/**
 * Practice — the first-run payment, and the three things it must never get wrong.
 *
 * 1. THE GUARD. `practiceRefusal` is the only thing standing between a pinned KEYLESS payee and
 *    real money, so both halves are pinned: currency 0 passes, everything else is refused by name.
 * 2. HONESTY. Three outcomes and exactly one success. An `unknown` result must render the pending
 *    state — no success mark, no settled sentence — because a payment whose outcome is not known
 *    is not a payment that failed and is certainly not one that worked. A `rejected` result shows
 *    the ledger's own decoded reason.
 * 3. NEVER A DEAD END, AND NEVER A SOLICITATION. Each of the four fail-closed branches renders its
 *    own named panel with a way forward, and none of them offers a deposit address or an
 *    add-money action (anti-scam rule R1) — this is the screen a brand-new user meets before the
 *    app has asked them for anything, and it must stay that way.
 *
 * Stamps: a settled practice payment awards `flowUnderstood` and NOT `paymentTested` — that second
 * stamp is about a payment to a real counterparty, and leaving it unfilled is what keeps the trip
 * passport's "one payment to go" true.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {JOURNEY_STORAGE_KEY, PRACTICE_AMOUNT_RAW, PRACTICE_PAYEE_PUBKEY} from '../config/constants';

jest.mock('../services/native', () => ({
  DpayCore: {
    encodeRequest: jest.fn(),
    decodeRequest: jest.fn(),
  },
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  // The wire→intent conversion is exercised for real in rail.test.ts; stubbed here so this suite
  // stays a component test (no principal derivation on the practice path).
  wireRequestToIntent: jest.fn(),
}));
// The catalog is the relay's, and its fetch/cache dance is useCatalog's own subject. The bundled
// default carries the real DEMO row, which is what practice formats and signs against.
jest.mock('../hooks/useCatalog', () => ({
  useCatalog: () => jest.requireActual<typeof import('../config/catalog')>('../config/catalog').BUNDLED_NETWORKS,
}));

import {DpayCore} from '../services/native';
import {prepareTransfer, submitTransfer, wireRequestToIntent, type RailPrepared} from '../services/rail';
import {Practice, practiceRefusal, FIRST_RUN_PRACTICE} from '../components/Practice';
import {M} from '../i18n';
import type {Identity, PayIntent, Req} from '../lib/types';

type Tree = renderer.ReactTestRenderer;

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: 'ab'.repeat(32), username: 'me'};
const RELAY = 'http://relay.example';

const REQ: Req = {
  toHex: PRACTICE_PAYEE_PUBKEY,
  amount: PRACTICE_AMOUNT_RAW,
  nonceHex: 'cd'.repeat(16),
  expiry: Math.floor(Date.now() / 1000) + 900,
  currency: 0,
  toName: 'Practice shop',
  memo: '',
};
const INTENT: PayIntent = {
  toAccount: 'aaaaa-aa',
  toName: 'Practice shop',
  toAccountText: 'e1f9e51a…',
  amount: PRACTICE_AMOUNT_RAW,
  currency: 0,
  nonceHex: REQ.nonceHex,
  memo: '',
  expiry: REQ.expiry,
  source: 'wire',
};
const PREPARED: RailPrepared = {
  ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai',
  envelopeHex: 'ab'.repeat(64),
  requestIdHex: 'cd'.repeat(32),
  amount: PRACTICE_AMOUNT_RAW,
  currency: 0,
  memoHex: REQ.nonceHex,
};

function findByTestID(tree: Tree, id: string): renderer.ReactTestInstance {
  const matches = tree.root.findAll(node => node.props && node.props.testID === id);
  if (matches.length === 0) throw new Error(`no node with testID=${id}`);
  return matches[0];
}
function isPresent(tree: Tree, id: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === id).length > 0;
}
function textOf(tree: Tree, id: string): string {
  const found: string[] = [];
  const walk = (node: renderer.ReactTestInstance) => {
    for (const c of node.children) {
      if (typeof c === 'string') found.push(c);
      else walk(c);
    }
  };
  walk(findByTestID(tree, id));
  return found.join('');
}

const realFetch = globalThis.fetch;

/** A relay with a working faucet and a funded practice balance, unless told otherwise. */
function installRelay(opts: {balance?: string; demoFaucet?: boolean; faucet?: {ok: boolean; body: unknown; status?: number}; balanceReachable?: boolean} = {}) {
  const balance = opts.balance ?? '10000';
  const reachable = opts.balanceReachable ?? true;
  const calls: string[] = [];
  const fetchMock = jest.fn((url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/v1/balances/')) {
      return reachable
        ? Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({'0': balance})} as unknown as Response)
        : Promise.reject(new Error('offline'));
    }
    if (u.includes('/api/v1/capabilities')) {
      return Promise.resolve({ok: true, status: 200, json: () => Promise.resolve({till: false, demo_faucet: opts.demoFaucet ?? true})} as unknown as Response);
    }
    if (u.includes('/api/v1/faucet')) {
      const f = opts.faucet ?? {ok: true, body: {balance: '10000'}};
      return Promise.resolve({ok: f.ok, status: f.status ?? (f.ok ? 200 : 422), json: () => Promise.resolve(f.body)} as unknown as Response);
    }
    return Promise.reject(new Error(`unexpected fetch: ${u}`));
  });
  (globalThis as unknown as {fetch: unknown}).fetch = fetchMock;
  return {calls};
}

async function mount(onDone: () => void = () => {}): Promise<Tree> {
  let tree!: Tree;
  await act(async () => { tree = renderer.create(<Practice identity={IDENTITY} relayUrl={RELAY} onDone={onDone} />); });
  // The readiness sequence is a chain of awaited fetches; let it finish.
  await act(async () => {});
  await act(async () => {});
  return tree;
}

/** Get from the request card to the review card. */
async function openReview(tree: Tree): Promise<void> {
  await act(async () => { findByTestID(tree, 'btn-practice-review').props.onPress(); });
}

describe('Practice — the currency guard', () => {
  test('the practice currency is allowed', () => {
    expect(practiceRefusal(0)).toBeNull();
  });

  test('every other currency is refused BY NAME — the keyless payee must never hold real money', () => {
    for (const currency of [1, 2, 6, 7, 8, 9]) {
      const refusal = practiceRefusal(currency);
      expect(refusal).not.toBeNull();
      expect(refusal).toContain(String(currency));
      expect(refusal).toContain('keyless');
    }
  });
});

describe('Practice — the payment', () => {
  beforeEach(() => {
    (DpayCore.encodeRequest as jest.Mock<typeof DpayCore.encodeRequest>).mockResolvedValue('practice-wire');
    (DpayCore.decodeRequest as jest.Mock<typeof DpayCore.decodeRequest>).mockResolvedValue(REQ);
    (wireRequestToIntent as jest.Mock<typeof wireRequestToIntent>).mockResolvedValue(INTENT);
    (prepareTransfer as jest.Mock<typeof prepareTransfer>).mockResolvedValue(PREPARED);
    return AsyncStorage.clear();
  });
  afterEach(() => {
    (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
    jest.clearAllMocks();
  });

  test('the request card names the practice payee and the ∂1.00 amount, and the review is the REAL review', async () => {
    installRelay();
    const tree = await mount();
    expect(isPresent(tree, 'practice-card')).toBe(true);
    expect(textOf(tree, 'practice-balance')).toContain('∂100.00');

    await openReview(tree);
    // PaymentReview's own testIDs — the exact ones the Pay tab renders, which is the point.
    expect(textOf(tree, 'pay-amount')).toContain('∂1.00');
    expect(isPresent(tree, 'btn-approve')).toBe(true);
    expect(isPresent(tree, 'btn-review-cancel')).toBe(true);
    // The fee line says who sets it — never a 0 that would be a claim about money.
    expect(textOf(tree, 'practice-fee')).toBe(M.withdraw.send.feeUnknown);
    // …and the honest line about why practising needs a connection when the product does not.
    expect(textOf(tree, 'practice-both-sides')).toBe(M.education.practice.bothSides);

    // The request that was built is the REAL 132-byte wire request, to the pinned payee.
    expect(DpayCore.encodeRequest).toHaveBeenCalledTimes(1);
    const args = (DpayCore.encodeRequest as jest.Mock<typeof DpayCore.encodeRequest>).mock.calls[0];
    expect(args[0]).toBe(PRACTICE_PAYEE_PUBKEY);
    expect(args[1]).toBe(PRACTICE_AMOUNT_RAW);
    expect(args[4]).toBe(0);
    act(() => { tree.unmount(); });
  });

  test('a SETTLED payment shows the confirmed state, the remaining balance, and awards flowUnderstood only', async () => {
    installRelay();
    (submitTransfer as jest.Mock<typeof submitTransfer>).mockImplementation(async () => {
      // The ledger has moved the money by the time the balance is re-read.
      installRelay({balance: '9900'});
      return {kind: 'settled', blockIndex: '42'};
    });
    const tree = await mount();
    await openReview(tree);
    await act(async () => { findByTestID(tree, 'btn-approve').props.onPress(); });
    await act(async () => {});

    expect(textOf(tree, 'practice-outcome-body')).toBe(M.education.practice.settledBody);
    expect(textOf(tree, 'practice-left')).toContain('∂99.00');
    expect(isPresent(tree, 'btn-practice-continue')).toBe(true);

    const j = JSON.parse((await AsyncStorage.getItem(JOURNEY_STORAGE_KEY)) as string);
    expect(j.stamps).toEqual(['flowUnderstood']);
    expect(j.stamps).not.toContain('paymentTested');
    act(() => { tree.unmount(); });
  });

  test('an UNKNOWN outcome renders the pending state — never a success, and never a stamp', async () => {
    installRelay();
    (submitTransfer as jest.Mock<typeof submitTransfer>).mockResolvedValue({kind: 'unknown'});
    const tree = await mount();
    await openReview(tree);
    await act(async () => { findByTestID(tree, 'btn-approve').props.onPress(); });
    await act(async () => {});

    expect(textOf(tree, 'practice-outcome-body')).toBe(M.education.practice.pendingBody);
    // The settled sentence is nowhere on this screen, and no balance claim is made.
    expect(textOf(tree, 'practice-outcome')).not.toContain(M.education.practice.settledBody);
    expect(isPresent(tree, 'practice-left')).toBe(false);
    // No stamp: the flow was not demonstrated, it was left in doubt.
    expect(await AsyncStorage.getItem(JOURNEY_STORAGE_KEY)).toBeNull();
    // …and it still exits.
    expect(isPresent(tree, 'btn-practice-continue')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a REJECTED payment shows the ledger’s own reason and says nothing moved', async () => {
    installRelay();
    (submitTransfer as jest.Mock<typeof submitTransfer>).mockResolvedValue({kind: 'rejected', reason: 'Insufficient funds: balance 0'});
    const tree = await mount();
    await openReview(tree);
    await act(async () => { findByTestID(tree, 'btn-approve').props.onPress(); });
    await act(async () => {});

    expect(textOf(tree, 'practice-refused-reason')).toBe('Insufficient funds: balance 0');
    expect(textOf(tree, 'practice-outcome-body')).toBe(M.education.practice.refusedBody);
    expect(await AsyncStorage.getItem(JOURNEY_STORAGE_KEY)).toBeNull();
    expect(isPresent(tree, 'btn-practice-continue')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('Continue and Skip both leave — practice never blocks the first run', async () => {
    installRelay();
    const onDone = jest.fn();
    const tree = await mount(onDone);
    act(() => { findByTestID(tree, 'btn-practice-skip').props.onPress(); });
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('Practice — the four fail-closed branches', () => {
  beforeEach(() => AsyncStorage.clear());
  afterEach(() => { (globalThis as unknown as {fetch: unknown}).fetch = realFetch; jest.clearAllMocks(); });

  /** Anti-scam rule R1: no first-run screen may render a deposit address, a fundable QR or an
   *  add-money action. `InstructionPanel` renders its primary as `<testID>-go`, so its ABSENCE is
   *  the structural check — a future edit that adds a "Show my address" button fails here. */
  function assertNoFunding(tree: Tree, panel: string): void {
    expect(isPresent(tree, `${panel}-go`)).toBe(false);
    const body = textOf(tree, panel).toLowerCase();
    expect(body).not.toMatch(/deposit|add money|top up|buy /);
  }

  test('no faucet: says the server hands out none, offers Continue, and shows NO deposit address', async () => {
    installRelay({balance: '0', demoFaucet: false});
    const tree = await mount();
    expect(isPresent(tree, 'practice-nofaucet')).toBe(true);
    expect(isPresent(tree, 'btn-practice-continue')).toBe(true);
    // The skip affordance is gone: Continue is the one exit, so there is no second control that
    // does the same thing.
    expect(isPresent(tree, 'btn-practice-skip')).toBe(false);
    assertNoFunding(tree, 'practice-nofaucet');
    act(() => { tree.unmount(); });
  });

  test('faucet cooldown: carries the relay’s OWN remaining-time reason, verbatim', async () => {
    installRelay({balance: '0', faucet: {ok: false, status: 422, body: {error: 'faucet cooldown: try again in ~58 min'}}});
    const tree = await mount();
    expect(isPresent(tree, 'practice-cooldown')).toBe(true);
    expect(textOf(tree, 'practice-cooldown')).toContain('faucet cooldown: try again in ~58 min');
    assertNoFunding(tree, 'practice-cooldown');
    act(() => { tree.unmount(); });
  });

  test('offline: explains that THIS phone is playing both roles, and offers a retry', async () => {
    installRelay({balanceReachable: false});
    const tree = await mount();
    expect(isPresent(tree, 'practice-offline')).toBe(true);
    // The retry is InstructionPanel's re-check affordance, not a funding action.
    expect(isPresent(tree, 'practice-offline-check')).toBe(true);
    assertNoFunding(tree, 'practice-offline');
    act(() => { tree.unmount(); });
  });

  test('an empty balance never offers Approve', async () => {
    // The faucet answers OK but credits nothing — the honest "there is still nothing to pay with".
    installRelay({balance: '0', faucet: {ok: true, body: {balance: '0'}}});
    const tree = await mount();
    expect(isPresent(tree, 'practice-empty')).toBe(true);
    expect(isPresent(tree, 'btn-practice-review')).toBe(false);
    expect(isPresent(tree, 'btn-approve')).toBe(false);
    assertNoFunding(tree, 'practice-empty');
    act(() => { tree.unmount(); });
  });
});

describe('Practice — the seen marker', () => {
  test('is the free-form journey key the first-run router reads', () => {
    expect(FIRST_RUN_PRACTICE).toBe('firstRunPractice');
  });
});
