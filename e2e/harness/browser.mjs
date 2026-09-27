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
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { trackChild, untrackChild } from './procs.mjs';

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

// ─────────────────────────────────────────────────────────────────────────────────────
// Machine-global chrome gate: ONE chrome-headless-shell per machine, shared across runs.
//
// Three layers, all MACHINE-GLOBAL (never inside a worktree; /tmp/opencode is shared and
// pre-created):
//
//   1. Discovery-before-spawn. `/tmp/opencode/dpay-chrome-<CHROME_BUILD_ID>.json` records
//      `{pid, port, started}` of the live shell. Before any launch we probe
//      `GET /json/version` on the recorded port (250ms budget): alive means every caller
//      puppeteer.connect()s to that shell instead of spawning a duplicate. A shell costs
//      ~1.5s to start and hundreds of MB resident; parallel gate re-runs each spawning
//      their own shell produced the 2026-09-27 CPU storm (load 31, dozens of shells).
//
//   2. Admission control. `/tmp/opencode/dpay-chrome.lock` is a mkdir-mutex (atomic,
//      zero-dependency) with a 30s stale-TTL that only ever steals from a DEAD holder
//      (never from a live one; a live holder is waited on, up to the wait cap). It is
//      acquired per RUN, not per launch, and held for the run's whole browser lifetime:
//      parallel runs QUEUE at the browser step instead of interleaving shells. Queuing is
//      the documented trade (spec 2026-09-27): predictable and bounded by the wait cap.
//
//   3. Launch path. Inside the lock: re-check discovery (double-checked), then launch with
//      `--remote-debugging-port=0`, read `DevToolsActivePort` from the user-data-dir, write
//      the discovery file atomically. The lock is released when the run's LAST browser
//      connection drops.
//
// Per-run test isolation is unchanged: every test still gets its own incognito browser
// CONTEXT (driver.mjs `create()`), so a shared shell never leaks localStorage or identity
// between runs or tests.
//
// Kill discipline (house rule: the box runs other projects' browsers and a production
// relay): the harness only ever kills a shell it LAUNCHED itself (pid-registry backstop,
// procs.mjs). A shell this run merely CONNECTED to (adopted after a previous holder was
// hard-killed) is disconnected, never killed here; adoption runs a janitor pass that closes
// the stale contexts the dead holder left behind, and the shell is then left for the next
// run to adopt or for `just e2e-sweep` to reap once it has been idle past the sweep
// threshold. The sweep only ever touches shells whose /proc cmdline carries THIS gate's
// user-data-dir marker; anything else is foreign and left alone.
// ─────────────────────────────────────────────────────────────────────────────────────

const GATE_ROOT = '/tmp/opencode';
const LOCK_DIR = join(GATE_ROOT, 'dpay-chrome.lock');
const LOCK_OWNER_FILE = join(LOCK_DIR, 'owner.json');
const STALE_LOCK_MS = 30_000;                       // spec: 30s stale TTL for the mkdir-mutex
const PROBE_TIMEOUT_MS = 250;                       // spec: ~250ms /json/version budget
// `Number(x) || default` would swallow a deliberate 0 (used to test the sweep); guard instead.
function envMs(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const LOCK_WAIT_CAP_MS = envMs('DPAY_E2E_LOCK_WAIT_MS', 30 * 60_000);
const SWEEP_MIN_IDLE_MS = envMs('DPAY_E2E_SWEEP_MIN_IDLE_MS', 10 * 60_000);
const DEVTOOLS_PORT_WAIT_MS = 10_000;

// One shell per RUN is the machine-global policy (spec acceptance: two concurrent `just e2e`
// runs must show exactly ONE chrome-headless-shell). run.mjs defaults its browser-shard count
// to the pool concurrency (one PROCESS per lane, the 2026-09-16 throughput optimization), so
// publish the collapse to it: it reads this env when sizing shards and the self-contention
// timeout scale, and both stay honest only if it knows the run owns a single shell. An
// explicit DPAY_E2E_BROWSERS value still wins for the runner's math; the gate itself always
// connects every lane of the process to the one admitted shell regardless.
if (process.env.DPAY_E2E_BROWSERS === undefined) process.env.DPAY_E2E_BROWSERS = '1';

// The launch flags are the shell's identity and live HERE (the gate owns launch + adopt).
// Verbatim from the driver's former launch path so rendering, and therefore the visual
// baselines, are bit-identical. `--remote-debugging-port=0` is what makes the port
// discoverable via DevToolsActivePort.
const BASE_LAUNCH_ARGS = [
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
  '--remote-debugging-port=0',
];

// puppeteer-core is imported lazily: this module is also the sweep's library, and the sweep
// must run even before `npm install` has ever populated e2e/node_modules (stdlib only until
// an actual connect/launch happens).
let _puppeteerPromise = null;
async function pp() {
  if (!_puppeteerPromise) _puppeteerPromise = import('puppeteer-core').then((m) => m.default);
  return _puppeteerPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short identity of the launch-arg set. The spec's exact discovery filename
 *  `dpay-chrome-<build>.json` is reserved for the default args (every standard recipe);
 *  a caller with extra args (web-scan-smoke's fake-camera flags) or a DPAY_CHROMIUM override
 *  gets a suffixed slot so the two shell flavors never adopt each other. */
function gateKey(extraArgs, executablePath) {
  const args = [...(extraArgs ?? [])].sort();
  if (args.length === 0 && !process.env.DPAY_CHROMIUM) return '';
  return createHash('sha256').update(JSON.stringify(args)).update(executablePath ?? '').digest('hex').slice(0, 8);
}

function discoveryPathFor(key) {
  return join(GATE_ROOT, `dpay-chrome-${CHROME_BUILD_ID}${key ? `-${key}` : ''}.json`);
}
function profileDirFor(key) {
  return join(GATE_ROOT, `dpay-chrome-${CHROME_BUILD_ID}-profile${key ? `-${key}` : ''}`);
}

// ── process-liveness helpers (Linux /proc) ──────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readCmdline(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    let argv = raw.split('\0').filter(Boolean);
    // Chromium's MAIN browser process rewrites its own argv into a single space-joined string
    // with one trailing NUL (measured 2026-09-27: a live gate shell's /proc cmdline is ~1KB
    // holding exactly ONE NUL), while its --type= children keep proper NUL separation. Tokenize
    // the blob form too; none of our tokens (binary path, flags, the gate profile dir) contain
    // spaces.
    if (argv.length === 1 && argv[0].includes(' --')) argv = argv[0].split(' ').filter(Boolean);
    return argv;
  } catch { return null; }
}

/** A pid is conclusively OUR shell iff its cmdline names chrome-headless-shell as the binary,
 *  carries this gate's exact user-data-dir, and has no `--type=` flag (chrome's renderer/gpu/
 *  zygote children share the binary AND the user-data-dir; only the main browser process lacks
 *  --type=). Foreign browsers (other projects' chrome) can then never be adopted, killed, or
 *  reaped by mistake. */
function pidIsOurShell(pid, profileDir) {
  const argv = readCmdline(pid);
  if (!argv) return false;
  return (argv[0] ?? '').includes('chrome-headless-shell')
    && !argv.some((a) => a.startsWith('--type='))
    && argv.some((a) => a === `--user-data-dir=${profileDir}`);
}

/** Process age in ms via /proc/<pid>/stat field 22 (starttime since boot, CLK_TCK=100). */
function procAgeMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = Number(fields[19]);
    const btime = Number(readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btime)) return null;
    return Date.now() - (btime + startTicks / 100) * 1000;
  } catch { return null; }
}

// ── DevTools HTTP probes ────────────────────────────────────────────────────────────

async function probeDevTools(port, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const info = await res.json();
    return typeof info?.webSocketDebuggerUrl === 'string' ? info : null;
  } catch { return null; }
}

/** Non-browser targets (pages, service workers) on the shell. `null` = unreachable. An empty
 *  list is the spec's "zero websocket clients" heuristic: the gate's own connections hold no
 *  page targets once the run's contexts are closed. */
async function listClientTargets(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const targets = await res.json();
    return Array.isArray(targets) ? targets.filter((t) => t?.type !== 'browser') : null;
  } catch { return null; }
}

// ── discovery file ──────────────────────────────────────────────────────────────────

function readDiscovery(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const d = JSON.parse(raw);
    if (Number.isInteger(d?.pid) && d.pid > 0 && Number.isInteger(d?.port) && d.port > 0 && d.port <= 65535 && Number.isFinite(d?.started)) return d;
  } catch { /* corrupt */ }
  try { unlinkSync(path); } catch { /* best-effort */ }
  return null;
}

function writeDiscoveryAtomic(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

// ── the mkdir-mutex ─────────────────────────────────────────────────────────────────

let _lockHolds = 0;
let _exitHookInstalled = false;

function readLockOwner() {
  try { return JSON.parse(readFileSync(LOCK_OWNER_FILE, 'utf8')); } catch { return null; }
}

function installGateExitHook() {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  // Sync `exit` handler (cannot await): drop the lock dir if we still own it, so an abnormal
  // exit (SIGTERM teardown, uncaughtException) doesn't make the next run wait out the 30s
  // stale-TTL. pid-checked so we never delete a lock that was stolen from us and re-created
  // by another process.
  process.on('exit', () => {
    if (_lockHolds <= 0) return;
    const owner = readLockOwner();
    if (owner?.pid === process.pid) {
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
}

/** Acquire the machine-global admission lock. Re-entrant for this pid (a process never
 *  contends with itself); waits behind a LIVE holder; steals only from a holder that is both
 *  older than the stale TTL and verifiably dead. Throws (loud) past the wait cap. */
async function acquireGateLock() {
  mkdirSync(GATE_ROOT, { recursive: true });
  if (_lockHolds > 0) {
    const owner = readLockOwner();
    if (owner?.pid === process.pid) { _lockHolds += 1; return; }
  }
  const deadline = Date.now() + LOCK_WAIT_CAP_MS;
  let lastNote = 0;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR); // atomic: exactly one winner
      writeFileSync(LOCK_OWNER_FILE, JSON.stringify({
        pid: process.pid, started: Date.now(), argv1: process.argv[1] ?? '',
      }));
      _lockHolds += 1;
      installGateExitHook();
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    const owner = readLockOwner();
    const heldMs = owner?.started != null ? Date.now() - owner.started
      : (() => { try { return Date.now() - statSync(LOCK_DIR).mtimeMs; } catch { return 0; } })();
    if (owner?.pid !== process.pid && heldMs > STALE_LOCK_MS) {
      const holderDead = owner?.pid != null && !pidAlive(owner.pid);
      const ownerFileMissing = owner == null && heldMs > STALE_LOCK_MS;
      if (holderDead || ownerFileMissing) {
        // Dead holder (or a lock dir whose owner entry never got written): steal. A
        // concurrent stealer race resolves on the next mkdir attempt (one winner, one EEXIST
        // loser).
        console.log(`[chrome-gate] stealing stale lock (holder pid ${owner?.pid ?? '?'} dead, held ${Math.round(heldMs / 1000)}s)`);
        try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* raced */ }
        continue;
      }
    }
    if (Date.now() - lastNote > 10_000) {
      console.log(`[chrome-gate] browser lock held by pid ${owner?.pid ?? '?'} for ${Math.round(heldMs / 1000)}s — queuing (machine-global singleton; waiting is normal)`);
      lastNote = Date.now();
    }
    if (Date.now() > deadline) {
      throw new Error(`[chrome-gate] browser lock still held by pid ${owner?.pid ?? '?'} after ${Math.round(LOCK_WAIT_CAP_MS / 60000)}min — refusing to run two shells; check for a wedged run or raise DPAY_E2E_LOCK_WAIT_MS`);
    }
    await sleep(250);
  }
}

/** Synchronous best-effort release; only removes the dir if we still own it. */
function releaseGateLockSync() {
  if (_lockHolds > 0) _lockHolds -= 1;
  const owner = readLockOwner();
  if (owner?.pid === process.pid) {
    try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* raced */ }
  }
}

// ── launch / adopt ──────────────────────────────────────────────────────────────────

/** Read the port chrome wrote into `<profile>/DevToolsActivePort` (line 1 = port). */
function readDevToolsActivePort(profileDir) {
  try {
    const first = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    const port = Number(first);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

async function waitForDevToolsPort(profileDir, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const port = readDevToolsActivePort(profileDir);
    if (port) return port;
    if (Date.now() > deadline) return null;
    await sleep(50);
  }
}

/** Try to adopt the shell a previous run left behind. Returns `{pid, port, launched: false}`
 *  on success, or null when the recorded shell is gone, foreign, or wedged. Dead-but-mine
 *  shells are SIGKILLed here so the fresh launch never fights a zombie for the profile dir. */
async function tryAdopt({ discoveryPath, profileDir }) {
  const d = readDiscovery(discoveryPath);
  if (!d) return null;
  const answered = await probeDevTools(d.port);
  const ours = pidIsOurShell(d.pid, profileDir);
  if (!answered || !ours) {
    if (pidAlive(d.pid) && ours) {
      console.log(`[chrome-gate] discovery file names a wedged shell (pid ${d.pid}, devtools not answering) — killing it before relaunch`);
      try { process.kill(d.pid, 'SIGKILL'); } catch { /* already dead */ }
    } else if (pidAlive(d.pid)) {
      console.log(`[chrome-gate] discovery file pid ${d.pid} is alive but not our shell (cmdline mismatch) — treating the file as stale`);
    }
    try { unlinkSync(discoveryPath); } catch { /* raced */ }
    return null;
  }
  const puppeteer = await pp();
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${d.port}`, defaultViewport: null });
  } catch (e) {
    console.log(`[chrome-gate] shell pid ${d.pid} answered /json/version but the CDP connect failed (${e instanceof Error ? e.message : e}) — relaunching`);
    try { unlinkSync(discoveryPath); } catch { /* raced */ }
    return null;
  }
  // Janitor: the lock is exclusive, so every existing context/page belongs to a DEAD holder
  // (a hard-killed run leaves its targets open). Clear them so the shell is pristine and the
  // sweep's zero-clients heuristic stays truthful once we disconnect.
  let cleaned = 0;
  try {
    for (const ctx of browser.browserContexts()) {
      if (ctx === browser.defaultBrowserContext()) continue;
      await ctx.close();
      cleaned += 1;
    }
    for (const page of await browser.pages()) {
      await page.close().catch(() => { /* raced */ });
      cleaned += 1;
    }
  } catch (e) {
    console.log(`[chrome-gate] janitor pass on adopted shell pid ${d.pid} partially failed: ${e instanceof Error ? e.message : e}`);
  }
  console.log(`[chrome-gate] reusing shared chrome-headless-shell pid=${d.pid} port=${d.port} (cleared ${cleaned} stale target(s) from a previous holder)`);
  try { await browser.disconnect(); } catch { /* already gone */ }
  return { pid: d.pid, port: d.port, launched: false };
}

/** Race any close/disconnect against a hard 5s ceiling (a wedged renderer can hang CDP
 *  teardown forever; a silently-hanging teardown is exactly the leak class this gate exists
 *  to prevent). */
async function withCloseCeiling(promise, what) {
  let done = false;
  const timer = new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error(`[chrome-gate] ${what} timed out after 5s`)), 5000);
    if (typeof t.unref === 'function') t.unref(); // never delay process exit for the timer
  });
  await Promise.race([promise.then(() => { done = true; }), timer]);
  return done;
}

const _leases = new Map(); // key -> Promise<lease>

/**
 * Acquire the machine-global browser: connect to the singleton shell when one is alive,
 * otherwise launch it under the admission lock. Returns `{browser, stop}`; `stop`
 * DISCONNECTS this connection only. The gate tears the shell down when the run's last
 * connection drops, and only if this process launched it (an adopted shell outlives us by
 * design; the sweep owns idle reaping).
 */
export async function acquireBrowser({ executablePath, extraArgs = [] }) {
  const key = gateKey(extraArgs, executablePath);
  let leasePromise = _leases.get(key);
  if (!leasePromise) {
    leasePromise = openLease({ key, executablePath, extraArgs }).catch((e) => { _leases.delete(key); throw e; });
    _leases.set(key, leasePromise);
  }
  const lease = await leasePromise;
  let browser;
  try {
    browser = await lease.connect();
  } catch (e) {
    // Shell died between lease-open and connect: tear the lease down (releases the lock) and
    // let the caller's next attempt start clean.
    await lease.teardown().catch(() => {});
    throw e;
  }
  lease.conns += 1;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await withCloseCeiling(browser.disconnect(), 'browser.disconnect()'); } catch { /* best-effort */ }
    lease.conns -= 1;
    if (lease.conns <= 0) await lease.teardown();
  };
  return { browser, stop };
}

async function openLease({ key, executablePath, extraArgs }) {
  const discoveryPath = discoveryPathFor(key);
  const profileDir = profileDirFor(key);
  await acquireGateLock();
  // Double-checked discovery: the lock guarantees we alone decide launch-vs-adopt.
  const adopted = await tryAdopt({ discoveryPath, profileDir }).catch(() => null);
  if (adopted) {
    return {
      key, conns: 0, pid: adopted.pid, port: adopted.port, launched: false,
      connect: () => pp().then((p) => p.connect({ browserURL: `http://127.0.0.1:${adopted.port}`, defaultViewport: null })),
      teardown: async () => {
        _leases.delete(key);
        // Adopted shell: disconnect-only happened per connection. Never kill it here; leave
        // the discovery file so the next run can adopt it too, and just release the lock.
        releaseGateLockSync();
      },
    };
  }
  // Launch path. The profile dir is ours alone under the lock and no live shell uses it:
  // clear any debris (a hard-killed shell leaves a SingletonLock that would block startup).
  const puppeteer = await pp();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: profileDir,
      args: [...BASE_LAUNCH_ARGS, ...extraArgs],
    });
  } catch (e) {
    releaseGateLockSync();
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[chrome-gate] chrome-headless-shell failed to launch (${executablePath}):\n${msg}`);
  }
  const proc = browser.process?.() ?? null;
  const pid = proc?.pid ?? null;
  const port = await waitForDevToolsPort(profileDir, DEVTOOLS_PORT_WAIT_MS);
  if (!Number.isInteger(pid) || pid <= 0 || !port) {
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
    try { await withCloseCeiling(browser.close(), 'browser.close()'); } catch { /* best-effort */ }
    releaseGateLockSync();
    throw new Error(`[chrome-gate] launched shell never wrote DevToolsActivePort within ${DEVTOOLS_PORT_WAIT_MS}ms — killed it; see the shell's stderr in the run log`);
  }
  // Registry backstop (236d9a6c semantics, self-launched shells only): an abnormal exit
  // SIGKILLs the shell from the sync exit handler, so a launched shell can never outlive us.
  trackChild(pid);
  writeDiscoveryAtomic(discoveryPath, { pid, port, started: Date.now() });
  console.log(`[chrome-gate] launched chrome-headless-shell pid=${pid} port=${port} (machine-global singleton; lock held for the run's browser lifetime)`);
  return {
    key, conns: 0, pid, port, launched: true,
    connect: () => pp().then((p) => p.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })),
    teardown: async () => {
      _leases.delete(key);
      try {
        // Self-launched shell: graceful CDP close raced against the 5s ceiling, SIGKILL
        // fallback (the same semantics driver.stop() had before the gate).
        let closed = false;
        try { closed = await withCloseCeiling(browser.close(), 'browser.close()'); } catch { closed = false; }
        if (closed) {
          untrackChild(pid); // the process is gone; drop the pid
        } else {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
          try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH: already dead */ }
        }
      } finally {
        try { unlinkSync(discoveryPath); } catch { /* raced */ }
        releaseGateLockSync();
      }
    },
  };
}

// ── sweep (just e2e-sweep) ──────────────────────────────────────────────────────────

/** SIGTERM, wait briefly, then SIGKILL. Only ever called on pids proven to be this gate's
 *  own shells (cmdline marker check). */
async function gracefulKill(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 2000;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(100);
  if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
}

/**
 * Reap the gate: remove dead discovery files, kill wedged / idle clientless gate shells,
 * drop a stale lock. NEVER touches a shell with live client targets, and never touches any
 * process that doesn't carry this gate's user-data-dir marker. Returns the action log.
 */
export async function sweepChromeGate({ minIdleMs = SWEEP_MIN_IDLE_MS } = {}) {
  const actions = [];
  mkdirSync(GATE_ROOT, { recursive: true });
  const referencedPids = new Set();

  // 1. discovery files
  let files = [];
  try {
    files = readdirSync(GATE_ROOT).filter((n) => /^dpay-chrome-.+\.json$/.test(n) && !n.includes('.tmp.'));
  } catch { /* no /tmp/opencode yet */ }
  for (const name of files) {
    const path = join(GATE_ROOT, name);
    const m = name.match(/^dpay-chrome-([^-]+?)(?:-([0-9a-f]{8}))?\.json$/);
    if (!m) { actions.push(`removed unrecognized discovery file ${name}`); try { unlinkSync(path); } catch {} continue; }
    const profileDir = profileDirFor(m[2] ?? '');
    const d = readDiscovery(path);
    if (!d) { actions.push(`removed corrupt discovery file ${name}`); continue; }
    referencedPids.add(d.pid);
    const answered = await probeDevTools(d.port, 1000);
    if (!answered) {
      if (pidIsOurShell(d.pid, profileDir)) {
        if (pidAlive(d.pid)) {
          await gracefulKill(d.pid);
          actions.push(`killed wedged gate shell pid=${d.pid} (devtools not answering; named by ${name})`);
        }
        try { unlinkSync(path); } catch {}
        actions.push(`removed dead discovery file ${name} (pid ${d.pid})`);
      } else if (pidAlive(d.pid)) {
        try { unlinkSync(path); } catch {}
        actions.push(`removed stale discovery file ${name} (pid ${d.pid} is alive but is NOT our shell — recycled pid; process untouched)`);
      } else {
        try { unlinkSync(path); } catch {}
        actions.push(`removed dead discovery file ${name} (pid ${d.pid} gone)`);
      }
      continue;
    }
    // Shell alive: reap only when it is old AND provably clientless.
    const ageMs = Date.now() - d.started;
    const targets = await listClientTargets(d.port);
    const clients = targets === null ? -1 : targets.length;
    if (ageMs > minIdleMs && clients === 0 && pidIsOurShell(d.pid, profileDir)) {
      await gracefulKill(d.pid);
      try { unlinkSync(path); } catch {}
      actions.push(`killed idle orphaned gate shell pid=${d.pid} (age ${Math.round(ageMs / 60000)}min, zero client targets; named by ${name})`);
    } else {
      const why = clients !== 0 ? `${clients} live client target(s)` : clients < 0
        ? 'target list unreachable (not killing without proof)'
        : `age ${Math.round(ageMs / 1000)}s < idle threshold`;
      actions.push(`kept ${name}: shell pid=${d.pid} alive, ${why}`);
    }
  }

  // 2. unreferenced shells launched by this gate (marker-scoped): the residue of hard-killed
  //    runs whose discovery file was already removed.
  let pids = [];
  try {
    pids = execFileSync('pgrep', ['-f', 'chrome-headless-shell'], { encoding: 'utf8' })
      .split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch { /* pgrep exits 1 when nothing matches */ }
  let foreign = 0;
  let gateChildren = 0;
  for (const pid of pids) {
    if (referencedPids.has(pid)) continue;
    const argv = readCmdline(pid);
    if (!argv) continue;
    const isChild = argv.some((a) => a.startsWith('--type='));
    const udd = argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    const isGateProcess = (argv[0] ?? '').includes('chrome-headless-shell') && udd?.startsWith(`${GATE_ROOT}/dpay-chrome-`);
    if (!isGateProcess) { foreign += 1; continue; } // other projects' shells (and their children): NEVER touched
    if (isChild) { gateChildren += 1; continue; } // our renderer/gpu child: dies with its main process
    const ageMs = procAgeMs(pid) ?? 0;
    const port = readDevToolsActivePort(udd);
    const targets = port ? await listClientTargets(port) : null;
    const clients = targets === null ? -1 : targets.length;
    if (ageMs > minIdleMs && clients === 0) {
      await gracefulKill(pid);
      actions.push(`killed unreferenced idle gate shell pid=${pid} (age ${Math.round(ageMs / 60000)}min, zero client targets)`);
    } else {
      const why = clients !== 0 ? `${clients} live client target(s)` : clients < 0
        ? 'devtools endpoint unreadable (not killing without proof)'
        : `age ${Math.round(ageMs / 1000)}s < idle threshold`;
      actions.push(`kept unreferenced gate shell pid=${pid}: ${why}`);
    }
  }
  if (pids.length > 0) actions.push(`scanned ${pids.length} chrome-headless-shell process(es); ${foreign} foreign + ${gateChildren} gate children (untouched)`);

  // 3. stale lock (dead owner only; a live holder is none of the sweep's business)
  const owner = readLockOwner();
  if (owner) {
    if (!pidAlive(owner.pid)) {
      try {
        rmSync(LOCK_DIR, { recursive: true, force: true });
        actions.push(`removed stale browser lock (holder pid ${owner.pid} dead)`);
      } catch { /* raced */ }
    } else {
      actions.push(`browser lock live: held by pid ${owner.pid} (untouched)`);
    }
  }

  return actions;
}
