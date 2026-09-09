// Flow 106 — ONE destination field, two rails: ckBTC reaches both a Bitcoin address and an
// Internet Computer account, and the app says which BEFORE the user commits.
//
// This is the founder-chosen behaviour ("every IC asset, auto-routed"): the user never picks a
// mechanism, they paste an address. What they paste decides whether the money leaves as a chain-key
// burn to Bitcoin (slow, high minimum) or as a plain icrc1_transfer on the Internet Computer
// (seconds, tiny fee) — and the route line names the difference so the choice is informed.
//
// It also closes a real asymmetry. The ck* DEPOSIT sheets have advertised the inbound IC route
// since 2026-08-29 ("Already on the Internet Computer? — send ckBTC straight in"), but there was no
// way to send it back OUT that way: the send surface only ever offered the Bitcoin burn. Holding
// ckBTC and wanting it in an Internet Computer wallet meant a full Bitcoin round trip.
//
// The flow asserts BOTH readings of the same field, in one session, without leaving the screen:
//   1. a Bitcoin address       → the route line names Bitcoin and quotes the chain's ~10 min +
//                                0.00050000 BTC minimum, and the chain-key withdraw body appears
//                                (its amount field carries the minimum rule)
//   2. an IC principal         → the route line flips to the Internet Computer with a per-transfer
//                                fee, and the DIRECT send body appears instead
//   3. the direct send executes → the recipient principal is credited on the ckBTC ledger itself,
//                                proving this was an ICRC-1 transfer and not a burn
//
// Step 3 is the one that could not happen before this change at all.
//
// Selector contract: `balance`, `asset-ckbtc-select`, `btn-pay-send`, `send-address-input`,
// `send-status`, `withdraw-amount-input` (native body), `send-amount-input` (direct body),
// `send-review-amount`, `send-review-fee`, `btn-send-confirm`, `send-destination`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, openPaySend, railPrincipalText,
} from '../harness/lib.mjs';

const CURRENCY = 1;            // mainnet ckBTC — a chain-key family, so BOTH routes are reachable
const ASSET_KEY = 'ckbtc';
const SEED_SATS = 200_000;     // 0.00200000 BTC
const SEND_TEXT = '0.00030000';
const SEND_SATS = 30_000;      // deliberately BELOW the 50_000-sat Bitcoin withdraw minimum:
                               // it is a perfectly good IC transfer, which is part of the point
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const RECIPIENT_PUBKEY = 'c'.repeat(64);

export const meta = {
  id: '106',
  name: 'send-auto-route',
  journey: 'withdraw',
  covers: ['send-to-address', 'auto-route', 'ckbtc', 'icrc1_transfer', 'route-disclosure', 'balance-delta'],
  verifies: 'One destination field routes ckBTC by what is pasted: a Bitcoin address discloses the Bitcoin chain (~10 min, 0.0005 minimum) and shows the burn body; an IC principal discloses the Internet Computer and sends a plain icrc1_transfer that credits the recipient on the ckBTC ledger — a route that did not exist before.',
  // Same reasoning as flow 105: measured ~31s under mild load against a 30s budget.
  timeoutMs: 45000,
};

export async function run() {
  const start = Date.now();
  console.log('[106-send-auto-route] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-autoroute');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'wallet account must be a 32-byte hex pubkey');
    const recipientPrincipal = await railPrincipalText(RECIPIENT_PUBKEY);

    const fund = await faucetAccount(relayBaseURL, accountHex, SEED_SATS, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);
    const senderBefore = await getBalance(relayBaseURL, accountHex, CURRENCY);
    assertEq(senderBefore, String(SEED_SATS), 'pre-send ckBTC balance');

    await openBalances(driver);
    await driver.waitForText('0.00200000 BTC', { timeoutMs: 8_000 });
    await selectCurrency(driver, ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // --- 1. a Bitcoin address → the chain-key burn, with the BITCOIN economics disclosed --------
    console.log('[106-send-auto-route] pasting a Bitcoin address…');
    await driver.type('send-address-input', BTC_ADDR, { timeoutMs: 4_000 });
    await driver.waitForText('Bitcoin', { timeoutMs: 6_000 });
    const btcRoute = await driver.readText('send-status');
    assertIncludes(btcRoute, 'Bitcoin', 'the route line names the Bitcoin chain');
    assertIncludes(btcRoute, '0.00050000', "the route line quotes Bitcoin's withdraw minimum, not an IC fee");
    // The chain-key body is what renders for a native destination — its amount field is the tell.
    await driver.findByTestID('withdraw-amount-input', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('send-amount-input')), 'the DIRECT send body must not render for a native destination');
    console.log(`[106-send-auto-route] ✓ Bitcoin route: "${btcRoute}"`);

    // --- 2. the SAME field, an IC principal → the direct rail, with IC economics ----------------
    console.log('[106-send-auto-route] replacing it with an Internet Computer principal…');
    await driver.type('send-address-input', recipientPrincipal, { timeoutMs: 4_000 });
    await driver.waitForText('Internet Computer', { timeoutMs: 6_000 });
    const icRoute = await driver.readText('send-status');
    assertIncludes(icRoute, 'Internet Computer', 'the route line flips to the Internet Computer');
    assert(!icRoute.includes('Bitcoin'), `the IC route must not still quote Bitcoin, got: "${icRoute}"`);
    // …and the bodies swap: the direct send form replaces the burn form.
    await driver.findByTestID('send-amount-input', { timeoutMs: 5_000 });
    assert(!(await driver.isPresent('withdraw-amount-input')), 'the chain-key burn body must not render for an IC destination');
    console.log(`[106-send-auto-route] ✓ Internet Computer route: "${icRoute}"`);

    // --- 3. execute the direct route ------------------------------------------------------------
    // 30_000 sats is BELOW the Bitcoin withdraw minimum and still a valid IC transfer — the two
    // rails genuinely have different rules, and the right one is being applied.
    await driver.type('send-amount-input', SEND_TEXT, { timeoutMs: 4_000 });
    await driver.findByTestID('send-review-amount', { timeoutMs: 4_000 });
    // The fee shown is the one the LEDGER reported (icrc1_fee), not the catalog's — ckBTC's row
    // carries none at all, so a catalog-sourced screen would have printed a fabricated 0. This
    // ledger charges nothing, and a zero fee is stated in words: a money screen never shows
    // "0.00000000 BTC", which reads as a malfunction rather than as good news.
    const feeCell = await driver.readText('send-review-fee');
    assertEq(feeCell, 'none', 'a genuinely-zero ledger fee reads as "none", never as 0.00000000 BTC');
    await driver.click('btn-send-confirm', { timeoutMs: 5_000 });
    const sent = await driver.waitForText('Sent', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(sent, `the IC send should confirm "Sent". body excerpt:\n${body.slice(0, 600)}`);

    const shownDest = await driver.readText('send-destination');
    assertEq(shownDest, recipientPrincipal, 'the success screen shows the full IC destination');

    // The decisive assertion: the recipient holds ckBTC on the ckBTC LEDGER. A burn would have
    // destroyed the tokens and paid out on Bitcoin instead — nothing would be credited here.
    const recipientAfter = await getBalance(relayBaseURL, RECIPIENT_PUBKEY, CURRENCY);
    assertEq(recipientAfter, String(SEND_SATS), 'recipient credited on the ckBTC ledger (an ICRC-1 transfer, not a burn)');
    // ckBTC's catalog row carries no registered fee, so the sender's debit is exactly the amount.
    const senderAfter = await getBalance(relayBaseURL, accountHex, CURRENCY);
    assertEq(senderAfter, String(SEED_SATS - SEND_SATS), 'sender debited by the amount');
    console.log(`[106-send-auto-route] ✓ ckBTC moved on the IC: sender ${senderBefore} → ${senderAfter}, recipient 0 → ${recipientAfter} sats`);

    await driver.screenshot('106-send-auto-route');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[106-send-auto-route] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[106-send-auto-route] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
