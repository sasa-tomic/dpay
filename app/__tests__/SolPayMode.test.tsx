/**
 * SolPayMode — the offline-signed SOL payment's share affordance (U-F1, 2026-08-16 UX finding)
 * and the auto-sign one-press rule (founder directive 2026-08-24).
 *
 * "Share signed code" fires Share.share with no in-DOM confirmation. The fix mirrors the
 * DepositSheet useCopyFeedback pattern: after the share resolves with sharedAction the label
 * flips to 'Copied ✓' for the 1500ms dwell; a dismissal leaves the label honest. The SOL rail's
 * ≤90s request window is untouched (blockhash physics — this test builds a fresh request like
 * the real flow does).
 *
 * The codec + offline signer are REAL (pure modules, no RPC): the test encodes a now-relative
 * solreq:v2 request and drives it through the same scan → AUTO-SIGN → qr path the camera flow
 * takes (the "Pay Now" gate press is the single deliberate press — no Approve button exists).
 * The read-only sign surface only survives a scan when the sign FAILS; the U-F5 payee-line tests
 * pin it there via a throwing signer mock (the honest terminal: reason + Cancel).
 * QrScanner is stubbed so its onScan prop can be driven directly.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, Text} from 'react-native';

jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));
jest.mock('../components/SolNfcTap', () => ({
  SolNfcTap: (_props: {role: string}) => null,
}));
jest.mock('../services/native', () => ({
  DpaySolNfc: {},
}));
// The signer is real by default (the U-F1 tests sign genuinely); the U-F5 suite swaps in a
// throwing implementation to park the read-only sign surface with its honest error terminal.
jest.mock('../solana', () => {
  const actual = jest.requireActual<typeof import('../solana')>('../solana');
  return {
    ...actual,
    signSolPayment: jest.fn(actual.signSolPayment),
    signSplPayment: jest.fn(actual.signSplPayment),
  };
});

import {encodeSolReq, type SolReqInput} from '../solana/qr';
import {signSolPayment} from '../solana';
import {SolPayMode} from '../components/SolPayMode';
import type {Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '33'.repeat(32), publicHex: '44'.repeat(32), username: 'Payer'};
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const BLOCKHASH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';

const shareSpy = jest.spyOn(Share, 'share');

function solReqUri(name: string = 'Cafe Sol'): string {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const input: SolReqInput = {
    rid: '0123456789abcdef0123456789abcdef',
    net: 'mainnet-beta',
    bh: BLOCKHASH,
    lvh: 300_000_000,
    slot: 290_000_000,
    iat,
    exp: iat + 90, // the v2 protocol maximum — fresh for another ~60s
    to: MERCHANT,
    amt: '2000000', // 0.002 SOL
    cur: 'SOL',
    mint: null,
    toAta: null,
    name,
    memo: '',
  };
  return encodeSolReq(input);
}

type SolPayModeProps = Parameters<typeof SolPayMode>[0];

function mountSolPay(props: Partial<SolPayModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SolPayMode
        identity={IDENTITY}
        nfcReady={false}
        solBalance="5000000000"
        usdcBalance="0"
        usdcAtaAbsent={false}
        payGate="none"
        selectedToken="SOL"
        onSent={() => {}}
        onSentUsdc={() => {}}
        onShowSolAddress={() => {}}
        onShowUsdcAddress={() => {}}
        onRecheckBalances={() => {}}
        subMode="scan"
        onSubModeChange={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

/** Drive the camera-scan path with the pay-intent gate armed — the AUTO-SIGN entry (the "Pay
 *  Now" gate press that armed the scanner IS the single deliberate press; the sync offline sign
 *  lands in the qr phase before this helper returns). */
async function scanToSign(tree: renderer.ReactTestRenderer, uri: string) {
  pressByTestID(tree, 'btn-sol-start-scan');
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan(uri);
  });
}

/** Mounted camera rail — the QrScanner stub carries onScan; presence = armed camera. */
function scannerNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && typeof node.props.onScan === 'function');
}

/** Mounted HCE rail — the SolNfcTap stub carries role="card"; presence = armed card. */
function cardNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && node.props.role === 'card');
}
/** Depth-first text of a props.children tree — strings, numbers, arrays, nested elements. */
function textOf(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  const el = children as {props?: {children?: unknown}};
  return el.props ? textOf(el.props.children) : '';
}

/** All visible text of Text nodes — the assertion target for label flips. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => textOf(n.props.children));
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string) {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => {
    node.props.onPress();
  });
}

async function pressByLabel(tree: renderer.ReactTestRenderer, label: string) {
  const node = tree.root.findAll(node => node.props && node.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`no node with accessibilityLabel=${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

beforeEach(() => {
  // Fake timers keep jest's loop clean; Date stays real — the v2 request's iat/exp math (and the
  // decoder's freshness check) reads Date.now().
  jest.useFakeTimers({doNotFake: ['Date']});
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
  // The signer mock defaults to the REAL implementation each test (the U-F5 suite swaps in a
  // throwing one to park the sign surface — without this reset it leaks into later suites).
  jest.mocked(signSolPayment).mockReset().mockImplementation(jest.requireActual<typeof import('../solana')>('../solana').signSolPayment);
});

afterEach(() => {
  jest.useRealTimers(); // the share dwell timer would keep the worker alive
  (Platform as {OS: string}).OS = 'ios'; // restore the jest-preset default (webLabel() tests mutate it)
});

// The jest preset pins Platform.OS to 'ios' (native). shareConfirmLabel: web says what the
// fallback DID ('Copied ✓' — the no-Web-Share path copies), native says 'Shared ✓' (the real
// Share sheet was the feedback, nothing was copied). The flip test runs as WEB; native has its own.
function asWeb() {
  (Platform as {OS: string}).OS = 'web';
}

describe('SolPayMode — share signed code feedback (U-F1)', () => {
  test('(web) "Share signed code" flips to "Copied ✓" after the share resolves', async () => {
    asWeb();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri()); // pure offline auto-sign → the qr phase
    expect(texts(tree)).toContain('Share signed code');
    await pressByLabel(tree, 'Share signed payment');
    expect(shareSpy).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('solpay:v2?')}));
    expect(texts(tree)).toContain('Copied ✓');
    expect(texts(tree)).not.toContain('Share signed code');
    act(() => {
      tree.unmount();
    });
  });

  test('native: a completed Share sheet flips to "Shared ✓" — never "Copied ✓" (nothing was copied)', async () => {
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    await pressByLabel(tree, 'Share signed payment');
    expect(texts(tree)).toContain('Shared ✓');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });

  test('a dismissed share sheet leaves the label honest (dismissedAction does not flip)', async () => {
    shareSpy.mockResolvedValue({action: 'dismissedAction' as const});
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    await pressByLabel(tree, 'Share signed payment');
    expect(texts(tree)).toContain('Share signed code');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });
});

describe('SolPayMode — sign status shows the short destination under a merchant name (U-F5)', () => {
  function textByTestID(tree: renderer.ReactTestRenderer, testID: string): string {
    const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
    if (!node) throw new Error(`no node with testID=${testID}`);
    return textOf(node.props.children);
  }

  // The sync offline sign succeeds instantly, so the read-only sign surface only SURVIVES a
  // failing sign — pin it there (the honest terminal keeps the payee lines + reason + Cancel).
  function throwOnSign() {
    jest.mocked(signSolPayment).mockImplementation(() => {
      throw new Error('sign failed');
    });
  }

  test('named merchant: the dim sol-pay-payee line carries the short base58 address', async () => {
    throwOnSign();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri('Cafe Sol'));
    expect(texts(tree)).toContain('to Cafe Sol');
    // short() = first 8 chars + '…' — MERCHANT starts 'Ecs89dz8'
    expect(textByTestID(tree, 'sol-pay-payee')).toBe('Ecs89dz8…');
    expect(texts(tree)).toContain('sign failed'); // honest sign-error terminal, no silent success
    expect(texts(tree)).not.toContain('Approve'); // one-press rule: no sign button exists
    act(() => {
      tree.unmount();
    });
  });

  test('unnamed merchant: the primary line carries the FULL address, no duplicate short line', async () => {
    throwOnSign();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri(''));
    expect(texts(tree)).toContain(`to ${MERCHANT}`);
    const payee = tree.root.findAll(node => node.props && node.props.testID === 'sol-pay-payee');
    expect(payee).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });
});

// Pay-intent scan gate (founder rule 2026-08-23, same as IC PayMode): the camera (QrScanner)
// and the HCE card (SolNfcTap) mount ONLY after "Pay Now". The sol-pay-scan container
// + hint stay in IDLE; reset() and leaving the scan sub-mode disarm.
describe('SolPayMode — pay-intent scan gate', () => {
  function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
    return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
  }

  test('idle: NEITHER rail mounts; sol-pay-scan + CTA render; one tap arms BOTH rails', () => {
    const tree = mountSolPay({nfcReady: true});
    expect(hasTestID(tree, 'sol-pay-scan')).toBe(true); // idle keeps the container + hint
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0); // camera rail off
    expect(cardNodes(tree)).toHaveLength(0); // HCE rail off (nfcReady, but gated)
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    expect(cardNodes(tree)).toHaveLength(1);
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(false);
    act(() => {
      tree.unmount();
    });
  });

  test("reset() (the qr-phase Cancel) disarms — the next attempt needs a fresh intent", async () => {
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    expect(hasTestID(tree, 'btn-sol-pay-discard')).toBe(true); // the qr-phase Cancel
    pressByTestID(tree, 'btn-sol-pay-discard');
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true); // idle CTA back
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  test('leaving the scan sub-mode disarms; flipping back shows the idle CTA again', () => {
    const tree = mountSolPay();
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    act(() => {
      tree.update(
        <SolPayMode
          identity={IDENTITY}
          nfcReady={false}
          solBalance="5000000000"
          usdcBalance="0"
          usdcAtaAbsent={false}
          payGate="none"
          selectedToken="SOL"
          onSent={() => {}}
          onSentUsdc={() => {}}
          onShowSolAddress={() => {}}
          onShowUsdcAddress={() => {}}
          onRecheckBalances={() => {}}
          subMode="send"
          onSubModeChange={() => {}}
        />,
      );
    });
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.update(
        <SolPayMode
          identity={IDENTITY}
          nfcReady={false}
          solBalance="5000000000"
          usdcBalance="0"
          usdcAtaAbsent={false}
          payGate="none"
          selectedToken="SOL"
          onSent={() => {}}
          onSentUsdc={() => {}}
          onShowSolAddress={() => {}}
          onShowUsdcAddress={() => {}}
          onRecheckBalances={() => {}}
          subMode="scan"
          onSubModeChange={() => {}}
        />,
      );
    });
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });
});
