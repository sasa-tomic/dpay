/**
 * Phase 6 — ISOLATED legacy durable-nonce reclaim. Tests the PURE pieces (key derivation, account
 * inspection, withdraw-message builder) byte-exact against the @solana/web3.js golden
 * (.dev/sol-poc/11-withdraw-nonce-golden.mjs), and the ONLINE orchestrator against the in-memory RPC
 * stub simulator. Reclaim is NOT a payment path — these tests assert the reclaim module has zero
 * coupling to the payment code.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {hexToBytes} from '../lib/format';
import {bytesToBase64} from '../lib/base64';
import {deriveSolanaKeypair} from '../solana/identity';
import type {SolanaRpcStub} from '../solana/rpc';

// Mock solNoncePersist so we can assert clearSolNonce is invoked on absent + reclaimed. Scoped to
// this test file only. reclaim.ts statically imports clearSolNonce; the mock supplies a resolved
// promise so the `await clearSolNonce(...).catch(...)` chain never throws. Explicit jest.fn generics
// are required — without them jest.fn() infers a `never` return type and mockResolvedValue fails to type.
jest.mock('../services/solNoncePersist', () => ({
  __esModule: true,
  // An explicit async impl makes jest.fn infer Promise<void> (avoids the `never` return type that
  // breaks mockResolvedValue typing); no generic in the factory (babel-jest hoists jest.mock and
  // forbids out-of-scope references — a type-arg generic trips its parser).
  clearSolNonce: jest.fn(async () => undefined),
}));

// The mocked clearSolNonce for call assertions.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {clearSolNonce}: {clearSolNonce: jest.Mock} = require('../services/solNoncePersist');

afterEach(() => {
  jest.clearAllMocks();
  delete (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub}).__DPAY_TEST_SOLANA_RPC_STUB;
});

// --- golden fixtures (from .dev/sol-poc/11-withdraw-nonce-golden.mjs) ---
// Deterministic 32-byte seeds (0x11 / 0x22); the builder takes raw pubkey bytes, so no SLIP-10
// derivation is needed for the byte-exact assertion — that isolates the builder from key derivation.
const MAIN_WALLET_PUBKEY_HEX = 'd04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737';
const NONCE_ACCOUNT_PUBKEY_HEX = 'a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0';
const BLOCKHASH_HEX = 'e734ea6c2b6257de72355e472aa05a4c487e6b463c029ed306df2f01b5636b58';
const GOLDEN_LAMPORTS = 1_447_680n;
// WithdrawNonceAccount message compiled by @solana/web3.js v1.98.4 (217 bytes). Pasted VERBATIM from
// the golden generator output to avoid hand-assembly errors. Account-table order (assembleMessage
// sort): [0]=mainWallet(signer,W), [1]=nonceAccount(W), [2]=SystemProgram, [3]=SysvarRecentBlockhashes,
// [4]=SysvarRent. Instruction account indices [1,0,3,4,0] = nonceAccount, dest(mainWallet),
// SysvarBH, SysvarRent, authority(mainWallet, deduped to [0]).
const GOLDEN_MESSAGE_HEX =
  '01000305' +
  MAIN_WALLET_PUBKEY_HEX +
  NONCE_ACCOUNT_PUBKEY_HEX +
  '0000000000000000000000000000000000000000000000000000000000000000' + // SystemProgram (111...111)
  '06a7d517192c568ee08a845f73d29788cf035c3145b21ab344d8062ea9400000' + // SysvarRecentBlockhashes
  '06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000' + // SysvarRent
  BLOCKHASH_HEX +
  '01' + // 1 instruction
  '02' + // programId index 2 (SystemProgram)
  '05' + // 5 account indices
  '0100030400' + // account indices: 1,0,3,4,0 (nonceAccount, mainWallet-dest, sysvarBH, sysvarRent, mainWallet-auth)
  '0c' + // data length 12
  '050000000017160000000000'; // u32(5) WithdrawNonce discriminator + u64(1447680)
const GOLDEN_SIGNATURE_HEX = '03ace0f7a4ac059f6226657120afdf22146a924ecf01a56f154a603c342fbd974eb2f3eeb2efbdf0d08842d65236154733e0a05e4fc36c30ab8b65770308620d';

// 32-byte main-wallet seed the golden signed with (0x11 × 32) — for the signTransaction assertion.
const MAIN_WALLET_SEED_HEX = '11'.repeat(32);

// A recovery seed for the orchestrator tests (deterministic; its SLIP-10 main-wallet key is the
// authority we encode into the stub's nonce-account data).
const RECLAIM_SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

const toHex = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
};

// Build an 80-byte NonceAccount data blob: u32 version | u32 state | 32B authority | 32B nonce | u64 fee.
function buildNonceAccountData(opts: {
  version?: number;
  state?: number;
  authority: Uint8Array;
  nonceValue?: Uint8Array;
  fee?: bigint;
}): Uint8Array {
  const out = new Uint8Array(80);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, opts.version ?? 0, true);
  dv.setUint32(4, opts.state ?? 1, true);
  out.set(opts.authority, 8);
  out.set(opts.nonceValue ?? hexToBytes(BLOCKHASH_HEX), 40);
  dv.setBigUint64(72, opts.fee ?? 5000n, true);
  return out;
}

// ===========================================================================
// buildWithdrawNonceMessage — byte-exact vs the @solana/web3.js golden
// ===========================================================================
describe('buildWithdrawNonceMessage — golden byte-exactness', () => {
  test('matches the @solana/web3.js nonceWithdraw message byte-for-byte', async () => {
    const {buildWithdrawNonceMessage} = await import('../solana/reclaim');
    const msg = buildWithdrawNonceMessage(
      hexToBytes(MAIN_WALLET_PUBKEY_HEX),
      hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX),
      GOLDEN_LAMPORTS,
      hexToBytes(BLOCKHASH_HEX),
    );
    expect(toHex(msg)).toBe(GOLDEN_MESSAGE_HEX);
    expect(msg.length).toBe(217);
  });

  test('signTransaction over the golden message reproduces the golden signature', async () => {
    const {buildWithdrawNonceMessage} = await import('../solana/reclaim');
    const {signTransaction} = await import('../solana/tx');
    const msg = buildWithdrawNonceMessage(
      hexToBytes(MAIN_WALLET_PUBKEY_HEX),
      hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX),
      GOLDEN_LAMPORTS,
      hexToBytes(BLOCKHASH_HEX),
    );
    const signed = signTransaction(msg, hexToBytes(MAIN_WALLET_SEED_HEX));
    // wire = compact-u16(1) || signature(64) || message
    expect(toHex(signed.subarray(1, 65))).toBe(GOLDEN_SIGNATURE_HEX);
    expect(toHex(signed.subarray(65))).toBe(GOLDEN_MESSAGE_HEX);
  });

  test('mutations produce a DIFFERENT message (no accidental golden collision)', async () => {
    const {buildWithdrawNonceMessage} = await import('../solana/reclaim');
    const golden = toHex(
      buildWithdrawNonceMessage(
        hexToBytes(MAIN_WALLET_PUBKEY_HEX),
        hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX),
        GOLDEN_LAMPORTS,
        hexToBytes(BLOCKHASH_HEX),
      ),
    );
    const main = hexToBytes(MAIN_WALLET_PUBKEY_HEX);
    const nonce = hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX);
    const bh = hexToBytes(BLOCKHASH_HEX);
    const cases: Array<[string, () => Uint8Array]> = [
      ['changed lamports', () => buildWithdrawNonceMessage(main, nonce, GOLDEN_LAMPORTS + 1n, bh)],
      ['halved lamports', () => buildWithdrawNonceMessage(main, nonce, GOLDEN_LAMPORTS / 2n, bh)],
      ['wrong authority/destination (main wallet bytes swapped)', () => buildWithdrawNonceMessage(nonce, main, GOLDEN_LAMPORTS, bh)],
      ['wrong nonce account', () => buildWithdrawNonceMessage(main, main, GOLDEN_LAMPORTS, bh)],
      ['wrong blockhash', () => buildWithdrawNonceMessage(main, nonce, GOLDEN_LAMPORTS, hexToBytes('00'.repeat(32)))],
    ];
    for (const [label, build] of cases) {
      const produced = toHex(build());
      if (produced === golden) throw new Error(`${label}: mutation must differ from golden but matched`);
    }
  });

  test('rejects negative lamports', async () => {
    const {buildWithdrawNonceMessage} = await import('../solana/reclaim');
    expect(() =>
      buildWithdrawNonceMessage(hexToBytes(MAIN_WALLET_PUBKEY_HEX), hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX), -1n, hexToBytes(BLOCKHASH_HEX)),
    ).toThrow('non-negative');
  });
});

// ===========================================================================
// inspectNonceAccount — every kind, never throws
// ===========================================================================
describe('inspectNonceAccount — pure parser, every kind mapped', () => {
  const authority = hexToBytes(MAIN_WALLET_PUBKEY_HEX);

  test('null data → absent', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    expect(inspectNonceAccount(null, 1000n, authority)).toEqual({kind: 'absent'});
  });

  test('Initialized, device-authority, version 0 (legacy) → reclaimable', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({version: 0, state: 1, authority});
    expect(inspectNonceAccount(data, 1_447_680n, authority)).toEqual({kind: 'reclaimable', lamports: 1_447_680n});
  });

  test('Initialized, device-authority, version 1 (current) → reclaimable (version-agnostic)', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({version: 1, state: 1, authority});
    expect(inspectNonceAccount(data, 500n, authority)).toEqual({kind: 'reclaimable', lamports: 500n});
  });

  test('Uninitialized (state 0) → uninitialized', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({state: 0, authority});
    expect(inspectNonceAccount(data, 1000n, authority)).toEqual({kind: 'uninitialized'});
  });

  test('wrong authority → wrong-authority', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({authority: hexToBytes(NONCE_ACCOUNT_PUBKEY_HEX)});
    expect(inspectNonceAccount(data, 1000n, authority)).toEqual({kind: 'wrong-authority'});
  });

  test('wrong length (79 / 81 bytes) → malformed', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    expect(inspectNonceAccount(new Uint8Array(79), 1000n, authority)).toEqual({kind: 'malformed'});
    expect(inspectNonceAccount(new Uint8Array(81), 1000n, authority)).toEqual({kind: 'malformed'});
  });

  test('unknown version tag (2) → malformed (fail-closed on future layout)', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({version: 2, state: 1, authority});
    expect(inspectNonceAccount(data, 1000n, authority)).toEqual({kind: 'malformed'});
  });

  test('zero balance Initialized account → reclaimable with 0 lamports (drains to close)', async () => {
    const {inspectNonceAccount} = await import('../solana/reclaim');
    const data = buildNonceAccountData({authority});
    expect(inspectNonceAccount(data, 0n, authority)).toEqual({kind: 'reclaimable', lamports: 0n});
  });
});

// ===========================================================================
// deriveNonceAccountKeypair — determinism + divergence from the main wallet
// ===========================================================================
describe('deriveNonceAccountKeypair — determinism + isolation from the main wallet', () => {
  test('deterministic: same seed → same keypair across calls', async () => {
    const {deriveNonceAccountKeypair} = await import('../solana/reclaim');
    const a = deriveNonceAccountKeypair(RECLAIM_SEED_HEX);
    const b = deriveNonceAccountKeypair(RECLAIM_SEED_HEX);
    expect(toHex(a.seed)).toBe(toHex(b.seed));
    expect(toHex(a.publicKey)).toBe(toHex(b.publicKey));
    expect(a.address).toBe(b.address);
    expect(a.seed.length).toBe(32);
    expect(a.publicKey.length).toBe(32);
  });

  test('differs from the main wallet (m/44\'/501\'/0\'/0\') — different SLIP-10 path', async () => {
    const {deriveNonceAccountKeypair} = await import('../solana/reclaim');
    const nonceKp = deriveNonceAccountKeypair(RECLAIM_SEED_HEX);
    const mainKp = deriveSolanaKeypair(RECLAIM_SEED_HEX);
    expect(toHex(nonceKp.publicKey)).not.toBe(toHex(mainKp.publicKey));
    expect(nonceKp.address).not.toBe(mainKp.address);
  });
});

// ===========================================================================
// reclaimNonceAccount — ONLINE orchestrator against the RPC stub simulator
// ===========================================================================
// Configure the RPC URL inside an isolated module registry so reclaim.ts re-evaluates constants with
// a non-empty SOLANA_RPC_URL (otherwise it short-circuits to 'offline'). The stub global is set
// per-test; rpcFetch routes to it at call time regardless of module isolation. A UNIQUE url per call
// is required because rpc.ts caches the genesis hash per-URL at module scope BEFORE consulting the
// stub — a shared url would let an earlier test's cached genesis bypass a later test's stub.
let rpcUrlSeq = 0;
function withRpc<T>(stub: SolanaRpcStub, fn: (reclaim: typeof import('../solana/reclaim')) => Promise<T>): Promise<T> {
  const g = globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL: string; __DPAY_TEST_SOLANA_RPC_STUB?: SolanaRpcStub};
  g.__DPAY_TEST_SOLANA_RPC_STUB = stub;
  const url = `https://stub.test/${++rpcUrlSeq}`;
  let p: Promise<T> | undefined;
  jest.isolateModules(() => {
    g.__DPAY_TEST_SOLANA_RPC_URL = url;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    p = fn(require('../solana/reclaim'));
  });
  g.__DPAY_TEST_SOLANA_RPC_URL = '';
  return p!;
}

// Build a stub whose getAccountInfo returns a funded, device-authority nonce account. `sigStatus`
// is the raw getSignatureStatuses entry (default = confirmed); pass null for a never-confirming tx
// (timeout) or {err:...} for an on-chain failure.
function reclaimableAccountStub(opts: {
  lamports: number;
  mainBalance: number;
  sigStatus?: {confirmationStatus?: 'confirmed' | 'processed' | 'finalized'; err?: unknown} | null;
}): SolanaRpcStub {
  const main = deriveSolanaKeypair(RECLAIM_SEED_HEX);
  const accountData = buildNonceAccountData({version: 0, state: 1, authority: main.publicKey});
  let sent = '';
  return {
    getGenesisHash: () => MAINNET_GENESIS,
    getAccountInfo: () => ({value: {data: [bytesToBase64(accountData), 'base64'], owner: SYSTEM_PROGRAM_ADDRESS, lamports: opts.lamports, executable: false, rentEpoch: 0}}),
    getLatestBlockhash: () => ({context: {slot: 250_000_000}, value: {blockhash: 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u', lastValidBlockHeight: 300_000_000}}),
    getFeeForMessage: () => 5000,
    getBalance: () => ({value: opts.mainBalance}),
    sendTransaction: (params: unknown[]) => {
      sent = 'sig_' + String(params[0]).slice(0, 8);
      return sent;
    },
    getSignatureStatuses: () => ({context: {slot: 250_000_001}, value: [opts.sigStatus === undefined ? {confirmationStatus: 'confirmed'} : opts.sigStatus]}),
  };
}

describe('reclaimNonceAccount — offline short-circuit', () => {
  test('returns offline when SOLANA_RPC_URL is empty (no stub, no fetch)', async () => {
    // Default jest state: __DPAY_TEST_SOLANA_RPC_URL=''. Require without isolateModules.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {reclaimNonceAccount} = require('../solana/reclaim');
    const result = await reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal);
    expect(result).toEqual({kind: 'offline'});
    expect(clearSolNonce).not.toHaveBeenCalled();
  });
});

describe('reclaimNonceAccount — configured RPC paths', () => {
  test('absent account → clears stale storage + returns absent', async () => {
    const stub: SolanaRpcStub = {
      getGenesisHash: () => MAINNET_GENESIS,
      getAccountInfo: () => ({value: null}), // account does not exist
    };
    const result = await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(result).toEqual({kind: 'absent'});
    expect(clearSolNonce).toHaveBeenCalledTimes(1);
  });

  test('reclaimable → broadcasts + confirms → clears storage + returns reclaimed', async () => {
    const stub = reclaimableAccountStub({lamports: 1_447_680, mainBalance: 10_000_000});
    const result = await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(result.kind).toBe('reclaimed');
    if (result.kind === 'reclaimed') {
      expect(result.sig.startsWith('sig_')).toBe(true); // sendTransaction returned a deterministic sig
      expect(result.lamports).toBe(1_447_680n);
    }
    expect(clearSolNonce).toHaveBeenCalledTimes(1);
  });

  test('insufficient main-wallet balance for the fee → insufficient-fee (no broadcast)', async () => {
    const stub = reclaimableAccountStub({lamports: 1_447_680, mainBalance: 100}); // < 5000 fee
    const result = await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(result.kind).toBe('insufficient-fee');
    if (result.kind === 'insufficient-fee') {
      expect(result.fee).toBe(5000n);
      expect(result.balance).toBe(100n);
    }
    expect(clearSolNonce).not.toHaveBeenCalled();
  });

  test('confirm timeout → unknown (tx may still land — never a false failure)', async () => {
    // Status never reaches confirmed; tiny timeout so confirmTransaction throws quickly.
    const stub = reclaimableAccountStub({lamports: 1_447_680, mainBalance: 10_000_000, sigStatus: null});
    const result = await withRpc(stub, async (reclaim) =>
      reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal, {confirmTimeoutMs: 40, pollMs: 5}),
    );
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.lamports).toBe(1_447_680n);
      expect(typeof result.sig).toBe('string');
    }
    // NOT cleared on unknown — the tx may still land; keep the marker until a re-check confirms.
    expect(clearSolNonce).not.toHaveBeenCalled();
  });

  test('confirm on-chain error → error with message (definitive failure, funds still locked)', async () => {
    const stub = reclaimableAccountStub({lamports: 1_447_680, mainBalance: 10_000_000, sigStatus: {confirmationStatus: 'confirmed', err: {InstructionError: [0, 'InsufficientFunds']}}});
    const result = await withRpc(stub, async (reclaim) =>
      reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal, {confirmTimeoutMs: 40, pollMs: 5}),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('transaction failed');
    }
    expect(clearSolNonce).not.toHaveBeenCalled();
  });

  test('wrong cluster (genesis mismatch) → error, fail-closed before any broadcast', async () => {
    const stub: SolanaRpcStub = {
      getGenesisHash: () => 'DevnetDifferentGenesisHash1234567890123456789012345678',
      getAccountInfo: () => ({value: null}),
    };
    const result = await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('genesis mismatch');
    }
  });

  test('uninitialized nonce account → error (mapped from inspection), no broadcast', async () => {
    const main = deriveSolanaKeypair(RECLAIM_SEED_HEX);
    const data = buildNonceAccountData({state: 0, authority: main.publicKey}); // Uninitialized
    const stub: SolanaRpcStub = {
      getGenesisHash: () => MAINNET_GENESIS,
      getAccountInfo: () => ({value: {data: [bytesToBase64(data), 'base64'], owner: SYSTEM_PROGRAM_ADDRESS, lamports: 1_447_680, executable: false, rentEpoch: 0}}),
    };
    const result = await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('uninitialized');
    }
  });

  test('clearSolNonce is keyed by the IC identity pubkey (NOT the Solana address)', async () => {
    const stub = reclaimableAccountStub({lamports: 1_447_680, mainBalance: 10_000_000});
    await withRpc(stub, async (reclaim) => reclaim.reclaimNonceAccount(RECLAIM_SEED_HEX, new AbortController().signal));
    expect(clearSolNonce).toHaveBeenCalledTimes(1);
    const passedKey = clearSolNonce.mock.calls[0][0] as string;
    // The legacy storage key namespace was the IC identity publicHex (64 hex chars), not the Solana
    // base58 address — re-derived from the same seed here.
    expect(passedKey).toMatch(/^[0-9a-f]{64}$/);
    const main = deriveSolanaKeypair(RECLAIM_SEED_HEX);
    expect(passedKey).not.toBe(main.address);
  });
});

// ===========================================================================
// isolation — reclaim.ts has NO import from the payment code
// ===========================================================================
describe('reclaim module isolation', () => {
  test('reclaim.ts source has no import from qr / payments / payment components', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'solana', 'reclaim.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.(\.\/)?(qr|payments)['"]/);
    expect(src).not.toMatch(/from ['"][^'"]*(SolPayMode|SolReceiveMode|SolNfcTap)['"]/);
    // Positive: it DOES import the allowed modules.
    expect(src).toMatch(/from ['"]\.\/identity['"]/);
    expect(src).toMatch(/from ['"]\.\/tx['"]/);
    expect(src).toMatch(/from ['"]\.\.\/services\/solNoncePersist['"]/);
  });
});
