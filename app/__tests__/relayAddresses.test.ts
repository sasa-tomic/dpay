/**
 * `services/relayAddresses.ts` — R1's ordered-list module (spec 2026-09-09 §"Direction 2").
 *
 * The walk itself (`relayFetch`) is pinned in `relayFailover.test.ts`; this suite owns everything
 * AROUND the walk:
 *   • parsing/validation — the Settings textarea (one address per line) and the `?relay=` deep
 *     link (comma-separated) both normalize through ONE rule, and a bad line is refused BY LINE
 *     NUMBER (the user's only map into their own textarea);
 *   • the module state — `setRelayAddresses` never stores a partial list, and the revision counter
 *     only moves on accepted sets (the walk clears its caches on a change);
 *   • persistence — the `dpay.relays.v1` JSON array, and THE MIGRATION: a pre-R1 wallet's single
 *     `dpay.relay.v1` string loads as a one-entry list, so an upgrading operator keeps their relay.
 *     A corrupt store is discarded whole ("no persisted choice" → the baked default), never
 *     half-applied.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadPersistedRelayAddresses,
  parseRelayAddress,
  parseRelayListText,
  persistRelayAddresses,
  relayAddresses,
  relayAddressesRevision,
  resetRelayAddressesForTest,
  setRelayAddresses,
  splitRelayListParam,
} from '../services/relayAddresses';
import {RELAY_LIST_STORAGE_KEY, RELAY_STORAGE_KEY} from '../config/constants';

afterEach(async () => {
  resetRelayAddressesForTest();
  await AsyncStorage.clear();
});

describe('parseRelayAddress — one validation rule for both entry formats', () => {
  test('accepts http and https, strips trailing slashes, keeps path prefixes and ports', () => {
    expect(parseRelayAddress('https://relay.example.com')).toBe('https://relay.example.com');
    expect(parseRelayAddress('https://relay.example.com/')).toBe('https://relay.example.com');
    expect(parseRelayAddress('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(parseRelayAddress('  http://lan-relay.local:8787/dpay/  ')).toBe('http://lan-relay.local:8787/dpay');
  });
  test('refuses scheme-less, wrong-scheme and junk — the placeholder is http://<ip>:8787, so plain http MUST stay valid', () => {
    expect(parseRelayAddress('relay.example.com')).toBeNull();
    expect(parseRelayAddress('ftp://relay.example.com')).toBeNull();
    expect(parseRelayAddress('not a url')).toBeNull();
    expect(parseRelayAddress('')).toBeNull();
    expect(parseRelayAddress('   ')).toBeNull();
  });
  test('refuses a query string, fragment, or userinfo — none can compose an API path honestly', () => {
    // The walk composes `${addr}${path}`: a query/fragment rides along and 404s every request, and
    // a 404 is an answer (never a failover), so the whole list would be quietly dead; userinfo
    // would be persisted in plaintext and sent as basic auth on every call.
    expect(parseRelayAddress('https://relay.example.com/prefix?x=1')).toBeNull();
    expect(parseRelayAddress('https://relay.example.com/#frag')).toBeNull();
    expect(parseRelayAddress('https://user:pass@relay.example.com')).toBeNull();
    expect(parseRelayAddress('http://user@127.0.0.1:8787')).toBeNull();
  });
  test('strips EMPTY trailing ?/# markers — the parsed search/hash read empty, but URL serialization keeps the danglers', () => {
    // `new URL('…/#').hash` is '' yet `.toString()` KEEPS the `#`: without the strip the accepted
    // address composes `…/#/api/v1/…`, the fragment eats the path, and every request 404s (an
    // answer — never a failover). Pinned as EQUALITY against the clean form so the asserts survive
    // unrelated normalization changes.
    const clean = parseRelayAddress('https://relay.example.com');
    expect(clean).toBe('https://relay.example.com'); // anchor: the equality pins are not vacuous
    expect(parseRelayAddress('https://relay.example.com/#')).toBe(clean);
    expect(parseRelayAddress('https://relay.example.com/?')).toBe(clean);
    expect(parseRelayAddress('https://relay.example.com/?#')).toBe(clean); // mixed trailing run
  });
});

describe('parseRelayListText — the Settings textarea', () => {
  test('one address per line, first line = preferred; blank lines are skipped', () => {
    expect(parseRelayListText('https://one.example\n\nhttp://two.example:8787\n')).toEqual({
      urls: ['https://one.example', 'http://two.example:8787'],
    });
  });
  test('empty is a VALUE ([]) — it restores the addresses baked into the build, like the Solana row', () => {
    expect(parseRelayListText('')).toEqual({urls: []});
    expect(parseRelayListText('  \n  \n')).toEqual({urls: []});
  });
  test('a bad line is refused by LINE NUMBER, quoting what was on it', () => {
    const out = parseRelayListText('https://one.example\nnope\nhttps://three.example');
    expect('err' in out).toBe(true);
    if (!('err' in out)) return;
    expect(out.err).toContain('Line 2');
    expect(out.err).toContain('nope');
  });
});

describe('splitRelayListParam — the ?relay= deep-link format', () => {
  test('one address stays one entry; several split on commas in priority order', () => {
    expect(splitRelayListParam('http://127.0.0.1:8787')).toEqual(['http://127.0.0.1:8787']);
    expect(splitRelayListParam(' http://a.example , http://b.example ')).toEqual(['http://a.example', 'http://b.example']);
  });
  test('entries are kept VERBATIM apart from trimming — the harness controls this input', () => {
    // A trailing slash survives here (it did before R1 too); the walk normalizes at fetch time.
    expect(splitRelayListParam('http://a.example/,,http://b.example')).toEqual(['http://a.example/', 'http://b.example']);
  });
});

describe('the live module state', () => {
  test('stores the normalized list; the revision moves on every accepted set', () => {
    const before = relayAddressesRevision();
    setRelayAddresses(['https://a.example/', 'http://b.example']);
    expect(relayAddresses()).toEqual(['https://a.example', 'http://b.example']);
    expect(relayAddressesRevision()).toBe(before + 1);
  });
  test('an invalid entry throws and NEVER stores a partial list', () => {
    setRelayAddresses(['https://kept.example']);
    const before = relayAddressesRevision();
    expect(() => setRelayAddresses(['https://b.example', 'garbage'])).toThrow('garbage');
    expect(relayAddresses()).toEqual(['https://kept.example']);
    expect(relayAddressesRevision()).toBe(before); // refused sets do not count as re-points
  });
});

describe('persistence + the legacy migration', () => {
  test('nothing stored → [] (the caller falls back to the addresses baked into the build)', async () => {
    expect(await loadPersistedRelayAddresses()).toEqual([]);
  });
  test('THE MIGRATION: a pre-R1 dpay.relay.v1 single string loads as a one-entry list', async () => {
    await AsyncStorage.setItem(RELAY_STORAGE_KEY, 'https://old-relay.example');
    expect(await loadPersistedRelayAddresses()).toEqual(['https://old-relay.example']);
  });
  test('the legacy value normalizes like any other entry', async () => {
    await AsyncStorage.setItem(RELAY_STORAGE_KEY, 'https://old-relay.example/');
    expect(await loadPersistedRelayAddresses()).toEqual(['https://old-relay.example']);
  });
  test('the new array key WINS over the legacy string (nothing writes the legacy key anymore)', async () => {
    await AsyncStorage.setItem(RELAY_STORAGE_KEY, 'https://old-relay.example');
    await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify(['https://new-a.example', 'http://new-b.example']));
    expect(await loadPersistedRelayAddresses()).toEqual(['https://new-a.example', 'http://new-b.example']);
  });
  test('a corrupt store is discarded WHOLE — "no persisted choice", never half the junk', async () => {
    await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, '{not json');
    expect(await loadPersistedRelayAddresses()).toEqual([]);
    await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify(['https://ok.example', 'not-a-url']));
    expect(await loadPersistedRelayAddresses()).toEqual([]);
    await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify({urls: ['https://shape.example']}));
    expect(await loadPersistedRelayAddresses()).toEqual([]);
  });
  test('a persisted EMPTY list is the deliberate-empty case — restored SILENTLY, not warned about as corruption (M7)', async () => {
    // An operator who cleared the list chose "restore what the build baked"; a "not a valid
    // address list" warn for their own recorded choice is a false corruption alarm.
    await AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify([]));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await loadPersistedRelayAddresses()).toEqual([]); // the deliberate empty loads
    } finally {
      log.mockRestore();
    }
    expect(log).not.toHaveBeenCalled(); // no corruption warn — empty is valid
  });
  test('persistRelayAddresses round-trips through the real key', async () => {
    await persistRelayAddresses(['https://a.example', 'http://b.example']);
    expect(await AsyncStorage.getItem(RELAY_LIST_STORAGE_KEY)).toBe(JSON.stringify(['https://a.example', 'http://b.example']));
  });
});
