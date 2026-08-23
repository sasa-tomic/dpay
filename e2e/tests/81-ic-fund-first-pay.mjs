/**
 * Flow 81 — IC fund-first Pay gate (2026-08-16 zero-funds UX, review finding 7).
 *
 * The IC rail mirrors the SOL rail's fund-first panel (same-surfaces hard rule): a wallet whose
 * SELECTED non-DEMO asset has a KNOWN zero balance (online batch read reported '0') sees the
 * fund panel INSTEAD of the scanner + NFC card — prompting the deposit funnel at the moment of
 * intent. Offline / loading / missing-entry FAIL OPEN to the live scanner (offline-first rule).
 *
 * Invariants exercised here (fresh FakeLedger wallet: DEMO ∂100 from faucet, ckBTC 0):
 *   1. ckBTC selected + ONLINE + known zero → `pay-fund` panel shows 'Add BTC to pay',
 *      the scanner surface (`pay-scan` status row / QrScanner box) is NOT in the DOM,
 *      and the primary `pay-fund-go` ('Show my BTC address') is present (ckBTC IS depositable:
 *      mintable=false, onramp Direct, minter present).
 *   2. One tap on `pay-fund-go` lands on the ckBTC deposit surface (deposit-address starts
 *      with bc1q — the one funding QR; no inline duplicate).
 *   3. Fail-open: with the relay unreachable (offline), the scanner RETURNS (no panel) —
 *      offline-first rule proven on the IC rail.
 *   4. Send sub-mode parity (review finding 6): back online + ckBTC selected, the
 *      'Send to address' toggle shows the SAME fund panel ('Add BTC to send') instead of
 *      the withdraw form.
 */
import {setup, onboardWallet, openBalances, goOffline, setRelay, assert, assertIncludes} from '../harness/lib.mjs';

export const meta = {
  id: '81',
  name: 'ic-fund-first-pay',
  journey: 'system',
  covers: ['ic-fund-first', 'pay-gate', 'fail-open', 'zero-funds', 'send-gate'],
  verifies: 'the IC Pay tab shows the fund-first panel on a KNOWN-zero non-DEMO asset (online), routes to the deposit address in one tap, fails open offline, and gates the send sub-mode identically',
  timeoutMs: 30_000,
};

export async function run() {
  const env = await setup();
  const {driver} = env;
  try {
    await onboardWallet(driver, 'e2e-ic-fund');

    // Select ckBTC (a fresh wallet holds DEMO ∂100 from the faucet but zero ckBTC).
    await openBalances(driver);
    await driver.click('asset-ckbtc-select');
    await driver.waitGone('btn-balances-close');

    // (1) Online + known zero → the fund panel replaces the scanner.
    await driver.click('tab-pay');
    const txt = await driver.readText('pay-fund');
    assertIncludes(txt, 'Add BTC to pay', 'panel headline names the selected asset');
    assertIncludes(txt, 'Show my BTC address', 'depositable asset offers the deposit primary');
    const scanLeak = await driver.eval(() => document.querySelector('[data-testid="pay-scan"], [data-testid="scan-cam-box"]') != null);
    assert(!scanLeak, 'scanner surface must NOT be mounted while gated');

    // (2) One tap → the ckBTC deposit address (the ONE funding QR surface).
    await driver.click('pay-fund-go');
    await driver.findByTestID('deposit-address', {timeoutMs: 8000});
    const addr = await driver.readText('deposit-address');
    assert(/^bc1q/.test(addr), `deposit address must be a btc-style address, got ${addr}`);
    assert(await driver.findByTestID('deposit-qr') != null, 'deposit QR rendered');

    // (3) Fail-open: relay unreachable → the scanner returns (offline-first rule).
    await goOffline(driver);
    await driver.click('tab-pay');
    await driver.waitGone('pay-fund', {timeoutMs: 10_000});
    assert(await driver.waitForText('Scan to pay'), 'offline wallet sees the live scanner, not the panel');
    const offlinePanelLeak = await driver.eval(() => document.querySelector('[data-testid="pay-fund"]') != null);
    assert(!offlinePanelLeak, 'panel must be gone while offline');

    // (4) Send sub-mode parity: back online, known zero → same panel ('Add BTC to send').
    await setRelay(driver, env.relayBaseURL);
    await driver.click('tab-pay');
    await driver.findByTestID('pay-fund', {timeoutMs: 10_000});
    await driver.click('btn-pay-send');
    const sendTxt = await driver.readText('pay-fund');
    assertIncludes(sendTxt, 'Add BTC to send', 'send sub-mode shows the same fund panel');
    const sendFormLeak = await driver.eval(() => document.querySelector('[data-testid="withdraw-address-input"]') != null);
    assert(!sendFormLeak, 'send form must NOT be mounted while gated');
    assertIncludes(sendTxt, 'Show my BTC address', 'send panel keeps the deposit primary');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
