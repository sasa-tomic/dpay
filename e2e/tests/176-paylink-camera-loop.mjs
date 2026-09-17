// Flow 176 — the GENERIC camera loop: a phone camera (not a dpay-specific scanner) drives a
// merchant request end to end, on both rails.
//
// Founder decision 2026-09-12: every payment-request QR the wallet renders IS the payment-LINK
// URL. This flow is that decision's full-loop proof — the string a regular camera app would open
// is the SAME string that pays and reconciles:
//
//   IC leg:  merchant opens a request → the QR carries /wallet/pay/<own-principal>?…&ref=<nonce>
//            → the payer camera-scans THAT EXACT STRING (the camera seam, not a crafted fixture)
//            → the IC review shows it (no auto-pay) → Approve signs + settles with the link's
//            `ref` as the on-chain memo → the merchant's OPEN request screen auto-confirms
//            "Received" from the memo (the reconciliation that used to ride the wire's nonce —
//            it is the same 16 bytes).
//
//   SOL leg: merchant opens a SOL request → the QR carries the SOL link (ref stays null — the
//            rail attaches no reconciliation memo, never promise what the rail can't keep) →
//            camera-scan → the Send-to-address form pre-fills → Confirm broadcasts (stub) →
//            "Sent ✓". The request screen does NOT auto-confirm — documented link semantics:
//            the payment lands on balances/transactions; the screen still confirms via NFC or
//            the payer's signed-QR scan-back (flows 51/74/138 cover those).
//
// TWO identities, one relay: the merchant app stays PARKED on its open request screen while a
// SECOND fresh incognito context (a second phone: its own localStorage identity, faucet-funded)
// plays the payer — an IC request does not survive its screen unmounting, so the merchant context
// must never leave the receive tab for the memo reconciliation to be observed live.
//
// Selector contract: `request-qr`, `sol-req-qr`, `pay-amount`, `review-payee`, `btn-approve`,
// `sol-send-address-input`, `sol-send-amount-input`, `btn-sol-send-confirm`, `sol-send-outcome`.
import {setup, getSession, assert, assertEq, assertIncludes, onboardWallet, railPrincipalText, openBalances, armPayScan, accountOf} from '../harness/lib.mjs';
import {parsePayLink} from '../harness/paylink.mjs';
import {Driver} from '../harness/driver.mjs';

export const meta = {
  id: '176',
  name: 'paylink-camera-loop',
  journey: 'pay',
  covers: ['request-qr', 'pay-link', 'camera-scan', 'pay-review', 'memo-reconcile', 'sol-send', 'rail-parity'],
  verifies: 'The request QR is the payment LINK: camera-scanning the exact QR string opens the payer flow on each rail — IC review+Approve settles with ref-as-memo and the open request auto-confirms Received (DEMO fee=null → verbatim amount); SOL pre-fills Send-to-address with the NETTED wire (typed 0.02 − fee → 0.019995; customer pays exactly the price) and broadcasts (screen does not auto-confirm).',
  timeoutMs: 90000,
};

const IC_AMOUNT = '3.50';
const SOL_AMOUNT = '0.02'; // the typed PRICE
const SOL_NETTED = '0.019995'; // 0.02 price − 5000-lamport fee — the netted wire netSolWireLamports quotes

export async function run() {
  const start = Date.now();
  console.log('[176-paylink-camera-loop] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  let payer = null;
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    // ============================== IC leg ================================================
    console.log('[176-paylink-camera-loop] onboarding merchant (funded ∂100)…');
    await onboardWallet(driver, 'e2e-link-merchant');
    const account = await accountOf(driver);
    const selfPrincipal = await railPrincipalText(account.publicHex);

    // --- Merchant opens the request (and stays parked on this screen — the payer pays from
    //     its own context below; an IC request does not outlive its screen).
    await driver.click('tab-receive', {timeoutMs: 4_000});
    await driver.type('amount-input', IC_AMOUNT, {timeoutMs: 4_000});
    await driver.click('btn-request', {timeoutMs: 4_000});
    await driver.findByTestID('request-qr', {timeoutMs: 5_000});

    // --- The QR value is the LINK — on the wallet's own origin, naming this wallet, this
    //     asset, this amount, and the reconciliation nonce as `ref`.
    const linkStr = await driver.eval(() => window.__DPAY_QR_LAST);
    const link = parsePayLink(linkStr);
    assert(link != null, `the request QR must BE the payment link, got "${linkStr}"`);
    assert(link.href.startsWith(`${webBaseURL}/wallet/pay/`), `the link must live on the wallet origin ${webBaseURL}, got ${link.href}`);
    assertEq(link.recipient, selfPrincipal, 'the link pays the requesting wallet\'s principal');
    assertEq(link.asset, 'DEMO', 'the link names the requested asset');
    assertEq(link.network, 'internet-computer', 'the link names the settlement network');
    assertEq(link.amount, IC_AMOUNT, 'the link carries the requested amount');
    assertIncludes(link.href, `label=${encodeURIComponent('e2e-link-merchant')}`, 'the link carries the merchant label');
    assert(/^[0-9a-f]{32}$/.test(link.ref ?? ''), `the link's ref must be the 16-byte request nonce, got "${link.ref}"`);
    console.log(`[176-paylink-camera-loop] ✓ QR is the link: ${IC_AMOUNT} DEMO → ${selfPrincipal.slice(0, 12)}… (ref=${link.ref.slice(0, 8)}…)`);

    // --- The payer: a SECOND fresh incognito context off the shared browser — its own
    //     localStorage, its own faucet-funded identity. This is the second phone.
    const {browser} = await getSession({});
    payer = await Driver.create(browser, {solStub: true});
    await payer.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await payer.waitReady({timeoutMs: 10_000});
    await onboardWallet(payer, 'e2e-link-payer');
    console.log('[176-paylink-camera-loop] payer context onboarded (∂100)');

    // --- Payer camera-scans THAT EXACT STRING. The camera seam receives the QR's own value —
    //     no fixture, no rebuild: what the pixels say is what gets scanned.
    await payer.click('tab-pay', {timeoutMs: 4_000});
    await armPayScan(payer);
    await payer.eval((payload) => window.__DPAY_TEST_SCAN(payload), linkStr);

    // --- The IC review — reached, pre-filled, NOT paid (a link is a zero-press entry).
    await payer.findByTestID('pay-amount', {timeoutMs: 6_000});
    const payAmt = await payer.readText('pay-amount');
    assert(payAmt.includes('∂3.50'), `review should show "Pay ∂3.50", got "${payAmt}"`);
    assertEq(await payer.readText('review-payee'), selfPrincipal, 'review shows the link\'s destination (full principal)');
    assert(!/\bPaid\b/.test(await payer.bodyText()), 'a scanned link must NOT auto-pay — review only');
    console.log('[176-paylink-camera-loop] ✓ camera scan → review (no auto-pay)');

    // --- Approve → sign + settle. The link's `ref` rides as the on-chain memo.
    await payer.click('btn-approve', {timeoutMs: 5_000});
    assert(await payer.waitForText('Paid', {timeoutMs: 10_000}), 'payer should reach the Paid screen');
    assert(await payer.waitForText('∂96.50', {timeoutMs: 10_000}), 'payer balance ∂100 − ∂3.50 = ∂96.50');
    console.log('[176-paylink-camera-loop] ✓ paid (memo = ref)');
    // Return the payer's pay tab to the scan surface for the SOL leg below (btn-new = reset).
    await payer.click('btn-new', {timeoutMs: 5_000});
    await payer.findByTestID('pay-scan', {timeoutMs: 6_000});

    // --- The merchant's OPEN request auto-confirms from the memo — the reconciliation the
    //     founder decision preserved (ref = nonce = memo, one key). The merchant context has
    //     been parked on the request screen the whole time, exactly like a real counter.
    assert(await driver.waitForText('Received ∂3.50', {timeoutMs: 20_000}),
      'the open request must flip to "Received ∂3.50" from the link payment\'s memo');
    await driver.screenshot('176-paylink-camera-loop-ic');
    console.log('[176-paylink-camera-loop] ✓ IC loop closed: request auto-confirmed via ref-as-memo');

    // ============================== SOL leg ===============================================
    // The SOL RPC stub (flow-74 shape) on BOTH contexts — `solStub:true` only points the rail at
    // the stub; the methods themselves are flow-supplied. The merchant needs getLatestBlockhash
    // to build the solreq; the payer needs the full send path below.
    for (const d of [driver, payer]) {
      await d.eval(() => {
        globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
          getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '0', decimals: 6}}),
          getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
          getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN', lastValidBlockHeight: 300000000}}),
          isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
          getBlockHeight: () => 250000001,
          sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
          getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
          getBalance: () => ({value: 5000000000}),
        };
      });
    }

    // --- Merchant opens a SOL request (select SOL → Receive → make). ------------------------
    await openBalances(driver, {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-amount-input', {timeoutMs: 5_000});
    await driver.type('sol-req-amount-input', SOL_AMOUNT, {timeoutMs: 5_000});
    await driver.click('btn-sol-req-make', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 8_000});

    // --- The SOL QR is the LINK — and `ref` is deliberately null.
    const solLinkStr = await driver.eval(() => window.__DPAY_QR_LAST);
    const solLink = parsePayLink(solLinkStr);
    assert(solLink != null, `the SOL request QR must BE the payment link, got "${solLinkStr}"`);
    assert(solLink.href.startsWith(`${webBaseURL}/wallet/pay/`), `the SOL link must live on the wallet origin, got ${solLink.href}`);
    assertEq(solLink.asset, 'SOL', 'the SOL link names the asset');
    assertEq(solLink.network, 'solana', 'the SOL link names the network');
    assertEq(solLink.amount, SOL_NETTED, 'the SOL link carries the NETTED wire (typed price − 5000-lamport fee; the customer pays exactly the price)');
    assert(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solLink.recipient), `the SOL link pays a base58 address, got "${solLink.recipient}"`);
    assert(solLink.ref == null, 'the SOL link carries NO ref — the rail attaches no reconciliation memo');
    console.log(`[176-paylink-camera-loop] ✓ SOL QR is the link: ${SOL_NETTED} SOL netted (price ${SOL_AMOUNT}) → ${solLink.recipient.slice(0, 8)}… (ref=null)`);

    // --- Camera-scan the exact string on the payer phone → the SOL rail's own confirm
    //     surface, pre-filled (stub installed above).
    await payer.click('tab-pay', {timeoutMs: 5_000});
    await armPayScan(payer);
    await payer.eval((payload) => window.__DPAY_TEST_SCAN(payload), solLinkStr);
    await payer.findByTestID('sol-send-address-input', {timeoutMs: 10_000});
    const addr = await payer.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-address-input');
    assertEq(addr, solLink.recipient, 'the send form carries the link\'s destination address');
    const amt = await payer.eval((id) => document.querySelector(`[data-testid="${id}"]`)?.value ?? '', 'sol-send-amount-input');
    assertEq(amt, SOL_NETTED, 'the send form carries the link\'s netted wire amount');
    console.log('[176-paylink-camera-loop] ✓ camera scan → SOL send form pre-filled');

    // --- Confirm → the REAL send path (local sign + broadcast through the stub).
    await payer.click('btn-sol-send-confirm', {timeoutMs: 5_000});
    const status = await payer.findByTestID('sol-send-outcome', {timeoutMs: 12_000});
    const statusTxt = await status.evaluate((n) => (n.textContent ?? '').trim());
    assert(/Sent/.test(statusTxt), `the sheet should show "Sent ✓", got: "${statusTxt}"`);
    console.log(`[176-paylink-camera-loop] ✓ broadcast: ${statusTxt}`);

    // --- The SOL request screen does NOT auto-confirm — documented semantics. It stays open,
    //     still waiting (NFC / signed-QR scan-back are its confirm paths).
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('sol-req-qr', {timeoutMs: 5_000});
    const reqBody = await driver.bodyText();
    assert(!/Received/.test(reqBody), 'a SOL link payment must NOT auto-confirm the request screen');
    assertIncludes(reqBody, 'Waiting', 'the SOL request stays open, waiting for its radio/scan-back confirm');
    await driver.screenshot('176-paylink-camera-loop-sol');
    console.log('[176-paylink-camera-loop] ✓ SOL semantics pinned: paid but screen unconfirmed');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[176-paylink-camera-loop] GREEN in ${elapsed}s`);
  } finally {
    try { await payer?.close(); } catch {}
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[176-paylink-camera-loop] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
