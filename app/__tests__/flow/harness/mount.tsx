/**
 * mount.tsx — full-app mount under react-test-renderer + act (the existing convention, extended
 * with the driver shim). The e2e web shims and seams are already installed (setupFlow ran as a
 * setupFile); this file only renders <App/> and binds the driver.
 *
 * "Reload" semantics (flows 155/169/181/212/33): `unmount()` + `remount()` WITHOUT clearing
 * AsyncStorage — the persisted-state honesty those flows assert survives by construction. The
 * optional `url` on (re)mount sets the location stub first: the COLD-LOAD URL surface (the
 * ?screen=/?m= deep links).
 */
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import App from '../../../App';
import {resetRelayAddressesForTest} from '../../../services/relayAddresses';
import {resetRelayBuildStateForTest} from '../../../services/relay';
import {WALLET_ORIGIN, setRelayBaseForSolana, setSolanaRpcUrl, setIcGatewayUrl} from '../../../config/constants';
import {setRelayBaseForEvm, setEvmRpcUrl} from '../../../evm/endpoints';
import {Driver} from './driver';
import {setPageURL} from './setupFlow';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fresh-page semantics for the module-session transport state. One module registry per FILE
 * means a retargeting test (Settings apply / pointRelayListAt / goOffline / enableSolRail /
 * flow-199's private relay) leaves the walk list, the derivation bases and the operator
 * overrides pointing at ITS relay for every later mount in this file: the next boot reads the
 * PURGED storage, `if (relayListV.length > 0)` skips the setter, and the wallet keeps walking
 * the previous test's port (observed 2026-09-29: relay-failover phase 2 walked phase 1's
 * [dead, live] — 44 failed fetches to phase 1's dead port, probe-proven). A mount IS a fresh
 * page load: reset to the pre-wiring defaults here, BEFORE renderer.create — the boot effect
 * re-applies any planted storage row right after, so pre-mount setups still win, and mid-test
 * retargets are unaffected (the reset precedes the mount, never runs mid-test).
 */
function resetSessionModuleState(): void {
  resetRelayAddressesForTest();          // the walk list + its revision
  resetRelayBuildStateForTest();         // walk fingerprints / baseline / drift / cooldowns
  setRelayBaseForSolana(WALLET_ORIGIN);  // SOL derivation bases → the pre-wiring default
  setRelayBaseForEvm(WALLET_ORIGIN);     // EVM derivation bases → the pre-wiring default
  // Operator overrides re-apply FROM THE SEAM, never a blind clear: a file seeds its rail mode
  // at module scope (e.g. __DPAY_TEST_SOLANA_RPC_URL = 'stub' before constants load — flow 122/
  // 131/45's fail-closed SOL surfaces) and a mount is a fresh page ON THAT FILE, not a fresh
  // file. '' clears; a seeded value rides. EXCEPT the offline SENTINELS ('stub' — solrpc.ts's
  // SOL sentinel): they are not URLs and the setter refuses them BY DESIGN — their rail mode
  // lives in the module-load TEST override (constants.ts), never in the operator row.
  const solSeam = ((globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL as string | undefined) ?? '';
  setSolanaRpcUrl(solSeam === 'stub' ? '' : solSeam);
  setEvmRpcUrl(((globalThis as unknown as Record<string, unknown>).__DPAY_TEST_EVM_RPC_URL as string) ?? '');
  setIcGatewayUrl('');                   // the stored IC-gateway override row's module mirror
}

// Every live Mount this worker created, on globalThis so the harness lifecycle (afterEnv's own
// module registry — module state here would not be visible to it) can unmount them in afterEach
// BEFORE tearing down any private flow relays (the e2e teardown ORDER: quiesce the polls, then
// kill the relay). Entries remove themselves on unmount.
type MountG = {__DPAY_FLOW_ACTIVE_MOUNTS__?: Array<{unmount: () => Promise<void>}>};
const mg = globalThis as unknown as MountG;
function track(m: {unmount: () => Promise<void>}): void {
  mg.__DPAY_FLOW_ACTIVE_MOUNTS__ ??= [];
  mg.__DPAY_FLOW_ACTIVE_MOUNTS__.push(m);
}
function untrack(m: {unmount: () => Promise<void>}): void {
  const all = mg.__DPAY_FLOW_ACTIVE_MOUNTS__ ?? [];
  const i = all.indexOf(m);
  if (i >= 0) all.splice(i, 1);
}

export type Mount = {
  driver: Driver;
  tree: renderer.ReactTestRenderer;
  unmount: () => Promise<void>;
  /** Remount WITHOUT clearing AsyncStorage (the reload / app-kill semantics). */
  remount: (opts?: {url?: string}) => Promise<void>;
};

async function create(): Promise<renderer.ReactTestRenderer> {
  resetSessionModuleState();
  let tree!: renderer.ReactTestRenderer;
  // SYNC act for the create itself; the boot chain settles via bounded real sleeps (async act
  // would await the wallet's perpetual poll chains — measured multi-second hangs).
  act(() => {
    tree = renderer.create(React.createElement(App));
  });
  await sleep(60);
  await sleep(60);
  return tree;
}

export async function mountApp(opts: {url?: string} = {}): Promise<Mount> {
  if (opts.url) setPageURL(opts.url);
  const driver = new Driver();
  let tree = await create();
  driver.bindTree(tree);

  let unmounted = false;
  const doUnmount = async (): Promise<void> => {
    if (unmounted) return;
    unmounted = true;
    untrack(m);
    await act(async () => {
      tree.unmount();
    });
  };

  const m: Mount = {
    driver,
    tree,
    async unmount() {
      await doUnmount();
    },
    async remount(remountOpts: {url?: string} = {}) {
      await act(async () => {
        tree.unmount();
      });
      if (remountOpts.url) setPageURL(remountOpts.url);
      tree = await create();
      driver.bindTree(tree);
      (m as unknown as {tree: renderer.ReactTestRenderer}).tree = tree;
    },
  };
  track(m);
  return m;
}
