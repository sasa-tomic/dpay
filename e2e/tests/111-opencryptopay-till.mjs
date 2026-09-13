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
//      destination account, and ONE provider line: the FIAT PRICE the till is charging ("CHF 1" —
//      the crypto amount alone is uncheckable against the sale) beside the HOST that set it, which
//      is what attributes the number to the provider rather than to dpay. Proven by money, not by
//      pixels: the payer's ledger balance is unchanged while that review is on screen.
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
// Selector contract: `ocp-checking`, `ocp-price`, `ocp-expiry`, `ocp-outcome`,
// `pay-amount`, `review-payee`, `btn-approve`, `btn-new`, `btn-start-scan`,
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
// NATIVE ICP is the asset that pays here, and it is the one whose block index is reported BARE:
// measured 2026-09-04, the prefixed `<ledger>:<index>` spelling resolves nothing on the ICP ledger,
// while every other ICRC ledger requires it (`ocpIcTxId`; findings doc). Flow 113 pays VCHF and pins
// the other half — between them both spellings are asserted on the wire.
const ICP = 8;
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // == the OCP menu's ICP ledger (findings, identity check)
const ICP_SEED = 500_000_001; // 5.00000001 ICP — covers two payments and their fees. The odd last
                              // digit is deliberate: the header trims trailing zeros, so a round seed
                              // renders as a prefix of other numbers and the wait below could pass early.
const ICP_FEE = 10_000;       // the ICP catalog fee, charged to the sender
const PAY_RAW = 50_795_551;   // the till's 0.50795551 ICP at 8 decimals — the exact amount that must move
const CKUSDC = 2;             // the asset the till does NOT take (leg 1); funded so no fund-gate fires
const CKUSDC_SEED = 5_000_000;

export const meta = {
  id: '111',
  name: 'opencryptopay-till',
  journey: 'pay',
  covers: ['opencryptopay', 'scan-fallback', 'explicit-approve', 'loss-path', 'unresolved-outcome', 'one-shot-submit', 'honest-instructions', 'fail-closed'],
  verifies: 'Scanning a merchant OpenCryptoPay till resolves a live quote and lands on an explicit review (full destination, plus ONE line carrying the fiat price the till charges and the host that set it, with no countdown while there is runway) that never auto-signs; Approve moves the funds and reports the proof once → Paid; a settled transfer whose single proof submission is indefinite renders as UNRESOLVED with the ledger block index, no retry and no "paid"; a till that does not take the selected asset is refused by name with the switch-in-Balances instruction and costs no quote.',
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

    for (const [currency, amount] of [[ICP, ICP_SEED], [CKUSDC, CKUSDC_SEED]]) {
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
        'InternetComputer/ICP': `icp:${ICP_LEDGER}/transfer?to=${merchantPrincipal}&amount=0.50795551`,
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
    // instruction. Solana USDC is absent for the measured reason (its URI names no token account),
    // and VEUR because this wallet carries no row for it.
    for (const id of ['ic:1', 'ic:7', 'ic:8']) {
      assert(await driver.isPresent(`ocp-option-${id}`), `the menu must offer ${id} — the till lists it and this wallet carries it`);
    }
    assertIncludes(await driver.readText('ocp-option-ic:8'), '0.50805551 ICP', 'the option states its total debit (amount + catalog fee)');
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
    await driver.click('ocp-option-ic:8');
    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    // The total debit (amount + ledger fee) needs the async icrc1_fee round trip — WAIT for it.
    assert(await driver.waitForText('Pay 0.50805551 ICP', {timeoutMs: 15_000}),
      'the picked review must reach the fee-inclusive total');
    assertEq(await driver.readText('pay-amount'), 'Pay 0.50805551 ICP',
      'picking ICP off the menu reviews ICP — never the ckUSDC the payer had selected');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the picked review still shows the FULL destination account');
    console.log('[111-opencryptopay-till] ✓ menu offered on one read, and picking pays the picked asset');
    await driver.click('btn-review-cancel');

    // --- 2. the review: never auto-signs, and says who priced it -------------------------------
    console.log('[111-opencryptopay-till] leg 2 — scanning the till with ICP selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('5.00000001 ICP', {timeoutMs: 10_000}), 'the app must see the ICP seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver);

    // Two provider reads take real time. The wallet says what it is doing rather than freezing.
    assert(await driver.findByTestID('ocp-checking', {timeoutMs: 8_000}) != null,
      'the wallet must say it is checking with the provider while the reads are in flight');
    assertIncludes(await driver.readText('ocp-checking'), 'payment provider',
      'the waiting message names who is being asked');

    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    assert(await driver.waitForText('Pay 0.50805551 ICP', {timeoutMs: 15_000}),
      'the review must reach the fee-inclusive total debit');
    assertEq(await driver.readText('pay-amount'), 'Pay 0.50805551 ICP',
      'the review shows the till\'s quoted amount + the ledger fee, converted at ICP\'s own precision');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the review shows the FULL destination account — the one thing on screen the payer can check');
    // ONE provider line, carrying both facts. WHAT THE TILL IS CHARGING, in the till's own unit:
    // `0.50795551 ICP` is uncheckable against a price tag; "CHF 1" is the number printed on the
    // till and read out by the cashier, and without it the payer approves an amount they cannot
    // compare against the price of the sale. And WHO SET IT — an LNURL can name any host on earth,
    // so naming the host is both the trust fact and the attribution that keeps the fiat number the
    // provider's rather than dpay's.
    const price = await driver.readText('ocp-price');
    assertEq(price, `CHF 1 · price from ${PROVIDER_HOST}`,
      'the review states the till\'s own price and the host that set it, in one line');
    // The policy sentences that used to sit here are gone (founder, 2026-09-09): a payer at a till
    // cannot act on "dpay doesn't convert" or on being told a merchant name is unverified.
    assert(!price.includes('convert'), 'the price line must not carry a policy sentence');
    assert(!(await driver.isPresent('review-claimed')), 'the review carries no unactionable name caveat');
    // The countdown stays OFF while there is runway. A 300s quote leaves minutes; a countdown then
    // changes nothing a payer would do and is one more thing to read at a checkout. It appears
    // inside the last minute, where it IS the reason to hurry (pinned in jest, which can set the
    // deadline; here the honest assertion is that a live quote shows no clock).
    assert(!(await driver.isPresent('ocp-expiry')),
      'a quote with minutes left must not put a countdown on the review');
    assertIncludes(await driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the name the till claims');

    // NEVER AUTO-SIGNS — proven with money, not pixels: the Approve press is still pending and the
    // payer's ledger balance has not moved. (A scanned dpay REQUEST does auto-sign, by design; this
    // code came from a stranger, so it may not.)
    assert(await driver.isPresent('btn-approve'), 'a scanned till must still require an explicit Approve press');
    assertEq(await getBalance(relayBaseURL, accountHex, ICP), String(ICP_SEED),
      'nothing may leave the wallet before the payer approves');
    await driver.screenshot('111-ocp-review');
    console.log('[111-opencryptopay-till] ✓ explicit review, one price+host line, no countdown noise, no auto-sign');

    // --- 3. paid ------------------------------------------------------------------------------
    console.log('[111-opencryptopay-till] leg 3 — approving…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    assert(await driver.waitForText('Paid ✓ 0.50805551 ICP', {timeoutMs: 20_000}),
      'an accepted submission renders the paid state with the exact amount');
    assert(!(await driver.isPresent('ocp-outcome')),
      'a clean payment carries no unresolved note — that surface is for the loss path alone');
    assertEq(await getBalance(relayBaseURL, accountHex, ICP), String(ICP_SEED - PAY_RAW - ICP_FEE),
      'the payer is debited the till\'s exact amount plus the ledger fee');

    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '1', 'the proof is reported EXACTLY once — the provider grants one attempt');
    const submitted = new URL(seen.txUrls[0]);
    assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`,
      'the submission goes to the /tx path derived from the callback\'s /cb/ segment');
    assertEq(submitted.searchParams.get('method'), 'InternetComputer', 'the submission echoes the provider\'s method spelling');
    assertEq(submitted.searchParams.get('asset'), 'ICP', 'the submission echoes the provider\'s asset spelling');
    // BARE, with no ledger prefix — the spelling the NATIVE ICP ledger requires and the only one it
    // answers to (measured 2026-09-04; the prefixed form resolves nothing there). Flow 113 pins the
    // prefixed spelling every other ICRC ledger requires.
    assert(/^\d+$/.test(submitted.searchParams.get('tx') ?? ''),
      `a native ICP index is reported bare, got ${submitted.searchParams.get('tx')}`);
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
    assertIncludes(body, 'Sent 0.50805551 ICP', 'the unresolved outcome is the honest pending headline');
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
    assertEq(await getBalance(relayBaseURL, accountHex, ICP), String(ICP_SEED - 2 * (PAY_RAW + ICP_FEE)),
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
