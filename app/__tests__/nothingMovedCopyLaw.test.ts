/**
 * The NOTHING-MOVED copy law (founder 2026-10-05: "UI shows 'nothing moved' in weird places.
 * It should only show this on failed conversions or payments.").
 *
 * "Nothing moved" (and its 4-locale family) is a FAILURE disposition: the money action was
 * refused, rejected, or expired with the funds verifiably still in place. It is a lie in every
 * other state - a waiting screen has not failed yet, a stale balance is a read problem, and an
 * unknown outcome means the money MAY have moved. This pin walks EVERY i18n domain in ALL FOUR
 * locales, renders every template with probing arguments, and asserts the phrase appears in an
 * explicit allowlist of failure keys and NOWHERE else - both directions, so a sweep that strips
 * the phrase from a real failure fails this test too.
 *
 * Allowlist rule of thumb: the surface reports a money action that FAILED (a ledger/pool/network
 * refusal, a rejected transaction). Not on the list, ever: waiting/polling states, expiry
 * warnings rendered BEFORE anything moves, watch-stopped acknowledgements, offline and
 * balance-stale notices, retry guidance, and account/balance READ failures.
 */
import {describe, expect, test} from '@jest/globals';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';
import {depositEn, withdrawEn} from '../i18n/domains/en/deposit';
import {depositDe, withdrawDe} from '../i18n/domains/de/deposit';
import {depositEs, withdrawEs} from '../i18n/domains/es/deposit';
import {depositFr, withdrawFr} from '../i18n/domains/fr/deposit';
import {errorsEn} from '../i18n/domains/en/errors';
import {errorsDe} from '../i18n/domains/de/errors';
import {errorsEs} from '../i18n/domains/es/errors';
import {errorsFr} from '../i18n/domains/fr/errors';
import {evmEn} from '../i18n/domains/en/evm';
import {evmDe} from '../i18n/domains/de/evm';
import {evmEs} from '../i18n/domains/es/evm';
import {evmFr} from '../i18n/domains/fr/evm';
import {walletEn, educationEn} from '../i18n/domains/en/wallet';
import {walletDe, educationDe} from '../i18n/domains/de/wallet';
import {walletEs, educationEs} from '../i18n/domains/es/wallet';
import {walletFr, educationFr} from '../i18n/domains/fr/wallet';
import {payEn, receiveEn} from '../i18n/domains/en/pay';
import {payDe, receiveDe} from '../i18n/domains/de/pay';
import {payEs, receiveEs} from '../i18n/domains/es/pay';
import {payFr, receiveFr} from '../i18n/domains/fr/pay';
import {receiptEn} from '../i18n/domains/en/receipt';
import {receiptDe} from '../i18n/domains/de/receipt';
import {receiptEs} from '../i18n/domains/es/receipt';
import {receiptFr} from '../i18n/domains/fr/receipt';
import {settingsEn, onboardingEn} from '../i18n/domains/en/settings';
import {settingsDe, onboardingDe} from '../i18n/domains/de/settings';
import {settingsEs, onboardingEs} from '../i18n/domains/es/settings';
import {settingsFr, onboardingFr} from '../i18n/domains/fr/settings';
import {updateEn} from '../i18n/domains/en/update';
import {updateDe} from '../i18n/domains/de/update';
import {updateEs} from '../i18n/domains/es/update';
import {updateFr} from '../i18n/domains/fr/update';

/** The phrase family per locale: every rendering of the "nothing moved" claim. */
const PHRASE: Record<string, RegExp> = {
  en: /nothing\s+(?:can\s+|will\s+|ever\s+)?mov(?:e[ds]?|ing)\b/i,
  de: /nichts bewegt|bewegte sich nichts|sich nichts bewegt|bewegt sich nichts|kann sich nichts bewegen|nichts kann sich|wurde nichts bewegt/i,
  es: /nada se mueve|no se mueve|nada se mov|no se mov|nada ha movido|no se ha movido|ha movido nada|nada puede mov/i,
  fr: /rien n['\u2019]?(?:a|à)\s*boug|rien ne boug|rien ne peut boug|plus rien ne peut/i,
};

/** The FAILURE keys where the claim is legal (identical paths in every locale). */
const ALLOW = [
  'convert.sol.failedBody', // the on-chain Solana swap failed whole
  'convert.failedApproveBody', // the ledger refused the FIRST signature
  'convert.errors.buildRefused', // the venue refused to prepare the exchange
  'evm.failedBody', // the EVM network rejected the transaction
  'education.practice.refusedBody', // the practice ledger refused the payment
];
const ALLOW_SET = new Set<string>(ALLOW);

const DOMAINS: Array<[string, Record<string, Record<string, unknown>>]> = [
  ['en', {convert: convertEn, deposit: depositEn, withdraw: withdrawEn, errors: errorsEn, evm: evmEn, wallet: walletEn, education: educationEn, pay: payEn, receive: receiveEn, receipt: receiptEn, settings: settingsEn, onboarding: onboardingEn, update: updateEn}],
  ['de', {convert: convertDe, deposit: depositDe, withdraw: withdrawDe, errors: errorsDe, evm: evmDe, wallet: walletDe, education: educationDe, pay: payDe, receive: receiveDe, receipt: receiptDe, settings: settingsDe, onboarding: onboardingDe, update: updateDe}],
  ['es', {convert: convertEs, deposit: depositEs, withdraw: withdrawEs, errors: errorsEs, evm: evmEs, wallet: walletEs, education: educationEs, pay: payEs, receive: receiveEs, receipt: receiptEs, settings: settingsEs, onboarding: onboardingEs, update: updateEs}],
  ['fr', {convert: convertFr, deposit: depositFr, withdraw: withdrawFr, errors: errorsFr, evm: evmFr, wallet: walletFr, education: educationFr, pay: payFr, receive: receiveFr, receipt: receiptFr, settings: settingsFr, onboarding: onboardingFr, update: updateFr}],
];

/** Render one template with a probe per parameter (same shape as convertCopyLaw's walker). */
function renderTemplate(fn: (...args: unknown[]) => unknown): string {
  const src = fn.toString();
  const bare = src.match(/^\s*([A-Za-z_$][\w$]*)\s*=>/);
  const paren = src.match(/^\s*\(([^)]*)\)\s*=>/);
  const params = bare != null
    ? [bare[1]!]
    : paren != null && paren[1]!.trim() !== ''
      ? paren[1]!.split(',').map(s => s.trim().split(/[:=]/)[0]!.trim())
      : [];
  try {
    return String(fn(...params.map(() => 'X')));
  } catch {
    return src; // unrenderable shape: the literal source still carries the claim if it has one
  }
}

function matchesIn(locale: string): Set<string> {
  const re = PHRASE[locale]!;
  const found = new Set<string>();
  for (const [localeName, domains] of DOMAINS) {
    if (localeName !== locale) continue;
    for (const [domainName, domain] of Object.entries(domains)) {
      const walk = (obj: unknown, path: string): void => {
        if (obj == null) return;
        if (typeof obj === 'function') {
          if (re.test(renderTemplate(obj as (...args: unknown[]) => unknown))) {
            found.add(`${domainName}.${path}`);
          }
          return;
        }
        if (typeof obj === 'string') {
          if (re.test(obj)) found.add(`${domainName}.${path}`);
          return;
        }
        if (typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            walk(v, path === '' ? k : `${path}.${k}`);
          }
        }
      };
      walk(domain, '');
    }
  }
  return found;
}

describe('the nothing-moved copy law (founder 2026-10-05): failure dispositions only', () => {
  for (const [locale] of DOMAINS) {
    test(`${locale}: the phrase appears ONLY in the failure allowlist, and in all of it`, () => {
      const found = matchesIn(locale);
      const stray = [...found].filter(k => !ALLOW_SET.has(k));
      expect(stray).toEqual([]); // no waiting/stale/offline/unknown surface claims it
      const missing = ALLOW.filter(k => !found.has(k));
      expect(missing).toEqual([]); // no real failure lost its honest disposition either
    });
  }

  test('the allowlist keys exist in every locale (a rename must update this pin)', () => {
    for (const [locale, domains] of DOMAINS) {
      for (const key of ALLOW) {
        const [domainName, ...rest] = key.split('.');
        let cur: unknown = domains[domainName!];
        for (const part of rest.join('.').split('.')) {
          if (cur == null || typeof cur !== 'object') break;
          cur = (cur as Record<string, unknown>)[part];
        }
        expect(`${locale}:${key}`).toBeDefined();
        expect(cur != null).toBe(true);
      }
    }
  });
});
