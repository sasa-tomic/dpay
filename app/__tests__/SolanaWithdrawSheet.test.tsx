/**
 * SolanaWithdrawSheet — the USDC needs-SOL fee warning (2026-08-16 UX review finding 13).
 *
 * Sending USDC pays network fees (and a possible recipient-ATA creation) in SOL, so a wallet
 * with a KNOWN-zero SOL balance learns the real constraint up front: `sol-send-needs-sol`
 * renders inside the send form BEFORE any amount is typed. Known-zero only — the branch
 * matrix pins the honest-state contract:
 *   - USDC + solBalance '0' + NOT checking → warning renders (the covered case)
 *   - USDC + SOL still checking            → NO warning (never claim on an unconfirmed state)
 *   - USDC + funded SOL                    → NO warning
 *   - SOL token                            → never (a SOL send needs no second asset)
 *
 * The second contract pinned here is the Trip Readiness PAYMENT TESTED stamp: `sendSol`/`sendSpl`
 * resolve only on a CONFIRMED signature and throw otherwise, so the stamp follows the resolution
 * and never the catch. e2e flow 52 drives the real send end to end but has no read of the journey
 * store, and only a mock can make the broadcast fail on demand.
 *
 * Uses react-test-renderer (the project's only renderer; no @testing-library). The sheet mounts
 * hooks (useEscapeToClose, useCopyFeedback) which are no-ops under jest — no stubs needed;
 * `identity` is only read inside confirm(), so a dummy seed renders safely with no network. The
 * Solana rail itself is mocked at its module boundary (the RPC is unreachable offline); the address
 * validator is NOT — the destination below is a real base58 Solana address.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../solana', () => ({
  sendSol: jest.fn(),
  sendSpl: jest.fn(),
  // The unknown terminal's Check status read (read-only, never re-signs) — armed per test below.
  getSolSignatureStatus: jest.fn(),
  // The sheet warms the lazily-loaded network module at mount (the 2026-09-21 engine-load fix);
  // a no-op here — this suite owns the seam's behavior, not the module load.
  preloadSolanaRpc: () => {},
}));

import {sendSol, sendSpl, getSolSignatureStatus} from '../solana';
import {deriveSolanaAddress} from '../solana/identity';
import {hasStamp, loadJourney} from '../lib/journey';
import {loadAddressBook} from '../services/addressBook';
import {SolanaWithdrawSheet} from '../components/SolanaWithdrawSheet';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const IDENT: Identity = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};
const SOL_DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // the journey store is global — a stamp must not leak across tests
});

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

async function mount(props: Partial<Parameters<typeof SolanaWithdrawSheet>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SolanaWithdrawSheet
        identity={IDENT}
        token="USDC"
        balance="2500000"
        onSent={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

describe('SolanaWithdrawSheet — sol-send-needs-sol (USDC fees are paid in SOL)', () => {
  test('USDC + known-zero SOL (not checking) → the fee warning renders inside the form', async () => {
    const tree = await mount({solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(true);
    expect(has(tree, 'sol-send-address-input')).toBe(true); // the form itself stays intact
    act(() => { tree.unmount(); });
  });

  test('USDC + SOL still checking → NO warning (never claim insufficiency on an unconfirmed state)', async () => {
    const tree = await mount({solBalance: '0', solChecking: true});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('USDC + funded SOL → NO warning', async () => {
    const tree = await mount({solBalance: '2044280', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('SOL token → never the USDC fee warning', async () => {
    const tree = await mount({token: 'SOL', balance: '2044280', solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaWithdrawSheet — stale-ok balance gating (2026-09-21 live EURC attempt #7)', () => {
  /** Fill destination + amount and return the confirm control's disabled state. */
  async function fill(tree: renderer.ReactTestRenderer, amount: string): Promise<{disabled: boolean; aria: boolean}> {
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText(amount);
    });
    const btn = tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props;
    return {disabled: btn.disabled as boolean, aria: (btn.accessibilityState as {disabled: boolean}).disabled};
  }

  test('amount ≤ LAST-KNOWN balance → confirm ENABLED (no fresh-poll demand; the attempt-#7 case: 8.8 ≤ 9.28 EURC)', async () => {
    const tree = await mount({token: 'EURC', balance: '9280000'}); // 9.28 EURC last-known
    const st = await fill(tree, '8.8');
    expect(st.disabled).toBe(false);
    expect(st.aria).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('amount > LAST-KNOWN balance → still gated, warned against the real figure, and a press submits nothing', async () => {
    const tree = await mount({token: 'EURC', balance: '9280000'});
    const st = await fill(tree, '9.5'); // 9.5 > 9.28
    expect(st.disabled).toBe(true);
    expect(st.aria).toBe(true);
    expect(has(tree, 'sol-send-review')).toBe(true); // the review renders — gated, not hidden
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    expect(sendSpl).not.toHaveBeenCalled(); // the blind press is refused
    act(() => { tree.unmount(); });
  });

  test('balance NEVER known (null) → still gated (an honest unknown never enables a blind send) and no fabricated "Available: 0"', async () => {
    const tree = await mount({token: 'EURC', balance: null});
    const st = await fill(tree, '0.5');
    expect(st.disabled).toBe(true);
    expect(st.aria).toBe(true);
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    expect(sendSpl).not.toHaveBeenCalled();
    // The available line must NOT claim a zero the wallet never read.
    const texts = tree.root.findAll(n => n.props && n.props.testID === undefined && typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(texts.some(t => t.startsWith('Available:'))).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a rendered review reports up ONCE (sticky) — the parent’s offline strike gate then defers', async () => {
    const onReviewShown = jest.fn();
    const tree = await mount({balance: '9280000', onReviewShown});
    expect(onReviewShown).not.toHaveBeenCalled(); // empty form: no review, no report
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('8.8');
    });
    expect(onReviewShown).toHaveBeenCalledTimes(1);
    expect(onReviewShown).toHaveBeenCalledWith(true);
    // More typing keeps the review up; the report stays a once-per-mount latch.
    await act(async () => { tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('8.9'); });
    expect(onReviewShown).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('offline (poll strike-flip) with the review up → the in-sheet notice renders, the form is untouched', async () => {
    const tree = await mount({balance: '9280000', online: false});
    await fill(tree, '8.8');
    expect(has(tree, 'sol-send-offline-note')).toBe(true);
    expect(has(tree, 'sol-send-review')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('online → no offline note', async () => {
    const tree = await mount({balance: '9280000', online: true});
    expect(has(tree, 'sol-send-offline-note')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaWithdrawSheet — the PAYMENT TESTED stamp follows the CONFIRMED signature', () => {
  /** Fill the form, press Send, then give the journey store's write queue a macrotask to land. */
  async function sendAndReadStamp(tree: renderer.ReactTestRenderer): Promise<boolean> {
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
    });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    return hasStamp(await loadJourney(), 'paymentTested');
  }

  test('a confirmed SOL transfer stamps it — the device-key rail earns the same stamp as the IC rails', async () => {
    // Rail parity (CLAUDE.md hard rule): the passport must not depend on which rail moved the money.
    jest.mocked(sendSol).mockResolvedValue('5ig'.repeat(10));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    expect(await sendAndReadStamp(tree)).toBe(true);
    expect(has(tree, 'sol-send-signature')).toBe(true); // it really reached the confirmed screen
    act(() => { tree.unmount(); });
  });

  test('a broadcast that never confirmed stamps NOTHING — the error screen is not a payment made', async () => {
    // sendSol rejects on an RPC failure, an on-chain failure, and a confirmation timeout alike, so
    // this one catch is every unconfirmed outcome the rail has.
    jest.mocked(sendSol).mockRejectedValue(new Error('solana confirmation timeout'));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    expect(await sendAndReadStamp(tree)).toBe(false);
    expect(has(tree, 'sol-send-err')).toBe(true);
    act(() => { tree.unmount(); });
  });
});

// Rail parity for the destination field (2026-08-30). This sheet used to own a bare TextInput whose
// only verdict was "not a valid Solana address" — it could not tell a typo from a Bitcoin address
// pasted into the wrong wallet, and it had neither the scanner nor the address book the IC surface
// already had. It now runs the SHARED AddressField over the shared destination classifier, so both
// rails refuse in the same words. `destination.test.ts` pins the policy table; these pin what this
// sheet does with it.
describe('SolanaWithdrawSheet — the shared destination field', () => {
  /** The AddressField double is the real component; `status` is this sheet's verdict about the text. */
  const fieldOf = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({testIDPrefix: 'sol-send'}).props;

  async function type(tree: renderer.ReactTestRenderer, text: string) {
    await act(async () => { tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(text); });
  }

  test.each([
    ['a Bitcoin address', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'Bitcoin'],
    ['an Ethereum address', '0x2D39863d5A1E1B1e8b7b0b8c7c9d0e1f2a3b4c5d', 'Ethereum'],
    ['an Internet Computer principal', 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae', 'Internet Computer'],
  ])('%s is refused BY NAME — a wrong-chain paste is the dangerous mistake, so it gets named', async (_label, addr, chain) => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, addr);
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.refuseWrongChain(chain, 'SOL', 'Solana'), tone: 'bad'}});
    expect(tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a valid Solana address discloses the route BEFORE an amount is entered', async () => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST);
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.routeSolana('Solana'), tone: 'ok'}});
    act(() => { tree.unmount(); });
  });

  test('the wallet\'s OWN address warns without blocking — a self-send is legal, just pointless', async () => {
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, deriveSolanaAddress(IDENT.secretHex));
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.send.selfWarning, tone: 'warn'}});
    act(() => { tree.unmount(); });
  });

  test('base58 text that is not a valid address is refused as a Solana problem, not a wrong chain', async () => {
    // Shape says base58, so the route is right and only the rail's own parser can reject it. The
    // two stages produce two different messages on purpose — "you pasted the wrong thing" and
    // "you pasted this thing wrong" need different fixes from the user.
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST.slice(0, 33)); // right shape (33 base58 chars), decodes to 24 bytes
    expect(fieldOf(tree)).toMatchObject({status: {text: M.withdraw.badAddress('Solana'), tone: 'bad'}});
    act(() => { tree.unmount(); });
  });

  test('a confirmed send remembers the destination — the address book the IC rail already had', async () => {
    jest.mocked(sendSol).mockResolvedValue('5ig'.repeat(10));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await type(tree, SOL_DEST);
    await act(async () => { tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5'); });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    // Per-token key: SOL and USDC go to the same KIND of address but to different people.
    expect(await loadAddressBook('sol:SOL')).toMatchObject([{address: SOL_DEST}]);
    expect(await loadAddressBook('sol:USDC')).toEqual([]);
    act(() => { tree.unmount(); });
  });
});

// ============================================================================
// The honest outcome split (2026-09-21, the EURC send-sheet hang). A send that
// outlives SOL_SEND_TIMEOUT used to have only two endings on this sheet — spinner
// forever (the live bug) or a generic error that invites a resend (a double-pay
// risk over a transfer that MAY still land). The seam now guarantees the promise
// settles by the deadline and hands over the broadcast signature, and the sheet
// splits the catch three ways: not-sent → error; accepted-but-unconfirmed → the
// honest "may still land" panel with the signature kept; on-chain failure → error.
// ============================================================================
describe('SolanaWithdrawSheet — the honest unknown outcome (accepted send, missed confirmation)', () => {
  const SIG = '5ig'.repeat(10);

  async function press(tree: renderer.ReactTestRenderer) {
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
    });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }

  test('a deadline abort AFTER the broadcast lands on the unknown panel — signature kept, no error line', async () => {
    // The exact shape the real seam produces at SOL_SEND_TIMEOUT: onBroadcast fired (the network
    // ACCEPTED), then the deadline cut the confirmation wait.
    jest.mocked(sendSol).mockImplementation((_seed, _dest, _amt, _signal, onBroadcast) => {
      onBroadcast?.(SIG);
      return Promise.reject(new Error('sol send aborted (deadline)'));
    });
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await press(tree);
    expect(has(tree, 'sol-send-unknown-title')).toBe(true);
    expect(has(tree, 'sol-send-unknown-note')).toBe(true);
    expect(has(tree, 'sol-send-signature')).toBe(true);
    expect(has(tree, 'sol-send-err')).toBe(false); // an unknown is NOT a failed send
    act(() => { tree.unmount(); });
  });

  test('a broadcast-time refusal (the 200-with-error-body shape) is an ERROR with the venue\'s own message — never the unknown panel', async () => {
    // Helius's rejection rides HTTP 200 with a JSON-RPC error body; the seam throws it as a
    // refusal BEFORE anything is accepted (no onBroadcast), so nothing can land and "resend"
    // is the correct affordance.
    const venueMessage = 'solana rpc: invalid request: error decoding base64 of transaction';
    jest.mocked(sendSol).mockRejectedValue(new Error(venueMessage));
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await press(tree);
    expect(has(tree, 'sol-send-err')).toBe(true);
    expect(tree.root.findByProps({testID: 'sol-send-err'}).props.children).toContain('error decoding base64');
    expect(has(tree, 'sol-send-unknown-title')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('an on-chain failure AFTER the broadcast is an ERROR (definitive — nothing moved but the fee), not unknown', async () => {
    jest.mocked(sendSol).mockImplementation((_seed, _dest, _amt, _signal, onBroadcast) => {
      onBroadcast?.(SIG);
      return Promise.reject(new Error('transaction failed: {"InstructionError":[0,{"Custom":1}]}'));
    });
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await press(tree);
    expect(has(tree, 'sol-send-err')).toBe(true);
    expect(has(tree, 'sol-send-unknown-title')).toBe(false);
    expect(has(tree, 'sol-send-signature')).toBe(false); // no honest-kept signature: the tx is DEFINITELY dead
    act(() => { tree.unmount(); });
  });

  test('the happy path is unchanged: a confirmed send renders the done panel and no unknown chrome', async () => {
    jest.mocked(sendSol).mockResolvedValue(SIG);
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    await press(tree);
    expect(has(tree, 'sol-send-outcome')).toBe(true);
    expect(has(tree, 'sol-send-signature')).toBe(true);
    expect(has(tree, 'sol-send-unknown-title')).toBe(false);
    expect(has(tree, 'sol-send-err')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

// ============================================================================
// The terminal surface's pins (2026-09 stream D). (a) the deadline-over-accepted-broadcast
// unknown (above, kept); (d) the Check-status resolution matrix — the one read that may resolve
// an unknown, and it may never re-sign; (e) the no-re-arm invariant: the unknown terminal offers
// NO send control, so a second 60s deadline can never be armed over an unresolved send.
// ============================================================================
describe('SolanaWithdrawSheet — the unknown terminal: Check status + no-re-send invariant', () => {
  const SIG = '5ig'.repeat(10);

  /** Mount, send with the deadline firing over an ACCEPTED broadcast (the unknown panel), and
   *  return the tree — the state every Check-status press starts from. */
  async function sendToUnknown(props: Partial<Parameters<typeof SolanaWithdrawSheet>[0]> = {}) {
    jest.mocked(sendSol).mockImplementation((_seed, _dest, _amt, _signal, onBroadcast) => {
      onBroadcast?.(SIG);
      return Promise.reject(new Error('sol send aborted (deadline)'));
    });
    const tree = await mount({token: 'SOL', balance: '2000000000', ...props});
    await act(async () => {
      tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
      tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
    });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(has(tree, 'sol-send-unknown-title')).toBe(true);
    return tree;
  }

  const checkButton = (tree: renderer.ReactTestRenderer) => tree.root.findByProps({testID: 'btn-sol-send-check'}).props;

  test('(d) status confirmed → the panel flips SETTLED (Sent ✓), never re-signs', async () => {
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed', err: null});
    const tree = await sendToUnknown();
    await act(async () => { await checkButton(tree).onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(has(tree, 'sol-send-outcome')).toBe(true);
    expect(has(tree, 'sol-send-unknown-title')).toBe(false);
    expect(jest.mocked(sendSol)).toHaveBeenCalledTimes(1); // the read resolved it; nothing re-signed
    act(() => { tree.unmount(); });
  });

  test('(d) status err → the terminal FAILED panel: fee-only truth, signature kept as proof, no resend', async () => {
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed', err: {InstructionError: [0, {Custom: 1}]}});
    const tree = await sendToUnknown();
    await act(async () => { await checkButton(tree).onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(has(tree, 'sol-send-failed-title')).toBe(true);
    expect(tree.root.findByProps({testID: 'sol-send-failed-note'}).props.children).toBe(M.withdraw.send.feeOnly);
    expect(has(tree, 'sol-send-signature')).toBe(true); // the proof stays checkable
    expect(has(tree, 'btn-sol-send-confirm')).toBe(false); // no resend control on a terminal failure
    expect(jest.mocked(sendSol)).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('(d) status null (the cluster never heard of it) → the honest pending stays, unchanged', async () => {
    jest.mocked(getSolSignatureStatus).mockResolvedValue(null);
    const tree = await sendToUnknown();
    await act(async () => { await checkButton(tree).onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(has(tree, 'sol-send-unknown-title')).toBe(true);
    expect(has(tree, 'sol-send-unknown-note')).toBe(true);
    expect(has(tree, 'sol-send-failed-title')).toBe(false);
    expect(has(tree, 'sol-send-outcome')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('(d) a check that cannot complete (rail unreachable) says so — the pending STAYS, never a verdict', async () => {
    jest.mocked(getSolSignatureStatus).mockRejectedValue(new Error(M.errors.solana.offline));
    const tree = await sendToUnknown();
    await act(async () => { await checkButton(tree).onPress(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(tree.root.findByProps({testID: 'sol-send-check-err'}).props.children).toBe(M.withdraw.send.checkFailed);
    expect(has(tree, 'sol-send-unknown-title')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('(e) the unknown terminal arms NO second deadline: no send control, only read/copy/done', async () => {
    jest.mocked(getSolSignatureStatus).mockResolvedValue(null);
    const tree = await sendToUnknown();
    // THE INVARIANT: with a signature accepted and unresolved, the only controls are the copy,
    // the read-only check and Done. Confirm is gone — pressing anything on this panel can never
    // re-enter confirm() and arm a second withTimeout over the same unresolved transfer.
    expect(has(tree, 'btn-sol-send-confirm')).toBe(false);
    await act(async () => { await checkButton(tree).onPress(); }); // the read
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-copy'}).props.onPress(); });
    await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-done'}).props.onPress(); });
    expect(jest.mocked(sendSol)).toHaveBeenCalledTimes(1); // one send, one deadline, whole story
    act(() => { tree.unmount(); });
  });

  test('(e) a fresh send after an ERROR re-arms exactly one deadline per press', async () => {
    // The error phase is the ONLY place a new send is consented. Each press drives exactly one
    // send chain (one withTimeout arm); two presses, two chains — never two timers for one.
    let calls = 0;
    jest.mocked(sendSol).mockImplementation(() => { calls += 1; throw new Error('solana rpc: HTTP 503'); });
    const tree = await mount({token: 'SOL', balance: '2000000000'});
    const pressSend = async () => {
      await act(async () => {
        tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(SOL_DEST);
        tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText('0.5');
      });
      await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
      await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    };
    await pressSend();
    await pressSend();
    expect(calls).toBe(2); // each error retry was one fresh, single-armed chain
    expect(has(tree, 'sol-send-nothing-sent')).toBe(true); // the nothing-was-sent guidance
    expect(has(tree, 'sol-send-fee-note')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
