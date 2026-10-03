/**
 * The stuck surfaces — 2026-10-02 POCO P0.
 *
 * The founder's device showed a stuck record ("Unbekannter Ausgang") with NO per-step
 * evidence, NO error, and a "keeps watching" claim on a window that had expired 1.5 h
 * earlier. Hard rules pinned here, on EVERY stuck surface:
 *  - the per-leg receipts block ALWAYS renders (what happened, not just "unknown");
 *  - a record-carried failureDetail renders verbatim — never hidden;
 *  - the expiry line flips: window open → today's copy; EXPIRED → the honest
 *    nothing-can-move-anymore copy (convert-stuck-expired);
 *  - the engine's last completed probe renders (convert-stuck-last-checked);
 *  - the window_closed resolution renders its honest failed_refunded body.
 *
 * The six surfaces: StatePanel, RouteStatePanel, CrossRailStatePanel, SolStatePanel,
 * EvmStatePanel (here) and ConvertIntentSheet's stuck block (pinned in convertMode.test.tsx,
 * which owns that mount harness).
 */
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../convertResume', () => ({
  convertResumeSnapshot: jest.fn((): Record<string, unknown> => ({})),
  subscribeConvertRecords: jest.fn(() => () => undefined),
  adoptConvertRecord: jest.fn(async () => undefined),
  acknowledgeStuckRecord: jest.fn(async () => undefined),
  abortConvertRecord: jest.fn(async () => undefined),
  providerLastCheckedAtMs: jest.fn((): number | null => null),
  attachCctpBurnTx: jest.fn(async () => undefined),
  confirmCrossRailSolLeg: jest.fn(async () => null),
  declineCctpHandoff: jest.fn(async () => undefined),
}));

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(async () => '40782196'),
    icpPrincipalFromPubkey: jest.fn(async () => 'principal'),
  },
}));

import {noteStuckProbeDone, clearStuckProbes} from '../convert/stuckProbeLog';
import {StatePanel} from '../components/ConvertStatePanel';
import {RouteStatePanel} from '../components/ConvertRouteStatePanel';
import {CrossRailStatePanel} from '../components/ConvertCrossRailStatePanel';
import {SolStatePanel} from '../components/SolStatePanel';
import {EvmStatePanel} from '../components/EvmStatePanel';
import type {ConvertRecord} from '../convert';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const POOL = '65mrh-fqaaa-aaaaar-qapoa-cai';
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const OPEN_AT = Date.now() + 600_000;
const PASSED_AT = Date.now() - 90 * 60_000; // the founder's shape: expired 1.5 h ago

const base = (over: Partial<ConvertRecord>): ConvertRecord => ({
  id: 'rec-1',
  createdAtMs: Date.now() - 120 * 60_000,
  step: 'stuck',
  venueId: 'icpswap',
  inCurrency: 8,
  outCurrency: 7,
  inLedger: ICP_LEDGER,
  outLedger: VCHF_LEDGER,
  inSymbol: 'ICP',
  outSymbol: 'CHF',
  amountIn: '100000000',
  expectedGross: '190000000',
  expectedNet: '189990000',
  inFee: '10000',
  outFee: '10000',
  slippageBps: 100,
  legs: [
    {canister: ICP_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'aa', requestIdHex: 'r1', expiresAtMs: OPEN_AT},
    {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'bb', requestIdHex: 'r2', expiresAtMs: OPEN_AT},
  ],
  ...over,
});

// A composed record in the founder's exact shape: leg-1 (IC pool swap) confirmed, the venue
// deposit leg sent, outcome unknown — receipts in record.legs, plan states frozen.
const composed = (expiryMs: number): ConvertRecord => base({
  id: 'comp-1',
  inLedger: VCHF_LEDGER,
  outSymbol: 'SOL',
  outCurrency: undefined,
  legs: [
    {canister: VCHF_LEDGER, method: 'icrc2_approve', argHex: 'a', envelopeHex: 'aa', requestIdHex: 'c1', expiresAtMs: expiryMs},
    {canister: POOL, method: 'depositFromAndSwap', argHex: 'b', envelopeHex: 'bb', requestIdHex: 'c2', expiresAtMs: expiryMs},
    {canister: ICP_LEDGER, method: 'icrc1_transfer', argHex: 'c', envelopeHex: 'cc', requestIdHex: 'c3', expiresAtMs: expiryMs},
  ],
  legPlan: [
    {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'confirmed'},
    {kind: 'swap', canister: POOL, fee: '', state: 'confirmed'},
    {kind: 'deposit_transfer', canister: ICP_LEDGER, fee: '10000', state: 'sent'},
  ],
  hopLedger: ICP_LEDGER,
  hopSymbol: 'ICP',
  hopCurrency: 7,
  composedDeposit: {
    venueId: 'sideshift', orderId: 'ord-9', depositAddress: 'venue-acct', depositOwner: 'venue-p',
    amountDecimal: '0.9', amountRaw: '90000000', fee: '10000',
    settleSymbol: 'SOL', settleDecimals: 9,
  },
  providerRef: {orderId: 'ord-9'},
});

const solana = (): ConvertRecord => base({
  id: 'sol-1',
  inSymbol: 'USDC',
  outSymbol: 'SOL',
  inCurrency: undefined,
  outCurrency: undefined,
  inLedger: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  outLedger: 'So11111111111111111111111111111111111111112',
  legs: [],
  solanaLeg: {protocol: 'solana', signedTxHex: 'aa', signature: '5XxSolSig9', lastValidBlockHeight: 12345},
});

const evm = (): ConvertRecord => base({
  id: 'evm-1',
  inSymbol: 'ZCHF',
  outSymbol: 'ETH',
  inCurrency: undefined,
  outCurrency: undefined,
  inLedger: '0xzchf',
  outLedger: 'native-eth',
  legs: [],
  evmSwap: {
    protocol: 'evm', chainId: 1, venueId: 'uniswap-v3', inRailId: 'evm:1:0xzchf', outRailId: 'evm:native-eth:1',
    tokenIn: '0xzchf', tokenOut: '', inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
    amountIn: '400000000000000000', minOut: '1', feeTier: 500, deadlineSecs: Math.floor(Date.now() / 1000) + 600,
    slippageBps: 100, txHashes: ['0xapprove1', '0xswap2'],
  },
});

type Tree = renderer.ReactTestRenderer;
const mounted: Tree[] = [];
afterEach(() => {
  // The stuck panels arm a 30 s forceTick timer — unmount every tree so no tick fires
  // after the environment tears down (a require after teardown fails the suite).
  while (mounted.length > 0) mounted.pop()!.unmount();
  clearStuckProbes();
});
const mount = (el: React.ReactElement): Tree => {
  let t!: Tree;
  act(() => { t = renderer.create(el); });
  mounted.push(t);
  return t;
};
const present = (t: Tree, id: string) => t.root.findAll((n) => n.props.testID === id).length > 0;
const textOf = (t: Tree, id: string): string => {
  const n = t.root.find((x) => x.props.testID === id);
  const walk = (x: {children?: unknown[]}): string =>
    (x.children ?? []).map((c) => (typeof c === 'string' ? c : walk(c as {children?: unknown[]}))).join('');
  return walk(n as unknown as {children?: unknown[]});
};
const allText = (t: Tree, id: string): string =>
  t.root.findAll((n) => n.props.testID === id).map((n) => textOfTree(n as never)).join('\n');
const textOfTree = (n: {children?: unknown[]}): string =>
  (n.children ?? []).map((c) => (typeof c === 'string' ? c : textOfTree(c as {children?: unknown[]}))).join('');

describe.each([
  ['StatePanel', StatePanel, (rec: ConvertRecord) => ({record: rec, onBack: () => {}})],
  ['RouteStatePanel', RouteStatePanel, (rec: ConvertRecord) => ({record: rec, onBack: () => {}})],
  ['SolStatePanel', SolStatePanel, (rec: ConvertRecord) => ({record: rec, onBack: () => {}})],
  ['EvmStatePanel', EvmStatePanel, (rec: ConvertRecord) => ({record: rec, onBack: () => {}})],
])('%s stuck surface', (_name, Panel, props) => {
  const fixture: () => ConvertRecord = () =>
    Panel === SolStatePanel ? solana() : Panel === EvmStatePanel ? evm() : base({});

  test('the receipts block renders per leg with its state', () => {
    const tree = mount(React.createElement(Panel as never, props(fixture())));
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(present(tree, 'convert-stuck-receipts')).toBe(true);
    const receipts = allText(tree, 'convert-stuck-receipts');
    expect(receipts).toContain(convertEn.multihop.legStateSent); // the honest per-leg fact
    expect(present(tree, 'convert-stuck-leg-0')).toBe(true);
  });

  test('a carried failureDetail renders verbatim — never hidden', () => {
    const rec = fixture();
    rec.failureDetail = 'the venue poll answered unknown';
    const tree = mount(React.createElement(Panel as never, props(rec)));
    expect(textOf(tree, 'convert-stuck-error')).toContain('the venue poll answered unknown');
  });

  test('no failureDetail, no error line', () => {
    const tree = mount(React.createElement(Panel as never, props(fixture())));
    expect(present(tree, 'convert-stuck-error')).toBe(false);
  });

  test('the last checked fact renders once a probe completed', () => {
    const rec = fixture();
    noteStuckProbeDone(rec.id, Date.now() - 30_000);
    const tree = mount(React.createElement(Panel as never, props(rec)));
    expect(present(tree, 'convert-stuck-last-checked')).toBe(true);
    expect(textOf(tree, 'convert-stuck-last-checked')).toContain(convertEn.stuckLastCheckedLine('').trim());
  });
});

describe('the IC expiry flip (StatePanel with a wall-clock window)', () => {
  test('window open: today\'s expiry line, no expired block', () => {
    const tree = mount(<StatePanel record={base({})} onBack={() => {}} />);
    expect(present(tree, 'convert-expiry')).toBe(true);
    expect(textOf(tree, 'convert-expiry')).toContain(convertEn.expiryLine('').slice(0, 11));
    expect(present(tree, 'convert-stuck-expired')).toBe(false);
  });

  test('window EXPIRED: the honest nothing-can-move copy replaces the watching claim', () => {
    const rec = base({legs: base({}).legs.map(l => ({...l, expiresAtMs: PASSED_AT}))});
    const tree = mount(<StatePanel record={rec} onBack={() => {}} />);
    expect(present(tree, 'convert-stuck-expired')).toBe(true);
    // The open-window line and the expired line are DIFFERENT copy — the line flipped.
    expect(textOf(tree, 'convert-expiry')).not.toContain('Expires by');
    expect(allText(tree, 'convert-stuck-expired')).toContain(convertEn.stuckExpiredBody);
    // The "keeps watching" claim is GONE past the deadline — the founder's exact complaint.
    expect(allText(tree, 'convert-stuck')).not.toContain(convertEn.stuckWatching);
  });

  test('the composed record renders EVERY leg: the settled swap, the sent deposit', () => {
    const tree = mount(<StatePanel record={composed(OPEN_AT)} onBack={() => {}} />);
    const receipts = allText(tree, 'convert-stuck-receipts');
    expect(present(tree, 'convert-stuck-leg-2')).toBe(true); // the deposit leg
    expect(receipts).toContain(convertEn.multihop.legStateConfirmed); // leg-1 settled — visible
    expect(receipts).toContain(convertEn.multihop.legStateSent);
  });

  test('the composed record carries its record-level evidence (the deposit row id)', () => {
    const rec = composed(PASSED_AT);
    rec.composedDeposit = {...rec.composedDeposit!, sentTx: 'block-38758651'};
    const tree = mount(<StatePanel record={rec} onBack={() => {}} />);
    expect(allText(tree, 'convert-stuck-receipts')).toContain('block-38758651');
  });

  test('failed_refunded + window_closed renders the honest nothing-left body + the detail', () => {
    const rec = base({step: 'failed_refunded', failureCode: 'window_closed', failureDetail: 'swap unconfirmed when its signed window expired - nothing left the wallet'});
    const tree = mount(<StatePanel record={rec} onBack={() => {}} />);
    const all = allText(tree, 'convert-failed');
    expect(all).toContain('could not be confirmed before its window closed');
    expect(all).toContain('nothing left the wallet');
    expect(all).not.toContain(convertEn.refundedBody('')); // no false "the pool returned it" claim
  });
});

describe('CrossRailStatePanel stuck surface', () => {
  const xr = (): ConvertRecord => base({
    id: 'xr-1',
    legs: base({}).legs.map(l => ({...l, expiresAtMs: PASSED_AT})),
    legPlan: [
      {kind: 'approve', canister: ICP_LEDGER, fee: '10000', state: 'confirmed'},
      {kind: 'swap', canister: POOL, fee: '', state: 'confirmed'},
      {kind: 'approve', canister: VCHF_LEDGER, fee: '10000', state: 'sent'},
      {kind: 'withdraw_erc20', canister: 'minter', fee: '', state: 'pending'},
      {kind: 'cctp_burn', canister: '', fee: '', state: 'pending'},
    ],
    crossRail: {kind: 'cctp', solAddress: 'SolAddr1', mintRecipientAta: 'AtaAddr1'},
  });
  test('receipts + error + expiry flip render on the cross-rail surface', () => {
    const rec = xr();
    rec.failureDetail = 'icp poll answered unknown';
    const tree = mount(
      <CrossRailStatePanel record={rec} secretHex="sec" relayUrl="http://r" solLamports={null} onBack={() => {}} />,
    );
    expect(present(tree, 'convert-stuck')).toBe(true);
    expect(present(tree, 'convert-stuck-receipts')).toBe(true);
    expect(present(tree, 'convert-stuck-leg-4')).toBe(true); // the burn leg renders too
    expect(textOf(tree, 'convert-stuck-error')).toContain('icp poll answered unknown');
    expect(present(tree, 'convert-stuck-expired')).toBe(true);
  });
  test('the DEVICE-burn dead end (stage 2): the USDC address is named, never "in this wallet"', () => {
    const rec = xr();
    rec.step = 'failed_leg';
    rec.failureCode = 'burn_refused';
    rec.destAddress = '0xAbC0000000000000000000000000000000000001';
    rec.failureDetail = 'the crossing needs about 48000000000000 wei of ETH';
    rec.legPlan = rec.legPlan!.map((p, i) => (i === 4 ? {...p, state: 'failed' as const} : p));
    const tree = mount(
      <CrossRailStatePanel record={rec} secretHex="sec" relayUrl="http://r" solLamports={null} onBack={() => {}} />,
    );
    const all = allText(tree, 'convert-failed-leg');
    expect(all).toContain(convertEn.crossrail.burnFailedBody(rec.destAddress!, '').slice(0, 40));
    expect(all).toContain('0xAbC0000000000000000000000000000000000001');
    expect(all).toContain('the crossing needs about 48000000000000 wei of ETH');
    // The generic failed_leg body would LIE here ("your funds are USDC in this wallet").
    expect(all).not.toContain(convertEn.multihop.failedLegBody('USDC', '').slice(0, 30));
  });
});

describe('the new copy exists in all four locales (type-checked by strict tsc, pinned here)', () => {
  test.each(['stuckReceiptsTitle', 'stuckExpiredBody'] as const)('%s is present in en/de/es/fr', (k) => {
    for (const cat of [convertEn, convertDe, convertEs, convertFr]) {
      expect(typeof cat[k]).toBe('string');
      expect((cat[k] as string).length).toBeGreaterThan(0);
    }
  });
  test.each(['stuckErrorLine', 'stuckExpiredLine', 'stuckLastCheckedLine', 'failedWindowClosedBody'] as const)('%s is a function in all locales', (k) => {
    for (const cat of [convertEn, convertDe, convertEs, convertFr]) {
      expect(typeof cat[k]).toBe('function');
    }
  });
});
