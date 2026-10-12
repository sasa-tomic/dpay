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
  solanaTxRows,
  type WcRequestSummary,
} from '../components/WcRequestSheet';
import {deriveEvmKeypair} from '../evm/identity';
import {signPersonal} from '../evm/personalSign';
import {signTypedData, type TypedData} from '../evm/typedData';
import {signEip1559Tx, toHex0x} from '../evm/tx';
import {encodeTransfer} from '../evm/abi';
import {bytesToHex, hexToBytes} from '../lib/format';
import {bytesToBase64} from '../lib/base64';
import {utf8ToBytes} from '../lib/base64url';
import {setEvmRpcUrl} from '../evm';
import {deriveSolanaKeypair} from '../solana/identity';
import {assembleMessage, buildSolTransferInstruction, base58Decode32, signVenueSwapTx, bytesToHex as solBytesToHex, buildMemoInstruction, type Instruction} from '../solana/tx';
import {buildTransferCheckedInstruction} from '../solana/spl';
import {decodeWcSolanaTx} from '../solana/wcDecode';
import {base64ToBytes} from '../lib/base64';
import bs58 from 'bs58';
import {ed25519} from '@noble/curves/ed25519';
import type {WcProposal, WcRequest, WcResponse} from '../walletkit';

const PROJECT_ID = 'test-wc-requests';
const SECRET_HEX = '11'.repeat(32);
const DEVICE_KEY = deriveEvmKeypair(SECRET_HEX).privateKey; // the SLIP-10-derived signing key
const DEVICE = deriveEvmKeypair(SECRET_HEX).address;
// The Solana identity derived from the SAME seed (m/44'/501'/0'/0') - what the solana namespace
// advertises and what every solana handler signs with.
const SOL_KP = deriveSolanaKeypair(SECRET_HEX);
const SOL_ADDR = SOL_KP.address;
const SOL_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

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
  (require('../config/constants') as typeof import('../config/constants')).setSolanaRpcUrl('');
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
function wireHandlers(mod: Loaded, state: HarnessState, solanaAddress: string | null = SOL_ADDR) {
  const proposalHandler = makeWcProposalHandler({
    isOpen: () => state.open,
    open: (proposal) => state.openedProposals.push(proposal),
    reject: (proposal) => mod.rejectSession(proposal),
  });
  const requestHandler = makeWcRequestHandler({
    evmAddress: DEVICE,
    solanaAddress,
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

// --- solana fixtures (Track S) -----------------------------------------------------------------------

const SECOND_KP = deriveSolanaKeypair('bb'.repeat(32));
const SOL_TO = '11111111111111111111111111111112';
const SOL_BLOCKHASH = new Uint8Array(32).fill(7);

/** A serialized UNSIGNED wire the way a dApp sends it: compact-u16 count || count zeroed 64-byte
 *  signature slots || message. */
function unsignedWire(msg: Uint8Array, sigCount: number): Uint8Array {
  const out: number[] = [sigCount];
  for (let i = 0; i < 64 * sigCount; i++) out.push(0);
  for (const b of msg) out.push(b);
  return new Uint8Array(out);
}

/** A one-signature System transfer paying FROM the device (the plain review case). */
function deviceTransferTx(): Uint8Array {
  const msg = assembleMessage(SOL_KP.publicKey, [buildSolTransferInstruction(SOL_KP.publicKey, base58Decode32(SOL_TO), 12345n)], SOL_BLOCKHASH);
  return unsignedWire(msg, 1);
}

/** A transfer owned by ANOTHER key entirely (fee payer + only required signer = SECOND): the
 *  external-fee-payer display and the not-a-required-signer refusal case. */
function otherOwnerTx(): Uint8Array {
  const msg = assembleMessage(SECOND_KP.publicKey, [buildSolTransferInstruction(SECOND_KP.publicKey, base58Decode32(SOL_TO), 12345n)], SOL_BLOCKHASH);
  return unsignedWire(msg, 1);
}

/** A transfer beside an instruction from a program the decoder does not know: the explicit
 *  unknown-warning case (structured row beside raw fallback, wire order kept). */
function unknownProgramTx(): Uint8Array {
  const arbitrary = new Uint8Array(32).fill(9);
  const unknownIx: Instruction = {programId: arbitrary, keys: [{pubkey: arbitrary, signer: false, writable: true}], data: new Uint8Array([1, 2, 3])};
  const msg = assembleMessage(SOL_KP.publicKey, [buildSolTransferInstruction(SOL_KP.publicKey, base58Decode32(SOL_TO), 1n), unknownIx], SOL_BLOCKHASH);
  return unsignedWire(msg, 1);
}

/** A transfer the device co-signs with SECOND (requiredSignatures = 2): the co-sign refusal case.
 *  A transferChecked whose owner (SECOND) is a required signer beside the fee payer (the device). */
function coSignedTx(): Uint8Array {
  const ix = buildTransferCheckedInstruction(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), SECOND_KP.publicKey, 1_000_000n, 6);
  const msg = assembleMessage(SOL_KP.publicKey, [ix], SOL_BLOCKHASH);
  return unsignedWire(msg, 2);
}

function solRequest(id: number, method: string, params: unknown): WcRequest {
  return fakeRequest(id, method, params, SOL_CHAIN);
}

/** The signAndSend fetch double: one sendTransaction answer, everything else refused loudly. */
function routeSolBroadcast(sig58: string): Array<{method: string; body: string}> {
  const calls: Array<{method: string; body: string}> = [];
  (globalThis as unknown as {fetch: unknown}).fetch = (async (_url: string | URL, init?: {body?: string}) => {
    const method = (JSON.parse(init?.body ?? '{}') as {method?: string}).method ?? '?';
    calls.push({method, body: init?.body ?? ''});
    if (method !== 'sendTransaction') throw new Error(`unexpected rpc ${method}`);
    return {
      ok: true,
      status: 200,
      headers: {get: () => null},
      text: async () => JSON.stringify({jsonrpc: '2.0', id: 1, result: sig58}),
      json: async () => ({jsonrpc: '2.0', id: 1, result: sig58}),
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

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
      solanaAddress: SOL_ADDR,
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
      solanaAddress: SOL_ADDR,
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
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

// =====================================================================================================
// Track S - the solana matrix (plan §Track S: approve->sign flows + refusals)
// =====================================================================================================

describe('solana_getAccounts / solana_requestAccounts (reads answer directly, no sheet)', () => {
  test('both reads answer the wallet solana address (base58); the sheet never opens', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(solRequest(30, 'solana_requestAccounts', {}));
    onRequest(solRequest(31, 'solana_getAccounts', []));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 30, jsonrpc: '2.0', result: [SOL_ADDR]});
    expect(answers[1]!.response).toEqual({id: 31, jsonrpc: '2.0', result: [SOL_ADDR]});
  });

  test('no solana identity: a typed refusal, NEVER an empty success', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state, null);
    onRequest(solRequest(32, 'solana_requestAccounts', {}));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const answers = responsesOf(kit);
    expect(answers[0]!.response).toEqual({id: 32, jsonrpc: '2.0', error: {code: -32603, message: 'No Solana account'}});
  });
});

describe('solana_signMessage', () => {
  test('approve: plain ed25519 over the EXACT base58-decoded bytes, base58 signature out', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const message = 'Hello solana';
    const request = solRequest(33, 'solana_signMessage', {pubkey: SOL_ADDR, message: bs58.encode(utf8ToBytes(message))});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    expect(summary.review.kind === 'solanaMessage' && summary.review.text).toBe(message); // UTF-8 preview
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = ed25519.sign(utf8ToBytes(message), SOL_KP.seed);
    expect(responsesOf(kit)[0]!.response).toEqual({id: 33, jsonrpc: '2.0', result: {signature: bs58.encode(expected)}});
  });

  test('non-UTF-8 message: the raw-bytes fallback preview, and the HEX bytes are what get signed', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const raw = new Uint8Array([0xff, 0x00, 0x81, 0x42]);
    const request = solRequest(34, 'solana_signMessage', {pubkey: SOL_ADDR, message: bs58.encode(raw)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaMessage'}>;
    expect(review.text).toBeNull(); // not reviewable text
    expect(review.hex).toBe(solBytesToHex(raw)); // the exact bytes shown as hex
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = ed25519.sign(raw, SOL_KP.seed);
    expect(responsesOf(kit)[0]!.response).toEqual({id: 34, jsonrpc: '2.0', result: {signature: bs58.encode(expected)}});
  });

  test('a different pubkey on the request: typed refusal, never signs', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const request = solRequest(35, 'solana_signMessage', {pubkey: SECOND_KP.address, message: bs58.encode(utf8ToBytes('x'))});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    expect(summary.review.kind === 'solanaMessage' && summary.review.signerMismatch).toBe(true);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const answers = responsesOf(kit);
    const err = (answers[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('different Solana address');
  });

  test('a message that is not base58: typed refusal, the sheet opens behind it', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(solRequest(36, 'solana_signMessage', {pubkey: SOL_ADDR, message: 'not-base58!!'}));
    await flush();
    expect(state.openedRequests).toHaveLength(1); // the sheet opens (the raw display law) ...
    await approveWcRequest({
      request: state.openedRequests[0]!, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('Malformed Solana message');
  });
});

describe('solana_signTransaction', () => {
  test('the venue-neutral rows: SPL transferChecked renders mint + decimal amount, memo renders text', () => {
    const source = new Uint8Array(32).fill(1);
    const mint = new Uint8Array(32).fill(2);
    const destination = new Uint8Array(32).fill(3);
    const ix = buildTransferCheckedInstruction(source, mint, destination, SECOND_KP.publicKey, 1_500_000n, 6);
    const memoIx = buildMemoInstruction(utf8ToBytes('note'));
    const msg = assembleMessage(SOL_KP.publicKey, [ix, memoIx], SOL_BLOCKHASH);
    const decoded = decodeWcSolanaTx(unsignedWire(msg, 2))!;
    const rows = solanaTxRows(decoded.instructions);
    expect(rows).toEqual([
      {key: 'from', value: bs58.encode(source)},
      {key: 'to', value: bs58.encode(destination)},
      {key: 'owner', value: SECOND_KP.address},
      {key: 'mint', value: bs58.encode(mint)},
      {key: 'amount', value: '1.5'}, // the wire's own decimals, honest
      {key: 'memo', value: 'note'},
    ]);
  });

  test('approve: signs ONLY the device slot, preserves every other byte, answers base64 (no broadcast)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const tx = deviceTransferTx();
    const request = solRequest(37, 'solana_signTransaction', {transaction: bytesToBase64(tx)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.malformed).toBeNull();
    expect(review.feePayer).toBe(SOL_ADDR);
    expect(review.signers).toEqual([SOL_ADDR]);
    expect(review.externalFeePayer).toBe(false);
    expect(review.deviceSigns).toBe(true);
    expect(review.coSigned).toBe(false);
    expect(review.unknown).toBe(false);
    expect(review.rows).toEqual([
      {key: 'from', value: SOL_ADDR},
      {key: 'to', value: SOL_TO},
      {key: 'amount', value: '0.000012345 SOL'},
    ]);
    const out = await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    expect(out).toEqual({submittedHash: null, switchedTo: null});
    const expected = signVenueSwapTx(tx, SOL_KP.seed)!;
    const result = (responsesOf(kit)[0]!.response as {result: string}).result;
    expect(responsesOf(kit)[0]!.response).toEqual({id: 37, jsonrpc: '2.0', result: bytesToBase64(expected.raw)});
    const resultBytes = base64ToBytes(result);
    // The message is byte-for-byte the wire's; exactly the device's signature slot was filled,
    // and it holds a valid ed25519 signature over the untouched message.
    expect(Array.from(resultBytes.slice(65))).toEqual(Array.from(tx.slice(65)));
    expect(Array.from(resultBytes.slice(0, 65))).not.toEqual(Array.from(tx.slice(0, 65)));
    expect(ed25519.verify(bs58.decode(expected.signature), resultBytes.slice(65), SOL_KP.publicKey)).toBe(true);
  });

  test('a transaction with an unknown program: the sheet opens behind the explicit warning; approve STILL signs (the user decides)', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const tx = unknownProgramTx();
    const request = solRequest(38, 'solana_signTransaction', {transaction: bytesToBase64(tx)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.unknown).toBe(true);
    expect(review.malformed).toBeNull();
    // The structured row beside the raw fallback, wire order kept.
    expect(review.rows.map((r) => r.key)).toEqual(['from', 'to', 'amount', 'program', 'data']);
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(request);
    await flush();
    expect(state.openedRequests).toEqual([request]); // opened, never auto-approved
    expect(responsesOf(kit)).toHaveLength(0); // NOTHING answers until a button press
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const expected = signVenueSwapTx(tx, SOL_KP.seed)!;
    expect(responsesOf(kit)[0]!.response).toEqual({id: 38, jsonrpc: '2.0', result: bytesToBase64(expected.raw)});
  });

  test('malformed bytes (not a transaction): warning + raw display, approve refuses typed', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const junk = bytesToBase64(new Uint8Array([9, 9, 9, 9]));
    const request = solRequest(39, 'solana_signTransaction', {transaction: junk});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.malformed).not.toBeNull();
    expect(review.rawBase64).toBe(junk);
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(request);
    await flush();
    expect(state.openedRequests).toEqual([request]); // the sheet opens behind the warning
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('Malformed transaction');
  });

  test('the instruction-array shape (deprecated upstream): refused by name before any sheet', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(solRequest(40, 'solana_signTransaction', {instructions: []}));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('instruction-array');
  });

  test('fee-payer-hidden: a params feePayer naming a DIFFERENT payer than the wire is refused', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const tx = deviceTransferTx(); // the wire's fee payer is the device
    const request = solRequest(41, 'solana_signTransaction', {transaction: bytesToBase64(tx), feePayer: SECOND_KP.address});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.feePayerHidden).toBe(true);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('different fee payer');
  });

  test('device-not-required-signer: the external-owned tx refuses whole, never partial-signs', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const tx = otherOwnerTx(); // fee payer + only signer = SECOND; the device is not in it
    const request = solRequest(42, 'solana_signTransaction', {transaction: bytesToBase64(tx)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.feePayer).toBe(SECOND_KP.address);
    expect(review.externalFeePayer).toBe(true);
    expect(review.deviceSigns).toBe(false);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('not a required signer');
  });

  test('co-signed tx (another required signer beside the device): refused whole by DEFAULT, never silently co-signed', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const tx = coSignedTx();
    const request = solRequest(43, 'solana_signTransaction', {transaction: bytesToBase64(tx)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.coSigned).toBe(true);
    expect(review.deviceSigns).toBe(true);
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('needs other signers');
    expect(responsesOf(kit)).toHaveLength(1); // nothing was signed or broadcast
  });
});

describe('solana_signAndSendTransaction', () => {
  test('approve: review + guards, then the app broadcast path; the signature is the submitted-not-settled answer', async () => {
    const sig58 = bs58.encode(new Uint8Array(64).fill(3));
    // The runtime operator slot (read per call), pointing the broadcast at the fetch double.
    (require('../config/constants') as typeof import('../config/constants')).setSolanaRpcUrl('https://127.0.0.1:8999');
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const calls = routeSolBroadcast(sig58);
    const tx = deviceTransferTx();
    const request = solRequest(44, 'solana_signAndSendTransaction', {transaction: bytesToBase64(tx)});
    const summary = summarizeWcRequest(request, {activeChain: 'eip155:1', evmAddress: DEVICE, solanaAddress: SOL_ADDR});
    const review = summary.review as Extract<WcRequestSummary['review'], {kind: 'solanaTx'}>;
    expect(review.send).toBe(true);
    const out = await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    // The submitted-not-settled terminal: the signature hash, no receipt poll.
    expect(out).toEqual({submittedHash: sig58, switchedTo: null});
    expect(responsesOf(kit)[0]!.response).toEqual({id: 44, jsonrpc: '2.0', result: sig58});
    // Broadcast went through the app's own path (skipPreflight posture) with EXACTLY the
    // locally-signed bytes.
    const expected = signVenueSwapTx(tx, SOL_KP.seed)!;
    const sends = calls.filter((c) => c.method === 'sendTransaction');
    expect(sends).toHaveLength(1);
    const params = (JSON.parse(sends[0]!.body) as {params: unknown[]}).params;
    expect(params[0]).toBe(bytesToBase64(expected.raw));
  });

  test('a co-signed send refuses typed and NEVER reaches the network', async () => {
    (require('../config/constants') as typeof import('../config/constants')).setSolanaRpcUrl('https://127.0.0.1:8999');
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const calls = routeSolBroadcast(bs58.encode(new Uint8Array(64).fill(4)));
    const request = solRequest(45, 'solana_signAndSendTransaction', {transaction: bytesToBase64(coSignedTx())});
    await approveWcRequest({
      request, secretHex: SECRET_HEX, evmAddress: DEVICE, solanaAddress: SOL_ADDR, activeChain: 'eip155:1',
      unsupportedChains: mod.wcUnsupportedChains(),
      respond: (topic, response) => mod.respondSessionRequest(topic, response),
    });
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toContain('needs other signers');
    expect(calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(0);
  });
});

describe('solana_signAllTransactions (outside v1)', () => {
  test('refused by name with the plan reason, and the sheet never opens', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(solRequest(46, 'solana_signAllTransactions', {transactions: [bytesToBase64(deviceTransferTx())]}));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('solana_signAllTransactions');
    expect(err.message).toContain('batches');
  });
});

describe('the one-review-at-a-time law covers the solana surface too', () => {
  test('a solana request while the sheet is open answers USER_REJECTED 5000 immediately', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: true, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state);
    onRequest(solRequest(47, 'solana_signMessage', {pubkey: SOL_ADDR, message: bs58.encode(utf8ToBytes('x'))}));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    expect(responsesOf(kit)[0]!.response).toEqual({id: 47, jsonrpc: '2.0', error: {code: 5000, message: 'User rejected.'}});
  });

  test('a solana SIGNING request with no solana identity refuses typed before any sheet', async () => {
    const mod = load(PROJECT_ID);
    await mod.initWalletKit();
    const kit = mod.kit()!;
    const state: HarnessState = {open: false, openedRequests: [], openedProposals: []};
    const {onRequest} = wireHandlers(mod, state, null);
    onRequest(solRequest(48, 'solana_signTransaction', {transaction: bytesToBase64(deviceTransferTx())}));
    await flush();
    expect(state.openedRequests).toHaveLength(0);
    const err = (responsesOf(kit)[0]!.response as {error: {code: number; message: string}}).error;
    expect(err.code).toBe(-32603);
    expect(err.message).toBe('No Solana account');
  });
});
