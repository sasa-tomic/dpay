// e2e-live Tier 2 — LIVE VCHF→USDC through the REAL app UI against the PROD relay (OPT-IN).
//
// THE FOUNDER'S EXACT FAILING PAIR: "I tried to convert 1 VCHF -> USDC and I got a spinner and
// text 'Approving' … and nothing further happens." Root cause fixed 2026-09-19 (the approve legs
// baked expected_allowance and decoded ApproveError transfer-shaped — every conversion wedged at
// the Approving spinner on a real ledger while the fake gateway passed). This flow drives the same
// pair live: VCHF → ckUSDC via the direct ICPSwap pool (venue icpswap-vchf-ckusdc), device-signed
// ICRC-2 approve + depositAndSwap on the MAINNET ledgers, through the surfaces a user touches.
//
// REAL FUNDS: converts VCHF of the agent test float (CLAUDE.md non-negotiable; log the spend in
// docs/AGENT-FUNDS.md). Requires:
//   DPAY_E2E_BASE=https://dpay.kalaj.org
//   DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed)
//
// Run: DPAY_E2E_LIVE_FLOW=03-convert-vchf-usdc.mjs DPAY_E2E_BASE=https://dpay.kalaj.org \
//      DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed) node e2e-live/run.mjs
import { setup, assert, onboardWallet, openBalances, selectCurrency, accountOf } from '../../e2e/harness/lib.mjs';

export const meta = {
  id: '03',
  name: 'convert-vchf-usdc',
  journey: 'live',
  covers: ['live', 'convert', 'icrc2-approve', 'icpswap', 'real-funds', 'approve-fix', 'vchf-usdc'],
  verifies: 'LIVE VCHF→USDC (the founder-reported failing pair) through the real UI on mainnet: the approve settles, the direct-pool swap fills ≥ min-out, ckUSDC lands in the wallet — never an endless Approving.',
  timeoutMs: 600_000,
};

// Spend size: 0.4 VCHF ≈ CHF 0.4 of the agent float (≤ the CHF 2 unasked-spend ceiling; log it).
const AMOUNT = '0.4';

export async function run() {
  const start = Date.now();
  const seedHex = process.env.DPAY_AGENT_SEED_HEX;
  if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('DPAY_AGENT_SEED_HEX must hold the agent identity secretHex (node scripts/agent-key.mjs seed)');
  }
  console.log('[03-convert-vchf-usdc] setup (local web @ HEAD + prod relay)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Throwaway onboard, then RESTORE the agent identity (flow-64 mechanism).
    console.log('[03-convert-vchf-usdc] onboarding throwaway, then restoring the agent identity…');
    await onboardWallet(driver, 'live-convert-vchf', { timeoutMs: 30_000 });
    await driver.click('btn-settings', { timeoutMs: 8_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 8_000 });
    await driver.type('settings-restore-seed-input', seedHex);
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 8_000 });
    await driver.waitForText('Home', { timeoutMs: 15_000 });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'restore re-mounts an identity');

    // 1b. LIVE ONLY: the shimmed e2e dist bootstraps `__DPAY_TEST_IC_GATEWAY` from `?relay=` — in
    //     live mode that points the IC value path at the relay origin (no /api/v2 → 404 → the
    //     certified clock read fails → confirm hangs submitting nothing). Re-point it at the real
    //     boundary node; icp.ts reads the seam PER CALL, so every later envelope goes there.
    const seam = await driver.eval(() => (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string' ? globalThis.__DPAY_TEST_IC_GATEWAY : null));
    if (typeof seam === 'string' && seam !== 'https://icp-api.io') {
      await driver.eval((gw) => { globalThis.__DPAY_TEST_IC_GATEWAY = gw; }, 'https://icp-api.io');
      console.log(`[03-convert-vchf-usdc] IC gateway seam ${seam} → https://icp-api.io`);
    }

    // 2. Read the relay's ledger answer (key 7 = VCHF e8s) and wait for the app chip to render it.
    const balRes = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    assert(balRes.ok, `relay balance read ok (${balRes.status})`);
    const balMap = await balRes.json();
    const vchfE8s = Number(balMap['7']);
    assert(Number.isFinite(vchfE8s) && vchfE8s > 0, `relay reports a live VCHF balance (got ${balMap?.['7']})`);
    const vchfOnchain = vchfE8s / 1e8;
    assert(vchfOnchain > parseFloat(AMOUNT) + 0.0002, `float covers the spend (${vchfOnchain} VCHF)`);
    console.log(`[03-convert-vchf-usdc] on-chain float: ${vchfOnchain} VCHF`);
    await openBalances(driver, { timeoutMs: 20_000 });
    await selectCurrency(driver, 'vchf');
    const expect = vchfOnchain.toFixed(5);
    const floatVisible = await driver.waitForFunction(
      (exp) => {
        const t = document.querySelector('[data-testid="balance"]')?.textContent ?? '';
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (Number.isFinite(n) && Math.abs(n - Number(exp)) < 0.0001) return true;
        return (document.body?.textContent ?? '').includes(exp);
      },
      { timeoutMs: 120_000 }, expect,
    ).then(() => true).catch(() => false);
    assert(floatVisible, `the app renders the live VCHF balance (${expect}) within 120s`);

    // 3. Convert VCHF→USDC through the real surfaces; pick the in-wallet ckUSDC destination
    //    (the direct ICPSwap pool, NOT the cash-out routes).
    console.log(`[03-convert-vchf-usdc] converting ${AMOUNT} VCHF → USDC on mainnet…`);
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 10_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 8_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 10_000 }) != null, 'Convert opens for VCHF');
    await driver.type('convert-amount', AMOUNT);
    await driver.findByTestID('convert-quote-source', { timeoutMs: 20_000 });
    await driver.click('convert-dest-inwallet-ckusdc', { timeoutMs: 12_000 });
    await driver.screenshot('03-vchf-usdc-checklist');
    await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });

    // 4. The state machine settles — never the endless Approving of the defect.
    await driver.screenshot('03-vchf-usdc-inflight');
    assert(await driver.findByTestID('convert-done', { timeoutMs: 480_000 }) != null,
      'the conversion SETTLES to Done (approve accepted + swap filled) — never an endless Approving');
    await driver.screenshot('03-vchf-usdc-done');

    // 5. The money moved: VCHF debited by amount+fee, ckUSDC (key 2) credited.
    const balRes2 = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    const balMap2 = await balRes2.json();
    const vchfAfter = Number(balMap2['7']) / 1e8;
    const expectAfter = vchfOnchain - parseFloat(AMOUNT) - 0.0001;
    assert(Math.abs(vchfAfter - expectAfter) < 0.0001,
      `VCHF debit exact on-chain: ${vchfOnchain} → ${vchfAfter} (expected ≈ ${expectAfter.toFixed(8)})`);
    const usdcAfter = Number(balMap2['2']) / 1e6;
    console.log(`[03-convert-vchf-usdc] ✓ VCHF ${vchfOnchain} → ${vchfAfter}; ckUSDC now ${usdcAfter}; wall ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.close?.();
  }
}
