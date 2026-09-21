/**
 * SolPayMode ▸ SolanaWithdrawSheet — the live EURC→ICP funding-drive attempt #7 signature,
 * reproduced against the REAL sheet (2026-09-21) and pinned with both halves of the fix:
 *
 *   1. STALE-OK BALANCE GATING. The wallet held 9.28 EURC (last known) and the review asked to
 *      send 8.8 EURC. Every balance poll aborted ("balance poll failed: signal is aborted
 *      without reason" — the relay's IC-boundary reads timing out at 5000 ms), the 3-strike
 *      rule flipped `online` false, and the sheet received a coerced '0' balance — so
 *      `overBalance` was true against zero and `canReview` stayed false across FOUR presses.
 *      The fix: the sheet receives the LAST-KNOWN balance (null only when nothing was ever
 *      known) and gates WITHOUT demanding a fresh poll — known + amount ≤ known enables.
 *
 *   2. SURFACE OWNERSHIP FOR THE OFFLINE GATE. The same strike flip then REPLACED the open
 *      sheet body mid-review with "Sending to an address needs a connection", destroying the
 *      review surface the user was mid-flow on. The fix: once the sheet has rendered its
 *      review (onReviewShown), the gate defers and offline may only show a notice INSIDE the
 *      sheet; a genuinely-offline send fails honestly at broadcast (no funds move until the
 *      network accepts — the architecture's own safe failure).
 *
 * The polls themselves are App-level (useBalancePoll / useSolanaBalances); this test mounts the
 * surface those polls feed and reproduces their OBSERVED outcome exactly: `online=false` (the
 * 3-strike flip) beside a last-known token balance. The Solana rail is mocked at its module
 * boundary (no test reaches an RPC); the address validator is REAL — the destination is a
 * genuine base58 Solana address. SolPayMode mounts with its real SolanaWithdrawSheet child (the
 * SolPayMode suite stubs that child; this suite is precisely about the real one).
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

jest.mock('../components/QrScanner', () => ({
  QrScanner: () => null,
}));
jest.mock('../components/SolNfcTap', () => ({
  SolNfcTap: () => null,
}));
jest.mock('../services/native', () => ({
  DpaySolNfc: {},
}));
jest.mock('../solana', () => ({
  sendSol: jest.fn(),
  sendSpl: jest.fn(),
  // The sheet warms the lazily-loaded network module at mount — a no-op here.
  preloadSolanaRpc: () => {},
}));

import {sendSpl} from '../solana';
import {SolPayMode} from '../components/SolPayMode';
import type {Identity} from '../lib/types';

const IDENT: Identity = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};
const SOL_DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// The attempt-#7 figures, in raw units at EURC's 6 decimals: the review asked for 8.8 EURC
// against a last-KNOWN 9.28 EURC.
const LAST_KNOWN_EURC_RAW = '9280000';
const REVIEW_EURC_AMOUNT = '8.8';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(sendSpl).mockResolvedValue('e2e-confirmed-signature');
});

function element(overrides: Partial<Parameters<typeof SolPayMode>[0]> = {}) {
  return (
    <SolPayMode
      identity={IDENT}
      online={true} // the form opens while the polls still answer — as on the live run
      nfcStatus="off"
      assets={[]}
      catalog={[]}
      homeCurrency={null}
      balances={{}}
      solBalance="500000000"
      tokenBalance={LAST_KNOWN_EURC_RAW}
      tokenAtaAbsent={false}
      tokenBalances={{}}
      payGate="none"
      selectedToken="EURC"
      onSent={() => {}}
      onSentToken={() => {}}
      onShowSolAddress={() => {}}
      onShowTokenAddress={() => {}}
      onRecheckBalances={() => {}}
      subMode="send"
      onSubModeChange={() => {}}
      onScannedLink={() => {}}
      {...overrides}
    />
  );
}

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function byTestID(tree: renderer.ReactTestRenderer, testID: string): {props: Record<string, unknown>} {
  return tree.root.findAll(node => node.props && node.props.testID === testID)[0] as unknown as {props: Record<string, unknown>};
}

async function fillReview(tree: renderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    (byTestID(tree, 'sol-send-address-input').props as {onChangeText: (t: string) => void}).onChangeText(SOL_DEST);
    (byTestID(tree, 'sol-send-amount-input').props as {onChangeText: (t: string) => void}).onChangeText(REVIEW_EURC_AMOUNT);
  });
}

describe('attempt #7 — a rendered review must be able to complete', () => {
  test('polls die (3-strike → offline) AFTER the review is up: sheet stays, review stays interactive, confirm ENABLED against the last-known balance', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(element()); });
    expect(has(tree, 'sol-send-address-input')).toBe(true); // the form is up while online

    await fillReview(tree);
    expect(has(tree, 'sol-send-review')).toBe(true); // the fully rendered review (amount + destination + route)

    // The balance polls now abort every tick; the 3-strike rule flips `online` false.
    await act(async () => { tree.update(element({online: false})); });

    // HALF 2 — surface ownership: the sheet body was NOT replaced by the offline panel.
    expect(has(tree, 'sol-send-offline')).toBe(false);           // no "Sending to an address needs a connection" teardown
    expect(has(tree, 'sol-send-review')).toBe(true);             // the review surface survives
    expect(has(tree, 'sol-send-address-input')).toBe(true);      // still interactive
    // …and offline speaks INSIDE the sheet instead:
    expect(has(tree, 'sol-send-offline-note')).toBe(true);

    // HALF 1 — stale-ok gating: 8.8 ≤ 9.28 last-known → the confirm is ENABLED without a fresh
    // poll (the attempt-#7 signature was exactly this button stuck aria-disabled).
    const confirm = byTestID(tree, 'btn-sol-send-confirm').props as {disabled: boolean; accessibilityState: {disabled: boolean}};
    expect(confirm.disabled).toBe(false);
    expect(confirm.accessibilityState.disabled).toBe(false);

    // The press submits — and the four blind presses of the live run cannot duplicate it: after
    // the first submit the sheet is off the form, and the button is gone from the tree.
    await act(async () => { await (byTestID(tree, 'btn-sol-send-confirm').props as {onPress: () => Promise<void>}).onPress(); });
    expect(sendSpl).toHaveBeenCalledTimes(1);
    expect(has(tree, 'sol-send-outcome')).toBe(true); // the terminal surface got its moment
    expect(has(tree, 'btn-sol-send-confirm')).toBe(false);
    await act(async () => { tree.unmount(); });
  });

  test('offline BEFORE any review: the gate still applies to the bare form (flow 110 unchanged)', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(element({online: false})); });
    // Nothing was ever filled — the sheet never rendered a review — so the honest
    // "needs a connection" instruction owns the surface, exactly as flow 110 pins it.
    expect(has(tree, 'sol-send-offline')).toBe(true);
    expect(has(tree, 'sol-send-address-input')).toBe(false);
    await act(async () => { tree.unmount(); });
  });
});
