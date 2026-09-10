// Flow 165 — R2: the Solana rail THROUGH the relay proxy — the real client↔relay wire, offline.
//
// Spec docs/specs/2026-09-09-relay-ha-and-solana-proxy.md §"Direction 1": every Solana RPC
// (read and broadcast) goes `${relayBase}/api/v1/solana/rpc` — the provider key lives in the
// relay's environment, never in the app bundle. This flow drives that path END TO END against
// the harness relay, which `harness/relay.mjs` points at its OWN test-helpers JSON-RPC stub
// (`DPAY_SOLANA_RPC_URL` is constructed explicitly there — never inherited — and the stub
// route + its `/hits` counter live behind the `test-helpers` feature in crates/dpay-relay):
//
//   app → POST {relay}/api/v1/solana/rpc → (proxy) → POST {relay}/api/v1/test/solana-upstream
//
// The suite default disables the SOL rail (`__DPAY_TEST_SOLANA_RPC_URL=''`), and the in-page
// stub seam (`solStub`) answers BEFORE fetch — neither exercises the wire. This flow boots
// with `setup({solRpcUrl: 'relay'})`, which DELETES the override instead of pinning a URL:
// `constants.ts` then derives the candidate list from the App-installed relay bases — the
// exact production path, App.tsx wiring included (the mutator that keeps the SOL derivation
// in the same tick as the relay list install; jest pins its shape in
// app/__tests__/solana-rpc-config.test.ts, this flow pins it over real HTTP).
//
//   1. WIRE: boot with `?relay=<harness relay>`, onboard, and assert the SOL and USDC balance
//      rows render the stub's positional `getMultipleAccounts` answers (2 SOL / 3 USDC) —
//      numbers that can only have arrived through the proxy — and that the stub's hit counter
//      is non-zero (the request really reached an UPSTREAM through the relay, not a page stub).
//
//   2. WALK: re-point the relay list mid-session to [dead, harness relay] via the Settings
//      editor (flow-164 mechanics). The SOL derivation follows the list: its first candidate
//      is now the DEAD relay's proxy route — a transport failure the walk must skip — and the
//      balance row must still read 2 SOL from the live second home, with connection-refused
//      failures on record against the dead origin's `/api/v1/solana/rpc` (proof the dead SOL
//      home was TRIED, not silently skipped).
//
// Selector contract: `btn-settings`, `btn-advanced-toggle`, `settings-relay` (multiline list
// editor), `btn-relay-apply`, `btn-settings-close`, `asset-sol`, `asset-sol-usdc`.
import {
  setup, assert, assertIncludes,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent,
  waitForEnabled, WALLET_READY, onboardWallet,
} from '../harness/lib.mjs';
import {pickFreePort} from '../harness/relay.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test
  * timeout) and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source
  * of truth for id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '165',
  name: 'solana-via-relay',
  journey: 'system',
  covers: ['solana-rpc-proxy', 'solana-relay-derivation', 'solana-walk-transport', 'relay-solana-wire'],
  verifies: 'R2 Solana-through-relay: SOL/USDC balances render from the harness relay\'s proxy (stub upstream hit recorded) with the candidate list DERIVED from the App-installed relay list, and a mid-session re-point to a dead-first list still serves SOL from the second home after a recorded transport failure at the dead one\'s proxy route.',
  timeoutMs: 90000,
};

/** Onboard WITHOUT the funded-wallet contract: the faucet-funded ∂100.00 wait is the IC
  * rail's business; this flow's subject is the SOL rail, whose stub answers from the moment
  * the relay is up. Same shape as flow 164's onboardUnfunded. */
async function onboardUnfunded(driver, name) {
  await skipWalkthroughIfPresent(driver);
  await driver.typeByPlaceholder('e.g. Alice', name, {timeoutMs: 8_000});
  await driver.click('btn-create', {timeoutMs: 4_000});
  await driver.findByTestID('mnemonic-backup', {timeoutMs: 8_000});
  await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
  await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
  await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
  await skipPracticeIfPresent(driver);
  await chooseHomeCurrencyIfPresent(driver);
  await driver.findByTestID(WALLET_READY, {timeoutMs: 10_000});
}

/** The stub upstream's envelope counter (the relay's `/hits` test route). */
async function stubHits(relayBaseURL) {
  const r = await fetch(`${relayBaseURL}/api/v1/test/solana-upstream/hits`);
  assert(r.ok, `the relay's solana-stub hits route must answer (got ${r.status})`);
  const body = await r.json();
  return Number(body.hits);
}

export async function run() {
  const start = Date.now();
  console.log('[165-solana-via-relay] setup (solRpcUrl: relay — the derived, production path)…');
  const env = await setup({solRpcUrl: 'relay'});
  // A free port that NOTHING will ever bind: the dead relay for phase 2. Real address shape,
  // refused connections — the exact "transport failure" leg of the walk rule (flow 164's trick).
  const deadPort = await pickFreePort();
  const deadOrigin = `http://127.0.0.1:${deadPort}`;
  try {
    const { driver, relayBaseURL } = env;
    const failures = driver.recordRequestFailures();
    // Phase 2 will aim both rails' polls at the dead origin — expected, allowed.
    driver.allowRequestFailuresFrom(deadOrigin);

    // ── Phase 1: the wire — balances arrive through the relay's proxy, derivationally ───────
    // setup() already navigated `?relay=<harness relay>`: the App installs that list, the SOL
    // candidate list derives from it (no test override — 'relay' mode deleted it), and every
    // RPC the rail issues must land on {relay}/api/v1/solana/rpc.
    console.log('[165-solana-via-relay] phase 1: onboard, assert SOL+USDC render through the proxy…');
    await onboardUnfunded(driver, 'e2e-sol-relay');

    // The stub's positional getMultipleAccounts answers: wallet → 2 SOL, registered token
    // accounts → 3.000000 raw at 6 decimals (3 USDC). These strings can ONLY come from the
    // stub upstream THROUGH the relay's proxy — no page stub is installed, no provider exists.
    await driver.waitForText('2 SOL', {timeoutMs: 15_000});
    await driver.waitForText('3 USDC', {timeoutMs: 15_000});
    console.log('[165-solana-via-relay] ✓ SOL and USDC rows render from the stub upstream');

    // …and the upstream really was reached THROUGH the proxy: the stub's envelope counter is
    // non-zero (it only increments when the relay's proxy forwards a request to it).
    const hits = await stubHits(relayBaseURL);
    assert(hits > 0, `the stub upstream must have been hit through the proxy (hits=${hits})`);
    console.log(`[165-solana-via-relay] ✓ stub upstream served ${hits} envelope(s) through the proxy route`);

    // ── Phase 2: the walk — a dead FIRST relay home is skipped, SOL survives from the second ──
    console.log(`[165-solana-via-relay] phase 2: relay list → [${deadOrigin}, ${relayBaseURL}] (dead first)…`);
    await driver.click('btn-settings', {timeoutMs: 6_000});
    await driver.click('btn-advanced-toggle', {timeoutMs: 4_000});
    await driver.type('settings-relay', `${deadOrigin}\n${relayBaseURL}`, {timeoutMs: 4_000});
    await driver.click('btn-relay-apply', {timeoutMs: 4_000});
    await driver.click('btn-settings-close', {timeoutMs: 4_000});

    // The SOL derivation follows the SAME re-point (App.tsx installs the list and the SOL
    // bases in one tick): its walk now tries the DEAD home first — transport refusal → next —
    // and the live relay's proxy must keep the row at exactly 2 SOL. A walk that stopped at
    // the dead home would render the unreadable/— state; a derivation that DIDN'T follow the
    // list would keep using the (still-live) old base and this assert would prove nothing —
    // which is why the dead-home failures below are part of the pin.
    await driver.waitForText('2 SOL', {timeoutMs: 20_000});
    console.log('[165-solana-via-relay] ✓ SOL row still serves 2 SOL from the second home after the re-point');

    // …and the dead SOL home was really TRIED (not silently skipped): connection-refused
    // failures on record against the dead origin's PROXY ROUTE — the request shape only the
    // derived candidate list produces. Reason-audit as flow 164 (CONNECTION/REFUSED, never
    // UNSAFE_PORT).
    const deadSolFails = failures().filter((f) => f.url.startsWith(`${deadOrigin}/api/v1/solana/rpc`));
    assert(deadSolFails.length > 0, `the dead relay's proxy route must have been tried (no failed requests to ${deadOrigin}/api/v1/solana/rpc)`);
    for (const f of deadSolFails) {
      assert(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(f.errorText), `dead-home SOL failures must be connection errors, got "${f.errorText}"`);
      assert(!/UNSAFE_PORT/i.test(f.errorText), `dead-home SOL failures must not be UNSAFE_PORT artifacts, got "${f.errorText}"`);
    }
    console.log(`[165-solana-via-relay] ✓ ${deadSolFails.length} connection-refused request(s) to the dead home's proxy route on record`);

    await driver.screenshot('165-solana-via-relay');
    console.log(`[165-solana-via-relay] PASS (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } finally {
    await env.stop();
  }
}

// Standalone runner (`node e2e/tests/165-solana-via-relay.mjs`) — mirrors every flow file.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[165-solana-via-relay] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[165-solana-via-relay] FAILED:', e);
    process.exit(1);
  });
}
