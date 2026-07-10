// Drive the built app in headless chromium and capture the four flow states.
//
// Expects the app to already be served at $DPAY_BASE_URL (default http://127.0.0.1:4173).
// scripts/ui.mjs orchestrates build + serve + this + compare; run standalone only if
// you have a server up.
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { resolveExecutablePath } from './browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..');
const SHOTS_DIR = join(UI_DIR, 'shots');
const BASE = process.env.DPAY_BASE_URL || 'http://127.0.0.1:4173';

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };
// A sample opaque scan payload. The string is opaque to the app; JSON is convenient.
const SCAN_PAYLOAD = JSON.stringify({ amount: '5.00', to: 'Café Demo' });

// CSS injected into every page to freeze animation/caret so screenshots are stable.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

function fail(msg) {
  console.error(`\n[shoot] ERROR: ${msg}\n`);
  process.exit(1);
}

async function shot(page, name) {
  const path = join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path, type: 'png' });
  const size = statSync(path).size;
  if (size <= 0) fail(`screenshot ${name}.png is empty`);
  console.log(`[shoot] wrote ${name}.png (${size} bytes)`);
  return { name, path, size };
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateTimezone('UTC');
  await page.evaluateOnNewDocument((css) => {
    // Runs at document-start, before <html> may exist — inject defensively.
    const inject = () => {
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      const s = document.createElement('style');
      s.textContent = css;
      parent.appendChild(s);
      return true;
    };
    if (!inject()) {
      document.addEventListener('DOMContentLoaded', inject, { once: true });
    }
  }, FREEZE_CSS);
  page.on('pageerror', (e) => console.error(`[shoot] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[shoot] console.error: ${m.text()}`);
  });
  return page;
}

async function waitReady(page) {
  await page.waitForFunction('window.__DPAY_READY === true', { timeout: 15000 });
}

async function main() {
  const exe = resolveExecutablePath();
  if (!exe) {
    fail(
      'no usable chromium found.\n' +
      '  - /usr/bin/chromium-browser is a snap shim (prints "install the chromium snap") and cannot run.\n' +
      '  - run `npm install` (its postinstall downloads chrome-headless-shell), or set DPAY_CHROMIUM to a real chrome/chromium binary.'
    );
  }
  console.log(`[shoot] chromium: ${exe}`);
  console.log(`[shoot] base url: ${BASE}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--hide-scrollbars',
      ],
    });
  } catch (err) {
    fail(`chromium failed to launch (${exe}):\n${err.stack || err.message}`);
  }

  try {
    // 01 - receive (merchant), default screen
    let page = await newPage(browser);
    await page.goto(`${BASE}/?screen=receive`, { waitUntil: 'networkidle0' });
    await waitReady(page);
    await page.waitForSelector('[data-testid=amount-input]', { timeout: 10000 });
    await shot(page, '01-receive');

    // 02 - request: click Request -> request-QR appears
    await page.click('[data-testid=btn-request]');
    await page.waitForSelector('[data-testid=request-qr]', { timeout: 10000 });
    await shot(page, '02-request');
    await page.close();

    // 03 - scanned (payer): open pay screen, inject a scan via the camera SEAM
    page = await newPage(browser);
    await page.goto(`${BASE}/?screen=pay`, { waitUntil: 'networkidle0' });
    await waitReady(page);
    await page.waitForSelector('[data-testid=pay-waiting]', { timeout: 10000 });
    await page.evaluate((p) => window.__DPAY_TEST_SCAN(p), SCAN_PAYLOAD);
    await page.waitForSelector('[data-testid=btn-approve]', { timeout: 10000 });
    await shot(page, '03-scanned');

    // 04 - paid: click Approve -> "Paid ✓ $X"
    await page.click('[data-testid=btn-approve]');
    await page.waitForSelector('[data-testid=pay-paid]', { timeout: 10000 });
    await shot(page, '04-paid');
    await page.close();

    console.log('[shoot] all 4 screenshots captured');
  } finally {
    await browser.close();
  }
}

main().catch((err) => fail(err.stack || err.message));
