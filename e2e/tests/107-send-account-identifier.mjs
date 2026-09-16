// Flow 107 — Send ICP to a 64-hex ACCOUNT IDENTIFIER, through the ledger's legacy `transfer`.
//
// The address form exchanges hand out for ICP deposits. It is a one-way SHA-224 hash of the owner
// principal, so `icrc1_transfer` — whose `to` is `Account { owner : principal; … }` — physically
// cannot address it: there is nothing to invert the hash into. The ICP ledger is the only ledger
// dpay speaks to that ALSO exposes the older `transfer`, whose `to` is those 32 bytes verbatim.
// This flow proves the app takes that second path when, and only when, the address calls for it.
//
// Verified end to end: the destination is CRC-checked by the real core (a mistyped exchange address
// dies before signing), the route is disclosed, ONE legacy `transfer` envelope is signed on-device
// and POSTed to /api/v2, and the gateway — which resolves the hash by DERIVING candidates, since it
// cannot invert it — credits the principal that owns the identifier.
//
// The destination is derived by the harness's own implementation of the account-identifier hash
// (`icpAccountIdentifierHex` in wire.mjs), not by the app: an oracle that asked the code under test
// where to send the money would prove nothing. That oracle is separately pinned byte-for-byte
// against the Rust core.
//
// Contrast with flow 105, which asserts the same address form is REFUSED for VCHF — the ledger
// there has no such method, and the app says so rather than pretending the address is malformed.
//
// Selector contract: `balance`, `asset-icp-select`, `btn-pay-send`, `send-address-input`,
// `send-status`, `send-amount-input`, `send-review-fee`, `send-review-total`, `btn-send-confirm`,
// `send-destination`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, openPaySend,
} from '../harness/lib.mjs';
import { icpAccountIdentifierHex } from '../harness/wire.mjs';

const CURRENCY = 8;            // native ICP — the ONE ledger with a legacy `transfer`
const ASSET_KEY = 'icp';
const FEE_RAW = 10_000;        // 0.0001 ICP, the ledger's fixed fee
const SEED = 400_000_000;      // 4.00000000 ICP
const SEND_TEXT = '1.00000000';
const SEND_RAW = 100_000_000;

// A second wallet. We send to its ACCOUNT IDENTIFIER but read the balance back at its PRINCIPAL —
// which is exactly the asymmetry that makes this rail interesting.
const RECIPIENT_PUBKEY = 'd'.repeat(64);

export const meta = {
  id: '107',
  name: 'send-account-identifier',
  journey: 'withdraw',
  covers: ['send-to-address', 'account-identifier', 'icp', 'legacy-transfer', 'crc', 'balance-delta'],
  verifies: 'Send ICP to a 64-hex account identifier via the ledger\'s legacy `transfer`: the address is CRC-validated by the real core, the route disclosed with the fee, one envelope signed on-device, and the gateway credits the principal owning that identifier — the address form icrc1_transfer cannot reach.',
  // Measured 2026-09-09: 34-43s of wall clock ALONE on this host — above the 30000 it declared, so
  // it too passed only on the host-load scale multiplier (see flow 101). Onboarding, a faucet
  // credit, a rejected address, an accepted one, and a real settled transfer read back off the
  // ledger.
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[107-send-account-identifier] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-acctid');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'wallet account must be a 32-byte hex pubkey');

    const recipientAccountId = icpAccountIdentifierHex(RECIPIENT_PUBKEY);
    assertEq(recipientAccountId.length, 64, 'an account identifier is 64 hex characters');
    console.log(`[107-send-account-identifier] destination account id: ${recipientAccountId}`);

    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);
    // Seed the recipient too, so the gateway KNOWS the principal and can resolve the hash to it.
    // (An account it has never seen cannot be recognised — the identifier is not invertible. That
    // is an honest limitation of the fake, documented in resolve_account_identifier.)
    const seedRecipient = await faucetAccount(relayBaseURL, RECIPIENT_PUBKEY, 1, { currency: CURRENCY });
    assert(seedRecipient.ok, 'recipient seed must succeed');
    const senderBefore = await getBalance(relayBaseURL, accountHex, CURRENCY);
    const recipientBefore = await getBalance(relayBaseURL, RECIPIENT_PUBKEY, CURRENCY);
    assertEq(senderBefore, String(SEED), 'pre-send ICP balance at the sender principal');

    await openBalances(driver);
    await driver.waitForText('4.00000000 ICP', { timeoutMs: 8_000 });
    await selectCurrency(driver, ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // A mistyped exchange address must die HERE, on the CRC, before anything is signed. One flipped
    // character is the realistic failure — a truncated paste or a transposed digit.
    const broken = recipientAccountId.slice(0, 63) + (recipientAccountId[63] === 'a' ? 'b' : 'a');
    await driver.type('send-address-input', broken, { timeoutMs: 4_000 });
    await driver.waitForText('incomplete or mistyped', { timeoutMs: 6_000 });
    console.log('[107-send-account-identifier] ✓ a one-character corruption is caught by the CRC');

    // The real address: routed to the ICP account rail, with the fee disclosed up front.
    await driver.type('send-address-input', recipientAccountId, { timeoutMs: 4_000 });
    await driver.waitForText('ICP account', { timeoutMs: 6_000 });
    const routeLine = await driver.readText('send-status');
    assertIncludes(routeLine, 'ICP account', 'the route line names the ICP account rail');
    assertIncludes(routeLine, '0.0001 ICP', 'the route line discloses the ledger fee');
    console.log(`[107-send-account-identifier] route disclosed: "${routeLine}"`);

    await driver.type('send-amount-input', SEND_TEXT, { timeoutMs: 4_000 });
    await driver.findByTestID('send-review-total', { timeoutMs: 4_000 });
    const total = await driver.readText('send-review-total');
    assertIncludes(total, '1.0001', 'the review totals amount + fee');

    console.log('[107-send-account-identifier] confirming (signs one legacy `transfer` on-device)…');
    await driver.click('btn-send-confirm', { timeoutMs: 5_000 });
    const sent = await driver.waitForText('Sent', { timeoutMs: 15_000 });
    const body = await driver.bodyText();
    assert(sent, `the legacy send should confirm "Sent". body excerpt:\n${body.slice(0, 600)}`);

    const shownDest = await driver.readText('send-destination');
    assertEq(shownDest, recipientAccountId, 'the success screen shows the full account identifier');

    // The decisive assertion: the gateway resolved a NON-INVERTIBLE hash back to its owner by
    // derivation, and credited that principal on the ICP ledger.
    const senderAfter = await getBalance(relayBaseURL, accountHex, CURRENCY);
    assertEq(senderAfter, String(SEED - SEND_RAW - FEE_RAW), 'sender debited by amount + fee');
    const recipientAfter = await getBalance(relayBaseURL, RECIPIENT_PUBKEY, CURRENCY);
    assertEq(recipientAfter, String(Number(recipientBefore) + SEND_RAW), 'the principal owning the account identifier was credited');
    console.log(`[107-send-account-identifier] ✓ sender ${senderBefore} → ${senderAfter}, recipient ${recipientBefore} → ${recipientAfter} (raw)`);

    await driver.screenshot('107-send-account-identifier');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[107-send-account-identifier] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[107-send-account-identifier] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
