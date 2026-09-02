#!/usr/bin/env node
// LIVE OpenCryptoPay probe — the real app, driven against the REAL provider. NETWORK REQUIRED.
//
// This is NOT part of `just verify` and must never be: the inner loop is offline by design, and
// flows 111/112 cover this feature against `harness/ocp.mjs`, a fail-closed stub that REFUSES any
// request to api.dfx.swiss. That stub is what keeps the suite honest and fast — and it is also the
// reason a wrong belief about the provider's payload could sit behind 107 green flows indefinitely.
// It did: `parsePaymentDetails` refused every body carrying an empty `assets` array, which the live
// provider sends on every response, so no real till was payable while everything was green (review
// ledger row 16). No fixture could have caught that, because the fixture WAS the wrong belief.
//
// So this probe closes exactly one gap: it points the shipped app at the real thing and reads what
// comes back. It runs the REAL parser, the REAL provider client and the REAL review screen against
// a live 300-second quote from the public CHF-1 test till.
//
// IT NEVER SPENDS MONEY, BY CONSTRUCTION. It stops at the review — the screen whose entire purpose
// is that it has not signed anything yet — and never presses Approve. The wallet it drives is a
// throwaway identity funded by the local relay's faucet, not the agent float, so even a mistake
// here could only move play money on a FakeLedger. Fetching a quote costs nothing and commits
// nothing; the provider mints a fresh one on every read and lets the old one expire.
//
//   node e2e/live-ocp-probe.mjs
//
// Green means: the live body parsed, the live quote resolved to the exact ICP transfer the app
// would sign, and the review rendered it. It does NOT mean a payment would be accepted — the one
// unprovable leg is the `/tx` submission, which cannot be exercised without irreversibly paying.
import {
  setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, armPayScan,
} from './harness/lib.mjs';
import { PROVIDER_HOST, TILL_QR } from './harness/ocp.mjs';

const ICP = 8;                 // the till's `InternetComputer` menu offers ICP; the agent float holds it
const ICP_SEED = 210_000_001;  // 2.10000001 ICP — comfortably over the ~0.5 ICP the CHF-1 till asks

const start = Date.now();
console.log('[live-ocp] setup (relay + web + browser)…');
console.log(`[live-ocp] provider: ${PROVIDER_HOST} — REAL network calls will be made`);
const env = await setup();
let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };

try {
  const { driver, relayBaseURL } = env;

  await onboardWallet(driver, 'live-ocp-probe');
  const identity = await accountOf(driver);
  const accountHex = identity?.publicHex;
  assert(typeof accountHex === 'string' && accountHex.length === 64, 'wallet must have a 32-byte hex pubkey');

  // Local play money on the relay's FakeLedger — enough that the balance gate does not park the Pay
  // tab on the fund-first panel. Nothing here touches a real ledger.
  const fund = await faucetAccount(relayBaseURL, accountHex, ICP_SEED, { currency: ICP });
  assert(fund.ok, `faucet must fund ICP, got HTTP ${fund.status}`);

  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  assert(await driver.waitForText('2.10000001 ICP', { timeoutMs: 10_000 }), 'the app must see the ICP seed before Pay can scan');
  await driver.click('tab-pay');

  console.log('[live-ocp] scanning the live till — two real provider round trips…');
  await armPayScan(driver);
  await driver.eval((qr) => { window.__DPAY_TEST_SCAN(qr); }, TILL_QR);

  // The review is the outcome. Generous timeout: two live HTTPS round trips to Switzerland.
  const review = await driver.findByTestID('btn-approve', { timeoutMs: 30_000 });
  if (review === null) {
    bad('no review rendered — the live quote did not resolve');
    console.error('[live-ocp] screen said:\n' + (await driver.bodyText()));
  } else {
    ok('the live quote resolved to a review — the app never auto-signed');

    const amount = await driver.readText('pay-amount');
    const payee = await driver.readText('review-payee');
    const host = await driver.readText('ocp-host');
    const requested = await driver.readText('ocp-requested');
    console.log(`\n  amount   ${amount}`);
    console.log(`  payee    ${payee}`);
    console.log(`  host     ${host}`);
    console.log(`  charging ${requested}\n`);

    assertIncludes(host, PROVIDER_HOST, 'the review must name the live provider host');
    assertIncludes(requested, 'CHF 1', "the review must show the till's own price");
    // The destination is DFX's real receiving principal, and it must be rendered in FULL — it is the
    // one value on the screen a payer can independently check.
    assert(/^[a-z0-9-]{20,}$/.test(payee.trim()), `the full destination principal must render, got "${payee}"`);
    assertIncludes(amount, 'ICP', 'the amount must be denominated in the selected asset');
    ok('amount, full destination, provider host and the till’s fiat price all rendered');
  }

  await driver.screenshot('live-ocp-review');
  // Belt and braces: assert we are still ON the review, i.e. nothing was submitted.
  assert(await driver.isPresent('btn-approve'), 'the probe must end on the review, having signed nothing');
  ok('ended on the review — nothing signed, nothing sent, no money moved');
} catch (e) {
  bad(`probe threw: ${e.stack || e.message || e}`);
} finally {
  await env.stop().catch(() => {});
}

console.log(`\n[live-ocp] ${failed === 0 ? 'GREEN' : 'RED'} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
process.exit(failed === 0 ? 0 : 1);
