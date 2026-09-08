// Flow 100 — Offline cold start renders BOTH bundled native rows (wave: VCHF+ICP, 2026-08-28).
//
// Obligation (9), one flow for both assets: with the relay dead from t=0 (a true cold start — no
// cached catalog, no balances), the wallet still renders the full bundled catalog in the shared
// asset selector, including the two new no-minter native rows with their exact unit · network:
//   * asset-vchf → "VCHF · Internet Computer"
//   * asset-icp  → "ICP · Internet Computer"
// and still NO ramp actions anywhere in the sheet (the bundled rows carry no onramp/offramp).
// Mirrors flow 37's dead-relay onboarding (capability discovery fails closed → no speculative
// faucet request, wallet reaches $0 home).
import {
  setup, assert, assertIncludes, pickFreePort, skipWalkthroughIfPresent, skipRehearsalIfPresent,
  waitForEnabled, chooseHomeCurrencyIfPresent, openBalances,
} from '../harness/lib.mjs';

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '100',
  name: 'offline-bundled-assets',
  journey: 'offline',
  covers: ['offline', 'cold-start', 'bundled-catalog', 'vchf', 'icp', 'icp-mainnet', 'asset-selector', 'no-ramp'],
  verifies: 'A dead-relay cold start (no cached catalog) still renders both bundled native rows in the shared selector — "VCHF · Internet Computer" and "ICP · Internet Computer" — with no ramp actions.',
  timeoutMs: 25000, // dead-relay onboarding retries + balances sheet under parallel load
};

export async function run() {
  const start = Date.now();
  console.log('[100-offline-bundled-assets] setup (web + browser; relay will be dead)…');
  const env = await setup();
  try {
    const { webBaseURL, driver } = env;

    // A port nothing listens on = a relay that refuses every request (flow 37 pattern).
    const deadPort = await pickFreePort();
    const DEAD_RELAY = `http://127.0.0.1:${deadPort}`;
    driver.allowRequestFailuresFrom(DEAD_RELAY);
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(DEAD_RELAY)}`, { timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 10_000 });

    // Manual onboarding (a dead relay advertises no faucet, so none is attempted — the wallet
    // proceeds straight through to the chooser at ∂0/$0).
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-cold-assets', { timeoutMs: 8_000 });
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipRehearsalIfPresent(driver);
    await chooseHomeCurrencyIfPresent(driver);
    await driver.findByTestID('balance', { timeoutMs: 8_000 }); // wallet home mounted at $0

    // Offline indicator (header shows "approx." when online === false).
    assert(await driver.waitForText('approx.', { timeoutMs: 6_000 }), 'header shows the offline approx. indicator');

    // The shared asset selector must show BOTH bundled native rows with exact unit · network.
    console.log('[100-offline-bundled-assets] assert bundled VCHF + ICP rows offline…');
    await openBalances(driver);
    const vchfRow = await driver.findByTestID('asset-vchf', { timeoutMs: 6_000 });
    assert(vchfRow != null, 'offline cold start renders the bundled VCHF row');
    assertIncludes(await driver.readText('asset-vchf'), 'VCHF · Internet Computer', 'offline VCHF row unit · network');
    const icpRow = await driver.findByTestID('asset-icp', { timeoutMs: 6_000 });
    assert(icpRow != null, 'offline cold start renders the bundled ICP row');
    assertIncludes(await driver.readText('asset-icp'), 'ICP · Internet Computer', 'offline ICP row unit · network');
    assertIncludes(await driver.bodyText(), 'Internet Computer', 'selector shows the IC network name');

    // No per-asset ramp actions offline — scoped to the ACCOUNTS LIST, the route the header
    // balance chip opens. That route carries no "Add money" / "Cash out" action of its own, so a
    // hit here can only come from a rail row's on/off-ramp.
    const sheetBody = await driver.readText('accounts-list');
    assert(!sheetBody.includes('Add money'), 'no on-ramp action rendered offline either');
    assert(!sheetBody.includes('Cash out'), 'no off-ramp action rendered offline either');

    await driver.screenshot('100-offline-bundled-assets');
    console.log(`[100-offline-bundled-assets] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('100-offline-bundled-assets RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
