/**
 * Per-batch helpers for the onboard/settings flow files (batch E). Harness core is frozen, so
 * batch-local helpers live here.
 *
 * freshContext(): jest runs many full-app mounts per FILE (one module registry), and an unmounted
 * app's in-flight write chains (journey award, identity save) can land AFTER the lifecycle's
 * AsyncStorage.clear() — re-seeding a stamp the next boot then trusts. The browser twin never sees
 * this: every phase is a fresh page with zero in-flight state. Drain the stragglers and verify the
 * store is ACTUALLY empty before mounting a pristine first-run context.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage') as {
  clear: () => Promise<void>;
  getItem: (k: string) => Promise<string | null>;
};

/** The persisted-state keys that steer the first-run router (App.tsx) and Onboarding's gate. */
const ROUTER_KEYS = ['dpay.identity.v1', 'dpay.identity.pending.v1', 'dpay.journey.v1'];

export async function freshContext(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await AsyncStorage.clear();
    const left = (await Promise.all(ROUTER_KEYS.map((k) => AsyncStorage.getItem(k)))).some((v) => v != null);
    if (!left) return;
    await sleep(100);
  }
  throw new Error('freshContext: storage never settled empty — an unmounted app keeps rewriting it');
}
