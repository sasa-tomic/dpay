// The code-copy economy pin (founder 2026-10-05: "EVERY WORD COSTS US, REMOVE ALL WORDS THAT
// DO NOT HAVE TO BE READ BY THE USER"). Regex-scans the code-owned user-facing strings (the
// literals this repo renders verbatim: executor/engine failureDetails, thrown errors a panel
// prints, wallet errors) for filler the reader never needs: "in this wallet", "on this
// device", "your own", "exactly", "please", "the whole", politeness padding, and em-dashes
// (plain hyphens only). The M.* i18n domains are ANOTHER lane's files - not scanned here.
// Error CAUSES, amounts-with-currency, and safety disclosures stay; only filler goes.

import {readdirSync, readFileSync, statSync} from 'fs';
import {join} from 'path';
import {describe, expect, it} from '@jest/globals';

const OWNED_ROOTS = ['components', 'convert', 'lib'];
const SKIP_FILES = new Set([
  // The BIP39 English wordlist IS data, not copy: its words ("please", "already") are seed
  // vocabulary a user must read back, not UI prose.
  'bip39-wordlist.ts',
]);

const BANNED: ReadonlyArray<[string, RegExp]> = [
  ['in this wallet', /in this wallet/i],
  ['on this device', /on this device/i],
  ['your own', /your own/i],
  ['exactly', /\bexactly\b/i],
  ['please', /\bplease\b/i],
  ['the whole', /the whole\b/i],
  ['kindly', /\bkindly\b/i],
  ['simply', /\bsimply\b/i],
  ['note that', /\bnote that\b/i],
  ['keep in mind', /keep in mind/i],
  ['make sure', /\bmake sure\b/i],
  // Em-dash in prose; the bare '—' literal is the empty-value placeholder glyph, not prose.
  ['em-dash (use a plain hyphen)', /—/],
];

function* ownedFiles(): Generator<string> {
  const root = join(__dirname, '..');
  const entries: string[] = [];
  for (const d of OWNED_ROOTS) {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e)) entries.push(p);
      }
    };
    walk(join(root, d));
  }
  for (const f of readdirSync(root)) {
    if (/\.(ts|tsx)$/.test(f) && statSync(join(root, f)).isFile()) entries.push(join(root, f));
  }
  for (const f of entries.sort()) {
    if (!SKIP_FILES.has(f.split('/').pop() ?? '')) yield f;
  }
}

// Comments never render; only string literals can reach the user. Block and line comments
// are blanked (newlines kept so line numbers stay true), then literals are read.
function literalsOf(src: string): Array<{lit: string; line: number}> {
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
  const out: Array<{lit: string; line: number}> = [];
  const re = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blanked)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3] ?? '';
    // The bare em-dash glyph is the UI's empty-value placeholder ("no timestamp"), not prose.
    if (lit.trim() === '—') continue;
    out.push({lit, line: blanked.slice(0, m.index).split('\n').length});
  }
  return out;
}

describe('code copy economy: no filler words in code-owned user-facing strings', () => {
  it('owned app files carry no banned filler in string literals', () => {
    const violations: string[] = [];
    for (const file of ownedFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const {lit, line} of literalsOf(src)) {
        for (const [name, re] of BANNED) {
          if (re.test(lit)) violations.push(`${file}:${line}: "${name}" in: ${lit.slice(0, 140)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
