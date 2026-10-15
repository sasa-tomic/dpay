/**
 * Flow 52 - the Mt Pelerin cash-out entry (plan R2 step 2, the flow leg; the widget
 * handoff, 2026-10-13; the in-app embed, 2026-10-15).
 *
 * Over the fake-relay catalog (the EVM mainnet sections the relay always serves, the R2 step 1
 * flip applied: ZCHF on Ethereum carries `offramp: 'Partner'`), against the file's OWN relay
 * with the quote proxy pointed at the in-process venue stub (`DPAY_MTPELERIN_CTKN` +
 * `DPAY_MTPELERIN_API_BASE={{base}}/test/mtpelerin-upstream`, the trocador-stub pattern):
 *
 *   • The receive surface (the Ethereum ZCHF row) renders the cash-out entry — the buy row's
 *     twin, gated on the row's own offramp flag — and a SOL asset renders none. The withdraw
 *     surface (the same asset's send-to-address form in the Pay tab) carries the same entry,
 *     so the off-ramp is discovered inside the flow the home Withdraw button opens.
 *   • The sheet (Wallet-owned, root-mounted) asks for the amount, shows the verbatim fee facts
 *     and the counterparty, and VALIDATES locally before anything is sent (an unusable amount
 *     keeps Continue inert - no order, no widget).
 *   • Continue registers the order through the REAL relay's LOCAL conversion route (no upstream
 *     dial - the venue's API tier is closed for dpay) and opens the sell widget IN-APP: the
 *     relay's token route appends the `_ctkn` SERVER-side to the documented bare link (no
 *     sell-side or correlation parameters are documented, so nothing else is prefilled), the
 *     embed marker carries the tokenized URL and the external seam stays cold. The token window
 *     is pinned to 1/min: the SECOND continue is limiter-429'd, which drives the EXTERNAL
 *     fallback — there the `__DPAY_TEST_MTP_OPEN` seam fires with the bare UNTOKENIZED link.
 *     There is NO send step and NO deposit-address handoff (dpay never learns an address; the
 *     bank details are the widget session's).
 *   • Cancel is the typed rejection and closes the sheet.
 */
import {it, expect, jest} from '@jest/globals';
import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {evmEnv} from '../evm/env';
import {isDisabled} from '../harness/lib';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

// The JSONL records stay OUT of the repo (the deterministic dir is cleaned here at module
// scope, before the spawn - the flow-199 pattern).
const LOG_DIR = join(tmpdir(), 'dpay-flow-52-mtp-log');
rmSync(LOG_DIR, {recursive: true, force: true});
mkdirSync(LOG_DIR, {recursive: true});

// The file's own relay: the quote proxy keyed (CTKN, a FAKE value - the venue's quote
// endpoint is keyless upstream, the tripwire is dpay's own gate) and pointed at the
// in-process stub. The conversion route is local and never dials anything. The widget-token
// window is pinned to 1/min so the SECOND continue deterministically drives the EXTERNAL
// fallback (a limiter refusal is a token-fetch failure; the sheet falls back, the seam fires).
// The flow tier hosts the app on WEB, where the widget hand-off is the EXTERNAL open by
// design; this seam forces the embed path so the flow can exercise it (prod web never
// sets it). The token-fetch-failure arm below still falls back to the external seam.
g.__DPAY_TEST_MTP_EMBED = true;

hermeticFlow({relay: {env: {
  DPAY_MTPELERIN_CTKN: 'flow-ctkn',
  DPAY_MTPELERIN_WIDGET_PER_MIN: '1',
  DPAY_MTPELERIN_API_BASE: '{{base}}/api/v1/test/mtpelerin-upstream',
  DPAY_MTPELERIN_LOG_DIR: LOG_DIR,
}}});

hermeticDescribe('flow 52 - the Mt Pelerin cash-out entry (offramp-gated; local validation; the widget handoff)', () => {
  it('cash-out row for ZCHF-on-Ethereum opens the sheet; a zero amount keeps continue inert; continue registers the order, opens the sell widget and lands the lifecycle; SOL renders no row; non-eligible headline keeps the old withdraw', async () => {
    const {accountOf, onboardWallet, waitForWallet, selectEvmAsset, openBalances} = await evmEnv();
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

    // ── The sheet: the summary, the fee facts, the counterparty. No IBAN, no holder: those
    // are the widget session's to collect. ──
    await m.driver.click('btn-receive-cashout', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-sheet', {timeoutMs: 5000});
    const body = m.driver.bodyText();
    expect(body).toContain('CHF 500');     // the bank 0% band
    expect(body).toContain('1.3%');        // the bank floor after it
    expect(body).toContain('CHF 999');     // the no-KYC band
    expect(body).toContain('CHF 50');      // the cash-out minimum
    expect(body).toContain('Mt Pelerin converts and pays out.'); // the counterparty disclosure
    expect(m.driver.isPresent('mtp-cashout-iban')).toBe(false);

    // ── Local validation FIRST: a zero amount keeps Continue inert - no order, no widget. ──
    const openSeam = jest.fn<(uri: string) => Promise<void>>().mockResolvedValue(undefined);
    g.__DPAY_TEST_MTP_OPEN = openSeam;
    await m.driver.type('mtp-cashout-amount', '0', {timeoutMs: 5000});
    expect(await isDisabled(m, 'btn-mtp-cashout-continue')).toBe(true);
    await m.driver.click('btn-mtp-cashout-continue', {timeoutMs: 5000});
    expect(openSeam).not.toHaveBeenCalled();

    // ── A real amount: the stub's attributed quote lands and the payout line renders. ──
    await m.driver.type('mtp-cashout-amount', '2', {timeoutMs: 5000});
    await m.driver.waitForText('Payout: 97.7395 CHF, fees included.', {timeoutMs: 15000});

    // ── Continue: the LOCAL registration through the real relay, then the IN-APP embed —
    // the tokenized bare link, the external seam COLD on the happy path. ──
    await m.driver.click('btn-mtp-cashout-continue', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-lifecycle', {timeoutMs: 15000});
    await m.driver.findByTestID('mtp-widget-embed', {timeoutMs: 15000});
    expect(openSeam).not.toHaveBeenCalled();
    expect(m.driver.bodyText()).toContain('https://widget.mtpelerin.com/?_ctkn=flow-ctkn');
    // NO send step exists: the sale happens in the venue's own window.
    expect(m.driver.isPresent('btn-evm-send-confirm')).toBe(false);
    // The adopted record: awaiting_deposit, and NO deposit-address handoff block (dpay never
    // learns an address - the webhook payload never carries one and the widget session holds it).
    await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 15000});
    expect(m.driver.isPresent('convert-deposit-handoff')).toBe(false);
    // Closing the embed returns to the lifecycle view; the handoff note names the widget as
    // the place the sale completes.
    await m.driver.click('btn-mtp-embed-close', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-widget-embed')).toBe(false);
    await m.driver.waitForText('Finish the sale in the Mt Pelerin window', {timeoutMs: 5000});

    // ── The lifecycle's back closes the sheet (the panel's own affordance). ──
    await m.driver.click('btn-convert-back', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);

    // ── The fallback path: the token window (1/min) is spent, so this continue is limiter-429'd
    // and the sheet falls back to the EXTERNAL open — the seam fires with the documented bare
    // UNTOKENIZED link, and the lifecycle view stands (the registration + the watch). ──
    await m.driver.click('btn-receive-cashout', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-sheet', {timeoutMs: 5000});
    await m.driver.type('mtp-cashout-amount', '2', {timeoutMs: 5000});
    await m.driver.waitForText('Payout: 97.7395 CHF, fees included.', {timeoutMs: 15000});
    await m.driver.click('btn-mtp-cashout-continue', {timeoutMs: 15000});
    await m.driver.findByTestID('mtp-cashout-lifecycle', {timeoutMs: 15000});
    // The fallback resolves a beat AFTER the lifecycle mounts (token 429, then the
    // external open) and leaves no UI signal - poll the seam instead of racing it.
    for (let waited = 0; openSeam.mock.calls.length === 0 && waited < 10_000; waited += 50) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(openSeam).toHaveBeenCalledTimes(1);
    expect(openSeam.mock.calls[0][0]).toBe('https://widget.mtpelerin.com/');
    expect(m.driver.isPresent('mtp-widget-embed')).toBe(false);
    await m.driver.click('btn-convert-back', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);
    delete g.__DPAY_TEST_MTP_OPEN;

    // ── A SOL asset renders NO cash-out entry. ──
    // (The native SOL rail, NOT an SPL token: evmEnv configures no Solana RPC, so SPL rows are
    // fail-closed out of the picker — the SOL currency card is the reachable surface here.)
    await openBalances(m, {timeoutMs: 5000});
    await m.driver.click('btn-accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-coinbase', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-receive-cashout')).toBe(false);

    // ── The WITHDRAW flow carries the entry too (2026-10-15, the pay side of the same rail):
    // the eligible EVM asset's send surface shows the row and opens the SAME root-mounted
    // sheet — inside the surface, no chooser, no extra step. An ineligible asset would render
    // none (the per-asset gate, already pinned on the receive side above). ──
    await selectEvmAsset(m, 'evm-zchf-ethereum'); // lands tab-pay, scan sub-mode
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-pay-cashout', {timeoutMs: 5000});
    await m.driver.click('btn-pay-cashout', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-cashout-sheet', {timeoutMs: 5000});
    await m.driver.click('btn-mtp-cashout-cancel', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);

    // ── A non-eligible headline (VCHF/IC): the withdraw press keeps the OLD flow — the sheet
    // never opens from it (the HomeTab contract's flow-level half; the unit half is
    // HomeTab.test.tsx). ──
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-withdraw', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-cashout-sheet')).toBe(false);

    await m.unmount();
  }, 150_000);
});
