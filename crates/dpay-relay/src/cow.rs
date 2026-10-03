//! The CoW Protocol order-API proxy — `POST /api/v1/cow/mainnet/quote`,
//! `POST /api/v1/cow/mainnet/orders` and `GET /api/v1/cow/mainnet/orders/{uid}`
//! (the second EVM venue, 2026-10-03; the `crate::jupiter` twin, module for module).
//!
//! CoW Swap (`api.cow.fi/mainnet`) is the keyless off-chain order venue behind the
//! Convert surface's second EVM row: the device signs an EIP-712 order offline, POSTs it
//! here, and polls the same path until the solvers settle it. Every method is KEYLESS —
//! no credential, no account, nothing to hold server-side — so like Jupiter there is NO
//! 503 state: these routes are registered on every build and always serve. What the relay
//! adds is the one egress point for the venue (the house pattern: venue HTTP rides the
//! relay, never the device — the EVM RPC pipe's own doctrine, R2).
//!
//! # What this module serves
//!
//! All three routes are BYTE-FAITHFUL PIPES and never cached:
//! - `POST …/quote` — the quote ask carries the trader's own address and exact amounts;
//!   a cached answer would price one wallet's order for another (and the venue prices
//!   per-block). The reply's fee/price figures are the venue's own, passed verbatim.
//! - `POST …/orders` — an order submission is a WRITE (it mints the order UID); writes
//!   are never replayed or deduped here.
//! - `GET …/orders/{uid}` — the status poll feeds the record's settle decision; a stale
//!   answer could park a fulfilled order (or worse, call one done early). Fresh, always.
//!
//! # Failure semantics (same contract as `crate::jupiter` / `crate::solana`)
//!
//! - Upstream HTTP error status → SAME status, upstream body VERBATIM (the venue's own
//!   `{"errorType": …, "description": …}` shape — whatever refused is the venue, not us).
//! - Transport death (connect/timeout) → 504 carrying the body marker
//!   `{"dpayRelayError":"cow-upstream-unreachable","detail":"…"}`. The detail is a
//!   category ("timed out after N ms" / "connection failed" / "request failed"), never
//!   the error text: a reqwest error embeds the request URL.
//! - No 503 state exists: the upstream is keyless and its base has a constant default.
//!   Only a SET-but-malformed `DPAY_COW_API_BASE` refuses startup (EXIT_CONFIG in main.rs).
//! - The `{uid}` path segment is validated (56-byte order-UID hex) before any upstream
//!   call: a malformed uid is a client bug (400, house shape), not a venue question.
//! - Redirects are not followed: exactly one hop, surfaced not chased.
//!
//! # Secrets
//!
//! `DPAY_COW_API_BASE` is deploy config but carries NO credential (the venue is keyless);
//! it is still never logged or echoed, and every error body in this module is a fixed
//! string for exactly that reason.

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;

/// The CoW Protocol order-API base (the keyless mainnet host the venue documents).
/// Overridable via `DPAY_COW_API_BASE` (main.rs): the offline loop points it at the
/// relay's own test stub, and an operator may pin a different base. NOT a secret —
/// no credential exists. Other chains would be other paths under the same host
/// (`/gnosis`, `/arbitrum_one`); dpay serves mainnet only (the row's chain is 1).
pub const DEFAULT_API_BASE: &str = "https://api.cow.fi/mainnet";

/// Per-upstream-call timeout. Quote/order/status are single round trips; no env knob
/// (same reasoning as the jupiter proxy — this surface does not ride a poll loop
/// faster than its own cadence).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// The relay-originated marker code for transport death (the client's failure-vocabulary
/// contract: this code maps to `unreachable`, while an upstream's own status keeps its own
/// meaning). Stable by contract — do not rename without the app client.
pub const UPSTREAM_UNREACHABLE: &str = "cow-upstream-unreachable";

/// The order-UID shape this proxy forwards: `0x` + 112 hex (56 bytes — the packed
/// orderDigest(32) ‖ owner(20) ‖ validTo(4) the settlement contract defines). Anything
/// else never reaches the venue.
pub fn is_valid_order_uid(uid: &str) -> bool {
    let Some(hex) = uid.strip_prefix("0x") else {
        return false;
    };
    hex.len() == 112 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The proxy's state: the upstream base, the shared HTTP client and the per-call
/// timeout. Held in an `Arc` on [`AppState`]. No cache by design (module header).
pub struct CowProxy {
    base: String,
    timeout: Duration,
    client: reqwest::Client,
}

impl CowProxy {
    /// Build the proxy. There is no unconfigured state (module header): the base always
    /// has a value (the constant default, the env override, or the test stub).
    pub fn new(base: String, timeout: Duration) -> Self {
        CowProxy {
            base,
            timeout,
            client: http_client(),
        }
    }
}

/// `POST /api/v1/cow/mainnet/quote` — the quote ask, piped verbatim, never cached.
pub async fn quote_proxy(State(state): State<AppState>, body: Bytes) -> Response {
    let proxy = state.cow.clone();
    let outcome = post_upstream(&proxy, "/api/v1/quote", body).await;
    json_response(outcome.status, &outcome.body)
}

/// `POST /api/v1/cow/mainnet/orders` — the signed-order submission, piped verbatim,
/// never cached or deduped (a write).
pub async fn orders_proxy(State(state): State<AppState>, body: Bytes) -> Response {
    let proxy = state.cow.clone();
    let outcome = post_upstream(&proxy, "/api/v1/orders", body).await;
    json_response(outcome.status, &outcome.body)
}

/// `GET /api/v1/cow/mainnet/orders/{uid}` — the status poll. The uid is shape-checked
/// BEFORE any upstream call; a malformed one is the client's bug, not the venue's.
pub async fn order_status_proxy(State(state): State<AppState>, Path(uid): Path<String>) -> Response {
    let proxy = state.cow.clone();
    if !is_valid_order_uid(&uid) {
        return err(
            StatusCode::BAD_REQUEST,
            "order uid must be 0x + 112 hex chars (the 56-byte packed order UID)",
        );
    }
    let url = format!("{}/api/v1/orders/{}", proxy.base, uid);
    let attempt = proxy
        .client
        .get(&url)
        .header(header::ACCEPT, "application/json")
        .timeout(proxy.timeout)
        .send()
        .await;
    let response = match attempt {
        Ok(r) => r,
        Err(e) => return transport_refusal(&proxy, e).into_response(),
    };
    let status = response.status();
    let body = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(e) => return transport_refusal(&proxy, e).into_response(),
    };
    json_response(status, &body)
}

/// One upstream POST: `{base}{path}` with the device's ORIGINAL body bytes, answered with
/// the upstream's status + body verbatim — or the fixed 504 marker for transport trouble.
async fn post_upstream(proxy: &CowProxy, path: &str, body: Bytes) -> Outcome {
    let url = format!("{}{}", proxy.base, path);
    let attempt = proxy
        .client
        .post(&url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .timeout(proxy.timeout)
        .body(body)
        .send()
        .await;
    let response = match attempt {
        Ok(r) => r,
        Err(e) => return transport_refusal(proxy, e),
    };
    let status = response.status();
    match response.bytes().await {
        Ok(bytes) => Outcome {
            status,
            body: bytes,
        },
        Err(e) => transport_refusal(proxy, e),
    }
}

/// One completed upstream call: status + body (the verbatim-passthrough currency of this
/// module — same shape as `crate::jupiter`).
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

impl IntoResponse for Outcome {
    fn into_response(self) -> Response {
        json_response(self.status, &self.body)
    }
}

/// The honest answer when the venue could not be reached: a 504 carrying the
/// relay-originated marker, category only (never the error, never the URL) — the
/// jupiter proxy's own refusal, with this venue's marker code.
fn transport_refusal(proxy: &CowProxy, e: reqwest::Error) -> Outcome {
    let why = if e.is_timeout() {
        format!("timed out after {} ms", proxy.timeout.as_millis())
    } else if e.is_connect() {
        "connection failed".to_string()
    } else {
        "request failed".to_string()
    };
    Outcome {
        status: StatusCode::GATEWAY_TIMEOUT,
        body: relay_error_body(
            UPSTREAM_UNREACHABLE,
            &format!("cow upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract shared with
/// `crate::solana` / `crate::jupiter`: `{"dpayRelayError": <code>, "detail": <short
/// human phrase>}`. Fixed inputs only (categories), so nothing of the request can leak.
fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(json!({"dpayRelayError": code, "detail": detail}).to_string())
}

/// The shared HTTP client (one per process; redirects NOT followed — exactly one hop,
/// surfaced not chased).
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the cow proxy's HTTP client")
        })
        .clone()
}

/// House error shape (`{"error": …}`, application/json) — client bugs, not relay-path facts.
fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    use axum::Json;
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

/// A body-carrying response with a fixed status, `application/json` by contract.
fn json_response(status: StatusCode, body: &Bytes) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.clone(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_uid_shape_is_the_56_byte_packed_form() {
        // The packed order UID: orderDigest(32) ‖ owner(20) ‖ validTo(4) — 56 bytes, 112 hex.
        let uid = format!("0x{}", "ab".repeat(56));
        assert!(is_valid_order_uid(&uid));
        assert!(!is_valid_order_uid(&format!("0x{}", "ab".repeat(55))));
        assert!(!is_valid_order_uid(&format!("0x{}", "ab".repeat(57))));
        assert!(!is_valid_order_uid(&format!("{}", "ab".repeat(56)))); // no 0x
        assert!(!is_valid_order_uid("0xzz…")); // not hex
    }
}
