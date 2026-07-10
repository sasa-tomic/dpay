// Shared browser-resolution logic for the harness.
//
// The sandbox has NO usable system chromium: /usr/bin/chromium-browser is a snap
// shim that just prints "install the chromium snap" and exits. So the harness
// downloads Chrome-for-Testing's `chrome-headless-shell` once (network is available
// at `npm install` time) into a persistent in-project cache, then runs fully offline.
//
// Resolution order for the executable:
//   1. $DPAY_CHROMIUM (explicit override)
//   2. our downloaded chrome-headless-shell under the persistent cache
//   3. a real system chromium/chrome, IF one exists and is not the broken snap shim
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..');

// Persistent cache that survives across sandbox sessions (mount-backed, gitignored).
// Falls back to a local ./.browser dir if the .dev cache isn't present.
export function browserCacheDir() {
  const devCache = join(UI_DIR, '..', '.dev', 'browser');
  const devParent = join(UI_DIR, '..', '.dev');
  if (existsSync(devParent)) return devCache;
  return join(UI_DIR, '.browser');
}

// Pinned Chrome-for-Testing build. chrome-headless-shell is a slim, headless-only
// binary — smaller than full chrome and exactly what a screenshot harness needs.
export const CHROME_BUILD_ID = '150.0.7871.49';
export const CHROME_HEADLESS_SHELL_URL =
  `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_BUILD_ID}/linux64/chrome-headless-shell-linux64.zip`;

// A path is a real browser only if it exists AND isn't the snap "please install" shim.
function isRealBrowser(p) {
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
  // Also scan for @puppeteer/browsers-style nested layout.
  for (const c of candidates) if (isRealBrowser(c)) return c;
  const found = scan(dir);
  return found;
}

function scan(dir) {
  if (!existsSync(dir)) return null;
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = require_readdir(d);
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

// tiny sync readdir with types, kept local to avoid a top-level fs import churn
import { readdirSync } from 'node:fs';
function require_readdir(d) {
  return readdirSync(d, { withFileTypes: true });
}

// Final resolver used by the driver.
export function resolveExecutablePath() {
  if (process.env.DPAY_CHROMIUM && isRealBrowser(process.env.DPAY_CHROMIUM)) {
    return process.env.DPAY_CHROMIUM;
  }
  const shell = findDownloadedShell();
  if (shell) return shell;
  for (const sys of ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']) {
    if (isRealBrowser(sys)) return sys;
  }
  return null;
}

export { isRealBrowser };
