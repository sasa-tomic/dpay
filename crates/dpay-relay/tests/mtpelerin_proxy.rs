//! The Mt Pelerin off-ramp proxy + conversion webhook receiver (`GET
//! /api/v1/mtpelerin/quote`, `POST+GET /api/v1/mtpelerin/conversion`,
//! `POST /api/v1/mtpelerin/webhook`) — offline integration tests, the
//! `tests/trocador_proxy.rs` idioms verbatim: `test-helpers` is always on for
//! integration tests, the suite drives the axum `Router` directly with
//! `tower::ServiceExt::oneshot`, and the "upstream" is a REAL loopback `TcpListener`
//! running an in-process axum stub — no packet leaves the machine. The webhook secret
//! (`stub-webhook-secret`) and CTKN (`stub-ctkn`) are FAKE values so every "never
//! echoed" assertion has teeth.
//!
//! Pinned here, in order:
//! - the 503-not-404 contract: an unconfigured proxy answers 503 `mtpelerin-unconfigured`
//!   on ALL routes naming exactly the missing variable (the CTKN for the proxy routes,
//!   the webhook secret for the receiver), never touching any upstream;
//! - the quote proxy: the upstream sees the venue's documented POST
//!   currency_rates/convert shape (whitelisted fields only, amounts as numbers), the
//!   device gets the attribution wrap
//!   `{"venue_id":"mtpelerin","quote":<venue body VERBATIM>,"fetched_at":<unix secs>}`,
//!   upstream errors pass through verbatim unwrapped, and unknown/missing params are
//!   400 house errors with zero upstream hits;
//! - conversion creation: the relay mints the correlation id (`mtp-…`), passes it
//!   upstream as `oid`, answers the venue's body VERBATIM with `X-Dpay-Order-Id`, and
//!   persists the order FIRST — the venue's `id` + `offRampAddress` land in the store;
//! - the poll cap: the status read is webhook-first (zero upstream calls) and spaced at
//!   most one per id per 60 s — 429 `mtpelerin-status-throttled` + `Retry-After` within
//!   the window (the injectable clock walks it, no sleeping);
//! - HMAC verify: a good `Mtp-Signature` (HMAC-SHA256 hex over the exact raw body) is
//!   accepted; a missing, wrong-key, tampered-body or cross-body signature answers 401
//!   and mutates nothing;
//! - terminal dedupe: the FIRST completion delivery wins — later deliveries for the
//!   same order answer 200 idempotently and never overwrite the stored payload, across
//!   a proxy rebuild from the same store (the startup replay);
//! - verified-but-unknown `external_id`: 200, logged unmatched, no store mutation.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use dpay_relay::mtpelerin::{MtPelerinConfig, MtPelerinProxy, STATUS_SPACING_SECS};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use sha2::Sha256;
use tower::ServiceExt;

/// The FAKE credentials the tests carry (the stub asserts nothing secret-bearing rides
/// upstream — the quote endpoint is keyless by the venue's own docs).
const STUB_CTKN: &str = "stub-ctkn";
const STUB_WEBHOOK_SECRET: &str = "stub-webhook-secret";

/// HMAC-SHA256 hex over `body` keyed with `secret` — the test-side signer (the RFC 4231
/// vector for this computation is pinned in the module's own unit tests).
fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// A unique temp dir per call — the JSONL stores write nothing into the repo.
fn temp_log_dir(tag: &str) -> std::path::PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "dpay-mtp-test-{}-{}-{}",
        std::process::id(),
        tag,
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

// ---- the stub upstream ----

/// The stub's shared state: per-route hit counts + the last request (headers, URI and
/// the full body — the body IS the request on a POST-shaped venue API).
#[derive(Clone)]
struct Stub {
    quote_hits: Arc<AtomicUsize>,
    conversion_hits: Arc<AtomicUsize>,
    last: Arc<Mutex<(HeaderMap, String, String)>>,
}

impl Stub {
    fn new() -> Self {
        Stub {
            quote_hits: Arc::new(AtomicUsize::new(0)),
            conversion_hits: Arc::new(AtomicUsize::new(0)),
            last: Arc::new(Mutex::new((HeaderMap::new(), String::new(), String::new()))),
        }
    }

    fn hits(counter: &Arc<AtomicUsize>) -> usize {
        counter.load(Ordering::SeqCst)
    }

    fn last(&self) -> (HeaderMap, String, String) {
        self.last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

fn record(stub: &Stub, uri: &axum::http::Uri, headers: &HeaderMap, body: &[u8]) {
    *stub.last.lock().unwrap_or_else(|p| p.into_inner()) = (
        headers.clone(),
        uri.to_string(),
        String::from_utf8_lossy(body).to_string(),
    );
}

/// The venue's documented price-quote answer (price-quote-api.md, fetched 2026-10-12):
/// `destAmount` is the NET final amount. `sourceAmount=0` scripts a venue refusal so
/// the error-passthrough test has a real upstream status to pin.
async fn stub_convert(
    State(stub): State<Stub>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    stub.quote_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers, &body);
    let fail = String::from_utf8_lossy(&body).contains(r#""sourceAmount":0"#);
    if fail {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({"error": "amount too low"}).to_string(),
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "fees": {"networkFee": "2.2605", "fixFee": 0},
            "sourceCurrency": "ZCHF",
            "destCurrency": "CHF",
            "sourceNetwork": "ethereum",
            "destNetwork": "fiat",
            "sourceAmount": 100,
            "destAmount": "97.7395"
        })
        .to_string(),
    )
        .into_response()
}

/// The venue's (best-effort-pinned) order-creation answer: the sell order carries the
/// venue's own `id` and the `offRampAddress` the user's crypto goes to.
async fn stub_orders(
    State(stub): State<Stub>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    stub.conversion_hits.fetch_add(1, Ordering::SeqCst);
    record(&stub, &uri, &headers, &body);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({
            "id": "664369c938b3ca001a3cd44f",
            "offRampAddress": "0xMTP-DEPOSIT-ADDRESS",
            "currencyIn": "ZCHF",
            "currencyOut": "CHF",
            "type": "sell",
            "valueIn": "100",
            "valueOut": "97.73"
        })
        .to_string(),
    )
        .into_response()
}

/// Bind the stub on an ephemeral loopback port; return (its state, the API BASE the
/// relay should be given — the proxy appends `/currency_rates/convert` and the
/// configured conversion path).
async fn spawn_stub() -> (Stub, String) {
    let stub = Stub::new();
    let router = Router::new()
        .route("/currency_rates/convert", post(stub_convert))
        .route("/orders", post(stub_orders))
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

fn state_with(proxy: MtPelerinProxy) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_mtpelerin(proxy)
}

/// A fully configured proxy pointed at the given stub base.
fn configured(base: &str) -> MtPelerinProxy {
    MtPelerinProxy::new(MtPelerinConfig {
        ctkn: Some(STUB_CTKN.into()),
        webhook_secret: Some(STUB_WEBHOOK_SECRET.into()),
        api_base: base.to_string(),
        conversion_path: "/orders".to_string(),
        log_dir: temp_log_dir("full"),
        trust_proxy: false,
        status_spacing_secs: STATUS_SPACING_SECS,
    })
}

/// The REAL clock seam: a shared fake unix-seconds counter the test can advance.
fn fake_clock() -> (Arc<AtomicU64>, impl Fn(MtPelerinProxy) -> MtPelerinProxy) {
    let now = Arc::new(AtomicU64::new(1_000_000));
    let now2 = now.clone();
    (now, move |proxy| {
        let now3 = now2.clone();
        proxy.with_clock(Arc::new(move || now3.load(Ordering::SeqCst)))
    })
}

async fn request_json(
    state: &AppState,
    method: &str,
    uri: &str,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(uri);
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    for (k, v) in extra_headers {
        builder = builder.header(*k, *v);
    }
    let req = builder
        .body(match body {
            Some(b) => Body::from(b.to_string()),
            None => Body::empty(),
        })
        .expect("build the mtpelerin request");
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
    request_json(state, "POST", uri, Some(body), &[]).await
}

async fn get_json(state: &AppState, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    request_json(state, "GET", uri, None, &[]).await
}

fn relay_error_code(body: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(body)
        .expect("a relay-originated error body is JSON carrying the dpayRelayError marker");
    v["dpayRelayError"]
        .as_str()
        .expect("dpayRelayError is a string")
        .to_string()
}

fn conversion_body() -> String {
    serde_json::json!({
        "sourceCurrency": "ZCHF",
        "destCurrency": "CHF",
        "sourceAmount": "100",
        "sourceNetwork": "ethereum",
        "iban": "CH9300762011623852957",
        "holderName": "Test Holder",
    })
    .to_string()
}

// ---- the 503-not-404 contract ----

/// Unconfigured (BOTH credentials unset — TODAY'S DEFAULT): every route answers 503
/// with the `mtpelerin-unconfigured` marker naming its own variable, with zero
/// upstream calls. The venue is absent, not broken.
#[tokio::test]
async fn unconfigured_answers_503_naming_the_missing_variable() {
    let (stub, _unused) = spawn_stub().await;
    let state = state_with(MtPelerinProxy::new(MtPelerinConfig {
        log_dir: temp_log_dir("unconf"),
        ..MtPelerinConfig::default()
    }));
    for (method, uri, body) in [
        ("GET", "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1", None),
        ("POST", "/api/v1/mtpelerin/conversion", Some(conversion_body())),
        ("GET", "/api/v1/mtpelerin/conversion?id=mtp-0123456789abcdef", None),
    ] {
        let (status, _h, body_bytes) =
            request_json(&state, method, uri, body.as_deref(), &[]).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert_eq!(relay_error_code(&body_bytes), "mtpelerin-unconfigured");
        assert!(
            String::from_utf8_lossy(&body_bytes).contains("DPAY_MTPELERIN_CTKN"),
            "names the CTKN variable: {}",
            String::from_utf8_lossy(&body_bytes)
        );
    }
    // The receiver gates on ITS OWN variable: still unset → 503 naming the secret.
    let (status, _h, body_bytes) =
        post_json(&state, "/api/v1/mtpelerin/webhook", "{}").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        String::from_utf8_lossy(&body_bytes).contains("DPAY_MTPELERIN_WEBHOOK_SECRET"),
        "names the webhook secret variable"
    );
    assert_eq!(Stub::hits(&stub.quote_hits), 0, "zero upstream calls");
    assert_eq!(Stub::hits(&stub.conversion_hits), 0, "zero upstream calls");
}

/// CTKN set but the webhook secret unset: the proxy routes work, the receiver stays
/// 503 naming the secret (an unverifiable delivery must never mutate an order).
#[tokio::test]
async fn ctkn_alone_leaves_the_receiver_dormant() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(MtPelerinProxy::new(MtPelerinConfig {
        ctkn: Some(STUB_CTKN.into()),
        api_base: base.clone(),
        log_dir: temp_log_dir("ctkn-only"),
        ..MtPelerinConfig::default()
    }));
    let (status, _h, _b) = get_json(
        &state,
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "the quote surface is configured");
    let (status, _h, body) = post_json(&state, "/api/v1/mtpelerin/webhook", "{}").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(relay_error_code(&body), "mtpelerin-unconfigured");
    assert!(
        String::from_utf8_lossy(&body).contains("DPAY_MTPELERIN_WEBHOOK_SECRET"),
        "names the secret, not the CTKN"
    );
    assert_eq!(Stub::hits(&stub.quote_hits), 1);
}

// ---- the quote surface ----

/// Happy path: the upstream sees the venue's documented POST shape (whitelisted fields,
/// amounts as numbers); the device gets the attribution wrap with the venue's body
/// untouched; no credential exists to echo and none is sent.
#[tokio::test]
async fn quote_wraps_the_venue_body_verbatim_and_posts_the_documented_shape() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));

    let (status, headers, body) = get_json(
        &state,
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=100&sourceNetwork=ethereum&destNetwork=fiat",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(Stub::hits(&stub.quote_hits), 1, "exactly one upstream call");

    // What the VENUE saw: the documented POST body, whitelisted fields only, the
    // amount as a JSON number.
    let (seen_headers, seen_uri, seen_body) = stub.last();
    assert_eq!(seen_uri, "/currency_rates/convert");
    let v: serde_json::Value = serde_json::from_str(&seen_body).expect("the upstream body is JSON");
    assert_eq!(v["sourceCurrency"], "ZCHF");
    assert_eq!(v["destCurrency"], "CHF");
    assert_eq!(v["sourceNetwork"], "ethereum");
    assert_eq!(v["destNetwork"], "fiat");
    assert_eq!(v["sourceAmount"], 100, "the amount rides as a number");
    assert!(v.get("isCardPayment").is_none(), "absent params are not sent");
    assert!(
        seen_headers.get("API-Key").is_none() && seen_headers.get("Authentication").is_none(),
        "the quote endpoint is keyless upstream - nothing secret rides it"
    );

    // What the DEVICE got: the attribution wrap, numbers untouched.
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains(STUB_CTKN), "no credential is ever echoed");
    let v: serde_json::Value = serde_json::from_slice(&body).expect("the wrap is JSON");
    assert_eq!(v["venue_id"], "mtpelerin", "the venue attribution");
    assert!(v["fetched_at"].as_u64().is_some(), "the relay's read instant");
    assert_eq!(v["quote"]["destAmount"], "97.7395", "the venue body verbatim");
    assert_eq!(v["quote"]["fees"]["networkFee"], "2.2605");
}

/// The venue's own refusal passes through VERBATIM: same status, the venue's body, no
/// wrap and no relay marker.
#[tokio::test]
async fn quote_error_passes_through_verbatim_unwrapped() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let (status, _h, body) = get_json(
        &state,
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=0",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "the venue's own status");
    let text = String::from_utf8_lossy(&body);
    let v: serde_json::Value = serde_json::from_str(&text).expect("the venue's JSON");
    assert_eq!(v["error"], "amount too low", "the venue's own words, verbatim");
    assert!(v.get("dpayRelayError").is_none(), "NO relay marker");
    assert!(v.get("venue_id").is_none(), "NO attribution wrap on an error");
    assert_eq!(Stub::hits(&stub.quote_hits), 1);
}

/// Malformed quote queries are 400 house errors BEFORE any upstream call: unknown
/// params (no smuggling), missing currencies, both amounts, junk amounts, junk
/// isCardPayment.
#[tokio::test]
async fn quote_malformed_queries_are_refused_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    for bad in [
        "/api/v1/mtpelerin/quote",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF",
        "/api/v1/mtpelerin/quote?destCurrency=CHF",
        "/api/v1/mtpelerin/quote?sourceCurrency=&destCurrency=CHF",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1&destAmount=2",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1,5",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=abc",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1&markup=0.1",
        "/api/v1/mtpelerin/quote?sourceCurrency=ZCHF&destCurrency=CHF&sourceAmount=1&isCardPayment=yes",
    ] {
        let (status, _h, body) = get_json(&state, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("\"error\""), "house shape: {text}");
        assert!(!text.contains("dpayRelayError"), "a 400 device error, not 503-class");
    }
    assert_eq!(Stub::hits(&stub.quote_hits), 0, "zero upstream hits");
}

// ---- the conversion surface ----

/// Order creation: the relay mints the correlation id, passes it upstream as `oid`,
/// answers the venue's body VERBATIM with `X-Dpay-Order-Id`, and the venue's `id` +
/// `offRampAddress` land in the order store (visible through the status route).
#[tokio::test]
async fn conversion_forwards_oid_persists_and_answers_verbatim() {
    let (stub, base) = spawn_stub().await;
    let (now, with_clock) = fake_clock();
    let state = state_with(with_clock(configured(&base)));

    let (status, headers, resp_body) = post_json(&state, "/api/v1/mtpelerin/conversion", &conversion_body()).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&resp_body)
    );
    assert_eq!(Stub::hits(&stub.conversion_hits), 1, "exactly one upstream call");

    // The relay's own correlation id: minted here, carried in the header, passed
    // upstream as `oid`, never the venue's id.
    let order_id = headers
        .get("X-Dpay-Order-Id")
        .and_then(|v| v.to_str().ok())
        .expect("the order id rides X-Dpay-Order-Id")
        .to_string();
    assert!(order_id.starts_with("mtp-"), "{order_id}");
    assert_eq!(order_id.len(), "mtp-".len() + 16, "{order_id}");
    let (seen_headers, seen_uri, seen_body) = stub.last();
    assert_eq!(seen_uri, "/orders");
    let v: serde_json::Value = serde_json::from_str(&seen_body).expect("upstream JSON");
    assert_eq!(v["oid"], order_id, "the correlation id is OURS");
    assert_eq!(v["sourceCurrency"], "ZCHF");
    assert_eq!(v["iban"], "CH9300762011623852957");
    assert_eq!(v["holderName"], "Test Holder");
    assert_eq!(v["sourceAmount"], 100, "the amount rides as a number");
    assert!(seen_headers.get("Authentication").is_none());

    // What the DEVICE got: the venue's answer VERBATIM (an order is not a quote
    // surface — no wrap), no credential echoed.
    let text = String::from_utf8_lossy(&resp_body);
    let v: serde_json::Value = serde_json::from_str(&text).expect("verbatim JSON");
    assert_eq!(v["id"], "664369c938b3ca001a3cd44f");
    assert_eq!(v["offRampAddress"], "0xMTP-DEPOSIT-ADDRESS");
    assert!(v.get("venue_id").is_none(), "NO wrap on an order");
    assert!(!text.contains(STUB_CTKN), "no credential is ever echoed");

    // The store: the status route serves the persisted order (webhook-first, zero
    // upstream) with the offRampAddress + venue id attached.
    now.store(1_000_000 + STATUS_SPACING_SECS + 1, Ordering::SeqCst);
    let (status, _h, body) = get_json(&state, &format!("/api/v1/mtpelerin/conversion?id={order_id}")).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).expect("status JSON");
    assert_eq!(v["order_id"], order_id);
    assert_eq!(v["venue_order_id"], "664369c938b3ca001a3cd44f", "the venue's id persisted");
    assert_eq!(v["offRampAddress"], "0xMTP-DEPOSIT-ADDRESS", "the deposit address persisted");
    assert_eq!(v["terminal"], false, "no completion delivery yet");
    assert_eq!(Stub::hits(&stub.conversion_hits), 1, "the status read made NO upstream call");
}

/// Malformed conversion bodies are 400s BEFORE any upstream call and mint no order.
#[tokio::test]
async fn conversion_refuses_malformed_bodies_before_any_upstream_call() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let ok = serde_json::from_str::<serde_json::Value>(&conversion_body()).unwrap();
    type Mutate = Box<dyn Fn(&mut serde_json::Value)>;
    for (label, mutate) in [
        (
            "drop iban",
            Box::new(|v: &mut serde_json::Value| {
                v.as_object_mut().unwrap().remove("iban");
            }) as Mutate,
        ),
        (
            "empty holderName",
            Box::new(|v: &mut serde_json::Value| {
                v["holderName"] = serde_json::json!("");
            }) as Mutate,
        ),
        (
            "both amounts",
            Box::new(|v: &mut serde_json::Value| {
                v["destAmount"] = serde_json::json!("90");
            }) as Mutate,
        ),
        (
            "no amount",
            Box::new(|v: &mut serde_json::Value| {
                v.as_object_mut().unwrap().remove("sourceAmount");
            }) as Mutate,
        ),
        (
            "junk amount",
            Box::new(|v: &mut serde_json::Value| {
                v["sourceAmount"] = serde_json::json!("1.5.5");
            }) as Mutate,
        ),
        (
            "missing network",
            Box::new(|v: &mut serde_json::Value| {
                v.as_object_mut().unwrap().remove("sourceNetwork");
            }) as Mutate,
        ),
    ] {
        let mut body = ok.clone();
        mutate(&mut body);
        let (status, _h, _b) =
            post_json(&state, "/api/v1/mtpelerin/conversion", &body.to_string()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
        let (status, _h, _b) =
            post_json(&state, "/api/v1/mtpelerin/conversion", "not json").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "not json ({label})");
    }
    assert_eq!(Stub::hits(&stub.conversion_hits), 0, "zero upstream hits on every refusal");
}

// ---- the poll cap (the 1/min fallback discipline) ----

/// The status read is the webhook's FALLBACK: webhook-first (zero upstream), and at
/// most ONE read per id per 60 s — the second read inside the window answers 429
/// `mtpelerin-status-throttled` + `Retry-After`, and the window opens on the clock.
#[tokio::test]
async fn status_reads_are_capped_at_one_per_order_per_minute() {
    let (stub, base) = spawn_stub().await;
    let (now, with_clock) = fake_clock();
    let state = state_with(with_clock(configured(&base)));

    // An unknown id is a 404 — but the read still counts (the promise bounds reads).
    let (status, _h, _body) =
        get_json(&state, "/api/v1/mtpelerin/conversion?id=mtp-does-not-exist0").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, retry, body) =
        get_json(&state, "/api/v1/mtpelerin/conversion?id=mtp-does-not-exist0").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "the second read inside 60s");
    assert_eq!(relay_error_code(&body), "mtpelerin-status-throttled");
    let retry_after = retry
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .expect("Retry-After rides the 429")
        .to_string();
    assert_eq!(retry_after, "60", "the full window remains");

    // A DIFFERENT id is not throttled by the first one's window.
    let (status, _h, _b) = get_json(&state, "/api/v1/mtpelerin/conversion?id=mtp-another-order00").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The window opens when the clock passes it.
    now.store(1_000_000 + STATUS_SPACING_SECS, Ordering::SeqCst);
    let (status, _h, _b) = get_json(&state, "/api/v1/mtpelerin/conversion?id=mtp-does-not-exist0").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "the window opened");

    // Missing/empty id: a client bug, 400, and no window was marked for it.
    for bad in ["/api/v1/mtpelerin/conversion", "/api/v1/mtpelerin/conversion?id="] {
        let (status, _h, _b) = get_json(&state, bad).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(Stub::hits(&stub.quote_hits), 0);
    assert_eq!(Stub::hits(&stub.conversion_hits), 0, "status reads never touch the venue");
}

// ---- the webhook receiver ----

/// The documented delivery body (conversion-webhook.md, fetched 2026-10-12), signed the
/// documented way: HMAC-SHA256 over the FULL raw body, hex, under the exchanged key.
fn webhook_payload(oid: &str, amount: &str) -> String {
    serde_json::json!({
        "id": "664369c938b3ca001a3cd44f",
        "amount": amount.parse::<f64>().unwrap_or(0.0),
        "currency": "ZCHF",
        "external_id": oid,
    })
    .to_string()
}

async fn create_order(state: &AppState) -> String {
    let (status, headers, body) = post_json(state, "/api/v1/mtpelerin/conversion", &conversion_body()).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    headers
        .get("X-Dpay-Order-Id")
        .and_then(|v| v.to_str().ok())
        .expect("the order id header")
        .to_string()
}

/// A good signature on a matched order: 200, the order turns TERMINAL with the FULL
/// payload stored verbatim (visible through the status route).
#[tokio::test]
async fn webhook_good_signature_marks_the_order_terminal() {
    let (_stub, base) = spawn_stub().await;
    let (now, with_clock) = fake_clock();
    let state = state_with(with_clock(configured(&base)));
    let order_id = create_order(&state).await;

    let payload = webhook_payload(&order_id, "1");
    let (status, _h, body) = request_json(
        &state,
        "POST",
        "/api/v1/mtpelerin/webhook",
        Some(&payload),
        &[("Mtp-Signature", &sign(STUB_WEBHOOK_SECRET, payload.as_bytes()))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    now.store(1_000_000 + STATUS_SPACING_SECS + 1, Ordering::SeqCst);
    let (status, _h, body) = get_json(&state, &format!("/api/v1/mtpelerin/conversion?id={order_id}")).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).expect("status JSON");
    assert_eq!(v["terminal"], true, "a matched delivery IS the terminal fact");
    assert_eq!(v["status_ts"].as_u64(), Some(1_000_000), "the delivery instant");
    let stored = v["payload"].as_object().expect("the verbatim payload");
    assert_eq!(stored["external_id"], order_id);
    assert_eq!(stored["currency"], "ZCHF");
    assert_eq!(stored["amount"], 1.0);
    assert_eq!(v["venue_order_id"], "664369c938b3ca001a3cd44f");
}

/// HMAC verify, the refusals: a missing header, a wrong key, a tampered body and a
/// signature reused across bodies all answer 401 and mutate NOTHING (the order stays
/// non-terminal).
#[tokio::test]
async fn webhook_rejects_missing_wrong_tampered_and_replayed_signatures() {
    let (_stub, base) = spawn_stub().await;
    let (now, with_clock) = fake_clock();
    let state = state_with(with_clock(configured(&base)));
    let order_id = create_order(&state).await;
    let payload = webhook_payload(&order_id, "1");
    let signed_original = sign(STUB_WEBHOOK_SECRET, payload.as_bytes());

    let wrong_key_sig = sign("another-secret", payload.as_bytes());
    let tampered = webhook_payload(&order_id, "999");
    let cross_body_sig = sign(STUB_WEBHOOK_SECRET, b"{}");
    let cases: Vec<(&str, Vec<(&str, &str)>, String)> = vec![
        ("missing header", vec![], payload.clone()),
        (
            "wrong key",
            vec![("Mtp-Signature", wrong_key_sig.as_str())],
            payload.clone(),
        ),
        (
            "tampered body (signature over the ORIGINAL body)",
            vec![("Mtp-Signature", &signed_original)],
            tampered,
        ),
        (
            "cross-body signature reuse",
            vec![("Mtp-Signature", cross_body_sig.as_str())],
            payload.clone(),
        ),
        ("garbage header", vec![("Mtp-Signature", "not-hex")], payload.clone()),
    ];
    for (label, headers, body_text) in &cases {
        let header_refs: Vec<(&str, &str)> =
            headers.iter().map(|(k, v)| (*k, *v)).collect();
        let (status, _h, body_bytes) = request_json(
            &state,
            "POST",
            "/api/v1/mtpelerin/webhook",
            Some(body_text),
            &header_refs,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{label}");
        assert_eq!(relay_error_code(&body_bytes), "mtpelerin-webhook-unauthorized", "{label}");
    }

    // Nothing mutated: the order is still non-terminal, no payload stored.
    now.store(1_000_000 + STATUS_SPACING_SECS + 1, Ordering::SeqCst);
    let (status, _h, body) = get_json(&state, &format!("/api/v1/mtpelerin/conversion?id={order_id}")).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).expect("status JSON");
    assert_eq!(v["terminal"], false, "refused deliveries never mutate an order");
    assert!(v["payload"].is_null());
}

/// Terminal dedupe: the FIRST completion wins. A second delivery for the same order
/// (any validly signed body) answers 200 idempotently and NEVER overwrites the stored
/// payload — including across a proxy REBUILD from the same store (the startup replay).
#[tokio::test]
async fn webhook_first_terminal_wins_and_later_deliveries_are_idempotent() {
    let (stub, base) = spawn_stub().await;
    let dir = temp_log_dir("dedupe");
    let (now, with_clock) = fake_clock();
    let state = state_with(with_clock(MtPelerinProxy::new(MtPelerinConfig {
        ctkn: Some(STUB_CTKN.into()),
        webhook_secret: Some(STUB_WEBHOOK_SECRET.into()),
        api_base: base.clone(),
        conversion_path: "/orders".to_string(),
        log_dir: dir.clone(),
        trust_proxy: false,
        status_spacing_secs: STATUS_SPACING_SECS,
    })));
    let order_id = create_order(&state).await;

    let first = webhook_payload(&order_id, "1");
    let (status, _h, _b) = request_json(
        &state,
        "POST",
        "/api/v1/mtpelerin/webhook",
        Some(&first),
        &[("Mtp-Signature", &sign(STUB_WEBHOOK_SECRET, first.as_bytes()))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A LATER delivery (different amount — the venue redelivering, or a replay after a
    // restore) is answered 200 but changes nothing.
    let second = webhook_payload(&order_id, "999");
    assert_ne!(first, second);
    let (status, _h, _b) = request_json(
        &state,
        "POST",
        "/api/v1/mtpelerin/webhook",
        Some(&second),
        &[("Mtp-Signature", &sign(STUB_WEBHOOK_SECRET, second.as_bytes()))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "idempotent: never signal a retry-worthy failure");

    // The stored payload is STILL the first one.
    now.store(1_000_000 + STATUS_SPACING_SECS + 1, Ordering::SeqCst);
    let (status, _h, body) = get_json(&state, &format!("/api/v1/mtpelerin/conversion?id={order_id}")).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).expect("status JSON");
    let stored = v["payload"].as_object().expect("the verbatim payload");
    assert_eq!(stored["amount"], 1.0, "the FIRST terminal payload won");

    // The startup replay preserves the terminal state: a fresh proxy over the SAME
    // store answers the order terminal with the same payload, and the duplicate
    // delivery stays idempotent there too.
    let rebuilt = state_with(with_clock(MtPelerinProxy::new(MtPelerinConfig {
        ctkn: Some(STUB_CTKN.into()),
        webhook_secret: Some(STUB_WEBHOOK_SECRET.into()),
        api_base: base.clone(),
        conversion_path: "/orders".to_string(),
        log_dir: dir,
        trust_proxy: false,
        status_spacing_secs: STATUS_SPACING_SECS,
    })));
    let (status, _h, body) =
        get_json(&rebuilt, &format!("/api/v1/mtpelerin/conversion?id={order_id}")).await;
    assert_eq!(status, StatusCode::OK, "the rebuilt index still knows the order");
    let v: serde_json::Value = serde_json::from_slice(&body).expect("status JSON");
    assert_eq!(v["terminal"], true, "terminal state survives the rebuild");
    assert_eq!(v["payload"]["amount"], 1.0, "the first payload survives the rebuild");
    let (status, _h, _b) = request_json(
        &rebuilt,
        "POST",
        "/api/v1/mtpelerin/webhook",
        Some(&second),
        &[("Mtp-Signature", &sign(STUB_WEBHOOK_SECRET, second.as_bytes()))],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "idempotent on the rebuilt store too");
    assert_eq!(Stub::hits(&stub.conversion_hits), 1, "creation only - nothing else dials upstream");
}

/// A verified delivery whose `external_id` names no order: 200 (authentic venue
/// traffic — a non-2xx could only invite redelivery of what we cannot correlate), no
/// store mutation, no crash.
#[tokio::test]
async fn webhook_verified_but_unknown_id_answers_200_without_mutation() {
    let (_stub, base) = spawn_stub().await;
    let state = state_with(configured(&base));
    let payload = webhook_payload("mtp-no-such-order0000", "1");
    let (status, _h, body) = request_json(
        &state,
        "POST",
        "/api/v1/mtpelerin/webhook",
        Some(&payload),
        &[("Mtp-Signature", &sign(STUB_WEBHOOK_SECRET, payload.as_bytes()))],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).expect("the ok JSON");
    assert_eq!(v["ok"], true);
}
