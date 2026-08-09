export const EXPIRY_WINDOW = 300; // request valid 5 min — kills stale replays
export const DIRECT_PAY_TIMEOUT_MS = 5000;
// Merchant NFC settlement: bound the /pay call, then reconcile the ambiguous case via the
// idempotent /receipt/:nonce so a settled payment is never reported as failed.
export const NFC_PAY_TIMEOUT_MS = 8000;
// PR23 — named timeouts for the remaining bare fetch literals. The value is the SAME the inline
// constants carried; only the name is new. BALANCE_TIMEOUT_MS bounds every "fast read" poll
// (balance/history/receipt/catalog + the onboarding best-effort fund). FAUCET_TIMEOUT_MS bounds
// the user-initiated top-up. DEPOSIT_TIMEOUT_MS bounds the initial deposit-info/address load +
// the ckERC20 onramp-params fetch; DEPOSIT_REFRESH_TIMEOUT_MS bounds the deposit-status refresh
// (manual "Check now" + the 10s poll). RECONCILE_FETCH_TIMEOUT_MS bounds a single /receipt fetch
// inside the NFC reconcile loop (distinct from RECONCILE_INTERVAL_MS, the poll spacing).
export const BALANCE_TIMEOUT_MS = 4000;
export const FAUCET_TIMEOUT_MS = 6000;
// DEPOSIT_TIMEOUT_MS bounds the best-effort deposit-info load + the ckERC20 onramp-params fetch.
// DEPOSIT_ADDRESS_TIMEOUT_MS bounds the CRITICAL deposit-address fetch on its OWN controller: the
// address is an IC update call (relay → facade → ckBTC minter, ~5–7s observed on mainnet), so it
// gets ample headroom AND is decoupled from the slower deposit_info (a read-only update that proxies
// the minter's get_minter_info, observed at 7–15s). Sharing one controller let the slow info abort
// the ready address at 8s → "Couldn't load your deposit address." (fixed 2026-08-03).
export const DEPOSIT_TIMEOUT_MS = 8000;
export const DEPOSIT_ADDRESS_TIMEOUT_MS = 20000;
export const DEPOSIT_REFRESH_TIMEOUT_MS = 6000;
export const RECONCILE_FETCH_TIMEOUT_MS = 3000;
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
// Whether the user has unhid testnet currencies in the Balances sheet. Defaults to false (testnet
// assets are hidden by default per the founder decision); persisted so the choice survives a
// restart. Mirrors the identity/relay AsyncStorage pattern.
export const SHOW_TESTNET_STORAGE_KEY = 'dpay.showTestnet';
// Google Play requires the public privacy policy to be reachable from inside the app as well as the
// store listing. This is the stable website URL, independent of the user-editable relay endpoint.
export const PRIVACY_URL = 'https://dpay.kalaj.org/privacy';

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

// WalletConnect v2 project id (from cloud.walletconnect.com, free). Required by the dApp-side
// `EthereumProvider.init` for the native (Android) ckERC20 onramp — the only WalletConnect entry
// point in dpay. PRODUCTION ID IS BAKED HERE: the capstone (showQrModal:false + display_uri QR)
// makes WC's built-in @reown/appkit modal path RUNTIME-UNREACHABLE (ethereum-provider only
// dynamic-imports the modal when showQrModal is true; we render the pairing URI ourselves via a
// custom on-brand <QRCode>). So a non-empty projectId is now SAFE to ship. The test override
// `__DPAY_TEST_WALLETCONNECT_PROJECT_ID=''` DISABLES WC for the offline inner loop (e2e/jest/web):
// jest.setup.js sets it globally to '' (so no jest test triggers WC); the e2e harness injects a
// test id via driver.mjs; prod never sets the global → every `??` falls through to the baked id.
// Mirrors the EXPECTED_RECEIPT_PUBKEY + POLL override seam exactly.
export const WALLETCONNECT_PROJECT_ID =
  ((globalThis as unknown as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID ?? '648afbc757419fa381f77ba0c900bc85');

// Solana RPC endpoint for the native device-key SOL rail (balance/send). Config-driven: the MVP
// defaults to the public DEVNET endpoint (the PoC key on devnet is funded; no signup/key needed). An
// operator switches to mainnet (api.mainnet-beta.solana.com) or a paid provider (Helius/QuickNode)
// by editing this one line — no key is required for the public endpoints. The test override
// `__DPAY_TEST_SOLANA_RPC_URL=''` DISABLES SOL for the offline inner loop (jest.setup.js sets it
// globally; the e2e driver injects it via evaluateOnNewDocument): an empty URL makes the SOL balance
// hook no-op and the SOL card render with `—`, so jest/e2e never touch real devnet. Mirrors the
// WALLETCONNECT_PROJECT_ID + EXPECTED_RECEIPT_PUBKEY override seam exactly. Prod never sets the
// global → falls through to the baked default.
export const SOLANA_RPC_URL =
  ((globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string}).__DPAY_TEST_SOLANA_RPC_URL ?? 'https://mainnet.helius-rpc.com/?api-key=76929a9c-96d5-4866-9e71-f0e8a8930777');

// Whether the configured SOL RPC is a devnet endpoint. Derived from the URL so it stays correct
// when an operator flips SOLANA_RPC_URL. Used to badge SOL screens ("DEVNET") and warn on the
// receive-address sheet that mainnet SOL sent here would be invisible — a real fund-loss risk while
// the rail ships on devnet. A prod build that leaves this true is caught by scripts/check-prod-sol.mjs.
export const IS_SOLANA_DEVNET = /devnet|testnet/i.test(SOLANA_RPC_URL);

export const WITHDRAW_TIMEOUT_MS = 8000; // bound the /withdraw POST (every new fetch has a timeout)
// SOL native send: getLatestBlockhash + sendTransaction + confirmTransaction (which polls up to
// CONFIRM_TIMEOUT_MS=30s). 60s gives headroom over the full confirm path so a slow-but-finalising
// transfer is never reported as a false failure.
export const SOL_SEND_TIMEOUT_MS = 60000;
// SOL merchant broadcast: getLatestBlockhash + sendTransaction + confirmTransaction, with headroom
// for the merchant↔payer round trip. 2× the native send timeout. Single source — the offline-pay
// broadcast path (solana.ts) and the merchant NFC path (SolNfcTap) reference this instead of
// inlining SOL_SEND_TIMEOUT_MS * 2 at each site.
export const SOL_BROADCAST_TIMEOUT_MS = SOL_SEND_TIMEOUT_MS * 2;
export const WITHDRAW_EXPIRY_WINDOW = 600; // the signed WithdrawAuth is valid 10 min
// Mirrors the canister's fixed FAUCET_AMOUNT ($100.00 = 10_000 cents). The demo top-up POSTs this
// amount to /api/v1/faucet; the real canister mints the fixed amount regardless of the request. MC1
// units 2-4: a decimal-digit STRING (raw u64) — the relay accepts string-OR-number at the JSON seam.
export const TOP_UP_CENTS = '10000';

// PR24 — single source of truth for the QR code render size. QR_SIZE is the standard signed-QR /
// request-QR / WC-pairing-QR card (244px, the long-shipped value); QR_SIZE_SMALL is the deposit-
// address QR (200px — slightly smaller so a long native address QR scans reliably at high density).
export const QR_SIZE = 244;
export const QR_SIZE_SMALL = 200;
