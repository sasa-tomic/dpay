// Flow 95 — VCHF pay journey through the real app (wave: VCHF+ICP support, 2026-08-28).
//
// Covers the VCHF obligations of the spec's e2e matrix that ride the PAYER side of the shared
// IC rail, in one journey (deeplink-entry variant — the explicit-approve surface):
//   * (1) The VCHF mainnet row appears in the shared asset selector (the accounts route) with the exact
//         unit + network ("VCHF · Internet Computer") and NO ramp actions — no "Add money" /
//         "Cash out" anywhere, and the only btn-topup in the accounts list is DEMO's faucet button.
//   * (3) The payer opens a VCHF payment link, sees the exact unit + amount
//         ("Pay 1.00010001 VCHF" — the total debit: amount + ledger fee), the payee short key + merchant name — and the request does NOT
//         auto-sign: the deeplink entry keeps the full review card with a single explicit Approve.
//   * (4) The app signs an icrc1_transfer whose ONLY canister target is VCHF's exact ledger
//         principal ly36x-wiaaa-aaaai-aqj7q-cai (asserted via a fetch recorder installed over
//         window.fetch BEFORE approving — every /api/v2/canister/<id>/call the app makes is
//         checked against the expected principal).
//   * (5) The transfer settles in fake-IC: payee is credited the exact raw amount, payer is debited
//         amount + fee (VCHF fee 10000, charged to the sender like ckUSDC), both in-app balances
//         refresh by the exact amount, and NO other currency changes (full 0..8 balance snapshot
//         compared pre/post for both sides).
//   * (7) The payer's Ledger shows the outgoing row: "−1.00000001 VCHF" (U+2212) + the payee's
//         short principal as counterparty.
//   * Fund-first honesty + real instructions: an UNFUNDED VCHF selection parks the Pay tab on the
//         fund panel ("No VCHF available" + the practical "first receive VCHF at your address"
//         instruction
//         with a primary that opens the ICRC receive-address surface — the wallet's own ICRC-1
//         principal; no onramp and no minter, yet fully receivable by plain transfer).
//
// The camera-scan twin (auto-sign one-press entry) for ICP is flow 96; the VCHF merchant/reconcile
// twin is flow 97.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan, waitForScanner, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair, randNonceHex } from '../harness/wire.mjs';

const CURRENCY = 7; // VCHF
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const SEED = 210000001; // 2.10000001 VCHF — covers pay + fee
const PAY = 100000001; // 1.00000001 VCHF — 8-decimal exactness (odd raw tail)
const FEE = 10000; // VCHF catalog fee, charged to the sender

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
  id: '95',
  name: 'vchf-pay',
  journey: 'pay',
  covers: ['vchf', 'icp-mainnet', 'asset-selector', 'no-ramp', 'deeplink', 'explicit-approve', 'icrc1-transfer', 'ledger-target', 'settle', 'balance-refresh', 'sibling-isolation', 'ledger-row'],
  verifies: 'VCHF (currency 7, ledger ly36x…) appears in the shared selector with exact unit/network and no ramp actions; an unfunded selection parks on the fund panel with the real "first receive VCHF at your address" instruction and a primary that opens the ICRC receive-address surface (the wallet\'s own ICRC-1 principal); a 1.00000001 VCHF deeplink request reviews with the total debit (amount + ledger fee, compact) in exact unit and signs ONLY against the VCHF ledger; the transfer settles exactly (payee +amount, payer −amount−fee, no other currency moves); the payer Ledger shows −1.00000001 VCHF to the payee short key.',
  timeoutMs: 25000, // full-suite parallel load: onboard + 2 snapshots ×2 actors + deeplink reload + settle polls
};

export async function run() {
  const start = Date.now();
  console.log('[95-vchf-pay] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, webBaseURL, driver } = env;

    // --- Payer onboarding + per-currency context ---------------------------------------------
    console.log('[95-vchf-pay] onboarding payer…');
    await onboardWallet(driver, 'e2e-vchf-payer');
    const account = await accountOf(driver);

    // (1) Shared asset selector: exact unit/network, no ramp actions.
    console.log('[95-vchf-pay] assert accounts-route VCHF row (exact unit/network, no ramps)…');
    await openBalances(driver);
    const vchfRow = await driver.findByTestID('asset-vchf', { timeoutMs: 6_000 });
    assert(vchfRow != null, 'asset-vchf row present in the shared accounts list');
    assertIncludes(await driver.readText('asset-vchf'), 'VCHF · Internet Computer', 'VCHF row unit · network');
    assertIncludes(await driver.readText('asset-icp'), 'ICP · Internet Computer', 'ICP sibling row unit · network');
    const sheetBody = await driver.bodyText();
    assert(!sheetBody.includes('Add money'), 'no on-ramp ("Add money") action on VCHF row');
    assert(!sheetBody.includes('Cash out'), 'no off-ramp ("Cash out") action on VCHF row');
    const topupCount = await driver.eval(() => document.querySelectorAll('[data-testid="btn-topup"]').length);
    assertEq(String(topupCount), '1', 'exactly one btn-topup in the accounts list (DEMO faucet only — VCHF has none)');

    // Select VCHF; unfunded selection parks the Pay tab on the fund panel WITH real top-up
    // instructions (founder hard rule 2026-08-29: no "check back soon" dead ends — receiving a
    // no-minter direct-ICRC asset is a plain ICRC-1 transfer to the user's own principal).
    await selectCurrency(driver, 'vchf');
    // VCHF is the rail of CHF, and the harness preamble picks CHF as the main currency — so the
    // header names the CURRENCY, not the token (the home-currency model, 2026-09-04; flow 118 owns
    // that behaviour). The AMOUNT below still carries the VCHF unit, which the balance assertions
    // in this flow check directly.
    assertEq(await driver.readText('active-asset-label'), 'Swiss francs · Main', 'header active-asset label after VCHF select');
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    const fundPanel = await driver.findByTestID('pay-fund', { timeoutMs: 6_000 });
    assert(fundPanel != null, 'unfunded VCHF selection parks Pay tab on the fund panel');
    const fundBody = await driver.bodyText();
    assertIncludes(fundBody, 'No VCHF available', 'fund panel title names VCHF');
    assertIncludes(fundBody, 'receive VCHF at your address', 'fund panel gives the practical receive-first instruction');
    // Tap through: the primary lands on the Receive ▸ My-address ICRC surface, which shows THIS
    // wallet's own ICRC-1 account (its self principal) + the no-memo instruction.
    await driver.click('pay-fund-go', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('deposit-address', { timeoutMs: 10_000 }) != null, 'primary opens the ICRC receive-address surface');
    const shownAddr = (await driver.readText('deposit-address')).trim();
    assertEq(shownAddr, await railPrincipalText(account.publicHex), 'shown address is the wallet\'s own ICRC-1 principal');
    assertIncludes(await driver.bodyText(), 'No memo or reference needed', 'receive surface carries practical instructions');
    assert(await driver.findByTestID('btn-receive-request', { timeoutMs: 4_000 }) != null, 'the Request/My-address toggle is present for VCHF');
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // --- Seed VCHF; both balances refresh by the exact amount --------------------------------
    console.log('[95-vchf-pay] faucet 2.10000001 VCHF and wait for in-app refresh…');
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);
    await driver.waitForText('2.10000001 VCHF', { timeoutMs: 10_000 }); // header balance (exact units)

    const bob = await generateKeypair();
    const aliceBefore = await snapBalances(relayBaseURL, account.publicHex);
    const bobBefore = await snapBalances(relayBaseURL, bob.publicHex);
    assertEq(aliceBefore[CURRENCY], String(SEED), 'payer VCHF balance after faucet (raw)');
    assertEq(aliceBefore['0'], '10000', 'payer DEMO balance untouched by VCHF faucet');

    // --- Payment link: exact unit/amount review, explicit approve, exact ledger target --------
    //     The link names VCHF on the Internet Computer explicitly, so the 8-decimal amount is
    //     converted at VCHF's own precision — the odd raw tail below proves no rounding anywhere.
    console.log('[95-vchf-pay] open the VCHF payment link (1.00000001 VCHF → Bob)…');
    const nonce = randNonceHex();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    await driver.navigate(
      webBaseURL,
      `/wallet/pay/${bobPrincipal}?asset=VCHF&network=internet-computer&amount=1.00000001&label=Bob&ref=${nonce}`
        + `&relay=${encodeURIComponent(relayBaseURL)}`,
      { waitUntil: 'domcontentloaded', timeoutMs: 8_000 },
    );
    await driver.waitReady({ timeoutMs: 10_000 });

    const payAmount = await driver.findByTestID('pay-amount', { timeoutMs: 6_000 });
    assert(payAmount != null, 'the payment link reaches the review card');
    await driver.waitForText('Pay 1.00010001 VCHF', { timeoutMs: 6_000 });
    assertIncludes(await driver.readText('pay-amount'), 'Pay 1.00010001 VCHF', 'review shows the total debit — exact unit, amount + ledger fee, compact');
    assertEq(await driver.readText('review-payee'), bobPrincipal, 'review shows the full destination account');
    assertIncludes(await driver.bodyText(), 'Bob', 'review shows the label the link carried');
    assert(!(await driver.bodyText()).match(/\bPaid\b/), 'a payment link must NOT auto-sign (no Paid before Approve)');

    // (4) Ledger-target recorder: installed AFTER the reload (window state resets), BEFORE approve.
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

    console.log('[95-vchf-pay] approve…');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    await driver.waitForText('Paid', { timeoutMs: 12_000 });
    assertIncludes(await driver.bodyText(), '1.00010001 VCHF', 'paid screen shows the total debited (amount + ledger fee), compact');

    // (4) Every canister call the app made targets VCHF's exact ledger principal.
    const seen = (await driver.eval(() => window.__E2E_CANISTER_CALLS ?? [])) || [];
    const calls = seen.filter((u) => u.endsWith('/call')); // ignore /read_state status polls
    assert(calls.length >= 1, `app made at least one icrc1_transfer call (saw ${JSON.stringify(seen)})`);
    const prefix = `${relayBaseURL}/api/v2/canister/`;
    for (const u of calls) {
      assert(u.startsWith(prefix), `canister call goes through the relay gateway (${u})`);
      const canister = u.slice(prefix.length).replace(/\/call$/, '');
      assertEq(canister, VCHF_LEDGER, 'icrc1_transfer envelope target canister');
    }

    // --- (5) Exact settlement + sibling isolation ---------------------------------------------
    console.log('[95-vchf-pay] assert exact settlement + sibling isolation…');
    const aliceAfter = await snapBalances(relayBaseURL, account.publicHex);
    const bobAfter = await snapBalances(relayBaseURL, bob.publicHex);
    assertEq(bobAfter[CURRENCY], String(PAY), 'payee credited exact VCHF amount (no fee for receiver)');
    assertEq(aliceAfter[CURRENCY], String(SEED - PAY - FEE), 'payer debited amount + fee (fee charged to sender)');
    for (const c of Object.keys(aliceBefore)) {
      if (c !== String(CURRENCY)) {
        assertEq(aliceAfter[c], aliceBefore[c], `payer sibling currency ${c} unchanged`);
      }
    }
    for (const c of Object.keys(bobBefore)) {
      if (c !== String(CURRENCY)) {
        assertEq(bobAfter[c], bobBefore[c], `payee sibling currency ${c} unchanged`);
      }
    }

    // In-app refresh by the exact amount: header shows the post-fee remainder, payee row in the accounts list.
    await driver.waitForText('1.0999 VCHF', { timeoutMs: 10_000 });
    await driver.click('btn-new', { timeoutMs: 5_000 }); // dismiss Paid → header is clickable again
    await openBalances(driver);
    assertIncludes(await driver.readText('asset-vchf'), '1.0999 VCHF', 'accounts-list VCHF row refreshed to post-pay amount');
    assertIncludes(await driver.readText('asset-demo'), '∂100.00', 'DEMO row unchanged in the accounts list');
    await driver.click('tab-pay', { timeoutMs: 4_000 });

    // --- (7) Ledger outgoing row ---------------------------------------------------------------
    console.log('[95-vchf-pay] assert Ledger outgoing row…');
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    const named = await driver.waitForText('to Bob', { timeoutMs: 10_000 });
    const bodyText = await driver.bodyText();
    assert(named, `ledger row names the payee via the link-label annotation ("to Bob"). ledger:\n${bodyText.slice(0, 500)}`);
    assertIncludes(bodyText, '\u22121.00000001 VCHF', 'ledger outgoing row amount (U+2212 minus + exact units)');
    assert(!bodyText.includes(bobPrincipal), 'ledger row never dumps the full principal');
    assert(!bodyText.includes(bob.publicHex), 'ledger row shows only the annotation name, never the full hex');

    await driver.screenshot('95-vchf-pay');
    console.log(`[95-vchf-pay] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('95-vchf-pay RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
