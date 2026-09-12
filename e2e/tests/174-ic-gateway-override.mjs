// Flow 174 — F2: the IC /api/v2 gateway OPERATOR OVERRIDE — Settings ▸ Advanced, over the real wire.
//
// The app's IC rail (signed icrc1_transfer envelopes) POSTs to an /api/v2 gateway whose base is
// resolved in app/config/constants.ts `icGatewayUrl()`: operator override (AsyncStorage
// dpay.icpGateway.v1, set from Settings ▸ Advanced) → e2e seam `__DPAY_TEST_IC_GATEWAY` → the
// public default https://icp-api.io. The override exists so a demo/operator can point the rail at
// a local replica (scripts/demo.sh — the phone leg of Demo A; measured broken 2026-09-07, fixed
// 2026-09-12). This flow pins the PRECEDENCE and the CLEAR over real HTTP:
//
//   1. SEAM BASELINE: a scan-pay settles through the harness fake-IC gateway (the `?relay=`
//      bootstrap of `__DPAY_TEST_IC_GATEWAY`) — the un-overridden rail works, and the Settings
//      field honestly mirrors the seam base it resolves to.
//   2. ROUND-TRIP: set the override to a dead local origin (http://127.0.0.1:<free port> —
//      plain http is accepted for local hosts by design), assert it applies verbatim with no
//      refusal row, assert it PERSISTS a settings round-trip, then CLEAR it (empty IS a value)
//      and assert the field falls back to the seam base.
//   3. COMPOSE-BACK: with the override cleared, a scan-pay settles through the seam again —
//      operator #1, seam #2, compose, don't replace.
//   4. OPERATOR WINS (final by design): re-apply the dead override and pay once more — the
//      submit must fail with ERR_CONNECTION_REFUSED at <dead>/api/v2/canister/… (proof the
//      envelope went to the OVERRIDE, not the seam's live fake gateway) and the payee stays at
//      0. A dead-gateway submit leaves the app mid-"Signing…" for its full ~76s retry budget
//      (review buttons hidden — nothing to recover from inside a flow window), which is why
//      this leg runs LAST and the flow simply ends on it; teardown stops the retry.
//
// jest twins: app/__tests__/ic-gateway-config.test.ts (precedence + validation, unit) and
// SettingsIcGateway.test.tsx (the Settings row). This flow pins the same contract end-to-end.
//
// Selector contract: `btn-settings`, `btn-advanced-toggle`, `settings-ic-gateway`,
// `btn-ic-gateway-apply`, `btn-settings-close`, `btn-new`, `tab-transactions`.
import {
  setup, assert, assertIncludes, getBalance, onboardWallet, armPayScan,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';
import { pickFreePort } from '../harness/relay.mjs';

const PAY_CENTS = 2500; // ∂25.00 (DEMO_USD = currency 0, the wallet asset)
const PAYEE_NAME = 'Bob';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test
  * timeout) and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source
  * of truth for id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '174',
  name: 'ic-gateway-override',
  journey: 'system',
  covers: ['ic-gateway-override', 'operator-override', 'gateway-precedence', 'settings-advanced'],
  verifies: 'F2 IC-gateway operator override: Settings ▸ Advanced re-points the IC /api/v2 rail — the override outranks the e2e seam (a dead local origin makes the next submit fail with ERR_CONNECTION_REFUSED at the override\'s /api/v2 route and settles nothing), and clearing it (empty is a value) restores the seam underneath (the next scan-pay settles again). Pinned over real HTTP: operator #1, seam #2, compose.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[174-ic-gateway-override] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // A free port that NOTHING will ever bind: the dead gateway for phase 2 (flow 165's trick).
    const deadPort = await pickFreePort();
    const deadOrigin = `http://127.0.0.1:${deadPort}`;

    // ── Phase 1: the seam baseline — a scan-pay settles through the harness fake gateway ─────
    console.log('[174-ic-gateway-override] phase 1: onboard + settle through the seam-bootstrapped gateway…');
    await onboardWallet(driver, 'e2e-icgw');
    const bob = await generateKeypair();
    await scanPay(driver, bob.publicHex, randNonceHex());
    await driver.waitForText('Paid', { timeoutMs: 10_000 });
    await waitPayeeCents(relayBaseURL, bob.publicHex, PAY_CENTS);
    console.log('[174-ic-gateway-override] ✓ baseline payment settled through the seam gateway');

    // ── Phase 2: the override round-trip — set the dead origin, then clear it, then PROVE the
    // clear composes back by settling again. (Set/clear are pure Settings edits — no payment is
    // attempted while the dead override is live in THIS phase, so the app is never left in the
    // ~76s "Signing…" retry budget that a dead-gateway submit runs before it surfaces.) ──────
    console.log(`[174-ic-gateway-override] phase 2: override → ${deadOrigin}, then clear…`);
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    // With NO operator override set, the field shows the RESOLVED rail base — here the e2e
    // seam's fake-IC gateway (bootstrapped from ?relay= by e2e/web/shims.ts), not the public
    // default. Pin exactly that: the field mirrors the seam underneath it.
    const seamBase = await driver.eval(() => (globalThis.__DPAY_TEST_IC_GATEWAY ?? ''));
    const seeded = await icFieldValue(driver);
    assert(seeded === seamBase, `with no override the field must mirror the seam base (${seamBase}), got "${seeded}"`);
    assert(seeded !== deadOrigin, 'sanity: the seeded seam base must differ from the dead override origin');
    await driver.type('settings-ic-gateway', deadOrigin, { timeoutMs: 4_000 });
    await driver.click('btn-ic-gateway-apply', { timeoutMs: 4_000 });
    const applied = await icFieldValue(driver);
    assert(applied === deadOrigin, `the applied override must read back verbatim, got "${applied}"`);
    const errShown = await driver.eval(() => !!document.querySelector('[data-testid="settings-ic-gateway-err"]'));
    assert(!errShown, 'a local http origin must be ACCEPTED (plain http is local-only by design), no error row');
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    console.log('[174-ic-gateway-override] ✓ override applied (local http accepted, no refusal)');

    // The clear: EMPTY IS A VALUE. The override must survive one settings round-trip first.
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    const stillDead = await icFieldValue(driver); // scrolls the below-fold field into view too
    assert(stillDead === deadOrigin, `the override must persist across the settings round-trip, got "${stillDead}"`);
    await driver.type('settings-ic-gateway', '', { timeoutMs: 4_000 }); // EMPTY IS A VALUE
    await driver.click('btn-ic-gateway-apply', { timeoutMs: 4_000 });
    const restored = await icFieldValue(driver);
    assert(restored === seamBase, `clearing must re-expose the seam base (${seamBase}), got "${restored}"`);
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });
    console.log('[174-ic-gateway-override] ✓ override persisted, then cleared (field back to the seam base)');

    // ── Phase 3: compose-back — with the override cleared, the seam settles a payment again ───
    console.log('[174-ic-gateway-override] phase 3: cleared → settle through the seam again…');
    const carol = await generateKeypair();
    await driver.click('btn-new', { timeoutMs: 5_000 }); // phase 1's Paid screen → scan returns
    await scanPay(driver, carol.publicHex, randNonceHex());
    await driver.waitForText('Paid', { timeoutMs: 10_000 });
    await waitPayeeCents(relayBaseURL, carol.publicHex, PAY_CENTS);
    console.log('[174-ic-gateway-override] ✓ cleared → the seam gateway settles again (compose, don\'t replace)');

    // ── Phase 4: operator outranks the seam — the dead override, then a payment that MUST die
    // at the OVERRIDE's /api/v2 route while the seam gateway underneath is alive and well. This
    // is the LAST phase by design: a dead-gateway submit leaves the app mid-"Signing…" for its
    // full retry budget (~76s) with the review buttons hidden — nothing to recover from inside
    // a flow window. The flow ends here; teardown stops the retry with the page. ──────────────
    const failures = driver.recordRequestFailures();
    driver.allowRequestFailuresFrom(deadOrigin); // the dead-gateway submits are expected
    console.log(`[174-ic-gateway-override] phase 4: override → ${deadOrigin} (final)…`);
    await driver.click('btn-settings', { timeoutMs: 6_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    await driver.type('settings-ic-gateway', deadOrigin, { timeoutMs: 4_000 });
    await driver.click('btn-ic-gateway-apply', { timeoutMs: 4_000 });
    const deadAgain = await icFieldValue(driver);
    assert(deadAgain === deadOrigin, `the override must re-apply verbatim, got "${deadAgain}"`);
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    const dave = await generateKeypair();
    await driver.click('btn-new', { timeoutMs: 5_000 }); // phase 3's Paid screen → scan returns
    await scanPay(driver, dave.publicHex, randNonceHex());
    const deadHit = await waitForFailureAt(failures, deadOrigin, 15_000);
    assertIncludes(deadHit.url, '/api/v2/canister/', 'the refused request must be an /api/v2 envelope POST');
    assertIncludes(deadHit.errorText, 'ERR_CONNECTION_REFUSED', 'the override origin must be connection-refused (a real dead origin, not a Chrome block)');
    await new Promise((r) => setTimeout(r, 2_000)); // give a would-be settlement time to land
    const daveStuck = await getBalance(relayBaseURL, dave.publicHex, 0);
    assert(Number(daveStuck) === 0, `nothing may settle while the rail points at the dead override (dave=${daveStuck})`);
    console.log(`[174-ic-gateway-override] ✓ submit refused AT the override (${deadHit.url}) — operator outranks the seam`);

    console.log(`[174-ic-gateway-override] PASS in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

/** The IC-gateway input sits BELOW THE FOLD in the Advanced disclosure (relay editor + Solana
  * rows render first) and `readInputValue`/`type` wait on VISIBILITY — scroll the field into
  * view first, then hand back its current value. */
async function icFieldValue(driver) {
  return await driver.eval(() => {
    const el = document.querySelector('[data-testid="settings-ic-gateway"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    return (el.value ?? '').toString();
  });
}

/** Build a request QR for `payeeHex` (∂25, +10min, currency 0), arm the payer scan surface and
  * inject it through the camera seam — flow 07's one-press auto-sign mechanics. */
async function scanPay(driver, payeeHex, nonce) {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const qr = buildRequestQR(payeeHex, PAY_CENTS, nonce, expiry, 0, PAYEE_NAME);
  await armPayScan(driver);
  await driver.eval((v) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(v); }, qr);
}

/** Poll the relay ledger until the payee holds exactly `cents` (settle + poll reconcile). */
async function waitPayeeCents(relayBaseURL, publicHex, cents, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '0';
  while (Date.now() < deadline) {
    last = await getBalance(relayBaseURL, publicHex, 0);
    if (Number(last) === cents) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert(false, `payee balance never reached ${cents} cents (last=${last})`);
}

/** Poll the CDP request-failure record until something at `origin` failed; returns the entry. */
async function waitForFailureAt(failures, origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = failures().find((f) => f.url.startsWith(origin));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(false, `no failed request was recorded at ${origin} within ${timeoutMs}ms`);
}
