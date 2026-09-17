// Flow 115 — the till control exists everywhere, and says NO by name where it must.
//
// The hard UI rule is that every asset and every rail is handled through the SAME surfaces, so the
// till-code checkbox renders on both Receive forms for every asset — a control that appeared only
// for the one asset a till takes would be exactly the per-rail special case the rule forbids, and a
// shop holding ckBTC would be left guessing whether their phone can ring up at all.
//
// What that costs is a refusal, and this flow is about the quality of it. A dpay till is paid in
// VCHF on the Internet Computer and in nothing else (`crates/dpay-relay/src/till.rs`), so:
//   * with ckBTC selected the control refuses BY NAME — the asset AND its chain — and offers the one
//     tap that fixes it;
//   * that tap crosses to VCHF and lands on the counter, with the till form still chosen: the code
//     form is owned by the wallet, so the choice survives the re-mount the switch causes;
//   * with SOL selected the SAME control renders on the Solana Receive form and refuses by name
//     there too — the rail parity the hard rule is about;
//   * a price finer than a rappen is refused on the phone, before anything is signed or sent.
//
// Nothing here rings up a charge, so nothing here needs the relay's till to answer at all — which is
// the point: every one of these is decided on the device, with the money nowhere near it.
//
// Selector contract: `receive-code-form`, `btn-code-till`, `till-refused`, `till-refused-go`,
// `amount-input`, `btn-till-ring-up`, `till-err`, `till-qr`, `sol-req-memo-input`, `btn-sol-req-make`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, selectCurrency,
} from '../harness/lib.mjs';

export const meta = {
  id: '115',
  name: 'till-refusals',
  journey: 'pay',
  covers: ['till', 'merchant-till', 'rail-parity', 'same-surfaces', 'fail-closed', 'honest-instructions', 'asset-switch', 'shared-message-box'],
  verifies: 'The till-code checkbox renders for EVERY asset on BOTH Receive rails and fails closed by name where a charge cannot be rung up: with ckBTC selected it names the asset and its chain, says a till code is paid in VCHF, and offers one tap that switches — after which the counter is open with the checkbox still checked (the code form is wallet-owned, so it survives the rail re-mount). With SOL selected the same checkbox renders on the Solana Receive form and refuses naming SOL on Solana — and the message box there is the ONE box both code forms share (its text survives the checkbox toggle in both directions). A price finer than a rappen is refused on the device with the correction spelled out, and nothing is signed or sent.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[115-till-refusals] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;
    await onboardWallet(driver, 'e2e-till-refusals');

    // --- 1. a chain-key asset: refused by name, with the switch offered ------------------------
    console.log('[115-till-refusals] ckBTC selected → the till control refuses by name…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckbtc');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    assert(await driver.isPresent('receive-code-form'), 'the till-code checkbox renders for ckBTC too — the same-surfaces rule');
    await driver.click('btn-code-till', { timeoutMs: 4_000 });
    await driver.findByTestID('till-refused', { timeoutMs: 5_000 });
    const refusedBtc = await driver.readText('till-refused');
    assertIncludes(refusedBtc, 'BTC', 'the refusal names the selected asset');
    assertIncludes(refusedBtc, 'Bitcoin', 'and the chain it is on');
    assertIncludes(refusedBtc, 'VCHF', 'and what a till code IS paid in');
    assert(!refusedBtc.includes('ckBTC'), `the wallet names the backing symbol, never the wrapper:\n${refusedBtc}`);
    // A form that cannot produce a payable code must not be pressed.
    assert(!(await driver.isPresent('btn-till-ring-up')), 'no button is offered for an asset a till cannot take');
    await driver.screenshot('115-till-refused-ckbtc');

    // --- 2. the one tap that fixes it -----------------------------------------------------------
    console.log('[115-till-refusals] switching to VCHF from the refusal itself…');
    await driver.click('till-refused-go', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-till-ring-up', { timeoutMs: 6_000 });
    assert(!(await driver.isPresent('till-refused')), 'the refusal is gone once the asset it named is switched');

    // --- 3. the SAME control on the Solana rail --------------------------------------------------
    console.log('[115-till-refusals] SOL selected → the same control, refused on the other rail…');
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    assert(await driver.isPresent('receive-code-form'), 'the till-code checkbox renders on the Solana Receive form as well');
    // The till form is STILL the chosen one — the wallet owns the choice across the rail re-mount.
    await driver.findByTestID('till-refused', { timeoutMs: 5_000 });
    const refusedSol = await driver.readText('till-refused');
    assertIncludes(refusedSol, 'SOL', 'the Solana refusal names the selected asset');
    assertIncludes(refusedSol, 'Solana', 'and the rail it settles on');
    assertIncludes(refusedSol, 'Internet Computer', 'and where a till code settles instead');
    await driver.screenshot('115-till-refused-sol');
    // The ONE message box on the SOL rail too (founder 2026-09-14): present with the till checkbox
    // checked, and its text survives the toggle in both directions — the same-surfaces rule cuts
    // both ways, so this rail's box behaves exactly like the IC one flow 114 pins.
    const SOL_NOTE = 'SOL-side note';
    await driver.type('sol-req-memo-input', SOL_NOTE, { timeoutMs: 4_000 });
    await driver.click('btn-code-till', { timeoutMs: 4_000 }); // uncheck → the dpay SOL request form
    assertEq(await driver.readInputValue('sol-req-memo-input'), SOL_NOTE, 'the SOL message text survives unchecking the till checkbox');
    assert(await driver.isPresent('btn-sol-req-make'), 'the dpay SOL request form is back');
    await driver.click('btn-code-till', { timeoutMs: 4_000 }); // check again → the refusal returns
    assert(await driver.isPresent('sol-req-memo-input'), 'the SOL message box stays mounted with the till checkbox checked');
    assertEq(await driver.readInputValue('sol-req-memo-input'), SOL_NOTE, 'the SOL message text survives checking the till checkbox again');
    await driver.findByTestID('till-refused', { timeoutMs: 5_000 });
    // …and the same one tap crosses the rail.
    await driver.click('till-refused-go', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-till-ring-up', { timeoutMs: 6_000 });

    // --- 4. a price a till cannot charge, refused on the device ---------------------------------
    console.log('[115-till-refusals] a sub-rappen price is refused before anything is signed…');
    await driver.type('amount-input', '10.505', { timeoutMs: 4_000 });
    await driver.click('btn-till-ring-up', { timeoutMs: 4_000 });
    const err = await driver.readText('till-err');
    assertIncludes(err, 'rappen', 'the refusal names the rule that was broken');
    assertIncludes(err, '10.50', 'and shows what to type instead');
    assert(!(await driver.isPresent('till-qr')), 'nothing was rung up, so no code is showing');

    console.log(`[115-till-refusals] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('115-till-refusals RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
