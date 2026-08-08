import {describe, it, expect} from '@jest/globals';
import {friendlySolError} from '../solana/errors';

// friendlySolError maps raw Solana RPC error strings to actionable human copy. The bug this guards:
// a payer with no SOL hit "solana rpc: Transaction simulation failed: Attempt to debit on account
// but found no record of a prior credit" verbatim — a raw blockchain error with no guidance. The
// function must translate the common failure classes a user actually encounters, and never hide an
// unknown error (it falls through to the raw message so diagnosis is still possible).

describe('friendlySolError — SOL RPC error → human copy', () => {
  it('maps "no record of a prior credit" (unfunded account) to a fund-your-account message', () => {
    const raw = 'solana rpc: Transaction simulation failed: Attempt to debit on account but found no record of a prior credit';
    const out = friendlySolError(raw);
    expect(out).not.toContain('debit');
    expect(out).not.toContain('prior credit');
    expect(out.toLowerCase()).toContain('sol');
  });

  it('maps insufficient funds', () => {
    const out = friendlySolError('solana rpc: Transaction simulation failed: InstructionError: InsufficientFunds');
    expect(out).toMatch(/not enough|insufficient/i);
    expect(out).not.toBe('solana rpc: Transaction simulation failed: InstructionError: InsufficientFunds');
  });

  it('maps rent-exempt violation', () => {
    const out = friendlySolError('custom program error: 0x1: account rent not exempt');
    expect(out).toMatch(/minimum balance|rent/i);
  });

  it('maps blockhash errors', () => {
    const out = friendlySolError('solana rpc: Blockhash not found');
    expect(out).toMatch(/busy|try again|blockhash/i);
  });

  it('maps abort/timeout', () => {
    const out = friendlySolError('aborted');
    expect(out).toMatch(/timed out|try again/i);
  });

  it('passes through an unknown error verbatim (never hides)', () => {
    const raw = 'solana rpc: some novel future error code 0x99';
    expect(friendlySolError(raw)).toBe(raw);
  });
});
