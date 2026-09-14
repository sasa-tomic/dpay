/**
 * The receive-address screen re-opens the fast poll window while it is up (M3).
 *
 * WHAT THIS PROTECTS. The SOL rail's balance poll idles at `POLL.balanceIdle` (30s in a shipped
 * build) and runs at the active 2.5s cadence only inside a window that a money flow opens
 * (`usePollCadence`). That is right for a phone in a pocket — an idle wallet reading a paid
 * endpoint 128 times a minute is what emptied a month of quota in five days
 * (`docs/specs/2026-09-08-solana-rpc-plan.md`) — and wrong for the ONE screen whose entire purpose
 * is showing a deposit arrive, where it means the user watches a stale number for up to half a
 * minute after the money has landed.
 *
 * THE CONTRACT: while the sub-mode is `address`, the refresh callback fires on mount and once per
 * `SOL_ACTIVE_POLL_WINDOW_MS` — each call being the same `bump` a confirmed send fires, so the fast
 * cadence stays open for exactly as long as the screen does. On the `request` sub-mode nothing
 * fires, and leaving the screen stops it: a receive screen must not leave a rail polling fast
 * forever.
 *
 * ONE callback per tick, not two: `useSolanaBalances` answers for every rail in a single request,
 * so `onRefreshSol` and `onRefreshToken` are the same poll — firing both would double the request
 * rate to buy nothing, which is the exact failure this cadence work exists to undo.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SolReceiveMode} from '../components/SolReceiveMode';
import {SOL_ACTIVE_POLL_WINDOW_MS} from '../config/constants';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

jest.mock('../services/native', () => ({
  DpaySolNfc: {
    addListener: () => ({remove: () => {}}),
    removeListeners: () => {},
    armCard: jest.fn(async () => {}),
    disarmCard: jest.fn(async () => {}),
    startSolReader: jest.fn(async () => {}),
    stopSolReader: jest.fn(async () => {}),
    confirmSolReceipt: jest.fn(async () => {}),
  },
}));

// The merchant-state reconciliation effect runs on mount; a clean store keeps this suite on the
// address surface instead of restoring somebody else's open request.
jest.mock('../services/solMerchantPersist', () => ({
  loadSolMerchantState: jest.fn(async () => null),
  saveSolMerchantState: jest.fn(async () => {}),
  clearSolMerchantState: jest.fn(async () => {}),
}));

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const IDENTITY = {secretHex: '9f'.repeat(32), publicHex: '11'.repeat(32), username: 'test'};
const SOL_ADDRESS = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

let tree: renderer.ReactTestRenderer | null = null;

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  if (tree) { const t = tree; tree = null; act(() => { t.unmount(); }); }
  jest.useRealTimers();
  jest.clearAllMocks();
});

function solReceiveProps(over: {subMode?: 'request' | 'address'; selectedToken?: string; onRefreshSol?: () => void; onRefreshToken?: () => void; codeForm?: 'dpay' | 'till'; tillAvailable?: boolean} = {}): Parameters<typeof SolReceiveMode>[0] {
  return {
    identity: IDENTITY,
    relayUrl: 'http://relay.test',
    nfcStatus: 'unsupported',
    solAddress: SOL_ADDRESS,
    subMode: over.subMode ?? 'address',
    onSubModeChange: jest.fn(),
    codeForm: over.codeForm ?? 'dpay',
    onCodeFormChange: jest.fn(),
    tillAvailable: over.tillAvailable ?? false,
    catalog: CATALOG,
    selectedToken: over.selectedToken ?? 'SOL',
    assets: ASSETS,
    selectedAssetId: 'solana:SOL' as AssetId,
    balances: {} as Record<AssetId, BalanceView>,
    onSelectAsset: jest.fn(),
    onRefreshSol: over.onRefreshSol,
    onRefreshToken: over.onRefreshToken,
  };
}

function mount(over: Parameters<typeof solReceiveProps>[0] = {}) {
  act(() => {
    tree = renderer.create(
      <SolReceiveMode {...solReceiveProps(over)} />,
    );
  });
  return tree!;
}

describe('SolReceiveMode — the address screen keeps the rail on its fast cadence', () => {
  test('reads immediately on arrival, then once per active window, for as long as it is shown', () => {
    const refreshSol = jest.fn();
    mount({subMode: 'address', onRefreshSol: refreshSol});
    expect(refreshSol).toHaveBeenCalledTimes(1); // the arrival read — not a 30s wait
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS - 1); });
    expect(refreshSol).toHaveBeenCalledTimes(1); // the bump already holds the fast cadence here
    act(() => { jest.advanceTimersByTime(1); });
    expect(refreshSol).toHaveBeenCalledTimes(2); // re-armed exactly one window later
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS * 3); });
    expect(refreshSol).toHaveBeenCalledTimes(5);
  });

  test('an SPL address refreshes the TOKEN side, and only that one — one poll answers for all rails', () => {
    const refreshSol = jest.fn();
    const refreshToken = jest.fn();
    mount({subMode: 'address', selectedToken: 'USDC', onRefreshSol: refreshSol, onRefreshToken: refreshToken});
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS); });
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(refreshSol).not.toHaveBeenCalled();
  });

  test('the REQUEST sub-mode polls nothing — a merchant showing a charge is not watching a deposit', () => {
    const refreshSol = jest.fn();
    mount({subMode: 'request', onRefreshSol: refreshSol});
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS * 4); });
    expect(refreshSol).not.toHaveBeenCalled();
  });

  test('leaving the screen stops it — no rail is left polling fast behind an unmounted surface', () => {
    const refreshSol = jest.fn();
    const t = mount({subMode: 'address', onRefreshSol: refreshSol});
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS); });
    expect(refreshSol).toHaveBeenCalledTimes(2);
    tree = null;
    act(() => { t.unmount(); });
    act(() => { jest.advanceTimersByTime(SOL_ACTIVE_POLL_WINDOW_MS * 5); });
    expect(refreshSol).toHaveBeenCalledTimes(2);
  });
});

// --- ONE message box, both code forms (founder 2026-09-14) ----------------------------------------
// The same truth `ReceiveMode.test.tsx` pins on the IC rail, stated on this rail too because the
// same-surfaces hard rule cuts both ways: if the SOL form were allowed to move or reset the
// message box on the till-checkbox toggle, the two Receive forms would disagree about one box.
// The rail cannot ring up a charge (the checkbox leads to the honest refusal), so what is pinned
// here is the BOX — mounted, positioned, text-preserving — not the counter. e2e flow 115 drives
// the same toggle through the real app on this rail.
describe('SolReceiveMode — the message box is one box, whatever the code form', () => {
  const NOTE = '2x Kafi, Tisch 4';
  const TILL_ON = {subMode: 'request' as const, codeForm: 'till' as const, tillAvailable: true};
  const TILL_OFF = {subMode: 'request' as const, codeForm: 'dpay' as const, tillAvailable: true};

  function memoBox(t: renderer.ReactTestRenderer) {
    return t.root.findAll(n => n.props && n.props.testID === 'sol-req-memo-input')[0];
  }

  test('the same input stays mounted with the checkbox checked, and its text survives the toggle both ways', () => {
    const t = mount(TILL_OFF);
    expect(memoBox(t)).toBeDefined();                       // the dpay form's box
    act(() => { memoBox(t).props.onChangeText(NOTE); });

    // Checked: the SAME box keeps its place and its text — no till-owned twin input appears (on
    // this rail the till branch is the honest refusal, and the box is still the form's own). NB:
    // RN mirrors a `testID` across several host nodes (every Pressable in this tree matches 3×),
    // so "one box" is asserted by presence + the twin id's ABSENCE, not by match count.
    act(() => { t.update(<SolReceiveMode {...solReceiveProps(TILL_ON)} />); });
    expect(memoBox(t)).toBeDefined();
    expect(memoBox(t).props.value).toBe(NOTE);
    expect(t.root.findAll(n => n.props && n.props.testID === 'till-note-input')).toHaveLength(0);
    expect(t.root.findAll(n => n.props && n.props.testID === 'till-refused').length).toBeGreaterThan(0);

    // Unchecked again: the dpay SOL request form, text intact — the other direction.
    act(() => { t.update(<SolReceiveMode {...solReceiveProps(TILL_OFF)} />); });
    expect(memoBox(t).props.value).toBe(NOTE);
  });
});
