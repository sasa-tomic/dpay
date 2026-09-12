/**
 * The till's R1 session pin (spec 2026-09-09 §"Direction 2 — several relays"): a till charge is
 * RELAY-HELD, session-affine state — the charge id, its expiry and its settlement live on the relay
 * that opened it. So while every read-only surface multi-homes (`relayFailover.test.ts`), the till
 * resolves ONE relay per session — the first address that answers OK (only a relay that can
 * actually HOLD a charge earns the session; a 4xx answers the call but does NOT pin) — and never
 * failovers mid-session, even if the operator re-points the list under it.
 *
 * The failures this suite exists for:
 *   • a mid-session failover would ask a replica that never heard of the charge — the cashier sees
 *     "not found" for a charge that is open elsewhere, and either re-rings it or turns the payer
 *     away;
 *   • a PIN that outlived its MEMBERSHIP would keep talking to an address the operator just
 *     removed — a shadow connection no list edit can reach (e2e flow 116's stage 1 hung exactly
 *     there: the poll kept asking the retargeted-away relay and the screen never said "can't
 *     check") — so the pin holds exactly as long as the configured list still carries its
 *     address: a REORDER keeps it, a REMOVAL kills it, and the call walks the new list like any
 *     other (a dead new list ⇒ unreachable/unchecked naming who was actually asked);
 *   • a 4xx PIN would let a NON-TILL relay early in the list permanently hide a working till
 *     further down — so a <500 non-2xx answers the call, pins nothing, and the next charge
 *     re-walks.
 *
 * The core is stubbed at its module boundary exactly as till.test.ts stubs it; `globalThis.fetch`
 * is replaced with a URL-aware handler and restored afterwards.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import {readFileSync} from 'fs';
import {join} from 'path';

const mockSignatureCalls: unknown[][] = [];
jest.mock('../services/native', () => ({
  DpayCore: {
    tillOpenSignature: jest.fn((...args: unknown[]) => {
      mockSignatureCalls.push(args);
      return Promise.resolve('ab'.repeat(64));
    }),
  },
}));

import {cancelTillCharge, openTillCharge, resetTillRelayPinForTest, tillChargeStatus, tillSessionRelay} from '../services/till';
import {resetRelayAddressesForTest, setRelayAddresses} from '../services/relayAddresses';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {Identity} from '../lib/types';

const GOLDEN = JSON.parse(readFileSync(join(__dirname, '..', '..', 'dfx', 'till_wire.json'), 'utf8')) as {
  input: {cents: number};
  open: {id: string; qr: string; amount: string; merchant: string; reference: string; created_secs: number; expires_at: number};
  details: {transferAmounts: {method: string; assets: {asset: string}[]}[]};
  callback: {uri: string};
};

/** VCHF's ledger fee — the one the shop absorbs, so a ring-up's price check knows what the relay
 *  will have subtracted (`tillRawUnits`). From the wallet's own bundled catalog, the same row the
 *  counter reads; these tests are about WHICH RELAY is asked, so the number only has to be the
 *  right one, not a second statement of it. */
const VCHF_FEE_RAW = (() => {
  const row = icpCatalogOf(BUNDLED_NETWORKS).find(c => c.currency === 7);
  if (row?.fee == null) throw new Error('the bundled catalog must state VCHF’s ledger fee');
  return row.fee;
})();

const MERCHANT: Identity = {secretHex: '0b'.repeat(32), publicHex: '66'.repeat(32), username: 'Bahnhof Kiosk'};
const A = 'http://till-a.example';
const B = 'http://till-b.example';
const C = 'http://till-c.example';
const D = 'http://till-d.example';

const realFetch = globalThis.fetch;
const requests: string[] = [];

/** URL-aware fetch stand-in: per-origin PATH table; an unlisted path or origin REJECTS. `'hang'`
 *  accepts the connection and never answers, rejecting only when the fetch's signal aborts —
 *  what a hung relay looks like from the client (and what holds a walk open on the fake clock). */
function serve(handlers: Record<string, Record<string, {ok: boolean; status: number; body?: unknown} | 'reject' | 'hang'>>) {
  (globalThis as unknown as {fetch: unknown}).fetch = jest.fn((url: string, init?: RequestInit) => {
    requests.push(url);
    const u = new URL(url);
    const hit = handlers[u.origin]?.[u.pathname];
    if (hit === 'hang') {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    }
    if (hit == null || hit === 'reject') return Promise.reject(new Error('network refused'));
    return Promise.resolve({ok: hit.ok, status: hit.status, json: async () => hit.body ?? {}} as unknown as Response);
  });
}

/** The 200 open body the client accepts (the committed golden's shape — see till.test.ts). */
const openOk = (id: string) => ({
  id,
  qr: GOLDEN.open.qr,
  amount: GOLDEN.open.amount,
  merchant: GOLDEN.open.merchant,
  reference: GOLDEN.open.reference,
  created_secs: GOLDEN.open.created_secs,
  expires_at: GOLDEN.open.expires_at,
  details: GOLDEN.details,
  callback: GOLDEN.callback,
});

/** The relay's `ChargeStatus` wire shape (snake_case, as parseStatus reads it — the camelCase in
 *  till.test.ts's ASSERTIONS is the parsed outcome, not what the relay sends). */
const paidStatus = (id: string) => ({
  id, cents: GOLDEN.input.cents, state: 'paid',
  created_secs: GOLDEN.open.created_secs, expires_at: GOLDEN.open.expires_at,
  paid: {from: 'lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe', amount_raw: '1000000000', at_secs: GOLDEN.open.created_secs + 60, block: 77},
});

beforeEach(() => {
  resetTillRelayPinForTest();
  resetRelayAddressesForTest();
  requests.length = 0;
  mockSignatureCalls.length = 0;
});
afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});

describe('the till resolves ONE relay per session (first address that answers OK)', () => {
  test('preferred dead → the next address opens the charge, and the pin records it (2xx PINS)', async () => {
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-1')}},
    });
    setRelayAddresses([A, B]);
    const outcome = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(outcome.kind).toBe('open');
    expect(tillSessionRelay()).toBe(B);
    expect(requests[0]).toBe(`${A}/api/v1/till`);
    expect(requests[1]).toBe(`${B}/api/v1/till`);
  });
  test('a 4xx does NOT pin — the walk keeps looking, so a non-till relay early in the list never hides a working till behind it (M6)', async () => {
    serve({
      [A]: {'/api/v1/till': {ok: false, status: 404, body: {}}}, // serves no till
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-2')}},
    });
    setRelayAddresses([A, B]);
    const outcome = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(outcome.kind).toBe('open'); // B, FURTHER DOWN, opened it
    expect(tillSessionRelay()).toBe(B); // and B — not the 404 — owns the session
    expect(requests).toEqual([`${A}/api/v1/till`, `${B}/api/v1/till`]);
  });
  test('a 4xx with no working till behind it answers not-served, pins NOTHING, and the next charge re-walks (M6)', async () => {
    serve({
      [A]: {'/api/v1/till': {ok: false, status: 404, body: {}}},
      [B]: {'/api/v1/till': 'reject'},
    });
    setRelayAddresses([A, B]);
    const outcome = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(outcome.kind).toBe('not-served');
    if (outcome.kind !== 'not-served') return;
    expect(outcome.addr).toBe(A); // the sentence names the relay that actually answered
    expect(tillSessionRelay()).toBeNull(); // a relay that serves no till does not own the session
    // The next charge re-walks: nothing short-circuits it back to A's 404.
    requests.length = 0;
    const again = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(again.kind).toBe('not-served');
    expect(requests[0]).toBe(`${A}/api/v1/till`); // A asked again — the walk retried
  });
});

describe('failure attribution — a dead relay is named by who was actually asked (M5)', () => {
  test('a mid-session failure names the PIN, never the preferred URL', async () => {
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-5')}},
    });
    setRelayAddresses([A, B]);
    await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW); // pins B
    expect(tillSessionRelay()).toBe(B);
    requests.length = 0;
    serve({}); // everything is down now — including the pin
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
      expect(outcome.kind).toBe('unreachable');
      if (outcome.kind !== 'unreachable') return;
      expect(outcome.tried).toEqual([B]); // the pin ALONE — the caller's A was never asked
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toContain(B); // the diagnostics name the relay actually tried
      expect(said).not.toContain(A); // …not the preferred URL that was not
      expect(requests).toEqual([`${B}/api/v1/till`]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the pin holds while the list carries its address, and dies when it does not', () => {
  test('still in the list (REORDERED): every call goes to the pin ALONE — no walk, not even the caller\'s own address outranks it', async () => {
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {
        '/api/v1/till': {ok: true, status: 200, body: openOk('charge-3')},
        [`/api/v1/till/charge-3`]: {ok: true, status: 200, body: paidStatus('charge-3')},
      },
    });
    setRelayAddresses([A, B]);
    await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    // The operator REORDERS the list mid-session (B promoted to preferred): the charge still
    // lives on B and B is still a configured address, so the session must not move — even with
    // the caller passing A, a list member, as its own preferred URL.
    setRelayAddresses([B, A]);
    requests.length = 0;
    serve({
      [B]: {[`/api/v1/till/charge-3`]: {ok: true, status: 200, body: paidStatus('charge-3')}},
    });
    const outcome = await tillChargeStatus(A, 'charge-3');
    expect(outcome.kind).toBe('status');
    expect(requests).toEqual([`${B}/api/v1/till/charge-3`]); // the pin, not a walk over [B, A]
    expect(tillSessionRelay()).toBe(B);
  });
  test('address REMOVED from the list: the pin is dead and the call walks the NEW list — no shadow connection to the removed relay', async () => {
    // e2e flow 116's fix: an operator who re-points the list away from the relay a charge was
    // opened on must not leave the app quietly asking that relay behind their back. The pin
    // dies with its membership; the call becomes the normal walk over the new list, and a 2xx
    // from THAT walk re-pins (a session the current list endorses).
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-7')}},
    });
    setRelayAddresses([A, B]);
    await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW); // pins B
    expect(tillSessionRelay()).toBe(B);
    // The operator re-points the list at [C(dead), D]; B is gone from it.
    setRelayAddresses([C, D]);
    requests.length = 0;
    serve({
      [C]: {[`/api/v1/till/charge-7`]: 'reject'},
      [D]: {[`/api/v1/till/charge-7`]: {ok: true, status: 200, body: paidStatus('charge-7')}},
      [B]: {[`/api/v1/till/charge-7`]: {ok: true, status: 200, body: paidStatus('charge-7')}},
    });
    const outcome = await tillChargeStatus(C, 'charge-7');
    expect(outcome.kind).toBe('status');
    // The walk over the NEW list — C dead, D answers. B still serves the charge and is NEVER
    // asked: that is the whole point of the membership rule.
    expect(requests).toEqual([`${C}/api/v1/till/charge-7`, `${D}/api/v1/till/charge-7`]);
    expect(tillSessionRelay()).toBe(D); // the 2xx under the current list owns the session now
  });
  test('address REMOVED and the new list is DEAD: the status poll answers unchecked and the void answers unreachable naming the NEW list (e2e 116 stage 1)', async () => {
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-8')}},
    });
    setRelayAddresses([A, B]);
    await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW); // pins B
    // The operator re-points the list at an unreachable address; B is gone from it.
    setRelayAddresses([C]);
    requests.length = 0;
    serve({}); // everything is down — B included, but B must not be asked at all
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The POLL: TillStatusOutcome's "could not reach" is `unchecked` (rule 2 — never
      // "unpaid", never "still waiting") — the state TillCharge renders as "Can't check this
      // charge right now".
      const poll = await tillChargeStatus(C, 'charge-8');
      expect(poll.kind).toBe('unchecked');
      expect(requests).toEqual([`${C}/api/v1/till/charge-8`]); // the dead list was walked; the pin was not
      // The VOID path shares `tillFetch`, so the same membership rule governs it: its
      // unreachable outcome carries the addresses actually tried.
      const voidOutcome = await cancelTillCharge(C, MERCHANT);
      expect(voidOutcome.kind).toBe('unreachable');
      if (voidOutcome.kind !== 'unreachable') return;
      expect(voidOutcome.tried).toEqual([C]);
      expect(tillSessionRelay()).toBeNull(); // the dead pin was dropped, not parked
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).not.toContain(B); // the removed relay is never blamed — it was never asked
    } finally {
      warn.mockRestore();
    }
  });
  test('a new session (resetTillRelayPinForTest) walks again from the top', async () => {
    serve({
      [A]: {'/api/v1/till': 'reject'},
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-4')}},
    });
    setRelayAddresses([A, B]);
    await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(tillSessionRelay()).toBe(B);
    resetTillRelayPinForTest();
    expect(tillSessionRelay()).toBeNull();
    const outcome = await openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    expect(outcome.kind).toBe('open'); // walked A (dead) → B again
    expect(requests.filter((u) => u === `${A}/api/v1/till`)).toHaveLength(2);
  });
});

describe('wave-2 — the pin guard: a stale walk never pins, and void-unreachable names its hosts', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a walk that outlived a list edit may still ANSWER, but pins NOTHING (the revision moved)', async () => {
    // The design gap this closes: A hangs (holding the walk open on the clock), the operator
    // re-points the list mid-walk, and only THEN does B answer. B's 200 is a fact — the per-call
    // outcome stands — but B earned it under the OLD list. Pinning would keep talking to an
    // address list the operator just replaced until the app restarts, so a stale walk must not.
    serve({
      [A]: {'/api/v1/till': 'hang'}, // accepts TCP, never answers
      [B]: {'/api/v1/till': {ok: true, status: 200, body: openOk('charge-6')}},
    });
    setRelayAddresses([A, B]);
    const p = openTillCharge(A, MERCHANT, String(GOLDEN.input.cents), 8, VCHF_FEE_RAW);
    // Park the walk on the hung A FIRST: signedBody is async, so the fetch issues a microtask hop
    // after the call — the revision bump below must land genuinely MID-walk, not before the walk
    // began (a bump before tillFetch captured its revision would guard against itself).
    for (let i = 0; i < 10 && !requests.some((u) => u === `${A}/api/v1/till`); i++) {
      await Promise.resolve();
    }
    expect(requests).toContain(`${A}/api/v1/till`); // the walk is live on the hung A
    // While A hangs, the operator re-points the list (revision N → N+1): B stays, A is REMOVED.
    setRelayAddresses([B]);
    await jest.advanceTimersByTimeAsync(15_000); // TILL_TIMEOUT_MS backstop expires the hung A
    const outcome = await p;
    expect(outcome.kind).toBe('open'); // the walk still finished — its answer is per-call truth
    expect(requests).toContain(`${B}/api/v1/till`); // B really was reached…
    expect(tillSessionRelay()).toBeNull(); // …but a walk under the OLD list pins nothing
  });

  test('void-unreachable carries the walked addresses — the cashier reads WHO never answered', async () => {
    // Symmetric with the OPEN path's `tried` (rendered by TillCharge's failure copy): a
    // cancellation that could not clear the till names the addresses actually tried.
    serve({
      [A]: {'/api/v1/till/void': 'reject'},
      [B]: {'/api/v1/till/void': 'reject'},
    });
    setRelayAddresses([A, B]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await cancelTillCharge(A, MERCHANT);
      expect(outcome.kind).toBe('unreachable');
      if (outcome.kind !== 'unreachable') return;
      expect(outcome.tried).toEqual([A, B]); // the whole walk, in order
    } finally {
      warn.mockRestore();
    }
  });
});
