// e2e-live Tier 2 — LIVE VCHF→USDC (the founder's exact failing pair) through the REAL app UI
// against the PROD relay (OPT-IN). Direct ICPSwap pool icpswap-vchf-ckusdc (the 2026-09-16
// 8-decimal→6-decimal pair). Like flow 02, the LOCAL web build (HEAD — the approve fix, the
// stale-quote guard) is pointed at the prod relay: the /wallet bundle prod serves may lag HEAD,
// and this flow exists to prove the FIXES, not the lag. The app submits to icp-api.io DIRECTLY.
//
// REAL FUNDS: converts AMOUNT_VCHF of the agent test float (≤ the CHF 2 unasked-spend ceiling;
// log the spend in docs/AGENT-FUNDS.md). Requires:
//   DPAY_E2E_BASE=https://dpay.kalaj.org
//   DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed)
//
// Run: DPAY_E2E_LIVE_FLOW=03-convert-vchf-usdc.mjs DPAY_E2E_BASE=https://dpay.kalaj.org \
//      DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed) node e2e-live/run.mjs
import { setup, assert, assertIncludes, onboardWallet, openBalances, selectCurrency, accountOf } from '../../e2e/harness/lib.mjs';

export const meta = {
  id: '03',
  name: 'convert-vchf-usdc',
  journey: 'live',
  covers: ['live', 'convert', 'icrc2-approve', 'icpswap', 'real-funds', 'approve-fix', 'decimal-pairs', 'stale-quote-guard'],
  verifies: 'LIVE VCHF→ckUSDC (direct pool) through the real UI on mainnet: the approve settles, the swap fills ≥ min-out, ckUSDC lands in the wallet; the destination pick re-quotes and never renders the stale standing quote under the new asset\'s label.',
  timeoutMs: 600_000,
};

// Spend size: 0.4 VCHF ≈ CHF 0.4 of the agent float.
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
    const apiLog = [];
    driver.page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/api/v1/swap_quote') || u.includes('/api/v1/convert')) {
        apiLog.push(`${res.status()} ${u.replace(relayBaseURL, '').slice(0, 150)}`);
      }
    });

    // 1. Throwaway onboard (prod relay registration), then RESTORE the agent identity over it —
    //    the exact flow-64 mechanism (Settings → Restore → secretHex → confirm → remount).
    console.log('[03-convert-vchf-usdc] onboarding throwaway, then restoring the agent identity…');
    await onboardWallet(driver, 'live-convert', { timeoutMs: 30_000 });
    await driver.click('btn-settings', { timeoutMs: 8_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 8_000 });
    await driver.type('settings-restore-seed-input', seedHex);
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 8_000 });
    await driver.waitForText('Home', { timeoutMs: 15_000 });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'restore re-mounts an identity');

    // 1b. LIVE ONLY: re-point the harness IC-gateway seam at the real boundary node (see flow 02).
    const seam = await driver.eval(() => (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string' ? globalThis.__DPAY_TEST_IC_GATEWAY : null));
    if (typeof seam === 'string' && seam !== 'https://icp-api.io') {
      await driver.eval((gw) => { globalThis.__DPAY_TEST_IC_GATEWAY = gw; }, 'https://icp-api.io');
      console.log(`[03-convert-vchf-usdc] IC gateway seam ${seam} → https://icp-api.io`);
    }

    // 2. The relay's ledger answer (key 7 = VCHF e8s) anchors the float before any spend.
    const balRes = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    assert(balRes.ok, `relay balance read ok (${balRes.status})`);
    const balMap = await balRes.json();
    const vchfE8s = Number(balMap['7']);
    assert(Number.isFinite(vchfE8s) && vchfE8s > 0, `relay reports a live VCHF balance (got ${balMap?.['7']})`);
    const vchfOnchain = vchfE8s / 1e8;
    assert(vchfOnchain > parseFloat(AMOUNT) + 0.0005, `float covers the spend (${vchfOnchain} VCHF)`);
    console.log(`[03-convert-vchf-usdc] on-chain float: ${vchfOnchain} VCHF`);

    // 3. Convert VCHF→USDC: the in-wallet ckUSDC destination, DIRECT mechanism (currency id 2).
    console.log(`[03-convert-vchf-usdc] converting ${AMOUNT} VCHF → USDC on mainnet…`);
    await openBalances(driver, { timeoutMs: 20_000 });
    await selectCurrency(driver, 'vchf');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 10_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 8_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 10_000 }) != null, 'Convert opens for VCHF');
    await driver.type('convert-amount', AMOUNT);
    await driver.findByTestID('convert-quote-source', { timeoutMs: 20_000 });
    const destRow = (await driver.findByTestID('convert-dest-inwallet-2', { timeoutMs: 6_000 }).catch(() => null)) != null
      ? 'convert-dest-inwallet-2' : 'convert-dest-inwallet-ckusdc';
    await driver.click(destRow, { timeoutMs: 12_000 });
    // The destination pick re-keys the quote fetch; the panel must show the NEW pool's number
    // before confirming — pressing early trips the honest quote-changed gate (review again).
    // The direct VCHF→ckUSDC quote ≈ 0.49 USDC; the stale standing quote reads ~17 ("USDC").
    // textContent joins the label and the styled number WITHOUT whitespace ("receive0.47").
    const quoteSettled = await driver.eval(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000) {
        const m = (document.body?.textContent ?? '').replace(/\s+/g, ' ').match(/YOU.?LL RECEIVE\s*([0-9.]+)/i);
        if (m != null && Number(m[1]) < 5) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    });
    if (!quoteSettled) {
      const d = await driver.eval(() => (document.body?.textContent ?? '').replace(/\s+/g, ' ').match(/(YOU.?LL RECEIVE[^B]{0,60}|Quote from[^.]{0,40}|quote unavailable[^.]{0,40})/gi)?.slice(0, 5) ?? []);
      console.log('[03-convert-vchf-usdc] quote-wait DIAG:', JSON.stringify(d));
      console.log('[03-convert-vchf-usdc] api:', JSON.stringify(apiLog, null, 1));
      await driver.screenshot('03-quote-wait-diag');
    }
    assert(quoteSettled, 'the refetched direct quote (≈0.49 USDC, not the stale ~17) renders before confirm');
    await driver.screenshot('03-vchf-usdc-checklist');
    await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });
    // The confirm re-quotes; if the fresh number differs the app honestly arms the
    // quote-changed gate — review and press again.
    const reArm = await driver.findByTestID('convert-quote-changed', { timeoutMs: 15_000 }).catch(() => null);
    if (reArm != null) {
      console.log('[03-convert-vchf-usdc] quote-changed gate armed — confirming again');
      await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });
    }

    // 4. The state machine settles — never the endless Approving of the defect.
    await driver.screenshot('03-vchf-usdc-inflight');
    const done = await driver.findByTestID('convert-done', { timeoutMs: 480_000 }).catch(() => null);
    if (done == null) {
      const panel = await driver.eval(() => (document.body?.textContent ?? '').replace(/\s+/g, ' ').match(/(Approving|Swapping|Settling|Converted|Swap not executed|refused|Unknown outcome|quote changed)[^\n]{0,80}/gi)?.slice(0, 6) ?? []);
      console.log('[03-convert-vchf-usdc] STUCK. panel:', JSON.stringify(panel));
      console.log('[03-convert-vchf-usdc] api:', JSON.stringify(apiLog, null, 1));
      await driver.screenshot('03-stuck-panel');
    }
    assert(done != null,
      'the conversion SETTLES to Done (approve accepted + swap filled) — never an endless Approving');
    await driver.screenshot('03-vchf-usdc-done');

    // 5. The money moved: VCHF debit exact (amount + TWO input-ledger fees: the approve and the
    //    pool's own pull), and the app lists USDC as an in-wallet asset.
    await openBalances(driver, { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assertIncludes(body, 'USDC', 'the USDC asset row exists after the conversion');
    const balRes2 = await fetch(`${relayBaseURL}/api/v1/balances/${identity.publicHex}`);
    const balMap2 = await balRes2.json();
    const after = Number(balMap2['7']) / 1e8;
    const expectAfter = vchfOnchain - parseFloat(AMOUNT) - 0.0002;
    assert(Math.abs(after - expectAfter) <= 0.0001,
      `VCHF debit exact on-chain: ${vchfOnchain} → ${after} (expected ≈ ${expectAfter.toFixed(8)})`);
    const ckusdcE6s = Number(balMap2['2']);
    assert(Number.isFinite(ckusdcE6s) && ckusdcE6s > 0, `ckUSDC credit landed (got ${balMap2?.['2']} e6s)`);
    console.log(`[03-convert-vchf-usdc] ✓ VCHF ${vchfOnchain} → ${after}; ckUSDC ${ckusdcE6s / 1e6}; wall ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.close?.();
  }
}
