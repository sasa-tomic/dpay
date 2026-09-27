// Flow 164 — R1: the ordered relay address LIST — failover on transport failure, NONE on 4xx.
//
// Spec docs/specs/2026-09-09-relay-ha-and-solana-proxy.md §"Direction 2": the wallet holds an
// ORDERED list of relay addresses (one client implementation at several addresses — NOT a
// "fallback"): try the first; a transport failure OR a 5xx moves to the next; a 4xx is an ANSWER
// (the relay heard us and refused) and must never move. This flow pins both halves against TWO real
// harness relays:
//
//   1. FAILOVER: `?relay=<dead>,<relay2>` — a dead FIRST address. The wallet must still onboard
//      (the direct faucet POST failing is non-blocking) and, once the account is funded on relay2
//      OUT OF BAND (relay2's own faucet), the header must show ∂100.00 — a number that could only
//      have arrived by walking PAST the dead primary to relay2. The walk is also pinned from the
//      other side: the browser must have recorded real transport failures against the dead origin
//      (ERR_CONNECTION_REFUSED, not UNSAFE_PORT — the same reason-audit as flow 13), proving the
//      dead address was TRIED FIRST, not skipped.
//
//   2. A 4xx STOPS THE WALK: retarget the list to [webOrigin, relay2] via the Settings list
//      editor. The web origin serves the app bundle and has NO /api/v1 routes → the balance poll
//      gets a 404. A 4xx is an answer, so the walk must NOT touch relay2: the header flips to the
//      offline 'approx.' eyebrow (online=false) while relay2 is provably alive. A buggy
//      failover-on-4xx would read 200 from relay2 and show the exact online balance instead.
//
// Why the drift gate does not appear here: both harness relays are the SAME dpay-relay build, so
// their fingerprints agree by construction — the mismatch path (typed error, names both addresses
// + commits) is covered by the jest suite (app/__tests__/relayFailover.test.ts) where a mismatched
// replica can be cheaply faked.
//
// Selector contract: `btn-settings`, `btn-advanced-toggle`, `settings-relay` (multiline list
// editor), `btn-relay-apply`, `btn-settings-close`, `tab-home`.
import {
  setup, assert, assertIncludes, accountOf, faucetAccount,
  skipWalkthroughIfPresent, skipPracticeIfPresent, chooseHomeCurrencyIfPresent,
  waitForEnabled, WALLET_READY, openBalances,
} from '../harness/lib.mjs';
import {startRelay, pickFreePort} from '../harness/relay.mjs';

const FUND_RAW_DEMO = 10_000; // ∂100.00 — the faucet-funded contract amount (2 decimals)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '164',
  name: 'relay-failover',
  journey: 'system',
  covers: ['relay-multi-address', 'relay-failover', 'relay-4xx-no-failover', 'settings-relay-list'],
  verifies: 'R1 ordered relay list: a dead first address is walked past (balance arrives from the second, and the dead origin was really tried), and a 4xx from the first address NEVER fails over (offline eyebrow while the second relay is alive).',
  timeoutMs: 90000,
};

/** Onboard WITHOUT the funded-wallet contract: `onboardWallet` waits for ∂100.00, but this flow's
 *  primary relay is DEAD at boot — the direct faucet POST cannot succeed (the app treats that as
 *  non-blocking), so the flow funds the account on relay2 out-of-band and asserts the balance
 *  arrives THROUGH the walk instead. */
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

export async function run() {
  const start = Date.now();
  console.log('[164-relay-failover] setup…');
  const env = await setup();
  // The second relay — same build, own fake-IC gateway + faucet, own port.
  const r2 = await startRelay();
  // A free port that NOTHING will ever bind: the dead primary. Real address shape, refused
  // connections — the exact "transport failure" leg of the walk rule.
  const deadPort = await pickFreePort();
  const deadOrigin = `http://127.0.0.1:${deadPort}`;
  try {
    const { driver, relayBaseURL, webBaseURL } = env;
    const failures = driver.recordRequestFailures();
    // The polls will keep failing against the dead primary for the whole flow — expected.
    driver.allowRequestFailuresFrom(deadOrigin);

    // ── Phase 1: ordered failover past a dead first address ─────────────────────────────────
    console.log(`[164-relay-failover] phase 1: boot with ?relay=${deadOrigin},${r2.baseURL} (dead first)…`);
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(`${deadOrigin},${r2.baseURL}`)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardUnfunded(driver, 'e2e-failover');
    const identity = await accountOf(driver);
    assert(typeof identity?.publicHex === 'string' && identity.publicHex.length === 64, 'onboarded identity must be present');

    // The list editor renders the ?relay= list verbatim (one address per line, order = priority).
    await driver.click('btn-settings', {timeoutMs: 6_000});
    await driver.click('btn-advanced-toggle', {timeoutMs: 4_000});
    const listText = await driver.readInputValue('settings-relay', {timeoutMs: 4_000});
    assertIncludes(listText, r2.baseURL, 'the list editor must carry every ?relay= address');
    assertIncludes(listText, deadOrigin, '…including the dead first one (order = priority)');
    await driver.click('btn-settings-close', {timeoutMs: 4_000});

    // Fund the SAME account on relay2 (out of band — the app never switched anything). The app
    // can only learn this number by walking dead → relay2, and the learned DEMO balance renders
    // on the accounts-route DEMO row (currency-first: the Pay surface headlines MAIN).
    console.log(`[164-relay-failover] funding ∂100.00 on relay2 (${r2.baseURL}) for the onboarded account…`);
    const fund = await faucetAccount(r2.baseURL, identity.publicHex, FUND_RAW_DEMO);
    assert(fund.ok, `relay2 faucet must fund the account (got ${fund.status}: ${JSON.stringify(fund.body)})`);
    await openBalances(driver, {timeoutMs: 8_000});
    const arrived = await driver.waitForText('∂100.00', {timeoutMs: 15_000});
    assert(arrived, 'the DEMO balance must arrive through the relay walk (dead primary → relay2)');
    await driver.click('tab-pay', {timeoutMs: 4_000});
    console.log('[164-relay-failover] ✓ ∂100.00 arrived — the balance walked past the dead primary to relay2');

    // And the walk really TRIED the dead primary first (not silently skipped): real transport
    // failures must be on record against the dead origin, for the right reason.
    const deadFails = failures().filter((f) => f.url.startsWith(deadOrigin));
    assert(deadFails.length > 0, `the dead primary must have been tried (no failed requests to ${deadOrigin})`);
    for (const f of deadFails) {
      // The reasons a request to a DEAD origin can fail. `ERR_ABORTED` belongs here and is not a
      // tolerance: it is what Chrome reports when the app's own fetch timeout gives up on a relay
      // that never answers, which is the app behaving correctly — and it is what a loaded machine
      // produces instead of a fast REFUSED. What is still refused is a request that succeeded, or
      // failed for a reason that would mean the walk never really tried the dead address.
      assert(/CONNECTION|NETWORK|REFUSED|FAILED|ABORTED/i.test(f.errorText), `dead-primary failures must be connection errors, got "${f.errorText}"`);
      assert(!/UNSAFE_PORT/i.test(f.errorText), `dead-primary failures must not be UNSAFE_PORT artifacts, got "${f.errorText}"`);
    }
    console.log(`[164-relay-failover] ✓ ${deadFails.length} connection-refused request(s) to the dead primary on record`);

    // ── Phase 2: a 4xx is an answer — NO failover ────────────────────────────────────────────
    console.log(`[164-relay-failover] phase 2: list → [${webBaseURL}, ${r2.baseURL}] (web 404s /api/v1)…`);
    await driver.click('btn-settings', {timeoutMs: 6_000});
    await driver.click('btn-advanced-toggle', {timeoutMs: 4_000});
    await driver.type('settings-relay', `${webBaseURL}\n${r2.baseURL}`, {timeoutMs: 4_000});
    await driver.click('btn-relay-apply', {timeoutMs: 4_000});
    await driver.click('btn-settings-close', {timeoutMs: 4_000});

    // relay2 must be alive, or 'approx.' would prove nothing (flow 13 already owns the plain
    // dead-relay case). Prove liveness the same way the funding did: its API answers.
    const alive = await fetch(`${r2.baseURL}/api/v1/health`);
    assert(alive.ok, `relay2 must still be healthy for the 4xx assertion to mean anything (got ${alive.status})`);

    // The web origin serves no /api/v1 → the balance poll gets a 404 → that is an ANSWER: the walk
    // stops, `online` flips false, the header grows the offline 'approx.' eyebrow. If a buggy walk
    // failed over on 4xx, relay2's 200 would keep the header exact (online=true) and this wait
    // would time out.
    await driver.waitForText('approx.', {timeoutMs: 15_000});
    console.log('[164-relay-failover] ✓ offline eyebrow shown — the 4xx from the first address stopped the walk while relay2 was alive');

    await driver.screenshot('164-relay-failover');
    console.log(`[164-relay-failover] PASS (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

// Standalone runner (`node e2e/tests/164-relay-failover.mjs`) — mirrors every flow file.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => {
    console.log('[164-relay-failover] standalone run complete');
    process.exit(0);
  }).catch((e) => {
    console.error('[164-relay-failover] FAILED:', e);
    process.exit(1);
  });
}
