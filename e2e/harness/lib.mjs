// Shared harness library — the single import a `e2e/tests/NN-name.mjs` file uses. It:
//   1. Generates `dfx/wire_layout.json` (the single source of truth for the wire layout + golden
//      signed bytes) if missing, via `cargo run -p dpay-fixture --release -- wire-layout`. The
//      DpayCore shim reads this JSON so it never hand-transcribes the layout.
//   2. Spawns the REAL test relay (FakeLedger) on a free port (local mode only).
//   3. Builds + serves the REAL web app once (cached across tests in a single run).
//   4. Hands the test a `Driver` over CDP.
//
// `setup()` returns an `env` with `{ mode, relayBaseURL?, webBaseURL, driver, stop }`. `stop()` is
// the single teardown path — closes the browser, stops the relay (if local), stops the web server.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { Driver } from './driver.mjs';
import { startRelay } from './relay.mjs';
import { buildWeb, serveWeb } from './web.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WIRE_LAYOUT = join(REPO_ROOT, 'dfx', 'wire_layout.json');

/**
 * Resolve the run mode from $DPAY_E2E_MODE (default `local`). `live` requires $DPAY_E2E_BASE — the
 * harness does NOT spawn a relay in live mode (it drives the real one + canister).
 */
export function resolveMode() {
  const m = (process.env.DPAY_E2E_MODE ?? 'local').toLowerCase();
  if (m !== 'local' && m !== 'live') {
    throw new Error(`DPAY_E2E_MODE=${m} — expected 'local' or 'live'`);
  }
  return m;
}

/**
 * Ensure `dfx/wire_layout.json` exists (regenerate via dpay-fixture ONLY if missing). The DpayCore
 * shim + the cross-validation test both read it. Single source of truth for the wire layout — never
 * hand-transcribed anywhere else.
 *
 * Regenerating every test run was wasteful (a ~1s `cargo run` per test); the JSON is committed and
 * stable, so we only regenerate when it's actually absent. Force a regen with
 * `DPAY_E2E_REGEN_LAYOUT=1` (e.g. after a wire-format change — then commit the new JSON).
 */
export async function ensureWireLayout() {
  if (existsSync(WIRE_LAYOUT) && process.env.DPAY_E2E_REGEN_LAYOUT !== '1') return;
  console.log('[lib] regenerating dfx/wire_layout.json via dpay-fixture…');
  const code = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['run', '-p', 'dpay-fixture', '--release', '--', 'wire-layout', WIRE_LAYOUT], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('dpay-fixture wire-layout timed out after 180s'));
    }, 180_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`dpay-fixture wire-layout exited ${code}\n${stderr.split('\n').slice(-20).join('\n')}`));
      } else resolve(code ?? 0);
    });
  });
  if (code !== 0) throw new Error(`dpay-fixture wire-layout failed (exit ${code})`);
}

/**
 * Top-level setup. Generates wire_layout.json, builds+serves the web app, spawns the relay (local
 * mode), and returns a ready-to-drive `Driver`. Idempotent within a run; safe to call once per test.
 *
 * @param {{noRelay?: boolean, noWeb?: boolean, rebuildWeb?: boolean}} [opts]
 */
export async function setup(opts = {}) {
  await ensureWireLayout();
  const mode = resolveMode();
  let relayBaseURL = '';
  const stops = [];

  try {
    if (mode === 'live') {
      const base = process.env.DPAY_E2E_BASE;
      if (!base) throw new Error('DPAY_E2E_MODE=live requires DPAY_E2E_BASE=<url> (e.g. https://dpay.kalaj.org)');
      relayBaseURL = base;
      console.log(`[lib] live mode — pointing app at ${relayBaseURL} (throttle + throwaway identity)`);
    } else if (!opts.noRelay) {
      const relay = await startRelay();
      relayBaseURL = relay.baseURL;
      stops.push(relay.stop);
      console.log(`[lib] local relay up at ${relayBaseURL}`);
    }

    let webBaseURL = '';
    if (!opts.noWeb) {
      await buildWeb({ force: opts.rebuildWeb });
      const web = await serveWeb();
      webBaseURL = web.baseURL;
      stops.push(web.stop);
      console.log(`[lib] web app served at ${webBaseURL}`);
    }

    const driver = await Driver.create();
    stops.push(() => driver.close());

    const stop = async () => { for (const s of stops.slice().reverse()) { try { await s(); } catch {} } };

    // In live mode, throttle: navigate is slow against mainnet, so allow more time. The app still
    // generates an ephemeral key on first run (we clearStorage before navigate for idempotency).
    if (!opts.noWeb) {
      // about:blank first so localStorage.clear() has a same-origin context to operate on.
      await driver.navigate('about:blank', '/');
      try { await driver.clearStorage(); } catch {}
      const navPath = `/?relay=${encodeURIComponent(relayBaseURL)}`;
      await driver.navigate(webBaseURL, navPath, { timeoutMs: mode === 'live' ? 20_000 : 8_000 });
      await driver.waitReady({ timeoutMs: mode === 'live' ? 20_000 : 10_000 });
    }

    return { mode, relayBaseURL, webBaseURL, driver, stop };
  } catch (e) {
    // Best-effort cleanup on setup failure so a half-spawned relay/server doesn't leak.
    for (const s of stops.slice().reverse()) { try { await s(); } catch {} }
    throw e;
  }
}

// --- assertion helpers (kept tiny so the suite has zero test-framework deps) -----------------

/** Assert `cond` is true; throw with `msg`. */
export function assert(cond, msg) {
  if (!cond) throw new Error(`[assert] ${msg}`);
}

/** Assert `actual === expected`; the message includes both values for fast triage. */
export function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`[assert] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Assert `actual` contains `substring`; the message includes a body excerpt. */
export function assertIncludes(actual, substring, label) {
  if (!actual.includes(substring)) {
    const excerpt = actual.length > 400 ? actual.slice(0, 400) + '…' : actual;
    throw new Error(`[assert] ${label}: page text should include "${substring}".\n  body excerpt:\n${excerpt}`);
  }
}

// --- relay client helpers (used by the deposit/pay flows) -------------------------------------
//
// Every call has a timeout (AbortController) and surfaces a thrown Error on non-2xx — no silent
// failures. These hit the REAL test relay the harness spawned (FakeLedger offline), proving the
// credited/settled path end-to-end rather than mocking it.

/** GET `/api/v1/balance/<hex>?currency=N` → the balance in minor units. */
export async function getBalance(relayBaseURL, accountHex, currency = 0, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/balance/${accountHex}?currency=${currency}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`balance ${r.status}`);
    const j = await r.json();
    if (typeof j.balance !== 'number') throw new Error(`balance: bad body ${JSON.stringify(j)}`);
    return j.balance;
  } finally { clearTimeout(t); }
}

/**
 * POST `/api/v1/test/deposit/seed` (feature `test-helpers` ONLY — the harness builds the relay with
 * `--features test-helpers`, the prod image never does). Seeds a pending deposit of `amount` minor
 * units for `accountHex` in `currency`; the NEXT `/deposit/refresh` drains + credits it (mirrors a
 * confirmed ckBTC mint). Used by flow 05 to prove the credited path through the real relay+FakeLedger.
 */
export async function seedDeposit(relayBaseURL, accountHex, currency, amount, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/test/deposit/seed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: accountHex, currency, amount }), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`seed ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
  } finally { clearTimeout(t); }
}

/** POST `/api/v1/pay` with a `{qr}` body → `{ok, status, body}` (null `ok`/`status` on fetch throw). */
export async function postPay(relayBaseURL, qrCode, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${relayBaseURL}/api/v1/pay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr: qrCode }), signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: null, status: null, body: {} };
  } finally { clearTimeout(t); }
}
