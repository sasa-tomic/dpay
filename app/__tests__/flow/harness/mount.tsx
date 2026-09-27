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

  const m: Mount = {
    driver,
    tree,
    async unmount() {
      await act(async () => {
        tree.unmount();
      });
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
  return m;
}
