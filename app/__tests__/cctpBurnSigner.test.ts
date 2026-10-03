// Smoke: WHO signs the CCTP burn leg (swap-typing stage 2, 2026-10-03) — a money-defining
// decision frozen on every cross-rail record. The device's OWN derived EVM address as the
// destination means the DEVICE signs the burn (no external wallet, no handoff); any other
// destination means an EXTERNAL wallet owns the USDC and must sign it. The compare is
// case-insensitive (EVM hex case is display noise) — a checksummed paste of the device's own
// address must never demote the record to the handoff path.
import {describe, expect, test} from '@jest/globals';
import {resolveCctpBurnSigner} from '../cctp';

const DEVICE = '0xab3f0a1d0c1e2b3c4d5e6f708192a3b4c5d6e7f8';

describe('resolveCctpBurnSigner — the burn signer decision (stage 2)', () => {
  test('the device-derived address (any hex case, trimmed) is DEVICE-signed', () => {
    expect(resolveCctpBurnSigner(DEVICE, DEVICE)).toBe('device');
    expect(resolveCctpBurnSigner(DEVICE.toUpperCase(), DEVICE)).toBe('device');
    expect(resolveCctpBurnSigner(` ${DEVICE} `, DEVICE.toLowerCase())).toBe('device');
  });
  test('any other address is EXTERNAL — the WalletConnect handoff path stays', () => {
    expect(resolveCctpBurnSigner('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', DEVICE)).toBe('external');
    expect(resolveCctpBurnSigner('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', DEVICE)).toBe('external');
  });
  test('a one-character difference never reads as the device', () => {
    const off = DEVICE.slice(0, -1) + (DEVICE.endsWith('8') ? '9' : '8');
    expect(off).not.toBe(DEVICE);
    expect(resolveCctpBurnSigner(off, DEVICE)).toBe('external');
  });
});
