/**
 * The counter (`components/CheckoutCharge.tsx`) — the merchant's own OpenCryptoPay charge, rendered
 * inside Receive ▸ Request payment beside the checkout-code CHECKBOX: the amount row and the message
 * row are the parent's, shared with the dpay-code form, and arrive here as props.
 *
 * WHAT THIS SUITE OWNS. The client's outcomes are `checkout.test.ts`'s business and the signed bytes are
 * `checkoutOpenSignature.test.ts`'s; the three routes are mocked at their module boundary here so what
 * is exercised is the SCREEN: which asset may open one, what the cashier is told when it cannot,
 * and — the two that matter most — that an unreadable poll never reads as "unpaid", and that an
 * expired code is watched a bounded while longer and then stops.
 *
 * The rail-parity case (`the control refuses a Solana asset by name`) is the same-surfaces hard
 * rule with teeth: this control renders on BOTH Receive forms for EVERY asset, so the only thing
 * that may differ between rails is the sentence, never the presence of the control.
 *
 * THE TAP CASES pin what the reader is armed WITH, not what the reader then does: `NfcTap` is a
 * double here, and its own three verdicts are `nfc-merchant-verdict.test.tsx`'s business while a
 * real tap settling a real charge is e2e flow 117's. What only this suite can state is the join —
 * that the request the counter arms carries the CHARGE's reference as its nonce, because that nonce
 *  becomes the ICRC-1 memo the relay credits the sale on, and that nothing about the tap is allowed
 *  to turn the paid light green.
 *
 * The NOTE cases pin the merchant half of the signed note: what the cashier typed is what was
 * signed, sent, shown on the payer's tap and saved against the charge's reference — one spelling
 * everywhere. The typing itself is the PARENT's now (the ONE message box shared by both code
 * forms, founder 2026-09-14): the note arrives here as a prop, exactly like the amount, and
 * `ReceiveMode.test.tsx` owns the box — that it is one input, in one place, whose text survives
 * the checkout-checkbox toggle. How the payer READS the note back is the payer's suites, off the same
 * golden.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {StyleSheet, Text, View} from 'react-native';

jest.mock('../services/checkout', () => {
  const actual = jest.requireActual('../services/checkout') as Record<string, unknown>;
  return {
    ...actual, // CHECKOUT_OFFER / chfCents / checkoutRawUnits / checkoutPriceUnits stay REAL — they are pure and are the rules
    openCheckoutCharge: jest.fn(),
    checkoutChargeStatus: jest.fn(),
    cancelCheckoutCharge: jest.fn(),
  };
});

// The radio and the certified clock, at their module boundaries. `buildRequest` is the REAL core's
// job on a device; what matters here is the ARGUMENTS it is handed.
const mockBuildRequest = jest.fn(async (..._args: unknown[]) => 'de'.repeat(66));
const mockStampExpiry = jest.fn(async (..._args: unknown[]) => '0');
const mockPrincipalFromPubkey = jest.fn(async (..._a: unknown[]) => MERCHANT_PRINCIPAL);
const mockDecodeTransferFrom = jest.fn(async (..._a: unknown[]) => ({ok: true, blockIndex: '1'}));
jest.mock('../services/native', () => ({
  DpayNfc: {buildRequest: (...a: unknown[]) => mockBuildRequest(...a)},
  DpayCore: {
    icpPrincipalFromPubkey: (...a: unknown[]) => mockPrincipalFromPubkey(...a),
    icpDecodeTransferFromResult: (...a: unknown[]) => mockDecodeTransferFrom(...a),
  },
}));

// The PULL, at its module boundary: this suite asserts what the counter asks the rail to sign, not
// what the rail then does with it (that is rail's own business, and e2e flow 118's end to end).
const mockPreparePull = jest.fn(async (..._a: unknown[]) => ({ledger: 'ly36x', envelopeHex: 'aa', requestIdHex: 'bb', amount: '0', currency: 7, memoHex: ''}));
const mockSubmitTransfer = jest.fn(async (..._a: unknown[]) => ({kind: 'settled', blockIndex: '91'} as const));
jest.mock('../services/rail', () => ({
  preparePull: (...a: unknown[]) => mockPreparePull(...a),
  submitTransfer: (...a: unknown[]) => mockSubmitTransfer(...a),
}));
jest.mock('../services/icp', () => ({icStampExpiry: (...a: unknown[]) => mockStampExpiry(...a)}));

// The reader itself is a double: this suite asserts what it is MOUNTED with, and drives its two
// callbacks to check who owns the screen. (The `mock` prefix is jest's allowlist for a value a
// hoisted factory may close over; the props are only read at render time, never at factory time.)
const mockTap: {props: Record<string, unknown> | null} = {props: null};
jest.mock('../components/NfcTap', () => ({
  NfcTap: (props: Record<string, unknown>) => {
    mockTap.props = props;
    return null;
  },
}));

// The payee-side annotation store, at its module boundary: what this suite asserts is the note is
// SAVED, keyed by the charge's reference (the memo the incoming transfer carries); how the store
// keeps and merges rows is `txNotes.test.ts`'s business.
const mockSaveTxNote = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../services/txNotes', () => ({saveTxNote: (...a: unknown[]) => mockSaveTxNote(...a)}));

import {CheckoutCharge} from '../components/CheckoutCharge';
import {openCheckoutCharge, checkoutChargeStatus, cancelCheckoutCharge, checkoutRawUnits, checkoutPriceUnits, type CheckoutStatus} from '../services/checkout';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET} from '../config/constants';
import {M} from '../i18n';
import {S} from '../styles';
import type {AssetId, Identity, NfcStatus} from '../lib/types';

const IDENTITY: Identity = {secretHex: '0b'.repeat(32), publicHex: '66'.repeat(32), username: 'Bahnhof Kiosk'};
const RELAY = 'https://checkout.example';
/** The shop's own account — what the allowance names as spender and what a collection pays TO. */
const MERCHANT_PRINCIPAL = 'snzff-yj2qd-fjns7-lqhvw-rsgq7-tohk2-fjnw4-uq3d6-wtk56-pxgry-mqe';
/** A customer who approved instead of sending. */
const PAYER_PRINCIPAL = 'ygf2v-2qaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-4ae';

// The wallet's REAL selectable rows, both rails — the same list the Receive forms hand this
// component in production, so "which asset can open one" is decided against the shipping
// catalog rather than a hand-made fixture that could disagree with it.
const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true});
const assetOf = (predicate: (a: SelectableAsset) => boolean): SelectableAsset => {
  const found = ASSETS.find(predicate);
  if (!found) throw new Error('the bundled catalog must carry this row');
  return found;
};
const VCHF = assetOf(a => a.linkToken === 'VCHF');
const CKBTC = assetOf(a => a.linkToken === 'ckBTC');
const SOL = assetOf(a => a.protocol === 'solana' && a.token === 'SOL');

/** The charge's own name on the ledger — 16 bytes of hex, the width the relay mints and the width
 *  the wire's nonce field holds. A tap request built with anything else credits nothing. */
const REFERENCE = '19ff3250469370d21a04c100ad5ab8bb';
const CHARGE = {id: 'pl_ecd765908f264957', cents: '1050', qr: 'https://checkout.example/pl/?lightning=LNURL1XYZ', reference: REFERENCE, createdSecs: 1_788_479_954, expiresAt: 1_788_483_554};
/** VCHF's ledger fee, from the same catalog row the counter reads — the fee the SHOP absorbs. */
const VCHF_FEE_RAW = (() => {
  const row = CATALOG.find(c => c.currency === 7);
  if (row?.fee == null) throw new Error('the bundled catalog must state VCHF’s ledger fee');
  return row.fee;
})();

/** What the SHOP receives for a CHF 10.50 charge: 1050 rappen at VCHF's eight decimals, less the
 *  ledger fee. The customer's wallet moves this PLUS that fee — i.e. exactly CHF 10.50, which is
 *  the whole point of the subtraction (`checkoutRawUnits`, services/checkout.ts). */
const PAY_RAW = checkoutRawUnits('1050', 8, VCHF_FEE_RAW);
// The opened price BEFORE netting — what the displays headline and the annotation records as the
// gross (founder rule 2026-09-14): wire = price − fee stays the settlement truth.
const PRICE_RAW = checkoutPriceUnits('1050', 8);

/** A status body as the relay would answer for the charge above. */
function status(over: Partial<CheckoutStatus> = {}): CheckoutStatus {
  return {id: CHARGE.id, cents: '1050', state: 'open', createdSecs: CHARGE.createdSecs, expiresAt: CHARGE.expiresAt, paid: null, pull: null, ...over};
}

function textOf(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  const el = children as {props?: {children?: unknown}};
  return el.props ? textOf(el.props.children) : '';
}

function visible(tree: renderer.ReactTestRenderer): string {
  return tree.root.findAllByType(Text).map(n => textOf(n.props.children)).join('   ');
}

function node(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(n => !!n.props && n.props.testID === testID)[0];
}

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(n => !!n.props && n.props.testID === testID).length > 0;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function mount(
  asset: SelectableAsset,
  onRepickAsset: (id: AssetId) => void = () => {},
  nfcStatus: NfcStatus = 'ready',
  catalog: CurrencyDescriptor[] = CATALOG,
  /** What the PARENT's shared amount row holds — the price the cashier typed there. */
  amount = '10.50',
  /** What the PARENT's shared message row holds — the ONE box, in the same place, whether or not
   *  the checkout checkbox is checked (founder 2026-09-14). What this counter DOES with the text is
   *  this suite's business; that the box itself never moves or resets is ReceiveMode's. */
  note = '',
) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <CheckoutCharge
        identity={IDENTITY}
        relayUrl={RELAY}
        asset={asset}
        assets={ASSETS}
        catalog={catalog}
        nfcStatus={nfcStatus}
        onRepickAsset={onRepickAsset}
        amount={amount}
        note={note}
      />,
    );
  });
  return tree;
}

/** Press "Show code" and let the open resolve — the amount is already on the tree as a prop. */
async function openCharge(tree: renderer.ReactTestRenderer) {
  await act(async () => { node(tree, 'btn-checkout-open').props.onPress(); await flush(); });
}

beforeEach(() => {
  // The screen runs a 1s display clock and a poll interval; Date stays real so the countdown maths
  // is the production one.
  jest.useFakeTimers({doNotFake: ['Date']});
  jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'open', charge: CHARGE});
  jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'status', status: status()});
  jest.mocked(cancelCheckoutCharge).mockReset();
  mockTap.props = null;
  mockBuildRequest.mockClear();
  mockSaveTxNote.mockClear();
  // A certified instant comfortably ahead of the wall clock, so a freshly armed tap is LIVE. The
  // stamp is nanoseconds, exactly as `icStampExpiry` returns it.
  mockStampExpiry.mockReset();
  mockStampExpiry.mockResolvedValue(String((BigInt(Math.floor(Date.now() / 1000)) + BigInt(NFC_UPDATE_AHEAD_S)) * 1_000_000_000n));
  mockPreparePull.mockClear();
  mockSubmitTransfer.mockClear();
  mockSubmitTransfer.mockResolvedValue({kind: 'settled', blockIndex: '91'} as const);
});

afterEach(() => {
  jest.useRealTimers();
  jest.mocked(openCheckoutCharge).mockReset();
  jest.mocked(checkoutChargeStatus).mockReset();
});

describe('the settlement picker (multi-currency build-out)', () => {
  const CKUSDC = assetOf(a => a.linkToken === 'ckUSDC');
  const CKUSDC_FEE = (() => {
    const row = CATALOG.find(c => c.currency === 2);
    if (row?.fee == null) throw new Error('the bundled catalog must state ckUSDC\u2019s ledger fee');
    return row.fee;
  })();

  test('offers every asset the checkout can settle, naming the currency each price is read in', () => {
    const tree = mount(VCHF);
    expect(has(tree, 'checkout-settle')).toBe(true);
    expect(has(tree, 'checkout-asset-vchf')).toBe(true);
    expect(has(tree, 'checkout-asset-ckusdc')).toBe(true);
    // A row that settles no home currency has no honest price unit — never offered.
    expect(has(tree, 'checkout-asset-icp')).toBe(false);
    expect(has(tree, 'checkout-asset-ckbtc')).toBe(false);
    const said = visible(tree);
    expect(said).toContain('VCHF · CHF');
    expect(said).toContain('ckUSDC · USD');
    act(() => { tree.unmount(); });
  });

  test('opens the charge in the PICKED asset — decimals, fee and token follow it', async () => {
    const tree = mount(VCHF);
    act(() => { node(tree, 'checkout-asset-ckusdc').props.onPress(); });
    await openCharge(tree);
    expect(openCheckoutCharge).toHaveBeenLastCalledWith(RELAY, IDENTITY, '1050', CKUSDC.decimals, CKUSDC_FEE, '', 'ckUSDC');
    act(() => { tree.unmount(); });
  });

  test('a checkout that serves a different asset than the pick is a named refusal with the one-tap fix', async () => {
    // Today's relay serves VCHF only; a ckUSDC pick comes back as exactly that fact, and the
    // counter must never show a dollar pick as a franc charge (that would be an exchange nobody
    // at the counter made).
    jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'served-other', served: 'VCHF'});
    const picked: AssetId[] = [];
    const tree = mount(CKUSDC, id => picked.push(id));
    await openCharge(tree);
    expect(has(tree, 'btn-checkout-open')).toBe(false);
    const said = visible(tree);
    expect(said).toContain('VCHF');  // what the checkout DID open
    expect(said).toContain('USD');   // the currency the cashier picked
    // One tap re-picks the served asset and returns to the entry form.
    act(() => { node(tree, 'checkout-failed-go').props.onPress(); });
    expect(has(tree, 'btn-checkout-open')).toBe(true);
    const pill = node(tree, 'checkout-asset-vchf');
    expect(pill.props.accessibilityState).toMatchObject({checked: true});
    // The fix re-picks the wallet's asset too — one truth, the same move the pills make.
    expect(picked).toEqual([VCHF.id]);
    act(() => { tree.unmount(); });
  });
});

describe('which asset may open a checkout charge', () => {
  test('refuses an IC asset that is not the checkout’s, by name, with the one tap that fixes it', () => {
    const picked: AssetId[] = [];
    const tree = mount(CKBTC, id => picked.push(id));
    expect(has(tree, 'checkout-refused')).toBe(true);
    // No button at all: a form that cannot produce a payable code must not be pressed.
    expect(has(tree, 'btn-checkout-open')).toBe(false);
    const said = visible(tree);
    // The BACKING symbol, as every other surface in this wallet names it — never the `ck*` wrapper.
    expect(said).toContain('BTC');
    expect(said).not.toContain('ckBTC');
    expect(said).toContain('Bitcoin'); // the rail, not just the asset
    expect(said).toContain('VCHF');
    act(() => { node(tree, 'checkout-refused-go').props.onPress(); });
    expect(picked).toEqual([VCHF.id]);
    act(() => { tree.unmount(); });
  });

  test('renders the SAME control on the Solana rail and refuses it by name', () => {
    // The same-surfaces hard rule: the control exists on both rails; only the answer differs.
    const picked: AssetId[] = [];
    const tree = mount(SOL, id => picked.push(id));
    expect(has(tree, 'checkout-refused')).toBe(true);
    const said = visible(tree);
    expect(said).toContain('SOL');
    expect(said).toContain('Solana');
    act(() => { node(tree, 'checkout-refused-go').props.onPress(); });
    expect(picked).toEqual([VCHF.id]); // one tap crosses the rail
    act(() => { tree.unmount(); });
  });

  test('opens the counter for the asset a checkout code is actually paid in', () => {
    const tree = mount(VCHF);
    expect(has(tree, 'btn-checkout-open')).toBe(true);
    expect(has(tree, 'checkout-refused')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('opening a charge', () => {
  test('closes the counter when the catalog states no fee, rather than billing the customer for it', async () => {
    // The shop pays the ledger fee out of the price. A row that states no fee leaves nothing to
    // subtract, and quoting the full price instead would put the fee back on the customer in
    // silence — the one outcome the rule exists to prevent. So the counter refuses, names the
    // asset and the relay, and offers no amount field at all.
    const feeless = CATALOG.map(c => (c.currency === 7 ? {...c, fee: null} : c));
    const tree = mount(VCHF, () => {}, 'ready', feeless);
    expect(node(tree, 'checkout-no-fee')).toBeDefined();
    expect(node(tree, 'btn-checkout-open')).toBeUndefined();
    const said = visible(tree);
    expect(said).toContain('VCHF');
    expect(said).toContain('checkout.example'); // the relay whose list is missing it
    // …and it is NOT the wrong-asset refusal, which would send the cashier to switch to the asset
    // they are already on.
    expect(node(tree, 'checkout-refused')).toBeUndefined();
    expect(openCheckoutCharge).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('sends the exact whole rappen at the asset’s own precision, and shows the code', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(openCheckoutCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW, '', 'VCHF');
    expect(node(tree, 'checkout-qr')).toBeDefined();
    const said = visible(tree);
    expect(said).toContain('10.50 CHF');       // the price the cashier reads out
    // The SHOP's side of the same sale: the price less the ledger fee it absorbs. Both numbers are
    // on screen on purpose — a cashier shown only the smaller one would read it as a misprice.
    expect(said).toContain('10.4999 VCHF');
    expect(said).toContain(M.receive.checkout.waiting);
    // Nothing on this screen may suggest the customer has scanned or is even present.
    expect(said).not.toContain('scanned');
    act(() => { tree.unmount(); });
  });

  test('refuses a price finer than a rappen without sending anything', async () => {
    const tree = mount(VCHF, () => {}, 'ready', CATALOG, '10.505');
    await openCharge(tree);
    expect(openCheckoutCharge).not.toHaveBeenCalled();
    expect(visible(tree)).toContain(M.receive.checkout.badAmount('too-precise'));
    expect(has(tree, 'checkout-qr')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('pressable with nothing typed — the empty press is the honest badAmount refusal, not a greyed button', async () => {
    // Founder 2026-09-17: parity with the dpay form's always-tappable Show code. An empty total
    // is refused by `chfCents` with the badAmount sentence; the button itself never disables.
    const tree = mount(VCHF, () => {}, 'ready', CATALOG, '');
    const btn = node(tree, 'btn-checkout-open');
    expect(btn.props.disabled).toBeFalsy();
    expect(btn.props.accessibilityState.disabled).toBeFalsy();
    await act(async () => { btn.props.onPress(); await flush(); });
    expect(openCheckoutCharge).not.toHaveBeenCalled();
    expect(visible(tree)).toContain(M.receive.checkout.badAmount('not-a-number'));
    expect(has(tree, 'checkout-qr')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a relay that serves no checkout is a named dead end, not a spinner', async () => {
    jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'not-served', addr: 'https://checkout.example'});
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(has(tree, 'checkout-failed')).toBe(true);
    const said = visible(tree);
    expect(said).toContain('checkout.example');            // WHICH relay could not do it
    expect(said).toContain(M.receive.checkout.tryAgain);   // and the way out
    act(() => { tree.unmount(); });
  });

  test('a refusal carries the checkout’s own sentence, which already names the fix', async () => {
    jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'refused', said: 'Re-sync the device clock', status: 401});
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(visible(tree)).toContain('Re-sync the device clock');
    act(() => { tree.unmount(); });
  });

  test('an unreachable relay walk is CLASSIFIED (work order 2026-09-30): online names the host calmly, offline blames nobody', async () => {
    // The open walk's old copy said "check the connection" unconditionally — wrong when the phone
    // was online and dpay's relay was the side that was down. The seam now carries the blame.
    jest.mocked(openCheckoutCharge).mockResolvedValue(
      {kind: 'unreachable', detail: 'ECONNREFUSED', tried: [RELAY], blame: 'unreachable'});
    let tree = mount(VCHF);
    await openCharge(tree);
    expect(has(tree, 'checkout-failed')).toBe(true);
    const online = visible(tree);
    expect(online).toContain(M.receive.checkout.unreachable('checkout.example'));
    expect(online).toContain('connection is fine');
    act(() => { tree.unmount(); });

    jest.mocked(openCheckoutCharge).mockResolvedValue(
      {kind: 'unreachable', detail: 'ECONNREFUSED', tried: [RELAY], blame: 'offline'});
    tree = mount(VCHF);
    await openCharge(tree);
    const offline = visible(tree);
    expect(offline).toContain(M.receive.checkout.unreachableOffline('checkout.example'));
    expect(offline).toMatch(/offline/i);
    expect(offline).not.toMatch(/connection is fine/);
    act(() => { tree.unmount(); });
  });
});

describe('the note — what this charge is for', () => {
  const NOTE = '2× Kafi, Tisch 4';

  test('rides the charge-open trimmed — signed, displayed on the tap, and saved against the reference', async () => {
    // The note is the PARENT's shared message row (founder 2026-09-14): it arrives as a prop, so
    // the whitespace is asserted to be trimmed HERE — at the counter's edge — not at the input's.
    const tree = mount(VCHF, () => {}, 'ready', CATALOG, '10.50', `  ${NOTE}  `);
    await openCharge(tree);
    // The whitespace is the cashier's, not the payer's: ONE trimmed spelling travels everywhere.
    expect(openCheckoutCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW, NOTE, 'VCHF');
    // …it is the tap request's DISPLAY memo — what the payer's phone shows while it asks them to
    // confirm. The SETTLEMENT memo stays the reference, asserted by the reader cases below.
    expect(mockBuildRequest.mock.calls[0][6]).toBe(NOTE);
    // …and the payee-side annotation is keyed by the one thing the incoming transfer carries: the
    // charge's reference, which is the ICRC-1 memo the relay credits the sale on — so the history
    // row this sale settles into already says what it was for. The gross + fee ride along (founder
    // rule 2026-09-14): the row headlines the opened price with the fee as its annotation line.
    expect(mockSaveTxNote).toHaveBeenCalledWith(IDENTITY.publicHex, {k: REFERENCE, msg: NOTE, gross: PRICE_RAW, fee: VCHF_FEE_RAW}, expect.any(Number));
    act(() => { tree.unmount(); });
  });

  test('no note typed: v1 charge-open, no display memo — but the price annotation still lands', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(openCheckoutCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW, '', 'VCHF');
    expect(mockBuildRequest.mock.calls[0][6]).toBe('');
    // Founder rule 2026-09-14: even noteless, the charge-open records {gross, fee} against the
    // reference — the settled row headlines the price, not the netted wire.
    expect(mockSaveTxNote).toHaveBeenCalledWith(IDENTITY.publicHex, {k: REFERENCE, msg: undefined, gross: PRICE_RAW, fee: VCHF_FEE_RAW}, expect.any(Number));
    act(() => { tree.unmount(); });
  });

  test('whitespace the cashier typed is not a note — the price annotation still lands', async () => {
    const tree = mount(VCHF, () => {}, 'ready', CATALOG, '10.50', '   ');
    await openCharge(tree);
    expect(openCheckoutCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW, '', 'VCHF');
    expect(mockSaveTxNote).toHaveBeenCalledWith(IDENTITY.publicHex, {k: REFERENCE, msg: undefined, gross: PRICE_RAW, fee: VCHF_FEE_RAW}, expect.any(Number));
    act(() => { tree.unmount(); });
  });

  test('a refused charge-open keeps the note for the re-open, like the amount above it', async () => {
    // The note is the PARENT's prop (the shared message row above), so it survives the counter's
    // reset by construction — what this pins is the behaviour that follows: the re-open signs the
    // SAME words again, exactly like it re-uses the same price.
    jest.mocked(openCheckoutCharge).mockResolvedValue({kind: 'refused', said: 'Re-sync the device clock', status: 401});
    const tree = mount(VCHF, () => {}, 'ready', CATALOG, '10.50', NOTE);
    await openCharge(tree);
    expect(has(tree, 'checkout-failed')).toBe(true);
    await act(async () => { node(tree, 'checkout-failed-go').props.onPress(); await flush(); });
    expect(has(tree, 'btn-checkout-open')).toBe(true);
    await openCharge(tree);
    expect(openCheckoutCharge).toHaveBeenLastCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW, NOTE, 'VCHF');
    act(() => { tree.unmount(); });
  });
});

describe('a customer who taps instead of scanning', () => {
  test('arms the reader with the CHARGE’s reference as the request nonce', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);

    // THE JOIN THIS WHOLE SURFACE TURNS ON. `prepareNfcTransfer` writes the request's nonce onto the
    // payer's transfer as its ICRC-1 memo, and the relay credits only a transfer whose memo is this
    // charge's reference — so a request built with a nonce of this wallet's own would move the
    // customer's money and leave the sale open.
    expect(mockBuildRequest).toHaveBeenCalledTimes(1);
    const [toHex, amount, nonce, expiry, currency, toName, memo] = mockBuildRequest.mock.calls[0];
    expect(toHex).toBe(IDENTITY.publicHex);           // paid to the shop's own account, never dpay's
    expect(amount).toBe(PAY_RAW);                     // the franc price at VCHF's own precision
    expect(nonce).toBe(REFERENCE);
    expect(currency).toBe(7);                         // VCHF, the one asset a dpay checkout takes
    expect(toName).toBe(IDENTITY.username);
    expect(memo).toBe('');
    expect(typeof expiry).toBe('number');
    expect(mockStampExpiry).toHaveBeenCalledWith(IDENTITY.secretHex, NFC_UPDATE_AHEAD_S);

    // …and the reader is mounted with exactly that request, told the same amount/nonce/currency it
    // will later match ledger history on. The DISPLAY amount is the opened price — the readout
    // headlines the gross, `amount` stays the settlement wire (founder rule 2026-09-14).
    expect(mockTap.props?.role).toBe('reader');
    expect(mockTap.props?.requestHex).toBe(await mockBuildRequest.mock.results[0].value);
    expect(mockTap.props?.reqInfo).toMatchObject({amount: PAY_RAW, displayAmount: PRICE_RAW, nonce: REFERENCE, currency: 7});
    // NO `onSettled`: nothing the radio does may turn the paid light green — only the relay's poll.
    expect(mockTap.props?.onSettled).toBeUndefined();

    // The code is up and tappable, and says so in one line rather than two.
    expect(has(tree, 'checkout-qr')).toBe(true);
    expect(visible(tree)).toContain(M.receive.checkout.showToCustomer('tap'));
    act(() => { tree.unmount(); });
  });

  test('a phone that cannot tap still shows a code, and names what is wrong with the phone', async () => {
    const tree = mount(VCHF, () => {}, 'off');
    await openCharge(tree);
    // Nothing is armed and nothing is claimed: no request was built at all.
    expect(mockBuildRequest).not.toHaveBeenCalled();
    expect(mockTap.props).toBeNull();
    // The radio's own row takes the line, because the fix is about the PHONE (turn NFC on) rather
    // than about this code — and the code itself is still up and still scannable.
    expect(has(tree, 'checkout-nfc')).toBe(true);
    expect(has(tree, 'checkout-tap-hint')).toBe(false);
    expect(has(tree, 'checkout-qr')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a tap request that could not be built leaves a scannable code and says only that', async () => {
    // The certified IC instant the request's expiry needs is a network read; without it there is no
    // honest expiry to sign, so no reader is armed. The code must not silently lose its QR over it.
    mockStampExpiry.mockRejectedValue(new Error('certified time unreachable'));
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(mockTap.props).toBeNull();
    expect(has(tree, 'checkout-qr')).toBe(true);
    expect(visible(tree)).toContain(M.receive.checkout.showToCustomer('none'));
    expect(visible(tree)).not.toContain(M.receive.checkout.showToCustomer('tap'));
    act(() => { tree.unmount(); });
  });

  test('a tap in flight owns the screen, and the paid light is still the relay’s answer', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    const onActive = mockTap.props?.onActive as () => void;
    const onClose = mockTap.props?.onClose as () => void;

    // The exchange starts: the counter's own body goes away rather than sitting beside a tap that
    // is mid-flight. Two settlement surfaces at once is the thing a cashier learns to distrust.
    act(() => { onActive(); });
    expect(has(tree, 'checkout-qr')).toBe(false);
    expect(has(tree, 'checkout-tap-hint')).toBe(false);

    // The relay observes the transfer WHILE the tap is still returning its result to the payer. The
    // charge is credited underneath, and the tap keeps the screen — it still owes that result.
    jest.mocked(checkoutChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: PAY_RAW, atSecs: CHARGE.createdSecs + 8, block: 91}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(has(tree, 'checkout-paid')).toBe(false);
    expect(mockTap.props).not.toBeNull();

    // Only when the tap is done does the checkout's own answer take the screen — and it is the RELAY's
    // answer, with the ledger block that paid.
    act(() => { onClose(); });
    expect(has(tree, 'checkout-paid')).toBe(true);
    expect(visible(tree)).toContain(M.receive.checkout.paidBlock(91));
    act(() => { tree.unmount(); });
  });
});

describe('watching the charge', () => {
  test('an unreadable poll says CAN’T CHECK — never unpaid, never paid', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'unchecked', detail: 'ECONNREFUSED'});
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    const said = visible(tree);
    expect(said).toContain(M.receive.checkout.cantCheck);
    expect(said).not.toContain(M.receive.checkout.waiting);
    expect(has(tree, 'checkout-paid')).toBe(false);
    // The code stays up and the money is untouched by our ignorance — the charge is still showing.
    expect(has(tree, 'checkout-qr')).toBe(true);
    // …and the screen recovers the moment the checkout answers again.
    jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'status', status: status()});
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.checkout.waiting);
    act(() => { tree.unmount(); });
  });

  test('paid renders the RELAY’s answer: the block that paid, and who paid it', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    jest.mocked(checkoutChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: '1050000000', atSecs: CHARGE.createdSecs + 30, block: 77}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    const said = visible(tree);
    expect(said).toContain(M.receive.checkout.paidAmount('10.50 CHF'));
    expect(said).toContain(M.receive.checkout.paidBlock(77));
    expect(said).toContain('lrdna-ai');                       // the payer, shortened
    expect(said).not.toContain(M.receive.checkout.paidLate);      // it landed inside the code's life
    act(() => { tree.unmount(); });
  });

  test('a transfer that lands after the code expired is accepted, and said to be late', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    jest.mocked(checkoutChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: '1050000000', atSecs: CHARGE.expiresAt + 5, block: 78}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.checkout.paidLate);
    act(() => { tree.unmount(); });
  });

  test('an expired code is watched a bounded while longer, then stops being polled', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'status', status: status({state: 'expired'})});
    // Inside the budget the screen says the code is dead but the money can still land — the offline
    // payer's transfer is exactly the case this window exists for.
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.checkout.expiredWatching);
    expect(has(tree, 'checkout-qr')).toBe(true);

    for (let i = 0; i < PROOF_POLL_BUDGET; i++) {
      await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    }
    expect(has(tree, 'checkout-ended')).toBe(true);
    expect(visible(tree)).toContain(M.receive.checkout.endedBody('expired'));
    // AND THE POLL IS OFF: no further request goes out for a charge nobody can pay.
    const settled = jest.mocked(checkoutChargeStatus).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv * 5); await flush(); });
    expect(jest.mocked(checkoutChargeStatus).mock.calls.length).toBe(settled);
    act(() => { tree.unmount(); });
  });

  test('a charge the relay lost, and one another charge-open replaced, are told apart', async () => {
    for (const [answer, body] of [
      [{kind: 'gone' as const, said: null}, M.receive.checkout.endedBody('gone')],
      [{kind: 'status' as const, status: status({state: 'superseded'})}, M.receive.checkout.endedBody('superseded')],
    ] as const) {
      const tree = mount(VCHF);
      await openCharge(tree);
      jest.mocked(checkoutChargeStatus).mockResolvedValue(answer);
      await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
      expect(visible(tree)).toContain(body);
      act(() => { tree.unmount(); });
      jest.mocked(checkoutChargeStatus).mockResolvedValue({kind: 'status', status: status()});
    }
  });
});

describe('a customer who approves instead of sending', () => {
  /** charge-open, then let one poll carry a pull claim. */
  async function claimArrives(_tree: renderer.ReactTestRenderer) {
    jest.mocked(checkoutChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({pull: {payer: PAYER_PRINCIPAL, atSecs: CHARGE.createdSecs + 3}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
  }

  test('collects the approval: the customer’s account, the shop’s own, and the charge’s reference', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    await claimArrives(tree);

    // WHAT IS SIGNED. Every field is the thing that makes this sale creditable rather than a
    // transfer that moves money and leaves the charge open.
    expect(mockPreparePull).toHaveBeenCalledTimes(1);
    const [secret, cat, req] = mockPreparePull.mock.calls[0] as [string, unknown, Record<string, string | number>];
    expect(secret).toBe(IDENTITY.secretHex);
    expect(req.fromAccount).toBe(PAYER_PRINCIPAL);       // whose allowance is being spent
    expect(req.toAccount).toBe(MERCHANT_PRINCIPAL);      // the shop's own account, never dpay's
    expect(req.amount).toBe(PAY_RAW);                    // the price less the fee the shop absorbs
    expect(req.nonceHex).toBe(REFERENCE);                // the ONLY thing that credits this sale
    expect(req.currency).toBe(7);
    expect(cat).toEqual({currencies: CATALOG});
    // …and the reply is decoded as a PULL's, which is what keeps `InsufficientAllowance` legible.
    const decode = mockSubmitTransfer.mock.calls[0][3] as (hex: string) => Promise<unknown>;
    await decode('ff');
    expect(mockDecodeTransferFrom).toHaveBeenCalledWith('ff');
    act(() => { tree.unmount(); });
  });

  test('a collection that moved money still does NOT turn the light green — the relay does', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    await claimArrives(tree);
    // The ledger said settled. The screen says nothing of the kind: one settlement owner, and it is
    // the relay observing the money on the merchant's own history.
    expect(has(tree, 'checkout-paid')).toBe(false);
    expect(has(tree, 'checkout-qr')).toBe(true);

    // …and when the relay DOES see it, the sale lands the ordinary way.
    jest.mocked(checkoutChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: PAYER_PRINCIPAL, amountRaw: PAY_RAW, atSecs: CHARGE.createdSecs + 9, block: 91}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(has(tree, 'checkout-paid')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('the same claim is collected ONCE, however many times it is polled', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    await claimArrives(tree);
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv * 4); await flush(); });
    expect(mockPreparePull).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('a refusal names what the CUSTOMER must do, and leaves the code payable', async () => {
    const cases: Array<[string, string]> = [
      ['InsufficientAllowance', M.receive.checkout.collectNotApproved],
      ['InsufficientFunds', M.receive.checkout.collectNoFunds],
      ['SomethingNobodyHasSeen', M.receive.checkout.collectFailed],
    ];
    for (const [variant, sentence] of cases) {
      mockSubmitTransfer.mockResolvedValue({kind: 'rejected', reason: 'no', variant} as never);
      const tree = mount(VCHF);
      await openCharge(tree);
      await claimArrives(tree);
      expect(visible(tree)).toContain(sentence);
      // Nothing was taken and nothing is claimed: the code is still on screen and still payable.
      expect(has(tree, 'checkout-qr')).toBe(true);
      expect(has(tree, 'checkout-paid')).toBe(false);
      act(() => { tree.unmount(); });
      mockPreparePull.mockClear();
    }
  });

  test('an unknown outcome is left to the poll rather than shown as a failure', async () => {
    // The money may well have moved — the ledger simply did not answer inside this phone's budget.
    // Saying "could not collect" there would send a cashier to ask for a second payment.
    mockSubmitTransfer.mockResolvedValue({kind: 'unknown'} as never);
    const tree = mount(VCHF);
    await openCharge(tree);
    await claimArrives(tree);
    expect(has(tree, 'checkout-collect-err')).toBe(false);
    expect(visible(tree)).toContain(M.receive.checkout.waiting);
    act(() => { tree.unmount(); });
  });
});

describe('clearing the checkout', () => {
  test('a cancelled charge ends the code and offers the next customer', async () => {
    jest.mocked(cancelCheckoutCharge).mockResolvedValue({kind: 'cancelled', status: status({state: 'cancelled'})});
    const tree = mount(VCHF);
    await openCharge(tree);
    await act(async () => { node(tree, 'btn-checkout-cancel').props.onPress(); await flush(); });
    expect(cancelCheckoutCharge).toHaveBeenCalledWith(RELAY, IDENTITY);
    expect(has(tree, 'checkout-ended')).toBe(true);
    expect(visible(tree)).toContain(M.receive.checkout.endedBody('cancelled'));
    act(() => { tree.unmount(); });
  });

  test('a cancellation that did not happen names the unreachable host and says it is still payable', async () => {
    jest.mocked(cancelCheckoutCharge).mockResolvedValue(
      {kind: 'unreachable', detail: 'ECONNREFUSED', tried: [RELAY], blame: 'unreachable'});
    const tree = mount(VCHF);
    await openCharge(tree);
    await act(async () => { node(tree, 'btn-checkout-cancel').props.onPress(); await flush(); });
    expect(has(tree, 'checkout-ended')).toBe(false);
    expect(has(tree, 'checkout-qr')).toBe(true);
    // Wave-2: the refusal copy carries the host attribution (symmetric with the open path);
    // work order 2026-09-30: the blame is classified, so the ONLINE sentence stops implying the
    // phone's connection is the problem.
    expect(visible(tree)).toContain(M.receive.checkout.cancelUnreachable('checkout.example'));
    expect(visible(tree)).toContain('connection is fine');
    expect(visible(tree)).toContain('payable');
    act(() => { tree.unmount(); });
  });

  test('an offline cancellation keeps the charge payable and blames nobody', async () => {
    jest.mocked(cancelCheckoutCharge).mockResolvedValue(
      {kind: 'unreachable', detail: 'ECONNREFUSED', tried: [RELAY], blame: 'offline'});
    const tree = mount(VCHF);
    await openCharge(tree);
    await act(async () => { node(tree, 'btn-checkout-cancel').props.onPress(); await flush(); });
    expect(visible(tree)).toContain(M.receive.checkout.cancelUnreachableOffline('checkout.example'));
    expect(visible(tree)).toMatch(/offline/i);
    expect(visible(tree)).toContain('payable');
    act(() => { tree.unmount(); });
  });
});

// The counter is the ONE component that mounts a mode surface INSIDE another one (Receive's own),
// which is how its charge-open form came to be sized to its own max-content and hung 71.7px off both
// edges of a 358px column. The reason lives in `app/styles.ts` (MODE_SURFACE); what is pinned here
// is that this component picks the right surface for each of its two shapes.
function surfaceOf(tree: renderer.ReactTestRenderer): {alignSelf?: string; justifyContent?: string} {
  return StyleSheet.flatten(tree.root.findAllByType(View)[0].props.style) as {alignSelf?: string; justifyContent?: string};
}

describe('the counter fits the screen it is nested in', () => {
  test('the charge-open form fills its column and starts at the top', () => {
    const tree = mount(VCHF);
    expect(has(tree, 'btn-checkout-open')).toBe(true);
    expect(surfaceOf(tree)).toEqual(StyleSheet.flatten(S.centerTop));
    expect(surfaceOf(tree).alignSelf).toBe('stretch');
    expect(surfaceOf(tree).justifyContent).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  test('the live code is a moment — centred, and still filling its column', async () => {
    const tree = mount(VCHF);
    await openCharge(tree);
    expect(has(tree, 'checkout-qr')).toBe(true);
    expect(surfaceOf(tree).justifyContent).toBe('center');
    expect(surfaceOf(tree).alignSelf).toBe('stretch');
    act(() => { tree.unmount(); });
  });
});
