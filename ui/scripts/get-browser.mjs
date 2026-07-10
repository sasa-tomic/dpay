// postinstall: ensure a usable headless chromium exists in the persistent cache.
//
// Idempotent: if the binary is already cached (or a real system browser exists),
// this is a no-op — so it stays offline on every run after the first install.
// Network is only touched here, at install time.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  browserCacheDir,
  findDownloadedShell,
  resolveExecutablePath,
  CHROME_BUILD_ID,
  CHROME_HEADLESS_SHELL_URL,
} from './browser.mjs';

async function main() {
  const existing = resolveExecutablePath();
  if (existing) {
    console.log(`[get-browser] using existing browser: ${existing}`);
    return;
  }

  const cacheDir = browserCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  // Preferred path: @puppeteer/browsers.install (handles layout + caching).
  try {
    const mod = await import('@puppeteer/browsers');
    const { install, Browser } = mod;
    console.log(
      `[get-browser] downloading chrome-headless-shell ${CHROME_BUILD_ID} via @puppeteer/browsers -> ${cacheDir}`
    );
    await install({
      browser: Browser.CHROMEHEADLESSSHELL,
      buildId: CHROME_BUILD_ID,
      cacheDir,
    });
    const found = findDownloadedShell();
    if (found) {
      chmodSync(found, 0o755);
      console.log(`[get-browser] installed: ${found}`);
      return;
    }
    console.warn('[get-browser] @puppeteer/browsers finished but binary not found; falling back');
  } catch (err) {
    console.warn(`[get-browser] @puppeteer/browsers install failed (${err.message}); falling back to direct download`);
  }

  // Fallback: direct download of the pinned zip + system `unzip`.
  await directDownload(cacheDir);
}

async function directDownload(cacheDir) {
  const zipPath = join(cacheDir, 'chrome-headless-shell.zip');
  console.log(`[get-browser] direct download: ${CHROME_HEADLESS_SHELL_URL}`);
  const res = await fetch(CHROME_HEADLESS_SHELL_URL);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${CHROME_HEADLESS_SHELL_URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);
  console.log(`[get-browser] downloaded ${buf.length} bytes; unzipping`);
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', cacheDir], { stdio: 'inherit' });

  const found = findDownloadedShell();
  if (!found) {
    throw new Error('unzip completed but chrome-headless-shell binary not found in cache');
  }
  chmodSync(found, 0o755);
  console.log(`[get-browser] installed: ${found}`);
}

main().catch((err) => {
  console.error(`[get-browser] FATAL: ${err.stack || err.message}`);
  // Do not fail `npm install` hard on browser download issues in restricted
  // environments; the driver will emit a clear, actionable error if no browser
  // is available at run time.
  process.exitCode = 0;
});
