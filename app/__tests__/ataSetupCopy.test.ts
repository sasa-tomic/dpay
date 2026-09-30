/**
 * The AtaSetupCard copy — the NEW wallet-level setup keys, in all four locales.
 *
 * Same contract solana-ata-copy.test.ts pins for the rent strings: the caller hands in
 * ALREADY-FORMATTED amounts, so a template that re-appends a unit next to one duplicates it.
 * The fund confirm names four facts (swap amount, source token, target accounts, cost) — the
 * sentences are pinned to carry each exactly once and never a bare 'undefined'.
 */
import {describe, test, expect} from '@jest/globals';
import {depositEn} from '../i18n/domains/en/deposit';
import {depositDe} from '../i18n/domains/de/deposit';
import {depositEs} from '../i18n/domains/es/deposit';
import {depositFr} from '../i18n/domains/fr/deposit';

const LOCALES = {en: depositEn, de: depositDe, es: depositEs, fr: depositFr};
const COST = '0.00204428 SOL';
const SWAP = '0.0021 USDC';

const occurrences = (h: string, n: string): number => h.split(n).length - 1;

describe('the wallet-level setup copy exists and stays clean, in every locale', () => {
  for (const [locale, d] of Object.entries(LOCALES)) {
    test(`${locale}: the button, the confirm and the refusal carry each fact exactly once`, () => {
      expect(d.ata.completeSetup.length).toBeGreaterThan(0);
      expect(d.ata.completeHint(COST)).toContain(COST);
      expect(d.ata.targetsLabel(['EURC'])).toContain('EURC');
      const two = d.ata.targetsLabel(['EURC', 'USDC']);
      expect(two).toContain('EURC');
      expect(two).toContain('USDC');
      expect(d.ata.fundFrom('USDC')).toContain('USDC');
      const confirm = d.ata.fundConfirm(SWAP, 'USDC', two, COST);
      expect(confirm).not.toContain('undefined');
      expect(occurrences(confirm, SWAP)).toBe(1);
      expect(occurrences(confirm, COST)).toBe(1);
      expect(confirm).toContain('USDC');
      const short = d.ata.fundShort('USDC');
      expect(short).toContain('USDC');
      expect(short).not.toContain('undefined');
      expect(d.ata.confirmAction.length).toBeGreaterThan(0);
      expect(d.ata.creatingAll(two)).toContain('EURC');
      // The pre-existing per-asset keys the card shares keep their register.
      expect(d.ata.absent('EURC')).toContain('EURC');
      expect(d.ata.cost(COST, two)).toContain(COST);
      // The compact banner (one-line summary row) and the fund-ic states (2026-09-30).
      const banner = d.ata.finishSetup(two);
      expect(banner).toContain('EURC');
      expect(banner).toContain('USDC');
      expect(d.ata.costShort(COST)).toContain(COST);
      const icConfirm = d.ata.fundIcConfirm(SWAP, 'USDC', two, COST);
      expect(icConfirm).not.toContain('undefined');
      expect(occurrences(icConfirm, SWAP)).toBe(1);
      expect(occurrences(icConfirm, COST)).toBe(1);
      expect(icConfirm).toContain('USDC');
      expect(d.ata.swapPending(two)).toContain('EURC');
    });
  }
});
