/**
 * useBalancePoll — the ONE rule the money path leans on: **an UNKNOWN balance is not a zero
 * balance.**
 *
 * Every affordability gate in the wallet reads this hook's output, and the hard refusals
 * ("Not enough balance to cover this payment.", no sign control at all) are computed from it. So
 * the hook's contract is not a display detail: if it ever answered `'0'` where it means "the relay
 * did not tell me", a payer holding the money would be refused at a till. The relay is honest here
 * by construction — `balances` in `crates/dpay-relay/src/app.rs` OMITS a currency whose ledger
 * query errored or timed out rather than reporting zero — and these tests pin the app half of that
 * contract:
 *
 *   - an omitted currency keeps its PRIOR value (no flap, and never a zero);
 *   - a currency never answered for has NO ENTRY, so a consumer's `?? null` reads "unknown";
 *   - a batch with no primary flips `online` false and LEAVES the last known balance alone;
 *   - a non-2xx does the same, and writes nothing.
 *
 * Plus the offline-deduction reducer's own arithmetic, which is currency-keyed and clamped.
 *
 * The hook is driven through a probe component (react-test-renderer is this project's only
 * renderer); `fetchWithTimeout` is mocked at its module boundary — nothing else is.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(),
}));

import {fetchWithTimeout} from '../services/relay';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {POLL} from '../config/constants';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const DISPLAY_ASSETS = CATALOG.filter(c => c.currency !== 0);
const DISPLAY_IDS = DISPLAY_ASSETS.map(a => a.currency).join(',');
// Two real non-primary currencies to play the "answered" and "omitted" halves.
const VCHF = 7;
const CKBTC = 1;

type Poll = ReturnType<typeof useBalancePoll>;

/** The batch response shape the relay serves: a flat `{currency: minor-units-string}` map. */
function answer(map: Record<string, string>) {
  return {ok: true, json: async () => map, text: async () => JSON.stringify(map)};
}
function refuse(status: number, body: string) {
  return {ok: false, status, json: async () => null, text: async () => body};
}

/** Mount the hook and return a live handle on its latest return value. */
async function mountPoll(): Promise<{latest: () => Poll; tree: renderer.ReactTestRenderer}> {
  let latest: Poll | null = null;
  function Probe() {
    latest = useBalancePoll({
      relayUrl: 'http://relay.test',
      publicHex: 'aa'.repeat(32),
      displayAssets: DISPLAY_ASSETS,
      displayCurrencyIds: DISPLAY_IDS,
    });
    return <Text>{''}</Text>;
  }
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(<Probe />); });
  await act(async () => {}); // flush the first poll's promise chain
  return {latest: () => latest as Poll, tree};
}

/** Let the interval fire once more and settle. */
async function nextPoll() {
  await act(async () => { jest.advanceTimersByTime(POLL.balance); });
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers({doNotFake: ['Date']});
  jest.mocked(fetchWithTimeout).mockReset();
});

afterEach(() => { jest.useRealTimers(); });

describe('useBalancePoll — an unknown balance is never reported as zero', () => {
  test('a currency the relay OMITS keeps its prior value; it is never written as 0', async () => {
    jest.mocked(fetchWithTimeout)
      // Everything answers.
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000', [String(CKBTC)]: '7'}) as never)
      // VCHF's ledger hiccups — the relay omits it (see the route's own doc comment).
      .mockResolvedValueOnce(answer({'0': '10000', [String(CKBTC)]: '7'}) as never);

    const {latest, tree} = await mountPoll();
    expect(latest().assetBalances[VCHF]).toBe('500000000');

    await nextPoll();
    // The prior value survives. A '0' here would refuse a payment the wallet can make.
    expect(latest().assetBalances[VCHF]).toBe('500000000');
    // …and the omission does not disturb the currencies that DID answer, nor the primary.
    expect(latest().assetBalances[CKBTC]).toBe('7');
    expect(latest().balance).toBe('10000');
    expect(latest().online).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a currency never answered for has NO ENTRY — the consumer reads "unknown", not "zero"', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValue(answer({'0': '10000'}) as never);
    const {latest, tree} = await mountPoll();
    // `undefined`, so `assetBalances[c] ?? null` at the affordability gate is null and fails OPEN.
    expect(latest().assetBalances[VCHF]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(latest().assetBalances, VCHF)).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a batch with no primary goes offline and leaves the last known balance alone', async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never)
      .mockResolvedValueOnce(answer({[String(VCHF)]: '500000000'}) as never);

    const {latest, tree} = await mountPoll();
    expect(latest().online).toBe(true);

    await nextPoll();
    // Offline is the honest state; the balance is stale, not zero — and the gate only HARD-blocks
    // while online, so a stale reading degrades to the warning rather than a refusal.
    expect(latest().online).toBe(false);
    expect(latest().balance).toBe('10000');
    act(() => { tree.unmount(); });
  });

  test('a non-2xx goes offline and writes no balance at all', async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never)
      .mockResolvedValueOnce(refuse(503, '{"error":"ledger unreachable"}') as never);

    const {latest, tree} = await mountPoll();
    await nextPoll();
    expect(latest().online).toBe(false);
    expect(latest().balance).toBe('10000');
    expect(latest().assetBalances[VCHF]).toBe('500000000');
    act(() => { tree.unmount(); });
  });

  test('a transport failure goes offline without touching a single balance', async () => {
    jest.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never)
      .mockRejectedValueOnce(new Error('ECONNREFUSED') as never);

    const {latest, tree} = await mountPoll();
    await nextPoll();
    expect(latest().online).toBe(false);
    expect(latest().balance).toBe('10000');
    expect(latest().assetBalances[VCHF]).toBe('500000000');
    act(() => { tree.unmount(); });
  });
});

describe('useBalancePoll — the offline deduction is currency-keyed and clamped', () => {
  test('a spend on one asset never touches another, and a refund cannot go negative', async () => {
    jest.mocked(fetchWithTimeout).mockResolvedValue(answer({'0': '10000'}) as never);
    const {latest, tree} = await mountPoll();

    act(() => { latest().markOfflinePaid('2500', 0); });
    expect(latest().offlineSpent[0]).toBe('2500');
    expect(latest().offlineSpent[VCHF]).toBeUndefined();

    // A second hand-off on the SAME asset sums; the other asset stays untouched.
    act(() => { latest().markOfflinePaid('500', 0); });
    act(() => { latest().markOfflinePaid('100000000', VCHF); });
    expect(latest().offlineSpent[0]).toBe('3000');
    expect(latest().offlineSpent[VCHF]).toBe('100000000');

    // The refund path (a signed-but-failed NFC hand-off) undoes a deduction, and over-refunding
    // floors at zero rather than rendering a negative raw amount.
    act(() => { latest().markOfflinePaid('-99999999999', VCHF); });
    expect(latest().offlineSpent[VCHF]).toBe('0');

    act(() => { latest().resetDeduction(0); });
    expect(latest().offlineSpent[0]).toBe('0');
    act(() => { tree.unmount(); });
  });
});
