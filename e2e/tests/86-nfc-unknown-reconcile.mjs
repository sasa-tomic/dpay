// Flow 86 — receiver settles an offline-payer NFC bundle and returns a result.
//
// The receiver is not authorized to read the payer-owned request_status on the real IC. This flow
// therefore asserts the actual receiver contract end to end:
//   - the payer bundle contains the update plus a reusable payer-signed read_state envelope;
//   - the receiver alone submits/polls, then matches recipient + currency + amount + memo nonce;
//   - that exact match resolves to "Received" and queues the merchant-signed NFC result;
//   - the merchant's balance reflects the settled transfer exactly once.
//
// Prerequisites proven elsewhere: envelope signing parity (flow 00), the merchant submit+poll
// happy path (flow 08), the reader-side NFC protocol phases (flow 11).
import { setup, assert, assertIncludes, getBalance, faucetAccount, icpCatalog, onboardWallet, accountOf } from '../harness/lib.mjs';
import { generateKeypair, decodeRequestHex, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate, icpSignReadState, b64urlEncode, randNonceHex } from '../harness/wire.mjs';

const PAY_CENTS = 1000; // ∂10.00 — the exact amount of the 2026-08-21 field failure

export const meta = {
  id: '86',
  name: 'nfc-history-confirmation',
  journey: 'nfc',
  covers: ['nfc', 'settle', 'history', 'reconcile'],
  verifies: 'Offline payer supplies update + signed read_state; receiver alone settles, exact-history binds success, and queues the returned result.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[86-nfc-unknown-reconcile] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // The merchant app must treat NFC as available (web default is 'unknown' → NfcTap never mounts).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    // --- wallet A (payer): generated + faucet-funded in-test. -----------------------------------
    const alice = await generateKeypair();
    const fundA = await faucetAccount(relayBaseURL, alice.publicHex, 10_000);
    assert(fundA.ok, `payer A faucet funding must succeed, got ${fundA.status}`);

    // --- wallet B (merchant): onboarded in the browser. -----------------------------------------
    await onboardWallet(driver, 'e2e-merchant');
    const bob = await accountOf(driver);
    const bobHex = bob.publicHex;

    // --- B requests ∂10.00; the REAL reader mode must arm (buildRequest now returns real hex). ---
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '10.00', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    // The QR is the payment LINK now (founder 2026-09-12); the wire request lives on the radio —
    // the reader-armed stash is the machine code this flow's memo must match.
    let readerHex = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = await driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null);
      if (!readerHex) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(typeof readerHex === 'string' && readerHex.length > 0, 'the NFC reader must arm with the 132-byte wire request');
    const req = decodeRequestHex(readerHex);
    assert(req.toHex === bobHex, `wire.to must be the merchant's account, got ${req.toHex}`);
    assert(req.amount === String(PAY_CENTS), `wire.amount must be ${PAY_CENTS}, got ${req.amount}`);
    console.log(`[86-nfc-unknown-reconcile] B request nonce=${req.nonceHex.slice(0, 12)}…`);

    // The reader NfcTap must be mounted (reader mode armed by the real buildRequest hex).
    const listeners = await driver.eval(() => window.__DPAY_TEST_NFC_COUNT());
    assert(listeners >= 1, `reader NfcTap must mount a DpayNfcEvent listener, got ${listeners}`);

    // --- A signs a REAL icrc1_transfer envelope for B's request (memo = the request nonce). -----
    const catalog = await icpCatalog(relayBaseURL);
    const ledger = catalog.find(c => c.currency === 0)?.ledger;
    const arg = icpTransferArgBytes(icpPrincipalBytes(bobHex), BigInt(PAY_CENTS), {fee: null, memoHex: req.nonceHex});
    const expiryNs = BigInt(Date.now() + 240_000) * 1_000_000n;
    const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);
    const readState = await icpSignReadState(alice.secretHex, [
      [Buffer.from('request_status'), Buffer.from(signed.requestIdHex, 'hex')],
    ], expiryNs + 60_000_000_000n);
    console.log('[86-nfc-unknown-reconcile] A signed (request_id=' + signed.requestIdHex.slice(0, 12) + '…)');

    // --- Mirror native ordering: transport reaches Settling, then delivers the immutable wire. ---
    await driver.eval(() => window.__DPAY_TEST_NFC_SESSION({ type: 'phase', role: 'reader', phase: 'settling' }));
    await driver.eval((bundle) => window.__DPAY_TEST_NFC_SESSION({
      type: 'done', role: 'reader',
      envelopeHex: bundle.envelopeHex,
      readStateEnvelopeHex: bundle.readStateEnvelopeHex,
      requestIdHex: bundle.requestIdHex,
    }), {envelopeHex: signed.envelopeHex, readStateEnvelopeHex: readState.envelopeHex, requestIdHex: signed.requestIdHex});
    const status = await driver.findByTestID('nfc-status', { timeoutMs: 5_000 });
    assert(status, 'the single NFC settlement view must remain mounted after envelope delivery');
    console.log('[86-nfc-unknown-reconcile] ✓ offline bundle handed to sole merchant settlement owner');

    // Settlement queues the signed result, but merchant UI stays nonterminal until the payer
    // accepts it. This prevents Done from tearing down reader mode before a result-only re-tap.
    let queued = null;
    for (let i = 0; i < 200 && !queued; i++) {
      queued = await driver.eval(() => window.__DPAY_TEST_NFC_RESULT ?? null);
      if (!queued) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(queued?.status === 0, `merchant must queue settled result, got ${JSON.stringify(queued)}`);
    assert(queued.requestIdHex === signed.requestIdHex, 'returned result must bind the update request id');
    const beforeAck = await status.evaluate(node => node.textContent ?? '');
    assert(!beforeAck.includes('Received'), 'merchant must wait for payer result acknowledgement');
    await driver.eval(() => window.__DPAY_TEST_NFC_SESSION({type: 'confirmed', role: 'reader'}));

    // --- The receiver reaches success only after exact history + result delivery. -----------------
    const received = await driver.waitForText('Received ✓ ∂10.00', { timeoutMs: 20_000 });
    assert(received, 'the receiver should reach "Received ✓ ∂10.00" from exact ledger history');
    console.log('[86-nfc-unknown-reconcile] ✓ exact ledger row resolved to Received');

    // --- The transfer settled EXACTLY ONCE: B's ledger balance is ∂100 + ∂10. --------------------
    const bobLedger = await getBalance(relayBaseURL, bobHex, 0);
    assert(bobLedger === '11000', `B ledger balance must be 11000 cents, got ${bobLedger}`);
    const aliceLedger = await getBalance(relayBaseURL, alice.publicHex, 0);
    assert(aliceLedger === '9000', `A ledger balance must be 9000 cents, got ${aliceLedger}`);

    await driver.screenshot('86-nfc-unknown-reconcile');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[86-nfc-unknown-reconcile] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[86-nfc-unknown-reconcile] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
