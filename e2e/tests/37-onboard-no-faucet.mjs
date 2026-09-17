// Flow 37 — Onboarding against a DEAD relay: wallet creation never asks for or promises funding,
// still reaches the wallet with $0, and shows an honest offline indicator.
//
// Onboarding's `create()` (Onboarding.tsx) generates the on-device keypair + parks it as pending,
// then discovers relay capabilities. If the relay is unreachable, capabilities fail closed and no
// speculative faucet POST is made. This flow proves that contract end-to-end:
//   - the wallet IS created (identity persisted, header username renders, balance element mounts);
//   - capability discovery DID reach the dead relay and failed for the RIGHT reason (a connection
//     refusal) — the gate that separates "asked and was refused" from "never asked because the page
//     never loaded", which is the only thing that makes the no-faucet assertion below mean anything;
//   - NO faucet request is made at all;
//   - the header NEVER shows ∂100.00 (the funded happy path) — it shows the honest offline state
//     ("~ … approx." label + "—" amount, because the balance poll also can't reach the dead relay);
//   - the account genuinely holds $0 on the real ledger (it was never funded anywhere).
//
// The dead relay is the REAL "relay unreachable" failure mode: the harness grabs a free TCP port
// (binds :0 → closes) so nothing listens → connect yields ECONNREFUSED (mirrors flow 13's approach).
//
// Selector contract: `balance` (header balance Pressable), `header-who` (username), the offline
// label "~ DEMO approx." (Wallet.tsx renders it when `online === false`; asset-name-prefixed after D3).
import { setup, assert, pickFreePort, getBalance, accountOf, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent, waitForWallet} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '37',
  name: 'onboard-no-faucet',
  journey: 'onboard',
  covers: ['onboard', 'capability-failure', 'offline', 'dead-relay', 'right-reason', 'zero-balance', 'no-funding-solicitation'],
  verifies: 'Onboard against a dead relay → capability discovery reaches the relay and fails with a connection refusal (not an unsafe-port artifact), no faucet request follows, the first-run practice screen fails closed with a retry and NO deposit address or add-money action, the wallet is created with $0 (∂100 never shown), and the balance carries the honest offline indicator.',
  timeoutMs: 90000,
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

    // Record BEFORE the navigate: Onboarding's capability probe fires on mount, so a recorder
    // installed after waitReady() could miss the very request this flow needs to see fail.
    const failures = driver.recordRequestFailures();

    // Load the app against the DEAD relay from the start (the `?relay=` query is read at module
    // load → Onboarding's capability probe goes to the dead relay). setup() first navigated to the
    // good relay; re-navigate now so onboarding is primed with the dead URL before we tap Create.
    console.log(`[37-onboard-no-faucet] loading the app against the dead relay (${DEAD_RELAY})…`);
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(DEAD_RELAY)}`, { timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // Onboard: wallet creation must remain independent from relay funding.
    console.log('[37-onboard-no-faucet] skipping first-run walkthrough if present…');
    await skipWalkthroughIfPresent(driver);
    console.log('[37-onboard-no-faucet] onboarding (capabilities fail closed)…');
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-nofaucet', { timeoutMs: 8_000 });
    await driver.click('btn-create', { timeoutMs: 4_000 });

    // Dismiss the mandatory backup screen; creation then proceeds without funding.
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox', { timeoutMs: 4_000 });
    await waitForEnabled(driver, 'btn-mnemonic-continue', { timeoutMs: 4_000 });
    await driver.click('btn-mnemonic-continue', { timeoutMs: 4_000 });

    // The first-run PRACTICE screen against a dead relay. It cannot read a balance, so it takes
    // its OFFLINE branch — and the assertion of record for this flow's `no-funding-solicitation`
    // slug is what that branch does NOT do: it offers a retry and a way on, and never a deposit
    // address or an add-money action. A screen that answered "we couldn't fund you" with "here is
    // where to send money" is the exact shape the 2026-09-08 first-run redesign exists to remove.
    await driver.findByTestID('practice', { timeoutMs: 15_000 });
    await driver.findByTestID('practice-offline', { timeoutMs: 15_000 });
    assert(!(await driver.isPresent('practice-offline-go')),
      'the offline practice branch must offer no funding primary');
    assert(!(await driver.isPresent('deposit-address')), 'and no deposit address');
    assert(await driver.isPresent('practice-offline-check'), 'it offers a re-check');
    assert(await driver.isPresent('btn-practice-continue'), 'and a way on');
    console.log('[37-onboard-no-faucet] ✓ practice fails closed with a retry and no solicitation');

    await skipPracticeIfPresent(driver);
    // The wallet mounts without a funding-failure detour.
    await chooseHomeCurrencyIfPresent(driver);
    await waitForWallet(driver, { timeoutMs: 10_000 });
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
    // header label reads "~ <name> approx." (Wallet.tsx; the name is the CURRENCY when the wallet
    // is on its main currency's rail, the asset otherwise). This is the
    // app's honest "I can't confirm a balance" signal — NOT a fabricated ∂0.00 and NOT a crash. The
    // assertion matches the substring 'approx.'.
    const approx = await driver.waitForText('approx.', { timeoutMs: 6_000 });
    assert(approx,
      `wallet should show the honest "~ … approx." offline indicator (balance poll unreachable). body excerpt:\n${body.slice(0, 500)}`);
    console.log('[37-onboard-no-faucet] ✓ no ∂100.00 + honest "~ … approx." offline indicator (no fake funding)');

    // The account genuinely holds $0 on the REAL ledger: the faucet POST went to the dead relay and
    // failed, so this account was never funded anywhere. Querying the shared FakeLedger confirms $0.
    const ledgerBal = await getBalance(relayBaseURL, identity.publicHex, 0);
    assert(ledgerBal === '0', `the unfunded account should read $0 on the ledger, got ${ledgerBal}`);
    console.log('[37-onboard-no-faucet] ✓ ledger confirms $0 (account never funded)');

    // THE RIGHT-REASON GATE. `no faucet request` is only evidence of the capability contract if the
    // app actually asked the dead relay something and was refused — otherwise a page that never
    // loaded, or a relay URL that was never adopted, would satisfy it just as well. So pin the
    // capability probe's own failure first: it must have happened, and it must be a CONNECTION
    // refusal, not Chrome's ERR_UNSAFE_PORT (which would mean the port choice, not the relay being
    // dead, produced the error — the artifact `pickFreePort()` exists to avoid).
    let capFail = null;
    for (let i = 0; i < 20 && capFail === null; i++) {
      capFail = failures().find((f) => f.url.startsWith(DEAD_RELAY) && f.url.includes('/api/v1/capabilities')) ?? null;
      if (capFail === null) await new Promise((r) => setTimeout(r, 250));
    }
    assert(capFail !== null,
      `capability discovery must have REACHED the dead relay and failed; no /api/v1/capabilities failure was recorded. Seen: ${JSON.stringify(failures().map((f) => f.url))}`);
    assert(/CONNECTION|NETWORK|REFUSED|FAILED/i.test(capFail.errorText),
      `capability discovery must fail with a connection error, got "${capFail.errorText}"`);
    assert(!/UNSAFE_PORT/i.test(capFail.errorText),
      `the dead relay must be REFUSED, not blocked as an unsafe port, got "${capFail.errorText}"`);
    console.log(`[37-onboard-no-faucet] ✓ capabilities failed for the right reason (${capFail.errorText})`);

    // And only THEN: no speculative faucet POST followed the failed discovery.
    const faucetFails = failures().filter((f) => f.url.includes('/api/v1/faucet'));
    assert(faucetFails.length === 0,
      `onboarding must not request funding when capabilities are unavailable; got ${faucetFails.length} faucet failures`);
    console.log('[37-onboard-no-faucet] ✓ no speculative faucet request followed');

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
