/**
 * lib.ts — the e2e harness sugar (`e2e/harness/lib.mjs`), ported verbatim-in-spirit to the flow
 * driver (same names, TS, first arg is the flow `Mount` where e2e passed the browser driver).
 * Port mechanically; do not redesign. HTTP-touching helpers live in relayClient.ts and are
 * re-exported here so a ported flow keeps its single import shape.
 */
import {mountApp, type Mount} from './mount';
import {DpayCore as CORE} from './setupFlow';
import {faucetAccount, getBalance, railTransfer, icpCatalog, relayGet, fmtHero} from './relayClient';
import type {DpayCoreApi} from '../../../lib/types';
import {setSolanaRpcUrl, RELAY_LIST_STORAGE_KEY} from '../../../config/constants';
import {setEvmRpcUrl} from '../../../evm/endpoints';

export {Driver} from './driver';
export {faucetAccount, getBalance, railTransfer, icpCatalog, relayGet, fmtHero};

/** The REAL wasm core (the same instance NativeModules.DpayCore carries). */
export const DpayCore = CORE as DpayCoreApi;

/**
 * Clear the rail OPERATOR overrides — module-session state inside the APP'S registry
 * (config/constants.ts `setSolanaRpcUrl`, evm/endpoints.ts `setEvmRpcUrl`: `''` clears, never an
 * offline switch). This helper must be called from the TEST FILE's module graph (it is — lib is
 * imported by every flow file) because the app modules here are the ones the app itself loaded;
 * the harness lifecycle runs in a different jest module registry and cannot reach them.
 * AsyncStorage rail keys are already covered by the lifecycle's per-test purge.
 */
export function resetRailOverrides(): void {
  setSolanaRpcUrl('');
  setEvmRpcUrl('');
}

export type {Mount};
// --- assertions (tiny, BigInt-safe — the lib.mjs originals) -------------------------------------

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[assert] ${msg}`);
}

export function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    const show = (v: unknown): string => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? `${x}` : x);
    throw new Error(`[assert] ${label}: expected ${show(expected)}, got ${show(actual)}`);
  }
}

export function assertIncludes(actual: string, substring: string, label: string): void {
  if (!actual.includes(substring)) {
    const excerpt = actual.length > 400 ? actual.slice(0, 400) + '…' : actual;
    throw new Error(`[assert] ${label}: page text should include "${substring}".\n  body excerpt:\n${excerpt}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- wallet-shell anchors -----------------------------------------------------------------------

/** The testID that means "the wallet shell is mounted" (the tab bar renders on every wallet
 *  surface and on none of the onboarding ones). Same anchor as lib.mjs. */
export const WALLET_READY = 'tab-home';

export async function waitForWallet(m: Mount, opts: {timeoutMs?: number} = {}): Promise<unknown> {
  return m.driver.findByTestID(WALLET_READY, {timeoutMs: opts.timeoutMs ?? 10_000});
}

// --- shared onboarding preambles ----------------------------------------------------------------

/** Dismiss the first-run walkthrough if showing. No-op when absent (never throws when neither
 *  surface is up). The press is confirmed by its EFFECT (the create form), per lib.mjs. */
export async function skipWalkthroughIfPresent(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const deadline = Date.now() + timeoutMs;
  let sawSkip = false;
  while (Date.now() < deadline) {
    if (m.driver.isPresent('username-input')) return;
    if (m.driver.isPresent('btn-walkthrough-skip')) { sawSkip = true; break; }
    await sleep(50);
  }
  if (!sawSkip) return;
  try { await m.driver.click('btn-walkthrough-skip', {timeoutMs}); } catch { /* press may land and unmount its own button */ }
  try {
    await m.driver.findByTestID('username-input', {timeoutMs});
  } catch {
    throw new Error(`[lib] walkthrough Skip pressed but the create form never appeared within ${timeoutMs}ms. ` +
      `On screen: ${JSON.stringify(m.driver.bodyText().slice(0, 300))}`);
  }
}

/** Leave the first-run practice payment if showing; either settled exit is accepted. */
export async function skipPracticeIfPresent(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const done = () => m.driver.isPresent(WALLET_READY) || m.driver.isPresent('btn-home-currency-continue');
  const deadline = Date.now() + timeoutMs;
  let exit: string | null = null;
  while (Date.now() < deadline) {
    if (await done()) return;
    for (const t of ['btn-practice-skip', 'btn-practice-continue', 'practice-offline-check']) {
      if (m.driver.isPresent(t)) { exit = t; break; }
    }
    if (exit) break;
    await sleep(50);
  }
  if (exit === null) return;
  while (Date.now() < deadline) {
    const now = (['btn-practice-skip', 'btn-practice-continue', 'practice-offline-check'] as const)
      .find((t) => m.driver.isPresent(t));
    if (now) {
      try { await m.driver.click(now, {timeoutMs: 2000}); } catch { /* re-render replaced the node */ }
    }
    const settle = Date.now() + 2000;
    while (Date.now() < settle) {
      if (await done()) return;
      await sleep(50);
    }
  }
  throw new Error(`[lib] practice was left but the wallet never appeared within ${timeoutMs}ms. ` +
    `On screen: ${JSON.stringify(m.driver.bodyText().slice(0, 300))}`);
}

/** Answer the first-run home-currency question if showing (no-op when a currency is stored). */
export async function chooseHomeCurrencyIfPresent(m: Mount, currency = 'CHF', opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  let sawChooser = false;
  while (Date.now() < deadline) {
    if (m.driver.isPresent(WALLET_READY)) return;
    if (m.driver.isPresent('btn-home-currency-continue')) { sawChooser = true; break; }
    await sleep(50);
  }
  if (!sawChooser) return;
  await m.driver.click(`home-currency-${currency}`, {timeoutMs});
  try { await m.driver.click('btn-home-currency-continue', {timeoutMs}); } catch { /* press unmounts its own button */ }
  try {
    await m.driver.findByTestID(WALLET_READY, {timeoutMs});
  } catch {
    throw new Error(`[lib] home-currency Continue pressed but the wallet never appeared within ${timeoutMs}ms. ` +
      `On screen: ${JSON.stringify(m.driver.bodyText().slice(0, 300))}`);
  }
}

export async function waitForEnabled(m: Mount, testID: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isDisabled(m, testID))) return;
    await sleep(50);
  }
  throw new Error(`[lib] element testID=${testID} stayed disabled past ${timeoutMs}ms`);
}

/** The persisted wallet identity (the app's own storage record), or null. */
export async function accountOf(_m: Mount): Promise<{secretHex: string; publicHex: string; username: string} | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
  const v = await AsyncStorage.getItem('dpay.identity.v1');
  return v ? JSON.parse(v) as {secretHex: string; publicHex: string; username: string} : null;
}

// --- the routes the sugar opens -----------------------------------------------------------------

/** Open the accounts route by the affordance the current screen offers (the lib.mjs lookup). */
export async function openBalances(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const affordance = m.driver.isPresent('balance') ? 'balance'
    : m.driver.isPresent('btn-home-accounts') ? 'btn-home-accounts' : null;
  if (affordance === null) {
    if (m.driver.isPresent('btn-convert-back')) {
      await m.driver.click('btn-convert-back', {timeoutMs});
    } else {
      throw new Error('openBalances: neither the header chip, Home\'s headline, nor the convert back chevron is on screen — the accounts route is unreachable from here');
    }
  } else {
    await m.driver.click(affordance, {timeoutMs});
  }
  await m.driver.findByTestID('asset-demo-select', {timeoutMs});
}

const ASSET_KEY_TO_CURRENCY: Record<string, string> = {
  vchf: 'CHF', ckusdc: 'USD', 'sol-eurc': 'EUR',
  ckbtc: 'BTC', cketh: 'ETH', icp: 'ICP', sol: 'SOL',
  'sol-usdc': 'USD',
};

/** Select a catalog currency in the ACCOUNTS route (sets MAIN), then restore the Pay tab. */
export async function selectCurrency(m: Mount, key: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  if (key === 'demo') {
    await m.driver.click('asset-demo-select', {timeoutMs});
    await waitForSelected(m, 'asset-demo', timeoutMs);
    await m.driver.click('tab-pay', {timeoutMs});
    return;
  }
  const currency = ASSET_KEY_TO_CURRENCY[key] ?? (key.length <= 4 ? key.toUpperCase() : null);
  if (currency == null) throw new Error(`selectCurrency: no currency for asset key "${key}"`);
  await m.driver.findByTestID(`btn-accounts-currency-${currency}`, {timeoutMs});
  await m.driver.click(`btn-accounts-currency-${currency}`, {timeoutMs});
  // The tap sets MAIN and navigates Home: Home's own headline names the currency we are in now.
  await m.driver.waitForFunction(
    () => m.driver.isReadTextSafe('home-headline-label', currency),
    {timeoutMs, label: `Home headline names ${currency}`},
  );
  await m.driver.click('tab-pay', {timeoutMs});
}

async function waitForSelected(m: Mount, testID: string, timeoutMs: number): Promise<void> {
  await m.driver.waitForFunction(
    () => m.driver.propOf(testID, 'aria-selected') === true,
    {timeoutMs, label: `${testID} aria-selected`},
  );
}

/** Put the wallet on the DEMO practice rail and end on the Pay scanner (the suite contract). */
export async function selectDemoAsset(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const dbg = process.env.DPAY_FLOW_DEBUG === '1';
  const t0 = Date.now();
  const mark = (l: string) => { if (dbg) console.log(`    [selectDemo] ${l}: ${((Date.now() - t0) / 1000).toFixed(1)}s`); };
  await openBalances(m, {timeoutMs});
  mark('openBalances');
  await m.driver.click('asset-demo-select', {timeoutMs});
  mark('click');
  await waitForSelected(m, 'asset-demo', timeoutMs);
  mark('aria');
  await m.driver.click('tab-pay', {timeoutMs});
  mark('tab-pay');
  await m.driver.findByTestID('pay-scan', {timeoutMs});
  mark('pay-scan');
}

export async function openReceiveAddress(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  await m.driver.click('tab-receive', {timeoutMs});
  await m.driver.click('btn-receive-address', {timeoutMs});
}

export async function openPaySend(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  await m.driver.click('tab-pay', {timeoutMs});
  await m.driver.click('btn-pay-send', {timeoutMs});
}

// --- convert sugar ------------------------------------------------------------------------------

export async function openConvertFor(m: Mount, key: string, opts: {timeoutMs?: number; formTimeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  await openBalances(m, {timeoutMs});
  const currency = ASSET_KEY_TO_CURRENCY[key] ?? (key.length <= 4 ? key.toUpperCase() : null);
  if (currency == null) throw new Error(`openConvertFor: no currency for asset key "${key}"`);
  await m.driver.click(`btn-accounts-convert-${currency}`, {timeoutMs});
  // The surface's own entry: form, live record, fund gate, or unavailable — any real root.
  const roots = ['convert-screen', 'convert-sheet', 'convert-state', 'crossrail-crossing', 'convert-awaiting-deposit',
    'convert-provider-processing', 'convert-done', 'convert-pending', 'convert-fund', 'convert-unavailable'];
  await m.driver.waitForFunction(() => roots.some((t) => m.driver.isPresent(t)), {
    timeoutMs: timeoutMs + 4000, label: `the ${currency} convert surface renders`,
  });
  // The fund gate can flash first when entry races the first balance poll — one re-entry, then
  // hand the gate to the caller (its fund-gate assertions take over), exactly like lib.mjs.
  for (let attempt = 0; attempt < 2; attempt++) {
    const deadline = Date.now() + (opts.formTimeoutMs ?? 6000);
    let sawGate = false;
    for (;;) {
      if (m.driver.isPresent('convert-amount')) return;
      if (['convert-state', 'convert-awaiting-deposit', 'convert-provider-processing', 'convert-done', 'convert-pending', 'crossrail-crossing']
        .some((t) => m.driver.isPresent(t))) return;
      sawGate = sawGate || m.driver.isPresent('convert-fund');
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    if (!sawGate) return;
    await m.driver.click('btn-convert-back', {timeoutMs: 5000});
    await m.driver.click(`btn-accounts-convert-${currency}`, {timeoutMs: 5000});
  }
}

export async function typeConvertAmount(m: Mount, text: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await m.driver.type('convert-amount', text, opts);
    if (m.driver.readInputValue('convert-amount') === text) return;
  }
  throw new Error(`typeConvertAmount: the controlled amount input never held "${text}" after 3 tries`);
}

export async function pickSwapTarget(m: Mount, code: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const names: Record<string, string> = {
    CHF: 'Swiss francs', USD: 'US dollars', EUR: 'Euros', BTC: 'Bitcoin',
    ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana',
  };
  const name = names[code] ?? code;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (m.driver.readTextSafe('convert-target-line')?.includes(name)) return;
    const chip = await m.driver.findByTestID(`convert-target-chip-${code}`, {timeoutMs: opts.timeoutMs ?? 5000}).catch(() => null);
    if (!chip) throw new Error(`pickSwapTarget: no chip for ${code} and the line does not name "${name}"`);
    await m.driver.click(`convert-target-chip-${code}`, opts);
    const landed = await m.driver.waitForFunction(
      () => (m.driver.readTextSafe('convert-target-line') ?? '').includes(name),
      {timeoutMs: opts.timeoutMs ?? 5000, label: `target line flips to ${code}`},
    ).catch(() => null);
    if (landed !== undefined) return;
  }
  throw new Error(`pickSwapTarget: the target line never flipped to "${name}" after 3 tries`);
}

export async function openOtherVenues(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (m.driver.isPresent('convert-venues-expanded')) return;
    await m.driver.click('btn-convert-venues-other', opts);
  }
  await m.driver.findByTestID('convert-venues-expanded', {timeoutMs: opts.timeoutMs ?? 2500});
}

export async function pickSwapVenue(m: Mount, rowId: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  if (!m.driver.isPresent(`convert-venue-${rowId}`)) {
    await openOtherVenues(m, opts);
  }
  await m.driver.click(`convert-venue-${rowId}`, opts);
}

export async function selectSolRail(m: Mount, key: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const CODE: Record<string, string> = {'sol-usdc': 'USD', 'sol-eurc': 'EUR'};
  const code = CODE[key];
  if (code == null) throw new Error(`selectSolRail: no currency for "${key}"`);
  const timeoutMs = opts.timeoutMs ?? 5000;
  await openBalances(m, {timeoutMs});
  await m.driver.click(`btn-accounts-currency-${code}`, {timeoutMs});
  await m.driver.findByTestID('home-headline-label', {timeoutMs});
  await m.driver.click('tab-receive', {timeoutMs});
  await m.driver.click('btn-receive-address', {timeoutMs});
  await m.driver.click('btn-receive-asset-switch', {timeoutMs});
  await m.driver.click(`req-pick-${key}`, {timeoutMs});
}

export async function selectEvmAsset(m: Mount, testKey: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  await openBalances(m, {timeoutMs});
  if (!m.driver.isPresent(`asset-${testKey}`)) {
    await m.driver.findByTestID('btn-toggle-testnet', {timeoutMs: 15_000});
    await m.driver.click('btn-toggle-testnet', {timeoutMs});
    await m.driver.findByTestID(`asset-${testKey}`, {timeoutMs});
  }
  await m.driver.click(`asset-${testKey}-select`, {timeoutMs});
  await m.driver.click('tab-pay', {timeoutMs});
  await m.driver.findByTestID('evm-pay-scan', {timeoutMs});
}

// --- pay-intent scan/NFC gates (the CHOKE POINTS, per lib.mjs) ----------------------------------

function scanCount(): number {
  const f = (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SCAN_COUNT as (() => number) | undefined;
  return typeof f === 'function' ? f() : -1;
}

/** Press whichever pay-intent gate button is on screen. Returns true when a press was issued. */
async function pressScanGate(m: Mount): Promise<boolean> {
  const gate = ['btn-start-scan', 'btn-sol-start-scan', 'btn-evm-start-scan'].find((t) => m.driver.isPresent(t));
  if (!gate) return false;
  try {
    await m.driver.click(gate, {timeoutMs: 2000});
    return true;
  } catch {
    return false; // unmounted mid-click — the caller's poll retries
  }
}

/** Ensure the payer scan surface is ARMED (camera listening). The choke point for every
 *  __DPAY_TEST_SCAN injection against the Pay tab. */
export async function armPayScan(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scanCount() > 0) return;
    await pressScanGate(m);
    await sleep(50);
  }
  assert(false, `pay scan surface never armed within ${timeoutMs}ms (listeners=0 throughout, no gate button pressed)`);
}

/** Ensure the payer-side NFC CARD is armed (rail 'ic' | 'sol'). */
export async function armNfcCard(m: Mount, rail: 'ic' | 'sol', opts: {timeoutMs?: number} = {}): Promise<void> {
  const seam = {ic: '__DPAY_TEST_NFC_COUNT', sol: '__DPAY_TEST_SOL_NFC_COUNT'}[rail];
  assert(seam, `armNfcCard: unknown rail ${String(rail)}`);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = (globalThis as unknown as Record<string, unknown>)[seam] as (() => number) | undefined;
    const n = typeof f === 'function' ? f() : -1;
    if (n > 0) return;
    await pressScanGate(m);
    await sleep(50);
  }
  assert(false, `${rail} NFC card never mounted within ${timeoutMs}ms (listeners=0 throughout; the pay-intent gate never armed it)`);
}

export async function assertScannerMounted(m: Mount, label = 'scan screen'): Promise<void> {
  await armPayScan(m);
  const count = scanCount();
  assert(count > 0, `QrScanner must be mounted on ${label} (listeners=${count}); the scanner component failed to render.`);
}

export async function waitForScanner(m: Mount, opts: {timeoutMs?: number} = {}): Promise<void> {
  await armPayScan(m, opts);
}

// --- relay retarget / offline -------------------------------------------------------------------

/** Open Settings, apply `url` as the relay, close. Re-points the fake-IC gateway seam too. */
export async function setRelay(m: Mount, url: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const t = opts.timeoutMs ?? 4000;
  await m.driver.click('btn-settings', {timeoutMs: t});
  await m.driver.click('btn-advanced-toggle', {timeoutMs: t});
  await m.driver.type('settings-relay', url, {timeoutMs: t});
  await m.driver.click('btn-relay-apply', {timeoutMs: t});
  await m.driver.click('btn-settings-close', {timeoutMs: t});
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY = url;
}

export async function goOffline(m: Mount, opts: {timeoutMs?: number; keepGateway?: boolean} = {}): Promise<{deadRelay: string; deadGateway: string}> {
  const deadRelay = await deadOrigin();
  m.driver.allowRequestFailuresFrom(deadRelay);
  const deadGateway = await deadOrigin();
  m.driver.allowRequestFailuresFrom(deadGateway);
  const keepGateway = opts.keepGateway === true;
  const prevGateway = keepGateway
    ? (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY as string | undefined
    : undefined;
  await setRelay(m, deadRelay, opts);
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY = keepGateway && prevGateway ? prevGateway : deadGateway;
  return {deadRelay, deadGateway};
}

/** Bind :0, close — a port nothing listens on (the REAL unreachable-relay failure mode). */
async function deadOrigin(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('node:net') as typeof import('node:net');
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as {port: number}).port;
      srv.close(() => resolve(p));
    });
  });
  return `http://127.0.0.1:${port}`;
}

// --- disabled-state probes ----------------------------------------------------------------------

export async function isDisabled(m: Mount, testID: string): Promise<boolean> {
  return m.driver.propOf(testID, 'aria-disabled') === true
    || m.driver.propOf(testID, 'disabled') === true;
}

export async function assertDisabled(m: Mount, testID: string, label: string): Promise<void> {
  if (!(await isDisabled(m, testID))) {
    throw new Error(`[assert] ${label}: element testID=${testID} should be disabled but is not`);
  }
}

// --- onboarding (the seeded single-boot fast path + the real create path) -----------------------

/** A fresh random keypair from the REAL wasm core (the same generateKeypair the app's create
 *  path calls — no JS re-implementation). */
export async function generateKeypair(): Promise<{secretHex: string; publicHex: string}> {
  return DpayCore.generateKeypair();
}

/** The pubkey's self-authenticating PRINCIPAL TEXT (what the fake-IC gateway keys balances on). */
export async function railPrincipalText(pubHex: string): Promise<string> {
  return DpayCore.icpPrincipalFromPubkey(pubHex);
}

function journeySeedJson(): string {
  const now = Date.now();
  return JSON.stringify({
    stamps: ['walkthroughDone', 'recoverySaved', 'flowUnderstood'],
    at: {walkthroughDone: now, recoverySaved: now, flowUnderstood: now},
    seen: ['firstRunPractice'],
  });
}

/**
 * Plant a fresh, FUNDED identity (real wasm keypair + the relay faucet) and bring the app up ONCE
 * over it — the seeded-identity fast path. Ends exactly where the slow path ends: home currency
 * answered, wallet shell mounted, DEMO selected, Pay scanner live, ∂100.00 visible.
 */
/**
 * Point the wallet's PERSISTED relay list (services/relayAddresses.ts, `dpay.relays.v1`) at ONE
 * address — or restore the baked default with null. This is the jest retarget surface: the e2e
 * twins pass `?relay=` through a vite alias of relayConfig.ts (e2e/web/relay-config.ts), which
 * the jest module graph never loads; App.tsx's boot effect wires the walk + the SOL/EVM
 * derivations from the persisted list IN THE SAME TICK, so a list planted before the mount is
 * the app's entire relay world. Pair it with the per-call `__DPAY_TEST_IC_GATEWAY` seam for the
 * /api/v2 envelope transport. Plant AFTER the lifecycle's storage purge, BEFORE the mount.
 */
export async function pointRelayListAt(baseURL: string | null): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {
    setItem: (k: string, v: string) => Promise<void>;
    removeItem: (k: string) => Promise<void>;
  };
  if (baseURL == null) await AsyncStorage.removeItem(RELAY_LIST_STORAGE_KEY);
  else await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify([baseURL]));
}

export async function onboardWallet(name = 'e2e', opts: {timeoutMs?: number; fund?: boolean; slow?: boolean; url?: string; relayBase?: string} = {}): Promise<Mount> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const kp = await DpayCore.generateKeypair();
  if (opts.fund !== false) {
    const fund = await faucetAccount(kp.publicHex, undefined, {baseURL: opts.relayBase});
    assert(fund.ok, `onboardWallet: the faucet POST failed (status ${fund.status}): ${JSON.stringify(fund.body).slice(0, 200)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {
    setItem: (k: string, v: string) => Promise<void>;
  };
  await AsyncStorage.setItem('dpay.identity.v1', JSON.stringify({
    secretHex: kp.secretHex, publicHex: kp.publicHex, username: name,
  }));
  await AsyncStorage.setItem('dpay.journey.v1', journeySeedJson());
  // opts.url seeds the location stub BEFORE the mount — the `?relay=` cold-load surface (the
  // e2e twins' navigate). mountApp installs it prior to the first App render.
  const m = await mountApp({url: opts.url});
  await chooseHomeCurrencyIfPresent(m);
  await m.driver.findByTestID(WALLET_READY, {timeoutMs: 10_000});
  await selectDemoAsset(m);
  // The balance figure lives on the accounts route (the pay scanner carries no balance text):
  // prove the funding there, then return to the scanner — the suite's shared assumption.
  await openBalances(m);
  assert(await m.driver.waitForText('∂100.00', {timeoutMs}), 'wallet balance should read ∂100.00 (faucet-funded)');
  await m.driver.click('tab-pay', {timeoutMs: 5000});
  await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});
  return m;
}

/** The seeded fast path WITHOUT the funded-DEMO contract: seed + single boot + home currency. */
export async function onboardSeededUnfunded(name = 'e2e', opts: {timeoutMs?: number; fund?: boolean; url?: string; relayBase?: string} = {}): Promise<Mount> {
  const kp = await DpayCore.generateKeypair();
  if (opts.fund !== false) {
    await faucetAccount(kp.publicHex, undefined, {baseURL: opts.relayBase});
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AsyncStorage = require('@react-native-async-storage/async-storage') as {setItem: (k: string, v: string) => Promise<void>};
  await AsyncStorage.setItem('dpay.identity.v1', JSON.stringify({
    secretHex: kp.secretHex, publicHex: kp.publicHex, username: name,
  }));
  await AsyncStorage.setItem('dpay.journey.v1', journeySeedJson());
  // opts.url: the `?relay=` cold-load surface (see onboardWallet).
  const m = await mountApp({url: opts.url});
  await chooseHomeCurrencyIfPresent(m);
  await m.driver.findByTestID(WALLET_READY, {timeoutMs: 10_000});
  return m;
}

/** The SLOW onboarding path (the real create flow) — flow 01's subject, never a preamble. */
export async function onboardSlowPath(m: Mount, name: string, opts: {timeoutMs?: number} = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  await skipWalkthroughIfPresent(m);
  await m.driver.typeByPlaceholder('e.g. Alice', name, {timeoutMs: 8000});
  await m.driver.click('btn-create', {timeoutMs: 4000});
  await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
  await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
  await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
  await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
  await skipPracticeIfPresent(m, {timeoutMs});
  await chooseHomeCurrencyIfPresent(m);
  await m.driver.findByTestID(WALLET_READY, {timeoutMs: 10_000});
}

