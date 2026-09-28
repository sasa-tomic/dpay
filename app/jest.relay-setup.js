// Flow-project globalSetup — spawn the REAL test-helpers dpay-relay ONCE for the whole jest run.
// The relay is the same binary `just e2e` drives (spawner: e2e/harness/relay.mjs, imported
// verbatim by the detached child e2e/harness/evm/jest-stage-relay-child.mjs — zero fixture
// duplication). This file only: spawn the child, read its ONE `{relayBaseURL}` line, publish
//   DPAY_JEST_RELAY_URL         (the app's fetch rewrite target; flow/harness/setupFlow.ts)
//   DPAY_JEST_RELAY_CHILD_PID   (the detached child's pid — globalTeardown kills the GROUP)
// via process.env (globalSetup and globalTeardown share the jest process, so this is the
// documented data channel between them; workers inherit the parent's env).
//
// Concurrency contract (ported from e2e/run.mjs's argument, do not re-litigate): ONE relay for
// the whole run is safe — the shared FakeLedger is mutex-serialized and flow tests use distinct
// random identities, so there is no cross-test account state to collide.
//
// The child is spawned DETACHED so it (and the relay) form their own process group: teardown can
// SIGTERM the whole group and cannot be defeated by jest's own exit path. genSetup keeps a
// synchronous exit-handler backstop too (same doctrine as e2e/harness/procs.mjs: an interrupted
// run must never orphan a relay).
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

const CHILD = join(__dirname, '..', 'e2e', 'harness', 'evm', 'jest-stage-relay-child.mjs');
// Generous on purpose: relay.mjs ALWAYS runs cargo (warm no-op ~0.5-2.5s; a fresh worktree pays a
// one-time local-crate rebuild measured at ~70s on this machine). The 10s budget in the spec is
// the /api/v1/health probe INSIDE relay.mjs (READY_TIMEOUT_MS) — not this wait.
const LINE_TIMEOUT_MS = 420_000;

module.exports = async function globalRelaySetup() {
  if (!existsSync(CHILD)) {
    throw new Error(`[jest-relay] relay staging child missing: ${CHILD}`);
  }
  const child = spawn(process.execPath, [CHILD], {
    detached: true, // own process group — the relay grandchild is in it too; group-kill in teardown
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pid = child.pid;

  const killGroup = (signal) => {
    try { process.kill(-pid, signal); } catch { /* already gone */ }
    try { child.kill(signal); } catch {}
  };
  // Backstop: if jest itself dies between setup and teardown, do not orphan the group.
  process.on('exit', () => { try { process.kill(-pid, 'SIGKILL'); } catch {} });

  const line = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      killGroup('SIGKILL');
      reject(new Error(
        `[jest-relay] the relay child printed no {relayBaseURL} line within ${LINE_TIMEOUT_MS}ms — ` +
        `see the stderr above (cargo build / health probe output).`,
      ));
    }, LINE_TIMEOUT_MS);
    child.stdout.on('data', (b) => {
      buf += b.toString();
      // relay.mjs logs its own progress on stdout too — scan every line for THE one JSON line.
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const candidate = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed.relayBaseURL === 'string') {
            clearTimeout(timer);
            resolve(candidate);
            return;
          }
        } catch { /* progress chatter — keep scanning */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`[jest-relay] relay child exited early (code ${code}) — see stderr above`));
    });
  });

  const parsed = JSON.parse(line);
  if (!parsed || typeof parsed.relayBaseURL !== 'string' || !parsed.relayBaseURL.startsWith('http')) {
    killGroup('SIGKILL');
    throw new Error(`[jest-relay] bad relay line: ${line.slice(0, 200)}`);
  }
  process.env.DPAY_JEST_RELAY_URL = parsed.relayBaseURL;
  process.env.DPAY_JEST_RELAY_CHILD_PID = String(pid);
  // eslint-disable-next-line no-console
  console.log(`[jest-relay] test relay up at ${parsed.relayBaseURL} (one per run; pid ${pid})`);
};
