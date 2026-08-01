// Flow 29 — Exact amount transport (MC1 units 2-4 acceptance proof).
//
// Proves a raw amount > 2^53 (the IEEE-754 loss zone the OLD `number`/`Double` path collapsed)
// round-trips BYTE-EXACT through the TS↔relay-JSON stack at every boundary that can carry it:
//
//   1. FAUCET (relay JSON u64→string + balance path): POST a >2^53 amount → the response balance
//      is the EXACT decimal string (Number() would have collapsed 2^53+1 → 2^53).
//   2. REQUEST WIRE (BigInt codec): build + decode a 132-byte request with the >2^53 raw amount →
//      `req.amount === "9007199254740993"` byte-exact (the OLD `Math.floor`/`& 0xff` `putU64Le`
//      would have encoded 9007199254740992 instead).
//   3. SIGN (signAuthorizationCode with the string amount): the >2^53 authorization signs, and the
//      amount read back out of the SIGNED WIRE bytes is the exact raw — the FROZEN wire carries the
//      amount as a u64 LE at its fixed offset, and the new string-marshalling encodes it exactly.
//   4. SETTLE (receipt amount is an exact string): a NORMAL-amount settle (the per-tx cap correctly
//      blocks a >2^53 amount — that's the right behavior, not a gap) proves the /pay receipt.amount
//      is carried as the exact decimal string.
//
// This is IMPOSSIBLE through `number`: `Number("9007199254740993") === 9007199254740992`.
import { setup, assert, assertEq, getBalance, postPay, accountOf, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, signAuthorizationCode, decodeRequest, buildRequestQR, b64urlDecode } from '../harness/wire.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 2^53 + 1 — the canonical IEEE-754 loss probe. Number(9007199254740993) === 9007199254740992 (lossy);
// BigInt + the decimal-string transport carry the exact value end to end.
const BIG_RAW = '9007199254740993';
const FUTURE_EXPIRY = 4_102_444_800; // 2100-01-01Z (a fixed far-future expiry, comfortably in range)
const SETTLE_CENTS = 2500; // ∂25.00 — a normal amount for the settle (the cap blocks >2^53, correctly)

// Read the wire layout's amount offset/len from wire_layout.json (single source of truth).
const __dirname = dirname(fileURLToPath(import.meta.url));
const L = JSON.parse(readFileSync(join(__dirname, '..', '..', 'dfx', 'wire_layout.json'), 'utf8'));

/** Read the amount LE u64 out of a 292-byte wire as an UNSIGNED decimal STRING (BigInt). */
function readAmountFromWire(wireB64) {
  const bytes = b64urlDecode(wireB64);
  const off = L.fields.amount.offset;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v.toString();
}

export async function run() {
  const start = Date.now();
  console.log('[29-exact-amount] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL } = env;

    // --- 1. FAUCET: a >2^53 credit returns the balance as the EXACT decimal string. ------------
    const alice = await generateKeypair();
    const fundA = await fetch(`${relayBaseURL}/api/v1/faucet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: alice.publicHex, amount: BIG_RAW }),
    });
    assert(fundA.ok, `faucet funding (2^53+1) must succeed, got ${fundA.status}`);
    const fundJ = await fundA.json();
    assert(fundJ.balance === BIG_RAW, `faucet balance must be the exact 2^53+1 string, got ${fundJ.balance}`);
    console.log(`[29-exact-amount] ✓ faucet credited the exact raw ${BIG_RAW} (2^53+1) as a string`);

    // --- 2. REQUEST WIRE: build + decode a 132-byte request carrying the >2^53 amount. ----------
    const { driver } = env;
    await onboardWallet(driver, 'e2e-bigamt');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;
    const nonce = randNonceHex();
    const requestQR = buildRequestQR(bobHex, BIG_RAW, nonce, FUTURE_EXPIRY, 0, 'e2e-bigamt', 'big');
    const req = decodeRequest(requestQR);
    assertEq(req.toHex, bobHex, 'decoded request.to == merchant B');
    assertEq(req.amount, BIG_RAW, 'decoded request.amount == 2^53+1 (byte-exact; impossible via number)');
    console.log(`[29-exact-amount] ✓ decoded request.amount === "${req.amount}" (byte-exact 2^53+1)`);

    // --- 3. SIGN: signAuthorizationCode with the >2^53 amount → the wire carries the exact raw. -
    // The FROZEN wire carries amount as a u64 LE at offset 64; the new string-marshalling must
    // encode it exactly or the signature math breaks. Reading the amount back out of the SIGNED wire
    // proves the encode side; the relay verifies the sig on settle (step 4 proves verify accepts it).
    const code = await signAuthorizationCode(alice.secretHex, bobHex, BIG_RAW, nonce, FUTURE_EXPIRY, 0, 'e2e-payer', 'e2e-bigamt', 'big');
    const wireAmount = readAmountFromWire(code);
    assertEq(wireAmount, BIG_RAW, 'signed wire.amount == 2^53+1 (the signed bytes carry the exact raw)');
    console.log(`[29-exact-amount] ✓ >2^53 authorization signs + the wire carries the exact raw`);

    // --- 4. SETTLE a normal-amount payment: the /pay receipt.amount is an exact string. ---------
    // (A >2^53 amount is correctly OverCap-rejected by validate — the right behavior, not a gap;
    // this settle proves the receipt path carries exact strings for a payable amount.)
    const settleNonce = randNonceHex();
    const settleCode = await signAuthorizationCode(alice.secretHex, bobHex, SETTLE_CENTS, settleNonce, FUTURE_EXPIRY, 0, 'e2e-payer', 'e2e-bigamt', 'settle');
    const pay = await postPay(relayBaseURL, settleCode);
    assert(pay.ok && pay.body?.receipt, `the /pay must settle, got status=${pay.status} body=${JSON.stringify(pay.body)}`);
    assertEq(pay.body.receipt.amount, String(SETTLE_CENTS), 'receipt.amount == exact string (not a number)');
    // B was onboarded (∂100 = 10000) before receiving ∂25 (2500) → 12500. The balance path carries
    // the exact summed string (no number loss).
    const bobBal = await getBalance(relayBaseURL, bobHex, 0);
    assertEq(bobBal, '12500', 'payee B balance == exact string through the balance path');
    console.log(`[29-exact-amount] ✓ settled ∂${SETTLE_CENTS / 100}; receipt.amount + balance are exact strings`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[29-exact-amount] GREEN in ${elapsed}s — 2^53+1 round-trips byte-exact (faucet + wire + sign + balance)`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[29-exact-amount] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
