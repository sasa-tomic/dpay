/**
 * wallet-picker — the KNOWN_WALLETS table and the two picker helpers it feeds (`installedWallets`,
 * `openWalletWithUri`) in `wallet.ts`.
 *
 * WHY A PICKER AT ALL: `@walletconnect/sign-client` only foregrounds the wallet for a session
 * request when it can read a recorded deeplink choice from its own storage, and dpay is the only
 * component left that can write one (the appkit that normally does is shimmed out). Recording it
 * means dpay must KNOW which wallet was opened — which the bare `wc:` system chooser
 * (`openWalletApp`) cannot tell it. Hence: a named list, an installed-check, and a per-wallet open.
 *
 * These tests own the TRANSPORT-AGNOSTIC half (no `@walletconnect/*` is reached: `../walletconnect`
 * is mocked, so the lazy dynamic import inside `openWalletWithUri` resolves to a controllable
 * double). The WalletConnect-side half — what `recordWalletChoice` actually writes, under which
 * key, and its deletion on teardown — is pinned in `walletconnect.test.ts`.
 *
 * `react-native` is mocked minimally (`Platform` + `Linking`) exactly as `walletconnect.test.ts`
 * does: `wallet.ts` touches nothing else from it, and requiring the real preset here would drag in
 * turbo modules for no gain. `WALLETCONNECT_PROJECT_ID` is a module-load const, so every case
 * re-evaluates `wallet.ts` inside `jest.isolateModules` with the desired override.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import type {KnownWallet} from '../wallet';

// Controllable `Platform.OS` + `Linking`. `jest.mock` is hoisted and its factory runs lazily at
// require time, so a test flips these BEFORE `load()`. The `mock` name prefix is what lets jest's
// hoisting rule permit the references. Default 'android' — the only platform this seam serves.
let mockPlatformOS = 'android';
const mockCanOpenURL = jest.fn<(url: string) => Promise<boolean>>();
const mockOpenURL = jest.fn<(url: string) => Promise<void>>();
jest.mock('react-native', () => ({
  Platform: {OS: mockPlatformOS},
  Linking: {canOpenURL: mockCanOpenURL, openURL: mockOpenURL},
}));

// The lazy dynamic-import boundary `openWalletWithUri` crosses to record the choice. Mocking it
// here keeps this suite free of WalletConnect entirely AND lets the record step be driven to
// failure (the storage-write-failed path below).
const mockRecordWalletChoice = jest.fn<(wallet: KnownWallet) => Promise<void>>();
jest.mock('../walletconnect', () => ({recordWalletChoice: mockRecordWalletChoice}));

const PROJECT_ID = 'test-project-id';

/** The `wallet.ts` surface under test, re-evaluated with `projectId` + `mockPlatformOS` applied. */
type Loaded = {
  KNOWN_WALLETS: readonly KnownWallet[];
  installedWallets: () => Promise<KnownWallet[]>;
  openWalletWithUri: (wallet: KnownWallet, uri: string) => Promise<boolean>;
};

function load(id: string): Loaded {
  let out!: Loaded;
  jest.isolateModules(() => {
    // ALWAYS set the override (even to '') — constants.ts defaults to the REAL project id, so
    // deleting it would ENABLE WalletConnect. `load('')` is the disabled-guard case.
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
    out = require('../wallet') as Loaded;
  });
  return out;
}

/** Find a row by name — the tests drive real rows rather than inventing a fake wallet. */
function row(wallets: readonly KnownWallet[], name: string): KnownWallet {
  const found = wallets.find(w => w.name === name);
  if (!found) throw new Error(`KNOWN_WALLETS has no row named ${name}`);
  return found;
}

afterEach(() => {
  mockPlatformOS = 'android';
  mockCanOpenURL.mockReset();
  mockOpenURL.mockReset();
  mockRecordWalletChoice.mockReset();
  (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
});

// --- the table -------------------------------------------------------------------------------
// The VALUES come from the WalletConnect Explorer API (sourced + dated at the table itself) and are
// deliberately NOT restated here — a second copy is a second thing to drift. What is asserted is
// the SHAPE each consumer depends on, which the values alone cannot guarantee.
describe('KNOWN_WALLETS', () => {
  test('every scheme is a BARE `<scheme>://` — the form both consumers append to', () => {
    const {KNOWN_WALLETS} = load(PROJECT_ID);
    expect(KNOWN_WALLETS.length).toBeGreaterThan(0);
    for (const w of KNOWN_WALLETS) {
      // `openWalletWithUri` appends `wc?uri=…` and the SDK's `formatDeeplinkUrl` appends
      // `/wc?requestId=…` to the STORED href — a scheme carrying a path or query breaks both.
      expect(w.scheme).toMatch(/^[a-z][a-z0-9+.-]*:\/\/$/);
    }
  });

  test('every androidPackage is a valid Android application id, and every row is unique', () => {
    const {KNOWN_WALLETS} = load(PROJECT_ID);
    for (const w of KNOWN_WALLETS) {
      expect(w.androidPackage).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(w.name.trim()).toBe(w.name);
      expect(w.name).not.toBe('');
    }
    // A duplicate scheme would make two picker rows open the same app; a duplicate package would
    // make the manifest agreement below pass while hiding a missing entry.
    expect(new Set(KNOWN_WALLETS.map(w => w.name)).size).toBe(KNOWN_WALLETS.length);
    expect(new Set(KNOWN_WALLETS.map(w => w.scheme)).size).toBe(KNOWN_WALLETS.length);
    expect(new Set(KNOWN_WALLETS.map(w => w.androidPackage)).size).toBe(KNOWN_WALLETS.length);
  });

  // Android 11+ package visibility: without a <queries> entry `Linking.canOpenURL` answers false
  // for an installed wallet, so the picker would silently hide it. The manifest entry for Safe was
  // `io.gnosis.safe`, a dead Play listing (Safe rebranded to `global.safe.mobileapp`) — exactly the
  // drift this derives away. The expectation is built FROM the table, never restated.
  test('AndroidManifest <queries> declares exactly the KNOWN_WALLETS packages', () => {
    const {KNOWN_WALLETS} = load(PROJECT_ID);
    const manifest = readFileSync(
      join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );
    const block = /<queries>([\s\S]*?)<\/queries>/.exec(manifest);
    expect(block).not.toBeNull();
    const declared = [...(block as RegExpExecArray)[1].matchAll(/<package\s+android:name="([^"]+)"\s*\/>/g)]
      .map(m => m[1]);
    // Exact agreement in BOTH directions: a missing entry hides an installed wallet, and a stale
    // extra entry is a package name nobody checks and everybody trusts.
    expect([...declared].sort()).toEqual([...KNOWN_WALLETS.map(w => w.androidPackage)].sort());
  });
});

// --- installedWallets ------------------------------------------------------------------------
describe('installedWallets', () => {
  test('returns only the wallets whose scheme the OS can open, in table order', async () => {
    const {KNOWN_WALLETS, installedWallets} = load(PROJECT_ID);
    const trust = row(KNOWN_WALLETS, 'Trust Wallet');
    const metamask = row(KNOWN_WALLETS, 'MetaMask');
    mockCanOpenURL.mockImplementation(async (url: string) =>
      url === trust.scheme || url === metamask.scheme,
    );

    const found = await installedWallets();

    expect(found).toEqual(KNOWN_WALLETS.filter(w => w === trust || w === metamask));
    // Every row is probed by its bare scheme — nothing else.
    expect(mockCanOpenURL.mock.calls.map(c => c[0])).toEqual(KNOWN_WALLETS.map(w => w.scheme));
  });

  test('no wallet installed → empty list (the picker has nothing to offer)', async () => {
    const {installedWallets} = load(PROJECT_ID);
    mockCanOpenURL.mockResolvedValue(false);
    await expect(installedWallets()).resolves.toEqual([]);
  });

  test('a canOpenURL rejection drops only that wallet and logs the cause', async () => {
    const {KNOWN_WALLETS, installedWallets} = load(PROJECT_ID);
    const metamask = row(KNOWN_WALLETS, 'MetaMask');
    mockCanOpenURL.mockImplementation(async (url: string) => {
      if (url === metamask.scheme) throw new Error('bad URL scheme');
      return true;
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const found = await installedWallets();
      // Every other wallet survives — one broken probe must not blank the picker…
      expect(found).toEqual(KNOWN_WALLETS.filter(w => w !== metamask));
      // …and the failure is never silent.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(metamask.scheme),
        expect.stringContaining('bad URL scheme'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('web → empty list without probing (canOpenURL always answers true there, so it proves nothing)', async () => {
    mockPlatformOS = 'web';
    const {installedWallets} = load(PROJECT_ID);
    await expect(installedWallets()).resolves.toEqual([]);
    expect(mockCanOpenURL).not.toHaveBeenCalled();
  });

  test('empty projectId → empty list without probing (WalletConnect disabled, nothing to pair)', async () => {
    const {installedWallets} = load('');
    await expect(installedWallets()).resolves.toEqual([]);
    expect(mockCanOpenURL).not.toHaveBeenCalled();
  });
});

// --- openWalletWithUri -----------------------------------------------------------------------
describe('openWalletWithUri', () => {
  const URI = 'wc:abcdef-1234@2?relay-protocol=irn&symKey=deadbeef';

  test('opens `<scheme>wc?uri=<encoded>` and records the choice', async () => {
    const {KNOWN_WALLETS, openWalletWithUri} = load(PROJECT_ID);
    const trust = row(KNOWN_WALLETS, 'Trust Wallet');
    mockOpenURL.mockResolvedValue(undefined);
    mockRecordWalletChoice.mockResolvedValue(undefined);

    await expect(openWalletWithUri(trust, URI)).resolves.toBe(true);

    // The shape every AppKit dapp emits (CoreHelperUtil.formatNativeUrl) and Trust's own docs
    // document: the pairing URI is percent-encoded into a `wc?uri=` query on the wallet's scheme.
    expect(mockOpenURL).toHaveBeenCalledWith(`${trust.scheme}wc?uri=${encodeURIComponent(URI)}`);
    expect(mockRecordWalletChoice).toHaveBeenCalledWith(trust);
  });

  test('wallet not installed (openURL rejects) → false, and NOTHING is recorded', async () => {
    const {KNOWN_WALLETS, openWalletWithUri} = load(PROJECT_ID);
    const rainbow = row(KNOWN_WALLETS, 'Rainbow');
    mockOpenURL.mockRejectedValue(new Error('No activity found to handle Intent { rainbow:… }'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(openWalletWithUri(rainbow, URI)).resolves.toBe(false);
      // Load-bearing: a recorded choice for a wallet that never opened would foreground the wrong
      // app — or nothing at all — for every later signing request.
      expect(mockRecordWalletChoice).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(rainbow.name),
        expect.stringContaining('No activity found'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('the storage write failing still reports the open that DID happen, and logs the cause', async () => {
    const {KNOWN_WALLETS, openWalletWithUri} = load(PROJECT_ID);
    const zerion = row(KNOWN_WALLETS, 'Zerion');
    mockOpenURL.mockResolvedValue(undefined);
    mockRecordWalletChoice.mockRejectedValue(new Error('AsyncStorage is full'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The wallet IS in the foreground — returning false would be a lie about what the user sees.
      await expect(openWalletWithUri(zerion, URI)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(zerion.name),
        expect.stringContaining('AsyncStorage is full'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('web → false without opening anything (the browser path uses window.ethereum)', async () => {
    mockPlatformOS = 'web';
    const {KNOWN_WALLETS, openWalletWithUri} = load(PROJECT_ID);
    await expect(openWalletWithUri(KNOWN_WALLETS[0], URI)).resolves.toBe(false);
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockRecordWalletChoice).not.toHaveBeenCalled();
  });

  test('empty projectId → false without opening anything (WalletConnect disabled)', async () => {
    const {KNOWN_WALLETS, openWalletWithUri} = load('');
    await expect(openWalletWithUri(KNOWN_WALLETS[0], URI)).resolves.toBe(false);
    expect(mockOpenURL).not.toHaveBeenCalled();
    expect(mockRecordWalletChoice).not.toHaveBeenCalled();
  });
});
