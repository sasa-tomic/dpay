/**
 * Flow 109 — the jest twin of `e2e/tests/109-scan-link-and-address.mjs` (the Pay camera reads a
 * payment LINK and a bare ADDRESS, not only a request code).
 *
 * The camera classifies what it read: a payment-link QR opens the pre-filled review (no auto-sign),
 * a bare IC account opens Send to address with the destination filled + route disclosed, a
 * `bitcoin:` request is refused BY NAME with a practical instruction, and unrecognised input keeps
 * the honest "not a payment code" refusal. VCHF is the active asset — direct-ICRC, so ONE asset
 * exercises both halves of the classifier.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, faucetAccount, onboardWallet,
  openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {scanSeam} from './local';

const CURRENCY = 7; // VCHF — a direct-ICRC row: payable AND sendable to any IC account
const SEED = 500_000_000; // 5.00000000 VCHF, so neither the fund-first gate nor a zero balance fires
const LINK_AMOUNT = '1.25';
const RECIPIENT_PUBKEY = 'c'.repeat(64); // a second wallet's pubkey; its principal is a real destination
const BTC_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

async function scan(m: Parameters<typeof armPayScan>[0], payload: string): Promise<void> {
  await armPayScan(m);
  await m.driver.settleFrames(1);
  scanSeam()(payload);
}

hermeticDescribe('flow 109 — the camera classifies links, addresses, foreign schemes, and garbage', () => {
  it('link → review (no auto-sign); address → send form + route; bitcoin: → named refusal', async () => {
    const m = await onboardWallet('jest-scan2');
    const accountHex = (await accountOf(m))!.publicHex;

    const recipient = await railPrincipalText(RECIPIENT_PUBKEY);
    const fund = await faucetAccount(accountHex, SEED, {currency: CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);

    // VCHF active: payable and sendable — both classifier halves in one asset.
    await openBalances(m);
    await selectCurrency(m, 'vchf');

    // --- 1. a printed payment link, read by the camera -------------------------------------------
    // The host is deliberately not the web origin: parsePayLink ignores it by design.
    const link = `https://dpay.kalaj.org/wallet/pay/${recipient}?asset=VCHF&network=internet-computer&amount=${LINK_AMOUNT}&label=Cafe`;
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await scan(m, link);
    await m.driver.findByTestID('pay-amount', {timeoutMs: 10_000});
    assertIncludes(m.driver.readText('pay-amount'), LINK_AMOUNT, 'the scanned link’s amount reaches the review');
    assert(m.driver.isPresent('btn-approve'), 'a scanned payment link must still require an Approve press');
    expect(m.driver.bodyText()).not.toContain("isn't a dpay payment code");

    // --- 2. a bare wallet address, read by the camera ---------------------------------------------
    await m.driver.click('btn-review-cancel', {timeoutMs: 4000});
    await scan(m, recipient);
    await m.driver.findByTestID('send-address-input', {timeoutMs: 10_000});
    // The scan fills the field through a state update — wait for the value, then pin it.
    await m.driver.waitForFunction(
      () => m.driver.readInputValue('send-address-input') === recipient,
      {timeoutMs: 10_000, label: 'the scanned account reaches the destination field'},
    );
    assertEq(m.driver.readInputValue('send-address-input'), recipient, 'the scanned account fills the field verbatim');
    // The disclosure is the point: the user learns the rail + its fee BEFORE typing an amount, and
    // it is produced by the same resolver a paste goes through (no scan-specific shortcut).
    await m.driver.waitForFunction(
      () => (m.driver.readTextSafe('send-status') ?? '').includes('Internet Computer'),
      {timeoutMs: 10_000, label: 'the scanned destination’s route is disclosed'},
    );
    const status = m.driver.readText('send-status');
    assertIncludes(status, 'Internet Computer', 'the scanned destination’s route is disclosed');

    // --- 3. another wallet's payment format, refused BY NAME --------------------------------------
    await m.driver.click('btn-pay-scan', {timeoutMs: 5000});
    await scan(m, `BITCOIN:${BTC_ADDRESS}?amount=0.001&label=Coffee`);
    assert(await m.driver.waitForText('payment request in Bitcoin', {timeoutMs: 5000}),
      'a bitcoin: request must be refused by name');
    expect(m.driver.bodyText()).not.toContain("isn't a dpay payment code");
    expect(m.driver.isPresent('pay-amount')).toBe(false);

    // --- 4. still honest about what it genuinely cannot read --------------------------------------
    await scan(m, 'not a link, not an address, not a request');
    assert(await m.driver.waitForText("isn't a dpay payment code", {timeoutMs: 5000}),
      'input that belongs to no namespace must keep the honest refusal');
    expect(m.driver.isPresent('pay-amount')).toBe(false);

    await m.unmount();
  }, 150_000);
});
