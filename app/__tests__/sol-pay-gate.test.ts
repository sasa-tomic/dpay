/**
 * solPayGate — the pure zero-funds gate derivation (2026-08-16 fund-first UX).
 *
 * Contract (mirrors the UX-expert spec, "fund-first, fail-open"):
 *   • gates fire ONLY on KNOWN state (the SELECTED token — any registered SPL token):
 *       - SOL selected:   sol.status === 'ok' && sol.balance === '0'        ⇒ 'sol-zero'
 *       - token selected: token.status === 'absent'                        ⇒ 'token-absent'
 *                         token.status === 'balance' && amount === '0'      ⇒ 'token-zero'
 *   • EVERYTHING ELSE fails OPEN ('none'): 'loading' (not yet known), 'unavailable' (RPC off /
 *     offline — the offline-first rule), 'error' (the hook preserves the last balance by contract,
 *     so an error is never a confident zero).
 *   • 'token-absent' is NOT gated by SOL balance: the ATA-setup card itself offers the fund-SOL
 *     escape hatch (btn-sol-ata-fund) when SOL is short.
 */
import {describe, it, expect} from '@jest/globals';
import {solPayGate} from '../config/assets';

const sol = (status: string, balance: string | null) => ({status, balance});
const token = (status: string, amount: string | null) => ({status, amount});

describe('solPayGate — derivation table', () => {
  it('SOL: known ok + zero balance gates', () => {
    expect(solPayGate('SOL', sol('ok', '0'), token('balance', '5'))).toBe('sol-zero');
  });

  it('SOL: positive balance never gates', () => {
    expect(solPayGate('SOL', sol('ok', '2044280'), token('absent', null))).toBe('none');
  });

  it('SOL: loading / unavailable / error fail OPEN (offline-first)', () => {
    expect(solPayGate('SOL', sol('loading', null), token('balance', '0'))).toBe('none');
    expect(solPayGate('SOL', sol('unavailable', null), token('balance', '0'))).toBe('none');
    // error preserves the last-known balance; even a preserved '0' is NOT a confident zero
    expect(solPayGate('SOL', sol('error', '0'), token('balance', '0'))).toBe('none');
  });

  it('token: known-absent ATA gates as token-absent regardless of SOL balance', () => {
    expect(solPayGate('USDC', sol('ok', '0'), token('absent', null))).toBe('token-absent');
    expect(solPayGate('USDC', sol('ok', '9999999'), token('absent', null))).toBe('token-absent');
  });

  it('token: existing account with known zero balance gates as token-zero', () => {
    expect(solPayGate('USDC', sol('ok', '123'), token('balance', '0'))).toBe('token-zero');
  });

  it('token: positive balance never gates', () => {
    expect(solPayGate('USDC', sol('ok', '0'), token('balance', '2500000'))).toBe('none');
  });

  it('token: loading / unavailable / error fail OPEN', () => {
    expect(solPayGate('USDC', sol('ok', '0'), token('loading', null))).toBe('none');
    expect(solPayGate('USDC', sol('ok', '0'), token('unavailable', null))).toBe('none');
    // hook contract: poll error PRESERVES the last amount — never a confident zero
    expect(solPayGate('USDC', sol('ok', '0'), token('error', '0'))).toBe('none');
  });

  it('token: null amount on balance status (defensive) fails OPEN', () => {
    expect(solPayGate('USDC', sol('ok', '5'), token('balance', null))).toBe('none');
  });
});
