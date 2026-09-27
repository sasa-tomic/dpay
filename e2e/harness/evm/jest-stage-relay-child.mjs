#!/usr/bin/env node
// jest-stage-relay-child.mjs — the child process the flow project's jest globalSetup spawns to
// own the test relay for the whole jest run (spec: jest reuses the e2e relay fixture VERBATIM,
// zero duplication). Plain ESM run by node directly (jest never transforms it, and e2e/harness/*'s
// `import.meta.url` stays intact — which is exactly why test code must never import those modules
// itself).
//
// Lifecycle: imports startRelay from e2e/harness/relay.mjs (the SAME spawner `just e2e` uses —
// cargo fingerprinting into the isolated .dev/target-e2e dir, free-port pick, /api/v1/health
// probe, test-helpers feature probe), prints ONE line `{"relayBaseURL": "…"}` on stdout, then
// stays alive as the relay's parent. Teardown is the globalSetup's job: it spawned this child
// detached (own process group), and the relay is our grandchild in that SAME group, so killing
// the group reaches both — no orphaned relay can survive the jest process.
//
// A missing relay binary (fresh worktree) fails with relay.mjs's own actionable error; the parent
// globalSetup relays stderr through, so the failure names the fix instead of hanging.
import { startRelay } from '../relay.mjs';

const relay = await startRelay();
// ONE JSON line — the parent reads exactly one line and ignores everything else (cargo's build
// chatter goes to stderr/our stderr, never this line's parse).
process.stdout.write(JSON.stringify({ relayBaseURL: relay.baseURL }) + '\n');

// Hold the process (and the relay child) open until the teardown kills us. Do NOT ref timers that
// would keep a half-dead state alive: a plain interval, unref'd is WRONG here — the process MUST
// stay alive; the interval itself is just a heartbeat.
setInterval(() => {}, 60_000);

process.on('SIGTERM', async () => {
  try { await relay.stop(); } catch { /* the group kill reaches the relay regardless */ }
  process.exit(0);
});
process.on('SIGINT', async () => {
  try { await relay.stop(); } catch {}
  process.exit(0);
});
