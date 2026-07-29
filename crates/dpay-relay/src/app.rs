//! The relay's HTTP surface.
//!
//! Public pages at the root, the JSON API under `/api/v1`:
//! - `GET /` — the marketing landing page (with a download CTA when an APK is configured).
//! - `GET /download/dpay.apk` — the Android build, when one is configured; else `404`.
//! - `GET /merchant` — the merchant terminal web page, driven by the merchant phone.
//! - `GET /shots/{name}` — the real app screenshots embedded in the landing page.
//! - `POST /api/v1/pay` — hands the payer's signed-authorization QR to the ledger and returns a
//!   receipt. Two properties matter for the demo and are enforced here (not in the ledger):
//!   * **Idempotency** — keyed by the authorization nonce (the merchant's `request_id`). A repeat
//!     submission returns the *same cached receipt* and never settles twice. This makes the
//!     merchant's "scan → submit" safe to mash / auto-retry.
//!   * **Retries** — a `LedgerError::Transient` is retried a few times with small backoff;
//!     a `Rejected` is final and becomes `422`.
//! - `GET /api/v1/health` — the merchant's pre-flight green dot; consults `ledger.healthy()`.
//! - `GET /api/v1/transactions/{hex}?currency=N&limit=30` — the wallet's durable transaction list,
//!   sourced from the ledger (newest-first); replaces the ephemeral in-memory UI list.
//! - `GET  /api/v1/deposit/address/{hex}?currency=N` — ckBTC-style deposit address for the wallet's
//!   "Add money" sheet (proxies the facade → ck minter `get_btc_address`).
//! - `POST /api/v1/deposit/refresh/{hex}?currency=N` — mint any now-confirmed UTXOs and report
//!   what landed + what's still pending (proxies the facade → ck minter `update_balance`).
//! - `GET  /api/v1/deposit/info?currency=N` — static deposit instructions (min confirmations, fee,
//!   min amount) so the sheet can render before showing the address.
//!
//! The three deposit routes map **any** `LedgerError` to `503` — there is no `422` path, because the
//! deposit proxy has no permanent-policy failure (no sig, no cap, no replay); see deposit plan §0.
//!
//! `safe_mode` is a wired-but-inert flag: the seam the demo flips to fall back to a degraded path.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use dpay_core::{Currency, SignedAuthorization, DEMO_USD, NONCE_LEN, PUBKEY_LEN};

use crate::ledger::{Ledger, LedgerError, MintedUtxo, PendingUtxo, Receipt, TxnRecord};

/// Retry policy for transient ledger errors (idempotency makes retries safe).
const MAX_ATTEMPTS: u32 = 3;
const BACKOFF: Duration = Duration::from_millis(20);

/// Shared relay state. `Arc<dyn Ledger>` is the settlement seam; `idempotency` caches receipts by
/// nonce so a duplicate submission is answered from cache and never re-settled.
#[derive(Clone)]
pub struct AppState {
    pub ledger: Arc<dyn Ledger>,
    idempotency: Arc<Mutex<HashMap<[u8; NONCE_LEN], Receipt>>>,
    /// Seam for the demo's degraded fallback. Wiring only for now.
    pub safe_mode: Arc<Mutex<bool>>,
    /// Whether `POST /api/v1/faucet` (which *mints*) is served. Defaults to `true` — harmless
    /// against the in-memory demo ledger this crate is normally exercised with. The binary turns it
    /// **off** whenever it settles on a real ledger unless `DPAY_ENABLE_FAUCET` says otherwise:
    /// against a canister with an open `mint`, an exposed faucet is an open money printer.
    faucet_enabled: Arc<Mutex<bool>>,
    /// The Android build served at `GET /download/dpay.apk`, when one is configured. `None` renders
    /// a "coming soon" CTA on the landing page and answers the download route with `404`.
    apk: Arc<Option<Vec<u8>>>,
    /// Content hash of the APK bytes, used as a `?v=` cache-buster on the download link so a new
    /// build invalidates the CDN cache immediately without manual cache purges.
    apk_version: String,
}

impl AppState {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        AppState {
            ledger,
            idempotency: Arc::new(Mutex::new(HashMap::new())),
            safe_mode: Arc::new(Mutex::new(false)),
            faucet_enabled: Arc::new(Mutex::new(true)),
            apk: Arc::new(None),
            apk_version: String::new(),
        }
    }

    /// Attach the Android build to serve at `GET /download/dpay.apk` (and light up the landing
    /// page's download CTA). `None` leaves it disabled.
    pub fn with_apk(mut self, apk: Option<Vec<u8>>) -> Self {
        if let Some(ref bytes) = apk {
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            self.apk_version = format!("{:x}", h.finish());
        }
        self.apk = Arc::new(apk);
        self
    }

    pub fn set_safe_mode(&self, on: bool) {
        *self.safe_mode.lock().unwrap() = on;
    }

    pub fn safe_mode(&self) -> bool {
        *self.safe_mode.lock().unwrap()
    }

    pub fn set_faucet_enabled(&self, on: bool) {
        *self.faucet_enabled.lock().unwrap() = on;
    }

    pub fn faucet_enabled(&self) -> bool {
        *self.faucet_enabled.lock().unwrap()
    }
}

/// Build the router. No socket is bound here — tests drive it via `tower::ServiceExt::oneshot`,
/// `main` wraps it with a listener.
pub fn app(state: AppState) -> Router {
    let api: Router<AppState> = Router::new()
        .route("/pay", post(pay))
        .route("/faucet", post(faucet))
        .route("/balance/{hex}", get(balance))
        .route("/transactions/{hex}", get(transactions))
        .route("/receipt/{nonce}", get(receipt))
        .route("/deposit/address/{hex}", get(deposit_address))
        .route("/deposit/refresh/{hex}", post(deposit_refresh))
        .route("/deposit/info", get(deposit_info))
        .route("/health", get(health));

    // Test-only deposit-seed route (feature-gated so it CANNOT compile into the prod image). The
    // local e2e harness builds the relay with `--features test-helpers` and POSTs here to simulate
    // a confirmed ckBTC deposit landing; the prod image (`just image`) never enables the feature,
    // so the route is absent and unreachable.
    #[cfg(feature = "test-helpers")]
    let api = api.route("/test/deposit/seed", post(test_deposit_seed));

    Router::new()
        .route("/", get(landing_page))
        .route("/download/dpay.apk", get(apk_download))
        .route("/merchant", get(merchant_page))
        .route("/jsqr.js", get(jsqr_js))
        .route("/qrcode.js", get(qrcode_js))
        .route("/shots/{name}", get(screenshot))
        .nest("/api/v1", api)
        .with_state(state)
}

/// `POST /api/v1/faucet` JSON `{account: <hex>, currency?, amount?}` → `{balance}`. Demo on-ramp:
/// funds a phone's freshly-generated account so it can pay. Defaults: `currency = DEMO_USD` (0),
/// `amount = 10_000` ($100.00) when either is omitted.
///
/// **Mints.** Served only when [`AppState::faucet_enabled`]; otherwise `404`, as if the route did
/// not exist. The relay binary disables it by default on the real-ledger path.
async fn faucet(State(state): State<AppState>, Json(req): Json<FaucetRequest>) -> Response {
    if !state.faucet_enabled() {
        return err(StatusCode::NOT_FOUND, "faucet disabled");
    }
    let bytes = match hex::decode(req.account.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "account must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    // Currency defaults to DEMO_USD — the faucet's whole point is play money for the demo. A missing
    // amount is the demo's $100.00 top-up.
    let currency = req.currency.unwrap_or(DEMO_USD);
    let amount = req.amount.unwrap_or(10_000);
    match state.ledger.mint(pk, currency, amount).await {
        Ok(bal) => (StatusCode::OK, Json(BalanceBody { balance: bal })).into_response(),
        // Mirror `pay`: a permanent/`Rejected` error (e.g. "not mintable", "unauthorized" — a policy
        // failure, not a transient infra hiccup) is `422`; only a genuine `Transient` is `503`. The
        // relay must not signal "try again" for a rejection that will never succeed.
        Err(LedgerError::Rejected(msg)) => err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => {
            err(StatusCode::SERVICE_UNAVAILABLE, format!("ledger unavailable: {msg}"))
        }
    }
}

/// `GET /api/v1/receipt/{nonce}` → `200 {receipt, replayed}` if that request_id (nonce) has
/// settled, else `404`. Lets the merchant terminal poll for an on-chain completion when the payer paid directly
/// (online), instead of scanning the payer's QR.
async fn receipt(State(state): State<AppState>, Path(nonce_hex): Path<String>) -> Response {
    let bytes = match hex::decode(nonce_hex.trim()) {
        Ok(b) if b.len() == NONCE_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "nonce must be 16 bytes hex"),
    };
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes);
    match state.idempotency.lock().unwrap().get(&nonce).cloned() {
        Some(rc) => (StatusCode::OK, Json(PayOk { receipt: rc, replayed: true })).into_response(),
        None => err(StatusCode::NOT_FOUND, "not settled"),
    }
}

/// `GET /api/v1/balance/{hex}?currency=<u32>` → `{"balance": <minor units>}` for a 32-byte
/// pubkey (hex). Lets the payer's wallet show its live balance when it can reach the relay.
///
/// `currency` is an optional query param defaulting to `DEMO_USD` (0) — the demo's only asset — so
/// existing callers that don't name a currency keep working unchanged. A wallet holding multiple
/// assets asks once per currency.
async fn balance(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<BalanceQuery>,
) -> Response {
    let bytes = match hex::decode(hex_pk.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "pubkey must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    let currency = qs.currency.unwrap_or(DEMO_USD);
    match state.ledger.balance(pk, currency).await {
        Ok(bal) => (StatusCode::OK, Json(BalanceBody { balance: bal })).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /api/v1/transactions/{hex}?currency=N&limit=30` → `{"transactions": [...]}` newest-first.
/// Lets the wallet render a durable transaction list sourced from the ledger (the in-memory UI list
/// is gone on restart; this is the source of truth). `limit` defaults to 30 and is capped at 100.
async fn transactions(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<TransactionsQuery>,
) -> Response {
    let bytes = match hex::decode(hex_pk.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "pubkey must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    let currency = qs.currency.unwrap_or(DEMO_USD);
    let limit = qs.limit.unwrap_or(30).min(100);
    match state.ledger.transactions_of(pk, currency, limit).await {
        Ok(rows) => (StatusCode::OK, Json(TransactionsBody { transactions: rows })).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /api/v1/deposit/address/{hex}?currency=N` → `200 {"address": "..."}` for a 32-byte pubkey
/// (hex). The ckBTC-style deposit address the user sends native BTC to (the facade proxies the ck
/// minter's per-principal `get_btc_address`). `currency` defaults to `DEMO_USD` for the same reason
/// `balance` does: callers that don't name one keep working. A ledger error → `503` (no `422`; the
/// deposit surface has no permanent-policy failure — deposit plan §0).
async fn deposit_address(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<BalanceQuery>,
) -> Response {
    let bytes = match hex::decode(hex_pk.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "pubkey must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    let currency = qs.currency.unwrap_or(DEMO_USD);
    match state.ledger.deposit_address(pk, currency).await {
        Ok(addr) => (StatusCode::OK, Json(DepositAddressBody { address: addr })).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `POST /api/v1/deposit/refresh/{hex}?currency=N` → `200 {"minted":[...],"minted_total":N,
/// "pending":[...],"required_confirmations":N}`. Mints any now-confirmed UTXOs for the account
/// (proxies the facade → ck minter `update_balance`); the wallet polls this from the "Add money"
/// sheet and re-reads its balance when `minted_total > 0`. Path/query parsing mirrors `balance`;
/// any ledger error → `503` (deposit plan §0).
async fn deposit_refresh(
    State(state): State<AppState>,
    Path(hex_pk): Path<String>,
    Query(qs): Query<BalanceQuery>,
) -> Response {
    let bytes = match hex::decode(hex_pk.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "pubkey must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    let currency = qs.currency.unwrap_or(DEMO_USD);
    match state.ledger.deposit_status(pk, currency).await {
        Ok(r) => (StatusCode::OK, Json(DepositRefreshBody {
            minted: r.minted,
            minted_total: r.minted_total,
            pending: r.pending,
            required_confirmations: r.required_confirmations,
        }))
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
        Ok(i) => (StatusCode::OK, Json(DepositInfoBody {
            min_confirmations: i.min_confirmations,
            deposit_fee: i.deposit_fee,
            deposit_min_amount: i.deposit_min_amount,
        }))
            .into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `POST /api/v1/test/deposit/seed` (feature `test-helpers` ONLY — never in the prod image).
///
/// JSON `{account: <hex>, currency?: N, amount: U64}` → seeds a pending deposit on the FakeLedger
/// (mirrors `register_deposit` — drain-on-next-`deposit_status`). Lets a browser e2e harness
/// simulate a confirmed ckBTC deposit landing and then assert the credited path through the REAL
/// relay + REAL FakeLedger settlement. Path/account parsing mirrors `balance`/`faucet`; any ledger
/// error → `503` (like the other deposit routes — no `422` path, deposit plan §0). Returns `200
/// {"seeded": true}` on success.
#[cfg(feature = "test-helpers")]
async fn test_deposit_seed(
    State(state): State<AppState>,
    Json(req): Json<DepositSeedRequest>,
) -> Response {
    let bytes = match hex::decode(req.account.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "account must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    let currency = req.currency.unwrap_or(DEMO_USD);
    match state.ledger.seed_deposit(pk, currency, req.amount).await {
        Ok(()) => (StatusCode::OK, Json(DepositSeedBody { seeded: true })).into_response(),
        // Mirror the deposit routes: any LedgerError → 503. seed_deposit on FakeLedger is infallible
        // in practice, but the default trait impl returns Rejected — surface it honestly rather than
        // swallowing.
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
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
/// is configured.
async fn apk_download(State(state): State<AppState>) -> Response {
    match state.apk.as_ref() {
        Some(bytes) => (
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
                (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
            ],
            bytes.clone(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "no build available").into_response(),
    }
}

/// `GET /merchant` — the merchant terminal (webcam QR scan + paste fallback, submits to
/// `/api/v1/pay`). Self-contained + same-origin, so no CORS and no external assets needed.
async fn merchant_page() -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("../assets/merchant.html"),
    )
        .into_response()
}

/// `GET /jsqr.js` — the vendored QR decoder the terminal loads (offline; no CDN).
async fn jsqr_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../assets/jsQR.js"),
    )
        .into_response()
}

/// `GET /shots/{name}` — the real app screenshots the landing page shows (offline; no CDN). The
/// flow rails now step through real phone screens, so the NFC tap states and the post-scan review
/// view are served alongside the original QR/Pay/Paid trio. Anything else is a clean `404`.
async fn screenshot(Path(name): Path<String>) -> Response {
    let bytes: &'static [u8] = match name.as_str() {
        "request.png" => include_bytes!("../assets/shot-request.png"),
        "approve.png" => include_bytes!("../assets/shot-approve.png"),
        "paid.png" => include_bytes!("../assets/shot-paid.png"),
        "nfc-listen.png" => include_bytes!("../assets/shot-nfc-listen.png"),
        "nfc-exchange.png" => include_bytes!("../assets/shot-nfc-exchange.png"),
        "nfc-paid.png" => include_bytes!("../assets/shot-nfc-paid.png"),
        "scanned.png" => include_bytes!("../assets/shot-scanned.png"),
        _ => return err(StatusCode::NOT_FOUND, "no such screenshot"),
    };
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

/// `GET /qrcode.js` — the vendored QR *encoder* (for the merchant's request QR; offline, no CDN).
async fn qrcode_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../assets/qrcode.js"),
    )
        .into_response()
}

// ---- request / response bodies ----

/// `POST /api/v1/pay` JSON body: the QR string. We also accept raw wire bytes (see `pay`), so this
/// is only used on the JSON path.
#[derive(Deserialize)]
struct PayRequest {
    qr: String,
}

#[derive(Deserialize)]
struct FaucetRequest {
    account: String,
    /// Settlement currency to mint. Defaults to `DEMO_USD` when absent (the demo's play money).
    #[serde(default)]
    currency: Option<Currency>,
    amount: Option<u64>,
}

/// `?currency=N` for `GET /api/v1/balance/{hex}`. Absent → `DEMO_USD`.
#[derive(Deserialize)]
struct BalanceQuery {
    currency: Option<Currency>,
}

/// `?currency=N&limit=30` for `GET /api/v1/transactions/{hex}`. Absent currency → `DEMO_USD`;
/// absent limit → 30 (capped at 100 server-side).
#[derive(Deserialize)]
struct TransactionsQuery {
    currency: Option<Currency>,
    limit: Option<u32>,
}

#[derive(Serialize)]
struct PayOk {
    receipt: Receipt,
    /// True when this nonce was already settled and the receipt came from the idempotency cache —
    /// lets the terminal say "already paid, not charged twice" instead of a second "Paid ✓".
    replayed: bool,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
}

#[derive(Serialize)]
struct BalanceBody {
    balance: u64,
}

/// `GET /api/v1/transactions/{hex}` response body. Direction (in/out) is derived client-side by
/// comparing the queried account's pubkey to each row's `from` (hex).
#[derive(Serialize)]
struct TransactionsBody {
    transactions: Vec<TxnRecord>,
}

/// `GET /api/v1/deposit/address/{hex}` response body — the native-chain deposit address.
#[derive(Serialize)]
struct DepositAddressBody {
    address: String,
}

/// `POST /api/v1/deposit/refresh/{hex}` response body — mirrors [`crate::ledger::DepositRefresh`].
/// `minted_total > 0` means ck-asset was just credited; the wallet then re-reads its balance.
#[derive(Serialize)]
struct DepositRefreshBody {
    minted: Vec<MintedUtxo>,
    minted_total: u64,
    pending: Vec<PendingUtxo>,
    required_confirmations: u32,
}

/// `GET /api/v1/deposit/info` response body — static deposit instructions.
#[derive(Serialize)]
struct DepositInfoBody {
    min_confirmations: u32,
    deposit_fee: u64,
    deposit_min_amount: Option<u64>,
}

/// `POST /api/v1/test/deposit/seed` request body (feature `test-helpers` ONLY). `currency` defaults
/// to `DEMO_USD` when absent, matching `balance`/`faucet`.
#[cfg(feature = "test-helpers")]
#[derive(Deserialize)]
struct DepositSeedRequest {
    account: String,
    #[serde(default)]
    currency: Option<Currency>,
    amount: u64,
}

/// `POST /api/v1/test/deposit/seed` response body.
#[cfg(feature = "test-helpers")]
#[derive(Serialize)]
struct DepositSeedBody {
    seeded: bool,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ErrorBody { error: msg.into() })).into_response()
}

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

/// `POST /api/v1/pay`. Body is either JSON `{"qr":"<base64url>"}` or the raw 196-byte wire form
/// (any non-JSON content type). Returns `200 {"receipt":...}` or `422 {"error":"..."}`.
async fn pay(State(state): State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    // 1. Get the wire bytes from whichever encoding the merchant sent.
    let sa = match decode_body(&headers, &body) {
        Ok(sa) => sa,
        Err(e) => return err(StatusCode::UNPROCESSABLE_ENTITY, e),
    };
    let nonce = sa.auth.nonce;
    let wire = sa.to_wire().to_vec();

    // 2. Idempotency: if we've already settled this nonce, replay the cached receipt verbatim.
    //    Never touch the ledger again.
    if let Some(cached) = state.idempotency.lock().unwrap().get(&nonce).cloned() {
        return (StatusCode::OK, Json(PayOk { receipt: cached, replayed: true })).into_response();
    }

    // 3. Settle, retrying transient failures with small backoff. (Idempotency at the ledger — the
    //    single-use nonce — means a retry can never double-charge even if a prior attempt partly
    //    landed; here it can't, since Transient is returned before any commit.)
    let receipt = match settle_with_retry(&state, wire).await {
        Ok(r) => r,
        Err(LedgerError::Rejected(msg)) => return err(StatusCode::UNPROCESSABLE_ENTITY, msg),
        Err(LedgerError::Transient(msg)) => {
            // Exhausted retries — report as unavailable, not a client error.
            return err(StatusCode::SERVICE_UNAVAILABLE, format!("ledger unavailable: {msg}"));
        }
    };

    // 4. Cache under the nonce (guard against a race that settled the same nonce concurrently:
    //    keep whatever landed first).
    {
        let mut idem = state.idempotency.lock().unwrap();
        let stored = idem.entry(nonce).or_insert_with(|| receipt.clone()).clone();
        return (StatusCode::OK, Json(PayOk { receipt: stored, replayed: false })).into_response();
    }
}

/// Decode the body to a `SignedAuthorization`. JSON content type → `{"qr": ...}` (base64url);
/// anything else → raw wire bytes. Errors are human-readable strings for the `422` body.
fn decode_body(headers: &HeaderMap, body: &[u8]) -> Result<SignedAuthorization, String> {
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.starts_with("application/json"))
        .unwrap_or(false);

    if is_json {
        let req: PayRequest =
            serde_json::from_slice(body).map_err(|e| format!("bad JSON body: {e}"))?;
        SignedAuthorization::decode(&req.qr).map_err(|e| format!("bad qr: {e:?}"))
    } else {
        SignedAuthorization::from_wire(body).map_err(|e| format!("bad wire body: {e:?}"))
    }
}

/// Call `ledger.pay`, retrying only `Transient` errors up to `MAX_ATTEMPTS` with a small backoff.
/// `Rejected` and success short-circuit immediately.
async fn settle_with_retry(state: &AppState, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
    let mut last: Option<LedgerError> = None;
    for attempt in 0..MAX_ATTEMPTS {
        match state.ledger.pay(wire.clone()).await {
            Ok(r) => return Ok(r),
            Err(LedgerError::Rejected(m)) => return Err(LedgerError::Rejected(m)),
            Err(t @ LedgerError::Transient(_)) => {
                last = Some(t);
                // Don't sleep after the final attempt.
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(BACKOFF).await;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| LedgerError::Transient("no attempts".into())))
}
