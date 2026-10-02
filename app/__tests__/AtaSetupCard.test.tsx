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
import {M} from '../i18n';

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

  test('the per-asset detail lines are gone: the title and the cost carry the facts', () => {
    // 2026-10-02 audit: 'No EURC account on this device yet.' restated the title's target list
    // line for line. The card states WHO and WHAT IT COSTS; the per-asset prose is deleted.
    const tree = mount({kind: 'create', targets: ['EURC', 'USDC'], costLine: '0.00408856 SOL'});
    expect(textOf(tree, 'ata-setup-EUR-banner')).not.toContain('No EURC account');
    expect(textOf(tree, 'ata-setup-EUR-banner')).not.toContain('No USDC account');
    act(() => { tree.unmount(); });
  });

  test('the create-kind card names its payer (the SOL balance)', () => {
    const tree = mount({kind: 'create', targets: ['EURC', 'USDC'], costLine: '0.00408856 SOL'});
    expect(textOf(tree, 'ata-setup-EUR-banner')).toContain('SOL');
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

  test('refuse renders the REAL cause line (2026-10-02: a confirm-time failure may never render cause-less)', () => {
    const tree = mount({kind: 'refuse', err: 'Even all your VCHF doesn\'t cover it - receive a little SOL at your address instead.'});
    expect(has(tree, 'ata-setup-EUR-refuse')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-err')).toBe(true);
    expect(textOf(tree, 'ata-setup-EUR-err')).toContain('VCHF');
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

  test('busy: the founder-specified SINGLE line and nothing else (2026-10-02)', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'fund-ic', busy: true, onStart});
    expect(has(tree, 'ata-setup-EUR-busy')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    // The founder's verbatim contract: ONE line next to the spinner, simple, active tense.
    expect([...new Set(textOf(tree, 'ata-setup-EUR-busy-line').split('\n').filter(Boolean))]).toEqual([M.deposit.ata.settingUp]);
    // NO other copy competes with it, and nothing inside the busy view is actionable.
    const busyView = tree.root.findAll(n => n.props && n.props.testID === 'ata-setup-EUR-busy')[0]!;
    expect(busyView.findAll(n => typeof n.props.onPress === 'function').length).toBe(0);
    act(() => { tree.unmount(); });
  });

  test('busy during a still-in-flight venue swap shows the SAME one line (no swap-pending override)', () => {
    const tree = mount({kind: 'fund-ic', busy: true});
    expect([...new Set(textOf(tree, 'ata-setup-EUR-busy-line').split('\n').filter(Boolean))]).toEqual([M.deposit.ata.settingUp]);
    expect(textOf(tree, 'ata-setup-EUR-busy-line')).not.toContain('Creating');
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard - the LIVE state (2026-10-02 P0: a non-terminal record owns the card)', () => {
  // The silent-strand defect: the card fell back to idle (button re-armed) while a convert
  // record was still live - a second-spend invitation. The live state renders the SAME single
  // founder line as busy (2026-10-02 spec: one line, continuously, from confirm until
  // terminal) and NO button, NO note line, NO idle probe minimum line. It outranks every
  // other state, because a live record must never be pasted over by idle/confirm/busy.

  test('live: the single setting-up line renders, no note line, no button, no minimum line', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'fund-ic', live: true, minLine: 'Needs at least 0.09 VCHF.', onStart});
    expect(has(tree, 'ata-setup-EUR-live')).toBe(true);
    expect([...new Set(textOf(tree, 'ata-setup-EUR-live-line').split('\n').filter(Boolean))]).toEqual([M.deposit.ata.settingUp]);
    expect(has(tree, 'ata-setup-EUR-live-note')).toBe(false); // ONE line - no competing copy
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false); // never a second spend
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-banner')).toBe(false);
    expect(textOf(tree, 'ata-setup-EUR-live')).not.toContain('at least 0.09 VCHF'); // no idle probe line
    act(() => { tree.unmount(); });
  });

  test('live + err: the error renders under the single line (money-critical, not competing copy)', () => {
    const tree = mount({kind: 'fund-ic', live: true, err: 'The deposit was refused.'});
    expect(has(tree, 'ata-setup-EUR-err')).toBe(true);
    expect(textOf(tree, 'ata-setup-EUR-err')).toContain('refused');
    act(() => { tree.unmount(); });
  });

  test('live outranks busy and confirm: a record standing while a run (or a stale confirm) is up still hides every control', () => {
    const tree = mount({kind: 'fund-ic', live: true, busy: true, confirming: true, confirmLine: 'Swaps about 5 VCHF'});
    expect(has(tree, 'ata-setup-EUR-live')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-busy')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-confirm-btn')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('live outranks refuse: the honest dead end waits until the record resolves', () => {
    const tree = mount({kind: 'refuse', live: true});
    expect(has(tree, 'ata-setup-EUR-live')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-refuse')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('not live: every existing state renders exactly as before (no live chrome leaking)', () => {
    const tree = mount({kind: 'create'});
    expect(has(tree, 'ata-setup-EUR-live')).toBe(false);
    expect(has(tree, 'ata-setup-EUR-banner')).toBe(true);
    act(() => { tree.unmount(); });
  });
});

describe('AtaSetupCard - the terminal failure (founder spec 2026-10-02: error first, then next steps)', () => {
  // After a run fails or its window expires the user must see the error (what went wrong,
  // one honest line) AND the next steps (what happens to the money, what to do now). When
  // the funds are NOT verifiably accounted for, the card must NOT re-arm a repeat affordance.
  const ERR = 'swap unconfirmed when its signed window expired - nothing left the wallet';
  const NEXT = 'Nothing left your wallet. Complete the setup again when you are ready.';

  test('the failed panel: error first, then the next-steps line, then the retry action', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'fund-ic', err: ERR, errNext: NEXT, onStart});
    expect(has(tree, 'ata-setup-EUR-failed')).toBe(true);
    const failedText = textOf(tree, 'ata-setup-EUR-failed');
    expect(failedText.indexOf(ERR)).toBeGreaterThanOrEqual(0);
    expect(failedText.indexOf(ERR)).toBeLessThan(failedText.indexOf(NEXT)); // error BEFORE next steps
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(true); // funds accounted: retry is legal
    act(() => { tree.unmount(); });
  });

  test('unaccounted funds: error + next steps render, but NO repeat affordance re-arms', () => {
    const onStart = jest.fn();
    const tree = mount({
      kind: 'fund-ic',
      err: 'swap unconfirmed when its signed window expired - your balance is the source of truth',
      errNext: 'Check your SOL balance in a moment: if the money is still there, complete the setup again.',
      errCanRetry: false,
      onStart,
    });
    expect(has(tree, 'ata-setup-EUR-failed')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-err-next')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(false); // no repeat while funds unaccounted
    act(() => { tree.unmount(); });
  });

  test('without next steps (a transient pre-run error) the idle card keeps its bottom error line', () => {
    const onStart = jest.fn();
    const tree = mount({kind: 'create', err: 'The network refused the request.', onStart});
    expect(has(tree, 'ata-setup-EUR-failed')).toBe(false); // idle carries it (existing contract)
    expect(has(tree, 'ata-setup-EUR-err')).toBe(true);
    expect(has(tree, 'ata-setup-EUR-complete')).toBe(true);
    act(() => { tree.unmount(); });
  });
});
