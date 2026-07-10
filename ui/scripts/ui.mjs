// Self-contained orchestrator for `npm run ui`:
//   build (vite) -> serve dist (sirv, offline, 127.0.0.1) -> wait for port
//   -> shoot (4 screenshots) -> compare (seed or diff) -> tear down -> exit code.
//
// Everything stays on 127.0.0.1; no external network at run time.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, '..');
const DIST = join(UI_DIR, 'dist');

const HOST = '127.0.0.1';
const PORT = Number(process.env.DPAY_PORT || 4173);
const BASE = `http://${HOST}:${PORT}`;

const npmCli = process.env.npm_execpath; // node's own npm, if invoked via npm
const nodeBin = process.execPath;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: UI_DIR, ...opts });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${cmd} ${args.join(' ')} killed by ${signal}`));
      resolve(code ?? 0);
    });
  });
}

function waitForPort(host, port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = createConnection({ host, port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`server did not open ${host}:${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    };
    attempt();
  });
}

async function main() {
  // 1) Build.
  console.log('[ui] building (vite)…');
  const buildCode = await run(nodeBin, [join(UI_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
  if (buildCode !== 0) throw new Error(`vite build failed (exit ${buildCode})`);
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('build produced no dist/index.html');

  // 2) Serve dist offline. sirv-cli exposes a `sirv` bin under node_modules/.bin.
  const sirvBin = join(UI_DIR, 'node_modules', 'sirv-cli', 'bin.js');
  console.log(`[ui] serving dist at ${BASE} (sirv)…`);
  const server = spawn(
    nodeBin,
    [sirvBin, 'dist', '--single', '--host', HOST, '--port', String(PORT), '--quiet'],
    { cwd: UI_DIR, stdio: 'inherit' }
  );

  let serverClosed = false;
  server.on('exit', () => { serverClosed = true; });

  const stopServer = () => {
    if (!serverClosed && server.pid) {
      try { process.kill(server.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  process.on('exit', stopServer);

  let exitCode = 0;
  try {
    await waitForPort(HOST, PORT);
    console.log('[ui] server up');

    // 3) Screenshots.
    await run(nodeBin, [join(__dirname, 'shoot.mjs')], { env: { ...process.env, DPAY_BASE_URL: BASE } });

    // 4) Compare / seed.
    const cmpCode = await run(nodeBin, [join(__dirname, 'compare.mjs')]);
    exitCode = cmpCode;
  } catch (err) {
    console.error(`[ui] ERROR: ${err.stack || err.message}`);
    exitCode = 1;
  } finally {
    stopServer();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[ui] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
