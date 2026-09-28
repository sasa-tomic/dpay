/**
 * Smoke-tier DRIFT test — runs in the DOMAIN project, so it gates the smoke tier even when nobody
 * runs `just smoke`. Three static checks keep the manifest honest:
 *   (a) every manifest entry exists on disk (a renamed/deleted file must leave the manifest);
 *   (b) no manifest entry's source matches the banned-import pattern — smoke is pure node, zero
 *       network, zero chrome/anvil/spawn, no flow-harness imports, no full-<App/> mounts. This is
 *       a STATIC approximation of criterion 2/3 (a mocked-fetch call-shape pin is legal; a bare
 *       `fetch(` call is not — matched here); the per-test wall budget stays with budget-setup.js;
 *   (c) scripts/smoke-files.mjs output parses and is non-empty (the runner's feed cannot rot).
 */
import {readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {describe, expect, test} from '@jest/globals';
import {SMOKE_FILES} from './manifest';

const here = dirname(__dirname); // app/__tests__
const appRoot = dirname(here); // app/
const repoRoot = join(appRoot, '..');

// Real-tooling imports only — deliberately NOT the bare word "anvil" (the app's own chain slug
// for 31337 is `anvil`, and pinning that slug is exactly the catalog-drift coverage smoke wants).
const BANNED =
  /(e2e\/anvil|anvil\.mjs|puppeteer|child_process|node:net|node:https?|__tests__\/flow\/|e2e\/harness|<App[ /]|from '\.\.\/App'|require\('\.\.\/App'\)|(^|[^A-Za-z0-9_.$])fetch\s*\()/;

describe('smoke manifest — the tier cannot rot', () => {
  test('every manifest entry exists on disk', () => {
    expect(SMOKE_FILES.length).toBeGreaterThan(0);
    for (const f of SMOKE_FILES) {
      expect({file: f, exists: existsSync(join(appRoot, '__tests__', f))}).toEqual({file: f, exists: true});
    }
  });

  test('every manifest entry is pure-node, network-free, non-flow source (static drift check)', () => {
    for (const f of SMOKE_FILES) {
      const src = readFileSync(join(appRoot, '__tests__', f), 'utf8');
      const hit = src.match(BANNED);
      expect({file: f, banned: hit ? hit[0] : null}).toEqual({file: f, banned: null});
    }
  });

  test('scripts/smoke-files.mjs output parses and is non-empty', () => {
    const r = spawnSync('node', [join(repoRoot, 'scripts', 'smoke-files.mjs')], {encoding: 'utf8'});
    expect(r.status).toBe(0);
    const out = r.stdout.trim().split(/\s+/).filter(Boolean);
    expect(out.length).toBe(SMOKE_FILES.length);
    for (const p of out) {
      expect({path: p, shaped: p.startsWith('__tests__/') && p.endsWith('.test.ts') || p.endsWith('.test.tsx')})
        .toEqual({path: p, shaped: true});
    }
  });
});
