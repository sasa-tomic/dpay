// Flow 192 — the user's Stop during a LIVE swap (the 2026-09-19 founder ask): the record
// aborts honestly instead of promising a cancel. The fake-IC reply-delay knob
// (`POST /api/v1/test/ic_delay`, method-keyed) holds the depositFromAndSwap reply for 12 s
// after its submit — the deterministic in-flight window a real boundary node's latency gives
// only by luck. In that window the swap envelope is already ON THE BOOKS (202-accepted,
// reply pending, legPlan swap state 'sent'), so the record is watching, the button says
// "Stop watching", and the Stop tap lands on the TERMINAL aborted card whose watching flavor
// says the truth: "The swap may still go through. Check Balances later." No Stop control
// remains once the record is terminal.

import {
  setup,
  assert,
  onboardWallet,
  accountOf,
  faucetAccount,
  openBalances, openConvertFor,
  selectCurrency,
  typeConvertAmount,
} from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

export const meta = {
  id: '192',
  name: 'convert-abort',
  journey: 'convert',
  covers: [
    'convert',
    'icp',
    'abort',
    'stop-watching',
    'flavor-watching',
    'may-still-go-through',
    'in-flight-window',
    'fake-ic-delay',
    'terminal-abort-ui',
    'no-stop-after-abort',
  ],
  verifies:
    'the founder ask 2026-09-19: a live conversion can be stopped; a submitted swap is honestly flagged as may-still-go-through',
  timeoutMs: 120000,
};

export async function run() {
  const start = Date.now();
  console.log('[192-convert-abort] setup (own relay — the ic_delay knob is global per gateway)…');
  const env = await setup();
  const r2 = await startRelay();
  try {
    const { webBaseURL, driver } = env;
    const relayBaseURL = r2.baseURL;
    await driver.navigate(
      webBaseURL,
      `/?relay=${encodeURIComponent(relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 8_000 },
    );
    await driver.waitReady({ timeoutMs: 8_000 });

    console.log('[192-convert-abort] onboarding + funding + the Convert surface…');
    await onboardWallet(driver, 'e2e-convert-abort');
    const account = await accountOf(driver);
    const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openConvertFor(driver, 'icp');
    assert(
      (await driver.findByTestID('convert-screen', { timeoutMs: 8_000 })) != null,
      'the Convert surface opens for ICP',
    );
    await typeConvertAmount(driver, '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 10_000 });

    console.log('[192-convert-abort] arming the ic_delay knob — the swap reply stays pending 12 s…');
    const arm = await fetch(`${relayBaseURL}/api/v1/test/ic_delay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'depositFromAndSwap', ms: 12000 }),
    });
    assert(arm.ok, `ic_delay knob armed (status ${arm.status}): ${await arm.text()}`);

    console.log('[192-convert-abort] confirm → approve settles, swap submits, reply held…');
    await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });
    assert(
      (await driver.findByTestID('convert-swapping', { timeoutMs: 45_000 })) != null,
      'the swapping card renders (swap envelope submitted, reply pending)',
    );

    const stopBtn = await driver.findByTestID('btn-convert-stop', { timeoutMs: 5_000 });
    assert(stopBtn != null, 'the Stop control is offered while the swap is in flight');
    const stopLabel = await driver.readText('btn-convert-stop');
    assert(
      stopLabel.includes('Stop watching'),
      `the watching flavor labels the button "Stop watching" (got: ${stopLabel})`,
    );

    console.log('[192-convert-abort] Stop → terminal aborted card, honest about the swap…');
    await driver.click('btn-convert-stop', { timeoutMs: 5_000 });
    assert(
      (await driver.findByTestID('convert-aborted', { timeoutMs: 15_000 })) != null,
      'the TERMINAL aborted card renders within 15 s of the Stop tap',
    );
    const abortedBody = await driver.readText('convert-aborted');
    assert(
      abortedBody.includes('The swap may still go through'),
      `the aborted body carries the watching flavor's may-still-go-through truth (got: ${abortedBody})`,
    );
    assert(
      (await driver.findByTestID('btn-convert-stop', { timeoutMs: 1_000 }).catch(() => null)) ==
        null,
      'no Stop button remains on the terminal aborted card',
    );
    await driver.screenshot('192-convert-abort');

    console.log(`[192-convert-abort] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('192-convert-abort RED:', e.stack || e.message || e);
  });
}
