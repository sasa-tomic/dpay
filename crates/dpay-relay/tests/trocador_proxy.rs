//! The Trocador aggregator proxy (`POST /api/v1/trocador/rate`,
//! `POST /api/v1/trocador/trade`, `GET /api/v1/trocador/trade?id=`) — offline
//! integration tests, the `tests/sideshift_proxy.rs` idioms verbatim: `test-helpers`
//! is always on for integration tests (the dev-dependency self-reference), the suite
//! drives the axum `Router` directly with `tower::ServiceExt::oneshot`, and the
//! "upstream" is a REAL loopback `TcpListener` running an in-process axum stub — no
//! packet leaves the machine, the suite stays offline and seconds-fast. The stub's
//! canned credential is a FAKE partner key (`stub-partner-key`) so every "the key is
//! never echoed" assertion has teeth.
//!
//! Pinned here, in order:
//! - the 503-not-404 contract: an unconfigured proxy answers 503 on ALL THREE routes
//!   carrying the `dpayRelayError` marker and naming `DPAY_TROCADOR_API_KEY`, never
//!   touching any upstream;
//! - the key attachment + founder pins: the upstream sees `API-Key` with the configured
//!   value and `min_kycrating=A`, `markup=0`, `fixed=True`, `best_only=True` — all from
//!   relay-side constants, never from the request;
//! - the pair allowlist: only the `trocador` row's registered cross-rail pair (ICP
//!   principal ↔ SOL mint, both directions) reaches the upstream — notably NOT the
//!   pairs the SIDESHIFT rows trade, even though those are real cefi pairs (the pair
//!   disambiguates the row); anything else is a 400 house error with zero upstream hits;
//! - the rate wrap: a successful upstream answer comes back as
//!   `{"venue_id":"trocador","quote":<venue body VERBATIM>,"fetched_at":<unix secs>}`,
//!   while upstream ERRORS pass through status+body verbatim (no wrap, no marker);
//! - trade creation: verbatim passthrough both ways, and the refund-address fund-loss
//!   guard — a missing, empty, wrong-rail or malformed refund address is a 400 BEFORE
//!   any upstream call;
//! - the status proxy: `?id=` required (400 without one), verbatim passthrough with the
//!   key attached — the route the record's statusUrl polls;
//! - transport trouble: hang → 504 within the timeout, connection refused → 504, both
//!   with the `trocador-upstream-unreachable` marker and NO URL or key in the body.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use dpay_relay::trocador::{TrocadorProxy, DEFAULT_TIMEOUT};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The FAKE partner credential the stub upstream recognizes (and leak-asserts hunt).
const STUB_KEY: &str = "stub-partner-key";

const ICP: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SOL: &str = "So11111111111111111111111111111111111111112";
const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// A real mainnet Solana pubkey (the refund well-formedness fixture).
const SOL_ADDRESS: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// ---- the stub upstream ----

/// The stub's shared state: per-route hit counts + the last request (headers snapshot
/// and full request URI — the query IS the request on an all-GET venue).
#[derive(Clone)]
struct Stub {
    rate_hits: Arc<AtomicUsize>,
    trade_hits: Arc<AtomicUsize>,
    status_hits: Arc<AtomicUsize>,
    last: Arc<Mutex<(HeaderMap, String)>>,
}

impl Stub {
    fn new() -> Self {
        Stub {
            rate_hits: Arc::new(AtomicUsize::new(0)),
            trade_hits: Arc::new(AtomicUsize::new(0)),
            status_hits: Arc::new(AtomicUsize::new(0)),
            last: Arc::new(Mutex::new((HeaderMap::new(), String::new()))),
        }
    }

    fn hits(counter: &Arc<AtomicUsize>) -> usize {
        counter.load(Ordering::SeqCst)
    }

    /// The most recent (headers, uri) the stub received, on any route.
    fn last(&self) -> (HeaderMap, String) {
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

fn record(stub: &Stub, uri: &Uri, headers: &HeaderMap) {
    *stub.last.lock().unwrap_or_else(|p| p.into_inner()) =
        (headers.clone(), uri.to_string());
}

/// Record the arrival then answer with the venue's own `new_rate` wire shape
/// (trocador.app/en/docs/, fetched 2026-09-20; the trade_id is the RATE id the
/// trade surface consumes). `amount_from=0` scripts a venue refusal so the
/// error-passthrough test has a real upstream status to pin.
async fn stub_new_rate(State(stub): State<Stub>, uri: Uri, headers: HeaderMap) -> Response {
    stub.rate_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers);
    // The scripted venue refusal triggers on amount_from EXACTLY "0" — substring
    // matching would also swallow "0.1" and break the reverse-direction test.
    let fail = uri
        .query()
        .map(|q| {
            q.split('&').any(|pair| {
                pair.split_once('=')
                    .is_some_and(|(k, v)| k == "amount_from" && v == "0")
            })
        })
        .unwrap_or(false);
    if fail {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({"error": "Invalid parameters"}).to_string(),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "trade_id": "stub-rate-1",
            "date": "2026-09-20 20:00",
            "ticker_from": "icp",
            "ticker_to": "sol",
            "coin_from": "Internet Computer",
            "coin_to": "Solana",
            "network_from": "Mainnet",
            "network_to": "Mainnet",
            "amount_from": "2",
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "fixed": true,
            "status": "Waiting",
            "quotes": [],
            "payment": false,
        })
        .to_string(),
    )
        .into_response()
}

/// The venue's own `new_trade` answer shape: the exchange's DEPOSIT address
/// (`address_provider`) is the field the user sends to.
async fn stub_new_trade(State(stub): State<Stub>, uri: Uri, headers: HeaderMap) -> Response {
    stub.trade_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "trade_id": "stub-trade-1",
            "date": "2026-09-20 20:00",
            "ticker_from": "icp",
            "ticker_to": "sol",
            "amount_from": "2",
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "fixed": true,
            "status": "Waiting",
            "address_provider": "stub-trocador-deposit-01",
            "address_provider_memo": null,
            "address_user": "e2e-settle-address",
            "refund_address": "e2e-refund-address",
            "id_provider": "stub-provider-id-1",
            "payment": false,
        })
        .to_string(),
    )
        .into_response()
}

/// The venue's own `trade` status answer (the body the resume engine reads its
/// top-level `status` from).
async fn stub_trade_status(State(stub): State<Stub>, uri: Uri, headers: HeaderMap) -> Response {
    stub.status_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "trade_id": "stub-trade-1",
            "status": "Waiting",
            "amount_from": "2",
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "fixed": true,
        })
        .to_string(),
    )
        .into_response()
}

/// A route that hangs past any sane timeout — the 504 contract's instrument.
async fn stub_hang() -> Response {
    tokio::time::sleep(Duration::from_secs(2)).await;
    (StatusCode::OK, "late").into_response()
}

/// Bind the stub on an ephemeral loopback port; return (its state, the API BASE the
/// relay should be given — the proxy appends `/new_rate`, `/new_trade`, `/trade`).
async fn spawn_stub() -> (Stub, String) {
    let stub = Stub::new();
    let router = Router::new()
        .route("/new_rate", get(stub_new_rate))
        .route("/new_trade", get(stub_new_trade))
        .route("/trade", get(stub_trade_status))
        .route("/hang", get(stub_hang))
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

fn state_with(proxy: TrocadorProxy) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_trocador(proxy)
}

/// A fully configured proxy pointed at the given stub base.
fn configured(base: &str) -> TrocadorProxy {
    TrocadorProxy::new(Some(STUB_KEY.into()), base.into(), DEFAULT_TIMEOUT)
}

async fn request_json(
    state: &AppState,
    method: &str,
    uri: &str,
    body: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = match body {
        Some(b) => axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string())),
        None => axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty()),
    }
    .expect("build the trocador request");
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

async fn post_json(state: &AppState, uri: &str, body: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    request_json(state, "POST", uri, Some(body)).await
}

async fn get_json(state: &AppState, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    request_json(state, "GET", uri, None).await
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

fn rate_body(deposit: &str, settle: &str, amount: &str) -> String {
    serde_json::json!({
        "depositLedger": deposit,
        "settleLedger": settle,
        "depositAmount": amount,
    })
    .to_string()
}

fn trade_body(
    deposit: &str,
    settle: &str,
    amount: &str,
    refund: &str,
    overrides: serde_json::Value,
) -> String {
    let mut v = serde_json::json!({
        "rateId": "stub-rate-1",
        "provider": "StubSwap",
        "settleAddress": "e2e-settle-address",
        "refundAddress": refund,
        "depositLedger": deposit,
        "settleLedger": settle,
        "depositAmount": amount,
    });
    if let (Some(base), Some(extra)) = (v.as_object_mut(), overrides.as_object()) {
        for (k, val) in extra {
            base.insert(k.clone(), val.clone());
        }
    }
    v.to_string()
}

// ---- the 503-not-404 contract ----

/// Unconfigured (the key env var unset — TODAY'S DEFAULT, the founder's request is
/// outstanding): all three routes answer 503 with the marker, naming the variable,
/// with zero upstream calls. The venue is absent, not broken.
#[tokio::test]
async fn unconfigured_answers_503_naming_the_key_variable() {
    let (stub, _unused) = spawn_stub().await;
    let state = state_with(TrocadorProxy::new(
        None,
        "https://trocador.example".into(),
        DEFAULT_TIMEOUT,
    ));
    let (s1, _h, b1) = post_json(&state, "/api/v1/trocador/rate", &rate_body(ICP, SOL, "2")).await;
    assert_eq!(s1, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(relay_error_code(&b1), "trocador-unconfigured");
    assert!(
        String::from_utf8_lossy(&b1).contains("DPAY_TROCADOR_API_KEY"),
        "names the key variable"
    );
    let (s2, _h, b2) = post_json(
        &state,
        "/api/v1/trocador/trade",
        &trade_body(ICP, SOL, "2", ICP, serde_json::json!({})),
    )
    .await;
    assert_eq!(s2, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(relay_error_code(&b2), "trocador-unconfigured");
    let (s3, _h, b3) = get_json(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s3, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(relay_error_code(&b3), "trocador-unconfigured");
    assert_eq!(Stub::hits(&stub.rate_hits), 0);
    assert_eq!(Stub::hits(&stub.trade_hits), 0);
    assert_eq!(Stub::hits(&stub.status_hits), 0);
}

// ---- the rate surface: key attachment, founder pins, the wrap ----

/// Happy path: the upstream sees the `API-Key` header with the configured value and
/// the mapped codes + founder pins in the query; the device gets the attribution wrap
/// with the venue's body untouched and the key nowhere in it.
#[tokio::test]
async fn rate_attaches_key_and_wraps_the_venue_body_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let (status, headers, body) =
        post_json(&state, "/api/v1/trocador/rate", &rate_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(Stub::hits(&stub.rate_hits), 1, "exactly one upstream call");

    // What the VENUE saw: the key header from config, the mapped codes, the founder
    // pins, the aggregator's own pick, the amount verbatim.
    let (seen_headers, seen_uri) = stub.last();
    assert_eq!(
        seen_headers.get("API-Key").and_then(|v| v.to_str().ok()),
        Some(STUB_KEY),
        "the partner key rides the header, from config"
    );
    let query = seen_uri.split_once('?').map(|(_, q)| q).unwrap_or("");
    let pairs: Vec<(String, String)> = query
        .split('&')
        .map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap())
        .collect();
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    assert_eq!(get("ticker_from"), "icp", "the mapped deposit ticker");
    assert_eq!(get("network_from"), "Mainnet", "the mapped deposit network");
    assert_eq!(get("ticker_to"), "sol", "the mapped settle ticker");
    assert_eq!(get("network_to"), "Mainnet", "the mapped settle network");
    assert_eq!(get("amount_from"), "2", "the deposit amount verbatim");
    assert_eq!(get("min_kycrating"), "A", "the pinned KYC filter");
    assert_eq!(get("markup"), "0", "the pinned zero markup");
    assert_eq!(get("best_only"), "True", "the aggregator's own pick, one quote");

    // What the DEVICE got: the attribution wrap, numbers untouched, key not echoed.
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains(STUB_KEY), "the key is never echoed");
    let v: serde_json::Value = serde_json::from_slice(&body).expect("the wrap is JSON");
    assert_eq!(v["venue_id"], "trocador", "the matched row's id");
    assert!(v["fetched_at"].as_u64().is_some(), "the relay's read instant");
    assert_eq!(v["quote"]["trade_id"], "stub-rate-1", "the venue body verbatim");
    assert_eq!(v["quote"]["amount_to"], "0.0496");
    assert_eq!(v["quote"]["provider"], "StubSwap");
    assert_eq!(v["quote"]["fixed"], true);
}

/// The reverse direction maps codes the other way round — the unordered-pair rule.
#[tokio::test]
async fn rate_accepts_the_reverse_direction() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let (status, _h, _b) =
        post_json(&state, "/api/v1/trocador/rate", &rate_body(SOL, ICP, "0.1")).await;
    assert_eq!(status, StatusCode::OK);
    let (seen_headers, seen_uri) = stub.last();
    assert_eq!(seen_headers.get("API-Key").and_then(|v| v.to_str().ok()), Some(STUB_KEY));
    assert!(seen_uri.contains("ticker_from=sol"), "{seen_uri}");
    assert!(seen_uri.contains("ticker_to=icp"), "{seen_uri}");
    assert_eq!(Stub::hits(&stub.rate_hits), 1);
}

/// The pair allowlist: only the TROCADOR row's pair rides the key. The ICP↔USDC pair
/// is a real cefi pair — but it belongs to the SIDESHIFT row, and the pair
/// disambiguates the row: it must never spend the trocador key. Zero upstream hits.
#[tokio::test]
async fn rate_refuses_unregistered_pairs_without_touching_the_upstream() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let vchf = "ly36x-wiaaa-aaaai-aqj7q-cai";
    for (deposit, settle) in [
        (ICP, USDC),  // the sideshift-usdc row's pair — NOT trocador's
        (ICP, "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"), // sideshift-eurc's
        (vchf, SOL),  // a real IC ledger no cefi row pairs
        (SOL, USDC),  // a jupiter pair
        (ICP, ICP),   // same rail — never a cross-rail pair
        ("", ""),
    ] {
        let (status, _h, body) =
            post_json(&state, "/api/v1/trocador/rate", &rate_body(deposit, settle, "2")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{deposit}->{settle}");
        let text = String::from_utf8_lossy(&body);
        assert!(
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").cloned())
                .is_some(),
            "a house {{\"error\"}} body, not a marker: {text}"
        );
        assert!(!text.contains("dpayRelayError"), "a 400 device error, not 503-class");
    }
    assert_eq!(Stub::hits(&stub.rate_hits), 0, "zero upstream hits");
}

/// Malformed device bodies are refused BEFORE any upstream call: not-JSON, missing
/// fields, non-string amounts, junk decimals.
#[tokio::test]
async fn rate_malformed_bodies_are_refused_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    for bad in [
        "not json",
        "{}",
        r#"{"depositLedger": 1, "settleLedger": "x", "depositAmount": "1"}"#,
        r#"{"depositLedger": "a", "settleLedger": "b"}"#,
        &rate_body(ICP, SOL, "1,5"),
        &rate_body(ICP, SOL, "abc"),
        &rate_body(ICP, SOL, ""),
    ] {
        let (status, _h, body) = post_json(&state, "/api/v1/trocador/rate", bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("\"error\""), "house shape: {text}");
    }
    assert_eq!(Stub::hits(&stub.rate_hits), 0, "zero upstream hits");
}

/// An upstream ERROR passes through verbatim — same status, venue's own body, no wrap
/// and no relay marker: whatever refused is the venue, not us.
#[tokio::test]
async fn upstream_error_passes_through_verbatim_unwrapped() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    // amount_from=0 scripts the stub's venue refusal (the amount_from=0 branch).
    let (status, _h, body) =
        post_json(&state, "/api/v1/trocador/rate", &rate_body(ICP, SOL, "0")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the venue's own status");
    let text = String::from_utf8_lossy(&body);
    let v: serde_json::Value = serde_json::from_str(&text).expect("the venue's JSON");
    assert_eq!(v["error"], "Invalid parameters", "the venue's own words, verbatim");
    assert!(v.get("dpayRelayError").is_none(), "NO relay marker");
    assert!(v.get("venue_id").is_none(), "NO attribution wrap on an error");
    assert_eq!(Stub::hits(&stub.rate_hits), 1);
}

// ---- the trade surface: forwarding + the refund fund-loss guard ----

/// Trade creation forwards the quote's own rate id + provider, the user's own
/// addresses, the mapped codes and the SAME founder pins; the answer is the venue's
/// body VERBATIM (an order is not a quote surface — no wrap).
#[tokio::test]
async fn trade_creation_forwards_and_passes_back_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let body = trade_body(ICP, SOL, "2", ICP, serde_json::json!({}));
    let (status, _h, resp_body) = post_json(&state, "/api/v1/trocador/trade", &body).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&resp_body)
    );
    assert_eq!(Stub::hits(&stub.trade_hits), 1, "exactly one upstream call");

    let (seen_headers, seen_uri) = stub.last();
    assert_eq!(
        seen_headers.get("API-Key").and_then(|v| v.to_str().ok()),
        Some(STUB_KEY),
        "the partner key rides the header, from config"
    );
    let query = seen_uri.split_once('?').map(|(_, q)| q).unwrap_or("");
    let pairs: Vec<(String, String)> = query
        .split('&')
        .map(|p| p.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())).unwrap())
        .collect();
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    assert_eq!(get("id"), "stub-rate-1", "the quote's own rate id");
    assert_eq!(get("provider"), "StubSwap", "the provider the quote named");
    assert_eq!(get("ticker_from"), "icp");
    assert_eq!(get("ticker_to"), "sol");
    assert_eq!(get("amount_from"), "2");
    assert_eq!(get("address"), "e2e-settle-address", "the user's OWN settle address");
    assert_eq!(get("refund"), ICP, "the user's OWN refund address, forwarded");
    assert_eq!(get("fixed"), "True", "the pinned fixed-rate trade");
    assert_eq!(get("min_kycrating"), "A", "the pinned KYC filter, same as the quote");
    assert_eq!(get("markup"), "0", "the pinned zero markup, same as the quote");
    assert!(!query.contains("Ledger"), "rail ids are device-side only, never forwarded");

    // The venue's answer verbatim: the exchange's deposit address + the trade id ride
    // untouched; no attribution wrap on an order.
    let text = String::from_utf8_lossy(&resp_body);
    let v: serde_json::Value = serde_json::from_str(&text).expect("verbatim JSON");
    assert_eq!(v["trade_id"], "stub-trade-1");
    assert_eq!(v["address_provider"], "stub-trocador-deposit-01");
    assert!(v.get("venue_id").is_none(), "NO wrap on an order");
    assert!(!text.contains(STUB_KEY), "the key is never echoed");
}

/// The refund-address FUND-LOSS guard: a missing, empty, wrong-rail, malformed or
/// un-railable refund address — or any other malformed field — is a 400 BEFORE any
/// upstream call. Without a valid refund, a failed deposit strands the user's funds
/// at the venue.
#[tokio::test]
async fn trade_creation_refuses_missing_or_malformed_refund_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let sol_garbage = "0OIl-not-base58-safe";
    for (deposit, refund, label) in [
        // (depositLedger, refundAddress, label)
        (ICP, "", "empty refund"),
        (ICP, "not-a-principal", "malformed IC principal"),
        (ICP, SOL_ADDRESS, "a SOLANA address on the IC rail (wrong rail)"),
        (SOL, ICP, "an IC principal on the SOLANA rail (wrong rail)"),
        (SOL, sol_garbage, "not base58 at all"),
        (SOL, "111", "base58 but not 32 bytes"),
        ("", ICP, "unknown deposit rail cannot be refund-scoped"),
    ] {
        let body = trade_body(deposit, if deposit == ICP { SOL } else { ICP }, "2", refund, serde_json::json!({}));
        let (status, _h, resp) = post_json(&state, "/api/v1/trocador/trade", &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
        let text = String::from_utf8_lossy(&resp);
        assert!(text.contains("\"error\""), "house shape: {text}");
    }
    assert_eq!(Stub::hits(&stub.trade_hits), 0, "zero upstream hits on every refusal");
}

/// Malformed trade bodies — missing/empty rateId, provider or settleAddress, junk
/// amounts — are 400s before any upstream call.
#[tokio::test]
async fn trade_creation_refuses_malformed_bodies() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    for bad in [
        "not json",
        "{}",
        &trade_body(ICP, SOL, "2", ICP, serde_json::json!({"rateId": ""})),
        &trade_body(ICP, SOL, "2", ICP, serde_json::json!({"provider": ""})),
        &trade_body(ICP, SOL, "2", ICP, serde_json::json!({"settleAddress": ""})),
        &trade_body(ICP, SOL, "2", ICP, serde_json::json!({"depositAmount": 2})),
        &trade_body(ICP, SOL, "1.5.5", ICP, serde_json::json!({})),
    ] {
        let (status, _h, resp) = post_json(&state, "/api/v1/trocador/trade", bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert!(String::from_utf8_lossy(&resp).contains("\"error\""));
    }
    assert_eq!(Stub::hits(&stub.trade_hits), 0, "zero upstream hits");
}

// ---- the status proxy ----

/// The status route attaches the key and passes the venue's body verbatim; a missing
/// or empty `id` is a client bug — 400, no upstream call.
#[tokio::test]
async fn status_route_passes_through_and_requires_an_id() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let (status, _h, body) = get_json(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(Stub::hits(&stub.status_hits), 1);
    let (seen_headers, seen_uri) = stub.last();
    assert_eq!(
        seen_headers.get("API-Key").and_then(|v| v.to_str().ok()),
        Some(STUB_KEY),
        "the key rides server-side — the device never holds one"
    );
    assert!(seen_uri.ends_with("/trade?id=stub-trade-1"), "{seen_uri}");
    let v: serde_json::Value = serde_json::from_slice(&body).expect("verbatim JSON");
    assert_eq!(v["status"], "Waiting", "the venue's own top-level status");
    assert!(v.get("venue_id").is_none(), "NO wrap on a status read");

    for bad in ["/api/v1/trocador/trade", "/api/v1/trocador/trade?id="] {
        let (status, _h, _b) = get_json(&state, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(Stub::hits(&stub.status_hits), 1, "no upstream calls for the refusals");
}

// ---- transport trouble ----

/// A hanging upstream times out into the 504 marker within the proxy's timeout — and
/// the marker names no URL and no key.
#[tokio::test]
async fn hanging_upstream_times_out_with_marker_and_no_leak() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let router = Router::new()
            .route("/new_rate", get(stub_hang))
            .with_state(());
        axum::serve(listener, router).await.expect("stub stays up");
    });
    let proxy = TrocadorProxy::new(
        Some(STUB_KEY.into()),
        format!("http://{addr}"),
        Duration::from_millis(150),
    );
    let state = state_with(proxy);
    let started = std::time::Instant::now();
    let (status, _h, body) =
        post_json(&state, "/api/v1/trocador/rate", &rate_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the timeout surfaces promptly"
    );
    let text = String::from_utf8_lossy(&body);
    assert_eq!(relay_error_code(&body), "trocador-upstream-unreachable");
    assert!(!text.contains(STUB_KEY), "no key in the body");
    assert!(!text.contains("http://"), "no URL in the body: {text}");
}

/// A connection-refused upstream is the same honest 504 marker.
#[tokio::test]
async fn connection_refused_is_a_504_with_marker() {
    // Port 1 on loopback: nothing listens there.
    let state = state_with(TrocadorProxy::new(
        Some(STUB_KEY.into()),
        "http://127.0.0.1:1".into(),
        Duration::from_millis(500),
    ));
    let (status, _h, body) =
        post_json(&state, "/api/v1/trocador/rate", &rate_body(ICP, SOL, "2")).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), "trocador-upstream-unreachable");
}
