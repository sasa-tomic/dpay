/**
 * W1 step 5 - the responder's conformance matrix, driven on the WalletKit FAKE (the
 * `walletkit.test.ts` load pattern: `walletkit.ts` inside `jest.isolateModules`, every WC
 * specifier resolving to the typed stub). The module under test for the per-method logic is
 * `WcRequestSheet.tsx` - the handler factories + the approve/reject paths are exported pure
 * precisely so THIS suite can pin them without mounting the 2800-line Wallet.
 *
 * The matrix (plan W1 step 3 + step 5):
 *   - the full loop: emit proposal -> open -> approveSession -> emit request -> approve ->
 *     respondSessionRequest (all through the same loaded module the Wallet wires);
 *   - personal_sign approve: the 65-byte r||s||v hex exactly `signPersonal` produces over the
 *     EXACT request bytes (hex in, hex signed; UTF-8 string in, its UTF-8 bytes signed);
 *   - personal_sign reject: the SDK's USER_REJECTED 5000;
 *   - eth_signTypedData_v4 approve: the EIP-712 spec's Mail example (the evm-typed-data golden),
 *     signed through the same parsed payload;
 *   - malformed typed data: rejected with a typed error by the HANDLER, the sheet never opens,
 *     and nothing is ever raw-signed;
 *   - the one-review-at-a-time law: a request while the sheet is open answers USER_REJECTED
 *     5000 immediately (never queues);
 *   - wallet_switchEthereumChain: a wired chain answers null and moves the session chain; an
 *     unwired one answers the SDK's UNSUPPORTED_CHAINS 5100;
 *   - eth_sendTransaction: param-fill from the chain (nonce/gas/fees through the relay-proxy
 *     path, fetch doubled), deterministic signing, broadcast of exactly the locally-signed
 *     bytes, hash returned SUBMITTED-not-settled; unknown calldata opens the sheet behind the
 *     explicit warning; and the NEVER-AUTO-APPROVE invariant: an emitted request alone provokes
 *     NO response of any kind.
 *   - reads: eth_accounts / eth_chainId answer directly from session state, no sheet.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {
  FakeWalletKit,
  FAKE_CORE,
  FAKE_WALLETKIT_INIT,
  FAKE_BUILD_APPROVED_NAMESPACES,
} from './walletkit-fake';
import {
  makeWcProposalHandler,
  makeWcRequestHandler,
  summarizeWcRequest,
  approveWcRequest,
  rejectWcRequest,
  chainHexOf,
  type WcRequestSummary,
} from '../components/WcRequestSheet';
import {deriveEvmKeypair} from '../evm/identity';
import {signPersonal} from '../evm/personalSign';
import {signTypedData, type TypedData} from '../evm/typedData';
import {signEip1559Tx, toHex0x} from '../evm/tx';
import {encodeTransfer} from '../evm/abi';
import {bytesToHex, hexToBytes} from '../lib/format';
import {utf8ToBytes} from '../lib/base64url';
import {setEvmRpcUrl} from '../evm';
import type {WcProposal, WcRequest, WcResponse} from '../walletkit';

const PROJECT_ID = 'test-wc-requests';
const SECRET_HEX = '11'.repeat(32);
const DEVICE_KEY = deriveEvmKeypair(SECRET_HEX).privateKey; // the SLIP-10-derived signing key
const DEVICE = deriveEvmKeypair(SECRET_HEX).address;

// --- module loading (the walletkit.test.ts pattern, minus its react-native mock: the mock would
// break the sheet's real RN imports in THIS file's registry, and the default preset Platform is
// non-web, which is all `walletkit.ts`'s disabled guard reads). --------------------------------------

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
  (globalThis as unknown as {fetch: unknown}).fetch = realFetch;
});
const realFetch: typeof globalThis.fetch = globalThis.fetch;

// --- fixtures ----------------------------------------------------------------------------------------

function fakeProposal(id = 42): WcProposal {
  const metadata = {name: 'fake-dapp', description: 'fake', url: 'https://fake.invalid', icons: []};
  return {
    id,
    params: {
      id,
      expiryTimestamp: 0,
      relays: [{protocol: 'irn'}],
      proposer: {publicKey: 'fake-proposer-key', metadata},
      requiredNamespaces: {},
      optionalNamespaces: {},
      pairingTopic: 'fake-pairing-topic',
    },
    verifyContext: {
      verified: {origin: 'https://fake.invalid', validation: 'UNKNOWN', verifyUrl: ''},
    },
  } as unknown as WcProposal;
}

function fakeRequest(id: number, method: string, params: unknown, chainId = 'eip155:1'): WcRequest {
  return {
    topic: 'topic-1',
    id,
    params: {
      requester: {publicKey: 'pk', metadata: {name: 'fake-dapp', description: 'd', url: 'https://fake.invalid', icons: []}},
      chainId,
      request: {method, params},
    },
  } as unknown as WcRequest;
}

interface HarnessState {
  open: boolean;
  openedRequests: WcRequest[];
  openedProposals: WcProposal[];
}

/** The handler wired EXACTLY like the Wallet wires it (same module, same deps shape). */
function wireHandlers(mod: Loaded, state: HarnessState) {
  const proposalHandler = makeWcProposalHandler({
    isOpen: () => state.open,
    open: (proposal) => state.openedProposals.push(proposal),
    reject: (proposal) => mod.rejectSession(proposal),
  });
  const requestHandler = makeWcRequestHandler({
    evmAddress: DEVICE,
    isOpen: () => state.open,
    activeChainOf: () => 'eip155:1',
    respond: (topic, response) => mod.respondSessionRequest(topic, response),
    userRejected: mod.wcUserRejected(),
    openRequest: (request) => state.openedRequests.push(request),
  });
  return {onProposal: proposalHandler, onRequest: requestHandler};
}

function responsesOf(kit: FakeWalletKit): Array<{topic: string; response: WcResponse}> {
  return (kit.respondSessionRequest as unknown as {mock: {calls: Array<[{topic: string; response: WcResponse}]>}}).mock.calls.map((c) => c[0]);
}

/** The handler answers fire-and-forget (one promise hop before the fake records). */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** The EIP-712 spec's Mail example (the evm-typed-data golden), as the dApp sends it. */
const MAIL: TypedData = {
  types: {
    EIP712Domain: [
      {name: 'name', type: 'string'},
      {name: 'version', type: 'string'},
      {name: 'chainId', type: 'uint256'},
      {name: 'verifyingContract', type: 'address'},
    ],
    Person: [
      {name: 'name', type: 'string'},
      {name: 'wallet', type: 'address'},
    ],
    Mail: [
      {name: 'from', type: 'Person'},
      {name: 'to', type: 'Person'},
      {name: 'contents', type: 'string'},
    ],
  },
  primaryType: 'Mail',
  domain: {name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'},
  message: {
    from: {name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'},
    to: {name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'},
    contents: 'Hello, Bob!',
  },
};

const OTHER_ADDRESS = '0x1234567890AbCdEf1234567890aBcDeF12345678';

// --- the matrix --------------------------------------------------------------------------------------

describe('the responder loop: proposal -> approve -> request -> respond', () => {
  test('the full loop runs through the loaded module; respondSessionRequest happens only on approve', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    // Registered through the module's emitter, exactly the Wallet wiring.
    const offProposal = mod.onProposal(makeWcProposalHandler({
      isOpen: () => state.open,
      open: (proposal) => state.openedProposals.push(proposal),
      reject: (proposal) => mod.rejectSession(proposal),
    }));
    const offRequest = mod.onRequest(makeWcRequestHandler({
      evmAddress: DEVICE,
      isOpen: () => state.open,
      activeChainOf: () => 'eip155:1',
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
      userRejected: mod.wcUserRejected(),
      openRequest: (request) => state.openedRequests.push(request),
    }));

    // 1. proposal arrives, sheet opens, NOTHING answers yet.
    const proposal = fakeProposal(7);
    kit.emit('session_proposal', proposal);
    expect(state.openedProposals).toEqual([proposal]);
    expect(kit.approveSession).not.toHaveBeenCalled();

    // 2. approve goes through the module (what the sheet's button calls).
    await mod.approveSession(proposal, DEVICE);
    expect(kit.approveSession).toHaveBeenCalledTimes(1);

    // 3. a signature request arrives over the SAME emitter; still nothing answers - the
    // NEVER-AUTO-APPROVE invariant.
    state.open = false;
    const message = 'Hello dpay';
    const request = fakeRequest(9, 'personal_sign', [`0x${bytesToHex(utf8ToBytes(message))}`, DEVICE]);
    kit.emit('session_request', request);
    expect(state.openedRequests).toEqual([request]);
    expect(responsesOf(kit)).toHaveLength(0);

    // 4. approve -> the dApp sees the signature, byte-exact.
    await approveWcRequest({
      request,
      secretHex: SECRET_HEX,
      evmAddress: DEVICE,
      activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const answers = responsesOf(kit);
    expect(answers).toHaveLength(1);
    const expected = signPersonal(DEVICE_KEY, message);
    expect(answers[0]).toEqual({
      topic: 'topic-1',
      response: {id: 9, jsonrpc: '2.0', result: `0x${bytesToHex(expected.serialized)}`},
    });

    offProposal();
    offRequest();
  });
});

describe('personal_sign', () => {
  test('hex message: the response is the 65-byte signature over the EXACT hex bytes', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const message = 'MtPelerin-1234';
    const hexMessage = `0x${bytesToHex(utf8ToBytes(message))}`;
    const request = fakeRequest(1, 'personal_sign', [hexMessage, DEVICE]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = signPersonal(DEVICE_KEY, hexToBytes(hexMessage));
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 1, jsonrpc: '2.0', result: `0x${bytesToHex(expected.serialized)}`});
  });

  test('raw UTF-8 string message: signed as its UTF-8 bytes (the MetaMask param shape)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(2, 'personal_sign', ['plain text message', DEVICE]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = signPersonal(DEVICE_KEY, 'plain text message');
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 2, jsonrpc: '2.0', result: `0x${bytesToHex(expected.serialized)}`});
  });

  test('reject: the SDK USER_REJECTED error (code 5000), and nothing was signed', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(3, 'personal_sign', ['0xdeadbeef', DEVICE]);
    await rejectWcRequest(request, mod.wcUserRejected(), (topic, response) => mod.respondSessionRequest(topic, response));
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 3, jsonrpc: '2.0', error: {code: 5000, message: 'User rejected.'}});
  });

  test('a different signer address: approved path answers a typed error, never signs', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(4, 'personal_sign', ['0xdeadbeef', OTHER_ADDRESS]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 4, jsonrpc: '2.0', error: {code: -32603, message: 'Request asks a different address to sign'}});
  });
});

describe('eth_signTypedData_v4', () => {
  test('the EIP-712 Mail golden signs through the parsed payload (same bytes as signTypedData)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(5, 'eth_signTypedData_v4', [DEVICE, JSON.stringify(MAIL)]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = signTypedData(DEVICE_KEY, MAIL);
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 5, jsonrpc: '2.0', result: expected.serialized});
  });

  test('malformed typed data: the HANDLER refuses with a typed error, the sheet never opens', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(6, 'eth_signTypedData_v4', [DEVICE, '{not json']));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect(answers).toHaveLength(1);
    const err = (answers[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('Malformed typed data');
  });

  test('typed data with an UNKNOWN value type: refused, never raw-signed', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const bad = {...MAIL, types: {...MAIL.types, Mail: [{name: 'weird', type: 'uint'} as never]}};
    const request = fakeRequest(7, 'eth_signTypedData_v4', [DEVICE, JSON.stringify(bad)]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const answers = responsesOf(kit);
    const err = (answers[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('Malformed typed data');
  });
});

describe('the one-review-at-a-time law', () => {
  test('a request while the sheet is open answers USER_REJECTED 5000 immediately and never queues', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: true, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(8, 'personal_sign', ['0x01', DEVICE]));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 8, jsonrpc: '2.0', error: {code: 5000, message: 'User rejected.'}});
  });

  test('a PROPOSAL while the sheet is open is refused through rejectSession (5000)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: true, openedRequests: [], openedProposals: []};
    const {onProposal} = wireHandlers(mod, state);
    const proposal = fakeProposal(10);
    onProposal(proposal);
    await flush();
    expect(state.openedProposals).toHaveLength(0);
    expect(kit.rejectSession).toHaveBeenCalledWith({id: 10, reason: {code: 5000, message: 'User rejected.'}});
  });
});

describe('wallet_switchEthereumChain', () => {
  test('a wired chain answers null and reports the move', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(11, 'wallet_switchEthereumChain', [{chainId: '0xa4b1'}]);
    const out = await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    expect(out).toEqual({submittedHash: null, switchedTo: 'eip155:42161'});
    expect(responsesOf(kit)[0]!.response).toEqual({id: 11, jsonrpc: '2.0', result: null});
  });

  test('an unwired chain answers the SDK UNSUPPORTED_CHAINS error (code 5100)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(12, 'wallet_switchEthereumChain', [{chainId: '0x89'}]);
    const out = await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    expect(out).toEqual({submittedHash: null, switchedTo: null});
    expect(responsesOf(kit)[0]!.response).toEqual({id: 12, jsonrpc: '2.0', error: {code: 5100, message: 'Unsupported chains.'}});
  });
});

describe('eth_accounts / eth_chainId (reads answer directly, no sheet)', () => {
  test('eth_accounts answers the paired address; eth_chainId answers the session chain as hex', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(13, 'eth_accounts', []));
    onRequest(fakeRequest(14, 'eth_chainId', []));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 13, jsonrpc: '2.0', result: [DEVICE]});
    expect(answers[1]!.response).toEqual({id: 14, jsonrpc: '2.0', result: '0x1'});
  });

  test('reads are answered even while the sheet is open (they never touch the review)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: true, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(15, 'eth_chainId', []));
    await flush();
    expect(responsesOf(kit)[0]!.response).toEqual({id: 15, jsonrpc: '2.0', result: '0x1'});
  });

  test('chainHexOf is the eth_chainId codec', () => {
    expect(chainHexOf('eip155:1')).toBe('0x1');
    expect(chainHexOf('eip155:42161')).toBe('0xa4b1');
  });
});

describe('eth_sendTransaction', () => {
  /** A fetch double routed by JSON-RPC method, answering the param-fill chain arithmetic. */
  function routeFill() {
    const calls: Array<{method: string; body: string}> = [];
    (globalThis as unknown as {fetch: unknown}).fetch = (async (_url: string | URL, init?: {body?: string}) => {
      const method = (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?';
      calls.push({method, body: init?.body ?? ''});
      let result: unknown = null;
      if (method === 'eth_chainId') result = '0x1';
      else if (method === 'eth_estimateGas') result = '0x5208'; // 21000
      else if (method === 'eth_getTransactionCount') result = '0x5';
      else if (method === 'eth_maxPriorityFeePerGas') result = '0x1';
      else if (method === 'eth_gasPrice') result = '0xa';
      else if (method === 'eth_sendRawTransaction') result = '0x' + 'ab'.repeat(32);
      else throw new Error(`unexpected rpc ${method}`);
      return {
        ok: true,
        status: 200,
        headers: {get: () => null},
        text: async () => JSON.stringify({jsonrpc: '2.0', id: 1, result}),
        json: async () => ({jsonrpc: '2.0', id: 1, result}),
      } as unknown as Response;
    }) as typeof fetch;
    return calls;
  }

  test('param-fill + deterministic sign + broadcast of EXACTLY the locally-signed bytes', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    setEvmRpcUrl('http://127.0.0.1:8545');
    const calls = routeFill();
    const to = OTHER_ADDRESS;
    // The dApp omits nonce, gas, and every fee field - all five fill from the chain.
    const request = fakeRequest(16, 'eth_sendTransaction', [{from: DEVICE, to, value: '0x2386f26fc10000', data: ''}]);
    const out = await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });

    // The chain was ASKED for exactly the omitted fields (the relay-proxy path, one call each).
    expect(calls.map((c) => c.method)).toEqual([
      'eth_chainId', // the wrong-chain guard
      'eth_estimateGas',
      'eth_getTransactionCount',
      'eth_maxPriorityFeePerGas',
      'eth_gasPrice',
      'eth_sendRawTransaction',
    ]);

    // Recompute the fill INDEPENDENTLY from the mocked answers: 21000 + 20% + 1 = 25201;
    // priority 1, baseFee 10 -> maxFee 2*10+1 = 21. Deterministic RFC 6979 signing pins the bytes.
    const signed = signEip1559Tx({
      chainId: 1,
      nonce: 5,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 21n,
      gasLimit: 25201n,
      to,
      value: 0x2386f26fc10000n,
    }, DEVICE_KEY);
    const rawCall = calls.find((c) => c.method === 'eth_sendRawTransaction')!;
    expect((JSON.parse(rawCall.body) as {params: [string]}).params[0]).toBe(toHex0x(signed.raw));

    // The dApp's answer is OUR hash - submitted, NOT settled.
    expect(out.submittedHash).toBe(toHex0x(signed.txHash));
    expect(responsesOf(kit)[0]!.response).toEqual({id: 16, jsonrpc: '2.0', result: toHex0x(signed.txHash)});
  });

  test('gasPrice on the request -> a LEGACY tx, no fee reads', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    setEvmRpcUrl('http://127.0.0.1:8545');
    const calls = routeFill();
    const request = fakeRequest(17, 'eth_sendTransaction', [{from: DEVICE, to: OTHER_ADDRESS, value: '0x1', gasPrice: '0x14', nonce: '0x0'}]);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    // gasPrice on the request -> the legacy signer, and NO fee reads (no 1559 arithmetic). The
    // wrong-chain guard's eth_chainId read is MEMOIZED per session (the send path's discipline),
    // so it ran once in the previous test and does not reappear here.
    expect(calls.map((c) => c.method)).toEqual(['eth_estimateGas', 'eth_sendRawTransaction']);
  });

  test('KNOWN calldata (ERC-20 transfer) decodes to structured rows; UNKNOWN calldata warns', () => {
    const summaryTransfer = summarizeWcRequest(
      fakeRequest(18, 'eth_sendTransaction', [{from: DEVICE, to: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC', data: toHex0x(encodeTransfer(OTHER_ADDRESS, 1234500000000000000n))}]),
      {activeChain: 'eip155:1', evmAddress: DEVICE},
    );
    const review = summaryTransfer.review as Extract<WcRequestSummary['review'], {kind: 'tx'}>;
    expect(review.unknownCall).toBe(false);
    expect(review.rows).toEqual([
      // The decode reads the calldata word, so the address comes back lowercase-hex.
      {key: 'to', value: OTHER_ADDRESS.toLowerCase()},
      {key: 'amount', value: '1234500000000000000'},
    ]);

    const summaryUnknown = summarizeWcRequest(
      fakeRequest(19, 'eth_sendTransaction', [{from: DEVICE, to: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC', data: '0xdeadbeef' + 'ff'.repeat(64)}]),
      {activeChain: 'eip155:1', evmAddress: DEVICE},
    );
    const unknown = summaryUnknown.review as Extract<WcRequestSummary['review'], {kind: 'tx'}>;
    expect(unknown.unknownCall).toBe(true);
    expect(unknown.rows).toEqual([]);
  });

  test('contract creation (no `to`) is unsupported - refused by name, never opened', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(20, 'eth_sendTransaction', [{from: DEVICE, data: '0x6080'}]));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    const err = (answers[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32601);
  });

  test('the EVM endpoint not configured -> the approve THROWS (sheet stays open), the dApp gets nothing', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = fakeRequest(21, 'eth_sendTransaction', [{from: DEVICE, to: OTHER_ADDRESS, value: '0x1'}]);
    await expect(approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    })).rejects.toThrow(/not configured/);    expect(responsesOf(kit)).toHaveLength(0);
  });
});

describe('unsupported methods fail closed', () => {
  test('a method outside the approved namespace answers -32601 without opening the sheet', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(fakeRequest(22, 'eth_sign' as string, ['0x00', DEVICE]));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect((answers[0]!.response as {error: {code: number}}).error.code).toBe(-32601);
  });
});
