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
import {Driver} from './driver';
import {setPageURL} from './setupFlow';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
