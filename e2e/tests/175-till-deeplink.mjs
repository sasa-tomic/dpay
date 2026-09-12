// Flow 175 — a till code arriving as an OS App Link, not a camera scan.
//
// The till QR the relay mints is an https URL (`{origin}/pl/?lightning=<LNURL…>`, TILL_CODE_PATH in
// crates/dpay-relay/src/till.rs). Before the `/pl/` App Link claim existed, a phone WITH the app
// that read that QR with its own camera opened the relay's static landing page in a browser — the
// app could only pay a till through its in-app scanner. The fix is one manifest filter plus a third
// door in Wallet's link pipeline: the URL enters PayMode/SolPayMode as a PREFILLED SCAN and runs the
// SAME classification a camera scan of the same QR takes (flow 111/112 pin the camera halves).
//
// What this flow pins, on both rails:
//   • the OS entry routes from IDLE (Balances — the Pay tab was never opened) straight to the
//     OpenCryptoPay review: an App Link, like a payment link, is a zero-press entry and bypasses the
//     pay-intent camera gate — but never the Approve press;
//   • NEVER AUTO-SIGNS, proven with money on both rails (IC ledger balance unchanged, zero Solana
//     broadcasts while the review is on screen);
//   • the review is the SAME review a scan produces: exact amount, FULL destination, the one
//     price+host line.
// The URL is fired through `window.__DPAY_TEST_DEEPLINK` — the same handleUrl the OS 'url' listener
// drives — rebuilt in the PROD shape (dpay.kalaj.org host) from the harness's foreign-host fixture
// QR, which also proves the parse is host-liberal for self-hosted relays.
//
// Selector contract: `pay-amount`, `review-payee`, `ocp-price`, `btn-approve`, `btn-review-cancel`
// (IC), `sol-pay-amount`, `sol-pay-payee`, `btn-sol-pay-cancel` (SOL), `asset-sol-select`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';
import {
  installTillStub, ocpStubState, CLAIMED_MERCHANT, PROVIDER_HOST, TILL_QR,
} from '../harness/ocp.mjs';

// The PROD App-Link shape: the relay's own host carrying the fixture's lightning payload. Built
// from the harness QR (whose foreign host `app.dfx.swiss` is what a scan of the REAL printed code
// would carry) so the payload stays the one the stub knows how to price.
const TILL_LINK = 'https://dpay.kalaj.org' + new URL(TILL_QR).pathname + new URL(TILL_QR).search;

const ICP = 8;
const ICP_SEED = 500_000_001; // 5.00000001 ICP — funds the IC leg without moving anything (no approve here)
const PAY_RAW = 50_795_551;   // the till's 0.50795551 ICP at 8 decimals (the stub's CHF-1 quote)

// SYNTHETIC (same provenance as flow 112): a real, checksum-valid base58 Solana address — the app
// validates it with `isValidSolanaAddress` before the payer ever sees it.
const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const SOL_PAY_DISPLAY = '0.012192520 SOL'; // the till's 0.01219252 SOL at 9 decimals

/** The Solana RPC simulator (the same seam every SOL flow uses): this flow never approves, so the
 *  stub only has to fund the wallet (5 SOL) and answer balance reads. `__E2E_SOL_SENT` is the
 *  never-auto-signs proof — a broadcast cannot happen without landing there. */
async function installSolStub(driver) {
  await driver.eval(() => {
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: (params) => {
        const sig = `sig_deeplink_${globalThis.__E2E_SOL_SENT.length + 1}`;
        globalThis.__E2E_SOL_SENT.push({signature: sig, raw: Array.isArray(params) ? params[0] : null});
        return sig;
      },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });
}

const broadcasts = (driver) => driver.eval(() => globalThis.__E2E_SOL_SENT.map((t) => t.signature));

export const meta = {
  id: '175',
  name: 'till-deeplink',
  journey: 'pay',
  covers: ['deeplink', 'app-link', 'opencryptopay', 'explicit-approve', 'never-auto-sign', 'sol-rail'],
  verifies: 'A till code arriving as an OS App Link (…/pl/?lightning=…) routes from idle Balances — the Pay tab never opened — straight into the SAME OpenCryptoPay review a camera scan of the same QR produces, on both rails: exact amount, full destination, one price+host line, and no auto-sign (IC ledger balance unchanged, zero Solana broadcasts until an Approve that this flow never presses).',
  timeoutMs: 30000, // 2 provider round trips per rail, no settlement
};

export async function run() {
  const start = Date.now();
  console.log('[175-till-deeplink] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[175-till-deeplink] onboarding…');
    await onboardWallet(driver, 'e2e-till-link');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64,
      `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    const merchant = await generateKeypair();
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const fund = await faucetAccount(relayBaseURL, accountHex, ICP_SEED, {currency: ICP});
    assert(fund.ok, `faucet funding of ICP must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    await installTillStub(driver, {
      passOrigins: [new URL(relayBaseURL).origin, new URL(webBaseURL).origin],
      uris: {
        'InternetComputer/ICP': `icp:ryjl3-tyaaa-aaaaa-aaaba-cai/transfer?to=${merchantPrincipal}&amount=0.50795551`,
        'Solana/SOL': `solana:${MERCHANT_ADDR}?amount=0.01219252`,
      },
    });

    // --- 1. IC rail: the App Link opens the review, never the browser's flow --------------------
    console.log('[175-till-deeplink] leg 1 — IC: App Link fired from idle Balances…');
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    assert(await driver.waitForText('5.00000001 ICP', {timeoutMs: 10_000}), 'the app must see the ICP seed');
    // Deliberately NOT clicking tab-pay: the OS entry must do its own routing — an App Link arrives
    // with no Pay Now gate passed, exactly like a payment link (flow 70's territory).
    await driver.eval((u) => { window.__DPAY_TEST_DEEPLINK(u); }, TILL_LINK);

    await driver.findByTestID('pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('pay-amount'), 'Pay 0.50795551 ICP',
      'the till App Link lands on the SAME review a camera scan of the same QR produces');
    assertEq(await driver.readText('review-payee'), merchantPrincipal,
      'the review shows the FULL destination account');
    assertEq(await driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`,
      'the price+host line is the scan review\'s line, unchanged');
    assertIncludes(await driver.bodyText(), CLAIMED_MERCHANT, 'the review shows the name the till claims');
    // NEVER AUTO-SIGNS — proven with money, not pixels (the camera twins assert the same in 111).
    assert(await driver.isPresent('btn-approve'), 'the App-Link entry still requires an explicit Approve press');
    assertEq(await getBalance(relayBaseURL, accountHex, ICP), String(ICP_SEED),
      'nothing may leave the wallet before the payer approves');
    assertEq(JSON.stringify((await ocpStubState(driver)).txUrls), '[]',
      'a review the payer never approved must never touch the submission endpoint');
    await driver.screenshot('175-till-deeplink-ic');
    console.log('[175-till-deeplink] ✓ IC: idle → review, no auto-sign');
    await driver.click('btn-review-cancel');

    // --- 2. SOL rail: the same App Link through the SOL twin (same-surfaces rule) ----------------
    console.log('[175-till-deeplink] leg 2 — SOL: the same link on the twin rail…');
    await installSolStub(driver);
    await openBalances(driver);
    await driver.click('asset-sol-select', {timeoutMs: 8_000});
    await driver.eval((u) => { window.__DPAY_TEST_DEEPLINK(u); }, TILL_LINK);

    await driver.findByTestID('sol-pay-amount', {timeoutMs: 15_000});
    assertEq(await driver.readText('sol-pay-amount'), `Pay ${SOL_PAY_DISPLAY}`,
      'the SOL twin renders the same-shaped review at SOL\'s own 9-decimal precision');
    assertEq(await driver.readText('sol-pay-payee'), MERCHANT_ADDR,
      'the SOL review shows the FULL destination address');
    assertEq(await driver.readText('ocp-price'), `CHF 1 · price from ${PROVIDER_HOST}`,
      'one component renders the price line for both rails — byte-identical here');
    // NEVER AUTO-SIGNS on the twin too — a broadcast cannot happen without landing in the stub.
    assert(await driver.isPresent('btn-approve'), 'the SOL review still requires an explicit Approve press');
    assertEq(JSON.stringify(await broadcasts(driver)), '[]',
      'the device must broadcast nothing while the review is unapproved');
    await driver.screenshot('175-till-deeplink-sol');
    console.log('[175-till-deeplink] ✓ SOL: idle → review, nothing broadcast');
    await driver.click('btn-sol-pay-cancel');

    // Nothing ever escaped toward the real provider.
    const seen = await ocpStubState(driver);
    assertEq(JSON.stringify(seen.unexpected), '[]', 'no request may reach an origin outside the fixture table');

    console.log(`[175-till-deeplink] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[175-till-deeplink] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
