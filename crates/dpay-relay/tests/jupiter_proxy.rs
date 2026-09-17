//! The Jupiter proxy (`GET /api/v1/jupiter/quote` + `POST /api/v1/jupiter/swap`) —
//! offline integration tests, same idioms as `tests/sideshift_proxy.rs`: `test-helpers`
//! is always on for integration tests (the dev-dependency self-reference), the suite
//! drives the axum `Router` directly with `tower::ServiceExt::oneshot`, and the
//! "upstream" is a REAL loopback `TcpListener` running an in-process axum stub — no
//! packet leaves the machine, the suite stays offline and seconds-fast.
//!
//! Pinned here, in order:
//! - pipe-through fidelity: a quote GET and a swap POST come back with the upstream's
//!   status and EXACT body bytes (no wrap, no envelope, no re-serialization — the device
//!   must receive Jupiter's own JSON, and the swap POST must forward the device's body
//!   verbatim, since it carries the quoteResponse the venue binds the answer to);
//! - upstream HTTP errors pass through VERBATIM (status + body, no `dpayRelayError`
//!   marker — whatever refused is the venue, not us), and are never cached;
//! - transport death: hang → 504 within the timeout, connection refused → 504, both with
//!   the `jupiter-upstream-unreachable` marker and NO URL in the body;
//! - the quote cache: two identical GETs → ONE upstream hit within the TTL; reordered
//!   query params share the canonical key (one hit); a TTL expiry (test-seam override)
//!   re-arms the upstream; a DIFFERENT query is its own key;
//! - the swap POST is NEVER cached: two identical POSTs → two upstream hits, and a swap
//!   after a cached quote still reaches the upstream;
//! - no 503 state exists: there is nothing to configure — a proxy is always fully armed
//!   (every test above runs against a plain `JupiterProxy::new(base, timeout)`).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{RawQuery, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use dpay_relay::jupiter::{JupiterProxy, UPSTREAM_UNREACHABLE, DEFAULT_TIMEOUT};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use http_body_util::BodyExt;
use tower::ServiceExt;

const SOL: &str = "So11111111111111111111111111111111111111112";
const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---- the stub upstream ----

/// What the stub's quote route answers: the happy echo, a scripted error (status + body
/// — the upstream-error-passthrough test), or a hang (the transport-timeout test).
#[derive(Clone)]
enum QuoteReply {
    Ok,
    Error(StatusCode, String),
    Hang,
}

/// The stub's shared state: per-route hit counts, the scripted quote reply, and the last
/// raw arrivals (query string / body) each route received.
#[derive(Clone)]
struct Stub {
    quote_hits: Arc<AtomicUsize>,
    swap_hits: Arc<AtomicUsize>,
    quote_reply: Arc<Mutex<QuoteReply>>,
    last_quote_query: Arc<Mutex<String>>,
    last_swap_body: Arc<Mutex<String>>,
    swap_hang: Arc<AtomicBool>,
}

impl Stub {
    fn new() -> Self {
        Stub {
            quote_hits: Arc::new(AtomicUsize::new(0)),
            swap_hits: Arc::new(AtomicUsize::new(0)),
            quote_reply: Arc::new(Mutex::new(QuoteReply::Ok)),
            last_quote_query: Arc::new(Mutex::new(String::new())),
            last_swap_body: Arc::new(Mutex::new(String::new())),
            swap_hang: Arc::new(AtomicBool::new(false)),
        }
    }

    fn quote_hits(&self) -> usize {
        self.quote_hits.load(Ordering::SeqCst)
    }

    fn swap_hits(&self) -> usize {
        self.swap_hits.load(Ordering::SeqCst)
    }

    fn last_quote_query(&self) -> String {
        self.last_quote_query
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn last_swap_body(&self) -> String {
        self.last_swap_body
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// GET /swap/v1/quote — the venue's quote shape (lite-api.jup.ag, verified live
/// 2026-09-14): 200 with the mint/amount echo + the quote figures. The happy body is
/// written with DELIBERATE spacing so the byte-fidelity assertion can tell a verbatim
/// pipe from a re-serialization.
async fn stub_quote(State(stub): State<Stub>, RawQuery(raw): RawQuery) -> Response {
    stub.quote_hits.fetch_add(1, Ordering::SeqCst);
    *stub.last_quote_query.lock().unwrap_or_else(|p| p.into_inner()) = raw.unwrap_or_default();
    let reply = stub
        .quote_reply
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    match reply {
        QuoteReply::Ok => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            Bytes::from(format!(
                "{{\"inputMint\": \"{SOL}\", \"outputMint\": \"{USDC}\", \
                 \"inAmount\": \"1000000000\", \"outAmount\": \"10360000\"}}"
            )),
        )
            .into_response(),
        QuoteReply::Error(status, body) => (
            status,
            [(header::CONTENT_TYPE, "application/json")],
            Bytes::from(body),
        )
            .into_response(),
        // Transport trouble: hold the connection open past any sane timeout, then 200
        // (the caller must already be gone — the timeout fired long before).
        QuoteReply::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            (StatusCode::OK, Bytes::from("{\"late\":true}")).into_response()
        }
    }
}

/// POST /swap/v1/swap — the venue's swap-tx shape: 200 with `{swapTransaction,
/// lastValidBlockHeight}`. Records the body it received (the device's quoteResponse POST
/// must arrive verbatim) and can be scripted to hang.
async fn stub_swap(State(stub): State<Stub>, body: Bytes) -> Response {
    stub.swap_hits.fetch_add(1, Ordering::SeqCst);
    *stub.last_swap_body.lock().unwrap_or_else(|p| p.into_inner()) =
        String::from_utf8_lossy(&body).into_owned();
    if stub.swap_hang.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        Bytes::from(
            "{\"swapTransaction\": \"AgAAA\", \"lastValidBlockHeight\": 300000000}",
        ),
    )
        .into_response()
}

/// Bind the stub on an ephemeral loopback port; return (its state, the API BASE the
/// relay should be given — the proxy appends `/swap/v1/quote` and `/swap/v1/swap`).
async fn spawn_stub() -> (Stub, String) {
    let stub = Stub::new();
    let router = Router::new()
        .route("/swap/v1/quote", get(stub_quote))
        .route("/swap/v1/swap", axum::routing::post(stub_swap))
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

fn state_with(proxy: JupiterProxy) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_jupiter(proxy)
}

/// A proxy pointed at the given stub base, with the standard timeout.
fn proxy_at(base: &str) -> JupiterProxy {
    JupiterProxy::new(base.to_string(), DEFAULT_TIMEOUT)
}

async fn send(
    state: &AppState,
    method: &str,
    uri: &str,
    body: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ACCEPT, "application/json");
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let req = builder
        .body(Body::from(body.unwrap_or("").to_string()))
        .expect("build the jupiter request");
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

async fn get_quote(state: &AppState, query: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(state, "GET", &format!("/api/v1/jupiter/quote?{query}"), None).await
}

async fn post_swap(state: &AppState, body: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    send(state, "POST", "/api/v1/jupiter/swap", Some(body)).await
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

fn quote_query() -> String {
    format!("inputMint={SOL}&outputMint={USDC}&amount=1000000000&slippageBps=100")
}

fn swap_body() -> String {
    serde_json::json!({
        "quoteResponse": {"inputMint": SOL, "outputMint": USDC, "inAmount": "1000000000"},
        "userPublicKey": "DeviceSolanaAddress11111111111111111111111111",
        "wrapAndUnwrapSol": true,
        "asLegacyTransaction": true,
    })
    .to_string()
}

// ---- pipe-through fidelity ----

/// The quote pipe: 200 + the upstream's EXACT body bytes. The deliberate spacing in the
/// stub's reply would not survive a parse-and-reserialize; only a verbatim pipe does.
#[tokio::test]
async fn quote_pipes_upstream_body_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let (status, headers, body) = get_quote(&state, &quote_query()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let expected = format!(
        "{{\"inputMint\": \"{SOL}\", \"outputMint\": \"{USDC}\", \
         \"inAmount\": \"1000000000\", \"outAmount\": \"10360000\"}}"
    );
    assert_eq!(
        String::from_utf8_lossy(&body),
        expected,
        "the quote body is byte-faithful — no wrap, no envelope, no re-serialization"
    );
    assert_eq!(stub.quote_hits(), 1);
    // The upstream got the CANONICAL (sorted) query — the cache key and the upstream
    // query are the same string.
    assert_eq!(
        stub.last_quote_query(),
        format!("amount=1000000000&inputMint={SOL}&outputMint={USDC}&slippageBps=100")
    );
}

/// The swap pipe: the device's body reaches the upstream EXACTLY as posted (it carries
/// the quoteResponse the venue binds the answer to), and the answer's swapTransaction
/// reaches the device unmodified.
#[tokio::test]
async fn swap_pipes_both_ways_verbatim() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let posted = swap_body();
    let (status, _h, body) = post_swap(&state, &posted).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.last_swap_body(), posted, "upstream sees the exact bytes");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["swapTransaction"], "AgAAA");
    assert_eq!(v["lastValidBlockHeight"], 300000000);
    assert_eq!(stub.swap_hits(), 1);
}

// ---- upstream errors pass through verbatim ----

/// An upstream HTTP error keeps its OWN status and body — no marker, no wrap (whatever
/// refused is the venue) — and a failure is NEVER cached (the retry gets a fresh upstream
/// call, and the upstream sees it).
#[tokio::test]
async fn upstream_error_passes_through_verbatim_and_is_never_cached() {
    let (stub, base) = spawn_stub().await;
    *stub.quote_reply.lock().unwrap_or_else(|p| p.into_inner()) = QuoteReply::Error(
        StatusCode::BAD_REQUEST,
        "{\"errorCode\":\"SLIPPAGE_OUT_OF_RANGE\",\"errorMessage\":\"too wide\"}".into(),
    );
    let state = state_with(proxy_at(&base));

    for _ in 0..2 {
        let (status, _h, body) = get_quote(&state, &quote_query()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "the venue's own status");
        assert_eq!(
            String::from_utf8_lossy(&body),
            "{\"errorCode\":\"SLIPPAGE_OUT_OF_RANGE\",\"errorMessage\":\"too wide\"}",
            "the venue's own body, verbatim"
        );
        assert!(
            serde_json::from_slice::<serde_json::Value>(&body)
                .unwrap()
                .get("dpayRelayError")
                .is_none(),
            "an upstream error carries NO relay marker"
        );
    }
    assert_eq!(stub.quote_hits(), 2, "failures are never served from cache");
}

/// A 5xx from the venue behaves the same: verbatim status + body, never cached.
#[tokio::test]
async fn upstream_5xx_passes_through_verbatim() {
    let (stub, base) = spawn_stub().await;
    *stub.quote_reply.lock().unwrap_or_else(|p| p.into_inner()) =
        QuoteReply::Error(StatusCode::SERVICE_UNAVAILABLE, "{\"up\":false}".into());
    let state = state_with(proxy_at(&base));
    let (status, _h, body) = get_quote(&state, &quote_query()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(String::from_utf8_lossy(&body), "{\"up\":false}");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v.get("dpayRelayError").is_none(), "no relay marker");
}

// ---- transport death ----

/// A hung upstream dies at the per-call timeout: 504 within a bounded time, carrying the
/// `jupiter-upstream-unreachable` marker, with NO URL in the body (a reqwest error embeds
/// the request URL — it is dropped, not formatted).
#[tokio::test]
async fn hung_upstream_answers_504_with_marker_within_timeout() {
    let (stub, base) = spawn_stub().await;
    *stub.quote_reply.lock().unwrap_or_else(|p| p.into_inner()) = QuoteReply::Hang;
    // A 300ms timeout keeps the test fast while proving the timeout actually fires.
    let state = state_with(JupiterProxy::new(base, Duration::from_millis(300)));
    let started = std::time::Instant::now();
    let (status, _h, body) = get_quote(&state, &quote_query()).await;
    assert!(started.elapsed() < Duration::from_secs(5), "bounded, not hung");
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), UPSTREAM_UNREACHABLE);
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("http"), "no URL in the body: {text}");
    assert!(!text.contains("127.0.0.1"), "no host in the body: {text}");
}

/// A dead upstream (nothing listening) is the same honest 504 marker — the route is
/// registered and serving; the VENUE is what is unreachable.
#[tokio::test]
async fn dead_upstream_answers_504_with_marker() {
    // Bind then drop a listener: the port is free, so connects are refused immediately.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("ephemeral bind");
    let addr = listener.local_addr().expect("ephemeral addr");
    drop(listener);
    let state = state_with(JupiterProxy::new(
        format!("http://{addr}"),
        Duration::from_millis(2000),
    ));
    let (status, _h, body) = get_quote(&state, &quote_query()).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), UPSTREAM_UNREACHABLE);
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("http"), "no URL in the body: {text}");
}

/// The swap POST's transport death is the same 504 marker (never a silent 200).
#[tokio::test]
async fn swap_transport_death_answers_504_with_marker() {
    let (stub, base) = spawn_stub().await;
    stub.swap_hang.store(true, Ordering::SeqCst);
    let state = state_with(JupiterProxy::new(base, Duration::from_millis(300)));
    let (status, _h, body) = post_swap(&state, &swap_body()).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), UPSTREAM_UNREACHABLE);
}

// ---- the quote cache ----

/// Two identical GETs within the TTL → ONE upstream hit (the founder ask's "caching etc").
#[tokio::test]
async fn identical_quotes_share_one_upstream_call_within_ttl() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let q = quote_query();
    let (s1, _h1, b1) = get_quote(&state, &q).await;
    let (s2, _h2, b2) = get_quote(&state, &q).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(b1, b2, "the cached answer is the same bytes");
    assert_eq!(stub.quote_hits(), 1, "the second ask never left the relay");
}

/// The cache key is the CANONICAL (sorted) query: the same params in any order share one
/// entry — one upstream call, and the upstream still gets a well-formed query.
#[tokio::test]
async fn reordered_params_share_the_canonical_key() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let a = format!("inputMint={SOL}&outputMint={USDC}&amount=7&slippageBps=100");
    let b = format!("slippageBps=100&amount=7&outputMint={USDC}&inputMint={SOL}");
    let (s1, _h1, b1) = get_quote(&state, &a).await;
    let (s2, _h2, b2) = get_quote(&state, &b).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(b1, b2);
    assert_eq!(stub.quote_hits(), 1, "order variants dedup to one upstream call");
}

/// A DIFFERENT query is its own key: two distinct asks both reach the upstream.
#[tokio::test]
async fn different_queries_are_distinct_cache_keys() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let a = format!("inputMint={SOL}&outputMint={USDC}&amount=7&slippageBps=100");
    let b = format!("inputMint={SOL}&outputMint={USDC}&amount=9&slippageBps=100");
    let (s1, _h1, _b1) = get_quote(&state, &a).await;
    let (s2, _h2, _b2) = get_quote(&state, &b).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(stub.quote_hits(), 2, "different params never share a quote");
}

/// TTL expiry re-arms the upstream: with the test-seam override at 60ms, a second ask
/// after expiry makes a FRESH upstream call (the cache collapses identical asks within
/// the TTL, it never serves an old price as fresh).
#[tokio::test]
async fn ttl_expiry_re_arms_the_upstream() {
    let (stub, base) = spawn_stub().await;
    let proxy = proxy_at(&base);
    proxy.set_ttl_override(Duration::from_millis(60));
    let state = state_with(proxy);
    let q = quote_query();
    let (_s1, _h1, _b1) = get_quote(&state, &q).await;
    assert_eq!(stub.quote_hits(), 1);
    // Within the TTL: still one hit.
    let (_s2, _h2, _b2) = get_quote(&state, &q).await;
    assert_eq!(stub.quote_hits(), 1, "fresh entry serves from cache");
    // Past expiry: a fresh upstream call, and the replaced entry serves again.
    tokio::time::sleep(Duration::from_millis(120)).await;
    let (_s3, _h3, b3) = get_quote(&state, &q).await;
    assert_eq!(stub.quote_hits(), 2, "expired entries never answer");
    assert!(b3.starts_with(b"{"), "the refreshed answer is the venue's body");
}

/// The swap POST is NEVER cached — two identical POSTs make two upstream calls (the
/// quoteResponse may have gone stale in between; the venue is the authority), and a swap
/// after a cached quote still reaches the upstream rather than being answered locally.
#[tokio::test]
async fn swap_is_never_cached() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    // Warm the quote cache first: the swap must not be answered from it either way.
    let (_s, _h, _b) = get_quote(&state, &quote_query()).await;
    let body = swap_body();
    let (s1, _h1, b1) = post_swap(&state, &body).await;
    let (s2, _h2, b2) = post_swap(&state, &body).await;
    assert_eq!((s1, s2), (StatusCode::OK, StatusCode::OK));
    assert_eq!(b1, b2);
    assert_eq!(stub.swap_hits(), 2, "every swap POST reaches the venue");
    assert_eq!(stub.quote_hits(), 1, "the quote was cached, the swaps were not");
}

// ---- malformed device requests ----

/// An empty or oversized query is refused BEFORE any upstream call, in the house
/// `{"error": …}` shape — a client bug, not a relay-path fact.
#[tokio::test]
async fn empty_or_oversized_query_is_a_house_400_before_upstream() {
    let (stub, base) = spawn_stub().await;
    let state = state_with(proxy_at(&base));
    let (s1, _h1, b1) = send(&state, "GET", "/api/v1/jupiter/quote", None).await;
    assert_eq!(s1, StatusCode::BAD_REQUEST);
    let v1: serde_json::Value = serde_json::from_slice(&b1).unwrap();
    assert!(v1.get("error").is_some(), "house shape: {b1:?}");
    let huge = format!("{}=x", "a".repeat(2049));
    let (s2, _h2, _b2) = get_quote(&state, &huge).await;
    assert_eq!(s2, StatusCode::BAD_REQUEST);
    assert_eq!(stub.quote_hits(), 0, "nothing reached the upstream");
}
