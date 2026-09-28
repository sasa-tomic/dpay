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
  accountOf, assert, assertEq, assertIncludes, DpayCore, faucetAccount, getBalance,
  onboardWallet, onboardSeededUnfunded, openBalances, openReceiveAddress, railPrincipalText,
  selectCurrency, waitForWallet,
} from '../harness/lib';
export type {Mount} from '../harness/lib';
