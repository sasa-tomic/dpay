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
      // needSol receives the cost WITH its unit, so the sentence must not name SOL twice.
      const need = d.ata.needSol(COST);
      expect(need).toContain(COST);
      expect(occurrences(need, 'SOL')).toBe(1);
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
      // The up-front minimum line (2026-10-01): the idle card states the measured swap minimum
      // BEFORE the user initiates anything - one line, amount once, source named. The amount
      // arrives PRE-FORMATTED with its symbol; the 2026-10-02 live trip rendered the symbol
      // TWICE ('Needs at least 2.62487136 VCHF VCHF.') - the template takes the amount only
      // and the source name must appear EXACTLY once.
      const min = d.ata.minSwap(SWAP);
      expect(min).toContain(SWAP);
      expect(min).toContain('USDC');
      expect(min).not.toContain('undefined');
      expect(occurrences(min, SWAP)).toBe(1);
      expect(occurrences(min, 'USDC')).toBe(1);
      // The card's OWN fallback copy never invites a hollow retry (2026-10-01): state facts,
      // full stop. The banned family is the empty retry promise - a venue-verbatim
      // failureDetail pass-through is exempt by design (ataRecordErrLine returns it
      // verbatim), but these five keys are authored copy and must be clean in EVERY locale.
      // (Instructional 'again' without the try-verb, like swapUnknown's 'complete the setup
      // again', stays legal.)
      const banned = ['try again', 'erneut versuchen', 'versuch es erneut', 'inténtalo de nuevo', 'intentarlo de nuevo', 'réessaie', 'réessayer'];
      const fallbacks = [d.ata.swapFailed, d.ata.swapUnknown, short, min, d.ata.needSol(COST)];
      for (const f of fallbacks) {
        for (const b of banned) expect(f.toLowerCase()).not.toContain(b);
      }
      // The house style: plain hyphens in the setup copy, never em-dashes.
      const surfaces = [short, icConfirm, min, d.ata.needSol(COST), d.ata.creatingAll(two), d.ata.creating('EURC'), d.ata.swapFailed];
      expect(surfaces.join('\n')).not.toContain('—');
    });
  }
});
