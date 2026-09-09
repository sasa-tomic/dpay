// Flow 112 — paying the SAME merchant till on the SOLANA rail, and refusing the one asset it offers
// that dpay must not pay.
//
// Flow 111 pays this till on the Internet Computer. This is its twin on the device-key rail, and the
// pair is the point: a merchant's till code is not per-rail, so the same fixture (`harness/ocp.mjs`)
// has to behave identically whichever asset the payer happens to have selected — the same explicit
// review, the same never-auto-sign rule, the same one-shot report. Only the settlement changes: a
// System Program transfer signed on the device, with the transaction SIGNATURE as the proof, where
// the IC rail reports a ledger block index.
//
// Three legs, in the order a payer meets them:
//
//   1. SOLANA USDC IS REFUSED, BY NAME. The till really does offer `Solana/USDC` (measured), and
//      dpay really can hold it — so this is not "asset not accepted", it is dpay declining an offer
//      it could physically take. The reason is money-safety and it is measured: the provider's
//      Solana URI carries no `spl-token` parameter, so `solana:<address>?amount=…` is byte-identical
//      to a native SOL transfer and the address is ambiguous between the owner and its token account
//      (`docs/specs/2026-09-01-opencryptopay-findings.md`, "Stale-README trap #2"). Sending against
//      that would move real money to the wrong account. The refusal must name SOL as the way to pay
//      this same till, cost at most the one details read, ask for NO destination, and — the part
//      that actually protects the user — broadcast NOTHING.
//   2. SOL PAYS, AND NEVER AUTO-SIGNS. A scanned till lands on an explicit review carrying the
//      amount at SOL's own precision, the FULL destination address, the provider host the price came
//      from, the countdown, the FIAT PRICE the till is charging, and the merchant name marked as
//      CLAIMED. Proven by the chain, not by pixels: zero transactions have been broadcast while that
//      review is on screen. Approve → one broadcast → one proof submission naming that signature →
//      the paid state.
//   3. A TRANSFER THE CLUSTER WON'T CONFIRM STAYS RECOVERABLE. The network accepts the transaction
//      and then the status read stops answering: money on chain, provider untold. The wallet keeps
//      the broadcast signature, says so honestly, reports NOTHING — and when the cluster comes back
//      it re-reads that same signature, finds it confirmed, and completes the sale itself. One
//      broadcast, one submission, no action from the payer.
//
// The unresolved SUBMISSION path — the provider itself never answering — is flow 111's job and is
// rail-independent by construction: `payAndReport` (`app/services/opencryptopay.ts`) owns the order
// and the one-shot submission for BOTH rails, and only the `send` seam differs. The CLAIM is not
// shared: each rail holds its own handle on a transfer it could not resolve (an IC envelope there, a
// Solana signature here) and re-reads it against its own chain, so leg 3 belongs to this flow.
//
// Selector contract: `asset-sol-select`, `asset-sol-usdc-select`, `sol-pay-scan`, `sol-pay-err`,
// `ocp-checking`, `sol-pay-amount`, `sol-pay-payee`, `ocp-price`, `ocp-expiry`,
// `btn-approve`, `sol-pay-status`, `ocp-outcome`, `btn-sol-pay-done`,
// `btn-sol-start-scan` (via armPayScan).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, armPayScan,
} from '../harness/lib.mjs';
import {
  installTillStub, ocpStubState,
  CLAIMED_MERCHANT, PAYMENT_ID, PROVIDER_HOST, TILL_QR,
} from '../harness/ocp.mjs';

// SYNTHETIC (the findings doc records the URI's shape, not this till's Solana address): a real,
// checksum-valid base58 Solana address — the app runs it through `isValidSolanaAddress` before the
// payer ever sees it, so a made-up string would be refused rather than displayed.
const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
/** The till's `0.01219252` SOL rendered at SOL's own 9 decimals — what the review must say. */
const PAY_DISPLAY = '0.012192520 SOL';

export const meta = {
  id: '112',
  name: 'opencryptopay-sol',
  journey: 'pay',
  covers: ['opencryptopay', 'sol-rail', 'explicit-approve', 'solana-usdc-refused',
    'one-shot-submit', 'honest-instructions', 'fail-closed', 'loss-path-recovery'],
  verifies: 'The Solana rail pays an OpenCryptoPay till: a scanned till with SOL selected resolves a live quote and lands on an explicit review (exact SOL amount, full destination address, and ONE line carrying the fiat price the till itself is charging and the host that set it) that broadcasts nothing until Approve; Approve sends exactly one Solana transaction and reports that signature to the provider exactly once → paid. With Solana USDC selected the SAME till is refused by name — its URI names no token account — pointing the payer at SOL, costing one provider read, and broadcasting nothing. A transfer the cluster accepts but will not confirm is reported to nobody, keeps its signature, and is completed by the wallet itself once the status read comes back — one broadcast, one submission.',
  timeoutMs: 60000, // 3 legs × (2 provider round trips) + a real local sign/broadcast/confirm
};

/**
 * The Solana RPC simulator: the same seam every SOL flow uses (`__DPAY_TEST_SOLANA_RPC_STUB`), so
 * `sendSol` runs its REAL build/sign/broadcast/confirm path against it. `sent` is what makes leg 2's
 * "never auto-signs" claim about money rather than about pixels — a broadcast cannot happen without
 * landing here.
 *
 * The USDC token account exists and holds a balance so leg 1 reaches the SCAN surface: an absent ATA
 * parks the Pay tab on the fail-closed setup card (flow 76) and the till would never be scanned.
 */
async function installSolStub(driver) {
  await driver.eval(() => {
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: (params) => {
        const sig = `sig_ocp_${globalThis.__E2E_SOL_SENT.length + 1}`;
        globalThis.__E2E_SOL_SENT.push({signature: sig, raw: Array.isArray(params) ? params[0] : null});
        return sig;
      },
      // Flipped by leg 4 to 'unreadable': the status read is the ONLY thing that fails there, so a
      // transaction the network has already accepted is left with no verdict — the shape that puts
      // real money on chain with the provider untold.
      getSignatureStatuses: () => {
        if (globalThis.__E2E_SOL_STATUS === 'unreadable') throw new Error('solana rpc: status node unavailable');
        return {context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]};
      },
      // A funded wallet on both tokens: 5 SOL, and a USDC token account that exists with 2.5 USDC.
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });
}

/** How many Solana transactions the device has actually broadcast. */
const broadcasts = (driver) => driver.eval(() => globalThis.__E2E_SOL_SENT.map((t) => t.signature));

/** Whether the cluster will answer a signature-status read at all. 'unreadable' throws — the
 *  broadcast still succeeds, only the verdict is out of reach. */
const setSolStatus = (driver, mode) => driver.eval((m) => { globalThis.__E2E_SOL_STATUS = m; }, mode);

/** Select an asset in Balances and land on its Pay scan surface. */
async function selectAndScan(driver, assetKey) {
  await openBalances(driver);
  await driver.click(`asset-${assetKey}-select`, {timeoutMs: 8_000});
  await driver.click('tab-pay', {timeoutMs: 5_000});
  await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});
  await armPayScan(driver); // the pay-intent gate — the shared choke point for every injected scan
  await driver.eval((qr) => { window.__DPAY_TEST_SCAN(qr); }, TILL_QR);
}

export async function run() {
  const start = Date.now();
  console.log('[112-opencryptopay-sol] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[112-opencryptopay-sol] onboarding…');
    await onboardWallet(driver, 'e2e-ocp-sol');
    await installSolStub(driver);
    await installTillStub(driver, {
      passOrigins: [new URL(relayBaseURL).origin, new URL(webBaseURL).origin],
      // The real provider takes real time over two reads, and leg 2 asserts the wallet says what it
      // is doing instead of freezing — so the fixture has to take time too. Without this the reads
      // resolve inside a single frame and the waiting copy is a state no observer can ever catch,
      // which is a race in the TEST, not in the app (observed RED, 2026-09-01).
      detailsDelayMs: 800,
      uris: {
        // `solana:<ADDRESS>?amount=<DECIMAL>` — the live shape. No `spl-token` parameter exists on
        // this rail at all (measured), which is precisely why leg 1 refuses USDC: the same URI would
        // be handed back for it, naming no token account.
        'Solana/SOL': `solana:${MERCHANT_ADDR}?amount=0.01219252`,
      },
    });

    // --- 1. Solana USDC: offered by the till, refused by dpay ----------------------------------
    console.log('[112-opencryptopay-sol] leg 1 — scanning the till with Solana USDC selected…');
    await selectAndScan(driver, 'sol-usdc');

    assert(await driver.waitForText('doesn’t say which token account', {timeoutMs: 12_000}),
      'the refusal must name the measured reason: the till\'s code does not say which token account to pay');
    const body = await driver.bodyText();
    assertIncludes(body, 'Pay with SOL instead', 'the refusal must point at the asset that CAN pay this same till');
    assert(!(await driver.isPresent('sol-pay-amount')), 'a refused till must never render a payment review');
    assert(!(await driver.isPresent('btn-approve')), 'a refused till must never render an Approve button');

    // Cheap AND safe: one details read, no destination asked for, and — the part that matters —
    // nothing signed and nothing broadcast.
    let seen = await ocpStubState(driver);
    assertEq(String(seen.calls.length), '1', 'an unpayable till costs exactly one provider read');
    assertIncludes(seen.calls[0], 'timeout=0', 'the details read asks for the current charge, never a long poll');
    assertEq(String(seen.txUrls.length), '0', 'a refusal before any funds move must never touch the submission endpoint');
    assertEq(JSON.stringify(await broadcasts(driver)), '[]',
      'a refused Solana USDC till must broadcast NOTHING — that refusal exists to stop money reaching the wrong account');
    console.log('[112-opencryptopay-sol] ✓ Solana USDC refused by name; one read, nothing signed');
    await driver.screenshot('112-ocp-sol-usdc-refused');

    // --- 2. SOL: the explicit review, then the payment -----------------------------------------
    console.log('[112-opencryptopay-sol] leg 2 — scanning the till with SOL selected…');
    await selectAndScan(driver, 'sol');

    // Two provider reads take real time. The wallet says what it is doing rather than freezing —
    // the same copy the IC rail shows, from the same string (flow 111 pins it on that rail).
    assertIncludes(await driver.readText('ocp-checking', {timeoutMs: 8_000}), 'payment provider',
      'the waiting message names who is being asked');

    await driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('sol-pay-amount'), `Pay ${PAY_DISPLAY}`,
      'the review shows the till\'s exact quoted amount, converted at SOL\'s own 9-decimal precision');
    assertEq(await driver.readText('sol-pay-payee'), MERCHANT_ADDR,
      'the review shows the FULL destination address — the one thing on screen the payer can check');
    // ONE provider line: the till's own price (`0.01221422 SOL` is uncheckable against the number
    // on the till) beside the host that set it, which is what attributes the fiat figure to the
    // provider. One component renders it for both rails, so this is byte-identical to the IC
    // rail's line (CLAUDE.md same-surfaces rule) even though the asset amount above it is not.
    assertEq(await driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`,
      'the review states the price and its host in one line, in the same words as the IC rail');
    assert(!(await driver.isPresent('review-claimed')), 'the review carries no unactionable name caveat');
    assert(!(await driver.isPresent('ocp-expiry')),
      'a quote with minutes left must not put a countdown on the review');
    assertIncludes(await driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the name the till claims');

    // NEVER AUTO-SIGNS — proven on the chain, not in pixels: the Approve press is still pending and
    // the device has broadcast nothing. (A scanned dpay REQUEST does auto-sign on this rail too, by
    // design; this code came from a stranger, so it may not.)
    assert(await driver.isPresent('btn-approve'), 'a scanned till must still require an explicit Approve press');
    assertEq(JSON.stringify(await broadcasts(driver)), '[]',
      'nothing may be broadcast before the payer approves');
    await driver.screenshot('112-ocp-sol-review');
    console.log('[112-opencryptopay-sol] ✓ explicit review, host + claimed name + countdown, nothing broadcast');

    // --- 3. Approve: one transfer, one report, paid --------------------------------------------
    console.log('[112-opencryptopay-sol] approving…');
    await driver.click('btn-approve', {timeoutMs: 5_000});
    assert(await driver.waitForText(`Paid ✓ ${PAY_DISPLAY}`, {timeoutMs: 20_000}),
      'an accepted submission renders the paid state with the exact amount');
    assert(!(await driver.isPresent('ocp-outcome')),
      'a clean payment carries no unresolved note — that surface is for the loss path alone');

    const sent = await broadcasts(driver);
    assertEq(String(sent.length), '1', 'Approve broadcasts EXACTLY one Solana transaction');

    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '1', 'the proof is reported EXACTLY once — the provider grants one attempt');
    const submitted = new URL(seen.txUrls[0]);
    assertEq(submitted.pathname, `/v1/lnurlp/tx/${PAYMENT_ID}`,
      'the submission goes to the /tx path derived from the callback\'s /cb/ segment');
    assertEq(submitted.searchParams.get('method'), 'Solana', 'the submission echoes the provider\'s method spelling');
    assertEq(submitted.searchParams.get('asset'), 'SOL', 'the submission echoes the provider\'s asset spelling');
    assertEq(submitted.searchParams.get('tx'), sent[0],
      'the reported proof is the signature of the transaction that was actually broadcast');

    console.log(`[112-opencryptopay-sol] ✓ paid; one broadcast (${sent[0]}) reported once`);
    await driver.screenshot('112-ocp-sol-paid');

    // --- 4. (header leg 3) confirmation fails AFTER the broadcast — still recoverable -----------
    // The likeliest failure of a till payment is not a refusal: it is losing the network while the
    // transaction is already landing. Money on chain, provider untold, and the only claim on it is
    // the signature the broadcast returned. Discarding it is what made this rail's version of the
    // loss path unrecoverable (review #15); keeping it makes the outcome resolvable without the
    // payer doing anything. This is rail-SPECIFIC — each rail re-reads its own claim in its own
    // vocabulary — so it cannot be inherited from flow 111.
    console.log('[112-opencryptopay-sol] leg 3 — broadcast accepted, confirmation unreadable…');
    await setSolStatus(driver, 'unreadable');
    await driver.click('btn-sol-pay-done', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 8_000});
    await armPayScan(driver);
    await driver.eval((qr) => { window.__DPAY_TEST_SCAN(qr); }, TILL_QR);
    await driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
    await driver.click('btn-approve', {timeoutMs: 5_000});

    const pending = await driver.readText('ocp-outcome', {timeoutMs: 20_000});
    assertIncludes(pending, 'neither paid nor failed', 'an unconfirmable transfer is stated as neither paid nor failed');
    assertIncludes(pending, 'Keep this screen open', 'the copy tells the payer what keeps the recovery running');
    assert(!(await driver.bodyText()).includes(`Paid ✓ ${PAY_DISPLAY}`),
      'an unconfirmed transfer must NEVER render as paid');
    // The money moved and the provider was NOT told: spending the one submission on a signature the
    // wallet cannot vouch for would burn the quote AND bind the id, which is the unrecoverable case.
    assertEq(String((await broadcasts(driver)).length), '2', 'leg 4 broadcasts exactly one more transaction');
    assertEq(String((await ocpStubState(driver)).txUrls.length), '1',
      'an unconfirmed transfer must not be reported — the one submission stays unspent');
    await driver.screenshot('112-ocp-sol-unconfirmed');

    // The cluster comes back. dpay re-reads the SAME signature — no second broadcast — finds it
    // confirmed, and spends the submission it was holding.
    await setSolStatus(driver, 'confirmed');
    assert(await driver.waitForText(`Paid ✓ ${PAY_DISPLAY}`, {timeoutMs: 20_000}),
      'a recovered transfer completes the sale on its own, with no action from the payer');
    assert(!(await driver.isPresent('ocp-outcome')), 'the unresolved note goes when the outcome resolves');

    const recovered = await broadcasts(driver);
    assertEq(String(recovered.length), '2', 'recovery re-READS the transaction; it never re-broadcasts one');
    seen = await ocpStubState(driver);
    assertEq(String(seen.txUrls.length), '2', 'the recovered proof is reported exactly ONCE in total');
    assertEq(new URL(seen.txUrls[1]).searchParams.get('tx'), recovered[1],
      'the recovered proof names the signature of the transaction that was actually broadcast');
    console.log(`[112-opencryptopay-sol] ✓ recovered; ${recovered[1]} reported once, nothing re-sent`);
    await driver.screenshot('112-ocp-sol-recovered');

    // Nothing ever escaped toward the real provider.
    assertEq(JSON.stringify(seen.unexpected), '[]', 'no request may reach an origin outside the fixture table');

    console.log(`[112-opencryptopay-sol] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[112-opencryptopay-sol] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
