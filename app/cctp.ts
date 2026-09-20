/**
 * cctp — the Circle CCTP V2 Ethereum burn leg's calldata builder, as PURE functions.
 *
 * Dependency-free (no react-native, no keccak lib) so it runs under jest on the
 * fast inner loop — the `cketh.ts` pattern: every byte produced here is pinned byte-exact
 * against the LIVE Ethereum contract, so a unit test proves the external interface is
 * represented accurately with zero network. (ONE exception since the gas-fund widening:
 * `fetchEthBalance` dials the global `fetch` against the publicnode staging — still no
 * import, still jest-mockable via the global.)
 *
 * WHAT IT BUILDS (the cross-rail leg of Routes B/C, docs/specs/2026-09-14-swap-venue-
 * feasibility.md §Multi-step routes; the EVM signing boundary: dpay NEVER holds EVM keys —
 * the user's OWN Ethereum wallet signs both transactions, dpay only renders the exact bytes):
 *
 *   1. approve(TokenMessengerV2, amount) on the USDC ERC-20 — lets the messenger pull the
 *      burn amount (selector + encoding reused verbatim from `cketh.ts`, the proven onramp
 *      builder).
 *   2. depositForBurnWithHook(amount, destinationDomain, mintRecipient, burnToken,
 *      destinationCaller, maxFee, minFinalityThreshold, hookData) on TokenMessengerV2 —
 *      burns USDC on Ethereum for canonical mint on Solana (domain 5).
 *
 * WHY `depositForBurnWithHook` AND NOT plain `depositForBurn`: the Solana-side receive is a
 * permissionless message-execution nobody reliably relays, and the converting user may hold
 * ZERO SOL (the whole point of Route C). The extended hookData below opts the transfer into
 * Circle's Forwarding Service: Circle itself executes the Solana mint (and creates the
 * recipient's USDC ATA when missing), paid from a source-side USDC fee — no destination-side
 * SOL is ever required. (Circle docs: Forwarding Service, `cctp-forward` hook format.)
 *
 * AUTHORITATIVE SOURCES (constants because the contract ABI is fixed at deploy):
 *   - TokenMessengerV2 Ethereum mainnet `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`
 *     (Circle docs, developers.circle.com/cctp → Contract Addresses; the same address is
 *     deployed across EVM chains).
 *   - USDC Ethereum mainnet `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (Centre/Circle).
 *   - Destination domain ids (Circle docs, Supported Chains & Domains): Ethereum = 0,
 *     Solana = 5.
 *   - Finality thresholds (Circle docs, Finality & Block Confirmations): FAST = 1000,
 *     STANDARD = 2000. Values < 1000 clamp to 1000; > 1000 clamp to 2000. Fast Transfer
 *     ETH→SOL measured ~20 s (feasibility doc, 2026-09-14).
 *   - Selectors verified by keccak256 (computed with @noble/hashes sha3, cross-checked
 *     against the canonical `approve(address,uint256)` = 0x095ea7b3) AND against the LIVE
 *     mainnet contract via read-only `eth_call` staging (2026-09-15, publicnode RPC):
 *     zero mintRecipient → revert "Mint recipient must be nonzero"; nonzero mintRecipient +
 *     real USDC → revert "ERC20: transfer amount exceeds allowance" (the transferFrom pull),
 *     proving the full arg path decodes and executes.
 *
 * The mint recipient for a Solana destination is the recipient's USDC ATA (32 raw bytes),
 * NOT the wallet owner — Circle's Forwarding Service doc is explicit; the extended hookData
 * carries the OWNER and Circle validates the ATA derivation.
 */

// ── contract constants (fixed at deploy; sources in the header) ───────────────────────────────

/** Circle TokenMessengerV2, Ethereum mainnet (proxy; implementation verified to contain the
 *  selector below via eth_getCode on the EIP-1967 implementation slot, 2026-09-15). */
export const TOKEN_MESSENGER_V2_ADDRESS = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
/** Canonical USDC on Ethereum mainnet — the only burn token this build composes routes for. */
export const USDC_ERC20_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** CCTP V2 destination domain ids (Circle docs): Ethereum = 0, Solana = 5. */
export const CCTP_DOMAIN_ETHEREUM = 0;
export const CCTP_DOMAIN_SOLANA = 5;
/** Finality thresholds (Circle docs): FAST = 1000 ("Confirmed", ~seconds-to-minutes),
 *  STANDARD = 2000 ("Finalized", waits full Ethereum finality). This build burns FAST. */
export const CCTP_FINALITY_FAST = 1000;
export const CCTP_FINALITY_STANDARD = 2000;

/** keccak256("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)")
 *  — LIVE-VERIFIED against mainnet TokenMessengerV2 (staged reverts prove the arg path). */
export const SELECTOR_DEPOSIT_FOR_BURN_WITH_HOOK = '779b432d';

// ── word helpers (32-byte big-endian ABI words, 64 lowercase hex chars, no 0x) ─────────────────

function uint256ToWord(n: bigint): string {
  if (n < 0n) throw new Error('uint256 cannot be negative');
  return n.toString(16).padStart(64, '0');
}

/** A raw big-endian u32 as 8 hex chars — the hook's version/len fields are packed bytes,
 *  NOT ABI words. */
function uint32ToBytes(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('uint32 out of range');
  return n.toString(16).padStart(8, '0');
}

/** A u32 as a full 32-byte ABI word (the head's destinationDomain/minFinalityThreshold). */
function uint32ToWord(n: number): string {
  return uint32ToBytes(n).padStart(64, '0');
}

/** A 32-byte value already encoded as 64 hex chars (or a 0x-prefixed 32-byte hex string),
 *  normalized to exactly 64 lowercase hex chars. */
function bytes32ToWord(hex: string): string {
  const h = hex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('bytes32 word must be exactly 64 hex chars');
  return h;
}

/** Left-pad a 20-byte Ethereum address to a 32-byte word. */
function addressToWord(addr: string): string {
  return addr.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

// ── the Forwarding Service hook (extended form — ATA creation included) ────────────────────────

/** The 24-byte magic prefix every cctp-forward hookData carries: ASCII "cctp-forward"
 *  right-padded with zeros to 24 bytes (Circle docs, Forwarding Service hook format). */
const FORWARD_MAGIC_HEX = '636374702d666f7277617264000000000000000000000000'; // 48 hex chars = 24 B

/**
 * Build the EXTENDED cctp-forward hookData (65 bytes): magic(24B) + version u32 = 0 +
 * len u32 = 33 + flag u8 = 1 (create the recipient's ATA if missing) + the recipient OWNER's
 * 32-byte Solana address. `ownerHex64` is the owner's raw 32-byte address as 64 hex chars.
 * Circle derives the expected mint recipient as deriveAta(owner, burn-token-mint) and
 * validates the match — the caller passes exactly that ATA as the burn's mintRecipient.
 *
 * The extended form (vs the 32-byte static form for an existing ATA) is used UNCONDITIONALLY:
 * it works whether or not the ATA exists, so no pre-flight Solana account read can gate the
 * burn, and the quoted forwarding fee is fetched with includeRecipientSetup=true to match.
 */
export function buildForwardHookData(ownerHex64: string): string {
  const owner = bytes32ToWord(ownerHex64);
  return FORWARD_MAGIC_HEX + uint32ToBytes(0) + uint32ToBytes(33) + '01' + owner; // 130 hex chars = 65 B
}

// ── the burn calldata ──────────────────────────────────────────────────────────────────────────

/**
 * Build the calldata for TokenMessengerV2.depositForBurnWithHook — the ONE transaction that
 * burns `amount` USDC on Ethereum for canonical mint on the destination domain.
 *
 * ABI: 7 static words in the head (amount, destinationDomain, mintRecipient, burnToken,
 * destinationCaller, maxFee, minFinalityThreshold), then the `bytes hookData` tail: one
 * offset word (0xe0 = 7×32), one length word, and the data zero-padded to a whole 32-byte
 * word boundary (65 bytes → 3 words = 192 bytes). The tail padding is load-bearing — an
 * unpadded 65-byte tail decodes as garbage and the call reverts with no reason string
 * (reproduced live against mainnet while pinning this encoder).
 *
 * `mintRecipientHex64` is the recipient's ATA for the burn token on the DESTINATION chain
 * (Solana: deriveAta(owner, USDC mint), raw 32 bytes). `destinationCaller` stays bytes32(0)
 * — the Forwarding Service rejects a set destinationCaller, and zeros mean permissionless
 * execution (which the forwarding service itself performs).
 */
export function encodeDepositForBurnWithHook(args: {
  amount: bigint;
  destinationDomain: number;
  mintRecipientHex64: string;
  burnToken: string;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookDataHex: string;
}): string {
  const hook = args.hookDataHex.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(hook) || hook.length === 0 || hook.length % 2 !== 0) {
    throw new Error('hookData must be non-empty lowercase hex');
  }
  const byteLen = hook.length / 2;
  const paddedWords = Math.ceil(byteLen / 32);
  const head =
    uint256ToWord(args.amount)
    + uint32ToWord(args.destinationDomain)
    + bytes32ToWord(args.mintRecipientHex64)
    + addressToWord(args.burnToken)
    + '0'.repeat(64) // destinationCaller = bytes32(0)
    + uint256ToWord(args.maxFee)
    + uint32ToWord(args.minFinalityThreshold);
  const tail =
    uint256ToWord(BigInt(7 * 32)) // offset of the bytes tail, after the 7 static words
    + uint256ToWord(BigInt(byteLen))
    + hook.padEnd(paddedWords * 64, '0');
  return '0x' + SELECTOR_DEPOSIT_FOR_BURN_WITH_HOOK + head + tail;
}

// ── fee math (Circle's published numbers, verbatim inputs) ─────────────────────────────────────

/** Circle's published burn-fee row for one finality threshold, as its /v2/burn/USDC/fees API
 *  serves it: `minimumFee` in bps (1 = 0.01%... the API's own unit is hundredths-of-a-bps,
 *  which for the live ETH→SOL row reads 1 = 1 bps — parsed to bps here exactly as Circle's
 *  quickstart does: amount × minimumFee × 100 / 1e6 = amount × minimumFee / 1e4) and the
 *  Forwarding Service's `forwardFee` in USDC base units (low/med/high percentiles). */
export type CctpBurnFee = {
  finalityThreshold: number;
  /** Circle's minimumFee for this threshold, converted to basis points. */
  minimumFeeBps: bigint;
  /** The forwarding fee percentile this build quotes (Circle publishes low/med/high; med). */
  forwardFeeSubunits: bigint;
};

/** The maxFee the burn signs: Circle's protocol fee (its own bps on the burn amount) + the
 *  Forwarding Service fee + a 20% buffer on the total (Circle's docs recommend 10–20%; an
 *  insufficient maxFee silently degrades a fast transfer to standard). Throws when the fee
 *  would reach the burn amount — the contract requires maxFee < amount, so a burn that small
 *  is refused HERE, before anything is signed. */
export function cctpMaxFee(amount: bigint, fee: CctpBurnFee): bigint {
  const protocolFee = (amount * fee.minimumFeeBps) / 10_000n;
  const total = protocolFee + fee.forwardFeeSubunits;
  const buffered = total + (total * 20n) / 100n;
  if (buffered >= amount) {
    throw new Error('cctp fee reaches the burn amount — the transfer is too small to route');
  }
  return buffered;
}

/** The USDC subunits expected to LAND (burn amount minus Circle's fee execution ceiling):
 *  the honest floor the destination is promised before the chain answers. */
export function cctpMintFloor(amount: bigint, maxFee: bigint): bigint {
  const floor = amount - maxFee;
  return floor > 0n ? floor : 0n;
}

// ── live-API response parsers (pure; pinned against captured live bodies) ─────────────────────

/**
 * Parse Circle's `GET /v2/burn/USDC/fees/0/5?forward=true&includeRecipientSetup=true` body
 * (captured live 2026-09-15):
 *   [{"finalityThreshold":1000,"minimumFee":1,"forwardFee":{"low":269688,"med":282032,"high":305756}},
 *    {"finalityThreshold":2000,"minimumFee":0,"forwardFee":{…same…}}]
 * Returns the row for the requested threshold, or null when the body does not carry one —
 * the caller fails closed (no invented fee).
 */
export function parseCctpBurnFees(
  body: unknown,
  finalityThreshold: number,
): CctpBurnFee | null {
  if (!Array.isArray(body)) return null;
  for (const row of body) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.finalityThreshold !== finalityThreshold) continue;
    if (typeof r.minimumFee !== 'number') return null;
    const ff = r.forwardFee;
    if (!ff || typeof ff !== 'object' || typeof (ff as Record<string, unknown>).med !== 'number') return null;
    return {
      finalityThreshold,
      minimumFeeBps: BigInt(Math.round(r.minimumFee)),
      forwardFeeSubunits: BigInt((ff as Record<string, unknown>).med as number),
    };
  }
  return null;
}

/** One reading of Circle's message-status API for a burn tx hash — the mint-watch states.
 *  `pending` = no attestation yet (the API 404s until one exists); `attested` = the burn
 *  message exists but the destination forward has not produced its transaction yet;
 *  `complete` = Circle executed the destination mint (forwardTxHash present — the
 *  destination-chain transaction id, a Solana signature for domain 5). Only `complete`
 *  advances a record; everything else keeps watching (a late or stalled attestation is an
 *  honest pending, never a false failure). */
export type CctpMessageStatus =
  | {state: 'pending'}
  | {state: 'attested'}
  | {state: 'complete'; forwardTxHash: string};

/** Parse `GET /v2/messages/0?transactionHash=0x…` (200 shape, captured live 2026-09-15:
 *  {messages:[{…, status:'complete', forwardState, forwardTxHash, decodedMessageBody:{…}}],
 *   sourceTxHash}). A body with no messages array reads as pending. */
export function parseCctpMessageStatus(body: unknown): CctpMessageStatus {
  if (!body || typeof body !== 'object') return {state: 'pending'};
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return {state: 'pending'};
  const first = messages[0] as Record<string, unknown> | null;
  if (!first || typeof first !== 'object') return {state: 'pending'};
  const hash = first.forwardTxHash;
  if (typeof hash === 'string' && hash.length > 0) {
    return {state: 'complete', forwardTxHash: hash};
  }
  return {state: 'attested'};
}

// ── the publicnode Ethereum JSON-RPC staging ────────────────────────────────────────────────────
// The module stays import-free (the header's dependency-free promise): the ONE network read
// below dials the global `fetch` against the same publicnode endpoint the 2026-09-15 live
// eth_call/eth_getCode verification staged through. Keyless, read-only, no dpay credential.

/** The Ethereum mainnet JSON-RPC origin used for every read-only staging probe (2026-09-15)
 *  and — since the gas-fund widening — for the EXTERNAL wallet's own ETH balance read. */
export const ETHEREUM_RPC_URL = 'https://ethereum-rpc.publicnode.com';

/**
 * The user's OWN external Ethereum wallet's ETH balance, in wei (DECIMAL string — the
 * codebase's money-string convention, JSON-safe for the state screens), via `eth_getBalance`
 * ("latest") on the publicnode staging. This is the gas-fund offer's honest "have" line for
 * the wallet the burn legs deliver INTO.
 *
 * Fail-open by contract: an unreachable RPC, a non-2xx, a malformed JSON-RPC body, or a
 * malformed address ALL read as `null` — an unmeasurable balance is UNKNOWN, never zero,
 * and the gas-fund UI stays offered with an unknown-have rather than blocked on a flaky
 * read. (The gas the burn legs themselves spend is the IN-WALLET ckETH — `railBalanceOf`
 * territory — never this number.)
 */
export async function fetchEthBalance(address: string, timeoutMs = 8000): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ETHEREUM_RPC_URL, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest']}),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as {result?: unknown} | null;
    if (body == null || typeof body.result !== 'string' || !/^0x[0-9a-f]+$/i.test(body.result)) return null;
    return BigInt(body.result).toString();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
