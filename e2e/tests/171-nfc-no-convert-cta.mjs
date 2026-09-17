// Flow 171 — V9 INVARIANT 8, the NFC half: the NFC/HCE payment surfaces never grow convert
// affordances. (Companion of flow 170, which pins the same invariant on the scan-intent pay
// surfaces; this one walks every NFC sub-surface the harness can drive.)
//
// The invariant's reason: convert is a deliberate wallet journey (Accounts → the ICP row →
// Convert, V11: gated to protocol==='ic'). No payment flow — least of all the one-press NFC tap,
// where a single press at "Pay Now" is the user's whole consent — may ever offer a conversion.
// A convert CTA surfacing mid-tap would be exactly the "conversion offer inside a payment flow"
// the spec forbids.
//
// Sub-surfaces walked (all driven through the REAL NfcTap / SolNfcTap state machines via the
// __DPAY_TEST_NFC_SESSION / __DPAY_TEST_SOL_NFC_SESSION seams — the same event plumbing the
// native modules emit; the radio hop itself stays a physical-device gate):
//   IC payer card (NfcTap):  idle armed pay surface · linking · exchanging · settling · the
//                            success terminal ("Paid ✓") · the auto-sign exchanging status with
//                            the honest asset disclosure ("Paying 0.0005 BTC on Bitcoin",
//                            flow-32 shape — money moving, the strongest place for a CTA to
//                            creep in) · the declined terminal · the error terminal ("Tap
//                            failed").
//   SOL payer card (SolNfcTap): idle armed SolPayMode · linking · the auto-sign exchanging
//                            status ("Paying 0.001005 SOL") · the receipt-bound paid phase
//                            ("Sent · awaiting the merchant's confirmation").
// On each, the same zero-tolerance census flow 170 uses must count ZERO convert affordances
// (no convert-* testIDs, no Accounts-Convert entry, no button/radio/link labelled "Convert").
//
// NOT reachable in this harness (noted, not faked): the READER-side NFC surface — that is the
// merchant till terminal (flow 117's /till page, served by the relay), not a wallet surface, and
// it has no convert surface of its own to walk; and the NFC 'pending' terminal (the
// settle-receipt timer), which renders through the same NfcTapView shell whose terminals are
// walked above. The probe's honesty control (Accounts with the ICP row selected reports exactly
// ONE convert affordance) runs mid-flow, proving the census CAN fail.
import {setup, assert, assertEq, onboardWallet, armNfcCard, openBalances, selectCurrency} from '../harness/lib.mjs';
import { nfcPhase } from '../harness/flow-steps.mjs';

export const meta = {
  id: '171',
  name: 'nfc-no-convert-cta',
  journey: 'nfc',
  covers: ['nfc', 'convert-absence', 'inv-8', 'nfc-phases', 'auto-sign', 'sol-nfc', 'no-conversion-in-payment'],
  verifies: 'Every NFC sub-surface reachable in the harness (IC card: idle/linking/exchanging/settling/success/auto-sign-disclosure/declined/error; SOL card: idle/linking/auto-sign/receipt-paid) shows ZERO convert affordances — the one-press tap never grows a conversion offer. Reader-side (merchant till) is not a wallet surface; pending terminal shares the walked NfcTapView shell.',
  timeoutMs: 90000,
};

/** Zero-tolerance convert census — the SAME probe flow 170 uses: every convert testID, the
  * Accounts-Convert entry point, and any button/radio/link whose full label is "Convert". */
function convertCtaCount(driver) {
  return driver.eval(() => {
    const byTestID = document.querySelectorAll('[data-testid^="convert-"], [data-testid="btn-accounts-convert"]').length;
    const byLabel = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], a'))
      .filter(el => (el.textContent ?? '').trim() === 'Convert').length;
    return byTestID + byLabel;
  });
}

/** Poll for the expected NfcTapView escape button (Done on a terminal phase, Cancel mid-flow),
  * then click it — the flow-60 helper verbatim (a phase event only QUEUES a React update, so
  * reading the DOM in the same tick can still see the OLD label). */
async function clickNfcButton(driver, expected) {
  for (let i = 0; i < 40; i++) {
    const hit = await driver.eval((label) => {
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      if (btn) { btn.click(); return label; }
      return null;
    }, expected);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return driver.eval(() => {
    for (const label of ['Done', 'Cancel']) {
      if (document.querySelector(`button[aria-label="${label}"]`)) return label;
    }
    return null;
  });
}

// ---- SOL v2 solreq builder + sig extractor (flow-47 helpers, verbatim) -------------------------
const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL
const REQ_RID = 'c'.repeat(32);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function extractSig(solpayUri) {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  const sigBytes = new Uint8Array(tx.slice(1, 65)); // compact-u16 count || sig64 || msg
  return bs58Encode(sigBytes);
}

function buildSolReq() {
  const iat = Math.floor(Date.now() / 1000);
  const obj = {
    v: 2, rid: REQ_RID, net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000, slot: 250_000_000,
    iat, exp: iat + 90,
    to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name: 'merchant', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[171-nfc-no-convert] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver} = env;

    // Zero-convert assertion, named for the surface it runs on.
    const zeroConvert = async (surface) => {
      const n = await convertCtaCount(driver);
      assertEq(n, 0, `NFC surface "${surface}" shows ZERO convert affordances (found ${n})`);
      console.log(`[171-nfc-no-convert] ✓ ${surface}: 0 convert affordances`);
    };

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts so Pay mode arms the HCE card.
    const nfcSeam = await driver.addInitScript(() => { globalThis.__DPAY_TEST_NFC_STATUS = 'ready'; });
    console.log('[171-nfc-no-convert] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-nfc-no-convert');
    await driver.removeInitScript(nfcSeam);
    await driver.findByTestID('pay-scan', {timeoutMs: 5_000});

    const dispatch = async (event) => { await armNfcCard(driver, 'ic'); return driver.eval((e) => window.__DPAY_TEST_NFC_SESSION(e), event); };

    // --- IC card: idle armed pay surface (listening for a tap, QR scanner live). -----------------
    await armNfcCard(driver, 'ic');
    await zeroConvert('IC idle armed pay surface');

    // --- IC card: the pure phase walk — every NfcTapView status the tap passes through. ---------
    assert(await nfcPhase(driver, dispatch, 'linking', { statusId: 'nfc-status', mount: true }), 'linking should show "Connecting…"');
    await zeroConvert('IC linking (Connecting…)');

    assert(await nfcPhase(driver, dispatch, 'exchanging'), 'exchanging should show "Communicating…"');
    await zeroConvert('IC exchanging (Communicating…)');

    assert(await nfcPhase(driver, dispatch, 'settling'), 'settling should show "Confirming…"');
    await zeroConvert('IC settling (Confirming…)');

    assert(await nfcPhase(driver, dispatch, 'success', { text: 'Paid', timeoutMs: 5_000 }), 'success should show the honest "Paid ✓" terminal');
    await zeroConvert('IC success terminal (Paid ✓)');
    assert((await clickNfcButton(driver, 'Done')) === 'Done', 'Done reachable after the success terminal');
    await driver.waitGone('nfc-status', {timeoutMs: 5_000});

    // --- IC card: AUTO-SIGN exchanging with the honest asset disclosure (flow-32 shape). --------
    // Money is moving and the asset/amount sit in front of the payer — the strongest place for a
    // convert CTA to creep in. None may exist.
    const nowSecs = Math.floor(Date.now() / 1000);
    await dispatch({
      type: 'request', role: 'card',
      toHex: '11'.repeat(32), amount: '50000', nonceHex: 'ab'.repeat(16),
      expiry: nowSecs + 300, currency: 1, toName: 'merchant', memo: 'two coffees',
    });
    assert(await driver.waitForText('Communicating', {timeoutMs: 6_000}), 'a payable request should auto-sign → exchanging');
    {
      const body = await driver.bodyText();
      assert(body.includes('Paying 0.0005 BTC on Bitcoin'), 'the honest asset disclosure rides the status (pre-condition)');
    }
    await zeroConvert('IC auto-sign exchanging (Paying 0.0005 BTC on Bitcoin)');
    await dispatch({type: 'phase', role: 'card', phase: 'declined'}); // terminal cleanup (flow-32 pattern)
    await driver.waitForText('Declined', {timeoutMs: 5_000});
    await zeroConvert('IC declined terminal');
    assert((await clickNfcButton(driver, 'Done')) === 'Done', 'Done reachable after the declined terminal');
    await driver.waitGone('nfc-status', {timeoutMs: 5_000});

    // --- IC card: the transport-error terminal ("Tap failed"). ----------------------------------
    await nfcPhase(driver, dispatch, 'linking', { statusId: 'nfc-status', text: null, mount: true });
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    assert(await driver.waitForText('Tap failed', {timeoutMs: 5_000}), 'the error terminal should show "Tap failed"');
    await zeroConvert('IC error terminal (Tap failed)');
    assert((await clickNfcButton(driver, 'Done')) === 'Done', 'Done reachable after the error terminal');
    await driver.waitGone('nfc-status', {timeoutMs: 5_000});

    // --- PROBE CONTROL: the census CAN fail — Accounts with the ICP row selected shows exactly ---
    // --- ONE convert entry point (the V11-gated button). A probe that cannot fail is not a     ---
    // --- gate. (Scoped to the button's testID, like flow 170's control — the full census would ---
    // --- double-count the same element through its label branch.)                              ---
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    const control = await driver.eval(() =>
      document.querySelectorAll('[data-testid="btn-accounts-convert"]').length);
    assertEq(control, 1, `probe control: the Accounts list (ICP selected) carries the one legit Convert entry (found ${control})`);
    console.log('[171-nfc-no-convert] ✓ probe control: Accounts/ICP shows exactly 1 convert affordance');

    // --- SOL card: idle armed SolPayMode, then the tap phases + the receipt-bound paid phase. ----
    await openBalances(driver);
    await selectCurrency(driver, 'sol');
    await driver.findByTestID('btn-sol-start-scan', {timeoutMs: 5_000});
    const dispatchSol = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };

    await zeroConvert('SOL idle armed pay surface');

    assert(await nfcPhase(driver, dispatchSol, 'linking', { statusId: 'sol-nfc-status', mount: true }), 'SOL linking should show "Connecting…"');
    await zeroConvert('SOL linking (Connecting…)');

    await dispatchSol({type: 'request', role: 'card', solreqUri: buildSolReq()});
    assert(await driver.waitForText('Communicating', {timeoutMs: 6_000}), 'SOL request should auto-sign → exchanging');
    {
      const body = await driver.bodyText();
      assert(body.includes('Paying 0.001005 SOL'), 'the SOL read-only amount rides the status (pre-condition)');
    }
    await zeroConvert('SOL auto-sign exchanging (Paying 0.001005 SOL)');

    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v2?'), 'the auto-sign produced a solpay:v2 URI (pre-condition)');
    await dispatchSol({type: 'receipt', role: 'card', status: 0, rid: REQ_RID, sig: extractSig(solpayUri)});
    assert(await driver.waitForText('awaiting', {timeoutMs: 5_000}), 'receipt success → the honest pending ("Sent · awaiting")');
    await zeroConvert('SOL paid phase (Sent · awaiting the merchant\'s confirmation)');

    await driver.screenshot('171-nfc-no-convert');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[171-nfc-no-convert] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[171-nfc-no-convert] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
