/**
 * SendSheet — the destination resolver's canonical output, the fee-aware amount ceiling, the
 * self-send warning, and the confirm gate while a destination is still being validated.
 *
 * SCOPE. e2e flows 104–107 already drive the real surface end to end (the VCHF direct send, the
 * four refusal messages, ckBTC's two routes, the ICP legacy transfer), and `destination.test.ts`
 * exhausts `detectAddressShape`/`routeForShape`. Nothing here repeats either. What is left is the
 * logic a browser cannot hold still or does not reach:
 *
 *  - `resolveDestination`'s RETURN VALUE — which spelling of the address is what gets shown, saved
 *    and signed. The ICRC-1 subaccount form and a case-significant base58 address are the two ways
 *    this can silently pay the wrong account, and neither appears in any flow.
 *  - the refusal branches no flow types: a Solana address, unparseable text, and a native-namespace
 *    address that its own family validator rejects.
 *  - the Max button, which is untested anywhere, together with the overspend guard it exists to
 *    satisfy (amount + fee, not amount, is what must fit inside the balance).
 *  - an `icrc1_fee` query that FAILS. The fee is read from the ledger, so an unreachable ledger is
 *    the one way the screen ends up with no fee at all — and it must then say so and still send,
 *    rather than print a 0. The e2e gateway always answers, so only a mock can produce it.
 *  - the self-send warning, in both account namespaces — it needs the wallet's own identity as the
 *    destination, which a flow would have to construct.
 *  - the button state DURING an in-flight validation: a race with no deterministic browser handle.
 *  - the Trip Readiness PAYMENT TESTED stamp, which is awarded on a CONFIRMED settle and withheld
 *    on the honest-pending 'unknown' outcome. Only a mock can produce an 'unknown' at all.
 *
 * `AddressField` and `WithdrawSheet` are null-rendering doubles that keep the props under assertion
 * (`status`, `onChange`); the core validators and the rail are mocked at their module boundaries,
 * so every verdict asserted here is SendSheet's own.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpSelfPrincipal: jest.fn(),
    icpAccountIdFromPrincipal: jest.fn(),
    icpValidateIcrcAccount: jest.fn(),
    icpValidateAccountId: jest.fn(),
  },
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  prepareLegacyTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  decodeLegacyReply: jest.fn(),
  fetchLedgerFee: jest.fn(),
}));
// The destination field is a dumb input + scanner modal (its own contract is the e2e selector set).
// The double keeps `status` — the resolved route/refusal line SendSheet computes — and `onChange`,
// which is the only way to put text in the field once the real input is gone.
jest.mock('../components/AddressField', () => ({
  AddressField: (_props: {status: unknown; onChange: (text: string) => void}) => null,
  shortAddress: (a: string) => a,
}));
// The chain-key offramp engine has its own suite (WithdrawSheet.test.tsx); here it only has to not
// render, so a native destination's delegation cannot leak into these assertions.
jest.mock('../components/WithdrawSheet', () => ({
  WithdrawSheet: (_props: {address: string}) => null,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {DpayCore} from '../services/native';
import {fetchLedgerFee, prepareTransfer, submitTransfer} from '../services/rail';
import {hasStamp, loadJourney} from '../lib/journey';
import {SendSheet, resolveDestination} from '../components/SendSheet';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {CurrencyDescriptor} from '../config/catalog';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Ada'};

// The REAL shipped rows, derived exactly as the app derives them.
const CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const byId = (id: number): CurrencyDescriptor => CATALOG.find(c => c.currency === id)!;
const VCHF = byId(7), ICP = byId(8), CKBTC = byId(1);
const LEDGER_FEE = '10000'; // 0.00010000 VCHF — what the VCHF ledger's icrc1_fee reports
const VCHF_BALANCE = '500000000'; // 5.00000000 VCHF

// Real addresses (same provenance as destination.test.ts): valid somewhere, which is the point.
const OISY = '3nrdb-dxqqw-mc4gr-fbwxc-ynsdh-2e72e-urieh-mx52v-moiye-hff4l-4qe';
const K2 = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
const K2_SUBACCOUNT = `${K2}-6cc627i.1`;
const K2_ACCOUNT_ID = '051b05839339f89053454a4b9865ea0452a4bffe2b1cd41f4982bad10c1e637c';
const BTC_LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'; // base58: case IS the address
const SOL_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// A paste that stopped early. Still shaped like bech32, so it routes to the Bitcoin family and is
// then rejected by that family's own validator — the branch below the shape/route split.
const BTC_TRUNCATED = 'bc1qar0srrr7xfkvy5l';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // the journey store is global — a stamp must not leak across tests
  jest.mocked(fetchLedgerFee).mockResolvedValue(LEDGER_FEE);
  jest.mocked(DpayCore.icpSelfPrincipal).mockResolvedValue(OISY);
  jest.mocked(DpayCore.icpAccountIdFromPrincipal).mockResolvedValue('ff'.repeat(32));
  jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: K2, subaccountHex: ''});
  jest.mocked(DpayCore.icpValidateAccountId).mockResolvedValue(K2_ACCOUNT_ID);
});

// --- component harness ---------------------------------------------------------------------------

type SendProps = Parameters<typeof SendSheet>[0];

function sendElement(o: Partial<SendProps> = {}) {
  return (
    <SendSheet
      identity={IDENTITY}
      catalog={CATALOG}
      desc={VCHF}
      balance={VCHF_BALANCE}
      family={null}
      display={null}
      tokenContract={null}
      onSent={() => {}}
      onClose={() => {}}
      {...o}
    />
  );
}

async function mountSend(o: Partial<SendProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(sendElement(o)); });
  await act(async () => {}); // self-account derivation + address-book load
  return tree;
}

/** The destination-field double: `status` is SendSheet's verdict, `onChange` the way in. */
function field(tree: renderer.ReactTestRenderer) {
  return tree.root.findByProps({testIDPrefix: 'send'}).props;
}

async function typeAddress(tree: renderer.ReactTestRenderer, text: string) {
  await act(async () => { field(tree).onChange(text); });
  await act(async () => {}); // the validators are async — let the verdict land
}

async function typeAmount(tree: renderer.ReactTestRenderer, text: string) {
  await act(async () => { tree.root.findByProps({testID: 'send-amount-input'}).props.onChangeText(text); });
}

const amountValue = (tree: renderer.ReactTestRenderer): string =>
  tree.root.findByProps({testID: 'send-amount-input'}).props.value;

const confirm = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({testID: 'btn-send-confirm'}).props;

const present = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(n => n.props != null && n.props.testID === testID).length > 0;

const textOf = (tree: renderer.ReactTestRenderer, testID: string): string =>
  String(tree.root.findByProps({testID}).props.children);

async function pressMax(tree: renderer.ReactTestRenderer) {
  await act(async () => { tree.root.findByProps({testID: 'btn-send-max'}).props.onPress(); });
}

// --- resolveDestination: what the user actually commits to ---------------------------------------

describe('resolveDestination — the canonical destination each route commits to', () => {
  test('a bare principal commits to the CORE\'s canonical owner, not the text that was typed', async () => {
    // The user pastes with stray whitespace and the wrong case; the core is the canonicaliser, and
    // its answer — not the keystrokes — is what gets shown, saved and signed.
    const pasted = `  ${K2.toUpperCase()}\n`;
    const r = await resolveDestination(pasted, VCHF);
    expect(r).toEqual({ok: true, kind: 'icrc', destination: K2, owner: K2, subaccountHex: ''});
    expect(DpayCore.icpValidateIcrcAccount).toHaveBeenCalledWith(pasted);
  });

  test('the ICRC-1 subaccount form keeps the WHOLE account text — the owner alone is a different account', async () => {
    // `principal-checksum.subaccount` names a non-default subaccount. Committing to `owner` here
    // would silently retarget the transfer at the default subaccount: same wallet, wrong account.
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: K2, subaccountHex: '01'});
    const r = await resolveDestination(K2_SUBACCOUNT.toUpperCase(), VCHF);
    expect(r).toEqual({ok: true, kind: 'icrc', destination: K2_SUBACCOUNT, owner: K2, subaccountHex: '01'});
    if (!r.ok || r.kind !== 'icrc') throw new Error('expected an icrc route');
    expect(r.destination).not.toBe(r.owner);
  });

  test('a 64-hex account identifier on ICP takes the legacy route, and never touches the ICRC parser', async () => {
    // Disjoint namespaces: an account identifier is a one-way hash, so asking the principal parser
    // about it could only ever produce a wrong answer or a misleading refusal.
    const r = await resolveDestination(K2_ACCOUNT_ID.toUpperCase(), ICP);
    expect(r).toEqual({ok: true, kind: 'icp-legacy', destination: K2_ACCOUNT_ID, accountId: K2_ACCOUNT_ID});
    expect(DpayCore.icpValidateAccountId).toHaveBeenCalledWith(K2_ACCOUNT_ID.toUpperCase());
    expect(DpayCore.icpValidateIcrcAccount).not.toHaveBeenCalled();
  });

  test('a native Bitcoin address is kept VERBATIM — base58 case is part of the address', async () => {
    // Trimmed, never re-spelled: lower-casing a base58 address produces a different (invalid, or
    // worse, valid-but-other) destination, and the minter is the final authority on it anyway.
    const r = await resolveDestination(`  ${BTC_LEGACY}\n`, CKBTC);
    expect(r).toEqual({ok: true, kind: 'native', destination: BTC_LEGACY, family: 'CkBtcUtxo'});
    if (!r.ok) throw new Error('expected a native route');
    expect(r.destination).not.toBe(BTC_LEGACY.toLowerCase());
    // No IC parser runs for a native destination — there is no IC account to parse.
    expect(DpayCore.icpValidateIcrcAccount).not.toHaveBeenCalled();
    expect(DpayCore.icpValidateAccountId).not.toHaveBeenCalled();
  });
});

describe('resolveDestination — refusals name what the address is', () => {
  test('a Solana address on an IC asset is named as Solana and pointed at the right network', async () => {
    // dpay never swaps, so a base58 Solana address is always a wrong-chain paste — and saying
    // "Solana" is the whole difference between an actionable refusal and a shrug.
    expect(await resolveDestination(SOL_ADDR, VCHF)).toEqual({
      ok: false,
      message: M.withdraw.send.refuseWrongChain('Solana', 'VCHF', 'Internet Computer'),
    });
  });

  test('text that belongs to no address namespace refuses by naming the asset it cannot be sent', async () => {
    expect(await resolveDestination('pay me back please', VCHF)).toEqual({
      ok: false,
      message: M.withdraw.send.refuseUnrecognised('VCHF'),
    });
    expect(DpayCore.icpValidateIcrcAccount).not.toHaveBeenCalled();
  });

  test('a truncated Bitcoin address is refused by the FAMILY validator, in the same status line', async () => {
    // Shape routes it to the Bitcoin burn; the family's own validator then rejects it. Before this
    // second stage lived here, a short-but-plausible address opened the burn form and only refused
    // afterwards — one refusal in a different place from every other.
    expect(await resolveDestination(BTC_TRUNCATED, CKBTC)).toEqual({
      ok: false,
      message: M.withdraw.badAddress('BTC'),
    });
  });
});

// --- the amount ceiling ---------------------------------------------------------------------------

describe('SendSheet — Max is balance MINUS fee', () => {
  test('Max fills the amount the balance can actually clear; the un-reduced balance is refused', async () => {
    const tree = await mountSend();
    await typeAddress(tree, K2);

    // The whole balance LOOKS affordable and is not: the ledger charges the fee on top.
    await typeAmount(tree, '5.00000000');
    expect(present(tree, 'send-overbalance')).toBe(true);
    expect(confirm(tree).disabled).toBe(true);

    await pressMax(tree);
    expect(amountValue(tree)).toBe('4.99990000'); // 5.00000000 − 0.00010000
    expect(present(tree, 'send-overbalance')).toBe(false);
    expect(confirm(tree).disabled).toBe(false);
    // The point of subtracting the fee: the total is exactly the balance, never above it.
    expect(textOf(tree, 'send-review-total')).toBe('5.00000000 VCHF');

    act(() => { tree.unmount(); });
  });

  test('a balance at or below the fee has nothing to send: Max yields 0 and the button stays disabled', async () => {
    for (const balance of [LEDGER_FEE, '5000']) {
      const tree = await mountSend({balance});
      await typeAddress(tree, K2);
      await pressMax(tree);
      expect(amountValue(tree)).toBe('0');
      expect(confirm(tree).disabled).toBe(true);
      expect(present(tree, 'send-review')).toBe(false); // nothing to review
      act(() => { tree.unmount(); });
    }
  });
});

describe('SendSheet — an unreachable ledger leaves the fee UNKNOWN, never 0', () => {
  test('the fee the ledger reported becomes the review\'s fee and its total', async () => {
    const tree = await mountSend();
    await typeAddress(tree, K2);
    await typeAmount(tree, '1.00000000');
    expect(fetchLedgerFee).toHaveBeenCalledWith(IDENTITY.secretHex, VCHF.ledger);
    expect(textOf(tree, 'send-review-fee')).toBe('0.00010000 VCHF');
    expect(textOf(tree, 'send-review-total')).toBe('1.00010000 VCHF');

    act(() => { tree.unmount(); });
  });

  test('a failed icrc1_fee query says so in every place a fee appears — and still lets the send go', async () => {
    // The fee is the LEDGER's, so an unreachable ledger is the one way this screen ends up with no
    // fee at all. Everything it could say instead would be a false claim about money: a 0 fee, or a
    // total that quietly equals the amount and understates what leaves the account. It says
    // "unknown" and omits the total — and the send stays armed, because the envelope carries
    // `fee: None` and the ledger applies its own.
    jest.mocked(fetchLedgerFee).mockRejectedValue(new Error('ledger unreachable'));
    const tree = await mountSend();
    await typeAddress(tree, K2);
    expect(field(tree).status).toEqual({
      text: M.withdraw.send.routeIcrcUnknownFee('Internet Computer'),
      tone: 'ok',
    });

    await typeAmount(tree, '1.00000000');
    expect(textOf(tree, 'send-review-fee')).toBe(M.withdraw.send.feeUnknown);
    expect(present(tree, 'send-review-total')).toBe(false);
    expect(textOf(tree, 'send-review-amount')).toBe('1.00000000 VCHF'); // the amount is known, and shown
    expect(confirm(tree).disabled).toBe(false);

    act(() => { tree.unmount(); });
  });
});

// --- self-send + the confirm gate -----------------------------------------------------------------

describe('SendSheet — sending to yourself warns but never blocks', () => {
  test('an IC account equal to the wallet\'s own principal warns, and the send stays enabled', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: OISY, subaccountHex: ''});
    const tree = await mountSend();
    await typeAddress(tree, OISY);
    expect(field(tree).status).toEqual({text: M.withdraw.send.selfWarning, tone: 'warn'});

    await typeAmount(tree, '1.00000000');
    expect(confirm(tree).disabled).toBe(false);
    expect(confirm(tree).accessibilityState).toEqual({disabled: false});

    act(() => { tree.unmount(); });
  });

  test('the legacy namespace recognises it too — the wallet\'s own account identifier warns', async () => {
    // An account identifier is a one-way hash, so recognising our own means DERIVING it. That
    // derivation is the only reason the legacy route can warn at all.
    const SELF_ACCOUNT_ID = K2_ACCOUNT_ID;
    jest.mocked(DpayCore.icpAccountIdFromPrincipal).mockResolvedValue(SELF_ACCOUNT_ID);
    const tree = await mountSend({desc: ICP});
    await typeAddress(tree, SELF_ACCOUNT_ID);
    expect(field(tree).status).toEqual({text: M.withdraw.send.selfWarning, tone: 'warn'});
    expect(DpayCore.icpAccountIdFromPrincipal).toHaveBeenCalledWith(OISY, '');

    act(() => { tree.unmount(); });
  });
});

describe('SendSheet — the confirm gate while no destination is resolved', () => {
  test('an amount alone cannot arm the send — with the field empty there is nowhere to send it', async () => {
    const tree = await mountSend();
    await typeAmount(tree, '1.00000000');
    expect(field(tree).status).toBeNull();
    expect(confirm(tree).disabled).toBe(true);
    expect(present(tree, 'send-review')).toBe(false);

    await typeAddress(tree, K2); // the same amount, now with a resolved destination
    expect(confirm(tree).disabled).toBe(false);

    act(() => { tree.unmount(); });
  });

  test('a destination still being validated shows NO status line and leaves the button disabled', async () => {
    // The validators are the real base32/CRC parsers, so the verdict lags the keystroke. Until it
    // lands the screen says nothing — a refusal flashed at a half-typed address is a lie, and an
    // armed button would let it be signed against an unresolved destination.
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockImplementation(() => new Promise(() => {}));
    const tree = await mountSend();
    await typeAmount(tree, '1.00000000');
    await typeAddress(tree, K2);
    expect(field(tree).status).toBeNull();
    expect(confirm(tree).disabled).toBe(true);

    act(() => { tree.unmount(); });
  });
});

// --- the PAYMENT TESTED stamp ---------------------------------------------------------------------

describe('SendSheet — a send fills the Trip Readiness PAYMENT TESTED stamp, but only once settled', () => {
  const PREPARED = {
    ledger: VCHF.ledger!, envelopeHex: 'aa'.repeat(64), requestIdHex: 'rr'.repeat(16),
    amount: '100000000', currency: 7, memoHex: 'be'.repeat(16),
  };

  /** Drive Confirm, then give the journey store's fire-and-forget write queue a macrotask to land. */
  async function sendAndReadStamp(tree: renderer.ReactTestRenderer): Promise<boolean> {
    await act(async () => { confirm(tree).onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return hasStamp(await loadJourney(), 'paymentTested');
  }

  async function armedSend() {
    jest.mocked(prepareTransfer).mockResolvedValue(PREPARED);
    const tree = await mountSend();
    await typeAddress(tree, K2);
    await typeAmount(tree, '1.00000000');
    return tree;
  }

  test('a SETTLED transfer stamps it — sending IS a real payment, and for an outbound-only wallet the only one', async () => {
    // Before this, the stamp was reachable only by scanning/tapping: a wallet whose entire money
    // history is sends could never complete the passport, though it had moved real funds.
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '8168'});
    const tree = await armedSend();
    expect(await sendAndReadStamp(tree)).toBe(true);
    expect(textOf(tree, 'send-outcome')).toBe(M.withdraw.send.sent); // it really reached the settled screen
    act(() => { tree.unmount(); });
  });

  test('an UNKNOWN outcome stamps NOTHING — a transfer that may never have executed is not a payment made', async () => {
    // The honest-pending branch: the envelope was submitted but never reached a terminal state in
    // budget. Awarding here would tell the user they had tested paying on the strength of a
    // transfer nobody has confirmed.
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'unknown'});
    const tree = await armedSend();
    expect(await sendAndReadStamp(tree)).toBe(false);
    expect(textOf(tree, 'send-outcome')).toBe(M.withdraw.send.sentUnknown); // the pending screen, not a failure
    act(() => { tree.unmount(); });
  });
});

// The Pay camera can now hand this sheet a destination it read off a QR (defect fixed 2026-08-30 —
// scanning a wallet address used to dead-end on "This isn't a dpay payment code"). The prefill is
// the SAME text a paste would produce, so everything downstream — resolution, route disclosure,
// the Confirm press that is the consent — is unchanged and untested here on purpose.
describe('SendSheet — a destination handed over by the camera', () => {
  test('a prefilled destination is indistinguishable from a pasted one, and is consumed once', async () => {
    // The contract is equivalence, not a special case: the same address must produce the same
    // field value and the same route disclosure whichever way it arrived. Asserting it against a
    // real paste (rather than a hardcoded fee string) is what keeps that true as the copy changes.
    const consumed: number[] = [];
    const scanned = await mountSend({prefillAddress: K2, onPrefillConsumed: () => consumed.push(1)});
    await act(async () => {}); // the prefill's resolution is async, exactly like a keystroke's
    const pasted = await mountSend();
    await typeAddress(pasted, K2);

    expect(field(scanned).value).toBe(field(pasted).value);
    expect(field(scanned).status).toEqual(field(pasted).status);
    expect(consumed).toHaveLength(1); // consumed as taken — a re-render cannot re-apply it
    act(() => { scanned.unmount(); pasted.unmount(); });
  });

  test('a prefill arriving mid-send cannot rewrite the destination', async () => {
    // Guarded on the form phase: the done screen shows the address the user actually confirmed,
    // and a scan landing a moment later must not repaint it as somewhere else.
    jest.mocked(prepareTransfer).mockResolvedValue({ledger: VCHF.ledger, envelopeHex: 'ee', requestIdHex: 'cd', amount: '100000000', currency: 7, memoHex: 'ab'});
    jest.mocked(submitTransfer).mockResolvedValue({kind: 'settled', blockIndex: '9'});
    const tree = await mountSend();
    await typeAddress(tree, K2);
    await typeAmount(tree, '1.0');
    await act(async () => { confirm(tree).onPress(); });
    expect(textOf(tree, 'send-outcome')).toBe(M.withdraw.send.sent);
    act(() => { tree.update(sendElement({prefillAddress: SOL_ADDR})); });
    await act(async () => {});
    expect(textOf(tree, 'send-destination')).toBe(K2);
    act(() => { tree.unmount(); });
  });
});
