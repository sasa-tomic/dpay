/**
 * Multi-venue readiness V9 — the NINE venue-agnostic invariants (jest half; the relay Rust half
 * lives in `crates/dpay-relay` — `catalog.rs` `venue_truth_tests` for the allowlist, `tests/relay.rs`
 * for the query-only surface + verbatim echo). Waves 1–3 pinned these per-flow against the ONE
 * PoC venue; nothing there would fail if venue #2 crossed a red line. This suite is parametric
 * over the WHOLE venue registry — the bundled table, the runtime overlay (the relay's served list,
 * incl. offline fixture B), and SYNTHETIC hostile venues injected through the same overlay seam —
 * so a crossing by ANY venue fails:
 *
 *   INV-1 every signed envelope targets the user's own ledger or an allowlisted venue endpoint,
 *        never a dpay principal (prepareConvertRecord across every registered venue; a hostile
 *        registry row whose endpoint IS a dpay canister is refused at the signing boundary);
 *   INV-2 every beneficiary is the user's own principal (approve spender = the venue endpoint;
 *        the swap arg carries no recipient; the settle probe matches only to=user from=venue);
 *   INV-4 the quoted number is the venue's reply byte-for-byte (fetchConvertQuote parametric —
 *        the render half is in convertMode.test.tsx, the relay half in tests/relay.rs);
 *   INV-7 the approval is bounded per venue (exact amount + fee, expected_allowance ABSENT —
 *        ICRC-2 compares it with the CURRENT allowance, so a baked figure refuses with
 *        AllowanceChanged on the first-ever approve; the bound is the ≤10-min expiry — the
 *        encoder inputs are pinned here; the arg BYTES are the
 *        compiled core's goldens, `crates/dpay-icp` tests);
 *   INV-9 no swap submit traverses a dpay-hosted origin (executeConvert submits each leg to its
 *        own canister; the relay is only ever asked settlement READS — the transport's own URL
 *        derivation is pinned in icpBoundary.test.ts);
 *   WAVE-3 the named recovery invariants, consolidated as named and strengthened to full
 *        matrices (their scenario twins stay in convert.test.ts / convertResume.test.ts):
 *        "expired ⇒ submitTransfer never called", "probe match ⊆ [net, gross] ∧ ∉ claimed",
 *        "provider transitions never backwards".
 *
 * INV-3 (relay query-only) and INV-8 (no convert CTA on pay surfaces) have no jest half by
 * design — e2e flow 170 / relay tests own them.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn(), fetchWithTimeout: jest.fn()}));
jest.mock('../services/rail', () => ({submitTransfer: jest.fn()}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {fetchWithTimeout, relayFetch} from '../services/relay';
import {submitTransfer} from '../services/rail';
import {
  executeConvert,
  fetchConvertQuote,
  prepareConvertRecord,
  probeConvertSettlement,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {advanceProviderRecord, startConvertResumeEngine, __resetConvertResumeEngineForTest} from '../convertResume';
import {CONVERT_APPROVE_LIFETIME_S} from '../config/convert';
import {BUNDLED_VENUES, DPAY_CANISTER_PRINCIPALS, setRuntimeVenues, type VenueEntry} from '../config/venues';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {convertEn} from '../i18n/domains/en/convert';

// --- the shared fixtures ---------------------------------------------------------------------------

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ICP_DESC = BUNDLED.find(c => c.currency === 8)!;
const VCHF_DESC = BUNDLED.find(c => c.currency === 7)!;
const ICP_LEDGER = ICP_DESC.ledger;
const VCHF_LEDGER = VCHF_DESC.ledger;

const VENUE_A = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)!;
// The fixture-B pool as the offline test relay serves it (dfx/catalog_truth.json venues[]).
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7';
// An invented principal-shaped endpoint that is nobody — a hostile THIRD venue's "pool".
const POOL_C = '2xh5b-7xkab-aaaaa-qbkcq-cai';

const venueRow = (over: Partial<VenueEntry>): VenueEntry => ({
  venue_id: 'synthetic',
  display_name: 'Synthetic Venue',
  kind: 'ic_amm',
  endpoint: POOL_C,
  pair_ledgers: [ICP_LEDGER, VCHF_LEDGER],
  testnet: false,
  disclosure_key: 'icpswap',
  ...over,
});

const VENUE_B = venueRow({
  venue_id: 'icpswap-fixture-b',
  display_name: 'ICPSwap (offline fixture)',
  endpoint: POOL_B,
  testnet: true,
});
// A rank-bait NAME is part of the hostile surface: nothing may sort/rank/label by it (INV-5's
// render half), and no copy may hardcode a venue's name where a parameter belongs.
const VENUE_C = venueRow({venue_id: 'hostile-rankbait', display_name: 'Best Rate Swap ⚡ Zero Fees'});
// The dpay-owned principals AS venue endpoints — the §0 red line in registry form.
const HOSTILE_FACADE = venueRow({
  venue_id: 'hostile-dpay-facade',
  display_name: 'dpay "Swap" (hostile registry row)',
  endpoint: DPAY_CANISTER_PRINCIPALS[0],
});
const HOSTILE_LEDGER = venueRow({
  venue_id: 'hostile-dpay-ledger',
  display_name: 'DEMO Convert (hostile registry row)',
  endpoint: DPAY_CANISTER_PRINCIPALS[1],
});

/** Every venue set is injected through the SAME seam production code reads (the runtime overlay
 *  `loadVenueRegistry` arms) — parametric over the registry, never over a bespoke fixture. */
const SETS: readonly {name: string; venues: readonly VenueEntry[]}[] = [
  {name: 'bundled registry (one venue)', venues: [VENUE_A]},
  {name: 'two venues (real + offline fixture B)', venues: [VENUE_A, VENUE_B]},
  {name: 'three venues (real + fixture B + rank-bait hostile name)', venues: [VENUE_A, VENUE_B, VENUE_C]},
];

const MATH: ConvertMath = {
  amountIn: '100000000',
  grossOut: '190000000',
  minOut: '188000000',
  netOut: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
};

const quoteFor = (v: VenueEntry, over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: v.venue_id,
  pool: v.endpoint,
  tokenInLedger: ICP_LEDGER,
  tokenOutLedger: VCHF_LEDGER,
  amountIn: '100000000',
  amountOutGross: '190000000',
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: 1_000,
  ...over,
});

const recordFor = (v: VenueEntry, over: Partial<ConvertRecord> = {}): ConvertRecord => ({
  id: 'rec1',
  createdAtMs: 1,
  step: 'approving',
  venueId: v.venue_id,
  inCurrency: 8,
  outCurrency: 7,
  inLedger: ICP_LEDGER,
  outLedger: VCHF_LEDGER,
  inSymbol: 'ICP',
  outSymbol: 'VCHF',
  amountIn: '100000000',
  expectedGross: '190000000',
  expectedNet: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  legs: [
    {
      canister: ICP_LEDGER,
      method: 'icrc2_approve',
      argHex: 'approvearg',
      envelopeHex: 'aacc',
      requestIdHex: 'bbdd',
      expiresAtMs: Date.now() + 600_000,
    },
    {
      canister: v.endpoint,
      method: 'depositFromAndSwap',
      argHex: 'swaparg',
      envelopeHex: 'ccaa',
      requestIdHex: 'ddbb',
      expiresAtMs: Date.now() + 600_000,
    },
  ],
  ...over,
});

const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
// Probe fixtures must look NEWER than any record's createdAtMs (the 2026-09-19 probe floor
// ignores rows that predate the record — index timestamps are absolute).
const NOW = (): number => Math.floor(Date.now() / 1000) + 3600;
const myPrincipal = 'myprincipal123';
const OPTS = {submitAttempts: 2, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 2, settleIntervalMs: 0};
const EXEC_DEPS = () => ({secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r', onUpdate: jest.fn()});

/** Every venue in a set that the IC-AMM rail could execute (the dpay-endpoint hostile rows are
 *  refused — they are NOT executable venues, which is exactly INV-1's point). */
const executable = (venues: readonly VenueEntry[]) =>
  venues.filter(v => v.kind === 'ic_amm' && !DPAY_CANISTER_PRINCIPALS.includes(v.endpoint));

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex' as never);
  jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex' as never);
  jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s: string, canister: string, method: string) =>
    ({envelopeHex: `env-${method}-${canister}`, requestIdHex: `rid-${method}`} as never));
  jest.mocked(icStampExpiry).mockResolvedValue('1800000000000000000' as never);
});

afterEach(() => {
  setRuntimeVenues(null);
});

// --- INV-1: targets are the user's own ledger or an allowlisted venue endpoint — never dpay -------

describe('INV-1 — every signed envelope targets the user\'s own ledger or the venue\'s registered endpoint', () => {
  describe.each(SETS)('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).map(v => [v.venue_id, v] as const) )
    ('venue %s signs exactly [own input ledger, this venue\'s endpoint]', async (_id, v) => {
      const rec = await prepareConvertRecord({
        secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(v), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
      });
      // Both legs, in order: the user's OWN ledger carries the approve; the venue endpoint is
      // the only other canister anything is ever signed against.
      expect(rec.legs.map(l => l.canister)).toEqual([ICP_LEDGER, v.endpoint]);
      expect(rec.legs[0]!.method).toBe('icrc2_approve');
      expect(rec.legs[1]!.method).toBe('depositFromAndSwap');
      // The approve's SPENDER is the venue endpoint (the pool that pulls) — no third principal.
      const approveCall = jest.mocked(DpayCore.icpApproveArg).mock.calls.at(-1)!;
      expect(approveCall[0]).toBe(v.endpoint);
      // Every signed update names one of exactly those two targets.
      for (const call of jest.mocked(DpayCore.icpSignUpdate).mock.calls) {
        expect([ICP_LEDGER, v.endpoint]).toContain(call[1]);
      }
    });
  });

  test('a hostile registry row whose endpoint IS a dpay canister is refused at the signing boundary', async () => {
    setRuntimeVenues([VENUE_A, HOSTILE_FACADE, HOSTILE_LEDGER]);
    for (const hostile of [HOSTILE_FACADE, HOSTILE_LEDGER]) {
      await expect(prepareConvertRecord({
        secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(hostile), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
      })).rejects.toThrow(convertEn.errors.quoteUnavailable('venue'));
    }
    // Refused BEFORE anything is built or signed — no arg, no envelope, no record.
    expect(DpayCore.icpApproveArg).not.toHaveBeenCalled();
    expect(DpayCore.icpDepositAndSwapArg).not.toHaveBeenCalled();
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });

  test('a quote whose attribution and target disagree is refused (venue A\'s name on B\'s pool / an unknown venue)', async () => {
    setRuntimeVenues([VENUE_A, VENUE_B]);
    // venueId = A, pool = B's endpoint: the executor would submit B while settlement watches A.
    await expect(prepareConvertRecord({
      secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(VENUE_A, {pool: VENUE_B.endpoint}), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
    })).rejects.toThrow(convertEn.errors.quoteUnavailable('pool'));
    // A venue the registry does not know at all.
    await expect(prepareConvertRecord({
      secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(venueRow({venue_id: 'ghost'})), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
    })).rejects.toThrow(convertEn.errors.quoteUnavailable('pool'));
    // And the registry being DISARMED (relay registry never loaded) is not an execution path
    // either — the bundled table still resolves the PoC venue, but a fixture quote does not.
    setRuntimeVenues(null);
    await expect(prepareConvertRecord({
      secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(VENUE_B), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
    })).rejects.toThrow(convertEn.errors.quoteUnavailable('pool'));
    expect(DpayCore.icpSignUpdate).not.toHaveBeenCalled();
  });

  test('DPAY_CANISTER_PRINCIPALS mirrors canister_ids.json (drift alarm — a new dpay canister must extend the denylist)', () => {
    const ids = JSON.parse(readFileSync(join(__dirname, '..', '..', 'canister_ids.json'), 'utf8')) as Record<string, {ic: string}>;
    expect(DPAY_CANISTER_PRINCIPALS).toEqual(Object.values(ids).map(entry => entry.ic));
  });
});

// --- INV-2: the only beneficiary is the user's own principal ---------------------------------------

describe('INV-2 — every beneficiary is the user\'s own principal', () => {
  describe.each(SETS)('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).map(v => [v.venue_id, v] as const) )
    ('venue %s: payout matches only from ITS endpoint TO the user — never to anyone else', async (_id, v) => {
      jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
      jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
        (String(path).includes('currency=7')
          ? rowsRes([
              {from: v.endpoint, to: 'someoneelse', amount: '190000000', currency: 7, block: 43},
              {from: v.endpoint, to: myPrincipal, amount: '190000000', currency: 7, block: 44, timestamp: NOW()},
            ])
          : rowsRes([])) as never);
      const seen = await probeConvertSettlement({
        relayUrl: 'http://r', publicHex: 'pub', myPrincipalLower: myPrincipal, record: recordFor(v, {step: 'settling'}),
      });
      expect(seen).toEqual({kind: 'output', amount: '190000000', tx: '44'});
    });
  });

  test('the swap arg carries NO beneficiary at all — the pool pays the caller (approve spender pinned in INV-1)', async () => {
    setRuntimeVenues([VENUE_A]);
    await prepareConvertRecord({
      secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(VENUE_A), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
    });
    // (amountIn, minOut, inFee, outFee, zeroForOne) — five values, not one of them a principal.
    const args = jest.mocked(DpayCore.icpDepositAndSwapArg).mock.calls.at(-1)!;
    expect(args).toHaveLength(5);
    expect(args.slice(0, 4).every(a => /^[0-9]+$/.test(String(a)))).toBe(true);
    expect(args[4]).toBe(true);
  });

  // Provider shapes (CeFi): a providerRef record has legs: [] — there is nothing to scan and
  // nothing to sign; the store refuses a legless record without a providerRef. Both are pinned
  // by convert.test.ts hydrateConvertStore/prepare suites — named here, not duplicated.
});

describe('INV-2 (multi-venue half) — a venue\'s settlement never claims another venue\'s payout', () => {
  // Only meaningful with 2+ executable venues in the registry (jest `each` refuses empty tables).
  describe.each(SETS.filter(s => executable(s.venues).length > 1))('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).flatMap(v => executable(venues).filter(o => o !== v).map(o => [v.venue_id, o.venue_id, v, o] as const)) )
    ('settlement of a %s record never matches rows paid by %s', async (_a, _b, mine, other) => {
      jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
      // The OTHER venue's pool pays the user the exact expected amount — still no match: the
      // counterparty identity is part of the match, not just the figures.
      jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
        (String(path).includes('currency=7')
          ? rowsRes([{from: other.endpoint, to: myPrincipal, amount: '190000000', currency: 7, block: 42, timestamp: NOW()}])
          : rowsRes([])) as never);
      const seen = await probeConvertSettlement({
        relayUrl: 'http://r', publicHex: 'pub', myPrincipalLower: myPrincipal, record: recordFor(mine, {step: 'settling'}),
      });
      expect(seen).toBeNull();
    });
  });
});

// --- INV-4: the quoted number is the venue's reply, byte-for-byte (app half) ------------------------

describe('INV-4 — fetchConvertQuote returns the venue\'s own number byte-for-byte (relay echo → ConvertQuote)', () => {
  describe.each(SETS)('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).map(v => [v.venue_id, v] as const) )
    ('venue %s: a mutated pool reply moves the quote identically', async (_id, v) => {
      const served = {
        venue_id: v.venue_id,
        pool: v.endpoint,
        token_in: ICP_LEDGER,
        token_out: VCHF_LEDGER,
        amount_in: '100000000',
        // The "mutated pool output" — some number no default would produce.
        amount_out: '137777777',
        zero_for_one: true,
        fee_millionths: 1234,
        fetched_at: 1_690_000_000,
      };
      jest.mocked(relayFetch).mockResolvedValue(fakeRes(served) as never);
      const q = await fetchConvertQuote('http://r', ICP_LEDGER, VCHF_LEDGER, '100000000', {venue: v});
      expect(q.amountOutGross).toBe('137777777'); // the venue's digits, unrounded and unblended
      expect(q.venueId).toBe(v.venue_id);
      expect(q.pool).toBe(v.endpoint);
      expect(q.feeMillionths).toBe(1234); // the venue's OWN tier, echoed
      expect(q.fetchedAtMs).toBe(1_690_000_000_000); // seconds → ms, nothing else derived
      // And the quote ASKED this venue's own pool (the registry row's endpoint is the query key).
      const path = String(jest.mocked(relayFetch).mock.calls[0]![1]);
      expect(path).toContain(`pool=${v.endpoint}`);
    });
  });
});

// --- INV-7: the approval is bounded per venue --------------------------------------------------------

describe('INV-7 — the approve leg is bounded: exact amount + fee, expected_allowance semantics, ≤ 10 min', () => {
  describe.each(SETS)('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).map(v => [v.venue_id, v] as const) )
    ('venue %s approves exactly amountIn + inFee, once, expiring inside the 10-minute window', async (_id, v) => {
      const rec = await prepareConvertRecord({
        secretHex: 'sec', relayUrl: 'http://r', quote: quoteFor(v), math: MATH, inDesc: ICP_DESC, outDesc: VCHF_DESC,
      });
      // The encoder INPUTS are the decoded approve semantics (the arg bytes are the compiled
      // core's own goldens — crates/dpay-icp): (spender, '', '', amount, expected, expiry, memo, fee).
      const [spender, , , amount, expected, , memo, fee] =
        jest.mocked(DpayCore.icpApproveArg).mock.calls.at(-1)!;
      expect(spender).toBe(v.endpoint);
      expect(amount).toBe('100010000'); // amountIn + inFee — EXACTLY, no rounding headroom
      // expected_allowance stays ABSENT (the 2026-09-19 live defect): ICRC-2 compares it with
      // the CURRENT allowance, so any baked figure refuses with AllowanceChanged whenever it
      // differs — the first-ever approve included (current 0 ≠ amount). The "second pull"
      // bound still holds: the allowance EXPIRES at now+CONVERT_APPROVE_LIFETIME_S, and each
      // conversion re-approves from zero.
      expect(expected).toBe('');
      expect(memo).toBe('');
      expect(fee).toBe(MATH.inFee); // the ledger's own fee, not a venue tier
      // The allowance lifetime comes from the certified clock + CONVERT_APPROVE_LIFETIME_S…
      expect(icStampExpiry).toHaveBeenCalledWith('sec', CONVERT_APPROVE_LIFETIME_S);
      // …and the persisted legs die at the ENVELOPES' OWN ingress expiry — the exact stamp
      // icStampExpiry returned for signing (the beforeEach mock pins it at
      // 1_800_000_000_000_000_000 ns), converted ns → ms. The old pin here (legs outliving
      // the envelopes by up to 10 min) conflated the ALLOWANCE's death with the envelopes'
      // ~5-min ingress death — two different deaths; the never-resubmit boundary now ends
      // exactly at the real submit-death, never later.
      expect(rec.legs[0]!.expiresAtMs).toBe(1_800_000_000_000);
      expect(rec.legs[1]!.expiresAtMs).toBe(rec.legs[0]!.expiresAtMs);
    });
  });
});

// --- INV-9: no swap submit traverses a dpay-hosted origin -------------------------------------------

describe('INV-9 — every leg submits to ITS canister at the IC boundary; the relay is only ever read', () => {
  describe.each(SETS)('registry: $name', ({venues}) => {
    beforeEach(() => {
      setRuntimeVenues(venues);
    });

    test.each( executable(venues).map(v => [v.venue_id, v] as const) )
    ('venue %s: executeConvert submits [own ledger, venue endpoint] and asks the relay only settlement reads', async (_id, v) => {
      const d = EXEC_DEPS();
      jest.mocked(submitTransfer)
        .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
        .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never);
      jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
      jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
        (String(path).includes('currency=7')
          ? rowsRes([{from: v.endpoint, to: myPrincipal, amount: '190000000', currency: 7, block: 77, timestamp: NOW()}])
          : rowsRes([])) as never);
      const final = await executeConvert(recordFor(v), d, OPTS);
      expect(final.step).toBe('done');
      // The two submits target exactly the two leg canisters — the input ledger and the venue
      // endpoint — and no dpay principal is among them.
      const targets = jest.mocked(submitTransfer).mock.calls.map(c => (c[0] as {ledger: string}).ledger);
      expect(targets).toEqual([ICP_LEDGER, v.endpoint]);
      for (const principal of DPAY_CANISTER_PRINCIPALS) expect(targets).not.toContain(principal);
      // No submit carries the relay URL in ANY argument — the rail's transport derives its
      // origin from the IC gateway, never from the relay (pinned in icpBoundary.test.ts).
      for (const call of jest.mocked(submitTransfer).mock.calls) {
        expect(JSON.stringify(call)).not.toContain('http://r');
      }
      // Every relay request the executor made was a settlement probe (a READ of transactions).
      expect(jest.mocked(relayFetch).mock.calls.length).toBeGreaterThan(0);
      for (const call of jest.mocked(relayFetch).mock.calls) {
        expect(String(call[1])).toMatch(/^\/api\/v1\/transactions\//);
      }
    });
  });
});

// --- Wave-3 named recovery invariants (consolidated; scenario twins live in convert.test.ts) --------

describe('Wave-3 recovery invariant — "expired legs ⇒ submitTransfer is NEVER called"', () => {
  const expiredLegs = (v: VenueEntry) =>
    recordFor(v).legs.map(l => ({...l, expiresAtMs: Date.now() - 60_000}));

  test.each(['approving', 'approved', 'swapping'] as const)
  ('%s + expired legs parks without a single submit (outcome unknown, resubmission forbidden)', async step => {
    setRuntimeVenues([VENUE_A, VENUE_B]);
    for (const v of [VENUE_A, VENUE_B]) {
      jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
      jest.mocked(relayFetch).mockResolvedValue(rowsRes([]) as never);
      const final = await executeConvert(recordFor(v, {step, legs: expiredLegs(v)}), EXEC_DEPS(), OPTS);
      expect(final.step).toBe('stuck');
    }
    expect(submitTransfer).not.toHaveBeenCalled();
  });

  test('expired + the payout already landed resolves to done — still without submitting anything', async () => {
    setRuntimeVenues([VENUE_A, VENUE_B]);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=7')
        ? rowsRes([{from: VENUE_B.endpoint, to: myPrincipal, amount: '189995000', currency: 7, block: 555, timestamp: NOW()}])
        : rowsRes([])) as never);
    const final = await executeConvert(
      recordFor(VENUE_B, {step: 'swapping', legs: expiredLegs(VENUE_B)}), EXEC_DEPS(), OPTS);
    expect(final.step).toBe('done');
    expect(final.outTx).toBe('555');
    expect(submitTransfer).not.toHaveBeenCalled();
  });
});

describe('Wave-3 recovery invariant — "probe match ⊆ [net, gross] ∧ ∉ claimed"', () => {
  const probe = async (amount: string, exclude: ReadonlySet<string>, v: VenueEntry = VENUE_A) => {
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=7')
        ? rowsRes([{from: v.endpoint, to: myPrincipal, amount, currency: 7, block: 900, timestamp: NOW()}])
        : rowsRes([])) as never);
    return probeConvertSettlement({
      relayUrl: 'http://r', publicHex: 'pub', myPrincipalLower: myPrincipal,
      record: recordFor(v, {step: 'settling'}), excludeOutTx: exclude,
    });
  };

  // net = 189990000, gross = 190000000 — the inclusive range the record itself declares.
  const RANGE_GRID: Array<[amount: string, shouldMatch: boolean]> = [
    ['189989999', false], // one unit BELOW net — never a match
    ['189990000', true], // net itself — inclusive
    ['189995000', true], // inside (a real pool fee path)
    ['190000000', true], // gross itself — inclusive (the pool's #ok is GROSS, not settlement)
    ['190000001', false], // one unit ABOVE gross — never a match (nobody overpaid)
  ];
  test.each(RANGE_GRID)('amount %s → match=%s', async (amount, shouldMatch) => {
    setRuntimeVenues([VENUE_A]);
    const seen = await probe(amount, new Set());
    expect(seen != null).toBe(shouldMatch);
  });

  test('a row another record already claimed is skipped — the next identical row matches', async () => {
    setRuntimeVenues([VENUE_A]);
    jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal as never);
    jest.mocked(relayFetch).mockImplementation(async (_relay: unknown, path: unknown) =>
      (String(path).includes('currency=7')
        ? rowsRes([
            {from: VENUE_A.endpoint, to: myPrincipal, amount: '190000000', currency: 7, block: 555, timestamp: NOW()},
            {from: VENUE_A.endpoint, to: myPrincipal, amount: '190000000', currency: 7, block: 556, timestamp: NOW()},
          ])
        : rowsRes([])) as never);
    const seen = await probeConvertSettlement({
      relayUrl: 'http://r', publicHex: 'pub', myPrincipalLower: myPrincipal,
      record: recordFor(VENUE_A, {step: 'settling'}), excludeOutTx: new Set(['555']),
    });
    expect(seen).toEqual({kind: 'output', amount: '190000000', tx: '556'});
  });
});

describe('Wave-3 recovery invariant — "provider transitions never move backwards" (the full matrix)', () => {
  // held × reading → the ONE allowed next step (or the same step — never an earlier one).
  // order: awaiting_user_authorization < awaiting_deposit < provider_processing < terminal.
  const MATRIX: ReadonlyArray<readonly [ConvertRecord['step'], string, Record<string, unknown> | 'unreachable', ConvertRecord['step']]> = [
    // from awaiting_user_authorization
    ['awaiting_user_authorization', 'awaiting_deposit', {status: 'pending_deposit'}, 'awaiting_deposit'],
    ['awaiting_user_authorization', 'processing', {status: 'processing'}, 'provider_processing'],
    ['awaiting_user_authorization', 'completed', {status: 'completed'}, 'awaiting_user_authorization'],
    ['awaiting_user_authorization', 'expired', {status: 'expired'}, 'quote_expired'],
    ['awaiting_user_authorization', 'refunded', {status: 'refunded'}, 'provider_refunded'],
    ['awaiting_user_authorization', 'unreachable', 'unreachable', 'awaiting_user_authorization'],
    ['awaiting_user_authorization', 'unknown', {status: 'weird-word'}, 'awaiting_user_authorization'],
    // from awaiting_deposit
    ['awaiting_deposit', 'awaiting_deposit', {status: 'pending_deposit'}, 'awaiting_deposit'],
    ['awaiting_deposit', 'processing', {status: 'processing'}, 'provider_processing'],
    ['awaiting_deposit', 'completed', {status: 'completed'}, 'awaiting_deposit'],
    ['awaiting_deposit', 'expired', {status: 'expired'}, 'quote_expired'],
    ['awaiting_deposit', 'refunded', {status: 'refunded'}, 'provider_refunded'],
    ['awaiting_deposit', 'unreachable', 'unreachable', 'awaiting_deposit'],
    ['awaiting_deposit', 'unknown', {status: 'weird-word'}, 'awaiting_deposit'],
    // from provider_processing — the backwards hazards live here
    ['provider_processing', 'awaiting_deposit', {status: 'pending_deposit'}, 'provider_processing'],
    ['provider_processing', 'processing', {status: 'processing'}, 'provider_processing'],
    ['provider_processing', 'completed', {status: 'completed', settled_amount: '5000000', tx_id: 'tx9'}, 'done'],
    ['provider_processing', 'expired', {status: 'expired'}, 'provider_processing'],
    ['provider_processing', 'refunded', {status: 'refunded'}, 'provider_refunded'],
    ['provider_processing', 'unreachable', 'unreachable', 'provider_processing'],
    ['provider_processing', 'unknown', {status: 'weird-word'}, 'provider_processing'],
  ];

  const CTX = {secretHex: 'sec', publicHex: 'pub', relayUrl: 'http://r'};
  const FAST = {rearmMs: 5, stuckWatchMs: 5, providerPollMs: 5, executorOpts: OPTS};

  beforeEach(async () => {
    await AsyncStorage.clear();
    startConvertResumeEngine(CTX, FAST); // advanceProviderRecord persists through the engine's ctx
  });
  afterEach(() => {
    __resetConvertResumeEngineForTest();
  });

  test.each(MATRIX.map(m => [m[0], m[1], m] as const))
  ('%s + reading %s lands on the one allowed step (never backwards)', async (_held, _reading, cell) => {
    const [heldStep, , body, expected] = cell;
    jest.mocked(fetchWithTimeout).mockResolvedValue(
      (body === 'unreachable' ? {ok: false, status: 503} : {ok: true, status: 200, json: async () => body}) as never);
    const rec: ConvertRecord = recordFor(VENUE_A, {
      step: heldStep,
      legs: [],
      providerRef: {orderId: 'ocp-9', statusUrl: 'https://provider.example/o/ocp-9'},
    });
    const next = await advanceProviderRecord(rec);
    expect(next.step).toBe(expected);
  });
});

// --- the solana_amm invariants (V11 — Jupiter, 2026-09-15) -----------------------------------------
//
// The same red lines, read through the Solana rail's own shape: the registry row is
// drift-alarmed against the truth file BOTH ways; the resolver never crosses rails; the
// venue-built transaction is beneficiary-checked BEFORE the device's signature; submission
// goes through the SOL rail's own seam (never a relay URL); and the outcome vocabulary is the
// chain's own (signature status), never a node's prose.

jest.mock('../services/jupiter', () => ({fetchJupiterQuote: jest.fn(), fetchJupiterSwapTx: jest.fn()}));
jest.mock('../solana', () => ({
  submitRawSolTx: jest.fn(),
  getSolSignatureStatus: jest.fn(),
  getSolBlockHeight: jest.fn(),
  getSolTokenCredit: jest.fn(),
  getSolNativeCredit: jest.fn(),
  quoteSolMessageFee: jest.fn(),
}));

import {fetchJupiterSwapTx} from '../services/jupiter';
import {
  getSolBlockHeight, getSolSignatureStatus, getSolTokenCredit, quoteSolMessageFee, submitRawSolTx,
} from '../solana';
import {executeSolanaConvert, prepareSolanaConvertRecord} from '../convert';
import {solanaAmmVenueForMint, solanaVenuesForMint, icAmmVenueForPair} from '../config/venues';
import {deriveSolanaKeypair} from '../solana/identity';
import {deriveAta} from '../solana/spl';
import {assembleMessage, hexToBytes} from '../solana/tx';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import type {JupiterQuote} from '../services/jupiter';

describe('venue invariants — solana_amm (V11: Jupiter reaches the screen)', () => {
  const TRUTH = JSON.parse(readFileSync(join('..', 'dfx', 'catalog_truth.json'), 'utf8')) as {
    venues: {venue_id: string; display_name: string; kind: string; endpoint: string; pair_ledgers: string[]; testnet: boolean; disclosure_key: string}[];
  };
  const SECRET = '11'.repeat(32); // any 32-byte seed — the real SLIP-10 derivation runs
  const KP = deriveSolanaKeypair(SECRET);
  const BLOCKHASH = new Uint8Array(32).fill(7);
  const SWAP_PROGRAM = new Uint8Array(32).fill(9);
  const userAta = deriveAta(KP.address, USDC_MINT_ADDRESS);

  /** A venue-built legacy tx in the wire shape decodeVenueSwapTx expects (one empty sig slot). */
  const venueTx = (over: {feePayer?: Uint8Array; extraKeys?: {pubkey: Uint8Array; writable?: boolean}[]; skipUserAta?: boolean} = {}) => {
    const keys = [{pubkey: over.feePayer ?? KP.publicKey, signer: true, writable: true}];
    if (!over.skipUserAta) keys.push({pubkey: userAta, signer: false, writable: true});
    for (const k of over.extraKeys ?? []) keys.push({pubkey: k.pubkey, signer: false, writable: k.writable ?? false});
    const msg = assembleMessage(over.feePayer ?? KP.publicKey, [{programId: SWAP_PROGRAM, keys, data: new Uint8Array([1, 2, 3])}], BLOCKHASH);
    return new Uint8Array([1, ...new Array(64).fill(0), ...msg]);
  };

  const quote = (over: Partial<JupiterQuote> = {}): JupiterQuote => ({
    venueId: 'jupiter',
    inputMint: WRAPPED_SOL_MINT_ADDRESS,
    outputMint: USDC_MINT_ADDRESS,
    inAmount: '1000000000',
    outAmount: '10360000',
    otherAmountThreshold: '10250000',
    priceImpactPct: '0.003',
    slippageBps: 100,
    platformFeeBps: null,
    raw: {},
    fetchedAtMs: 1_000,
    ...over,
  });

  const built = (bytes: Uint8Array) => ({ok: true as const, swap: {swapTransaction: bytes, lastValidBlockHeight: 300_000_000}});

  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.mocked(fetchJupiterSwapTx).mockReset();
    jest.mocked(submitRawSolTx).mockReset();
    jest.mocked(getSolSignatureStatus).mockReset();
    jest.mocked(getSolBlockHeight).mockReset();
    jest.mocked(getSolTokenCredit).mockReset();
    jest.mocked(quoteSolMessageFee).mockReset();
    jest.mocked(relayFetch).mockReset();
    jest.mocked(fetchJupiterSwapTx).mockImplementation(async () => built(venueTx()));
    jest.mocked(quoteSolMessageFee).mockResolvedValue(null);
  });

  test('the bundled solana_amm registry and the truth file agree, both ways (mints, not principals)', () => {
    const truthSol = TRUTH.venues.filter(v => v.kind === 'solana_amm');
    const bundledSol = BUNDLED_VENUES.filter(v => v.kind === 'solana_amm');
    expect(truthSol.length).toBeGreaterThan(0); // V11: at least one Solana venue is registered
    expect(bundledSol.map(v => v.venue_id).sort()).toEqual(truthSol.map(v => v.venue_id).sort());
    for (const t of truthSol) {
      const b = bundledSol.find(v => v.venue_id === t.venue_id)!;
      expect(b.display_name).toBe(t.display_name);
      expect(b.endpoint).toBe(t.endpoint);
      expect([...b.pair_ledgers].sort()).toEqual([...t.pair_ledgers].sort());
      expect(b.testnet).toBe(t.testnet);
      expect(b.disclosure_key).toBe(t.disclosure_key);
      // Identifier semantics: solana_amm pair entries are MINTS — the app's own constants, and
      // never a dpay canister principal.
      for (const mint of b.pair_ledgers) {
        expect(mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
        expect(DPAY_CANISTER_PRINCIPALS).not.toContain(mint);
      }
      expect(b.endpoint).toMatch(/^https:\/\//); // an origin, never a principal
    }
    // The pair the founder named: wrapped SOL ↔ USDC(Solana), from the token registry itself.
    const jup = bundledSol.find(v => v.venue_id === 'jupiter')!;
    expect([...jup.pair_ledgers].sort()).toEqual([WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS].sort());
  });

  test('the resolver never crosses rails: solana mints resolve only the solana_amm row, IC ledgers never do', () => {
    expect(solanaAmmVenueForMint(WRAPPED_SOL_MINT_ADDRESS)?.venue_id).toBe('jupiter');
    expect(solanaAmmVenueForMint(USDC_MINT_ADDRESS)?.venue_id).toBe('jupiter');
    // EURC has its OWN row since 2026-09-16 (the SOL ↔ EURC Jupiter pair) — registry-first
    // resolution still lands the jupiter row for the mints they share.
    expect(solanaAmmVenueForMint(EURC_MINT_ADDRESS)?.venue_id).toBe('jupiter-eurc');
    expect(solanaAmmVenueForMint('garbage')).toBeNull();
    expect(solanaAmmVenueForMint(ICP_LEDGER)).toBeNull(); // an IC ledger is not a mint
    expect(icAmmVenueForPair(WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS)).toBeNull(); // and vice versa
    // A testnet solana row is as good as no row (the IC rule, carried over) — in the RUNTIME
    // overlay (the relay-served candidate list) it never appears; the bundled enable gate
    // (solanaAmmVenueForMint, the icAmmVenueForPair analog) stays drift-alarmed truth, so a
    // runtime testnet-only overlay leaves the pair unreachable end to end.
    setRuntimeVenues([{venue_id: 'jupiter-testnet', display_name: 'Jupiter (test)', kind: 'solana_amm', endpoint: 'https://t.jup.ag', pair_ledgers: [WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS], testnet: true, disclosure_key: 'jupiter'}]);
    expect(solanaVenuesForMint(WRAPPED_SOL_MINT_ADDRESS)).toEqual([]);
    setRuntimeVenues(null);
    // Both bundled rows serve the wrapped-SOL side, in registry order, never ranked.
    expect(solanaVenuesForMint(WRAPPED_SOL_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['jupiter', 'jupiter-eurc']);
    // jupiter-usdc-eurc (2026-09-19, EUR↔USD completion) makes USDC and EURC two-destination
    // mints too: their SOL-pair row first (registry order), the rail-local FX venue second.
    expect(solanaVenuesForMint(USDC_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['jupiter', 'jupiter-usdc-eurc']);
    expect(solanaVenuesForMint(EURC_MINT_ADDRESS).map(v => v.venue_id)).toEqual(['jupiter-eurc', 'jupiter-usdc-eurc']);
  });

  test('INV-1/2 (Solana): a venue tx paying from or to ANYONE but the user is refused BEFORE the signature', async () => {
    // A stranger fee payer: the tx wants someone else's key to sign — never signed by us.
    jest.mocked(fetchJupiterSwapTx).mockResolvedValue(built(venueTx({feePayer: new Uint8Array(32).fill(3), skipUserAta: true})));
    await expect(prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote(), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}})).rejects.toThrow(/venue/);
    // A stranger's destination token account: proceeds would land outside the user's own ATA.
    jest.mocked(fetchJupiterSwapTx).mockResolvedValue(built(venueTx({skipUserAta: true, extraKeys: [{pubkey: new Uint8Array(32).fill(4), writable: true}]})));
    await expect(prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote(), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}})).rejects.toThrow(/venue/);
    // A quote naming mints outside the registry pair: the venue may only run what it is registered for.
    jest.mocked(fetchJupiterSwapTx).mockResolvedValue(built(venueTx()));
    await expect(prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote({outputMint: EURC_MINT_ADDRESS}), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'EURC', mint: EURC_MINT_ADDRESS, decimals: 6}})).rejects.toThrow(/pool/);
    // A venueId that names no solana row: never reaches https.
    await expect(prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote({venueId: 'no-such-venue'}), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}})).rejects.toThrow(/venue/);
    // Nothing was signed-then-abandoned along the way: no submit ever ran.
    expect(submitRawSolTx).not.toHaveBeenCalled();
  });

  test('the happy prepare: record is Solana-shaped (legs [], one solanaLeg, venue digits verbatim)', async () => {
    const rec = await prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote(), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}});
    expect(rec.step).toBe('swapping');
    expect(rec.legs).toEqual([]);
    expect(rec.legPlan).toBeUndefined();
    expect(rec.providerRef).toBeUndefined();
    const leg = rec.solanaLeg!;
    expect(leg.protocol).toBe('solana');
    expect(leg.signedTxHex).toMatch(/^[0-9a-f]+$/); // lowercase hex, the frozen envelope
    expect(leg.lastValidBlockHeight).toBe(300_000_000);
    // The signature is the user's own over the venue's own message (ed25519, verified by the
    // codec's own round-trip — a mismatch would have thrown at prepare).
    expect(leg.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    // Venue digits verbatim: the estimate and the floor are Jupiter's own strings.
    expect(rec.amountIn).toBe('1000000000');
    expect(rec.expectedGross).toBe('10360000');
    expect(rec.expectedNet).toBe('10250000');
    expect(rec.inFee).toBe('0');
    expect(rec.outFee).toBe('0');
    // Money has not moved at prepare: nothing was submitted.
    expect(submitRawSolTx).not.toHaveBeenCalled();
  });

  test('INV-9 (Solana): submission goes through the SOL rail seam — the relay is never in the path', async () => {
    const rec = await prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote(), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}});
    const leg = rec.solanaLeg!;
    jest.mocked(submitRawSolTx).mockResolvedValue(leg.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed'});
    jest.mocked(getSolTokenCredit).mockResolvedValue('10360000');
    const onUpdate = jest.fn((_r: ConvertRecord) => undefined);
    const done = await executeSolanaConvert(rec, {publicHex: 'ab'.repeat(32), solAddress: KP.address, onUpdate}, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    // The EXACT signed bytes were submitted (identical-bytes discipline; the chain dedups).
    expect(submitRawSolTx).toHaveBeenCalledTimes(1);
    const submitted = jest.mocked(submitRawSolTx).mock.calls[0][0] as Uint8Array;
    expect(Array.from(submitted)).toEqual(Array.from(hexToBytes(leg.signedTxHex)!));
    // No relay URL anywhere in the submission args (the RPC seam takes bytes, not origins).
    for (const call of jest.mocked(submitRawSolTx).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('http');
    }
    expect(relayFetch).not.toHaveBeenCalled();
    // The honest end state: the REALIZED chain credit, not the estimate.
    expect(done.step).toBe('done');
    expect(done.outAmountNet).toBe('10360000');
    expect(done.outTx).toBe(leg.signature);
  });

  test('recovery vocabulary: a node signature that is not ours parks stuck; a failed tx refunds honestly', async () => {
    const rec = await prepareSolanaConvertRecord({secretHex: SECRET, relayUrl: 'http://relay', quote: quote(), inAsset: {symbol: 'SOL', mint: WRAPPED_SOL_MINT_ADDRESS, decimals: 9}, outAsset: {symbol: 'USDC', mint: USDC_MINT_ADDRESS, decimals: 6}});
    // A FOREIGN node signature: not our bytes — park, never guess, never re-sign.
    jest.mocked(submitRawSolTx).mockResolvedValue('SomeOtherSignature1111111111111111111111111111111');
    let next = await executeSolanaConvert(rec, {publicHex: 'ab'.repeat(32), solAddress: KP.address, onUpdate: jest.fn((_r: ConvertRecord) => undefined)}, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(next.step).toBe('stuck');
    expect(next.failureDetail).toBe('signature-mismatch');
    expect(submitRawSolTx).toHaveBeenCalledTimes(1); // no second round after a mismatch
    // The chain confirming WITH an error: the route did not run; input unmoved.
    jest.mocked(submitRawSolTx).mockResolvedValue(rec.solanaLeg!.signature);
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: {InstructionError: [0, {Custom: 1}]}, confirmationStatus: 'confirmed'});
    next = await executeSolanaConvert(rec, {publicHex: 'ab'.repeat(32), solAddress: KP.address, onUpdate: jest.fn((_r: ConvertRecord) => undefined)}, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(next.step).toBe('failed_refunded');
    expect(next.failureCode).toBe('swap_refused');
    // Past the blockhash's death, unseen: the bytes can NEVER land — resolved, not parked.
    jest.mocked(getSolSignatureStatus).mockResolvedValue(null);
    jest.mocked(getSolBlockHeight).mockResolvedValue(300_000_001);
    next = await executeSolanaConvert(rec, {publicHex: 'ab'.repeat(32), solAddress: KP.address, onUpdate: jest.fn((_r: ConvertRecord) => undefined)}, {submitAttempts: 1, confirmAttempts: 1, pollIntervalMs: 0});
    expect(next.step).toBe('failed_refunded');
    expect(next.failureDetail).toBe('blockhash-expired');
  });
});
