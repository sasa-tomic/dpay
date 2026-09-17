/**
 * Flow 81 — IC fund-first Pay gate (2026-08-16 zero-funds UX, review finding 7).
 *
 * The IC rail mirrors the SOL rail's fund-first panel (same-surfaces hard rule): a wallet whose
 * SELECTED non-DEMO asset has a KNOWN zero balance (online batch read reported '0') sees the
 * fund panel INSTEAD of the scanner + NFC card — prompting the deposit funnel at the moment of
 * intent. Offline / loading / missing-entry FAIL OPEN to the live scanner (offline-first rule).
 *
 * Invariants exercised here (fresh FakeLedger wallet: DEMO ∂100 from faucet, ckBTC 0):
 *   1. ckBTC selected + ONLINE + known zero → `pay-fund` panel shows 'No BTC available' with the
 *      PAY instruction and the primary `pay-fund-go` ('Show my BTC address') — ckBTC IS depositable
 *      (mintable=false, onramp Direct, minter present) — while the scan surface stays REACHABLE
 *      (`btn-start-scan`). Changed 2026-09-08 (X3): the panel used to replace the scanner, which
 *      stopped a payer reading a request for an asset they actually held.
 *   2. One tap on `pay-fund-go` lands on the ckBTC deposit surface (deposit-address starts
 *      with bc1q — the one funding QR; no inline duplicate).
 *   3. Fail-open: with the relay unreachable (offline), the scanner RETURNS (no panel) —
 *      offline-first rule proven on the IC rail.
 *   4. Send sub-mode parity (review finding 6): back online + ckBTC selected, the
 *      'Send to address' toggle shows the SAME fund panel instead of the withdraw form — and the
 *      panel speaks in the SEND sub-mode's own voice, never the scan sub-mode's.
 */
import {setup, onboardWallet, openBalances, goOffline, setRelay, assert, assertIncludes, accountOf, faucetAccount} from '../harness/lib.mjs';

export const meta = {
  id: '81',
  name: 'ic-fund-first-pay',
  journey: 'system',
  covers: ['ic-fund-first', 'pay-gate', 'fail-open', 'zero-funds', 'send-gate'],
  verifies: 'the IC Pay tab shows the fund-first panel on a KNOWN-zero non-DEMO asset (online), routes to the deposit address in one tap, fails open offline, and gates the send sub-mode with the same panel carrying the send sub-mode\'s own instruction',
  timeoutMs: 90000,
};

export async function run() {
  const env = await setup();
  const {driver} = env;
  try {
    await onboardWallet(driver, 'e2e-ic-fund');

    // Select ckBTC (a fresh wallet holds DEMO ∂100 from the faucet but zero ckBTC).
    await openBalances(driver);
    await driver.click('asset-ckbtc-select');

    // (1) Online + known zero → the fund panel rides BELOW the scan surface, never in front of it
    //     (X3, 2026-09-08). The merchant's QR names its own asset and this rail pays THAT asset, so
    //     the selected balance cannot decide whether a request is readable — the panel keeps the
    //     funding funnel's entry, and "Pay Now" is still one tap away.
    await driver.click('tab-pay');
    const txt = await driver.readText('pay-fund');
    assertIncludes(txt, 'No BTC available', 'panel headline names the selected asset');
    assertIncludes(txt, 'To pay a BTC request, first receive BTC at your address.',
      'the scan sub-mode states the PAY instruction');
    assertIncludes(txt, 'Show my BTC address', 'depositable asset offers the deposit primary');
    assert(await driver.isPresent('btn-start-scan'), 'the scan surface stays reachable on a zero balance (X3)');
    const camLeak = await driver.eval(() => document.querySelector('[data-testid="scan-cam-box"]') != null);
    assert(!camLeak, 'the camera itself still waits for the Pay Now press (pay-intent gate)');

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

    // (4) Send sub-mode parity: back online, known zero → same panel ('No BTC available').
    await setRelay(driver, env.relayBaseURL);
    await driver.click('tab-pay');
    await driver.findByTestID('pay-fund', {timeoutMs: 10_000});
    await driver.click('btn-pay-send');
    const sendTxt = await driver.readText('pay-fund');
    assertIncludes(sendTxt, 'No BTC available', 'send sub-mode shows the same fund panel');
    // The headline stopped branching when `fundTitle` dropped its action argument, so asserting it
    // alone would be byte-identical to step 1 and would pass on step 1's screen. `fundBody` is the
    // one gate string that still differs per sub-mode — pin it in BOTH directions.
    assertIncludes(sendTxt, 'To send BTC, first receive BTC at your address.',
      'send sub-mode states the SEND instruction');
    assert(!sendTxt.includes('To pay a BTC request'),
      `the send gate must not keep the scan sub-mode instruction. Got: ${JSON.stringify(sendTxt)}`);
    const sendFormLeak = await driver.eval(() => document.querySelector('[data-testid="send-address-input"]') != null);
    assert(!sendFormLeak, 'send form must NOT be mounted while gated');
    assertIncludes(sendTxt, 'Show my BTC address', 'send panel keeps the deposit primary');

    // (5) Fund-funnel RESUME. The user was sent to the deposit screen from Pay; once the money
    //     actually lands they must get a one-tap way back to what they were trying to do. The SOL
    //     rail has had this since the fund-funnel work and the IC rail never did — it recorded no
    //     origin, so the user had to re-navigate by hand. Note the link appears only AFTER the
    //     balance goes positive: offered over an unfunded account it would lead straight back to
    //     the gate it came from.
    await driver.click('pay-fund-go');
    await driver.findByTestID('deposit-address', {timeoutMs: 8000});
    const noLinkYet = await driver.isPresent('btn-ic-receive-return');
    assert(!noLinkYet, 'no resume link while the balance is still zero — it would return to the gate');

    const identity = await accountOf(driver);
    const fund = await faucetAccount(env.relayBaseURL, identity.publicHex, 150_000, {currency: 1});
    assert(fund.ok, `faucet must succeed, got HTTP ${fund.status}`);

    await driver.findByTestID('btn-ic-receive-return', {timeoutMs: 12_000});
    const label = await driver.readText('btn-ic-receive-return');
    assertIncludes(label, 'Back to paying', 'the resume link names the action it returns to');
    assertIncludes(label, 'BTC', 'the resume link names the asset');
    await driver.click('btn-ic-receive-return');

    // Back on Pay, on the SAME asset, in the SAME sub-mode the funnel started from (send).
    await driver.findByTestID('send-address-input', {timeoutMs: 8_000});
    const backLeak = await driver.isPresent('pay-fund');
    assert(!backLeak, 'the fund gate is gone — the asset is funded now');
    await driver.screenshot('81-ic-fund-first-pay');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
