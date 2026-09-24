/**
 * ReceiveMode — the merchant request screen's share affordance (U-F1, 2026-08-16 UX finding).
 *
 * "Share request link" fires Share.share with no in-DOM confirmation (a known cosmetic gap on
 * web, where the code path is Web Share + clipboard fallback). The fix mirrors the DepositSheet
 * useCopyFeedback pattern: after the share resolves with sharedAction the label flips to
 * 'Link copied ✓' for the 1500ms dwell. The testID stays `btn-share-request` (the e2e contract)
 * and a dismissal leaves the label honest.
 *
 * Uses react-test-renderer (the project's only renderer). The native encode + ledger-history
 * confirmation are mocked at their module boundaries; QrScanner is stubbed (the camera never opens —
 * the request-QR branch only mounts it while scanning, which this flow never enters).
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, StyleSheet, Text, View} from 'react-native';

jest.mock('../services/native', () => ({
  DpayCore: {
    encodeRequest: jest.fn(),
    // The wallet's own ICRC-1 account — the destination of the shareable payment link.
    icpSelfPrincipal: jest.fn(async () => 'ryjl3-tyaaa-aaaaa-aaaba-cai'),
  },
  DpayNfc: {
    buildRequest: jest.fn(),
  },
}));
jest.mock('../services/icp', () => ({icStampExpiry: jest.fn()}));
jest.mock('../services/relay', () => ({
  fetchWithTimeout: jest.fn(async () => ({ok: false})),
}));
jest.mock('../services/rail', () => ({
  confirmIncomingTransfer: jest.fn(),
  submitAndConfirmIncomingTransfer: jest.fn(),
  qrPayloadToEnvelopeHex: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
}));
jest.mock('../components/NfcTap', () => ({NfcTap: jest.fn(() => null)}));
// The checkout routes, at their module boundary: what this suite asserts is what the counter is HANDED
// (the charge-open's note), not what the relay then does with it — `CheckoutCharge.test.tsx` owns the
// counter's own outcomes, and e2e flow 114 owns the route end to end.
jest.mock('../services/checkout', () => {
  const actual = jest.requireActual('../services/checkout') as Record<string, unknown>;
  return {
    ...actual, // CHECKOUT_OFFER / chfCents / checkoutRawUnits / checkoutPriceUnits stay REAL — they are the rules
    openCheckoutCharge: jest.fn(),
    checkoutChargeStatus: jest.fn(),
    cancelCheckoutCharge: jest.fn(),
  };
});

import {DpayCore, DpayNfc} from '../services/native';
import {icStampExpiry} from '../services/icp';
import {confirmIncomingTransfer, fetchLedgerFee} from '../services/rail';
import {openCheckoutCharge, checkoutChargeStatus} from '../services/checkout';
// Spied (not mocked): the store's own write behaviour is txNotes.test.ts's to pin; here only the
// SEAM's arguments matter, and the real write keeps the rest honest.
import * as txNotes from '../services/txNotes';
import {ReceiveMode} from '../components/ReceiveMode';
import {NfcTap} from '../components/NfcTap';
import {receiptShareBlob, parsePayLink} from '../lib/deepLink';
import {QrCode} from '../components/QrCode';
import {M} from '../i18n';
import {BUNDLED_NETWORKS, icpCatalogOf, fmtCurrencyAmountCompact} from '../config/catalog';
import {S} from '../styles';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';
import type {Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};

// Record<AssetId, BalanceView> requires both SOL keys (the ic:${number} template adds none). The
// request flow never reads them; a minimal honest view keeps the prop type-checkable.
const BALANCES: Record<AssetId, BalanceView> = {
  'solana:SOL': {displayText: '—', status: 'unavailable', failure: null},
  'solana:USDC': {displayText: '—', status: 'unavailable', failure: null},
};

// The wallet's own ICRC-1 account (mocked DpayCore.icpSelfPrincipal) — the destination of the
// shareable payment link built from an open request.
const SELF_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
// The selected asset the share link names. DEMO settles on the Internet Computer like every other
// IC row, so its link reads `?asset=DEMO&network=internet-computer`.
const DEMO_ASSET: SelectableAsset = {
  id: 'ic:0', protocol: 'ic', currency: 0, symbol: 'DEMO', linkToken: 'DEMO',
  networkLabel: 'play money', network: null, decimals: 2, minFractionDigits: 0, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'demo',
};

const shareSpy = jest.spyOn(Share, 'share');

type ReceiveModeProps = Parameters<typeof ReceiveMode>[0];

function fullProps(over: Partial<ReceiveModeProps> = {}): ReceiveModeProps {
  return {
    identity: IDENTITY,
    relayUrl: 'http://relay.test',
    online: true,
    nfcStatus: 'unsupported',
    onReceived: () => {},
    catalog: [],
    depositCurrency: 0,
    depositDisplay: null,
    depositChainId: null,
    depositNativeEth: false,
    subMode: 'request',
    onSubModeChange: () => {},
    // The code form this suite is about is the dpay one (the share affordance lives on its request
    // QR). The checkout form's own behaviour is `CheckoutCharge.test.tsx`; a relay that serves no checkout
    // hides the selector entirely, which is also this fixture's posture.
    codeForm: 'dpay',
    onCodeFormChange: () => {},
    checkoutAvailable: false,
    selectedCurrency: 0,
    assets: [DEMO_ASSET],
    selectedAssetId: 'ic:0',
    balances: BALANCES,
    onSelectAsset: () => {},
    onSelectAssetProgrammatic: () => {},
    ...over,
  };
}

function mountReceive(props: Partial<ReceiveModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ReceiveMode {...fullProps(props)} />);
  });
  return tree;
}

/** Re-render with overrides — how Wallet delivers a dpay:pay blob AFTER a request is open. */
function rerenderReceive(tree: renderer.ReactTestRenderer, over: Partial<ReceiveModeProps>) {
  act(() => {
    tree.update(<ReceiveMode {...fullProps(over)} />);
  });
}

/** Enter an amount + press Request — drives makeRequest into the request-QR branch. */
async function makeRequest(tree: renderer.ReactTestRenderer, amount = '25') {
  const input = tree.root.findAll(node => node.props && node.props.testID === 'amount-input')[0];
  act(() => {
    input.props.onChangeText(amount);
  });
  const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-request')[0];
  await act(async () => {
    btn.props.onPress();
  });
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

function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

beforeEach(() => {
  // Fake timers: the request-QR branch runs a 1s `now` display clock whose tick lands outside act
  // and past the test's end. Date stays real (the request expiry math uses Date.now()).
  jest.useFakeTimers({doNotFake: ['Date']});
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
  // The live ledger-fee query behind the exact-price netting (each netting test pins its own
  // answer; the default is a benign known fee for any mount that never asks — DEMO never does).
  jest.mocked(fetchLedgerFee).mockReset().mockResolvedValue('10000');
});

afterEach(() => {
  jest.useRealTimers(); // the 1s display clock + the share dwell would keep the worker alive
  (Platform as {OS: string}).OS = 'ios'; // restore the jest-preset default (webLabel() tests mutate it)
});

// The jest preset pins Platform.OS to 'ios' (native). shareConfirmLabel: web says what the
// fallback DID ('Link copied ✓' — the no-Web-Share path copies), native says 'Shared ✓' (the real
// Share sheet was the feedback, nothing was copied). The flip test runs as WEB; native has its own.
function asWeb() {
  (Platform as {OS: string}).OS = 'web';
}

describe('ReceiveMode — share request feedback (U-F1)', () => {
  test('NFC request uses a certified short ingress expiry while the QR keeps its 15-minute expiry', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcStatus: 'ready'});
    await makeRequest(tree);
    expect(DpayNfc.buildRequest).toHaveBeenCalledWith(
      IDENTITY.publicHex, '2500', expect.any(String), 1_800_000_240, 0, IDENTITY.username, '',
    );
    // The wire encoder is GONE from the request path (founder decision 2026-09-12: the QR is the
    // payment link; a machine code leaves the screen only over NFC) — this is the tripwire that
    // keeps it gone. The QR's own validity is the 15-minute request window, shown by its countdown.
    expect(DpayCore.encodeRequest).not.toHaveBeenCalled();
    expect(texts(tree).join(' ')).toContain('Valid for ~15 min');
  });

  test('expired short NFC request is no longer advertised while the QR remains valid', async () => {
    let nowMs = 1_800_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.mocked(icStampExpiry).mockResolvedValue('1800000002000000000');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcStatus: 'ready'});
    await makeRequest(tree);
    expect(texts(tree).join(' ')).toContain('or let them tap');

    nowMs += 3_000;
    act(() => jest.advanceTimersByTime(1_000));
    const visible = texts(tree).join(' ');
    expect(visible).toContain('NFC tap expired');
    expect(visible).not.toContain('or let them tap');
    expect(hasTestID(tree, 'request-qr')).toBe(true);
    dateSpy.mockRestore();
  });

  test('an active NFC settlement survives request expiry for a result-only re-tap', async () => {
    let nowMs = 1_800_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.mocked(icStampExpiry).mockResolvedValue('1800000002000000000');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcStatus: 'ready'});
    await makeRequest(tree);

    const props = jest.mocked(NfcTap).mock.calls.at(-1)?.[0];
    expect(props).toBeDefined();
    act(() => props?.onActive?.());
    const callsBeforeExpiry = jest.mocked(NfcTap).mock.calls.length;
    nowMs += 3_000;
    act(() => jest.advanceTimersByTime(1_000));
    expect(jest.mocked(NfcTap).mock.calls.length).toBeGreaterThan(callsBeforeExpiry);
    expect(texts(tree).join(' ')).not.toContain('NFC tap expired');
    dateSpy.mockRestore();
  });

  test('the request QR IS the payment link — it round-trips parsePayLink and equals what Share carries', async () => {
    const tree = mountReceive();
    await makeRequest(tree);
    const qrCard = tree.root.findAll(node => node.props && node.props.testID === 'request-qr')[0];
    const value = qrCard.findAllByType(QrCode)[0].props.value;
    // Founder decision 2026-09-12: the QR renders the LINK on every rail — a regular camera opens
    // it. The invariant that matters downstream: the string re-parses into the exact payment the
    // request screen is waiting for (recipient/asset/network/amount, `ref` = the reconciliation
    // memo nonce).
    expect(value).toContain(`https://dpay.kalaj.org/wallet/pay/${SELF_PRINCIPAL}?`);
    const parsed = parsePayLink(value);
    expect(parsed?.ok).toBe(true);
    if (parsed?.ok) {
      expect(parsed.link.recipient).toBe(SELF_PRINCIPAL);
      expect(parsed.link.asset).toBe('DEMO');
      expect(parsed.link.network).toBe('internet-computer');
      expect(parsed.link.amount).toBe('25');
      expect(parsed.link.ref).toMatch(/^[0-9a-f]{32}$/);
    }
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    const shared = jest.mocked(shareSpy).mock.calls[0][0] as {message: string};
    expect(shared.message).toBe(value); // one payment, two surfaces — never two different codes
    act(() => {
      tree.unmount();
    });
  });

  test('(web) "Share request link" flips to "Link copied ✓" after the share resolves (testID unchanged)', async () => {
    asWeb();
    const tree = mountReceive();
    await makeRequest(tree);
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    expect(texts(tree)).toContain('Share request link');
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    // The shared payload is the PAYMENT LINK: this wallet's own account in the path, the exact
    // asset + settlement chain and the typed amount in the query, and the request nonce as `ref`
    // so a link payment reconciles against this very request. On web it carries the page origin
    // (empty in jest — a relative URL is still openable same-origin).
    const shared = jest.mocked(shareSpy).mock.calls[0][0] as {message: string};
    expect(shared.message).toContain(`/wallet/pay/${SELF_PRINCIPAL}?`);
    const q = new URL(shared.message, 'https://dpay.invalid').searchParams;
    expect(q.get('asset')).toBe('DEMO');
    expect(q.get('network')).toBe('internet-computer');
    expect(q.get('amount')).toBe('25'); // the amount makeRequest types
    expect(q.get('label')).toBe(IDENTITY.username);
    expect(q.get('ref')).toMatch(/^[0-9a-f]{32}$/);
    expect(texts(tree)).toContain('Link copied ✓');
    expect(texts(tree)).not.toContain('Share request link');
    expect(hasTestID(tree, 'btn-share-request')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });

  test('native: a completed Share sheet flips to "Shared ✓" — never "Link copied ✓"', async () => {
    const tree = mountReceive();
    await makeRequest(tree);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    // On native there is no page origin to read, so the link carries the canonical public wallet
    // origin — a link shared from a phone must open for a recipient who has never heard of this
    // device's relay setting.
    expect(shareSpy).toHaveBeenCalledWith({message: expect.stringContaining(`https://dpay.kalaj.org/wallet/pay/${SELF_PRINCIPAL}?`)});
    expect(texts(tree)).toContain('Shared ✓');
    expect(texts(tree)).not.toContain('Link copied ✓');
    act(() => {
      tree.unmount();
    });
  });

  test('a dismissed share sheet leaves the label honest (dismissedAction does not flip)', async () => {
    shareSpy.mockResolvedValue({action: 'dismissedAction' as const});
    const tree = mountReceive();
    await makeRequest(tree);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-share-request')[0];
    await act(async () => {
      btn.props.onPress();
    });
    expect(texts(tree)).toContain('Share request link');
    expect(texts(tree)).not.toContain('Link copied ✓');
    act(() => {
      tree.unmount();
    });
  });
});

// --- F2/F6: a rail-proof deeplink is only a trigger; exact ledger history is authoritative --------
describe('ReceiveMode — rail-proof deeplink is history-gated, never fabricated', () => {
  const CATALOG: CurrencyDescriptor[] = [{
    currency: 0, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', mintable: true, minter: null,
    minter_family: null, symbol: null, decimals: 2, wrapper_name: null, backing_symbol: null,
    network: null, display_decimals: 2, min_fraction_digits: null, fee: null, cap: null, chain_id: null, token_contract: null,
    gas_ledger: null, onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false,
  }];
  const FORGED = receiptShareBlob({request_id: '00'.repeat(32), block_index: '7', ledger: 'x'});

  beforeEach(() => {
    jest.mocked(confirmIncomingTransfer).mockReset();
  });

  test('a forged-but-well-formed proof cannot render Received without an exact history match', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    expect(hasTestID(tree, 'request-qr')).toBe(true);
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(false);
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});
    await act(async () => {});
    expect(confirmIncomingTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverPublicHex: IDENTITY.publicHex, currency: 0, amount: '2500',
    }), expect.any(Object));
    expect(texts(tree).join(' ')).not.toContain('Received'); // the F2 invariant
    expect(onReceived).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('the same proof flips to Received only when exact ledger history confirms the open request', async () => {
    const onReceived = jest.fn();
    const tree = mountReceive({catalog: CATALOG, onReceived});
    await makeRequest(tree);
    jest.mocked(confirmIncomingTransfer).mockResolvedValue(true);
    rerenderReceive(tree, {catalog: CATALOG, onReceived, prefillReceipt: FORGED});
    await act(async () => {});
    expect(texts(tree).join(' ')).toContain('Received');
    expect(onReceived).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('a proof with no open request is ignored — no fabricated amount or settlement', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onReceived = jest.fn();
    try {
      const tree = mountReceive({catalog: CATALOG, onReceived, prefillReceipt: FORGED});
      await act(async () => {});
      expect(confirmIncomingTransfer).not.toHaveBeenCalled();
      expect(texts(tree).join(' ')).not.toContain('Received');
      expect(onReceived).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no open request'));
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  test('a malformed proof is refused before any history lookup', async () => {
    const tree = mountReceive({catalog: CATALOG});
    await makeRequest(tree);
    const bad = receiptShareBlob({request_id: 'zz', block_index: '7'}); // fails the 64-hex gate
    rerenderReceive(tree, {catalog: CATALOG, prefillReceipt: bad});
    await act(async () => {});

    expect(texts(tree).join(' ')).toContain("This receipt doesn't match your open request.");
    expect(texts(tree).join(' ')).not.toContain('Received');
    expect(confirmIncomingTransfer).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

// --- U2 (2026-08-28): the Receive amount prefix renders the honest VCHF/ICP unit text ------------
// currencySymbol now returns the exact payment-unit text for a COMPLETE trusted direct-ICRC row
// ('VCHF'/'ICP' — not '?'). These pin the RENDERED prefix (the `req-prefix` pressable) + the layout
// invariants that keep it visible at every width: the container is content-sized (no fixed width
// can clip) and the widest honest unit fits the narrowest mobile viewport (320dp) under a
// conservative glyph bound. This file is in the scan-screen layout tree, so the change is surgical:
// ReceiveMode.tsx + styles.ts are UNTOUCHED — these tests pin why that is safe.
describe('ReceiveMode — VCHF/ICP amount prefix (U2 honest textual units)', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);

  /** The unit text rendered inside the `req-prefix` pressable (before the chevron icon). */
  const prefixText = (tree: renderer.ReactTestRenderer): string => {
    const node = tree.root.findAll(n => n.props && n.props.testID === 'req-prefix')[0];
    const unit = node.findAllByType(Text)[0];
    return textOf(unit.props.children);
  };

  test('mounts with the exact unit text VCHF (currency 7) — not "?"', () => {
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 7});
    expect(prefixText(tree)).toBe('VCHF');
    act(() => { tree.unmount(); });
  });

  test('mounts with the exact unit text ICP (currency 8) — not "?"', () => {
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 8});
    expect(prefixText(tree)).toBe('ICP');
    act(() => { tree.unmount(); });
  });

  test('the prefix container is CONTENT-SIZED — no fixed width can clip the unit text', () => {
    // S.prefixBtn must carry no width/minWidth/maxWidth: the flex:1 amount input yields space, so
    // the widest honest unit never truncates. Read from S so a future style edit that pins a width
    // fails HERE (deterministically, offline) instead of on a device.
    const prefixBtn = S.prefixBtn as Record<string, unknown>;
    expect(prefixBtn.width).toBeUndefined();
    expect(prefixBtn.minWidth).toBeUndefined();
    expect(prefixBtn.maxWidth).toBeUndefined();
    expect((S.amountInput as Record<string, unknown>).flex).toBe(1);
  });

  test('the VCHF prefix fits the NARROWEST mobile width (320dp) under a conservative glyph bound', () => {
    // Budget at 320dp (the smallest RN baseline viewport): viewport − body paddingHorizontal×2 −
    // amountRow paddingHorizontal×2. Worst-case prefix: 4 chars × 0.75em (bold advance) × fontSize
    // 34 + chevron 20 + prefixBtn paddingRight 12. Every number is read from S so a style change
    // that shrinks the budget (or grows the prefix font) fails here, not on a device.
    const NARROWEST_VIEWPORT = 320;
    const budget =
      NARROWEST_VIEWPORT -
      2 * Number(S.body.paddingHorizontal) -
      2 * Number(S.amountRow.paddingHorizontal);
    const glyphPx = Number(S.currency.fontSize) * 0.75;
    const worstCasePrefix =
      'VCHF'.length * glyphPx + 20 /* IconChevronDown size */ + Number(S.prefixBtn.paddingRight);
    expect(worstCasePrefix).toBeLessThanOrEqual(budget);
    // Desktop/web is capped WIDER (root maxWidth 480 ≥ 320), so the mobile bound subsumes it.
    expect(Number(S.root.maxWidth)).toBeGreaterThanOrEqual(NARROWEST_VIEWPORT);
  });

  test('(web) the same honest prefix at desktop width — the unit text is platform-independent', () => {
    asWeb();
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 7});
    expect(prefixText(tree)).toBe('VCHF');
    act(() => { tree.unmount(); });
  });
});

/**
 * WHICH NFC LINE THE COUNTER SEES. The merchant screen answers two different questions with one
 * line, and the pre-2026-09-04 prop (`nfcReady: boolean`) could only answer the first: with the
 * radio working, whether THIS code can be tapped; with it not working, WHY and what to do instead.
 * The second question is `NfcStatusRow`'s (its own suite pins the four states); what is pinned here
 * is the routing — that a merchant with the radio off is not left with a mute "Show this to the
 * payer" that names no problem and no fix.
 */
describe('ReceiveMode — the request screen routes the NFC line by the 4-state status', () => {
  test('radio off: the actionable status row replaces the mute per-request hint', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    const tree = mountReceive({nfcStatus: 'off'});
    await makeRequest(tree);
    expect(hasTestID(tree, 'receive-nfc')).toBe(true);
    const shown = texts(tree).join(' ');
    expect(shown).toContain(M.pay.nfcNotAvailable);
    expect(shown).not.toContain('Show this to the payer');
    // The code itself is unaffected — a radio problem never withholds the payable QR.
    expect(hasTestID(tree, 'request-qr')).toBe(true);
  });

  test('radio ready: the per-request hint owns the line and the status row stays away', async () => {
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({nfcStatus: 'ready'});
    await makeRequest(tree);
    expect(hasTestID(tree, 'receive-nfc')).toBe(false);
    expect(texts(tree).join(' ')).toContain('Show this to the payer');
  });
});

// The layout contract of a Receive branch, stated where the branch is chosen. A mode surface that
// does not stretch is sized to its own max-content by a centring parent and hangs off both viewport
// edges (`app/styles.ts`, MODE_SURFACE); a form that is vertically centred parks itself in the
// middle of the screen behind a dead band. Both are money-screen properties, so both are pinned
// here rather than left to a pixel diff that cannot see an off-screen element at all.
function surfaceOf(tree: renderer.ReactTestRenderer): {alignSelf?: string; justifyContent?: string} {
  return StyleSheet.flatten(tree.root.findAllByType(View)[0].props.style) as {alignSelf?: string; justifyContent?: string};
}

describe('ReceiveMode — a form is laid out as a form, a code as a moment', () => {
  test('the amount form starts at the top of the surface and fills the content column', () => {
    const tree = mountReceive();
    expect(hasTestID(tree, 'amount-input')).toBe(true);
    const surface = surfaceOf(tree);
    expect(surface.justifyContent).toBeUndefined();
    expect(surface.alignSelf).toBe('stretch');
  });

  test('the request code keeps the centred surface — and still fills the column', async () => {
    const tree = mountReceive();
    await makeRequest(tree);
    expect(hasTestID(tree, 'request-qr')).toBe(true);
    const surface = surfaceOf(tree);
    expect(surface.justifyContent).toBe('center');
    expect(surface.alignSelf).toBe('stretch');
  });
});

// --- Exact-price fee netting (founder rule 2026-09-12) -------------------------------------------
// If something costs $1, the customer pays exactly $1 — the merchant pays the fees. The p2p
// request is the payee's QUOTE, so the WIRE it builds (the link `amount=`, the NFC machine code,
// every confirm) carries price − ledger-fee, exactly like the relay's checkout (`checkout_raw_units`).
// The payee-facing headline keeps saying the typed PRICE; ONE dim line discloses fee + net. A
// price that does not clear the fee refuses the request before any wire exists. An unknowable
// fee nets nothing — the payer then pays price+fee, honestly displayed, never a guessed number.
describe('ReceiveMode — payee-quoted fee netting (exact-price rule, 2026-09-12)', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
  // VCHF (currency 7): 8 decimals, catalog fee '10000' (0.0001). A '1' request quotes
  // priceRaw 100000000, wire 99990000 — the payer pays exactly 0.9999.
  const VCHF_ASSET: SelectableAsset = {
    id: 'ic:7', protocol: 'ic', currency: 7, symbol: 'VCHF', linkToken: 'VCHF',
    networkLabel: 'Internet Computer', network: null, decimals: 8, minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'vchf',
  };
  const FORGED = receiptShareBlob({request_id: '00'.repeat(32), block_index: '7', ledger: 'x'});

  /** Mount the VCHF request form (NFC-ready) and let the mount-time fee fetch settle first. */
  async function mountVchf(over: Partial<ReceiveModeProps> = {}) {
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 7, assets: [VCHF_ASSET], selectedAssetId: 'ic:7', nfcStatus: 'ready', ...over});
    await act(async () => {}); // flush the live-fee effect's promise into feeRaw state
    return tree;
  }

  /** The link `amount=` of the open request QR, as the payer's scanner will read it. */
  function linkAmountOf(tree: renderer.ReactTestRenderer): string | undefined {
    const qrCard = tree.root.findAll(node => node.props && node.props.testID === 'request-qr')[0];
    const parsed = parsePayLink(qrCard.findAllByType(QrCode)[0].props.value);
    return parsed?.ok ? parsed.link.amount : undefined;
  }

  test('a live ledger fee nets into the ONE wire number — link, NFC, headline, disclosure', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
    const tree = await mountVchf();
    await makeRequest(tree, '1');
    // The link amount is the NETTED wire as the exact canonical decimal ('0.9999') — the number
    // the payer pays and the payee's confirms expect, identical everywhere by construction.
    expect(linkAmountOf(tree)).toBe('0.9999');
    // The NFC machine code carries the same netted raw (one request, one number).
    expect(DpayNfc.buildRequest).toHaveBeenCalledWith(
      IDENTITY.publicHex, '99990000', expect.any(String), 1_800_000_240, 7, IDENTITY.username, '',
    );
    // The payee-facing headline keeps the TYPED price (not the wire)…
    expect(texts(tree).join(' ')).toContain(fmtCurrencyAmountCompact(BUNDLED, 7, '100000000'));
    // …and the one-line disclosure states the fee and what actually arrives.
    const feeLine = tree.root.findAll(node => node.props && node.props.testID === 'request-fee-line')[0];
    const feeText = textOf(feeLine.props.children);
    expect(feeText).toContain('0.0001'); // the fee the payee absorbs
    expect(feeText).toContain('0.9999'); // the net that lands
  });

  test('a settled proof confirms the NETTED wire but reports the price — Received says what was asked', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
    const onReceived = jest.fn();
    const tree = await mountVchf({onReceived});
    await makeRequest(tree, '1');
    jest.mocked(confirmIncomingTransfer).mockReset().mockResolvedValue(true);
    rerenderReceive(tree, {catalog: BUNDLED, selectedCurrency: 7, assets: [VCHF_ASSET], selectedAssetId: 'ic:7', onReceived, prefillReceipt: FORGED});
    await act(async () => {});
    // Ledger history is matched against the WIRE raw — what actually lands is what confirms.
    expect(confirmIncomingTransfer).toHaveBeenCalledWith(expect.objectContaining({
      receiverPublicHex: IDENTITY.publicHex, currency: 7, amount: '99990000',
    }), expect.any(Object));
    // The settled screen reports the PRICE the payee typed, not the net.
    const settled = texts(tree).join(' ');
    expect(settled).toContain('Received');
    expect(settled).toContain(fmtCurrencyAmountCompact(BUNDLED, 7, '100000000'));
    expect(onReceived).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('live fetch failed → the catalog fee nets instead (stale-tolerant, never a guess)', async () => {
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tree = await mountVchf();
      await makeRequest(tree, '1');
      // The bundled VCHF row carries fee '10000' — the same net as the live answer would quote.
      expect(linkAmountOf(tree)).toBe('0.9999');
      expect(DpayNfc.buildRequest).toHaveBeenCalledWith(
        IDENTITY.publicHex, '99990000', expect.any(String), expect.any(Number), 7, IDENTITY.username, '',
      );
      act(() => { tree.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  test('a price that does not clear the fee is refused — no wire, no code, a named reason', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('100000000'); // the fee IS the whole 1.00 price
    const tree = await mountVchf();
    jest.mocked(DpayNfc.buildRequest).mockClear(); // earlier tests' calls don't count against this one
    await makeRequest(tree, '1');
    expect(texts(tree).join(' ')).toContain('clear the ledger fee');
    expect(hasTestID(tree, 'request-qr')).toBe(false); // no request screen ever opened
    expect(DpayNfc.buildRequest).not.toHaveBeenCalled(); // no zero-unit wire was built
    expect(DpayCore.encodeRequest).not.toHaveBeenCalled();
  });

  test('no fee known anywhere → the wire is the price verbatim; pinned ckBTC nets its measured fee', async () => {
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // ckBTC (currency 1): 8 decimals. Its bundled row NOW carries the MEASURED fee '10'
      // (2026-09-18 icrc1_fee), so even fully offline the request nets it: 25 BTC − 10 sats.
      const CKBTC_ASSET: SelectableAsset = {
        id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', linkToken: 'ckBTC',
        networkLabel: 'Internet Computer', network: null, decimals: 8, minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckbtc',
      };
      const tree = mountReceive({catalog: BUNDLED, selectedCurrency: 1, assets: [CKBTC_ASSET], selectedAssetId: 'ic:1'});
      await act(async () => {});
      await makeRequest(tree, '25');
      expect(linkAmountOf(tree)).toBe('24.9999999');
      const feeLine = tree.root.findAll(node => node.props && node.props.testID === 'request-fee-line')[0];
      const feeText = textOf(feeLine.props.children);
      expect(feeText).toContain('0.0000001');   // the pinned fee the payee absorbs
      expect(feeText).toContain('24.9999999'); // the net that lands
      act(() => { tree.unmount(); });
      // The unknown-fee seam itself is structural, not a ckBTC fact anymore: a row that
      // registers no fee rides verbatim and the disclosure stays silent — an unknown fee
      // invents no numbers.
      const FEELESS = BUNDLED.map(c => (c.currency === 1 ? {...c, fee: null} : c));
      const tree2 = mountReceive({catalog: FEELESS, selectedCurrency: 1, assets: [CKBTC_ASSET], selectedAssetId: 'ic:1'});
      await act(async () => {});
      await makeRequest(tree2, '25');
      expect(linkAmountOf(tree2)).toBe('25');
      expect(hasTestID(tree2, 'request-fee-line')).toBe(false);
      act(() => { tree2.unmount(); });
    } finally {
      warn.mockRestore();
    }
  });

  test('DEMO is play money: no fee query, no netting — the request path bit-for-bit as before', async () => {
    const tree = mountReceive(); // DEMO (currency 0) is the default fixture
    await makeRequest(tree);
    expect(fetchLedgerFee).not.toHaveBeenCalled(); // play money has no honest fee to net
    expect(linkAmountOf(tree)).toBe('25'); // the typed decimal, verbatim
    expect(hasTestID(tree, 'request-fee-line')).toBe(false);
  });

  // --- The price annotation (founder rule 2026-09-14) ----------------------------------------------
  // The payee's tx-log row headlines the TYPED PRICE with the fee as its annotation line, so the
  // request itself must save {gross: priceRaw, fee} against the nonce (the memo the settling row
  // joins on) the moment the request exists — and the NFC reader readout must be told the same
  // gross, while `amount` stays the wire it will match ledger history on.
  test('the request saves the PRICE as the row note — {gross, fee} against the nonce, reader told the gross', async () => {
    jest.mocked(fetchLedgerFee).mockResolvedValue('10000');
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    const tree = await mountVchf();
    await makeRequest(tree, '1');
    expect(noteSpy).toHaveBeenCalledTimes(1);
    const [who, note] = noteSpy.mock.calls[0];
    expect(who).toBe(IDENTITY.publicHex);
    expect(note.k).toMatch(/^[0-9a-f]{32}$/); // the request nonce = the settling row's memo
    expect(note.msg).toBeUndefined();         // no memo typed in this fixture
    expect(note.gross).toBe('100000000');     // the typed price — NOT the 99990000 wire
    expect(note.fee).toBe('10000');
    // The NFC reader is handed BOTH truths: displayAmount (what its readout says) vs amount (what
    // it matches the incoming ledger transfer on).
    const reader = jest.mocked(NfcTap).mock.calls.at(-1)?.[0];
    expect(reader?.reqInfo).toMatchObject({amount: '99990000', displayAmount: '100000000'});
    act(() => {
      tree.unmount();
    });
    noteSpy.mockRestore();
  });

  test('unknown fee: the note saves the gross alone (a guessed fee is worse than none)', async () => {
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
      const CKBTC_ASSET: SelectableAsset = {
        id: 'ic:1', protocol: 'ic', currency: 1, symbol: 'ckBTC', linkToken: 'ckBTC',
        networkLabel: 'Internet Computer', network: null, decimals: 8, minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'ckbtc',
      };
      // ckBTC's row carries the MEASURED fee '10' now, so the unknown-fee seam is exercised
      // against a fee-less row (the structural case, e.g. DEMO's shape) — the seam itself
      // must never invent a number either way.
      const FEELESS = BUNDLED.map(c => (c.currency === 1 ? {...c, fee: null} : c));
      const tree = mountReceive({catalog: FEELESS, selectedCurrency: 1, assets: [CKBTC_ASSET], selectedAssetId: 'ic:1', nfcStatus: 'ready'});
      await act(async () => {});
      await makeRequest(tree, '25');
      const note = noteSpy.mock.calls.at(-1)![1];
      expect(note.gross).toBe('2500000000'); // the typed price, verbatim raw
      expect(note.fee).toBeUndefined();      // nothing was invented
      const reader = jest.mocked(NfcTap).mock.calls.at(-1)?.[0];
      expect(reader?.reqInfo).toMatchObject({amount: '2500000000', displayAmount: '2500000000'}); // wire = price
      act(() => {
        tree.unmount();
      });
      noteSpy.mockRestore();
    } finally {
      warn.mockRestore();
    }
  });
});

// --- ONE message box, both code forms (founder 2026-09-14) ----------------------------------------
// The papercut this replaces: the dpay form's memo unmounted when the checkout checkbox was checked
// and the checkout rendered its OWN note input lower down — the box moved and its text reset on every
// toggle. The truth now: ONE input, owned by this form, mounted between the amount row and the
// checkbox in BOTH modes, text preserved across the toggle in both directions; what changes with
// the checkbox is only what the BUTTON does with the text (payment-link memo vs signed checkout note).
// `CheckoutCharge.test.tsx` pins what the counter then does with the note; this pins the BOX.
describe('ReceiveMode — the message box is one box, whatever the code form', () => {
  const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
  const VCHF_ASSET: SelectableAsset = {
    id: 'ic:7', protocol: 'ic', currency: 7, symbol: 'VCHF', linkToken: 'VCHF',
    networkLabel: 'Internet Computer', network: null, decimals: 8, minFractionDigits: 2, liquidity: null, onramp: 'Unavailable', offramp: 'Unavailable', rampPartner: null, gasToken: null, visible: true, testKey: 'vchf',
  };
  const NOTE = '2× Kafi, Tisch 4';
  // The props of the checkout-capable form, in both code forms — `codeForm` is wallet-owned, so a
  // toggle is a re-render with it flipped (exactly what the checkbox's onCodeFormChange does).
  // Annotated so the literals keep their narrow types (a bare const widens `7` to number).
  const OVER: Partial<ReceiveModeProps> = {catalog: BUNDLED, selectedCurrency: 7, assets: [VCHF_ASSET], selectedAssetId: 'ic:7', checkoutAvailable: true};
  const CHARGE = {id: 'pl_ecd765908f264957', cents: '1050', qr: 'http://relay.test/pl/?lightning=LNURL1XYZ', reference: '19ff3250469370d21a04c100ad5ab8bb', createdSecs: 1_788_479_954, expiresAt: 1_788_483_554};

  /** The `memo-input` test instance — the ONE box. */
  function memoBox(tree: renderer.ReactTestRenderer) {
    return tree.root.findAll(node => node.props && node.props.testID === 'memo-input')[0];
  }

  /** The element's immediate neighbours in the form, as position evidence: the sibling BEFORE the
   *  box must carry the amount row, the one AFTER must be the checkout checkbox's container. Holding in
   *  BOTH code forms is what "same position in the form" means here. */
  function neighboursOfBox(tree: renderer.ReactTestRenderer) {
    const box = memoBox(tree);
    const siblings = box.parent!.children.filter(
      (c): c is renderer.ReactTestInstance => !!c && typeof c === 'object' && 'props' in c && !!c.props,
    );
    const i = siblings.indexOf(box);
    return {prev: siblings[i - 1], next: siblings[i + 1]};
  }

  /** Does a subtree contain the testID? (Host Text nodes have no findAll, so guard.) */
  function containsTestID(node: renderer.ReactTestInstance | null, testID: string): boolean {
    if (!node) return false;
    if (node.props?.testID === testID) return true;
    return typeof node.findAll === 'function' && node.findAll(n => !!n.props && n.props.testID === testID).length > 0;
  }

  test('the same input stays mounted, in the same place, and keeps its text across the toggle', () => {
    const tree = mountReceive({...OVER, codeForm: 'dpay'});
    expect(hasTestID(tree, 'memo-input')).toBe(true);       // the dpay form's box…
    expect(hasTestID(tree, 'btn-request')).toBe(true);      // …under the dpay form's button
    const box = memoBox(tree);
    expect(box.props.maxLength).toBe(32);                   // ONE field's rules, both modes
    act(() => { box.props.onChangeText(NOTE); });

    // …checked: the box is the SAME input, still between the amount row and the checkbox — not a
    // checkout-owned twin rendered elsewhere — and the text typed a moment ago is still in it.
    rerenderReceive(tree, {...OVER, codeForm: 'checkout'});
    expect(hasTestID(tree, 'memo-input')).toBe(true);
    expect(hasTestID(tree, 'checkout-note-input')).toBe(false); // the twin is gone, not relocated
    expect(memoBox(tree).props.value).toBe(NOTE);
    expect(hasTestID(tree, 'btn-checkout-open')).toBe(true); // the BUTTON is what the checkbox flips
    let around = neighboursOfBox(tree);
    expect(containsTestID(around.prev, 'amount-input')).toBe(true);
    expect(around.next.props?.testID).toBe('receive-code-form');

    // …unchecked again: same box, same place, same text — the other direction of the toggle.
    rerenderReceive(tree, {...OVER, codeForm: 'dpay'});
    expect(hasTestID(tree, 'memo-input')).toBe(true);
    expect(hasTestID(tree, 'checkout-note-input')).toBe(false);
    expect(memoBox(tree).props.value).toBe(NOTE);
    expect(hasTestID(tree, 'btn-request')).toBe(true);
    around = neighboursOfBox(tree);
    expect(containsTestID(around.prev, 'amount-input')).toBe(true);
    expect(around.next.props?.testID).toBe('receive-code-form');

    act(() => { tree.unmount(); });
  });

  test('a message typed while the checkout box is checked becomes the dpay memo on uncheck', () => {
    // The other founding direction of the papercut: text typed while the checkout checkbox is checked
    // (today it lived in the checkout's own input and VANISHED on uncheck) must survive into the dpay
    // form — and then ride the ordinary payment link as the memo.
    const tree = mountReceive({...OVER, codeForm: 'checkout'});
    act(() => { memoBox(tree).props.onChangeText(NOTE); });
    rerenderReceive(tree, {...OVER, codeForm: 'dpay'});
    expect(memoBox(tree).props.value).toBe(NOTE);
    act(() => { tree.unmount(); });
  });

  test('the checkout button rings up what the ONE box holds — the shared text is the signed note', async () => {
    // The seam between the box and the counter: the parent's message rides the charge-open as the
    // note (the same trip e2e flow 114 pins through the real route). Amount first, like a cashier.
    jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'open', charge: CHARGE});
    // The open charge starts the merchant's poll — hand it a benign unpaid answer so the watch
    // loop inside the act flush settles instead of crashing on an undefined outcome.
    jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'status', status: {id: CHARGE.id, cents: '1050', state: 'open', createdSecs: CHARGE.createdSecs, expiresAt: CHARGE.expiresAt, paid: null, pull: null}});
    jest.mocked(icStampExpiry).mockResolvedValue('1800000240123456789');
    jest.mocked(DpayNfc.buildRequest).mockResolvedValue('nfc-request');
    const tree = mountReceive({...OVER, codeForm: 'checkout'});
    act(() => {
      tree.root.findAll(node => node.props && node.props.testID === 'amount-input')[0].props.onChangeText('10.50');
      memoBox(tree).props.onChangeText(NOTE);
    });
    await act(async () => {
      tree.root.findAll(node => node.props && node.props.testID === 'btn-checkout-open')[0].props.onPress();
    });
    expect(openCheckoutCharge).toHaveBeenCalledWith('http://relay.test', IDENTITY, '1050', 8, '10000', NOTE, 'VCHF');
    act(() => { tree.unmount(); });
  });
});
