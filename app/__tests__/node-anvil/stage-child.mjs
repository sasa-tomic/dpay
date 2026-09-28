#!/usr/bin/env node
// app/__tests__/node-anvil/stage-child.mjs — the plain-node staging child the node-anvil jest
// globalSetup spawns (the flow project's jest-stage-relay-child pattern, EVM tier). Runs DIRECTLY
// under node, never under jest's babel transform, which is exactly why it may import
// e2e/harness/*.mjs (their import.meta.url stays intact) while test code must not.
//
// Stages, ONCE for the whole jest run: a scratch anvil (31337, 1s blocks) + the REAL test-helpers
// dpay-relay with its EVM upstream pointed at that anvil — the e2e/harness/evm/pipe.mjs
// stagePipe, imported verbatim (zero fixture duplication; the DPAY_EVM_RPC_URL /
// DPAY_EVM_RPC_URL_31337 / DPAY_EVM_ANVIL_TOKEN env wiring is set HERE, explicitly, so a
// shell-exported value can never leak in). Prints ONE JSON line with the handoff and holds open.
//
// Teardown is layered, the e2e/harness/procs.mjs discipline:
//   1. the jest globalTeardown SIGTERMs this child's whole process GROUP (the detached spawn put
//      anvil + relay in it too);
//   2. this child's SIGTERM/SIGINT handler runs pipe.stop() (graceful relay + anvil stop);
//   3. a synchronous `exit` backstop SIGKILLs every tracked child pid — no abnormal exit path
//      can orphan a chain (the measured ~9-zombie-relay leak class procs.mjs exists for).
import {stagePipe} from '../../../e2e/harness/evm/pipe.mjs';
import {killTrackedChildren} from '../../../e2e/harness/procs.mjs';

const staged = await stagePipe({recipients: []});
// ONE JSON line — the parent scans for it and ignores everything else (relay.mjs's own progress
// chatter shares this stdout).
process.stdout.write(JSON.stringify({
  rpc: staged.anvil.rpcUrl,
  pipe: `${staged.relay.baseURL}/api/v1/evm/rpc/31337`,
  token: staged.anvil.tokenAddress,
  relay: staged.relay.baseURL,
}) + '\n');
console.log(`[node-anvil] anvil ${staged.anvil.rpcUrl} · token ${staged.anvil.tokenAddress} · pipe ${staged.pipe}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await staged.stop(); } catch { /* the group kill reaches both regardless */ }
  process.exit(0);
};
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { void stop(); });
// The sync last resort: the `exit` event cannot await, so SIGKILL the tracked pids directly.
process.on('exit', () => { killTrackedChildren(); });

// Hold the process (and the staged pair) open until the teardown kills us.
setInterval(() => {}, 60_000);
