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
import {describe, it, expect, jest} from '@jest/globals';
import {solPayGate, solSignCaveat, solSplSignGate} from '../config/assets';
import {M} from '../i18n';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';

const sol = (status: string, balance: string | null) => ({status, balance});
const token = (status: string, amount: string | null, failure: string | null = null) => ({status, amount, failure});

// A real mainnet mint dpay does NOT carry (wrapped SOL) — registered-mint checks must refuse it.
const UNREGISTERED_MINT = 'So11111111111111111111111111111111111111112';

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

describe('solSplSignGate — per-request-mint solreq sign gate (OPEN_ISSUES 6(a))', () => {
  // The solreq auto-sign paths sign PURE against an ASSUMED source ATA; a KNOWN-absent mint is
  // refused before signing, everything UNCONFIRMED fails open (offline-first — same rule as
  // solPayGate). 'balance' of ANY amount (including '0') proves the ATA exists — only the owner
  // can close an ATA, and dpay never builds a close instruction.
  it('a native-SOL request (mint null) always allows — no ATA involved', () => {
    expect(solSplSignGate(null, {})).toBe('allow');
    expect(solSplSignGate(null, {[USDC_MINT_ADDRESS]: token('absent', null)})).toBe('allow');
  });

  it('a mint outside the registry is unregistered — even one the states happen to carry', () => {
    expect(solSplSignGate(UNREGISTERED_MINT, {})).toBe('unregistered');
    expect(solSplSignGate(UNREGISTERED_MINT, {[UNREGISTERED_MINT]: token('absent', null)})).toBe('unregistered');
  });

  it('a KNOWN-absent mint refuses', () => {
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('absent', null)})).toBe('absent');
  });

  it('any confirmed balance allows — including a known zero (the ATA exists)', () => {
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('balance', '0')})).toBe('allow');
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('balance', '2500000')})).toBe('allow');
  });

  it('loading / unavailable / never-polled sign, and say so — UNVERIFIED, never silently fine', () => {
    // The offline payer is the product. None of these may refuse; all of them must be nameable by
    // the surface, which is why they are not spelled 'allow'.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {})).toBe('unverified');
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('loading', null)})).toBe('unverified');
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('unavailable', null)})).toBe('unverified');
    // a degraded poll observes NOTHING — even one that preserved an amount is not an existence
    // fact; and 'offline' (the oracle classified the PHONE as offline) keeps the plain-unverified
    // advice "get signal", which is exactly right for that payer.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('error', '0', 'offline')})).toBe('unverified');
    // a pre-R3 error view with NO classified failure (back-compat): never a crash, never 'allow'.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('error', '0')})).toBe('unverified');
  });

  it('a rail that is down while the phone is online is its own state — refused, unreadable, or unreachable', () => {
    // This is the state the outage produced: the device is online, the endpoint answers 429, and
    // the wallet has no fact for the mint. It still SIGNS (a payer who does hold the account must
    // not be blocked by someone else's quota), but the surface has to be able to say that the
    // account could not be checked and why — a payment that cannot settle otherwise looks fine
    // right up until it silently never arrives.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('error', null, 'refused')}))
      .toBe('unverified-rail-down');
    // …and 'unreadable' bytes are the same class of thing: the endpoint answered, we learnt nothing.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('error', null, 'unreadable')}))
      .toBe('unverified-rail-down');
    // …and 'unreachable' (R3 audit): nothing answered on the rail's path while the IC-boundary
    // probe DID answer — the phone is online and the service side is down, so the plain-
    // 'unverified' advice ("retry when you have signal") would be wrong advice for this cause.
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('error', null, 'unreachable')}))
      .toBe('unverified-rail-down');
  });

  it('a KNOWN fact beats any endpoint state — a refusing rail never re-opens a refusal', () => {
    // The persisted-fact store is what makes this true offline: an absence observed once stays
    // observed (only the owner can close a token account, and dpay has no close path).
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('absent', null, 'refused')})).toBe('absent');
    expect(solSplSignGate(EURC_MINT_ADDRESS, {[EURC_MINT_ADDRESS]: token('balance', '1', 'refused')})).toBe('allow');
  });

  it('the gate reads ONLY the request\'s mint — sibling mint states are irrelevant', () => {
    const states = {[USDC_MINT_ADDRESS]: token('balance', '5'), [EURC_MINT_ADDRESS]: token('absent', null)};
    expect(solSplSignGate(USDC_MINT_ADDRESS, states)).toBe('allow');
    expect(solSplSignGate(EURC_MINT_ADDRESS, states)).toBe('absent');
  });
});

// The DISCLOSURE half of the gate: what a payment signed on no fact tells its payer. The gate's own
// verdicts are covered above; this covers the sentence, which is the part the user actually meets.
describe('solSignCaveat — the sentence a fact-less signature owes its payer', () => {
  it('a decided gate discloses nothing — allow signs on a fact, absent/unregistered never sign', () => {
    for (const gate of ['allow', 'absent', 'unregistered'] as const) {
      expect(solSignCaveat(gate, EURC_MINT_ADDRESS)).toBeNull();
    }
  });

  it("'unverified' names the token, states the cost of being wrong, and sends the payer to get signal", () => {
    const line = solSignCaveat('unverified', EURC_MINT_ADDRESS);
    expect(line).toBe(M.errors.solana.senderTokenAccountUnverified('EURC'));
    expect(line).toContain('EURC');
    expect(line).toContain('can’t settle');
    expect(line).toContain('Go online');
    expect(line).toContain('My address');
  });

  it("'unverified-rail-down' says the RAIL is down, so it must NOT tell the payer to find signal", () => {
    const line = solSignCaveat('unverified-rail-down', USDC_MINT_ADDRESS);
    expect(line).toBe(M.errors.solana.senderTokenAccountUnverifiedRailDown('USDC'));
    expect(line).toContain('USDC');
    expect(line).toContain('Solana isn’t answering');
    expect(line).toContain('can’t settle');
    expect(line).toContain('My address');
    // The distinction is the whole point of the second state: "get online" would be a lie to a
    // payer who already is.
    expect(line).not.toContain('Get online');
  });

  it('the two unverified states say DIFFERENT things (a single message would defeat the split)', () => {
    expect(solSignCaveat('unverified', EURC_MINT_ADDRESS))
      .not.toBe(solSignCaveat('unverified-rail-down', EURC_MINT_ADDRESS));
  });

  it('a pair the gate cannot produce warns loudly instead of naming an asset it cannot name', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(solSignCaveat('unverified', UNREGISTERED_MINT)).toBeNull();
    expect(solSignCaveat('unverified-rail-down', null)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
