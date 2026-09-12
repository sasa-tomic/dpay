/**
 * The counter (`components/TillCharge.tsx`) — the merchant's own OpenCryptoPay charge, rendered
 * inside Receive ▸ Request payment as a second code FORM.
 *
 * WHAT THIS SUITE OWNS. The client's outcomes are `till.test.ts`'s business and the signed bytes are
 * `tillOpenSignature.test.ts`'s; the three routes are mocked at their module boundary here so what
 * is exercised is the SCREEN: which asset may ring one up, what the cashier is told when it cannot,
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
 * becomes the ICRC-1 memo the relay credits the sale on, and that nothing about the tap is allowed
 * to turn the paid light green.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {StyleSheet, Text, View} from 'react-native';

jest.mock('../services/till', () => {
  const actual = jest.requireActual('../services/till') as Record<string, unknown>;
  return {
    ...actual, // TILL_OFFER / chfCents / tillRawUnits stay REAL — they are pure and are the rules
    openTillCharge: jest.fn(),
    tillChargeStatus: jest.fn(),
    cancelTillCharge: jest.fn(),
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

import {TillCharge} from '../components/TillCharge';
import {openTillCharge, tillChargeStatus, cancelTillCharge, tillRawUnits, type TillStatus} from '../services/till';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {NFC_UPDATE_AHEAD_S, POLL, PROOF_POLL_BUDGET} from '../config/constants';
import {M} from '../i18n';
import {S} from '../styles';
import type {AssetId, Identity, NfcStatus} from '../lib/types';

const IDENTITY: Identity = {secretHex: '0b'.repeat(32), publicHex: '66'.repeat(32), username: 'Bahnhof Kiosk'};
const RELAY = 'https://till.example';
/** The shop's own account — what the allowance names as spender and what a collection pays TO. */
const MERCHANT_PRINCIPAL = 'snzff-yj2qd-fjns7-lqhvw-rsgq7-tohk2-fjnw4-uq3d6-wtk56-pxgry-mqe';
/** A customer who approved instead of sending. */
const PAYER_PRINCIPAL = 'ygf2v-2qaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-aaaaa-4ae';

// The wallet's REAL selectable rows, both rails — the same list the Receive forms hand this
// component in production, so "which asset can ring one up" is decided against the shipping
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
const CHARGE = {id: 'pl_ecd765908f264957', cents: '1050', qr: 'https://till.example/pl/?lightning=LNURL1XYZ', reference: REFERENCE, createdSecs: 1_788_479_954, expiresAt: 1_788_483_554};
/** VCHF's ledger fee, from the same catalog row the counter reads — the fee the SHOP absorbs. */
const VCHF_FEE_RAW = (() => {
  const row = CATALOG.find(c => c.currency === 7);
  if (row?.fee == null) throw new Error('the bundled catalog must state VCHF’s ledger fee');
  return row.fee;
})();

/** What the SHOP receives for a CHF 10.50 charge: 1050 rappen at VCHF's eight decimals, less the
 *  ledger fee. The customer's wallet moves this PLUS that fee — i.e. exactly CHF 10.50, which is
 *  the whole point of the subtraction (`tillRawUnits`, services/till.ts). */
const PAY_RAW = tillRawUnits('1050', 8, VCHF_FEE_RAW);

/** A status body as the relay would answer for the charge above. */
function status(over: Partial<TillStatus> = {}): TillStatus {
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
  onSelectAsset: (id: AssetId) => void = () => {},
  nfcStatus: NfcStatus = 'ready',
  catalog: CurrencyDescriptor[] = CATALOG,
) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <TillCharge
        identity={IDENTITY}
        relayUrl={RELAY}
        asset={asset}
        assets={ASSETS}
        catalog={catalog}
        nfcStatus={nfcStatus}
        onSelectAsset={onSelectAsset}
      />,
    );
  });
  return tree;
}

/** Ring up CHF 10.50 and let the open resolve. */
async function ringUp(tree: renderer.ReactTestRenderer, amount = '10.50') {
  act(() => { node(tree, 'till-amount-input').props.onChangeText(amount); });
  await act(async () => { node(tree, 'btn-till-ring-up').props.onPress(); await flush(); });
}

beforeEach(() => {
  // The screen runs a 1s display clock and a poll interval; Date stays real so the countdown maths
  // is the production one.
  jest.useFakeTimers({doNotFake: ['Date']});
  jest.mocked(openTillCharge).mockResolvedValue({kind: 'open', charge: CHARGE});
  jest.mocked(tillChargeStatus).mockResolvedValue({kind: 'status', status: status()});
  jest.mocked(cancelTillCharge).mockReset();
  mockTap.props = null;
  mockBuildRequest.mockClear();
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
  jest.mocked(openTillCharge).mockReset();
  jest.mocked(tillChargeStatus).mockReset();
});

describe('which asset may ring up a till charge', () => {
  test('refuses an IC asset that is not the till’s, by name, with the one tap that fixes it', () => {
    const picked: AssetId[] = [];
    const tree = mount(CKBTC, id => picked.push(id));
    expect(has(tree, 'till-refused')).toBe(true);
    // No counter at all: a form that cannot produce a payable code must not be typed into.
    expect(has(tree, 'till-amount-input')).toBe(false);
    const said = visible(tree);
    // The BACKING symbol, as every other surface in this wallet names it — never the `ck*` wrapper.
    expect(said).toContain('BTC');
    expect(said).not.toContain('ckBTC');
    expect(said).toContain('Bitcoin'); // the rail, not just the asset
    expect(said).toContain('VCHF');
    act(() => { node(tree, 'till-refused-go').props.onPress(); });
    expect(picked).toEqual([VCHF.id]);
    act(() => { tree.unmount(); });
  });

  test('renders the SAME control on the Solana rail and refuses it by name', () => {
    // The same-surfaces hard rule: the control exists on both rails; only the answer differs.
    const picked: AssetId[] = [];
    const tree = mount(SOL, id => picked.push(id));
    expect(has(tree, 'till-refused')).toBe(true);
    const said = visible(tree);
    expect(said).toContain('SOL');
    expect(said).toContain('Solana');
    act(() => { node(tree, 'till-refused-go').props.onPress(); });
    expect(picked).toEqual([VCHF.id]); // one tap crosses the rail
    act(() => { tree.unmount(); });
  });

  test('opens the counter for the asset a till code is actually paid in', () => {
    const tree = mount(VCHF);
    expect(has(tree, 'till-amount-input')).toBe(true);
    expect(has(tree, 'till-refused')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('ringing up', () => {
  test('closes the counter when the catalog states no fee, rather than billing the customer for it', async () => {
    // The shop pays the ledger fee out of the price. A row that states no fee leaves nothing to
    // subtract, and quoting the full price instead would put the fee back on the customer in
    // silence — the one outcome the rule exists to prevent. So the counter refuses, names the
    // asset and the relay, and offers no amount field at all.
    const feeless = CATALOG.map(c => (c.currency === 7 ? {...c, fee: null} : c));
    const tree = mount(VCHF, () => {}, 'ready', feeless);
    expect(node(tree, 'till-no-fee')).toBeDefined();
    expect(node(tree, 'till-amount-input')).toBeUndefined();
    expect(node(tree, 'btn-till-ring-up')).toBeUndefined();
    const said = visible(tree);
    expect(said).toContain('VCHF');
    expect(said).toContain('till.example'); // the relay whose list is missing it
    // …and it is NOT the wrong-asset refusal, which would send the cashier to switch to the asset
    // they are already on.
    expect(node(tree, 'till-refused')).toBeUndefined();
    expect(openTillCharge).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('sends the exact whole rappen at the asset’s own precision, and shows the code', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(openTillCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals, VCHF_FEE_RAW);
    expect(node(tree, 'till-qr')).toBeDefined();
    const said = visible(tree);
    expect(said).toContain('10.50 CHF');       // the price the cashier reads out
    // The SHOP's side of the same sale: the price less the ledger fee it absorbs. Both numbers are
    // on screen on purpose — a cashier shown only the smaller one would read it as a misprice.
    expect(said).toContain('10.4999 VCHF');
    expect(said).toContain(M.receive.till.waiting);
    // Nothing on this screen may suggest the customer has scanned or is even present.
    expect(said).not.toContain('scanned');
    act(() => { tree.unmount(); });
  });

  test('refuses a price finer than a rappen without sending anything', async () => {
    const tree = mount(VCHF);
    await ringUp(tree, '10.505');
    expect(openTillCharge).not.toHaveBeenCalled();
    expect(visible(tree)).toContain(M.receive.till.badAmount('too-precise'));
    expect(has(tree, 'till-qr')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a relay that serves no till is a named dead end, not a spinner', async () => {
    jest.mocked(openTillCharge).mockResolvedValue({kind: 'not-served', addr: 'https://till.example'});
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(has(tree, 'till-failed')).toBe(true);
    const said = visible(tree);
    expect(said).toContain('till.example');            // WHICH relay could not do it
    expect(said).toContain(M.receive.till.tryAgain);   // and the way out
    act(() => { tree.unmount(); });
  });

  test('a refusal carries the till’s own sentence, which already names the fix', async () => {
    jest.mocked(openTillCharge).mockResolvedValue({kind: 'refused', said: 'Re-sync the device clock', status: 401});
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(visible(tree)).toContain('Re-sync the device clock');
    act(() => { tree.unmount(); });
  });
});

describe('a customer who taps instead of scanning', () => {
  test('arms the reader with the CHARGE’s reference as the request nonce', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);

    // THE JOIN THIS WHOLE SURFACE TURNS ON. `prepareNfcTransfer` writes the request's nonce onto the
    // payer's transfer as its ICRC-1 memo, and the relay credits only a transfer whose memo is this
    // charge's reference — so a request built with a nonce of this wallet's own would move the
    // customer's money and leave the sale open.
    expect(mockBuildRequest).toHaveBeenCalledTimes(1);
    const [toHex, amount, nonce, expiry, currency, toName, memo] = mockBuildRequest.mock.calls[0];
    expect(toHex).toBe(IDENTITY.publicHex);           // paid to the shop's own account, never dpay's
    expect(amount).toBe(PAY_RAW);                     // the franc price at VCHF's own precision
    expect(nonce).toBe(REFERENCE);
    expect(currency).toBe(7);                         // VCHF, the one asset a dpay till takes
    expect(toName).toBe(IDENTITY.username);
    expect(memo).toBe('');
    expect(typeof expiry).toBe('number');
    expect(mockStampExpiry).toHaveBeenCalledWith(IDENTITY.secretHex, NFC_UPDATE_AHEAD_S);

    // …and the reader is mounted with exactly that request, told the same amount/nonce/currency it
    // will later match ledger history on.
    expect(mockTap.props?.role).toBe('reader');
    expect(mockTap.props?.requestHex).toBe(await mockBuildRequest.mock.results[0].value);
    expect(mockTap.props?.reqInfo).toMatchObject({amount: PAY_RAW, nonce: REFERENCE, currency: 7});
    // NO `onSettled`: nothing the radio does may turn the paid light green — only the relay's poll.
    expect(mockTap.props?.onSettled).toBeUndefined();

    // The code is up and tappable, and says so in one line rather than two.
    expect(has(tree, 'till-qr')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.showToCustomer('tap'));
    act(() => { tree.unmount(); });
  });

  test('a phone that cannot tap still shows a code, and names what is wrong with the phone', async () => {
    const tree = mount(VCHF, () => {}, 'off');
    await ringUp(tree);
    // Nothing is armed and nothing is claimed: no request was built at all.
    expect(mockBuildRequest).not.toHaveBeenCalled();
    expect(mockTap.props).toBeNull();
    // The radio's own row takes the line, because the fix is about the PHONE (turn NFC on) rather
    // than about this code — and the code itself is still up and still scannable.
    expect(has(tree, 'till-nfc')).toBe(true);
    expect(has(tree, 'till-tap-hint')).toBe(false);
    expect(has(tree, 'till-qr')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a tap request that could not be built leaves a scannable code and says only that', async () => {
    // The certified IC instant the request's expiry needs is a network read; without it there is no
    // honest expiry to sign, so no reader is armed. The code must not silently lose its QR over it.
    mockStampExpiry.mockRejectedValue(new Error('certified time unreachable'));
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(mockTap.props).toBeNull();
    expect(has(tree, 'till-qr')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.showToCustomer('none'));
    expect(visible(tree)).not.toContain(M.receive.till.showToCustomer('tap'));
    act(() => { tree.unmount(); });
  });

  test('a tap in flight owns the screen, and the paid light is still the relay’s answer', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    const onActive = mockTap.props?.onActive as () => void;
    const onClose = mockTap.props?.onClose as () => void;

    // The exchange starts: the counter's own body goes away rather than sitting beside a tap that
    // is mid-flight. Two settlement surfaces at once is the thing a cashier learns to distrust.
    act(() => { onActive(); });
    expect(has(tree, 'till-qr')).toBe(false);
    expect(has(tree, 'till-tap-hint')).toBe(false);

    // The relay observes the transfer WHILE the tap is still returning its result to the payer. The
    // charge is credited underneath, and the tap keeps the screen — it still owes that result.
    jest.mocked(tillChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: PAY_RAW, atSecs: CHARGE.createdSecs + 8, block: 91}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(has(tree, 'till-paid')).toBe(false);
    expect(mockTap.props).not.toBeNull();

    // Only when the tap is done does the till's own answer take the screen — and it is the RELAY's
    // answer, with the ledger block that paid.
    act(() => { onClose(); });
    expect(has(tree, 'till-paid')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.paidBlock(91));
    act(() => { tree.unmount(); });
  });
});

describe('watching the charge', () => {
  test('an unreadable poll says CAN’T CHECK — never unpaid, never paid', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    jest.mocked(tillChargeStatus).mockResolvedValue({kind: 'unchecked', detail: 'ECONNREFUSED'});
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    const said = visible(tree);
    expect(said).toContain(M.receive.till.cantCheck);
    expect(said).not.toContain(M.receive.till.waiting);
    expect(has(tree, 'till-paid')).toBe(false);
    // The code stays up and the money is untouched by our ignorance — the charge is still showing.
    expect(has(tree, 'till-qr')).toBe(true);
    // …and the screen recovers the moment the till answers again.
    jest.mocked(tillChargeStatus).mockResolvedValue({kind: 'status', status: status()});
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.till.waiting);
    act(() => { tree.unmount(); });
  });

  test('paid renders the RELAY’s answer: the block that paid, and who paid it', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    jest.mocked(tillChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: '1050000000', atSecs: CHARGE.createdSecs + 30, block: 77}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    const said = visible(tree);
    expect(said).toContain(M.receive.till.paidAmount('10.50 CHF'));
    expect(said).toContain(M.receive.till.paidBlock(77));
    expect(said).toContain('lrdna-ai');                       // the payer, shortened
    expect(said).not.toContain(M.receive.till.paidLate);      // it landed inside the code's life
    act(() => { tree.unmount(); });
  });

  test('a transfer that lands after the code expired is accepted, and said to be late', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    jest.mocked(tillChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: 'lrdna-ain6m-ja6ko', amountRaw: '1050000000', atSecs: CHARGE.expiresAt + 5, block: 78}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.till.paidLate);
    act(() => { tree.unmount(); });
  });

  test('an expired code is watched a bounded while longer, then stops being polled', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    jest.mocked(tillChargeStatus).mockResolvedValue({kind: 'status', status: status({state: 'expired'})});
    // Inside the budget the screen says the code is dead but the money can still land — the offline
    // payer's transfer is exactly the case this window exists for.
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(visible(tree)).toContain(M.receive.till.expiredWatching);
    expect(has(tree, 'till-qr')).toBe(true);

    for (let i = 0; i < PROOF_POLL_BUDGET; i++) {
      await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    }
    expect(has(tree, 'till-ended')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.endedBody('expired'));
    // AND THE POLL IS OFF: no further request goes out for a charge nobody can pay.
    const settled = jest.mocked(tillChargeStatus).mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv * 5); await flush(); });
    expect(jest.mocked(tillChargeStatus).mock.calls.length).toBe(settled);
    act(() => { tree.unmount(); });
  });

  test('a charge the relay lost, and one another ring-up replaced, are told apart', async () => {
    for (const [answer, body] of [
      [{kind: 'gone' as const, said: null}, M.receive.till.endedBody('gone')],
      [{kind: 'status' as const, status: status({state: 'superseded'})}, M.receive.till.endedBody('superseded')],
    ] as const) {
      const tree = mount(VCHF);
      await ringUp(tree);
      jest.mocked(tillChargeStatus).mockResolvedValue(answer);
      await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
      expect(visible(tree)).toContain(body);
      act(() => { tree.unmount(); });
      jest.mocked(tillChargeStatus).mockResolvedValue({kind: 'status', status: status()});
    }
  });
});

describe('a customer who approves instead of sending', () => {
  /** Ring up, then let one poll carry a pull claim. */
  async function claimArrives(_tree: renderer.ReactTestRenderer) {
    jest.mocked(tillChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({pull: {payer: PAYER_PRINCIPAL, atSecs: CHARGE.createdSecs + 3}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
  }

  test('collects the approval: the customer’s account, the shop’s own, and the charge’s reference', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
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
    await ringUp(tree);
    await claimArrives(tree);
    // The ledger said settled. The screen says nothing of the kind: one settlement owner, and it is
    // the relay observing the money on the merchant's own history.
    expect(has(tree, 'till-paid')).toBe(false);
    expect(has(tree, 'till-qr')).toBe(true);

    // …and when the relay DOES see it, the sale lands the ordinary way.
    jest.mocked(tillChargeStatus).mockResolvedValue({
      kind: 'status',
      status: status({state: 'paid', paid: {from: PAYER_PRINCIPAL, amountRaw: PAY_RAW, atSecs: CHARGE.createdSecs + 9, block: 91}}),
    });
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv); await flush(); });
    expect(has(tree, 'till-paid')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('the same claim is collected ONCE, however many times it is polled', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    await claimArrives(tree);
    await act(async () => { jest.advanceTimersByTime(POLL.receiptRcv * 4); await flush(); });
    expect(mockPreparePull).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('a refusal names what the CUSTOMER must do, and leaves the code payable', async () => {
    const cases: Array<[string, string]> = [
      ['InsufficientAllowance', M.receive.till.collectNotApproved],
      ['InsufficientFunds', M.receive.till.collectNoFunds],
      ['SomethingNobodyHasSeen', M.receive.till.collectFailed],
    ];
    for (const [variant, sentence] of cases) {
      mockSubmitTransfer.mockResolvedValue({kind: 'rejected', reason: 'no', variant} as never);
      const tree = mount(VCHF);
      await ringUp(tree);
      await claimArrives(tree);
      expect(visible(tree)).toContain(sentence);
      // Nothing was taken and nothing is claimed: the code is still on screen and still payable.
      expect(has(tree, 'till-qr')).toBe(true);
      expect(has(tree, 'till-paid')).toBe(false);
      act(() => { tree.unmount(); });
      mockPreparePull.mockClear();
    }
  });

  test('an unknown outcome is left to the poll rather than shown as a failure', async () => {
    // The money may well have moved — the ledger simply did not answer inside this phone's budget.
    // Saying "could not collect" there would send a cashier to ask for a second payment.
    mockSubmitTransfer.mockResolvedValue({kind: 'unknown'} as never);
    const tree = mount(VCHF);
    await ringUp(tree);
    await claimArrives(tree);
    expect(has(tree, 'till-collect-err')).toBe(false);
    expect(visible(tree)).toContain(M.receive.till.waiting);
    act(() => { tree.unmount(); });
  });
});

describe('clearing the till', () => {
  test('a cancelled charge ends the code and offers the next customer', async () => {
    jest.mocked(cancelTillCharge).mockResolvedValue({kind: 'cancelled', status: status({state: 'cancelled'})});
    const tree = mount(VCHF);
    await ringUp(tree);
    await act(async () => { node(tree, 'btn-till-cancel').props.onPress(); await flush(); });
    expect(cancelTillCharge).toHaveBeenCalledWith(RELAY, IDENTITY);
    expect(has(tree, 'till-ended')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.endedBody('cancelled'));
    act(() => { tree.unmount(); });
  });

  test('a cancellation that did not happen names the unreachable host and says it is still payable', async () => {
    jest.mocked(cancelTillCharge).mockResolvedValue({kind: 'unreachable', detail: 'ECONNREFUSED', tried: [RELAY]});
    const tree = mount(VCHF);
    await ringUp(tree);
    await act(async () => { node(tree, 'btn-till-cancel').props.onPress(); await flush(); });
    expect(has(tree, 'till-ended')).toBe(false);
    expect(has(tree, 'till-qr')).toBe(true);
    // Wave-2: the refusal copy carries the host attribution (symmetric with the open path).
    expect(visible(tree)).toContain(M.receive.till.cancelUnreachable('till.example'));
    expect(visible(tree)).toContain('till.example');
    act(() => { tree.unmount(); });
  });
});

// The counter is the ONE component that mounts a mode surface INSIDE another one (Receive's own),
// which is how its ring-up form came to be sized to its own max-content and hung 71.7px off both
// edges of a 358px column. The reason lives in `app/styles.ts` (MODE_SURFACE); what is pinned here
// is that this component picks the right surface for each of its two shapes.
function surfaceOf(tree: renderer.ReactTestRenderer): {alignSelf?: string; justifyContent?: string} {
  return StyleSheet.flatten(tree.root.findAllByType(View)[0].props.style) as {alignSelf?: string; justifyContent?: string};
}

describe('the counter fits the screen it is nested in', () => {
  test('the ring-up form fills its column and starts at the top', () => {
    const tree = mount(VCHF);
    expect(has(tree, 'till-amount-input')).toBe(true);
    expect(surfaceOf(tree)).toEqual(StyleSheet.flatten(S.centerTop));
    expect(surfaceOf(tree).alignSelf).toBe('stretch');
    expect(surfaceOf(tree).justifyContent).toBeUndefined();
    act(() => { tree.unmount(); });
  });

  test('the live code is a moment — centred, and still filling its column', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(has(tree, 'till-qr')).toBe(true);
    expect(surfaceOf(tree).justifyContent).toBe('center');
    expect(surfaceOf(tree).alignSelf).toBe('stretch');
    act(() => { tree.unmount(); });
  });
});
