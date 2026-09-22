//! The Trocador partner-agreement layer (`src/trocador_agreement.rs`) — offline integration
//! tests for the three signed promises: the compliance ACCESS LOG, the per-trade WEBHOOKS +
//! order store, and the upstream RATE LIMITS. Same idioms as `tests/trocador_proxy.rs`:
//! `test-helpers` is always on for integration tests, the suite drives the axum `Router`
//! directly with `tower::ServiceExt::oneshot`, and the "upstream" is a REAL loopback
//! `TcpListener` running an in-process axum stub — no packet leaves the machine. Every
//! artifact (access log, order store) lands in a per-test temp dir; nothing leaks into the
//! repo tree.
//!
//! Pinned here, in order:
//! - the access log: one JSON line per proxied call (rate/trade/status) carrying every
//!   promised field — ts (RFC3339 + unix), route, method, ip, user_agent, accept_language,
//!   upstream_status, duration_ms — with the order/trade correlation ids once known, and
//!   X-Forwarded-For honored ONLY under DPAY_TRUST_PROXY;
//! - the order store: persisted BEFORE the upstream call (the stub itself asserts this —
//!   it refuses the trade unless the order line already exists), trade_id attached after,
//!   `X-Dpay-Order-Id` + webhook params present IFF the public origin is set, body
//!   byte-verbatim in both cases;
//! - the webhook receiver: a matched delivery updates the order and the status route then
//!   serves that payload verbatim with ZERO upstream hits; unknown keys, garbage bodies and
//!   GET probes all answer 200 and log `webhook-unmatched` (hash, never the raw key);
//! - the 60s status spacing: one upstream read per trade per window, 429 + Retry-After in
//!   between (injectable clock — no sleeping), webhook-served reads exempt;
//! - the per-client limits: rate/trade fixed windows 429 with the house marker, keyed per
//!   IP, resetting with the window, never counting device 400s;
//! - restart durability: a fresh `Agreement` on the same dir rebuilds the index from the
//!   jsonl and correlates a webhook for a pre-restart order.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use dpay_relay::trocador::{TrocadorProxy, DEFAULT_TIMEOUT};
use dpay_relay::trocador_agreement::{
    Agreement, AgreementConfig, NowFn, WebhookOutcome, ORDER_ID_HEADER,
};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// The FAKE partner credential the stub upstream recognizes.
const STUB_KEY: &str = "stub-partner-key";

const ICP: &str = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const SOL: &str = "So11111111111111111111111111111111111111112";

/// The venue trade JSON the webhook delivers (the same transaction data the trade endpoint
/// returns, per the agreement). Delivered in two acts so last-wins is observable.
const WEBHOOK_PAYLOAD_PROCESSING: &str = r#"{"trade_id":"stub-trade-1","status":"Processing","amount_from":"2","amount_to":"0.0496","provider":"StubSwap"}"#;
const WEBHOOK_PAYLOAD_COMPLETED: &str = r#"{"trade_id":"stub-trade-1","status":"Completed","amount_to":"0.0496","details":{"hashout":"stub-settle-hash"}}"#;

// ---- the injectable clock ----

/// A fixed-base clock cell + the agreement's `NowFn` over it — the 60s spacing and the fixed
/// windows are walked in seconds, never slept.
fn clock() -> (Arc<Mutex<u64>>, NowFn) {
    let cell = Arc::new(Mutex::new(1_760_000_000u64));
    let now: NowFn = {
        let cell = cell.clone();
        Arc::new(move || *cell.lock().unwrap_or_else(|p| p.into_inner()))
    };
    (cell, now)
}

fn bump(cell: &Arc<Mutex<u64>>, secs: u64) {
    *cell.lock().unwrap_or_else(|p| p.into_inner()) += secs;
}

// ---- per-test artifact dirs ----

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dpay-trocador-agr-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir); // each run starts fresh
    std::fs::create_dir_all(&dir).expect("create the temp artifact dir");
    dir
}

fn access_lines(dir: &Path) -> Vec<serde_json::Value> {
    jsonl(&dir.join("trocador-access.jsonl"))
}

fn order_lines(dir: &Path) -> Vec<serde_json::Value> {
    jsonl(&dir.join("trocador-orders.jsonl"))
}

fn jsonl(path: &Path) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn lines_of<'a>(lines: &'a [serde_json::Value], kind: &str) -> Vec<&'a serde_json::Value> {
    lines
        .iter()
        .filter(|line| line["kind"] == kind)
        .collect()
}

// ---- the stub upstream ----

/// The stub's shared state: per-route hit counts + the last request. When `orders_check` is
/// set (the persist-first test), `new_trade` REFUSES (500) unless the order-store file already
/// contains the `webhook_key` that arrived in its query — a direct probe of the
/// persist-BEFORE-upstream promise, from the venue's own side of the wire.
#[derive(Clone)]
struct Stub {
    rate_hits: Arc<AtomicUsize>,
    trade_hits: Arc<AtomicUsize>,
    status_hits: Arc<AtomicUsize>,
    last: Arc<Mutex<(HeaderMap, String)>>,
    orders_check: Option<PathBuf>,
}

impl Stub {
    fn new() -> Self {
        Stub {
            rate_hits: Arc::new(AtomicUsize::new(0)),
            trade_hits: Arc::new(AtomicUsize::new(0)),
            status_hits: Arc::new(AtomicUsize::new(0)),
            last: Arc::new(Mutex::new((HeaderMap::new(), String::new()))),
            orders_check: None,
        }
    }

    fn hits(counter: &Arc<AtomicUsize>) -> usize {
        counter.load(Ordering::SeqCst)
    }

    fn last(&self) -> (HeaderMap, String) {
        self.last.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

fn record(stub: &Stub, uri: &Uri, headers: &HeaderMap) {
    *stub.last.lock().unwrap_or_else(|p| p.into_inner()) = (headers.clone(), uri.to_string());
}

async fn stub_new_trade(State(stub): State<Stub>, uri: Uri, headers: HeaderMap) -> Response {
    stub.trade_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers);
    // The persist-first probe: the venue-side proof that the order line hit the store
    // BEFORE this request could ever be issued.
    if let Some(path) = &stub.orders_check {
        let key = uri.query().unwrap_or_default().split('&').find_map(|pair| {
            pair.split_once('=').is_some_and(|(k, _)| k == "webhook_key").then(|| {
                pair.split_once('=').expect("has =").1.to_string()
            })
        });
        let persisted = key
            .map(|k| {
                std::fs::read_to_string(path)
                    .map(|text| text.contains(&k))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !persisted {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "the order was not persisted before the upstream call",
            )
                .into_response();
        }
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "trade_id": "stub-trade-1",
            "date": "2026-09-21 20:00",
            "ticker_from": "icp",
            "ticker_to": "sol",
            "amount_from": "2",
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "fixed": true,
            "status": "Waiting",
            "address_provider": "stub-trocador-deposit-01",
            "payment": false,
        })
        .to_string(),
    )
        .into_response()
}

async fn stub_new_rate(State(stub): State<Stub>, uri: Uri, headers: HeaderMap) -> Response {
    stub.rate_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "trade_id": "stub-rate-1",
            "amount_from": "2",
            "amount_to": "0.0496",
            "provider": "StubSwap",
            "status": "Waiting",
        })
        .to_string(),
    )
        .into_response()
}

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
        })
        .to_string(),
    )
        .into_response()
}

/// Bind the stub on an ephemeral loopback port; return (its state, the API BASE).
async fn spawn(stub: Stub) -> (Stub, String) {
    let router = Router::new()
        .route("/new_rate", get(stub_new_rate))
        .route("/new_trade", get(stub_new_trade))
        .route("/trade", get(stub_trade_status))
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

fn agreement_in(dir: &Path, now: NowFn) -> Agreement {
    Agreement::new(AgreementConfig {
        log_dir: dir.to_path_buf(),
        ..AgreementConfig::default()
    })
    .with_clock(now)
}

fn agreement_with(config: AgreementConfig, now: NowFn) -> Agreement {
    Agreement::new(config).with_clock(now)
}

fn state_with(base: &str, agreement: Agreement) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_trocador(
        TrocadorProxy::new(Some(STUB_KEY.into()), base.to_string(), DEFAULT_TIMEOUT)
            .with_agreement(agreement),
    )
}

/// The one request builder every test rides: optional body, UA/Accept-Language/XFF headers,
/// and an optional injected `ConnectInfo` (what `into_make_service_with_connect_info` adds in
/// prod; oneshot tests inject it by hand when the peer-addr path is the one under test).
struct Req {
    method: &'static str,
    uri: &'static str,
    body: Option<String>,
    user_agent: Option<&'static str>,
    accept_language: Option<&'static str>,
    xff: Option<&'static str>,
    peer: Option<SocketAddr>,
}

impl Req {
    fn new(method: &'static str, uri: &'static str) -> Self {
        Req {
            method,
            uri,
            body: None,
            user_agent: None,
            accept_language: None,
            xff: None,
            peer: None,
        }
    }
    fn body(mut self, body: String) -> Self {
        self.body = Some(body);
        self
    }
    fn ua(mut self, ua: &'static str) -> Self {
        self.user_agent = Some(ua);
        self
    }
    fn al(mut self, al: &'static str) -> Self {
        self.accept_language = Some(al);
        self
    }
    fn xff(mut self, xff: &'static str) -> Self {
        self.xff = Some(xff);
        self
    }
    fn peer(mut self, peer: SocketAddr) -> Self {
        self.peer = Some(peer);
        self
    }
}

async fn send(state: &AppState, req: Req) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = axum::http::Request::builder()
        .method(req.method)
        .uri(req.uri);
    if req.body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    if let Some(ua) = req.user_agent {
        builder = builder.header(header::USER_AGENT, ua);
    }
    if let Some(al) = req.accept_language {
        builder = builder.header(header::ACCEPT_LANGUAGE, al);
    }
    if let Some(xff) = req.xff {
        builder = builder.header("x-forwarded-for", xff);
    }
    if let Some(peer) = req.peer {
        builder = builder.extension(ConnectInfo(peer));
    }
    let request = builder
        .body(Body::from(req.body.unwrap_or_default()))
        .expect("build the request");
    let resp = app(state.clone())
        .oneshot(request)
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

async fn post(state: &AppState, uri: &'static str, body: String) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(state, Req::new("POST", uri).body(body)).await
}

async fn send_get(state: &AppState, uri: &'static str) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(state, Req::new("GET", uri)).await
}

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

fn trade_body() -> String {
    serde_json::json!({
        "rateId": "stub-rate-1",
        "provider": "StubSwap",
        "settleAddress": "e2e-settle-address",
        "refundAddress": ICP,
        "depositLedger": ICP,
        "settleLedger": SOL,
        "depositAmount": "2",
    })
    .to_string()
}

/// The stub's query as (key, value) pairs (the values are the URL builder's own encoding).
fn query_pairs(stub_last_uri: &str) -> Vec<(String, String)> {
    stub_last_uri
        .split_once('?')
        .map(|(_, q)| q)
        .unwrap_or("")
        .split('&')
        .map(|p| {
            p.split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .unwrap_or((p.to_string(), String::new()))
        })
        .collect()
}

// ---- the access log ----

/// Every proxied call logs one line carrying the promised fields, correlated once the ids are
/// known; refusals (here: nothing refused) and unconfigured answers never log.
#[tokio::test]
async fn access_logs_all_three_kinds_with_promised_fields() {
    let (cell, now) = clock();
    let dir = temp_dir("all-kinds");
    let (_stub, base) = spawn(Stub::new()).await;
    let state = state_with(&base, agreement_in(&dir, now));

    let (s1, _h, _b) = post(
        &state,
        "/api/v1/trocador/rate",
        rate_body(ICP, SOL, "2"),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, _h, _b) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/trade")
            .body(trade_body())
            .ua("dpay-e2e/1.0")
            .al("en-US,de;q=0.7"),
    )
    .await;
    assert_eq!(s2, StatusCode::OK);
    let (s3, _h, _b) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s3, StatusCode::OK);

    let lines = access_lines(&dir);
    let rates = lines_of(&lines, "rate");
    let trades = lines_of(&lines, "trade");
    let statuses = lines_of(&lines, "status");
    assert_eq!(
        (rates.len(), trades.len(), statuses.len()),
        (1, 1, 1),
        "exactly one line per proxied call: {lines:?}"
    );

    let rate = rates[0];
    assert_eq!(rate["route"], "/api/v1/trocador/rate");
    assert_eq!(rate["method"], "POST");
    assert_eq!(rate["ip"], "-", "oneshot requests carry no address — never fabricated");
    assert_eq!(rate["user_agent"], "-", "no UA header sent on the rate call");
    assert_eq!(rate["upstream_status"], 200);
    assert!(rate["duration_ms"].as_u64().is_some());
    let ts = rate["ts"].as_str().expect("RFC3339 ts");
    assert!(ts.len() == 20 && ts.ends_with('Z') && ts.as_bytes()[10] == b'T', "{ts}");
    assert_eq!(rate["ts_unix"], *cell.lock().unwrap(), "the agreement's clock");

    let trade = trades[0];
    assert_eq!(trade["route"], "/api/v1/trocador/trade");
    assert_eq!(trade["user_agent"], "dpay-e2e/1.0", "the UA rides the line");
    assert_eq!(trade["accept_language"], "en-US,de;q=0.7");
    let order_id = trade["order_id"].as_str().expect("order id correlated");
    assert!(order_id.starts_with("trod-") && order_id.len() == 21, "{order_id}");
    assert_eq!(trade["trade_id"], "stub-trade-1", "correlated after the venue answered");
    assert_eq!(trade["upstream_status"], 200);

    let status = statuses[0];
    assert_eq!(status["method"], "GET");
    assert_eq!(status["trade_id"], "stub-trade-1");
    assert_eq!(
        status["order_id"], trade["order_id"],
        "the status line correlates through the order store"
    );
    // The rate line carries no correlation ids (a quote has none yet).
    assert!(rate.get("order_id").is_none() && rate.get("trade_id").is_none());
}

/// X-Forwarded-For names the client IP ONLY under DPAY_TRUST_PROXY; otherwise the connecting
/// peer wins and the header is ignored; with neither visible the log records `-`.
#[tokio::test]
async fn xff_is_the_client_ip_only_under_trust_proxy() {
    let (_, now) = clock();
    let trusted_dir = temp_dir("xff-trusted");
    let untrusted_dir = temp_dir("xff-untrusted");
    let blind_dir = temp_dir("xff-blind");

    let (stub_t, base_t) = spawn(Stub::new()).await;
    let trusted = agreement_with(
        AgreementConfig {
            trust_proxy: true,
            log_dir: trusted_dir.clone(),
            ..AgreementConfig::default()
        },
        now.clone(),
    );
    let state = state_with(&base_t, trusted);
    let (s, _h, _b) = send(
        &state,
        Req::new("GET", "/api/v1/trocador/trade?id=stub-trade-1")
            .xff("203.0.113.7, 10.0.0.1"),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let trusted_lines = access_lines(&trusted_dir);
    let trusted_line = lines_of(&trusted_lines, "status")[0];
    assert_eq!(
        trusted_line["ip"], "203.0.113.7",
        "the FIRST XFF entry is the client under DPAY_TRUST_PROXY"
    );
    assert_eq!(Stub::hits(&stub_t.status_hits), 1);

    let (stub_u, base_u) = spawn(Stub::new()).await;
    let untrusted = agreement_with(
        AgreementConfig {
            trust_proxy: false,
            log_dir: untrusted_dir.clone(),
            ..AgreementConfig::default()
        },
        now.clone(),
    );
    let state = state_with(&base_u, untrusted);
    let peer: SocketAddr = "127.0.0.1:55001".parse().expect("peer addr");
    let (s, _h, _b) = send(
        &state,
        Req::new("GET", "/api/v1/trocador/trade?id=stub-trade-1")
            .xff("203.0.113.7, 10.0.0.1")
            .peer(peer),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let untrusted_lines = access_lines(&untrusted_dir);
    let untrusted_line = lines_of(&untrusted_lines, "status")[0];
    assert_eq!(
        untrusted_line["ip"], "127.0.0.1",
        "no trust: the connecting peer is the client, the header is ignored"
    );
    assert_eq!(Stub::hits(&stub_u.status_hits), 1);

    // Neither XFF (untrusted) nor a peer: `-`, never fabricated.
    let (stub_b, base_b) = spawn(Stub::new()).await;
    let state = state_with(&base_b, agreement_in(&blind_dir, now));
    let (s, _h, _b) = send(
        &state,
        Req::new("GET", "/api/v1/trocador/trade?id=stub-trade-1").xff("203.0.113.7"),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let blind_lines = access_lines(&blind_dir);
    let blind_line = lines_of(&blind_lines, "status")[0];
    assert_eq!(blind_line["ip"], "-");
    assert_eq!(Stub::hits(&stub_b.status_hits), 1);
}

// ---- the order store + webhook params + the order header ----

/// The persist-BEFORE-upstream promise, proven from the venue's side: the stub refuses any
/// new_trade whose `webhook_key` is not already in the order store. A 200 therefore means the
/// order line existed before the call could be issued.
#[tokio::test]
async fn order_is_persisted_before_the_upstream_call_and_trade_id_after() {
    let (_, now) = clock();
    let dir = temp_dir("persist-first");
    let mut stub = Stub::new();
    stub.orders_check = Some(dir.join("trocador-orders.jsonl"));
    let (stub, base) = spawn(stub).await;
    let state = state_with(
        &base,
        agreement_with(
            AgreementConfig {
                public_origin: Some("https://relay.example".into()),
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now,
        ),
    );

    let (status, headers, body) = post(&state, "/api/v1/trocador/trade", trade_body()).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the stub refused only if the store was behind: {}",
        String::from_utf8_lossy(&body)
    );

    let (seen_headers, seen_uri) = stub.last();
    let pairs = query_pairs(&seen_uri);
    let webhook_key = pairs
        .iter()
        .find(|(k, _)| k == "webhook_key")
        .map(|(_, v)| v.clone())
        .expect("webhook_key rides the upstream call");
    assert_eq!(
        headers
            .get(ORDER_ID_HEADER)
            .and_then(|v| v.to_str().ok()),
        Some(webhook_key.as_str()),
        "the header IS the webhook key"
    );
    assert_eq!(
        seen_headers.get("API-Key").and_then(|v| v.to_str().ok()),
        Some(STUB_KEY)
    );

    // After the venue answered, the trade_id is attached (a second state line, last-wins).
    let orders = order_lines(&dir);
    assert!(orders.len() >= 2, "creation + trade_id attachment: {orders:?}");
    let last = orders.last().unwrap();
    assert_eq!(last["order_id"], webhook_key);
    assert_eq!(last["trade_id"], "stub-trade-1");
    assert_eq!(Stub::hits(&stub.trade_hits), 1);
}

/// Origin UNSET (the offline default): NO webhook params upstream, NO order header, order
/// still persisted + logged — and the body stays the venue's VERBATIM answer.
#[tokio::test]
async fn origin_off_sends_no_webhook_params_and_no_header() {
    let (_, now) = clock();
    let dir = temp_dir("origin-off");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(&base, agreement_in(&dir, now));

    let (status, headers, body) = post(&state, "/api/v1/trocador/trade", trade_body()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.get(ORDER_ID_HEADER).is_none(),
        "no origin → no order header"
    );
    let (_, seen_uri) = stub.last();
    let pairs = query_pairs(&seen_uri);
    assert!(pairs.iter().all(|(k, _)| k != "webhook"), "no webhook param: {pairs:?}");
    assert!(pairs.iter().all(|(k, _)| k != "webhook_key"));

    // The body is byte-for-byte what the venue said.
    let expected = serde_json::json!({
        "trade_id": "stub-trade-1", "date": "2026-09-21 20:00",
        "ticker_from": "icp", "ticker_to": "sol",
        "amount_from": "2", "amount_to": "0.0496",
        "provider": "StubSwap", "fixed": true, "status": "Waiting",
        "address_provider": "stub-trocador-deposit-01", "payment": false,
    })
    .to_string();
    assert_eq!(body, expected.as_bytes(), "verbatim body, byte for byte");

    // The order store still works without a webhook world.
    let orders = order_lines(&dir);
    assert!(orders.iter().any(|o| o["trade_id"] == "stub-trade-1"));
    let all_lines = access_lines(&dir);
    let trades = lines_of(&all_lines, "trade");
    assert_eq!(trades.len(), 1);
    assert!(trades[0]["order_id"].as_str().unwrap().starts_with("trod-"));
}

/// Origin SET: the webhook URL + the order id ride the upstream call, the header rides the
/// answer, and the body is STILL byte-verbatim.
#[tokio::test]
async fn origin_on_appends_webhook_params_and_keeps_the_body_verbatim() {
    let (_, now) = clock();
    let dir = temp_dir("origin-on");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(
        &base,
        agreement_with(
            AgreementConfig {
                public_origin: Some("https://relay.example".into()),
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now,
        ),
    );

    let (status, headers, body) = post(&state, "/api/v1/trocador/trade", trade_body()).await;
    assert_eq!(status, StatusCode::OK);
    let (_, seen_uri) = stub.last();
    let pairs = query_pairs(&seen_uri);
    let get = |k: &str| {
        pairs
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let order_id = headers
        .get(ORDER_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .expect("origin set → order header")
        .to_string();
    assert!(order_id.starts_with("trod-"));
    assert_eq!(get("webhook_key"), order_id, "the key IS the order id");
    let webhook = get("webhook");
    assert!(
        webhook.starts_with("https%3A%2F%2Frelay.example") && webhook.ends_with("%2Fwebhook"),
        "the receiver URL, percent-encoded by the URL builder: {webhook}"
    );

    let expected = serde_json::json!({
        "trade_id": "stub-trade-1", "date": "2026-09-21 20:00",
        "ticker_from": "icp", "ticker_to": "sol",
        "amount_from": "2", "amount_to": "0.0496",
        "provider": "StubSwap", "fixed": true, "status": "Waiting",
        "address_provider": "stub-trocador-deposit-01", "payment": false,
    })
    .to_string();
    assert_eq!(body, expected.as_bytes(), "verbatim body, byte for byte");
}

// ---- the webhook receiver ----

/// A matched delivery updates the order, and the status route then serves THAT payload
/// verbatim with ZERO upstream hits — the webhook as the primary channel.
#[tokio::test]
async fn webhook_matched_updates_order_and_status_serves_cache_with_zero_upstream() {
    let (cell, now) = clock();
    let dir = temp_dir("webhook-matched");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(
        &base,
        agreement_with(
            AgreementConfig {
                public_origin: Some("https://relay.example".into()),
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now.clone(),
        ),
    );

    // Create the trade (order O ↔ trade stub-trade-1).
    let (_s, headers, _b) = post(&state, "/api/v1/trocador/trade", trade_body()).await;
    let order_id = headers
        .get(ORDER_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .expect("order header")
        .to_string();

    // The venue's first delivery: POST the trade JSON, key echoed back.
    let uri: &'static str = Box::leak(format!("/api/v1/trocador/webhook?key={order_id}").into_boxed_str());
    let (s, _h, b) = post(&state, uri, WEBHOOK_PAYLOAD_PROCESSING.to_string()).await;
    assert_eq!(s, StatusCode::OK, "deliveries are 200, always: {}", String::from_utf8_lossy(&b));
    assert_eq!(Stub::hits(&stub.status_hits), 0, "no status reads yet");

    // The device's status poll: served from the webhook cache, zero upstream, VERBATIM.
    let (s, _h, body) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, WEBHOOK_PAYLOAD_PROCESSING.as_bytes(), "the payload, byte for byte");
    assert_eq!(Stub::hits(&stub.status_hits), 0, "ZERO upstream hits");

    // The store holds the state transition, last-wins verbatim.
    let orders = order_lines(&dir);
    let last = orders.last().unwrap();
    assert_eq!(last["order_id"], order_id);
    assert_eq!(last["last_status"], "Processing");
    assert!(last["status_ts"].as_u64().is_some());
    assert_eq!(
        last["last_webhook_payload"],
        WEBHOOK_PAYLOAD_PROCESSING,
        "the full payload, verbatim"
    );

    // A second delivery replaces the cached answer (last-wins), again zero upstream.
    bump(&cell, 5);
    let (s, _h, _b) = post(&state, uri, WEBHOOK_PAYLOAD_COMPLETED.to_string()).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _h, body) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, WEBHOOK_PAYLOAD_COMPLETED.as_bytes());
    assert_eq!(Stub::hits(&stub.status_hits), 0, "still zero upstream");

    // The webhook lines are in the access log, correlated, without the raw key echoed
    // (a matched key IS our own order id, so it is logged plainly as order_id).
    let lines_after_webhooks = access_lines(&dir);
    let webhook_lines = lines_of(&lines_after_webhooks, "webhook");
    assert_eq!(webhook_lines.len(), 2);
    assert_eq!(webhook_lines[0]["order_id"], order_id);
    assert_eq!(webhook_lines[0]["trade_id"], "stub-trade-1");
    assert_eq!(webhook_lines[0]["method"], "POST");
    let unmatched_free = access_lines(&dir)
        .iter()
        .all(|l| l["kind"] != "webhook-unmatched");
    assert!(unmatched_free, "nothing unmatched so far");
}

/// Unknown keys, matched-key garbage and GET probes: ALL answer 200 (never retry-worthy,
/// never a failed probe) and log `webhook-unmatched` with a key HASH — never the raw text.
#[tokio::test]
async fn webhook_unknown_key_garbage_and_get_probe_all_200_and_log_unmatched() {
    let (_, now) = clock();
    let dir = temp_dir("webhook-unmatched");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(&base, agreement_in(&dir, now));

    // Unknown key + garbage body.
    let (s, _h, _b) = post(
        &state,
        "/api/v1/trocador/webhook?key=trod-00000000000000ff",
        "not-json-at-all{".to_string(),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    // GET probe (the venue tests the URL at trade creation).
    let (s, _h, _b) = send_get(&state, "/api/v1/trocador/webhook?key=trod-00000000000000ff").await;
    assert_eq!(s, StatusCode::OK);
    // POST without any key.
    let (s, _h, _b) = post(&state, "/api/v1/trocador/webhook", "{}".to_string()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(Stub::hits(&stub.trade_hits), 0, "the receiver never touches the venue");

    let unmatched_lines = access_lines(&dir);
    let unmatched = lines_of(&unmatched_lines, "webhook-unmatched");
    assert_eq!(unmatched.len(), 3, "every non-delivery logged: {:?}", unmatched);
    assert!(unmatched.iter().all(|l| l.get("order_id").is_none()));
    for line in &unmatched[..2] {
        let hash = line["key_hash"].as_str().expect("the (present) key is hashed");
        assert_eq!(hash.len(), 16, "sha256 prefix, 16 hex: {hash}");
    }
    assert!(
        unmatched[2].get("key_hash").is_none(),
        "no key on the request → no hash to log"
    );
    assert_eq!(unmatched[0]["method"], "POST");
    assert_eq!(unmatched[1]["method"], "GET", "the probe's own method");
    // The raw (hostile-controlled) key text never lands in the log.
    let raw = std::fs::read_to_string(dir.join("trocador-access.jsonl")).unwrap();
    assert!(!raw.contains("trod-00000000000000ff"), "no raw key echo: {raw}");
}

// ---- the 60s status spacing + the per-client limits ----

/// The signed promise: at most ONE upstream status read per trade per 60s; inside the window
/// the route answers 429 + Retry-After with the house marker; the window then reopens. Only
/// upstream-bound reads are logged (the 429 never reaches the venue).
#[tokio::test]
async fn status_spacing_sixty_seconds_per_trade_with_retry_after() {
    let (cell, now) = clock();
    let dir = temp_dir("spacing");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(&base, agreement_in(&dir, now));

    let (s, _h, _b) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::OK, "the first read is the fallback's own right");
    assert_eq!(Stub::hits(&stub.status_hits), 1);

    bump(&cell, 30);
    let (s, headers, body) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        headers
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
        Some("30"),
        "Retry-After carries the remaining seconds"
    );
    assert_eq!(relay_error_code(&body), "trocador-status-throttled");
    assert!(!String::from_utf8_lossy(&body).contains(STUB_KEY));
    assert_eq!(Stub::hits(&stub.status_hits), 1, "the venue saw nothing more");

    bump(&cell, 31); // elapsed: 61s
    let (s, _h, _b) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::OK, "the window reopened");
    assert_eq!(Stub::hits(&stub.status_hits), 2);

    // A DIFFERENT trade id has its own window entirely.
    let (s, _h, _b) = send_get(&state, "/api/v1/trocador/trade?id=stub-trade-2").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(Stub::hits(&stub.status_hits), 3);

    // Only the two upstream reads are in the log — the 429 never touched the venue.
    assert_eq!(lines_of(&access_lines(&dir), "status").len(), 3);
}

/// The per-client fixed windows: 429 + house marker when full, keyed per IP, reset by the
/// window, never counting device 400s (limits apply ONLY to upstream-bound calls).
#[tokio::test]
async fn per_client_limiters_429_reset_and_exempt_device_refusals() {
    let (cell, now) = clock();
    let dir = temp_dir("limits");
    let (stub, base) = spawn(Stub::new()).await;
    let state = state_with(
        &base,
        agreement_with(
            AgreementConfig {
                trust_proxy: true,
                rate_per_min: 2,
                trade_per_min: 1,
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now.clone(),
        ),
    );

    // Rate: 2 pass, the 3rd is refused BEFORE any upstream call.
    let base_secs = *cell.lock().unwrap();
    let bucket = base_secs - base_secs % 60;
    let retry_when_full = bucket + 60 - base_secs;
    for _ in 0..2 {
        let (s, _h, _b) = send(
            &state,
            Req::new("POST", "/api/v1/trocador/rate")
                .body(rate_body(ICP, SOL, "2"))
                .xff("198.51.100.1"),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
    }
    let (s, headers, body) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/rate")
            .body(rate_body(ICP, SOL, "2"))
            .xff("198.51.100.1"),
    )
    .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(relay_error_code(&body), "trocador-rate-limited");
    assert_eq!(
        headers
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok()),
        Some(retry_when_full.to_string().as_str())
    );
    assert_eq!(Stub::hits(&stub.rate_hits), 2, "the refused call never went upstream");

    // A DIFFERENT client has its own window.
    let (s, _h, _b) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/rate")
            .body(rate_body(ICP, SOL, "2"))
            .xff("198.51.100.9"),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "per-IP, not global");

    // The window resets with time (the injectable clock walks it).
    bump(&cell, 61);
    let (s, _h, _b) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/rate")
            .body(rate_body(ICP, SOL, "2"))
            .xff("198.51.100.1"),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "a fresh window admits again");

    // Trade: limit 1. The FIRST creation passes; the second is refused and mints NOTHING.
    let (s, _h, _b) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/trade")
            .body(trade_body())
            .xff("198.51.100.1"),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let (s, headers, body) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/trade")
            .body(trade_body())
            .xff("198.51.100.1"),
    )
    .await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(relay_error_code(&body), "trocador-trade-limited");
    assert!(headers.get(ORDER_ID_HEADER).is_none(), "a refused trade rides no header");
    assert_eq!(Stub::hits(&stub.trade_hits), 1);
    let order_history = order_lines(&dir);
    let mut ids: Vec<&str> = order_history
        .iter()
        .filter_map(|o| o["order_id"].as_str())
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(
        ids.len(),
        1,
        "the refused trade never minted an order: {ids:?}"
    );

    // Device 400s are NOT upstream-bound: they consume nothing.
    for bad in ["not json", "{}"] {
        let (s, _h, _b) = send(
            &state,
            Req::new("POST", "/api/v1/trocador/rate")
                .body(bad.to_string())
                .xff("198.51.100.1"),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}");
    }
    let (s, _h, _b) = send(
        &state,
        Req::new("POST", "/api/v1/trocador/rate")
            .body(rate_body(ICP, SOL, "2"))
            .xff("198.51.100.1"),
    )
    .await;
    assert_eq!(
        s,
        StatusCode::OK,
        "the window's last slot survived the 400s"
    );
}

// ---- restart durability ----

/// The index is REBUILT from the append-only store: a webhook for a pre-restart order
/// correlates in a fresh process, and the status route serves the cache with zero upstream.
#[tokio::test]
async fn restart_durability_index_rebuilt_from_jsonl() {
    let (_, now) = clock();
    let dir = temp_dir("restart");
    let (stub1, base1) = spawn(Stub::new()).await;
    let state1 = state_with(
        &base1,
        agreement_with(
            AgreementConfig {
                public_origin: Some("https://relay.example".into()),
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now.clone(),
        ),
    );
    let (_s, headers, _b) = post(&state1, "/api/v1/trocador/trade", trade_body()).await;
    let order_id = headers
        .get(ORDER_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .expect("order header")
        .to_string();
    assert_eq!(Stub::hits(&stub1.trade_hits), 1);
    drop(state1); // the "restart"

    // A fresh relay process: new stub (fresh counters), fresh Agreement on the SAME dir.
    let (stub2, base2) = spawn(Stub::new()).await;
    let state2 = state_with(
        &base2,
        agreement_with(
            AgreementConfig {
                public_origin: Some("https://relay.example".into()),
                log_dir: dir.clone(),
                ..AgreementConfig::default()
            },
            now,
        ),
    );
    let uri: &'static str = Box::leak(format!("/api/v1/trocador/webhook?key={order_id}").into_boxed_str());
    let (s, _h, _b) = post(&state2, uri, WEBHOOK_PAYLOAD_PROCESSING.to_string()).await;
    assert_eq!(s, StatusCode::OK, "the pre-restart order correlates");

    let (s, _h, body) = send_get(&state2, "/api/v1/trocador/trade?id=stub-trade-1").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, WEBHOOK_PAYLOAD_PROCESSING.as_bytes());
    assert_eq!(
        Stub::hits(&stub2.status_hits),
        0,
        "cache-served after a restart, zero upstream"
    );

    // The store's history is append-only across both processes.
    let orders = order_lines(&dir);
    assert!(orders.len() >= 3, "creation + trade_id + webhook: {orders:?}");
    assert_eq!(orders.last().unwrap()["last_status"], "Processing");
}

// ---- the unconfigured contract is untouched ----

/// With the key unset every route keeps the 503 contract (nothing logged, nothing counted,
/// nothing upstream) — the agreement layers wrap AROUND it; the webhook receiver still 200s.
#[tokio::test]
async fn unconfigured_keeps_the_503_contract_with_agreement_attached() {
    let (_, now) = clock();
    let dir = temp_dir("unconfigured");
    let (stub, base) = spawn(Stub::new()).await;
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    let state = AppState::new(ledger).with_trocador(
        TrocadorProxy::new(None, base.clone(), DEFAULT_TIMEOUT)
            .with_agreement(agreement_in(&dir, now)),
    );

    for (method, uri, body) in [
        ("POST", "/api/v1/trocador/rate", Some(rate_body(ICP, SOL, "2"))),
        ("POST", "/api/v1/trocador/trade", Some(trade_body())),
        ("GET", "/api/v1/trocador/trade?id=stub-trade-1", None),
    ] {
        let req = Req::new(method, uri).body(body.unwrap_or_default());
        let (s, _h, b) = send(&state, req).await;
        assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(relay_error_code(&b), "trocador-unconfigured");
        assert!(String::from_utf8_lossy(&b).contains("DPAY_TROCADOR_API_KEY"));
    }
    assert_eq!(Stub::hits(&stub.rate_hits), 0);
    assert_eq!(Stub::hits(&stub.trade_hits), 0);
    assert_eq!(Stub::hits(&stub.status_hits), 0);
    // Nothing was proxied → nothing was logged, nothing was stored.
    assert!(access_lines(&dir).is_empty(), "no lines for unconfigured answers");
    assert!(order_lines(&dir).is_empty());
    // The receiver is still a live 200 sink on this build.
    let (s, _h, _b) = send_get(&state, "/api/v1/trocador/webhook?key=whatever").await;
    assert_eq!(s, StatusCode::OK);
}

// ---- the store, directly (no HTTP) ----

/// A webhook teaches an order its trade_id, and a rebuilt store (the restart path) still
/// correlates by that trade id — the pure-store half of the correlation contract.
#[test]
fn store_teaches_trade_id_from_webhook_and_survives_reload() {
    use dpay_relay::trocador_agreement::{classify_status, StatusClass};

    let dir = temp_dir("store-direct");
    let (_, now) = clock();
    let a = agreement_in(&dir, now.clone());
    let order_id = a.open_order(Some("device-order-42"));
    assert!(order_id.starts_with("trod-"));

    let payload = r#"{"trade_id":"venue-t-9","status":"Confirmed"}"#;
    assert!(matches!(
        a.apply_webhook(&order_id, payload),
        WebhookOutcome::Matched { .. }
    ));
    assert_eq!(a.cached_payload("venue-t-9").as_deref(), Some(payload));
    let record = a.order_by_trade_id("venue-t-9").expect("correlated");
    assert_eq!(record.client_order_id.as_deref(), Some("device-order-42"));
    assert_eq!(
        classify_status(record.last_status.as_deref().expect("status word")),
        StatusClass::Processing,
        "the classifier mirrors the route reader's vocabulary"
    );
    // A word the route reader does not map stays honest-unknown — never a verdict.
    assert_eq!(classify_status("Sending"), StatusClass::Unknown);

    // Reload from the append-only file (what a restart does).
    let b = agreement_in(&dir, now);
    assert_eq!(b.cached_payload("venue-t-9").as_deref(), Some(payload));
    let record = b.order_by_trade_id("venue-t-9").expect("correlated after reload");
    assert_eq!(record.client_order_id.as_deref(), Some("device-order-42"));

    // An unknown key stays unmatched, honestly.
    assert!(matches!(
        b.apply_webhook("trod-ffffffffffffffff", payload),
        WebhookOutcome::Unmatched
    ));
}
