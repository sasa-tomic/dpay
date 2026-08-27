//! The relay's HTTP surface.
//!
//! Public pages at the root, the JSON API under `/api/v1`:
//! - `GET /` — the marketing landing page (with a download CTA when an APK is configured).
//! - `GET /download/dpay.apk` — the Android build, when one is configured; else `404`.
//! - `GET /merchant` — permanent redirect to `/wallet` (the hand-rolled terminal page is gone;
//!   the REAL app's Receive tab IS the merchant terminal now).
//! - `GET /wallet` — the REAL app (`app/App.tsx`) built for the web (react-native-web, wasm
//!   DpayCore), embedded at compile time from `e2e/dist-prod`. Same app the APK ships.
//! - `GET /assets/{path}` — the wallet build's content-hashed assets (immutable caching).
//! - `GET /privacy` — the public privacy policy for the app and website.
//! - `GET /dpay-core.wasm` — the shared wire core (canonical same-origin URL for any web surface;
//!   the wallet build carries its own hashed copy under /assets/).
//! - `GET /shots/{name}` — the real app screenshots embedded in the landing page.
//! - `GET /api/v1/health` — liveness pre-flight; consults `ledger.healthy()`.
//! - `GET /api/v1/transactions/{hex}?currency=N&limit=30` — the wallet's durable transaction list,
//!   newest-first, read off the ICRC ledger's own transaction log at the user's principal.
//! - `GET  /api/v1/deposit/info?currency=N` — static deposit instructions (min confirmations, fee,
//!   min amount) so the "Add money" sheet can render them.
//! - `GET  /api/v1/currencies` — the wallet's runtime asset catalog (closes issue #7), served
//!   network-first: `{networks:[{protocol,name,environment,assets}]}` — icp mainnet + icp testnet
//!   partitioned from the facade's flat ICRC registry, plus the relay-constant solana mainnet
//!   section. IC rows keep the exact `CurrencyDescriptor` shape; read once on wallet load.
//! - `GET  /api/v1/balances/{hex}` — ALL currency balances in ONE response (a flat map
//!   `{currency: minor-units}`), replacing the wallet's old N+1 per-poll fetch loop (1 primary +
//!   1 per-asset, each a relay→IC round trip) with a single request.
//! - `POST /api/v1/faucet` — the demo top-up. TWO builds, ONE route shape (`{account: hex,
//!   currency?, amount?}` → `{balance}`; refusals → 422 `{error: <verbatim reason>}`):
//!   test-helpers credits the fake-IC gateway (gated by `DPAY_ENABLE_FAUCET`); the agent build
//!   (production) enforces the relay-side cooldown ([`crate::faucet`]) and drives the facade's
//!   controller-gated `mint` through the authenticated agent, crediting the USER principal.
//!   With BOTH features (the live-test config) the test-helpers branch owns the route.
//!
//! Read-only by construction apart from the play-money faucet: there is no value-moving route
//! left on this crate (the 2026-08-19 IC-rail cutover moved settlement to the app's own signed
//! /api/v2 envelopes; the test-helpers fake-IC gateway is the offline e2e stand-in for that
//! surface).

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

use crate::ledger::{CurrencyDescriptor, Ledger, LedgerError, RampCapability, TxnRecord, U64String};

/// Shared relay state. `Arc<dyn Ledger>` is the read seam (catalog, balances, history).
#[derive(Clone)]
pub struct AppState {
    pub ledger: Arc<dyn Ledger>,
    /// Whether `POST /api/v1/faucet` (which *mints*) is served. Gates the test-helpers faucet
    /// (`DPAY_ENABLE_FAUCET`); defaults to `true` — harmless against the offline fixtures it
    /// ships with. The agent-build faucet is NOT gated by this flag: its rate limit is the
    /// relay-side [`crate::faucet`] cooldown, and its mint is already canister-gated
    /// (`require_admin` refuses the anonymous agent).
    faucet_enabled: Arc<Mutex<bool>>,
    /// The agent-build faucet's per-account cooldown map (see [`crate::faucet`]). Guarded by
    /// the repo's poison-tolerant lock convention and never held across an await.
    #[cfg(feature = "agent")]
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
}

impl AppState {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        AppState {
            ledger,
            faucet_enabled: Arc::new(Mutex::new(true)),
            #[cfg(feature = "agent")]
            faucet_cooldown: Arc::new(Mutex::new(crate::faucet::FaucetCooldown::with_window(
                crate::faucet::FAUCET_COOLDOWN_SECS,
            ))),
            apk: Arc::new(None),
            apk_version: String::new(),
            #[cfg(feature = "test-helpers")]
            fake_ic: None,
        }
    }

    /// Attach the fake-IC `/api/v2` gateway (test-helpers only; see [`crate::ic_gateway`]).
    #[cfg(feature = "test-helpers")]
    pub fn with_fake_ic(mut self, fake_ic: Arc<crate::ic_gateway::FakeIc>) -> Self {
        self.fake_ic = Some(fake_ic);
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

    pub fn set_faucet_enabled(&self, on: bool) {
        *self.faucet_enabled.lock().unwrap_or_else(|p| p.into_inner()) = on;
    }

    /// Replace the faucet cooldown's window (agent build). Test seam ONLY: the live tests shrink
    /// the 1h production window to seconds so the rollover is observable; prod never calls this.
    #[cfg(feature = "agent")]
    pub fn set_faucet_cooldown_window(&self, window_secs: u64) {
        *self.faucet_cooldown.lock().unwrap_or_else(|p| p.into_inner()) =
            crate::faucet::FaucetCooldown::with_window(window_secs);
    }

    pub fn faucet_enabled(&self) -> bool {
        *self.faucet_enabled.lock().unwrap_or_else(|p| p.into_inner())
    }
}

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
        .route("/version", get(version));

    // Test-only value fixtures (test-helpers, WITHOUT agent — the e2e/test-relay build): the
    // faucet credits the fake-IC gateway at the user's principal, and the single-currency
    // /balance reads it back — e2e assertion sugar. Prod gets balances through the batch route
    // above (direct ledger reads). When BOTH features are on (the live-test config) the AGENT
    // faucet below owns the route instead, so the live tests drive the production branch.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let api = api.route("/faucet", axum::routing::post(faucet));
    #[cfg(feature = "test-helpers")]
    let api = api.route("/balance/{hex}", get(balance));
    // Test seam for the honest-unknown recovery flow (2026-08-21 mainnet NFC bug): arm
    // "hide this request_id's outcome for the next N read_states" on the fake-IC gateway —
    // see `FakeIc::hidden_outcomes`. RID-scoped, so concurrent flows on the shared relay are
    // unaffected.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/hide_outcome", axum::routing::post(hide_outcome));

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
        .route("/assets/{*path}", get(web_asset))
        .route("/privacy", get(privacy_page))
        .route("/dpay-core.wasm", get(dpay_core_wasm))
        .route("/shots/{name}", get(screenshot))
        .nest("/api/v1", api);

    // Test-only fake-IC /api/v2 gateway (test-helpers): the offline e2e stand-in for icp-api.io,
    // mounted at the ROOT (the IC API is its own top-level namespace — NOT under /api/v1). Routed
    // on the pre-state router so the submit handler's State<AppState> extractor resolves.
    #[cfg(feature = "test-helpers")]
    let router = router
        .route("/api/v2/canister/{canister}/{kind}", axum::routing::post(crate::ic_gateway::submit))
        .route("/api/v2/status", get(crate::ic_gateway::status));

    let router = router.with_state(state);

    // Test-only CORS: allows the web build of the app (served by vite on a different port) to make
    // direct fetch() calls to the relay during e2e + UX review. Gated behind `test-helpers` so the
    // prod image (built without the feature) never sends CORS headers. The e2e harness ALSO launches
    // Chrome with --disable-web-security, but this layer makes the relay usable by ANY web-based test
    // tool without requiring browser flags.
    #[cfg(feature = "test-helpers")]
    let router = router.layer(axum::middleware::from_fn(test_cors_middleware));

    router
}

/// Permissive CORS middleware (test-only, feature-gated). Adds `Access-Control-Allow-Origin: *` to
/// every response + intercepts OPTIONS preflight with a 204.
#[cfg(feature = "test-helpers")]
async fn test_cors_middleware(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    use axum::http::Method;
    if req.method() == Method::OPTIONS {
        let mut resp = Response::new(axum::body::Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        let h = resp.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, header::HeaderValue::from_static("*"));
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            header::HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            header::HeaderValue::from_static("Content-Type"),
        );
        return resp;
    }
    let mut resp = next.run(req).await;
    resp.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        header::HeaderValue::from_static("*"),
    );
    resp
}

/// `POST /api/v1/faucet` JSON `{account: <hex>, currency?, amount?}` → `{balance}`. Demo on-ramp
/// (test-helpers WITHOUT agent — the e2e/test-relay build; the agent build serves the production
/// branch below). Credits the user PRINCIPAL on the fake-IC gateway's ledger for `currency`,
/// exactly where a signed icrc1_transfer would move funds; the pk → principal mapping is
/// self_authenticating(pk) — the account the app derives from its device key. Defaults:
/// `currency = DEMO_USD` (0), `amount = 10_000`.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
async fn faucet(State(state): State<AppState>, Json(req): Json<FaucetRequest>) -> Response {
    if !state.faucet_enabled() {
        return err(StatusCode::NOT_FOUND, "faucet disabled");
    }
    let pk = ok_or_bail!(parse_hex_array(&req.account, "account"));
    // Currency defaults to DEMO_USD — the faucet's whole point is play money for the demo. A missing
    // amount is the demo's $100.00 top-up.
    let currency = req.currency.unwrap_or(DEMO_USD);
    let amount = req.amount.map(|x| x.0).unwrap_or(10_000);
    let Some(fake) = state.fake_ic.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "fake-IC gateway not attached");
    };
    use dpay_icp::principal::Principal as IcpPrincipal;
    let owner = IcpPrincipal::self_authenticating_ed25519(&pk);
    let bal = fake.faucet_credit(currency, &owner, u128::from(amount));
    (StatusCode::OK, Json(BalanceBody { balance: U64String(bal.min(u64::MAX as u128) as u64) })).into_response()
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
    let pk = ok_or_bail!(parse_hex_array(&req.account, "account"));
    let currency = req.currency.unwrap_or(DEMO_USD);
    let amount = req.amount.map(|x| x.0).unwrap_or(crate::faucet::FAUCET_AMOUNT);
    if amount != crate::faucet::FAUCET_AMOUNT {
        return err(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("faucet amount is fixed at {} (minor units)", crate::faucet::FAUCET_AMOUNT),
        );
    }
    // Relay-side rate limit. The lock is NEVER held across the mint await below (check-and-mark
    // completes synchronously) and is poison-tolerant like every lock in this crate.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Err(reason) = state
        .faucet_cooldown
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .check_and_mark(&pk, currency as u32, now_secs)
    {
        return err(StatusCode::UNPROCESSABLE_ENTITY, reason);
    }
    match state.ledger.faucet_mint(&pk, currency, amount).await {
        Ok(balance) => {
            (StatusCode::OK, Json(BalanceBody { balance: U64String(balance) })).into_response()
        }
        // The canister's own refusal text (e.g. "currency 0 is not mintable", or an
        // unauthorized-controllership change) — surfaced verbatim per the app's N5 contract.
        Err(LedgerError::Rejected(msg)) => err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => {
            err(StatusCode::SERVICE_UNAVAILABLE, format!("ledger unavailable: {msg}"))
        }
    }
}

/// `GET /api/v1/balance/{hex}?currency=<u32>` → `{"balance": <minor units>}` for a 32-byte
/// pubkey (hex). Test fixture (test-helpers only): reads the fake-IC gateway's principal-keyed
/// ledger so e2e assertions can check where funds landed. Prod reads balances through the app's
/// own signed icrc1_balance_of queries — this route does not exist there.
#[cfg(feature = "test-helpers")]
async fn balance(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<BalanceQuery>,
) -> Response {
    let pk = ok_or_bail!(parse_pubkey_hex(&hex_pk));
    let currency = qs.currency.unwrap_or(DEMO_USD);
    // Read the gateway's principal-keyed balance (same mapping the faucet credits and signed
    // transfers move — the pubkey's self_authenticating principal).
    let Some(fake) = state.fake_ic.clone() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "fake-IC gateway not attached");
    };
    use dpay_icp::principal::Principal as IcpPrincipal;
    let owner = IcpPrincipal::self_authenticating_ed25519(&pk);
    let bal = fake.balance_for(currency, &owner);
    (StatusCode::OK, Json(BalanceBody { balance: U64String(bal) })).into_response()
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
        return err(StatusCode::SERVICE_UNAVAILABLE, "fake-IC gateway not attached");
    };
    let rid: [u8; 32] = ok_or_bail!(parse_hex_array(&req.request_id, "request_id"));
    let polls = req.polls.unwrap_or(1).min(64) as usize;
    fake.arm_hidden_outcome(rid, polls);
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
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
/// value for that currency) and logged here (no silent errors). The catalog fetch itself is
/// all-or-nothing: if it fails the route is `503` (the relay can't enumerate currencies without it).
/// Each query is a free read DIRECTLY on the currency's ledger (no facade hop, no consensus, no
/// cache), so the batch is always-live at near-zero cost.
///
/// Response shape (flat map, currency index string → minor-units decimal string): the JSON object
/// keys are serde-serialized currency indices as decimal strings, e.g. `{"0":"5000","1":"0",...}`.
async fn balances(State(state): State<AppState>, Path(hex_pk): Path<String>) -> Response {
    let pk = ok_or_bail!(parse_pubkey_hex(&hex_pk));

    // Enumerate the catalog (the source of truth for which currencies exist). An unreachable ledger
    // can't be enumerated → 503; there is no per-currency permanent-policy failure on this surface.
    let catalog = match state.ledger.currencies().await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    };

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
            Ok(Ok(bal)) => { map.insert(currency.to_string(), U64String(bal)); }
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
        Some(_) => return err(StatusCode::BAD_REQUEST, "memo must be exactly 32 hex characters"),
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
        return (StatusCode::OK, Json(TransactionsBody { transactions: rows })).into_response();
    }
    // History needs the currency's LEDGER principal — resolve it from the catalog (the same
    // source /balances fans out over), then walk that ledger's own transaction log.
    let catalog = match state.ledger.currencies().await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    };
    let Some(desc) = catalog.iter().find(|d| d.currency == currency) else {
        return err(StatusCode::BAD_REQUEST, format!("unknown currency {currency}"));
    };
    match state
        .ledger
        .transactions_on_ledger(&desc.ledger, pk, currency, limit, memo)
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(TransactionsBody { transactions: rows })).into_response(),
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
        Ok(i) => (StatusCode::OK, Json(DepositInfoBody {
            min_confirmations: i.min_confirmations,
            deposit_fee: i.deposit_fee,
            deposit_min_amount: i.deposit_min_amount,
        }))
            .into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// The v2 environment partition rule (server-authoritative — the app reads the section's
/// `environment` and never re-derives this): an IC row is testnet iff `network` is `Some` AND not
/// one of the mainnet backing networks {"Bitcoin","Ethereum"}; `network == None` (DEMO $, the
/// facade-native play asset, `mintable`) is mainnet-side.
fn is_testnet_row(d: &CurrencyDescriptor) -> bool {
    !matches!(d.network.as_deref(), None | Some("Bitcoin") | Some("Ethereum"))
}

/// The mainnet USDC mint — mirrors `USDC_MINT_ADDRESS` (app/solana/spl.ts) verbatim; the only
/// on-chain address the solana section carries.
const SOLANA_USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// The solana mainnet section — a relay-level constant provider (NOT a `Ledger` thing: the rail
/// is device-key + direct RPC and never touches the IC facade, so it is absent from the trait and
/// `fake.rs`). Values mirror app/solana.ts exactly: SOL 9 decimals (`SOL_DECIMALS`), USDC 6
/// decimals + [`SOLANA_USDC_MINT`]. No RPC endpoints or API keys here — the Helius URL stays
/// APK-side.
fn solana_network_section() -> NetworkBody {
    NetworkBody {
        protocol: "solana",
        name: "Solana",
        environment: "mainnet",
        assets: NetworkAssets::Solana(vec![
            SolanaAsset {
                token: "SOL",
                symbol: "SOL",
                decimals: 9, // SOL_DECIMALS (app/solana/identity.ts)
                mint: None,  // native L1 asset — no SPL mint
                onramp: RampCapability::Direct,
                offramp: RampCapability::Direct,
            },
            SolanaAsset {
                token: "USDC",
                symbol: "USDC",
                decimals: 6, // USDC_DECIMALS (app/solana/spl.ts)
                mint: Some(SOLANA_USDC_MINT),
                onramp: RampCapability::Direct,
                offramp: RampCapability::Direct,
            },
        ]),
    }
}

/// `GET /api/v1/currencies` → `200 {"networks":[...]}` — the network-first asset catalog (v2):
/// exactly three sections in order (icp mainnet, icp testnet, solana mainnet). The relay is the
/// multi-network composition layer: the facade stays IC-only and `ledger.currencies()` keeps
/// returning its flat IC row list; THIS handler partitions it mainnet/testnet ([`is_testnet_row`])
/// and appends the constant [`solana_network_section`]. The empty testnet section is still
/// emitted — clients shouldn't infer from absence. IC rows serialize in the UNCHANGED
/// `CurrencyDescriptor` shape. No query params; unauthenticated (catalog only — no balances).
/// Mirrors the deposit routes' error mapping: any ledger error is `503` (there is no
/// permanent-policy failure on this surface).
async fn currencies(State(state): State<AppState>) -> Response {
    match state.ledger.currencies().await {
        Ok(list) => {
            // Partition preserves each side's catalog order; mainnet keeps DEMO (network None).
            let (mainnet, testnet): (Vec<_>, Vec<_>) =
                list.into_iter().partition(|d| !is_testnet_row(d));
            let body = CurrenciesBody {
                networks: vec![
                    NetworkBody {
                        protocol: "icp",
                        name: "Internet Computer",
                        environment: "mainnet",
                        assets: NetworkAssets::Ic(mainnet),
                    },
                    NetworkBody {
                        protocol: "icp",
                        name: "Internet Computer",
                        environment: "testnet",
                        assets: NetworkAssets::Ic(testnet),
                    },
                    solana_network_section(),
                ],
            };
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
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
async fn ckerc20_onramp(
    State(state): State<AppState>,
    Query(qs): Query<CkErc20Query>,
) -> Response {
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
        Err(LedgerError::Transient(msg)) => {
            err(StatusCode::SERVICE_UNAVAILABLE, format!("ledger unavailable: {msg}"))
        }
    }
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
        include_str!("../assets/landing.html").replace("{{DOWNLOAD}}", &download),
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
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| { let t = t.trim(); t == etag || t == "*" }));
    if not_modified {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::CACHE_CONTROL, "public, max-age=300"), (header::ETAG, etag.as_str())],
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
        include_str!("../assets/privacy.html"),
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
async fn wallet_page() -> Response {
    let mut resp = serve_dist_asset("/wallet");
    resp.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    resp
}

/// `GET /assets/{path}` — the wallet build's content-hashed assets (immutable, cache-forever:
/// the hash IS the version). Unknown names are a clean 404; there is no catch-all.
async fn web_asset(Path(path): Path<String>) -> Response {
    serve_dist_asset(&format!("/assets/{path}"))
}

/// Serve one embedded dist file by route, or 404. Hashed `assets/` files are immutable; the
/// entry HTML is no-cache (see wallet_page).
fn serve_dist_asset(route: &str) -> Response {
    match web_dist::WEB_ASSETS.iter().find(|a| a.route == route) {
        Some(asset) => {
            let cache = if asset.immutable {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            };
            (
                [
                    (header::CONTENT_TYPE, HeaderValue::from_static(asset.content_type)),
                    (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
                ],
                asset.bytes,
            )
                .into_response()
        }
        None => err(StatusCode::NOT_FOUND, "not found"),
    }
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

/// `?currency=N` for `GET /api/v1/balance/{hex}`. Absent → `DEMO_USD`.
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

/// `GET /api/v1/currencies` response body — the network-first asset catalog (v2). Exactly three
/// sections in order: icp mainnet, icp testnet (possibly empty), solana mainnet.
#[derive(Serialize)]
struct CurrenciesBody {
    networks: Vec<NetworkBody>,
}

/// One `networks[]` section. `assets` is untagged so IC sections carry `CurrencyDescriptor` rows
/// and the solana section carries [`SolanaAsset`] rows — both serialize as plain JSON arrays.
#[derive(Serialize)]
struct NetworkBody {
    protocol: &'static str,
    name: &'static str,
    environment: &'static str,
    assets: NetworkAssets,
}

/// The `assets` array of a network section — IC rows (`CurrencyDescriptor`, field set/casing
/// UNCHANGED from the pre-v2 flat catalog) or the relay-constant Solana rows.
#[derive(Serialize)]
#[serde(untagged)]
enum NetworkAssets {
    Ic(Vec<CurrencyDescriptor>),
    Solana(Vec<SolanaAsset>),
}

/// One Solana asset row — a relay-level constant (the device-key rail never touches the IC
/// facade, so this is deliberately NOT a `CurrencyDescriptor`). `mint` is null for native SOL.
/// Ramp vocabulary is shared with the IC rows (`Direct`/`Partner`/`Unavailable`).
#[derive(Serialize)]
struct SolanaAsset {
    token: &'static str,
    symbol: &'static str,
    decimals: u8,
    mint: Option<&'static str>,
    onramp: RampCapability,
    offramp: RampCapability,
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
        None => Err(err(StatusCode::BAD_REQUEST, format!("{label} must be {N} bytes hex"))),
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
            Json(HealthBody { status: "unhealthy" }),
        )
            .into_response()
    }
}

/// `GET /api/v1/version` → `200 {"name":"dpay-relay","version":"<pkg>","commit":"<sha>"}`. The commit
/// is baked at compile time by `build.rs` (`DPAY_BUILD_COMMIT`), so the live endpoint reports EXACTLY
/// which source the running image was built from — the deploy-fidelity primitive
/// (`scripts/verify-relay-version.sh` compares it to `git rev-parse HEAD`). Feature-unconditional: the
/// prod image carries it too (no `agent` requirement). No state, no I/O — cheap + always reachable.
async fn version() -> Response {
    (StatusCode::OK, Json(VersionBody {
        name: "dpay-relay",
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("DPAY_BUILD_COMMIT"),
        commit_date: env!("DPAY_BUILD_DATE"),
    }))
        .into_response()
}
