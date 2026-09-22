// Flow 77 — Solana USDC "Send to address" happy path + the rent pre-check failure.
//
// Flow 52 (sol-withdraw) proves the native-SOL sheet; flow 72 proves the fail-closed device-ATA
// gate + the one-tap create. This flow completes the USDC send matrix by driving the SPL transfer
// END-TO-END through the REAL app — the path that had ZERO e2e coverage (only jest byte-exact
// proofs, which structurally cannot see the UI phases):
//
//   CASE 1 — happy path (both ATAs exist):
//     Balances → select USDC·Solana → Pay tab → "Send to address" → the form renders in USDC
//     units ("Available: 2.500000 USDC"); entering address + amount surfaces the review card with
//     the USDC rent disclosure note (`sol-send-ata-note`: "If they have no USDC account yet,
//     this creates it for them (one-time ≈0.00204428 SOL paid by you)") → confirm → sendSpl
//     (accountExists ×2 → blockhash → sign locally → sendTransaction → confirm, all stubbed) →
//     "Sent ✓" + signature.
//
//   CASE 2 — recipient ATA absent + sender SOL below the rent floor (folded in to share the
//     setup/teardown): sendSpl's honest cost pre-check fires BEFORE building anything — the
//     friendly error ("They have no USDC account yet. Creating it costs about 0.00204428
//     SOL, paid by you — send a little SOL here first") renders via `sol-send-err` and NO
//     "Sent ✓" state is reached (the sheet stays on the form).
//
// Stub design (the per-address dispatch is the point): `getAccountInfo` must answer differently
// for the DEVICE/SOURCE ATA (exists — the USDC balance poll + sendSpl's sender check read it) vs
// the RECIPIENT ATA (absent, in case 2). The device ATA is LEARNED from the first call after the
// stub install (the balance poll fires within one fast-poll tick, long before any confirm-time
// call) and pinned; every other address is governed by the mutable `recipientAtaAbsent` flag.
// `getBalance` is likewise mutable: 5 SOL for case 1, 0.001 SOL (1_000_000 lamports — below the
// 2_044_280 rent+fee floor) for case 2.
//
// Selector contract: `asset-sol-usdc-select`, `btn-pay-send`, `sol-send-address-input`,
// `sol-send-amount-input`, `sol-send-review-amount`, `sol-send-ata-note`, `btn-sol-send-confirm`,
// `sol-send-outcome`, `sol-send-signature`, `sol-send-err`.
import {setup, assert, assertEq, assertIncludes, onboardWallet, openBalances} from '../harness/lib.mjs';

export const meta = {
  id: '77',
  name: 'sol-usdc-withdraw',
  journey: 'withdraw',
  covers: ['sol-usdc-withdraw', 'spl-transfer', 'ata-note', 'rent-precheck', 'sol-send'],
  verifies: 'USDC send to address: happy path (USDC units + rent disclosure note → Sent ✓) and the below-rent pre-check failure (friendly error, no Sent).',
  timeoutMs: 90000,
};

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const SEND_AMOUNT = '1.5'; // 1.5 USDC = 1_500_000 base units

export async function run() {
  const start = Date.now();
  console.log('[77-sol-usdc-withdraw] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[77-sol-usdc-withdraw] onboarding…');
    await onboardWallet(driver, 'e2e-sol-usdc-send');

    // Stateful per-address stub (see the header comment). The device/source ATA is learned from the
    // first getAccountInfo call (the USDC balance poll); `recipientAtaAbsent` + `solLamports` are
    // flipped in place between the two cases. The USDC poll reads 2.5 USDC (2_500_000 base units).
    await driver.eval(() => {
      const st = {recipientAtaAbsent: false, solLamports: 5000000000};
      globalThis.__DPAY_TEST_SEND_STATE = st;
      let deviceAta = null; // pinned from the first (balance-poll) call — the source ATA
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: st.solLamports, token: {amount: '2500000', decimals: 6}}),
        getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_spl_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: (params) => {
          const addr = Array.isArray(params) ? String(params[0]) : String(params);
          if (deviceAta === null) deviceAta = addr;
          // Only a NON-device address can be the absent recipient ATA (case 2). The device/source
          // ATA always exists — it funds the send + feeds the balance poll.
          const absent = st.recipientAtaAbsent && addr !== deviceAta;
          return absent
            ? {value: null}
            : {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}};
        },
        getBalance: () => ({value: st.solLamports}),
        getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
      };
    });

    // 1. Select USDC·Solana via Balances (the same whole-row IA every asset uses).
    console.log('[77-sol-usdc-withdraw] selecting USDC·Solana via Balances…');
    await openBalances(driver);
    await driver.findByTestID('asset-sol-usdc-select', {timeoutMs: 8_000});
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});

    // 2. Pay tab → "Send to address": the sheet mounts with token='USDC' (device ATA exists → no
    //    gate) and renders in USDC units.
    console.log('[77-sol-usdc-withdraw] Pay tab → "Send to address"…');
    await driver.click('tab-pay', {timeoutMs: 5_000});
    await driver.findByTestID('pay-mode-toggle', {timeoutMs: 5_000});
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 8_000});
    await driver.waitForText('Available: 2.500000 USDC', {timeoutMs: 5_000});
    console.log('[77-sol-usdc-withdraw] ✓ form renders in USDC units');

    // 3. Enter address + amount → the review card carries the exact USDC amount + the rent note.
    await driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4_000});
    await driver.type('sol-send-amount-input', SEND_AMOUNT, {timeoutMs: 4_000});
    const review = await driver.findByTestID('sol-send-review-amount', {timeoutMs: 4_000});
    const reviewTxt = await review.evaluate((n) => (n.textContent ?? '').trim());
    assert(reviewTxt === 'Send 1.5 USDC', `review should read "Send 1.5 USDC", got: "${reviewTxt}"`);
    console.log(`[77-sol-usdc-withdraw] ✓ review: ${reviewTxt}`);

    const note = await driver.findByTestID('sol-send-ata-note', {timeoutMs: 4_000});
    const noteTxt = await note.evaluate((n) => (n.textContent ?? '').trim());
    assertIncludes(noteTxt, "If they have no USDC account yet, this creates it for them", 'the USDC review card must disclose the recipient-ATA rent');
    assertIncludes(noteTxt, 'one-time ≈0.00204428 SOL paid by you', 'the rent disclosure must carry the exact SOL_ATA_SETUP_MIN_LAMPORTS cost');
    console.log('[77-sol-usdc-withdraw] ✓ rent disclosure note rendered');

    // 4. Confirm → sendSpl through the stub (sender+recipient exist → plain SPL transfer) → Sent ✓.
    console.log('[77-sol-usdc-withdraw] confirming (sign + broadcast via stub)…');
    await driver.click('btn-sol-send-confirm', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the sheet should show "Sent ✓", got: "${statusTxt}"`);
    console.log(`[77-sol-usdc-withdraw] ✓ ${statusTxt}`);
    const sig = await driver.findByTestID('sol-send-signature', {timeoutMs: 5_000});
    const sigTxt = await sig.evaluate((n) => (n.textContent ?? '').trim());
    assert(/^sig_spl_/.test(sigTxt), `the sent signature should be rendered, got: "${sigTxt}"`);
    console.log(`[77-sol-usdc-withdraw] ✓ signature: ${sigTxt}`);
    await driver.screenshot('77-sol-usdc-withdraw');

    // 5. CASE 2 — recipient ATA ABSENT + sender SOL below the rent floor. Close the done screen
    //    (back to the scan sub-mode, unmounting the sheet), flip the stub, then re-open "Send to
    //    address": a FRESH sheet mounts (new form state). sendSpl's pre-check must throw BEFORE
    //    any broadcast — the friendly rent message renders via `sol-send-err`, no "Sent ✓".
    console.log('[77-sol-usdc-withdraw] case 2: absent recipient ATA + 0.001 SOL sender…');
    await driver.click('btn-sol-send-done', {timeoutMs: 5_000});
    await driver.waitGone('sol-send-outcome', {timeoutMs: 5_000});
    await driver.eval(() => {
      const st = globalThis.__DPAY_TEST_SEND_STATE;
      st.recipientAtaAbsent = true;
      st.solLamports = 1000000; // 0.001 SOL < 2_044_280 rent+fee floor
    });
    await driver.click('btn-pay-send', {timeoutMs: 5_000});
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 8_000});
    await driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4_000});
    await driver.type('sol-send-amount-input', SEND_AMOUNT, {timeoutMs: 4_000});
    await driver.click('btn-sol-send-confirm', {timeoutMs: 5_000});

    const err = await driver.findByTestID('sol-send-err', {timeoutMs: 12_000});
    const errTxt = await err.evaluate((n) => (n.textContent ?? '').trim());
    // The WHOLE sentence, not a prefix. The prefix version of this assertion ended at the amount
    // and therefore passed for two years' worth of "…0.00204428 SOL of SOL in this wallet" — the
    // unit printed twice, on the error path, in every locale (fixed 2026-09-08: `fmtAsset` owns
    // the unit, so the i18n template must not re-append it; pinned in __tests__/solana-ata-copy).
    assertEq(
      errTxt,
      "They have no USDC account yet. Creating it costs about 0.00204428 SOL, paid by you "
      + '— send a little SOL here first',
      'the pre-check error renders the whole sentence, with the rent amount carrying its unit ONCE',
    );
    console.log('[77-sol-usdc-withdraw] ✓ rent pre-check failure surfaced verbatim');

    // No success state: the sheet stays on the form — no "Sent ✓", no signature, no broadcast.
    const sent = await driver.eval(() => !!document.querySelector('[data-testid="sol-send-outcome"]'));
    assert(sent === false, 'no "Sent ✓" state may be reached on a below-rent pre-check failure');
    await driver.findByTestID('sol-send-address-input', {timeoutMs: 5_000});
    console.log('[77-sol-usdc-withdraw] ✓ no Sent state; the form is still up');
    await driver.screenshot('77-sol-usdc-withdraw-rent-err');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[77-sol-usdc-withdraw] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[77-sol-usdc-withdraw] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
