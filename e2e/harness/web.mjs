// Web builder + static server. Builds the REAL app once via vite (cached, <2s incremental) and
// serves `e2e/dist` via sirv on a free port, offline, on 127.0.0.1. The relay URL is passed to the
// app via the `?relay=` query param — see `e2e/web/relay-config.ts` (the entry the app's
// `./relayConfig` import is aliased to).
import { spawn, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { trackChild, untrackChild } from './procs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');
const DIST = join(E2E_DIR, 'dist');
const INDEX_HTML = join(DIST, 'index.html');

// --- dist cache invalidation (root fix for the stale-build wart) ---
// The OLD cache gate was a bare `existsSync(INDEX_HTML)`: it never noticed a source edit, so a dev
// changing app/App.tsx (or a shim) got a STALE build across runs. The TRUE fix: track the newest
// mtime across every file that feeds the vite build and rebuild when any is newer than the built
// dist/index.html. Warm runs stay fast (a no-op stat check, no rebuild, when nothing changed).
const REPO_ROOT = join(E2E_DIR, '..');
const APP_DIR = join(REPO_ROOT, 'app');
// The shims live in `e2e/web/` (= E2E_DIR/web), NOT `e2e/harness/web`. Pointing at the harness dir
// (the old value) made readdirSync throw → silently skipped → a shim edit NEVER invalidated the dist
// cache (a stale-build false-confidence bug). This is the canonical path the vite build pulls in.
const WEB_DIR = join(E2E_DIR, 'web');
// The vite build pulls in the ENTIRE app/ source tree (App.tsx imports config/, lib/, hooks/,
// services/, styles.ts, components/*). Watching only a few top-level files let edits to
// styles.ts / components/*.tsx silently run against a STALE dist (tests pass on old code). The fix:
// walk app/ for every .ts/.tsx that is a real build input, skipping non-input dirs.
const APP_SKIP_DIRS = new Set(['node_modules', 'android', 'ios', '__tests__', '__mocks__', '.e2e-dist']);

/**
 * Newest mtime (ms) across every SOURCE that feeds the vite build: the real app sources
 * (walked so an edit anywhere in app/ — components, styles, config, lib, hooks, services —
 * invalidates the cache), the e2e/web shims/entry/html (walked so a newly added shim is picked up
 * automatically), and the vite config itself. Missing files are skipped (a deleted file is not a
 * build input). This is the SOURCE-change gate; vite's own incremental cache still handles
 * dependency changes.
 */
function newestSourceMtimeMs() {
  let newest = 0;
  const touch = (p) => {
    try {
      const m = statSync(p).mtimeMs;
      if (m > newest) newest = m;
    } catch {} // missing → not a build input
  };
  const walkApp = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (APP_SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walkApp(p);
      else if (/\.(ts|tsx)$/.test(name)) touch(p);
    }
  };
  walkApp(APP_DIR);
  try {
    for (const name of readdirSync(WEB_DIR)) {
      if (/\.(ts|tsx|html|js)$/.test(name)) touch(join(WEB_DIR, name));
    }
  } catch {}
  touch(join(E2E_DIR, 'vite.config.js'));
  return newest;
}

export const BUILD_TIMEOUT_MS = 90_000;
export const SERVE_READY_TIMEOUT_MS = 5_000;

/**
 * Build the web bundle via vite. Cache gate (when `force` is false):
 *   - no dist/index.html        → build (cold);
 *   - a source newer than dist  → build (stale: a source edit landed since the last build);
 *   - otherwise                 → reuse the existing dist (warm, no rebuild — fast).
 * `force=true` always rebuilds. The mtime check is what makes a dev edit to app/App.tsx (or a
 * shim) reliably invalidate the cache instead of serving yesterday's build.
 */
export async function buildWeb(opts = {}) {
  if (!opts.force && existsSync(INDEX_HTML)) {
    const distMtime = statSync(INDEX_HTML).mtimeMs;
    if (newestSourceMtimeMs() <= distMtime) {
      console.log('[web] using existing dist/index.html (cached; no source newer than dist)');
      return;
    }
    console.log('[web] a source is newer than dist/index.html — rebuilding (vite)…');
  } else {
    console.log('[web] building (vite)…');
  }
  const code = await runVite(['build'], opts.timeoutMs ?? BUILD_TIMEOUT_MS);
  if (code !== 0) throw new Error(`vite build failed (exit ${code})`);
  if (!existsSync(INDEX_HTML)) throw new Error('vite build produced no dist/index.html');
}

function runVite(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const viteBin = join(E2E_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = spawn(process.execPath, [viteBin, ...args], { cwd: E2E_DIR, stdio: 'inherit' });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`vite ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
  });
}

/** Find a free TCP port by binding to :0 and immediately closing — the server then re-binds it. */
export async function pickFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Regex-escape a literal for use inside a `pkill -f` pattern (it is a POSIX ERE, not a plain
 *  string). Escaping keeps the sweep TIGHT: the pattern must match the exact sirv invocation this
 *  harness spawns for OUR dist root, never an unrelated node process that merely contains the
 *  substring. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reap ORPHANED sirv servers before spawning a fresh one. Killed harness runs (SIGKILL, a host OOM,
 * a lost `kill -9` race) can leave the tracked sirv child reparented to PID 1, still bound to its
 * free port forever — 22 had accumulated by 2026-08-15. The `process.on('exit')` SIGKILL net cannot
 * fire when Node itself dies without an exit event, so this spawn-time sweep is the source fix: it
 * kills every process whose command line is EXACTLY the harness's sirv invocation for this repo's
 * e2e/dist root. Scoped so tightly (binary path + dist path + `--single`) that an unrelated node
 * process cannot match. NOTE: parallel `run.mjs` invocations are already required to be serialized
 * (the e2e/dist build cache is a shared path — see FLOWS.md conventions), so a LIVE sibling run's
 * sirv is never a casualty under documented usage. `pkill` absence (non-Linux) is swallowed.
 */
function reapOrphanedSirv() {
  const pattern = `sirv-cli/bin\\.js ${escapeRegex(DIST)} --single`;
  try {
    execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    console.log('[web] reaped orphaned sirv server(s) serving this dist root');
  } catch (e) {
    // exit code 1 = no process matched (the common case); ENOENT = no pkill (non-Linux). Both fine.
    const nomatch = typeof e.status === 'number';
    if (!nomatch && e.code !== 'ENOENT') {
      console.warn(`[web] sirv reap failed (continuing): ${e.message}`);
    }
  }
}

/**
 * Serve `e2e/dist` on a free port via sirv-cli. Returns `{ port, baseURL, stop }`. Throws (does not
 * hang) if sirv fails to start or the port never opens.
 */
export async function serveWeb(opts = {}) {
  if (!existsSync(INDEX_HTML)) throw new Error(`serveWeb: ${INDEX_HTML} missing — call buildWeb first`);
  reapOrphanedSirv(); // kill leftover servers from killed harness runs BEFORE binding our own
  const port = opts.port ?? await pickFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const sirvBin = join(E2E_DIR, 'node_modules', 'sirv-cli', 'bin.js');
  console.log(`[web] serving dist at ${baseURL} (sirv)…`);
  const child = spawn(process.execPath, [sirvBin, DIST, '--single', '--host', '127.0.0.1', '--port', String(port), '--quiet'], {
    cwd: E2E_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Track the PID so a sync `process.on('exit')` SIGKILL can reach it if Node dies before the async
  // stop() drains. Untrack on exit so the set never holds a dead/recycled PID. See harness/procs.mjs.
  trackChild(child.pid);
  child.on('exit', () => untrackChild(child.pid));
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      try { child.kill('SIGTERM'); } catch { resolve(); }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000);
    });
  };

  try {
    await waitForPort('127.0.0.1', port, opts.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS);
  } catch (e) {
    await stop();
    throw new Error(`sirv did not open ${baseURL} within ${opts.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS}ms: ${e}\n  stderr:\n${stderr}`);
  }
  return { port, baseURL, stop };
}

/** Poll a TCP port until it accepts a connection AND HTTP responds, or throw on timeout. */
export async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => {
      const sock = createConnection({ host, port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); resolve(); });
    });
    // Verify the server actually responds (port open != HTTP responding).
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_500);
      try {
        const r = await fetch(`http://${host}:${port}/`);
        if (r.ok || r.status === 404) return; // sirv serves index.html for "/" (--single)
      } finally { clearTimeout(t); }
    } catch { /* keep polling */ }
    await sleep(100);
  }
  throw new Error(`port ${host}:${port} never accepted HTTP within ${timeoutMs}ms`);
}
