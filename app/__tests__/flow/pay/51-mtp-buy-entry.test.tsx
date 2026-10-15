/**
 * Flow 51 — the Mt Pelerin buy entry (plan R1 step 3 + the step-4 flow leg; the in-app
 * embed, 2026-10-15).
 *
 * The buy entry lives on THREE surfaces; the flow tier exercises the two the real catalog can
 * reach, over the fake-relay catalog (the EVM mainnet sections the relay always serves):
 *
 *   • The receive surface's FundingRoutes card gains the INTERACTIVE Mt Pelerin row (the founder
 *     directive: an alphabetical peer among the inert provider rows) for the ZCHF-on-Arbitrum
 *     EVM row — and renders NO row for a SOL asset.
 *   • The sheet (Wallet-owned, root-mounted) reviews the validation signature — the exact
 *     `MtPelerin-{code}` message (the per-address derivation), the device's EIP-55 address, the
 *     delivery chain — plus the verbatim fee facts and the counterparty disclosure. Approve signs
 *     with the DEVICE key, hands the golden widget URL to the RELAY's token route and opens the
 *     IN-APP embed (the webview stub's marker carries the tokenized URL; the `_ctkn` was injected
 *     SERVER-side and the external seam stays cold). The token window is pinned to 1/min: the
 *     SECOND approve is limiter-429'd, which drives the EXTERNAL fallback — there the
 *     `__DPAY_TEST_MTP_OPEN` seam fires with the UNTOKENIZED URL, and a rejecting seam keeps the
 *     sheet with the failed-link note (the TrustWalletFundButton pattern).
 *   • HomeTab's Add funds keeps the PRE-WAVE single path: ONE press lands the home rail's
 *     deposit surface (flow 134's contract); the buy is discovered INSIDE that surface (the
 *     DepositSheet onBuy entry / the FundingRoutes provider row), never behind a chooser.
 *
 * The open seam (`__DPAY_TEST_MTP_OPEN`, the `__DPAY_TEST_DEEPLINK` pattern) answers success AND
 * failure deterministically — the real Linking has no handler under jest; the IN-APP embed never
 * touches it. The on-return arrival refresh (the useAppActive arm) is not observable in a jest
 * mount (no backgrounding) and is pinned by the Wallet wiring review, not here.
 */
import {it, expect, jest} from '@jest/globals';
import {mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {evmEnv} from '../evm/env';
import {deriveEvmKeypair, toChecksumAddress} from '../../../evm/identity';
import {signPersonalBase64} from '../../../evm/personalSign';
import {deriveValidationCode, validationMessage} from '../../../ramp/mtpelerin';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

// The JSONL records stay OUT of the repo (the flow-52 pattern). The token route is keyed
// (`DPAY_MTPELERIN_CTKN`, a FAKE value) so the happy path embeds IN-APP, and its per-client
// window is pinned to 1/min so the second approve deterministically drives the EXTERNAL
// fallback (a limiter refusal is a token-fetch failure; the sheet falls back, the seam fires).
const LOG_DIR = join(tmpdir(), 'dpay-flow-51-mtp-log');
rmSync(LOG_DIR, {recursive: true, force: true});
mkdirSync(LOG_DIR, {recursive: true});

// The flow tier hosts the app on WEB, where the widget hand-off is the EXTERNAL open by
// design; this seam forces the embed path so the flow can exercise it (prod web never
// sets it). The token-fetch-failure arm below still falls back to the external seam.
g.__DPAY_TEST_MTP_EMBED = true;

hermeticFlow({relay: {env: {
  DPAY_MTPELERIN_CTKN: 'flow-ctkn',
  DPAY_MTPELERIN_WIDGET_PER_MIN: '1',
  DPAY_MTPELERIN_LOG_DIR: LOG_DIR,
}}});

hermeticDescribe('flow 51 — the Mt Pelerin buy entry (EVM row only; sign-confirm; open-failure keeps the sheet)', () => {
  it('FundingRoutes row for ZCHF-on-Arbitrum opens the sheet; approve hands the golden URL; failed open keeps the sheet; SOL renders no row', async () => {
    const {accountOf, onboardWallet, waitForWallet, selectEvmAsset, openBalances} = await evmEnv();
    const m = await onboardWallet('jest-mtp-51');
    const id = await accountOf(m);
    expect(id?.secretHex ?? '').toHaveLength(64);
    // The device EVM key: the SAME derivation the sheet signs with (golden-vector cross-check).
    const device = deriveEvmKeypair(id!.secretHex);
    const checksummed = toChecksumAddress(device.address);
    const code = deriveValidationCode(device.address);

    // ── The EVM receive surface: the interactive Mt Pelerin row among the alphabetical peers. ──
    await waitForWallet(m);
    await selectEvmAsset(m, 'evm-zchf-arbitrum');
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-mtp', {timeoutMs: 5000});
    expect(m.driver.isPresent('funding-provider-coinbase')).toBe(true); // the inert peers still render

    // ── The sheet: the review line (message, address, chain) + the verbatim facts. ──
    await m.driver.click('funding-provider-mtp', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-buy-sheet', {timeoutMs: 5000});
    // The validation code lands a tick after mount (the per-address salt read).
    await m.driver.waitForText(validationMessage(code), {timeoutMs: 5000});
    const body = m.driver.bodyText();
    expect(body).toContain(checksummed);
    expect(body).toContain('Ethereum');
    expect(body).toContain('2.5%+');           // card, verbatim
    expect(body).toContain('CHF 500');         // the bank 0% band
    expect(body).toContain('1.3%');            // the bank floor after it
    expect(body).toContain('7 days');          // the unverified-bank hold
    expect(body).toContain('Mt Pelerin handles the purchase.'); // the counterparty disclosure

    // ── Cancel closes; nothing opened. ──
    await m.driver.click('btn-mtp-cancel', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);

    // ── Approve signs with the device key, fetches the relay-tokenized URL and opens the
    // IN-APP embed: the stub's marker view carries the tokenized URL as text, and the
    // external seam stays COLD on the happy path (the embed never touches it). ──
    const openSeam = jest.fn<(uri: string) => Promise<void>>();
    g.__DPAY_TEST_MTP_OPEN = openSeam;
    await m.driver.click('funding-provider-mtp', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-buy-sheet', {timeoutMs: 5000});
    await m.driver.waitForText(validationMessage(code), {timeoutMs: 5000});
    await m.driver.click('btn-mtp-sign', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-widget-embed', {timeoutMs: 15000});
    expect(openSeam).not.toHaveBeenCalled();
    const embedBody = m.driver.bodyText();
    expect(embedBody).toContain('https://widget.mtpelerin.com/?net=mainnet');
    expect(embedBody).toContain(`addr=${encodeURIComponent(checksummed)}`);
    expect(embedBody).toContain(`code=${code}`);
    // The hash is the device key's personal_sign over the reviewed message, base64, URL-encoded;
    // the `_ctkn` rode SERVER-side (the fake relay token, never a client value).
    const expectedHash = encodeURIComponent(signPersonalBase64(device.privateKey, validationMessage(code)));
    expect(embedBody).toContain(`hash=${expectedHash}`);
    expect(embedBody).toContain('_ctkn=flow-ctkn');
    // Closing the embed reveals the sheet's opened line; Done closes the sheet.
    await m.driver.click('btn-mtp-embed-close', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-widget-embed')).toBe(false);
    await m.driver.waitForText('Mt Pelerin is open. Your balance updates when you return.', {timeoutMs: 5000});
    await m.driver.click('btn-mtp-close', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);

    // ── The fallback path: the token window (1/min) is spent, so this approve is limiter-429'd,
    // the sheet falls back to the EXTERNAL open and the seam fires with the UNTOKENIZED golden
    // URL. A rejecting seam keeps the sheet with the failed-link note (the TrustWallet
    // pattern); the retry stays one tap away. ──
    openSeam.mockReset();
    openSeam.mockRejectedValue(new Error('No activity found'));
    await m.driver.click('funding-provider-mtp', {timeoutMs: 5000});
    await m.driver.findByTestID('mtp-buy-sheet', {timeoutMs: 5000});
    await m.driver.waitForText(validationMessage(code), {timeoutMs: 5000});
    await m.driver.click('btn-mtp-sign', {timeoutMs: 5000});
    await m.driver.waitForText("Couldn't open Mt Pelerin", {timeoutMs: 15000});
    expect(openSeam).toHaveBeenCalledTimes(1);
    const fallbackUrl = openSeam.mock.calls[0][0] as string;
    expect(fallbackUrl.startsWith('https://widget.mtpelerin.com/?')).toBe(true);
    expect(fallbackUrl).not.toContain('_ctkn'); // the token rides server-side only
    expect(m.driver.isPresent('mtp-widget-embed')).toBe(false);
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(true);
    expect(m.driver.isPresent('btn-mtp-sign')).toBe(true); // the retry stays one tap away
    await m.driver.click('btn-mtp-cancel', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);
    delete g.__DPAY_TEST_MTP_OPEN;

    // ── A SOL asset renders NO Mt Pelerin row: the providers list stays deposit-only. ──
    // (The native SOL rail, NOT an SPL token: evmEnv configures no Solana RPC, so SPL rows are
    // fail-closed out of the picker — the SOL currency card is the reachable surface here.)
    await openBalances(m, {timeoutMs: 5000});
    await m.driver.click('btn-accounts-currency-SOL', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-label', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('funding-provider-coinbase', {timeoutMs: 5000});
    expect(m.driver.isPresent('funding-provider-mtp')).toBe(false);

    // ── The Add-funds press keeps the PRE-WAVE single path (one tap, no chooser): it lands the
    // deposit surface of the home rail directly, whatever the catalog carries. ──
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.click('btn-home-add-funds', {timeoutMs: 5000});
    await m.driver.findByTestID('receive-mode-toggle', {timeoutMs: 5000});
    expect(m.driver.isPresent('mtp-buy-sheet')).toBe(false);
    expect(m.driver.isPresent('home-add-funds-menu')).toBe(false);

    await m.unmount();
  }, 150_000);
});
