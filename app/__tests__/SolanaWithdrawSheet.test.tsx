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
 * Uses react-test-renderer (the project's only renderer; no @testing-library). The sheet mounts
 * hooks (useEscapeToClose, useCopyFeedback) which are no-ops under jest — no stubs needed;
 * `identity` is only read inside confirm(), so a dummy seed renders safely with no network.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SolanaWithdrawSheet} from '../components/SolanaWithdrawSheet';
import type {Identity} from '../lib/types';

const IDENT: Identity = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function mount(props: Partial<Parameters<typeof SolanaWithdrawSheet>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
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
  test('USDC + known-zero SOL (not checking) → the fee warning renders inside the form', () => {
    const tree = mount({solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(true);
    expect(has(tree, 'sol-send-address-input')).toBe(true); // the form itself stays intact
    act(() => { tree.unmount(); });
  });

  test('USDC + SOL still checking → NO warning (never claim insufficiency on an unconfirmed state)', () => {
    const tree = mount({solBalance: '0', solChecking: true});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('USDC + funded SOL → NO warning', () => {
    const tree = mount({solBalance: '2044280', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('SOL token → never the USDC fee warning', () => {
    const tree = mount({token: 'SOL', balance: '2044280', solBalance: '0', solChecking: false});
    expect(has(tree, 'sol-send-needs-sol')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
