// Flow 66 — SOL NFC tap ERROR + DECLINED + PENDING phases (the failure modes flow 47's happy path
// doesn't cover, for the SOL rail specifically).
//
// Flow 47 proves the SOL NFC happy path (linking → exchanging → receipt → Paid ✓ + nonce adoption).
// But the SOL NFC rail (SolNfcTap.tsx → useNfcTapState) has THREE failure surfaces, NONE of which
// were covered for SOL before this flow (flow 60 covers them for the IC rail):
//   - `declined` (payer side): the autoSign callback refuses to sign. The SOL-specific trigger is
//     `isSolReqExpired(req)` (SolNfcTap.tsx line 60-62): an expired solreq is a stale-replay vector
//     unique to SOL (the rail has no server to reject it, so the payer enforces exp client-side).
//     autoSign calls `DpaySolNfc.declineSolCard()` + `ctx.finalize('declined', 'This payment request
//     has expired')`. The cardholder sees "Declined" + the SOL-specific "expired" reason.
//   - `error` (transport glitch): a `{type:'error', reason}` seam event (mid-tap radio loss) maps to
//     `finalize('error', reason)` → "Tap failed" + reason. SAME shared-hook behavior as flow 60 but
//     exercised through the SOL surface (testID `sol-nfc-status`, seam `__DPAY_TEST_SOL_NFC_SESSION`).
//   - `pending` (committed, late error ignored): once `settling` fired (committed=true), a late
//     transport error is IGNORED by useNfcTapState (line 112) — a radio glitch can't overwrite a
//     decided outcome. The phase stays on the receipt path. This is the catch-all "no false failure
//     over a decided outcome" rule that separates an honest transport glitch from a real funds loss;
//     a late `error` after `settling` is exactly the SOL analog of the IC case flow 60 proves.
//
// Plus a 4th case unique to the SOL rail: the merchant (reader) side of the same seam. SolNfcTap
// mounts with role="reader" inside SolReceiveMode when an solreq QR is showing + NFC ready. The
// reader listens for the SAME seam events (filtered by role). When the payer's card declines, the
// merchant reader sees `phase: 'declined'` and surfaces "Declined" — proving the merchant-side
// plumbing that flow 47 (card-only, single-driver simulation) doesn't reach.
//
// This flow drives the REAL SolNfcTap state machine via `__DPAY_TEST_SOL_NFC_SESSION` (the SOL seam,
// NOT the IC `__DPAY_TEST_NFC_SESSION`). The app code is the REAL app — no mocks at the protocol
// layer, only at the I/O seam (the SOL RPC stub + the NFC session seam). The radio hop stays a
// physical-device gate.
//
// Selector contract: `sol-nfc-status` (SolNfcTap's NfcTapView testID), `balance` (unchanged), the
// Done/Cancel button (aria-label — terminal vs mid-flow), `asset-sol-select` + `btn-sol-pay-setup`
// (card-side nonce arming), `tab-receive` + `btn-sol-req-make` + `sol-req-qr` (reader-side mount).
import {setup, assert, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '66',
  name: 'sol-nfc-error',
  journey: 'nfc',
  covers: ['sol-nfc-decline', 'sol-nfc-error', 'sol-nfc-receipt-unreachable', 'sol-nfc-phases', 'sol-nfc-reader-decline', 'no-fake-paid', 'terminal-escape'],
  verifies: 'SOL NFC tap failure modes: an expired solreq autoSign decline surfaces honest "Declined" + "expired" (never Paid); a mid-tap transport error surfaces "Tap failed"; a late error after settling is ignored (no false failure over a decided outcome); the merchant reader sees the same decline.',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

// 80-byte durable-nonce NonceState as base64 (u32 version | u32 state=Initialized | 32B authority |
// 32B nonce value | u64 fee). getNonceAccount parses this layout. Verbatim from flow 47.
function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(1, 4);
  buf.fill(1, 8, 40);
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40);
  buf.writeBigUInt64LE(5000n, 72);
  return buf.toString('base64');
}

// Build a solreq:v1 URI. `expSeconds` is the expiry (unix seconds); pass a PAST value to make the
// request expired (the case-1 trigger). The codec is the inverse of decodeSolReq; mirrors flow 47.
function buildSolReq(expSeconds) {
  const obj = {
    v: 1, to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null,
    exp: expSeconds,
    name: 'merchant', memo: '',
  };
  return 'solreq:v1?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[66-sol-nfc-error] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts so SolPayMode arms the SOL HCE
    // card on mount (without this, SolNfcTap is never rendered and seam events find no listener).
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[66-sol-nfc-error] onboarding (NFC forced ready)…');
    await onboardWallet(driver, 'e2e-sol-nfc-err');

    // Install the SOL RPC stub (functional for createNonceAccount; not exercised by the failure
    // cases below — they fail BEFORE any broadcast, in the autoSign path or the seam event path).
    const nonceB64 = nonceAccountB64();
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
      };
    }, nonceB64);

    // SOL is selected as the active asset → SolPayMode mounts → first-use setup creates the durable
    // nonce (so the card-side SolNfcTap mounts — gated on `nonceState?.status === 'ready'`).
    console.log('[66-sol-nfc-error] selecting SOL + setting up durable-nonce…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.click('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 12_000});
    console.log('[66-sol-nfc-error] ✓ SOL selected + durable-nonce ready (card armed)');

    // Helper: dispatch one SOL NFC event through the seam. role='card' = the payer being tapped;
    // role='reader' = the merchant listening for taps.
    const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event);

    // Escape a terminal/non-terminal SolNfcTap: the NfcTapView button flips its label to "Done" on
    // a terminal phase (success/declined/error/pending) and stays "Cancel" mid-flow (settling).
    // Try both — the case 3 (late-error-ignored) cancel uses the "Cancel" label specifically.
    const clickNfcButton = () => driver.eval(() => {
      for (const label of ['Done', 'Cancel']) {
        const btn = document.querySelector(`button[aria-label="${label}"]`);
        if (btn) { btn.click(); return label; }
      }
      return null;
    });

    // --- 1. EXPIRED-REQUEST DECLINE (SOL-specific autoSign path, SolNfcTap.tsx line 60-62). -----
    // The cardholder taps → request arrives → autoSign decodes the solreq → isSolReqExpired is true
    // → declineSolCard + finalize('declined', 'This payment request has expired'). The cardholder
    // sees the honest "Declined" status + the SOL-specific "expired" reason — NEVER "Paid ✓".
    console.log('[66-sol-nfc-error] case 1: expired solreq decline (SOL-specific autoSign path)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    const expiredReq = buildSolReq(Math.floor(Date.now() / 1000) - 600); // expired 10 min ago
    await dispatch({type: 'request', role: 'card', solreqUri: expiredReq});
    assert(await driver.waitForText('Declined', {timeoutMs: 5_000}),
      'an expired solreq should surface the honest "Declined" status');
    const expiredBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(expiredBody), 'a declined SOL tap must NEVER show "Paid ✓"');
    assert(/expir/.test(expiredBody),
      `the SOL-specific "expired" reason should render. body excerpt:\n${expiredBody.slice(0, 400)}`);
    // No debit on a decline: the SOL tap never reached broadcast (declined BEFORE signing), so no
    // money moved. The "no Paid" check above is the no-debit proof — we don't assert the SOL balance
    // directly because SOL is the active asset (the header shows the SOL balance, not the DEMO ∂ one
    // flow 60 reads). The stub's getBalance is unchanged across the case anyway.
    console.log('[66-sol-nfc-error] ✓ expired solreq → "Declined" + "expired", no fake Paid');
    assert((await clickNfcButton()) === 'Done', 'the Done button should be reachable after a decline');
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // --- 2. TRANSPORT ERROR mid-tap (linking → error): honest "Tap failed", no fake Paid. -------
    // A `{type:'error', reason}` seam event represents a real radio loss (the phones separated, the
    // HCE service threw). useNfcTapState maps it to `finalize('error', reason)` — but ONLY if no
    // outcome is committed yet (a transport error after the wire left says nothing about whether
    // the ledger settled; the hook deliberately does NOT overwrite a decided outcome — case 3 below).
    console.log('[66-sol-nfc-error] case 2: transport error mid-tap (linking → error)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    await dispatch({type: 'error', role: 'card', reason: 'Lost the radio link'});
    assert(await driver.waitForText('Tap failed', {timeoutMs: 5_000}),
      'a mid-tap transport error should surface the honest "Tap failed" status');
    const errBody = await driver.bodyText();
    assert(!/\bPaid\b/.test(errBody), 'a failed SOL tap must NEVER show "Paid ✓"');
    assert(errBody.includes('Lost the radio link'),
      `the error reason should render as the sub-line. body excerpt:\n${errBody.slice(0, 400)}`);
    console.log('[66-sol-nfc-error] ✓ transport error → "Tap failed" + reason, no fake Paid');
    assert((await clickNfcButton()) === 'Done', 'the Done button should be reachable after an error');
    await driver.waitGone('sol-nfc-status', {timeoutMs: 5_000});

    // --- 3. LATE ERROR AFTER SETTLING IGNORED (the "no false failure over a decided outcome"). ---
    // Once the wire left the phone (settling → committed=true), a transport error says nothing about
    // whether the ledger settled. useNfcTapState (line 112) deliberately IGNORES a late `error` so a
    // radio glitch can't mask a real success. We drive settling, fire a late error, and assert the
    // phase does NOT flip to 'error' (it stays on the receipt path: still "Confirming…"). This is
    // the SOL analog of flow 60's case 3 — the rule is rail-agnostic, but exercising it through the
    // SOL surface proves the SOL adapter inherits the shared-hook guard correctly.
    console.log('[66-sol-nfc-error] case 3: late error after settling is ignored (no false failure)…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    await dispatch({type: 'phase', role: 'card', phase: 'exchanging'});
    await dispatch({type: 'phase', role: 'card', phase: 'settling'}); // committed=true
    assert(await driver.waitForText('Confirming', {timeoutMs: 4_000}),
      'settling should surface the "Confirming…" status');
    // Fire the late error — it MUST be ignored (committed=true).
    await dispatch({type: 'error', role: 'card', reason: 'should be ignored'});
    // The phase stays on the receipt path: still "Confirming…" (NOT "Tap failed"). Give the
    // assertion a moment to catch a regression (a hook that overwrites would flip immediately).
    const stillConfirming = await driver.waitForText('Confirming', {timeoutMs: 2_000});
    assert(stillConfirming, 'a late error after settling must NOT overwrite the receipt path');
    const lateErrBody = await driver.bodyText();
    assert(!lateErrBody.includes('should be ignored'),
      'the late-error reason must NOT render (the error was ignored)');
    assert(!/Tap failed/.test(lateErrBody),
      'a late error must NOT flip the status to "Tap failed"');
    console.log('[66-sol-nfc-error] ✓ late error after settling ignored — phase stays on the receipt path');
    // Escape the receipt path (Cancel — mid-flow label, not the terminal Done). The settling timer
    // would eventually time out to 'pending' on its own; we cancel to move on.
    assert((await clickNfcButton()) === 'Cancel',
      'the Cancel button should be reachable on the receipt path (mid-flow)');

    // --- 4. MERCHANT (READER) DECLINE: the merchant sees the same decline (SOL reader plumbing). -
    // Flow 47 drives only the card side. The reader (merchant) SolNfcTap mounts in SolReceiveMode
    // when phase==='reqQr' + nfcReady; it shares the same useNfcTapState + the same DpaySolNfcEvent
    // bus. When the payer's card declines, the merchant's reader sees `phase: 'declined'` and
    // surfaces "Declined" — proving the merchant-side plumbing that flow 47 doesn't reach. Switch to
    // the Receive tab, make a solreq (mounts the reader), dispatch a `role:'reader'` decline.
    console.log('[66-sol-nfc-error] case 4: merchant reader sees the decline (reader plumbing)…');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});
    await driver.type('sol-req-amount-input', '0.025', {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000}); // reader is now mounted (nfc ready)
    // Drive the reader: linking → declined (the payer's card declined the tap).
    await dispatch({type: 'phase', role: 'reader', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    await dispatch({type: 'phase', role: 'reader', phase: 'declined'});
    assert(await driver.waitForText('Declined', {timeoutMs: 5_000}),
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
