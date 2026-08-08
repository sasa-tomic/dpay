// Flow 47 — SOL NFC tap (driven through the __DPAY_TEST_SOL_NFC_SESSION seam).
//
// The NFC radio hop is a physical-device gate (two phones); this flow drives the JS event plumbing
// the real Kotlin DpaySolNfc module emits, through the app's REAL SolNfcTap state machine, and
// asserts the SOL-specific receipt-nonce-relay (the unique value of the SOL NFC rail: the payer
// adopts the merchant's advanced nonce over the same tap, so the NEXT offline sign needs NO resync).
//
// The seam flips the device NFC status to 'ready' (window.__DPAY_TEST_NFC_STATUS) so SolPayMode arms
// the HCE card; then __DPAY_TEST_SOL_NFC_SESSION dispatches the same SolNfcEvent payloads the native
// module emits (role='card' = payer), and the app's listener drives SolNfcTap's phase state + UI
// verbatim.
//
// Card-side phases asserted (single-driver simulation — the reader/broadcast path is flow 46's job):
//   - linking   : "Connecting…"  (the tap started; SolNfcTap takes over the screen)
//   - exchanging: "Communicating…" + autoSign fires (decode solreq → offline sign → approveSolCard)
//   - receipt   : "Paid ✓"  + adopt nextNonce + persist (the receipt-nonce-relay win)
//
// The stub RPC (`__DPAY_TEST_SOLANA_RPC_STUB`) simulates a Solana node for createNonceAccount (first-
// use setup). The offline sign itself is PURE (no RPC — signs against the stored durable-nonce value).
//
// Selector contract: `btn-sol-send` (Balances SOL row → send sheet), `btn-sol-pay-offline` (the
// offline-pay link INSIDE the SOL send sheet — re-homed from the Balances row 2026-08-08),
// `btn-sol-pay-setup`, `sol-pay-scan`, `sol-nfc-status`.
import {setup, assert, onboardWallet, openBalances, accountOf} from '../harness/lib.mjs';

export const meta = {
  id: '47',
  name: 'sol-nfc',
  journey: 'nfc',
  covers: ['sol-nfc', 'sol-nonce-relay', 'event-bus'],
  verifies: 'SOL NFC tap: arm card → auto-sign → broadcast-stub → receipt → adopt nonce → Paid ✓',
  timeoutMs: 25000,
};

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const PAY_LAMPORTS = '1000000'; // 0.001 SOL

// Build the 80-byte NonceState account data as base64 (the layout getNonceAccount parses).
// u32(0) version | u32(1) state=Initialized | 32B authority | 32B nonce value | u64 fee.
function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);    // version
  buf.writeUInt32LE(1, 4);    // state = Initialized
  buf.fill(1, 8, 40);         // authority (arbitrary — createNonceAccount ignores .authority)
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40); // nonce value (deadbeef×8)
  buf.writeBigUInt64LE(5000n, 72); // fee.lamports_per_signature
  return buf.toString('base64');
}

function buildSolReq() {
  const obj = {
    v: 1, to: MERCHANT_ADDR, amt: PAY_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null,
    exp: Math.floor(Date.now() / 1000) + 600,
    name: 'merchant', memo: '',
  };
  return 'solreq:v1?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[47-sol-nfc] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    // Flip the device NFC status to 'ready' BEFORE the Wallet mounts (on onboarding) so the app's
    // nfcStatus() probe returns 'ready' → SolPayMode arms the HCE card on mount.
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });

    console.log('[47-sol-nfc] onboarding…');
    await onboardWallet(driver, 'e2e-sol-nfc');

    // Install the SOL RPC stub (simulates a Solana node for createNonceAccount). VERBATIM from flow 46.
    const nonceB64 = nonceAccountB64();
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
      };
    }, nonceB64);

    console.log('[47-sol-nfc] opening SolPayMode via the SOL send sheet…');
    await openBalances(driver);
    // The offline-pay flow was re-homed from the Balances row into the SOL send sheet (2026-08-08).
    // The Send button is gated on a positive balance; the stub's getBalance → 5 SOL populates it.
    await driver.findByTestID('btn-sol-send', {timeoutMs: 8_000});
    await driver.click('btn-sol-send', {timeoutMs: 5_000});
    await driver.click('btn-sol-pay-offline', {timeoutMs: 5_000});

    // First-use setup: create the durable-nonce account (online, via stub).
    console.log('[47-sol-nfc] setting up durable-nonce account…');
    await driver.findByTestID('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.click('btn-sol-pay-setup', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 12_000});
    console.log('[47-sol-nfc] ✓ durable-nonce account created (stub)');

    // Read the payer's nonce state from AsyncStorage — npub is the binding key the receipt must
    // match (decideSolPayerReceipt requires receipt.npub === nonceState.address, exact base58 compare).
    const account = await accountOf(driver);
    const nonceState = await driver.eval((pubhex) => {
      const raw = localStorage.getItem('dpay.sol.nonce.v1.' + pubhex);
      return raw ? JSON.parse(raw) : null;
    }, account.publicHex);
    assert(nonceState && nonceState.address, 'nonce state should be persisted after setup');
    assert(nonceState.status === 'ready', 'nonce status should be ready after setup');
    const npub = nonceState.address;
    const originalValue = nonceState.value;
    console.log(`[47-sol-nfc] ✓ nonce state: npub=${npub.slice(0, 8)}… value=${originalValue.slice(0, 8)}…`);

    // Helper: dispatch one SOL NFC event through the seam (role='card' = the payer being tapped).
    const dispatch = (event) => driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event);

    // linking → markActive → SolNfcTap takes over the screen; sol-nfc-status mounts → "Connecting…".
    console.log('[47-sol-nfc] dispatching phase=linking…');
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await driver.findByTestID('sol-nfc-status', {timeoutMs: 4_000});
    assert(await driver.waitForText('Connecting', {timeoutMs: 4_000}), 'linking should show "Connecting…"');
    console.log('[47-sol-nfc] ✓ linking → "Connecting…"');

    // request → exchanging + autoSign (decode solreq → offline sign against stored nonce →
    // approveSolCard stashes the solpay: URI). Proves the tap-is-consent sign path.
    console.log('[47-sol-nfc] dispatching request (autoSign)…');
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReq()});
    assert(await driver.waitForText('Communicating', {timeoutMs: 5_000}), 'request should show "Communicating…"');
    console.log('[47-sol-nfc] ✓ request → "Communicating…" (exchanging + autoSign)');

    // Verify autoSign produced a valid solpay: URI (proves the offline sign ran end-to-end).
    const solpayUri = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUri === 'string' && solpayUri.startsWith('solpay:v1?'),
      `autoSign should produce a solpay: URI, got: ${JSON.stringify(solpayUri)?.slice(0, 80)}`);
    console.log('[47-sol-nfc] ✓ autoSign produced a solpay: URI (offline-signed)');

    // receipt (status=0 settled, npub match, nextNonce) → decideSolPayerReceipt → success →
    // onPaid(nextNonce) → persist. A DIFFERENT nextNonce proves the receipt-nonce-relay adoption.
    const nextNonce = '9' + originalValue.slice(1); // different value → proves adoption
    console.log('[47-sol-nfc] dispatching receipt (settled + nextNonce)…');
    await dispatch({
      type: 'receipt', role: 'card', status: 0,
      npub, nextNonce, sig: 'sig_test_47',
    });
    assert(await driver.waitForText('Paid', {timeoutMs: 5_000}), 'receipt should show "Paid ✓"');
    console.log('[47-sol-nfc] ✓ receipt → "Paid ✓"');

    // Verify the advanced nonce was adopted + persisted (the receipt-nonce-relay win: the NEXT
    // offline payment needs NO online resync).
    const updatedState = await driver.eval((pubhex) => {
      const raw = localStorage.getItem('dpay.sol.nonce.v1.' + pubhex);
      return raw ? JSON.parse(raw) : null;
    }, account.publicHex);
    assert(updatedState && updatedState.value === nextNonce,
      `nonce value should be adopted (${nextNonce.slice(0, 8)}…), got: ${JSON.stringify(updatedState?.value)?.slice(0, 16)}`);
    assert(updatedState.status === 'ready', 'adopted nonce status should be ready');
    console.log('[47-sol-nfc] ✓ receipt-nonce-relay: nonce adopted + persisted');

    await driver.screenshot('47-sol-nfc');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[47-sol-nfc] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[47-sol-nfc] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
