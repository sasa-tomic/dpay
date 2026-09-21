/**
 * The REAL send sheet over the REAL seam over a RECORDING RPC stub — the offline reproduction
 * harness the 2026-09-21 live diagnosis called for ("drive with a stub RPC that records every
 * call"). Until now NO test drove the full app-side send chain: the sheet's own suite mocks
 * `../solana` at its module boundary and the seam suite has no component, so the three live EURC
 * attempts (zero movement, no terminal surface, no broadcast) died somewhere in between.
 *
 * What this pins, end to end and offline:
 *   - the EXACT RPC method sequence an EURC send must produce (both ATAs exist, and the
 *     recipient-ATA-create variant),
 *   - exactly ONE broadcast carrying real signed transaction bytes (device-key signed),
 *   - the sheet's terminal surface (the done panel) with the returned signature,
 *   - the honest error surface when the endpoint refuses (the "no error surfaced" live gap).
 *
 * Isolated module registry: `__DPAY_TEST_SOLANA_RPC_URL` must be non-empty at the moment the seam
 * module graph loads (jest.setup.js pins '' globally), so both the seam and the sheet component
 * are required INSIDE `jest.isolateModules`. The stub (`__DPAY_TEST_SOLANA_RPC_STUB`) is consulted
 * per call inside rpcFetch — before any candidate walk — so fetch is never hit and every call
 * lands in the recording. A method missing from the stub THROWS (rpcFetch's contract), which is
 * itself the assertion that no unexpected RPC fires.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';

// Isolated-instance holders, populated in beforeEach. EVERYTHING — react, the renderer, the sheet
// and the seam — is required from ONE reset registry: requiring the sheet's graph in isolation
// while keeping the file-level renderer would put TWO React copies in one render (the invalid-hook
// failure). The override must be set BEFORE the seam graph loads: constants.ts captures
// `__DPAY_TEST_SOLANA_RPC_URL` at module load (jest.setup.js pins '' globally).
let React!: typeof import('react');
let rtr!: typeof import('react-test-renderer');
let Sheet!: typeof import('../components/SolanaWithdrawSheet')['SolanaWithdrawSheet'];
let tokens!: typeof import('../solana/tokens');

beforeEach(() => {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string};
  g.__DPAY_TEST_SOLANA_RPC_URL = 'https://stub.test';
  jest.resetModules();
  React = require('react');
  rtr = require('react-test-renderer');
  tokens = require('../solana/tokens') as typeof import('../solana/tokens');
  Sheet = (require('../components/SolanaWithdrawSheet') as typeof import('../components/SolanaWithdrawSheet')).SolanaWithdrawSheet;
});

/** Lazy `act`: `rtr` is only populated in beforeEach, so the wrapper must resolve at CALL time. */
const act = ((...args: Parameters<typeof rtr.act>) => rtr.act(...args)) as typeof rtr.act;
const createElement = (props: Record<string, unknown>) => React.createElement(Sheet, props as never);

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: Record<string, unknown>}).__DPAY_TEST_SOLANA_RPC_STUB;
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string}).__DPAY_TEST_SOLANA_RPC_URL = '';
});

const IDENT = {secretHex: 'ab'.repeat(32), publicHex: 'cd'.repeat(32), username: 't'};
const DEST = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'; // real base58 Solana address, not the wallet's own
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_ACCOUNT = {value: {data: ['', 'base64'], owner: TOKEN_PROGRAM, lamports: 2039280}};
const SIG = '5ig'.repeat(10);

/** A stub that records EVERY call (method + params) and throws on any method it has no handler
 *  for — rpcFetch does that natively, so an unexpected RPC can never pass silently. */
function recordingStub(handlers: Record<string, (params: unknown[]) => unknown>): {calls: {method: string; params: unknown[]}[]} {
  const calls: {method: string; params: unknown[]}[] = [];
  const stub: Record<string, (params: unknown[]) => unknown> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    stub[method] = (params: unknown[]) => {
      calls.push({method, params});
      return handler(params);
    };
  }
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: Record<string, unknown>}).__DPAY_TEST_SOLANA_RPC_STUB = stub;
  return {calls};
}

function has(tree: ReturnType<typeof rtr.create>, testID: string): boolean {
  return tree.root.findAll((node: {props?: Record<string, unknown>}) => Boolean(node.props) && node.props!.testID === testID).length > 0;
}

async function drive(tree: ReturnType<typeof rtr.create>, amount: string) {
  await act(async () => {
    tree.root.findByProps({testID: 'sol-send-address-input'}).props.onChangeText(DEST);
    tree.root.findByProps({testID: 'sol-send-amount-input'}).props.onChangeText(amount);
  });
  await act(async () => { await tree.root.findByProps({testID: 'btn-sol-send-confirm'}).props.onPress(); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const BLOCKHASH_OK = () => ({context: {slot: 100}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}});

describe('the send sheet over the REAL seam — recorded-stub repro harness (2026-09-21)', () => {
  test('an EURC send performs the exact RPC sequence, broadcasts ONCE, and lands on the done panel', async () => {
    const EURC = tokens.solanaTokenInfo('EURC');
    expect(EURC).not.toBeNull();
    const {calls} = recordingStub({
      getAccountInfo: () => ATA_ACCOUNT,   // sender ATA exists, recipient ATA exists (both calls)
      getLatestBlockhash: BLOCKHASH_OK,
      sendTransaction: () => SIG,
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    });
    let tree!: ReturnType<typeof rtr.create>;
    await act(async () => {
      tree = rtr.create(createElement({identity: IDENT, token: 'EURC', mint: EURC!.mint, balance: '1500000', solBalance: '2000000', onSent: () => {}, onClose: () => {}}));
    });
    await drive(tree, '1.5'); // 1.5 EURC at 6 decimals

    // The exact RPC story, in order: ATA check (sender), ATA check (recipient), blockhash,
    // BROADCAST, confirm poll. Nothing else — every extra call would have thrown.
    expect(calls.map(c => c.method)).toEqual([
      'getAccountInfo', 'getAccountInfo', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses',
    ]);
    // Exactly ONE broadcast, carrying real signed bytes (sig(64) + message ⇒ well past trivial).
    const broadcasts = calls.filter(c => c.method === 'sendTransaction');
    expect(broadcasts).toHaveLength(1);
    const bytes = Buffer.from(String(broadcasts[0].params[0]), 'base64');
    expect(bytes.length).toBeGreaterThan(120);

    // The terminal surface: the DONE panel with the seam's returned signature.
    expect(has(tree, 'sol-send-outcome')).toBe(true);
    expect(tree.root.findByProps({testID: 'sol-send-signature'}).props.children).toBe(SIG);
    act(() => { tree.unmount(); });
  });

  test('a missing recipient ATA adds the rent pre-check to the story — still exactly one broadcast', async () => {
    const EURC = tokens.solanaTokenInfo('EURC');
    let ataCalls = 0;
    const {calls} = recordingStub({
      getAccountInfo: () => {
        ataCalls += 1;
        return ataCalls === 1 ? ATA_ACCOUNT : {value: null}; // sender yes, recipient NO
      },
      getBalance: () => ({value: 1000000000}), // rent pre-check: 1 SOL ≥ the one-time rent
      getLatestBlockhash: BLOCKHASH_OK,
      sendTransaction: () => SIG,
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    });
    let tree!: ReturnType<typeof rtr.create>;
    await act(async () => {
      tree = rtr.create(createElement({identity: IDENT, token: 'EURC', mint: EURC!.mint, balance: '1500000', solBalance: '2000000', onSent: () => {}, onClose: () => {}}));
    });
    await drive(tree, '1.5');

    expect(calls.map(c => c.method)).toEqual([
      'getAccountInfo', 'getAccountInfo', 'getBalance', 'getLatestBlockhash', 'sendTransaction', 'getSignatureStatuses',
    ]);
    expect(calls.filter(c => c.method === 'sendTransaction')).toHaveLength(1);
    expect(has(tree, 'sol-send-outcome')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('an endpoint that REFUSES the first call lands on the honest ERROR surface — the live "no error surfaced" gap is closed', async () => {
    // The 2026-09-21 attempts produced NO visible error: an early failure used to hide behind the
    // offline gate replacing the sheet. On this harness the failure path itself is proven to end
    // on a surface that names what happened.
    const EURC = tokens.solanaTokenInfo('EURC');
    recordingStub({
      getAccountInfo: () => { throw new Error('solana rpc getAccountInfo → relay.example: HTTP 503'); },
    });
    let tree!: ReturnType<typeof rtr.create>;
    await act(async () => {
      tree = rtr.create(createElement({identity: IDENT, token: 'EURC', mint: EURC!.mint, balance: '1500000', solBalance: '2000000', onSent: () => {}, onClose: () => {}}));
    });
    await drive(tree, '1.5');
    expect(has(tree, 'sol-send-err')).toBe(true);
    expect(has(tree, 'sol-send-outcome')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
