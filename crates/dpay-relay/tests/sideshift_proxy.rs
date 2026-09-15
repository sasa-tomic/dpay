//! The SideShift partner-key proxy (`POST /api/v1/sideshift/quotes` +
//! `POST /api/v1/sideshift/shifts/fixed`) — offline integration tests, same idioms as
//! `tests/solana_proxy.rs`: `test-helpers` is always on for integration tests (the
//! dev-dependency self-reference), the suite drives the axum `Router` directly with
//! `tower::ServiceExt::oneshot`, and the "upstream" is a REAL loopback `TcpListener`
//! running an in-process axum stub — no packet leaves the machine, the suite stays
//! offline and seconds-fast. The stub's canned credential is a FAKE partner secret
//! (`stub-partner-secret`) so every "the secret is never echoed" assertion has teeth.
//!
//! Pinned here, in order:
//! - the 503-not-404 contract: unconfigured AND half-configured proxies answer 503
//!   carrying the `dpayRelayError` marker, naming exactly the missing variable(s)
//!   (`DPAY_SIDESHIFT_SECRET` / `DPAY_SIDESHIFT_AFFILIATE_ID`), never touching any
//!   upstream;
//! - the credential attachment: the upstream sees `x-sideshift-secret` with the
//!   configured value and an `affiliateId` that came from CONFIG, never from the
//!   request — and `commissionRate` is the pinned `"0"` (the founder red line: dpay
//!   takes no cut), never a request-suppliable field;
//! - the pair allowlist: only the registered cross-rail pair (ICP principal ↔ SOL
//!   mint, both directions) reaches the upstream; anything else is a 400 house error
//!   with zero upstream hits;
//! - the quote wrap: a successful upstream answer comes back as
//!   `{"venue_id":"sideshift","quote":<venue body VERBATIM>,"fetched_at":<unix secs>}`
//!   (attribution + timestamp, numbers untouched), while upstream ERRORS pass through
//!   status+body verbatim (no wrap, no marker — whatever refused is the venue);
//! - fixed-order creation: verbatim passthrough both ways, `settleMemo` forwarded only
//!   when present;
//! - transport trouble: hang → 504 within the timeout, connection refused → 504, both
//!   with the `sideshift-upstream-unreachable` marker and NO URL or secret in the body.
//!
//! x-user-ip note: oneshot-driven requests carry no `ConnectInfo`, so these tests pin
//! the omit-don't-fabricate half (the stub sees NO x-user-ip header). The forwarding
//! half rides `into_make_service_with_connect_info` in main.rs and the e2e flow.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use dpay_relay::sideshift::{SideShiftProxy, DEFAULT_TIMEOUT};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The FAKE partner credential the stub upstream recognizes (and leak-asserts hunt).
const STUB_SECRET: &str = "stub-partner-secret";
const STUB_AFFILIATE: &str = "stub-affiliate-id";

const ICP: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SOL: &str = "So11111111111111111111111111111111111111112";

// ---- the stub upstream ----

/// The stub's shared state: per-route hit counts + the last request (headers snapshot
/// and body) each route received.
#[derive(Clone)]
struct Stub {
    quotes_hits: Arc<AtomicUsize>,
    shifts_hits: Arc<AtomicUsize>,
    last: Arc<Mutex<(HeaderMap, String)>>,
}

impl Stub {
    fn new() -> Self {
        Stub {
            quotes_hits: Arc::new(AtomicUsize::new(0)),
            shifts_hits: Arc::new(AtomicUsize::new(0)),
            last: Arc::new(Mutex::new((HeaderMap::new(), String::new()))),
        }
    }

    fn quotes_hits(&self) -> usize {
        self.quotes_hits.load(Ordering::SeqCst)
    }

    fn shifts_hits(&self) -> usize {
        self.shifts_hits.load(Ordering::SeqCst)
    }

    /// The most recent (headers, body) the stub received, on either route.
    fn last(&self) -> (HeaderMap, String) {
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// Record the arrival then answer with the venue's own wire shapes (docs.sideshift.ai,
/// verified live 2026-09-15): 201 with `{id, echoed pair fields, depositAmount,
/// settleAmount}` for /quotes and 201 with `{id, depositAddress, …, expiresAt}` for
/// /shifts/fixed.
async fn stub_quotes(State(stub): State<Stub>, headers: HeaderMap, body: Bytes) -> Response {
    stub.quotes_hits.fetch_add(1, Ordering::SeqCst);
    *stub.last.lock().unwrap_or_else(|p| p.into_inner()) =
        (headers.clone(), String::from_utf8_lossy(&body).into_owned());
    // The real venue's refusal shape for a bad credential — used by the error-passthrough
    // test by scripting the body below when needed. Happy path here.
    let req: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::json!({}));
    (
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "id": "stub-quote-1",
            "depositCoin": req.get("depositCoin").cloned().unwrap_or(serde_json::json!("ICP")),
            "settleCoin": req.get("settleCoin").cloned().unwrap_or(serde_json::json!("SOL")),
            "depositAmount": req.get("depositAmount").cloned().unwrap_or(serde_json::json!("2")),
            "settleAmount": "0.04959689",
            "rate": "0.0247984448",
        })
        .to_string(),
    )
        .into_response()
}

async fn stub_shifts_fixed(
    State(stub): State<Stub>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    stub.shifts_hits.fetch_add(1, Ordering::SeqCst);
    *stub.last.lock().unwrap_or_else(|p| p.into_inner()) =
        (headers.clone(), String::from_utf8_lossy(&body).into_owned());
    (
        StatusCode::CREATED,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "id": "stub-shift-1",
            "depositAddress": "stub-deposit-address-01",
            "depositAmount": "2",
            "settleAmount": "0.04959689",
            "expiresAt": "2026-09-16T00:00:00.000Z",
        })
        .to_string(),
    )
        .into_response()
}

/// Bind the stub on an ephemeral loopback port; return (its state, the API BASE the
/// relay should be given — the proxy appends `/quotes` and `/shifts/fixed`).
async fn spawn_stub() -> (Stub, String) {
    let stub = Stub::new();
    let router = Router::new()
        .route("/quotes", post(stub_quotes))
        .route("/shifts/fixed", post(stub_shifts_fixed))
        .with_state(stub.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind the stub upstream on an ephemeral loopback port");
    let addr = listener.local_addr().expect("ephemeral addr");
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("the stub upstream stays up");
    });
    (stub, format!("http://{addr}"))
}

// ---- the relay under test ----

fn state_with(proxy: SideShiftProxy) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_sideshift(proxy)
}

/// A fully configured proxy pointed at the given stub base.
fn configured(base: &str) -> SideShiftProxy {
    SideShiftProxy::new(
        Some(STUB_SECRET.into()),
        Some(STUB_AFFILIATE.into()),
        base.into(),
        DEFAULT_TIMEOUT,
    )
}

async fn post_json(
    state: &AppState,
    uri: &str,
    body: &str,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = axum::http::Request::builder()
        .method("POST")
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("build the sideshift request");
    let resp = app(state.clone())
        .oneshot(req)
        .await
        .expect("the router answers");
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp
        .into_body()
        .collect()
        .await
        .expect("read the response body")
        .to_bytes();
    (status, headers, bytes.to_vec())
}

/// Parse a relay-originated error body and return its `dpayRelayError` code.
fn relay_error_code(body: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(body)
        .expect("a relay-originated error body is JSON carrying the dpayRelayError marker");
    v["dpayRelayError"]
        .as_str()
        .expect("dpayRelayError is a string")
        .to_string()
}

fn quote_body(deposit: &str, settle: &str, amount: &str) -> String {
    serde_json::json!({
        "depositLedger": deposit,
        "settleLedger": settle,
        "depositAmount": amount,
    })
    .to_string()
}

// ---- the 503-not-404 contract ----

/// Unconfigured (both env vars unset): both routes answer 503 with the marker, naming
/// BOTH variables, without any upstream call existing to make.
#[tokio::test]
async fn unconfigured_answers_503_naming_both_variables() {
    let state = state_with(SideShiftProxy::new(
        None,
        None,
        "https://sideshift.example".into(),
        DEFAULT_TIMEOUT,
    ));
    for uri in ["/api/v1/sideshift/quotes", "/api/v1/sideshift/shifts/fixed"] {
        let (status, _h, body) = post_json(&state, uri, r#"{"x":1}"#).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(relay_error_code(&body), "sideshift-unconfigured", "{uri}");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("DPAY_SIDESHIFT_SECRET"), "{uri}: names the secret var");
        assert!(
            text.contains("DPAY_SIDESHIFT_AFFILIATE_ID"),
            "{uri}: names the affiliate var"
        );
    }
}

/// HALF-configured is the same honest 503, naming exactly the missing half — a stale
/// deploy must not serve a credential the venue will refuse anyway.
#[tokio::test]
async fn half_configured_names_exactly_the_missing_variable() {
    let secret_only = state_with(SideShiftProxy::new(
        Some("s".into()),
        None,
        "https://sideshift.example".into(),
        DEFAULT_TIMEOUT,
    ));
    let (status, _h, body) =
        post_json(&secret_only, "/api/v1/sideshift/quotes", &quote_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("DPAY_SIDESHIFT_SECRET\":"), "secret is set");
    assert!(text.contains("DPAY_SIDESHIFT_AFFILIATE_ID"));

    let affiliate_only = state_with(SideShiftProxy::new(
        None,
        Some("a".into()),
        "https://sideshift.example".into(),
        DEFAULT_TIMEOUT,
    ));
    let (status, _h, body) = post_json(
        &affiliate_only,
        "/api/v1/sideshift/quotes",
        &quote_body(ICP, SOL, "2"),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("DPAY_SIDESHIFT_SECRET"));
    assert!(!text.contains("DPAY_SIDESHIFT_AFFILIATE_ID\":"), "affiliate is set");
}

// ---- credential attachment + the quote wrap ----

/// Happy path: the upstream sees the secret header, the CONFIG's affiliateId and the
/// pinned commissionRate, the mapped coin/network codes and the deposit amount
/// verbatim; the device gets the attribution wrap with the venue's body untouched.
#[tokio::test]
async fn quote_attaches_credentials_and_wraps_the_venue_body_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let (status, headers, body) =
        post_json(&state, "/api/v1/sideshift/quotes", &quote_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(stub.quotes_hits(), 1, "exactly one upstream call");

    // What the VENUE saw: the secret header with the configured value, the config's
    // affiliateId + the pinned commission rate, the mapped codes, the amount verbatim.
    let (seen_headers, seen_body) = stub.last();
    assert_eq!(
        seen_headers.get("x-sideshift-secret").and_then(|v| v.to_str().ok()),
        Some(STUB_SECRET),
        "the partner secret rides the header, from config"
    );
    assert!(
        seen_headers.get("x-user-ip").is_none(),
        "oneshot requests carry no connection info — the IP is omitted, never fabricated"
    );
    let sent: serde_json::Value = serde_json::from_str(&seen_body).expect("upstream body is JSON");
    assert_eq!(sent["depositCoin"], "ICP");
    assert_eq!(sent["depositNetwork"], "icp");
    assert_eq!(sent["settleCoin"], "SOL");
    assert_eq!(sent["settleNetwork"], "solana");
    assert_eq!(sent["depositAmount"], "2", "amount forwarded verbatim");
    assert_eq!(sent["settleAmount"], serde_json::Value::Null);
    assert_eq!(
        sent["affiliateId"], STUB_AFFILIATE,
        "affiliateId from CONFIG, never the request"
    );
    assert_eq!(
        sent["commissionRate"], "0",
        "commissionRate pinned to zero — dpay takes no cut"
    );

    // What the DEVICE got: the attribution wrap, venue numbers untouched.
    let wrapped: serde_json::Value = serde_json::from_slice(&body).expect("wrap is JSON");
    assert_eq!(wrapped["venue_id"], "sideshift");
    assert!(
        wrapped["fetched_at"].as_u64().is_some(),
        "fetched_at is a unix-seconds timestamp"
    );
    assert_eq!(wrapped["quote"]["id"], "stub-quote-1");
    assert_eq!(wrapped["quote"]["settleAmount"], "0.04959689");
    assert_eq!(wrapped["quote"]["rate"], "0.0247984448");
    assert!(
        !String::from_utf8_lossy(&body).contains(STUB_SECRET),
        "the secret is never echoed"
    );
}

/// The registered pair is UNORDERED: SOL→ICP maps onto the venue's codes reversed.
#[tokio::test]
async fn quote_accepts_the_reverse_direction_of_the_registered_pair() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let (status, _h, body) =
        post_json(&state, "/api/v1/sideshift/quotes", &quote_body(SOL, ICP, "3.5")).await;
    assert_eq!(status, StatusCode::CREATED, "body: {}", String::from_utf8_lossy(&body));
    let (_seen_headers, seen_body) = stub.last();
    let sent: serde_json::Value = serde_json::from_str(&seen_body).unwrap();
    assert_eq!(sent["depositCoin"], "SOL");
    assert_eq!(sent["depositNetwork"], "solana");
    assert_eq!(sent["settleCoin"], "ICP");
    assert_eq!(sent["settleNetwork"], "icp");
    assert_eq!(sent["depositAmount"], "3.5");
}

/// The partner key is spendable on EXACTLY the registered pair: any other rail ids
/// (real ledgers included) are a 400 house error and never reach the upstream.
#[tokio::test]
async fn quote_refuses_unregistered_pairs_without_touching_the_upstream() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    // VCHF is a real IC ledger (a real pair member of icpswap) — still not THIS row's pair.
    for (deposit, settle) in [
        ("ly36x-wiaaa-aaaai-aqj7q-cai", SOL), // VCHF → SOL
        (ICP, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // ICP → USDC mint
        (ICP, ICP),                             // same asset both sides
    ] {
        let (status, _h, body) =
            post_json(&state, "/api/v1/sideshift/quotes", &quote_body(deposit, settle, "2")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{deposit}→{settle}");
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["error"].is_string(), "house error shape");
    }
    assert_eq!(stub.quotes_hits(), 0, "the venue was never asked");
}

/// Malformed device bodies are 400s refused BEFORE any upstream call.
#[tokio::test]
async fn quote_malformed_bodies_are_refused_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    for body in [
        "not json",
        r#"{"settleLedger": "x", "depositAmount": "1"}"#, // missing depositLedger
        r#"{"depositLedger": 7, "settleLedger": "x", "depositAmount": "1"}"#, // not a string
        &quote_body(ICP, SOL, "1,5"),  // not a decimal string
        &quote_body(ICP, SOL, "abc"),  // not an amount at all
    ] {
        let (status, _h, got) = post_json(&state, "/api/v1/sideshift/quotes", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        let v: serde_json::Value = serde_json::from_slice(&got).unwrap();
        assert!(v["error"].is_string(), "house error shape for {body}");
    }
    assert_eq!(stub.quotes_hits(), 0);
}

/// An upstream ERROR (SideShift's own `{"error":{message,code}}` shape) comes back with
/// the venue's status AND body verbatim — no wrap, no marker: whatever refused is the
/// venue, and the device should see the venue's own words for it.
#[tokio::test]
async fn upstream_error_passes_through_verbatim_unwrapped() {
    // A stub that always refuses with the venue's real 400 shape.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let venue_error = r#"{"error":{"message":"Invalid \"affiliateId\"","code":"BAD_USER_INPUT"}}"#;
    tokio::spawn(async move {
        let refuse = axum::Router::new().route(
            "/quotes",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    [(header::CONTENT_TYPE, "application/json")],
                    venue_error.to_string(),
                )
            }),
        );
        axum::serve(listener, refuse).await.unwrap();
    });
    let state = state_with(configured(&format!("http://{addr}")));

    let (status, _h, body) =
        post_json(&state, "/api/v1/sideshift/quotes", &quote_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, venue_error.as_bytes(), "body verbatim, no wrap, no marker");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.get("dpayRelayError").is_none());
    assert!(v.get("venue_id").is_none());
}

// ---- fixed-order creation ----

/// `/shifts/fixed` forwards quoteId + settleAddress (+settleMemo only when present)
/// with the config credentials, and passes the venue's 201 back VERBATIM — the
/// deposit address the user must send to is the venue's own answer, untouched.
#[tokio::test]
async fn shift_creation_forwards_and_passes_back_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let with_memo = serde_json::json!({
        "quoteId": "stub-quote-1",
        "settleAddress": "UserSolAddr1111111111111111111111111111111111",
        "settleMemo": "optional-memo",
    })
    .to_string();
    let (status, _h, body) = post_json(&state, "/api/v1/sideshift/shifts/fixed", &with_memo).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(stub.shifts_hits(), 1);
    let (_seen_headers, seen_body) = stub.last();
    let sent: serde_json::Value = serde_json::from_str(&seen_body).unwrap();
    assert_eq!(sent["quoteId"], "stub-quote-1");
    assert_eq!(sent["settleAddress"], "UserSolAddr1111111111111111111111111111111111");
    assert_eq!(sent["settleMemo"], "optional-memo");
    assert_eq!(sent["affiliateId"], STUB_AFFILIATE, "from config");

    // The device gets the venue's body byte-faithfully: id, depositAddress, expiresAt.
    let got: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(got["id"], "stub-shift-1");
    assert_eq!(got["depositAddress"], "stub-deposit-address-01");
    assert_eq!(got["expiresAt"], "2026-09-16T00:00:00.000Z");
    assert!(got.get("venue_id").is_none(), "orders are not quote surfaces — no wrap");

    // Without a memo, the field is simply absent upstream (ICP settles need none).
    let no_memo = serde_json::json!({
        "quoteId": "stub-quote-1",
        "settleAddress": "UserSolAddr1111111111111111111111111111111111",
    })
    .to_string();
    let (status, _h, _body) = post_json(&state, "/api/v1/sideshift/shifts/fixed", &no_memo).await;
    assert_eq!(status, StatusCode::CREATED);
    let (_seen_headers, seen_body) = stub.last();
    let sent: serde_json::Value = serde_json::from_str(&seen_body).unwrap();
    assert!(sent.get("settleMemo").is_none(), "absent memo is not forwarded");
}

/// Empty quoteId/settleAddress (or missing fields) are 400s before any upstream call.
#[tokio::test]
async fn shift_creation_refuses_malformed_bodies_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    for body in [
        r#"{"settleAddress": "x"}"#, // missing quoteId
        r#"{"quoteId": "", "settleAddress": "x"}"#, // empty quoteId
        r#"{"quoteId": "q", "settleAddress": ""}"#, // empty settleAddress
        "not json",
    ] {
        let (status, _h, got) = post_json(&state, "/api/v1/sideshift/shifts/fixed", body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        let v: serde_json::Value = serde_json::from_slice(&got).unwrap();
        assert!(v["error"].is_string());
    }
    assert_eq!(stub.shifts_hits(), 0);
}

// ---- transport trouble ----

/// A hanging upstream → 504 within the timeout, with the marker and NO URL or secret
/// anywhere in the body.
#[tokio::test]
async fn hanging_upstream_times_out_with_marker_and_no_leak() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let hang = axum::Router::new().route(
            "/quotes",
            post(|| async { std::future::pending::<Response>().await }),
        );
        axum::serve(listener, hang).await.unwrap();
    });
    // A short timeout so the test stays fast: the proxy under test is built directly.
    let state = state_with(SideShiftProxy::new(
        Some(STUB_SECRET.into()),
        Some(STUB_AFFILIATE.into()),
        format!("http://{addr}"),
        Duration::from_millis(300),
    ));

    let started = std::time::Instant::now();
    let (status, _h, body) =
        post_json(&state, "/api/v1/sideshift/quotes", &quote_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert!(started.elapsed() < Duration::from_secs(5), "the proxy's own timeout fires");
    assert_eq!(relay_error_code(&body), "sideshift-upstream-unreachable");
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains(STUB_SECRET), "no secret in the error");
    assert!(!text.contains(&addr.to_string()), "no URL in the error");
}

/// Connection refused (a port with no listener) → the same 504 marker.
#[tokio::test]
async fn connection_refused_is_a_504_with_marker() {
    // Bind then drop the listener: the port is (almost certainly) closed.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let state = state_with(configured(&format!("http://{addr}")));
    let (status, _h, body) =
        post_json(&state, "/api/v1/sideshift/quotes", &quote_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), "sideshift-upstream-unreachable");
    assert!(!body.iter().any(|b| *b == 0), "body is clean text");
}
