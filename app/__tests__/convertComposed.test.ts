/**
 * The COMPOSED IC→CeFi widening (2026-09-26, design brief §5.4 item 2) — the route walk:
 * resolveConvertDestinations grows a composed kind when a pool/hub leg lands on an asset a
 * registered CeFi venue buys (VCHF → ICP → EURC via SideShift's ICP order), failing closed
 * on any leg the catalog or the Solana registry cannot price, mainnet only, registry order,
 * and NEVER displacing the direct/hub routes beside it.
 *
 * Plus the v2→v3 store migration (the composed record is the v3 shape): the prior
 * per-identity v2 store is ADOPTED once into the v3 key and retired, the same one-time
 * shape the v1 and unscoped-v2 migrations used — and the composed record itself hydrates
 * byte-identically or is dropped, never half-adopted.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/native', () => ({DpayCore: {}}));

import {loadConvertRecords, hydrateConvertStore, type ConvertRecord} from '../convert';
import {resolveConvertDestinations} from '../config/convert';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {EURC_MINT_ADDRESS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const rowOf = (currency: number) => BUNDLED.find(c => c.currency === currency)!;
const ICP_LEDGER = rowOf(8).ledger!;
const VCHF_LEDGER = rowOf(7).ledger!;
const CKUSDC_LEDGER = rowOf(2).ledger!;
const CKETH_LEDGER = rowOf(6).ledger!;
const CKBTC_LEDGER = rowOf(1).ledger!;
const PUB = 'cc'.repeat(32);

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveConvertDestinations — the composed IC→CeFi walk', () => {
  test('VCHF gains the composed mint destinations: SOL, USDC, EURC over the ICP pool leg', () => {
    const dests = resolveConvertDestinations(VCHF_LEDGER, false);
    // The four IC-ledger destinations come first (unchanged), then the composed ones in
    // first-encounter order (the cefi registry walk: sideshift, sideshift-usdc,
    // sideshift-eurc, trocador).
    expect(dests.map(d => d.destLedger)).toEqual([
      ICP_LEDGER, CKUSDC_LEDGER, CKETH_LEDGER, CKBTC_LEDGER,
      WRAPPED_SOL_MINT_ADDRESS, USDC_MINT_ADDRESS, EURC_MINT_ADDRESS,
    ]);
    // VCHF → ICP → EURC — THE founder route: the direct pool leg first, then the
    // ckUSDC-hub composition beside it (both offered, registry order, never ranked).
    const eurc = dests.find(d => d.destLedger === EURC_MINT_ADDRESS)!;
    expect(eurc.routes.map(r => (r.kind === 'composed' ? r.routeId : r.kind))).toEqual([
      'composed:icpswap:sideshift-eurc',
      'composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:sideshift-eurc',
    ]);
    expect(eurc.routes[0]).toEqual({
      kind: 'composed',
      routeId: 'composed:icpswap:sideshift-eurc',
      legs: [{venueId: 'icpswap', pool: '65mrh-fqaaa-aaaar-qapoa-cai', fromLedger: VCHF_LEDGER, toLedger: ICP_LEDGER}],
      endpoints: [
        {currency: 7, ledger: VCHF_LEDGER, symbol: 'VCHF', decimals: 8, fee: '10000', network: 'Internet Computer'},
        {currency: 8, ledger: ICP_LEDGER, symbol: 'ICP', decimals: 8, fee: '10000', network: 'Internet Computer'},
      ],
      cefiVenueId: 'sideshift-eurc',
      settleMint: EURC_MINT_ADDRESS,
      settleSymbol: 'EURC',
      settleDecimals: 6,
    });
    // The SOL-mint destination carries the registry's TWO venues on it, each with its
    // direct-IC-leg and ckUSDC-hub-IC-leg variants (per-venue grouping, registry order,
    // never ranked).
    const sol = dests.find(d => d.destLedger === WRAPPED_SOL_MINT_ADDRESS)!;
    expect(sol.routes.map(r => (r.kind === 'composed'
      ? `${r.routeId}`
      : r.kind))).toEqual([
      'composed:icpswap:sideshift',
      'composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:sideshift',
      'composed:icpswap:trocador',
      'composed:hub:icpswap-vchf-ckusdc:2:icpswap-ckusdc:trocador',
    ]);
  });

  test('a single-venue direct route still stands untouched beside the composed additions', () => {
    // The direct VCHF↔ckUSDC pool is the FIRST route on its destination, hub beside it,
    // composed never prepended or re-sorted — composition only ADDS mint-keyed
    // destinations, it never reorders the IC ones.
    const dests = resolveConvertDestinations(VCHF_LEDGER, false);
    const ckusdc = dests.find(d => d.destLedger === CKUSDC_LEDGER)!;
    expect(ckusdc.routes[0]).toEqual({kind: 'direct', venueId: 'icpswap-vchf-ckusdc'});
    expect(ckusdc.routes[1]).toEqual({
      kind: 'hub',
      routeId: 'hub:icpswap:8:icpswap-ckusdc',
      venue1Id: 'icpswap',
      venue2Id: 'icpswap-ckusdc',
      hubLedger: ICP_LEDGER,
    });
    // A composed route also resolves from ckBTC: the direct ckBTC↔ICP pool leg first, then
    // the 2-leg hub composition over ckETH — registry order, both named in full.
    const ckbtcDests = resolveConvertDestinations(CKBTC_LEDGER, false);
    const ckbtcEurc = ckbtcDests.find(d => d.destLedger === EURC_MINT_ADDRESS)!;
    expect(ckbtcEurc.routes).toHaveLength(2);
    expect(ckbtcEurc.routes[0]).toMatchObject({
      kind: 'composed',
      routeId: 'composed:icpswap-ckbtc:sideshift-eurc',
      legs: [{venueId: 'icpswap-ckbtc', fromLedger: CKBTC_LEDGER, toLedger: ICP_LEDGER}],
    });
    const hubRoute = ckbtcEurc.routes[1];
    expect(hubRoute?.kind === 'composed' ? hubRoute.legs.map(l => l.venueId) : []).toEqual([
      'icpswap-ckbtc-cketh', // ckBTC → ckETH
      'icpswap-cketh',       // ckETH → ICP
    ]);
    expect(hubRoute?.kind === 'composed' ? hubRoute.endpoints[2].ledger : '').toBe(ICP_LEDGER);
  });

  test('ICP gains NO composed destinations: the cefi venues deposit ICP directly (plain cefi rows)', () => {
    const dests = resolveConvertDestinations(ICP_LEDGER, false);
    expect(dests.map(d => d.destLedger)).toEqual([VCHF_LEDGER, CKUSDC_LEDGER, CKETH_LEDGER, CKBTC_LEDGER]);
    expect(dests.every(d => d.routes.every(r => r.kind !== 'composed'))).toBe(true);
  });

  test('fail-closed on unpriceable legs: a hub row without fee/decimals/symbol yields no composed route', () => {
    const strip = (currency: number, over: Record<string, unknown>) =>
      BUNDLED.map(c => (c.currency === currency ? {...c, ...over} : c)) as CurrencyDescriptor[];
    // The ICP deposit leg unpriceable / unnamed → the composed mint destinations vanish;
    // the direct IC destinations are untouched (ICP stays, priced).
    expect(resolveConvertDestinations(VCHF_LEDGER, false, strip(8, {fee: null})).map(d => d.destLedger))
      .toEqual([CKUSDC_LEDGER]);
    expect(resolveConvertDestinations(VCHF_LEDGER, false, strip(8, {backing_symbol: null, symbol: null})).map(d => d.destLedger))
      .toEqual([CKUSDC_LEDGER]);
    // The SOURCE row itself unpriced → the hub/composed walks refuse it (they cannot name
    // the legs) while the direct walk keeps its historical posture: [ICP, ckUSDC], exactly
    // what this walk returned before the widening.
    expect(resolveConvertDestinations(VCHF_LEDGER, false, strip(7, {fee: null})).map(d => d.destLedger))
      .toEqual([ICP_LEDGER, CKUSDC_LEDGER]);
  });

  test('testnet sources and unknown ledgers get NOTHING (same posture as before the widening)', () => {
    expect(resolveConvertDestinations(VCHF_LEDGER, true)).toEqual([]);
    expect(resolveConvertDestinations(undefined, false)).toEqual([]);
    expect(resolveConvertDestinations('no-such-ledger', false)).toEqual([]);
  });
});

/** A minimal VALID composed record (the v3 shape), hand-written — the executor-level
 *  lifecycle lives in convertComposedLeg.test.tsx through the real prepare. */
const composedRecord = (over: Partial<ConvertRecord> = {}): ConvertRecord => ({
  id: 'comp-1',
  createdAtMs: 1,
  step: 'approving',
  venueId: 'icpswap',
  inCurrency: 7,
  inLedger: VCHF_LEDGER,
  outLedger: EURC_MINT_ADDRESS,
  inSymbol: 'VCHF',
  outSymbol: 'EURC',
  inDecimals: 8,
  outDecimals: 6,
  hopLedger: ICP_LEDGER,
  hopSymbol: 'ICP',
  hopCurrency: 8,
  hopDecimals: 8,
  amountIn: '100000000',
  expectedGross: '120000000',
  expectedNet: '11500',
  inFee: '10000',
  outFee: '0',
  slippageBps: 100,
  legs: [
    {canister: VCHF_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'e1', requestIdHex: 'r1', expiresAtMs: Date.now() + 600_000},
    {canister: '65mrh-fqaaa-aaaar-qapoa-cai', method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'e2', requestIdHex: 'r2', expiresAtMs: Date.now() + 600_000},
    {canister: ICP_LEDGER, method: 'icrc1_transfer', argHex: 'c', envelopeHex: 'e3', requestIdHex: 'r3', expiresAtMs: Date.now() + 600_000},
  ],
  legPlan: [
    {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'pending'},
    {kind: 'swap', canister: '65mrh-fqaaa-aaaar-qapoa-cai', fee: '', state: 'pending'},
    {kind: 'deposit_transfer', canister: ICP_LEDGER, fee: '10000', state: 'pending'},
  ],
  destAddress: 'sol-address-1',
  destSymbol: 'EURC',
  destNetwork: 'Solana',
  providerRef: {orderId: 'shift-1', statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-1'},
  composedDeposit: {
    venueId: 'sideshift-eurc',
    orderId: 'shift-1',
    depositAddress: 'venue-deposit-account',
    depositOwner: 'venue-deposit-principal',
    amountDecimal: '1.188',
    amountRaw: '118800000',
    fee: '10000',
    settleSymbol: 'EURC',
    settleDecimals: 6,
  },
  ...over,
});

describe('hydrateConvertStore — the composed (v3) record shape', () => {
  test('a composed record round-trips byte-for-byte, every flight step included', () => {
    for (const step of ['approving', 'awaiting_deposit', 'provider_processing', 'done', 'failed_leg', 'stuck'] as const) {
      const rec = composedRecord({step, ...(step === 'done' ? {outAmountNet: '11500', outTx: '9'} : {})});
      const out = hydrateConvertStore(JSON.parse(JSON.stringify({[rec.id]: rec})));
      expect(out).toEqual({[rec.id]: rec});
    }
  });

  test.each([
    ['composedDeposit'],
    ['hopLedger'],
    ['hopCurrency'],
    ['providerRef'],
  ])('composed record without %s → REJECTED (the engine cannot drive what it cannot see)', (key) => {
    const rec = composedRecord();
    const broken = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    if (key === 'providerRef') {
      delete broken.providerRef;
    } else if (key === 'composedDeposit') {
      delete broken.composedDeposit;
    } else {
      delete broken[key];
    }
    expect(hydrateConvertStore({[rec.id]: broken})).toEqual({});
  });

  test('a composed record whose deposit leg leaves the hop ledger, or whose providerRef order id drifts from the deposit block, is REJECTED', () => {
    const wrongLedger = composedRecord();
    wrongLedger.legs[2] = {...wrongLedger.legs[2]!, canister: CKUSDC_LEDGER};
    expect(hydrateConvertStore({[wrongLedger.id]: JSON.parse(JSON.stringify(wrongLedger))})).toEqual({});

    const drifted = composedRecord({
      providerRef: {orderId: 'shift-other', statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-other'},
    });
    expect(hydrateConvertStore({[drifted.id]: JSON.parse(JSON.stringify(drifted))})).toEqual({});
  });

  test('a composed record at a step outside the composed vocabulary is REJECTED', () => {
    // 'swapping' is a DIRECT-record step (the step machine, not the planned executor) — a
    // composed record there is a shape no driver this build ships can advance.
    const rec = composedRecord({step: 'swapping'});
    expect(hydrateConvertStore({[rec.id]: JSON.parse(JSON.stringify(rec))})).toEqual({});
  });

  test('corrupt deposit-block fields (non-digit amountRaw/fee, bad decimals) are REJECTED', () => {
    for (const mutate of [
      (r: ConvertRecord) => ({...r, composedDeposit: {...r.composedDeposit!, amountRaw: '1.188'}}),
      (r: ConvertRecord) => ({...r, composedDeposit: {...r.composedDeposit!, fee: ''}}),
      (r: ConvertRecord) => ({...r, composedDeposit: {...r.composedDeposit!, settleDecimals: -1}}),
      (r: ConvertRecord) => ({...r, composedDeposit: {...r.composedDeposit!, depositAddress: ''}}),
    ]) {
      const rec = mutate(composedRecord());
      expect(hydrateConvertStore(JSON.parse(JSON.stringify({[rec.id]: rec})))).toEqual({});
    }
  });
});

describe('the v2→v3 store migration — one-time adoption, byte-frozen records', () => {
  const plainRecord = (over: Partial<ConvertRecord> = {}): ConvertRecord => ({
    id: 'abc123',
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
      {canister: '65mrh-fqaaa-aaaar-qapoa-cai', method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'e2', requestIdHex: 'r2', expiresAtMs: Date.now() + 600_000},
    ],
    ...over,
  });

  test('the prior per-identity v2 store is adopted into the v3 key, then retired', async () => {
    const rec = plainRecord();
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, JSON.stringify({abc123: rec}));
    const loaded = await loadConvertRecords(PUB);
    expect(loaded.abc123?.id).toBe('abc123');
    // The v3 store now holds the adopted record; the v2 key is GONE (one-time migration).
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v3.${PUB}`))!)).toEqual({abc123: rec});
    expect(await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`)).toBeNull();
    // A second load reads the v3 store directly — the migration never runs twice.
    expect(await loadConvertRecords(PUB)).toEqual(loaded);
    // Nobody else inherits it.
    expect(await loadConvertRecords('dd'.repeat(32))).toEqual({});
  });

  test('a healthy v3 store is read directly and legacy keys are never consulted', async () => {
    const rec = composedRecord();
    await AsyncStorage.setItem(`dpay.convert.v3.${PUB}`, JSON.stringify({[rec.id]: rec}));
    const loaded = await loadConvertRecords(PUB);
    expect(loaded[rec.id]?.id).toBe('comp-1');
    // The composed record survives the round trip: the v3 store is the ONLY store a v3
    // build needs.
    expect(loaded[rec.id]?.composedDeposit?.orderId).toBe('shift-1');
  });

  test('a PARTIALLY corrupt prior v2 store: valid records adopt, the v2 KEY SURVIVES on disk', async () => {
    const good = plainRecord({id: 'good1'});
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, JSON.stringify({
      good1: good,
      bad1: {...plainRecord({id: 'bad1'}), step: 'weird'},
    }));
    const loaded = await loadConvertRecords(PUB);
    expect(Object.keys(loaded)).toEqual(['good1']);
    expect(await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`)).not.toBeNull(); // source preserved
    expect(JSON.parse((await AsyncStorage.getItem(`dpay.convert.v3.${PUB}`))!)).toEqual({good1: good});
  });

  test('all three generations fold in ONE pass: v1, unscoped v2, prior scoped v2 (newest wins)', async () => {
    const legacyV1 = (id: string, env: string): Record<string, unknown> => ({
      id,
      createdAtMs: 1,
      step: 'swapping',
      inCurrency: 8,
      outCurrency: 7,
      inLedger: ICP_LEDGER,
      outLedger: VCHF_LEDGER,
      inSymbol: 'ICP',
      outSymbol: 'CHF',
      amountIn: '100000000',
      amountOutMin: '188000000',
      expectedGross: '190000000',
      expectedNet: '189990000',
      inFee: '10000',
      outFee: '10000',
      slippageBps: 100,
      zeroForOne: true,
      approveEnvelopeHex: env,
      approveRequestIdHex: 'bbdd',
      approveExpiresAtMs: 601_000,
      swapEnvelopeHex: 'ccaa',
      swapRequestIdHex: 'ddbb',
    });
    // A v1 record's id must match its store key (the same rule every generation applies).
    await AsyncStorage.setItem('dpay.convert.v1', JSON.stringify({
      old1: legacyV1('old1', 'v1env'),
      shared: legacyV1('shared', 'v1env'),
    }));
    await AsyncStorage.setItem('dpay.convert.v2', JSON.stringify({
      shared: plainRecord({id: 'shared'}),
      unscoped2: plainRecord({id: 'unscoped2'}),
    }));
    await AsyncStorage.setItem(`dpay.convert.v2.${PUB}`, JSON.stringify({
      shared: plainRecord({id: 'shared', expectedGross: '999000000'}), // the newest generation wins
    }));
    const loaded = await loadConvertRecords(PUB);
    expect(Object.keys(loaded).sort()).toEqual(['old1', 'shared', 'unscoped2']);
    expect(loaded.shared?.expectedGross).toBe('999000000');
    expect(await AsyncStorage.getItem('dpay.convert.v1')).toBeNull();
    expect(await AsyncStorage.getItem('dpay.convert.v2')).toBeNull();
    expect(await AsyncStorage.getItem(`dpay.convert.v2.${PUB}`)).toBeNull();
  });
});
