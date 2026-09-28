// The EVM-native CeFi destination (2026-09-27): ICP → native ETH on Ethereum mainnet
// through the adapter-owned SideShift row (sideshift-eth), the trip that funds the EVM
// rail from ICP holdings. Pinned here, end to end at the app layer:
//   * GATING — the row exists only while the EVM rail is configured (the same
//     isEvmRailConfigured gate the EVM asset surfaces read): rail off → the ETH target
//     resolves exactly the pre-ETH walk (the IC ckETH rows, no sideshift-eth); rail on →
//     the row appears, and ONLY for the ICP deposit (EURC/USDC sources are not eligible —
//     the adapter owns exactly one EVM-native pair).
//   * THE SETTLE ADDRESS — the device's OWN EVM identity at m/44'/60'/0'/0/0,
//     EIP-55-checksummed for display AND as the order's settle address. The expected
//     address is the INDEPENDENT vector computed by the e2e harness's own SLIP-10
//     implementation (e2e/harness/evm/evm-core.mjs, the SLIP-10-official-vectors module
//     flow 218 pins) over the same test seed — not this app's own code.
//   * THE QUOTE + ORDER — the rail id rides as the settle side end to end (the quote
//     call, the order body's settleLedger, the record's outLedger), the order locks the
//     fresh figures, and a deposit-amount mismatch refuses before anything is adopted.
//   * PROVENANCE + COMPLETION — the record hydrates (the venueOfId path resolves the
//     adapter-owned row), and a settled venue status normalizes its decimal settle
//     figure through the OUT asset's own 18 decimals into the raw outAmountNet.
// The rail-id drift alarm: ETH_NATIVE_RAIL_ID must equal the relay adapter's twin
// (crates/dpay-relay/src/sideshift.rs ETH_NATIVE_RAIL_ID) — a drift fails loud at order
// time (the relay refuses the settle rail) and here, as a literal pin.
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

const mockIcPrincipal = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const mockSettleAccountId = 'cd'.repeat(32); // the refund target (deposit rail = IC)

jest.mock('../services/native', () => ({
  DpayCore: {
    icpPrincipalFromPubkey: jest.fn(async () => mockIcPrincipal),
    icpAccountIdFromPrincipal: jest.fn(async () => mockSettleAccountId),
  },
}));
jest.mock('../services/sideshift', () => ({
  sideShiftStatusUrl: (o: string) => `https://sideshift.ai/api/v2/shifts/${o}`,
  SIDESHIFT_STATUS_BASE: 'https://sideshift.ai/api/v2',
  fetchSideShiftQuote: jest.fn(),
  createSideShiftFixedShift: jest.fn(),
}));
jest.mock('../services/jupiter', () => ({
  fetchJupiterQuote: jest.fn(),
  fetchJupiterSwapTx: jest.fn(),
}));
jest.mock('../convertResume', () => ({
  convertResumeSnapshot: jest.fn((): Record<string, unknown> => ({})),
  subscribeConvertRecords: jest.fn(() => () => undefined),
  adoptConvertRecord: jest.fn(async () => undefined),
  acknowledgeStuckRecord: jest.fn(async () => undefined),
  attachCctpBurnTx: jest.fn(),
  confirmCrossRailSolLeg: jest.fn(),
  declineCctpHandoff: jest.fn(),
}));
jest.mock('../convert', () => {
  const actual = jest.requireActual('../convert') as Record<string, unknown>;
  return {...actual, isQuoteStale: () => false};
});

import {ConvertMode} from '../components/ConvertMode';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {ETH_NATIVE_RAIL_ID, EVM_NATIVE_VENUES, evmNativeVenuesForLedger} from '../config/evmConvert';
import {resolveSwapTargets, type SwapRow} from '../config/swap';
import {setEvmRpcUrl} from '../evm';
import {deriveEvmKeypair, toChecksumAddress} from '../evm/identity';
import {ICP_LEDGER_PRINCIPAL} from '../config/constants';
import {fetchSideShiftQuote, createSideShiftFixedShift} from '../services/sideshift';
import {prepareCeFiConvertRecord} from '../convert/prepare';
import {setRuntimeVenues} from '../config/venues';
import {adoptConvertRecord} from '../convertResume';
import {advanceProviderRecord} from '../convert/providerStatus';
import {salvageConvertStore} from '../convert/records';
import type {ConvertRecord} from '../convert';
import type {Identity} from '../lib/types';
import type {SideShiftQuoteResult, SideShiftFixedShift} from '../services/sideshift';

const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaTokens: true});
const ICP_ASSET = ASSETS.find(a => a.protocol === 'ic' && a.currency === 8)!;
const EURC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.token === 'EURC') as SelectableAsset & {protocol: 'solana'};
const USDC_ASSET = ASSETS.find(a => a.protocol === 'solana' && a.token === 'USDC') as SelectableAsset & {protocol: 'solana'};
const IDENTITY: Identity = {secretHex: 'aa'.repeat(32), publicHex: 'bb'.repeat(32), username: 'tester'};

// The INDEPENDENT derivation vector (e2e/harness/evm/evm-core.mjs over this seed) in its
// EIP-55 form — what the sheet must display and what the order must settle to.
const EXPECTED_ETH_ADDRESS = '0x229d8FE61B9ac2a88f29fef3872d990b7aaF6fb6';

const QUOTE: SideShiftQuoteResult = {
  venueId: 'sideshift-eth',
  quoteId: 'q-eth-1',
  settleAmount: '0.0495',
  rate: '0.0495',
  fetchedAtMs: 1_700_000_000_000,
};
const ORDER: SideShiftFixedShift = {
  id: 'shift-eth-1',
  depositAddress: 'icp-deposit-address-eth',
  depositMemo: null,
  depositAmount: '1',
  settleAmount: '0.0495',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

// Every mounted tree is unmounted in afterEach: the sheet arms its 1 s stale-quote clock on
// mount, so a tree left alive after its test would keep the interval armed and hang the whole
// file at exit (jest waits on the timer before the worker can die).
const mountedTrees: renderer.ReactTestRenderer[] = [];
afterEach(async () => {
  setEvmRpcUrl(''); // the rail gate back OFF (the jest default) for the next test
  const trees = mountedTrees.splice(0);
  for (const t of trees) {
    await act(async () => { t.unmount(); });
  }
});

const ethRowsFor = (source: SelectableAsset) => {
  const targets = resolveSwapTargets({
    catalog: CATALOG, source, targetCurrencies: ['ETH'], evmEnabled: true,
  }) ?? [];
  return targets.find(t => t.currency === 'ETH')?.rows.filter(r => r.rowId === 'sideshift-eth') ?? [];
};

const present = (tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance[] =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID);
const textOf = (tree: renderer.ReactTestRenderer, testID: string): string => {
  const node = present(tree, testID)[0];
  if (node == null) return '';
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
};

async function mountEthTargetWithEthRowPicked(): Promise<renderer.ReactTestRenderer> {
  let tree: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ConvertMode
      identity={IDENTITY}
      relayUrl="http://relay.test"
      catalog={CATALOG}
      selectedAsset={ICP_ASSET}
      assetBalances={{8: '2000000000'} as Record<number, string>}
      visibleCurrencies={['CHF', 'USD', 'EUR', 'BTC', 'ETH', 'ICP', 'SOL'] as const}
      currencyBalances={{}}
      onBack={() => undefined}
      onShowDepositAddress={() => undefined}
    />);
  });
  mountedTrees.push(tree!);
  // Clear the prefill, pick the ETH target, type 1, then pick the sideshift-eth row in the
  // Other-venues expander (the pair also carries the direct IC ckETH pool row, which the
  // auto-pick holds until the venue quote exists — a cefi row quotes only once picked).
  await act(async () => { present(tree!, 'convert-amount')[0].props.onChangeText(''); });
  await act(async () => { present(tree!, 'convert-target-chip-ETH')[0].props.onPress(); });
  await act(async () => { present(tree!, 'convert-amount')[0].props.onChangeText('1'); });
  await act(async () => { present(tree!, 'btn-convert-venues-other')[0].props.onPress(); });
  await act(async () => { present(tree!, 'convert-venue-sideshift-eth')[0].props.onPress(); });
  await act(async () => {});
  return tree!;
}

beforeEach(() => {
  jest.mocked(fetchSideShiftQuote).mockReset();
  jest.mocked(createSideShiftFixedShift).mockReset();
  jest.mocked(adoptConvertRecord).mockReset().mockResolvedValue(undefined);
  // The EVM rail ON for the mount tests (the same operator-override seam Settings ▸
  // Advanced writes; afterEach clears it).
  setEvmRpcUrl('http://127.0.0.1:8545');
  jest.mocked(fetchSideShiftQuote).mockImplementation(async (_relay, venue) => ({...QUOTE, venueId: venue.venue_id}));
  jest.mocked(createSideShiftFixedShift).mockImplementation(async (_relay, venue, args) => {
    void venue;
    expect(args.settleAddress).toBe(EXPECTED_ETH_ADDRESS);
    expect(args.refundAddress).toBe(mockSettleAccountId);
    expect(args.depositLedger).toBe(ICP_LEDGER_PRINCIPAL);
    expect(args.settleLedger).toBe(ETH_NATIVE_RAIL_ID); // the relay gates the payout address on THIS
    return {...ORDER};
  });
});

describe('the EVM-native gate and pair eligibility', () => {
  test('the ETH destination rides the EVM rail gate: off → absent, on → the sideshift-eth row', () => {
    const off = resolveSwapTargets({catalog: CATALOG, source: ICP_ASSET, targetCurrencies: ['ETH']}) ?? [];
    expect(off.find(t => t.currency === 'ETH')?.rows.some(r => r.rowId === 'sideshift-eth')).toBe(false);
    // The IC ckETH rows are untouched by the gate (the direct pool is still offered).
    expect(off.find(t => t.currency === 'ETH')?.rows.length ?? 0).toBeGreaterThan(0);

    const on = resolveSwapTargets({catalog: CATALOG, source: ICP_ASSET, targetCurrencies: ['ETH'], evmEnabled: true}) ?? [];
    const cefiRows = on.find(t => t.currency === 'ETH')?.rows.filter((r): r is Extract<SwapRow, {kind: 'cefi'}> => r.kind === 'cefi' && r.rowId === 'sideshift-eth') ?? [];
    expect(cefiRows).toHaveLength(1);
    const row = cefiRows[0]!;
    expect(row.outSym).toBe('ETH');
    expect(row.outDecimals).toBe(18);
    expect(row.outRailId).toBe(ETH_NATIVE_RAIL_ID);
    expect(row.outLedger).toBeNull();
    expect(row.outMint).toBeNull();
  });

  test('only the ICP deposit is eligible: the EURC and USDC sources reach no EVM-native row', () => {
    expect(ethRowsFor(EURC_ASSET)).toHaveLength(0);
    expect(ethRowsFor(USDC_ASSET)).toHaveLength(0);
    // And the adapter table itself serves exactly one deposit rail.
    expect(EVM_NATIVE_VENUES).toHaveLength(1);
    expect(evmNativeVenuesForLedger(ICP_LEDGER_PRINCIPAL)).toHaveLength(1);
    expect(evmNativeVenuesForLedger('not-a-rail')).toHaveLength(0);
  });

  test('the rail id matches the relay adapter twin, and the row is registry-shaped', () => {
    // crates/dpay-relay/src/sideshift.rs ETH_NATIVE_RAIL_ID (the drift alarm; the relay
    // also refuses an unknown settle rail at order time, so a drift fails loud twice).
    expect(ETH_NATIVE_RAIL_ID).toBe('evm:native-eth');
    expect(EVM_NATIVE_VENUES[0]!.pair_ledgers).toEqual([ICP_LEDGER_PRINCIPAL, ETH_NATIVE_RAIL_ID]);
    expect(EVM_NATIVE_VENUES[0]!.endpoint).toBe('https://sideshift.ai/api/v2');
  });

  test('the settle address is the device EVM identity, EIP-55-checksummed (independent vector)', () => {
    const kp = deriveEvmKeypair(IDENTITY.secretHex);
    expect(kp.address).toBe(EXPECTED_ETH_ADDRESS.toLowerCase());
    expect(toChecksumAddress(kp.address)).toBe(EXPECTED_ETH_ADDRESS);
  });
});

describe('the ETH destination surface: quote, order, record', () => {
  test('the sheet renders the EVM settle facts: address, payout-rail line, attributed quote', async () => {
    const tree = await mountEthTargetWithEthRowPicked();
    // The settle address line: the wallet's own EVM address, checksummed.
    await act(async () => {});
    expect(textOf(tree, 'convert-settle-address')).toBe(EXPECTED_ETH_ADDRESS);
    // The settle-rail line names the payout rail (the ETH-target ambiguity killer:
    // the pair's other row, the IC ckETH pool, pays out ckETH — not this).
    expect(textOf(tree, 'convert-settle-rail')).toContain('Ethereum');
    // The quote rides the RAIL ids end to end: deposit = the ICP ledger principal,
    // settle = the adapter's native-ETH rail id (what the relay maps onto ETH/ethereum).
    await waitQuote(tree);
    expect(jest.mocked(fetchSideShiftQuote).mock.calls[0]![2]).toBe(ICP_LEDGER_PRINCIPAL);
    expect(jest.mocked(fetchSideShiftQuote).mock.calls[0]![3]).toBe(ETH_NATIVE_RAIL_ID);
  });

  test('prepare builds the legless provider record with the EVM settle facts, and it hydrates', async () => {
    setRuntimeVenues(null); // venueOfId must resolve the ADAPTER-OWNED row (no overlay)
    const rec = prepareCeFiConvertRecord({
      id: 'rec-eth-1',
      quote: {venueId: 'sideshift-eth', pool: 'https://sideshift.ai/api/v2', tokenInLedger: ICP_LEDGER_PRINCIPAL, tokenOutLedger: ETH_NATIVE_RAIL_ID, amountIn: '100000000', amountOutGross: '49500000000000000', zeroForOne: null, feeMillionths: 0, fetchedAtMs: 1_700_000_000_000},
      order: ORDER,
      relayUrl: 'http://relay.test',
      settleAddress: EXPECTED_ETH_ADDRESS,
      inCurrency: 8,
      inSymbol: 'ICP',
      outSymbol: 'ETH',
      inDecimals: 8,
      outDecimals: 18,
    });
    expect(rec.step).toBe('awaiting_deposit');
    expect(rec.legs.length).toBe(0);
    expect(rec.venueId).toBe('sideshift-eth');
    expect(rec.outLedger).toBe(ETH_NATIVE_RAIL_ID);
    expect(rec.outSymbol).toBe('ETH');
    expect(rec.outDecimals).toBe(18);
    expect(rec.destAddress).toBe(EXPECTED_ETH_ADDRESS);
    expect(rec.destSymbol).toBe('ETH');
    expect(rec.expectedNet).toBe('49500000000000000');
    expect(rec.providerDeposit?.depositAmount).toBe('1');
    expect(rec.providerRef?.statusUrl).toBe('https://sideshift.ai/api/v2/shifts/shift-eth-1');
    // Provenance: the record HYDRATES (the venueOfId path resolves the adapter-owned row,
    // so the cefi half-pair exemption covers the absent outCurrency).
    const salvaged = salvageConvertStore({[rec.id]: {...rec, outAmountNet: '49500000000000000', outTx: 'eth-settle-hash-1'}});
    expect(salvaged.dropped).toBe(0);
    expect(salvaged.records[rec.id]!.outLedger).toBe(ETH_NATIVE_RAIL_ID);
  });

  test('prepare refuses an order whose depositAmount is not the quoted deposit', () => {
    setRuntimeVenues(null);
    expect(() => prepareCeFiConvertRecord({
      id: 'rec-eth-2',
      quote: {venueId: 'sideshift-eth', pool: 'https://sideshift.ai/api/v2', tokenInLedger: ICP_LEDGER_PRINCIPAL, tokenOutLedger: ETH_NATIVE_RAIL_ID, amountIn: '100000000', amountOutGross: '49500000000000000', zeroForOne: null, feeMillionths: 0, fetchedAtMs: 1_700_000_000_000},
      order: {...ORDER, depositAmount: '2'},
      relayUrl: 'http://relay.test',
      settleAddress: EXPECTED_ETH_ADDRESS,
      inCurrency: 8,
      inSymbol: 'ICP',
      outSymbol: 'ETH',
      inDecimals: 8,
      outDecimals: 18,
    })).toThrow(/deposit/);
  });

  test('prepare refuses a quote attributing a different venue (the signing-boundary red line)', () => {
    setRuntimeVenues(null);
    expect(() => prepareCeFiConvertRecord({
      id: 'rec-eth-3',
      quote: {venueId: 'sideshift', pool: 'https://sideshift.ai/api/v2', tokenInLedger: ICP_LEDGER_PRINCIPAL, tokenOutLedger: ETH_NATIVE_RAIL_ID, amountIn: '100000000', amountOutGross: '49500000000000000', zeroForOne: null, feeMillionths: 0, fetchedAtMs: 1_700_000_000_000},
      order: ORDER,
      relayUrl: 'http://relay.test',
      settleAddress: EXPECTED_ETH_ADDRESS,
      inCurrency: 8,
      inSymbol: 'ICP',
      outSymbol: 'ETH',
      inDecimals: 8,
      outDecimals: 18,
    })).toThrow();
  });

  test('a settled venue status lands through the OUT asset 18 decimals', async () => {
    // Unit-level: the provider driver normalizes SideShift's DECIMAL settle figure into
    // raw units through the record's own outDecimals (18 for native ETH — never 8).
    const base: ConvertRecord = {
      id: 'rec-eth-done', createdAtMs: 0, step: 'awaiting_deposit', venueId: 'sideshift-eth',
      inLedger: ICP_LEDGER_PRINCIPAL, outLedger: ETH_NATIVE_RAIL_ID,
      inSymbol: 'ICP', outSymbol: 'ETH', amountIn: '100000000', expectedGross: '4950000',
      expectedNet: '4950000', inFee: '0', outFee: '0', slippageBps: 0, legs: [],
      outDecimals: 18,
      providerRef: {orderId: 'shift-eth-1', statusUrl: 'https://sideshift.ai/api/v2/shifts/shift-eth-1'},
      providerDeposit: {depositAddress: 'icp-deposit-address-eth', depositAmount: '1'},
      destAddress: EXPECTED_ETH_ADDRESS, destSymbol: 'ETH',
    };
    global.fetch = (jest.fn(async () => Response.json({status: 'settled', settleAmount: '0.0495', settleHash: 'eth-tx-1'}))) as unknown as typeof fetch;
    try {
      const done = await advanceProviderRecord(base, async () => undefined);
      expect(done.step).toBe('done');
      expect(done.outAmountNet).toBe((BigInt('0.0495'.replace('.', '')) * 10n ** 14n).toString()); // 0.0495 ETH in wei
      expect(done.outTx).toBe('eth-tx-1');
    } finally {
      // @ts-expect-error test seam reset
      delete global.fetch;
    }
  });
});

/** Wait for the picked row's quote to land (the settle address + headline render). */
async function waitQuote(tree: renderer.ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 20 && jest.mocked(fetchSideShiftQuote).mock.calls.length === 0; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
  expect(jest.mocked(fetchSideShiftQuote).mock.calls.length).toBeGreaterThan(0);
  void tree;
}
