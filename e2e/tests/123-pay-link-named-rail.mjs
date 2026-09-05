// Flow 123 — a payment link that NAMES the sibling rail pays exactly that rail (never-override).
//
// Objective 2's rail choice (`chooseRail` — preference/funded/destination) exists only on surfaces
// the user drives interactively. A payment link is a PINNED request: when it names USDC@Solana,
// the wallet must settle on USDC@Solana even though ckUSDC — the home group's PREFERRED rail,
// already selected on screen — is one switch away. No rail-selection copy may appear anywhere on
// the pinned path: no "Switch to…", no rail disclosure, no funded-sibling pointer. The deeplink
// routing that flips the selection is the one deliberate programmatic bypass (Wallet's link
// pipeline); this flow pins that it flips to the NAMED rail and nothing else.
//
// Proves end-to-end through the REAL app:
//   1. Home = US dollars ⇒ the preferred ckUSDC rail is selected first (the baseline the link
//      must override — by NAMING its rail, not by choosing).
//   2. A `?asset=USDC&network=solana` link lands on the Solana USDC send form, header "USDC
//      balance", destination + amount pre-filled, review naming USDC — and the body NEVER says
//      ckUSDC or any rail-switch copy.
//   3. A link never auto-sends; Confirm broadcasts the NAMED rail's transfer (stub) → Sent ✓.
//
// Selector contract: `active-asset-label`, `sol-send-address-input`, `sol-send-amount-input`,
// `sol-send-review`, `btn-sol-send-confirm`, `sol-send-outcome`.
import {setup, assert, assertEq, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipRehearsalIfPresent} from '../harness/lib.mjs';

export const meta = {
  id: '123',
  name: 'pay-link-named-rail',
  journey: 'pay',
  covers: ['pay-link', 'url-routing', 'rail-choice', 'never-override'],
  verifies: 'A payment link naming USDC@Solana pays exactly that rail with home=USD/preferred ckUSDC selected — no rail-selection copy on the pinned path.',
  timeoutMs: 30000,
};

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const SEND_AMOUNT = '0.001';

export async function run() {
  const start = Date.now();
  console.log('[123-pay-link-named-rail] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[123-pay-link-named-rail] onboarding with home=USD (manual — onboardWallet pins CHF+DEMO)…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-named-rail', {timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipRehearsalIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-USD');
    await driver.click('btn-home-currency-continue');
    await driver.findByTestID('balance', {timeoutMs: 10_000});

    // 1. Baseline: USD home selects the PREFERRED ckUSDC rail (flow 118's remembered-asset rule).
    //    This is what the named-rail link must override — by naming, not by choosing.
    assertIncludes(await driver.readText('active-asset-label'), 'US dollars',
      'home=USD must start on the preferred ckUSDC rail');

    // The SOL RPC stub: USDC FUNDED (2.5 USDC — the sibling is the richer rail here, tempting any
    // chooser) + 5 SOL for fees. Installed on every subsequent document: the link navigation
    // below loads a fresh page, which would wipe a plain driver.eval.
    await driver.page.evaluateOnNewDocument(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
      };
    });

    // 2. The link NAMES the sibling rail: asset=USDC, network=solana.
    const link = `/wallet/pay/${DEST_ADDR}?asset=USDC&network=solana&amount=${SEND_AMOUNT}`
      + `&label=${encodeURIComponent('Named Rail Merchant')}`
      + `&relay=${encodeURIComponent(relayBaseURL)}`;
    console.log('[123-pay-link-named-rail] opening the USDC@Solana link…');
    await driver.navigate(webBaseURL, link, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});

    await driver.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    assertEq(await driver.readText('active-asset-label'), 'USDC·Sol balance',
      'the NAMED rail (USDC@Solana) must be the selected asset — never the preferred ckUSDC');

    const addr = await driver.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-address-input');
    assertEq(addr, DEST_ADDR, 'the send form must carry the link\'s destination address');
    const amt = await driver.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-amount-input');
    assertEq(amt, SEND_AMOUNT, 'the send form must carry the link\'s amount');

    // The pinned path carries NO rail-selection copy: no switch affordance, no rail disclosure,
    // no funded-sibling pointer — and never the preferred rail's name.
    const body = await driver.bodyText();
    assert(!/Switch to/.test(body), 'the pinned path must offer no rail switch');
    assert(!/ckUSDC/.test(body), 'the pinned path must not name the preferred rail anywhere');
    assert(!/default rail/.test(body), 'the pinned path must not explain a rail choice it never made');
    assert(!(await driver.isPresent('receive-rail-disclosure')), 'no rail disclosure on the pinned path');
    assert(!(await driver.isPresent('fund-sibling-rail')), 'no funded-sibling pointer on the pinned path');

    // 3. The review pays the NAMED rail exactly; nothing was sent by the link itself.
    const review = await driver.findByTestID('sol-send-review', {timeoutMs: 5_000});
    const reviewTxt = await review.evaluate((n) => (n.textContent ?? '').trim());
    assert(/0.001000 USDC/.test(reviewTxt), `review should show 0.001000000 USDC, got: "${reviewTxt}"`);
    assert(!/Sent/.test(body), 'a payment link must NOT auto-send — the review is the terminal state');

    console.log('[123-pay-link-named-rail] confirming (sign + broadcast via stub)…');
    await driver.click('btn-sol-send-confirm', {timeoutMs: 5_000});
    const status = await driver.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the sheet should show "Sent ✓", got: "${statusTxt}"`);
    console.log(`[123-pay-link-named-rail] ✓ ${statusTxt}`);

    await driver.screenshot('123-pay-link-named-rail');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[123-pay-link-named-rail] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[123-pay-link-named-rail] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
