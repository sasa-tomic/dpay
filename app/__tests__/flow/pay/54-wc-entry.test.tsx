/**
 * Flow 54 — the WalletConnect entry (founder directive 2026-10-15: WalletConnect needs more
 * than opening wc: — discoverability, instructions, session management).
 *
 * WRITTEN, NOT YET RUN: this file joins the flow suite at the next `just flow` (the wave's
 * scope keeps the dev loop to focused suites + smoke + typecheck). What it pins, over the fake
 * relay and the EVM harness:
 *
 *   • The EVM pay scan screen carries the discoverable entry row (btn-evm-pay-wc) — absent
 *     while the project-id seam is empty, present once it is armed (Wallet reads the override
 *     LIVE per render, the `walletConnectProjectId()` getter).
 *   • Tapping it opens the ONE root-mounted entry sheet with exactly the four instruction
 *     lines (what / how / honesty / disconnect), each stated once.
 *   • The sheet's primary action ("Scan QR code") closes it back over the already-live camera;
 *     scanning a `wc:` QR then routes through the pre-existing classifier path (lib/scan.ts →
 *     Wallet.pairWc), which this flow does NOT re-drive (WC relay = external transport; the
 *     pairing loop is pinned by wc-requests.test.tsx on the SDK fake).
 *   • With no sessions the sheet renders NO list section (the instructions ARE the empty
 *     state); the connected-dapps rows + Disconnect are pinned by wc-entry.test.tsx at the
 *     component level against `connectedAppOf`.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {evmEnv} from '../evm/env';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

hermeticDescribe('flow 54 — the WC entry row, the instruction sheet, and the scan hand-off', () => {
  it('the entry row opens the instruction sheet; the scan button closes it over the live camera', async () => {
    // Arm the project-id seam BEFORE the first Wallet render - the entry-row gate reads it live.
    g.__DPAY_TEST_WALLETCONNECT_PROJECT_ID = 'flow-54';
    const {onboardWallet, waitForWallet, selectEvmAsset} = await evmEnv();
    const m = await onboardWallet('jest-wc-54');
    await waitForWallet(m);
    await selectEvmAsset(m, 'evm-zchf-arbitrum');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('evm-pay-scan', {timeoutMs: 5000});

    // The entry row is ON the scan screen, beside the live camera.
    await m.driver.findByTestID('btn-evm-pay-wc', {timeoutMs: 5000});

    // Tap: the root-mounted instruction sheet. Four facts, no more.
    await m.driver.click('btn-evm-pay-wc', {timeoutMs: 5000});
    await m.driver.findByTestID('wc-entry-sheet', {timeoutMs: 5000});
    const body = m.driver.bodyText();
    expect(body).toContain('dpay connects to dapps on Ethereum and Solana.');
    expect(body).toContain('In the dapp, choose WalletConnect, then scan its QR code.');
    expect(body).toContain('Every request is shown before you approve it.');
    expect(body).toContain('A dapp stays connected until you disconnect it.');
    expect(body).not.toContain('Connected dapps'); // no sessions -> no list section at all

    // The primary action closes the sheet; the camera beneath is the instrument (the same
    // classifier path a scanned wc: QR always took).
    await m.driver.click('btn-wc-entry-scan', {timeoutMs: 5000});
    await m.driver.waitGone('wc-entry-sheet', {timeoutMs: 5000});
    expect(m.driver.isPresent('evm-pay-scan')).toBe(true);

    await m.unmount();
    g.__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
  }, 150_000);

  it('without the project-id seam the entry row does not render at all (no dead entry)', async () => {
    const {onboardWallet, waitForWallet, selectEvmAsset} = await evmEnv();
    const m = await onboardWallet('jest-wc-54b');
    await waitForWallet(m);
    await selectEvmAsset(m, 'evm-zchf-arbitrum');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('evm-pay-scan', {timeoutMs: 5000});
    expect(m.driver.isPresent('btn-evm-pay-wc')).toBe(false);
    await m.unmount();
  }, 150_000);
});
