export const EXPIRY_WINDOW = 600; // request valid 10 min
export const DIRECT_PAY_TIMEOUT_MS = 5000;
// Merchant NFC settlement: bound the /pay call, then reconcile the ambiguous case via the
// idempotent /receipt/:nonce so a settled payment is never reported as failed.
export const NFC_PAY_TIMEOUT_MS = 8000;
export const RECONCILE_ATTEMPTS = 4;
export const RECONCILE_INTERVAL_MS = 1200;
// Payer NFC: how long to wait for the merchant's receipt before falling back to a truthful
// "couldn't confirm" (never a false success or a false failure). Must exceed the merchant's worst
// case (pay timeout + reconciliation) so a slow-but-successful settle still delivers its receipt.
export const RECEIPT_WAIT_MS = 20000;
export const STORAGE_KEY = 'dpay.identity.v1';
// The user-chosen relay URL persists across reloads (AsyncStorage, like identity + the currency
// catalog) so changing networks in Settings survives an app restart. Default is `relayConfig`'s
// value when no persisted choice exists (the harness passes ?relay=; prod codegens the real URL).
export const RELAY_STORAGE_KEY = 'dpay.relay.v1';

// Poll intervals — read once at module load. The e2e harness injects a shortened override via
// `window.__DPAY_TEST_POLL` (driver.mjs evaluateOnNewDocument, before the bundle evaluates) so the
// suite isn't paced by production cadence. In a shipped build that global is never set → every `??`
// falls through to the prod default, so this is prod-safe (RN sets no such global).
export const POLL = (() => {
  const t = (globalThis as unknown as {__DPAY_TEST_POLL?: Record<string, number>}).__DPAY_TEST_POLL;
  return {
    balance:    t?.balance    ?? 2500,
    history:    t?.history    ?? 5000,
    deposit:    t?.deposit    ?? 10000,
    receiptPay: t?.receiptPay ?? 2500,
    receiptRcv: t?.receiptRcv ?? 1500,
  };
})();
// Expected canister receipt-signing pubkey (32-byte hex). Empty string = dev/unpinned fallback
// (`verifyOutcomeReceipt` then trusts the receipt's embedded key — the e2e/dev path; a malicious
// relay can still self-sign in this mode, so it is NOT production-safe). Production bakes the real
// canister's `receipt_pubkey()` here (one-time per canister deploy; the key never rotates), which
// closes the malicious-relay trust gap (MC4 U5 / OPEN_ISSUES #2): a relay can no longer fabricate a
// key+sig+claim that passes the app's check, because the trusted key is sourced INDEPENDENTLY of the
// receipt body. The e2e harness injects the FakeLedger's test key via `__DPAY_TEST_RECEIPT_PUBKEY`
// before the bundle evaluates, exactly like `__DPAY_TEST_POLL` (driver.mjs evaluateOnNewDocument).
export const EXPECTED_RECEIPT_PUBKEY =
  ((globalThis as unknown as {__DPAY_TEST_RECEIPT_PUBKEY?: string}).__DPAY_TEST_RECEIPT_PUBKEY ?? '');

export const WITHDRAW_TIMEOUT_MS = 8000; // bound the /withdraw POST (every new fetch has a timeout)
export const WITHDRAW_EXPIRY_WINDOW = 600; // the signed WithdrawAuth is valid 10 min
// Mirrors the canister's fixed FAUCET_AMOUNT ($100.00 = 10_000 cents). The demo top-up POSTs this
// amount to /api/v1/faucet; the real canister mints the fixed amount regardless of the request. MC1
// units 2-4: a decimal-digit STRING (raw u64) — the relay accepts string-OR-number at the JSON seam.
export const TOP_UP_CENTS = '10000';
