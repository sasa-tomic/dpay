// One-off probe: dump the REAL convert destination tree on VCHF (testIDs + labels),
// before and after tapping the standing row, against a private test-helpers relay.
import {
  assert, accountOf, faucetAccount, onboardWallet, openBalances, selectCurrency, setup,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const env = await setup();
const r2 = await startRelay();
try {
  const {driver, webBaseURL, stop} = env;
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  try {
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'probe-hub');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, 2000000000, {currency: 7});
    assert(fund.ok, `faucet VCHF credit ok (status ${fund.status})`);
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.findByTestID('convert-dest-direct', {timeoutMs: 10_000});

    const dump = () => driver.eval(() => {
      const els = [...document.querySelectorAll('[data-testid^="convert-dest"]')];
      return els.map(e => e.getAttribute('data-testid'));
    });
    console.log('BEFORE:', JSON.stringify(await dump(), null, 1));
    const mechsBefore = await driver.findByTestID('convert-dest-mechs', {timeoutMs: 1_000}).catch(() => null);
    console.log('mechsBefore rendered:', mechsBefore != null);
    await driver.click('convert-dest-direct');
    await new Promise(res => setTimeout(res, 500));
    console.log('AFTER:', JSON.stringify(await dump(), null, 1));
    const mechsAfter = await driver.findByTestID('convert-dest-mechs', {timeoutMs: 3_000}).catch(() => null);
    console.log('mechsAfter rendered:', mechsAfter != null);
    if (mechsAfter != null) {
      const text = await driver.readText('convert-dest-mechs');
      console.log('mechs text:', JSON.stringify(text));
    }
  } finally {
    await stop();
  }
} finally {
  await r2.stop();
}
