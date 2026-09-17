// The offline Jupiter stand-in — the relay-proxied venue seam for the Solana convert flows.
//
// Jupiter is a KEYLESS https venue (measured 2026-09-14, docs/specs/2026-09-14-swap-venue-feasibility.md):
// GET /swap/v1/quote?inputMint&outputMint&amount&slippageBps → the venue's own digits;
// POST /swap/v1/swap {quoteResponse, userPublicKey} → a serialized UNSIGNED legacy transaction the
// DEVICE verifies (fee payer = user, SPL destination = user's own ATA — app/solana/tx.ts) and signs.
// The registry row is endpoint "https://lite-api.jup.ag" with NO ic fixture by rule (dfx/catalog_truth.json
// venues[] _doc). Since 2026-09-16 the device dials the venue THROUGH dpay's relay
// (/api/v1/jupiter/* — crates/dpay-relay/src/jupiter.rs), so the offline stand-in is the
// relay's own test-stub upstream: harness/relay.mjs spawns the relay with
// DPAY_JUPITER_API_BASE pointed at /api/v1/test/jupiter-upstream on the same server, and the
// helpers below configure/read that stub over HTTP. The app-side client (app/services/jupiter.ts)
// never sees a fake fetch — the whole path (relayFetch → relay proxy → upstream) runs for real.
//
// This module has two halves:
//   NODE half  — crypto mirrors of the app's PURE Solana modules (SLIP-10 keypair, ATA PDA, legacy
//                tx bytes, getTransaction detail) so the flow can prebuild the deterministic swap
//                bytes for the wallet it just onboarded. These mirror app/solana/{identity,spl,tx}.ts
//                exactly; jest pins those modules byte-for-byte against @solana/web3.js, and flow
//                112's selector for the rail means any drift here shows up as the app's own
//                beneficiary check refusing the fixture — loudly, not silently.
//   RELAY half — configureJupiterStub / jupiterStubState: the relay test-stub upstream's config +
//                hits endpoints (the e2e flow's proof requests went THROUGH the proxy).
//
// The page NEVER gets the private key back from the app: the flow derives the keypair in Node from
// the identity secret (dpay.identity.v1, the same store accountOf reads), prebuilds the venue tx
// for THAT wallet, and the stub asserts the POST's userPublicKey is that wallet — a mismatch is
// recorded as userMismatch and fails the flow (it would mean the app is handing the venue some
// OTHER identity's key).

import {sha512} from '@noble/hashes/sha512';
import {sha256} from '@noble/hashes/sha256';
import {ed25519} from '@noble/curves/ed25519';
import {bs58Encode} from './soltx.mjs';

/** The registry row's mints (mirrors app/solana/tokens.ts + dfx/catalog_truth.json venues[]). */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr';
/** Solana program ids the mirrors need (mirrors app/solana/spl.ts / constants.ts). */
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 decode (BigInt) — the inverse of soltx.mjs's bs58Encode, for the 32-byte ids we handle. */
export function bs58Decode(str) {
  if (str.length === 0) return new Uint8Array();
  let n = 0n;
  for (const ch of str) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`bs58Decode: invalid character ${JSON.stringify(ch)}`);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  let i = 0;
  while (i < str.length && str[i] === '1') {
    bytes.unshift(0);
    i++;
  }
  return new Uint8Array(bytes);
}

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

// Hand-rolled RFC 2104 HMAC-SHA512 — the SAME deliberate choice app/solana/identity.ts makes: the
// resolved @noble/hashes `hmac` module in this tree disagrees with standard HMAC-SHA512, so the
// mirror hand-rolls over the (stable) sha512 primitive exactly as the app does. Byte-identical to
// the app's own function; cross-checked against the app via the golden values in flow 185's prep.
function hmacSha512(key, data) {
  const blockLen = 128;
  const normKey = key.length > blockLen ? sha512(key) : key;
  const pad = new Uint8Array(blockLen);
  pad.set(normKey);
  const inner = new Uint8Array(blockLen + data.length);
  const outer = new Uint8Array(blockLen + 64);
  for (let i = 0; i < blockLen; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  inner.set(data, blockLen);
  const innerHash = sha512(inner);
  outer.set(innerHash, blockLen);
  return Uint8Array.from(sha512(outer));
}

/**
 * SLIP-10 ed25519 at m/44'/501'/0'/0' from the IC identity secret — the mirror of
 * app/solana/identity.ts `deriveSolanaKeypair`. Returns {seed, publicKey, address} with the
 * address as the base58 string the venue POST carries as userPublicKey. Every level hardened;
 * the MASTER step keys HMAC with 'ed25519 seed', every child step keys it with the chain code.
 */
export function deriveSolanaKeypair(secretHex) {
  let key = hexToBytes(secretHex);
  if (key.length !== 32) throw new Error(`deriveSolanaKeypair: seed must be 32 bytes, got ${key.length}`);
  const master = hmacSha512(new TextEncoder().encode('ed25519 seed'), key);
  key = master.slice(0, 32);
  let chainCode = master.slice(32, 64);
  for (const index of [44, 501, 0, 0]) {
    const hardened = index + 0x80000000;
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (hardened >>> 24) & 0xff;
    data[34] = (hardened >>> 16) & 0xff;
    data[35] = (hardened >>> 8) & 0xff;
    data[36] = hardened & 0xff;
    const I = hmacSha512(chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32, 64);
  }
  const publicKey = ed25519.getPublicKey(key);
  return {seed: key, publicKey, address: bs58Encode(publicKey)};
}

function isOnEd25519Curve(bytes) {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The user's USDC ATA — the mirror of app/solana/spl.ts `deriveAta` (PDA under the ASSOCIATED TOKEN
 * program with seeds [owner, TOKEN_PROGRAM, mint]). The app's pre-sign beneficiary check requires
 * exactly this account among the venue tx's static keys.
 */
export function deriveAta(ownerAddress, mintAddress) {
  const owner = bs58Decode(ownerAddress);
  const program = bs58Decode(ASSOCIATED_TOKEN_PROGRAM);
  const seedParts = [owner, bs58Decode(TOKEN_PROGRAM), bs58Decode(mintAddress)];
  const label = new TextEncoder().encode('ProgramDerivedAddress');
  // Preimage order (mirrors createProgramAddress): seeds…, BUMP, programId, 'ProgramDerivedAddress'.
  for (let bump = 255; bump > 0; bump--) {
    const parts = [...seedParts, new Uint8Array([bump]), program, label];
    let total = 0;
    for (const p of parts) total += p.length;
    const preimage = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      preimage.set(p, off);
      off += p.length;
    }
    const hash = sha256(preimage);
    if (!isOnEd25519Curve(hash)) return new Uint8Array(hash);
  }
  throw new Error('deriveAta: no PDA found (mirror of findProgramAddress exhausted bumps)');
}

/**
 * The deterministic UNSIGNED venue swap tx — the exact wire shape Jupiter is asked for
 * (asLegacyTransaction, so every account key is IN the bytes) and the app's decodeVenueSwapTx
 * expects: compact-u16 sigCount=1 || 64 empty sig slots || legacy message. Message layout:
 * header [1 signer, 0 readonly-signed, 1 readonly-unsigned] (the app's own assembleMessage
 * layout), accounts [feePayer=user (signer+writable), userAta (writable), TOKEN_PROGRAM (ro)],
 * one route instruction keyed [user, ata] under the (fake) route program at index 2. The
 * beneficiary red lines see: fee payer IS the user; the SPL destination IS the user's own ATA.
 */
export function buildJupiterSwapTx({userPublicKey, userAta, blockhash = new Uint8Array(32).fill(7)}) {
  if (blockhash.length !== 32) throw new Error('buildJupiterSwapTx: blockhash must be 32 bytes');
  const user = bs58Decode(userPublicKey);
  const ata = bs58Decode(userAta);
  const tokenProgram = bs58Decode(TOKEN_PROGRAM);
  const message = new Uint8Array([
    1, 0, 1, // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    3, // account count (compact-u16)
    ...user, ...ata, ...tokenProgram,
    ...blockhash,
    1, // instruction count (compact-u16)
    2, // programIdIndex: the route program (the third static key)
    2, 0, 1, // key count (compact-u16) + key indices
    3, 1, 2, 3, // data length (compact-u16) + route calldata
  ]);
  if (user.length !== 32 || ata.length !== 32) throw new Error('buildJupiterSwapTx: keys must be 32 bytes');
  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1;
  tx.set(message, 65);
  return tx;
}

/**
 * The getTransaction json detail the settle path re-reads after confirmation — the realized-payout
 * oracle (app/solana.ts getSolTokenCredit): the postTokenBalances row whose mint is the OUT mint
 * (`mint`, default USDC) and whose owner is the user IS the chain's own account of what the route
 * paid out.
 */
export function solConvertTxDetail({userPublicKey, userAta, outAmount, mint = USDC_MINT, decimals = 6, slot = 250_000_003}) {
  const user = bs58Decode(userPublicKey);
  const ata = bs58Decode(userAta);
  const blockhash = bs58Encode(new Uint8Array(32).fill(7));
  return {
    slot,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [5_000_000_000, 2_039_280, 1],
      postBalances: [4_999_995_000, 2_039_280, 1],
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 1,
        mint,
        owner: userPublicKey,
        programId: TOKEN_PROGRAM,
        uiTokenAmount: {amount: String(outAmount), decimals, uiAmount: Number(outAmount) / 10 ** decimals},
      }],
    },
    transaction: {
      message: {
        accountKeys: [bs58Encode(user), bs58Encode(ata), TOKEN_PROGRAM],
        recentBlockhash: blockhash,
        header: {numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1},
        instructions: [{programIdIndex: 2, accounts: [0, 1], data: Buffer.from([1, 2, 3]).toString('base64')}],
        version: 'legacy',
      },
      signatures: [],
    },
  };
}

/**
 * Point the relay's Jupiter test-stub upstream at the deterministic digits. `relayBaseURL` is
 * the relay the app under test DIALS (flow 186 spawns its own second relay — configure THAT
 * one). cfg:
 *   - quote: {outAmount, otherAmountThreshold, priceImpact} — the deterministic digits
 *     (inAmount is ECHOED from the request's own amount param by the stub, so the quote is
 *     always about what the screen asked for; slippageBps likewise echoed as a number).
 *   - userPublicKey: the wallet the tx was prebuilt for (a POST for any other key is
 *     recorded as userMismatch and fails the flow's attribution asserts).
 *   - txBytes: the prebuilt unsigned venue tx (sent base64 — the stub's wire field).
 *   - lastValidBlockHeight: echoed into the swap reply; the RPC stub's getBlockHeight stays below.
 */
export async function configureJupiterStub(relayBaseURL, cfg) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/jupiter-upstream/config`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      quote: {
        outAmount: cfg.quote.outAmount,
        otherAmountThreshold: cfg.quote.otherAmountThreshold,
        priceImpact: cfg.quote.priceImpact ?? null,
      },
      userPublicKey: cfg.userPublicKey,
      txB64: Buffer.from(cfg.txBytes).toString('base64'),
      lastValidBlockHeight: cfg.lastValidBlockHeight,
    }),
  });
  if (!res.ok) throw new Error(`configureJupiterStub: relay stub config refused (${res.status})`);
}

/** Read the relay stub's recorded state back into Node for attribution asserts. */
export async function jupiterStubState(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/jupiter-upstream/hits`);
  if (!res.ok) return null;
  return await res.json();
}
