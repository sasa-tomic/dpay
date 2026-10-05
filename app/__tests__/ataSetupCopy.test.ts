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
// No middleman jargon anywhere on the card: the copy speaks in movements, never venues.
const JARGON = /venue|Anbieter|proveedor|prestataire/i;

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
      const confirm = d.ata.fundConfirm(SWAP, two, COST);
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
      // The pre-existing per-asset keys the card shares keep their register.
      expect(d.ata.absent('EURC')).toContain('EURC');
      expect(d.ata.cost(COST, two)).toContain(COST);
      // The compact banner (one-line summary row) and the fund-ic states (2026-09-30).
      const banner = d.ata.finishSetup(two);
      expect(banner).toContain('EURC');
      expect(banner).toContain('USDC');
      expect(d.ata.costShort(COST)).toContain(COST);
      const icConfirm = d.ata.fundIcConfirm(SWAP, two, COST);
      expect(icConfirm).not.toContain('undefined');
      expect(occurrences(icConfirm, SWAP)).toBe(1);
      expect(occurrences(icConfirm, COST)).toBe(1);
      expect(icConfirm).toContain('USDC');
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
      const surfaces = [short, icConfirm, min, d.ata.needSol(COST), d.ata.settingUp, d.ata.creating('EURC'), d.ata.swapFailed];
      expect(surfaces.join('\n')).not.toContain('—');
      // THE BUSY LINE (founder spec 2026-10-02, verbatim intent): ONE line, simple, active
      // tense, with the 1-2-minute expectation. No targets interpolation, no second sentence
      // beyond the timing - the busy card renders this and NOTHING else.
      const busy = d.ata.settingUp;
      expect(busy.length).toBeGreaterThan(0);
      expect(busy).toMatch(/1-2|1 a 2|1 à 2/);
      expect(busy).not.toContain('undefined');
      expect(busy).not.toMatch(JARGON);
      // The failure guidance (founder spec: after the error, the NEXT STEPS - what happens to
      // the money and what to do now, 1-2 sentences). `errNextSafe` = money verifiably
      // untouched (retry is legal); `errNextUnknown` = unaccounted funds (check the balance
      // first, never a blind retry) and must name where to look (SOL).
      for (const next of [d.ata.errNextSafe, d.ata.errNextUnknown]) {
        expect(next.length).toBeGreaterThan(0);
        expect(next).not.toContain('undefined');
        expect(next).not.toContain('—');
        expect(next).not.toMatch(JARGON);
        const sentences = next.split(/[.!?]\s/).filter(s => s.trim().length > 0).length;
        expect(sentences).toBeLessThanOrEqual(3);
      }
      expect(d.ata.errNextUnknown).toMatch(/SOL/);
      // Register per locale: de uses du, es uses tu, fr uses vous (the surrounding card).
      if (locale === 'de') {
        expect(`${busy}\n${d.ata.errNextSafe}`).toMatch(/dein|warte/i);
      } else if (locale === 'es') {
        expect(`${busy}\n${d.ata.errNextSafe}`).toMatch(/\btu\b|\bespera\b/i);
      } else if (locale === 'fr') {
        expect(`${busy}\n${d.ata.errNextSafe}`).toMatch(/votre|patientez|attendez/i);
      }
    });
  }
});

describe('the audit copy rules (2026-10-02): one name per fact, no middleman jargon, the create card names its payer', () => {
  for (const [locale, d] of Object.entries(LOCALES)) {
    test(`${locale}: the confirm sentence names the swap amount once and never re-names the source`, () => {
      const two = d.ata.targetsLabel(['EURC', 'USDC']);
      // The 2026-10-02 live trip rendered 'about 0.90 ICP of your ICP' - a source whose
      // symbol the swap amount already carries must never be re-possessed. When the source
      // IS a created account (fund a USDC balance), the token may appear twice: once as the
      // input amount, once as the account being created - two facts, each named once.
      const c = d.ata.fundConfirm(SWAP, two, COST);
      expect(occurrences(c, SWAP)).toBe(1);
      expect(c).not.toMatch(/of your (USDC|ICP|VCHF|EURC)\b/);
      const ic = d.ata.fundIcConfirm(SWAP, two, COST);
      expect(occurrences(ic, SWAP)).toBe(1);
      expect(ic).not.toMatch(/of your (USDC|ICP|VCHF|EURC)\b/);
      expect(occurrences(ic, COST)).toBe(1);
    });

    test(`${locale}: no middleman jargon - the timing line speaks plainly`, () => {
      const two = d.ata.targetsLabel(['EURC', 'USDC']);
      expect(d.ata.fundIcConfirm(SWAP, two, COST)).not.toMatch(JARGON);
      expect(d.ata.fundFrom('USDC')).not.toMatch(JARGON);
      // THE busy line (2026-10-02 founder spec, verbatim intent): while a run or a live
      // record holds the card, the user gets exactly ONE line - simple, active tense, with
      // the honest 1-2 minute window. No target list, no second sentence of progress detail.
      const busy = d.ata.settingUp;
      expect(busy).not.toContain('undefined');
      expect(busy).not.toContain('—');
      expect(busy).toMatch(/1-2/);
      expect(busy).not.toMatch(JARGON);
      if (locale === 'en') expect(busy).toBe('Setting up your account. Takes 1-2 minutes.'); // copy-economy sweep: "Please wait" filler dropped, the 1-2 min window stays
      // Register consistency per locale card (de du, es tu, fr vous).
      if (locale === 'de') expect(busy).toMatch(/dein|warte/i);
      if (locale === 'es') expect(busy).toMatch(/\btu\b/i);
      if (locale === 'fr') expect(busy).toMatch(/\bvous\b|\bvotre/i);
    });

    test(`${locale}: the create-kind card states what pays (the SOL balance)`, () => {
      expect(d.ata.createSource).toContain('SOL');
      expect(d.ata.createSource).not.toContain('undefined');
    });
  }
});
