import {describe, it, expect} from '@jest/globals';
import {keccak256, eip55ChecksumBad} from '../lib/eip55';

// Golden pins for the hand-rolled keccak256 (original Keccak padding — NOT NIST SHA-3) and the
// EIP-55 mixed-case rule it feeds. The EIP-55 vectors are the spec's own; the corrupted forms
// are the typo class this check exists to catch (one flipped case verifies as a different
// address). No-case-information forms (all-lower / all-upper) are never "bad" — they carry no
// checksum to verify, and breaking their acceptance would break every legitimate paste.

describe('keccak256', () => {
  it('matches the published vectors', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    expect(hex(keccak256(new Uint8Array(0)))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(hex(keccak256(new TextEncoder().encode('abc')))).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });
});

describe('eip55ChecksumBad', () => {
  // The EIP-55 spec's own vectors.
  const spec = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    // The USDC token contract, as carried by this repo's constants.
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  ];

  it('accepts the spec vectors', () => {
    for (const a of spec) expect(eip55ChecksumBad(a)).toBe(false);
  });

  it('rejects one flipped case (the typo class)', () => {
    expect(eip55ChecksumBad('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(true);
    expect(eip55ChecksumBad('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48')).toBe(true);
  });

  it('never rejects a no-case-information form', () => {
    for (const a of spec) {
      expect(eip55ChecksumBad(a.toLowerCase())).toBe(false);
      expect(eip55ChecksumBad(a.toUpperCase())).toBe(false);
    }
  });
});
