// Read the __DPAY_PROBE_CEFI hook the page set during the convert render.
import {setup, onboardWallet, openBalances, selectCurrency, faucetAccount, accountOf} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const env = await setup();
const r2 = await startRelay();
try {
  const {driver, webBaseURL} = env;
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await onboardWallet(driver, 'probe-cefi');
  const account = await accountOf(driver);
  await faucetAccount(r2.baseURL, account.publicHex, 500000000, {currency: 8});
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver);
  await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
  await driver.type('convert-amount', '5');
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  const probe = await driver.eval(() => globalThis.__DPAY_PROBE_GROUPS);
  console.log('PROBE-CEFI:', JSON.stringify(probe, null, 1));
  process.exit(0);
} catch (e) {
  console.error('PROBE-FAIL', e);
  process.exit(1);
} finally {
  await r2.stop();
}
