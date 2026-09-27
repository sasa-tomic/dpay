import {stagePipe} from './harness/evm/pipe.mjs';
import {deriveEvmKeypair} from './harness/evm/evm-core.mjs';
import {ANVIL_ACCOUNT_0_PRIV, fundEth, transferToken} from './harness/evm/anvil.mjs';
import {setup, onboardWallet, accountOf, selectEvmAsset} from './harness/lib.mjs';
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const env = await stagePipe({recipients: []});
const app = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
const {driver} = app;
try {
  await onboardWallet(driver, 'probe');
  const id = await accountOf(driver);
  const device = deriveEvmKeypair(id.secretHex);
  await fundEth(env.anvil.rpcUrl, device.address, 1_000_000_000_000_000n);
  await transferToken(env.anvil.rpcUrl, env.anvil.tokenAddress, ANVIL_ACCOUNT_0_PRIV, device.address, ZCHF(500));
  await selectEvmAsset(driver, 'evm-zchf-anvil');
  await driver.click('btn-pay-send', {timeoutMs: 5_000});
  await new Promise(r=>setTimeout(r,4000));
  const state = await driver.eval(() => ({
    ids: [...new Set([...document.querySelectorAll('[data-testid]')].map(n=>n.getAttribute('data-testid')))].filter(t=>t.includes('evm')||t.includes('fund')||t.includes('offline')),
    body: document.body.innerText.slice(0, 600),
  }));
  console.log('PROBE state:', JSON.stringify(state, null, 2));
} finally {
  await app.stop();
  await env.stop();
}
