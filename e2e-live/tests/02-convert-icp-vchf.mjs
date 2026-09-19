// e2e-live Tier 2 — LIVE IC conversion through the REAL app UI against the PROD relay (OPT-IN).
//
// Proves the 2026-09-19 approve-defect fix on the rails it broke: a real device-signed ICRC-2
// approve + ICPSwap depositAndSwap on the MAINNET ledgers, driven through the same surfaces a
// user touches (Convert checklist → Approving → settled), with the local web build (HEAD) pointed
// at the prod relay. The app submits to icp-api.io DIRECTLY — the relay only serves catalog/venues,
// so this exercises the exact client path prod phones run.
//
// REAL FUNDS: converts AMOUNT_ICP of the agent test float (CLAUDE.md non-negotiable; log the spend
// in docs/AGENT-FUNDS.md). Requires:
//   DPAY_E2E_BASE=https://dpay.kalaj.org
//   DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed)
//
// Run: DPAY_E2E_LIVE_FLOW=02-convert-icp-vchf.mjs DPAY_E2E_BASE=https://dpay.kalaj.org \
//      DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed) node e2e-live/run.mjs
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, accountOf } from '../../e2e/harness/lib.mjs';

export const meta = {
  id: '02',
  name: 'convert-icp-vchf',
  journey: 'live',
  covers: ['live', 'convert', 'icrc2-approve', 'icpswap', 'real-funds', 'approve-fix'],
  verifies: 'LIVE ICP→VCHF through the real UI on mainnet: the ICRC-2 approve settles (the 2026-09-19 AllowanceChanged defect stays dead), the swap fills ≥ min-out, VCHF lands in the wallet.',
  timeoutMs: 600_000,
};

// Spend size: 0.2 ICP of the agent float (≤ the CHF 2 unasked-spend ceiling; log it).
const AMOUNT = '0.2';

export async function run() {
  const start = Date.now();
  const seedHex = process.env.DPAY_AGENT_SEED_HEX;
  if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('DPAY_AGENT_SEED_HEX must hold the agent identity secretHex (node scripts/agent-key.mjs seed)');
  }
  console.log('[02-convert-icp-vchf] setup (local web @ HEAD + prod relay)…');
  const env = await setup();
  try {
    const { driver } = env;

    // 1. Throwaway onboard (prod relay registration), then RESTORE the agent identity over it —
    //    the exact flow-64 mechanism (Settings → Restore → secretHex → confirm → remount).
    console.log('[02-convert-icp-vchf] onboarding throwaway, then restoring the agent identity…');
    await onboardWallet(driver, 'live-convert', { timeoutMs: 30_000 });
    await driver.click('btn-settings', { timeoutMs: 8_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 8_000 });
    await driver.type('settings-restore-seed-input', seedHex);
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 8_000 });
    await driver.waitForText('Home', { timeoutMs: 15_000 });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'restore re-mounts an identity');

    // 1b. LIVE ONLY: the shimmed e2e dist bootstraps `__DPAY_TEST_IC_GATEWAY` from `?relay=` at
    //     page load — which in live mode points the app's IC value path at the RELAY ORIGIN, and
    //     the prod relay serves no /api/v2 (404) → the certified clock is "unreachable" → confirm
    //     hangs on "Re-quote and confirm" forever, submitting NOTHING. The real app (phone, and
    //     the /wallet bundle the relay serves) uses icp-api.io. icp.ts reads the seam PER CALL, so
    //     re-pointing it here sends every later envelope to the real boundary node.
    const seam = await driver.eval(() => (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string' ? globalThis.__DPAY_TEST_IC_GATEWAY : null));
    if (typeof seam === 'string' && seam !== 'https://icp-api.io') {
      await driver.eval((gw) => { globalThis.__DPAY_TEST_IC_GATEWAY = gw; }, 'https://icp-api.io');
      console.log(`[02-convert-icp-vchf] IC gateway seam ${seam} → https://icp-api.io (live = real boundary node)`);
    }

    // 2. The LIVE balance proves the identity IS the agent float: read the relay's own batch
    //    answer (ledger truth, key 8 = ICP e8s) and wait for the app's chip to render it. Restore
    //    resets the selection to DEMO, so make ICP the active asset first. The chip renders an
    //    animated "~approx" form while the fiat conversion streams in, so a single parseFloat can
    //    catch a half-rendered frame — poll the CHIP and fall back to the exact e8s→ICP string.
    const balRes = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    assert(balRes.ok, `relay balance read ok (${balRes.status})`);
    const balMap = await balRes.json();
    const icpE8s = Number(balMap['8']);
    assert(Number.isFinite(icpE8s) && icpE8s > 0, `relay reports a live ICP balance (got ${balMap?.['8']})`);
    const icpOnchain = icpE8s / 1e8;
    console.log(`[02-convert-icp-vchf] on-chain float: ${icpOnchain} ICP`);
    await openBalances(driver, { timeoutMs: 20_000 });
    await selectCurrency(driver, 'icp');
    const expect = icpOnchain.toFixed(4);
    const floatVisible = await driver.waitForFunction(
      (exp) => {
        const t = document.querySelector('[data-testid="balance"]')?.textContent ?? '';
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && Math.abs(n - Number(exp)) < 0.0001) return true;
        return (document.body?.textContent ?? '').includes(exp);
      },
      { timeoutMs: 120_000 }, expect,
    ).then(() => true).catch(() => false);
    assert(floatVisible, `the app renders the live ICP balance (${expect}) within 120s`);

    // 3. Convert ICP→VCHF through the real surfaces.
    console.log(`[02-convert-icp-vchf] converting ${AMOUNT} ICP → VCHF on mainnet…`);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 10_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 8_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 10_000 }) != null, 'Convert opens for ICP');
    await driver.type('convert-amount', AMOUNT);
    await driver.findByTestID('convert-quote-source', { timeoutMs: 20_000 });
    await driver.click('convert-dest-direct', { timeoutMs: 8_000 });
    await driver.screenshot('02-icp-vchf-checklist');
    await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });

    // 4. The state machine: the approve leg settles (the fixed path) and the record reaches Done.
    //    The old bug spun on Approving forever (AllowanceChanged decoded transfer-shaped → throw →
    //    driveOne re-arm loop). Generous timeout: every leg is a real mainnet round trip.
    await driver.screenshot('02-icp-vchf-inflight');
    assert(await driver.findByTestID('convert-done', { timeoutMs: 480_000 }) != null,
      'the conversion SETTLES to Done (approve accepted + swap filled) — never an endless Approving');
    await driver.screenshot('02-icp-vchf-done');

    // 5. The money moved: re-read the relay's ledger answer — ICP dropped by ~amount+fee — and
    //    the app lists VCHF as an in-wallet asset.
    await openBalances(driver, { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assertIncludes(body, 'VCHF', 'the VCHF asset row exists after the conversion');
    const balRes2 = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    const balMap2 = await balRes2.json();
    const after = Number(balMap2['8']) / 1e8;
    const expectAfter = icpOnchain - parseFloat(AMOUNT) - 0.0001;
    assert(after < expectAfter + 0.0001 && after > expectAfter - 0.0001,
      `ICP debit exact on-chain: ${icpOnchain} → ${after} (expected ≈ ${expectAfter.toFixed(8)})`);
    console.log(`[02-convert-icp-vchf] ✓ ICP ${icpOnchain} → ${after}; VCHF in wallet; wall ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.close?.();
  }
}
