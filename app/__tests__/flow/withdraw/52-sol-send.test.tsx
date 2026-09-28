/**
 * Flows 52 + 77 — the jest twins of `e2e/tests/52-sol-withdraw.mjs` and `77-sol-usdc-withdraw.mjs`
 * (the Solana "Send to address" sheet: native SOL + SPL USDC, through the in-memory RPC stub).
 *
 * 52: SOL selectable via the SAME tab IA every currency uses; the send↔scan toggle round-trip
 * preserves state; a Bitcoin paste is refused BY NAME with Confirm disabled; a valid destination
 * has its route disclosed; confirm signs + broadcasts → "Sent ✓" + signature. 77: the USDC send —
 * USDC units, the recipient-ATA rent disclosure note, Sent ✓ — plus the below-rent pre-check that
 * refuses with the WHOLE sentence (unit printed once) and never reaches Sent.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ../pay/solrpc).
 */
import {describe, it, expect} from '@jest/globals';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from '../pay/solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {assertDisabled, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency, selectSolRail} = lib;

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'; // a real address on the WRONG chain
const SEND_AMOUNT = '0.001'; // 0.001 SOL = 1_000_000 lamports

describe('flow 52 — SOL withdraw (native SOL send sheet)', () => {
  it('wrong-chain refusal by name; route disclosed; confirm broadcasts; Sent ✓ + signature', async () => {
    const m = await onboardWallet('jest-sol-send');

    // 5 SOL on the device; no USDC account (silences the USDC poll).
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '0', decimals: 6}}),
    });

    // 1. Balances → select SOL (whole-row, uniform with IC).
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});

    // 2. Pay tab → the SolPayMode scan surface; then the send↔scan toggle round-trip (Rules of
    //    Hooks regression): the scan screen survives the detour, the inputs come and go cleanly.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-mode-toggle', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 5000});
    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await m.driver.waitGone('sol-send-address-input', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});

    // 3. Re-open send; a Bitcoin paste is refused BY NAME and Confirm stays disabled.
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 5000});
    await m.driver.type('sol-send-address-input', BTC_ADDR, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => {
      const t = m.driver.readTextSafe('sol-send-status') ?? '';
      return t.includes('Bitcoin') && t.includes('Solana');
    }, {timeoutMs: 6000, label: 'a Bitcoin paste is refused by name'});
    expect(m.driver.readText('sol-send-status')).toContain('Bitcoin');
    assertDisabled(m, 'btn-sol-send-confirm', 'a refused destination must leave Confirm disabled');

    // 4. A valid destination has its route disclosed BEFORE the amount is typed.
    await m.driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4000});
    await m.driver.waitForFunction(() => (m.driver.readTextSafe('sol-send-status') ?? '').includes('Solana'),
      {timeoutMs: 6000, label: 'a valid destination discloses its route'});
    await m.driver.type('sol-send-amount-input', SEND_AMOUNT, {timeoutMs: 4000});

    // 5. Review → confirm → Sent ✓ + signature.
    await m.driver.findByTestID('sol-send-review', {timeoutMs: 4000});
    assertIncludes(m.driver.readText('sol-send-review'), '0.001 SOL', 'review shows 0.001 SOL');
    await lib.waitForEnabled(m, 'btn-sol-send-confirm');
    await m.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    const sent = await m.driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000}).catch(() => null);
    if (!sent && process.env.DPAY_FLOW_DEBUG === '1') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').writeFileSync('/home/sat/projects/dpay/tmp/diag52.txt', m.driver.bodyText());
    }
    expect(sent).not.toBeNull(); // the sheet shows "Sent ✓"
    assertIncludes(m.driver.readText('sol-send-outcome'), 'Sent', 'the sheet shows "Sent ✓"');
    await m.driver.findByTestID('sol-send-signature', {timeoutMs: 5000});
    expect(m.driver.readText('sol-send-signature')).toMatch(/^sig_/);

    await m.unmount();
  }, 180_000);
});

describe('flow 77 — Solana USDC "Send to address" (SPL transfer + rent pre-check)', () => {
  it('happy path: USDC units + rent note → Sent ✓; absent recipient ATA + low rent → honest refusal', async () => {
    const m = await onboardWallet('jest-sol-usdc-send');

    // Stateful per-address stub: the device/source ATA is learned from the first getAccountInfo
    // call; the recipient ATA + the SOL balance are mutable between the two cases.
    const st = {recipientAtaAbsent: false, solLamports: 5_000_000_000};
    let deviceAta: string | null = null;
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: st.solLamports, token: {amount: '2500000', decimals: 6}}),
      sendTransaction: () => 'sig_spl_' + Math.random().toString(36).slice(2, 12),
      getAccountInfo: (params: unknown) => {
        const addr = String(Array.isArray(params) ? (params as unknown[])[0] : params);
        if (deviceAta === null) deviceAta = addr;
        const absent = st.recipientAtaAbsent && addr !== deviceAta;
        return absent
          ? {value: null}
          : {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}};
      },
      getBalance: () => ({value: st.solLamports}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    });

    // 1. Select USDC·Solana via Balances (the same whole-row IA).
    await openBalances(m);
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});

    // 2. Pay tab → "Send to address": the sheet mounts in USDC units (2.5 USDC on device).
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-mode-toggle', {timeoutMs: 5000});
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 8000});
    // The compact formatter trims the 6-dec balance ('2.5'/'2.50'); the money fact is the same.
    await m.driver.waitForFunction(() => /Available: 2\.5\d* USDC/.test(m.driver.bodyText()),
      {timeoutMs: 5000, label: 'the form renders in USDC units'});

    // 3. Address + amount → the review names the exact amount and discloses the recipient-ATA rent.
    await m.driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4000});
    await m.driver.type('sol-send-amount-input', '1.5', {timeoutMs: 4000});
    await m.driver.findByTestID('sol-send-review-amount', {timeoutMs: 4000});
    assertEq(m.driver.readText('sol-send-review-amount'), 'Send 1.5 USDC', 'review reads the exact amount');
    await m.driver.findByTestID('sol-send-ata-note', {timeoutMs: 4000});
    const note = m.driver.readText('sol-send-ata-note');
    assertIncludes(note, 'If they have no USDC account yet, this creates it for them', 'the rent disclosure');
    assertIncludes(note, 'one-time ≈0.00204428 SOL paid by you', 'the exact SOL_ATA_SETUP_MIN_LAMPORTS cost');

    // 4. Confirm → sendSpl through the stub → Sent ✓ + signature.
    await lib.waitForEnabled(m, 'btn-sol-send-confirm');
    await m.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    assertIncludes(m.driver.readText('sol-send-outcome'), 'Sent', 'the sheet shows "Sent ✓"');
    await m.driver.findByTestID('sol-send-signature', {timeoutMs: 5000});
    expect(m.driver.readText('sol-send-signature')).toMatch(/^sig_spl_/);

    // 5. CASE 2 — recipient ATA ABSENT + sender SOL below the rent floor. A FRESH sheet mounts;
    //    sendSpl's pre-check throws BEFORE any broadcast.
    await m.driver.click('btn-sol-send-done', {timeoutMs: 5000});
    await m.driver.waitGone('sol-send-outcome', {timeoutMs: 5000});
    st.recipientAtaAbsent = true;
    st.solLamports = 1_000_000; // 0.001 SOL < the 2_044_280 rent+fee floor
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 8000});
    await m.driver.type('sol-send-address-input', DEST_ADDR, {timeoutMs: 4000});
    await m.driver.type('sol-send-amount-input', '1.5', {timeoutMs: 4000});
    await m.driver.click('btn-sol-send-confirm', {timeoutMs: 5000});

    await m.driver.findByTestID('sol-send-err', {timeoutMs: 12_000});
    // The WHOLE sentence — the prefix version passed two years of a double-printed unit (see twin).
    assertEq(
      m.driver.readText('sol-send-err'),
      'They have no USDC account yet. Creating it costs about 0.00204428 SOL, paid by you — send a little SOL here first',
      'the pre-check error renders the whole sentence, the rent amount carrying its unit ONCE',
    );
    expect(m.driver.isPresent('sol-send-outcome')).toBe(false);
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 5000});

    await m.unmount();
  }, 180_000);
});
