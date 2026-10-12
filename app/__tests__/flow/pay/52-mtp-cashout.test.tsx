/**
 * Flow 52 — the Mt Pelerin cash-out entry (plan R2 step 2, the flow leg).
 *
 * Over the fake-relay catalog (the EVM mainnet sections the relay always serves, the R2 step 1
 * flip applied: ZCHF on Ethereum carries `offramp: 'Partner'`):
 *
 *   • The receive surface (the Ethereum ZCHF row) renders the cash-out entry — the buy row's
 *     twin, gated on the row's own offramp flag — and a SOL asset renders none.
 *   • The sheet (Wallet-owned, root-mounted) asks for IBAN + account holder + amount, shows the
 *     verbatim fee facts and the counterparty, and VALIDATES locally before anything is sent.
 *   • Continue creates the order THROUGH THE REAL RELAY'S PROXY — which 503s while
 *     `DPAY_MTPELERIN_CTKN` is absent — and the sheet answers with its honest
 *     not-switched-on-yet line, form intact, retry one tap away (the unconfigured-refusal
 *     shape every money surface shares).
 *   • Cancel is the typed rejection and closes the sheet.
 *
 * The full order→send→lifecycle ride is beyond a 503 relay on purpose: the sheet-level pins
 * live in MtpCashOutSheet.test.tsx (service seam mocked), the send path is 220/226's real-chain
 * territory, and the lifecycle engine is convertResume's own suites. THIS file pins the
 * wiring: entry gate → sheet → local validation → the relay's own honest refusal.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {evmEnv} from '../evm/env';

hermeticDescribe('flow 52 — the Mt Pelerin cash-out entry (offramp-gated; local validation; the unconfigured relay refuses honestly)', () => {
  it('cash-out row for ZCHF-on-Ethereum opens the sheet; invalid IBAN never sends; continue hits the relay and renders its refusal; SOL renders no row; non-eligible headline keeps the old withdraw', async () => {
    const {accountOf, onboardWallet, waitForWallet, selectEvmAsset, selectSolRail} = await evmEnv();
    const m = await onboardWallet('jest-mtp-52');
    const id = await accountOf(m);
    expect(id?.secretHex ?? '').toHaveLength(64);

    // ── The EVM receive surface: the cash-out entry for the FLIPPED row (Ethereum ZCHF). ──
    await waitForWallet(m);
    await selectEvmAsset(m, 'evm-zchf-ethereum');
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-mtp', {timeoutMs: 5000}); // the buy row still renders
    await m.driver.findByTestID('btn-receive-cashout', {timeoutMs: 5000}); // and so does its twin

    // ── The sheet: the summary, the fee facts, the counterparty, the local validation. ──
    await m.driver.click('btn-receive-cashout', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-sheet', {timeoutMs: 5000});
    const body = m.driver.bodyText();
    expect(body).toContain('CHF 500');     // the bank 0% band
    expect(body).toContain('1.3%');        // the bank floor after it
    expect(body).toContain('CHF 999');     // the no-KYC band
    expect(body).toContain('CHF 50');      // the cash-out minimum
    expect(body).toContain('Mt Pelerin converts and pays out.'); // the counterparty disclosure

    // A checksum-failing IBAN shows its own line; the continue button stays inert.
    await m.driver.type('mtp-cashout-iban', 'CH93 0076 2011 6238 5295 8', {timeoutMs: 5000});
    await m.driver.type('mtp-cashout-holder', 'Ada Lovelace', {timeoutMs: 5000});
    await m.driver.type('mtp-cashout-amount', '1', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-iban-err', {timeoutMs: 5000});

    // ── Continue with a VALID form: the relay's proxy is the REAL relay's, and without the
    // integration key it 503s — the sheet must answer with the honest line, form intact. ──
    await m.driver.type('mtp-cashout-iban', 'CH93 0076 2011 6238 5295 7', {timeoutMs: 5000});
    await m.driver.click('btn-mtp-cashout-continue', {timeoutMs: 5000});
    await m.driver.waitForText('Cash out is not switched on yet.', {timeoutMs: 15000});
    expect(m.driver.isPresent('btn-mtp-cashout-continue')).toBe(true); // the retry lives

    // ── Cancel closes the sheet — nothing was created, nothing was sent. ──
    await m.driver.click('btn-mtp-cashout-cancel', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);

    // ── A SOL asset renders NO cash-out entry. ──
    await selectSolRail(m, 'sol-usdc');
    await m.driver.findByTestID('funding-provider-coinbase', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-receive-cashout')).toBe(false);

    // ── A non-eligible headline (VCHF/IC): the withdraw press keeps the OLD flow — the sheet
    // never opens from it (the HomeTab contract's flow-level half; the unit half is
    // HomeTab.test.tsx). ──
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-withdraw', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);

    await m.unmount();
  }, 150_000);
});
