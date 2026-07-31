// Flow 23 — Onboarding with the DEFAULT username (no name typed → 'me').
//
// A quick positive path: the Onboarding screen defaults an empty username to 'me' (N8's documented
// behavior — `const name = username.trim() || 'me'` in create()). This flow proves a user can onboard
// WITHOUT typing a username and still get a working funded wallet: the wallet mounts, the header
// shows the default 'me' identity, and the faucet funds $100. Kept SHORT — it's a fast gate.
//
// Pins the current behavior (default 'me') so a future change to require a username (the N8 fix)
// fails THIS test loudly, forcing a conscious update rather than a silent behavior drift.
//
// Selector contract: `btn-create`, `balance`.
import { setup, assert, assertIncludes } from '../harness/lib.mjs';

export async function run() {
  const start = Date.now();
  console.log('[23-username-default] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // The onboarding screen renders (no identity yet). DO NOT type a username.
    console.log('[23-username-default] waiting for the onboarding screen (no username typed)…');
    await driver.typeByPlaceholder('e.g. Alice', '', { timeoutMs: 8_000 });

    // Click Create directly — the app defaults the empty name to 'me'.
    console.log('[23-username-default] clicking btn-create (empty username → default "me")…');
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // The wallet mounts + the faucet funds $100 (the real relay path, same as flow 01).
    await driver.findByTestID('balance', { timeoutMs: 10_000 });
    const funded = await driver.waitForText('$100.00', { timeoutMs: 12_000 });
    const body = await driver.bodyText();
    assert(funded, `wallet should fund $100 with the default username. body excerpt:\n${body.slice(0, 500)}`);

    // The header shows the default 'me' identity (username + short pubkey).
    assertIncludes(body, 'me ·', 'the wallet header should show the default username "me"');
    console.log('[23-username-default] ✓ onboarded with default "me" + funded $100.00');

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
