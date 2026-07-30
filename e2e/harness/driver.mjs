// CDP driver — launches chrome-headless-shell (the vendored binary, resolved via browser.mjs) and
// drives the page with a tiny Puppeteer-core wrapper. Methods are test-flow-shaped: navigate, find
// by testID (RN renders testID -> web data-testid under RNW — verified), click, type, read text,
// wait for text, screenshot. Each call has a timeout + descriptive errors; nothing is swallowed.
//
// Per the rules: a fresh browser CONTEXT per run (blank localStorage) so tests are idempotent and
// independent — the app's first-run key generation runs every time, with a throwaway identity.
import puppeteer from 'puppeteer-core';
import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveExecutablePath } from './browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');

// iPhone-12-ish viewport — the RN app's styles are designed for a phone; this keeps the layout
// correct (and matches what golden-shot visual regression would compare against).
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };

// CSS injected into every page to freeze animation/caret so screenshots + text reads are stable.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

export class Driver {
  /** The base URL the app was loaded from (set by `navigate`). */
  baseURL = null;

  /** Launch the headless browser once (shared across tests in a run). Returns `{browser, stop}` —
   *  tests create their own fresh incognito CONTEXT from this browser via `create(browser)`, so each
   *  gets an isolated localStorage/identity without paying the ~1.5s browser-launch cost per test. */
  static async launchBrowser(opts = {}) {
    const exe = resolveExecutablePath();
    if (!exe) {
      throw new Error(
        '[driver] no usable chromium found.\n' +
        '  - run `npm install` in e2e/ (postinstall downloads chrome-headless-shell), OR\n' +
        '  - set DPAY_CHROMIUM to a real chrome/chromium binary.'
      );
    }
    const browser = await puppeteer.launch({
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
        // The web app is served on a different port than the relay (sirv + the relay's axum). CORS
        // is a browser-only constraint the REAL phone app never has (Android fetch doesn't enforce
        // it); rather than add CORS headers to the prod relay JUST for the browser harness, disable
        // the check in the headless browser. Standard e2e practice; matches what the real app sees.
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        ...(opts.extraArgs ?? []),
      ],
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[driver] chromium failed to launch (${exe}):\n${msg}`);
    });
    const stop = async () => { try { await browser.close(); } catch {} };
    return { browser, stop };
  }

  /** Attach page diagnostics (pageerror / console / requestfailed) so a swallowed exception in the
   *  app bubbles up. Shared between `create()` paths so a fresh context gets the same surfacing. */
  static attachPageListeners(page) {
    page.on('pageerror', (e) => console.error(`[driver] pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.type();
      const text = m.text();
      // Always surface logs that mention [shims] (install order diagnostics) and any error/warn.
      if (t === 'error' || t === 'warning' || text.includes('[shims]') || text.includes('DPAY_SELFCHECK')) {
        console.error(`[driver] console.${t}: ${text}`);
      }
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      // Ignore favicon + the relay's intentional best-effort fetches (the app's `try { fetch } catch`
      // paths produce requestfailed events when the relay is briefly down — those are not test bugs).
      if (url.endsWith('/favicon.ico')) return;
      console.error(`[driver] requestfailed: ${url} — ${req.failure()?.errorText ?? 'unknown'}`);
    });
  }

  /**
   * Create a Driver over a FRESH incognito context. Pass a shared `browser` (from `launchBrowser`)
   * so the whole run shares one browser process while each test gets isolated localStorage/identity;
   * omit it to launch+own a throwaway browser. `close()` closes only the context (and the browser if
   * this Driver launched it), so a shared-browser Driver never tears down the session's browser.
   */
  static async create(browserOrOpts, opts = {}) {
    const shared = browserOrOpts && typeof browserOrOpts.createBrowserContext === 'function' ? browserOrOpts : null;
    const o = shared ? opts : (browserOrOpts && typeof browserOrOpts === 'object' ? browserOrOpts : {});
    let browser, ownsBrowser;
    if (shared) { browser = shared; ownsBrowser = false; }
    else { const launched = await Driver.launchBrowser(o); browser = launched.browser; ownsBrowser = true; }
    // Fresh incognito context per run → fresh localStorage → fresh identity each test.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ ...VIEWPORT, width: o.width ?? VIEWPORT.width, height: o.height ?? VIEWPORT.height });
    if (o.timezone !== undefined) await page.emulateTimezone(o.timezone);
    await page.evaluateOnNewDocument(injectFreezeCss, FREEZE_CSS);
    await page.evaluateOnNewDocument(injectTestGlobals);
    Driver.attachPageListeners(page);
    return new Driver(browser, context, page, ownsBrowser);
  }

  constructor(browser, context, page, ownsBrowser = true) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.ownsBrowser = ownsBrowser;
  }

  /** Navigate to `${base}${path}` (path includes the query, e.g. `?relay=...`). Times out at 8s.
   *  `opts.waitUntil` defaults to `networkidle0` (fine for first-run/empty pages); pass
   *  `domcontentloaded` for a returning-user page that mounts the Wallet and starts continuous polls
   *  (balance 2.5s / history 5s / deposit 10s) — networkidle0 may never settle there. */
  async navigate(base, path = '/', opts = {}) {
    this.baseURL = base;
    const url = `${base}${path}`;
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const waitUntil = opts.waitUntil ?? 'networkidle0';
    try {
      await this.page.goto(url, { waitUntil, timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] navigate ${url} failed within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Wait for `window.__DPAY_READY === true` (set by shims.ts after the shims are installed). */
  async waitReady(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    try {
      await this.page.waitForFunction('window.__DPAY_READY === true', { timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] app never signaled ready within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Find an element by RN `testID` (RNW renders it as `data-testid`). Returns the ElementHandle. */
  async findByTestID(testID, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    try {
      return await this.page.waitForSelector(`[data-testid="${cssEscape(testID)}"]`, { timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] element testID=${testID} not visible within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Wait until `text` appears anywhere on the page (substring match). Returns true on success. */
  async waitForText(text, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    try {
      await this.page.waitForFunction(
        (t) => (document.body?.innerText ?? '').includes(t),
        { timeout: timeoutMs },
        text,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Click the element matched by `testID`. Scrolls into view first. Retries on element-detachment
   *  (React re-renders under fast polls can unmount a node between find and click). */
  async click(testID, opts = {}) {
    const attempts = opts.retries ?? 3;
    for (let i = 1; i <= attempts; i++) {
      const el = await this.findByTestID(testID, opts);
      try {
        await el.scrollIntoView();
        await el.click();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const detached = msg.includes('detached') || msg.includes('not attached') || msg.includes('Node not found');
        if (!detached || i === attempts) {
          throw new Error(`[driver] click testID=${testID} failed: ${msg}`);
        }
      }
    }
  }

  /** Type a string into the input matched by `testID`. Clears it first via native `select()` so the
   *  typed text REPLACES the current value (reliable for RN-web controlled inputs, including the
   *  pre-filled decimal amount field — triple-click + Backspace was racy and left partial values). */
  async type(testID, text, opts = {}) {
    const el = await this.findByTestID(testID, opts);
    await el.focus();
    // Select all current text so the subsequent keystrokes replace it (standard browser behavior).
    await el.evaluate((node) => {
      if (typeof node.select === 'function') node.select();
      else if (typeof node.setSelectionRange === 'function') node.setSelectionRange(0, (node.value ?? '').length);
    });
    if (text) await el.type(text, { delay: 5 });
  }

  /** Read the `.value` of the input matched by `testID` (readText reads textContent, which is empty
   *  for `<input>`/TextInput). Use this to verify what a controlled input actually holds. */
  async readInputValue(testID, opts = {}) {
    const el = await this.findByTestID(testID, opts);
    return await el.evaluate((node) => (node.value ?? '').toString());
  }

  /**
   * Type into an input matched by visible placeholder text (the real App's onboarding username input
   * has NO testID — its placeholder is "e.g. Alice"). Used when a flow's only handle is text.
   */
  async typeByPlaceholder(placeholder, text, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const el = await this.page.waitForSelector(`input[placeholder="${cssEscape(placeholder)}"]`, { timeout: timeoutMs });
    await el.click({ clickCount: 3 });
    await el.press('Backspace');
    if (text) await el.type(text, { delay: 5 });
  }

  /** Read the textContent of the element matched by `testID` (trimmed). */
  async readText(testID, opts = {}) {
    const el = await this.findByTestID(testID, opts);
    return await el.evaluate((node) => (node.textContent ?? '').trim());
  }

  /** Read the entire page body text (trimmed). Useful for "is this state visible?" checks. */
  async bodyText() {
    return (await this.page.evaluate(() => document.body?.innerText ?? '')).trim();
  }

  /** Take a full-page screenshot to `e2e/shots/<name>.png`. Returns the absolute path. */
  async screenshot(name) {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const path = join(SHOTS_DIR, `${name}.png`);
    await this.page.screenshot({ path, type: 'png', fullPage: false });
    const size = statSync(path).size;
    if (size <= 0) throw new Error(`[driver] screenshot ${name}.png is empty`);
    console.log(`[driver] wrote shots/${name}.png (${size} bytes)`);
    return path;
  }

  /** Evaluate a JS function in the page (escape-hatch for flows that need a custom check or an
   *  injected value). Forwards extra args to `page.evaluate(fn, ...args)` — e.g.
   *  `driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), requestQR)` injects `requestQR` into the seam. */
  async eval(fn, ...args) {
    return this.page.evaluate(fn, ...args);
  }

  /** Press a keyboard key (e.g. 'Escape', 'Enter') via a real DOM event. Powers the keyboard-shortcut
   *  surface (Escape-to-close on sheets — plan flow 14). Throws with the key name on failure. */
  async pressKey(key) {
    try {
      await this.page.keyboard.press(key);
    } catch (e) {
      throw new Error(`[driver] pressKey ${key} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Wait until NO element matches `testID` (e.g. a sheet closed and unmounted). */
  async waitGone(testID, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 3_000;
    try {
      await this.page.waitForFunction(
        (sel) => !document.querySelector(sel),
        { timeout: timeoutMs },
        `[data-testid="${cssEscape(testID)}"]`,
      );
    } catch (e) {
      throw new Error(`[driver] testID=${testID} still present after ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Non-throwing existence check: returns true iff an element matching `testID` is currently in the
   *  DOM (no wait, no throw). Use for "should be hidden" / "should be shown" guards that must not
   *  block on a timeout. Distinct from `findByTestID` (which waits + throws). */
  async isPresent(testID) {
    return await this.page.evaluate(
      (sel) => document.querySelector(sel) != null,
      `[data-testid="${cssEscape(testID)}"]`,
    );
  }

  /** Wipe localStorage (forces the app's first-run identity flow on the next load). */
  async clearStorage() {
    await this.page.evaluate(() => { try { localStorage.clear(); } catch {} });
  }

  /** Close the context (and the browser if this Driver owns it — a shared-browser Driver never
   *  tears down the session's browser). Safe to call multiple times. */
  async close() {
    try { await this.context.close(); } catch {}
    if (this.ownsBrowser) { try { await this.browser.close(); } catch {} }
  }
}

/** Minimal CSS-string escaper for `data-testid` attribute selectors (handles quotes / brackets). */
function cssEscape(s) {
  // testIDs in this app are simple (`btn-create`, `balance`, `tab-pay`); a backslash escape of any
  // char outside [A-Za-z0-9_-] is sufficient and overcautious rather than risky.
  return s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}

/** Page-start CSS injection (defined outside the class so it serializes cleanly to the browser). */
function injectFreezeCss(css) {
  const inject = () => {
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    const s = document.createElement('style');
    s.textContent = css;
    parent.appendChild(s);
    return true;
  };
  if (!inject()) document.addEventListener('DOMContentLoaded', inject, { once: true });
}

/**
 * Inject the fast-poll override so the suite isn't paced by production cadence. App.tsx reads
 * `globalThis.__DPAY_TEST_POLL` at MODULE-LOAD time (the POLL const IIFE), and evaluateOnNewDocument
 * runs before any bundle script → the shortened intervals take effect. Prod never sets this global.
 */
function injectTestGlobals() {
  globalThis.__DPAY_TEST_POLL = {
    balance: 150, history: 150, deposit: 150, receiptPay: 150, receiptRcv: 150,
  };
}
