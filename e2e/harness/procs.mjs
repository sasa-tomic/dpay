// Process registry — tracks the PIDs of child processes the e2e harness spawns (the relay binary +
// the sirv web server) so that a SYNC last-resort SIGKILL can reach them from a `process.on('exit')`
// handler when the normal async teardown (stopSession) can't run to completion.
//
// THE LEAK THIS PREVENTS: the shared relay + web server are long-lived children whose graceful
// teardown is the ASYNC `stopSession()` (SIGTERM → SIGKILL after 2s). But an abnormal exit — Ctrl-C
// (SIGINT), SIGTERM, SIGHUP, an uncaughtException, or an unhandledRejection — can kill Node BEFORE
// that async drain completes, orphaning the children. Over many sessions ~9 zombie relays accumulated
// this way and starved the host (load avg 55 on 16 cores → flaky e2e). The `exit`-handler SIGKILL
// below is the only layer that can fire on a sync-exit path (the `exit` event cannot await), which is
// what makes orphaning structurally impossible: no tracked child can outlive the harness process.
//
// WHY A DEDICATED MODULE: relay.mjs and web.mjs are LEAVES in the harness import graph (lib.mjs
// imports them; they import nothing harness-internal). Putting the registry here lets both spawners
// register their child PIDs without creating a circular import (lib.mjs ↔ relay/web). run.mjs +
// watch.mjs reach the sync kill via lib.mjs's re-export. cargo/vite BUILD children are short-lived
// and always awaited, so they never outlive their parent and need no tracking. The browser IS
// tracked here too (driver.mjs registers it at launch): chrome-headless-shell demonstrably does
// NOT self-exit on a broken pipe / Node death — 2026-09-27 incident: ~30 leaked shells at 50-70%
// CPU each, load 16+ — so it rides the same sync-exit backstop as every other child.

const _childPids = new Set();

/**
 * Register a spawned child PID so the sync `exit` handler can SIGKILL it as a last resort. Called by
 * relay.mjs/web.mjs at SPAWN time — the instant the child is born, before any health checks — so the
 * PID is tracked even if the child crashes during startup or a signal arrives mid-build (the window
 * where `_session` is still null and `stopSession` would be a no-op).
 */
export function trackChild(pid) {
  if (Number.isInteger(pid) && pid > 0) _childPids.add(pid);
}

/**
 * Drop a PID from the registry. Called when the child exits cleanly (normal teardown), so the set
 * doesn't accumulate dead PIDs (and we never signal a PID that may have been recycled by the OS for
 * an unrelated process). Not strictly required — killTrackedChildren swallows ESRCH for already-dead
 * PIDs — but keeps the set tidy and bounds the risk of PID reuse surfacing as a stray signal.
 */
export function untrackChild(pid) {
  _childPids.delete(pid);
}

/**
 * Synchronously signal every tracked child PID. Used as the `process.on('exit')` last resort: the
 * `exit` event is synchronous (no `await` possible), so we send the signal directly via
 * `process.kill`. A child that already exited is a no-op (`process.kill` throws ESRCH → swallowed).
 * Clears the set afterward so a re-entry doesn't re-signal a recycled PID.
 *
 * Default signal is SIGKILL — this is the FINAL fallback after the async teardown (stopSession) has
 * already had its chance (SIGTERM + 2s grace per child). By the time the `exit` event fires, graceful
 * shutdown is no longer an option; only "ensure the child is dead" remains.
 */
export function killTrackedChildren(signal = 'SIGKILL') {
  for (const pid of _childPids) {
    try { process.kill(pid, signal); } catch { /* ESRCH: already dead — expected on the happy path */ }
  }
  _childPids.clear();
}
