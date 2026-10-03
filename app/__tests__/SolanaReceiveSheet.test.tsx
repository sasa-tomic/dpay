/**
 * SolanaReceiveSheet — the USDC receive gate tri-state matrix (2026-08-14 audit fix).
 *
 * The sheet must NEVER make a false claim about the USDC account:
 *   - 'ready'      → address + QR (USDC can land).
 *   - 'absent'     → the one-tap setup card (shared AtaSetupCard, create surface), never the address.
 *   - 'checking'   → honest "Checking…" — NO setup card (the account may exist), NO address.
 *   - 'unverified' → "Couldn't check" + Retry — fail-closed, NO false "you don't have one".
 * SOL never gates (the device key IS the account) — any ataStatus still renders the address.
 *
 * Also pins the setup-card contract the e2e net taps: sol-receive-instructions (instruction
 * card), btn-sol-ata-create (create action), sol-ata-insufficient (needs-SOL warning),
 * sol-ata-checking-sol (SOL balance unconfirmed — "checking", never a false insufficiency),
 * sol-ata-busy, sol-ata-err, btn-sol-ata-retry.
 *
 * Uses react-test-renderer (the project's only renderer; no @testing-library). The sheet mounts
 * hooks (useEscapeToClose, useCopyFeedback) which are no-ops under jest — no stubs needed.
 */
import {describe, test, expect} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SolanaReceiveSheet} from '../components/SolanaReceiveSheet';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import {QrCode} from '../components/QrCode';

const ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function qrValue(tree: renderer.ReactTestRenderer): string {
  const nodes = tree.root.findAllByType(QrCode);
  expect(nodes.length).toBe(1);
  return nodes[0].props.value as string;
}

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string): void {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => { node.props.onPress(); });
}

function mount(props: Partial<Parameters<typeof SolanaReceiveSheet>[0]> = {}) {
  // The sheet is prop-driven: a token is named by its literal AND its mint (registry truth).
  // Default the mint the way the production caller does (the selected row's mint) so existing
  // token:'USDC' tests exercise the SPL path exactly as the app wires it.
  const mint = props.mint !== undefined
    ? props.mint
    : (props.token != null && props.token !== 'SOL' ? USDC_MINT_ADDRESS : null);
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <SolanaReceiveSheet
        address={ADDR}
        mint={mint}
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

  test("USDC 'absent' + SOL unconfirmed (solBalance null) → sol-ata-checking-sol, never a false insufficiency claim", () => {
    const tree = mount({token: 'USDC', ataStatus: 'absent', solBalance: null});
    expect(has(tree, 'sol-ata-checking-sol')).toBe(true);
    expect(has(tree, 'sol-ata-insufficient')).toBe(false);
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

describe('SolanaReceiveSheet — Solana Pay QR payload', () => {
  test('SOL: the QR encodes solana:<address>?reference=<base58>, no spl-token', () => {
    const tree = mount({token: 'SOL', ataStatus: 'ready'});
    const value = qrValue(tree);
    const m = new RegExp(`^solana:${ADDR}\\?reference=([1-9A-HJ-NP-Za-km-z]{32,44})$`).exec(value);
    expect(m).not.toBeNull();
    expect(value).not.toContain('spl-token');
    act(() => { tree.unmount(); });
  });

  test('USDC without uriRecipient: the QR recipient is the passed address and carries spl-token', () => {
    const tree = mount({token: 'USDC', ataStatus: 'ready'});
    const value = qrValue(tree);
    expect(value.startsWith(`solana:${ADDR}?spl-token=${USDC_MINT_ADDRESS}&reference=`)).toBe(true);
    const ref = value.slice(`solana:${ADDR}?spl-token=${USDC_MINT_ADDRESS}&reference=`.length);
    expect(BASE58.test(ref)).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('USDC with uriRecipient: the QR recipient is the OWNER, not the ATA', () => {
    const tree = mount({token: 'USDC', ataStatus: 'ready', uriRecipient: OWNER});
    const value = qrValue(tree);
    expect(value.startsWith(`solana:${OWNER}?spl-token=${USDC_MINT_ADDRESS}&reference=`)).toBe(true);
    expect(value.startsWith(`solana:${ADDR}?`)).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('the reference is stable across re-renders of the same mount', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<SolanaReceiveSheet address={ADDR} ataStatus="ready" onClose={() => {}} />);
    });
    const before = qrValue(tree);
    act(() => {
      tree.update(<SolanaReceiveSheet address={ADDR} ataStatus="ready" onClose={() => {}} />);
    });
    const after = qrValue(tree);
    expect(after).toBe(before);
    act(() => { tree.unmount(); });
  });

  test('a fresh reference is drawn per mount (per receive session)', () => {
    const tree1 = mount({token: 'SOL', ataStatus: 'ready'});
    const v1 = qrValue(tree1);
    act(() => { tree1.unmount(); });
    const tree2 = mount({token: 'SOL', ataStatus: 'ready'});
    const v2 = qrValue(tree2);
    act(() => { tree2.unmount(); });
    expect(v2).not.toBe(v1);
  });

  test('the on-screen address text stays the bare base58 address (copy target unchanged)', () => {
    const tree = mount({token: 'SOL', ataStatus: 'ready'});
    const text = tree.root.findAll(node => node.props && node.props.testID === 'sol-receive-address')[0];
    expect(text.props.children).toBe(ADDR);
    act(() => { tree.unmount(); });
  });
});

describe('SolanaReceiveSheet — unverified detail is classified (R4, spec 2026-09-09-relay-ha-and-solana-proxy)', () => {
  // The 'unverified' detail sentence is picked from the transport seam's SolanaReadFailure
  // classification (threaded Wallet → SolReceiveMode → sheet; never classified at the component) —
  // the same contract as RailUnreadableNote (R3). Each class renders its OWN sentence, and the
  // relay-outage class ('unreachable') names dpay's relay: post-R2 the RPC path IS the relay's
  // proxy, so that outage must never be spelled as the user's connection problem.
  function cardText(tree: renderer.ReactTestRenderer): string {
    const card = tree.root.findAll(node => node.props && node.props.testID === 'sol-ata-unverified')[0];
    return card.findAll(node => typeof node.props.children === 'string')
      .map(n => n.props.children as string)
      .join('\n');
  }

  test("'unreachable' (relay-path outage) names dpay's relay, never the user's connection", () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: 'unreachable'});
    const text = cardText(tree);
    expect(text).toContain('relay');
    expect(text).toContain('untouched');
    expect(text).not.toContain('Check your connection');
    act(() => { tree.unmount(); });
  });

  test("'offline' keeps the connection-honest spelling (you appear to be offline)", () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: 'offline'});
    expect(cardText(tree)).toContain('offline');
    act(() => { tree.unmount(); });
  });

  test("'refused' names the endpoint's refusal, not the user", () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: 'refused'});
    expect(cardText(tree)).toContain('refused');
    act(() => { tree.unmount(); });
  });

  test("'unreadable' names the untrustworthy answer", () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: 'unreadable'});
    expect(cardText(tree)).toContain('can’t read');
    act(() => { tree.unmount(); });
  });

  test('no classified cause (null — rail off / unavailable) → the class-agnostic fallback sentence', () => {
    const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: null});
    const text = cardText(tree);
    expect(text).toContain('reach Solana');
    expect(text).toContain('Check your connection');
    act(() => { tree.unmount(); });
  });

  test('each class renders a DISTINCT detail (no two classes share a sentence)', () => {
    const classes = ['refused', 'offline', 'unreachable', 'unreadable'] as const;
    const details = classes.map(c => {
      const tree = mount({token: 'USDC', ataStatus: 'unverified', ataFailure: c});
      const text = cardText(tree);
      act(() => { tree.unmount(); });
      return text;
    });
    expect(new Set(details).size).toBe(classes.length);
  });
});
