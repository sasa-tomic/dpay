// Flow 09 — double-spend (IC rail): a replayed payment must be credited ONCE. On the IC rail the
// idempotency key is the request_id (a sha256 over the signed envelope's content) — the fake-IC
// gateway dedups on it: POSTing the SAME envelope bytes twice returns 202 both times, but the
// transfer executes exactly once. The ONLY safe retry is a byte-identical resubmit; re-signing
// (even identical fields) yields a NEW request_id (nonce/expiry differ) and WOULD double-pay —
// that hazard is exactly why the payer app reconciles by request_id, never by re-signing.
//
// Rail semantics (replaces the facade-era postPay replay assertion):
//   1. build + sign an icrc1_transfer envelope ONCE (memo = request nonce);
//   2. POST the same bytes twice → both 202;
//   3. ledger: payee credited the amount exactly once; payer debited once;
//   4. the gateway's txn log carries ONE transfer row (no duplicate).
import {setup, assert, getBalance, faucetAccount, icpCatalog, onboardWallet, accountOf} from '../harness/lib.mjs';
import {generateKeypair, decodeRequest, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate} from '../harness/wire.mjs';

export const meta = {
  id: '09',
  name: 'double-spend',
  journey: 'pay',
  covers: ['pay', 'replay-safety', 'confirmation'],
  verifies: 'identical-byte envelope resubmit is idempotent on the IC gateway (request_id dedup): both POSTs 202, transfer executed once, payee credited once — and re-signing is a NEW request (the never-retry-by-resigning hazard)',
  timeoutMs: 90000,
};

const PAY_CENTS = 2500;

export async function run() {
  const start = Date.now();
  console.log(`[${meta.name}] pay-journey cutover: request_id dedup on identical-byte resubmit`);
  const env = await setup();
  try {
    // --- Payer (alice) + payee (bob), both funded so balances are unambiguous. -----------------
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    await faucetAccount(env.relayBaseURL, alice.publicHex, 10_000);
    await faucetAccount(env.relayBaseURL, bob.publicHex, 10_000);

    // --- A request from bob (gives the payment a memo = reconciliation nonce). -----------------
    // (The request QR itself is not needed here — the memo just has to be a stable 16B value.)
    const nonceHex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

    // --- Sign ONE envelope (the payer would hand this to the rail exactly once). ---------------
    const catalog = await icpCatalog(env.relayBaseURL);
    const ledger = catalog.find((c) => c.currency === 0).ledger;
    const arg = icpTransferArgBytes(icpPrincipalBytes(bob.publicHex), BigInt(PAY_CENTS), {fee: null, memoHex: nonceHex});
    const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    const envelopeBytes = hexBytes(signed.envelopeHex);
    console.log(`[${meta.name}] ✓ envelope signed once (request_id=${signed.requestIdHex.slice(0, 12)}…)`);

    // --- POST the SAME bytes twice — both accepted (202), executed once. -----------------------
    const post = () => fetch(`${env.relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes,
    });
    const first = await post();
    const second = await post();
    assert(first.status === 202, `first submit must be 202 Accepted, got ${first.status}`);
    assert(second.status === 202, `identical-byte replay must also be 202 (free dedup), got ${second.status}`);
    console.log(`[${meta.name}] ✓ both submits 202 (request_id dedup — replay is free)`);

    // --- Ledger truth: credited once, debited once. --------------------------------------------
    const bobBal = await getBalance(env.relayBaseURL, bob.publicHex, 0);
    assert(bobBal === '12500', `payee must be credited ONCE (12500), got ${bobBal}`);
    const aliceBal = await getBalance(env.relayBaseURL, alice.publicHex, 0);
    assert(aliceBal === '7500', `payer must be debited once (7500), got ${aliceBal}`);
    console.log(`[${meta.name}] ✓ ledger: bob 12500 / alice 7500 (executed exactly once)`);

    // --- The txn log carries exactly ONE transfer row for this memo. ---------------------------
    const txns = (await (await fetch(`${env.relayBaseURL}/api/v1/transactions/${bob.publicHex}?currency=0&limit=10`)).json()).transactions;
    const transferRows = txns.filter((t) => t.memo === nonceHex && t.amount === String(PAY_CENTS));
    assert(transferRows.length === 1, `exactly one transfer row for the replayed payment, got ${transferRows.length}`);
    console.log(`[${meta.name}] ✓ txn log: one transfer row (no duplicate)`);

    // --- The hazard note: re-signing identical fields = NEW request_id = would double-pay. -----
    // (Asserted cheaply on the request_id derivation — no second POST, we do NOT double-pay bob.)
    const resigned = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs + 1_000_000n);
    assert(resigned.requestIdHex !== signed.requestIdHex, 're-signing must produce a NEW request_id (retry ≠ resubmit)');
    console.log(`[${meta.name}] ✓ re-sign ⇒ new request_id (retrying by re-signing would double-pay)`);

    await env.driver.screenshot('09-double-spend');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${meta.name}] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function hexBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[${meta.name}] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
