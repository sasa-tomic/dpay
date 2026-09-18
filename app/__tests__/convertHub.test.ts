/**
 * The IC hub 2-hop widening (2026-09-18, spec §11): the pure hub route walk over the
 * REGISTERED surfaces (app/routes.ts hubRoutes — no hardcoded hub, fail-closed on any
 * missing number), the FOUR-leg prepare (one intent, one signing pass, quote2 sized on
 * math1.minOut — the compounding floor), record hydration for the hub shape (additive —
 * the shipped v2 two-leg and Route A five-leg records MUST stay byte-identical), and the
 * planned executor's hub branches: the per-swap payout watch (swap2's DEST row IS the
 * terminal evidence — done with the SEEN amount), the hub refusal taxonomy (swap2 refusal
 * is failed_leg, never failed_refunded — the input already converted), and the expiry
 * trichotomy (DEST payout → done, HUB payout → failed_leg, else stuck).
 * The arg/envelope BYTES are the compiled core's; the FFI is mocked and its CALLS pinned.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpWithdrawErc20Arg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
    icpDecodeSwapResult: jest.fn(),
    icpDecodeMinterOk: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({relayFetch: jest.fn()}));
jest.mock('../services/rail', () => ({
  submitTransfer: jest.fn(),
  fetchGasFeeWei: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));

import {DpayCore} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {relayFetch} from '../services/relay';
import {submitTransfer} from '../services/rail';
import {
  executeConvert,
  hydrateConvertStore,
  isHubConvertRecord,
  prepareHubConvertRecord,
  type ConvertMath,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {hubRoutes, type HubRoute} from '../routes';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {resolveConvertDestinations} from '../config/convert';
import {setRuntimeVenues, type VenueEntry} from '../config/venues';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const rowOf = (currency: number) => BUNDLED.find(c => c.currency === currency)!;
const ICP_LEDGER = rowOf(8).ledger!;
const VCHF_LEDGER = rowOf(7).ledger!;
const CKUSDC_LEDGER = rowOf(2).ledger!;
const CKETH_LEDGER = rowOf(6).ledger!;
const CKBTC_LEDGER = rowOf(1).ledger!;
const VEUR_LEDGER = rowOf(9).ledger!;
const POOL1 = '65mrh-fqaaa-aaaar-qapoa-cai'; // icpswap (VCHF/ICP) — the registry's own endpoint
const POOL2 = 'angxa-baaaa-aaaag-qcvnq-cai'; // icpswap-cketh (ICP/ckETH)

const fakeRes = (body: unknown, ok = true, status = 200) => ({ok, status, json: async () => body});
const rowsRes = (rows: unknown[]) => fakeRes({transactions: rows});
const myPrincipal = 'myprincipal123';
const OPTS = {submitAttempts: 2, poll: {attempts: 1, intervalMs: 0}, settleAttempts: 1, settleIntervalMs: 0};
let STAMP_NS = '0';

const vchfRoute = (): HubRoute => hubRoutes(BUNDLED, VCHF_LEDGER, CKETH_LEDGER)[0];

const quote1 = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: 'icpswap',
  pool: POOL1,
  tokenInLedger: VCHF_LEDGER,
  tokenOutLedger: ICP_LEDGER,
  amountIn: '100000000', // 1 VCHF
  amountOutGross: '120000000', // 1.2 ICP
  zeroForOne: true,
  feeMillionths: 3000,
  fetchedAtMs: 1_000,
  ...over,
});

const math1 = (over: Partial<ConvertMath> = {}): ConvertMath => ({
  amountIn: '100000000',
  grossOut: '120000000',
  minOut: '118800000', // 1% floor
  netOut: '119990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  ...over,
});

/** quote2 QUOTED ON math1.minOut — the composition floor prepareHubConvertRecord enforces. */
const quote2 = (over: Partial<ConvertQuote> = {}): ConvertQuote => ({
  venueId: 'icpswap-cketh',
  pool: POOL2,
  tokenInLedger: ICP_LEDGER,
  tokenOutLedger: CKETH_LEDGER,
  amountIn: '118800000', // EXACTLY math1.minOut
  amountOutGross: '3000000000000', // 3e12 wei-ish ckETH base units
  zeroForOne: false,
  feeMillionths: 5000,
  fetchedAtMs: 1_000,
  ...over,
});

const math2 = (over: Partial<ConvertMath> = {}): ConvertMath => ({
  amountIn: '118800000',
  grossOut: '3000000000000',
  minOut: '2970000000000',
  netOut: '1000000000000', // gross2 − the ckETH ledger fee (2e12)
  inFee: '10000',
  outFee: '2000000000000',
  slippageBps: 100,
  ...over,
});

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  STAMP_NS = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
  jest.mocked(icStampExpiry).mockResolvedValue(STAMP_NS);
  jest.mocked(DpayCore.icpPrincipalFromPubkey).mockResolvedValue(myPrincipal);
  // One derivation rule per swap leg: each probe re-derives ITS swap's floor from the
  // record's own gross — leg 1 on expectedGross, leg 2 on expectedGross2 (the compounding
  // floor). The mock honors the real core's shape so the windows are honest.
  jest.mocked(DpayCore.icpSwapMinOut).mockImplementation(async (gross) =>
    gross === '3000000000000' ? '2970000000000' : '118800000');
  jest.mocked(DpayCore.icpApproveArg).mockResolvedValue('approve-arg-hex');
  jest.mocked(DpayCore.icpDepositAndSwapArg).mockResolvedValue('swap-arg-hex');
  jest.mocked(DpayCore.icpWithdrawErc20Arg).mockResolvedValue('withdraw-arg-hex');
  jest.mocked(DpayCore.icpSignUpdate).mockImplementation(async (_s, canister) => ({
    envelopeHex: `env-${canister}`,
    requestIdHex: `rid-${canister}`,
  }));
  jest.mocked(DpayCore.icpDecodeSwapResult).mockResolvedValue({ok: true, amountOutGross: '3000000000000'});
  jest.mocked(DpayCore.icpDecodeMinterOk).mockResolvedValue({ok: true, blockIndex: '77'});
  jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '1'} as never);
});

afterEach(() => {
  setRuntimeVenues(null);
});

/** hub record via the real prepare, every leg still pending. */
async function hubRecord(over: Partial<ConvertRecord> = {}): Promise<ConvertRecord> {
  const rec = await prepareHubConvertRecord({
    secretHex: '00'.repeat(32),
    quote1: quote1(),
    quote2: quote2(),
    math1: math1(),
    math2: math2(),
    route: vchfRoute(),
  });
  return {...rec, ...over};
}

/** Point the relay mock at per-currency ledger rows: the probe's URL names the currency it
 *  watches (`?currency=N`), so the same mock serves the leg-1 (hub) and leg-2 (dest) watches. */
function mockRows(byCurrency: Record<number, unknown[]>): void {
  jest.mocked(relayFetch).mockImplementation(async (_r, url) => {
    const m = /currency=(\d+)/.exec(url ?? '');
    const rows = m ? byCurrency[Number(m[1])] ?? [] : [];
    return rowsRes(rows) as never;
  });
}

describe('hubRoutes — the pure registry walk (no hardcoded hub)', () => {
  test('VCHF reaches exactly THREE hub routes: two over ICP, one over the ckUSDC hub', () => {
    const routes = hubRoutes(BUNDLED, VCHF_LEDGER);
    expect(routes.map(r => r.routeId)).toEqual([
      `hub:icpswap:8:icpswap-ckusdc`, // VCHF → ICP → ckUSDC
      `hub:icpswap:8:icpswap-cketh`, // VCHF → ICP → ckETH
      `hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc`, // VCHF → ckUSDC → ICP (ckUSDC IS a real hub — the VCHF↔ckUSDC pool is registered)
    ]);
    const r = routes[1];
    expect(r.legs).toEqual([
      {venueId: 'icpswap', pool: POOL1, fromLedger: VCHF_LEDGER, toLedger: ICP_LEDGER},
      {venueId: 'icpswap-cketh', pool: POOL2, fromLedger: ICP_LEDGER, toLedger: CKETH_LEDGER},
    ]);
    expect(r.from).toEqual({currency: 7, ledger: VCHF_LEDGER, symbol: 'VCHF', decimals: 8, fee: '10000', network: 'Internet Computer'});
    expect(r.hub).toEqual({currency: 8, ledger: ICP_LEDGER, symbol: 'ICP', decimals: 8, fee: '10000', network: 'Internet Computer'});
    expect(r.dest).toEqual({currency: 6, ledger: CKETH_LEDGER, symbol: 'ETH', decimals: 18, fee: '2000000000000', network: 'Ethereum'});
  });

  test('ckUSDC reaches THREE hub routes — ICP is a hub on BOTH sides, VCHF becomes one too', () => {
    const routes = hubRoutes(BUNDLED, CKUSDC_LEDGER);
    expect(routes.map(r => r.routeId)).toEqual([
      'hub:icpswap-ckusdc:8:icpswap', // ckUSDC → ICP → VCHF
      'hub:icpswap-ckusdc:8:icpswap-cketh', // ckUSDC → ICP → ckETH
      'hub:icpswap-vchf-ckusdc:7:icpswap', // ckUSDC → VCHF → ICP
    ]);
  });

  test('ICP itself walks back over TWO hubs (VCHF and ckUSDC) — the walk is symmetric', () => {
    const routes = hubRoutes(BUNDLED, ICP_LEDGER);
    expect(routes.map(r => r.routeId)).toEqual([
      'hub:icpswap:7:icpswap-vchf-ckusdc', // ICP → VCHF → ckUSDC
      'hub:icpswap-ckusdc:2:icpswap-vchf-ckusdc', // ICP → ckUSDC → VCHF
    ]);
  });

  test('ckBTC-involving routes FAIL CLOSED: the bundled catalog carries no ckBTC fee yet', () => {
    // ckBTC's row is fee:null today — a leg that cannot be priced is not a route. The venue
    // icpswap-ckbtc exists, so this is the catalog's honesty gate, not a registry gap; the
    // walk picks ckBTC routes up the moment its row carries a fee (no code change).
    expect(hubRoutes(BUNDLED, CKBTC_LEDGER)).toEqual([]);
    expect(hubRoutes(BUNDLED, CKUSDC_LEDGER, CKBTC_LEDGER)).toEqual([]);
    expect(hubRoutes(BUNDLED, VCHF_LEDGER, CKBTC_LEDGER)).toEqual([]);
  });

  test('VEUR gets NO routes (no venue pairs it) and DEMO gets none (fee null on the row)', () => {
    expect(hubRoutes(BUNDLED, VEUR_LEDGER)).toEqual([]);
    expect(hubRoutes(BUNDLED, rowOf(0).ledger!)).toEqual([]);
  });

  test('the testnet fixture venue never composes a route; the toLedger filter narrows exactly', () => {
    // icpswap-fixture-b pairs [VCHF, ICP] with testnet:true — had the walk skipped the flag,
    // VCHF would show duplicate ICP-hub routes.
    const routes = hubRoutes(BUNDLED, VCHF_LEDGER);
    expect(routes.every(r => !r.routeId.includes('fixture'))).toBe(true);
    expect(hubRoutes(BUNDLED, VCHF_LEDGER, CKUSDC_LEDGER).map(r => r.routeId)).toEqual([
      'hub:icpswap:8:icpswap-ckusdc',
    ]);
  });

  test('the hub is found in the REGISTRY, not hardcoded: a runtime venue makes VEUR a hub', () => {
    // The runtime fixtures carry disclosure_key:null (registry rows may ship without one —
    // the TYPE disagrees with reality; the cast is the test's, not the engine's).
    const runtime = [
      {venue_id: 'fakev', display_name: 'Fake V', kind: 'ic_amm', endpoint: 'fqaaa-fake-1-cai', pair_ledgers: [VCHF_LEDGER, VEUR_LEDGER], testnet: false, disclosure_key: null},
      {venue_id: 'fakev2', display_name: 'Fake V2', kind: 'ic_amm', endpoint: 'fqaaa-fake-2-cai', pair_ledgers: [VEUR_LEDGER, ICP_LEDGER], testnet: false, disclosure_key: null},
    ] as unknown as VenueEntry[];
    setRuntimeVenues(runtime);
    const routes = hubRoutes(BUNDLED, VCHF_LEDGER);
    // VCHF → VEUR → ICP: the walk composed VEUR (currency 9) as a HUB purely from the
    // registry graph — nothing anywhere pins "the hub is ICP".
    expect(routes.some(r => r.routeId === 'hub:fakev:9:fakev2' && r.hub.ledger === VEUR_LEDGER && r.dest.ledger === ICP_LEDGER)).toBe(true);
  });

  test('a catalog row missing fee/symbol/network on ANY of the three legs fails the route closed', () => {
    // The descriptor type admits only string fees/networks, but the RUNTIME rows carry
    // nulls (ckBTC's fee IS null today) — the strip writes through that honesty gap.
    const strip = (currency: number, over: Record<string, unknown>) =>
      BUNDLED.map(c => (c.currency === currency ? {...c, ...over} : c)) as CurrencyDescriptor[];
    // hub unpriceable / unnamed:
    expect(hubRoutes(strip(8, {fee: null}), VCHF_LEDGER)).toEqual([]);
    expect(hubRoutes(strip(8, {backing_symbol: null, symbol: null}), VCHF_LEDGER)).toEqual([]);
    // dest unpriceable / unplaceable: the ckETH-dest route drops; ckUSDC and ICP remain
    // (the ckUSDC-hub route's DEST is ICP itself).
    expect(hubRoutes(strip(6, {fee: null}), VCHF_LEDGER).map(r => r.dest.currency)).toEqual([2, 8]);
    expect(hubRoutes(strip(6, {network: null}), VCHF_LEDGER).map(r => r.dest.currency)).toEqual([2, 8]);
    // the FROM row missing its fee → no routes at all:
    expect(hubRoutes(strip(7, {fee: null}), VCHF_LEDGER)).toEqual([]);
  });
});

describe('resolveConvertDestinations — the widened Convert-entry enumeration', () => {
  test('VCHF: two direct destinations, both gain hub routes, ckETH is hub-only', () => {
    const dests = resolveConvertDestinations(VCHF_LEDGER, false);
    expect(dests.map(d => d.destLedger)).toEqual([ICP_LEDGER, CKUSDC_LEDGER, CKETH_LEDGER]);
    // Direct FIRST, then the hub alternative — offered, never ranked. ICP itself is reachable
    // over the ckUSDC hub (the direct VCHF↔ICP pool beside it).
    expect(dests[0].routes).toEqual([
      {kind: 'direct', venueId: 'icpswap'},
      {kind: 'hub', routeId: 'hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc', venue1Id: 'icpswap-vchf-ckusdc', venue2Id: 'icpswap-ckusdc', hubLedger: CKUSDC_LEDGER},
    ]);
    expect(dests[1].routes).toEqual([
      {kind: 'direct', venueId: 'icpswap-vchf-ckusdc'},
      {kind: 'hub', routeId: 'hub:icpswap:8:icpswap-ckusdc', venue1Id: 'icpswap', venue2Id: 'icpswap-ckusdc', hubLedger: ICP_LEDGER},
    ]);
    expect(dests[2].routes).toEqual([
      {kind: 'hub', routeId: 'hub:icpswap:8:icpswap-cketh', venue1Id: 'icpswap', venue2Id: 'icpswap-cketh', hubLedger: ICP_LEDGER},
    ]);
  });

  test('ICP keeps every direct pair and gains hub alternatives beside the direct ones', () => {
    const dests = resolveConvertDestinations(ICP_LEDGER, false);
    // Registry order: icpswap (VCHF) is the FIRST venue pairing ICP, so VCHF leads.
    // ckBTC is NOT a destination: its catalog row carries fee:null, and a destination the
    // catalog cannot fully price is not offered (fail-closed, same bar as hubRoutes' own
    // endpoints) — the icpswap-ckbtc venue yields nothing.
    expect(dests.map(d => d.destLedger)).toEqual([VCHF_LEDGER, CKUSDC_LEDGER, CKETH_LEDGER]);
    // VCHF: direct + hub over ckUSDC. ckUSDC: direct + hub over VCHF. Each destination lists
    // direct first, then hub — offered, never ranked.
    expect(dests[0].routes).toEqual([
      {kind: 'direct', venueId: 'icpswap'},
      {kind: 'hub', routeId: 'hub:icpswap-ckusdc:2:icpswap-vchf-ckusdc', venue1Id: 'icpswap-ckusdc', venue2Id: 'icpswap-vchf-ckusdc', hubLedger: CKUSDC_LEDGER},
    ]);
    expect(dests[1].routes).toEqual([
      {kind: 'direct', venueId: 'icpswap-ckusdc'},
      {kind: 'hub', routeId: 'hub:icpswap:7:icpswap-vchf-ckusdc', venue1Id: 'icpswap', venue2Id: 'icpswap-vchf-ckusdc', hubLedger: VCHF_LEDGER},
    ]);
    expect(dests.some(d => d.destLedger === CKBTC_LEDGER)).toBe(false); // fee:null — never offered
  });

  test('testnet rows and unregistered assets get NOTHING (same posture as resolveConvertDirection)', () => {
    expect(resolveConvertDestinations(VEUR_LEDGER, false)).toEqual([]);
    expect(resolveConvertDestinations(VCHF_LEDGER, true)).toEqual([]);
    expect(resolveConvertDestinations(undefined, false)).toEqual([]);
    expect(resolveConvertDestinations('no-such-ledger', false)).toEqual([]);
  });
});

describe('prepareHubConvertRecord — one intent, four legs, signed once up front', () => {
  test('four legs in execution order with the exact canisters/methods, and a parallel legPlan', async () => {
    const rec = await hubRecord();
    expect(rec.step).toBe('approving');
    expect(rec.legs.map(l => [l.canister, l.method])).toEqual([
      [VCHF_LEDGER, 'icrc2_approve'], // approve pool1 to pull VCHF
      [POOL1, 'depositFromAndSwap'], // swap1: VCHF → ICP (hub)
      [ICP_LEDGER, 'icrc2_approve'], // approve pool2 to pull the hub floor
      [POOL2, 'depositFromAndSwap'], // swap2: ICP → ckETH (dest = own principal)
    ]);
    expect(rec.legPlan!.map(p => [p.kind, p.canister, p.fee])).toEqual([
      ['approve', VCHF_LEDGER, '10000'],
      ['swap', POOL1, ''],
      ['approve', ICP_LEDGER, '10000'], // the hub ledger's own approve fee
      ['swap', POOL2, ''],
    ]);
    expect(rec.legPlan!.every(p => p.state === 'pending')).toBe(true);
    expect('destAddress' in rec).toBe(false); // dest is the user's OWN principal — no address is signed
    // The record's out* names the HUB (the first watchable ledger); the DEST lives in dest*.
    expect(rec.outCurrency).toBe(8);
    expect(rec.outLedger).toBe(ICP_LEDGER);
    expect(rec.outSymbol).toBe('ICP');
    expect(rec.hopCurrency).toBe(8);
    expect(rec.hopLedger).toBe(ICP_LEDGER);
    expect(rec.destLedger).toBe(CKETH_LEDGER);
    expect(rec.destCurrency).toBe(6);
    expect(rec.destDecimals).toBe(18);
    expect(rec.destFee).toBe('2000000000000');
    expect(rec.destSymbol).toBe('ETH');
    expect(rec.destNetwork).toBe('Ethereum');
    expect(rec.venueId).toBe('icpswap');
    expect(rec.venue2Id).toBe('icpswap-cketh');
    expect(rec.expectedGross).toBe('120000000');
    expect(rec.expectedGross2).toBe('3000000000000');
    expect(rec.expectedNet2).toBe('1000000000000');
    expect(rec.feeMillionths).toBe(3000);
    expect(rec.feeMillionths2).toBe(5000);
    expect(isHubConvertRecord(rec)).toBe(true);
  });

  test('every arg is built exactly once with the compounding floors (approve2 sized on minOut1)', async () => {
    await hubRecord();
    const approve = jest.mocked(DpayCore.icpApproveArg).mock.calls;
    expect(approve).toHaveLength(2);
    // Leg 1 — pool pull on VCHF: amountIn + the from ledger's fee (convert shape).
    expect(approve[0]).toEqual([POOL1, '', '', '100010000', '100010000', STAMP_NS, '', '10000']);
    // Leg 3 — pool pull on ICP: the HUB FLOOR (minOut1) + the hub ledger's fee. swap2 pulls
    // whatever swap1's floor delivers, so the allowance is sized on the floor, never the gross.
    expect(approve[1]).toEqual([POOL2, '', '', '118810000', '118810000', STAMP_NS, '', '10000']);
    expect(jest.mocked(DpayCore.icpDepositAndSwapArg).mock.calls).toEqual([
      ['100000000', '118800000', '10000', '10000', true], // swap1: in=1 VCHF, min=minOut1, fees VCHF→ICP
      ['118800000', '2970000000000', '10000', '2000000000000', false], // swap2: in=minOut1, min=minOut2 (its OWN floor), fees ICP→ckETH
    ]);
    // One shared stamp: every envelope expires together (one intent, one expiry).
    const stamps = jest.mocked(DpayCore.icpSignUpdate).mock.calls.map(c => c[4]);
    expect(stamps).toEqual([STAMP_NS, STAMP_NS, STAMP_NS, STAMP_NS]);
    expect(jest.mocked(DpayCore.icpWithdrawErc20Arg)).not.toHaveBeenCalled();
  });

  test('quote2 quoted on anything but math1.minOut is REFUSED — a differently-sized quote2 is a different trade', async () => {
    await expect(prepareHubConvertRecord({
      secretHex: '00'.repeat(32),
      quote1: quote1(),
      quote2: quote2({amountIn: '119000000'}),
      math1: math1(),
      math2: math2(),
      route: vchfRoute(),
    })).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });

  test('the red lines: endpoint ≠ pool, ledger mismatch, unregistered venue, dpay canister — all refuse unsigned', async () => {
    const route = vchfRoute();
    const base = {secretHex: '00'.repeat(32), quote1: quote1(), quote2: quote2(), math1: math1(), math2: math2(), route};
    await expect(prepareHubConvertRecord({...base, quote1: quote1({pool: 'not-the-endpoint'})})).rejects.toThrow();
    await expect(prepareHubConvertRecord({...base, quote2: quote2({tokenInLedger: CKUSDC_LEDGER})})).rejects.toThrow();
    await expect(prepareHubConvertRecord({...base, quote2: quote2({venueId: 'no-such-venue'})})).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
    // No dpay-owned canister anywhere in the five-target set:
    const hostile: HubRoute = {...route, dest: {...route.dest, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai'}};
    await expect(prepareHubConvertRecord({...base, route: hostile})).rejects.toThrow();
    expect(jest.mocked(DpayCore.icpSignUpdate)).not.toHaveBeenCalled();
  });
});

describe('hydrateConvertStore — the hub shape is additive; every old record stays byte-identical', () => {
  test('a pending hub record survives JSON round-trip byte-for-byte (no destAddress ever needed)', async () => {
    const rec = await hubRecord();
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({[rec.id]: rec})));
    expect(out).toEqual({[rec.id]: rec});
  });

  test('a DONE hub record round-trips with its destTx evidence', async () => {
    const rec = await hubRecord();
    const done: ConvertRecord = {
      ...rec,
      step: 'done',
      legPlan: rec.legPlan!.map(p => ({...p, state: 'confirmed' as const})),
      outAmountNet: '2990000000000',
      outTx: '22',
      destTx: '22',
      hopTx: '11',
    };
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({[done.id]: done})));
    expect(out).toEqual({[done.id]: done});
  });

  test.each([
    ['destLedger'],
    ['venue2Id'],
    ['expectedGross2'],
    ['expectedNet2'],
    ['destFee'],
  ])('hub record without %s → REJECTED (a swap2 the record cannot watch or re-price is corrupt)', async (key) => {
    const rec = await hubRecord();
    const broken = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    delete broken[key];
    expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
  });

  test('hub record with a non-number destCurrency / feeMillionths2 → REJECTED', async () => {
    for (const key of ['destCurrency', 'feeMillionths2']) {
      const rec = await hubRecord();
      const broken = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
      broken[key] = '6';
      expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
    }
  });

  test('a four-leg plan in the WRONG kind order is not a hub record — the Route A rules apply and refuse it', async () => {
    const rec = await hubRecord();
    const broken = JSON.parse(JSON.stringify(rec)) as ConvertRecord;
    broken.legPlan = [
      {...broken.legPlan![0]},
      {...broken.legPlan![2]}, // approve before the swap ran — not the hub order
      {...broken.legPlan![1]},
      {...broken.legPlan![3]},
    ];
    expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
  });

  test('BACKWARD COMPAT: a v2 two-leg record (no legPlan) still hydrates byte-identically', () => {
    const direct: ConvertRecord = {
      id: 'direct1',
      createdAtMs: 1,
      step: 'approving',
      venueId: 'icpswap',
      inCurrency: 7,
      outCurrency: 8,
      inLedger: VCHF_LEDGER,
      outLedger: ICP_LEDGER,
      inSymbol: 'VCHF',
      outSymbol: 'ICP',
      amountIn: '100000000',
      expectedGross: '120000000',
      expectedNet: '119990000',
      inFee: '10000',
      outFee: '10000',
      slippageBps: 100,
      legs: [
        {canister: VCHF_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'e1', requestIdHex: 'r1', expiresAtMs: Date.now() + 600_000},
        {canister: POOL1, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'e2', requestIdHex: 'r2', expiresAtMs: Date.now() + 600_000},
      ],
    };
    const out = hydrateConvertStore(JSON.parse(JSON.stringify({direct1: direct})));
    expect(out).toEqual({direct1: direct});
  });
});

describe('executeConvert (hub) — the per-swap watch, the hub taxonomy, the expiry trichotomy', () => {
  const deps = (onUpdate: (r: ConvertRecord) => void) => ({
    secretHex: '00'.repeat(32),
    publicHex: 'aabb',
    relayUrl: 'http://relay',
    onUpdate,
  });

  test('happy path: both payouts SEEN — done with the SEEN dest amount, destTx set, hop gated in between', async () => {
    const rec = await hubRecord();
    const updates: ConvertRecord[] = [];
    mockRows({
      8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}], // swap1's hub row
      6: [{currency: 6, from: POOL2, to: myPrincipal, amount: '2990000000000', block: '22'}], // swap2's dest row
    });
    jest.mocked(DpayCore.icpSwapMinOut).mockImplementation(async (gross) => {
      // One derivation rule per swap leg: each floor is its OWN gross × (1−slippage).
      return gross === '3000000000000' ? '2970000000000' : '118800000';
    });
    const out = await executeConvert(rec, deps(r => updates.push(r)), OPTS);
    expect(out.step).toBe('done');
    expect(out.legPlan!.every(p => p.state === 'confirmed')).toBe(true);
    // Honest completion: the SEEN dest row, never the expected gross; dest asset IS in-wallet.
    expect(out.outAmountNet).toBe('2990000000000');
    expect(out.outTx).toBe('22');
    expect(out.destTx).toBe('22');
    expect(out.hopTx).toBe('11');
    // Four identical-envelope submits, in leg order — venue2's pool never re-signed.
    const ledgers = jest.mocked(submitTransfer).mock.calls.map(c => (c[0] as {ledger: string}).ledger);
    expect(ledgers).toEqual([VCHF_LEDGER, POOL1, ICP_LEDGER, POOL2]);
    expect(updates.filter(u => u.legPlan!.some(p => p.state === 'sent'))).toHaveLength(4);
  });

  test('swap2 refused → failed_leg/swap_refused (never failed_refunded — the input already converted)', async () => {
    const rec = await hubRecord();
    mockRows({8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}]});
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never) // approve1
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never) // swap1 (#ok → hub row seen)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '3'} as never) // approve2
      .mockResolvedValueOnce({kind: 'rejected', reason: 'amountOutMinimum not met', variant: 'InternalError'} as never); // swap2
    const out = await executeConvert(rec, deps(() => {}), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('swap_refused');
    expect(out.legPlan![3].state).toBe('failed');
    expect(out.legPlan!.slice(0, 3).every(p => p.state === 'confirmed')).toBe(true);
  });

  test('approve2 refused → failed_leg/withdraw_refused (the user holds the HUB asset in-wallet)', async () => {
    const rec = await hubRecord();
    mockRows({8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}]});
    jest.mocked(submitTransfer)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '1'} as never)
      .mockResolvedValueOnce({kind: 'settled', blockIndex: '2'} as never)
      .mockResolvedValueOnce({kind: 'rejected', reason: 'expired allowance', variant: 'ExpiredAllowance'} as never);
    const out = await executeConvert(rec, deps(() => {}), OPTS);
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('withdraw_refused');
    expect(out.legPlan![2].state).toBe('failed');
    expect(out.legPlan!.slice(0, 2).every(p => p.state === 'confirmed')).toBe(true);
  });

  test('swap2 #ok but NO dest row in budget → parked pending_withdrawal; resume sees the row → done', async () => {
    const rec = await hubRecord();
    mockRows({8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}]});
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '1'} as never);
    const parked = await executeConvert(rec, deps(() => {}), OPTS);
    expect(parked.step).toBe('pending_withdrawal');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(4); // all four legs submitted; swap2 awaits its row
    expect(parked.legPlan![3].state).toBe('sent');

    // Resume: the DEST payout has landed — no re-signing, the watch resolves it terminal.
    mockRows({6: [{currency: 6, from: POOL2, to: myPrincipal, amount: '2990000000000', block: '22'}]});
    const done = await executeConvert(parked, deps(() => {}), OPTS);
    expect(done.step).toBe('done');
    expect(done.outAmountNet).toBe('2990000000000');
    expect(done.destTx).toBe('22');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(4); // nothing new signed during recovery
    expect(done.legPlan!.every(p => p.state === 'confirmed')).toBe(true);
  });

  test('pending_withdrawal parked BETWEEN the swaps (no hub row yet): resume completes legs 3–4', async () => {
    const rec = await hubRecord();
    mockRows({}); // nothing visible anywhere during the first run
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '1'} as never);
    const parked = await executeConvert(rec, deps(() => {}), OPTS);
    expect(parked.step).toBe('pending_withdrawal');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(2); // stopped at swap1's watch — approve2 never ran
    expect(parked.legPlan![1].state).toBe('sent');

    // Resume: swap1's hub row appears; legs 3–4 run; swap2's dest row completes the record.
    mockRows({
      8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}],
      6: [{currency: 6, from: POOL2, to: myPrincipal, amount: '2990000000000', block: '22'}],
    });
    const done = await executeConvert(parked, deps(() => {}), OPTS);
    expect(done.step).toBe('done');
    expect(done.hopTx).toBe('11');
    expect(done.destTx).toBe('22');
    expect(jest.mocked(submitTransfer)).toHaveBeenCalledTimes(4);
  });

  test('expired with the DEST payout SEEN → done (the swap executed even though its envelope died)', async () => {
    const rec = await hubRecord();
    for (const l of rec.legs) l.expiresAtMs = 1;
    mockRows({6: [{currency: 6, from: POOL2, to: myPrincipal, amount: '2990000000000', block: '22'}]});
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('done');
    expect(out.outAmountNet).toBe('2990000000000');
    expect(out.destTx).toBe('22');
    expect(jest.mocked(submitTransfer)).not.toHaveBeenCalled(); // arm (b) resolves BEFORE any submit
  });

  test('expired with only the HUB payout seen → failed_leg (swap1 ran, swap2 dead; hub asset in-wallet)', async () => {
    const rec = await hubRecord();
    for (const l of rec.legs) l.expiresAtMs = 1;
    mockRows({8: [{currency: 8, from: POOL1, to: myPrincipal, amount: '119950000', block: '11'}]});
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('failed_leg');
    expect(out.failureCode).toBe('unknown');
    expect(out.hopTx).toBe('11');
    expect(out.destTx).toBeUndefined();
  });

  test('expired with NOTHING seen → stuck (the honest unknown)', async () => {
    const rec = await hubRecord();
    for (const l of rec.legs) l.expiresAtMs = 1;
    mockRows({});
    const out = await executeConvert(rec, deps(() => {}), {...OPTS, nowMs: 5_000});
    expect(out.step).toBe('stuck');
    expect(out.failureCode).toBe('unknown');
  });
});
