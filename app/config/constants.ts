export const EXPIRY_WINDOW = 900; // request valid 15 min (U-F3: a payer who opens a shared request link and creates a wallet — 24-word mnemonic entry — must not land on an expired request) — still kills stale replays
// PR23 — named timeouts for the remaining bare fetch literals. The value is the SAME the inline
// constants carried; only the name is new. BALANCE_TIMEOUT_MS bounds every "fast read" poll
// (balance/history/receipt/catalog + the onboarding best-effort fund). FAUCET_TIMEOUT_MS bounds
// the user-initiated top-up. DEPOSIT_TIMEOUT_MS bounds the initial deposit-info load +
// the ckERC20 onramp-params fetch.
export const BALANCE_TIMEOUT_MS = 4000;
// History walks are the relay's SLOWEST read (icrc3 probe + backwards page walk per currency,
// bounded server-side by its own walk deadline). The 4s fast-read timeout aborted every slow
// currency on mainnet (the "AbortError: Aborted" fan-out noise, 2026-08-21); history gets its
// own ample bound so a full-but-slow page still lands. The interval below is also lengthened —
// history changes only when a payment settles, and the relay now TTL-caches walks anyway.
export const HISTORY_TIMEOUT_MS = 10000;
export const FAUCET_TIMEOUT_MS = 6000;
// DEPOSIT_TIMEOUT_MS bounds the best-effort deposit-info load + the ckERC20 onramp-params fetch.
// DEPOSIT_ADDRESS_TIMEOUT_MS bounds the CRITICAL deposit-address fetch on its OWN controller: the
// address is an IC update call (relay → facade → ckBTC minter, ~5–7s observed on mainnet), so it
// gets ample headroom AND is decoupled from the slower deposit_info (a read-only update that proxies
// the minter's get_minter_info, observed at 7–15s). Sharing one controller let the slow info abort
// the ready address at 8s → "Couldn't load your deposit address." (fixed 2026-08-03).
export const DEPOSIT_TIMEOUT_MS = 20000;
export const DEPOSIT_ADDRESS_TIMEOUT_MS = 20000;
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
// Wave 7 — manual theme choice ('light' | 'dark'; absent = follow the OS scheme) so the user can
// pin light/dark regardless of the OS scheme. Same AsyncStorage pattern as identity/relay/showTestnet.
export const THEME_STORAGE_KEY = 'dpay.theme.v1';
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
    history:    t?.history    ?? 15000,
    deposit:    t?.deposit    ?? 10000,
    receiptPay: t?.receiptPay ?? 2500,
    receiptRcv: t?.receiptRcv ?? 1500,
  };
})();
// Bounded unknown-budget for the Receive settlement poll (F2, 2026-08-20): how many 'unknown'
// read_state results we accept before stopping with actionable copy. NOT poll-interval-scaled —
// a count budget keeps the wall-clock bound proportional to POLL.receiptRcv (45s at prod cadence,
// ~4.5s under the e2e POLL override) so the offline suite stays fast.
export const PROOF_POLL_BUDGET = 30;
// WalletConnect v2 project id (from cloud.walletconnect.com, free). Required by the dApp-side
// `EthereumProvider.init` for the native (Android) ckERC20 onramp — the only WalletConnect entry
// point in dpay. PRODUCTION ID IS BAKED HERE: the capstone (showQrModal:false + display_uri QR)
// makes WC's built-in @reown/appkit modal path RUNTIME-UNREACHABLE (ethereum-provider only
// dynamic-imports the modal when showQrModal is true; we render the pairing URI ourselves via a
// custom on-brand <QRCode>). So a non-empty projectId is now SAFE to ship. The test override
// `__DPAY_TEST_WALLETCONNECT_PROJECT_ID=''` DISABLES WC for the offline inner loop (e2e/jest/web):
// jest.setup.js sets it globally to '' (so no jest test triggers WC); the e2e harness injects a
// test id via driver.mjs; prod never sets the global → every `??` falls through to the baked id.
// Mirrors the POLL override seam exactly.
export const WALLETCONNECT_PROJECT_ID =
  ((globalThis as unknown as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID ?? '648afbc757419fa381f77ba0c900bc85');

// Solana RPC endpoint for the native device-key SOL rail (balance/send). Config-driven: the baked
// default is the MAINNET Helius endpoint (keyed; wired 2026-08-09 — before that the rail ran on the
// public devnet endpoint). Devnet is selected by editing this one line; IS_SOLANA_DEVNET derives
// from the URL and badges the SOL screens accordingly. The test override
// `__DPAY_TEST_SOLANA_RPC_URL=''` DISABLES SOL for the offline inner loop (jest.setup.js sets it
// globally; the e2e driver injects it via evaluateOnNewDocument): an empty URL makes the SOL balance
// hook no-op and the SOL card render with `—`, so jest/e2e never touch real devnet. Mirrors the
// WALLETCONNECT_PROJECT_ID + POLL override seam exactly. Prod never sets the
// global → falls through to the baked default.
export const SOLANA_RPC_URL =
  ((globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string}).__DPAY_TEST_SOLANA_RPC_URL ?? 'https://mainnet.helius-rpc.com/?api-key=76929a9c-96d5-4866-9e71-f0e8a8930777');

// Whether the configured SOL RPC is a devnet endpoint. Derived from the URL so it stays correct
// when an operator flips SOLANA_RPC_URL. Used to badge SOL screens ("DEVNET") and warn on the
// receive-address sheet while on devnet — mainnet SOL sent to a devnet key is a real fund-loss
// risk. A prod build that leaves this true is caught by scripts/check-prod-sol.mjs.
export const IS_SOLANA_DEVNET = /devnet|testnet/i.test(SOLANA_RPC_URL);

// SOL native send: getLatestBlockhash + sendTransaction + confirmTransaction (which polls up to
// CONFIRM_TIMEOUT_MS=30s). 60s gives headroom over the full confirm path so a slow-but-finalising
// transfer is never reported as a false failure.
export const SOL_SEND_TIMEOUT_MS = 60000;
// SOL merchant broadcast: getLatestBlockhash + sendTransaction + confirmTransaction, with headroom
// for the merchant↔payer round trip. 2× the native send timeout. Single source — the offline-pay
// broadcast path (solana.ts) and the merchant NFC path (SolNfcTap) reference this instead of
// inlining SOL_SEND_TIMEOUT_MS * 2 at each site.
export const SOL_BROADCAST_TIMEOUT_MS = SOL_SEND_TIMEOUT_MS * 2;

// Phase 3 — Solana v2 recent-blockhash payment freshness constants. The merchant fetches a fresh
// blockhash + cluster identity immediately before showing a request, then strictly verifies +
// freshness-checks the offline-signed tx before broadcasting. These three values are frozen by the
// v2 protocol (see 2026-08-12-solana-recent-blockhash-rewrite-plan.md "Freshness rules"):
//   • SOL_PAYMENT_COMMITMENT — every freshness RPC call + preflight runs at 'confirmed'.
//   • SOL_GENESIS_HASH — the immutable mainnet-beta cluster id; mismatch fail-closes the request.
//   • SOL_PAYMENT_MAX_WINDOW_SECONDS — the codec's frozen max request lifetime (iat..exp ≤ 90s).
// The genesis hash accepts a `__DPAY_TEST_SOL_GENESIS_HASH` override so a unit test can mutate the
// expected cluster identity (mirrors the SOLANA_RPC_URL + POLL override seam).
export const SOL_PAYMENT_COMMITMENT = 'confirmed' as const;
export const SOL_GENESIS_HASH =
  ((globalThis as unknown as {__DPAY_TEST_SOL_GENESIS_HASH?: string}).__DPAY_TEST_SOL_GENESIS_HASH ??
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
export const SOL_PAYMENT_MAX_WINDOW_SECONDS = 90;
// Mirrors the canister's fixed FAUCET_AMOUNT ($100.00 = 10_000 cents). The demo top-up POSTs this
// amount to /api/v1/faucet; the real canister mints the fixed amount regardless of the request. MC1
// units 2-4: a decimal-digit STRING (raw u64) — the relay accepts string-OR-number at the JSON seam.
export const TOP_UP_CENTS = '10000';

// PR24 — single source of truth for the QR code render size. QR_SIZE is the standard signed-QR /
// request-QR / WC-pairing-QR card (244px, the long-shipped value); QR_SIZE_SMALL is the deposit-
// address QR (200px — slightly smaller so a long native address QR scans reliably at high density).
export const QR_SIZE = 244;
export const QR_SIZE_SMALL = 200;
