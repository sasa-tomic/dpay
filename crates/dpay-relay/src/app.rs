//! The relay's HTTP surface.
//!
//! Public pages at the root, the JSON API under `/api/v1`:
//! - `GET /` — the marketing landing page (with a download CTA when an APK is configured).
//! - `GET /download/dpay.apk` — the Android build, when one is configured; else `404`.
//! - `GET /merchant` — permanent redirect to `/wallet` (the hand-rolled terminal page is gone;
//!   the REAL app's Receive tab IS the merchant terminal now).
//! - `GET /wallet` — the REAL app (`app/App.tsx`) built for the web (react-native-web, wasm
//!   DpayCore), embedded at compile time from `e2e/dist-prod`. Same app the APK ships.
//! - `GET /wallet/pay/{recipient}` — a shared payment link; serves the same wallet page, which
//!   reads the link off its own location and pre-fills a payment review.
//! - `GET /.well-known/assetlinks.json` — Android App Links, so a shared payment link opens the
//!   installed app instead of a browser.
//! - `GET /assets/{path}` — the wallet build's content-hashed assets (immutable caching).
//! - `GET /sw.js`, `GET /manifest.webmanifest`, `GET /icon-192.png` — the wallet's offline shell
//!   (OPEN_ISSUES X10). The worker's caching policy is documented in `e2e/web/sw.js`, which is
//!   the only place it lives; the relay just serves it, `no-cache`, from the root scope.
//!
//! Every compressible response above is served as the brotli the web build precompressed, when
//! the client asks for it (`serve_dist_asset`). Nothing is compressed per request.
//! - `GET /privacy` — the public privacy policy for the app and website.
//! - `GET /dpay-core.wasm` — the shared wire core (canonical same-origin URL for any web surface;
//!   the wallet build carries its own hashed copy under /assets/).
//! - `GET /shots/{name}` — the real app screenshots embedded in the landing page.
//! - `GET /api/v1/health` — liveness pre-flight; consults `ledger.healthy()`.
//! - `GET /api/v1/capabilities` — runtime surface flags: whether this relay serves the checkout and
//!   whether the offline play-money DEMO faucet is available.
//! - `GET /api/v1/integrity` — the facade canister's live module hash vs the PIN baked at build
//!   time (`deploy/facade-module-hash.txt`; GOVERNANCE row 7), so one curl detects an unrecorded
//!   upgrade. Degrades, never 5xxes: an unreachable IC reports `status:"UNREACHABLE"`.
//! - `GET /api/v1/transactions/{hex}?currency=N&limit=30` — the wallet's durable transaction list,
//!   newest-first, read off the ICRC ledger's own transaction log at the user's principal.
//! - `GET /api/v1/swap_quote?pool=&token_in=&token_out=&amount_in=` — the delegated-conversion
//!   venue quote (spec 2026-09-07 §2): the pool's OWN quote VERBATIM + its `venue_id`
//!   attribution + its OWN `fee_millionths` + `fetched_at`; the relay never computes a rate,
//!   and since 2026-09-08 it never assumes the pool's pair either — the direction is read off
//!   the pool's own `metadata` (see `swap_quote_direction`). Served under `agent` (real
//!   ICPSwap pool) or `test-helpers` (the fake-IC stub pools); absent from the no-feature
//!   build.
//! - `GET /api/v1/venues` — the query-only venue registry (multi-venue readiness V4): identity,
//!   kind, endpoint and the UNORDERED pair for every REAL conversion venue. Pair-scoped, hence
//!   separate from `/currencies` (asset-scoped).
//! - `GET  /api/v1/deposit/info?currency=N` — static deposit instructions (min confirmations, fee,
//!   min amount) so the "Add money" sheet can render them.
//! - `GET  /api/v1/currencies` — the wallet's runtime asset catalog (closes issue #7), served
//!   network-first: `{networks:[{protocol,name,environment,assets}]}` — icp mainnet + icp testnet
//!   partitioned from the relay's compiled-in IC rows, plus the relay-constant solana mainnet
//!   section. Compiled in [`crate::catalog`] — the SOLE catalog authority (founder decision
//!   2026-08-28; the facade registry is gone) — so the route is infallible. IC rows keep the
//!   exact `CurrencyDescriptor` shape; read once on wallet load.
//! - `GET  /api/v1/balances/{hex}` — ALL currency balances in ONE response (a flat map
//!   `{currency: minor-units}`), replacing the wallet's old N+1 per-poll fetch loop (1 primary +
//!   1 per-asset, each a relay→IC round trip) with a single request.
//! - `POST /api/v1/faucet` — the demo top-up. TWO builds, ONE route shape (`{account: hex,
//!   currency?, amount?}` → `{balance}`; refusals → 422 `{error: <verbatim reason>}`):
//!   test-helpers credits the fake-IC gateway (gated by `DPAY_ENABLE_FAUCET`); the agent build
//!   (production) enforces the relay-side cooldown ([`crate::faucet`]) and drives the facade's
//!   controller-gated `mint` through the authenticated agent, crediting the USER principal.
//!   With BOTH features (the live-test config) the AGENT branch owns the route. Whichever is
//!   compiled refuses on [`AppState::faucet_available`] — the same flag `/capabilities` reports —
//!   with 503 and a reason naming the knob that is missing.
//! - `POST /api/v1/solana/rpc` — the Solana JSON-RPC proxy (spec 2026-09-09, Direction 1;
//!   [`crate::solana`]). The client's JSON-RPC envelope in, the upstream's answer back VERBATIM:
//!   a pure pipe for `sendTransaction` and everything unallowlisted, a short-TTL shared read
//!   cache for the explicit read allowlist (that is what makes a free-tier RPC quota survive N
//!   wallets). Registered on every build; unconfigured (`DPAY_SOLANA_RPC_URL` unset) it answers
//!   503 naming the variable. No value is inspected, held or moved — see [`crate::solana`].
//! - `POST /api/v1/evm/rpc` — the EVM JSON-RPC proxy ([`crate::evm`]), the Solana pipe's EVM
//!   twin with the same semantics line for line: pure pipe for `eth_sendRawTransaction` and
//!   everything off the read allowlist, short-TTL shared cache for the allowlisted reads.
//!   Registered on every build; unconfigured (`DPAY_EVM_RPC_URL` unset) it answers 503 naming
//!   the variable. See [`crate::evm`].
//! - `POST /api/v1/sideshift/quotes` and `POST /api/v1/sideshift/shifts/fixed` — the FIRST
//!   relay-held partner-key surface (founder decision 3, 2026-09-14; [`crate::sideshift`]).
//!   The relay attaches the SideShift partner credentials (`DPAY_SIDESHIFT_SECRET` /
//!   `DPAY_SIDESHIFT_AFFILIATE_ID`) server-side — the device never sees them — maps the
//!   registry's rail ids onto the venue's own coin/network codes, and returns the venue's
//!   quote (wrapped with attribution + timestamp) or fixed-order answer verbatim. Registered
//!   on every build; unconfigured it answers 503 naming the missing variable(s). Still no
//!   value moves through the relay: the user deposits straight to the VENUE's address, and
//!   shift status reads are the venue's own keyless GET the device polls directly.
//! - `GET /api/v1/jupiter/quote` and `POST /api/v1/jupiter/swap` — the Jupiter proxy
//!   (2026-09-16 founder ask, "through our relay (for caching etc)";
//!   [`crate::jupiter`]). The keyless venue behind the Convert surface's SOL legs: quotes
//!   pipe through a short-TTL canonical-params cache, swap-tx builds are a byte-faithful
//!   never-cached pipe (the device posts Jupiter's own quoteResponse back and must receive
//!   the swapTransaction unmodified). Registered on every build — keyless, so there is NO
//!   503 state; transport death answers 504 `jupiter-upstream-unreachable`. The registry
//!   row's `endpoint` stays the venue's identity/attribution, no longer a device dial
//!   target.
//! - `POST /api/v1/trocador/rate`, `POST /api/v1/trocador/trade`, `GET /api/v1/trocador/trade?id=`
//!   — the Trocador AGGREGATOR proxy (registered 2026-09-20; [`crate::trocador`]), all-GET
//!   upstream, every method key-gated so the STATUS read is proxied too. Plus
//!   `POST|GET /api/v1/trocador/webhook` — the partner agreement's per-trade webhook receiver
//!   (2026-09-21; [`crate::trocador_agreement`]): access log + order store + webhooks + the
//!   promised upstream limits wrap around the proxy; the receiver answers 200 to anything
//!   (the venue probes at creation and never retries a failed delivery).
//!
//! Read-only by construction apart from the play-money faucet: there is no value-moving route
//! left on this crate (the 2026-08-19 IC-rail cutover moved settlement to the app's own signed
//! /api/v2 envelopes; the test-helpers fake-IC gateway is the offline e2e stand-in for that
//! surface).

#[cfg(feature = "test-helpers")]
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use dpay_core::{Currency, DEMO_USD, PUBKEY_LEN};

/// The prod web build of the real app, embedded at compile time (see build.rs — generated from
/// `e2e/dist-prod`, which `just web` / deploy/build.sh produce; the build fails loud without it).
mod web_dist {
    include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));
}

use crate::catalog::{currencies_body, ic_rows};
use crate::ledger::{Ledger, LedgerError, TxnRecord, U64String};

/// Shared relay state. `Arc<dyn Ledger>` is the read seam (balances, history). The currency
/// catalog is NOT behind the seam — it lives in [`crate::catalog`], compiled into every build.
#[derive(Clone)]
pub struct AppState {
    pub ledger: Arc<dyn Ledger>,
    /// The merchant checkouts this relay is serving (`crate::checkout`). In memory by design: a charge is
    /// worth less than the hour it lives, and settlement is re-derived from the ledger on every
    /// read — so a restart costs a cashier a re-open, never a payment and never a double credit.
    pub checkouts: crate::checkout::SharedCheckouts,
    /// Whether the checkout's eight routes are REGISTERED at all — see the gate in [`app`]. Read once,
    /// while the router is built, so it cannot change under a live request. Set by
    /// [`AppState::with_checkout`]; `false` for a state that does not ask.
    checkout_enabled: bool,
    /// Whether `POST /api/v1/faucet` — the route THIS build compiles — will actually credit an
    /// account. ONE predicate: [`capabilities`] reports it and the compiled faucet handler refuses
    /// on it, so what the relay advertises can no longer drift from what the route does. It did:
    /// production served `{"demo_faucet":false}` while its faucet minted happily, so the app hid
    /// the top-up button and onboarded unfunded wallets against a healthy relay.
    ///
    /// Set by [`AppState::with_faucet`] from `main`, which is where the backend is known — the
    /// offline fixture build gates on the operator's `DPAY_ENABLE_FAUCET` (its faucet credits the
    /// fake-IC gateway), the agent build on the relay agent holding an authenticated identity
    /// (`DPAY_CONTROLLER_SEED`), because the facade's `mint` is `require_admin`-gated and an
    /// anonymous relay cannot credit anything. Defaults to `false`: a state that never said it
    /// can serve a faucet does not advertise one.
    faucet_available: bool,
    /// The faucet's per-account cooldown map (see [`crate::faucet`]). Guarded by the repo's
    /// poison-tolerant lock convention and never held across an await.
    ///
    /// SHARED BY BOTH BUILDS, and not a fixture nicety: it used to be `#[cfg(feature = "agent")]`,
    /// so the offline image served an unlimited faucet while production served one top-up an hour.
    /// The e2e suite calibrated itself to the fixture — flow 02 asserted the top-up button was
    /// REPEATABLE — and therefore proved a behaviour the shipped app has never had. One map, one
    /// predicate ([`crate::faucet::is_self_service_top_up`]), both handlers. Compiled only where a
    /// faucet route is — a build that serves none carries no cooldown map and no dead code.
    #[cfg(any(feature = "agent", feature = "test-helpers"))]
    faucet_cooldown: Arc<Mutex<crate::faucet::FaucetCooldown>>,
    /// The Android build served at `GET /download/dpay.apk`, when one is configured. `None` renders
    /// a "coming soon" CTA on the landing page and answers the download route with `404`.
    apk: Arc<Option<Vec<u8>>>,
    /// sha256 of the APK bytes (computed once, in `with_apk`). Doubles as the `?v=` cache-buster
    /// on the landing-page download link and the strong ETag on `/download/dpay.apk`, so the CDN
    /// revalidates cheaply instead of pinning a stale build.
    apk_version: String,
    /// Fake-IC gateway state (test-helpers only). When set, `/api/v2/canister/*` is served from
    /// this relay and the value-path helpers below (faucet/balances/transactions) read the
    /// gateway's principal-keyed ledgers instead of the facade-era `dyn Ledger`. `None` in prod.
    #[cfg(feature = "test-helpers")]
    pub fake_ic: Option<Arc<crate::ic_gateway::FakeIc>>,
    /// The facade canister whose module hash `GET /api/v1/integrity` reads live off the IC state
    /// tree (text principal). `None` — a memory-ledger demo relay with no facade configured —
    /// leaves the route honest about having no live hash to compare (status `UNREACHABLE`, live
    /// `null`; the pin is still reported). Set by [`AppState::with_facade_canister`] from
    /// `DPAY_CANISTER_ID` in main.rs when the ledger is the agent IC path.
    facade_canister: Option<String>,
    /// The Solana JSON-RPC proxy (`crate::solana`) — `POST /api/v1/solana/rpc`. The route is
    /// registered on EVERY build (no checkout-style gate): a proxy whose upstream is unset still
    /// answers, honestly, 503 naming `DPAY_SOLANA_RPC_URL`. The default state here carries that
    /// unconfigured proxy; `main` replaces it via [`AppState::with_solana`] from the env.
    pub solana: Arc<crate::solana::SolanaProxy>,
    /// The EVM JSON-RPC proxy (`crate::evm`) — `POST /api/v1/evm/rpc` (chain 1) plus the
    /// per-chain suffix `POST /api/v1/evm/rpc/{chain_id}` (D12). The Solana pipe's EVM
    /// twin, with the SAME always-registered contract: an unconfigured proxy still answers,
    /// honestly, 503 naming the exact `DPAY_EVM_RPC_URL[_<CHAINID>]` variable. The default
    /// state here carries that unconfigured proxy; `main` replaces it via
    /// [`AppState::with_evm`] from the env.
    pub evm: Arc<crate::evm::EvmProxy>,
    /// The SideShift partner-key proxy (`crate::sideshift`) — `POST /api/v1/sideshift/quotes`
    /// and `POST /api/v1/sideshift/shifts/fixed`. Same always-registered contract as the
    /// solana proxy above: unset partner credentials still answer 503 naming
    /// `DPAY_SIDESHIFT_SECRET` / `DPAY_SIDESHIFT_AFFILIATE_ID` (either may be unset; that is
    /// a LEGAL deploy state — the venue is simply absent). The default state here carries
    /// that unconfigured proxy; `main` replaces it via [`AppState::with_sideshift`] from the
    /// env. BOTH credential halves are secrets: never logged, never echoed.
    pub sideshift: Arc<crate::sideshift::SideShiftProxy>,
    /// The Trocador aggregator proxy (`crate::trocador`) — `POST /api/v1/trocador/rate`,
    /// `POST /api/v1/trocador/trade`, `GET /api/v1/trocador/trade`. Same always-registered
    /// contract: an unset `DPAY_TROCADOR_API_KEY` still answers 503 naming it (a LEGAL
    /// deploy state — the venue is simply absent until the founder's key request lands).
    /// UNLIKE sideshift the STATUS read is proxied too: every Trocador method is key-gated,
    /// so there is no keyless device-direct read. The key is a SECRET: never logged, never
    /// echoed.
    pub trocador: Arc<crate::trocador::TrocadorProxy>,
    /// The Jupiter proxy (`crate::jupiter`) — `GET /api/v1/jupiter/quote` +
    /// `POST /api/v1/jupiter/swap` (2026-09-16 founder ask). Same always-registered
    /// contract as the proxies above, but with NO unconfigured state at all: the venue is
    /// keyless and its base has a constant default, so there is no credential whose absence
    /// would degrade the routes. `main` may re-point the upstream via
    /// [`AppState::with_jupiter`] from `DPAY_JUPITER_API_BASE`.
    pub jupiter: Arc<crate::jupiter::JupiterProxy>,
}

impl AppState {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        AppState {
            ledger,
            checkouts: Arc::new(Mutex::new(crate::checkout::CheckoutStore::default())),
            checkout_enabled: false,
            faucet_available: false,
            #[cfg(any(feature = "agent", feature = "test-helpers"))]
            faucet_cooldown: Arc::new(Mutex::new(crate::faucet::FaucetCooldown::with_window(
                crate::faucet::FAUCET_COOLDOWN_SECS,
            ))),
            apk: Arc::new(None),
            apk_version: String::new(),
            // The unconfigured solana proxy: /api/v1/solana/rpc answers 503 naming the env var
            // until `with_solana` points it at DPAY_SOLANA_RPC_URL (see `crate::solana`).
            solana: Arc::new(crate::solana::SolanaProxy::new(
                None,
                crate::solana::DEFAULT_TIMEOUT,
            )),
            // The unconfigured EVM proxy: /api/v1/evm/rpc answers 503 naming the env var
            // until `with_evm` points it at DPAY_EVM_RPC_URL (see `crate::evm` — the
            // Solana pipe's EVM twin, same pure-pipe + read-cache semantics).
            evm: Arc::new(crate::evm::EvmProxy::new(
                None,
                crate::evm::DEFAULT_TIMEOUT,
            )),
            // The unconfigured SideShift partner-key proxy: /api/v1/sideshift/* answers 503
            // naming the missing env vars until `with_sideshift` attaches the partner
            // credentials (see `crate::sideshift` — the FIRST relay-held partner-key surface,
            // founder decision 3).
            sideshift: Arc::new(crate::sideshift::SideShiftProxy::new(
                None,
                None,
                crate::sideshift::DEFAULT_API_BASE.to_string(),
                crate::sideshift::DEFAULT_TIMEOUT,
            )),
            // The unconfigured Trocador aggregator proxy: /api/v1/trocador/* answers 503
            // naming the missing env var until `with_trocador` attaches the partner API key
            // (see `crate::trocador` — the FIRST aggregator venue; key requested from
            // commercial@trocador.app).
            trocador: Arc::new(crate::trocador::TrocadorProxy::new(
                None,
                crate::trocador::DEFAULT_API_BASE.to_string(),
                crate::trocador::DEFAULT_TIMEOUT,
            )),
            // The Jupiter proxy, ALWAYS serving (keyless — no unconfigured state): the
            // default state carries the venue's documented lite-api base; `main` re-points
            // it via `with_jupiter` when DPAY_JUPITER_API_BASE is set (see `crate::jupiter`).
            jupiter: Arc::new(crate::jupiter::JupiterProxy::new(
                crate::jupiter::DEFAULT_API_BASE.to_string(),
                crate::jupiter::DEFAULT_TIMEOUT,
            )),
            #[cfg(feature = "test-helpers")]
            fake_ic: None,
            facade_canister: None,
        }
    }

    /// Attach the fake-IC `/api/v2` gateway (test-helpers only; see [`crate::ic_gateway`]).
    #[cfg(feature = "test-helpers")]
    pub fn with_fake_ic(mut self, fake_ic: Arc<crate::ic_gateway::FakeIc>) -> Self {
        self.fake_ic = Some(fake_ic);
        self
    }

    /// Serve the OpenCryptoPay checkout (`DPAY_ENABLE_CHECKOUT`) — the eight routes gated in [`app`].
    /// Must be set BEFORE the router is built, because that is where the gate is read.
    pub fn with_checkout(mut self, enabled: bool) -> Self {
        self.checkout_enabled = enabled;
        self
    }

    /// Name the facade canister `GET /api/v1/integrity` reads the live module hash for (text
    /// principal). Call only for an agent/IC-backed ledger — a `None` state (memory demo)
    /// honestly reports it has no live hash rather than pretending to read one.
    pub fn with_facade_canister(mut self, canister: String) -> Self {
        self.facade_canister = Some(canister);
        self
    }

    /// Point the Solana RPC proxy at its upstream (`crate::solana::SolanaProxy`). `main` builds
    /// it from `DPAY_SOLANA_RPC_URL` (+ `DPAY_SOLANA_TIMEOUT_MS`); tests build it against the
    /// local stub upstream. The proxy's URL is SECRET (it carries the provider api key) — it is
    /// never logged here or anywhere else.
    pub fn with_solana(mut self, proxy: crate::solana::SolanaProxy) -> Self {
        self.solana = Arc::new(proxy);
        self
    }

    /// Point the EVM RPC proxy at its upstream (`crate::evm::EvmProxy`). `main` builds it
    /// from `DPAY_EVM_RPC_URL` (+ `DPAY_EVM_TIMEOUT_MS`); tests build it against the local
    /// stub upstream. The proxy's URL is SECRET (it carries the provider api key) — it is
    /// never logged here or anywhere else.
    pub fn with_evm(mut self, proxy: crate::evm::EvmProxy) -> Self {
        self.evm = Arc::new(proxy);
        self
    }

    /// Attach the SideShift partner-key proxy (`crate::sideshift::SideShiftProxy`).
    /// `main` builds it from `DPAY_SIDESHIFT_SECRET` + `DPAY_SIDESHIFT_AFFILIATE_ID`
    /// (+ optional `DPAY_SIDESHIFT_API_BASE`); tests build it against the local stub
    /// upstream. BOTH halves are SECRETS (the partner account credentials — never
    /// logged here or anywhere else), and either may stay unset: an unconfigured
    /// proxy still answers, honestly, 503 naming the missing variable(s).
    pub fn with_sideshift(mut self, proxy: crate::sideshift::SideShiftProxy) -> Self {
        self.sideshift = Arc::new(proxy);
        self
    }

    /// Attach the Trocador aggregator proxy (`crate::trocador::TrocadorProxy`). `main`
    /// builds it from `DPAY_TROCADOR_API_KEY` (+ optional `DPAY_TROCADOR_API_BASE`);
    /// tests build it against the local stub upstream. The key is a SECRET (the partner
    /// credential — never logged here or anywhere else), and it may stay unset: an
    /// unconfigured proxy still answers, honestly, 503 naming the missing variable.
    pub fn with_trocador(mut self, proxy: crate::trocador::TrocadorProxy) -> Self {
        self.trocador = Arc::new(proxy);
        self
    }

    /// Point the Jupiter proxy at its upstream (`crate::jupiter::JupiterProxy`). `main`
    /// builds it from `DPAY_JUPITER_API_BASE` (default the venue's own lite-api base);
    /// tests build it against the local stub upstream. The base is NOT a secret (the
    /// venue is keyless — no credential exists to leak), but it still never needs logging.
    pub fn with_jupiter(mut self, proxy: crate::jupiter::JupiterProxy) -> Self {
        self.jupiter = Arc::new(proxy);
        self
    }

    /// Attach the Android build to serve at `GET /download/dpay.apk` (and light up the landing
    /// page's download CTA). `None` leaves it disabled. The sha256 is computed exactly once, here
    /// (the binary has already read the whole file at startup; hashing 56MB once is nothing) and
    /// feeds both the `?v=` cache-buster and the download route's strong ETag.
    pub fn with_apk(mut self, apk: Option<Vec<u8>>) -> Self {
        if let Some(ref bytes) = apk {
            use sha2::{Digest, Sha256};
            self.apk_version = format!("{:x}", Sha256::digest(bytes));
        }
        self.apk = Arc::new(apk);
        self
    }

    /// Declare whether this deployment's faucet can actually credit — see
    /// [`faucet_available`](AppState::faucet_available). `main` derives it from the backend it
    /// built (fixture: `DPAY_ENABLE_FAUCET`; agent: an authenticated identity); tests declare it
    /// the same way they declare the checkout.
    pub fn with_faucet(mut self, available: bool) -> Self {
        self.faucet_available = available;
        self
    }

    /// Replace the faucet cooldown's window. Test seam ONLY: the live tests shrink the 1h
    /// production window to seconds so the rollover is observable; prod never calls this.
    #[cfg(any(feature = "agent", feature = "test-helpers"))]
    pub fn set_faucet_cooldown_window(&self, window_secs: u64) {
        *self
            .faucet_cooldown
            .lock()
            .unwrap_or_else(|p| p.into_inner()) =
            crate::faucet::FaucetCooldown::with_window(window_secs);
    }
}

/// Why `POST /api/v1/faucet` refuses on THIS build when it is unavailable — the reason names the
/// knob that is missing, so an operator reading a refusal knows what to set instead of reading
/// "disabled". Exactly one of these compiles: the agent branch owns the route whenever `agent` is
/// on (the same precedence the route registration uses).
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
const FAUCET_UNAVAILABLE: &str = "faucet unavailable: this relay serves the offline fixture \
     faucet, which needs DPAY_ENABLE_FAUCET=true and the fake-IC gateway it credits";
#[cfg(feature = "agent")]
const FAUCET_UNAVAILABLE: &str = "faucet unavailable: this relay's agent signs anonymously — set \
     DPAY_CONTROLLER_SEED, since the facade's mint is controller-gated and an anonymous relay \
     cannot credit anything";

/// Build the router. No socket is bound here — tests drive it via `tower::ServiceExt::oneshot`,
/// `main` wraps it with a listener.
pub fn app(state: AppState) -> Router {
    // 2026-08-19 IC-rail cutover (W7): the settlement/receipt surface is GONE — /pay, /withdraw,
    // /receipt/{nonce}, /receipt_pubkey, /deposit/address, /deposit/refresh. Value moves on the
    // IC rail: the app signs /api/v2 envelopes locally and submits them to the boundary nodes
    // (icp-api.io in prod; the fake-IC gateway in tests). What remains is read-only: config/display
    // surfaces + the balance batch + history (both read the ledgers directly, never the facade's
    // settlement state).
    let api: Router<AppState> = Router::new()
        .route("/balances/{hex}", get(balances))
        .route("/transactions/{hex}", get(transactions))
        .route("/deposit/info", get(deposit_info))
        .route("/currencies", get(currencies))
        .route("/onramp/ckerc20", get(ckerc20_onramp))
        .route("/health", get(health))
        .route("/capabilities", get(capabilities))
        .route("/version", get(version))
        .route("/integrity", get(integrity))
        // The Solana JSON-RPC proxy (spec 2026-09-09, Direction 1) — registered ALWAYS, unlike
        // the checkout below: an unconfigured proxy still answers (503 naming DPAY_SOLANA_RPC_URL),
        // because a route that vanishes makes the client guess. Pure pipe + read cache.
        .route("/solana/rpc", axum::routing::post(crate::solana::rpc_proxy))
        // The EVM JSON-RPC proxy (`crate::evm`) — the Solana pipe's EVM twin, registered
        // ALWAYS for the same reason: an unconfigured proxy still answers (503 naming
        // DPAY_EVM_RPC_URL). Pure pipe + read cache; `eth_sendRawTransaction` and every
        // unallowlisted method pass through byte-faithfully, uncached. The BARE route IS
        // chain 1; the per-chain suffix (spec 2026-09-26, D12) maps {chain_id} →
        // DPAY_EVM_RPC_URL_<CHAINID> and answers 404 `evm-unknown-chain` for chains outside
        // the served set.
        .route("/evm/rpc", axum::routing::post(crate::evm::rpc_proxy))
        .route(
            "/evm/rpc/{chain_id}",
            axum::routing::post(crate::evm::rpc_proxy_chain),
        )
        // The SideShift partner-key proxy (founder decision 3, 2026-09-14) — registered
        // ALWAYS for the same reason: unset credentials still answer 503 naming
        // DPAY_SIDESHIFT_SECRET / DPAY_SIDESHIFT_AFFILIATE_ID. The relay attaches the
        // partner credentials server-side (quote + fixed-order creation); the device never
        // sees them. See `crate::sideshift`.
        .route(
            "/sideshift/quotes",
            axum::routing::post(crate::sideshift::quotes_proxy),
        )
        .route(
            "/sideshift/shifts/fixed",
            axum::routing::post(crate::sideshift::shifts_fixed_proxy),
        )
        // The Trocador aggregator proxy (registered 2026-09-20) — registered ALWAYS for
        // the same reason: an unset key still answers 503 naming DPAY_TROCADOR_API_KEY.
        // The relay attaches the partner key server-side (rate + trade creation + the
        // key-gated STATUS read the sideshift venue polls keyless); the device never sees
        // it. See `crate::trocador`.
        .route(
            "/trocador/rate",
            axum::routing::post(crate::trocador::rate_proxy),
        )
        .route(
            "/trocador/trade",
            axum::routing::post(crate::trocador::trade_proxy)
                .get(crate::trocador::trade_status_proxy),
        )
        // The Trocador partner-agreement WEBHOOK receiver (2026-09-21, confirmed by the
        // venue's commercial email) — registered ALWAYS for the same 503-not-404 reason:
        // the venue PROBES this URL at trade creation and a 404 would fail the trade. POST
        // carries the venue's status-change deliveries (echoing our per-trade `webhook_key`
        // back as `key`); GET is the probe-shaped lenient sink. BOTH answer 200
        // unconditionally — a non-2xx would fail the trade, and failed deliveries are never
        // retried. See `crate::trocador_agreement`.
        .route(
            "/trocador/webhook",
            axum::routing::post(crate::trocador_agreement::webhook_receiver)
                .get(crate::trocador_agreement::webhook_probe),
        )
        // The Jupiter proxy (2026-09-16 founder ask) — registered ALWAYS, and unlike the
        // proxies above there is no unconfigured 503 branch at all: the venue is keyless
        // and its base has a constant default. Quote GETs ride the short-TTL canonical
        // cache; the swap POST is a byte-faithful never-cached pipe. See `crate::jupiter`.
        .route(
            "/jupiter/quote",
            axum::routing::get(crate::jupiter::quote_proxy),
        )
        .route(
            "/jupiter/swap",
            axum::routing::post(crate::jupiter::swap_proxy),
        );

    // --- the OpenCryptoPay checkout, ON unless the operator refuses it --------------------------------
    //
    // The eight routes below (three here; the standard's three, the camera landing page and the
    // cashier page on the root router) are registered unless `DPAY_ENABLE_CHECKOUT=false` — founder
    // decision 2026-09-10, reversing the 2026-09-04 opt-in that was taken against a production
    // probe of `POST /api/v1/checkout`. That route was UNAUTHENTICATED at the time: anyone could open
    // up a charge naming any ed25519 pubkey and any merchant name, and this relay then served a
    // full payment page for it on dpay's own domain under dpay's own certificate — a phishing
    // primitive aimed at the exact control the payer's review relies on, which host served the
    // quote.
    //
    // Both merchant routes have required the checkout-open to be SIGNED by the very key its destination
    // account derives from ever since (`crate::checkout`, rule 0; `dpay_core::validate_checkout_open`), so
    // a charge exists only where somebody who can SPEND from that account asked for one, an
    // anonymous caller can no longer force a cashier to re-open by voiding their pending charge,
    // and the unbounded `merchant_name` is both signed and clamped rather than an anonymous way to
    // spend this relay's memory. With that fixed, the founder turned the default ON; the flag
    // remains because "which surfaces does this image serve" is still an operator's call to make
    // per deploy — now as an explicit opt-out rather than an opt-in.
    //
    // The gate is at REGISTRATION, not inside the handlers: an unregistered route is refused by the
    // router with an empty 404 and no handler code is reachable, so there is one code path rather
    // than a live endpoint with a disabled branch inside it. It is read here, once, while the router
    // is built — the same instant `test-helpers`/`agent` decide their routes just above and below.
    let api = if state.checkout_enabled {
        // The merchant's own surface: open a charge, clear the checkout, and poll. `/checkout/void` is a
        // literal segment and `/checkout/{id}` a parameter, so the router matches the literal first — a
        // charge id is `pl_<hex>` and can never spell `void` anyway.
        api.route("/checkout", axum::routing::post(crate::checkout::open_charge))
            .route("/checkout/void", axum::routing::post(crate::checkout::void_charge))
            .route("/checkout/{id}", get(crate::checkout::charge_status))
    } else {
        api
    };

    // Test-only value fixture (test-helpers, WITHOUT agent — the e2e/test-relay build): the
    // faucet credits the fake-IC gateway at the user's principal; e2e assertion sugar reads it
    // back through the always-on batch /balances route above (the same gateway snapshot under
    // test-helpers). When BOTH features are on (the live-test config) the AGENT faucet below owns
    // the route instead, so the live tests drive the production branch.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let api = api.route("/faucet", axum::routing::post(faucet));
    // Test seam for the honest-unknown recovery flow (2026-08-21 mainnet NFC bug): arm
    // "hide this request_id's outcome for the next N read_states" on the fake-IC gateway —
    // see `FakeIc::hidden_outcomes`. RID-scoped, so concurrent flows on the shared relay are
    // unaffected.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/hide_outcome", axum::routing::post(hide_outcome));
    // Test seam for the stub ICPSwap pool (delegated-conversion PoC): the fake pool's knobs —
    // fee tier / price-impact overrides, the pending_withdrawal arm (`fail_withdrawal`) and
    // its resolution (`settle_pending`). See `FakeIc::set_swap_pool_knobs`.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/swap_pool", axum::routing::post(test_swap_pool));
    // Test seam for the fake-IC ledger's approve refusals (2026-09 approve semantics): arm
    // "the next N icrc2_approve calls on this ledger reply AllowanceChanged" — the
    // ledger-refusal class the happy-path fake cannot produce on demand otherwise. See
    // `FakeIcState::approve_fail`.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/approve_fail", axum::routing::post(test_approve_fail));
    // Test seam for the fake-IC reply-delay knob (2026-09-19 in-flight abort window): arm
    // "update calls of THIS method have their reply withheld from read_state for N ms after
    // each submit" — the slow-canister stand-in that gives tests a deterministic
    // submit-accepted / reply-pending window (the convert-abort e2e holds a live swap open
    // with it). See `FakeIcState::call_delay_ms`.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/ic_delay", axum::routing::post(test_ic_delay));
    // Test seam for the two-venue chooser world (multi-venue readiness V5): arm/disarm SERVING
    // a `test_helpers_served` fixture venue from GET /api/v1/venues. OFFLINE test build only —
    // the agent (prod) build has no knob at all, so it structurally can never serve an
    // invented venue (see catalog::venue_servable and its alarm). The default is un-served:
    // existing flows keep seeing exactly one venue per pair.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let api = api.route("/test/venue", axum::routing::post(test_venue_serve));
    // Test-only Solana JSON-Rpc UPSTREAM (flow 165 `e2e/tests/165-solana-via-relay.mjs`): the
    // harness points the RPC proxy (src/solana.rs, `DPAY_SOLANA_RPC_URL` set explicitly in
    // harness/relay.mjs) at this route ON THE SAME SERVER, so the flow drives the REAL client
    // path — app → POST /api/v1/solana/rpc → this stub — offline, with no provider key. The
    // `/hits` twin counts envelope arrivals so the flow can prove the request went THROUGH
    // the proxy (the app never sees this route's address directly).
    #[cfg(feature = "test-helpers")]
    let api = api
        .route(
            "/test/solana-upstream",
            axum::routing::post(solana_stub_rpc),
        )
        .route(
            "/test/solana-upstream/hits",
            axum::routing::get(solana_stub_hits),
        )
        .route(
            "/test/solana-upstream/mode",
            axum::routing::post(solana_stub_mode),
        );
    // Test-only SIDESHIFT UPSTREAM (flow 187 `e2e/tests/187-convert-cefi-sideshift.mjs`):
    // the harness points the partner-key proxy (src/sideshift.rs, DPAY_SIDESHIFT_* set
    // explicitly in harness/relay.mjs, base = DPAY_SIDESHIFT_API_BASE) at these routes ON
    // THE SAME SERVER, so the flow drives the REAL client path — app → POST
    // /api/v1/sideshift/quotes → THIS stub — offline, with no partner account. The stub
    // asserts the proxy attached the credential headers (it counts secret-bearing calls)
    // and answers the venue's own wire shapes; shift STATUS reads never come through here
    // (SideShift's are keyless device-direct https, which the e2e page fetch stub owns).
    #[cfg(feature = "test-helpers")]
    let api = api
        .route(
            "/test/sideshift-upstream/quotes",
            axum::routing::post(sideshift_stub_quotes),
        )
        .route(
            "/test/sideshift-upstream/shifts/fixed",
            axum::routing::post(sideshift_stub_shift_fixed),
        )
        .route(
            "/test/sideshift-upstream/hits",
            axum::routing::get(sideshift_stub_hits),
        );
    // Test-only TROCADOR UPSTREAM (flow 198 — the cross-rail aggregator surface): the
    // harness points the key-gated proxy (src/trocador.rs, DPAY_TROCADOR_API_KEY +
    // DPAY_TROCADOR_API_BASE set explicitly in harness/relay.mjs) at these routes ON
    // THE SAME SERVER, so the flow drives the REAL client path — app → the relay's
    // /api/v1/trocador/* → THIS stub — offline, with no partner key. The upstream calls
    // are GETs (the venue's own all-GET API); the stub counts key-bearing vs bare calls
    // (the partner-key audit) and scripts the trade status a flow's lifecycle needs.
    #[cfg(feature = "test-helpers")]
    let api = api
        .route(
            "/test/trocador-upstream/new_rate",
            axum::routing::get(trocador_stub_new_rate),
        )
        .route(
            "/test/trocador-upstream/new_trade",
            axum::routing::get(trocador_stub_new_trade),
        )
        .route(
            "/test/trocador-upstream/trade",
            axum::routing::get(trocador_stub_trade_status),
        )
        .route(
            "/test/trocador-upstream/config",
            axum::routing::post(trocador_stub_config),
        )
        .route(
            "/test/trocador-upstream/hits",
            axum::routing::get(trocador_stub_hits),
        );
    // Test-only JUPITER UPSTREAM (flows 185/186/189 — the SOL convert surfaces): the harness
    // points the Jupiter proxy (src/jupiter.rs, DPAY_JUPITER_API_BASE set explicitly in
    // harness/relay.mjs) at these routes ON THE SAME SERVER, so the flows drive the REAL
    // client path — app → GET /api/v1/jupiter/quote → THIS stub — offline. The stub replays
    // the lite-api quote/swap wire shapes with the values the flow configures
    // (`POST …/config`), and the `/hits` twin reports every quote/swap arrival (the flow's
    // proof the request went THROUGH the proxy, and that two identical quotes produced one
    // upstream call when the TTL allows). The sub-path after `/test/jupiter-upstream` is the
    // venue's own, because the proxy appends `/swap/v1/{quote,swap}` to its configured base.
    #[cfg(feature = "test-helpers")]
    let api = api
        .route(
            "/test/jupiter-upstream/config",
            axum::routing::post(jupiter_stub_configure),
        )
        .route(
            "/test/jupiter-upstream/swap/v1/quote",
            axum::routing::get(jupiter_stub_quote),
        )
        .route(
            "/test/jupiter-upstream/swap/v1/swap",
            axum::routing::post(jupiter_stub_swap),
        )
        .route(
            "/test/jupiter-upstream/hits",
            axum::routing::get(jupiter_stub_hits),
        );

    // `GET /api/v1/swap_quote` — the delegated-conversion PoC's venue quote (spec 2026-09-07
    // §2, the FIXED contract): the relay is a READ PROXY (same class as the balance fan-out) —
    // it resolves the pool against the VENUE REGISTRY (the allowlist, now table-driven), asks
    // that pool what pair it trades, derives the direction from the answer, and returns the
    // pool's own `quote` amountOut VERBATIM plus its `venue_id`, the venue's own fee tier and
    // the `fetched_at` stamp. It NEVER computes or blends a rate, and it holds no belief about
    // the venue's pair. Two builds, one route shape (mirroring the faucet split): the offline
    // image (test-helpers, without agent) reads the fake-IC stub pools; the agent build queries
    // the real ICPSwap pool anonymously.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let api = api.route("/swap_quote", axum::routing::get(swap_quote_fake));
    #[cfg(feature = "agent")]
    let api = api.route("/swap_quote", axum::routing::get(swap_quote_agent));

    // `GET /api/v1/venues` — the query-only venue registry (multi-venue readiness V4), separate
    // from /currencies because venues are PAIR-scoped, not asset-scoped.
    #[cfg(any(feature = "agent", feature = "test-helpers"))]
    let api = api.route("/venues", axum::routing::get(venues));

    // The PRODUCTION faucet (agent build — also the owner when test-helpers is co-enabled for
    // the live tests; the offline e2e image above keeps the fake-IC branch): the relay enforces
    // the cooldown locally (per-account, 1h window, old-canon error text) and drives the
    // facade's controller-gated `mint` with the authenticated agent identity, crediting the
    // USER principal. Requires DPAY_CONTROLLER_SEED at startup (main.rs) — without it the
    // canister's `require_admin` refuses the anonymous agent (422, reason surfaced verbatim).
    #[cfg(feature = "agent")]
    let api = api.route("/faucet", axum::routing::post(faucet_agent));

    let router = Router::new()
        .route("/", get(landing_page))
        .route("/download/dpay.apk", get(apk_download))
        // 2026-08-16 merge: /merchant (hand-rolled terminal page) is GONE — its capabilities live in
        // the REAL app's Receive tab (request QR + poll + scan-the-payer), served at /wallet. The
        // old URL permanently redirects so existing links/bookmarks land on the one web surface.
        .route("/merchant", get(merchant_redirect))
        .route("/wallet", get(wallet_page))
        // A shared payment link is a real route, not a query on the app's home page: the recipient
        // is the resource (the shape BIP-21 / Solana Pay use, mapped onto https). It serves the
        // same wallet page — see wallet_pay_page.
        .route("/wallet/pay/{recipient}", get(wallet_pay_page))
        // Android App Links: lets a shared https payment link open the installed app.
        .route("/.well-known/assetlinks.json", get(assetlinks))
        // The offline-boot surface (OPEN_ISSUES X10). `/sw.js` sits at the root because a service
        // worker's default scope is its own directory, and the wallet spans /wallet AND /assets/.
        .route("/sw.js", get(service_worker))
        .route("/manifest.webmanifest", get(web_manifest))
        .route("/icon-192.png", get(web_icon))
        .route("/assets/{*path}", get(web_asset))
        .route("/privacy", get(privacy_page))
        .route("/dpay-core.wasm", get(dpay_core_wasm))
        .route("/shots/{name}", get(screenshot));

    // The checkout's two HTML surfaces, behind the same gate (see above). The first is where a GENERIC
    // phone camera lands — the checkout's QR carries the LNURL inside an ordinary web address, so a
    // camera that is not a wallet opens a page rather than a 404 (`crate::checkout::checkout_code_page`).
    // The second is the cashier's own screen — the merchant's OTHER half, which watches the charge
    // they opened in the app (`crate::checkout::checkout_page`).
    //
    // The three routes a WALLET fetches are merged at the very END of this function, after the
    // test-only CORS layer, because they carry a CORS layer of their own and a response with two
    // `Access-Control-Allow-Origin` headers is refused by every browser.
    let checkout_enabled = state.checkout_enabled;
    // The same state, not a second one: every field that matters here is behind an `Arc`, so the
    // provider sub-router reads and writes the charges the merchant routes above opened.
    let provider_state = state.clone();
    let router = if checkout_enabled {
        router
            .route(
                crate::checkout::CHECKOUT_CODE_PATH,
                get(crate::checkout::checkout_code_page),
            )
            .route("/checkout/{id}", get(crate::checkout::checkout_page))
    } else {
        router
    };

    let router = router.nest("/api/v1", api);

    // Test-only fake-IC /api/v2 gateway (test-helpers): the offline e2e stand-in for icp-api.io,
    // mounted at the ROOT (the IC API is its own top-level namespace — NOT under /api/v1). Routed
    // on the pre-state router so the submit handler's State<AppState> extractor resolves.
    #[cfg(feature = "test-helpers")]
    let router = router
        .route(
            "/api/v2/canister/{canister}/{kind}",
            axum::routing::post(crate::ic_gateway::submit),
        )
        .route("/api/v2/status", get(crate::ic_gateway::status));

    let router = router.with_state(state);

    // Test-only CORS: allows the web build of the app (served by vite on a different port) to make
    // direct fetch() calls to the relay during e2e + UX review. Gated behind `test-helpers` so the
    // prod image (built without the feature) never sends CORS headers on these routes. The e2e
    // harness ALSO launches Chrome with --disable-web-security, but this layer makes the relay
    // usable by ANY web-based test tool without requiring browser flags.
    //
    // Applied BEFORE the provider routes are merged, which in axum means it does not wrap them
    // (`Router::layer` only wraps what is already registered). That is deliberate: those routes
    // carry the production layer below in EVERY build, so what the relay test suite drives is the
    // header set a real wallet meets rather than this fixture's.
    #[cfg(feature = "test-helpers")]
    let router = router.layer(axum::middleware::from_fn(test_cors_middleware));

    // The payer-facing half of the checkout — the three routes a WALLET fetches, and the only routes on
    // this relay that answer a cross-origin browser request.
    //
    // WHY THEY NEED CORS AT ALL, and why nothing else here does: an OpenCryptoPay wallet may be a
    // WEB page. Oisy is (oisy.com IS the wallet), and its scanner fetches the decoded LNURL
    // directly — so without an `Access-Control-Allow-Origin` on these three the browser refuses the
    // read before our handler is ever consulted, and the wallet can only report the code itself as
    // invalid. Measured 2026-09-12 against prod (preflight `405`, no CORS header on the GET) and
    // against the reference provider, which answers `access-control-allow-origin: *` on the very
    // same paths (`docs/specs/2026-09-01-opencryptopay-findings.md`).
    //
    // `*` is the right origin for exactly the reason it is wrong almost everywhere else: these
    // three are public, unauthenticated, credential-free reads of a charge whose id is printed on a
    // QR code in a shop window. The relay's OWN surfaces are NOT in here — the Solana RPC proxy
    // alone would hand any web page the operator's provider quota — which is why this is a merged
    // sub-router and not a layer over everything.
    if checkout_enabled {
        router.merge(
            Router::new()
                // The paths the STANDARD dictates, rather than this relay's own namespace: a wallet
                // derives the submission URL from the callback by swapping `/cb/` for `/tx/`, so
                // those segments are part of the protocol.
                .route("/v1/lnurlp/{id}", get(crate::checkout::lnurlp_details))
                .route("/v1/lnurlp/cb/{id}", get(crate::checkout::lnurlp_callback))
                .route("/v1/lnurlp/tx/{id}", get(crate::checkout::lnurlp_submit))
                .with_state(provider_state)
                .layer(axum::middleware::from_fn(provider_cors_middleware)),
        )
    } else {
        router
    }
}

/// Answer any origin, and answer the preflight here.
///
/// The ONE statement of what permissive CORS means on this relay, so its two users cannot drift:
/// the OpenCryptoPay provider routes (production — a wallet may be a web page) and the test-only
/// fixture layer. `methods` is the only thing that differs between them, because it is the only
/// thing that IS different: the provider surface is read-only.
///
/// The preflight is answered here rather than passed down because a router that only has `get` on
/// a path answers `OPTIONS` with `405` and no headers at all, which a browser reads as "this
/// server refuses cross-origin requests" — the exact failure this whole function exists to fix.
/// `insert` (never `append`): two `Access-Control-Allow-Origin` headers are refused by every
/// browser, so a response that somehow passes through twice still carries exactly one.
async fn cors_any_origin(
    req: axum::extract::Request,
    next: axum::middleware::Next,
    methods: &'static str,
) -> Response {
    let preflight = req.method() == axum::http::Method::OPTIONS;
    let mut resp = if preflight {
        let mut resp = Response::new(axum::body::Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        resp
    } else {
        next.run(req).await
    };
    let h = resp.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"),
    );
    // `X-Dpay-Order-Id` (the Trocador agreement's order id, attached by the trade route and
    // persisted by the wallet's convert service) is a NON-simple response header: a cross-origin
    // page can read it only when it is EXPOSED. Same-origin reads — prod, where the relay serves
    // /wallet itself — are unaffected either way; this only unblocks the cross-origin topologies
    // (vite-served web builds in tests/review) that already carry `ACAO *` from this helper.
    h.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        header::HeaderValue::from_static("X-Dpay-Order-Id"),
    );
    if preflight {
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            header::HeaderValue::from_static(methods),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            header::HeaderValue::from_static("Content-Type"),
        );
    }
    resp
}

/// CORS for the three OpenCryptoPay routes a wallet fetches — production, every build. Why these
/// and only these: see the merge site in [`app`].
///
/// `Content-Type` is in the allowed headers because a wallet sends it on a GET (Oisy does), and
/// that alone is what turns an otherwise-simple request into one that needs this preflight.
async fn provider_cors_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    cors_any_origin(req, next, "GET, HEAD, OPTIONS").await
}

/// Permissive CORS middleware (test-only, feature-gated) — see the layer site in [`app`].
#[cfg(feature = "test-helpers")]
async fn test_cors_middleware(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    cors_any_origin(req, next, "GET, POST, OPTIONS").await
}

/// The rate limit BOTH faucet handlers run before crediting anything, so the offline fixture and
/// production cannot answer the same request differently. `None` = proceed; `Some` = the refusal to
/// return, carrying the cooldown's own verbatim wait text (the app renders it as-is, N5).
///
/// A request that is not the canonical self-service top-up is not rate-limited HERE, because it is
/// not a top-up: production refuses it outright at its own call site, and the fixture serves it as
/// the e2e harness's opening-balance credit. See [`crate::faucet::is_self_service_top_up`].
#[cfg(any(feature = "agent", feature = "test-helpers"))]
fn faucet_cooldown_refusal(
    state: &AppState,
    pk: &[u8; 32],
    currency: u32,
    amount: u64,
) -> Option<Response> {
    if !crate::faucet::is_self_service_top_up(amount) {
        return None;
    }
    // The lock is NEVER held across an await (check-and-mark completes synchronously) and is
    // poison-tolerant like every lock in this crate. The clock is the crate's one reading, which
    // STOPS on a pre-epoch host rather than substituting `0` — see [`crate::now_secs`] for what
    // the `0` this replaces did to this exact cooldown.
    let now_secs = crate::now_secs();
    match state
        .faucet_cooldown
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .check_and_mark(pk, currency, now_secs)
    {
        Ok(()) => None,
        Err(reason) => Some(err(StatusCode::UNPROCESSABLE_ENTITY, reason)),
    }
}

/// `POST /api/v1/faucet` JSON `{account: <hex>, currency?, amount?}` → `{balance}`. Demo on-ramp
/// (test-helpers WITHOUT agent — the e2e/test-relay build; the agent build serves the production
/// branch below). Credits the user PRINCIPAL on the fake-IC gateway's ledger for `currency`,
/// exactly where a signed icrc1_transfer would move funds; the pk → principal mapping is
/// self_authenticating(pk) — the account the app derives from its device key. Defaults:
/// `currency = DEMO_USD` (0), `amount =` the canonical top-up.
///
/// It serves a SUPERSET of production: an arbitrary `amount` is accepted so the e2e harness can set
/// a flow's opening balance in raw units (sats, wei, 8-decimal VCHF), which production answers 422
/// to. Everything production DOES accept is answered identically here, cooldown included.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
async fn faucet(State(state): State<AppState>, Json(req): Json<FaucetRequest>) -> Response {
    // ONE gate, the same predicate `GET /api/v1/capabilities` reports — and it subsumes the
    // gateway check, because this branch can credit nothing else. Binding the gateway out of it
    // keeps a single refusal path instead of a second "not attached" branch saying the same thing.
    let Some(fake) = state.fake_ic.clone().filter(|_| state.faucet_available) else {
        return err(StatusCode::SERVICE_UNAVAILABLE, FAUCET_UNAVAILABLE);
    };
    let pk = ok_or_bail!(parse_hex_array(&req.account, "account"));
    // Currency defaults to DEMO_USD — the faucet's whole point is play money for the demo. A missing
    // amount is the demo's $100.00 top-up.
    let currency = req.currency.unwrap_or(DEMO_USD);
    let amount = req
        .amount
        .map(|x| x.0)
        .unwrap_or(crate::faucet::FAUCET_AMOUNT);
    if let Some(refusal) = faucet_cooldown_refusal(&state, &pk, currency as u32, amount) {
        return refusal;
    }
    use dpay_icp::principal::Principal as IcpPrincipal;
    let owner = IcpPrincipal::self_authenticating_ed25519(&pk);
    let bal = fake.faucet_credit(currency, &owner, u128::from(amount));
    (
        StatusCode::OK,
        Json(BalanceBody {
            balance: U64String(bal.min(u64::MAX as u128) as u64),
        }),
    )
        .into_response()
}

/// `POST /api/v1/faucet` JSON `{account: <hex>, currency?, amount?}` → `{balance}` — the
/// PRODUCTION top-up (agent build; also compiled with BOTH features so the live tests drive
/// this branch against a real PocketIC replica — the offline e2e build serves the fake-IC
/// credit above). Founder-approved design (2026-08-20): the cooldown lives HERE (relay-side,
/// per-account hex pubkey × currency, 1h window, byte-identical old-canon error text — cheap to
/// tune/redeploy, no canister upgrade cycle) and the mint itself is an AUTHENTICATED call to the
/// facade's controller-gated `mint`, crediting the USER principal (`self_authenticating(pk)`) —
/// exactly the account the app reads. The relay holds the controller key: acceptable because
/// the facade is out of the value path post-cutover, so the key only exposes play-money minting
/// + canister governance (already founder-managed).
///
/// Amount is PINNED to the canonical $100.00 top-up (`FAUCET_AMOUNT` = 10_000 cents — what the
/// app's TOP_UP_CENTS sends): a client-supplied `amount` is accepted only when it matches, so
/// the request shape stays forward-compatible while the self-service surface cannot print an
/// arbitrary amount. Canister refusals surface VERBATIM (`{error: text}`, 422) — the app's
/// Wallet shows the reason as-is (N5); transport failures answer 503.
#[cfg(feature = "agent")]
async fn faucet_agent(State(state): State<AppState>, Json(req): Json<FaucetRequest>) -> Response {
    // The SAME predicate `GET /api/v1/capabilities` reports, so the route and the advertisement
    // cannot disagree. Refusing here rather than at the canister costs one round trip and, more
    // to the point, names the missing knob: an anonymous relay's mint is refused by
    // `require_admin` anyway, and "unauthorized" does not tell an operator what to set.
    if !state.faucet_available {
        return err(StatusCode::SERVICE_UNAVAILABLE, FAUCET_UNAVAILABLE);
    }
    let pk = ok_or_bail!(parse_hex_array(&req.account, "account"));
    let currency = req.currency.unwrap_or(DEMO_USD);
    let amount = req
        .amount
        .map(|x| x.0)
        .unwrap_or(crate::faucet::FAUCET_AMOUNT);
    if !crate::faucet::is_self_service_top_up(amount) {
        return err(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "faucet amount is fixed at {} (minor units)",
                crate::faucet::FAUCET_AMOUNT
            ),
        );
    }
    // Relay-side rate limit, the same one the offline fixture runs — see [`faucet_cooldown_refusal`].
    if let Some(refusal) = faucet_cooldown_refusal(&state, &pk, currency as u32, amount) {
        return refusal;
    }
    match state.ledger.faucet_mint(&pk, currency, amount).await {
        Ok(balance) => (
            StatusCode::OK,
            Json(BalanceBody {
                balance: U64String(balance),
            }),
        )
            .into_response(),
        // The canister's own refusal text (e.g. "currency 0 is not mintable", or an
        // unauthorized-controllership change) — surfaced verbatim per the app's N5 contract.
        Err(LedgerError::Rejected(msg)) => err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("ledger unavailable: {msg}"),
        ),
    }
}

/// `POST /api/v1/test/hide_outcome` JSON `{request_id: <32-byte hex>, polls: <u32>}` → `{ok: true}`
/// (test-helpers only). Arms the fake-IC gateway's outcome-latency seam for THAT request id: the
/// next `polls` read_state certs omit the rid's `request_status` entry. Drives the honest-unknown
/// recovery flow (in-tap poll budget exhaustion → reader handoff → background reconcile) — see
/// `FakeIc::hidden_outcomes`.
#[cfg(feature = "test-helpers")]
async fn hide_outcome(
    State(state): State<AppState>,
    Json(req): Json<HideOutcomeRequest>,
) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    let rid: [u8; 32] = ok_or_bail!(parse_hex_array(&req.request_id, "request_id"));
    let polls = req.polls.unwrap_or(1).min(64) as usize;
    fake.arm_hidden_outcome(rid, polls);
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// `POST /api/v1/test/swap_pool` JSON `{pool, fee_millionths?, impact_bps?, fail_withdrawal?,
/// settle_pending?}` → `{ok: true}` (test-helpers only) — the knobs of ONE fake-IC stub pool,
/// named by its principal (multi-venue readiness V3: the gateway hosts many pools, so every
/// knob names its target; `pool` is required — a silent default would let a knob meant for one
/// pool land on another). `fail_withdrawal: true` arms spec §4's pending_withdrawal path (swaps
/// consume the input, queue the output, never pay it); `settle_pending: true` drains that
/// pool's queue — the eventual resolution the pending_withdrawal e2e flow needs.
/// `fee_millionths` and `impact_bps` (default 0) shape that pool's deterministic quote curve.
/// An unknown `pool` is 400 `unknown_pool`, same refusal the quote route makes.
#[cfg(feature = "test-helpers")]
async fn test_swap_pool(State(state): State<AppState>, Json(req): Json<SwapPoolKnobs>) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    let Some(pool) = req.pool.as_deref() else {
        return err(StatusCode::BAD_REQUEST, "pool is required");
    };
    if !fake.set_swap_pool_knobs(
        pool,
        req.fee_millionths,
        req.impact_bps,
        req.fail_withdrawal,
        req.settle_pending,
    ) {
        return err(StatusCode::BAD_REQUEST, "unknown_pool");
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// `POST /api/v1/test/approve_fail` JSON `{ledger, refusals?}` → `{ok: true}` (test-helpers
/// only) — the fake-IC ledger's approve-refusal knob: the next `refusals` (default 1, capped
/// at 64) `icrc2_approve` calls on THAT ledger reply `AllowanceChanged { current_allowance: 0 }`
/// regardless of state. Stands in for the real-ledger refusal class (stale/raced approval
/// expectation) the happy-path fake could never produce on demand — the class the 2026-09
/// expected_allowance bug hid. `refusals: 0` disarms. An unknown `ledger` is a 400
/// `unknown_ledger`, same named refusal the swap-pool knobs make.
#[cfg(feature = "test-helpers")]
async fn test_approve_fail(
    State(state): State<AppState>,
    Json(req): Json<ApproveFailKnob>,
) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    let Some(ledger) = req.ledger.as_deref() else {
        return err(StatusCode::BAD_REQUEST, "ledger is required");
    };
    let refusals = req.refusals.unwrap_or(1).min(64);
    if !fake.arm_approve_fail(ledger, refusals) {
        return err(StatusCode::BAD_REQUEST, "unknown_ledger");
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// `POST /api/v1/test/ic_delay` JSON `{method, ms?}` → `{ok: true}` (test-helpers only) — the
/// fake-IC reply-delay knob: update calls of THAT method have their reply withheld from
/// read_state for `ms` after each submit (0 = disarm), while the submit itself stays a
/// normal accepted 202. The fake's stand-in for a slow canister — the deterministic
/// in-flight window (accepted, reply pending) a Stop-the-swap test needs; a real boundary
/// node produces it only with real latency. An unknown `method` is a 400 `unknown_method`
/// and a delay beyond the 30 s cap is a 400 `delay_too_long` — named refusals, exactly like
/// the other knobs'.
#[cfg(feature = "test-helpers")]
async fn test_ic_delay(State(state): State<AppState>, Json(req): Json<IcDelayKnob>) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    let Some(method) = req.method.as_deref() else {
        return err(StatusCode::BAD_REQUEST, "method is required");
    };
    let ms = req.ms.unwrap_or(0);
    if ms > crate::ic_gateway::IC_DELAY_CAP_MS {
        // Named before the armer's own (boolean) refusal so a too-long delay is never
        // misreported as an unknown method.
        return err(StatusCode::BAD_REQUEST, "delay_too_long");
    }
    if !fake.arm_call_delay(method, ms) {
        return err(StatusCode::BAD_REQUEST, "unknown_method");
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// `POST /api/v1/test/venue` JSON `{venue_id, served}` → `{ok: true, served}` (offline test
/// build only) — the venue-chooser test knob (multi-venue readiness V5): arm/disarm SERVING a
/// `test_helpers_served` fixture venue from `GET /api/v1/venues`. The DEFAULT is un-served
/// (one venue per pair, exactly the production experience); a two-venue test opts in here and
/// disarms on teardown. A REAL venue is never knob-gated (`not_a_test_venue`) and an unknown
/// id is refused by name (`unknown_venue`) — the knob can neither silence a real venue nor
/// invent one the registry does not pin.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
async fn test_venue_serve(State(state): State<AppState>, Json(req): Json<VenueServeKnob>) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    match crate::catalog::venues()
        .into_iter()
        .find(|v| v.venue_id == req.venue_id)
        .map(|v| v.test_helpers_served)
    {
        None => return err(StatusCode::BAD_REQUEST, "unknown_venue"),
        Some(false) => return err(StatusCode::BAD_REQUEST, "not_a_test_venue"),
        Some(true) => {}
    }
    if !fake.set_venue_served(&req.venue_id, req.served) {
        return err(StatusCode::BAD_REQUEST, "unknown_venue");
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "served": fake.venue_served(&req.venue_id) })),
    )
        .into_response()
}

// ── Test-only Solana JSON-RPC upstream (test-helpers) ─────────────────────────────────────────
//
// Flow 165 (`e2e/tests/165-solana-via-relay.mjs`) drives the REAL Solana client path — the
// app's RPC walk → this relay's proxy route (`src/solana.rs`) → an upstream — fully offline:
// the harness points `DPAY_SOLANA_RPC_URL` (harness/relay.mjs) at THIS stub on the same
// server. The stub speaks just enough JSON-RPC for a balance render:
//
//   • `getMultipleAccounts` answers POSITIONALLY — the app always sends
//     [wallet, ata, mint, ata, mint, …] (one canonical ATA + its mint per registered token),
//     so index 0 is the wallet (2 SOL), every ODD index is a token account (3.000000 raw
//     units of the mint at the FOLLOWING index — whose bytes are bs58-decoded from that
//     address and planted at the token-account's mint offset so the app's
//     `decodeSplTokenAmount` mint check passes), and every even index ≥ 2 is a mint
//     (6 decimals — both registered mainnet tokens, USDC and EURC, are 6-decimal).
//   • `getGenesisHash` answers mainnet-beta's frozen id (the client's `SOL_GENESIS_HASH`) so
//     the cluster-identity checks stay coherent.
//   • every other read gets a sane constant; `sendTransaction` echoes a stub signature.
//   • `getSignatureStatuses` answers `[null]` ("never heard of it") until armed otherwise via
//     `POST /api/v1/test/solana-upstream/mode` (below): N nulls, then `confirmed`, or — fail
//     knob — an on-chain InstructionError. Flow 202 drives the send terminal's honest unknown →
//     Check status → settled flip and the fee-only failure leg through this.
//
// The proxy relays these VERBATIM, and its read cache (2s for getMultipleAccounts) applies
// upstream of the hit counter — a flow asserting hit GROWTH must out-wait that TTL.
#[cfg(feature = "test-helpers")]
static SOLANA_STUB_HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// The getSignatureStatuses flip knobs (flow 202, stream D's send-terminal flows). `SOLANA_STUB_GETSIG_HITS`
// counts getSignatureStatuses envelopes that REACHED the stub (proxy cache hits never arrive here —
// the confirm loop's `[[sig]]` params and the status read's `[[sig], {searchTransactionHistory:true}]`
// params canonicalize differently, so they always cache and count separately). The two thresholds
// are stored SHIFTED: `0` = off, user value N is stored as N+1, and the flip fires on hits ≥ stored
// — so N=0 means "flip from the very first hit" without colliding with off. Every `/mode` POST
// REPLACES the whole mode (an omitted knob is disarmed) and resets the hit count, so an arm is
// always "N [null] answers from now, then the flip".
#[cfg(feature = "test-helpers")]
static SOLANA_STUB_GETSIG_HITS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static SOLANA_STUB_CONFIRM_AFTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static SOLANA_STUB_FAIL_AFTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// `POST /api/v1/test/solana-upstream/mode` — arm the stub's `getSignatureStatuses` flip (see the
/// statics above). `{confirmAfterHits: N}` → N `[null]` answers, then `confirmed` (flow 202's
/// submitting → unknown → Check status → settled flip). `{failAfterHits: N}` → N `[null]` answers,
/// then an on-chain `InstructionError` — the fee-only failure leg, both as the send's own confirm
/// verdict and as a Check-status answer. The body REPLACES the mode: an omitted knob is disarmed,
/// `{}` is the neutral never-flipping default, and arming resets the flip counter. Only these two
/// methods flip; every other stub answer is unchanged.
#[cfg(feature = "test-helpers")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SolanaStubMode {
    confirm_after_hits: Option<usize>,
    fail_after_hits: Option<usize>,
}

#[cfg(feature = "test-helpers")]
async fn solana_stub_mode(Json(req): Json<SolanaStubMode>) -> Response {
    use std::sync::atomic::Ordering;
    // Shifted encoding: user N → N+1, so 0 stays "off" (see the statics' comment).
    let confirm = req.confirm_after_hits.map_or(0, |n| n + 1);
    let fail = req.fail_after_hits.map_or(0, |n| n + 1);
    SOLANA_STUB_CONFIRM_AFTER.store(confirm, Ordering::Relaxed);
    SOLANA_STUB_FAIL_AFTER.store(fail, Ordering::Relaxed);
    SOLANA_STUB_GETSIG_HITS.store(0, Ordering::Relaxed);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "confirmAfterHits": req.confirm_after_hits,
            "failAfterHits": req.fail_after_hits,
        })),
    )
        .into_response()
}

/// `POST /api/v1/test/solana-upstream` — the stub JSON-RPC upstream (see the section comment).
#[cfg(feature = "test-helpers")]
async fn solana_stub_rpc(body: axum::body::Bytes) -> Response {
    use std::sync::atomic::Ordering;
    SOLANA_STUB_HITS.fetch_add(1, Ordering::Relaxed);
    let envelope: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "stub upstream: body is not JSON"),
    };
    let id = envelope.get("id").cloned().unwrap_or(serde_json::json!(1));
    let method = envelope
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let params = envelope
        .get("params")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let result = match method {
        "getMultipleAccounts" => serde_json::json!({
            "context": {"slot": 1000},
            "value": solana_stub_accounts(&params),
        }),
        "getBalance" => serde_json::json!({"context": {"slot": 1000}, "value": 2_000_000_000u64}),
        "getGenesisHash" => serde_json::json!("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
        "getLatestBlockhash" => serde_json::json!({
            "context": {"slot": 1000},
            "value": {
                // 32 × '1' — VALID base58 that decodes to 32 zero bytes, so the app's sign step
                // (base58-decode → 32-byte blockhash) really accepts it. A flow 202 send signs
                // against this and broadcasts; an unparseable string here would fail the sign
                // step and never reach the terminal story the flow drives.
                "blockhash": "11111111111111111111111111111111",
                "lastValidBlockHeight": 1_000_000u64,
            },
        }),
        "getBlockHeight" => serde_json::json!(1_000_000u64),
        "isBlockhashValid" => serde_json::json!({"context": {"slot": 1000}, "value": true}),
        "getSignatureStatuses" => {
            // The flip knobs (see the statics above): N nulls, then confirmed — or, when the fail
            // knob is armed, an on-chain InstructionError (it wins: a definitive failure is the
            // one answer that must never be softened into a settle).
            use std::sync::atomic::Ordering;
            let hit = SOLANA_STUB_GETSIG_HITS.fetch_add(1, Ordering::Relaxed) + 1;
            let confirm_after = SOLANA_STUB_CONFIRM_AFTER.load(Ordering::Relaxed);
            let fail_after = SOLANA_STUB_FAIL_AFTER.load(Ordering::Relaxed);
            if fail_after != 0 && hit >= fail_after {
                serde_json::json!({
                    "context": {"slot": 1000},
                    "value": [{
                        "slot": 1000u64,
                        "confirmationStatus": "failed",
                        "err": {"InstructionError": [0, {"Custom": 1}]},
                    }],
                })
            } else if confirm_after != 0 && hit >= confirm_after {
                serde_json::json!({
                    "context": {"slot": 1000},
                    "value": [{
                        "slot": 1000u64,
                        "confirmations": 10u64,
                        "confirmationStatus": "confirmed",
                        "err": serde_json::Value::Null,
                    }],
                })
            } else {
                serde_json::json!({"context": {"slot": 1000}, "value": [null]})
            }
        }
        "getSignaturesForAddress" => serde_json::json!([]),
        "getFeeForMessage" => {
            serde_json::json!({"context": {"slot": 1000}, "value": {"lamports": 5000u64}})
        }
        "getAccountInfo" => serde_json::json!({"context": {"slot": 1000}, "value": null}),
        "getTransaction" => serde_json::json!(null),
        "getTokenAccountBalance" => serde_json::json!({
            "context": {"slot": 1000},
            "value": {"amount": "3000000", "decimals": 6, "uiAmount": 3.0, "uiAmountString": "3"},
        }),
        // A stub signature, UNIQUE per broadcast (counter-derived): each send gets its own
        // signature, so a second send's confirm polls never alias the first send's proxy-cached
        // getSignatureStatuses answers (flow 202 sends twice on one stub). Nothing parses this
        // as a real one — it is an opaque string the sheet keeps and re-reads by.
        "sendTransaction" => serde_json::json!(format!(
            "STUBSIG{}",
            SOLANA_STUB_HITS.load(std::sync::atomic::Ordering::Relaxed)
        )),
        other => {
            // Unsupported method: answer as a PROVIDER would (200 + JSON-RPC error envelope),
            // so the client's refusal path — not the transport path — handles it.
            return (
                StatusCode::OK,
                Json(serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {"code": -32601, "message": format!("stub upstream: unsupported method {other}")},
                })),
            )
                .into_response();
        }
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result})),
    )
        .into_response()
}

/// The positional `getMultipleAccounts` answer — see the section comment for the layout.
#[cfg(feature = "test-helpers")]
fn solana_stub_accounts(params: &serde_json::Value) -> serde_json::Value {
    use base64::Engine as _;
    let addrs: Vec<String> = params
        .as_array()
        .and_then(|a| a.first())
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    // A 165-byte SPL token account: mint bytes at 0..32, amount at 64..72, zeros elsewhere —
    // exactly the fields `decodeSplTokenAmount` reads (app/solana/spl.ts).
    let token_blob = |mint: Option<&str>| -> String {
        let mut blob = vec![0u8; 165];
        if let Some(bytes) = mint.and_then(solana_stub_bs58_decode) {
            let n = bytes.len().min(32);
            blob[..n].copy_from_slice(&bytes[..n]);
        }
        blob[64..72].copy_from_slice(&3_000_000u64.to_le_bytes());
        base64::engine::general_purpose::STANDARD.encode(blob)
    };
    // An 82-byte SPL mint: decimals at byte 44 — the only field `decodeSplMintDecimals` reads.
    let mint_blob = || -> String {
        let mut blob = vec![0u8; 82];
        blob[44] = 6;
        base64::engine::general_purpose::STANDARD.encode(blob)
    };
    let value: Vec<serde_json::Value> = addrs
        .iter()
        .enumerate()
        .map(|(i, _)| {
            if i == 0 {
                serde_json::json!({
                    "lamports": 2_000_000_000u64,
                    "owner": "11111111111111111111111111111111",
                    "data": ["", "base64"],
                    "executable": false,
                    "rentEpoch": 0,
                    "space": 0,
                })
            } else if i % 2 == 1 {
                serde_json::json!({
                    "lamports": 2_039_280u64,
                    "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                    "data": [token_blob(addrs.get(i + 1).map(String::as_str)), "base64"],
                    "executable": false,
                    "rentEpoch": 0,
                    "space": 165,
                })
            } else {
                serde_json::json!({
                    "lamports": 1_461_600u64,
                    "owner": "11111111111111111111111111111111",
                    "data": [mint_blob(), "base64"],
                    "executable": false,
                    "rentEpoch": 0,
                    "space": 82,
                })
            }
        })
        .collect();
    serde_json::json!(value)
}

/// Minimal bs58 DECODE (alphabet table + big-number base conversion, leading-'1' zeros): the
/// app's token-account decoder re-encodes a blob's first 32 bytes and requires the mint
/// ADDRESS, so the stub must plant that address's own bytes there. Hand-rolled because the
/// relay tree has no bs58 dependency and this is its only consumer (test-helpers only).
#[cfg(feature = "test-helpers")]
fn solana_stub_bs58_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new(); // big-endian base-256 accumulator
    for ch in s.bytes() {
        let val = u32::try_from(ALPHABET.iter().position(|&a| a == ch)?).ok()?;
        let mut carry = val;
        for byte in digits.iter_mut().rev() {
            let acc = u32::from(*byte) * 58 + carry;
            *byte = (acc & 0xff) as u8;
            carry = acc >> 8;
        }
        while carry > 0 {
            digits.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&b| b == b'1').count();
    let mut out = vec![0u8; zeros];
    out.extend(digits);
    Some(out)
}

/// `GET /api/v1/test/solana-upstream/hits` → `{"hits": N}` — how many envelopes the stub has
/// served (the flow's proof that the app's request reached the UPSTREAM through the proxy).
#[cfg(feature = "test-helpers")]
async fn solana_stub_hits() -> Response {
    use std::sync::atomic::Ordering;
    (
        StatusCode::OK,
        Json(serde_json::json!({"hits": SOLANA_STUB_HITS.load(Ordering::Relaxed)})),
    )
        .into_response()
}

// --- test-only SIDESHIFT upstream (the partner-key proxy's offline stand-in) ----------------------
//
// The REAL venue's wire shapes, as verified live + from the docs 2026-09-15
// (docs.sideshift.ai): POST /quotes answers 201 with {id, echoed pair fields,
// depositAmount, settleAmount}; POST /shifts/fixed answers 201 with {id, depositAddress,
// echoed pair fields, depositAmount, settleAmount, expiresAt}. The stub replays exactly
// those shapes with deterministic values (quote id, shift id, deposit address) so flow 187
// can assert them verbatim. It counts calls that carried the x-sideshift-secret header —
// the flow's proof that the proxy attached the credential the device never sees — and
// records the last request body per route so tests can pin what the relay forwarded.
// STATUS reads never route through here (they are the venue's own keyless GET, owned by
// the e2e page fetch stub; see e2e/harness/sideshift.mjs).
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_SECRET_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_BARE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_LAST: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// The depositAmount of the most recently served QUOTE. The relay's shift-creation body
/// carries {quoteId, settleAddress, …} — no amount — and a real venue binds the order to
/// the QUOTE's amount, so the shift stub echoes this (never a hard-coded default).
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_LAST_DEPOSIT: std::sync::Mutex<String> =
    std::sync::Mutex::new(String::new());
/// Per-route arrival counts — the e2e flow's proof that an order is never RE-created
/// across a reload (shiftCalls must not move) while quotes legitimately re-fetch.
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_QUOTE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static SIDESHIFT_STUB_SHIFT_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Record one stub arrival: classify by credential-header presence, remember the body.
#[cfg(feature = "test-helpers")]
fn sideshift_stub_record(headers: &axum::http::HeaderMap, body: &str) {
    use std::sync::atomic::Ordering;
    if headers.contains_key("x-sideshift-secret") {
        SIDESHIFT_STUB_SECRET_CALLS.fetch_add(1, Ordering::Relaxed);
    } else {
        SIDESHIFT_STUB_BARE_CALLS.fetch_add(1, Ordering::Relaxed);
    }
    if let Ok(mut slot) = SIDESHIFT_STUB_LAST.lock() {
        *slot = Some(body.to_string());
    }
}

/// `POST /api/v1/test/sideshift-upstream/quotes` — the venue's 201 quote shape.
#[cfg(feature = "test-helpers")]
async fn sideshift_stub_quotes(headers: axum::http::HeaderMap, body: axum::body::Bytes) -> Response {
    sideshift_stub_record(&headers, &String::from_utf8_lossy(&body));
    SIDESHIFT_STUB_QUOTE_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "stub upstream: body is not JSON"),
    };
    if let Some(amount) = req.get("depositAmount").and_then(|v| v.as_str()) {
        if let Ok(mut slot) = SIDESHIFT_STUB_LAST_DEPOSIT.lock() {
            *slot = amount.to_string();
        }
    }
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": "e2e-quote-7f3a",
            "depositCoin": req.get("depositCoin").cloned().unwrap_or(serde_json::json!("ICP")),
            "depositNetwork": req.get("depositNetwork").cloned().unwrap_or(serde_json::json!("icp")),
            "settleCoin": req.get("settleCoin").cloned().unwrap_or(serde_json::json!("SOL")),
            "settleNetwork": req.get("settleNetwork").cloned().unwrap_or(serde_json::json!("solana")),
            "depositAmount": req.get("depositAmount").cloned().unwrap_or(serde_json::json!("2")),
            "settleAmount": "0.0495",
            "rate": "0.02475",
        })),
    )
        .into_response()
}

/// `POST /api/v1/test/sideshift-upstream/shifts/fixed` — the venue's 201 fixed-shift
/// shape (the deposit address + memo the user must send to are the whole point).
#[cfg(feature = "test-helpers")]
async fn sideshift_stub_shift_fixed(
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    sideshift_stub_record(&headers, &String::from_utf8_lossy(&body));
    SIDESHIFT_STUB_SHIFT_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "stub upstream: body is not JSON"),
    };
    // The quoted depositAmount, not a constant: the order is bound to its quote (the app's
    // prepare red line refuses an order whose amount differs from the reviewed quote).
    let quoted_deposit = SIDESHIFT_STUB_LAST_DEPOSIT
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": "e2e-shift-9c1d",
            "depositCoin": req.get("depositCoin").cloned().unwrap_or(serde_json::json!("ICP")),
            "settleCoin": req.get("settleCoin").cloned().unwrap_or(serde_json::json!("SOL")),
            "depositAddress": "e2e-deposit-address-01",
            "settleAddress": req.get("settleAddress").cloned().unwrap_or(serde_json::json!("")),
            "depositAmount": req.get("depositAmount").cloned()
                .unwrap_or_else(|| serde_json::json!(if quoted_deposit.is_empty() { "2" } else { &quoted_deposit })),
            "settleAmount": "0.0495",
            "expiresAt": "2026-09-16T00:00:00.000Z",
        })),
    )
        .into_response()
}

/// `GET /api/v1/test/sideshift-upstream/hits` — how many credentialed vs bare calls the
/// stub has served (bare should stay ZERO for every flow: the proxy always attaches the
/// secret — a bare hit means a path reached the stub without the relay's key), plus
/// per-route counts so the e2e flow can prove an order was NEVER re-created across a
/// reload (shiftCalls must not move) while quotes legitimately re-fetch.
#[cfg(feature = "test-helpers")]
async fn sideshift_stub_hits() -> Response {
    use std::sync::atomic::Ordering;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "secretCalls": SIDESHIFT_STUB_SECRET_CALLS.load(Ordering::Relaxed),
            "bareCalls": SIDESHIFT_STUB_BARE_CALLS.load(Ordering::Relaxed),
            "quoteCalls": SIDESHIFT_STUB_QUOTE_CALLS.load(Ordering::Relaxed),
            "shiftCalls": SIDESHIFT_STUB_SHIFT_CALLS.load(Ordering::Relaxed),
        })),
    )
        .into_response()
}

// --- test-only TROCADOR upstream (the key-gated aggregator's offline stand-in) -------------------
//
// The wire shapes the venue's own docs pin (https://trocador.app/en/docs/, fetched
// 2026-09-20): ALL methods are GET answering flat JSON — `new_rate` → {trade_id, amount_from,
// amount_to, provider, fixed, status, …}; `new_trade` → the same plus address_provider (the
// VENUE's deposit address); `trade?id=` → the trade record incl. status + details.hashout.
// The stub ECHOES the request's own query params where the real venue does (amount_from,
// provider, refund) and serves the figures the flow configures, so the app's shape
// validation and the flow's UI assertions run against exactly the field names the real
// venue uses. The upstream calls are GETs carrying the `API-Key` header — the stub counts
// key-bearing vs bare calls (bare must stay ZERO: a bare hit means a path reached the stub
// without the relay's key). Status is FLOW-SCRIPTED via POST …/config (the status read
// rides the relay here — unlike sideshift there is no keyless device-direct read to stub
// in-page).

/// Counters + scripted state (the repo's process-global static idiom: every flow gets a
/// fresh relay process, so counters start at zero per flow).
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_KEY_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_BARE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_RATE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_TRADE_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_STATUS_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_LAST_QUERY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// The last NEW_TRADE query specifically — status polls overwrite the generic slot within
/// seconds of a confirm, and the e2e audit reads the TRADE's own query string (the refund
/// address ride) long after. (Flow 198.)
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_LAST_TRADE_QUERY: std::sync::Mutex<Option<String>> =
    std::sync::Mutex::new(None);
/// The scripted trade status (default the venue's waiting word) + settle figures.
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_STATE: std::sync::Mutex<(String, String, Option<String>)> =
    std::sync::Mutex::new((String::new(), String::new(), None));
/// Arm the LISTED-BUT-UNQUOTED verdict on the rate stub (flow 207): `new_rate` answers the
/// venue's own 400 body — `{"error":"no resulting quote"}`, the exact text the adapter's
/// client detects (live-measured 2026-09-22; the /coins row still lists the pair).
#[cfg(feature = "test-helpers")]
static TROCADOR_STUB_NO_QUOTE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Record one stub hit: key-bearing vs bare + the last query string (the audit reads it).
#[cfg(feature = "test-helpers")]
fn trocador_stub_record(headers: &axum::http::HeaderMap, query: &str) {
    use std::sync::atomic::Ordering;
    if headers.contains_key("API-Key") {
        TROCADOR_STUB_KEY_CALLS.fetch_add(1, Ordering::Relaxed);
    } else {
        TROCADOR_STUB_BARE_CALLS.fetch_add(1, Ordering::Relaxed);
    }
    *TROCADOR_STUB_LAST_QUERY.lock().unwrap() = Some(query.to_string());
}

/// `GET /api/v1/test/trocador-upstream/new_rate` — the venue's rate shape (one quote, the
/// aggregator's own pick — the stub serves ONE).
#[cfg(feature = "test-helpers")]
async fn trocador_stub_new_rate(
    headers: axum::http::HeaderMap,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    use std::sync::atomic::Ordering;
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    trocador_stub_record(&headers, &query);
    TROCADOR_STUB_RATE_CALLS.fetch_add(1, Ordering::Relaxed);
    if TROCADOR_STUB_NO_QUOTE.load(Ordering::Relaxed) {
        // The venue's own listed-but-unquoted answer, VERBATIM (module doc): a 400 whose
        // body names the coverage state — what the real venue answered for ICP markets on
        // 2026-09-22 while the pair sat listed on /coins.
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "no resulting quote" })),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "trade_id": "stub-rate-1",
            "date": "2026-09-20 12:00:00",
            "ticker_from": params.get("ticker_from").cloned().unwrap_or_default(),
            "ticker_to": params.get("ticker_to").cloned().unwrap_or_default(),
            "network_from": params.get("network_from").cloned().unwrap_or_default(),
            "network_to": params.get("network_to").cloned().unwrap_or_default(),
            "amount_from": params.get("amount_from").cloned().unwrap_or_default(),
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "fixed": true,
            "status": "Waiting",
            "min_kycrating": params.get("min_kycrating").cloned().unwrap_or_default(),
            "quotes": [],
            "payment": false,
        })),
    )
        .into_response()
}

/// `GET /api/v1/test/trocador-upstream/new_trade` — the venue's trade shape: the record
/// carries the VENUE's own deposit address (`address_provider`) + the user's echoed
/// refund.
#[cfg(feature = "test-helpers")]
async fn trocador_stub_new_trade(
    headers: axum::http::HeaderMap,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    use std::sync::atomic::Ordering;
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    trocador_stub_record(&headers, &query);
    *TROCADOR_STUB_LAST_TRADE_QUERY.lock().unwrap() = Some(query.clone());
    TROCADOR_STUB_TRADE_CALLS.fetch_add(1, Ordering::Relaxed);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "trade_id": "stub-trade-1",
            "date": "2026-09-20 12:00:00",
            "ticker_from": params.get("ticker_from").cloned().unwrap_or_default(),
            "ticker_to": params.get("ticker_to").cloned().unwrap_or_default(),
            "network_from": params.get("network_from").cloned().unwrap_or_default(),
            "network_to": params.get("network_to").cloned().unwrap_or_default(),
            "amount_from": params.get("amount_from").cloned().unwrap_or_default(),
            "amount_to": "0.0496",
            "provider": params.get("provider").cloned().unwrap_or_default(),
            "fixed": true,
            "status": "Waiting",
            "address_provider": "e2e-trocador-deposit-01",
            "address_provider_memo": null,
            "address_user": params.get("address").cloned().unwrap_or_default(),
            "refund_address": params.get("refund").cloned().unwrap_or_default(),
            "id_provider": "stub-provider-id-1",
            "payment": false,
        })),
    )
        .into_response()
}

/// `GET /api/v1/test/trocador-upstream/trade?id=` — the venue's status shape, scripted by
/// the flow (status word, settle amount, payout hash).
#[cfg(feature = "test-helpers")]
async fn trocador_stub_trade_status(
    headers: axum::http::HeaderMap,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    use std::sync::atomic::Ordering;
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    trocador_stub_record(&headers, &query);
    TROCADOR_STUB_STATUS_CALLS.fetch_add(1, Ordering::Relaxed);
    let (status, amount_to, hashout) = TROCADOR_STUB_STATE.lock().unwrap().clone();
    let mut body = serde_json::json!({
        "trade_id": params.get("id").cloned().unwrap_or_default(),
        "status": status,
        "amount_from": "2",
        "amount_to": amount_to,
        "provider": "StubSwap",
        "fixed": true,
        "address_user": "e2e-settle-address",
    });
    if let Some(hash) = hashout {
        body["details"] = serde_json::json!({ "hashout": hash });
    }
    (StatusCode::OK, Json(body)).into_response()
}

/// `POST /api/v1/test/trocador-upstream/config` — arm the scripted lifecycle: `{"status":
/// "Waiting"|"processing-word"|…, "amount_to"?: "<decimal>", "hashout"?: "<tx id>"}`.
#[cfg(feature = "test-helpers")]
async fn trocador_stub_config(body: axum::body::Bytes) -> Response {
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({}));
    let mut state = TROCADOR_STUB_STATE.lock().unwrap();
    if let Some(s) = v.get("status").and_then(|x| x.as_str()) {
        state.0 = s.to_string();
    }
    if let Some(a) = v.get("amount_to").and_then(|x| x.as_str()) {
        state.1 = a.to_string();
    }
    state.2 = v
        .get("hashout")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    drop(state);
    if let Some(nq) = v.get("no_quote").and_then(|x| x.as_bool()) {
        TROCADOR_STUB_NO_QUOTE.store(nq, std::sync::atomic::Ordering::Relaxed);
    }
    StatusCode::OK.into_response()
}

/// `GET /api/v1/test/trocador-upstream/hits` — how many key-bearing vs bare calls the
/// stub has served (bare should stay ZERO for every flow: the proxy always attaches the
/// key — a bare hit means a path reached the stub without the relay's credential), plus
/// per-route counts (rate/trade/status) so the flow can prove a trade was NEVER
/// re-created across a reload while quotes and status reads legitimately re-fetch.
#[cfg(feature = "test-helpers")]
async fn trocador_stub_hits() -> Response {
    use std::sync::atomic::Ordering;
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "keyCalls": TROCADOR_STUB_KEY_CALLS.load(Ordering::Relaxed),
            "bareCalls": TROCADOR_STUB_BARE_CALLS.load(Ordering::Relaxed),
            "rateCalls": TROCADOR_STUB_RATE_CALLS.load(Ordering::Relaxed),
            "tradeCalls": TROCADOR_STUB_TRADE_CALLS.load(Ordering::Relaxed),
            "statusCalls": TROCADOR_STUB_STATUS_CALLS.load(Ordering::Relaxed),
            "lastQuery": TROCADOR_STUB_LAST_QUERY.lock().unwrap().clone(),
            "lastTradeQuery": TROCADOR_STUB_LAST_TRADE_QUERY.lock().unwrap().clone(),
        })),
    )
        .into_response()
}

// --- test-only JUPITER upstream (the keyless venue's offline stand-in) ---------------------------
//
// The lite-api wire shapes the app's client actually reads (verified live 2026-09-14,
// docs/specs/2026-09-14-swap-venue-feasibility.md): GET /swap/v1/quote answers 200 with
// {inputMint, outputMint, inAmount, outAmount, otherAmountThreshold, priceImpact, slippageBps,
// platformFee}; POST /swap/v1/swap answers 200 with {swapTransaction: <base64>,
// lastValidBlockHeight}. The stub ECHOES the request's own params where the real venue does
// (inputMint/outputMint/inAmount/slippageBps) and serves the quote figures the flow
// configured, so the app's shape validation and the flow's UI assertions run against exactly
// the field names the real venue uses. State is process-global statics (the repo's stub
// idiom): every flow gets a fresh relay process, so counters start at zero per flow.
//
// `unexpected` stays an ALWAYS-EMPTY array only to keep the old page-stub state shape — the
// stray-device-direct-dial watch it used to own is structural now (the app has no
// device-direct Jupiter path left to go stray; jest pins that).

/// The canned quote figures + swap-tx answer a flow arms via `POST …/config`.
#[cfg(feature = "test-helpers")]
struct JupiterStubConfig {
    out_amount: String,
    other_amount_threshold: String,
    price_impact: Option<String>,
    user_public_key: String,
    tx_b64: String,
    last_valid_block_height: u64,
}

#[cfg(feature = "test-helpers")]
static JUPITER_STUB_CONFIG: std::sync::Mutex<Option<JupiterStubConfig>> =
    std::sync::Mutex::new(None);
/// Every quote arrival, in order — {inputMint, outputMint, amount, slippageBps} (raw query
/// strings, exactly what the app sent). This is the flow's proof the quote went THROUGH the
/// relay's proxy, and (with the proxy's own cache upstream of here) that identical quotes
/// within the TTL share one upstream call.
#[cfg(feature = "test-helpers")]
static JUPITER_STUB_QUOTE_CALLS: std::sync::Mutex<Vec<serde_json::Value>> =
    std::sync::Mutex::new(Vec::new());
/// Every swap arrival, in order — {userPublicKey, wrapAndUnwrapSol, asLegacyTransaction}.
#[cfg(feature = "test-helpers")]
static JUPITER_STUB_SWAP_CALLS: std::sync::Mutex<Vec<serde_json::Value>> =
    std::sync::Mutex::new(Vec::new());
/// The quoteResponse object the app posted back with its LAST swap build (the flow pins
/// that the device round-trips Jupiter's own quote verbatim).
#[cfg(feature = "test-helpers")]
static JUPITER_STUB_LAST_QUOTE_RESPONSE: std::sync::Mutex<Option<serde_json::Value>> =
    std::sync::Mutex::new(None);
/// Set when a swap arrived whose userPublicKey differs from the configured one (an app bug
/// the flow asserts absent — the page stub's userMismatch role).
#[cfg(feature = "test-helpers")]
static JUPITER_STUB_USER_MISMATCH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// `POST /api/v1/test/jupiter-upstream/config` `{quote: {outAmount, otherAmountThreshold,
/// priceImpact?}, userPublicKey, txB64, lastValidBlockHeight}` → `{ok: true}` — arm the
/// canned answers. Required before the stub serves anything: an unconfigured stub answers
/// 503 rather than inventing a quote.
#[cfg(feature = "test-helpers")]
async fn jupiter_stub_configure(Json(req): Json<serde_json::Value>) -> Response {
    let Some(quote) = req.get("quote") else {
        return err(StatusCode::BAD_REQUEST, "stub config needs `quote`");
    };
    let (Some(out_amount), Some(threshold)) = (
        quote.get("outAmount").and_then(|v| v.as_str()),
        quote.get("otherAmountThreshold").and_then(|v| v.as_str()),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "stub config quote needs string outAmount + otherAmountThreshold",
        );
    };
    let Some(user_public_key) = req.get("userPublicKey").and_then(|v| v.as_str()) else {
        return err(StatusCode::BAD_REQUEST, "stub config needs userPublicKey");
    };
    let Some(tx_b64) = req.get("txB64").and_then(|v| v.as_str()) else {
        return err(StatusCode::BAD_REQUEST, "stub config needs txB64");
    };
    let Some(height) = req.get("lastValidBlockHeight").and_then(|v| v.as_u64()) else {
        return err(StatusCode::BAD_REQUEST, "stub config needs lastValidBlockHeight");
    };
    *JUPITER_STUB_CONFIG.lock().unwrap_or_else(|p| p.into_inner()) = Some(JupiterStubConfig {
        out_amount: out_amount.to_string(),
        other_amount_threshold: threshold.to_string(),
        price_impact: quote
            .get("priceImpact")
            .and_then(|v| v.as_str())
            .map(str::to_owned),
        user_public_key: user_public_key.to_string(),
        tx_b64: tx_b64.to_string(),
        last_valid_block_height: height,
    });
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// `GET /api/v1/test/jupiter-upstream/swap/v1/quote` — the venue's quote shape, echoing the
/// request's own params. The proxy hands us the CANONICAL (sorted) query, so parse pairs by
/// name; percent-encoding is a no-op for mints (base58) and digit amounts.
#[cfg(feature = "test-helpers")]
async fn jupiter_stub_quote(axum::extract::RawQuery(raw): axum::extract::RawQuery) -> Response {
    let params: Vec<(String, String)> = raw
        .unwrap_or_default()
        .split('&')
        .filter_map(|pair| pair.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
        .collect();
    let get = |name: &str| {
        params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let record = serde_json::json!({
        "atMs": crate::now_millis(),
        "inputMint": get("inputMint").unwrap_or_default(),
        "outputMint": get("outputMint").unwrap_or_default(),
        "amount": get("amount").unwrap_or_default(),
        "slippageBps": get("slippageBps").unwrap_or_default(),
    });
    JUPITER_STUB_QUOTE_CALLS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(record);

    let cfg = JUPITER_STUB_CONFIG.lock().unwrap_or_else(|p| p.into_inner());
    let Some(cfg) = cfg.as_ref() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "stub upstream not configured: POST /api/v1/test/jupiter-upstream/config first",
        );
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "inputMint": get("inputMint").unwrap_or_default(),
            "outputMint": get("outputMint").unwrap_or_default(),
            "inAmount": get("amount").unwrap_or_default(),
            "outAmount": cfg.out_amount,
            "otherAmountThreshold": cfg.other_amount_threshold,
            "priceImpact": cfg.price_impact,
            "slippageBps": get("slippageBps").and_then(|v| v.parse::<u64>().ok()),
            "platformFee": serde_json::Value::Null,
        })),
    )
        .into_response()
}

/// `POST /api/v1/test/jupiter-upstream/swap/v1/swap` — the venue's swap-tx shape, bound to
/// the configured answer. Records what the app posted (the quoteResponse round-trip pin)
/// and flags a userPublicKey mismatch against the configured one.
#[cfg(feature = "test-helpers")]
async fn jupiter_stub_swap(body: axum::body::Bytes) -> Response {
    let req: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return err(StatusCode::BAD_REQUEST, "stub upstream: body is not JSON"),
    };
    JUPITER_STUB_SWAP_CALLS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(serde_json::json!({
            "atMs": crate::now_millis(),
            "userPublicKey": req.get("userPublicKey").cloned().unwrap_or(serde_json::Value::Null),
            "wrapAndUnwrapSol": req.get("wrapAndUnwrapSol").cloned().unwrap_or(serde_json::Value::Null),
            "asLegacyTransaction": req.get("asLegacyTransaction").cloned().unwrap_or(serde_json::Value::Null),
        }));
    if let Some(qr) = req.get("quoteResponse") {
        *JUPITER_STUB_LAST_QUOTE_RESPONSE
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(qr.clone());
    }
    let cfg = JUPITER_STUB_CONFIG.lock().unwrap_or_else(|p| p.into_inner());
    let Some(cfg) = cfg.as_ref() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "stub upstream not configured: POST /api/v1/test/jupiter-upstream/config first",
        );
    };
    let user = req.get("userPublicKey").and_then(|v| v.as_str()).unwrap_or("");
    if user != cfg.user_public_key {
        *JUPITER_STUB_USER_MISMATCH.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(format!("{user} != {}", cfg.user_public_key));
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "swapTransaction": cfg.tx_b64,
            "lastValidBlockHeight": cfg.last_valid_block_height,
        })),
    )
        .into_response()
}

/// `GET /api/v1/test/jupiter-upstream/hits` — every arrival, for the flows' assertions:
/// quoteCalls/swapCalls (in order), the last posted quoteResponse, any userPublicKey
/// mismatch, and `unexpected` (always empty — see the section comment).
#[cfg(feature = "test-helpers")]
async fn jupiter_stub_hits() -> Response {
    let quote_calls = JUPITER_STUB_QUOTE_CALLS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let swap_calls = JUPITER_STUB_SWAP_CALLS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let last_quote_response = JUPITER_STUB_LAST_QUOTE_RESPONSE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let user_mismatch = JUPITER_STUB_USER_MISMATCH
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "quoteCalls": quote_calls,
            "swapCalls": swap_calls,
            "lastQuoteResponse": last_quote_response,
            "userMismatch": user_mismatch,
            "unexpected": [],
        })),
    )
        .into_response()
}

#[cfg(all(test, feature = "test-helpers"))]
mod solana_stub_tests {
    use super::solana_stub_bs58_decode;

    #[test]
    fn bs58_all_ones_decode_to_zero_bytes() {
        // A system-program address ('111…1') is 32 leading zeros — the identity edge of the
        // alphabet's leading-'1' rule.
        assert_eq!(
            solana_stub_bs58_decode("11111111111111111111111111111111").unwrap(),
            vec![0u8; 32]
        );
    }

    #[test]
    fn bs58_decodes_a_real_mainnet_mint_to_exact_bytes() {
        // USDC's mainnet mint (app/solana/tokens.ts) — the exact string the app plants in the
        // address list and re-encodes from the blob during decode. Byte-VALUE equality, not just
        // length: the stub plants these bytes at every token account's mint offset, so a decoder
        // returning any OTHER 32 bytes would pass a len()==32 check while silently corrupting
        // every planted account. Expected bytes decoded with the reference implementation
        // (app/node_modules/bs58) — an independent oracle, not this decoder re-reading itself.
        assert_eq!(
            solana_stub_bs58_decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap(),
            vec![
                198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177,
                187, 228, 194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
            ]
        );
    }

    #[test]
    fn bs58_rejects_non_alphabet_chars() {
        assert!(solana_stub_bs58_decode("0OIl").is_none());
    }
}

/// The direction rule for `GET /api/v1/swap_quote`, shared by both builds and PURE: given what
/// the pool said about ITSELF, which way is this trade? `zero_for_one = token_in == token0` —
/// exactly the wallet-side convention (`zeroForOne: pool.token0.address === token_in`) and
/// exactly what the pool means by the flag in the arg the user's device signs.
///
/// The pair is NOT a relay constant. It is read off the venue on every quote
/// ([`crate::ledger::api::Ledger::swap_pool_metadata`]) precisely because the 2026-09-07 build
/// pinned it, pinned it BACKWARDS, and seeded the offline fake from the same pin — so the tests
/// agreed with the pin instead of with the venue while production quoted each direction under
/// the other direction's label. The refusal: 400 `unsupported_pair` when `{token_in, token_out}`
/// is not this pool's pair (which also covers token_in == token_out).
#[cfg(any(feature = "agent", feature = "test-helpers"))]
fn swap_quote_direction(
    meta: &crate::ledger::api::SwapPoolMetadata,
    token_in: &str,
    token_out: &str,
) -> Result<bool, Response> {
    if token_in == meta.token0_ledger && token_out == meta.token1_ledger {
        Ok(true)
    } else if token_in == meta.token1_ledger && token_out == meta.token0_ledger {
        Ok(false)
    } else {
        Err(err(StatusCode::BAD_REQUEST, "unsupported_pair"))
    }
}

/// `GET /api/v1/swap_quote?pool=<id>&token_in=<ledger>&token_out=<ledger>&amount_in=<e8s>` —
/// see the route comment above for the fixed contract. This build reads the fake-IC stub pool
/// (the offline e2e image): it asks the STUB for its own metadata and runs the same
/// [`swap_quote_direction`] rule the agent build runs on the live pool's reply, so the offline
/// loop exercises the direction logic instead of agreeing with a constant. The reply echoes the
/// attributed [`VenueQuote`] (multi-venue readiness V7) — amount_out off that pool's curve, the
/// pool's OWN fee tier, `fetched_at` — plus the `venue_id` the pool resolves to.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
async fn swap_quote_fake(
    State(state): State<AppState>,
    Query(qs): Query<SwapQuoteQuery>,
) -> Response {
    // The allowlist IS the venue resolution: one lookup both refuses unknown pools and gives
    // the quote its `venue_id` attribution.
    let Some(venue) = crate::catalog::venue_of_endpoint(&qs.pool) else {
        return err(StatusCode::BAD_REQUEST, "unknown_pool");
    };
    let Some(fake) = state.fake_ic.clone() else {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "fake-IC gateway not attached",
        );
    };
    let Some(meta) = fake.swap_pool_metadata(&qs.pool) else {
        return err(StatusCode::BAD_REQUEST, "unknown_pool");
    };
    let zero_for_one = match swap_quote_direction(&meta, &qs.token_in, &qs.token_out) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let Some(quote) = fake.swap_pool_quote(&qs.pool, zero_for_one, u128::from(qs.amount_in.0))
    else {
        return err(StatusCode::BAD_REQUEST, "unknown_pool");
    };
    (
        StatusCode::OK,
        Json(SwapQuoteBody {
            venue_id: venue.venue_id.to_string(),
            pool: quote.pool,
            token_in: qs.token_in,
            token_out: qs.token_out,
            amount_in: qs.amount_in,
            amount_out: U64String(u64::try_from(quote.amount_out).unwrap_or(u64::MAX)),
            zero_for_one: quote.zero_for_one,
            fee_millionths: quote.fee_millionths,
            fetched_at: quote.fetched_at,
        }),
    )
        .into_response()
}
/// `GET /api/v1/swap_quote` — the production branch (agent build; also the owner when
/// test-helpers is co-enabled for the live tests): reads the REAL pool's OWN `metadata` to
/// learn its pair order and fee tier, derives the direction from that, then queries the pool's
/// own `quote` (`AgentLedger`, anonymous reads) and passes its amountOut through VERBATIM. The
/// pool's own `#err` text surfaces verbatim at 422 (the house convention), transport trouble at
/// 503.
#[cfg(feature = "agent")]
async fn swap_quote_agent(
    State(state): State<AppState>,
    Query(qs): Query<SwapQuoteQuery>,
) -> Response {
    // The allowlist IS the venue resolution: one lookup both refuses unknown pools and gives
    // the quote its `venue_id` attribution.
    let Some(venue) = crate::catalog::venue_of_endpoint(&qs.pool) else {
        return err(StatusCode::BAD_REQUEST, "unknown_pool");
    };
    let meta = match state.ledger.swap_pool_metadata(&qs.pool).await {
        Ok(m) => m,
        Err(LedgerError::Rejected(msg)) => return err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("ledger unavailable: {msg}"),
            )
        }
    };
    let zero_for_one = match swap_quote_direction(&meta, &qs.token_in, &qs.token_out) {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    match state
        .ledger
        .swap_pool_quote(&qs.pool, zero_for_one, u128::from(qs.amount_in.0))
        .await
    {
        Ok(quote) => (
            StatusCode::OK,
            Json(SwapQuoteBody {
                venue_id: venue.venue_id.to_string(),
                pool: quote.pool,
                token_in: qs.token_in,
                token_out: qs.token_out,
                amount_in: qs.amount_in,
                amount_out: U64String(u64::try_from(quote.amount_out).unwrap_or(u64::MAX)),
                zero_for_one: quote.zero_for_one,
                fee_millionths: quote.fee_millionths,
                fetched_at: quote.fetched_at,
            }),
        )
            .into_response(),
        Err(LedgerError::Rejected(msg)) => err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("ledger unavailable: {msg}"),
        ),
    }
}

/// Per-currency balance-query timeout for the batch endpoint. Bounds a SINGLE ledger query inside
/// [`balances`]; the whole batch completes within ~this (the queries fan out concurrently via
/// `join_all`, so the batch wall-clock ≈ the slowest single query, not the sum). Generous enough for
/// a real IC query (a query read or a cold-start `refresh_balances` update: 1–5s observed), short
/// enough that a fully-hung ledger can't stall the response. The app's own HTTP timeout
/// (BALANCE_TIMEOUT_MS = 4s) is the tighter user-facing bound — it will abort the app→relay fetch
/// first in the slow case; this is the relay's own safety net against a wedged ledger so the route
/// never hangs indefinitely.
const BALANCE_BATCH_QUERY_TIMEOUT: Duration = Duration::from_secs(5);

/// `GET /api/v1/balances/{hex}` (note the PLURAL) → `{"<currency>": "<minor units>", ...}` mapping
/// EVERY currency in the catalog to its balance string, in ONE response. Replaces the wallet's old
/// N+1 poll (1 primary fetch + 1 per-asset fetch, each a relay→IC round trip) with a SINGLE fetch —
/// with 6 production currencies that's 1 HTTP request instead of 6 sequential-ish round trips.
///
/// Internally fans one DIRECT `icrc1_balance_of` query per catalog ledger out CONCURRENTLY
/// (`futures_util::join_all`), each under its own `BALANCE_BATCH_QUERY_TIMEOUT`, so a slow/hung
/// ledger for ONE currency can't stall the rest — best-effort per currency, matching the old
/// per-asset poll's "a hiccup on one asset's ledger never flips the primary offline" guarantee. A
/// currency whose query errors or times out is OMITTED from the map (the wallet keeps its prior
/// value for that currency) and logged here (no silent errors). The catalog itself is compiled
/// into [`crate::catalog`] — there is no catalog fetch that could fail. Each query is a free read
/// DIRECTLY on the currency's ledger (no facade hop, no consensus, no cache), so the batch is
/// always-live at near-zero cost.
///
/// Response shape (flat map, currency index string → minor-units decimal string): the JSON object
/// keys are serde-serialized currency indices as decimal strings, e.g. `{"0":"5000","1":"0",...}`.
async fn balances(State(state): State<AppState>, Path(hex_pk): Path<String>) -> Response {
    let pk = ok_or_bail!(parse_pubkey_hex(&hex_pk));

    // Enumerate the compiled catalog (the source of truth for which currencies exist) — no
    // ledger round trip, no failure mode (the facade registry is gone; founder 2026-08-28).
    let catalog = ic_rows();

    // IC-rail cutover (test-helpers): with the fake-IC gateway attached, balances live in the
    // gateway's PRINCIPAL-keyed ledgers — the app's pubkey maps to the same self_authenticating
    // principal a signed icrc1_transfer would move. One snapshot under the gateway lock; no fan-out.
    #[cfg(feature = "test-helpers")]
    if let Some(fake) = state.fake_ic.clone() {
        use dpay_icp::principal::Principal as IcpPrincipal;
        let owner = IcpPrincipal::self_authenticating_ed25519(&pk);
        let account = dpay_icp::principal::Account::new(owner);
        let map = fake.balances_of(&catalog, &account);
        return (StatusCode::OK, Json(map)).into_response();
    }

    // Fan out one balance query per catalog currency, each under its own timeout. `join_all` polls
    // them concurrently (one relay→ledger round trip each, in flight together) so the batch returns
    // in ~the slowest query, not the sum. A per-currency timeout preserves the old per-asset
    // best-effort semantics: one wedged ledger is dropped (omitted + logged), the rest still answer.
    let futs = catalog.iter().map(|d| {
        let ledger = state.ledger.clone();
        let currency = d.currency;
        let ledger_text = d.ledger.clone();
        async move {
            // Query each ledger DIRECTLY (`icrc1_balance_of`) — free, always-live, no facade hop
            // (the catalog already carries each ledger's Principal as text). A non-IC ledger impl
            // (FakeLedger in tests) ignores `ledger_text` via the trait default → `balance()`.
            let res = tokio::time::timeout(
                BALANCE_BATCH_QUERY_TIMEOUT,
                ledger.balance_on_ledger(&ledger_text, pk, currency),
            )
            .await;
            (currency, res)
        }
    });
    let results = futures_util::future::join_all(futs).await;

    // Collect into a BTreeMap so the keys serialize in stable, ascending order (0,1,2,…), matching
    // the documented shape and keeping test fixtures + relay logs deterministic. A successful query
    // inserts; an erroring/timed-out query is omitted (best-effort) and logged — never silent.
    let mut map: std::collections::BTreeMap<String, U64String> = std::collections::BTreeMap::new();
    for (currency, res) in results {
        match res {
            Ok(Ok(bal)) => {
                map.insert(currency.to_string(), U64String(bal));
            }
            Ok(Err(e)) => {
                eprintln!("dpay-relay: balances: currency {currency} query failed: {e}");
            }
            Err(_) => {
                eprintln!(
                    "dpay-relay: balances: currency {currency} query timed out after {}ms",
                    BALANCE_BATCH_QUERY_TIMEOUT.as_millis(),
                );
            }
        }
    }

    // Balances are now read DIRECTLY off each ledger (icrc1_balance_of, above) — free + always-live,
    // so there is no facade cache to refresh and no background update to fire. The facade's
    // `BAL_CACHE`/`refresh_balances` are simply unused on the read path (left in place on the
    // canister; harmless — the relay no longer calls them).

    (StatusCode::OK, Json(map)).into_response()
}

/// `GET /api/v1/transactions/{hex}?currency=N&limit=30&memo=HEX` → newest-first rows.
/// Lets the wallet render a durable transaction list sourced from the ledger (the in-memory UI list
/// is gone on restart; this is the source of truth). `limit` defaults to 30 and is capped at 100.
async fn transactions(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<TransactionsQuery>,
) -> Response {
    let pk = ok_or_bail!(parse_pubkey_hex(&hex_pk));
    let currency = qs.currency.unwrap_or(DEMO_USD);
    let limit = qs.limit.unwrap_or(30).min(100);
    let memo = match qs.memo.as_deref() {
        Some(m) if m.len() == 32 && m.bytes().all(|b| b.is_ascii_hexdigit()) => Some(m),
        Some(_) => {
            return err(
                StatusCode::BAD_REQUEST,
                "memo must be exactly 32 hex characters",
            )
        }
        None => None,
    };
    // With the fake-IC gateway attached (test-helpers), history reads the gateway's principal-keyed
    // txn log — the same records signed transfers append. Prod reads `transactions_on_ledger` off
    // the `dyn Ledger`, which walks the ICRC ledger's own transaction log (icrc3) at the user's
    // principal — see `AgentLedger::transactions_on_ledger`.
    #[cfg(feature = "test-helpers")]
    if let Some(fake) = state.fake_ic.clone() {
        use dpay_icp::principal::Principal as IcpPrincipal;
        let owner = IcpPrincipal::self_authenticating_ed25519(&pk);
        let rows = fake.transactions(&owner, currency, limit as usize, memo);
        return (
            StatusCode::OK,
            Json(TransactionsBody { transactions: rows }),
        )
            .into_response();
    }
    // History needs the currency's LEDGER principal — resolve it from the compiled catalog (the
    // same source /balances fans out over), then walk that ledger's own transaction log.
    let catalog = ic_rows();
    let Some(desc) = catalog.iter().find(|d| d.currency == currency) else {
        return err(
            StatusCode::BAD_REQUEST,
            format!("unknown currency {currency}"),
        );
    };
    match state
        .ledger
        .transactions_on_ledger(&desc.ledger, pk, currency, limit, memo)
        .await
    {
        Ok(rows) => (
            StatusCode::OK,
            Json(TransactionsBody { transactions: rows }),
        )
            .into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /api/v1/deposit/info?currency=N` → `200 {"min_confirmations":N,"deposit_fee":N,
/// "deposit_min_amount":N|null}`. Static deposit instructions for the wallet's "Add money" sheet
/// (proxies the facade → ck minter `get_minter_info` + `get_deposit_fee`). Any ledger error → `503`
/// (deposit plan §0).
async fn deposit_info(State(state): State<AppState>, Query(qs): Query<BalanceQuery>) -> Response {
    let currency = qs.currency.unwrap_or(DEMO_USD);
    match state.ledger.deposit_info(currency).await {
        Ok(i) => (
            StatusCode::OK,
            Json(DepositInfoBody {
                min_confirmations: i.min_confirmations,
                deposit_fee: i.deposit_fee,
                deposit_min_amount: i.deposit_min_amount,
            }),
        )
            .into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /api/v1/currencies` → `200 {"networks":[...]}` — the network-first asset catalog (v2):
/// exactly five sections in order (icp mainnet, icp testnet, solana mainnet, evm Arbitrum One
/// mainnet, evm Ethereum mainnet; plus the env-gated dev evm sections last). INFALLIBLE: the
/// catalog is compiled into [`crate::catalog`] (the sole authority — founder decision
/// 2026-08-28; the facade registry was removed), so this handler has no ledger call and no
/// failure mode. No query params; unauthenticated (catalog only — no balances).
async fn currencies() -> Response {
    (StatusCode::OK, Json(currencies_body())).into_response()
}

/// `GET /api/v1/venues` → `200 {"venues": [...]}` — the QUERY-ONLY venue registry
/// (multi-venue readiness V4/V5): identity, kind, endpoint and pair for every REAL conversion
/// venue, plus — ONLY in the offline test build — any `test_helpers_served` fixture venue
/// whose `/test/venue` knob is armed (the two-venue chooser tests; the agent/prod build has
/// no knob and structurally serves the real registry alone — `catalog::venue_servable`).
/// Query-only in both directions: the relay serves venue FACTS here, but never reads them as
/// inputs — the pair ORDER and fee tier are always read off the venue itself at quote time,
/// never out of this table. The fee tier is deliberately absent: the venue's own quote echoes
/// it. ROW ORDER is the compiled registry's own order — stable and quote-independent; the
/// app's chooser renders it verbatim and never ranks. (One demotion exception, 2026-09-20: a
/// venue whose last measured settlement blew the 30-minute SLA — `dfx/venue_health.json`,
/// verdict from `catalog::settlement_verdict` — is flagged on its row and moved to the TAIL
/// until a passing probe run clears it; `catalog::degraded_last` keeps both groups' order.)
#[cfg(any(feature = "agent", feature = "test-helpers"))]
async fn venues(State(state): State<AppState>) -> Response {
    let rows: Vec<VenueBody> = crate::catalog::venues()
        .into_iter()
        .filter(|v| crate::catalog::venue_servable(v, fixture_venue_armed(&state, v)))
        .map(|v| {
            let health = crate::catalog::venue_health(v.venue_id).map(|h| VenueHealthBody {
                status: h.status.to_string(),
                settle_seconds: h.settle_seconds,
                measured_at: h.measured_at,
            });
            VenueBody {
                venue_id: v.venue_id.to_string(),
                display_name: v.display_name.to_string(),
                kind: match v.kind {
                    crate::catalog::VenueKind::IcAmm => "ic_amm".to_string(),
                    crate::catalog::VenueKind::Cefi => "cefi".to_string(),
                    crate::catalog::VenueKind::SolanaAmm => "solana_amm".to_string(),
                },
                endpoint: v.endpoint.to_string(),
                pair_ledgers: v.pair_ledgers.iter().map(|p| p.to_string()).collect(),
                testnet: v.testnet,
                disclosure_key: v.disclosure_key.to_string(),
                health,
            }
        })
        .collect();
    let body = VenuesBody {
        venues: crate::catalog::degraded_last(rows, |v| {
            v.health.as_ref().is_some_and(|h| h.status == "degraded")
        }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// Is this fixture venue's serving knob armed? In the OFFLINE test build: ask the attached
/// gateway. In the AGENT builds (prod `--features agent`; also the agent+test-helpers live
/// tests): constant `false` — the knob route and the `FakeIc` state behind it are compiled
/// away there, so an armed knob can never leak a fixture venue into a served list.
///
/// The fallback below is gated `agent` — deliberately NOT as the complement of the primary
/// variant's cfg. A fallback's cfg is "everywhere the caller exists minus everywhere the
/// primary does": the caller (`venues`) is `any(agent, test-helpers)`, the primary is
/// `all(test-helpers, not(agent))`, and the difference is exactly `agent`. The complement
/// (`not(all(test-helpers, not(agent)))`) wrongly included the DEFAULT no-features build,
/// where neither the caller, the route, this fn, nor `catalog::VenueEntry` itself is compiled
/// — that dangling type reference broke the lean build (`scripts/stage-relay-probe.sh` under
/// `just apk`, the only default-features consumer) on 2026-09-11 while every feature-carrying
/// gate stayed green.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
fn fixture_venue_armed(state: &AppState, v: &crate::catalog::VenueEntry) -> bool {
    state
        .fake_ic
        .as_ref()
        .is_some_and(|f| f.venue_served(v.venue_id))
}
#[cfg(feature = "agent")]
fn fixture_venue_armed(_state: &AppState, _v: &crate::catalog::VenueEntry) -> bool {
    false
}

/// `GET /api/v1/onramp/ckerc20?currency=N` → `200 {"helper_address","erc20_address","kind"}`.
/// Surfaces the runtime parameters the app needs to build the user's Ethereum transaction(s) for a
/// CkEthErc20-family onramp. The deposit `principal` arg is the USER's own IC principal (derived
/// in-app from their key; ICRC-1 default subaccount) — the relay serves no principal. For an ERC-20
/// token (`kind="erc20"`, `erc20_address` set) the app builds two txs (approve + depositErc20); for
/// native ETH (`kind="native_eth"`, `erc20_address=null`) it builds ONE payable tx (depositEth, ETH
/// value in the tx). Only meaningful for CkEthErc20-family currencies (e.g. ckUSDC = currency 2,
/// native ckETH = a CkEthErc20 currency with token_contract null); a non-CkEthErc20 currency is a
/// `Transient` (no onramp configured) → 503. Error mapping: Rejected → 422, Transient → 503.
async fn ckerc20_onramp(State(state): State<AppState>, Query(qs): Query<CkErc20Query>) -> Response {
    let currency = qs.currency.unwrap_or(DEMO_USD);
    match state.ledger.ckerc20_onramp_params(currency).await {
        Ok(p) => (
            StatusCode::OK,
            Json(CkErc20OnrampBody {
                helper_address: p.helper_address,
                erc20_address: p.erc20_address,
                kind: p.kind,
            }),
        )
            .into_response(),
        Err(LedgerError::Rejected(msg)) => err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => err(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("ledger unavailable: {msg}"),
        ),
    }
}

/// The palette every static page paints from, generated from `app/config/palette.ts`
/// (`scripts/relay-palette-css.mjs`) and substituted for the `{{PALETTE}}` token below.
///
/// It is ONE block for FOUR pages because it used to be four hand-maintained copies of one fact,
/// which is how palette v5 shipped in the app and left the whole website on v4 — and how
/// checkout.html/checkout-code.html had already drifted off v4 before that. `app/__tests__/relay-palette.test.ts`
/// fails the moment the checked-in file stops matching the palette it claims to come from.
const PALETTE_CSS: &str = include_str!("../assets/palette.css");

/// Substitute the shared palette into one static page. Every HTML asset this relay serves goes
/// through it, so a page that forgets the token renders unstyled rather than half-styled — and the
/// `served_pages_carry_the_shared_palette` test asserts none of them does.
pub(crate) fn with_palette(html: &str) -> String {
    html.replace("{{PALETTE}}", PALETTE_CSS)
}

/// `GET /` — the marketing landing page. The `{{DOWNLOAD}}` placeholder becomes a live download CTA
/// when an APK is configured (via [`AppState::with_apk`]), or a "coming soon" chip otherwise.
async fn landing_page(State(state): State<AppState>) -> Response {
    let download = match state.apk.as_ref() {
        Some(bytes) => {
            // Round to the nearest whole megabyte, floored at 1 so a small build never reads "0 MB".
            let mb = ((bytes.len() + 524_288) / 1_048_576).max(1);
            let ver = &state.apk_version;
            format!(
                "<a class=\"btn\" href=\"/download/dpay.apk?v={ver}\" download>Download for Android\
                 <span class=\"apk-meta\">APK · {mb} MB</span></a>"
            )
        }
        None => "<span class=\"btn btn-disabled\">Android build coming soon</span>".to_string(),
    };
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        with_palette(include_str!("../assets/landing.html")).replace("{{DOWNLOAD}}", &download),
    )
        .into_response()
}

/// `GET /download/dpay.apk` — the configured Android build as an APK attachment, or `404` when none
/// is configured. Served with REVALIDATION semantics, not `immutable`: the old year-long max-age
/// let the Cloudflare edge pin a stale APK past every redeploy. A 5-minute `max-age` + a strong
/// ETag (the sha256 from [`AppState::with_apk`]) makes the CDN come back with cheap
/// `If-None-Match` revalidations (answered 304, bodyless), so a fresh build reaches users within
/// 5 minutes of a deploy.
async fn apk_download(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(bytes) = state.apk.as_ref() else {
        return (StatusCode::NOT_FOUND, "no build available").into_response();
    };
    let etag = format!("\"{}\"", state.apk_version);
    // A matching If-None-Match — an exact strong-etag match anywhere in the (possibly list-valued)
    // header, or `*` — short-circuits to a bodyless 304.
    // A non-text header value is treated as ABSENT (the client gets the full body, which is always
    // correct) and SAID so — the same shape `checkout.rs` uses for `Host`/`X-Forwarded-Proto`. Silently
    // dropping it would turn "this CDN sends a malformed validator" into a 56 MB re-download nobody
    // can explain.
    let not_modified = match headers.get(header::IF_NONE_MATCH).map(|v| v.to_str()) {
        Some(Ok(v)) => v.split(',').any(|t| {
            let t = t.trim();
            t == etag || t == "*"
        }),
        Some(Err(e)) => {
            eprintln!("dpay-relay: apk: If-None-Match is not text ({e}); serving the full build");
            false
        }
        None => false,
    };
    if not_modified {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, "public, max-age=300"),
                (header::ETAG, etag.as_str()),
            ],
        )
            .into_response();
    }
    let mut resp = (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                "application/vnd.android.package-archive",
            ),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"dpay.apk\"",
            ),
            (header::CACHE_CONTROL, "public, max-age=300"),
        ],
        bytes.clone(),
    )
        .into_response();
    // Inserted post-`into_response` because the tuple form needs uniform header-value types (the
    // etag is owned, the rest are `&'static str`). Strong (no `W/` prefix) by construction: a
    // given build's bytes never change, so a byte-identical revalidation can always skip the body.
    resp.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("quoted hex sha256 is always a valid header value"),
    );
    resp
}

/// `GET /merchant` — permanent redirect to `/wallet` (2026-08-16 merge). The hand-rolled merchant
/// terminal page is gone; its capabilities (build a request QR, poll for settlement, scan the
/// payer's signed QR / paste fallback) live in the REAL app's Receive tab served at `/wallet`.
/// A 308 keeps bookmarks + old share links working by landing on the one web surface.
async fn merchant_redirect() -> Response {
    (
        [(header::LOCATION, "/wallet")],
        StatusCode::PERMANENT_REDIRECT,
    )
        .into_response()
}

/// `GET /privacy` — the public privacy policy linked from Google Play, the app, and this website.
async fn privacy_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        with_palette(include_str!("../assets/privacy.html")),
    )
        .into_response()
}

/// `GET /wallet` — the REAL app (app/App.tsx) built for the web (react-native-web; every signing
/// path through the shared dpay-core wasm — the same core the APK and this relay use), embedded at
/// compile time from e2e/dist-prod. The hand-written wallet.html is gone; this page IS the app.
/// Served `no-cache` (the HTML references content-hashed assets, so freshness here is the only
/// lever needed — an over-cached HTML is exactly the APK-cache incident's class). The page's CSP
/// `<meta>` cannot carry `frame-ancestors` (browsers ignore it there — console error), so the
/// no-framing guarantee ships as a REAL response header on this route.
async fn wallet_page(headers: HeaderMap) -> Response {
    let mut resp = serve_dist_asset("/wallet", &headers);
    resp.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    resp
}

/// `GET /wallet/pay/{recipient}` — a shared PAYMENT LINK
/// (`/wallet/pay/<recipient>?asset=…&network=…&amount=…`). It serves the SAME wallet page: the
/// recipient/asset/amount live in the URL, and the app reads them off its own location and lands
/// the user on a pre-filled payment review. Nothing about the link is interpreted here — the relay
/// never sees a payment, and a link is not a request for one; only the payer's own wallet resolves
/// and signs it. The path segment is captured (not a wildcard) so a nested path 404s rather than
/// silently rendering the wallet with a recipient the app would then have to reject.
async fn wallet_pay_page(Path(_recipient): Path<String>, headers: HeaderMap) -> Response {
    wallet_page(headers).await
}

/// `GET /.well-known/assetlinks.json` — Android App Links (Digital Asset Links). This is what lets
/// `https://dpay.kalaj.org/wallet/pay/…` open the installed app instead of a browser tab: Android
/// fetches this file for the `autoVerify` intent-filter in AndroidManifest.xml and checks the
/// installed APK's signing certificate against the fingerprints below.
///
/// All FOUR of the project's certificates are listed, and each is here for a reason:
///   • deployment / hybrid-classical / hybrid-PQC — the Google-held Play App Signing keys, i.e.
///     every build a user installs from Play (see app/android/app/play-signing/README.md);
///   • upload — the founder-held key `just apk` signs sideloaded builds with, so the on-device
///     gate in this repo exercises the SAME App Link path a Play install takes rather than an
///     untested approximation.
/// Served `no-cache`: Android re-verifies on install/update, and a stale cached copy would silently
/// break link handling for a freshly-rotated certificate.
async fn assetlinks() -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        include_str!("../assets/assetlinks.json"),
    )
        .into_response()
}

/// `GET /assets/{path}` — the wallet build's content-hashed assets (immutable, cache-forever:
/// the hash IS the version). Unknown names are a clean 404; there is no catch-all.
async fn web_asset(Path(path): Path<String>, headers: HeaderMap) -> Response {
    serve_dist_asset(&format!("/assets/{path}"), &headers)
}

/// `GET /sw.js` — the wallet's service worker (`e2e/web/sw.js`, built with its precache manifest
/// baked in). Served from the ROOT so its scope covers both path prefixes the wallet spans,
/// `/wallet` and `/assets/`; `serve_dist_asset` gives it `no-cache`, which is what makes a deploy
/// reach an installed worker on the next navigation instead of whenever a cache decides.
async fn service_worker(headers: HeaderMap) -> Response {
    serve_dist_asset("/sw.js", &headers)
}

/// `GET /manifest.webmanifest` + `GET /icon-192.png` — the web app manifest the wallet page links
/// and the icon it names (the APK's own launcher icon, read from the Android res tree at build
/// time so the project has one icon rather than two).
async fn web_manifest(headers: HeaderMap) -> Response {
    serve_dist_asset("/manifest.webmanifest", &headers)
}
async fn web_icon(headers: HeaderMap) -> Response {
    serve_dist_asset("/icon-192.png", &headers)
}

/// Does this `Accept-Encoding` accept brotli? Token-exact and q-aware: `br;q=0` is a REFUSAL, and
/// `brotli` / `xbr` are not `br`. A client that does not ask gets the identity bytes — that is
/// content negotiation, not a degraded path.
fn accepts_brotli(headers: &HeaderMap) -> bool {
    // Unreadable is treated as "did not ask" (identity bytes — always correct) and SAID so, like
    // every other header this crate reads. A client that never gets a compressed asset because its
    // proxy sends a non-text Accept-Encoding is otherwise a silent 4x bandwidth bill.
    let raw = match headers.get(header::ACCEPT_ENCODING).map(|v| v.to_str()) {
        Some(Ok(raw)) => raw,
        Some(Err(e)) => {
            eprintln!("dpay-relay: Accept-Encoding is not text ({e}); serving identity bytes");
            return false;
        }
        None => return false,
    };
    raw.split(',').any(|part| {
        let mut it = part.split(';');
        let token = it.next().unwrap_or("").trim();
        if !token.eq_ignore_ascii_case("br") {
            return false;
        }
        // Any `q=0` (or `q=0.000`) in the parameters is an explicit refusal of this coding.
        !it.any(|p| {
            let p = p.trim();
            p.strip_prefix("q=")
                .is_some_and(|q| q.parse::<f32>().is_ok_and(|q| q == 0.0))
        })
    })
}

/// Serve one embedded dist file by route, or 404. Hashed `assets/` files are immutable; the entry
/// HTML, the service worker and the manifest are no-cache (see `wallet_page`, `service_worker`).
///
/// The body is the brotli the vite build precompressed (`build.rs`) whenever the client asked for
/// it — compression happens once at build time at max quality, never per request. `Vary` is sent
/// on every response that HAS a compressed twin, including the identity one, so a shared cache
/// cannot hand a `br` body to a client that never asked for one.
fn serve_dist_asset(route: &str, headers: &HeaderMap) -> Response {
    let Some(asset) = web_dist::WEB_ASSETS.iter().find(|a| a.route == route) else {
        return err(StatusCode::NOT_FOUND, "not found");
    };
    let cache = if asset.immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut resp = match asset.brotli.filter(|_| accepts_brotli(headers)) {
        Some(br) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(asset.content_type),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
                (header::CONTENT_ENCODING, HeaderValue::from_static("br")),
            ],
            br,
        )
            .into_response(),
        None => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static(asset.content_type),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
            ],
            asset.bytes,
        )
            .into_response(),
    };
    if asset.brotli.is_some() {
        resp.headers_mut()
            .insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    resp
}

/// `GET /dpay-core.wasm` — the frozen wire core compiled to wasm32 (crates/dpay-wasm, staged by
/// `just wasm`). This is the "one signing source for every web surface": a browser page loads it
/// and signs/builds the EXACT bytes the Android app's UniFFI core produces. Byte-parity against
/// the trusted JS oracle is enforced offline by scripts/check-wasm-core.mjs. (The /wallet build
/// bundles its own copy as a hashed asset; this route remains the canonical same-origin URL for
/// any other web surface + direct downloads.)
async fn dpay_core_wasm() -> Response {
    (
        [(header::CONTENT_TYPE, "application/wasm")],
        include_bytes!("../assets/dpay-core.wasm"),
    )
        .into_response()
}

/// `GET /shots/{name}` — the real app screenshots the landing page shows (offline; no CDN). The
/// flow rails now step through real phone screens, so the NFC tap states and the one-press
/// sign-status view are served alongside the original QR/Pay/Paid trio. Anything else is a clean `404`.
async fn screenshot(Path(name): Path<String>) -> Response {
    let bytes: &'static [u8] = match name.as_str() {
        "request.png" => include_bytes!("../assets/shot-request.png"),
        "paying.png" => include_bytes!("../assets/shot-paying.png"),
        "paid.png" => include_bytes!("../assets/shot-paid.png"),
        "nfc-listen.png" => include_bytes!("../assets/shot-nfc-listen.png"),
        "nfc-exchange.png" => include_bytes!("../assets/shot-nfc-exchange.png"),
        "nfc-paid.png" => include_bytes!("../assets/shot-nfc-paid.png"),
        "scanned.png" => include_bytes!("../assets/shot-scanned.png"),
        _ => return err(StatusCode::NOT_FOUND, "no such screenshot"),
    };
    // The shots are embedded via include_bytes! → they change only with the binary. A versioned
    // ETag lets the CDN revalidate instead of heuristically caching a stale shot after a redeploy
    // (the Jul-26 era shots stayed pinned at the edge for weeks before this header existed).
    // The validator is the build's git commit — unique per deploy, already exported by build.rs
    // for the /api/v1/version endpoint, and it changes exactly when the embedded shots can.
    let etag = format!("\"shots-{}\"", env!("DPAY_BUILD_COMMIT"));
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=300"),
            (header::ETAG, etag.as_str()),
        ],
        bytes,
    )
        .into_response()
}

// ---- request / response bodies ----

// Parsed by BOTH faucet builds: the test-helpers fake-IC credit AND the agent-build production
// route (relay-side cooldown + authenticated canister mint).
#[cfg(any(feature = "test-helpers", feature = "agent"))]
#[derive(Deserialize)]
struct FaucetRequest {
    account: String,
    /// Settlement currency to mint. Defaults to `DEMO_USD` when absent (the demo's play money).
    #[serde(default)]
    currency: Option<Currency>,
    amount: Option<U64String>,
}

/// Body for `POST /api/v1/test/hide_outcome` (test-helpers only).
#[cfg(feature = "test-helpers")]
#[derive(Deserialize)]
struct HideOutcomeRequest {
    request_id: String,
    /// How many subsequent read_state certs omit this rid's outcome. Default 1, capped at 64 —
    /// enough to exhaust any in-tap poll budget without pinning a relay-wide global.
    #[serde(default)]
    polls: Option<u32>,
}

/// Body for `POST /api/v1/test/swap_pool` (test-helpers only) — the fake-IC stub ICPSwap
/// pool's knobs; every field optional, absent = untouched.
#[cfg(feature = "test-helpers")]
#[derive(Deserialize)]
struct SwapPoolKnobs {
    /// WHICH stub pool the knobs target (multi-venue readiness V3): the pool principal,
    /// required — the gateway hosts many pools and a knob must name its target.
    pool: Option<String>,
    /// Swap fee in millionths of the input (per-pool; the PoC venue's tier is 0.30%).
    #[serde(default)]
    fee_millionths: Option<u128>,
    /// Extra price-impact haircut on the quoted output, basis points (default 0).
    #[serde(default)]
    impact_bps: Option<u16>,
    /// `true` = the pending_withdrawal arm: swaps consume the input and QUEUE the output.
    #[serde(default)]
    fail_withdrawal: Option<bool>,
    /// `true` = drain the queued outputs now (the pending_withdrawal resolution).
    #[serde(default)]
    settle_pending: bool,
}

/// Body for `POST /api/v1/test/approve_fail` (test-helpers only) — the fake-IC ledger's
/// approve-refusal knob.
#[cfg(feature = "test-helpers")]
#[derive(Deserialize)]
struct ApproveFailKnob {
    /// WHICH ledger the knob targets, by principal text — required (the gateway hosts one
    /// ledger per catalog currency; a silent default could land on the wrong one).
    ledger: Option<String>,
    /// How many subsequent `icrc2_approve` calls on that ledger are refused with
    /// `AllowanceChanged { current_allowance: 0 }`. Default 1, capped at 64; 0 disarms.
    #[serde(default)]
    refusals: Option<u32>,
}

/// Body for `POST /api/v1/test/ic_delay` (test-helpers only) — the fake-IC reply-delay knob.
#[cfg(feature = "test-helpers")]
#[derive(Deserialize)]
struct IcDelayKnob {
    /// WHICH update method the knob targets, by exact name (e.g. "depositFromAndSwap") —
    /// required; the gateway refuses names its dispatch does not answer.
    method: Option<String>,
    /// How many ms the reply stays invisible to read_state after each submit.
    /// Default 0 = disarm.
    #[serde(default)]
    ms: Option<u64>,
}

/// Body for `POST /api/v1/test/venue` (offline test build only) — the venue-serving knob of
/// multi-venue readiness V5. `venue_id` names the fixture venue; `served: true` arms it into
/// `GET /api/v1/venues`, `false` removes it (the default state).
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
#[derive(Deserialize)]
struct VenueServeKnob {
    venue_id: String,
    served: bool,
}

/// `?pool=&token_in=&token_out=&amount_in=` for `GET /api/v1/swap_quote` — all required.
/// `amount_in` is e8s (U64String: decimal string or bare number in query position).
#[cfg(any(feature = "agent", feature = "test-helpers"))]
#[derive(Deserialize)]
struct SwapQuoteQuery {
    pool: String,
    token_in: String,
    token_out: String,
    amount_in: U64String,
}

/// `GET /api/v1/swap_quote` response — the pool's own quote VERBATIM and ATTRIBUTED
/// (multi-venue readiness V4/V7): `venue_id` names which venue answered (the pool principal
/// resolved against the compiled venue registry), `amount_out` is the pool's `quote` reply,
/// GROSS — the app computes net by subtracting the output ledger's fee; the relay adds/blends
/// NOTHING — plus `fetched_at` (the moment the venue answered, for the app's staleness line).
/// The echo fields let the app key the quote without re-deriving direction; `zero_for_one`
/// and `fee_millionths` come back inside the venue's own quote — `fee_millionths` is the
/// venue's fee tier ECHOED (3000 = 0.30%), never a number dpay claims, and it is the app's
/// only source for that figure.
#[cfg(any(feature = "agent", feature = "test-helpers"))]
#[derive(Serialize)]
struct SwapQuoteBody {
    venue_id: String,
    pool: String,
    token_in: String,
    token_out: String,
    amount_in: U64String,
    amount_out: U64String,
    /// Serialized as a plain bool here BY DESIGN while the app parses it as OPTIONAL: absence on
    /// the app side deliberately means "venue published no direction" — neither side is wrong,
    /// do not "fix" one to match the other.
    zero_for_one: bool,
    fee_millionths: u128,
    fetched_at: u64,
}

/// One served venue in `GET /api/v1/venues` — the registry entry in wire shape (snake_case
/// like every route). `pair_ledgers` is an UNORDERED set: which side a pool calls token0 is
/// the venue's own fact, read live per quote — the route must never suggest an order.
#[cfg(any(feature = "agent", feature = "test-helpers"))]
#[derive(Serialize)]
struct VenueBody {
    venue_id: String,
    display_name: String,
    /// Extensible string enum: `ic_amm` today, `cefi` next, a future Solana kind is a new
    /// value — never a schema break.
    kind: String,
    endpoint: String,
    pair_ledgers: Vec<String>,
    testnet: bool,
    disclosure_key: String,
    /// The venue's last measured settlement health (probe result file `dfx/venue_health.json`,
    /// verdict derived relay-side by `catalog::settlement_verdict` — degraded = payout not
    /// settled or slower than 30 min). ABSENT when never measured: absence is
    /// healthy-by-default, never invented. The app renders a "recently slow" line on a
    /// degraded row; the DEMOTION is this route's row order, nothing else.
    #[serde(skip_serializing_if = "Option::is_none")]
    health: Option<VenueHealthBody>,
}

/// The settlement-health block on one served venue row (see [`VenueBody::health`]). Named
/// `VenueHealthBody`, NOT `HealthBody`: the relay's own liveness route already owns that name.
#[cfg(any(feature = "agent", feature = "test-helpers"))]
#[derive(Serialize)]
struct VenueHealthBody {
    /// `"ok" | "degraded"` — the gate's verdict over the raw measurement below.
    status: String,
    /// Measured order→settle latency (seconds); `null` = observed without a settle.
    settle_seconds: Option<u64>,
    /// When the probe measured (unix seconds).
    measured_at: u64,
}

/// `GET /api/v1/venues` response. Kept SEPARATE from `/api/v1/currencies` on purpose:
/// currencies are asset-scoped (one row per asset, network sections), venues are PAIR-scoped
/// (one row per venue, spanning two assets) — a different axis, not a sub-list.
#[cfg(any(feature = "agent", feature = "test-helpers"))]
#[derive(Serialize)]
struct VenuesBody {
    venues: Vec<VenueBody>,
}

/// `?currency=N` for `GET /api/v1/deposit/info`. Absent → `DEMO_USD`.
#[derive(Deserialize)]
struct BalanceQuery {
    currency: Option<Currency>,
}

/// Optional `memo` is an exact 16-byte hex settlement nonce; filtering occurs during the ledger
/// walk, before `limit`, so a busy account cannot push a just-settled request out of the window.
#[derive(Deserialize)]
struct TransactionsQuery {
    currency: Option<Currency>,
    limit: Option<u32>,
    memo: Option<String>,
}

/// `?currency=N` for `GET /api/v1/onramp/ckerc20`. Absent → `DEMO_USD` (which has no ckERC-20
/// onramp → 503); a caller must name the ckERC-20 currency it wants (e.g. ckUSDC = 2).
#[derive(Deserialize)]
struct CkErc20Query {
    currency: Option<Currency>,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
}

/// `GET /api/v1/capabilities` response. `demo_faucet` means "`POST /api/v1/faucet` on THIS relay
/// will credit an account" — whichever of the two faucet builds is compiled (see
/// [`AppState::faucet_available`]); the wallet reads it to decide whether a top-up action can
/// exist at all.
#[derive(Serialize)]
struct CapabilitiesBody {
    checkout: bool,
    demo_faucet: bool,
}

/// `GET /api/v1/version` response — the running image's source identity. `commit` is the git SHA
/// and `commit_date` its committer date, both baked by `build.rs` (deploy-fidelity: the date is
/// the human-readable "when was prod last updated" half of the pair).
#[derive(Serialize)]
struct VersionBody {
    name: &'static str,
    version: &'static str,
    commit: &'static str,
    commit_date: &'static str,
}

/// `GET /api/v1/integrity` response — the facade canister's live-vs-pinned module hash (both
/// lowercase sha256 hex; `null` when the half is unknown). `status` is [`classify_integrity`]'s
/// verdict; `relay_commit` rides along so the two halves of an upgrade (canister wasm + relay
/// image) are readable from one response.
#[derive(Serialize)]
struct IntegrityBody {
    facade_canister: Option<String>,
    live_module_hash: Option<String>,
    pinned_module_hash: Option<String>,
    status: &'static str,
    relay_commit: &'static str,
}

/// Response of BOTH faucet builds (test-helpers fake credit + agent canister mint):
/// `{balance: <new minor-unit balance>}` — the shape Wallet.tsx's `topUp` reads.
#[cfg(any(feature = "test-helpers", feature = "agent"))]
#[derive(Serialize)]
struct BalanceBody {
    balance: U64String,
}

/// `GET /api/v1/transactions/{hex}` response body. Direction (in/out) is derived client-side by
/// comparing the queried account's pubkey to each row's `from` (hex).
#[derive(Serialize)]
struct TransactionsBody {
    transactions: Vec<TxnRecord>,
}

/// `GET /api/v1/deposit/info` response body — static deposit instructions.
#[derive(Serialize)]
struct DepositInfoBody {
    min_confirmations: u32,
    deposit_fee: U64String,
    deposit_min_amount: Option<U64String>,
}

/// `GET /api/v1/onramp/ckerc20` response body — the CkEthErc20-family onramp params the app needs to
/// build the user's Ethereum transaction(s). The deposit `principal` arg is the user's own IC
/// principal (derived in-app), so no principal field is served. `kind` discriminates the two deposit
/// shapes ("erc20" = two txs approve+depositErc20 with `erc20_address` set; "native_eth" = one
/// payable depositEth tx with `erc20_address` null and the ETH amount in the tx `value`).
#[derive(Serialize)]
struct CkErc20OnrampBody {
    helper_address: String,
    erc20_address: Option<String>,
    kind: String,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ErrorBody { error: msg.into() })).into_response()
}

/// Decode a hex string into a fixed-size byte array, returning a `BAD_REQUEST` [`Response`] on any
/// decode or length failure (the same status + shape every hex-path handler returns for malformed
/// input). The single message collapses both failure modes — byte-identical to the prior
/// `match hex::decode … _ => BAD_REQUEST` blocks this replaces (no separate decode-vs-length error
/// surfaced; a 400 with the field name is enough for the client to debug).
///
/// Returns `Result<_, Response>` (not `[u8; N]` directly) because callers can't `?`-bail out of a
/// `-> Response` handler — they use the [`ok_or_bail!`] macro below. The dedicated
/// `parse_pubkey_hex` wrapper names the common 32-byte case.
fn parse_hex_array<const N: usize>(s: &str, label: &str) -> Result<[u8; N], Response> {
    let decoded = hex::decode(s.trim()).ok();
    match decoded.and_then(|b| <[u8; N]>::try_from(b).ok()) {
        Some(arr) => Ok(arr),
        None => Err(err(
            StatusCode::BAD_REQUEST,
            format!("{label} must be {N} bytes hex"),
        )),
    }
}

/// Decode a hex `pubkey` (32 bytes) path param / body field. Thin wrapper over [`parse_hex_array`]
/// so the 7+ handlers that take a pubkey collapse to one line; the message reads
/// `"pubkey must be 32 bytes hex"` (byte-identical to the prior inline blocks). Sites that take an
/// `account` field (faucet / deposit seed) pass a different label so the message reads naturally.
fn parse_pubkey_hex(s: &str) -> Result<[u8; PUBKEY_LEN], Response> {
    parse_hex_array::<PUBKEY_LEN>(s, "pubkey")
}

/// Unwrap a `Result<T, Response>` or early-return the `Response` from the enclosing `-> Response`
/// handler. The handlers can't use `?` (the `Response` return type doesn't implement
/// `FromResidual`), so without this macro every hex-parse call site would need a 3-line `match`.
/// Local to this module: the only `Result<_, Response>` producers here are the hex-parse helpers.
macro_rules! ok_or_bail {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}
use ok_or_bail;

/// `GET /api/v1/health` → `200 {"status":"ok"}` when the ledger reports healthy, else `503`.
async fn health(State(state): State<AppState>) -> Response {
    if state.ledger.healthy().await {
        (StatusCode::OK, Json(HealthBody { status: "ok" })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthBody {
                status: "unhealthy",
            }),
        )
            .into_response()
    }
}

/// `GET /api/v1/capabilities` → `200 {"checkout":bool,"demo_faucet":bool}`. Both values are read off
/// the SAME state the surfaces themselves are gated on — `checkout_enabled` is the flag [`app`] reads
/// to register the checkout routes, and `faucet_available` is the flag the compiled faucet handler
/// refuses on — so an advertised capability is the one thing this relay will actually do.
async fn capabilities(State(state): State<AppState>) -> Response {
    (
        StatusCode::OK,
        Json(CapabilitiesBody {
            checkout: state.checkout_enabled,
            demo_faucet: state.faucet_available,
        }),
    )
        .into_response()
}

/// `GET /api/v1/version` → `200 {"name":"dpay-relay","version":"<pkg>","commit":"<sha>"}`. The commit
/// is baked at compile time by `build.rs` (`DPAY_BUILD_COMMIT`), so the live endpoint reports EXACTLY
/// which source the running image was built from — the deploy-fidelity primitive
/// (`scripts/verify-relay-version.sh` compares it to `git rev-parse HEAD`). Feature-unconditional: the
/// prod image carries it too (no `agent` requirement). No state, no I/O — cheap + always reachable.
async fn version() -> Response {
    (
        StatusCode::OK,
        Json(VersionBody {
            name: "dpay-relay",
            version: env!("CARGO_PKG_VERSION"),
            commit: env!("DPAY_BUILD_COMMIT"),
            commit_date: env!("DPAY_BUILD_DATE"),
        }),
    )
        .into_response()
}

/// The PINNED facade module hash, baked by build.rs from tracked `deploy/facade-module-hash.txt`
/// (test-helpers builds bake the FakeLedger's deterministic hash instead, so the offline loop
/// reads MATCH — see build.rs). An empty env is `None`: the route then reports `UNPINNED`, the
/// honest "there is no reference to compare against" (prod builds FAIL rather than bake empty;
/// this branch is the documented escape hatch for deliberately unpinned builds).
fn pinned_facade_hash() -> Option<&'static str> {
    let pin = env!("DPAY_PINNED_FACADE_HASH");
    if pin.is_empty() {
        None
    } else {
        Some(pin)
    }
}

/// The integrity verdict: `MATCH` (live equals the pin — the deployed facade is the recorded
/// upgrade), `MISMATCH` (it is not — someone upgraded outside the recorded procedure, GOVERNANCE
/// row 7's whole point), `UNPINNED` (no reference hash was baked, so nothing can be judged), or
/// `UNREACHABLE` (the IC read failed / no facade is configured — the live half is missing).
/// PURE so the whole matrix is unit-testable without an IC; precedence when both halves are
/// missing: `UNPINNED` — a deployment without a pin has no integrity surface at all, which is
/// the fact the operator must act on first.
pub fn classify_integrity(live: Option<&str>, pinned: Option<&str>) -> &'static str {
    match (live, pinned) {
        (_, None) => "UNPINNED",
        (None, Some(_)) => "UNREACHABLE",
        (Some(l), Some(p)) if l == p => "MATCH",
        (Some(_), Some(_)) => "MISMATCH",
    }
}

/// `GET /api/v1/integrity` → the facade canister's live-vs-pinned module hash, the upgrade-
/// detection primitive of GOVERNANCE row 7 (companion of `/api/v1/version`, which pins the RELAY
/// image; this pins the CANISTER wasm). The live hash is read off the PUBLIC IC state tree
/// (`canister/<id>/module_hash` — the same read `dfx canister info` prints; no signature needed)
/// through the [`Ledger`] seam; the pinned half is baked at build time. Deliberately NOT on
/// `/health`: health must stay a cheap, IC-free liveness probe, and integrity a bounded read —
/// different jobs, different failure domains. Every failure degrades to a 200 with an honest
/// status rather than a 5xx: this is a report, not a promise.
async fn integrity(State(state): State<AppState>) -> Response {
    let live: Option<String> = match state.facade_canister.as_deref() {
        // The reason the live half is missing is NOT on the wire — the body reports a status, and
        // `UNREACHABLE` is the honest one for every way the read can fail — but it must exist
        // somewhere, because this route is the upgrade-detection primitive of GOVERNANCE row 7 and
        // "we could not read the canister's module hash" is exactly the sentence an operator needs
        // when the answer stops being MATCH. `.ok()` used to destroy it outright.
        Some(canister) => match state.ledger.facade_module_hash().await {
            Ok(hash) => Some(hash),
            Err(e) => {
                eprintln!(
                    "dpay-relay: integrity: could not read facade {canister}'s live module hash \
                     (reporting UNREACHABLE): {e}"
                );
                None
            }
        },
        None => None,
    };
    let pinned = pinned_facade_hash();
    let status = classify_integrity(live.as_deref(), pinned);
    (
        StatusCode::OK,
        Json(IntegrityBody {
            facade_canister: state.facade_canister.clone(),
            live_module_hash: live,
            pinned_module_hash: pinned.map(str::to_string),
            status,
            relay_commit: env!("DPAY_BUILD_COMMIT"),
        }),
    )
        .into_response()
}
