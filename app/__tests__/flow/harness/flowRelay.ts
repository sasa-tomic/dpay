/**
 * flowRelay.ts — per-test PRIVATE test-helpers relay spawns for the flow tier (the jest twin of
 * the e2e `startRelay(...)` capability, e2e/harness/relay.mjs). The ONE shared relay
 * (jest.relay-setup.js globalSetup) stays the default and is untouched; this module exists for
 * the flows whose SUBJECT is a relay PROCESS property that cannot be flipped on a live relay:
 * checkout capability (DPAY_ENABLE_CHECKOUT, flow 144), the global-per-gateway ic_delay knob
 * (flow 201 leg 2), the partner-agreement deployment knobs (DPAY_PUBLIC_ORIGIN +
 * DPAY_TROCADOR_LOG_DIR, flow 199), and the balance-CHANGE retarget proof (flow 38).
 *
 * Zero fixture duplication is impossible here on purpose: e2e/harness/relay.mjs must never be
 * imported from jest (babel's CJS transform breaks its import.meta.url), so this re-expresses
 * ONLY the spawn half — the same binary (.dev/target-e2e/debug/dpay-relay, the feature-bearing
 * build in the isolated e2e target dir), the same env knobs named EXPLICITLY per spawn (never
 * inherited — the relay.mjs doctrine), the same /api/v1/health probe. It never builds: the
 * binary is the seeded e2e artifact (globalSetup already proved it runs — startFlowRelay fails
 * with relay.mjs's actionable message when missing).
 *
 * Teardown is harness-owned: every relay registers on globalThis (which is shared across the
 * setup/afterEnv/test-file module registries — module state here would NOT be), and the
 * lifecycle's afterEach stops them AFTER the mounting test's app is unmounted, mirroring the
 * e2e teardown ORDER (quiesce the page's polls before killing the relay — flow-38 convention).
 */
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {scaled as budgetScaled} from './budget';

const here = dirname(__filename); // app/__tests__/flow/harness
const repoRoot = join(here, '..', '..', '..', '..');
const RELAY_BIN = join(repoRoot, '.dev', 'target-e2e', 'debug', 'dpay-relay');

const READY_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 100;

export type FlowRelay = {
  port: number;
  baseURL: string;
  /** Idempotent SIGTERM (+ SIGKILL backstop). The harness afterEach already calls it. */
  stop: () => Promise<void>;
};

type RelayG = {__DPAY_FLOW_RELAYS__?: FlowRelay[]};
const g = globalThis as unknown as RelayG;

/** Every relay this worker has spawned and not yet stopped — the afterEach drain list. On
 *  globalThis because the lifecycle (afterEnv registry) and the tests (test-file registry)
 *  are different jest module registries; only globalThis is shared between them. */
function relays(): FlowRelay[] {
  g.__DPAY_FLOW_RELAYS__ ??= [];
  return g.__DPAY_FLOW_RELAYS__;
}

/** Lifecycle teardown hook: stop and forget every live flow relay (idempotent). */
export async function teardownFlowRelays(): Promise<void> {
  const live = relays().splice(0, relays().length);
  for (const r of live) {
    try { await r.stop(); } catch { /* a dying relay must not mask the test's verdict */ }
  }
}

/** Find a free TCP port by binding :0 and closing — the relay then re-binds (relay.mjs's trick). */
export async function pickFreePort(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('node:net') as typeof import('node:net');
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as {port: number}).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn one private test-helpers relay on a free port. Knobs (all named EXPLICITLY per spawn,
 * never inherited — a shell-exported DPAY_* must never leak into a harness relay):
 *   checkout:false → DPAY_ENABLE_CHECKOUT=false (flow 144's operator opt-out)
 *   faucet:false   → DPAY_ENABLE_FAUCET=false
 *   env            → extra deployment knobs verbatim (DPAY_PUBLIC_ORIGIN, DPAY_TROCADOR_LOG_DIR)
 */
export async function startFlowRelay(opts: {port?: number; checkout?: boolean; faucet?: boolean; env?: Record<string, string>; readyTimeoutMs?: number} = {}): Promise<FlowRelay> {
  if (!existsSync(RELAY_BIN)) {
    throw new Error(
      '[flow-relay] the test-helpers relay binary is missing: ' + RELAY_BIN +
      ' — build it once (the e2e message applies: `just web` / the e2e build produces ' +
      '.dev/target-e2e/debug/dpay-relay with --features test-helpers).',
    );
  }
  const port = opts.port ?? await pickFreePort();
  const addr = `127.0.0.1:${port}`;
  const baseURL = `http://${addr}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    DPAY_RELAY_ADDR: addr,
    DPAY_LEDGER: 'memory',
    DPAY_ENABLE_FAUCET: opts.faucet === false ? 'false' : 'true',
    DPAY_ENABLE_CHECKOUT: opts.checkout === false ? 'false' : 'true',
    DPAY_E2E: '1',
    // R2: the Solana RPC proxy's upstream — this relay's own test-helpers stub (same server).
    DPAY_SOLANA_RPC_URL: `${baseURL}/api/v1/test/solana-upstream`,
    // Flow 187/199's proxy upstreams — the stubs on this same server + FAKE credentials
    // (no partner account exists; the shape is exercised).
    DPAY_SIDESHIFT_SECRET: 'e2e-stub-partner-secret',
    DPAY_SIDESHIFT_AFFILIATE_ID: 'e2e-stub-affiliate-id',
    DPAY_SIDESHIFT_API_BASE: `${baseURL}/api/v1/test/sideshift-upstream`,
    DPAY_TROCADOR_API_KEY: 'e2e-stub-trocador-key',
    DPAY_TROCADOR_API_BASE: `${baseURL}/api/v1/test/trocador-upstream`,
    DPAY_JUPITER_API_BASE: `${baseURL}/api/v1/test/jupiter-upstream`,
    ...(opts.env ?? {}),
    RUST_LOG: process.env.RUST_LOG ?? 'warn',
  };
  const child: ChildProcess = spawn(RELAY_BIN, [], {cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr?.on('data', (b: Buffer) => { stderr += b.toString(); });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const i = relays().indexOf(relay);
    if (i >= 0) relays().splice(i, 1);
    if (child.exitCode !== null || child.signalCode) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      try { child.kill('SIGTERM'); } catch { resolve(); }
      // The 2s SIGTERM→SIGKILL grace scales with the load budget too: it is a teardown bound,
      // not an assertion — under starvation a healthy relay also dies slowly, and a wedged
      // teardown must never bleed into the next test (the same doctrine as the unmount race).
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, budgetScaled(2_000));
    });
  };
  const relay: FlowRelay = {port, baseURL, stop};
  relays().push(relay);

  // Health probe: GET /api/v1/health → 200 {status:"ok"} (relay.mjs's contract), bounded. Uses
  // the UNRECORDED fetch (setupFlow's __DPAY_TEST_RAW_FETCH): the not-yet-up polls of a spawn in
  // progress are harness probes, not app requests — recording them would trip the fail-closed
  // rule on the spawn's own startup window.
  const probe = (globalThis as unknown as {__DPAY_TEST_RAW_FETCH?: typeof fetch}).__DPAY_TEST_RAW_FETCH ?? fetch;
  // Positive wait (the spawn coming up) — budget-scaled: a worker fighting for CPU delays BOTH
  // the relay's first serve and this loop's ticks; the old fixed 10s expired under exactly that.
  const deadline = Date.now() + budgetScaled(opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  let lastErr: unknown = null;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(
        `[flow-relay] the private relay exited before becoming healthy (code ${child.exitCode ?? child.signalCode})\n` +
        `  stdout tail:\n${stdout.split('\n').slice(-10).join('\n')}\n  stderr tail:\n${stderr.split('\n').slice(-10).join('\n')}`,
      );
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_500);
      try {
        const r = await probe(`${baseURL}/api/v1/health`, {signal: ctrl.signal});
        if (r.ok) {
          const j = await r.json().catch(() => ({})) as {status?: string};
          if (j?.status === 'ok') break;
        }
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`[flow-relay] health never returned ok at ${baseURL} (last error: ${String(lastErr)})`);
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return relay;
}
