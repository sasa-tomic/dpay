// Web builder + static server. Builds the REAL app once via vite (cached, <2s incremental) and
// serves `e2e/dist` via sirv on a free port, offline, on 127.0.0.1. The relay URL is passed to the
// app via the `?relay=` query param — see `e2e/web/relay-config.ts` (the entry the app's
// `./relayConfig` import is aliased to).
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(__dirname, '..');
const DIST = join(E2E_DIR, 'dist');
const INDEX_HTML = join(DIST, 'index.html');

export const BUILD_TIMEOUT_MS = 90_000;
export const SERVE_READY_TIMEOUT_MS = 5_000;

/** Build the web bundle via vite. No-op if `dist/index.html` exists AND `force=false` (cached). */
export async function buildWeb(opts = {}) {
  if (!opts.force && existsSync(INDEX_HTML)) {
    console.log('[web] using existing dist/index.html (cached; pass force=true to rebuild)');
    return;
  }
  console.log('[web] building (vite)…');
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

/**
 * Serve `e2e/dist` on a free port via sirv-cli. Returns `{ port, baseURL, stop }`. Throws (does not
 * hang) if sirv fails to start or the port never opens.
 */
export async function serveWeb(opts = {}) {
  if (!existsSync(INDEX_HTML)) throw new Error(`serveWeb: ${INDEX_HTML} missing — call buildWeb first`);
  const port = opts.port ?? await pickFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const sirvBin = join(E2E_DIR, 'node_modules', 'sirv-cli', 'bin.js');
  console.log(`[web] serving dist at ${baseURL} (sirv)…`);
  const child = spawn(process.execPath, [sirvBin, DIST, '--single', '--host', '127.0.0.1', '--port', String(port), '--quiet'], {
    cwd: E2E_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
