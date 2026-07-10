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

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use dpay_core::{SignedAuthorization, NONCE_LEN};

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
}

impl AppState {
    pub fn new(ledger: Arc<dyn Ledger>) -> Self {
        AppState {
            ledger,
            idempotency: Arc::new(Mutex::new(HashMap::new())),
            safe_mode: Arc::new(Mutex::new(false)),
        }
    }

    pub fn set_safe_mode(&self, on: bool) {
        *self.safe_mode.lock().unwrap() = on;
    }

    pub fn safe_mode(&self) -> bool {
        *self.safe_mode.lock().unwrap()
    }
}

/// Build the router. No socket is bound here — tests drive it via `tower::ServiceExt::oneshot`,
/// `main` wraps it with a listener.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/pay", post(pay))
        .route("/health", get(health))
        .with_state(state)
}

// ---- request / response bodies ----

/// `POST /pay` JSON body: the QR string. We also accept raw wire bytes (see `pay`), so this is
/// only used on the JSON path.
#[derive(Deserialize)]
struct PayRequest {
    qr: String,
}

#[derive(Serialize)]
struct PayOk {
    receipt: Receipt,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
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
        return (StatusCode::OK, Json(PayOk { receipt: cached })).into_response();
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
        return (StatusCode::OK, Json(PayOk { receipt: stored })).into_response();
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
