/**
 * Track S step 4 + 6 - the Solana namespace CONFORMANCE pin (docs/specs/2026-10-12-walletconnect-integration-plan.md).
 *
 * The law: whatever the namespace approval ADVERTISES is exactly the implemented handler set and
 * exactly `SOLANA_V1_METHODS` - never an unimplemented method on the wire ("never advertise an
 * unimplemented method", plan §Track S step 4). Driven on the WalletKit FAKE (the
 * `wc-requests.test.ts` load pattern): the proposal flows through the REAL `approveSession`, and
 * the assertion reads the `supportedNamespaces` the module hands the SDK's validator.
 *
 * Pinned here:
 *   - advertised solana chains == [SOLANA_MAINNET_CAIP2] (mainnet-beta genesis, plan §2.4), events
 *     == [], the account is the solana identity's;
 *   - advertised methods == SOLANA_V1_METHODS (5) == SOLANA_IMPLEMENTED_METHODS - subset AND
 *     equality, both directions;
 *   - SOLANA_METHODS_OUTSIDE_V1 (solana_signAllTransactions) is DISJOINT from advertised;
 *   - `solanaAddress: null` (no solana identity at approval time) leaves the solana namespace OUT
 *     entirely while the EVM namespace still works;
 *   - `solana_signAllTransactions` requested over a live session is refused -32601 by name, the
 *     sheet never opens.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {
  FakeWalletKit,
  FAKE_CORE,
  FAKE_WALLETKIT_INIT,
  FAKE_BUILD_APPROVED_NAMESPACES,
} from './walletkit-fake';
import {SOLANA_IMPLEMENTED_METHODS, makeWcRequestHandler} from '../components/WcRequestSheet';
import {SOLANA_V1_METHODS, SOLANA_METHODS_OUTSIDE_V1, SOLANA_MAINNET_CAIP2} from '../solana/wcDecode';
import {deriveEvmKeypair} from '../evm/identity';
import {deriveSolanaKeypair} from '../solana/identity';
import {bytesToBase64} from '../lib/base64';
import {assembleMessage, buildSolTransferInstruction, base58Decode32, type Instruction} from '../solana/tx';
import {setEvmRpcUrl} from '../evm';
import type {WcProposal, WcRequest, WcResponse} from '../walletkit';

const PROJECT_ID = 'test-solana-wc-conformance';
const SECRET_HEX = '11'.repeat(32);
const EVM_ADDR = deriveEvmKeypair(SECRET_HEX).address;
const SOL_KP = deriveSolanaKeypair(SECRET_HEX);
const SOL_ADDR = SOL_KP.address;

type Loaded = typeof import('../walletkit') & {
  init: typeof FAKE_WALLETKIT_INIT;
  core: typeof FAKE_CORE;
  buildApproved: typeof FAKE_BUILD_APPROVED_NAMESPACES;
  kit: () => FakeWalletKit | undefined;
};

function load(id: string): Loaded {
  let out!: Loaded;
  jest.isolateModules(() => {
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = id;
    const stub = require('@reown/walletkit') as {WalletKit: {init: typeof FAKE_WALLETKIT_INIT}};
    const coreStub = require('@walletconnect/core') as {Core: typeof FAKE_CORE};
    const utilsStub = require('@walletconnect/utils') as {buildApprovedNamespaces: typeof FAKE_BUILD_APPROVED_NAMESPACES};
    const fake = require('./walletkit-fake') as typeof import('./walletkit-fake');
    const mod = require('../walletkit') as typeof import('../walletkit');
    out = {
      ...mod,
      init: stub.WalletKit.init,
      core: coreStub.Core,
      buildApproved: utilsStub.buildApprovedNamespaces,
      kit: () => fake.lastFakeWalletKit(),
    };
  });
  return out;
}

afterEach(() => {
  (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
  setEvmRpcUrl('');
});

function fakeProposal(id = 42): WcProposal {
  const metadata = {name: 'fake-dapp', description: 'fake', url: 'https://fake.invalid', icons: []};
  return {
    id,
    params: {
      id,
      expiryTimestamp: 0,
      relays: [{protocol: 'irn'}],
      proposer: {publicKey: 'fake-proposer-key', metadata},
      requiredNamespaces: {
        eip155: {chains: ['eip155:1'], methods: ['personal_sign'], events: ['chainChanged']},
        solana: {chains: [SOLANA_MAINNET_CAIP2], methods: [...SOLANA_V1_METHODS], events: []},
      },
      optionalNamespaces: {},
      pairingTopic: 'fake-pairing-topic',
    },
    verifyContext: {verified: {origin: 'https://fake.invalid', validation: 'UNKNOWN', verifyUrl: ''}},
  } as unknown as WcProposal;
}

/** The supportedNamespaces the loaded module handed the SDK's validator on the LAST approve. */
function lastSupportedNamespaces(mod: Loaded): Record<string, {chains: string[]; methods: string[]; events: string[]; accounts: string[]}> {
  const calls = (mod.buildApproved as unknown as {mock: {calls: Array<[{proposal: unknown; supportedNamespaces: Record<string, {chains: string[]; methods: string[]; events: string[]; accounts: string[]}>}]>}}).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0].supportedNamespaces;
}

async function approveWith(mod: Loaded, solanaAddress: string | null): Promise<void> {
  const kit = mod.kit()!;
  await mod.approveSession(fakeProposal(7), EVM_ADDR, solanaAddress);
  expect(kit.approveSession).toHaveBeenCalledTimes(1);
}

describe('the advertised solana namespace (what approveSession builds)', () => {
  test('advertised methods EXACTLY equal SOLANA_V1_METHODS and are a subset of the implemented set', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    await approveWith(mod, SOL_ADDR);
    const solana = lastSupportedNamespaces(mod).solana;
    expect(solana).toBeDefined();
    // Subset arm: every advertised method is implemented.
    for (const m of solana.methods) expect(SOLANA_IMPLEMENTED_METHODS).toContain(m);
    // Equality arm: the advertisement is EXACTLY the v1 surface - nothing more, nothing less.
    expect([...solana.methods]).toEqual([...SOLANA_V1_METHODS]);
    expect([...SOLANA_IMPLEMENTED_METHODS]).toEqual([...SOLANA_V1_METHODS]);
  });

  test('mainnet-beta CAIP-2 only, no events, the account is the solana identity', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    await approveWith(mod, SOL_ADDR);
    const solana = lastSupportedNamespaces(mod).solana;
    expect(solana.chains).toEqual([SOLANA_MAINNET_CAIP2]);
    expect(SOLANA_MAINNET_CAIP2).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(solana.events).toEqual([]);
    expect(solana.accounts).toEqual([`${SOLANA_MAINNET_CAIP2}:${SOL_ADDR}`]);
    // The EVM namespace rides unchanged beside it.
    const eip155 = lastSupportedNamespaces(mod).eip155;
    expect(eip155.chains).toEqual(['eip155:1', 'eip155:42161']);
    expect(eip155.accounts).toEqual([`eip155:1:${EVM_ADDR}`, 'eip155:42161:'.concat(EVM_ADDR)]);
  });

  test('SOLANA_METHODS_OUTSIDE_V1 is disjoint from advertised (signAllTransactions is never on the wire)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    await approveWith(mod, SOL_ADDR);
    const advertised = lastSupportedNamespaces(mod).solana.methods;
    for (const {method} of SOLANA_METHODS_OUTSIDE_V1) {
      expect(advertised).not.toContain(method);
      expect(SOLANA_V1_METHODS).not.toContain(method);
    }
  });

  test('no solana identity at approval time: NO solana namespace, EVM still works', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    await approveWith(mod, null);
    const ns = lastSupportedNamespaces(mod);
    expect(ns.solana).toBeUndefined();
    expect(ns.eip155.chains).toEqual(['eip155:1', 'eip155:42161']);
    expect(ns.eip155.accounts).toHaveLength(2);
  });
});

describe('signAllTransactions refusal (pinned end to end)', () => {
  test('requested over a live session: refused -32601 by name with the plan reason, the sheet never opens', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const blockhash = new Uint8Array(32).fill(7);
    const arbitrary = new Uint8Array(32).fill(5);
    const unknownIx: Instruction = {programId: arbitrary, keys: [], data: new Uint8Array([1])};
    const msg = assembleMessage(SOL_KP.publicKey, [buildSolTransferInstruction(SOL_KP.publicKey, base58Decode32('11111111111111111111111111111112'), 1n), unknownIx], blockhash);
    const wire = new Uint8Array(1 + 64 + msg.length);
    wire[0] = 1; // one zeroed signature slot
    wire.set(msg, 65);
    const request: WcRequest = {
      topic: 'topic-1',
      id: 50,
      params: {
        requester: {publicKey: 'pk', metadata: {name: 'fake-dapp', description: 'd', url: 'https://fake.invalid', icons: []}},
        chainId: SOLANA_MAINNET_CAIP2,
        request: {method: 'solana_signAllTransactions', params: {transactions: [bytesToBase64(wire)]}},
      },
    } as unknown as WcRequest;
    const state = {open: false, openedRequests: [] as WcRequest[]};
    const {onRequest} = {
      onRequest: makeWcRequestHandler({
        evmAddress: EVM_ADDR,
        solanaAddress: SOL_ADDR,
        isOpen: () => state.open,
        activeChainOf: () => 'eip155:1',
        respond: (topic, response) => mod.respondSessionRequest(topic, response),
        userRejected: mod.wcUserRejected(),
        openRequest: (r) => state.openedRequests.push(r),
      }),
    };
    onRequest(request);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.openedRequests).toHaveLength(0);
    const answers = (kit.respondSessionRequest as unknown as {mock: {calls: Array<[{topic: string; response: WcResponse}]>}}).mock.calls.map((c) => c[0]);
    expect(answers).toHaveLength(1);
    const err = (answers[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('solana_signAllTransactions');
  });
});
