/**
 * AddFundsMenu — the deposit-vs-buy choice behind ONE Add-funds action row (plan R1 step 3, §8
 * item 1 recommendation). Pins:
 *
 *   • TWO rows and nothing else: the plain deposit route first, then the named-provider buy
 *     ("Mt Pelerin" verbatim in the label - a company name is not a message; no "best", no
 *     highlight).
 *   • Deposit hands off to the deposit route; Buy hands off to the buy route; each press closes
 *     through the owner (the rows call the owner's handlers, the owner flips its state).
 *   • The close affordance and the backdrop share ONE dismissal path.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {AddFundsMenu} from '../components/AddFundsMenu';
import {S} from '../styles';
import {M} from '../i18n';

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  return node.findAllByType(Text).map(t => String(t.props.children ?? '')).join('');
}

function press(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(n => n.props && n.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

function mount(onDeposit: () => void, onBuy: () => void, onClose: () => void) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<AddFundsMenu onDeposit={onDeposit} onBuy={onBuy} onClose={onClose} />);
  });
  return tree;
}

describe('AddFundsMenu — the deposit-vs-buy choice', () => {
  test('two rows: the plain deposit and the named-provider buy; no ranking copy', () => {
    const tree = mount(jest.fn(), jest.fn(), jest.fn());
    expect(has(tree, 'btn-add-funds-deposit')).toBe(true);
    expect(has(tree, 'btn-add-funds-buy')).toBe(true);
    expect(textOf(tree, 'btn-add-funds-deposit')).toBe(M.deposit.mtp.chooserDeposit);
    expect(textOf(tree, 'btn-add-funds-buy')).toBe(M.deposit.mtp.entryLabel);
    expect(textOf(tree, 'btn-add-funds-buy')).toContain('Mt Pelerin');
    expect(textOf(tree, 'btn-add-funds-buy')).not.toMatch(/\bbest\b/i);
    act(() => { tree.unmount(); });
  });

  test('deposit routes to the deposit hand-off, buy to the buy hand-off; closing is the owner\'s job', () => {
    const onDeposit = jest.fn();
    const onBuy = jest.fn();
    const onClose = jest.fn();
    const tree = mount(onDeposit, onBuy, onClose);
    press(tree, 'btn-add-funds-deposit');
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onBuy).not.toHaveBeenCalled();
    // The rows hand off only; the OWNER closes (Wallet flips its state in the same handler).
    expect(onClose).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });

    const tree2 = mount(onDeposit, onBuy, onClose);
    press(tree2, 'btn-add-funds-buy');
    expect(onBuy).toHaveBeenCalledTimes(1);
    expect(onDeposit).toHaveBeenCalledTimes(1); // unchanged from the first press
    expect(onClose).not.toHaveBeenCalled();
    act(() => { tree2.unmount(); });
  });

  test('the explicit close affordance and the backdrop share the dismissal', () => {
    const onClose = jest.fn();
    const tree = mount(jest.fn(), jest.fn(), onClose);
    press(tree, 'btn-add-funds-close');
    expect(onClose).toHaveBeenCalledTimes(1);
    // The backdrop is the full-bleed Pressable behind the card - one dismissal path for both.
    const backdrop = tree.root.find(n => n.props?.style === S.pickBackdrop);
    act(() => { (backdrop.props as {onPress: () => void}).onPress(); });
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => { tree.unmount(); });
  });

  // The 2026-10-15 visibility defect's menu-side half: a choice menu that opens with only
  // "Deposit" is the bug wearing a disguise - the surface exists, buy renders nowhere. The
  // eligibility gate must live in exactly ONE place (the mounting Wallet, on funding.ts's
  // catalog-level `mtpBuyOfferOf`); NOTHING inside the menu may hide the buy row again.
  test('the buy row is UNCONDITIONAL: both rows always render together, deposit first', () => {
    const tree = mount(jest.fn(), jest.fn(), jest.fn());
    expect(has(tree, 'btn-add-funds-deposit')).toBe(true);
    expect(has(tree, 'btn-add-funds-buy')).toBe(true);
    const rows = tree.root.findAllByType(Text).map(n => String(n.props.children ?? ''));
    expect(rows.indexOf(M.deposit.mtp.chooserDeposit)).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(M.deposit.mtp.entryLabel)).toBeGreaterThan(rows.indexOf(M.deposit.mtp.chooserDeposit));
    act(() => { tree.unmount(); });
  });
});
