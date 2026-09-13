// Flow 176 — a customer whose wallet APPROVES instead of sending, and a shop that collects.
//
// Every till flow before this one has the customer pushing money: they read the code, sign a
// transfer, and the relay observes it. An ICRC-2 allowance wallet — Oisy, the only third-party
// wallet measured to carry an Internet Computer OpenCryptoPay leg at all — does not work that way.
// It calls `icrc2_approve` naming the SHOP as spender, then reports its own principal to step 4 and
// waits for the provider to take the money. dpay's relay cannot take it (it holds no key, by the
// non-custody rule) and the shop's own phone can, because the allowance names the key that phone
// holds. This flow drives that whole path.
//
// WHAT IS REAL: the ring-up is the app's own Ed25519 signature over `dpay_core::TillOpen`; the
// approve is a real signed `icrc2_approve` envelope against the fake-IC gateway (the harness stands
// in for the allowance wallet, because nothing in dpay signs one); the report is the standard's own
// step-4 call carrying `sender`; and the collection is the APP signing a real `icrc2_transfer_from`
// with its own core. Nobody tells the screen anything — it flips to Paid because the relay observed
// the money on the merchant's own ledger, exactly as it does for a pushed payment.
//
// THE TWO PROPERTIES THIS FLOW EXISTS FOR:
//   1. The customer's account moves by EXACTLY the price. The shop absorbs the ledger fee — the
//      founder's rule (2026-09-12), and the reason the till quotes price-minus-fee.
//   2. The pull moves money and does NOT settle the sale. One settlement owner: the relay's own
//      ledger read. A screen that went green off the app's own pull would be claiming a sale on
//      the strength of its own opinion.
//
// Selector contract: `btn-code-till`, `amount-input`, `btn-till-ring-up`, `till-qr`,
// `till-status`, `till-paid`, `till-paid-block`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair, icpApproveArgBytes, icpPrincipalBytes, icpSignUpdate } from '../harness/wire.mjs';

const VCHF = 7;                  // the ONE asset a dpay till takes
const FEE = 10_000;              // the VCHF catalog fee, charged by the ledger to the SENDER
const PRICE = '4.50';            // what the cashier types
const PRICE_RAW = 450_000_000;   // 450 rappen × 10^(8−2)
// What the shop receives and what the pull asks for: the price less the fee it absorbs. The ledger
// then debits the customer `that + FEE` — the price exactly (`LEDGER_FEE_RAW`, till.rs).
const PAY_RAW = PRICE_RAW - FEE;
const PAYER_SEED = 2_000_000_000;

export const meta = {
  id: '177',
  name: 'till-allowance-pull',
  journey: 'pay',
  covers: ['till', 'merchant-till', 'opencryptopay', 'icrc2', 'allowance-pull', 'vchf', 'observed-settlement', 'charge-reference', 'settle'],
  verifies: 'A customer’s wallet approves the shop for a till charge instead of sending it (the ICRC-2 flow Oisy uses) and reports its own principal to the till’s step 4. The relay records that as a CLAIM and carries it to the merchant — it holds no key and collects nothing itself. The shop’s phone reads the claim off its ordinary poll, signs a real icrc2_transfer_from with the charge’s `ref` as the memo, and the money moves; the screen turns Paid only when the RELAY observes it on the merchant’s ledger. The customer’s account goes down by exactly CHF 4.50 and the shop is the one short by the ledger fee.',
  timeoutMs: 60_000,
};

/** Keep a copy of every ring-up answer the app receives, without changing what it receives.
 *  (The payment-link id lives inside a bech32 LNURL on screen; decoding it here would put a third
 *  LUD-01 implementation in this repo — see `e2e/harness/lnurl.mjs`.) */
async function observeTillOpens(driver) {
  await driver.eval(() => {
    window.__TILL_OPENS = [];
    const real = window.fetch;
    window.fetch = async (...args) => {
      const response = await real(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
      if (/\/api\/v1\/till$/.test(url) && response.ok) {
        try {
          window.__TILL_OPENS.push(await response.clone().json());
        } catch (e) {
          window.__TILL_OPENS.push({ observerError: String(e) });
        }
      }
      return response;
    };
  });
}

async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * THE ALLOWANCE WALLET, stood in for: sign a real `icrc2_approve` naming the shop as spender and
 * submit it to the fake-IC gateway. The approved amount is `amount + fee` — what Oisy approves, and
 * what a pull actually costs the customer (`payIcp`, the findings doc).
 */
async function approveTheShop(relayBaseURL, payer, merchantPubHex, amount, ledger) {
  const arg = icpApproveArgBytes(icpPrincipalBytes(merchantPubHex), BigInt(amount) + BigInt(FEE), {
    fee: BigInt(FEE),
    expiresAtNs: BigInt(Date.now() + 5 * 60_000) * 1_000_000n,
  });
  const expiry = BigInt(Date.now() + 300_000) * 1_000_000n;
  const signed = await icpSignUpdate(payer.secretHex, ledger, 'icrc2_approve', arg, expiry);
  const bytes = new Uint8Array(signed.envelopeHex.match(/../g).map(h => parseInt(h, 16)));
  const r = await fetch(`${relayBaseURL}/api/v2/canister/${ledger}/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/cbor' }, body: bytes,
  });
  assert(r.ok, `the approve must be accepted by the gateway, got HTTP ${r.status}`);
  return signed.requestIdHex;
}

export async function run() {
  const start = Date.now();
  console.log('[177-till-allowance-pull] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[177-till-allowance-pull] onboarding the shop…');
    await onboardWallet(driver, 'Bahnhof Kiosk');
    const merchant = await accountOf(driver);
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    const payer = await generateKeypair();
    const payerPrincipal = await railPrincipalText(payer.publicHex);
    const funded = await faucetAccount(relayBaseURL, payer.publicHex, PAYER_SEED, { currency: VCHF });
    assert(funded.ok, `the customer must be funded in VCHF, got HTTP ${funded.status}`);
    const ledger = (await getJson(`${relayBaseURL}/api/v1/currencies`)).networks
      .flatMap(n => n.assets ?? []).find(a => a.currency === VCHF)?.ledger;
    assert(typeof ledger === 'string' && ledger.length > 0, 'the catalog must name the VCHF ledger');

    // --- the counter ---------------------------------------------------------------------------
    console.log('[177-till-allowance-pull] ringing up CHF 4.50…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await observeTillOpens(driver);
    await driver.click('btn-code-till', { timeoutMs: 4_000 });
    await driver.type('amount-input', PRICE, { timeoutMs: 4_000 });
    await driver.click('btn-till-ring-up', { timeoutMs: 4_000 });
    await driver.findByTestID('till-qr', { timeoutMs: 15_000 });

    const opens = await driver.eval(() => window.__TILL_OPENS);
    assertEq(opens.length, 1, 'exactly one ring-up was sent');
    const open = opens[0];
    assertEq(open.merchant, merchantPrincipal, 'the charge is opened on the shop’s own account');
    assertEq(open.amount, '4.4999', 'the till quotes the price less the fee the shop absorbs');

    // --- the customer APPROVES, and tells the till so -------------------------------------------
    console.log('[177-till-allowance-pull] customer approving the shop (no transfer)…');
    await approveTheShop(relayBaseURL, payer, merchant.publicHex, PAY_RAW, ledger);
    // Nothing has moved: an approval is a permission, not a payment.
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), '0',
      'an approval must move no money at all');
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, VCHF)), String(PAYER_SEED - FEE),
      'the approve costs the customer one ledger fee and nothing else');

    const details = await getJson(`${relayBaseURL}/v1/lnurlp/${open.id}?timeout=0`);
    const quote = details?.quote?.id;
    assert(typeof quote === 'string', `the till must mint a quote, got ${JSON.stringify(details?.quote)}`);
    const report = `${relayBaseURL}/v1/lnurlp/tx/${open.id}?quote=${encodeURIComponent(quote)}` +
      `&method=InternetComputer&asset=VCHF&sender=${encodeURIComponent(payerPrincipal)}`;
    const reported = await fetch(report);
    assertEq(reported.status, 202, 'the standard’s retryable PENDING is what an allowance wallet gets');

    await driver.screenshot('177-till-claim');

    // --- the SHOP's own phone collects it -------------------------------------------------------
    // Nothing below is told to the app: it reads the claim off the poll it was already making.
    console.log('[177-till-allowance-pull] waiting for the shop’s phone to collect…');
    assert(await driver.waitForText('Paid 4.50 CHF', { timeoutMs: 30_000 }),
      `the sale must land once the shop collects and the relay observes it. screen:\n${(await driver.bodyText()).slice(0, 600)}`);
    const settled = await driver.bodyText();
    assertIncludes(settled, 'Ledger block', 'the sale names the ledger row that paid it');

    // --- the money, and the founder's rule on it ------------------------------------------------
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), String(PAY_RAW),
      'the shop was credited the price less the fee it absorbs');
    // The customer paid TWO ledger fees in total — one for their own approve (their wallet's choice
    // of mechanism, which dpay neither controls nor sees) and one on the transfer the shop pulled,
    // which came out of the price. The PRICE itself moved exactly once.
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, VCHF)), String(PAYER_SEED - PRICE_RAW - FEE),
      'the customer was debited the price, plus only their own wallet’s approve fee');

    await driver.screenshot('177-till-allowance-paid');
    console.log(`[177-till-allowance-pull] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('177-till-allowance-pull RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
