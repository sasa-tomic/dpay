// Shared browser-resolution logic for the e2e harness.
//
// The sandbox has NO usable system chromium: /usr/bin/chromium-browser is a snap shim that just
// prints "install the chromium snap" and exits. So the harness prefers a vendored
// chrome-headless-shell (downloaded once by get-browser.mjs at `npm install` time, then offline).
//
// Resolution order for the executable:
//   1. $DPAY_CHROMIUM (explicit override)
//   2. our downloaded chrome-headless-shell under the persistent cache
//   3. the playwright/puppeteer browser cache (offline reuse of an already-downloaded shell —
//      common in CI/sandboxes that already ran playwright; only the path is read)
//   4. a real system chromium/chrome, IF one exists and is not the broken snap shim
//
// This file is ui/scripts/browser.mjs + the playwright/puppeteer cache scan additions for offline
// reuse. The behavior is identical for the common case (a chrome-headless-shell under .dev/browser).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');
const REPO_ROOT = join(E2E_DIR, '..');

// Persistent cache that survives across sandbox sessions (mount-backed, gitignored). Falls back to a
// local ./.browser dir if the .dev cache isn't present (mirrors ui/scripts/browser.mjs).
export function browserCacheDir() {
  const devCache = join(REPO_ROOT, '.dev', 'browser');
  const devParent = join(REPO_ROOT, '.dev');
  if (existsSync(devParent)) return devCache;
  return join(E2E_DIR, '.browser');
}

// Pinned Chrome-for-Testing build. chrome-headless-shell is a slim, headless-only binary — smaller
// than full chrome and exactly what an e2e harness needs. (Same pin as ui/scripts/browser.mjs so the
// two harnesses share a cache when both are run in the same sandbox.)
export const CHROME_BUILD_ID = '150.0.7871.49';
export const CHROME_HEADLESS_SHELL_URL =
  `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_BUILD_ID}/linux64/chrome-headless-shell-linux64.zip`;

// A path is a real browser only if it exists AND isn't the snap "please install" shim.
export function isRealBrowser(p) {
  if (!p || !existsSync(p)) return false;
  try {
    const head = readFileSync(p).subarray(0, 512).toString('utf8');
    if (head.includes('requires the chromium snap')) return false; // broken shim
    return true;
  } catch {
    return true; // binary (unreadable as text) -> treat as real
  }
}

// Look for our downloaded chrome-headless-shell anywhere under the cache dir.
export function findDownloadedShell() {
  const dir = browserCacheDir();
  const candidates = [
    join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
  ];
  for (const c of candidates) if (isRealBrowser(c)) return c;
  return scan(dir);
}

/**
 * Scan well-known external caches for an already-downloaded chrome-headless-shell (or a compatible
 * full chrome). Offline reuse — only the path is read, nothing is fetched. Order:
 *   - $HOME/.cache/ms-playwright/chromium_headless_shell-X/chrome-headless-shell-linux64/chrome-headless-shell
 *   - $HOME/.cache/ms-playwright/chromium-X/chrome-linux/chrome
 *   - $HOME/.cache/puppeteer/chrome/X/chrome-linux64/chrome
 */
function findInExternalCaches() {
  const home = homedir();
  const roots = [
    join(home, '.cache', 'ms-playwright'),
    join(home, '.cache', 'puppeteer'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = scan(root);
    if (found) return found;
  }
  return null;
}

function scan(dir) {
  if (!existsSync(dir)) return null;
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name === 'chrome-headless-shell' || e.name === 'chrome') {
        if (isRealBrowser(full)) return full;
      }
    }
  }
  return null;
}

// Final resolver used by the driver.
export function resolveExecutablePath() {
  if (process.env.DPAY_CHROMIUM && isRealBrowser(process.env.DPAY_CHROMIUM)) {
    return process.env.DPAY_CHROMIUM;
  }
  const shell = findDownloadedShell();
  if (shell) return shell;
  const external = findInExternalCaches();
  if (external) return external;
  for (const sys of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (isRealBrowser(sys)) return sys;
  }
  return null;
}
