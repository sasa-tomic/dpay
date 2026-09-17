// Flow 29 — Exact amount transport (MC1 units 2-4 acceptance proof, IC-rail edition).
//
// Proves a raw amount > 2^53 (the IEEE-754 loss zone the OLD `number`/`Double` path collapsed)
// round-trips BYTE-EXACT through the TS↔rail stack at every boundary that can carry it:
//
//   1. FAUCET (relay JSON u64→string + balance path): POST a >2^53 amount → the response balance
//      is the EXACT decimal string (Number() would have collapsed 2^53+1 → 2^53).
//   2. REQUEST WIRE (BigInt codec): build + decode a 132-byte request with the >2^53 raw amount →
//      `req.amount === "9007199254740993"` byte-exact.
//   3. SIGN (rail): build the icrc1_transfer ARG with the >2^53 amount → the uleb128 tail encodes
//      it exactly; the signed envelope CONTAINS those arg bytes verbatim (byte-exact containment),
//      so the signature is computed over the exact raw.
//   4. SETTLE on the rail: submit the >2^53 transfer — the fake-IC ledger is u128-keyed with no
//      facade-era per-tx cap, so the balances AND the txn-log amount carry the exact decimal
//      strings on BOTH sides (payee credit + payer debit).
//
// This is IMPOSSIBLE through `number`: `Number("9007199254740993") === 9007199254740992`.
import { setup, assert, assertEq, getBalance, icpCatalog, accountOf, onboardWallet, railTransfer } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, decodeRequest, buildRequestQR, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate } from '../harness/wire.mjs';

// 2^53 + 1 — the canonical IEEE-754 loss probe. Number(9007199254740993) === 9007199254740992 (lossy);
// BigInt + the decimal-string transport carry the exact value end to end.
const BIG_RAW = '9007199254740993';
const FUTURE_EXPIRY = 4_102_444_800; // 2100-01-01Z (a fixed far-future expiry, comfortably in range)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '29',
  name: 'exact-amount',
  journey: 'pay',
  covers: ['exact-amount', 'decimal-transport', 'u64', 'bigint-codec'],
  verifies: 'Raw amount > 2^53 round-trips byte-exact through faucet/request-wire/signed-envelope/ledger-settle on the IC rail (BigInt codec, uleb128 + u128 ledger, decimal strings).',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[29-exact-amount] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

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
    await onboardWallet(driver, 'e2e-bigamt');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;
    const nonce = randNonceHex();
    const requestQR = buildRequestQR(bobHex, BIG_RAW, nonce, FUTURE_EXPIRY, 0, 'e2e-bigamt', 'big');
    const req = decodeRequest(requestQR);
    assertEq(req.toHex, bobHex, 'decoded request.to == merchant B');
    assertEq(req.amount, BIG_RAW, 'decoded request.amount == 2^53+1 (byte-exact; impossible via number)');
    console.log(`[29-exact-amount] ✓ decoded request.amount === "${req.amount}" (byte-exact 2^53+1)`);

    // --- 3. SIGN on the rail: the icrc1_transfer arg carries the >2^53 amount as uleb128, and
    // the SIGNED ENVELOPE embeds those arg bytes verbatim (byte-exact containment proof). --------
    const catalog = await icpCatalog(relayBaseURL);
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const arg = icpTransferArgBytes(icpPrincipalBytes(bobHex), BigInt(BIG_RAW), {fee: null, memoHex: nonce});
    const argHex = Buffer.from(arg).toString('hex');
    // uleb128-encode BIG_RAW independently and assert the ARG TAIL is exactly those bytes.
    const uleb = [];
    for (let v = BigInt(BIG_RAW);; v >>= 7n) {
      const b = Number(v & 0x7fn);
      if (v >> 7n === 0n) { uleb.push(b); break; }
      uleb.push(b | 0x80);
    }
    const argTail = argHex.slice(-uleb.length * 2);
    assertEq(argTail, Buffer.from(uleb).toString('hex'), 'arg uleb128 amount tail == exact 2^53+1 bytes');
    const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    assert(signed.envelopeHex.includes(argHex), 'the signed envelope must contain the exact arg bytes (signature covers the exact raw)');
    console.log(`[29-exact-amount] ✓ >2^53 arg encodes exactly (uleb128) + envelope signs over those bytes`);

    // --- 4. SETTLE the >2^53 transfer on the rail: u128 ledger, decimal-string truth. -----------
    // (No facade-era per-tx cap exists on the rail; the ledger's u128 is the authority. Both
    // sides' balances + the txn-log amount must carry the exact decimal strings.)
    const pay = await railTransfer(relayBaseURL, alice.secretHex, bobHex, BigInt(BIG_RAW), {memoHex: nonce});
    assert(pay.ok === true && pay.status === 202, `the 2^53+1 rail transfer must be accepted (202), got ${JSON.stringify(pay)}`);
    const bobBal = await getBalance(relayBaseURL, bobHex, 0);
    assertEq(bobBal, (10_000n + BigInt(BIG_RAW)).toString(), 'payee B balance == exact 2^53+1 + onboarding credit (string, no number loss)');
    const aliceBal = await getBalance(relayBaseURL, alice.publicHex, 0);
    assertEq(aliceBal, '0', 'payer A balance == exact 0 (the 2^53+1 debit landed whole)');
    const txns = (await (await fetch(`${relayBaseURL}/api/v1/transactions/${bobHex}?currency=0&limit=5`)).json()).transactions;
    const bigRow = txns.find((t) => t.memo === nonce);
    assert(bigRow && bigRow.amount === BIG_RAW, `txn-log amount must be the exact string "${BIG_RAW}", got ${bigRow && bigRow.amount}`);
    console.log(`[29-exact-amount] ✓ settled 2^53+1 on the rail; payee/payer balances + txn amount are exact strings`);

    await driver.screenshot('29-exact-amount');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[29-exact-amount] GREEN in ${elapsed}s — 2^53+1 round-trips byte-exact (faucet + wire + sign + rail settle)`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[29-exact-amount] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
