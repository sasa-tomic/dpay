/**
 * AtaSetupCard - the wallet-level ONE-TAP token-account setup card (2026-09-30, banner
 * redesign).
 *
 * Pins the founder gap's surface contract: ONE compact banner with ONE "Complete setup" button
 * that sets up every absent token account; a swap run (a real user spend) presses through to
 * ONE confirm stating the total before anything executes (fund and fund-ic alike); a create run
 * executes on the single press (the disclosed cost + the button press are the consent, the same
 * contract the per-asset SolanaAtaSetupCard established); the refusal is the honest dead end
 * (needSol copy, the SOL receive address with a copy affordance, NO button); busy states what
 * is happening (creating, or the still-in-flight venue swap). Copy is driven by the i18n - the
 * four-locale contract for the keys is pinned in ataSetupCopy.test.ts.
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
const textOf = (tree: renderer.ReactTestRenderer, testID: string): string =>
  tree.root.findAll(node => node.props && node.props.testID === testID)[0]!
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children).join('\n');

describe('AtaSetupCard — the ONE button (create: SOL already covers)', () => {
  test('the compact banner carries the ONE press - no confirm gate on the no-swap path', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'create', onStart});
    expect(has(tree, 'ata-setup-EUR-banner')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(true);
    press(tree, 'ata-setup-EUR-complete');
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('the compact summary names the accounts and the cost, ONE line, no duplicated text', () => {
    const tree = mount({kind: 'create', targets: ['EURC', 'USDC'], costLine: '0.00408856 SOL'});
    const banner = textOf(tree, 'ata-setup-EUR-banner');
    expect(banner).toContain('EURC');
    expect(banner).toContain('USDC');
    expect(banner).toContain('0.00408856 SOL');
    act(() => { tree.unmount(); });
  });

  test('expanded shows the per-asset detail lines; collapsed does not', () => {
    const tree = mount({kind: 'create', targets: ['EURC', 'USDC'], expanded: false});
    expect(textOf(tree, 'ata-setup-EUR-banner')).not.toContain('No EURC account');
    act(() => { tree.unmount(); });
    const open = mount({kind: 'create', targets: ['EURC', 'USDC'], expanded: true});
    expect(textOf(open, 'ata-setup-EUR-banner')).toContain('No EURC account');
    act(() => { open.unmount(); });
  });

  test('tapping the summary row toggles expansion (the parent owns the state)', () => {
    const onToggleExpanded = jest.fn();
    const tree = mount({kind: 'create', expanded: false, onToggleExpanded});
    press(tree, 'ata-setup-EUR-summary');
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard - the swap runs (fund and fund-ic: confirm is REQUIRED)', () => {
  test('the single press does NOT execute — it opens the ONE confirm stating the total', () => {
    for (const kind of ['fund', 'fund-ic'] as const) {
      const onStart = jest.fn();
      const onConfirm = jest.fn();
      const tree = mount({kind, onStart, onConfirm});
      press(tree, 'ata-setup-EUR-complete');
      expect(onStart).toHaveBeenCalledTimes(1); // the parent sizes, then flips confirming
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => { tree.unmount(); });
    }
  });

  test('confirming shows the total sentence + Confirm/Cancel; only Confirm executes', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const tree = mount({
      kind: 'fund-ic',
      confirming: true,
      confirmLine: 'Swaps about 5 USDC of your ckUSDC into SOL and creates your EURC account (0.00204428 SOL).',
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

describe('AtaSetupCard - the up-front minimum line (2026-10-01 founder directive)', () => {
  test('a measured minimum REPLACES the rent line - ONE cost line, stated before anything runs', () => {
    const tree = mount({kind: 'fund-ic', minLine: 'Needs at least 0.09 VCHF.'});
    const banner = textOf(tree, 'ata-setup-EUR-banner');
    expect(banner).toContain('at least 0.09 VCHF');
    expect(banner).not.toContain('Costs 0.00204428 SOL');
    act(() => { tree.unmount(); });
  });

  test('without a measurement the idle line stays the exact SOL rent', () => {
    const tree = mount({kind: 'fund-ic'});
    expect(textOf(tree, 'ata-setup-EUR-banner')).toContain('Costs 0.00204428 SOL');
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard - the honest refusal and the busy runs', () => {
  test('refuse: the needSol dead end renders, there is NO Complete-setup button', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'refuse', onStart});
    expect(has(tree, 'ata-setup-EUR-refuse')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-need-sol')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-show-sol')).toBe(false); // escape only when the parent shows one
    act(() => { tree.unmount(); });
  });

  test('refuse + address: the receive address renders inline with the copy affordance', () => {
    const onCopySolAddress = jest.fn();
    const tree = mount({kind: 'refuse', solAddress: 'DpaySoLAddress11111111111111111111111111', onCopySolAddress});
    expect(has(tree, 'ata-setup-EUR-sol-addr')).toBe(true);
    expect(textOf(tree, 'ata-setup-EUR-sol-addr')).toContain('DpaySoLAddress11111111111111111111111111');
    expect(has(tree, 'ata-setup-EUR-copy-sol')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-show-sol')).toBe(false);
    act(() => { press(tree, 'ata-setup-EUR-copy-sol'); });
    expect(onCopySolAddress).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });

  test('refuse + copied: the copy control speaks its state', () => {
    const tree = mount({kind: 'refuse', solAddress: 'Addr', onCopySolAddress: jest.fn(), solCopied: true});
    expect(textOf(tree, 'ata-setup-EUR-copy-sol')).toContain('Copied');
    act(() => { tree.unmount(); });
  });

  test('refuse without an inline address: the deposit-sheet escape stays reachable', () => {
    const onShowSolAddress = jest.fn();
    const tree = mount({kind: 'refuse', onShowSolAddress});
    expect(has(tree, 'ata-setup-EUR-show-sol')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('busy: the spinner state replaces every control (the default creating line)', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'create', busy: true, onStart});
    expect(has(tree, 'ata-setup-EUR-busy')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    expect(textOf(tree, 'ata-setup-EUR-busy')).toContain('EURC');
    act(() => { tree.unmount(); });
  });

  test('busy + a fund-ic venue swap in flight: the honest swap-pending line replaces creating', () => {
    const tree = mount({kind: 'fund-ic', busy: true, busyLine: 'Swapping into SOL. Your EURC account are created as soon as it lands.'});
    const line = textOf(tree, 'ata-setup-EUR-busy');
    expect(line).toContain('Swapping into SOL');
    expect(line).not.toContain('Creating');
    act(() => { tree.unmount(); });
  });
});
