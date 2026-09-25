// Flow 96 — ICP pay journey through the real app (wave: VCHF+ICP support, 2026-08-28).
//
// The ICP twin of flow 95, entering through the CAMERA-SCAN surface (the one-press auto-sign
// entry — the app's intended camera UX) instead of the deeplink review card:
//   * (1) The ICP mainnet row appears in the shared asset selector (the accounts route) with the exact
//         unit + network ("ICP · Internet Computer") and NO ramp actions — no "Add money" /
//         "Cash out" anywhere, and the only btn-topup in the accounts list is DEMO's faucet button.
//   * (3) The payer scans the merchant's request QR — built with the NETTED wire a dpay payee now
//         quotes (typed price − ledger fee, founder rule 2026-09-12: the customer pays exactly the
//         price; the payee nets the fee) — sees the exact unit + price-total on the sign surface
//         and the Paid screen ("1.00000001 ICP" — the total debited: netted wire + ledger fee =
//         the price), and the payment completes end-to-end.
//   * (4) The app signs an icrc1_transfer whose ONLY canister target is ICP's exact ledger
//         principal ryjl3-tyaaa-aaaaa-aaaba-cai (fetch recorder over window.fetch, installed
//         before the scan; every /api/v2/canister/<id>/call checked).
//   * (5) The transfer settles in fake-IC exactly per the founder rule: payee credited the netted
//         wire (99990001 — the fee is the payee's cost), payer debited EXACTLY the price
//         (100000001 = wire + fee, ICP fee 10000 charged on top of the wire), both in-app
//         balances refresh by the exact amount, and NO other currency changes (full 0..8
//         snapshot pre/post both sides).
//   * (7) The payer's Ledger headlines the GROSS: "−1.00000001 ICP" (U+2212 — the typed price,
//         wire + fee, founder rule 2026-09-14) with a "− 0.0001 ICP fees" annotation line +
//         the payee's short principal as counterparty. The rail itself still moved the wire.
//   * Fund-first honesty + real instructions: an UNFUNDED ICP selection parks the Pay tab on the
//         fund panel ("No ICP available" + the practical "first receive ICP at your address" instruction
//         with a primary that opens the ICRC receive-address surface — the wallet's own ICRC-1
//         principal; no onramp and no minter, yet fully receivable by plain transfer).
//
// The deeplink explicit-approve twin (VCHF) is flow 95; the ICP merchant/reconcile twin is 98.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan, waitForScanner, railPrincipalText,
} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import { generateKeypair, randNonceHex, buildRequestQR, decodeRequest } from '../harness/wire.mjs';

const CURRENCY = 8; // ICP
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const SEED = 210000001; // 2.10000001 ICP — covers the price
const PAY = 100000001; // 1.00000001 ICP — the PRICE the customer pays, exactly (8-decimal exactness, odd raw tail)
const FEE = 10000; // ICP catalog fee — the payee's cost, netted out of the quoted wire
const WIRE = PAY - FEE; // 99990001 — the netted wire the payee's request QR carries (price − fee)

/** Snapshot every fake-catalog currency balance (0..8) for one account. */
async function snapBalances(relayBaseURL, accountHex) {
  const out = {};
  for (let c = 0; c <= 8; c++) out[c] = String(await getBalance(relayBaseURL, accountHex, c));
  return out;
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '96',
  name: 'icp-pay',
  journey: 'pay',
  covers: ['icp', 'icp-mainnet', 'asset-selector', 'no-ramp', 'camera-scan', 'auto-sign', 'icrc1-transfer', 'ledger-target', 'settle', 'balance-refresh', 'sibling-isolation', 'ledger-row'],
  verifies: 'ICP (currency 8, ledger ryjl3…) appears in the shared selector with exact unit/network and no ramp actions; an unfunded selection parks on the fund panel with the real "Send ICP to your address" instruction and a primary that opens the ICRC receive-address surface (the wallet\'s own ICRC-1 principal); a scanned netted 1.00000001 ICP request (wire 99990001, what a dpay payee quotes after fee-netting) signs ONLY against the ICP ledger and settles exactly per the founder rule (payee +wire 0.99990001, payer −100000001 = exactly the price, no other currency moves); the payer Ledger headlines the gross −1.00000001 ICP (= the typed price, founder rule 2026-09-14) with a "− 0.0001 ICP fees" annotation line, to the payee short key.',
  timeoutMs: 60000, // currency-first entry adds a Home detour per select
};

export async function run() {
  const start = Date.now();
  console.log('[96-icp-pay] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    // --- Payer onboarding + per-currency context ---------------------------------------------
    console.log('[96-icp-pay] onboarding payer…');
    await onboardWallet(driver, 'e2e-icp-payer');
    const account = await accountOf(driver);

    // (1) Shared asset selector: exact unit/network, no ramp actions.
    console.log('[96-icp-pay] assert accounts-route ICP row (exact unit/network, no ramps)…');
    await openBalances(driver);
    const icpRow = await driver.findByTestID('accounts-currency-ICP', { timeoutMs: 6_000 });
    assert(icpRow != null, 'asset-icp row present in the shared accounts list');
    assertIncludes(await driver.readText('accounts-currency-ICP'), 'ICP · Internet Computer', 'ICP row unit · network');
    assertIncludes(await driver.readText('accounts-currency-CHF'), 'VCHF · Internet Computer', 'VCHF sibling row unit · network');
    const sheetBody = await driver.bodyText();
    assert(!sheetBody.includes('Add money'), 'no on-ramp ("Add money") action on ICP row');
    assert(!sheetBody.includes('Cash out'), 'no off-ramp ("Cash out") action on ICP row');
    const topupCount = await driver.eval(() => document.querySelectorAll('[data-testid="btn-topup"]').length);
    assertEq(String(topupCount), '1', 'exactly one btn-topup in the accounts list (DEMO faucet only — ICP has none)');

    // Select ICP; unfunded selection parks the Pay tab on the fund panel (real top-up
    // instructions — founder hard rule 2026-08-29).
    await selectCurrency(driver, 'icp');
    assertEq(await driver.readText('active-asset-label'), 'Balance ICP', 'chip after the ICP row select (main ICP)');
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    const fundPanel = await driver.findByTestID('pay-fund', { timeoutMs: 6_000 });
    assert(fundPanel != null, 'unfunded ICP selection parks Pay tab on the fund panel');
    const fundBody = await driver.bodyText();
    assertIncludes(fundBody, 'No ICP available', 'fund panel title names ICP');
    assertIncludes(fundBody, 'receive ICP at your address', 'fund panel gives the practical receive-first instruction');
    // Tap through: the primary lands on the Receive ▸ My-address ICRC surface showing THIS
    // wallet's own ICRC-1 principal (founder hard rule 2026-08-29 — real instructions, no dead end).
    await driver.click('pay-fund-go', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('deposit-address', { timeoutMs: 10_000 }) != null, 'primary opens the ICRC receive-address surface');
    const shownAddr = (await driver.readText('deposit-address')).trim();
    assertEq(shownAddr, await railPrincipalText(account.publicHex), 'shown address is the wallet\'s own ICRC-1 principal');
    assertIncludes(await driver.bodyText(), 'No memo or reference needed', 'receive surface carries practical instructions');
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // --- Seed ICP; balances refresh by the exact amount ---------------------------------------
    console.log('[96-icp-pay] faucet 2.10000001 ICP and wait for in-app refresh…');
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);
    await driver.waitForText('2.1 ICP', { timeoutMs: 10_000 }); // ICP is its own currency — the unit IS the token (fork #4)

    const bob = await generateKeypair();
    const aliceBefore = await snapBalances(relayBaseURL, account.publicHex);
    const bobBefore = await snapBalances(relayBaseURL, bob.publicHex);
    assertEq(aliceBefore[CURRENCY], String(SEED), 'payer ICP balance after faucet (raw)');
    assertEq(aliceBefore['0'], '10000', 'payer DEMO balance untouched by ICP faucet');

    // --- (4) Ledger-target recorder, installed before the scan (same session — no reload). ----
    await driver.eval(() => {
      window.__E2E_CANISTER_CALLS = [];
      const orig = window.fetch;
      window.fetch = function patchedFetch(input) {
        try {
          const u = typeof input === 'string' ? input : (input && input.url) || String(input);
          if (u.includes('/api/v2/canister/')) window.__E2E_CANISTER_CALLS.push(u);
        } catch { /* never break the app on a recorder fault */ }
        return orig.apply(this, arguments);
      };
    });

    // --- (3) Camera-scan request: exact unit/amount, auto-sign, Paid --------------------------
    console.log('[96-icp-pay] scan merchant request (price 1.00000001 ICP, wire 0.99990001 → Bob)…');
    const nonce = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, WIRE, nonce, expiry, CURRENCY, 'Bob');
    const decoded = decodeRequest(requestQR);
    assertEq(decoded.currency, CURRENCY, 'request QR carries ICP currency id');
    assertEq(decoded.amount, String(WIRE), 'request QR carries the netted wire (price − fee) in exact raw ICP units');

    await armPayScan(driver); // no-op when already armed
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);
    await driver.waitForText('Paid', { timeoutMs: 12_000 }); // camera path auto-signs (one-press rule)
    assertIncludes(await driver.bodyText(), '1.00000001 ICP', 'paid screen shows the total debited — exactly the typed price (netted wire + fee), compact');

    // (4) Every canister call the app made targets ICP's exact ledger principal.
    const seen = (await driver.eval(() => window.__E2E_CANISTER_CALLS ?? [])) || [];
    const calls = seen.filter((u) => u.endsWith('/call')); // ignore /read_state status polls
    assert(calls.length >= 1, `app made at least one icrc1_transfer call (saw ${JSON.stringify(seen)})`);
    const prefix = `${relayBaseURL}/api/v2/canister/`;
    for (const u of calls) {
      assert(u.startsWith(prefix), `canister call goes through the relay gateway (${u})`);
      const canister = u.slice(prefix.length).replace(/\/call$/, '');
      assertEq(canister, ICP_LEDGER, 'icrc1_transfer envelope target canister');
    }

    // --- (5) Exact settlement + sibling isolation ---------------------------------------------
    console.log('[96-icp-pay] assert exact settlement + sibling isolation…');
    const aliceAfter = await snapBalances(relayBaseURL, account.publicHex);
    const bobAfter = await snapBalances(relayBaseURL, bob.publicHex);
    assertEq(bobAfter[CURRENCY], String(WIRE), 'payee credited the netted wire (fee is the payee\'s cost, founder rule)');
    assertEq(aliceAfter[CURRENCY], String(SEED - PAY), 'payer debited EXACTLY the price (wire + fee; the customer never moves more than the price)');
    for (const c of Object.keys(aliceBefore)) {
      if (c !== String(CURRENCY)) assertEq(aliceAfter[c], aliceBefore[c], `payer sibling currency ${c} unchanged`);
    }
    for (const c of Object.keys(bobBefore)) {
      if (c !== String(CURRENCY)) assertEq(bobAfter[c], bobBefore[c], `payee sibling currency ${c} unchanged`);
    }

    // In-app refresh by the exact amount: header shows the price-debited remainder.
    await driver.waitForText('1.1 ICP', { timeoutMs: 10_000 });
    await driver.click('btn-new', { timeoutMs: 5_000 }); // dismiss Paid → header is clickable again
    await openBalances(driver);
    assertIncludes(await driver.readText('accounts-currency-ICP'), '1.1 ICP', 'Home accounts ICP row refreshed to post-pay amount');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'DEMO row unchanged in the accounts list');
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // --- (7) Ledger outgoing row ---------------------------------------------------------------
    console.log('[96-icp-pay] assert Ledger outgoing row…');
    await openHistory(driver);
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const named = await driver.waitForText('to Bob', { timeoutMs: 10_000 });
    const bodyText = await driver.bodyText();
    assert(named, `ledger row names the payee via the request-QR annotation ("to Bob"). ledger:\n${bodyText.slice(0, 500)}`);
    assertIncludes(bodyText, '\u22121.00000001 ICP', 'ledger outgoing row headlines the GROSS (U+2212 minus + the typed price = wire + fee, founder rule 2026-09-14)');
    assertIncludes(bodyText, '\u2212 0.0001 ICP fees', 'ledger row carries the fee as its annotation line — never inside the headline');
    assert(!bodyText.includes(bobPrincipal), 'ledger row never dumps the full principal');
    assert(!bodyText.includes(bob.publicHex), 'ledger row shows only the annotation name, never the full hex');

    await driver.screenshot('96-icp-pay');
    console.log(`[96-icp-pay] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('96-icp-pay RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
