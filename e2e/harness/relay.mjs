// Relay spawner — builds (if missing) and runs the REAL dpay-relay (FakeLedger, offline) built WITH
// `--features test-helpers` so the harness can drive the faucet + fake-IC gateway routes too.
// Hosts the page over 127.0.0.1 so sandboxed browser WebSocket CDP connections work.
//! The relay is the ONLY online dependency in the demo; in local mode we run it against the
//! in-memory fake-IC gateway so the whole suite stays offline + seconds-fast. In live mode
//! (DPAY_E2E_MODE=live) this spawner is NOT used — the harness points the app at $DPAY_E2E_BASE.
//
// --- Why a DEDICATED cargo target dir (the root fix for the "rebuild on every run" workaround) ---
// The e2e relay MUST be built with `--features test-helpers` (the `/api/v1/faucet` +
// `/api/v2/canister/*` fake-IC gateway routes),
// but `just check` / `just test-relay` build the SAME crate WITHOUT the feature into the SHARED
// `target/debug/dpay-relay`. Same output path → a plain `cargo build -p dpay-relay` CLOBBERS the
// feature-bearing binary, and a "binary exists" probe cannot tell the two apart. The old harness
// papered over this by ALWAYS rebuilding on every `just e2e` (~0.3s when warm, ~30s cold after a
// `just check`). The TRUE fix: give the e2e relay its OWN cargo target dir (`.dev/target-e2e`,
// gitignored) so nothing else ever writes the e2e binary — cargo's own fingerprinting within that
// isolated dir is now authoritative, and a missing-binary probe is sufficient. The deps cache stays
// shared (`.dev/cargo` as CARGO_HOME), so a cold build is no slower than before. A post-spawn
// `/api/v1/faucet` reachability probe is a SAFETY NET (defense against a future regression),
// NOT the primary mechanism — the isolated dir is.
//
// Hard rules honored:
// - No silent errors: every step is wrapped + logged with port/exit-code/stderr on failure.
// - Timeouts everywhere: cargo build has its own (caller passes a spawn timeout); ready-detect
//   polls /api/v1/health for < READY_TIMEOUT_MS; the relay is SIGTERM'd cleanly on teardown.
// - Picks a FREE port per run (no port collisions).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { trackChild, untrackChild } from './procs.mjs';
import { profSpan } from './profile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const E2E_DIR = __dirname;
// Dedicated, isolated cargo target dir for the e2e relay (gitignored under `.dev/`). Nothing else
// in the build graph writes here, so a featureless `cargo build -p dpay-relay` (from `just check`)
// can NEVER clobber the e2e binary. This is the root-cause fix for the always-rebuild workaround.
const E2E_TARGET_DIR = join(REPO_ROOT, '.dev', 'target-e2e');
const RELAY_BIN = join(E2E_TARGET_DIR, 'debug', 'dpay-relay');
// Reuse the shared in-project cargo home so the deps cache stays warm + fast across target dirs.
const CARGO_HOME_DIR = join(REPO_ROOT, '.dev', 'cargo');

export const READY_TIMEOUT_MS = 5_000;
export const HEALTH_POLL_INTERVAL_MS = 100;

/** Find a free TCP port by binding to :0 and immediately closing — the relay then re-binds it. */
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

/**
 * Ensure the e2e relay binary is CURRENT, built WITH `--features test-helpers` into the ISOLATED e2e
 * target dir. ALWAYS invokes `cargo build` and lets cargo's own fingerprinting decide: a warm no-op
 * is ~0.3s, and any source/dependency change (R1/R2/..., Cargo.toml, Cargo.lock) triggers a real
 * recompile. The isolated target dir (E2E_TARGET_DIR) means no other build clobbers the binary, so
 * cargo's fingerprinting is AUTHORITATIVE here.
 *
 * WHY always-invoke (not build-if-missing): an earlier version short-circuited on `existsSync`, which
 * skipped cargo whenever the binary existed. That served a STALE binary after a relay source edit —
 * e.g. a pre-receipt-signing (pre-R2) relay kept running after R2 landed, so /pay returned an
 * unsigned receipt and the app's R2 verification failed (flow 07/09 timed out waiting for "Paid").
 * Letting cargo run every time is the true fix: the 0.3s warm cost is negligible vs the ~13s suite,
 * and a source edit is guaranteed to produce a fresh binary. `force=true` (the 404 safety net) cleans
 * the relay crate first so the rebuild is a genuine recompile, not a cargo no-op.
 *
 * PER-PROCESS MEMO (a faster no-op, same staleness contract): within ONE harness process —
 * `just e2e`, where the session relay plus every flow-owned relay (40/84/151, the EVM pipe flows)
 * spawn concurrently across lanes — the input set's newest mtime is fingerprinted before invoking
 * cargo. Unchanged inputs since THIS PROCESS's last successful build → skip the ~0.3s invocation
 * (and, worse, the cargo target-dir flock that serializes concurrent spawns invisibly against a
 * lane's wall clock). Any input newer than the memo (a source edit, a `just web-prod` re-staging
 * dist-prod which build.rs embeds) invalidates it, so watch mode — a long-lived process that sees
 * edits mid-session — stays correct. `force` bypasses the memo.
 */
let _builtFingerprintMs = null;

/** Newest mtime across every input the relay build consumes: all crate sources (the relay links
 *  dpay-core/ffi/…), every crate + workspace manifest, and the dist-prod tree build.rs embeds. */
function relayBuildFingerprintMs() {
  let newest = 0;
  const touch = (p) => { try { const m = statSync(p).mtimeMs; if (m > newest) newest = m; } catch {} };
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === 'target' || name === '.dev') continue;
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (/\.(rs|toml)$/.test(name)) touch(p);
    }
  };
  walk(join(REPO_ROOT, 'crates'));
  touch(join(REPO_ROOT, 'Cargo.toml'));
  touch(join(REPO_ROOT, 'Cargo.lock'));
  walk(join(E2E_DIR, 'dist-prod'));
  // The pinned toolchain's rustc: a rustup update leaves every source mtime untouched but
  // produces a binary cargo WOULD rebuild — include the compiler binary so the freshness skip
  // below stays honest. (The rustup-installed toolchain bin, not PATH, is what cargoEnv uses.)
  for (const tc of ['stable-x86_64-unknown-linux-gnu', 'stable-aarch64-unknown-linux-gnu']) {
    touch(join(REPO_ROOT, '.dev', 'rustup', 'toolchains', tc, 'bin', 'rustc'));
  }
  return newest;
}

/**
 * CROSS-PROCESS freshness skip: cargo rebuilds iff some input is newer than the OUTPUT binary, so
 * a binary newer than every fingerprint input is exactly cargo's own no-op — invoking cargo to
 * confirm costs a 2.4s warm no-op idle (9s under load, measured 2026-09-28: the fingerprint walk
 * + full crate-graph validation is NOT free). This is the per-PROCESS memo made persistent; the
 * staleness contract is identical (any source/manifest/dist-prod/toolchain edit moves an input
 * newer than the binary → cargo runs). `force` bypasses everything.
 */
function relayBinaryIsFresh() {
  try {
    return statSync(RELAY_BIN).mtimeMs > relayBuildFingerprintMs();
  } catch {
    return false; // no binary (or unreadable inputs) → let cargo decide
  }
}

export async function ensureRelayBuilt(opts = {}) {
  if (opts.force) {
    console.log('[relay] force: cleaning the dpay-relay crate before rebuild…');
    const cc = await runCargo(['clean', '-p', 'dpay-relay'], 60_000);
    if (cc !== 0) console.warn(`[relay] cargo clean -p dpay-relay exited ${cc} (continuing)`);
  } else if (_builtFingerprintMs != null) {
    const fp = relayBuildFingerprintMs();
    if (fp <= _builtFingerprintMs) return; // unchanged since this process's last build — cargo would no-op
    _builtFingerprintMs = null; // inputs moved: re-run cargo below
  } else if (relayBinaryIsFresh()) {
    _builtFingerprintMs = relayBuildFingerprintMs();
    return; // binary newer than every input — cargo's own no-op, verified without invoking cargo
  }
  console.log(`[relay] cargo build dpay-relay --features test-helpers into ${E2E_TARGET_DIR} (cargo fingerprints)…`);
  const code = await runCargo(['build', '-p', 'dpay-relay', '--features', 'test-helpers'], opts.timeoutMs ?? 300_000);
  if (code !== 0) throw new Error(`relay build failed (cargo exit ${code})`);
  if (!existsSync(RELAY_BIN)) {
    throw new Error(`relay build reported success but ${RELAY_BIN} is missing — did the package/bin name change?`);
  }
  _builtFingerprintMs = relayBuildFingerprintMs();
}

function cargoEnv() {
  // Pin both the target dir + the shared cargo home so the e2e build is fully isolated in its
  // OUTPUT (E2E_TARGET_DIR) while sharing the dependency cache (CARGO_HOME). Inheriting process.env
  // keeps PATH (cargo) + any justfile-exported vars intact.
  return {
    ...process.env,
    CARGO_TARGET_DIR: E2E_TARGET_DIR,
    CARGO_HOME: process.env.CARGO_HOME ?? CARGO_HOME_DIR,
  };
}

function runCargo(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { cwd: REPO_ROOT, env: cargoEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', () => {}); // discard stdout (progress)
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`cargo ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[relay] cargo stderr (tail):\n${stderr.split('\n').slice(-30).join('\n')}`);
      }
      resolve(code ?? 0);
    });
  });
}

/**
 * Probe that the feature-gated test-helpers surface actually exists on the RUNNING relay. SAFETY
 * NET for the isolated-target-dir root fix: with the isolated dir a featureless clobber is
 * impossible, but this guard turns a silent future regression (route 404) into a loud error + one
 * forced rebuild, instead of a confusing flow failure.
 *
 * (2026-08-19 IC-rail cutover: the old probe hit `/api/v1/test/deposit/seed`, which was DELETED
 * with the relay settlement surface. The probe now hits `POST /api/v1/faucet` — the surviving
 * test-helpers funding route — with the same stateless trick.)
 *
 * Stateless by design: POSTs a deliberately-invalid account (4 hex bytes, not 32) so the route
 * returns `400 "account must be 32 bytes hex"` WITHOUT touching the ledger. A `404` means the route
 * is absent → the binary lacks `test-helpers`. Returns true iff the route is present. (A relay
 * whose faucet is switched OFF answers 503 before it looks at the account — also "present", which
 * is what this probe asks; the harness always spawns with it on.)
 */
async function probeFaucetRoute(baseURL, timeoutMs = 3_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseURL}/api/v1/faucet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 4-byte hex → rejected at parse_hex_array's length check BEFORE any ledger mutation. Stateless.
      body: JSON.stringify({ account: 'deadbeef', currency: 0, amount: 0 }), signal: ctrl.signal,
    });
    // 400 (bad account) = route present + feature compiled in; 404 = route absent (featureless).
    return r.status !== 404;
  } catch {
    return false; // treat a transport error as "probe inconclusive → caller may rebuild"
  } finally {
    clearTimeout(t);
  }
}

/**
 * Spawn the relay on a free port. Returns `{ port, baseURL, stop }`. The relay binds
 * `DPAY_RELAY_ADDR=127.0.0.1:PORT` and settles on the in-memory FakeLedger (DPAY_LEDGER=memory),
 * with the faucet ENABLED so the onboarding flow's `/api/v1/faucet` POST funds the new account.
 *
  * After health, probes the feature-gated `/api/v1/faucet` route (SAFETY NET). If it 404s — which
   * the isolated target dir makes impossible, but a future regression could — forces ONE rebuild into
   * the isolated dir and respawns, then re-probes. A second 404 is a hard, loud error (never silent).
   */
export async function startRelay(opts = {}) {
  const stopBuild = profSpan('relay.cargoBuild');
  await ensureRelayBuilt();
  stopBuild();
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const { port, baseURL, stop, stdout, stderr } = await spawnOnce(opts);
    try {
      const stopHealth = profSpan('relay.healthWait');
      await waitForHealth(baseURL, opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
      stopHealth();
      // Safety-net probe: confirm the feature-gated route is live.
      if (await probeFaucetRoute(baseURL)) {
        return { port, baseURL, stop };
      }
      // Route absent (404) — a featureless clobber SHOULD be impossible with the isolated dir, but
      // rebuild once + respawn before giving up, so a transient/regressed build can't silently fail.
      await stop();
      if (attempt === 1) {
        console.warn('[relay] /api/v1/faucet returned 404 (feature missing) — forcing a rebuild into the isolated dir…');
        await ensureRelayBuilt({ force: true });
        continue; // respawn + re-probe
      }
      throw new Error(
        `/api/v1/faucet still 404 after a forced rebuild — the relay binary lacks --features test-helpers.\n` +
        `  binary: ${RELAY_BIN}\n` +
        `  target dir: ${E2E_TARGET_DIR}`
      );
    } catch (e) {
      await stop();
      if (attempt === 1 && e.message && e.message.includes('health never returned')) {
        // A transport failure during health: surface, but only retry once after a rebuild.
        console.warn(`[relay] health probe failed (${e.message}); forcing a rebuild into the isolated dir…`);
        await ensureRelayBuilt({ force: true });
        continue;
      }
      throw new Error(
        `relay did not become healthy/ready at ${baseURL}: ${e}\n` +
        `  stdout tail:\n${stdout.split('\n').slice(-15).join('\n')}\n` +
        `  stderr tail:\n${stderr.split('\n').slice(-15).join('\n')}`
      );
    }
  }
}

/** One relay spawn: binds a free port, returns `{ port, baseURL, stop, stdout, stderr }`. */
async function spawnOnce(opts = {}) {
  const port = opts.port ?? await pickFreePort();
  const addr = `127.0.0.1:${port}`;
  const baseURL = `http://${addr}`;
  console.log(`[relay] spawning ${RELAY_BIN} at ${addr} (FakeLedger, faucet ${opts.faucet === false ? 'off' : 'on'}, checkout ${opts.checkout === false ? 'off' : 'on'})…`);

  const env = {
    ...process.env,
    // Keep the isolated target/cargo env on the spawn too (harmless at runtime, but self-consistent
    // and lets the binary's own tooling, if any, find the same paths).
    CARGO_TARGET_DIR: E2E_TARGET_DIR,
    CARGO_HOME: process.env.CARGO_HOME ?? CARGO_HOME_DIR,
    DPAY_RELAY_ADDR: addr,
    DPAY_LEDGER: 'memory',
    // The demo faucet is ON for every flow but the ones whose SUBJECT is a relay that hands out
    // no practice money — the first-run screens have to be honest about that and must not ask
    // the user for funds instead (anti-scam rule R1), and the only way to see it is to serve it.
    DPAY_ENABLE_FAUCET: opts.faucet === false ? 'false' : 'true',
    // The OpenCryptoPay checkout is ON by default in a shipped relay since the 2026-09-10 founder
    // decision; the harness still sets it EXPLICITLY so `opts.checkout === false` (flow 144) exercises
    // the operator opt-out deterministically whatever the binary's default. Flows 114-116 open charges
    // a real signed charge on `POST /api/v1/checkout`, pay it with a real signed VCHF transfer, and
    // watch `GET /api/v1/checkout/{id}` credit it. Enabling it costs the other flows nothing — the
    // checkout's payer-facing routes are shadowed by each OCP flow's own fetch stub.
    DPAY_ENABLE_CHECKOUT: opts.checkout === false ? 'false' : 'true',
    // Marker so a future relay feature can detect the e2e harness (no behavior change today).
    DPAY_E2E: '1',
    // R2 (flow 165): the Solana RPC proxy's UPSTREAM — the relay's own test-helpers JSON-RPC
    // stub on this same server. Named EXPLICITLY (never inherited) so a shell-exported
    // DPAY_SOLANA_RPC_URL can never leak into the harness relay: the spread of process.env
    // above carries toolchain vars (PATH/CARGO_*), while every DPAY_* knob is set HERE,
    // deliberately, per spawn.
    DPAY_SOLANA_RPC_URL: `http://127.0.0.1:${port}/api/v1/test/solana-upstream`,
    // Flow 187 (2026-09-15): the SideShift partner-key proxy's upstream — the relay's own
    // test-helpers stub on this same server, plus FAKE credentials (the shape is exercised;
    // no partner account exists — signing up is a founder step). Same deliberate-per-spawn
    // rule as DPAY_SOLANA_RPC_URL above: named HERE so a shell-exported DPAY_SIDESHIFT_*
    // can never leak a real secret into the harness relay.
    DPAY_SIDESHIFT_SECRET: 'e2e-stub-partner-secret',
    DPAY_SIDESHIFT_AFFILIATE_ID: 'e2e-stub-affiliate-id',
    DPAY_SIDESHIFT_API_BASE: `http://127.0.0.1:${port}/api/v1/test/sideshift-upstream`,
    // Flow 198 (2026-09-20): the Trocador aggregator proxy's upstream — the relay's own
    // test-helpers stub on this same server, plus a FAKE partner key (no key exists yet;
    // the real one is a founder step via commercial@trocador.app). Same deliberate-per-spawn
    // rule as every DPAY_* knob above: named HERE so a shell-exported DPAY_TROCADOR_*
    // can never leak into the harness relay.
    DPAY_TROCADOR_API_KEY: 'e2e-stub-trocador-key',
    DPAY_TROCADOR_API_BASE: `http://127.0.0.1:${port}/api/v1/test/trocador-upstream`,
    // The partner-agreement's 60s/trade-id upstream status window stood DOWN for the stub
    // world (2026-09-28): the offline venue has no partner budget to protect, and the
    // window was pacing every cefi lifecycle transition at ~55s (the app's engine honestly
    // waits out the 429 Retry-After). The knob is test-helpers-only relay-side, so prod
    // keeps the promise by construction. Same deliberate-per-spawn rule as the block above.
    DPAY_TROCADOR_STATUS_SPACING_SECS: '0',
    // Flow 185/186/189 (2026-09-16): the Jupiter proxy's upstream — the relay's own
    // test-helpers stub on this same server (keyless venue, so no credential vars). Same
    // deliberate-per-spawn rule as the two blocks above: named HERE so a shell-exported
    // DPAY_JUPITER_API_BASE can never leak a real base into the harness relay.
    DPAY_JUPITER_API_BASE: `http://127.0.0.1:${port}/api/v1/test/jupiter-upstream`,
    // Flow 199 (2026-09-22): a flow's OWN agreement knobs (DPAY_PUBLIC_ORIGIN,
    // DPAY_TROCADOR_LOG_DIR, …) ride `opts.env` — spread BEFORE the RUST_LOG clamp so the
    // fixed wiring above still wins for the knobs IT owns, and the clamp stays last. A flow
    // that passes nothing (every other flow) spawns byte-identically to before.
    ...(opts.env ?? {}),
    // Clamp noisy logs (the binary's banner is enough).
    RUST_LOG: process.env.RUST_LOG ?? 'warn',
  };
  const child = spawn(RELAY_BIN, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Track the PID the instant the child is born so a sync `process.on('exit')` SIGKILL can reach it
  // even if Node dies before health checks complete (the window where _session is still null). Untrack
  // on exit so the set never holds a dead/recycled PID. See harness/procs.mjs.
  trackChild(child.pid);
  child.on('exit', () => untrackChild(child.pid));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { const s = b.toString(); stdout += s; if (process.env.DPAY_E2E_VERBOSE) process.stdout.write(s); });
  child.stderr.on('data', (b) => { const s = b.toString(); stderr += s; if (process.env.DPAY_E2E_VERBOSE) process.stderr.write(s); });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      try { child.kill('SIGTERM'); } catch { resolve(); }
      // Hard kill after a grace period so a stuck relay can't hang the suite.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000);
    });
  };
  return { port, baseURL, stop, stdout, stderr };
}

/** Poll GET /api/v1/health until it returns 200 {status:"ok"}, or throw on timeout. */
export async function waitForHealth(baseURL, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_500);
      try {
        const r = await fetch(`${baseURL}/api/v1/health`, { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j?.status === 'ok') return;
        }
      } finally {
        clearTimeout(t);
      }
    } catch (e) { lastErr = e; }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(`health never returned ok (last error: ${String(lastErr)})`);
}
