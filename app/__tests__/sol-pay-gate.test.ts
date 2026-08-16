/**
 * solPayGate — the pure zero-funds gate derivation (2026-08-16 fund-first UX).
 *
 * Contract (mirrors the UX-expert spec, "fund-first, fail-open"):
 *   • gates fire ONLY on KNOWN state:
 *       - SOL selected:  sol.status === 'ok' && sol.balance === '0'  ⇒ 'sol-zero'
 *       - USDC selected: usdc.status === 'absent'                    ⇒ 'usdc-absent'
 *                        usdc.status === 'balance' && amount === '0' ⇒ 'usdc-zero'
 *   • EVERYTHING ELSE fails OPEN ('none'): 'loading' (not yet known), 'unavailable' (RPC off /
 *     offline — the offline-first rule), 'error' (the hook preserves the last balance by contract,
 *     so an error is never a confident zero).
 *   • 'usdc-absent' is NOT gated by SOL balance: the ATA-setup card itself offers the fund-SOL
 *     escape hatch (btn-sol-ata-fund) when SOL is short.
 */
import {describe, it, expect} from '@jest/globals';
import {solPayGate} from '../config/assets';

const sol = (status: string, balance: string | null) => ({status, balance});
const usdc = (status: string, amount: string | null) => ({status, amount});

describe('solPayGate — derivation table', () => {
  it('SOL: known ok + zero balance gates', () => {
    expect(solPayGate('SOL', sol('ok', '0'), usdc('balance', '5'))).toBe('sol-zero');
  });

  it('SOL: positive balance never gates', () => {
    expect(solPayGate('SOL', sol('ok', '2044280'), usdc('absent', null))).toBe('none');
  });

  it('SOL: loading / unavailable / error fail OPEN (offline-first)', () => {
    expect(solPayGate('SOL', sol('loading', null), usdc('balance', '0'))).toBe('none');
    expect(solPayGate('SOL', sol('unavailable', null), usdc('balance', '0'))).toBe('none');
    // error preserves the last-known balance; even a preserved '0' is NOT a confident zero
    expect(solPayGate('SOL', sol('error', '0'), usdc('balance', '0'))).toBe('none');
  });

  it('USDC: known-absent ATA gates as usdc-absent regardless of SOL balance', () => {
    expect(solPayGate('USDC', sol('ok', '0'), usdc('absent', null))).toBe('usdc-absent');
    expect(solPayGate('USDC', sol('ok', '9999999'), usdc('absent', null))).toBe('usdc-absent');
  });

  it('USDC: existing account with known zero balance gates as usdc-zero', () => {
    expect(solPayGate('USDC', sol('ok', '123'), usdc('balance', '0'))).toBe('usdc-zero');
  });

  it('USDC: positive balance never gates', () => {
    expect(solPayGate('USDC', sol('ok', '0'), usdc('balance', '2500000'))).toBe('none');
  });

  it('USDC: loading / unavailable / error fail OPEN', () => {
    expect(solPayGate('USDC', sol('ok', '0'), usdc('loading', null))).toBe('none');
    expect(solPayGate('USDC', sol('ok', '0'), usdc('unavailable', null))).toBe('none');
    // hook contract: poll error PRESERVES the last amount — never a confident zero
    expect(solPayGate('USDC', sol('ok', '0'), usdc('error', '0'))).toBe('none');
  });

  it('USDC: null amount on balance status (defensive) fails OPEN', () => {
    expect(solPayGate('USDC', sol('ok', '5'), usdc('balance', null))).toBe('none');
  });
});
