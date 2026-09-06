// Watch mode (Phase 3) — a long-running dev loop that re-runs a SUBSET of flows on every change to
// `app/`, `e2e/`, `crates/dpay-core/src/`, or `crates/dpay-ffi/src/`. Sub-second feedback while
// iterating on a component: save `app/components/PayMode.tsx` → the `pay` journey re-runs in ~5s.
//
// The shared relay+web+browser session PERSISTS across re-runs (only the per-test incognito contexts
// churn) — re-launching the relay+web+browser on every save would defeat the purpose. This works
// because `runTestsSubset({keepSession: true})` skips `stopSession()`; this watcher registers a
// SIGINT/SIGTERM handler that tears the session down once on exit.
//
// Usage:
//   `just e2e-watch`             # watch all dirs; map changed file → journey (or ALL if shared)
//   `just e2e-watch pay`         # pin to the `pay` journey (or any filter token)
//   `DPAY_E2E_WATCH_FILTER=07 node e2e/watch.mjs`   # same, via env
//
// What re-runs on a change:
//   - If a filter is pinned (arg or env), it ALWAYS wins — the changed file is ignored.
//   - Else the changed file is mapped:
//       `e2e/tests/NN-name.mjs`         → just that flow (by id)
//       `app/components/PayMode.tsx`    → the `pay` journey
//       `app/components/DepositSheet.tsx` → the `deposit` journey
//       ... (see FILE_JOURNEY below for the full static table)
//       `e2e/harness/*`, `e2e/web/*`, `crates/**`, or app shared-infra files (App.tsx, styles.ts,
//         services/native.ts, services/relay.ts, lib/types.ts, config/constants.ts, wallet*.ts,
//         cketh.ts, index.js, relayConfig.ts) → ALL flows (these touch every surface).
//       anything else                    → ALL (conservative: rather over-test than miss a regression)
//
// No new deps: Node's `fs.watch({recursive: true})` (Linux/Node 20+; this repo is on Node 24). No
// mocks, no silent errors (a transient fs.watch failure prints + keeps the loop alive).
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTestsSubset } from './run.mjs';
import { loadTestsMeta, filterByToken } from './harness/meta.mjs';
import { stopSession, killTrackedChildren } from './harness/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- configuration ------------------------------------------------------------------------------
//
// Pinned filter: if set, it ALWAYS wins (the changed file is ignored). Read from the first CLI arg
// OR `DPAY_E2E_WATCH_FILTER`. A token matches on journey / id / name / covers slug (same semantics
// as `DPAY_E2E_FILTER` for `just e2e`).
const PINNED_FILTER = process.argv[2] ?? process.env.DPAY_E2E_WATCH_FILTER ?? '';

// Debounce window: aggregate a burst of saves (an editor save often fires rename+change twice; a
// formatter can touch several files at once) into a single re-run.
const DEBOUNCE_MS = 300;

// Dirs to watch (repo-relative). All watched recursively.
const WATCH_DIRS = [
  'app',
  'e2e',
  'crates/dpay-core/src',
  'crates/dpay-ffi/src',
];

// Paths inside `e2e/` to IGNORE (regenerable build output + the screenshots dir + the giant lock
// file). A change here would otherwise re-trigger ALL on every `npm install` or every shot write.
const E2E_IGNORE = ['/node_modules/', '/dist/', '/shots/', '/.browser/', '/package-lock.json'];

// --- file → journey map (the conservative static table) -------------------------------------------------
//
// Only HIGH-CONFIDENCE 1:1 component→journey mappings live here. A file NOT in this table falls
// through to ALL flows (the safe default — rather re-run everything than miss a regression). The
// table is consulted ONLY when no filter is pinned.
//
// Rationale per row lives in the inline comment. Shared-infra files (services/native.ts,
// services/relay.ts, lib/types.ts, config/constants.ts, App.tsx, styles.ts, index.js,
// relayConfig.ts, wallet.ts, walletconnect.ts, cketh.ts) are DELIBERATELY OMITTED → ALL: they are
// imported by every journey, so narrowing the re-run would hide a regression.
const FILE_JOURNEY = [
  // --- app/components/* — direct 1:1 component → the journey that primarily exercises it ---
  ['app/components/PayMode.tsx',            'pay'],       // scan-pay, request-qr, asset-pay, …
  ['app/components/ReceiveMode.tsx',         'pay'],       // request-qr (merchant side) is pay; receive-scan (offline) shares the component
  ['app/components/Ledger.tsx',              'pay'],       // txn history surface, driven by every pay flow
  ['app/components/QrScanner.tsx',           'pay'],       // scan-pay, bad-qr
  ['app/components/Wallet.tsx',              'pay'],       // wallet home — pay is the most active surface (history + scan + request)
  ['app/components/Onboarding.tsx',          'onboard'],   // the onboarding screen
  ['app/components/Logo.tsx',                'onboard'],   // brand mark, only on onboarding
  ['app/components/HomeTab.tsx',            'deposit'],   // the money hub — the accounts list (ex-Balances sheet) every deposit/asset surface reaches
  ['app/components/DepositSheet.tsx',        'deposit'],
  ['app/components/CkErc20DepositSheet.tsx', 'deposit'],
  ['app/components/SettingsSheet.tsx',       'system'],    // settings flow
  ['app/components/Tab.tsx',                 'system'],    // tab nav — keyboard + scan-cleanup + wallet-cleanup
  ['app/components/HotkeyHint.tsx',          'system'],    // keyboard-shortcuts flow
  ['app/components/NfcTap.tsx',              'nfc'],       // nfc-phases + nfc-disclosure
  ['app/components/NfcIcon.tsx',             'nfc'],       // nfc badge
  ['app/components/SendSheet.tsx',           'withdraw'],  // the ONE send-to-address surface (routes to ICRC / legacy-ICP / the chain-key offramp)
  ['app/components/AddressField.tsx',        'withdraw'],  // the shared destination field it owns
  // --- app/* root production modules ---
  ['app/relayConfig.ts',                     'system'],    // relay retarget flow
  // --- app/services/* (native.ts + relay.ts → ALL: shared by every journey) ---
  ['app/services/rail.ts',                    'pay'],       // the ONE build/sign/submit/poll + RailOutcome classification
  ['app/services/addressBook.ts',             'withdraw'],  // saved send destinations (tap-to-reuse)
  ['app/services/ckerc20Persist.ts',          'deposit'],   // ckERC20 watching-resume flow
  // --- app/hooks/* ---
  ['app/hooks/useHotkeys.ts',                'system'],    // keyboard-shortcuts flow
];

/**
 * Resolve which flows to re-run given the list of changed files (repo-relative). Returns the
 * `tests` array (already filtered) plus a human label for the run header.
 *
 * Rules (in order):
 *   1. PINNED_FILTER wins — return its filter result, label is the filter itself.
 *   2. If ANY changed file is "shared infra" → ALL flows (label names the shared file).
 *   3. Each `e2e/tests/NN-name.mjs` → that flow's id; each FILE_JOURNEY match → that journey.
 *      Union all matched tokens; if the union is empty (no recognized file, e.g. the startup run
 *      with no pinned filter) → ALL.
 *
 * "Shared infra" = anything under `e2e/harness/`, `e2e/web/`, `crates/`, OR one of the app shared-
 * infra paths listed in FILE_JOURNEY's header comment, OR `e2e/vite.config.js` / `e2e/package.json`.
 *
 * Returns `{ tests, label, tokens, ranAll }` where `tokens` is the comma-joined filter string the
 * user could pass to `just e2e` for a full-diagnostic one-shot rerun (used in the RED hint).
 */
export async function resolveSubset(changedFiles, allTests) {
  // Rule 1: pinned filter always wins.
  if (PINNED_FILTER) {
    return {
      tests: filterByToken(allTests, PINNED_FILTER),
      label: `filter=${PINNED_FILTER} (pinned)`,
      tokens: PINNED_FILTER,
      ranAll: false,
    };
  }

  // Startup run (no changes yet, no filter) → ALL, with a clean label.
  if (changedFiles.length === 0) {
    return { tests: allTests, label: 'ALL', tokens: '', ranAll: true };
  }

  // Rule 2: any shared-infra change → ALL.
  const sharedInfraGlob = (f) =>
    f.startsWith('e2e/harness/') ||
    f.startsWith('e2e/web/') ||
    f.startsWith('crates/') ||
    f === 'e2e/vite.config.js' ||
    f === 'e2e/package.json' ||
    f === 'app/App.tsx' ||
    f === 'app/index.js' ||
    f === 'app/styles.ts' ||
    f === 'app/relayConfig.ts' ||
    f === 'app/services/native.ts' ||
    f === 'app/services/relay.ts' ||
    f === 'app/lib/types.ts' ||
    f === 'app/config/constants.ts' ||
    f === 'app/wallet.ts' ||
    f === 'app/walletconnect.ts' ||
    f === 'app/cketh.ts';
  const sharedHit = changedFiles.find(sharedInfraGlob);
  if (sharedHit) {
    return { tests: allTests, label: `ALL (shared: ${sharedHit})`, tokens: '', ranAll: true };
  }

  // Rule 3: collect journey + per-flow tokens from each changed file.
  const tokens = new Set();
  const triggers = [];
  for (const f of changedFiles) {
    // `e2e/tests/NN-name.mjs` → flow id `NN`.
    const flowMatch = f.match(/^e2e\/tests\/(\d{2})-/);
    if (flowMatch) {
      tokens.add(flowMatch[1]);
      triggers.push(`${f} → flow ${flowMatch[1]}`);
      continue;
    }
    // Static file→journey table.
    const hit = FILE_JOURNEY.find(([pat]) => f === pat || f.startsWith(pat));
    if (hit) {
      tokens.add(hit[1]);
      triggers.push(`${f} → journey ${hit[1]}`);
      continue;
    }
    // Unknown file → conservative ALL.
    return { tests: allTests, label: `ALL (unmapped: ${f})`, tokens: '', ranAll: true };
  }

  if (tokens.size === 0) {
    return { tests: allTests, label: 'ALL (no token resolved)', tokens: '', ranAll: true };
  }
  const tokenStr = [...tokens].sort().join(',');
  return {
    tests: filterByToken(allTests, tokenStr),
    label: `${tokenStr} — ${triggers.join('; ')}`,
    tokens: tokenStr,
    ranAll: false,
  };
}

// --- the runner ------------------------------------------------------------------------------------------------
//
// State: `running` is true while a subset is executing; `pendingFiles` collects changes that arrive
// mid-run so the next re-run picks up the LATEST batch (no lost triggers, no overlapping runs).
let runCount = 0;
let running = false;
let pendingFiles = null;
let allTests = [];

/**
 * Execute one re-run. Resolves the subset, prints a clear header (so each re-run is glanceable in
 * the scrollback), invokes the shared runner with `keepSession: true` (so the relay+web+browser
 * PERSIST for the next re-run), and prints a RED hint pointing at the full-diagnostic one-shot path.
 *
 * `keepSession: true` is the whole point of watch mode — the ~2.5s relay+web+browser spawn cost is
 * paid ONCE at startup, not on every save. SIGINT/SIGTERM (registered below) tear it down on exit.
 *
 * `triggerFiles` is the list of repo-relative paths that fired this re-run (may be empty for the
 * initial startup run). It's used only for the header label.
 */
async function executeRun(triggerFiles, { isStartup = false } = {}) {
  const { tests, label, tokens, ranAll } = await resolveSubset(triggerFiles, allTests);
  if (tests.length === 0) {
    console.log(`\n=== e2e-watch: no flows matched (label=${label}) — nothing to run ===`);
    return;
  }

  runCount++;
  const n = runCount;
  // Glanceable header — the `===` fence makes each re-run easy to find in scrollback. We do NOT
  // clear the terminal (clearing loses scrollback context; a fence is enough separation). Matches
  // the plan's example: `=== e2e-watch run #N (journey=pay, triggered by app/components/PayMode.tsx) ===`.
  const flowWord = tests.length === 1 ? 'flow' : 'flows';
  const header = isStartup
    ? `=== e2e-watch run #${n} (${label}) startup — ${tests.length} ${flowWord} ===`
    : `=== e2e-watch run #${n} (${label}), triggered by ${triggerFiles.join(', ')} — ${tests.length} ${flowWord} ===`;
  console.log(header);

  try {
    const { passed, total, elapsed, firstFailure } = await runTestsSubset(tests, { keepSession: true });
    if (firstFailure) {
      // RED: surface the first failure key + point at the full-diagnostic one-shot path. Phase 2's
      // diagnostics dump (when it lands) will be produced automatically by runOne — the watcher
      // inherits it for free because it goes through the same run path.
      const rerunFilter = tokens || '';
      const rerunHint = rerunFilter
        ? `DPAY_E2E_FILTER=${rerunFilter} just e2e`
        : 'just e2e';
      console.error(
        `\n[watch] RED — first failure: ${firstFailure.key}` +
        `\n[watch] for full diagnostics: \`${rerunHint}\`` +
        `\n[watch] (continuing to watch — save any file to re-run)`,
      );
    } else if (!isStartup) {
      console.log(`[watch] GREEN — ${passed}/${total} in ${elapsed}s (session persists; save to re-run)`);
    }
  } catch (e) {
    // No silent errors: a transient runner failure (e.g. the shared relay crashed mid-run) prints
    // + keeps the loop alive. The next save attempt re-uses the session; if it's wedged, the next
    // run will re-fail visibly + the operator can Ctrl-C + restart.
    console.error(`\n[watch] run #${n} threw (NOT fatal — continuing to watch): ${e.stack || e.message}`);
  }
}

/**
 * Trigger a re-run for the given changed files. If a run is already in flight, stash the files as
 * `pending` — when the current run finishes, `maybeDrainPending` kicks off another run with the
 * LATEST batch (so a rapid burst of saves collapses to one re-run, not N).
 *
 * `isStartup` flags the establishing run (so the header reads "startup" instead of "triggered by
 * <files>"). It does NOT change which flows run.
 */
async function triggerRun(changedFiles, opts = {}) {
  if (running) {
    pendingFiles = pendingFiles ? [...new Set([...pendingFiles, ...changedFiles])] : changedFiles;
    return;
  }
  running = true;
  try {
    await executeRun(changedFiles, opts);
  } finally {
    running = false;
    // Drain: if more changes arrived mid-run, kick off another re-run with the union batch.
    if (pendingFiles) {
      const next = pendingFiles;
      pendingFiles = null;
      void triggerRun(next);
    }
  }
}

// --- file watching ----------------------------------------------------------------------------------------------
//
// Node's `fs.watch({recursive: true})` is supported on Linux since Node 20 (this repo is on Node
// 24). If a future host doesn't support it, the watcher logs + exits (the operator falls back to
// `just e2e` per-save). No new dep (chokidar) is pulled in for this.
/**
 * Translate a watcher event into a repo-relative path, then enqueue it (debounced). Returns the
 * repo-relative path if it's a path we care about, else null (e.g. e2e/dist, e2e/node_modules).
 */
function classifyChange(watchDirRel, filename) {
  if (!filename) return null; // some platforms emit filename=null on rename bursts
  // filename is relative to the watched dir; reconstruct the repo-relative path.
  const repoRel = `${watchDirRel}/${filename.split('\\').join('/')}`;
  // Filter: ignore regenerable e2e artifacts (node_modules, dist, shots, .browser, lock file).
  if (E2E_IGNORE.some((p) => repoRel.includes(p))) return null;
  // Ignore our own re-run screenshot writes (e2e/shots/* is already filtered, but be explicit).
  return repoRel;
}

let debounceTimer = null;
let debouncedBatch = new Set();

/**
 * Add a changed file to the debounce batch. After DEBOUNCE_MS of quiescence, fire `triggerRun` with
 * the full batch. Aggregates a burst of saves (rename+change from one editor save, or a formatter
 * touching several files) into a single re-run.
 */
function enqueueChange(repoRel) {
  debouncedBatch.add(repoRel);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const files = [...debouncedBatch].sort();
    debouncedBatch = new Set();
    debounceTimer = null;
    // No silent errors: a failure inside triggerRun must NOT kill the watcher.
    void triggerRun(files).catch((e) => {
      console.error(`[watch] triggerRun failed (NOT fatal — continuing): ${e.stack || e.message}`);
    });
  }, DEBOUNCE_MS);
}

/**
 * Start one recursive watcher on `watchDirRel`. Returns the FSWatcher (so the caller can attach an
 * error handler). On a watcher error (e.g. the dir was deleted), print + keep going (the other
 * watchers stay live; the operator can restart if needed).
 */
function startWatcher(watchDirRel) {
  const abs = join(REPO_ROOT, watchDirRel);
  let watcher;
  try {
    watcher = watch(abs, { recursive: true, persistent: false }, (eventType, filename) => {
      if (process.env.DPAY_E2E_WATCH_DEBUG) {
        console.error(`[watch:debug] raw event dir=${watchDirRel} type=${eventType} file=${filename}`);
      }
      const repoRel = classifyChange(watchDirRel, filename);
      if (repoRel) enqueueChange(repoRel);
    });
  } catch (e) {
    // recursive:true unsupported on this platform → log + return null (don't crash the loop).
    console.error(`[watch] could not start recursive watcher on ${watchDirRel}: ${e.message}`);
    return null;
  }
  if (watcher) {
    watcher.on('error', (e) => {
      // No silent errors: print + keep the other watchers alive.
      console.error(`[watch] watcher on ${watchDirRel} errored (NOT fatal — continuing): ${e.message}`);
    });
  }
  return watcher;
}

// --- exit handling ----------------------------------------------------------------------------------------------
//
// Tear down the shared session ONCE on exit. SIGINT (Ctrl-C), SIGTERM, and SIGHUP all route here. We
// guard against double-teardown with a `tearingDown` flag; a SECOND signal exits IMMEDIATELY (the
// operator's "I asked twice, just die" escape — don't make them wait on the first drain or reach for
// `kill -9`, which would itself orphan the children).
//
// Three robustness measures:
//   1. The "tearing down" message is written to STDERR synchronously (Node can cut off buffered
//      stdout on `process.exit`; stderr is line-buffered and flushes reliably to piped logs).
//   2. A REF'd 3s force-exit timer guarantees the process exits even if `stopSession` stalls on a
//      wedged child — the operator never gets a hung watcher they have to `kill -9`.
//   3. `process.on('exit', killTrackedChildren)` — a SYNC last-resort SIGKILL of every tracked child
//      PID (relay + web server — see harness/procs.mjs). The `exit` event cannot await, so this is
//      the ONLY layer that fires on a path that bypasses the async teardown (e.g. an
//      uncaughtException that routes straight to `process.exit`). It is a no-op on a graceful stop
//      (children already dead → ESRCH swallowed) and the structural guarantee no tracked child can
//      outlive the watcher. uncaughtException + unhandledRejection are also routed here (logged first)
//      so a bug in the watcher itself can't orphan the session either.
let tearingDown = false;
function teardownAndExit(code) {
  if (tearingDown) process.exit(code); // second signal → immediate exit
  tearingDown = true;
  process.stderr.write('\n[watch] tearing down shared session (relay + web + browser)…\n');
  // Force-exit fallback: if stopSession stalls (a child that won't die), exit hard after 3s so the
  // operator never has to SIGKILL (which would leak the children). REF'd so it actually fires.
  const force = setTimeout(() => {
    process.stderr.write('[watch] force-exit after 3s (a child may not have torn down cleanly)\n');
    process.exit(code);
  }, 3000);
  stopSession()
    .catch((e) => process.stderr.write(`[watch] teardown error (continuing to exit): ${e.message}\n`))
    .finally(() => {
      clearTimeout(force);
      process.exit(code);
    });
}
process.on('SIGINT', () => teardownAndExit(0));
process.on('SIGTERM', () => teardownAndExit(0));
process.on('SIGHUP', () => teardownAndExit(0));
process.on('uncaughtException', (e) => {
  process.stderr.write(`[watch] uncaughtException: ${e instanceof Error ? e.stack || e.message : e}\n`);
  teardownAndExit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[watch] unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : reason}\n`);
  teardownAndExit(1);
});
// SYNC last-resort: SIGKILL any tracked child still alive when the process exits. No-op on a graceful
// stop (children already dead); the guarantee on every abnormal path. See harness/procs.mjs. Wrapped
// in an arrow so the `exit` event's exit-CODE arg isn't fed to killTrackedChildren's `signal` param
// (which would make it an invalid signal → silently no-op → orphan).
process.on('exit', () => killTrackedChildren());

// --- main loop --------------------------------------------------------------------------------------------------
/**
 * Startup: load the test metadata once (so resolveSubset is synchronous-fast on each change), start
 * the watchers, and run the initial establishing pass (the pinned filter if set, else ALL — to
 * confirm GREEN before the operator starts iterating). Then wait for file events forever.
 */
async function main() {
  console.log('[watch] loading test catalog…');
  allTests = await loadTestsMeta();
  console.log(`[watch] ${allTests.length} flows discovered`);

  const pinNote = PINNED_FILTER ? `pinned filter: "${PINNED_FILTER}"` : 'no pinned filter (map changed file → journey)';
  console.log(`[watch] ${pinNote}`);

  // Start the watchers (one per top-level dir).
  const liveWatchers = WATCH_DIRS.map(startWatcher).filter(Boolean);
  if (liveWatchers.length === 0) {
    console.error('[watch] FATAL: no watchers could be started — nothing to watch. Falling back to `just e2e`.');
    process.exit(1);
  }
  console.log(`[watch] watching ${liveWatchers.length} dir(s): ${WATCH_DIRS.join(', ')} (recursive)`);
  console.log('[watch] Ctrl-C to stop.\n');

  // Initial establishing run: the pinned filter if set, else ALL (no trigger files → resolveSubset
  // returns ALL when PINNED_FILTER is empty AND changedFiles is empty — see the "no token resolved"
  // branch). This proves GREEN before the operator starts iterating.
  await triggerRun([], { isStartup: true });
}

// Only auto-start when run directly (`node watch.mjs`). When imported (e.g. by a test of
// resolveSubset), main() does NOT fire — same guard pattern the test files use.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[watch] FATAL: ${e.stack || e.message}`);
    process.exit(1);
  });
}
