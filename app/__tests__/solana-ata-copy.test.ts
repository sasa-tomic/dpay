/**
 * The Solana token-account (ATA) rent copy — the two errors a user hits when an SPL transfer needs
 * an account that does not exist yet, in all four locales.
 *
 * The contract these pin is the one the 2026-09-08 Convert fix established and this suite extends
 * to the rest of the app: THE CALLER OWNS THE SYMBOL. `fmtAsset` already suffixes the unit and
 * owns the locale's separators, so an i18n template that puts a second bare unit next to that
 * formatted amount both duplicates it and fights the formatter. `recipientNoTokenAccount` shipped
 * as "…needs about 0.00204428 SOL of SOL in this wallet"; its sibling `ownTokenAccountRent`, two
 * lines below it in every locale file, always had it right — so the sibling is the reference here,
 * and both are pinned so they can never diverge again.
 *
 * e2e flow 77 drives these strings through the real app; it asserted only a PREFIX ending at the
 * amount, which is exactly why the duplicated unit sailed through it.
 */
import {describe, test, expect} from '@jest/globals';
import {SOL_ATA_SETUP_MIN_LAMPORTS} from '../solana/spl';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {fmtAssetCompact} from '../lib/format';
import {errorsEn} from '../i18n/domains/en/errors';
import {errorsDe} from '../i18n/domains/de/errors';
import {errorsEs} from '../i18n/domains/es/errors';
import {errorsFr} from '../i18n/domains/fr/errors';

const LOCALES = {en: errorsEn, de: errorsDe, es: errorsEs, fr: errorsFr};

/** Exactly what app/solana.ts passes in — the formatter's own string, unit included. */
const RENT = fmtAssetCompact(String(SOL_ATA_SETUP_MIN_LAMPORTS), SOL_DECIMALS, SOL_UNIT);

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('the rent amount carries its unit exactly once, in every locale', () => {
  test('the call sites really do hand the formatter\'s string in (not a bare number)', () => {
    expect(RENT).toBe('0.00204428 SOL');
  });

  for (const [locale, e] of Object.entries(LOCALES)) {
    test(`${locale}: neither rent message re-appends the unit to the amount`, () => {
      const lines = [
        e.solana.recipientNoTokenAccount(RENT, 'USDC'),
        e.solana.ownTokenAccountRent(RENT, 'USDC'),
      ];
      for (const line of lines) {
        expect(`${locale}: ${line}`).not.toContain('undefined');
        // the formatted amount appears once…
        expect(`${locale}: ${line} :: ${occurrences(line, RENT)}`).toBe(`${locale}: ${line} :: 1`);
        // …and no bare unit trails it, with or without a joining word ("SOL SOL", "SOL of SOL",
        // "SOL de SOL"). This is the shipped defect, in the shape each locale wrote it.
        expect(`${locale}: ${line}`).not.toMatch(/0\.002044280 SOL(\s+\S{1,3})?\s+SOL\b/);
      }
    });
  }
});

describe('both messages stay actionable after the correction', () => {
  for (const [locale, e] of Object.entries(LOCALES)) {
    test(`${locale}: the recipient message still names the asset, the cost and the remedy`, () => {
      const line = e.solana.recipientNoTokenAccount(RENT, 'USDC');
      expect(line).toContain('USDC'); // which token account is missing
      expect(line).toContain(RENT); // what creating it costs, in SOL
      expect(occurrences(line, 'SOL')).toBeGreaterThanOrEqual(2); // the remedy still names SOL to send
    });
  }
});

describe('the exact strings e2e flow 77 asserts', () => {
  test('the English recipient + own-account sentences, verbatim', () => {
    expect(errorsEn.solana.recipientNoTokenAccount(RENT, 'USDC')).toBe( // copy-economy sweep: em-dash to hyphen, "here" dropped; cost + remedy stay
      'They have no USDC account yet. Creating it costs about 0.00204428 SOL, paid by you '
      + '- send a little SOL first',
    );
    expect(errorsEn.solana.ownTokenAccountRent(RENT, 'USDC')).toBe(
      'Creating your USDC account costs about 0.00204428 SOL. '
      + 'Send a little SOL first.',
    );
  });
});
