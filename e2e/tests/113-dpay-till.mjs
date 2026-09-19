// Flow 113 — one dpay wallet pays a dpay TILL: the payment that was impossible until this flow.
//
// dpay's relay serves its own OpenCryptoPay till, and it offers exactly one pair —
// `InternetComputer` / `VCHF` (`crates/dpay-relay/src/till.rs`; the bytes it puts on the wire are
// pinned in `dfx/till_wire.json`). So this is the flow where a NON-ICP Internet Computer asset is
// paid at a till and the proof is reported — which makes it the end-to-end guard for the identifier
// that cost a real payment on 2026-09-03: an index on any ledger but the native ICP one has to be
// reported `<ledger>:<index>`, or the provider looks it up on the ICP ledger and the sale is never
// credited (`docs/specs/2026-09-01-opencryptopay-findings.md`, measured again 2026-09-04). Leg 1
// asserts the exact string that goes on the wire; flow 111 asserts the BARE spelling native ICP
// still requires, so the two flows together pin both halves of the rule.
//
// Two legs:
//
//   1. PAYABLE, and paid. The till's own code lands on the explicit review (the VCHF amount, the
//      FULL destination account, the relay host as the price's source, the merchant's claimed name,
//      the CHF price the till is charging, the note the merchant signed at ring-up — what the
//      charge is for) and signs nothing until Approve. Approve moves real VCHF
//      — asserted as money on both sides of the ledger, not as pixels — and reports the proof
//      exactly once → Paid ✓.
//   2. PENDING IS NOT PAID. dpay's till answers a submission `202 {"status":"PENDING"}` while it has
//      not yet matched the transfer in the merchant's own ledger history. The transfer is on-chain
//      and the report was taken, so this is neither paid nor failed: the screen must say sent-and-
//      waiting with the reference, must not claim the sale, and must not invite a second payment.
//
// The till fixture is READ from the committed golden, not authored here (`../harness/ocp.mjs`).
//
// Selector contract: `ocp-price`, `ocp-expiry`, `ocp-outcome`,
// `pay-amount`, `review-payee`, `review-memo`, `btn-approve`, `btn-new` (and `btn-start-scan` via
// armPayScan).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, armPayScan, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';
import { installTillStub, ocpStubState, setOcpTxMode, DPAY_TILL, dpayTillAt } from '../harness/ocp.mjs';

const VCHF = 7;                 // the ONE asset dpay's till takes
const FEE = 10_000;             // the VCHF catalog fee, charged to the sender (flow 95)
// What the payer signs, and what the SHOP receives: a CHF 10.00 charge less the ledger fee the
// shop absorbs, so the payer's account moves by exactly CHF 10.00 (`LEDGER_FEE_RAW`, till.rs).
// Checked against the golden below, which is the relay's own recording of that arithmetic.
const PAY_RAW = 999_990_000;
const SEED = 2_000_020_001;     // 20.00020001 VCHF: two payments + two fees, with an odd tail so the
                                // header's balance can never match a prefix of another number
const SEED_TEXT = '20.00020001 VCHF';
const PAY_TEXT = '10.00 VCHF'; /* the review/paid rendering: the TOTAL DEBIT — the till prices the fee in, so the total IS the shelf price — compact (VCHF min 2 fraction digits). Wire amount is PAY_RAW; the diff is the ledger fee the till absorbs. */

export const meta = {
  id: '113',
  name: 'dpay-till',
  journey: 'pay',
  covers: ['opencryptopay', 'tx-ledger-spelling', 'vchf', 'explicit-approve', 'one-shot-submit', 'pending-not-paid', 'honest-instructions', 'charge-reference', 'signed-note', 'settle'],
  verifies: 'A dpay wallet pays a dpay-served OpenCryptoPay till: the till offers only InternetComputer/VCHF and the payer pays it — the explicit review shows the VCHF amount, the full destination, that relay as the price\'s host, the claimed merchant name, the CHF price and the note the merchant signed at ring-up (what the charge is for), and Approve moves the exact VCHF (payer −amount−fee, merchant +amount) carrying the till\'s per-charge `ref` as the transfer\'s on-chain memo, then reports the proof exactly once — as `<vchf ledger>:<block index>`, the spelling a non-ICP ICRC ledger requires and the one whose absence cost a real payment — → Paid ✓. A submission the till answers 202 PENDING renders as sent-and-waiting with the ledger reference — never as paid, never as failed, and never with a second submission.',
  timeoutMs: 47000, // 2 legs: 4 provider round trips + 2 real IC settlements
};

/** Point the camera at the till's code (arming the pay-intent gate first — the shared choke point).
 *  dpay's ring-up hands the merchant three spellings of one address (`dfx/till_wire.json`, `open`);
 *  this flow scans the plain `https://…/v1/lnurlp/<id>` endpoint, admitted by its `/lnurlp/` path
 *  segment. The bech32 spelling and its `?lightning=` wrapper are exercised where they can be
 *  proven against the relay's own encoder rather than the harness's — `app/__tests__/tillWire.test.ts`
 *  — and the wrapper's scan branch is flow 111's. */
async function scanTill(driver, qr) {
  await armPayScan(driver);
  await driver.eval((code) => { window.__DPAY_TEST_SCAN(code); }, qr);
}

export async function run() {
  const start = Date.now();
  console.log('[113-dpay-till] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL, webBaseURL} = env;
    // The golden states the raw units its decimal amount means; every balance below is arithmetic on
    // that number, so a till that changes its price fails HERE with the reason, not in an assertion
    // about a screen.
    assertEq(DPAY_TILL.amountRaw, String(PAY_RAW), 'the till golden must still quote the amount this flow funds for');

    console.log('[113-dpay-till] onboarding…');
    await onboardWallet(driver, 'e2e-dpay-till');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64,
      `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // The MERCHANT's own account — the destination the till's step-3 URI names. dpay holds no key
    // for it and never stands between the two.
    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, {currency: VCHF});
    assert(fund.ok, `faucet funding of VCHF must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    // Served from the host the wallet talks to — which is precisely what makes it payable.
    const till = dpayTillAt(relayBaseURL, merchantPrincipal);
    console.log(`[113-dpay-till] till at ${till.host}: ${DPAY_TILL.amount} ${DPAY_TILL.asset} → ${merchantPrincipal}`);
    await installTillStub(driver, {
      passOrigins: [new URL(relayBaseURL).origin, new URL(webBaseURL).origin],
      ...till.cfg,
    });

    // --- 1. the till dpay serves is payable, and paying it moves real money -------------------
    console.log('[113-dpay-till] leg 1 — scanning our own till with VCHF selected…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    // The header carries the ACTIVE asset's balance, so this is the gate that the app has SEEN the
    // seed: without it a zero balance parks the Pay tab on the fund panel and there is no scanner to
    // point at the till — a green flow that proved nothing.
    assert(await driver.waitForText(SEED_TEXT, {timeoutMs: 10_000}),
      'the app must see the VCHF seed before the Pay tab can scan');
    await driver.click('tab-pay');
    assert(!(await driver.isPresent('pay-fund')), 'a funded asset must reach the scan surface, not the fund-first panel');
    await scanTill(driver, till.qr);

    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    // THE ASSERTION THIS FLOW EXISTS FOR. Before the trust rule this screen was a refusal reading
    // "dpay can't confirm that this provider would credit VCHF" — about dpay's own relay.
    // The total (amount + ledger fee) needs the async icrc1_fee round trip, so WAIT for it —
    // reading the node the instant it mounts can still show the pre-fee fallback.
    assert(await driver.waitForText(`Pay ${PAY_TEXT}`, {timeoutMs: 15_000}),
      'the review must reach the fee-inclusive total debit');
    assertEq(await driver.readText('pay-amount'), `Pay ${PAY_TEXT}`,
      'the review shows the till\'s exact quoted amount, in the one asset that till takes');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the review shows the FULL destination account — the merchant\'s own, not dpay\'s');
    // ONE provider line, and it names the host even when that host is our OWN relay — a dpay till
    // is not exempt from the trust disclosure it asks of every other provider.
    const price = await driver.readText('ocp-price');
    assertIncludes(price, `${DPAY_TILL.requestedAmount.asset} 10`,
      'the review shows the till\'s own price, so the payer can check it against the sale');
    assertIncludes(price, till.host, 'the review names the host that set the price');
    assertIncludes(await driver.bodyText(), DPAY_TILL.merchant, 'the review shows the name the till claims');
    // The ring-up's NOTE — what the charge is for, signed under `dpay-till-open-v2` when the
    // merchant rang the charge up and served back on step-2 (`input.note` of the same golden every
    // other value here comes from). Claimed, never verified: it rides the review's memo line.
    assertEq(await driver.readText('review-memo'), DPAY_TILL.note,
      'the review shows what the till says the charge is for — the note the merchant signed at ring-up');
    assert(!(await driver.isPresent('review-claimed')), 'the review carries no unactionable name caveat');
    assert(!(await driver.isPresent('ocp-expiry')),
      'a quote with minutes left must not put a countdown on the review');
    assert(await driver.isPresent('btn-approve'), 'a scanned till must still require an explicit Approve press');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(SEED),
      'nothing may leave the wallet before the payer approves');
    await driver.screenshot('113-dpay-till-review');

    console.log('[113-dpay-till] leg 1 — approving…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    assert(await driver.waitForText(`Paid ✓ ${PAY_TEXT}`, {timeoutMs: 20_000}),
      'an accepted submission renders the paid state with the exact amount');
    assert(!(await driver.isPresent('ocp-outcome')), 'a credited sale carries no unresolved note');
    assertEq(await getBalance(relayBaseURL, accountHex, VCHF), String(SEED - PAY_RAW - FEE),
      'the payer is debited the till\'s exact amount plus the ledger fee');
    assertEq(await getBalance(relayBaseURL, merchant.publicHex, VCHF), String(PAY_RAW),
      'the MERCHANT is credited the exact amount — the sale really happened on the ledger');

    // THE REFERENCE, end to end. dpay's till puts a per-charge `ref` on its step-3 URI and credits
    // only a transfer whose ICRC-1 memo carries it. So the payer must have signed THAT memo, and
    // the proof is the merchant's own history read back through the relay's exact-memo filter —
    // the same reconciliation the Receive tab uses. A payment without it would settle on-chain and
    // never be credited to the sale.
    const byRef = await fetch(
      `${relayBaseURL}/api/v1/transactions/${merchant.publicHex}?currency=${VCHF}&memo=${DPAY_TILL.ref}`,
    ).then(r => r.json());
    assertEq(String(byRef.transactions?.length ?? 0), '1',
      `exactly one transfer must carry the till's reference ${DPAY_TILL.ref}, got ${JSON.stringify(byRef)}`);
    assertEq(byRef.transactions[0].amount, String(PAY_RAW),
      'the referenced transfer is the one that paid the charge');

    let seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '1', 'the proof is reported exactly once');
    const submitted = new URL(seen.txUrls[0]);
    assertEq(submitted.pathname, `/v1/lnurlp/tx/${DPAY_TILL.paymentId}`,
      'the submission goes to the /tx path derived from the callback\'s /cb/ segment');
    assertEq(submitted.searchParams.get('method'), DPAY_TILL.method, 'the submission echoes the till\'s method');
    assertEq(submitted.searchParams.get('asset'), DPAY_TILL.asset, 'the submission echoes the till\'s asset');
    // THE IDENTIFIER, in full. Not a shape check: the LEDGER has to be this till's own, because a
    // bare index here is exactly the 2026-09-03 defect — the provider would resolve it against the
    // native ICP ledger, find something that is not this sale, and the payer's VCHF would be gone.
    const reportedTx = submitted.searchParams.get('tx') ?? '';
    assert(new RegExp(`^${DPAY_TILL.ledger}:\\d+$`).test(reportedTx),
      `the submission must name the till's own ledger beside the block index, got ${JSON.stringify(reportedTx)}`);
    console.log(`[113-dpay-till] ✓ paid; ${reportedTx} reported once`);
    await driver.screenshot('113-dpay-till-paid');

    // --- 2. the till says PENDING: reported, not credited ------------------------------------
    console.log('[113-dpay-till] leg 2 — the till answers 202 PENDING…');
    await setOcpTxMode(driver, 'pending');
    await driver.click('btn-new', {timeoutMs: 5_000});
    await scanTill(driver, till.qr);
    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});

    assert(await driver.findByTestID('ocp-outcome', {timeoutMs: 25_000}) != null,
      'a PENDING answer must render the honest outcome note, not silence and not a toast');
    const outcome = await driver.readText('ocp-outcome');
    assertIncludes(outcome, 'hasn’t matched this sale yet', 'the note says the provider has the report but has not matched the sale yet');
    assertIncludes(outcome, 'don’t pay again', 'the payer is told not to pay twice');
    assert(/ledger block \d+/.test(outcome),
      `the note carries the reference that proves the transfer, got ${JSON.stringify(outcome)}`);
    // NOT paid: the 2xx said the opposite of paid, so the screen may not claim the sale…
    const body = await driver.bodyText();
    assert(!body.includes('Paid ✓'), 'a PENDING submission must NEVER render as paid');
    assertIncludes(body, `Sent ${PAY_TEXT}`, 'the honest headline is that the money was sent');
    // …and NOT failed either: it really moved, and it moved to the merchant.
    assertEq(await getBalance(relayBaseURL, merchant.publicHex, VCHF), String(PAY_RAW * 2),
      'the pending payment really settled: the merchant holds both transfers');
    assert(!(await driver.isPresent('btn-approve')), 'the pending outcome must not offer an Approve to press again');
    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '2', 'a pending answer is reported once and never retried from here');
    // …and the second submission spells the identifier the same way. One rule, every submission.
    assert(new RegExp(`^${DPAY_TILL.ledger}:\\d+$`).test(new URL(seen.txUrls[1]).searchParams.get('tx') ?? ''),
      'a pending submission names the ledger too — the spelling is the rule, not a happy-path detail');
    await driver.screenshot('113-dpay-till-pending');
    console.log('[113-dpay-till] ✓ pending rendered as sent-and-waiting, not as paid');

    // Nothing ever escaped toward a host outside the fixture table.
    assertEq(JSON.stringify(seen.unexpected), '[]', 'no request may reach an origin outside the fixture table');
    console.log(`[113-dpay-till] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[113-dpay-till] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
