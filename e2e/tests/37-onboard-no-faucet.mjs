// Flow 37 — Onboarding-time faucet failure: onboard against a DEAD relay → wallet created with $0
// AND an honest offline indicator (no fake funding, no crash, no stall).
//
// Onboarding's `create()` (Onboarding.tsx) generates the on-device keypair + persists the identity,
// then fires a BEST-EFFORT faucet POST bounded by a 4s timeout. If the relay is unreachable the
// faucet throw is CAUGHT and SURFACED: instead of silently transitioning to the wallet at $0, the
// app shows an honest "starter funds couldn't be added" message + a "Continue" button so the user
// explicitly proceeds knowing starter funds weren't added (then the wallet mounts). This flow proves
// that contract end-to-end against the REAL failure mode (ECONNREFUSED to a genuinely-closed port,
// not Chrome's ERR_UNSAFE_PORT artifact):
//   - the wallet IS created (identity persisted, header username renders, balance element mounts);
//   - the faucet request fails for the RIGHT reason (a connection refusal);
//   - the header NEVER shows ∂100.00 (the funded happy path) — it shows the honest offline state
//     ("~ approx." label + "—" amount, because the balance poll also can't reach the dead relay);
//   - the account genuinely holds $0 on the real ledger (it was never funded anywhere).
//
// The dead relay is the REAL "relay unreachable" failure mode: the harness grabs a free TCP port
// (binds :0 → closes) so nothing listens → connect yields ECONNREFUSED (mirrors flow 13's approach).
//
// Selector contract: `balance` (header balance Pressable), `header-who` (username), the offline
// label "~ approx." (Wallet.tsx renders it when `online === false`).
import { setup, assert, pickFreePort, getBalance, accountOf } from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '37',
  name: 'onboard-no-faucet',
  journey: 'onboard',
  covers: ['onboard', 'faucet-failure', 'offline', 'dead-relay', 'right-reason', 'zero-balance'],
  verifies: 'Onboard against a dead relay → faucet failure surfaces an honest "Continue" prompt (not a silent $0 transition), wallet created with $0 (∂100 never shown), honest "~ approx." offline indicator, faucet fails with ECONNREFUSED.',
  timeoutMs: 20000,
};

export async function run() {
  const start = Date.now();
  console.log('[37-onboard-no-faucet] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, webBaseURL, relayBaseURL } = env;

    // A genuinely-dead relay: a port nothing listens on (bind :0 → close → freed). A connect is
    // refused (ECONNREFUSED), not unsafe-port-blocked — the real "relay unreachable" failure mode.
    const deadPort = await pickFreePort();
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;
    driver.allowRequestFailuresFrom(DEAD_RELAY);

    // Load the app against the DEAD relay from the start (the `?relay=` query is read at module load
    // → Onboarding's create() will POST the faucet to the dead relay). setup() first navigated to the
    // good relay; re-navigate now so onboarding is primed with the dead URL before we tap Create.
    console.log(`[37-onboard-no-faucet] loading the app against the dead relay (${DEAD_RELAY})…`);
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(DEAD_RELAY)}`, { timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // Capture the underlying request failures so we can prove the faucet failed for the RIGHT reason.
    const failures = driver.recordRequestFailures();

    // Onboard: type a username + tap Create. create() fires the best-effort faucet (which must fail).
    console.log('[37-onboard-no-faucet] onboarding (faucet will fail)…');
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-nofaucet', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // The faucet fails (dead relay) → create() sets pendingId + shows the honest "Continue" prompt
    // instead of auto-transitioning. Tap Continue to proceed to the wallet at $0.
    await driver.findByTestID('onboard-faucet-failed', { timeoutMs: 10_000 });
    await driver.click('btn-onboard-continue', { timeoutMs: 4_000 });

    // The wallet MOUNTS after the explicit Continue (onCreated(pendingId) fires).
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    const who = await driver.readText('header-who');
    assert(who === 'e2e-nofaucet', `wallet header should show the username after onboarding, got "${who}"`);
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string' && identity.publicHex.length === 64,
      `wallet identity must be persisted (32-byte hex pubkey), got ${JSON.stringify(identity?.publicHex)}`);
    console.log(`[37-onboard-no-faucet] ✓ wallet created + identity persisted (${identity.publicHex.slice(0, 16)}…)`);

    // ∂100.00 (the faucet-funded happy path) must NEVER appear — the faucet failed.
    // Give the (failing) balance poll a moment, then assert the funded amount is absent.
    await driver.waitForText('∂100.00', { timeoutMs: 1_500 }).catch(() => {}); // returns false (expected); bounded wait
    const body = await driver.bodyText();
    assert(!body.includes('∂100.00'),
      `wallet must NOT show the faucet-funded ∂100.00 against a dead relay. body excerpt:\n${body.slice(0, 500)}`);

    // The HONEST offline indicator: the balance poll can't reach the dead relay → online=false → the
    // header label reads "~ approx." (Wallet.tsx). This is the app's honest "I can't confirm a
    // balance" signal — NOT a fabricated ∂0.00 and NOT a crash.
    const approx = await driver.waitForText('approx.', { timeoutMs: 6_000 });
    assert(approx,
      `wallet should show the honest "~ approx." offline indicator (balance poll unreachable). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[37-onboard-no-faucet] ✓ no ∂100.00 + honest "~ approx." offline indicator (no fake funding)');

    // The account genuinely holds $0 on the REAL ledger: the faucet POST went to the dead relay and
    // failed, so this account was never funded anywhere. Querying the shared FakeLedger confirms $0.
    const ledgerBal = await getBalance(relayBaseURL, identity.publicHex, 0);
    assert(ledgerBal === '0', `the unfunded account should read $0 on the ledger, got ${ledgerBal}`);
    console.log('[37-onboard-no-faucet] ✓ ledger confirms $0 (account never funded)');

    // RIGHT-REASON gate: the onboarding faucet POST must have failed with a CONNECTION error
    // (refused), not an unsafe-port artifact (which would let this pass for the wrong reason).
    const faucetFails = failures().filter((f) => f.url.includes('/api/v1/faucet'));
    assert(faucetFails.length > 0,
      `the onboarding faucet POST to the dead relay must have failed (got ${failures().length} failed reqs)`);
    const errText = faucetFails[0].errorText;
    assert(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(errText),
      `dead-relay faucet should fail with a connection error, got "${errText}"`);
    assert(!/UNSAFE_PORT/i.test(errText),
      `dead relay must NOT be an unsafe-port artifact (wrong failure mode), got "${errText}"`);
    console.log(`[37-onboard-no-faucet] ✓ faucet failed for the right reason: ${errText}`);

    await driver.screenshot('37-onboard-no-faucet');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[37-onboard-no-faucet] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[37-onboard-no-faucet] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
