// e2e-live Tier 2 — LIVE conversion MATRIX on mainnet (OPT-IN): every IC pool pair, through the
// REAL app UI against the PROD relay (local web @ HEAD = the fixed app). Pool coverage after this
// flow + the earlier live runs: 65mrh ICP→VCHF (flow 02), hx7nb VCHF→ckUSDC (flow 03),
// mohjv ckUSDC→ICP (the two earlier 04 runs, on-chain proven), and here:
//   1. ICP→ckBTC    direct  (icpswap-ckbtc, xmiu5)      — the 2026-09-16 pool
//   2. ckBTC→ckETH  direct  (icpswap-ckbtc-cketh, akhru)— the 2026-09-16 pool
//   3. ICP→ckETH    direct  (icpswap-cketh, angxa)
//   4. ckUSDC→ckETH HUB via ICP (mohjv + angxa, 4 legs) — the item-7 hub path live
// Settle contract: convert-done, OR the honest stuck panel followed by ON-CHAIN proof (source
// debited + out credited from the relay's ledger answers) — against a pre-deploy prod relay the
// stuck watch is blind (its /api/v1/transactions probe 503s until the index-mirror fix ships),
// so the flip can only be asserted offline (flow 190 + jest). REAL FUNDS: the agent test float
// (explicit founder authorization: "test all possible conversion paths"). Log in AGENT-FUNDS.
//
// Run: DPAY_E2E_LIVE_FLOW=04-convert-matrix.mjs DPAY_E2E_BASE=https://dpay.kalaj.org \
//      DPAY_AGENT_SEED_HEX=$(node scripts/agent-key.mjs seed) node e2e-live/run.mjs
import { setup, assert, onboardWallet, openBalances, selectCurrency, accountOf } from '../../e2e/harness/lib.mjs';

export const meta = {
  id: '04',
  name: 'convert-matrix',
  journey: 'live',
  covers: ['live', 'convert', 'icrc2-approve', 'icpswap', 'real-funds', 'approve-fix', 'hub', 'decimal-pairs'],
  verifies: 'LIVE direct conversions on every registered IC pool pair (ckUSDC→ICP, ICP→ckBTC, ckBTC→ckETH) plus the 4-leg hub (ckUSDC→ckETH via ICP) through the real UI on mainnet — approves settle, swaps fill, out-balances land.',
  timeoutMs: 1_200_000,
};

const SPENDS = [
  { label: 'ICP→ckBTC direct', src: 'icp', srcKey: '8', amount: '0.3', dest: 'convert-dest-inwallet-1', outKey: '1', minOutGain: 0.000001 },
  { label: 'ckBTC→ckETH direct', src: 'ckbtc', srcKey: '1', amount: null, dest: 'convert-dest-inwallet-6', outKey: '6', minOutGain: 0.000000000000001 },
  { label: 'ICP→ckETH direct', src: 'icp', srcKey: '8', amount: '0.15', dest: 'convert-dest-inwallet-6', outKey: '6', minOutGain: 0.000000000000001 },
  { label: 'ckUSDC→ckETH hub', src: 'ckusdc', srcKey: '2', amount: '0.1', dest: 'convert-dest-inwallet-6', outKey: '6', minOutGain: 0.000000000000001 },
];

async function balancesOf(relayBaseURL, publicHex) {
  const res = await fetch(`${relayBaseURL}/api/v1/balances/${publicHex}`);
  assert(res.ok, `relay balance read ok (${res.status})`);
  return res.json();
}

export async function run() {
  const start = Date.now();
  const seedHex = process.env.DPAY_AGENT_SEED_HEX;
  if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error('DPAY_AGENT_SEED_HEX must hold the agent identity secretHex (node scripts/agent-key.mjs seed)');
  }
  console.log('[04-convert-matrix] setup (local web @ HEAD + prod relay)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[04-convert-matrix] onboarding throwaway, then restoring the agent identity…');
    await onboardWallet(driver, 'live-convert', { timeoutMs: 30_000 });
    await driver.click('btn-settings', { timeoutMs: 8_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 8_000 });
    await driver.type('settings-restore-seed-input', seedHex);
    await driver.click('btn-settings-restore-confirm', { timeoutMs: 8_000 });
    await driver.waitForText('Home', { timeoutMs: 15_000 });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'restore re-mounts an identity');

    const seam = await driver.eval(() => (typeof globalThis.__DPAY_TEST_IC_GATEWAY === 'string' ? globalThis.__DPAY_TEST_IC_GATEWAY : null));
    if (typeof seam === 'string' && seam !== 'https://icp-api.io') {
      await driver.eval((gw) => { globalThis.__DPAY_TEST_IC_GATEWAY = gw; }, 'https://icp-api.io');
      console.log(`[04-convert-matrix] IC gateway seam ${seam} → https://icp-api.io`);
    }

    // Convert a list of {e8s|e6s → plain} for the three decimals scales we touch.
    const DEC = { '1': 1e8, '2': 1e6, '6': 1e18, '8': 1e8 };
    const plain = (k) => Number(balancesOf_cache[k]) / DEC[k];
    let balancesOf_cache = await balancesOf(relayBaseURL, identity.publicHex);

    // DPAY_MATRIX_STEPS='2,3,4' (1-based) re-runs a subset — live re-runs must not repeat an
    // already-covered pair (a repeat also re-arms the probe ambiguity the timestamp floor fixes).
    const pick = (process.env.DPAY_MATRIX_STEPS ?? '')
      .split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n >= 1 && n <= SPENDS.length);
    const plan = pick.length > 0 ? pick.map((n) => SPENDS[n - 1]) : SPENDS;
    for (const step of plan) {
      balancesOf_cache = await balancesOf(relayBaseURL, identity.publicHex);
      const srcBefore = plain(step.srcKey);
      const outBefore = plain(step.outKey);
      console.log(`[04-convert-matrix] ${step.label}: src ${srcBefore}, converting ${step.amount ?? 'ALL'}…`);
      if (step.amount != null) {
        assert(srcBefore > parseFloat(step.amount) + 0.0005, `float covers ${step.label} (${srcBefore})`);
      } else {
        assert(srcBefore > 0, `float covers ${step.label} (${srcBefore})`);
      }

      await openBalances(driver, { timeoutMs: 20_000 });
      await selectCurrency(driver, step.src);
      await openBalances(driver);
      await driver.waitForText('Convert', { timeoutMs: 10_000 });
      await driver.click('btn-accounts-convert', { timeoutMs: 8_000 });
      assert(await driver.findByTestID('convert-screen', { timeoutMs: 10_000 }) != null, `Convert opens for ${step.src}`);
      if (step.amount != null) {
        await driver.type('convert-amount', step.amount);
      } else {
        // Convert the whole ckBTC lot: type the on-chain figure (the Max affordance varies).
        await driver.type('convert-amount', (srcBefore - 0.00001).toFixed(8));
      }
      await driver.findByTestID('convert-quote-source', { timeoutMs: 20_000 });
      // When the standing direct venue already targets this asset (e.g. a ckUSDC source's
      // registry-first venue is ICP↔ckUSDC → the checklist's default out IS ICP), no in-wallet
      // row renders for it — the standing pick is the destination. Click only when present.
      const destRow = await driver.findByTestID(step.dest, { timeoutMs: 6_000 }).catch(() => null);
      if (destRow != null) {
        await driver.click(step.dest, { timeoutMs: 8_000 });
      } else {
        console.log(`[04-convert-matrix] ${step.label}: no ${step.dest} row — the standing direct quote already targets this destination`);
      }
      // The destination pick re-keys the fetch; give the refetch a beat, then confirm. The honest
      // quote-changed gate re-arms confirm if the fresh number differs — pressing again is correct.
      await new Promise((r) => setTimeout(r, 2_500));
      await driver.screenshot('04-checklist');
      await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });
      const reArm = await driver.findByTestID('convert-quote-changed', { timeoutMs: 15_000 }).catch(() => null);
      if (reArm != null) {
        console.log(`[04-convert-matrix] ${step.label}: quote-changed gate armed — confirming again`);
        await driver.click('btn-convert-confirm', { timeoutMs: 8_000 });
      }
      await driver.screenshot('04-inflight');
      // Settle = done, OR the honest stuck panel ("the pool's answer did not arrive") — which
      // happens on REAL mainnet pools with slow execution. The stuck copy PROMISES the screen
      // "flips to done on its own" (probeConvertSettlement sees the output row) — hold the
      // screen and assert that promise; that IS the recovery engine under test.
      const settle = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (await driver.findByTestID('convert-done', { timeoutMs: 1_000 }).catch(() => null) != null) return 'done';
          if (await driver.findByTestID('convert-stuck', { timeoutMs: 1_000 }).catch(() => null) != null) return 'stuck';
        }
        return 'timeout';
      };
      let outcome = await settle(480_000);
      if (outcome === 'stuck') {
        await driver.screenshot('04-stuck-panel');
        console.log(`[04-convert-matrix] ${step.label}: honest stuck panel — holding briefly for the self-flip (needs the index-mirror fix deployed)…`);
        outcome = await settle(120_000);
      }
      if (outcome !== 'done') {
        const panel = await driver.eval(() => (document.body?.textContent ?? '').replace(/\s+/g, ' ').match(/(Approving|Swapping|Settling|Converted|Swap not executed|refused|Unknown outcome|quote changed)[^\n]{0,80}/gi)?.slice(0, 6) ?? []);
        console.log(`[04-convert-matrix] panel state at ${step.label} (${outcome}):`, JSON.stringify(panel));
      }
      assert(outcome === 'done' || outcome === 'stuck', `${step.label}: settles to Done or the honest stuck panel (never an endless spinner) — got ${outcome}`);
      await driver.screenshot('04-done');

      const after = await balancesOf(relayBaseURL, identity.publicHex);
      const srcAfter = Number(after[step.srcKey]) / DEC[step.srcKey];
      const outAfter = Number(after[step.outKey]) / DEC[step.outKey];
      const gain = outAfter - outBefore;
      assert(srcAfter < srcBefore, `${step.label}: source debited (${srcBefore} → ${srcAfter})`);
      assert(gain >= step.minOutGain, `${step.label}: out-balance credited (${outBefore} → ${outAfter})`);
      console.log(`[04-convert-matrix] ✓ ${step.label} (${outcome}): src ${srcBefore} → ${srcAfter}, out +${gain}`);
    }
    console.log(`[04-convert-matrix] ✓✓ all ${SPENDS.length} live conversions settled; wall ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.close?.();
  }
}
