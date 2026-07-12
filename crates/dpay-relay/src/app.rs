//! The relay's HTTP surface.
//!
//! Two routes, both driven by the merchant phone:
//! - `POST /pay` — hands the payer's signed-authorization QR to the ledger and returns a receipt.
//!   Two properties matter for the demo and are enforced here (not in the ledger):
//!   * **Idempotency** — keyed by the authorization nonce (the merchant's `request_id`). A repeat
//!     submission returns the *same cached receipt* and never settles twice. This makes the
//!     merchant's "scan → submit" safe to mash / auto-retry.
//!   * **Retries** — a `LedgerError::Transient` is retried a few times with small backoff;
//!     a `Rejected` is final and becomes `422`.
//! - `GET /health` — the merchant's pre-flight green dot; consults `ledger.healthy()`.
//!
//! `safe_mode` is a wired-but-inert flag: the seam the demo flips to fall back to a degraded path.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use dpay_core::{SignedAuthorization, NONCE_LEN, PUBKEY_LEN};

use crate::ledger::{Ledger, LedgerError, Receipt};

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
    /// Whether `POST /faucet` (which *mints*) is served. Defaults to `true` — harmless against the
    /// in-memory demo ledger this crate is normally exercised with. The binary turns it **off**
    /// whenever it settles on a real ledger unless `DPAY_ENABLE_FAUCET` says otherwise: against a
    /// canister with an open `mint`, an exposed faucet is an open money printer.
    faucet_enabled: Arc<Mutex<bool>>,
}

impl AppState {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        AppState {
            ledger,
            idempotency: Arc::new(Mutex::new(HashMap::new())),
            safe_mode: Arc::new(Mutex::new(false)),
            faucet_enabled: Arc::new(Mutex::new(true)),
        }
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
    Router::new()
        .route("/", get(merchant_page))
        .route("/jsqr.js", get(jsqr_js))
        .route("/qrcode.js", get(qrcode_js))
        .route("/pay", post(pay))
        .route("/faucet", post(faucet))
        .route("/balance/{hex}", get(balance))
        .route("/receipt/{nonce}", get(receipt))
        .route("/health", get(health))
        .with_state(state)
}

/// `POST /faucet` JSON `{account: <hex>, amount?}` → `{balance}`. Demo on-ramp: funds a phone's
/// freshly-generated account so it can pay. Defaults to $100.00 when `amount` is omitted.
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
    let amount = req.amount.unwrap_or(10_000);
    match state.ledger.mint(pk, amount).await {
        Ok(bal) => (StatusCode::OK, Json(BalanceBody { balance: bal })).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /receipt/{nonce}` → `200 {receipt, replayed}` if that request_id (nonce) has settled, else
/// `404`. Lets the merchant terminal poll for an on-chain completion when the payer paid directly
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

/// `GET /balance/{hex}` → `{"balance": <minor units>}` for a 32-byte pubkey (hex). Lets the payer's
/// wallet show its live balance when it can reach the relay.
async fn balance(State(state): State<AppState>, Path(hex_pk): Path<String>) -> Response {
    let bytes = match hex::decode(hex_pk.trim()) {
        Ok(b) if b.len() == PUBKEY_LEN => b,
        _ => return err(StatusCode::BAD_REQUEST, "pubkey must be 32 bytes hex"),
    };
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(&bytes);
    match state.ledger.balance(pk).await {
        Ok(bal) => (StatusCode::OK, Json(BalanceBody { balance: bal })).into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, format!("{e}")),
    }
}

/// `GET /` — the merchant terminal (webcam QR scan + paste fallback, submits to `/pay`).
/// Self-contained + same-origin, so no CORS and no external assets needed for the demo.
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

/// `GET /qrcode.js` — the vendored QR *encoder* (for the merchant's request QR; offline, no CDN).
async fn qrcode_js() -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../assets/qrcode.js"),
    )
        .into_response()
}

// ---- request / response bodies ----

/// `POST /pay` JSON body: the QR string. We also accept raw wire bytes (see `pay`), so this is
/// only used on the JSON path.
#[derive(Deserialize)]
struct PayRequest {
    qr: String,
}

#[derive(Deserialize)]
struct FaucetRequest {
    account: String,
    amount: Option<u64>,
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

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ErrorBody { error: msg.into() })).into_response()
}

/// `GET /health` → `200 {"status":"ok"}` when the ledger reports healthy, else `503`.
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

/// `POST /pay`. Body is either JSON `{"qr":"<base64url>"}` or the raw 192-byte wire form
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
