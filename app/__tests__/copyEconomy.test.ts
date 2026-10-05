/**
 * The COPY-ECONOMY pin (founder 2026-10-05: "EVERY WORD COSTS US, REMOVE ALL WORDS THAT DO NOT
 * HAVE TO BE READ BY THE USER").
 *
 * Filler words are banned from every user-facing string in ALL FOUR locale catalogs: "in this
 * wallet", "on this device", "your own", "exactly", "already", "please", "simply", "just",
 * "you can", "Note:", "here" - each obvious from context, each costing a read. Each locale is
 * scanned for its OWN filler family (de "in dieser Wallet"/"genau"/"bitte"/"bereits"/"einfach",
 * es "en esta billetera"/"exactamente"/"por favor", fr "dans ce portefeuille"/"exactement"/
 * "veuillez"/"deja"). Em/en-dashes are banned too - plain hyphens only.
 *
 * NOT banned (they earn their words, never delete them): amounts with currency symbols, error
 * causes + next steps, money-safety disclosures (min-out floors, expiry warnings, refund notes,
 * surplus-stays-spendable facts, held-funds notices), attribution the no-quote rule demands
 * ("dpay is not a party"), and anything a jest pin asserts. Register is fixed elsewhere
 * (en plain / de du / es tu / fr vous); this pin governs word economy only.
 */
import {describe, expect, test} from '@jest/globals';
import {en} from '../i18n/en';
import {de} from '../i18n/de';
import {es} from '../i18n/es';
import {fr} from '../i18n/fr';

/** Per-locale banned-filler families (values only; keys and comments are not copy). */
const BANNED: Record<string, RegExp[]> = {
  en: [
    /in this wallet/i,
    /on this device/i,
    /\byour own\b/i,
    /\bexactly\b/i,
    /\balready\b/i,
    /\bplease\b/i,
    /\bsimply\b/i,
    /\bjust\b/i,
    /\byou can\b/i,
    /\bnote\s*:/i,
    /\bhere\b/i,
  ],
  de: [
    /in dieser wallet/i,
    /auf diesem gerät/i,
    /\beigen(e|n|es|er|em)?\b/i,
    /\bgenau\b/i,
    /\b(bereits|schon)\b/i,
    /\bbitte\b/i,
    /\beinfach\b/i,
    /\b(du kannst|kannst du)\b/i,
    /\bhinweis\s*:/i,
    /\bhier\b/i,
  ],
  es: [
    /en esta (billetera|cartera)/i,
    /en este dispositivo/i,
    /\bpropi[oa]s?\b/i,
    /\bexactamente\b/i,
    /\bpor favor\b/i,
    /\bsimplemente\b/i,
    /\bpuedes\b/i,
    /\bnota\s*:/i,
    /\baqu[íi]\b/i,
  ],
  fr: [
    /dans ce portefeuille/i,
    /sur cet appareil/i,
    /\bpropre?s?\b/i,
    /\bexactement\b/i,
    /\bd[ée]jà\b/i,
    /s'il vous pla[îi]t/i,
    /\bveuillez\b/i,
    /\bsimplement\b/i,
    /\b(vous pouvez|tu peux)\b/i,
    /\bnote\s*:/i,
    /\bici\b/i,
  ],
};

/** Dashes are never copy: plain hyphens everywhere, every locale. */
const DASH = /[\u2013\u2014]/;

const CATALOGS: Array<[string, Record<string, unknown>]> = [
  ['en', en as unknown as Record<string, unknown>],
  ['de', de as unknown as Record<string, unknown>],
  ['es', es as unknown as Record<string, unknown>],
  ['fr', fr as unknown as Record<string, unknown>],
];

/** Render one template with a probe per parameter (same walker idiom as nothingMovedCopyLaw). */
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
    return src; // unrenderable shape: the literal source still carries the words if it has any
  }
}

/** Collect every banned match as `section.path: matched copy`. */
function violations(locale: string, root: Record<string, unknown>): string[] {
  const found: string[] = [];
  const banned = BANNED[locale]!;
  const check = (text: string, path: string): void => {
    for (const re of banned) {
      if (re.test(text)) found.push(`${locale}:${path} :: ${text}`);
    }
    if (DASH.test(text)) found.push(`${locale}:${path} :: dash :: ${text}`);
  };
  const walk = (obj: unknown, path: string): void => {
    if (obj == null) return;
    if (typeof obj === 'function') {
      check(renderTemplate(obj as (...args: unknown[]) => unknown), path);
      return;
    }
    if (typeof obj === 'string') {
      check(obj, path);
      return;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        walk(v, path === '' ? k : `${path}.${k}`);
      }
    }
  };
  walk(root, '');
  return found;
}

describe('the copy-economy law: no filler words in any locale', () => {
  for (const [locale, catalog] of CATALOGS) {
    test(`${locale}: every string is free of banned filler and dashes`, () => {
      const bad = violations(locale, catalog);
      expect(bad).toEqual([]);
    });
  }
});
