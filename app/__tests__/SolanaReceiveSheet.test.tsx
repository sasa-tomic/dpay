/**
 * SolanaReceiveSheet — the USDC receive gate tri-state matrix (2026-08-14 audit fix).
 *
 * The sheet must NEVER make a false claim about the USDC account:
 *   - 'ready'      → address + QR (USDC can land).
 *   - 'absent'     → the one-tap setup card (shared SolanaAtaSetupCard), never the address.
 *   - 'checking'   → honest "Checking…" — NO setup card (the account may exist), NO address.
 *   - 'unverified' → "Couldn't check" + Retry — fail-closed, NO false "you don't have one".
 * SOL never gates (the device key IS the account) — any ataStatus still renders the address.
 *
 * Also pins the setup-card contract the e2e net taps: sol-receive-instructions (instruction
 * card), btn-sol-ata-create (create action), sol-ata-insufficient (needs-SOL warning),
 * sol-ata-busy, sol-ata-err, btn-sol-ata-retry.
 *
 * Uses react-test-renderer (the project's only renderer; no @testing-library). The sheet mounts
 * hooks (useEscapeToClose, useCopyFeedback) which are no-ops under jest — no stubs needed.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SolanaReceiveSheet} from '../components/SolanaReceiveSheet';

const ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

function mount(props: Partial<Parameters<typeof SolanaReceiveSheet>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SolanaReceiveSheet
        address={ADDR}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

describe('SolanaReceiveSheet — USDC tri-state gate', () => {
  test('SOL never gates: an "absent" status still renders the address (the device key IS the account)', () => {
    const tree = mount({token: 'SOL', ataStatus: 'absent'});
    expect(has(tree, 'sol-receive-address')).toBe(true);
    expect(has(tree, 'btn-sol-ata-create')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("USDC 'ready' renders the address (no gate)", () => {
    const tree = mount({token: 'USDC', ataStatus: 'ready'});
    expect(has(tree, 'sol-receive-address')).toBe(true);
    expect(has(tree, 'btn-sol-ata-create')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("USDC 'absent' + funded SOL → the setup card with an ENABLED create button, no insufficient warning", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000000', onCreateAta: () => {}});
    expect(has(tree, 'sol-receive-address')).toBe(false);
    expect(has(tree, 'sol-receive-instructions')).toBe(true);
    expect(has(tree, 'btn-sol-ata-create')).toBe(true);
    expect(has(tree, 'sol-ata-insufficient')).toBe(false);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-sol-ata-create')[0];
    expect(btn.props.disabled).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("USDC 'absent' + unfunded SOL → insufficient warning + DISABLED create (honest cost gate)", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000', onCreateAta: () => {}});
    expect(has(tree, 'sol-ata-insufficient')).toBe(true);
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-sol-ata-create')[0];
    expect(btn.props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test("USDC 'absent' with NO onCreateAta → create button disabled (never a dead promise)", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000000'});
    const btn = tree.root.findAll(node => node.props && node.props.testID === 'btn-sol-ata-create')[0];
    expect(btn.props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test("USDC 'absent' + busy → the busy state replaces the button", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000000', onCreateAta: () => {}, ataSetupBusy: true});
    expect(has(tree, 'sol-ata-busy')).toBe(true);
    expect(has(tree, 'btn-sol-ata-create')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("USDC 'absent' + err → the error line renders", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000000', onCreateAta: () => {}, ataSetupErr: 'boom'});
    expect(has(tree, 'sol-ata-err')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test("USDC 'checking' → honest Checking state — NO setup card (no false absence claim), NO address", () => {
    const tree = mount({token: 'USDC', ataStatus: 'checking'});
    expect(has(tree, 'sol-ata-checking')).toBe(true);
    expect(has(tree, 'btn-sol-ata-create')).toBe(false);
    expect(has(tree, 'sol-receive-address')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("USDC 'unverified' → Couldn't-check card + Retry; retry fires onRetryAta; no address, no false absence claim", () => {
    let retries = 0;
    const tree = mount({token: 'USDC', ataStatus: 'unverified', onRetryAta: () => { retries += 1; }});
    expect(has(tree, 'sol-ata-unverified')).toBe(true);
    expect(has(tree, 'sol-receive-address')).toBe(false);
    expect(has(tree, 'btn-sol-ata-create')).toBe(false);
    expect(has(tree, 'btn-sol-ata-retry')).toBe(true);
    pressByTestID(tree, 'btn-sol-ata-retry');
    expect(retries).toBe(1);
    act(() => { tree.unmount(); });
  });

  test("USDC 'unverified' without onRetryAta → no retry button (still fail-closed)", () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified'});
    expect(has(tree, 'sol-ata-unverified')).toBe(true);
    expect(has(tree, 'btn-sol-ata-retry')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test("the create button's onPress is the wired onCreateAta (the real createUsdcAta path)", () => {
    let created = 0;
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: '1000000000', onCreateAta: () => { created += 1; }});
    pressByTestID(tree, 'btn-sol-ata-create');
    expect(created).toBe(1);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaReceiveSheet — fund-first resume link + waiting cue (2026-08-16)', () => {
  test('returnLabel + onReturn render btn-sol-receive-return; pressing fires onReturn (label iff props)', () => {
    let returned = 0;
    const tree = mount({token: 'SOL', ataStatus: 'ready', returnLabel: 'Back to paying USDC', onReturn: () => { returned += 1; }});
    expect(has(tree, 'btn-sol-receive-return')).toBe(true);
    pressByTestID(tree, 'btn-sol-receive-return');
    expect(returned).toBe(1);
    act(() => { tree.unmount(); });
  });

  test('no returnLabel → NO resume link (label is the only trigger)', () => {
    const tree = mount({token: 'SOL', ataStatus: 'ready', onReturn: () => {}});
    expect(has(tree, 'btn-sol-receive-return')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('no onReturn → NO resume link even with a label (never a dead button)', () => {
    const tree = mount({token: 'SOL', ataStatus: 'ready', returnLabel: 'Back to paying USDC'});
    expect(has(tree, 'btn-sol-receive-return')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('tokenZero (KNOWN zero) → the waiting cue + Check now fires onRetryAta', () => {
    let checks = 0;
    const tree = mount({token: 'SOL', ataStatus: 'ready', tokenZero: true, onRetryAta: () => { checks += 1; }});
    expect(has(tree, 'sol-receive-waiting')).toBe(true);
    expect(has(tree, 'btn-sol-receive-check')).toBe(true);
    pressByTestID(tree, 'btn-sol-receive-check');
    expect(checks).toBe(1);
    act(() => { tree.unmount(); });
  });

  test('tokenZero=false (funded or unconfirmed) → NO waiting cue (known-zero only)', () => {
    const tree = mount({token: 'SOL', ataStatus: 'ready', tokenZero: false, onRetryAta: () => {}});
    expect(has(tree, 'sol-receive-waiting')).toBe(false);
    expect(has(tree, 'btn-sol-receive-check')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
