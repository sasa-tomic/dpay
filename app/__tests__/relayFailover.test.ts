/**
 * `relayFetch` — R1's ordered multi-address walk (spec 2026-09-09 §"Direction 2 — several relays").
 *
 * The rules under test are the spec's, verbatim:
 *   • try the addresses in order (first = preferred); a transport failure OR an HTTP >= 500 moves
 *     to the next address;
 *   • a 4xx is an ANSWER — the relay heard us and refused; asking a replica would be asking a
 *     different question. No failover, and no build probe either;
 *   • build drift between replicas is a HARD error that names both addresses and both commits, and
 *     STICKS (fails fast) until the operator re-points the list;
 *   • one entry — or no operator list at all — is byte-for-byte the old single-URL fetch: exactly
 *     one request, same URL, same errors. That last clause is what keeps ~2300 pre-R1 tests honest.
 *   • wave-2: EVERY attempt (0 included) arms its own internal deadline when a second address
 *     exists, and an address that hung out its deadline is COOLED (walked last ~30 s, any answer
 *     clears it, a revision bump clears all) — a hung preferred relay now fails over instead of
 *     burning every caller budget forever; a single-address walk is still byte-for-byte pre-R1.
 *
 * `globalThis.fetch` is replaced at the boundary with a URL-aware handler and restored afterwards
 * (the same convention as relay.test.ts / till.test.ts).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {RelayBuildDriftError, relayBuildDrift, relayFetch, resetRelayBuildStateForTest} from '../services/relay';
import {resetRelayAddressesForTest, setRelayAddresses} from '../services/relayAddresses';
import {useBalancePoll} from '../hooks/useBalancePoll';
import {POLL} from '../config/constants';

const realFetch = globalThis.fetch;
const requests: string[] = [];

type Res = {ok: boolean; status: number; body?: unknown; delayMs?: number};
type Entry = Res | 'reject' | 'hang';

/** Serve per-path answers per-origin; any request to an origin without a handler REJECTS (that is
 *  the walk's "transport failure"). `'hang'` never settles of its own accord and rejects ONLY when
 *  the attempt's composed signal aborts — the exact behavior of a server that accepts the
 *  connection and never answers, which is what the armed per-attempt deadline exists for. A
 *  `delayMs` entry answers AFTER the delay (driven by the fake clock), rejecting immediately if
 *  the signal aborts mid-delay — real-fetch semantics for "alive but slow". Every call is
 *  recorded in `requests`. */
function serve(handlers: Record<string, Record<string, Entry>>) {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((url: string, init?: RequestInit) => {
    requests.push(url);
    // Real fetch rejects BEFORE sending when the signal is already aborted — the walk relies on
    // exactly that to stop on the address after a caller abort.
    if (init?.signal?.aborted) return Promise.reject(new Error('aborted'));
    const u = new URL(url);
    const table = handlers[u.origin];
    const hit = table?.[u.pathname];
    if (hit === 'hang') {
      return new Promise((_resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort, {once: true});
      });
    }
    if (hit == null || hit === 'reject') return Promise.reject(new Error('network refused'));
    if (hit.delayMs !== undefined) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        init?.signal?.addEventListener('abort', onAbort, {once: true});
        setTimeout(() => {
          init?.signal?.removeEventListener('abort', onAbort);
          resolve({ok: hit.ok, status: hit.status, json: async () => hit.body ?? {}} as unknown as Response);
        }, hit.delayMs);
      });
    }
    return Promise.resolve({ok: hit.ok, status: hit.status, json: async () => hit.body ?? {}} as unknown as Response);
  });
}

beforeEach(() => {
  resetRelayBuildStateForTest();
  resetRelayAddressesForTest();
  requests.length = 0;
});
afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

const A = 'http://a.example';
const B = 'http://b.example';
const C = 'http://c.example';
const D = 'http://d.example';
const E = 'http://e.example';

const versionBody = (commit: string) => ({name: 'dpay-relay', version: '1.0.0', commit, commit_date: '2026-09-10'});
const integrityBody = (pinned: string) => ({facade_canister: 'facade-id', live_module_hash: 'live', pinned_module_hash: pinned, status: 'MATCH', relay_commit: 'x'});
/** Both probe endpoints of a healthy same-build replica — the usual companion to a 2xx data row. */
const probes = (commit: string) => ({
  '/api/v1/version': {ok: true, status: 200, body: versionBody(commit)},
  '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')},
});

describe('the single-address world — no operator list means NO behavior change', () => {
  test('exactly one fetch, to the caller’s address, same errors as before', async () => {
    serve({[A]: {'/api/v1/x': {ok: true, status: 200, body: {hello: 1}}}});
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(200);
    expect(requests).toEqual([`${A}/api/v1/x`]);
  });
  test('a one-entry list naming the SAME address dedupes to one fetch (no self-walk)', async () => {
    serve({[A]: {'/api/v1/x': {ok: true, status: 200}}});
    setRelayAddresses([A]);
    await relayFetch(A, '/api/v1/x');
    expect(requests).toEqual([`${A}/api/v1/x`]);
  });
  test('the single-address failure is unchanged: no walk, no probe, the transport error as-is', async () => {
    serve({}); // every origin refuses
    await expect(relayFetch(A, '/api/v1/x')).rejects.toThrow(/a\.example.*network refused/);
  });
});

describe('ordered selection — transport failure or 5xx moves on, a 4xx never does', () => {
  test('transport failure on the preferred → the next address answers', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({from: 'b'});
    expect(relayBuildDrift()).toBeNull();
  });
  test('HTTP 500 on the preferred → the next address answers (5xx is "not serving", not an answer)', async () => {
    serve({
      [A]: {'/api/v1/x': {ok: false, status: 503}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(200);
  });
  test('a 4xx is AN ANSWER: returned as-is, no second address asked, no build probe', async () => {
    serve({
      [A]: {'/api/v1/x': {ok: false, status: 404}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(404);
    expect(requests).toEqual([`${A}/api/v1/x`]); // B was never touched — not even /version
  });
  test('every address transport-dead names each one and its reason in the aggregate error', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject'},
      [B]: {'/api/v1/x': 'reject'},
      [C]: {'/api/v1/x': 'reject'},
    });
    setRelayAddresses([A, B, C]);
    await expect(relayFetch(A, '/api/v1/x')).rejects.toThrow(
      /all relay addresses failed — http:\/\/a\.example \(network refused\); http:\/\/b\.example \(network refused\); http:\/\/c\.example \(network refused\)/,
    );
  });
  test('walk exhausted with a 5xx in hand returns that refusal — the relay’s own answer reaches the caller', async () => {
    // A reachable replica refusing to serve is a fact about the SERVICE, and its error body says
    // why; a synthetic "all addresses failed" would bury it. (Single-address 5xx error-body
    // surfacing — relay.test.ts’s M11 pins — rides this same branch.)
    serve({
      [A]: {'/api/v1/x': 'reject'},
      [B]: {'/api/v1/x': {ok: false, status: 503}},
      [C]: {'/api/v1/x': 'reject'},
    });
    setRelayAddresses([A, B, C]);
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(503);
  });
  test('the CALLER’s abort stops the walk — an aborted caller is not a transport failure', async () => {
    serve({[A]: {'/api/v1/x': 'reject'}, [B]: {'/api/v1/x': {ok: true, status: 200}}});
    setRelayAddresses([A, B]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(relayFetch(A, '/api/v1/x', {signal: ctrl.signal})).rejects.toThrow();
    expect(requests).toEqual([`${A}/api/v1/x`]);
  });
});

describe('build drift — replicas must agree on /version AND /integrity', () => {
  test('a version mismatch between preferred and replica is a LOUD hard error naming both', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('commit-aaa')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('commit-bbb')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    const p = relayFetch(A, '/api/v1/x');
    // The data request hit B and got a 2xx — the gate then read BOTH builds and refused.
    await expect(p).rejects.toBeInstanceOf(RelayBuildDriftError);
    await p.catch((e: RelayBuildDriftError) => {
      expect(e.referenceAddr).toBe(A);
      expect(e.replicaAddr).toBe(B);
      expect(e.referenceCommit).toBe('commit-aaa');
      expect(e.replicaCommit).toBe('commit-bbb');
      expect(e.message).toContain('different builds');
    });
  });
  test('an integrity-only mismatch (different PINNED facade hash) is drift too', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('hash-one')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('hash-two')}},
    });
    setRelayAddresses([A, B]);
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
  });
  test('drift STICKS: the next call fails fast without touching the network', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c2')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    requests.length = 0;
    await expect(relayFetch(A, '/api/v1/other')).rejects.toBeInstanceOf(RelayBuildDriftError);
    expect(requests).toEqual([]);
  });
  test('re-pointing the list (a new revision) clears the latch — the operator fixed it', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c2')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    setRelayAddresses([B]); // the operator removed the stale address
    const r = await relayFetch(B, '/api/v1/x');
    expect(r.status).toBe(200);
  });
  test('the latch reads NULL the moment the revision moves — before any walk has physically cleared it', async () => {
    // Settings renders `relayBuildDrift()` live; drift naming addresses that are no longer on
    // the list must die with the revision, not linger until some later walk resets the module.
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c2')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    setRelayAddresses([B]); // re-point; NO relayFetch runs
    expect(relayBuildDrift()).toBeNull();
  });
  test('identical builds answer normally, and the fingerprint is read ONCE per address', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B]);
    await relayFetch(A, '/api/v1/x');
    await relayFetch(A, '/api/v1/x');
    expect(requests.filter((u) => u === `${B}/api/v1/version`)).toHaveLength(1); // memoized
    expect(requests.filter((u) => u === `${B}/api/v1/integrity`)).toHaveLength(1);
  });
  test('first-seen adoption: with the preferred never reachable, the first replica to answer sets the baseline a THIRD replica is checked against', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': 'reject', '/api/v1/integrity': 'reject'},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [C]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c3')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B, C]);
    const r = await relayFetch(A, '/api/v1/x'); // A dead → B answers → B's build adopted as baseline
    expect(r.status).toBe(200);
    // Now B 5xx's: the walk reaches C, whose build is checked AGAINST THE ADOPTED BASELINE (B).
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': 'reject', '/api/v1/integrity': 'reject'},
      [B]: {'/api/v1/x': {ok: false, status: 503}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
      [C]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c3')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    const p = relayFetch(A, '/api/v1/x');
    await expect(p).rejects.toBeInstanceOf(RelayBuildDriftError);
    await p.catch((e: RelayBuildDriftError) => {
      expect(e.referenceAddr).toBe(B); // the baseline, not the dead preferred
      expect(e.replicaAddr).toBe(C);
    });
  });
  test('a replica whose build cannot be read is NOT trusted with data — the walk moves on', async () => {
    serve({
      [A]: {'/api/v1/x': 'reject', '/api/v1/version': 'reject', '/api/v1/integrity': 'reject'},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: {}}, '/api/v1/integrity': {ok: true, status: 200, body: {}}}, // no commit — unreadable
      [C]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: versionBody('c1')}, '/api/v1/integrity': {ok: true, status: 200, body: integrityBody('h1')}},
    });
    setRelayAddresses([A, B, C]);
    const r = await relayFetch(A, '/api/v1/x');
    expect(r.status).toBe(200);
    expect(requests).toContain(`${C}/api/v1/x`);
    // …and with NO further address, the honest outcome names the unreadable build.
    setRelayAddresses([A, B]);
    requests.length = 0;
    serve({
      [A]: {'/api/v1/x': 'reject'},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': {ok: true, status: 200, body: {}}, '/api/v1/integrity': {ok: true, status: 200, body: {}}},
    });
    await expect(relayFetch(A, '/api/v1/x')).rejects.toThrow(/b\.example \(its build could not be read/);
  });
});

describe('attempt deadlines — a hung transport is failover fuel, and the walk is bounded (R1 audit fix)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a HUNG preferred fails over within attempt 1’s OWN deadline — the next address answers', async () => {
    // A accepts TCP but never answers. Before the audit fix the caller's signal was forwarded
    // AS-IS and no attempt timer armed, so the hung preferred burned the whole budget and B was
    // never tried. Now every attempt arms its own deadline: A's expiry is a transport failure.
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')},
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    const p = relayFetch(A, '/api/v1/x', undefined, 8000);
    await jest.advanceTimersByTimeAsync(8000); // attempt 1’s full budget expires
    const r = await p;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({from: 'b'});
    expect(requests).toContain(`${A}/api/v1/x`);
    expect(requests).toContain(`${B}/api/v1/x`); // B was reached — the whole point
    expect(jest.getTimerCount()).toBe(0); // every attempt/probe timer was cancelled in its finally
  });

  test('the total walk is bounded ≈ 2×timeoutMs: five hung addresses, geometric falloff (8000+4000+2000+1000+1000)', async () => {
    // Without the falloff an all-hung list stalls one walk 5×timeoutMs with polls piling on.
    // The policy: attempt i gets timeoutMs >> (i-1) floored at 1000 ms — a geometric sum, so the
    // worst case is 16000 ms for a 10 s slot, NOT 40000 ms.
    serve({
      [A]: {'/api/v1/x': 'hang'},
      [B]: {'/api/v1/x': 'hang'},
      [C]: {'/api/v1/x': 'hang'},
      [D]: {'/api/v1/x': 'hang'},
      [E]: {'/api/v1/x': 'hang'},
    });
    setRelayAddresses([A, B, C, D, E]);
    let outcome: string | undefined;
    const p = relayFetch(A, '/api/v1/x', undefined, 8000);
    p.then(() => { outcome = 'resolved'; }, (e: Error) => { outcome = e.message; });
    await jest.advanceTimersByTimeAsync(15999);
    expect(outcome).toBeUndefined(); // the last attempt is still inside its 1000 ms floor
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/all relay addresses failed/); // settled at exactly 16000 = 2×8000
    expect(requests.filter((u) => u.endsWith('/api/v1/x'))).toHaveLength(5); // every address tried once
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a caller abort mid-PROBE stops the probe — the caller’s signal is the walk’s hard cap', async () => {
    // B answers data but hangs its /version probe; the caller gives up at 1000 ms. The probe
    // composes the caller's signal (R1 audit fix — it used to pass `undefined`), so it ends with
    // the caller instead of stalling the walk 4000 ms past the caller's deadline.
    serve({
      [A]: {'/api/v1/x': 'reject'},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': 'hang', '/api/v1/integrity': 'hang'},
      [C]: {'/api/v1/x': {ok: true, status: 200}},
    });
    setRelayAddresses([A, B, C]);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 1000);
    let outcome: string | undefined;
    const p = relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 8000);
    p.then(() => { outcome = 'resolved'; }, (e: Error) => { outcome = e.message; });
    await jest.advanceTimersByTimeAsync(1000);
    expect(outcome).toBeDefined(); // ended at the CALLER’s 1000 ms, not the probe’s 4000 ms
    expect(outcome).toMatch(/aborted/);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('mid-flight list edits — a stale walk never poisons the new list’s session state (R1 audit fix)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a walk that outlived a Settings re-point keeps its own answer but cannot latch drift', async () => {
    // The poison scenario: a walk starts under revision N (hung preferred), Settings applies a
    // healthy new list (revision N+1) which RESETS the shared caches — and then the stale walk
    // finishes and writes old-list drift into the new list's session. Guarded by the revision
    // captured at walk entry: the stale walk returns its own per-call answer and latches NOTHING.
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')}, // hung data; probes readable (commit c1)
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c2')}, // a REAL mismatch under the OLD list
      [C]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'c'}}},
    });
    setRelayAddresses([A, B]);
    const stale = relayFetch(A, '/api/v1/x', undefined, 8000); // walks under revision N
    setRelayAddresses([C]); // revision N+1: the operator applied a healthy list mid-flight
    const r2 = await relayFetch(C, '/api/v1/x'); // the fresh walk resets and succeeds NOW
    expect(r2.status).toBe(200);

    await jest.advanceTimersByTimeAsync(8000); // let the stale walk reach B’s mismatch
    const r1 = await stale;
    expect(r1.status).toBe(200); // its per-call answer stands — harmless, per-call
    expect(await r1.json()).toEqual({from: 'b'});
    expect(relayBuildDrift()).toBeNull(); // but the drift latch NEVER fired for the new session
    const r3 = await relayFetch(C, '/api/v1/x'); // every subsequent call still succeeds
    expect(r3.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a walk that outlived a Settings re-point cannot COOL an address on the new list (stale cooldown write)', async () => {
    // The cooldown twin of the drift-latch pin above: a walk starts under revision N (hung
    // preferred), Settings re-applies the list (revision N+1) — and when the stale walk's internal
    // deadline later expires, its cooldown write must be dropped (the `stillCurrent()` guard on
    // `cooldowns.set`), exactly like every other shared-state write. The poison it prevents: the
    // stale write landing AFTER a fresh walk already reset the session would reorder a THIRD walk
    // — bad-marking an address, on the operator's new list, for a hang observed under the old one.
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')}, // hung data under the OLD list
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    const stale = relayFetch(A, '/api/v1/x', undefined, 8000); // walks under revision N
    stale.catch(() => {}); // silence the unhandled-rejection loud mode; resolved below
    setRelayAddresses([A, B]); // re-APPLYING the same list still bumps the revision (N+1)
    serve({
      [A]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'a'}}, ...probes('c1')}, // A recovered
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c1')},
    });
    const r2 = await relayFetch(A, '/api/v1/x', undefined, 4000); // the fresh walk resets + succeeds NOW
    expect(r2.status).toBe(200);

    await jest.advanceTimersByTimeAsync(8000); // the stale walk's attempt-0 deadline fires HERE
    const r1 = await stale;
    expect(r1.status).toBe(200); // its per-call answer stands (failover to B under its own walk)
    // The guard under test: A must NOT be cooled by the stale expiry. Observable via a third walk —
    // the revision already matches cachesRevision, so NO reset runs first: had the stale walk
    // written, the cooldown would reorder this walk to B-first.
    requests.length = 0;
    const r3 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r3.status).toBe(200);
    expect(requests[0]).toBe(`${A}/api/v1/x`); // A first — no stale cooldown survived
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('attempt-0 arming + the address cooldown (R1 wave-2 — the hung-preferred blocker)', () => {
  // The blocker two hostile audits confirmed: a hung preferred relay (TCP accepts, never answers)
  // NEVER failed over for signal-passing callers — attempt 0 forwarded the caller's signal with no
  // internal deadline, the caller's own outer timer fired first, the catch read that as a caller
  // abort, and every 2.5 s poll repeated forever (useBalancePoll passes timed(BALANCE_TIMEOUT_MS)).
  // Wave-2: every attempt arms an internal deadline when a second address exists, and an address
  // that hung out ITS deadline is cooled (walked last ~30 s). These are the regression pins.

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test("THE blocker pin: useBalancePoll's EXACT new shape fails over IN THE SAME CALL", async () => {
    // The hook's shape since wave-2: outer caller timer BALANCE_TIMEOUT_MS + 1000 (5000), walk
    // timeoutMs BALANCE_TIMEOUT_MS (4000). The +1000 makes the walk's OWN internal 4000 ms
    // deadline the thing that classifies the hang — cooldown + failover — instead of the caller's
    // anonymous abort. B healthy ⇒ the SAME call answers from B.
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')},
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    const ctrl = new AbortController(); // the hook's `timed(BALANCE_TIMEOUT_MS + 1000)`
    const outer = setTimeout(() => ctrl.abort(), 5000);
    const p = relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 4000);
    await jest.advanceTimersByTimeAsync(4000); // attempt 0's INTERNAL deadline — ours, not the caller's
    const r = await p;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({from: 'b'});
    expect(requests).toContain(`${A}/api/v1/x`);
    expect(requests).toContain(`${B}/api/v1/x`); // the SAME call reached B
    // …and A's internal expiry armed the cooldown: the NEXT walk starts at B.
    requests.length = 0;
    const r2 = await relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 4000);
    expect(r2.status).toBe(200);
    expect(requests[0]).toBe(`${B}/api/v1/x`); // A walked last
    clearTimeout(outer);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('tied budget: the caller cap ends that poll as an ABORT, and the NEXT call starts at B', async () => {
    // B is alive but slower than the remaining budget: the caller grants 5000 total, attempt 0
    // burns 4000 on the hung A, and B's own attempt slot (2000) runs out of caller time at 5000.
    // That poll dies as the caller's abort (not an outage) — but A is cooled, so the immediate
    // NEXT poll starts at B and succeeds. Bounded outage, zero single-address latency change.
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')},
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}, delayMs: 1500}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    const ctrl = new AbortController();
    const outer = setTimeout(() => ctrl.abort(), 5000);
    const p1 = relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 4000);
    p1.catch(() => {}); // silence the unhandled-rejection loud mode; asserted below
    await jest.advanceTimersByTimeAsync(5000);
    await expect(p1).rejects.toThrow(/aborted/); // the caller's cap — an abort, NOT an outage
    clearTimeout(outer);
    expect(requests.filter((u) => u.endsWith('/api/v1/x'))).toEqual([`${A}/api/v1/x`, `${B}/api/v1/x`]);
    // The second call — same shape — skips cooled A, and B answers inside its full slot.
    requests.length = 0;
    const ctrl2 = new AbortController();
    const outer2 = setTimeout(() => ctrl2.abort(), 5000);
    const p2 = relayFetch(A, '/api/v1/x', {signal: ctrl2.signal}, 4000);
    await jest.advanceTimersByTimeAsync(1500); // B's slow-but-alive answer (also retires call 1's orphaned delay timer)
    const r2 = await p2;
    clearTimeout(outer2);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({from: 'b'});
    expect(requests[0]).toBe(`${B}/api/v1/x`); // A skipped: the cooldown moved the walk
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a cooldown EXPIRES (~30 s): A is retried, first in order again', async () => {
    serve({
      [A]: {'/api/v1/x': 'hang', ...probes('c1')},
      [B]: {'/api/v1/x': 'reject'},
    });
    setRelayAddresses([A, B]);
    let outcome: string | undefined;
    const p1 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p1.catch((e: Error) => { outcome = e.message; });
    await jest.advanceTimersByTimeAsync(4000 + 1000); // A hangs out its slot (→ cooled); B refuses
    expect(outcome).toMatch(/all relay addresses failed/);
    // A recovered in the meantime; 30 s after its hang the cooldown expires.
    serve({
      [A]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'a'}}, ...probes('c1')},
      [B]: {'/api/v1/x': 'reject'},
    });
    await jest.advanceTimersByTimeAsync(30_000);
    requests.length = 0;
    const r2 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r2.status).toBe(200);
    expect(requests[0]).toBe(`${A}/api/v1/x`); // A first again — cooldown reorders, never exiles
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ANY answer clears a cooldown — even a 404 (an answer is an answer)', async () => {
    serve({
      [A]: {'/api/v1/x': 'hang'},
      [B]: {'/api/v1/x': 'reject'},
    });
    setRelayAddresses([A, B]);
    const p1 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p1.catch(() => {});
    await jest.advanceTimersByTimeAsync(5000); // A hangs out its deadline → cooled
    // The next walk tries B first (still refused); cooled A answers 404 — an ANSWER.
    serve({
      [A]: {'/api/v1/x': {ok: false, status: 404}},
      [B]: {'/api/v1/x': 'reject'},
    });
    const r2 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r2.status).toBe(404); // the 4xx answer, returned as-is
    // That answer cleared A: the next walk puts A back at the FRONT (B never cooled — a refusal
    // is not a hang).
    requests.length = 0;
    const r3 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r3.status).toBe(404);
    expect(requests[0]).toBe(`${A}/api/v1/x`);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a COOLED replica with a different build still drift-errors — cooldown reorders the walk, it never bypasses the build gate', async () => {
    // Cooldown is ORDER only. When a reordering walk still REACHES the cooled replica and it
    // answers data, that answer goes through the same build gate as anyone else's — a mismatched
    // replica is drift no matter how unfavorably it was last seen. Without this pin, a "cooled
    // addresses are walked last (and trusted cheaper)" refactor would silently mix builds.
    // Phase 1 — cool B the honest way: it hangs out an attempt deadline while A and C refuse.
    serve({
      [A]: {'/api/v1/x': 'reject', ...probes('c1')},
      [B]: {'/api/v1/x': 'hang'},
      [C]: {'/api/v1/x': 'reject', ...probes('c1')},
    });
    setRelayAddresses([A, B, C]);
    const p1 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p1.catch(() => {});
    await jest.advanceTimersByTimeAsync(2000); // B (attempt 1: 4000>>1) hangs out its slot → cooled
    await expect(p1).rejects.toThrow(/all relay addresses failed/);
    // Phase 2 — B recovered AND was redeployed at a different commit. The walk order is now
    // [A, C, B] (B cooled, walked last) — but B is still the only address answering data.
    serve({
      [A]: {'/api/v1/x': 'reject', ...probes('c1')},
      [B]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'b'}}, ...probes('c2')}, // mismatching build
      [C]: {'/api/v1/x': 'reject', ...probes('c1')},
    });
    requests.length = 0;
    const p2 = relayFetch(A, '/api/v1/x', undefined, 4000);
    await expect(p2).rejects.toBeInstanceOf(RelayBuildDriftError);
    // The reorder AND the gate, in one sequence: B was walked LAST, and its data answer was still
    // build-checked (A probed live as the reference — the mismatch fires against A's c1).
    expect(requests.filter((u) => u.endsWith('/api/v1/x'))).toEqual([
      `${A}/api/v1/x`,
      `${C}/api/v1/x`,
      `${B}/api/v1/x`,
    ]);
    expect(relayBuildDrift()).not.toBeNull(); // latched for THIS list revision
    // …and sticky: the next call fails fast without touching the network.
    requests.length = 0;
    await expect(relayFetch(A, '/api/v1/x')).rejects.toBeInstanceOf(RelayBuildDriftError);
    expect(requests).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ALL addresses cooled → the walk uses the FULL original order (never offline-by-cooldown)', async () => {
    serve({[A]: {'/api/v1/x': 'hang'}, [B]: {'/api/v1/x': 'hang'}, [C]: {'/api/v1/x': 'hang'}});
    setRelayAddresses([A, B, C]);
    const p1 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p1.catch(() => {});
    await jest.advanceTimersByTimeAsync(7000); // 4000+2000+1000: every address hung out its slot
    requests.length = 0;
    const p2 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p2.catch(() => {});
    await jest.advanceTimersByTimeAsync(7000);
    // All three cooled → the ORIGINAL order — the wallet is never "offline by cooldown".
    expect(requests.filter((u) => u.endsWith('/api/v1/x'))).toEqual([
      `${A}/api/v1/x`,
      `${B}/api/v1/x`,
      `${C}/api/v1/x`,
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a CALLER abort mid-attempt never cools the address (an unmount is not an outage)', async () => {
    serve({[A]: {'/api/v1/x': 'hang'}, [B]: {'/api/v1/x': {ok: true, status: 200}}});
    setRelayAddresses([A, B]);
    const ctrl = new AbortController();
    const outer = setTimeout(() => ctrl.abort(), 1000); // the component unmounts 1 s in
    const p1 = relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 4000);
    p1.catch(() => {});
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p1).rejects.toThrow(/aborted/);
    clearTimeout(outer);
    expect(requests).toEqual([`${A}/api/v1/x`]); // B was never asked — the CALLER quit, not the relay
    // A is NOT cooled: the next walk tries A first again — and now A answers.
    serve({[A]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'a'}}}, [B]: {'/api/v1/x': {ok: true, status: 200}}});
    requests.length = 0;
    const r2 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r2.status).toBe(200);
    expect(requests[0]).toBe(`${A}/api/v1/x`);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a revision bump (re-point/reprobe) clears every cooldown — a new list gets a clean slate', async () => {
    serve({[A]: {'/api/v1/x': 'hang'}, [B]: {'/api/v1/x': 'reject'}});
    setRelayAddresses([A, B]);
    const p1 = relayFetch(A, '/api/v1/x', undefined, 4000);
    p1.catch(() => {});
    await jest.advanceTimersByTimeAsync(5000); // A cooled by its internal expiry
    setRelayAddresses([A, B]); // re-APPLYING the same list still bumps the revision
    serve({[A]: {'/api/v1/x': {ok: true, status: 200, body: {from: 'a'}}}, [B]: {'/api/v1/x': 'reject'}});
    requests.length = 0;
    const r2 = await relayFetch(A, '/api/v1/x', undefined, 4000);
    expect(r2.status).toBe(200);
    expect(requests[0]).toBe(`${A}/api/v1/x`); // A first again — the cooldown died with the revision
    expect(jest.getTimerCount()).toBe(0);
  });

  test('aggregation: a caller abort on the LAST address rethrows the abort, not "all relay addresses failed"', async () => {
    // An abort is a caller decision (unmount, screen change), not an outage — reporting it as the
    // aggregate would tell the caller every relay is down when the caller itself quit. This hits
    // the END-of-walk path: the loop FINISHED (B's data answered, but its build probe hung until
    // the caller's cap), so the choice is aggregate-vs-abort, not the mid-loop rethrow.
    serve({
      [A]: {'/api/v1/x': 'reject'},
      [B]: {'/api/v1/x': {ok: true, status: 200}, '/api/v1/version': 'hang', '/api/v1/integrity': 'hang'},
    });
    setRelayAddresses([A, B]);
    const ctrl = new AbortController();
    const outer = setTimeout(() => ctrl.abort(), 1000);
    let message = '';
    const p = relayFetch(A, '/api/v1/x', {signal: ctrl.signal}, 4000);
    p.catch((e: Error) => { message = e.message; });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow(/aborted/);
    expect(message).not.toMatch(/all relay addresses failed/); // the abort, never the aggregate
    clearTimeout(outer);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('useBalancePoll END-TO-END: a hung preferred goes online via B inside ONE poll', async () => {
    // The hook mounted for real (only `fetch` is faked). Before wave-2 this exact world left the
    // wallet offline forever: every poll aborted at its own 4000 ms timer and restarted at A.
    const HEX = 'aabb';
    serve({
      [A]: {[`/api/v1/balances/${HEX}`]: 'hang', ...probes('c1')},
      [B]: {[`/api/v1/balances/${HEX}`]: {ok: true, status: 200, body: {'0': '123'}}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    let latest: ReturnType<typeof useBalancePoll> | null = null;
    function Probe() {
      latest = useBalancePoll({relayUrl: A, publicHex: HEX, displayAssets: [], displayCurrencyIds: ''});
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Probe)); });
    // The walk's internal 4000 ms deadline — not the hook's 5000 ms outer timer — classifies A.
    await act(async () => { await jest.advanceTimersByTimeAsync(4000); });
    expect(latest!.online).toBe(true); // online, from B, within the FIRST poll
    expect(latest!.balance).toBe('123');
    const data = requests.filter((u) => u.includes('/api/v1/balances/'));
    expect(data[0]).toBe(`${A}/api/v1/balances/${HEX}`);
    expect(data).toContain(`${B}/api/v1/balances/${HEX}`);
    act(() => { tree.unmount(); });
    await act(async () => {
      // React's own work scheduler queues a due-at-now 0 ms tick on unmount; under a frozen fake
      // clock it never runs. Advance(0) fires it, then the hard assertion proves no REAL timer
      // (poll interval, outer poll timer, attempt deadline) leaked.
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(jest.getTimerCount()).toBe(0); // no leaked poll/attempt/interval timers
  });

  test('hook-level two-poll sequence: poll 1 dies as the CALLER abort at the 5 s cap; the NEXT poll starts at B and succeeds', async () => {
    // The mounted-hook companion of the "tied budget" pin above, at the REAL hook cadence
    // (useBalancePoll: outer caller timer BALANCE_TIMEOUT_MS+1000 = 5000, walk timeoutMs
    // BALANCE_TIMEOUT_MS = 4000, interval POLL.balance). The preferred hangs; B answers slower
    // than the remaining caller budget, so poll 1 dies as the CALLER's abort at the 5 s cap — not
    // an outage — with cooldown(A) armed by the walk's own 4000 ms deadline; the NEXT poll (one
    // interval later) starts at B and succeeds. POLL.balance is retimed to 6000 by direct mutation
    // of the shared constants object (`POLL.balance = 6000`, restored in the finally) so the
    // interval fires strictly AFTER poll 1's death (at the prod 2500 cadence the second poll would
    // start mid-hang and re-hang A itself).
    const HEX = 'aabb';
    serve({
      [A]: {[`/api/v1/balances/${HEX}`]: 'hang', ...probes('c1')},
      [B]: {[`/api/v1/balances/${HEX}`]: {ok: true, status: 200, body: {'0': '123'}, delayMs: 1500}, ...probes('c1')},
    });
    setRelayAddresses([A, B]);
    const prodBalance = POLL.balance;
    POLL.balance = 6000;
    let latest: ReturnType<typeof useBalancePoll> | null = null;
    function Probe() {
      latest = useBalancePoll({relayUrl: A, publicHex: HEX, displayAssets: [], displayCurrencyIds: ''});
      return null;
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => { tree = renderer.create(React.createElement(Probe)); });
      // Poll 1: A hangs out the walk's own 4000 ms attempt-0 deadline (→ cooldown(A) + failover);
      // B's 1500 ms answer needs more than the 1000 ms of caller budget left, so at 5000 the
      // CALLER's cap ends the poll as an abort.
      await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
      expect(latest!.online).toBe(false); // offline — the poll died as an abort, not an answer
      expect(latest!.balance).toBe(null);
      const logged = warn.mock.calls.map(c => c.map(a => String(a)).join(' ')).join('\n');
      expect(logged).toMatch(/balance poll failed: aborted/); // classified as the CALLER's abort
      expect(requests.filter((u) => u.includes('/api/v1/balances/'))).toEqual([
        `${A}/api/v1/balances/${HEX}`, // poll 1: the hung preferred
        `${B}/api/v1/balances/${HEX}`, // poll 1: failover attempt, aborted at the caller cap
      ]);
      // Poll 2 (the interval fires at 6000): A is cooled — the walk STARTS at B, whose full
      // attempt-0 slot (4000 ms) now covers the 1500 ms answer.
      await act(async () => { await jest.advanceTimersByTimeAsync(2500); }); // → t=7500: B answers
      expect(latest!.online).toBe(true);
      expect(latest!.balance).toBe('123');
      expect(requests.filter((u) => u.includes('/api/v1/balances/'))).toEqual([
        `${A}/api/v1/balances/${HEX}`, // poll 1: hung preferred
        `${B}/api/v1/balances/${HEX}`, // poll 1: failover attempt (aborted at the caller cap)
        `${B}/api/v1/balances/${HEX}`, // poll 2: STARTS at B — the cooldown moved the walk
      ]);
      act(() => { tree.unmount(); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(jest.getTimerCount()).toBe(0); // interval cleared, outer timers stopped, no orphans
    } finally {
      POLL.balance = prodBalance;
      warn.mockRestore();
    }
  });

  test('useBalancePoll overlap: a STALE poll\'s late timeout cannot flip the dot offline after a NEWER poll succeeded (the green→gray flicker)', async () => {
    // The reported glitch: the dot shows green "every now and then, then switches to gray
    // immediately after". Cause: POLL.balance (2.5 s) fires polls faster than a slow walk ends
    // (the outer cap aborts at 5 s), so when a HUNG poll A is overtaken by a FAST poll B, A's
    // own late abort landed after B's success and setOnline(false) — same effect generation, so
    // the `fresh()` gate alone never stopped it. The overlap guard retires A's write: a failure
    // is stale when a success completed after the failing poll started. Pin: single address, prod
    // cadence, A 'hang' for poll 1 then a fast 200.
    const HEX = 'aabb';
    serve({[A]: {[`/api/v1/balances/${HEX}`]: 'hang'}});
    setRelayAddresses([A]);
    const prodBalance = POLL.balance;
    POLL.balance = 2500;
    let latest: ReturnType<typeof useBalancePoll> | null = null;
    function Probe() {
      latest = useBalancePoll({relayUrl: A, publicHex: HEX, displayAssets: [], displayCurrencyIds: ''});
      return null;
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => { tree = renderer.create(React.createElement(Probe)); }); // poll 1 @ t=0: hangs
      // Re-serve BEFORE the interval fires so poll 2 (t=2500) meets a fast 200. Poll 1 is already
      // in flight on the old handler — its hang promise still only ends when ITS signal aborts.
      serve({[A]: {[`/api/v1/balances/${HEX}`]: {ok: true, status: 200, body: {'0': '123'}}}});
      await act(async () => { await jest.advanceTimersByTimeAsync(2500); }); // poll 2 succeeds fast
      expect(latest!.online).toBe(true); // green — the newer poll answered
      expect(latest!.balance).toBe('123');
      // Re-hang for poll 3 (fires at t=5000, the same tick poll 1's outer cap aborts it) so it
      // writes nothing during the test; poll 1's late abort is the ONLY writer that could land.
      serve({[A]: {[`/api/v1/balances/${HEX}`]: 'hang'}});
      // Poll 1's outer 5 s cap now aborts it — the OLD code wrote setOnline(false) HERE (the
      // flicker); the overlap guard must drop the stale failure instead.
      await act(async () => { await jest.advanceTimersByTimeAsync(2600); }); // → t=5100
      expect(latest!.online).toBe(true); // still green — the stale abort never landed
      expect(latest!.balance).toBe('123');
      const logged = warn.mock.calls.map(c => c.map(a => String(a)).join(' ')).join('\n');
      expect(logged).toMatch(/balance poll failed: aborted/); // the hang is still logged, just not WRITTEN
      expect(requests.filter((u) => u.includes('/api/v1/balances/'))).toEqual([
        `${A}/api/v1/balances/${HEX}`, // poll 1: the hung one (stale-dropped)
        `${A}/api/v1/balances/${HEX}`, // poll 2: the fast 200 that owns the dot
        `${A}/api/v1/balances/${HEX}`, // poll 3: re-hung at t=5000, still in flight at test end
      ]);
      act(() => { tree.unmount(); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      expect(jest.getTimerCount()).toBe(0); // interval cleared, outer timers stopped, no orphans
    } finally {
      POLL.balance = prodBalance;
      warn.mockRestore();
    }
  });
});
