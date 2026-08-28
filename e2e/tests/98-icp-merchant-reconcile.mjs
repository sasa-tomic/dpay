// Flow 98 — ICP merchant request + exact-memo reconciliation (wave: VCHF+ICP, 2026-08-28).
//
// The ICP twin of flow 97, on the native ICP ledger row (currency 8, no minter):
//   * (2) A merchant creates an 8-decimal ICP request IN THE APP (Receive tab → 1.00000001):
//         the encoded request carries exactly ICP's currency id and the exact raw units
//         (100000001) to the merchant's account — byte-checked via decodeRequest.
//   * (6) Receiver-side exact-memo reconciliation reaches Received ONLY on the exact row: a
//         harness-signed transfer with the WRONG memo settles on the rail (merchant's ICP
//         balance grows) but the open request does NOT flip to Received; the SAME transfer
//         with the request's exact memo nonce flips it to "Received 1.00000001 ICP" with the
//         payer's short principal. The memo nonce binds the confirmation to THIS request.
//   * The settlement rail is ICP's exact ledger principal ryjl3-tyaaa-aaaaa-aaaba-cai and the
//         sender pays the 10000 fee; the merchant's DEMO balance (and every other currency)
//         is untouched.
//   * (7) The merchant's Ledger shows the incoming row: "+1.00000001 ICP" + payer short key.
//
// The VCHF twin is flow 97; the payer-side journeys are flows 95/96.
import {
  setup, assert, assertEq, assertIncludes, getBalance, faucetAccount, icpCatalog, railPrincipalText,
  onboardWallet, accountOf, openBalances, selectCurrency,
} from '../harness/lib.mjs';
import {
  generateKeypair, randNonceHex, decodeRequest, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate,
  b64urlEncode,
} from '../harness/wire.mjs';

const CURRENCY = 8; // ICP
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const PAYER_SEED = 300000000; // 3.00000000 ICP — covers two (pay + fee) legs
const PAY = 100000001; // 1.00000001 ICP
const FEE = 10000; // ICP catalog fee, charged to the sender (harness-signed legs pay it too)

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '98',
  name: 'icp-merchant-reconcile',
  journey: 'pay',
  covers: ['icp', 'icp-mainnet', 'merchant-request', '8-decimals', 'signed-envelope', 'ledger-target', 'exact-memo', 'reconciliation', 'fail-closed-confirm', 'ledger-row'],
  verifies: 'A merchant creates a 1.00000001 ICP request in-app (exact raw units 100000001); a wrong-memo transfer to the ICP ledger settles on the rail but does NOT flip the request to Received; the exact-memo transfer flips it. Sender pays the 10000 fee; no other currency moves; merchant Ledger shows +1.00000001 ICP from the payer short key.',
  timeoutMs: 60_000, // two confirm polls (wrong leg burns the ~4.5s proof budget before failing) + settle polls.
  // 2026-08-28: raised 35s → 60s + widened the two reconcile waits to 20s to match flow 97 —
  // identical structure, same contention exposure (97 failed in-suite 2× at the old 8s wait).
};

export async function run() {
  const start = Date.now();
  console.log('[98-icp-merchant-reconcile] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { relayBaseURL, driver } = env;

    // --- Harness payer (funded on ICP only) + relay catalog truth -----------------------------
    const payer = await generateKeypair();
    const seedRes = await faucetAccount(relayBaseURL, payer.publicHex, PAYER_SEED, { currency: CURRENCY });
    assert(seedRes.ok, `payer faucet credit ok (status ${seedRes.status})`);

    const catalog = await icpCatalog(relayBaseURL);
    const desc = catalog.find((c) => c.currency === CURRENCY);
    assert(desc != null, 'relay catalog serves the ICP row');
    assertEq(desc.ledger, ICP_LEDGER, 'relay ICP ledger principal');
    assertEq(String(desc.fee), String(FEE), 'relay ICP fee');

    // --- (2) Merchant creates the 8-decimal request in the app --------------------------------
    console.log('[98-icp-merchant-reconcile] merchant requests 1.00000001 ICP in-app…');
    await onboardWallet(driver, 'e2e-icp-merchant');
    const merchant = await accountOf(driver);
    await openBalances(driver);
    await selectCurrency(driver, 'icp');

    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '1.00000001', { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 6_000 });
    assertIncludes(await driver.bodyText(), '1.00000001 ICP', 'request screen shows exact ICP amount');
    const requestQR = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(requestQR != null, 'request QR seam exposed the encoded request');
    const req = decodeRequest(requestQR);
    assertEq(req.currency, CURRENCY, 'encoded request currency id (ICP)');
    assertEq(req.amount, String(PAY), 'encoded request exact raw units (8-decimal tail)');
    assertEq(req.toHex, merchant.publicHex, 'encoded request payee = merchant account');

    const merchantBefore = {};
    for (let c = 0; c <= 8; c++) merchantBefore[c] = String(await getBalance(relayBaseURL, merchant.publicHex, c));
    assertEq(merchantBefore[CURRENCY], '0', 'merchant starts at 0 ICP');

    // --- (6) WRONG-memo leg: settles on the rail, must NOT flip the request --------------------
    console.log('[98-icp-merchant-reconcile] wrong-memo transfer (settles on rail, must NOT confirm)…');
    const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
    const envelope = async (memoHex) => {
      const arg = icpTransferArgBytes(icpPrincipalBytes(merchant.publicHex), BigInt(PAY), {
        fee: BigInt(desc.fee),
        memoHex,
      });
      const signed = await icpSignUpdate(payer.secretHex, desc.ledger, 'icrc1_transfer', arg, BigInt(Date.now() + 300_000) * 1_000_000n);
      return b64urlEncode(hexBytes(signed.envelopeHex));
    };

    await openPayerScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, await envelope(randNonceHex()));

    // The confirm poll must exhaust (~4.5s under e2e overrides) and surface its err — the request
    // stays open, NO Received.
    const sawErr = await driver.waitForText('confirm this payment yet', { timeoutMs: 20_000 });
    assert(sawErr, 'wrong-memo leg surfaces the could-not-confirm error');
    assert(!(await driver.bodyText()).includes('Received'), 'wrong-memo leg must NOT flip the request to Received');
    assert((await driver.findByTestID('request-qr', { timeoutMs: 2_000 })) != null, 'request QR stays open after the wrong-memo scan');

    // The rail settled anyway — the memo is what binds the CONFIRMATION, not the credit.
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, CURRENCY)), String(PAY), 'rail credited the wrong-memo transfer (UI must not confirm)');

    // --- (6) EXACT-memo leg: flips the open request to Received --------------------------------
    console.log('[98-icp-merchant-reconcile] exact-memo transfer (must confirm)…');
    await openPayerScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, await envelope(req.nonceHex));
    await driver.waitForText('Received 1.00000001 ICP', { timeoutMs: 20_000 });
    assertIncludes(await driver.bodyText(), '1.00000001 ICP', 'received screen shows exact ICP amount');

    // --- Balances: exact credits/debits, sibling isolation --------------------------------------
    console.log('[98-icp-merchant-reconcile] assert exact balances + sibling isolation…');
    assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, CURRENCY)), String(PAY * 2), 'merchant credited BOTH rail transfers (2 × 1.00000001 ICP)');
    assertEq(String(await getBalance(relayBaseURL, payer.publicHex, CURRENCY)), String(PAYER_SEED - 2 * (PAY + FEE)), 'payer debited 2 × (amount + fee)');
    for (let c = 0; c <= 8; c++) {
      if (c !== CURRENCY) {
        assertEq(String(await getBalance(relayBaseURL, merchant.publicHex, c)), merchantBefore[c], `merchant sibling currency ${c} unchanged`);
      }
    }
    assertEq(merchantBefore['0'], '10000', 'merchant DEMO balance was the onboard faucet amount (sanity)');

    // --- (7) Merchant Ledger: incoming row with exact units + payer counterparty ----------------
    console.log('[98-icp-merchant-reconcile] assert Ledger incoming row…');
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    await driver.waitForText('RECENT', { timeoutMs: 8_000 });
    const shortPayer = (await railPrincipalText(payer.publicHex)).slice(0, 8);
    let histBody = '';
    for (let i = 0; i < 20; i++) {
      histBody = await driver.bodyText();
      if (histBody.includes(shortPayer)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assertIncludes(histBody, shortPayer, 'merchant history row names the payer (short principal text)');
    assertIncludes(histBody, '+1.00000001 ICP', 'merchant history incoming row amount (+ prefix, exact units)');
    assert(!histBody.includes(payer.publicHex), 'history must not dump the payer full hex');

    await driver.screenshot('98-icp-merchant-reconcile');
    console.log(`[98-icp-merchant-reconcile] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
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
    console.error('98-icp-merchant-reconcile RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
