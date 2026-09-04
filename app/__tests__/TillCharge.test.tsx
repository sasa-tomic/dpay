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
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

jest.mock('../services/till', () => {
  const actual = jest.requireActual('../services/till') as Record<string, unknown>;
  return {
    ...actual, // TILL_OFFER / chfCents / tillRawUnits stay REAL — they are pure and are the rules
    openTillCharge: jest.fn(),
    tillChargeStatus: jest.fn(),
    cancelTillCharge: jest.fn(),
  };
});

import {TillCharge} from '../components/TillCharge';
import {openTillCharge, tillChargeStatus, cancelTillCharge, type TillStatus} from '../services/till';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {POLL, PROOF_POLL_BUDGET} from '../config/constants';
import {M} from '../i18n';
import type {AssetId, Identity} from '../lib/types';

const IDENTITY: Identity = {secretHex: '0b'.repeat(32), publicHex: '66'.repeat(32), username: 'Bahnhof Kiosk'};
const RELAY = 'https://till.example';

// The wallet's REAL selectable rows, both rails — the same list the Receive forms hand this
// component in production, so "which asset can ring one up" is decided against the shipping
// catalog rather than a hand-made fixture that could disagree with it.
const ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {showTestnet: false, solanaEnabled: true});
const assetOf = (predicate: (a: SelectableAsset) => boolean): SelectableAsset => {
  const found = ASSETS.find(predicate);
  if (!found) throw new Error('the bundled catalog must carry this row');
  return found;
};
const VCHF = assetOf(a => a.linkToken === 'VCHF');
const CKBTC = assetOf(a => a.linkToken === 'ckBTC');
const SOL = assetOf(a => a.protocol === 'solana' && a.token === 'SOL');

const CHARGE = {id: 'pl_ecd765908f264957', cents: '1050', qr: 'https://till.example/pl/?lightning=LNURL1XYZ', createdSecs: 1_788_479_954, expiresAt: 1_788_483_554};

/** A status body as the relay would answer for the charge above. */
function status(over: Partial<TillStatus> = {}): TillStatus {
  return {id: CHARGE.id, cents: '1050', state: 'open', createdSecs: CHARGE.createdSecs, expiresAt: CHARGE.expiresAt, paid: null, ...over};
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

function mount(asset: SelectableAsset, onSelectAsset: (id: AssetId) => void = () => {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <TillCharge
        identity={IDENTITY}
        relayUrl={RELAY}
        asset={asset}
        assets={ASSETS}
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
  test('sends the exact whole rappen at the asset’s own precision, and shows the code', async () => {
    const tree = mount(VCHF);
    await ringUp(tree);
    expect(openTillCharge).toHaveBeenCalledWith(RELAY, IDENTITY, '1050', VCHF.decimals);
    expect(node(tree, 'till-qr')).toBeDefined();
    const said = visible(tree);
    expect(said).toContain('10.50 CHF');       // the price the cashier reads out
    expect(said).toContain('10.50 VCHF');      // what the customer's wallet will actually move
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
    jest.mocked(openTillCharge).mockResolvedValue({kind: 'not-served'});
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

  test('a cancellation that did not happen leaves the code up and says it is still payable', async () => {
    jest.mocked(cancelTillCharge).mockResolvedValue({kind: 'unreachable', detail: 'ECONNREFUSED'});
    const tree = mount(VCHF);
    await ringUp(tree);
    await act(async () => { node(tree, 'btn-till-cancel').props.onPress(); await flush(); });
    expect(has(tree, 'till-ended')).toBe(false);
    expect(has(tree, 'till-qr')).toBe(true);
    expect(visible(tree)).toContain(M.receive.till.cancelUnreachable);
    act(() => { tree.unmount(); });
  });
});
