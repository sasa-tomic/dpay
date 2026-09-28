/**
 * Batch-A (receive/deposit) flow helpers. The per-test lifecycle (fresh AsyncStorage, seam
 * resets, the fail-closed fetch assertion) is registered by jest.flow-after-env.js — which the
 * flow project's config does not yet wire as a setupFilesAfterEnv file (harness gap, filed for
 * the integrator). Calling the exported installer here at collection time registers the SAME
 * hooks for every batch-A flow file that imports this helper; when the integrator wires the
 * after-env file the duplicate registration is harmless (the hooks are idempotent resets).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {installFlowLifecycle} = require('../harness/setupFlow') as {installFlowLifecycle: () => void};
installFlowLifecycle();

export {
  accountOf, armPayScan, assert, assertEq, assertIncludes, DpayCore, faucetAccount, getBalance,
  onboardWallet, onboardSeededUnfunded, openBalances, openReceiveAddress, railPrincipalText,
  selectCurrency, selectSolRail, waitForWallet,
} from '../harness/lib';
export type {Mount} from '../harness/lib';

import type {Mount} from '../harness/lib';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a testID's text, tolerating the mount transient: sheets whose body depends on async
 *  params (onramp params, deposit_info) can remount between a presence probe and the read —
 *  poll the read itself until the node is present AND carries text (deadline-honest throw). */
export async function readStable(m: Mount, testID: string, opts: {timeoutMs?: number} = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  for (;;) {
    try {
      const text = m.driver.readText(testID);
      if (text.length > 0) return text;
    } catch { /* the transient — retry */ }
    if (Date.now() > deadline) {
      throw new Error(`[readStable] testID=${testID} never carried text within ${opts.timeoutMs ?? 8000}ms`);
    }
    await sleep(25);
  }
}
