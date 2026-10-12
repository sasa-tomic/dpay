// Track S step 6 tests (docs/specs/2026-10-12-walletconnect-integration-plan.md): decoder golden
// vectors for the WC Solana review surface, the solana_signMessage base58 primitive vector, and
// the conformance pin (the advertised method list never exceeds the implemented set).
//
// Fixtures are REAL serialized messages built with the repo's own tx-construction helpers
// (assembleMessage + the instruction builders) — no hand-patched bytes except where the test
// names the byte it is pinning (v0 version byte, signature slots). Deterministic, no network.

import { describe, test, expect } from '@jest/globals';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import {
  assembleMessage,
  buildSolTransferInstruction,
  buildMemoInstruction,
  base58Decode32,
  bytesToHex,
  hexToBytes,
  type Instruction,
} from '../solana/tx';
import { buildSplTransferInstruction, buildTransferCheckedInstruction } from '../solana/spl';
import { deriveSolanaKeypair } from '../solana/identity';
import { utf8ToBytes } from '../lib/base64url';
import {
  decodeWcSolanaTx,
  SOLANA_V1_METHODS,
  SOLANA_METHODS_OUTSIDE_V1,
  SOLANA_MAINNET_CAIP2,
} from '../solana/wcDecode';

const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const KP = deriveSolanaKeypair(SEED_HEX);
const SECOND = deriveSolanaKeypair('bb'.repeat(32));
const THIRD = deriveSolanaKeypair('cc'.repeat(32));
const BLOCKHASH = new Uint8Array(32).fill(7);
const TO_ADDRESS = '11111111111111111111111111111112';

/** Arbitrary non-key account bytes (an ATA/mint/program stand-in — never a signer). */
const pub = (n: number): Uint8Array => new Uint8Array(32).fill(n);

/** A full serialized tx wire: compact-u16(count) || count*64B signature (slot order) || message.
 *  Zero-length seeds array is not allowed here — decode rejects a 0 sig count. */
function signWire(msg: Uint8Array, seeds: Uint8Array[]): Uint8Array {
  const out: number[] = [seeds.length];
  for (const s of seeds) for (const b of ed25519.sign(msg, s)) out.push(b);
  for (const b of msg) out.push(b);
  return new Uint8Array(out);
}

const transferIx = (from: Uint8Array, to: string, lamports: bigint): Instruction =>
  buildSolTransferInstruction(from, base58Decode32(to), lamports);

// ============================================================================
// System transfer
// ============================================================================
describe('decodeWcSolanaTx — System transfer', () => {
  test('decodes from/to/lamports and exposes fee payer + signers', () => {
    const msg = assembleMessage(KP.publicKey, [transferIx(KP.publicKey, TO_ADDRESS, 12345n)], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded).not.toBeNull();
    expect(decoded!.feePayer).toBe(KP.address);
    expect(decoded!.signers).toEqual([KP.address]);
    expect(decoded!.requiredSignatures).toBe(1);
    expect(decoded!.legacy).toBe(true);
    expect(decoded!.hasUnknown).toBe(false);
    expect(decoded!.instructions).toEqual([
      {
        kind: 'systemTransfer',
        programId: '11111111111111111111111111111111',
        from: KP.address,
        to: TO_ADDRESS,
        lamports: 12345n,
      },
    ]);
  });

  test('exact bigint amounts survive (u64 above Number.MAX_SAFE_INTEGER)', () => {
    const huge = 2n ** 53n + 7n; // 9007199254741001 — unsafe as a JS number
    const msg = assembleMessage(KP.publicKey, [transferIx(KP.publicKey, TO_ADDRESS, huge)], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions[0]).toMatchObject({kind: 'systemTransfer', lamports: huge});
  });
});

// ============================================================================
// SPL transferChecked + raw transfer
// ============================================================================
describe('decodeWcSolanaTx — SPL token transfers', () => {
  test('transferChecked decodes mint/source/dest/owner/amount/decimals', () => {
    const ix = buildTransferCheckedInstruction(pub(1), pub(2), pub(3), SECOND.publicKey, 1_000_000n, 6);
    // The owner (SECOND) is a required signer beside the fee payer — both slots are filled.
    const msg = assembleMessage(KP.publicKey, [ix], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed, SECOND.seed]));
    expect(decoded!.instructions).toEqual([
      {
        kind: 'splTransferChecked',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        source: bs58.encode(pub(1)),
        mint: bs58.encode(pub(2)),
        destination: bs58.encode(pub(3)),
        owner: SECOND.address,
        amount: 1_000_000n,
        decimals: 6,
      },
    ]);
    expect(decoded!.hasUnknown).toBe(false);
  });

  test('raw transfer decodes amount + parties, mint honestly null (not in the instruction)', () => {
    const ix = buildSplTransferInstruction(pub(1), pub(3), SECOND.publicKey, 777n);
    const msg = assembleMessage(KP.publicKey, [ix], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed, SECOND.seed]));
    expect(decoded!.instructions).toEqual([
      {
        kind: 'splTransfer',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        source: bs58.encode(pub(1)),
        destination: bs58.encode(pub(3)),
        owner: SECOND.address,
        amount: 777n,
        mint: null,
      },
    ]);
  });

  test('a token instruction with a short data body falls to the raw fallback (never guesses)', () => {
    // transferChecked needs 10 data bytes; 9 is a malformed shape → unknown, not a guess.
    const ix = buildTransferCheckedInstruction(pub(1), pub(2), pub(3), SECOND.publicKey, 5n, 6);
    const truncated: Instruction = {...ix, data: ix.data.subarray(0, 9)};
    const msg = assembleMessage(KP.publicKey, [truncated], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed, SECOND.seed]));
    expect(decoded!.instructions[0].kind).toBe('unknown');
    expect(decoded!.hasUnknown).toBe(true);
  });
});

// ============================================================================
// Memo
// ============================================================================
describe('decodeWcSolanaTx — memo', () => {
  test('valid UTF-8 memo decodes to text + hex', () => {
    const msg = assembleMessage(KP.publicKey, [buildMemoInstruction(utf8ToBytes('table 7'))], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions[0]).toEqual({
      kind: 'memo',
      programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      text: 'table 7',
      dataHex: bytesToHex(utf8ToBytes('table 7')),
    });
  });

  test('non-UTF-8 memo bytes render text null behind the hex (no mangled guess)', () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00]);
    const msg = assembleMessage(KP.publicKey, [buildMemoInstruction(raw)], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions[0]).toMatchObject({kind: 'memo', text: null, dataHex: 'fffe00'});
  });
});

// ============================================================================
// Multi-instruction ordering + the raw fallback
// ============================================================================
describe('decodeWcSolanaTx — instruction order and unknown fallback', () => {
  test('multi-instruction tx keeps wire order (memo ix0, transfer ix1)', () => {
    const msg = assembleMessage(
      KP.publicKey,
      [buildMemoInstruction(utf8ToBytes('dpay-solreq-v2:ab')), transferIx(KP.publicKey, TO_ADDRESS, 5n)],
      BLOCKHASH,
    );
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions.map(ix => ix.kind)).toEqual(['memo', 'systemTransfer']);
  });

  test('unknown program → raw fallback with program id, accounts, data hex, explicit warning', () => {
    const ix: Instruction = {
      programId: pub(9),
      keys: [{pubkey: pub(4), signer: false, writable: true}],
      data: new Uint8Array([1, 2, 3]),
    };
    const msg = assembleMessage(KP.publicKey, [ix], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions[0]).toEqual({
      kind: 'unknown',
      programId: bs58.encode(pub(9)),
      accounts: [bs58.encode(pub(4))],
      dataHex: '010203',
      warning: expect.stringMatching(/not decoded/),
    });
    expect(decoded!.hasUnknown).toBe(true);
  });

  test('a structured instruction beside an unknown one still decodes; hasUnknown flags the tx', () => {
    const unknown: Instruction = {
      programId: pub(9),
      keys: [],
      data: new Uint8Array([9]),
    };
    const msg = assembleMessage(
      KP.publicKey,
      [transferIx(KP.publicKey, TO_ADDRESS, 5n), unknown],
      BLOCKHASH,
    );
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed]));
    expect(decoded!.instructions[0].kind).toBe('systemTransfer');
    expect(decoded!.instructions[1].kind).toBe('unknown');
    expect(decoded!.hasUnknown).toBe(true);
  });
});

// ============================================================================
// Fee payer + signer exposure (the displayed-else-refuse law's data)
// ============================================================================
describe('decodeWcSolanaTx — fee payer / signer exposure', () => {
  test('a tx with a second required signer lists BOTH, fee payer still key[0]', () => {
    const ownerIx = buildSplTransferInstruction(pub(1), pub(3), SECOND.publicKey, 5n);
    const msg = assembleMessage(KP.publicKey, [ownerIx], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [KP.seed, SECOND.seed]));
    expect(decoded!.requiredSignatures).toBe(2);
    expect(decoded!.feePayer).toBe(KP.address);
    expect(decoded!.signers).toEqual([KP.address, SECOND.address]);
  });

  test('a sponsored tx (the sender IS the fee payer) names the sponsor up front', () => {
    const msg = assembleMessage(THIRD.publicKey, [transferIx(THIRD.publicKey, TO_ADDRESS, 1n)], BLOCKHASH);
    const decoded = decodeWcSolanaTx(signWire(msg, [THIRD.seed]));
    expect(decoded!.feePayer).toBe(THIRD.address);
    expect(decoded!.signers).toEqual([THIRD.address]);
  });
});

// ============================================================================
// v0 (versioned) messages — static keys only
// ============================================================================
describe('decodeWcSolanaTx — v0 messages', () => {
  test('a v0 message decodes legacy=false from its static keys', () => {
    const msg = assembleMessage(KP.publicKey, [transferIx(KP.publicKey, TO_ADDRESS, 42n)], BLOCKHASH);
    // Versioned wire: version byte 0x80 prefixes the same header/account/ix layout.
    const wire = new Uint8Array([1, ...new Array(64).fill(0), 0x80, ...msg]);
    const decoded = decodeWcSolanaTx(wire);
    expect(decoded!.legacy).toBe(false);
    expect(decoded!.instructions[0]).toMatchObject({kind: 'systemTransfer', lamports: 42n});
  });

  test('an instruction whose program id sits beyond the static keys → unknown with null programId', () => {
    // Hand-built v0 message: header | 1 key | blockhash | 1 ix referencing index 200 (an ALT key).
    const parts: number[] = [0x80, 1, 0, 0, 1];
    for (const b of KP.publicKey) parts.push(b);
    for (let i = 0; i < 32; i++) parts.push(0);
    parts.push(1, 200, 0, 1, 0); // 1 ix: programIdIndex 200, 0 accounts, 1 data byte [0]
    const wire = new Uint8Array([1, ...new Array(64).fill(0), ...parts]);
    const decoded = decodeWcSolanaTx(wire);
    expect(decoded!.legacy).toBe(false);
    expect(decoded!.instructions[0]).toMatchObject({kind: 'unknown', programId: null});
    expect(decoded!.hasUnknown).toBe(true);
  });
});

// ============================================================================
// Malformed layouts — pure + total, null never throws
// ============================================================================
describe('decodeWcSolanaTx — malformed inputs', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['zero sig count', new Uint8Array([0])],
    ['ascii garbage', new Uint8Array(Array.from('not-a-tx').map(c => c.charCodeAt(0)))],
    ['truncated account table', (() => {
      const msg = assembleMessage(KP.publicKey, [transferIx(KP.publicKey, TO_ADDRESS, 1n)], BLOCKHASH);
      return signWire(msg, [KP.seed]).subarray(0, 80);
    })()],
  ];
  for (const [label, wire] of cases) {
    test(`returns null on ${label}`, () => {
      expect(decodeWcSolanaTx(wire)).toBeNull();
    });
  }

  test('a wire whose signature count disagrees with the header is refused', () => {
    const msg = assembleMessage(KP.publicKey, [transferIx(KP.publicKey, TO_ADDRESS, 1n)], BLOCKHASH);
    // 2 wire slots but a 1-signer header: the bytes do not parse honestly.
    const wire = new Uint8Array([2, ...new Array(128).fill(0), ...msg]);
    expect(decodeWcSolanaTx(wire)).toBeNull();
  });
});

// ============================================================================
// solana_signMessage primitive — base58 golden vector (plan §Track S step 6)
// ============================================================================
describe('solana_signMessage primitive', () => {
  // Golden: @noble ed25519 over the golden seed, base58 in/out — exactly what the wiring lane's
  // solana_signMessage does (plain ed25519 over the provided bytes; the off-chain message format
  // is a dApp-side construction, not a wallet obligation).
  const MESSAGE_UTF8 = 'dpay-wc-sign-message';
  const SIG_B58 = '5tWr6n6VP2CcTgNcwKdurKjQKPWdFerSo2mcx2CiD2oB3vJQu5Jy2z83SkT3W7QnEy6jC2oujDBYTeSYeZrQdkSg';
  const PUB_B58 = 'GZxCddJS7SVYHcPtu7ZY8CC89tEy3xLZJxsWAyGBWFxD';
  const MSG_B58 = '2QAC5m3YwjxV9n5dXGcjxg8M2Y12';

  test('ed25519 over the golden seed base58-encodes to the golden signature', () => {
    const seed = hexToBytes(SEED_HEX);
    expect(seed).not.toBeNull();
    const sig = ed25519.sign(utf8ToBytes(MESSAGE_UTF8), seed!);
    expect(bs58.encode(sig)).toBe(SIG_B58);
  });

  test('the golden signature verifies against the golden pubkey and the base58 message round-trips', () => {
    const msg = bs58.decode(MSG_B58);
    expect(new TextDecoder().decode(msg)).toBe(MESSAGE_UTF8);
    expect(ed25519.verify(bs58.decode(SIG_B58), msg, bs58.decode(PUB_B58))).toBe(true);
  });
});

// ============================================================================
// Conformance pin — advertised <= implemented (plan §Track S step 4 + 6)
// ============================================================================
describe('Solana v1 method conformance pin', () => {
  test('v1 advertises exactly the four implemented methods', () => {
    expect([...SOLANA_V1_METHODS]).toEqual([
      'solana_getAccounts',
      'solana_requestAccounts',
      'solana_signMessage',
      'solana_signAndSendTransaction',
    ]);
  });

  test('solana_signAllTransactions is pinned OUT of v1, with the plan reason attached', () => {
    expect(SOLANA_V1_METHODS).not.toContain('solana_signAllTransactions');
    expect(SOLANA_METHODS_OUTSIDE_V1.map(m => m.method)).toEqual(['solana_signAllTransactions']);
    for (const m of SOLANA_METHODS_OUTSIDE_V1) expect(m.reason.length).toBeGreaterThan(0);
  });

  test('every advertised method is a namespaced solana_ call', () => {
    for (const m of SOLANA_V1_METHODS) expect(m.startsWith('solana_')).toBe(true);
  });

  test('the advertised chain is mainnet-beta CAIP-2 (plan §2.4)', () => {
    expect(SOLANA_MAINNET_CAIP2).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  });
});
