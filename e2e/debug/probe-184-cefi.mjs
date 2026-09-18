// One-off probe: dump the REAL convert destination tree from ICP (flow 184's surface),
// before/after selecting the USDC external group — to pin the cefi mech testIDs.
import {
  assert, onboardWallet, openBalances, selectCurrency, faucetAccount, accountOf, setup,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';

const env = await setup();
const r2 = await startRelay();
try {
  const {driver, webBaseURL} = env;
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await onboardWallet(driver, 'probe-184');
  const account = await accountOf(driver);
  await faucetAccount(r2.baseURL, account.publicHex, 500000000, {currency: 8});
  await faucetAccount(r2.baseURL, account.publicHex, 5000000000000, {currency: 6});
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver);
  await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
  await driver.type('convert-amount', '5');
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});

  const dump = () => driver.eval(() =>
    [...document.querySelectorAll('[data-testid^="convert-dest"]')].map(e => e.getAttribute('data-testid')));
  console.log('BEFORE:', JSON.stringify(await dump(), null, 1));
  await driver.click('convert-dest-route-multihop:icpswap-ckusdc:2');
  await new Promise(res => setTimeout(res, 800));
  console.log('AFTER:', JSON.stringify(await dump(), null, 1));
  console.log('PROBE-DONE');
  process.exit(0);
} catch (e) {
  console.error('PROBE-FAIL', e);
  process.exit(1);
} finally {
  await r2.stop();
}
