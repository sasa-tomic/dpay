// node-anvil project globalSetup — spawn the plain-node staging child
// (__tests__/node-anvil/stage-child.mjs) and publish the staged chain env for the workers:
//   DPAY_NODE_ANVIL_RPC     anvil DIRECT (assertions + funding only)
//   DPAY_NODE_ANVIL_PIPE    <relay>/api/v1/evm/rpc/31337 — the pipe the app seam is pointed at
//   DPAY_NODE_ANVIL_TOKEN   the deployed MockZCHF address
//   DPAY_NODE_ANVIL_RELAY   the relay base (catalog reads)
//   DPAY_NODE_ANVIL_CHILD_PID  the detached child's pid — teardown kills the GROUP
// globalSetup and globalTeardown share the jest process, so process.env is the documented data
// channel (the flow project's relay-setup pattern, verbatim). Workers inherit the parent's env.
//
// Env-gated: with DPAY_NODE_ANVIL unset (a bare `npx jest` / `just test-app`) this is a NO-OP —
// the tier must never stage a chain outside `just node-anvil`.
const { spawn } = require('node:child_process');
const { join } = require('node:path');

const CHILD = join(__dirname, '__tests__', 'node-anvil', 'stage-child.mjs');
// relay.mjs ALWAYS runs cargo (warm no-op ~0.5-2.5s; a fresh worktree pays a one-time local-crate
// rebuild — the same tolerance the flow project's setup carries).
const LINE_TIMEOUT_MS = 420_000;

module.exports = async function globalNodeAnvilSetup() {
  if (process.env.DPAY_NODE_ANVIL !== '1') return;
  const child = spawn(process.execPath, [CHILD], {
    detached: true, // own process group — anvil + relay are in it too; group-kill in teardown
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
        `[node-anvil] the staging child printed no config line within ${LINE_TIMEOUT_MS}ms — ` +
        `see the stderr above (cargo build / anvil staging output).`,
      ));
    }, LINE_TIMEOUT_MS);
    child.stdout.on('data', (b) => {
      buf += b.toString();
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl === -1) break;
        const candidate = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed.rpc === 'string' && typeof parsed.pipe === 'string'
            && typeof parsed.token === 'string' && typeof parsed.relay === 'string') {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch { /* progress chatter — keep scanning */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`[node-anvil] staging child exited early (code ${code}) — see stderr above`));
    });
  });

  process.env.DPAY_NODE_ANVIL_RPC = line.rpc;
  process.env.DPAY_NODE_ANVIL_PIPE = line.pipe;
  process.env.DPAY_NODE_ANVIL_TOKEN = line.token;
  process.env.DPAY_NODE_ANVIL_RELAY = line.relay;
  process.env.DPAY_NODE_ANVIL_CHILD_PID = String(pid);
  // eslint-disable-next-line no-console
  console.log(
    `[node-anvil] staged: anvil ${line.rpc} · pipe ${line.pipe} · token ${line.token} (one per run; pid ${pid})`,
  );
};
