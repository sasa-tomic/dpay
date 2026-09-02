// Flow 111 — paying a real merchant's OpenCryptoPay till, with the LOSS PATH pinned.
//
// OpenCryptoPay is the first payment code in this wallet that dpay did not design: a shop's till
// shows a static LNURL, an outside provider prices it, and the payer moves irreversible funds
// BEFORE the provider is told about them — and is granted exactly ONE chance to tell it
// (`docs/specs/2026-09-01-opencryptopay-findings.md`, "The loss path"). Everything this flow asserts
// follows from that asymmetry.
//
// Four legs, in the order a payer meets them:
//
//   1. REFUSED, with the next action. The till does not take the selected asset (ckUSDC — measured
//      absent from the live provider's menu). The wallet names what it chose, what the till DOES
//      take in the wallet's own words, and where to change it. It also asks the provider exactly
//      ONCE and never requests a destination it could not pay: a refusal must not cost a quote.
//   2. IT NEVER AUTO-SIGNS. A scanned till lands on an explicit review carrying the amount, the FULL
//      destination account, the provider HOST the price came from, the countdown, the FIAT PRICE the
//      till is charging ("CHF 1" — the crypto amount alone is uncheckable against the sale), and the
//      merchant name marked as CLAIMED. Proven by money, not by pixels: the payer's ledger balance is
//      unchanged while that review is on screen.
//   3. PAID. Approve → the funds move on the IC rail → the proof is reported once → the paid state.
//   4. UNRESOLVED — the important one. The transfer settles on-chain and the ONE submission does not
//      come back definitive. That is neither paid nor failed: the outcome screen must show the block
//      index that proves the transfer, must tell the payer not to pay again, and must offer no
//      retry — because the provider burns both the quote and the transaction id on a failed
//      submission, so a second attempt cannot succeed and only destroys the user's ability to claim
//      the payment. The flow asserts the money really left AND that exactly one /tx call was made.
//
// The till fixture and the fail-closed provider stub live in `../harness/ocp.mjs` — one till, shared
// with flow 112 (the same code paid on the Solana rail). Fixture provenance is documented there.
//
// Selector contract: `ocp-checking`, `ocp-host`, `ocp-expiry`, `ocp-requested`, `ocp-outcome`,
// `review-claimed`, `pay-amount`, `review-payee`, `btn-approve`, `btn-new`, `btn-start-scan`,
// `ocp-choose`, `ocp-option-<assetId>`, `btn-review-cancel`
// (via armPayScan).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';
import {
  installTillStub, ocpStubState, setOcpTxMode,
  CLAIMED_MERCHANT, PAYMENT_ID, PROVIDER_HOST, TILL_QR,
} from '../harness/ocp.mjs';

// --- the wallet side ------------------------------------------------------------------------------
const VCHF = 7;               // the asset that pays: a direct-ICRC row, settled by icrc1_transfer
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai'; // == the OCP menu's VCHF ledger (findings, identity check)
const VCHF_SEED = 500_000_000; // 5.00000000 VCHF — covers two 1.— payments and their fees
const VCHF_FEE = 10_000;       // the VCHF catalog fee, charged to the sender
const PAY_RAW = 100_000_000;   // the till's `1.` VCHF at 8 decimals — the exact amount that must move
const CKUSDC = 2;             // the asset the till does NOT take (leg 1); funded so no fund-gate fires
const CKUSDC_SEED = 5_000_000;

export const meta = {
  id: '111',
  name: 'opencryptopay-till',
  journey: 'pay',
  covers: ['opencryptopay', 'scan-fallback', 'explicit-approve', 'claimed-name', 'loss-path', 'unresolved-outcome', 'one-shot-submit', 'honest-instructions', 'fail-closed'],
  verifies: 'Scanning a merchant OpenCryptoPay till resolves a live quote and lands on an explicit review (provider host, full destination, countdown, the fiat price the till charges, claimed merchant name) that never auto-signs; Approve moves the funds and reports the proof once → Paid; a settled transfer whose single proof submission is indefinite renders as UNRESOLVED with the ledger block index, no retry and no "paid"; a till that does not take the selected asset is refused by name with the switch-in-Balances instruction and costs no quote.',
  timeoutMs: 45000, // 4 legs: 3 provider round trips (one deliberately slow) + 2 real IC settlements
};

/** Point the camera at the till code (arming the pay-intent gate first — the shared choke point). */
async function scanTill(driver) {
  await armPayScan(driver);
  await driver.eval((qr) => { window.__DPAY_TEST_SCAN(qr); }, TILL_QR);
}

export async function run() {
  const start = Date.now();
  console.log('[111-opencryptopay-till] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[111-opencryptopay-till] onboarding…');
    await onboardWallet(driver, 'e2e-ocp');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64,
      `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // The till's destination. SYNTHETIC (see the header): the findings doc redacts the middle of the
    // principal it recorded, so the fixture uses a real, CRC-valid principal of the same form — the
    // app runs it through the core validator (`icpValidatePrincipal`) before the payer sees it.
    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);
    console.log(`[111-opencryptopay-till] till destination: ${merchantPrincipal}`);

    for (const [currency, amount] of [[VCHF, VCHF_SEED], [CKUSDC, CKUSDC_SEED]]) {
      const fund = await faucetAccount(relayBaseURL, accountHex, amount, {currency});
      assert(fund.ok, `faucet funding of currency ${currency} must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);
    }

    await installTillStub(driver, {
      passOrigins: [new URL(relayBaseURL).origin, new URL(webBaseURL).origin],
      // Deliberately slow: the two provider reads take real time on a screen the payer just pointed
      // at a QR, and leg 2 asserts the wallet says so instead of freezing.
      detailsDelayMs: 1_000,
      uris: {
        // `icp:<LEDGER>/transfer?to=<PRINCIPAL>&amount=<DECIMAL>` — the live shape, NOT the README's.
        // The amount is the same `1.` the menu quoted: the provider does not re-price inside a quote,
        // so the wallet treats any disagreement as a hard refusal.
        'InternetComputer/VCHF': `icp:${VCHF_LEDGER}/transfer?to=${merchantPrincipal}&amount=1.`,
      },
    });

    // --- 1. the till does not take the selected asset ------------------------------------------
    // ckUSDC is dpay's stated launch rail and the live provider does NOT accept it — the refusal a
    // real payer will actually hit. It must name what was chosen, what the till takes in the
    // WALLET's words, and the one action available (founder rule 2026-08-29).
    console.log('[111-opencryptopay-till] leg 1 — scanning the till with ckUSDC selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'ckusdc');
    // The header carries the ACTIVE asset's balance, so this is the gate that the app has seen the
    // seed — without it a zero balance would park the Pay tab on the fund panel and there would be
    // no scanner to point at the till (a green flow that proved nothing about the refusal).
    assert(await driver.waitForText('5.00 USDC', {timeoutMs: 10_000}), 'the app must see the ckUSDC seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver);

    assert(await driver.findByTestID('ocp-choose', {timeoutMs: 12_000}) != null,
      'a till that does not take the selected asset must offer the ones it does');
    let body = await driver.bodyText();
    assertIncludes(body, 'This till doesn’t take USDC', 'the menu names the asset the payer had selected');
    assertIncludes(body, 'dpay never swaps', 'the menu must state that picking is not a conversion');
    // Every IC offer this wallet can pay, each with the amount IN ITS OWN UNITS — the price differs
    // per asset, so a menu of bare names would be a choice made blind. SOL is payable too but is
    // NOT here: taking it would unmount this rail's Pay screen mid-payment, so it stays a Balances
    // instruction. Solana USDC is absent for the measured reason (its URI names no token account).
    for (const [id, amount] of [['ic:1', '0.00001600 BTC'], ['ic:7', '1.00000000 VCHF'], ['ic:8', '0.50795551 ICP']]) {
      assert(await driver.isPresent(`ocp-option-${id}`), `the menu must offer ${id}`);
      assertIncludes(await driver.readText(`ocp-option-${id}`), amount, `the ${id} option states its own exact amount`);
    }
    assert(!(await driver.isPresent('ocp-option-solana:SOL')), 'the menu must not offer an asset on the other rail');
    assert(!(await driver.isPresent('pay-amount')), 'the menu must never render a payment review');
    assert(!(await driver.isPresent('btn-approve')), 'the menu must never render an Approve button');

    // Offering a menu must be CHEAP: one read, and no destination requested for an asset the payer
    // has not chosen — a quote spent on an unchosen asset is a quote the real payment lacks.
    let seen = await ocpStubState(driver);
    assertEq(String(seen.calls.length), '1', 'offering the menu costs exactly one provider read');
    assertIncludes(seen.calls[0], 'timeout=0', 'the details read asks for the current charge, never a long poll');
    assertEq(String(seen.txUrls.length), '0', 'nothing before the funds move may touch the submission endpoint');
    await driver.screenshot('111-ocp-choose');

    // PICKING pays the chosen asset, not the one that was selected in Balances.
    await driver.click('ocp-option-ic:7');
    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('pay-amount'), 'Pay 1.00000000 VCHF',
      'picking VCHF off the menu reviews VCHF — never the ckUSDC the payer had selected');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the picked review still shows the FULL destination account');
    console.log('[111-opencryptopay-till] ✓ menu offered on one read, and picking pays the picked asset');
    await driver.click('btn-review-cancel');

    // --- 2. the review: never auto-signs, and says who priced it -------------------------------
    console.log('[111-opencryptopay-till] leg 2 — scanning the till with VCHF selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    assert(await driver.waitForText('5.00 VCHF', {timeoutMs: 10_000}), 'the app must see the VCHF seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver);

    // Two provider reads take real time. The wallet says what it is doing rather than freezing.
    assert(await driver.findByTestID('ocp-checking', {timeoutMs: 8_000}) != null,
      'the wallet must say it is checking with the provider while the reads are in flight');
    assertIncludes(await driver.readText('ocp-checking'), 'payment provider',
      'the waiting message names who is being asked');

    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('pay-amount'), 'Pay 1.00000000 VCHF',
      'the review shows the till\'s exact quoted amount, converted at VCHF\'s own precision');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the review shows the FULL destination account — the one thing on screen the payer can check');
    assertEq(await driver.readText('ocp-host'), `Price from ${PROVIDER_HOST}`,
      'the review names the host the price came from (an LNURL can name any host on earth)');
    assertIncludes(await driver.readText('review-claimed'), 'Name given by the code',
      'the merchant name is marked as claimed, never as verified');
    // WHAT THE TILL IS CHARGING, in the till's own unit. `1.00000000 VCHF` is uncheckable against a
    // price tag; "CHF 1" is the number printed on the till and read out by the cashier, and without
    // it the payer approves an amount they cannot compare against the price of the sale. It is the
    // PROVIDER's figure and the line says so — dpay neither quotes nor converts.
    const charging = await driver.readText('ocp-requested');
    assertIncludes(charging, 'The merchant is charging CHF 1.',
      'the review must show the till\'s own price, so the payer can check it against the sale');
    assertIncludes(charging, 'dpay doesn’t convert',
      'the fiat ask must be attributed to the merchant\'s provider, never presented as a dpay quote');
    const expiry = await driver.readText('ocp-expiry');
    assert(/^Valid for ~\d+ min$/.test(expiry), `the review counts the 300s quote down, got ${JSON.stringify(expiry)}`);
    assertIncludes(await driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the name the till claims');

    // NEVER AUTO-SIGNS — proven with money, not pixels: the Approve press is still pending and the
    // payer's ledger balance has not moved. (A scanned dpay REQUEST does auto-sign, by design; this
    // code came from a stranger, so it may not.)
    assert(await driver.isPresent('btn-approve'), 'a scanned till must still require an explicit Approve press');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED),
      'nothing may leave the wallet before the payer approves');
    await driver.screenshot('111-ocp-review');
    console.log('[111-opencryptopay-till] ✓ explicit review, host + claimed name + countdown, no auto-sign');

    // --- 3. paid ------------------------------------------------------------------------------
    console.log('[111-opencryptopay-till] leg 3 — approving…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    assert(await driver.waitForText('Paid ✓ 1.00000000 VCHF', {timeoutMs: 20_000}),
      'an accepted submission renders the paid state with the exact amount');
    assert(!(await driver.isPresent('ocp-outcome')),
      'a clean payment carries no unresolved note — that surface is for the loss path alone');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED - PAY_RAW - VCHF_FEE),
      'the payer is debited the till\'s exact amount plus the ledger fee');

    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '1', 'the proof is reported EXACTLY once — the provider grants one attempt');
    const submitted = new URL(seen.txUrls[0]);
    assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`,
      'the submission goes to the /tx path derived from the callback\'s /cb/ segment');
    assertEq(submitted.searchParams.get('method'), 'InternetComputer', 'the submission echoes the provider\'s method spelling');
    assertEq(submitted.searchParams.get('asset'), 'VCHF', 'the submission echoes the provider\'s asset spelling');
    assert(/^\d+$/.test(submitted.searchParams.get('tx') ?? ''),
      `the submission reports a real ledger block index, got ${submitted.searchParams.get('tx')}`);
    console.log(`[111-opencryptopay-till] ✓ paid; proof reported once as block ${submitted.searchParams.get('tx')}`);
    await driver.screenshot('111-ocp-paid');

    // --- 4. UNRESOLVED: the money moved, the sale is not credited ------------------------------
    // The single submission comes back indefinite. This is neither paid nor failed, and the payer's
    // only remaining asset is the block index — so it must be on screen, with an instruction NOT to
    // pay again (the quote and the transaction id are both spent; a retry cannot succeed).
    console.log('[111-opencryptopay-till] leg 4 — the submission never answers…');
    await setOcpTxMode(driver, 'indefinite');
    await driver.click('btn-new', {timeoutMs: 5_000});
    await scanTill(driver);
    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});

    const note = await driver.findByTestID('ocp-outcome', {timeoutMs: 25_000});
    assert(note != null, 'an indefinite submission must render the unresolved outcome, not an error toast');
    const outcome = await driver.readText('ocp-outcome');
    assertIncludes(outcome, 'neither paid nor failed', 'the outcome is stated as neither paid nor failed');
    assertIncludes(outcome, 'don’t pay again', 'the payer is told NOT to pay again');
    const ref = /ledger block (\d+)/.exec(outcome);
    assert(ref != null, `the outcome must show the on-chain reference that proves the transfer, got ${JSON.stringify(outcome)}`);

    body = await driver.bodyText();
    assert(!body.includes('Paid ✓'), 'an unresolved payment must NEVER render as paid');
    assertIncludes(body, 'Sent 1.00000000 VCHF', 'the unresolved outcome is the honest pending headline');
    // …and it says what it is waiting on IN ITS OWN WORDS. The offline hand-off's "awaiting the
    // merchant's confirmation" line must NOT be borrowed here: that state resolves by waiting, this
    // one never does — the transfer is final and only the merchant can credit it, which is what the
    // note above says. Two different pending states, two different instructions.
    assert(!body.includes('awaiting the merchant’s confirmation'),
      'an OpenCryptoPay outcome must not borrow the offline hand-off\'s wait-and-see line — nothing here resolves by waiting');
    assertIncludes(body, `to ${CLAIMED_MERCHANT}`, 'the unresolved outcome still names who the money went to');
    // Not invited to pay again: no Approve, no review, and no receipt to hand back (there is no
    // accepted payment to share). `btn-new` starts a DIFFERENT payment; it does not retry this one.
    assert(!(await driver.isPresent('btn-approve')), 'the unresolved outcome must not offer an Approve to press again');
    assert(!(await driver.isPresent('pay-amount')), 'the unresolved outcome must not fall back to a re-payable review');
    assert(!(await driver.isPresent('btn-share-receipt')), 'there is no settlement receipt to share for an uncredited payment');

    // The money REALLY left — that is what makes "don't pay again" the honest instruction — and the
    // one submission was spent, not retried by any caller.
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(VCHF_SEED - 2 * (PAY_RAW + VCHF_FEE)),
      'the unresolved transfer really settled on-chain: the funds left the wallet');
    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '2', 'the indefinite submission is attempted ONCE and never retried');
    assertEq(new URL(seen.txUrls[1]).searchParams.get('tx'), ref[1],
      'the block index shown to the payer is the one that was reported');
    console.log(`[111-opencryptopay-till] ✓ unresolved, block ${ref[1]} shown, no retry offered`);
    await driver.screenshot('111-ocp-unresolved');

    // Nothing ever escaped toward the real provider.
    assertEq(JSON.stringify(seen.unexpected), '[]', 'no request may reach an origin outside the fixture table');

    console.log(`[111-opencryptopay-till] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[111-opencryptopay-till] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
