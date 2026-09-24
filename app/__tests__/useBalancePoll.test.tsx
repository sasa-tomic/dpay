/**
 * useBalancePoll — the ONE rule the money path leans on: **an UNKNOWN balance is not a zero
 * balance.**
 *
 * Every affordability gate in the wallet reads this hook's output, and the hard refusals
 * ("Not enough balance to cover this payment.", no sign control at all) are computed from it. So
 * the hook's contract is not a display detail: if it ever answered `'0'` where it means "the relay
 * did not tell me", a payer holding the money would be refused at a checkout. The relay is honest here
 * by construction — `balances` in `crates/dpay-relay/src/app.rs` OMITS a currency whose ledger
 * query errored or timed out rather than reporting zero — and these tests pin the app half of that
 * contract:
 *
 *   - an omitted currency keeps its PRIOR value (no flap, and never a zero);
 *   - a currency never answered for has NO ENTRY, so a consumer's `?? null` reads "unknown";
 *   - ONE missed poll is a blip, not an outage (F4, 2026-09-20): `online` holds; going
 *     offline takes BALANCE_OFFLINE_AFTER_FAILURES CONSECUTIVE failures — and no failure
 *     ever touches a balance (stale, not zero).
 *
 * Plus the 2026-09-15 offline-payments contract: the poll STAMPS a per-currency freshness clock
 * (`atByCurrency` — the one clock the pending-outbox subtraction and the 60 s approx marker read)
 * and PERSISTS the last good read per identity (`dpay.balances.v1.<publicHex>` — founder
 * requirement #3: funded at home, walked offline, restarted in the city ⇒ real numbers still
 * render and the fund gate still passes). The old ephemeral offlineSpent reducer is gone; its
 * arithmetic lives in Wallet's pending-record derivation now.
 *
 * The hook is driven through a probe component (react-test-renderer is this project's only
 * renderer); `relayFetch` is mocked at its module boundary — nothing else is.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/relay', () => ({
  relayFetch: jest.fn(), // R1: the hook's relay seam moved from fetchWithTimeout(url) to relayFetch(relay, path)
}));

import {relayFetch} from '../services/relay';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {POLL, BALANCE_OFFLINE_AFTER_FAILURES} from '../config/constants';

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
  jest.mocked(relayFetch).mockReset();
  // The balance cache is per-identity persisted state — tests must not see each other's writes.
  return AsyncStorage.clear();
});

afterEach(() => { jest.useRealTimers(); });

describe('useBalancePoll — an unknown balance is never reported as zero', () => {
  test('a currency the relay OMITS keeps its prior value; it is never written as 0', async () => {
    jest.mocked(relayFetch)
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
    jest.mocked(relayFetch).mockResolvedValue(answer({'0': '10000'}) as never);
    const {latest, tree} = await mountPoll();
    // `undefined`, so `assetBalances[c] ?? null` at the affordability gate is null and fails OPEN.
    expect(latest().assetBalances[VCHF]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(latest().assetBalances, VCHF)).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('ONE missed poll is a blip — online holds and the mid-flow form survives (F4)', async () => {
    jest.mocked(relayFetch)
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never)
      // The next batch answers VCHF but NOT the primary: a primary-ledger hiccup.
      .mockResolvedValueOnce(answer({[String(VCHF)]: '500000000'}) as never)
      .mockResolvedValueOnce(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never);

    const {latest, tree} = await mountPoll();
    expect(latest().online).toBe(true);

    await nextPoll();
    // One failure is not a reachability fact: the dot does NOT flip, the send form stays up,
    // and the balance is stale-but-known, never zero.
    expect(latest().online).toBe(true);
    expect(latest().balance).toBe('10000');

    await nextPoll();
    // Recovery was instant before and stays instant — one success resets the streak.
    expect(latest().online).toBe(true);
    expect(latest().balance).toBe('10000');
    act(() => { tree.unmount(); });
  });

  test(`offline takes BALANCE_OFFLINE_AFTER_FAILURES (${BALANCE_OFFLINE_AFTER_FAILURES}) CONSECUTIVE failures, any class`, async () => {
    const N = BALANCE_OFFLINE_AFTER_FAILURES;
    const ok = () => answer({'0': '10000', [String(VCHF)]: '500000000'});
    const mock = jest.mocked(relayFetch)
      .mockResolvedValueOnce(ok() as never); // the mount's own poll
    for (let i = 0; i < N - 1; i++) mock.mockResolvedValueOnce(refuse(503, '{"error":"ledger"}') as never);
    mock.mockResolvedValueOnce(ok() as never); // one success splits the streak
    for (let i = 0; i < N - 1; i++) mock.mockResolvedValueOnce(refuse(503, '{"error":"ledger"}') as never);
    mock.mockRejectedValueOnce(new Error('ECONNREFUSED') as never); // the Nth miss: a transport failure — the class does not matter

    const {latest, tree} = await mountPoll();
    expect(latest().online).toBe(true);

    // N-1 consecutive failures: still online — the old rule would have flipped here already.
    for (let i = 0; i < N - 1; i++) { await nextPoll(); expect(latest().online).toBe(true); }

    // A single success resets the count: the next N-1 misses STILL do not flip it.
    await nextPoll();
    expect(latest().online).toBe(true);
    for (let i = 0; i < N - 1; i++) { await nextPoll(); expect(latest().online).toBe(true); }

    // The Nth CONSECUTIVE failure: only now is offline the honest reading.
    await nextPoll();
    expect(latest().online).toBe(false);
    // And a failure never wrote a balance, in any class.
    expect(latest().balance).toBe('10000');
    expect(latest().assetBalances[VCHF]).toBe('500000000');
    act(() => { tree.unmount(); });
  });
});

describe('useBalancePoll — the 2026-09-15 offline contract: a freshness clock and a persisted restart', () => {
  const CACHE_KEY = `dpay.balances.v1.${'aa'.repeat(32)}`;

  test('a successful batch stamps every currency it answered for, key 0 included', async () => {
    jest.mocked(relayFetch).mockResolvedValue(answer({'0': '10000', [String(VCHF)]: '500000000', [String(CKBTC)]: '7'}) as never);
    const {latest, tree} = await mountPoll();

    const firstStamp = latest().atByCurrency[0];
    // Key 0 and BOTH answered display currencies carry a wall-clock stamp — the pending-outbox
    // subtraction (`rec.ts > clock`) and the 60 s approx marker both read exactly this.
    expect(firstStamp).toBeGreaterThan(0);
    expect(latest().atByCurrency[VCHF]).toBe(firstStamp);
    expect(latest().atByCurrency[CKBTC]).toBe(firstStamp);

    await nextPoll();
    // The clock only moves FORWARD — a stalled ledger read must not resurrect a retired deduction.
    expect(latest().atByCurrency[0]).toBeGreaterThanOrEqual(firstStamp);
    act(() => { tree.unmount(); });
  });

  test('the last good read is persisted under the identity — founder requirement #3', async () => {
    jest.mocked(relayFetch).mockResolvedValue(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never);
    const {tree} = await mountPoll();

    const raw = await AsyncStorage.getItem(CACHE_KEY);
    expect(raw).not.toBeNull();
    const cached = JSON.parse(raw as string) as {at: number; balance: string | null; assetBalances: Record<string, string>};
    expect(cached.balance).toBe('10000');
    expect(cached.assetBalances['0']).toBe('10000');
    expect(cached.assetBalances[String(VCHF)]).toBe('500000000');
    expect(cached.at).toBeGreaterThan(0);
    act(() => { tree.unmount(); });
  });

  test('a cold OFFLINE start hydrates from the cache — funded at home, restarted in the city', async () => {
    const AT = 1234567; // any wall-clock moment strictly in the past
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({at: AT, balance: '777', assetBalances: {7: '7777'}}));
    jest.mocked(relayFetch).mockRejectedValue(new Error('ECONNREFUSED') as never);

    const {latest, tree} = await mountPoll();
    // The poll never answers, yet the wallet renders the REAL numbers (never '—', never zero):
    // the fund gate passes offline and the balances render approx-marked via the seeded clock.
    expect(latest().balance).toBe('777');
    expect(latest().assetBalances[VCHF]).toBe('7777');
    expect(latest().atByCurrency[VCHF]).toBe(AT);
    expect(latest().online).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a cache older than this mount\'s own live read never overrides it', async () => {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({at: 1, balance: '1', assetBalances: {}}));
    jest.mocked(relayFetch).mockResolvedValue(answer({'0': '10000', [String(VCHF)]: '500000000'}) as never);

    const {latest, tree} = await mountPoll();
    // The live poll landed first; a strictly-older cache (the identity-switch race) is noise.
    expect(latest().balance).toBe('10000');
    expect(latest().assetBalances[VCHF]).toBe('500000000');
    act(() => { tree.unmount(); });
  });

  test('the faucet\'s setBalance wrapper stamps key 0 and persists the new read', async () => {
    jest.mocked(relayFetch).mockResolvedValue(answer({'0': '10000'}) as never);
    const {latest, tree} = await mountPoll();
    const before = latest().atByCurrency[0];

    act(() => { latest().setBalance('55000'); });
    expect(latest().balance).toBe('55000');
    expect(latest().atByCurrency[0]).toBeGreaterThanOrEqual(before);

    const raw = await AsyncStorage.getItem(CACHE_KEY);
    expect(raw).not.toBeNull();
    expect((JSON.parse(raw as string) as {balance: string | null}).balance).toBe('55000');
    act(() => { tree.unmount(); });
  });
});
