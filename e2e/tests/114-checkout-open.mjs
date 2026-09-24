// Flow 114 — the OTHER side of the counter: a dpay wallet OPENS a sale and is paid for it.
//
// Every payment flow before this one has dpay paying somebody. This is the merchant half: a shop
// enters a price in francs, the app signs a checkout-open on its own account, the relay opens a charge,
// and the cashier's screen shows a code and waits. The money then arrives the way it really would —
// a payer resolves the code through the checkout's own OpenCryptoPay routes and signs a VCHF transfer
// carrying the charge's `ref` as its ICRC-1 memo — and the screen flips to Paid because the RELAY
// observed that transfer on the merchant's own ledger. Nothing here is inferred from a countdown or
// a scan: the status route deliberately exposes no "scanned" signal, and this flow asserts money on
// the ledger beside the pixels.
//
// WHAT IS REAL: the checkout-open is a genuine Ed25519 signature from the app's own core over
// `dpay_core::CheckoutOpen` (the relay verifies it with `validate_checkout_open` and refuses a key the
// caller cannot sign for); the three checkout routes are the relay's own, served because the harness
// runs it with `DPAY_ENABLE_CHECKOUT`; the payment is a signed `icrc1_transfer` submitted to the fake-IC
// gateway exactly as flows 97/98 pay a merchant request.
//
// THE ONE TEST-ONLY SEAM is `observeCheckoutOpens`, which wraps `window.fetch` to KEEP a copy of the
// checkout-open's request and answer while passing every request through untouched. It changes no
// behaviour; it exists because the payment-link id lives inside a bech32 LNURL on screen, and
// decoding it here would put a third implementation of LUD-01 in this repo (the relay encodes, the
// app decodes — see `e2e/harness/lnurl.mjs`, which says exactly this). The kept request body pays
// for itself: it is how the flow asserts the shared message box's text rode the checkout-open as `note`.
//
// THE ONE BOX (founder 2026-09-14): the message box is the SAME input in the same place whether or
// not the checkout checkbox is checked, and its text survives the toggle in both directions — asserted
// here through a full off→on round trip before the checkout-open, and again after "Next customer".
//
// Selector contract: `btn-code-checkout`, `amount-input`, `memo-input`, `btn-checkout-open`, `checkout-qr`,
// `checkout-amount`, `checkout-status`, `checkout-paid`, `checkout-paid-block`, `btn-checkout-new`, `receive-code-form`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, railPrincipalText, railTransfer,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';

const VCHF = 7;                 // the ONE asset a dpay checkout takes
const FEE = 10_000;             // the VCHF catalog fee, charged by the ledger to the SENDER (flow 95)
const PRICE = '10.50';          // what the cashier types, and what the customer's account must move by
const PRICE_RAW = 1_050_000_000; // 1050 rappen × 10^(8−2) — the price, in raw VCHF
// What the SHOP receives: the price less the ledger fee it absorbs, which is the amount the checkout
// quotes and the payer signs. The ledger then debits the payer `that + FEE` — the price exactly.
// The rule and its reasoning: `LEDGER_FEE_RAW`, crates/dpay-relay/src/checkout.rs.
const PAY_RAW = PRICE_RAW - FEE;
const PAYER_SEED = 2_000_000_000;

export const meta = {
  id: '114',
  name: 'checkout-open',
  journey: 'pay',
  covers: ['checkout', 'merchant-checkout', 'opencryptopay', 'signed-checkout-open', 'vchf', 'observed-settlement', 'charge-reference', 'honest-instructions', 'settle', 'shared-message-box'],
  verifies: 'A shop opens a CHF charge 10.50 on its own dpay wallet: the Receive tab’s checkout-code checkbox switches the shared amount row’s button to the checkout counter — and the message box is ONE box for both code forms (founder 2026-09-14): the same input in the same place whether or not the checkbox is checked, its text surviving the toggle in both directions and riding the checkout-open as the signed `note`. The app signs the checkout-open with its own key, and the relay answers with a real charge — the screen shows the code, the franc price, what settles in VCHF, and an honest "waiting" that never claims the customer scanned anything. A payer then resolves that code through the checkout’s own OpenCryptoPay routes (which name the MERCHANT’s account, not dpay’s) and pays the exact VCHF carrying the charge’s `ref` as the on-chain memo; the merchant’s screen flips to Paid with the ledger block that paid, and the money is on the ledger (the customer’s account moves by exactly CHF 10.50 — the shop absorbs the ledger fee, so it receives 10.4999). "Next customer" returns to the shared form with the note kept, like the price.',
  timeoutMs: 60_000, // checkout-open + a 4-call provider walk + a real IC settlement + the merchant poll
};

/** Keep a copy of every checkout-open REQUEST and ANSWER, without changing what the app receives. The
 *  request body is kept because the founder's one-box rule (2026-09-14) is pinned here end to end:
 *  the message typed into the SHARED message box must ride the signed checkout-open as `note`. */
async function observeCheckoutOpens(driver) {
  await driver.eval(() => {
    window.__CHECKOUT_OPENS = [];
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await real(input, init);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/v1\/checkout$/.test(url) && response.ok) {
        let body = null;
        try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (e) { body = { unparsed: String(init && init.body) }; }
        try {
          window.__CHECKOUT_OPENS.push({ body, answer: await response.clone().json() });
        } catch (e) {
          window.__CHECKOUT_OPENS.push({ body, observerError: String(e) });
        }
      }
      return response;
    };
  });
}

/** GET a checkout route and parse it, failing loudly with the status and body on anything but 200. */
async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`GET ${url} answered unparseable JSON (${e.message}): ${text.slice(0, 300)}`);
  }
}

/**
 * Walk the checkout's OWN payer routes for the charge the merchant just opened: step 2 mints a quote,
 * step 3 hands back the transfer instruction. Returns the destination account, the decimal amount
 * and the per-charge `ref` the transfer must carry as its memo.
 */
async function resolveCharge(relayBaseURL, id) {
  const details = await getJson(`${relayBaseURL}/v1/lnurlp/${id}?timeout=0`);
  const quote = details?.quote?.id;
  assert(typeof quote === 'string' && quote.length > 0, `the checkout must mint a quote, got ${JSON.stringify(details?.quote)}`);
  const callback = `${details.callback}?quote=${encodeURIComponent(quote)}&method=InternetComputer&asset=VCHF`;
  const instruction = await getJson(callback);
  const uri = instruction?.uri ?? '';
  const to = /[?&]to=([^&]+)/.exec(uri)?.[1] ?? null;
  const amount = /[?&]amount=([^&]+)/.exec(uri)?.[1] ?? null;
  const ref = /[?&]ref=([0-9a-f]{32})/.exec(uri)?.[1] ?? null;
  assert(to && amount && ref, `the checkout's step-3 URI must name to/amount/ref, got "${uri}"`);
  return { to, amount, ref, displayName: details.displayName };
}

export async function run() {
  const start = Date.now();
  console.log('[114-checkout-open] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[114-checkout-open] onboarding the shop…');
    await onboardWallet(driver, 'Bahnhof Kiosk');
    const merchant = await accountOf(driver);
    assert(typeof merchant?.publicHex === 'string' && merchant.publicHex.length === 64,
      `the shop's wallet must have a 32-byte account key, got "${merchant?.publicHex}"`);
    const merchantPrincipal = await railPrincipalText(merchant.publicHex);

    // The customer: an independent key, funded on VCHF only. Nothing about them is in the app.
    const payer = await generateKeypair();
    const funded = await faucetAccount(relayBaseURL, payer.publicHex, PAYER_SEED, { currency: VCHF });
    assert(funded.ok, `the customer must be funded in VCHF, got HTTP ${funded.status}`);
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), '0', 'the shop starts with no VCHF');

    // --- the counter -------------------------------------------------------------------------
    console.log('[114-checkout-open] opening the CHF charge 10.50…');
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    // The checkout code is a CHECKBOX beside the shared amount row — not a third tab.
    assert(await driver.isPresent('receive-code-form'), 'the checkout-code checkbox must render on the Receive form');
    await observeCheckoutOpens(driver);
    await driver.click('btn-code-checkout', { timeoutMs: 4_000 });

    // --- ONE message box, both code forms (founder 2026-09-14) ---------------------------------
    // The message box is the SAME input in the same place whether or not the checkout checkbox is
    // checked, and its text survives the toggle in both directions. Type it in the CHECKOUT form…
    const NOTE = '2x Kafi, Tisch 4';
    await driver.type('memo-input', NOTE, { timeoutMs: 4_000 });
    // …toggle OFF (back to the dpay form): same box, same place, same text…
    await driver.click('btn-code-checkout', { timeoutMs: 4_000 });
    assert(await driver.isPresent('memo-input'), 'the message box stays mounted when the checkout checkbox is unchecked');
    assertEq(await driver.readInputValue('memo-input'), NOTE, 'the message text survives unchecking the checkout checkbox');
    // …and ON again: still the same box with the same text — the BUTTON is what flips, not the box.
    await driver.click('btn-code-checkout', { timeoutMs: 4_000 });
    assert(await driver.isPresent('memo-input'), 'the message box stays mounted when the checkout checkbox is checked');
    assertEq(await driver.readInputValue('memo-input'), NOTE, 'the message text survives checking the checkout checkbox again');

    await driver.type('amount-input', PRICE, { timeoutMs: 4_000 });
    await driver.click('btn-checkout-open', { timeoutMs: 4_000 });

    await driver.findByTestID('checkout-qr', { timeoutMs: 15_000 });
    const shown = await driver.bodyText();
    assertIncludes(shown, '10.50 CHF', 'the cashier reads the franc price back');
    assertIncludes(shown, '10.4999 VCHF', 'and what the SHOP receives, the price less the fee it absorbs');
    assertIncludes(shown, 'Waiting for the payment', 'the honest waiting line');
    // The status route exposes no scan signal, so the screen may never imply one.
    assert(!/scanned/i.test(shown), `the screen must not claim the customer scanned anything:\n${shown.slice(0, 400)}`);
    // A live charge hides the toggles and the checkbox: flipping away would abandon a payable code.
    assert(!(await driver.isPresent('receive-code-form')), 'the checkout-code checkbox hides while a charge is live');
    assert(!(await driver.isPresent('receive-mode-toggle')), 'the request/address toggle hides while a charge is live');
    await driver.screenshot('114-checkout-code');

    // --- what the relay actually opened --------------------------------------------------------
    const opens = await driver.eval(() => window.__CHECKOUT_OPENS);
    assertEq(opens.length, 1, 'exactly one checkout-open was sent');
    const open = opens[0].answer;
    // The one-box seam, on the wire: the text typed into the SHARED message box rode the checkout-open
    // as the signed `note` (the observer kept the request body for exactly this assertion).
    assertEq(opens[0].body.note, NOTE, 'the shared message box’s text rides the checkout-open as the signed note');
    assertEq(open.asset, 'VCHF', 'a dpay checkout quotes VCHF and nothing else');
    // NO CUSTODY, asserted rather than promised: the destination is the SHOP's own account, derived
    // from the key the app signed with — the relay never holds it.
    assertEq(open.merchant, merchantPrincipal, 'the charge is opened on the shop’s own account');
    assert(/^pl_[0-9a-f]{16}$/.test(open.id), `the charge id must be the standard's shape, got "${open.id}"`);

    // --- the customer pays it, through the checkout's own routes -----------------------------------
    console.log(`[114-checkout-open] customer resolving ${open.id} and paying…`);
    const instruction = await resolveCharge(relayBaseURL, open.id);
    assertEq(instruction.to, merchantPrincipal, 'the transfer instruction names the shop’s own account');
    assertEq(instruction.amount, '10.4999', 'the checkout instructs the settlement amount, never the price');
    assertEq(instruction.displayName, 'Bahnhof Kiosk', 'the checkout carries the shop’s claimed name');
    const paid = await railTransferOrFail(relayBaseURL, payer, merchant.publicHex, instruction.ref);
    console.log(`[114-checkout-open] transfer submitted (request id ${paid.requestIdHex.slice(0, 16)}…)`);

    // --- the screen flips because the RELAY saw the money, not because we told it ---------------
    assert(await driver.waitForText('Paid 10.50 CHF', { timeoutMs: 30_000 }),
      `the merchant screen must report the sale once the relay observes it. screen:\n${(await driver.bodyText()).slice(0, 600)}`);
    const settled = await driver.bodyText();
    assertIncludes(settled, 'Ledger block', 'the sale names the ledger row that paid it');
    assert(!/expired/i.test(settled), 'a sale paid inside the code’s life is not marked late');

    // …and the money is really there.
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, VCHF)), String(PAY_RAW), 'the shop was credited the price less the fee it absorbs');
    // THE FOUNDER'S RULE, on the ledger: a CHF 10.50 price moved the customer's account by exactly
    // CHF 10.50 — not the price plus a fee. The shop is the one out of pocket for it.
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, VCHF)), String(PAYER_SEED - PRICE_RAW), 'the customer was debited the price and not one unit more');

    await driver.screenshot('114-checkout-paid');

    // --- back to an empty counter ---------------------------------------------------------------
    await driver.click('btn-checkout-new', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-checkout-open', { timeoutMs: 4_000 });
    // waitFor, not isPresent: under host load the two reset-render siblings can land across a
    // paint boundary — the element IS part of the empty-counter state, so give it the same
    // budget the button just used.
    await driver.findByTestID('receive-code-form', { timeoutMs: 4_000 });
    assert(await driver.isPresent('receive-code-form'), 'the checkbox returns once nothing is live');
    // The note is the shared box's (the parent's), so "Next customer" keeps it exactly as it keeps
    // the price — the next charge is almost always for the same thing, and the cashier edits, not retypes.
    assertEq(await driver.readInputValue('memo-input'), NOTE, 'the shared message box keeps its text for the next customer');

    console.log(`[114-checkout-open] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

/** Sign + submit the customer's VCHF transfer, carrying the charge's reference as the memo. */
async function railTransferOrFail(relayBaseURL, payer, merchantPubHex, ref) {
  const res = await railTransfer(relayBaseURL, payer.secretHex, merchantPubHex, PAY_RAW, { currency: VCHF, memoHex: ref });
  assert(res.ok, `the customer's transfer must be accepted, got HTTP ${res.status}: ${res.bodyText.slice(0, 200)}`);
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('114-checkout-open RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
