/**
 * The failed-convert body routing (founder 2026-10-13: "convert sometimes unnecessarily says
 * 'nothing was sent'").
 *
 * The disposition reads the STRUCTURED truth - the persisted leg hashes on the record - never
 * the failure string:
 *  - no broadcast leg on record → the nothing-sent body is legal ("Nothing was sent.");
 *  - any broadcast leg on record → the sent-but-stopped body: a transaction is on-chain, the
 *    fee is spent, no balance claim is made, and the hash renders below.
 * Regression for the old defect: a post-broadcast throw (receipt RPC hiccup, leg-2 failure)
 * used to land failed_refunded and print "Nothing was sent" while the swap leg was on-chain.
 */

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

import {afterEach, describe, expect, jest, test} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import {EvmStatePanel} from '../components/EvmStatePanel';
import type {ConvertRecord} from '../convert';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const record = (over: Partial<ConvertRecord>): ConvertRecord => ({
  id: 'rec-f',
  createdAtMs: Date.now() - 5 * 60_000,
  step: 'failed_refunded',
  venueId: 'uniswap-v3',
  inSymbol: 'ZCHF',
  outSymbol: 'ETH',
  amountIn: '400000000000000000',
  ...over,
} as ConvertRecord);

type Tree = renderer.ReactTestRenderer;
const mounted: Tree[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});
const mount = (rec: ConvertRecord): Tree => {
  let t!: Tree;
  act(() => {
    t = renderer.create(React.createElement(EvmStatePanel, {record: rec, onBack: () => {}}));
  });
  mounted.push(t);
  return t;
};
const bodyText = (t: Tree): string => {
  const n = t.root.find((x) => x.props.testID === 'convert-failed');
  const walk = (x: {children?: unknown[]}): string =>
    (x.children ?? []).map((c) => (typeof c === 'string' ? c : walk(c as {children?: unknown[]}))).join('');
  return walk(n as unknown as {children?: unknown[]});
};

describe('EvmStatePanel failed body routing (structured truth, not string-sniffing)', () => {
  test('no broadcast leg → the nothing-sent body, no transaction record', () => {
    const tree = mount(record({failureCode: 'unknown', failureDetail: 'some rpc hiccup'}));
    const text = bodyText(tree);
    expect(text.includes('Nothing was sent')).toBe(true);
    expect(text.includes('sent but stopped')).toBe(false);
    expect(text.includes('0x')).toBe(false);
  });

  test('a broadcast leg on record → the sent-but-stopped body + the hash below', () => {
    const rec = record({
      failureCode: 'unknown',
      failureDetail: 'some rpc hiccup',
      evmSwap: {
        protocol: 'evm', chainId: 1, venueId: 'uniswap-v3', inRailId: 'evm:1:zchf', outRailId: 'evm:native-eth:1',
        tokenIn: '0xzchf', tokenOut: '', inSymbol: 'ZCHF', outSymbol: 'ETH', inDecimals: 18, outDecimals: 18,
        amountIn: '400000000000000000', minOut: '1', feeTier: 500, deadlineSecs: Math.floor(Date.now() / 1000) + 600,
        txHashes: ['0xabc123'],
      },
    } as Partial<ConvertRecord>);
    const tree = mount(rec);
    const text = bodyText(tree);
    expect(text.includes('Nothing was sent')).toBe(false);
    expect(text.includes('sent but stopped')).toBe(true);
    expect(text.includes('0xabc123')).toBe(true);
  });

  test('the four locales keep both bodies and the family phrases', () => {
    for (const m of [convertEn, convertDe, convertEs, convertFr]) {
      expect(m.evm.failedBody('X')).toMatch(/nothing was sent|nichts gesendet|no se envi|rien n/i);
      expect(m.evm.sentFailedBody).not.toMatch(/nothing was sent|nichts gesendet|no se envi|rien n/);
    }
  });
});
