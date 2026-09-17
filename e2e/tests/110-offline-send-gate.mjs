// Flow 110 — offline, "Send to address" says so up front and points at the rail that still works.
//
// The Pay tab's two halves have OPPOSITE connectivity truths and only one of them was ever stated.
// Scan-to-pay is dpay's signature rail: the payer signs in airplane mode and the MERCHANT's phone
// submits. An address send has no counterparty — this phone submits it — so it is the one Pay-tab
// action airplane mode genuinely blocks.
//
// Before this, offline it rendered the full form anyway: the ledger fee query failed silently, Max
// went disabled with no reason given, and the failure only arrived after Confirm as a raw error
// string. That is a dead end that describes itself instead of instructing (founder rule 2026-08-29).
//
// This flow proves the fix against the REAL app with a genuinely dead relay + gateway:
//   1. offline, the send form is REPLACED by the instruction — no address field, no amount field,
//      nothing to fill in against a rail that cannot carry it;
//   2. the instruction names the way out, and its primary actually goes there (Scan to pay), which
//      is the honest advice: the offline rail is the one dpay was built for;
//   3. back online, the form returns — the gate is connectivity and nothing else, so this can never
//      silently become a permanent block on an asset.
//
// Selector contract: `asset-vchf-select`, `btn-pay-send`, `pay-send-offline`, `pay-send-offline-go`,
// `send-address-input`, `btn-start-scan`.
import {
  setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, goOffline, setRelay,
} from '../harness/lib.mjs';

const CURRENCY = 7;       // VCHF — a send-capable direct-ICRC row
const SEED = 500_000_000; // 5.00000000 VCHF: funded, so the zero-balance gate cannot mask this one

export const meta = {
  id: '110',
  name: 'offline-send-gate',
  journey: 'offline',
  covers: ['offline', 'send-to-address', 'error-handling', 'graceful'],
  verifies: 'Offline, Pay ▸ Send to address replaces the form with an instruction naming the constraint and routing to Scan to pay (the rail that works offline); the form returns when the connection does.',
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[110-offline-send-gate] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL} = env;

    console.log('[110-offline-send-gate] onboarding (online)…');
    await onboardWallet(driver, 'e2e-offsend');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // Funded, because the zero-balance fund-first gate ALSO replaces the send form: without funds
    // this flow would pass against the wrong panel and prove nothing about connectivity.
    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, {currency: CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    // VCHF: a send-capable asset, so the "Send to address" toggle exists at all. (DEMO has no
    // on-chain identity and therefore no toggle — it could not exercise this gate.)
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');

    // Online first — the form is the baseline this flow shows being replaced and restored.
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    await driver.findByTestID('send-address-input', {timeoutMs: 10_000});
    console.log('[110-offline-send-gate] ✓ online: the send form renders');

    console.log('[110-offline-send-gate] going offline (dead relay + dead gateway)…');
    await goOffline(driver);

    await driver.findByTestID('pay-send-offline', {timeoutMs: 15_000});
    assert(
      !(await driver.isPresent('send-address-input')),
      'offline, the destination field must be GONE — an address typed against an unreachable ledger can only fail after the fact',
    );
    const panel = await driver.readText('pay-send-offline');
    assertIncludes(panel, 'connection', 'the offline instruction names the constraint');
    assertIncludes(panel, 'scan', 'the offline instruction names the rail that still works');
    console.log(`[110-offline-send-gate] ✓ offline: form replaced by an instruction — "${panel.slice(0, 80)}…"`);
    await driver.screenshot('110-offline-send-gate');

    // The primary is the way out, not decoration: it must land on the scan surface, whose pay-intent
    // gate (btn-start-scan) is the proof we are actually there.
    await driver.click('pay-send-offline-go');
    await driver.findByTestID('btn-start-scan', {timeoutMs: 10_000});
    console.log('[110-offline-send-gate] ✓ the instruction\'s primary lands on Scan to pay');

    // Back online: the gate is connectivity alone. If it were anything else — a capability check, a
    // balance read — the form would stay gone and an asset would be silently unsendable.
    console.log('[110-offline-send-gate] restoring the relay…');
    await setRelay(driver, relayBaseURL);
    await driver.click('btn-pay-send');
    await driver.findByTestID('send-address-input', {timeoutMs: 15_000});
    assert(!(await driver.isPresent('pay-send-offline')), 'the offline instruction must clear once the connection is back');
    console.log('[110-offline-send-gate] ✓ back online: the send form returns');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[110-offline-send-gate] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[110-offline-send-gate] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
