/**
 * AtaSetupCard — the wallet-level ONE-TAP token-account setup card (2026-09-30).
 *
 * Pins the founder gap's surface contract: ONE "Complete setup" button that sets up every
 * absent token account; a fund run (a real user spend — a swap pays the SOL) presses through
 * to ONE confirm stating the total before anything executes; a create run executes on the
 * single press (the disclosed cost + the button press are the consent, the same contract the
 * per-asset SolanaAtaSetupCard established); the refusal is the honest dead end (needSol copy,
 * no button); busy states what is being created. Copy is driven by the i18n — the four-locale
 * contract for the NEW keys is pinned in ataSetupCopy.test.ts.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {AtaSetupCard} from '../components/AtaSetupCard';

const COST = '0.00204428 SOL';

function mount(props: Partial<Parameters<typeof AtaSetupCard>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AtaSetupCard
        targets={['EURC']}
        kind="create"
        costLine={COST}
        testIDPrefix="ata-setup-EUR"
        {...props}
      />,
    );
  });
  return tree;
}

const has = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
const press = (tree: renderer.ReactTestRenderer, testID: string) =>
  act(() => { tree.root.findByProps({testID}).props.onPress(); });

describe('AtaSetupCard — the ONE button (create: SOL already covers)', () => {
  test('one press runs the whole setup — no confirm gate on the no-swap path', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'create', onStart});
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(true);
    press(tree, 'ata-setup-EUR-complete');
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the card names every absent account and the total cost, wallet-wide', () => {
    const tree = mount({kind: 'create', targets: ['EURC', 'USDC'], costLine: '0.00408856 SOL'});
    const text = tree.root.findAllByProps({testID: 'ata-setup-EUR-instr'})[0]
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children).join('\n');
    expect(text).toContain('EURC');
    expect(text).toContain('USDC');
    expect(text).toContain('0.00408856 SOL');
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard — the fund run (a swap pays: confirm is REQUIRED)', () => {
  test('the single press does NOT execute — it opens the ONE confirm stating the total', () => {
    const onStart = jest.fn();
    const onConfirm = jest.fn();
    const tree = mount({kind: 'fund', onStart, onConfirm});
    press(tree, 'ata-setup-EUR-complete');
    expect(onStart).toHaveBeenCalledTimes(1); // the parent sizes, then flips confirming
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('confirming shows the total sentence + Confirm/Cancel; only Confirm executes', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const tree = mount({
      kind: 'fund',
      confirming: true,
      confirmLine: 'Swaps about 0.0021 of your USDC into SOL and creates your EURC account (0.00204428 SOL).',
      onConfirm,
      onCancel,
    });
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false); // ONE action at a time
    press(tree, 'ata-setup-EUR-cancel-btn');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    press(tree, 'ata-setup-EUR-confirm-btn');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard — the honest refusal and the busy run', () => {
  test('refuse: the needSol dead end renders, there is NO Complete-setup button', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'refuse', onStart});
    expect(has(tree, 'ata-setup-EUR-need-sol')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-show-sol')).toBe(false); // escape only when the parent shows one
    act(() => { tree.unmount(); });
  });

  test('refuse + escape: the SOL-address affordance renders when the parent provides it', () => {
    const onShowSolAddress = jest.fn();
    const tree = mount({kind: 'refuse', onShowSolAddress});
    expect(has(tree, 'ata-setup-EUR-show-sol')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('busy: the spinner state replaces every control', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'create', busy: true, onStart});
    expect(has(tree, 'ata-setup-EUR-busy')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
