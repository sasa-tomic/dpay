import { describe, test, expect } from '@jest/globals';
import { deriveSolanaKeypair, deriveSolanaAddress, deriveSlip10Ed25519, isValidSolanaAddress } from '../solana/identity';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// SLIP-0010 ed25519 OFFICIAL Test Vector 1 (authoritative ground truth from the spec). The master
// node and the m/0' hardened child are checked at the raw IL (private key) level, so the
// HMAC-SHA512 + hardened-derivation is proven against the reference, not just self-consistent. IL
// and IR are the two halves of one HMAC-SHA512 output, so a matching IL guarantees a matching IR.
const SLIP10_SEED = '000102030405060708090a0b0c0d0e0f';
const SPEC_M_IL = '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7';
const SPEC_M0H_IL = '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3';
const H = 0x80000000;

// Real test-seed golden for m/44'/501'/0'/0'. Leaf IL re-derived independently with Python stdlib
// hmac+sha512 (SLIP-10 spec vector also matches there); pubkey/address confirmed via noble ed25519
// and are self-consistent with the leaf (the tx golden in solana-tx.test.ts signs with this leaf).
const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const EXPECTED_LEAF_SEED_HEX = 'f0d968658b737ff28be65b9b5902dd9e070e8887d8a32ed1c30a86ee091a877a';
const EXPECTED_PUBKEY_HEX = '28b3588eeebf53152ed5ad420e105eb28ecccdff90f068884ac30cc8eb3d4f34';
const EXPECTED_ADDRESS = '3jsvVphLjwR6wih9fQydrRNGieNjYzyMkyTxFueCssaK';

describe('solana/identity — SLIP-10 official ed25519 test vector', () => {
  test('master private key (IL) matches SLIP-0010 reference', () => {
    const masterPriv = deriveSlip10Ed25519(hexToBytes(SLIP10_SEED), []);
    expect(toHex(masterPriv)).toBe(SPEC_M_IL);
  });

  test("m/0' private key (IL) matches SLIP-0010 reference", () => {
    const m0hPriv = deriveSlip10Ed25519(hexToBytes(SLIP10_SEED), [0 + H]);
    expect(toHex(m0hPriv)).toBe(SPEC_M0H_IL);
  });
});

describe('solana/identity — SLIP-10 ed25519 m/44\'/501\'/0\'/0\' (real seed)', () => {
  test('derives the verified leaf seed', () => {
    const kp = deriveSolanaKeypair(SEED_HEX);
    expect(toHex(kp.seed)).toBe(EXPECTED_LEAF_SEED_HEX);
  });

  test('derives the verified public key', () => {
    const kp = deriveSolanaKeypair(SEED_HEX);
    expect(toHex(kp.publicKey)).toBe(EXPECTED_PUBKEY_HEX);
  });

  test('derives the Phantom/Solflare-compatible base58 address', () => {
    expect(deriveSolanaAddress(SEED_HEX)).toBe(EXPECTED_ADDRESS);
  });

  test('is deterministic — same seed always yields the same address', () => {
    expect(deriveSolanaAddress(SEED_HEX)).toBe(deriveSolanaAddress(SEED_HEX));
  });

  test('different seeds yield different addresses', () => {
    const other = '0000000000000000000000000000000000000000000000000000000000000001';
    expect(deriveSolanaAddress(other)).not.toBe(EXPECTED_ADDRESS);
  });

  test('rejects odd-length hex', () => {
    expect(() => deriveSolanaAddress('abc')).toThrow(/odd length/);
  });
});

describe('solana/identity — isValidSolanaAddress', () => {
  test('accepts a derived address (the real-seed golden)', () => {
    expect(isValidSolanaAddress(EXPECTED_ADDRESS)).toBe(true);
  });

  test('accepts the System Program address (all-zero pubkey)', () => {
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true);
  });

  test('rejects a 0x-prefixed Ethereum address (wrong chain paste)', () => {
    expect(isValidSolanaAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
  });

  test('rejects a base58 string with invalid chars (0/O/I/l)', () => {
    expect(isValidSolanaAddress('0OIIlllllllllllllllllllllllllllllllll')).toBe(false);
  });

  test('rejects too-short input', () => {
    expect(isValidSolanaAddress('short')).toBe(false);
  });

  test('rejects empty / whitespace', () => {
    expect(isValidSolanaAddress('')).toBe(false);
    expect(isValidSolanaAddress('   ')).toBe(false);
  });
});
