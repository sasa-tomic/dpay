// Flow 23 — Onboarding with the DEFAULT username (no name typed → 'me').
//
// A quick positive path: the Onboarding screen defaults an empty username to 'me' (N8's documented
// behavior — `const name = username.trim() || 'me'` in create()). This flow proves a user can onboard
// WITHOUT typing a username and still get a working funded wallet: the wallet mounts and the faucet
// funds ∂100. Kept SHORT — it's a fast gate.
//
// M6 proof: (1) the username input carries `testID="username-input"` (the pre-split audit reported it
// missing); (2) the empty-username default resolves to 'me' — verified DIRECTLY against the stored
// identity (`accountOf`), so the assertion is independent of how the header renders the name (the
// header's hex-pubkey suffix is H4's domain, not M6's). Pins the 'me' default so a future change to
// require a username fails THIS test loudly, forcing a conscious update rather than silent drift.
//
// Selector contract: `username-input` (M6), `btn-create`, `balance`.
import { setup, assert, assertEq, accountOf } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[23-username-default] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // The onboarding screen renders (no identity yet). DO NOT type a username.
    console.log('[23-username-default] waiting for the onboarding screen (no username typed)…');
    // M6 — the username input carries a testID (the pre-split audit reported it missing). Prove it.
    await driver.findByTestID('username-input', { timeoutMs: 8_000 });
    await driver.typeByPlaceholder('e.g. Alice', '', { timeoutMs: 8_000 });

    // Click Create directly — the app defaults the empty name to 'me'.
    console.log('[23-username-default] clicking btn-create (empty username → default "me")…');
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // The wallet mounts + the faucet funds ∂100 (the real relay path, same as flow 01).
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    const funded = await driver.waitForText('∂100.00', { timeoutMs: 12_000 });
    const body = await driver.bodyText();
    assert(funded, `wallet should fund ∂100 with the default username. body excerpt:\n${body.slice(0, 500)}`);

    // M6 — the default 'me' username was persisted to the stored identity. Verified directly (not via
    // the header text) so the assertion holds regardless of how the header renders the name (H4).
    const identity = await accountOf(driver);
    assertEq(identity?.username, 'me', 'the empty-username default should resolve to "me" in the stored identity');
    console.log('[23-username-default] ✓ onboarded with default "me" + funded ∂100.00');

    await driver.screenshot('23-username-default');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[23-username-default] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[23-username-default] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
