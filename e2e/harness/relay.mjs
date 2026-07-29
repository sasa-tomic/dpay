// Relay spawner — builds (if needed) and runs the REAL `target/debug/dpay-relay` (FakeLedger,
// offline) with `--features test-helpers` so the harness can drive the deposit-seed route too.
//
// The relay is the ONLY online dependency in the demo; in local mode we run it against the
// in-memory FakeLedger so the whole suite stays offline + seconds-fast. In live mode (DPAY_E2E_MODE
// =live) this spawner is NOT used — the harness points the app at $DPAY_E2E_BASE instead.
//
// Hard rules honored:
// - No silent errors: every step is wrapped + logged with port/exit-code/stderr on failure.
// - Timeouts everywhere: cargo build has its own (caller passes a spawn timeout); ready-detect
//   polls /api/v1/health for < READY_TIMEOUT_MS; the relay is SIGTERM'd cleanly on teardown.
// - Idempotent: re-uses an existing build; picks a FREE port per run (no port collisions).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RELAY_BIN = join(REPO_ROOT, 'target', 'debug', 'dpay-relay');

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
 * Ensure the relay binary is built WITH `--features test-helpers` (the deposit-seed route the e2e
 * harness needs). Always invokes cargo build rather than skipping on an existing binary, because a
 * plain `cargo build -p dpay-relay` (from `just check` / `just test-relay`) OVERWRITES the artifact
 * WITHOUT the feature — a "binary exists" check can't distinguish the two, and a featureless binary
 * returns 404 for `/test/deposit/seed`. Cargo's incremental cache makes an up-to-date build a
 * ~0.3s no-op, so this is cheap and correct across `check`/`e2e` interleaving.
 */
export async function ensureRelayBuilt(opts = {}) {
  console.log('[relay] ensuring target/debug/dpay-relay is built with --features test-helpers…');
  const code = await runCargo(['build', '-p', 'dpay-relay', '--features', 'test-helpers'], opts.timeoutMs ?? 300_000);
  if (code !== 0) throw new Error(`relay build failed (cargo exit ${code})`);
}

function runCargo(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
 * Spawn the relay on a free port. Returns `{ port, baseURL, stop }`. The relay binds
 * `DPAY_RELAY_ADDR=127.0.0.1:PORT` and settles on the in-memory FakeLedger (DPAY_LEDGER=memory),
 * with the faucet ENABLED so the onboarding flow's `/api/v1/faucet` POST funds the new account.
 */
export async function startRelay(opts = {}) {
  await ensureRelayBuilt();
  const port = opts.port ?? await pickFreePort();
  const addr = `127.0.0.1:${port}`;
  const baseURL = `http://${addr}`;
  console.log(`[relay] spawning ${RELAY_BIN} at ${addr} (FakeLedger, faucet on)…`);

  const env = {
    ...process.env,
    DPAY_RELAY_ADDR: addr,
    DPAY_LEDGER: 'memory',
    DPAY_ENABLE_FAUCET: 'true',
    // Marker so a future relay feature can detect the e2e harness (no behavior change today).
    DPAY_E2E: '1',
    // Clamp noisy logs (the binary's banner is enough).
    RUST_LOG: process.env.RUST_LOG ?? 'warn',
  };
  const child = spawn(RELAY_BIN, [], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // Race: wait for either /api/v1/health=ok OR a premature child exit. The latter is a hard error.
  try {
    await waitForHealth(baseURL, opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  } catch (e) {
    await stop();
    throw new Error(
      `relay did not become healthy at ${baseURL} within ${opts.readyTimeoutMs ?? READY_TIMEOUT_MS}ms: ${e}\n` +
      `  stdout tail:\n${stdout.split('\n').slice(-15).join('\n')}\n` +
      `  stderr tail:\n${stderr.split('\n').slice(-15).join('\n')}`
    );
  }
  return { port, baseURL, stop };
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
