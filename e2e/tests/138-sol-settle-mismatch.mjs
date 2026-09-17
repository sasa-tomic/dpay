// Flow 138 — SOL settle-verify: the three verdicts of the getTransaction re-read (OPEN_ISSUES 6(b)).
//
// broadcastSolPayment no longer settles on `getSignatureStatuses` alone: once the status says
// confirmed, it re-reads the transaction via getTransaction and requires the recompiled legacy
// body to BE the canonical message the merchant verified. This flow drives the REAL merchant
// cycle (flow-51 shape) three times with three different re-read outcomes:
//
//   (a) MISMATCH — the fixture derives from the REAL signed tx but carries a one-lamport-different
//       transfer (well-formed, confirmed, NOT this request) → RECEIPT_MISMATCH(3): the merchant
//       sees the check-before-handover copy (receive.settlementNotVerified), NOT "Received", and
//       the durable unknown-state (reconcile card) stays armed — the tx may still move money.
//   (b) UNVERIFIABLE then verified — the re-read THROWS (transient) for the first polls, then
//       returns null, then (after re-seeding) the matching body: the merchant stays on the honest
//       busy state ("Broadcasting…") — never a Received, never a mismatch/rejected copy — until
//       the body verifies, and only then "Received". Unverifiable is NEVER a verdict.
//   (c) ON-CHAIN ERROR — the fixture carries meta.err → RECEIPT_REJECTED: the merchant sees the
//       friendly rejected copy, never a false Received.
//
// The happy-path fixture seeding (flow 51/74) proves the verified verdict end-to-end; this flow
// proves the other three classifications reach the merchant UI with honest copy.
//
// Selector contract: same as flow 51 + `sol-req-reconcile` (durable unknown-state card).
import {setup, assert, onboardWallet, armNfcCard, waitForWallet, openBalances} from '../harness/lib.mjs';
import { nfcPhaseWalk } from '../harness/flow-steps.mjs';
import {solTxDetailFromSolpay} from '../harness/soltx.mjs';

export const meta = {
  id: '138',
  name: 'sol-settle-mismatch',
  journey: 'offline',
  covers: ['sol-merchant', 'sol-settle-verify', 'three-verdict'],
  verifies: 'SOL settle-verify: confirmed-but-mismatched body → honest doubt copy + reconcile; unreadable body → keeps polling, settles only when verified; on-chain error → rejected copy.',
  timeoutMs: 90000,
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function extractSig(solpayUri) {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  return bs58Encode(new Uint8Array(tx.slice(1, 65)));
}

/** The flow-51 merchant cycle up to the signed solpay: creates a request, auto-signs it via the
 *  NFC card seam, stashes sig + a canonical-derived json detail for the settle gate, dismisses the
 *  overlay, scans the signed solpay, and returns the captured URI. `splice(detail)` applies the
 *  leg's defect; `seedDetail: false` leaves the detail global untouched (leg b: unreadable). */
async function merchantCycle(driver, label, amount, splice, seedDetail = true) {
  await driver.click('tab-receive', {timeoutMs: 5_000});
  await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});
  await driver.type('sol-req-amount-input', amount, {timeoutMs: 5_000});
  await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
  await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000});

  // The QR is the payment LINK now (founder 2026-09-12) — the machine code is read off the armed
  // reader seam (`__DPAY_SOL_REQ_LAST`, what the card will actually receive).
  let solreqUri = null;
  for (let i = 0; i < 100 && !solreqUri; i++) {
    solreqUri = await driver.eval(() => window.__DPAY_SOL_REQ_LAST ?? null);
    if (!solreqUri) await new Promise((r) => setTimeout(r, 50));
  }
  assert(typeof solreqUri === 'string' && solreqUri.startsWith('solreq:v2?'),
    `[${label}] the reader must arm with the solreq:v2 machine code, got: ${JSON.stringify(solreqUri)?.slice(0, 80)}`);

  await driver.click('tab-pay', {timeoutMs: 5_000});
  await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
  const dispatch = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };
  await nfcPhaseWalk(driver, dispatch, ['linking'], { statusId: 'sol-nfc-status', text: null });
  await dispatch({type: 'request', role: 'card', solreqUri});
  await driver.waitForText('Communicating', {timeoutMs: 6_000});

  const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
  assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'),
    `[${label}] the arrival auto-sign should produce a solpay:v2 URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);

  const sig = extractSig(solpayUri);
  await driver.eval((s) => { globalThis.__DPAY_TEST_SOL_SIG = s; }, sig);
  if (seedDetail) {
    const detail = solTxDetailFromSolpay(solpayUri);
    if (splice) splice(detail);
    await driver.eval((d) => { globalThis.__DPAY_TEST_SOL_TX_DETAIL = d; }, detail);
  }

  await driver.eval(() => {
    const btn = document.querySelector('button[aria-label="Done"]') || document.querySelector('button[aria-label="Cancel"]');
    if (btn) btn.click();
  });
  await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

  await driver.click('tab-receive', {timeoutMs: 5_000});
  await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});
  await driver.eval(() => {
    const el = document.querySelector('[aria-label="Scan the payer\'s signed code"]');
    if (el) el.click();
  });
  await driver.waitForText('Scan the payer\'s signed code', {timeoutMs: 5_000});
  await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solpayUri);
  return {solpayUri, sig};
}

/** The flow-51 exit: back to a clean request form (the "New request" reset). */
async function newRequest(driver) {
  await driver.eval(() => {
    const el = document.querySelector('[aria-label="New request"]');
    if (el) el.click();
  });
  await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});
}

export async function run() {
  const start = Date.now();
  console.log('[138-sol-settle-mismatch] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[138-sol-settle-mismatch] onboarding…');
    await onboardWallet(driver, 'e2e-sol-settle');

    // The settle-gate stub: identical to flow 51 except getTransaction THROWS transiently for the
    // first reads (leg b covers the transient class), then echoes the seeded detail.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOL_GET_TX_READS = 0;
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
        isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
        getBlockHeight: () => 250000001,
        sendTransaction: () => globalThis.__DPAY_TEST_SOL_SIG || 'sig_fallback',
        getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
        getTransaction: () => {
          globalThis.__DPAY_TEST_SOL_GET_TX_READS++;
          if (globalThis.__DPAY_TEST_SOL_GET_TX_READS <= 5) throw new Error('solana rpc http 503');
          return globalThis.__DPAY_TEST_SOL_TX_DETAIL ?? null;
        },
        getBalance: () => ({value: 5000000000}),
      };
    });

    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});

    // ---- Leg (a): confirmed body ≠ canonical → MISMATCH (3) --------------------------------
    console.log('[138-sol-settle-mismatch] leg a: mismatching confirmed body…');
    await merchantCycle(driver, 'leg-a', '0.025', (detail) => {
      // Well-formed, confirmed, NOT this request: the System transfer (ix[1], data =
      // u32(2) || u64LE lamports) carries one lamport more than the canonical message.
      const ix = detail.transaction.message.instructions[1];
      const buf = Buffer.from(ix.data, 'base64');
      buf[buf.length - 1] ^= 1;
      ix.data = buf.toString('base64');
    });

    const errA = await driver.findByTestID('sol-req-err', {timeoutMs: 15_000});
    const errTxtA = await errA.evaluate((n) => (n.textContent ?? '').trim());
    assert(/doesn.t match this request/i.test(errTxtA),
      `leg a: the merchant should see the settlement-not-verified copy, got: "${errTxtA}"`);
    assert(!/received/i.test(errTxtA), `leg a: the mismatch copy must not claim receipt, got: "${errTxtA}"`);
    let bodyA = await driver.bodyText();
    assert(!/Received/.test(bodyA), 'leg a: the body must NOT show "Received" (terminal doubt, no false success)');
    // The durable unknown-state stays armed (the tx may still move money — reconcile/rebroadcast).
    await driver.findByTestID('sol-req-reconcile', {timeoutMs: 5_000});
    console.log('[138-sol-settle-mismatch] ✓ leg a: honest doubt copy + reconcile card armed');

    await driver.screenshot('138-sol-settle-mismatch-a');
    await newRequest(driver);

    // ---- Leg (b): re-read throws → null → only a VERIFIED body settles ----------------------
    console.log('[138-sol-settle-mismatch] leg b: transient throws + null detail keep the honest busy state…');
    // Reset the transient-throw window for THIS leg and clear the seeded detail: the first five
    // re-reads throw (http 503), the rest return null → unverifiable → keeps polling.
    await driver.eval(() => { globalThis.__DPAY_TEST_SOL_GET_TX_READS = 0; globalThis.__DPAY_TEST_SOL_TX_DETAIL = null; });
    const legB = await merchantCycle(driver, 'leg-b', '0.03', null, false);
    await driver.waitForText('Broadcasting', {timeoutMs: 15_000});
    await new Promise((r) => setTimeout(r, 2_500)); // several polls land while unreadable
    let bodyB = await driver.bodyText();
    assert(/Broadcasting/.test(bodyB), 'leg b: the merchant should stay on the honest busy state while the body is unreadable');
    assert(!/Received/.test(bodyB), 'leg b: no false "Received" while unverifiable');
    assert(!/doesn.t match this request/i.test(bodyB), 'leg b: unverifiable must NOT be promoted to a mismatch verdict');
    assert(!/rejected/i.test(bodyB), 'leg b: unverifiable must NOT be promoted to a rejection');
    // The read recovered: the seeded body derives from THIS leg's signed tx → verified → settles.
    const detailB = solTxDetailFromSolpay(legB.solpayUri);
    await driver.eval((d) => { globalThis.__DPAY_TEST_SOL_TX_DETAIL = d; }, detailB);
    await driver.waitForText('Received', {timeoutMs: 10_000});
    console.log('[138-sol-settle-mismatch] ✓ leg b: busy while unreadable, settles only once verified');

    await driver.screenshot('138-sol-settle-mismatch-b');
    await newRequest(driver);

    // ---- Leg (c): confirmed body carries meta.err → REJECTED --------------------------------
    console.log('[138-sol-settle-mismatch] leg c: on-chain error record → rejected…');
    await merchantCycle(driver, 'leg-c', '0.04', (detail) => {
      detail.meta = {err: {InstructionError: [1, 'InsufficientFundsForFees']}, fee: 5000, preBalances: [], postBalances: []};
    });

    const errC = await driver.findByTestID('sol-req-err', {timeoutMs: 15_000});
    const errTxtC = await errC.evaluate((n) => (n.textContent ?? '').trim());
    assert(/rejected/i.test(errTxtC),
      `leg c: the merchant should see the friendly rejected copy, got: "${errTxtC}"`);
    const bodyC = await driver.bodyText();
    assert(!/Received/.test(bodyC), 'leg c: no false "Received" on an on-chain error record');
    console.log('[138-sol-settle-mismatch] ✓ leg c: friendly rejected copy');

    await driver.screenshot('138-sol-settle-mismatch-c');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[138-sol-settle-mismatch] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[138-sol-settle-mismatch] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
