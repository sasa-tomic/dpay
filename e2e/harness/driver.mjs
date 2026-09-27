// CDP driver — acquires the machine-global chrome-headless-shell through the gate (browser.mjs:
// discovery-before-spawn + the cross-run admission lock) and drives the page with a tiny
// Puppeteer-core wrapper. Methods are test-flow-shaped: navigate, find by testID (RN renders
// testID -> web data-testid under RNW — verified), click, type, read text, wait for text,
// screenshot. Each call has a timeout + descriptive errors; nothing is swallowed.
//
// Per the rules: a fresh browser CONTEXT per run (blank localStorage) so tests are idempotent and
// independent — the app's first-run key generation runs every time, with a throwaway identity.
import { mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveExecutablePath, acquireBrowser } from './browser.mjs';
import { _testCtx } from './lib.mjs';
import { installSolAccountsHelper } from './solaccounts.mjs';
import { PROFILING, profOp, profSpan } from './profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(__dirname, '..', 'shots');
const FAILURES_DIR = join(SHOTS_DIR, 'failures');

// Timeline ring-buffer + console-log caps. Kept small so the per-call push is trivial (the suite
// makes thousands of driver calls); the dump only needs the last N actions to reconstruct what a
// failing flow was doing right before it went RED.
const TIMELINE_MAX = 200;
const CONSOLE_MAX = 500;
/** Resource types whose HTTP error status is always a broken BUILD, never product behaviour: the
 *  page itself, the JS chunks, the stylesheet, the fonts, the images and the core wasm (`other`).
 *  Deliberately excludes `fetch`/`xhr` — see the `response` listener. */
const ASSET_RESOURCE_TYPES = new Set(['document', 'script', 'stylesheet', 'font', 'image', 'media', 'other']);

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

/**
 * The host-load timeout scale, published by `run.mjs` before any flow starts.
 *
 * WHY THIS EXISTS. The runner already scales each flow's WALL-CLOCK budget by host load, so a busy
 * machine gets a longer allowance instead of a uniformly red suite. But every wait INSIDE a flow —
 * `navigate`, `findByTestID`, `waitForText` — carried a fixed millisecond budget that no load
 * measurement touched. So on a loaded box the inner wait blew first, and the failure read as
 * "element not visible within 5000ms": a statement about the app when it was a statement about the
 * machine. Three flows went red that way on a tree where nothing was wrong (105, 106, 156), and
 * each one cost a round of investigation before the cause was clear.
 *
 * Scaling both together keeps ONE notion of "how slow is this host" instead of two that disagree.
 * It cannot mask a genuine hang: the per-test wall clock still bounds the flow and is scaled by the
 * same factor, so a flow that never finishes still fails — with the timeout that describes it.
 */
/** A caller-supplied or default wait, stretched by the host-load scale.
 *
 *  Read LAZILY, not at module load. `run.mjs` publishes the scale after it has measured the host,
 *  by which time this module has long been imported — a module-scope constant captured 1 and every
 *  inner wait stayed unscaled, which is the exact bug this helper was added to fix.
 *
 *  Re-read on EVERY call: `runOne` republishes the env per test start with the LIVE 1-min load
 *  folded in (a test starting mid-spike gets the spike's factor), so a value frozen at the first
 * read would leave every later test's inner waits at the run-start scale — the exact class that
 * killed 176 mid-spike (12s wait died at ×1.30 while the box was at ×2+). Number() on a short
 * string is nothing next to a CDP roundtrip. Exported for the harness's own raw-deadline loops
 * (lib.mjs skip-practice) which sit OUTSIDE the driver's method-level waits and would otherwise
 * run unscaled — the 2026-09-17 verify RED on 164 (15s practice deadline at scale ×1.42, green
 * everywhere else) is that hole, punched through.
 */
export function scaled(ms) {
  const raw = process.env.DPAY_E2E_TIMEOUT_SCALE;
  if (raw === undefined) return Math.round(ms);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[driver] ignoring DPAY_E2E_TIMEOUT_SCALE="${raw}" — not a positive number`);
    return Math.round(ms);
  }
  return Math.round(ms * n);
}

export class Driver {
  /** The base URL the app was loaded from (set by `navigate`). */
  baseURL = null;

  /**
   * The app-boot intent stashed by `setup()` (lib.mjs): `{base, path, relay, navTimeoutMs,
   * readyTimeoutMs}` — where the single app boot navigates and which relay the seed targets.
   * `appBooted` flips true once a navigation has landed the app on this page, whether by
   * `setup()`'s eager prologue (DPAY_E2E_NO_LAZY_BOOT=1) or by the seeding helpers' single
   * boot. Under the default LAZY boot neither is touched until `onboardWallet` (or a flow's
   * own navigation) first loads the app.
   */
  appBoot = null;
  appBooted = false;

  /** Acquire the run's browser through the machine-global chrome gate (browser.mjs): reuse the
   *  singleton shell when one is alive (puppeteer.connect), else launch it under the cross-run
   *  admission lock. Returns `{browser, stop}` — tests create their own fresh incognito CONTEXT
   *  from this browser via `create(browser)`, so each gets an isolated localStorage/identity
   *  without paying a browser-launch cost per test. `stop` DISCONNECTS this connection only;
   *  the gate owns the shell's lifecycle: it is torn down (with the pid-registry SIGKILL
   *  backstop) when the run's LAST connection drops, and only if this run launched it. */
  static async launchBrowser(opts = {}) {
    const exe = resolveExecutablePath();
    if (!exe) {
      throw new Error(
        '[driver] no usable chromium found.\n' +
        '  - run `npm install` in e2e/ (postinstall downloads chrome-headless-shell), OR\n' +
        '  - set DPAY_CHROMIUM to a real chrome/chromium binary.'
      );
    }
    return acquireBrowser({ executablePath: exe, extraArgs: opts.extraArgs ?? [] });
  }

  /** Attach page diagnostics and retain every unexpected error so teardown fails the flow. */
  attachPageListeners() {
    this.page.on('pageerror', (e) => {
      this.recordUnexpectedDiagnostic(`pageerror: ${e.message}`);
    });
    this.page.on('console', (m) => {
      const t = m.type();
      const text = m.text();
      // Buffer EVERY console message (all types) for the RED-path diagnostics dump. Capped; the
      // push is O(1) and only runs while the buffer has room. This is ADDITIVE — the existing
      // fail-closed diagnostic-recording below is unchanged.
      if (this.consoleLog.length < CONSOLE_MAX) {
        this.consoleLog.push({ t: Date.now(), type: t, text });
      }
      // Chrome emits this URL-less duplicate for request failures. `requestfailed` below is the
      // authoritative, URL-aware gate and can distinguish an explicitly allowed dead relay.
      if (t === 'error' && text.startsWith('Failed to load resource:')) return;
      if (text.includes('DPAY_SELFCHECK FAIL')) {
        this.recordUnexpectedDiagnostic(`console.${t}: ${text}`);
      } else if (t === 'error') {
        this.recordUnexpectedDiagnostic(`console.error: ${text}`);
      } else if (t === 'warning' || text.includes('[shims]')) {
        console.error(`[driver] console.${t}: ${text}`);
      } else if (text.includes('DPAY_SELFCHECK')) {
        console.log(`[driver] console.${t}: ${text}`);
      }
    });
    this.page.on('requestfailed', (req) => {
      const url = req.url();
      const errorText = req.failure()?.errorText ?? 'unknown';
      const intentionalAbort = errorText === 'net::ERR_ABORTED';
      // ERR_NETWORK_CHANGED is Chromium's network service killing in-flight fetches when the HOST's
      // interface table churns (docker bridges, tailscale, the emulator's NAT) — transport-level
      // noise, not app behavior. Measured 2026-09-12: three suite runs red on three DIFFERENT
      // flows (79/26/108), each green in isolation, every failure solely this gate tripping on the
      // app's own background balance poll to its OWN LIVE relay, every functional assertion in the
      // affected flows passing (the poll is retry-by-design and recovered silently). Same genre as
      // the ERR_ABORTED teardown tolerance. A real balance-path break still fails the flows' balance
      // assertions, and every other requestfailed class (ERR_CONNECTION_REFUSED et al.) stays flagged.
      const hostInterfaceChurn = errorText === 'net::ERR_NETWORK_CHANGED';
      if (this.closing || intentionalAbort || hostInterfaceChurn || url.endsWith('/favicon.ico') || this.isRequestFailureAllowed(url)) return;
      this.recordUnexpectedDiagnostic(`requestfailed: ${url} — ${errorText}`);
    });
    // A 404 IS NOT A `requestfailed`, AND THAT WAS THE HOLE. Puppeteer emits `requestfailed` only
    // for transport failures — an HTTP error status is a perfectly successful response and arrives
    // as `requestfinished`. Chrome's own `Failed to load resource: … 404` console line is dropped a
    // few lines above as a URL-less duplicate, so between the two, a MISSING ASSET was invisible to
    // this gate: the whole suite would stay green with a bundle chunk, a font or the core wasm
    // 404ing. (This is the residue of the "receipt-poll 404 console lines — cosmetic" disposition:
    // an expected 404 taught the harness to ignore a class that also contains real failures.)
    //
    // Scope is STATIC ASSETS only. `fetch`/`xhr` are the app's own API calls, where a 404 is often
    // the product working as designed — an unknown checkout charge, a relay that serves no checkout, a
    // capabilities probe against a relay that has none — and those are asserted by the flows that
    // provoke them, not here.
    this.page.on('response', (res) => {
      if (this.closing || res.status() < 400) return;
      const req = res.request();
      if (!ASSET_RESOURCE_TYPES.has(req.resourceType())) return;
      const url = res.url();
      // The one allowlisted asset: Chrome requests /favicon.ico implicitly and `e2e/web/index.html`
      // declares no icon, so it 404s once per page load. (The SHIPPED page, wallet.html, does
      // declare one — this is harness-only.)
      if (url.endsWith('/favicon.ico') || this.isRequestFailureAllowed(url)) return;
      this.recordUnexpectedDiagnostic(`asset ${req.resourceType()} ${url} answered HTTP ${res.status()}`);
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
    let browser, ownsBrowser, gateStop = null;
    if (shared) { browser = shared; ownsBrowser = false; }
    else {
      const launched = await Driver.launchBrowser(o);
      browser = launched.browser;
      ownsBrowser = true;
      // The gate owns the shell's lifecycle: keep its stop (disconnect + lease teardown) so
      // close() never sends Browser.close over a connection we don't exclusively own — that
      // would kill a shell this run only connected to, and orphan the gate's lock.
      gateStop = launched.stop;
    }
    // Fresh incognito context per run → fresh localStorage → fresh identity each test.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ ...VIEWPORT, width: o.width ?? VIEWPORT.width, height: o.height ?? VIEWPORT.height });
    // Pin the clock and the language, always. Both were previously inherited from whatever the host
    // happened to be set to, which is a flake waiting for the first developer in a non-UTC,
    // non-English environment: the app resolves its catalog from the device locale, so a German
    // laptop would render the whole suite in German and fail 81 flows at the first assertion, and
    // every ledger timestamp shifts with the host zone. A flow that WANTS another locale asks for
    // it (`setup({locale: 'de-DE'})`); the default is the one the assertions are written against.
    await page.emulateTimezone(o.timezone ?? 'UTC');
    // `Emulation.setLocaleOverride` is what drives `Intl` — which is exactly where the app reads
    // the device tag from (`i18n/locale.ts` deviceLocaleTag). Chrome's `--lang` flag would not do
    // it: the browser is shared across the whole run, so a per-flow launch flag is not available.
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setLocaleOverride', { locale: o.locale ?? 'en-US' });
    // Wave-4 dual theme: emulate an OS dark scheme (flows pass opts.dark). Applied at the PAGE
    // level so window.matchMedia('(prefers-color-scheme: dark)') — which RNW's Appearance/useColorScheme
    // and the hosts' CSS @media blocks key on — reports dark BEFORE any page script runs.
    if (o.dark) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }
    await page.evaluateOnNewDocument(injectFreezeCss, FREEZE_CSS);
    await page.evaluateOnNewDocument(injectTestGlobals);
    // SOL stub RPC: when a flow requests it (opts.solStub), override the SOLANA_RPC_URL disable so
    // the app's SOL seam functions work against the stub. Runs AFTER injectTestGlobals (which sets
    // URL='') so the override takes effect. The stub object itself is set at runtime via driver.eval.
    if (o.solStub) {
      await page.evaluateOnNewDocument(() => { globalThis.__DPAY_TEST_SOLANA_RPC_URL = 'stub'; });
      // …and the account encoder every flow's `getMultipleAccounts` handler answers through, so a
      // flow declares balances and not SPL byte layouts (harness/solaccounts.mjs).
      await page.evaluateOnNewDocument(installSolAccountsHelper);
    }
    // REAL Solana-over-relay (flow 165): re-enable the SOL rail's REAL RPC path instead of
    // the suite default (disabled) or the in-page stub ('stub'). Runs after injectTestGlobals
    // (evaluateOnNewDocument scripts run in registration order), and the app captures the
    // value at module load, so it lands before the bundle evaluates on every navigation:
    //   • 'derive' — DELETE the global entirely: `constants.ts` treats an unset override as
    //     "no test override" and derives the candidate list from the App-installed relay
    //     bases — the exact production path, App.tsx wiring included.
    //   • any other string — that URL IS the whole candidate list (e.g. a harness relay's
    //     proxy route pinned explicitly).
    if (o.solRpcUrl) {
      await page.evaluateOnNewDocument((u) => {
        if (u === 'derive') delete globalThis.__DPAY_TEST_SOLANA_RPC_URL;
        else globalThis.__DPAY_TEST_SOLANA_RPC_URL = u;
      }, o.solRpcUrl);
    }
    // EVM seam (spec 2026-09-26 D27) — the solRpcUrl mirror, EVM-seam lines only: 'derive'
    // DELETES the override (the relay-derived per-chain route stands — the production path);
    // any other string is the whole candidate list (e.g. the harness relay's /api/v1/evm/rpc
    // pipe URL, so anvil flows ride the REAL proxy). Runs after injectTestGlobals (which sets
    // ''), and the app captures the value at module load, so it lands before the bundle
    // evaluates on every navigation.
    if (o.evmRpcUrl) {
      await page.evaluateOnNewDocument((u) => {
        if (u === 'derive') delete globalThis.__DPAY_TEST_EVM_RPC_URL;
        else globalThis.__DPAY_TEST_EVM_RPC_URL = u;
      }, o.evmRpcUrl);
    }
    const driver = new Driver(browser, context, page, ownsBrowser, gateStop);
    // The create-time CDP session (locale override lives HERE — a second session stacking another
    // locale override is a protocol error, so flows that switch locale mid-run must reuse this one).
    driver.cdp = cdp;
    driver.attachPageListeners();
    return driver;
  }

  constructor(browser, context, page, ownsBrowser = true, gateStop = null) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.ownsBrowser = ownsBrowser;
    // The chrome-gate lease teardown (browser.mjs), when this Driver launched/adopted the shell
    // through the gate. close() routes through it instead of `browser.close()` so the shared
    // singleton shell is never killed over a mere connection.
    this.gateStop = gateStop;
    this.allowedRequestFailureOrigins = new Set();
    this.unexpectedDiagnostics = new Set();
    this.navigationDepth = 0;
    this.closing = false;
    this.closed = false;
    // Action timeline (ring buffer) + full console-message buffer, captured for the RED-path
    // diagnostics dump. Both are in-memory only — they survive context close, so the dump can
    // always write actions.json + console.log even when the page is already torn down.
    this.timeline = [];
    this.timelineHead = 0;
    this.consoleLog = [];
    // Profiler attribution (set by lib.mjs setup() once the owning test file is known) + the
    // opt-in per-method timing wrapper. See harness/profile.mjs.
    this.profileFile = null;
    if (PROFILING) installDriverProfiler(this);
  }

  /** Explicitly permit transport failures to one origin. Offline flows must call this before they
   *  retarget the app; every other failed request remains fatal. */
  allowRequestFailuresFrom(baseURL) {
    let origin;
    try {
      origin = new URL(baseURL).origin;
    } catch {
      throw new Error(`[driver] invalid allowed request-failure URL: ${baseURL}`);
    }
    this.allowedRequestFailureOrigins.add(origin);
  }

  isRequestFailureAllowed(url) {
    try {
      return this.allowedRequestFailureOrigins.has(new URL(url).origin);
    } catch {
      return false;
    }
  }

  recordUnexpectedDiagnostic(message) {
    if (this.unexpectedDiagnostics.has(message)) return;
    this.unexpectedDiagnostics.add(message);
    console.error(`[driver] ${message}`);
  }

  /**
   * Push a timeline entry `{t, op, arg}` at the START of a driver method (before the await). O(1)
   * ring buffer — once full, overwrites the oldest entry in place via `timelineHead`. The arg is
   * flattened to a SHORT string by `_fmtTimelineArg` (never JSON.stringify large objects on the hot
   * path; testIDs are tiny strings). Called thousands of times per run — must stay trivial.
   */
  _recordTimeline(op, arg) {
    const entry = { t: Date.now(), op, arg: _fmtTimelineArg(arg) };
    if (this.timeline.length < TIMELINE_MAX) {
      this.timeline.push(entry);
    } else {
      this.timeline[this.timelineHead] = entry;
      this.timelineHead = (this.timelineHead + 1) % TIMELINE_MAX;
    }
  }

  /** Chronologically-ordered view of the ring buffer (oldest → newest). */
  _orderedTimeline() {
    if (this.timeline.length < TIMELINE_MAX) return this.timeline;
    return [...this.timeline.slice(this.timelineHead), ...this.timeline.slice(0, this.timelineHead)];
  }

  assertNoUnexpectedDiagnostics() {
    if (this.unexpectedDiagnostics.size === 0) return;
    const details = [...this.unexpectedDiagnostics].map((d) => `  - ${d}`).join('\n');
    throw new Error(`[driver] unexpected page diagnostics:\n${details}`);
  }

  /** Navigate to `${base}${path}` (path includes the query, e.g. `?relay=...`). Times out at 8s.
   *  `opts.waitUntil` defaults to `networkidle0` (fine for first-run/empty pages); pass
   *  `domcontentloaded` for a returning-user page that mounts the Wallet and starts continuous polls
   *  (balance 2.5s / history 5s / deposit 10s) — networkidle0 may never settle there. */
  async navigate(base, path = '/', opts = {}) {
    this._recordTimeline('navigate', `${base}${path}`);
    this.baseURL = base;
    const url = `${base}${path}`;
    const timeoutMs = scaled(opts.timeoutMs ?? 8_000);
    const waitUntil = opts.waitUntil ?? 'networkidle0';
    this.navigationDepth += 1;
    try {
      await this.page.goto(url, { waitUntil, timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] navigate ${url} failed within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.navigationDepth -= 1;
    }
  }

  /** Wait for `window.__DPAY_READY === true` (set by shims.ts after the shims are installed). */
  async waitReady(opts = {}) {
    const timeoutMs = scaled(opts.timeoutMs ?? 10_000);
    try {
      await this.page.waitForFunction('window.__DPAY_READY === true', { timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] app never signaled ready within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Register a script that runs BEFORE any page script on every navigation until removed.
   *  Returns the identifier for `removeInitScript`. This is what makes pre-boot storage seeding
   *  possible: the seed lands on the APP ORIGIN before the bundle evaluates, so onboarding by
   *  planted identity needs only ONE navigation (no "boot, eval, boot again" preamble). */
  async addInitScript(fn, ...args) {
    const reg = await this.page.evaluateOnNewDocument(fn, ...args);
    return reg.identifier;
  }

  /** Unregister an `addInitScript` script. The seed script is one-shot by contract: once the
   *  seeded boot has landed, later in-flow reloads must see the page exactly as the app left
   *  it — a lingering seed would `localStorage.clear()` away mid-flow writes on every reload. */
  async removeInitScript(identifier) {
    await this.page.removeScriptToEvaluateOnNewDocument(identifier);
  }

  /** The page's current full URL (the honest location — `baseURL` carries no query). */
  pageURL() {
    return this.page.url();
  }

  /** Find an element by RN `testID` (RNW renders it as `data-testid`). Returns the ElementHandle. */
  async findByTestID(testID, opts = {}) {
    this._recordTimeline('findByTestID', testID);
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    try {
      return await this.page.waitForSelector(`[data-testid="${cssEscape(testID)}"]`, { timeout: timeoutMs });
    } catch (e) {
      throw new Error(`[driver] element testID=${testID} not visible within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Wait until `text` appears anywhere on the page (substring match). Returns true on success.
   *
   *  A TIMEOUT returns false (the documented soft-probe contract — callers may `if (await ...)`
   *  or `.catch(() => {})`). But a NON-timeout rejection (page crash, protocol error, detached
   *  target) is a real infrastructure failure, NOT a benign "text not found": returning false there
   *  would let a flow continue on a dead page and pass/fail opaquely. So only a TimeoutError
   *  resolves to false; every other error is rethrown loud with the waited-for text + cause. */
  async waitForText(text, opts = {}) {
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    try {
      await this.page.waitForFunction(
        (t) => (document.body?.innerText ?? '').includes(t),
        { timeout: timeoutMs },
        text,
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Puppeteer names its wait timeout `TimeoutError`; fall back to the message shape for safety.
      if (e?.name === 'TimeoutError' || /Waiting.*failed|timeout/i.test(msg)) return false;
      throw new Error(`[driver] waitForText(${JSON.stringify(text)}) failed: ${msg}`);
    }
  }

  /** Click the element matched by `testID`. Scrolls into view first. Retries on element-detachment
   *  (React re-renders under fast polls can unmount a node between find and click). */
  async click(testID, opts = {}) {
    this._recordTimeline('click', testID);
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
    this._recordTimeline('type', `${testID}:${text}`);
    const el = await this.findByTestID(testID, opts);
    await el.focus();
    // Select all current text so the subsequent keystrokes replace it (standard browser behavior).
    await el.evaluate((node) => {
      if (typeof node.select === 'function') node.select();
      else if (typeof node.setSelectionRange === 'function') node.setSelectionRange(0, (node.value ?? '').length);
    });
    // An EMPTY string means CLEAR, not "do nothing". Select-all followed by no keystroke leaves the
    // field exactly as it was, so `type(id, '')` used to be a silent no-op — a test could assert an
    // empty-value behaviour and never once empty the field. Backspace deletes the selection.
    if (text) await el.type(text, { delay: 5 });
    else await this.page.keyboard.press('Backspace');
  }

  /** Read the `.value` of the input matched by `testID` (readText reads textContent, which is empty
   *  for `<input>`/TextInput). Use this to verify what a controlled input actually holds. */
  async readInputValue(testID, opts = {}) {
    this._recordTimeline('readInputValue', testID);
    const el = await this.findByTestID(testID, opts);
    return await el.evaluate((node) => (node.value ?? '').toString());
  }

  /**
   * Type into an input matched by visible placeholder text (the real App's onboarding username input
   * has NO testID — its placeholder is "e.g. Alice"). Used when a flow's only handle is text.
   */
  async typeByPlaceholder(placeholder, text, opts = {}) {
    this._recordTimeline('typeByPlaceholder', `${placeholder}:${text}`);
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    const el = await this.page.waitForSelector(`input[placeholder="${cssEscape(placeholder)}"]`, { timeout: timeoutMs });
    await el.click({ clickCount: 3 });
    await el.press('Backspace');
    // An EMPTY string means CLEAR, not "do nothing". Select-all followed by no keystroke leaves the
    // field exactly as it was, so `type(id, '')` used to be a silent no-op — a test could assert an
    // empty-value behaviour and never once empty the field. Backspace deletes the selection.
    if (text) await el.type(text, { delay: 5 });
    else await this.page.keyboard.press('Backspace');
  }

  /** Read the textContent of the element matched by `testID` (trimmed). */
  async readText(testID, opts = {}) {
    this._recordTimeline('readText', testID);
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
    this._recordTimeline('eval', fn);
    return this.page.evaluate(fn, ...args);
  }

  /** Press a keyboard key (e.g. 'Escape', 'Enter') via a real DOM event. Powers the keyboard-shortcut
   *  surface (Escape-to-close on sheets — plan flow 14). Throws with the key name on failure. */
  async pressKey(key) {
    this._recordTimeline('pressKey', key);
    try {
      await this.page.keyboard.press(key);
    } catch (e) {
      throw new Error(`[driver] pressKey ${key} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Wait until `fn` — evaluated IN THE PAGE, re-run on every rendered frame — returns truthy.
   *
   * The generic condition wait, for the states no selector names: a counter the flow installed, a
   * value in localStorage, a computed style. It exists so a flow that needs "the app has actually
   * done X" never has to approximate it with a sleep; `label` names the awaited condition so a
   * timeout reads as a fact about the app, not as an anonymous 5000ms.
   */
  async waitForFunction(fn, opts = {}) {
    this._recordTimeline('waitForFunction', opts.label ?? fn);
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    try {
      await this.page.waitForFunction(fn, { timeout: timeoutMs }, ...(opts.args ?? []));
    } catch (e) {
      throw new Error(
        `[driver] condition never held within ${timeoutMs}ms: ${opts.label ?? '(unlabelled)'} `
        + `— ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * Wait until an animated node has come to REST — the frame-accurate replacement for "sleep long
   * enough for the entrance to finish".
   *
   * FREEZE_CSS kills CSS animations/transitions, but React Native's `Animated` (which is what every
   * entrance in this app uses) drives inline styles from `requestAnimationFrame` instead, so those
   * animations really do run — over wall-clock time that stretches with host load. A flow that slept
   * 500ms for a 260ms fade was therefore asserting on an unloaded machine's frame rate: under
   * contention the fade is still mid-flight when the screenshot fires, which is the pixel-diff drift
   * the visual flows kept blaming on "±0.3% noise".
   *
   * The condition here is stated in FRAMES, the unit the animation is actually driven in: the node's
   * computed opacity has reached `minOpacity` AND neither opacity nor transform changed across a
   * RENDERED frame. That is exactly "Animated has stopped writing to this node", and it is true at
   * the same point in the animation whether the host is idle or at load 40.
   *
   * The sampling loop lives INSIDE the page (one CDP round trip, and each sample is separated by a
   * real frame boundary — a Node-side poll could take two identical samples inside one frame and
   * call a mid-flight animation "at rest"). Its own budget is enforced in-page too, so a page that
   * never paints returns a diagnosable answer instead of hanging.
   */
  async waitAtRest(testID, opts = {}) {
    this._recordTimeline('waitAtRest', testID);
    const timeoutMs = scaled(opts.timeoutMs ?? 8_000);
    const minOpacity = opts.minOpacity ?? 0.99;
    const out = await this.page.evaluate((cfg) => new Promise((resolve) => {
      const deadline = performance.now() + cfg.timeoutMs;
      let prev = null;
      let frames = 0;
      const read = () => {
        const el = document.querySelector(cfg.sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { opacity: Number(cs.opacity), transform: cs.transform };
      };
      const step = () => {
        frames += 1;
        const now = read();
        if (now && now.opacity >= cfg.minOpacity && prev
            && prev.opacity === now.opacity && prev.transform === now.transform) {
          resolve({ ok: true, last: now, frames });
          return;
        }
        prev = now;
        if (performance.now() >= deadline) { resolve({ ok: false, last: now, frames }); return; }
        requestAnimationFrame(step);
      };
      // A page that paints no frames at all would leave the rAF chain dangling; this bounds it so
      // the flow gets `frames: 1` and a named failure rather than a silent hang.
      setTimeout(() => resolve({ ok: false, last: prev, frames }), cfg.timeoutMs + 500);
      requestAnimationFrame(step);
    }), { sel: `[data-testid="${cssEscape(testID)}"]`, timeoutMs, minOpacity });
    if (!out.ok) {
      throw new Error(
        `[driver] testID=${testID} never came to rest within ${timeoutMs}ms `
        + `(${out.frames} frame(s) sampled, last ${JSON.stringify(out.last)}; `
        + `null means the node is not in the DOM)`,
      );
    }
  }

  /**
   * Resolve once the page has RENDERED `count` more frames. The honest way to say "give React a
   * chance to act on the event I just dispatched, then snapshot" — a proof-of-absence needs the app
   * to have had its turn, and a wall-clock sleep buys a load-dependent number of turns (30 frames on
   * an idle host, possibly 2 on a loaded one) while a frame count buys the same number every time.
   * Bounded in-page so a page that never paints fails loudly instead of hanging.
   */
  async settleFrames(count = 3, opts = {}) {
    this._recordTimeline('settleFrames', count);
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    const painted = await this.page.evaluate((cfg) => new Promise((resolve) => {
      let n = 0;
      const step = () => { n += 1; if (n >= cfg.count) { resolve(n); return; } requestAnimationFrame(step); };
      setTimeout(() => resolve(n), cfg.timeoutMs);
      requestAnimationFrame(step);
    }), { count, timeoutMs });
    if (painted < count) {
      throw new Error(`[driver] the page painted only ${painted} of ${count} frames within ${timeoutMs}ms`);
    }
  }

  /** Wait until NO element matches `testID` (e.g. a sheet closed and unmounted). */
  async waitGone(testID, opts = {}) {
    this._recordTimeline('waitGone', testID);
    const timeoutMs = scaled(opts.timeoutMs ?? 3_000);
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
    this._recordTimeline('isPresent', testID);
    return await this.page.evaluate(
      (sel) => document.querySelector(sel) != null,
      `[data-testid="${cssEscape(testID)}"]`,
    );
  }

  /** Instant multi-probe: WHICH of `testIDs` are in the DOM right now — ONE CDP roundtrip, no
   *  waiting. Returns the present subset in the caller's order (priority order), so the first
   *  element is the caller's preferred answer. This is the cheap building block for decision
   *  loops that used to pay a full `findByTestID` timeout per absent candidate (each miss burns
   *  its whole timeout — a 1s probe that misses costs exactly 1s; five probes in a loop cost 5s). */
  async whichPresent(testIDs) {
    this._recordTimeline('whichPresent', testIDs);
    const sels = testIDs.map((t) => `[data-testid="${cssEscape(t)}"]`);
    const present = await this.page.evaluate((sels) => sels.map((s) => document.querySelector(s) != null), sels);
    return testIDs.filter((_, i) => present[i]);
  }

  /** Wait until ANY of `testIDs` mounts; resolves with the first winner (caller's priority order
   *  breaks ties within one evaluation). In-page rAF polling — one CDP roundtrip total, so a
   *  five-candidate wait costs the same as a single-candidate one. This is the event-driven
   *  replacement for "probe each candidate with a full timeout, catch, probe the next". */
  async waitForFirstTestID(testIDs, opts = {}) {
    this._recordTimeline('waitForFirstTestID', testIDs);
    const timeoutMs = scaled(opts.timeoutMs ?? 5_000);
    const sels = testIDs.map((t) => `[data-testid="${cssEscape(t)}"]`);
    let idxHandle;
    try {
      idxHandle = await this.page.waitForFunction(
        (sels) => sels.findIndex((s) => document.querySelector(s) != null),
        { timeout: timeoutMs },
        sels,
      );
    } catch (e) {
      throw new Error(`[driver] none of [${testIDs.join(', ')}] appeared within ${timeoutMs}ms: ${e instanceof Error ? e.message : e}`);
    }
    return testIDs[await idxHandle.jsonValue()];
  }

  /** Wipe localStorage (forces the app's first-run identity flow on the next load). */
  async clearStorage() {
    this._recordTimeline('clearStorage', null);
    await this.page.evaluate(() => { try { localStorage.clear(); } catch {} });
  }

  /** Begin recording failed-request errorTexts (CDP `Network.requestFailed`). Returns a getter for
   *  the captured list of `{url, errorText}` (favicon filtered). Use to prove a fetch failed for the
   *  RIGHT reason — e.g. a dead-relay fetch must surface `ERR_CONNECTION_REFUSED`, NOT
   *  `ERR_UNSAFE_PORT` (which Chrome blocks before even connecting — a different, artifact failure
   *  mode that would let an offline test pass for the wrong reason). */
  recordRequestFailures() {
    const seen = [];
    const handler = (req) => {
      const url = req.url();
      if (url.endsWith('/favicon.ico')) return;
      seen.push({ url, errorText: req.failure()?.errorText ?? 'unknown' });
    };
    this.page.on('requestfailed', handler);
    return () => seen;
  }

  /** Close the context (and the browser if this Driver owns it — a shared-browser Driver never
   *  tears down the session's browser). Safe to call multiple times. */
  async close() {
    const failures = [];
    if (!this.closed) {
      this.closed = true;
      // Ignore request aborts caused by our own context teardown, but retain diagnostics observed
      // before teardown and assert them only after resources have been cleaned up.
      this.closing = true;
      if (this.unexpectedDiagnostics.size > 0) {
        try {
          const dir = await this.dumpDiagnostics(`${this._closeLabel()}-diagnostics`, null);
          if (dir) console.error(`[driver] unexpected-diagnostics snapshot dumped to ${dir}`);
        } catch (e) {
          console.error(`[driver] diagnostics snapshot failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      try { await this.context.close(); } catch (e) { failures.push(e); }
      if (this.ownsBrowser) {
        if (this.gateStop) {
          try { await this.gateStop(); } catch (e) { failures.push(e); }
        } else {
          try { await this.browser.close(); } catch (e) { failures.push(e); }
        }
      }
    }
    try { this.assertNoUnexpectedDiagnostics(); } catch (e) { failures.push(e); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, '[driver] teardown failed');
  }

  /** Best-effort per-flow label for the close-time diagnostics dump. Resolves the active test file
   *  from the harness AsyncLocalStorage (lib.mjs exports `_testCtx`); falls back to 'flow' when no
   *  store is active (standalone runs). The live-binding resolves at runtime, so the module-cycle
   *  driver.mjs ↔ lib.mjs is safe — neither module reads the binding at top-level. */
  _closeLabel() {
    try {
      const store = _testCtx?.getStore?.();
      if (store) return String(store).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    } catch {}
    return 'flow';
  }

  /**
   * Dump diagnostics for a RED test to `e2e/shots/failures/<label>-<timestamp>/`. Writes five
   * artifacts; each capture is BEST-EFFORT (a closed page makes screenshot/DOM fail, but the
   * in-memory timeline + console + unexpected-diagnostics survive context close, so those always
   * land). A failure to capture one artifact is logged and NEVER aborts the others. Returns the
   * dump directory path (or null if the dir could not be created).
   *
   * Reachability note: by the time this runs (from `runPool`'s catch), the flow's own
   * `finally { await env.stop(); }` has usually closed the context — so `page.screenshot()` and
   * `page.content()` will throw. The ring-buffer timeline + consoleLog arrays are instance state,
   * so actions.json + console.log + error.txt are the reliably-captured artifacts for real flows.
   * (The page is still alive for flows that throw WITHOUT a stop-finally, e.g. a throwaway probe.)
   */
  async dumpDiagnostics(label, err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeLabel = String(label ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown';
    const dir = join(FAILURES_DIR, `${safeLabel}-${ts}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error(`[driver] dumpDiagnostics: could not create ${dir}: ${e instanceof Error ? e.message : e}`);
      return null;
    }

    // screenshot.png — best-effort (page may be closed).
    await this._dumpArtifact(dir, 'screenshot.png', async () => {
      await this.page.screenshot({ path: join(dir, 'screenshot.png'), type: 'png', fullPage: false });
    });
    // dom.html — best-effort (page may be closed).
    await this._dumpArtifact(dir, 'dom.html', async () => {
      const html = await this.page.content();
      await writeFile(join(dir, 'dom.html'), html);
    });
    // console.log — the recorded diagnostics Set + the buffered console timeline (in-memory, reliable).
    await this._dumpArtifact(dir, 'console.log', async () => {
      await writeFile(join(dir, 'console.log'), this._formatConsoleDump());
    });
    // actions.json — the ring-buffer timeline, chronologically ordered (in-memory, reliable).
    await this._dumpArtifact(dir, 'actions.json', async () => {
      await writeFile(join(dir, 'actions.json'), JSON.stringify(this._orderedTimeline(), null, 2));
    });
    // error.txt — the thrown error's message + stack (if provided).
    if (err) {
      await this._dumpArtifact(dir, 'error.txt', async () => {
        const text = err.stack || err.message || String(err);
        await writeFile(join(dir, 'error.txt'), text);
      });
    }
    return dir;
  }

  /** Run a single artifact write; any throw is logged and swallowed so the other artifacts still
   *  land. No silent errors — every failure is named on stderr. */
  async _dumpArtifact(dir, name, write) {
    try {
      await write();
    } catch (e) {
      console.error(`[driver] dumpDiagnostics: ${name} capture failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Render the console dump: the unexpected-diagnostics Set first (the fail-closed signal), then
   *  the full buffered console timeline (info/warn/error, all types). Pure string build — cheap. */
  _formatConsoleDump() {
    const lines = [];
    lines.push('=== unexpected diagnostics (pageerror / console.error / requestfailed) ===');
    if (this.unexpectedDiagnostics.size === 0) {
      lines.push('(none)');
    } else {
      for (const d of this.unexpectedDiagnostics) lines.push(`  - ${d}`);
    }
    lines.push('');
    lines.push(`=== console timeline (${this.consoleLog.length} entries, capped at ${CONSOLE_MAX}) ===`);
    if (this.consoleLog.length === 0) {
      lines.push('(no console messages buffered)');
    } else {
      for (const e of this.consoleLog) lines.push(`[${new Date(e.t).toISOString()}] console.${e.type}: ${e.text}`);
    }
    return lines.join('\n');
  }
}

/**
 * Wrap the Driver's public methods with per-op timers (PROFILING builds only). Measured time is
 * INCLUSIVE (click includes its inner findByTestID) — the summary reads `click N× total`, and the
 * known nesting is documented here rather than reconstructed at runtime. Attribution uses
 * `driver.profileFile` at RECORD time (lib.mjs sets it before the flow body runs, so every op a
 * flow makes lands on the right file).
 */
const PROFILED_OPS = [
  'navigate', 'waitReady', 'findByTestID', 'waitForText', 'click', 'type', 'typeByPlaceholder',
  'readText', 'readInputValue', 'bodyText', 'screenshot', 'eval', 'pressKey', 'waitForFunction',
  'waitAtRest', 'settleFrames', 'waitGone', 'isPresent', 'whichPresent', 'waitForFirstTestID',
  'clearStorage', 'addInitScript', 'removeInitScript',
];
function installDriverProfiler(driver) {
  for (const op of PROFILED_OPS) {
    const orig = driver[op];
    driver[op] = function (...args) {
      const t0 = performance.now();
      let out;
      try {
        out = orig.apply(this, args);
      } catch (e) {
        profOp(this.profileFile, op, performance.now() - t0);
        throw e;
      }
      if (out && typeof out.then === 'function') {
        return out.finally(() => profOp(this.profileFile, op, performance.now() - t0));
      }
      profOp(this.profileFile, op, performance.now() - t0);
      return out;
    };
  }
  // Teardown cost is a phase, not an op (it happens once per flow, and close() is not on the
  // per-flow hot path the op table is for).
  const origClose = driver.close.bind(driver);
  driver.close = (...args) => {
    const file = driver.profileFile;
    const stop = profSpan('teardown.driverClose', file);
    return origClose(...args).finally(stop);
  };
}

/** Minimal CSS-string escaper for `data-testid` attribute selectors (handles quotes / brackets). */
function cssEscape(s) {
  // testIDs in this app are simple (`btn-create`, `balance`, `tab-pay`); a backslash escape of any
  // char outside [A-Za-z0-9_-] is sufficient and overcautious rather than risky.
  return s.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * Flatten a timeline arg to a SHORT string for the ring-buffer entry. CHEAP by design — the suite
 * makes thousands of driver calls and this runs on every one. Strings are capped at 40 chars; tiny
 * opts objects (`{timeoutMs: 5000}`) get a capped JSON.stringify; functions (the `eval` first arg)
 * become `fn:<name>`; large objects are never deep-stringified (the cap truncates the surface).
 */
function _fmtTimelineArg(arg) {
  if (arg == null) return '';
  const type = typeof arg;
  if (type === 'string') return arg.length > 40 ? arg.slice(0, 40) + '…' : arg;
  if (type === 'number' || type === 'boolean') return String(arg);
  if (type === 'function') return arg.name ? `fn:${arg.name}` : 'fn';
  try {
    const s = JSON.stringify(arg);
    if (s === undefined) return String(arg);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch {
    return String(arg);
  }
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
 *
 * MC8 U6.7: also inject a test WalletConnect project id (`__DPAY_TEST_WALLETCONNECT_PROJECT_ID`) so
 * the resolver's WalletConnect branch is "configured" across every flow. This is SAFE: the resolver
 * is web-first — `resolveOnrampProvider()` returns `window.ethereum` before ever reaching the WC
 * branch, and the WC branch is additionally gated by `Platform.OS !== 'web'` (react-native-web sets
 * Platform.OS='web' in this harness), so NO WalletConnect code ever executes. Setting it globally
 * proves the STRONGER property: even with WC configured, the web harness returns `window.ethereum`
 * (when present) or null — WC pairing is a native outer-loop gate by design. Prod bakes the real id;
 * this override never ships. (See flow 34-onramp-provider-resolution for the explicit seam test.)
 */
function injectTestGlobals() {
  globalThis.__DPAY_TEST_POLL = {
    balance: 150, history: 150, deposit: 150, receiptPay: 150, receiptRcv: 150, request: 150,
    // The IDLE cadences are overridden to the SAME 150 ms as the active ones ON PURPOSE. The suite
    // must not be paced by production cadence, and a request BUDGET expressed in wall-clock time
    // would be meaningless here anyway — flow 160 asserts requests PER TICK, which is the unit the
    // cost is actually incurred in. What the idle cadence does to a real wallet is measured under
    // fake timers in app/__tests__/usePollCadence.test.tsx.
    balanceIdle: 150, historyIdle: 150,
  };
  // MC8 U6.7 — a non-empty test project id so WALLETCONNECT_PROJECT_ID is "configured" app-wide.
  globalThis.__DPAY_TEST_WALLETCONNECT_PROJECT_ID = 'e2e-test-project-id';
  // SOL rail: DISABLE so the offline e2e suite never hits real Solana devnet. An empty URL makes
  // useSolanaBalance no-op and the SOL card render with `—` (tested offline-rendered, see flow SOL).
  globalThis.__DPAY_TEST_SOLANA_RPC_URL = '';
  // EVM rail: DISABLE identically (the SOL seam's mirror, spec 2026-09-26 D27). An empty URL
  // makes the app/evm.ts seam no-op. A flow that wants the EVM rail re-points it per-page with
  // the `evmRpcUrl` Driver option below (the `solRpcUrl` mirror) — usually the harness relay's
  // /api/v1/evm/rpc URL so the app exercises the REAL pipe, or 'derive' to drop the override
  // and let the relay-derived per-chain route stand.
  globalThis.__DPAY_TEST_EVM_RPC_URL = '';
  // Convert engine cadences (the config/convert.ts seam): the suite proves the honest-pending /
  // resume-engine invariants at ~100 ms probe cadence instead of prod's seconds. The invariants
  // are cadence-independent — the settle watch still has to EXHAUST before a record parks on
  // pending_withdrawal (never done from a pool #ok), and resolution still only comes from the
  // ledger row — while the wall-clock magnitudes these `??` fall back to are what a real venue
  // needs and stay pinned as the prod defaults.
  globalThis.__DPAY_TEST_CONVERT_ENGINE = {
    rearmMs: 500, stuckWatchMs: 2000, providerPollMs: 500,
    executorOpts: {submitAttempts: 3, poll: {attempts: 4, intervalMs: 100}, settleAttempts: 10, settleIntervalMs: 100},
  };
}
