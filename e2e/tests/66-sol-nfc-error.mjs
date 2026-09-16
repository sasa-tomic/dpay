// Flow 66 — SOL v2 NFC tap ERROR + DECLINED + PENDING phases (the failure modes flow 47 doesn't cover).
//
// Flow 47 proves the SOL v2 NFC happy path (linking → auto-sign → receipt → Paid ✓).
// This flow covers THREE failure surfaces + a merchant-side reader case:
//   - `expired auto-decline` (payer side): an expired solreq (exp in the past) is re-checked
//     authoritatively INSIDE the sign — the one-press rule (founder directive 2026-08-24) removed
//     the review card, so isSolReqV2Expired fires declineSolCard itself → "Declined" +
//     "This payment request has expired". No sign, no solpay URI.
//     (The reader's fast 0x6985 decline — SW_DECLINED from handleGet(TAG_PAYMENT) — is the
//     Kotlin transport hop, a device gate.)
//   - `error` (transport glitch): a `{type:'error', reason}` seam event (mid-tap radio loss) maps
//     to "Tap failed" + reason.
//   - `pending` (committed, late error ignored): once `settling` fired (committed=true), a late
//     transport error is IGNORED — a radio glitch can't overwrite a decided outcome.
//   - reader decline: the merchant (reader) side of the same seam — when the payer's card declines,
//     the merchant reader sees `phase: 'declined'` and surfaces "Declined".
//
// v2 changes from v1: no setup, no nonce-state gate, no btn-sol-pay-setup. The card mounts
// immediately in 'scan' when NFC is ready. Case 1 uses isSolReqV2Expired (exp in the past) instead
// of the v1 isSolReqExpired. Case 4's makeRequest is ONLINE (needs stub).
//
// Selector contract: `sol-nfc-status`, `asset-sol-select`, `sol-pay-scan`, `tab-receive`,
// `sol-req-amount-input`, `btn-sol-req-make`, `sol-req-qr`.
import {setup, assert, onboardWallet, armNfcCard, waitForWallet, openBalances} from '../harness/lib.mjs';
import { nfcPhase, nfcPhaseWalk } from '../harness/flow-steps.mjs';

export const meta = {
  id: '66',
  name: 'sol-nfc-error',
  journey: 'nfc',
  covers: ['sol-nfc-decline', 'sol-nfc-error', 'sol-nfc-receipt-unreachable', 'sol-nfc-phases', 'sol-nfc-reader-decline', 'no-fake-paid', 'terminal-escape', 'fail-closed'],
  verifies: 'SOL v2 NFC failure modes: expired solreq auto-declines at sign (honest reason, no sign); transport error → Tap failed; late error after settling ignored; merchant reader sees the decline.',
  timeoutMs: 30000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

// Build a solreq:v2 URI. Pass `expired` to set iat/exp in the past (the case-1 trigger).
function buildSolReq(opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  // For expired: exp must be in the past BUT exp-iat must be ≤90 (else decodeSolReq's structural
  // validation throws BEFORE isSolReqV2Expired runs). We anchor iat=now-85, exp=now-5 (diff=80≤90).
  const iat = opts.expired ? now - 85 : now;
  const exp = opts.expired ? now - 5 : iat + 90;
  const obj = {
    v: 2, rid: 'd'.repeat(32), net: 'mainnet-beta',
    bh: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN',
    lvh: 300_000_000, slot: 250_000_000,
    iat, exp,
    to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name: 'merchant', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[66-sol-nfc-error] setup (relay + web + browser)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // Force NFC ready so SolPayMode arms the HCE card on mount.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[66-sol-nfc-error] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-sol-nfc-err');

    // Install the SOL RPC stub (needed for case 4's ONLINE makeRequest; harmless for cases 1-3
    // which are fully offline).
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
        isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
        getBlockHeight: () => 250000001,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
        getBalance: () => ({value: 5000000000}),
      };
    });

    // Select SOL → SolPayMode mounts in 'scan' (v2: no setup, card armed immediately).
    console.log('[66-sol-nfc-error] selecting SOL (card mounts immediately, no setup)…');
    await waitForWallet(driver, {timeoutMs: 8_000});
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    // The accounts list is inline on Home (O4 S3) — the row select no longer closes any sheet,
    // so the flow owns the return to Pay.
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    console.log('[66-sol-nfc-error] ✓ SOL selected, card armed (no setup)');

    const dispatch = async (event) => { await armNfcCard(driver, 'sol'); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };

    // Escape a terminal/non-terminal NfcTapView: the button flips its label to "Done" on a terminal
    // phase (success/declined/error/pending) and stays "Cancel" mid-flow (settling). Dispatching a
    // phase only QUEUES a React update, so reading the DOM in the same tick can still see the OLD
    // label — a race that only loses on a loaded machine. Poll for the EXPECTED label (bounded),
    // then click it; if it never arrives, return whichever label is present so the caller's assert
    // names what it actually saw.
    const clickNfcButton = async (expected) => {
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
    };

    // --- 1. EXPIRED REQUEST → AUTO-DECLINE AT SIGN (the expiry gate is authoritative there). ---
    // One-press rule: no review card exists, so isSolReqV2Expired is re-checked INSIDE the sign —
    // the request declines itself (declineSolCard → terminal "Declined" + the honest reason),
    // nothing ever signs. (The reader's FAST 0x6985 decline — handleGet(TAG_PAYMENT) returns
    // SW_DECLINED the moment the card phase is DECLINED — is the Kotlin transport hop, a device
    // gate; case 4 covers the reader-side decline plumbing via the seam.)
    console.log('[66-sol-nfc-error] case 1: expired solreq → auto-decline at sign…');
    await nfcPhaseWalk(driver, dispatch, ['linking'], { statusId: 'sol-nfc-status', text: null });
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq({expired: true})});
    assert(await driver.waitForText('Declined', {timeoutMs: 5_000}),
      'an expired solreq should auto-decline at sign time (the honest "Declined" terminal)');
    const expiredBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(expiredBody), 'a declined SOL tap must NEVER show "Paid ✓"');
    assert(expiredBody.includes('This payment request has expired'),
      `the sign-time expiry reason should render. body excerpt:\n${expiredBody.slice(0, 400)}`);
    {
      const solpay = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
      assert(solpay == null, 'no solpay URI may exist for an expired request (nothing signed)');
    }
    console.log('[66-sol-nfc-error] ✓ expired solreq → auto-decline "This payment request has expired", no sign, no fake Paid');
    assert((await clickNfcButton('Done')) === 'Done', 'the Done button should be reachable after a decline');
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // --- 2. TRANSPORT ERROR mid-tap: honest "Tap failed", no fake Paid. -----------------------
    console.log('[66-sol-nfc-error] case 2: transport error mid-tap (linking → error)…');
    await nfcPhaseWalk(driver, dispatch, ['linking'], { statusId: 'sol-nfc-status', text: null });
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    assert(await driver.waitForText('Tap failed', {timeoutMs: 5_000}),
      'a mid-tap transport error should surface the honest "Tap failed" status');
    const errBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(errBody), 'a failed SOL tap must NEVER show "Paid ✓"');
    assert(errBody.includes('Lost the radio link'),
      `the error reason should render as the sub-line. body excerpt:\n${errBody.slice(0, 400)}`);
    console.log('[66-sol-nfc-error] ✓ transport error → "Tap failed" + reason, no fake Paid');
    assert((await clickNfcButton('Done')) === 'Done', 'the Done button should be reachable after an error');
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // --- 3. LATE ERROR AFTER SETTLING IGNORED (no false failure over a decided outcome). --------
    console.log('[66-sol-nfc-error] case 3: late error after settling is ignored (no false failure)…');
    await nfcPhase(driver, dispatch, 'linking', { statusId: 'sol-nfc-status', text: null, mount: true });
    await nfcPhase(driver, dispatch, 'exchanging', { text: null });
    assert(await nfcPhase(driver, dispatch, 'settling'), // committed=true
      'settling should surface the "Confirming…" status');
    await dispatch({type: 'error', role: 'card', reason: 'should be ignored'});
    // STALE-ASSERTION FIX: a bare waitForText('Confirming') would resolve on the FIRST poll — catching
    // the pre-render DOM before the error's effect (if any) could flip the phase. A fixed delay lets
    // React flush any would-be state update, then we snapshot the post-flush DOM. If the bug existed
    // (error overwrites the decided phase), "Confirming" would be gone after the flush.
    // Measured in FRAMES, not milliseconds — ten render opportunities, the same ten on an idle host
    // and on a saturated one (flow 60's idiom).
    await driver.settleFrames(10);
    const lateErrBody = await driver.bodyText();
    assert(lateErrBody.includes('Confirming'),
      'a late error after settling must NOT overwrite the receipt path');
    assert(!lateErrBody.includes('should be ignored'),
      'the late-error reason must NOT render (the error was ignored)');
    assert(!/Tap failed/.test(lateErrBody),
      'a late error must NOT flip the status to "Tap failed"');
    console.log('[66-sol-nfc-error] ✓ late error after settling ignored — phase stays on the receipt path');
    assert((await clickNfcButton('Cancel')) === 'Cancel',
      'the Cancel button should be reachable on the receipt path (mid-flow)');

    // --- 4. MERCHANT (READER) DECLINE: the merchant sees the same decline. --------------------
    // Switch to Receive, make a solreq (ONLINE via stub), dispatch reader decline.
    console.log('[66-sol-nfc-error] case 4: merchant reader sees the decline (reader plumbing)…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000}); // reader is now mounted (nfc ready)
    await nfcPhase(driver, dispatch, 'linking', { role: 'reader', statusId: 'sol-nfc-status', text: null, mount: true });
    assert(await nfcPhase(driver, dispatch, 'declined', { role: 'reader', text: 'Declined', timeoutMs: 5_000 }),
      'the merchant reader should surface the honest "Declined" status');
    const readerBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(readerBody) && !/Received/.test(readerBody),
      'a declined reader tap must NEVER show "Paid ✓" or "Received"');
    console.log('[66-sol-nfc-error] ✓ merchant reader → "Declined" (reader-side plumbing proven)');

    await driver.screenshot('66-sol-nfc-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[66-sol-nfc-error] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[66-sol-nfc-error] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
