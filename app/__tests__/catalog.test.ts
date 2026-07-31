import {describe, it, expect} from '@jest/globals';
import {isValidDestinationAddress} from '../config/catalog';

describe('isValidDestinationAddress', () => {
  describe('CkBtcUtxo (Bitcoin)', () => {
    const family = 'CkBtcUtxo';
    it('accepts a bech32 SegWit address', () => {
      expect(isValidDestinationAddress(family, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    });
    it('accepts a bech32m Taproot address', () => {
      expect(isValidDestinationAddress(family, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwud3qrvyhzg')).toBe(true);
    });
    it('accepts a P2PKH address', () => {
      expect(isValidDestinationAddress(family, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    });
    it('accepts a P2SH address', () => {
      expect(isValidDestinationAddress(family, '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    });
    it('rejects an Ethereum address (wrong chain)', () => {
      expect(isValidDestinationAddress(family, '0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
    });
    it('rejects garbage', () => {
      expect(isValidDestinationAddress(family, 'not-an-address')).toBe(false);
    });
    it('rejects empty', () => {
      expect(isValidDestinationAddress(family, '')).toBe(false);
    });
    it('rejects whitespace', () => {
      expect(isValidDestinationAddress(family, '   ')).toBe(false);
    });
  });

  describe('CkEthErc20 (Ethereum)', () => {
    const family = 'CkEthErc20';
    it('accepts a valid 0x hex address', () => {
      expect(isValidDestinationAddress(family, '0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
    });
    it('rejects a Bitcoin address (wrong chain)', () => {
      expect(isValidDestinationAddress(family, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
    });
    it('rejects too short', () => {
      expect(isValidDestinationAddress(family, '0x1234')).toBe(false);
    });
    it('rejects without 0x prefix', () => {
      expect(isValidDestinationAddress(family, '1234567890abcdef1234567890abcdef12345678')).toBe(false);
    });
  });
});
