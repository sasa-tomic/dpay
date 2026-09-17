// Flow 97 — VCHF merchant request + exact-memo reconciliation (wave: VCHF+ICP, 2026-08-28).
//
// The VCHF twin of flow 08's merchant-settle journey, on the new no-minter native asset:
//   * (2) A merchant creates an 8-decimal VCHF request IN THE APP (Receive tab → 1.00000001):
//         the screen headlines the typed price, and the encoded request carries exactly VCHF's
//         currency id and the NETTED wire raw units (99990001 = 100000001 price − 10000 fee,
//         founder rule 2026-09-12: the customer pays exactly the price, the payee nets the fee)
//         to the merchant's account — byte-checked via decodeRequest, fee line on-screen.
//   * (6) Receiver-side exact-memo reconciliation reaches Received ONLY on the exact row: a
//         harness-signed transfer with the WRONG memo settles on the rail (merchant's VCHF
//         balance grows by the wire) but the open request does NOT flip to Received; the SAME
//         transfer with the request's exact memo nonce flips it to "Received 1.00000001 VCHF"
//         (the typed price) with the payer's short principal. The memo nonce binds the
//         confirmation to THIS request.
//   * The settlement rail is VCHF's exact ledger principal ly36x-wiaaa-aaaai-aqj7q-cai and the
//         sender pays the 10000 fee on top of the wire (one leg debits the payer exactly the
//         price); the merchant's DEMO balance (and every other currency) is untouched.
//   * (7) The merchant's Ledger headlines the GROSS on the memo-matched row: "+1.00000001 VCHF"
//         (the typed price, founder rule 2026-09-14) with a "− 0.0001 VCHF fees" annotation;
//         the wrong-memo row keeps its bare wire amount (no note joins it — honest display).
//         + payer short key. The rail itself credited the wire on both legs.
//
// The ICP twin is flow 98; the payer-side journeys are flows 95/96.
import {
  setup, assert, assertEq, assertIncludes, getBalance, faucetAccount, icpCatalog, railPrincipalText,
  onboardWallet, accountOf, openBalances, selectCurrency,
} from '../harness/lib.mjs';
import { openHistory } from '../harness/flow-steps.mjs';
import {
  generateKeypair, randNonceHex, decodeRequestHex, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate,
  b64urlEncode,
} from '../harness/wire.mjs';
import { parsePayLink } from '../harness/paylink.mjs';

const CURRENCY = 7; // VCHF
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const PAYER_SEED = 300000000; // 3.00000000 VCHF — covers two price legs (wire + fee each)
const PAY = 100000001; // 1.00000001 VCHF — the PRICE the customer pays per leg, exactly
const FEE = 10000; // VCHF catalog fee — the payee's cost, netted out of the quoted wire
const WIRE = PAY - FEE; // 99990001 — the netted wire the in-app request carries (price − fee)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '97',
  name: 'vchf-merchant-reconcile',
  journey: 'pay',
  covers: ['vchf', 'icp-mainnet', 'merchant-request', '8-decimals', 'signed-envelope', 'ledger-target', 'exact-memo', 'reconciliation', 'fail-closed-confirm', 'ledger-row'],
  verifies: 'A merchant creates a 1.00000001 VCHF request in-app; the request headlines the typed price with the fee/receives line and encodes the netted wire 99990001 (price − fee, founder rule). A wrong-memo wire transfer to the VCHF ledger settles on the rail but does NOT flip the request to Received; the exact-memo wire transfer flips it (Received shows the typed price). Each leg debits the payer exactly the price (wire + fee); no other currency moves; merchant Ledger headlines the gross +1.00000001 VCHF on the memo-matched row (the typed price, with a "\u2212 0.0001 VCHF fees" annotation — founder rule 2026-09-14; the wrong-memo row keeps its bare wire amount) from the payer short key.',
  timeoutMs: 60_000, // two confirm polls (wrong leg burns the ~4.5s proof budget before failing) + settle polls.
  // 2026-08-28: raised 35s → 60s + widened the two reconcile waits to 20s — under full-suite
  // contention on the shared host the ~4.5s poll exhaust + render outran the old 8s wait
  // (failed in-suite 2× while passing standalone; same conditions, more patience).
};

export async function run() {
  const start = Date.now();
  console.log('[97-vchf-merchant-reconcile] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    // --- Harness payer (funded on VCHF only) + relay catalog truth -----------------------------
    const payer = await generateKeypair();
    const seedRes = await faucetAccount(relayBaseURL, payer.publicHex, PAYER_SEED, { currency: CURRENCY });
    assert(seedRes.ok, `payer faucet credit ok (status ${seedRes.status})`);

    const catalog = await icpCatalog(relayBaseURL);
    const desc = catalog.find((c) => c.currency === CURRENCY);
    assert(desc != null, 'relay catalog serves the VCHF row');
    assertEq(desc.ledger, VCHF_LEDGER, 'relay VCHF ledger principal');
    assertEq(String(desc.fee), String(FEE), 'relay VCHF fee');

    // --- (2) Merchant creates the 8-decimal request in the app --------------------------------
    console.log('[97-vchf-merchant-reconcile] merchant requests 1.00000001 VCHF in-app…');
    // Radio ready so the request ALSO builds the NFC wire (its one surface now) — the byte-exact
    // currency-id + raw-units encode contract is asserted off the reader seam below.
    const nfcSeam = await driver.addInitScript(() => { globalThis.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-vchf-merchant');
    await driver.removeInitScript(nfcSeam);
    const merchant = await accountOf(driver);
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');

    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '1.00000001', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 6_000 });
    assertIncludes(await driver.bodyText(), '1.00000001 VCHF', 'request screen headlines the typed price');
    assertIncludes(await driver.bodyText(), 'you receive 0.99990001 VCHF', 'request screen fee line names the netted wire the payee receives (fee is the payee\'s cost)');
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(requestQR != null, 'request QR seam exposed the payment link');
    // Founder 2026-09-12: the QR is the payment LINK — payable facts on the link, byte-exact wire
    // on the reader seam, `ref` = the reconciliation nonce the exact-memo leg must replay.
    const link = parsePayLink(requestQR);
    assert(link != null, 'request QR parses as the payment link');
    assertEq(link.asset, 'VCHF', 'link names the requested asset');
    assertEq(link.network, 'internet-computer', 'link names the settlement network');
    assertEq(link.amount, '0.99990001', 'link carries the netted 8-decimal wire (price − fee)');
    assertEq(link.recipient, await railPrincipalText(merchant.publicHex), 'link payee = merchant principal');
    assert(/^[0-9a-f]{32}$/.test(link.ref ?? ''), 'link ref = the 16-byte request nonce');
    const nonceHex = link.ref;

    let readerHex = null;
    for (let i = 0; i < 100 && !readerHex; i++) {
      readerHex = await driver.eval(() => window.__DPAY_TEST_NFC_READER_REQUEST ?? null);
      if (!readerHex) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(readerHex != null, 'NFC reader armed with the 132-byte wire request');
    const req = decodeRequestHex(readerHex);
    assertEq(req.currency, CURRENCY, 'encoded wire currency id (VCHF)');
    assertEq(req.amount, String(WIRE), 'encoded wire exact raw units = the netted wire (8-decimal tail)');
    assertEq(req.toHex, merchant.publicHex, 'encoded wire payee = merchant account');

    const merchantBefore = {};
    for (let c = 0; c <= 8; c++) merchantBefore[c] = String(await getBalance(relayBaseURL, merchant.publicHex, c));
    assertEq(merchantBefore[CURRENCY], '0', 'merchant starts at 0 VCHF');

    // --- (6) WRONG-memo leg: settles on the rail, must NOT flip the request --------------------
    console.log('[97-vchf-merchant-reconcile] wrong-memo transfer (settles on rail, must NOT confirm)…');
    const envelope = async (memoHex) => {
      const arg = icpTransferArgBytes(icpPrincipalBytes(merchant.publicHex), BigInt(WIRE), {
        fee: BigInt(desc.fee),
        memoHex,
      });
      const signed = await icpSignUpdate(payer.secretHex, desc.ledger, 'icrc1_transfer', arg, BigInt(Date.now() + 300_000) * 1_000_000n);
      return b64urlEncode(hexBytes(signed.envelopeHex));
    };
    const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));

    await openPayerScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, await envelope(randNonceHex()));

    // The confirm poll must exhaust (~4.5s under e2e overrides) and surface its err — the request
    // stays open, NO Received.
    const sawErr = await driver.waitForText('confirm this payment yet', { timeoutMs: 20_000 });
    assert(sawErr, 'wrong-memo leg surfaces the could-not-confirm error');
    assert(!(await driver.bodyText()).includes('Received'), 'wrong-memo leg must NOT flip the request to Received');
    assert((await driver.findByTestID('request-qr', { timeoutMs: 2_000 })) != null, 'request QR stays open after the wrong-memo scan');

    // The rail settled anyway — the memo is what binds the CONFIRMATION, not the credit.
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, CURRENCY)), String(WIRE), 'rail credited the wrong-memo wire transfer (UI must not confirm)');

    // --- (6) EXACT-memo leg: flips the open request to Received --------------------------------
    console.log('[97-vchf-merchant-reconcile] exact-memo transfer (must confirm)…');
    await openPayerScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, await envelope(nonceHex));
    await driver.waitForText('Received 1.00000001 VCHF', { timeoutMs: 20_000 });
    assertIncludes(await driver.bodyText(), '1.00000001 VCHF', 'received screen shows exact VCHF amount');

    // --- Balances: exact credits/debits, sibling isolation --------------------------------------
    console.log('[97-vchf-merchant-reconcile] assert exact balances + sibling isolation…');
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, CURRENCY)), String(WIRE * 2), 'merchant credited BOTH wire transfers (2 × 0.99990001 VCHF — the fee is the merchant\'s cost)');
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, CURRENCY)), String(PAYER_SEED - 2 * PAY), 'payer debited 2 × EXACTLY the price (wire + fee per leg, founder rule)');
    for (let c = 0; c <= 8; c++) {
      if (c !== CURRENCY) {
        assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, c)), merchantBefore[c], `merchant sibling currency ${c} unchanged`);
      }
    }
    assertEq(merchantBefore['0'], '10000', 'merchant DEMO balance was the onboard faucet amount (sanity)');

    // --- (7) Merchant Ledger: incoming row with exact units + payer counterparty ----------------
    console.log('[97-vchf-merchant-reconcile] assert Ledger incoming row…');
    await openHistory(driver);
    const shortPayer = (await railPrincipalText(payer.publicHex)).slice(0, 8);
    const named = await driver.waitForText(shortPayer, { timeoutMs: 10_000 });
    const histBody = await driver.bodyText();
    assert(named, `merchant history row names the payer (short principal ${shortPayer}). history:\n${histBody.slice(0, 500)}`);
    assertIncludes(histBody, '+1.00000001 VCHF', 'memo-matched history row headlines the GROSS (+ prefix, the typed price = wire + fee — founder rule 2026-09-14)');
    assertIncludes(histBody, '\u2212 0.0001 VCHF fees', 'memo-matched row carries the fee as its annotation line');
    assertIncludes(histBody, '+0.99990001 VCHF', 'wrong-memo row keeps the bare received wire — nothing joins it, so nothing is invented');
    assert(!histBody.includes(payer.publicHex), 'history must not dump the payer full hex');

    await driver.screenshot('97-vchf-merchant-reconcile');
    console.log(`[97-vchf-merchant-reconcile] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

/** Open ReceiveMode's "Scan payer's signed QR" affordance (the offline-payer confirm path). The
 *  button has no testID — find the exact label text node and walk up, clicking each wrapper (RNW
 *  renders Pressables as plain elements). Same pattern as flows 08/21. */
async function openPayerScan(driver) {
  await driver.eval(() => {
    const nodes = Array.from(document.querySelectorAll('text, span, div, a, button, [role]'));
    const target = nodes.find(e => (e.textContent || '').trim() === "Scan payer's signed QR" && e.children.length === 0);
    if (!target) throw new Error('affordance button label node not found');
    let el = target;
    for (let i = 0; i < 5 && el; i++) {
      el.click?.();
      el = el.parentElement;
    }
  });
  const scanning = await driver.waitForText("Scan the payer's signed QR", { timeoutMs: 5_000 });
  assert(scanning, 'clicking the affordance should mount the scanner (label swaps)');
}

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('97-vchf-merchant-reconcile RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
