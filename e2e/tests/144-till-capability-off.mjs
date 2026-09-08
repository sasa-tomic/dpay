// Flow 144 — cashier availability is discovered before the UI offers it. A relay with its till
// routes disabled must show the ordinary dpay request form, never the cashier selector that would
// lead to a guaranteed 404. The normal VCHF request remains fully usable.
//
// The flow is a MATCHED PAIR against the SAME app and the SAME wallet, because the negative half
// alone constrains nothing: a selector that never renders on any relay would satisfy it. So the
// second half re-points the identical page at the shared session relay — which runs with the till
// ENABLED — and requires the selector to appear. Absent-then-present is what pins the selector to
// `GET /api/v1/capabilities` rather than to some unrelated condition.
//
// Deliberately NOT asserted here: "the app sends no till POST". With the till off there is no
// selector, so `TillCharge` is unreachable and no POST is constructible — the assertion would be
// true of a till-ENABLED relay too. The absence of the selector IS the constraint.
import {
  setup, assert, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  chooseHomeCurrencyIfPresent,
} from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '144',
  name: 'till-capability-off',
  journey: 'pay',
  covers: ['till', 'capabilities', 'receive', 'vchf', 'fail-closed', 'positive-control'],
  verifies: 'A till-disabled relay makes Receive offer no cashier-code selector while the ordinary VCHF dpay request still works; the SAME app re-pointed at a till-enabled relay shows the selector — so the surface tracks the capability, not a constant.',
  timeoutMs: 45_000,
};

export async function run() {
  const env = await setup();
  const tillOff = await startRelay({till: false});
  try {
    const {driver, webBaseURL} = env;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(tillOff.baseURL)}`, {
      waitUntil: 'domcontentloaded', timeoutMs: 8_000,
    });
    await driver.waitReady({timeoutMs: 10_000});

    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-till-off', {timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver, 'CHF');

    // (1) NEGATIVE HALF — till off. `receive-code-form` is the selector's container, so its absence
    //     also settles both segments; asserting `btn-code-till` here too would restate it.
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('amount-input', {timeoutMs: 8_000});
    assert(!(await driver.isPresent('receive-code-form')),
      'a till-disabled relay must not show the cashier-code selector');

    // (2) The ordinary VCHF request is untouched by the missing capability — the honest fallback is
    //     the full dpay request, not a degraded screen.
    await driver.type('amount-input', '1.00', {timeoutMs: 4_000});
    await driver.click('btn-request', {timeoutMs: 4_000});
    await driver.findByTestID('request-qr', {timeoutMs: 8_000});
    await driver.screenshot('144-till-capability-off');

    // (3) POSITIVE CONTROL — the same wallet (identity persists in this origin's storage), the same
    //     build, re-pointed at the shared session relay, which runs with the till ENABLED. Reloading
    //     via `?relay=` rather than retargeting in Settings also clears the Receive tab's request
    //     state, so the selector is judged on a freshly mounted form.
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(env.relayBaseURL)}`, {
      waitUntil: 'domcontentloaded', timeoutMs: 8_000,
    });
    await driver.waitReady({timeoutMs: 10_000});
    await chooseHomeCurrencyIfPresent(driver, 'CHF');
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('amount-input', {timeoutMs: 8_000});
    assert(await driver.isPresent('btn-code-till'),
      'a till-ENABLED relay must offer the cashier-code action — otherwise step 1 proves nothing');
    await driver.screenshot('144-till-capability-on');
  } finally {
    await tillOff.stop();
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => { console.log('[144-till-capability-off] done'); process.exit(0); }, (e) => { console.error(e); process.exit(1); });
}
