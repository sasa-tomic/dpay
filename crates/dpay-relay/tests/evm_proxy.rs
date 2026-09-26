//! The EVM RPC proxy (`POST /api/v1/evm/rpc`, `crate::evm` — the Solana pipe's EVM twin) —
//! offline integration tests. Same idioms as `tests/solana_proxy.rs`: `test-helpers` is
//! always on for integration tests (the dev-dependency self-reference), and the suite drives
//! the axum `Router` directly with `tower::ServiceExt::oneshot`.
//!
//! ONE deliberate difference from relay.rs: these tests bind a REAL loopback `TcpListener`.
//! The proxy's whole job is one outbound HTTP call, so the "upstream" is an in-process axum
//! stub on `127.0.0.1:0` with a scripted answer — no packet leaves the machine, the suite
//! stays offline and seconds-fast. The stub's URL carries a FAKE api key
//! (`?api-key=stub-secret`) so every "the secret is never echoed" assertion has teeth.
//!
//! Pinned here, in order: the pure-pipe guarantees (byte-faithful pass-through, no caching of
//! `eth_sendRawTransaction` or unknown methods, no caching of any failure), the allowlist
//! boundary (cached reads vs pass-through methods, `eth_estimateGas` deliberately uncached),
//! the cache (hit, TTL expiry, id-substitution on hit, single-flight, canonical key ordering
//! incl. nested objects, cap eviction expired-first-then-arbitrary), the failure
//! semantics (upstream status relayed verbatim, hang → 504, connection refused → 504,
//! unconfigured → 503 — the relay-ORIGINATED ones carrying the `dpayRelayError` body marker
//! the client walks on), and the chain multiplexing (spec 2026-09-26, D12: the suffix route
//! maps {chain_id} → its own upstream, the bare route stays chain 1, the per-chain cache
//! never cross-answers, an unconfigured served chain is a 503 naming its exact env var, an
//! unknown chain is a 404 `evm-unknown-chain` answered before the body is even read).
//!
//! Route contract pin: a JSON-RPC BATCH (top-level JSON array) is a 400 — the client never
//! batches, and the envelope parse finds no string `method` on an array (see the module
//! header's "Route contract" note in src/evm.rs).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use dpay_relay::evm::{EvmProxy, DEFAULT_TIMEOUT};
use dpay_relay::{app, AppState, FakeLedger, Ledger};
use http_body_util::BodyExt;
use tower::ServiceExt;

// ---- the stub upstream ----

/// What the stub answers for the next request. One script per test — the relay gets ONE
/// upstream and it says the same thing every time; variance comes from making more calls.
#[derive(Clone)]
enum Script {
    /// 200 with a fixed body, after an optional delay (for single-flight/timeout tests).
    Ok { body: String, delay_ms: u64 },
    /// A fixed HTTP error status with a fixed body (for 429 pass-through).
    Status { code: StatusCode, body: String },
    /// Never answers (for the timeout test).
    Hang,
}

/// The stub's shared state: how many requests reached the "provider", the last request body
/// it received (for byte-faithfulness asserts), and what to answer.
#[derive(Clone)]
struct Stub {
    hits: Arc<AtomicUsize>,
    last_body: Arc<Mutex<String>>,
    script: Arc<Mutex<Script>>,
}

impl Stub {
    fn new(script: Script) -> Self {
        Stub {
            hits: Arc::new(AtomicUsize::new(0)),
            last_body: Arc::new(Mutex::new(String::new())),
            script: Arc::new(Mutex::new(script)),
        }
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }

    fn last_body(&self) -> String {
        self.last_body
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// The stub's one route: record the request, answer the script. The lock is released before
/// any await (the script is cloned out under it).
async fn stub_handler(State(stub): State<Stub>, body: Bytes) -> Response {
    stub.hits.fetch_add(1, Ordering::SeqCst);
    *stub.last_body.lock().unwrap_or_else(|p| p.into_inner()) =
        String::from_utf8_lossy(&body).into_owned();
    let script = stub
        .script
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    match script {
        Script::Ok { body, delay_ms } => {
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response()
        }
        Script::Status { code, body } => {
            (code, [(header::CONTENT_TYPE, "application/json")], body).into_response()
        }
        // A hanging upstream: this future never resolves; the RELAY's timeout is under test.
        Script::Hang => std::future::pending().await,
    }
}

/// Bind the stub on an ephemeral loopback port and return (its state, the URL the relay
/// should be given — carrying a FAKE api key so leak-asserts have teeth).
async fn spawn_stub(script: Script) -> (Stub, String) {
    let stub = Stub::new(script);
    let router = Router::new()
        .route("/", post(stub_handler))
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
    (stub, format!("http://{addr}/?api-key=stub-secret"))
}

// ---- the relay under test ----

fn state_with(proxy: EvmProxy) -> AppState {
    let ledger: Arc<dyn Ledger> = Arc::new(FakeLedger::new());
    AppState::new(ledger).with_evm(proxy)
}

/// POST one JSON-RPC envelope to /api/v1/evm/rpc through the real router.
async fn rpc(state: &AppState, body: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    rpc_path(state, "/api/v1/evm/rpc", body).await
}

/// POST to an arbitrary path under /api/v1 — the chain-multiplexing tests (D12) drive the
/// suffix route `/api/v1/evm/rpc/{chain_id}` through the same real router.
async fn rpc_path(state: &AppState, path: &str, body: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("build the rpc request");
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
        .expect("read the rpc response body")
        .to_bytes();
    (status, headers, bytes.to_vec())
}

fn get_balance(id: u64, who: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"eth_getBalance","params":["{who}","latest"]}}"#)
}

/// Parse a relay-originated error body and return its `dpayRelayError` code — the MARKER
/// contract from src/evm.rs ("Failure semantics"): relay failures carry
/// `{"dpayRelayError": <code>, "detail": …}` so the client can tell "the provider answered
/// badly" from "dpay's relay path is down" without parsing prose.
fn relay_error_code(body: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(body)
        .expect("a relay-originated error body is JSON carrying the dpayRelayError marker");
    v["dpayRelayError"]
        .as_str()
        .expect("dpayRelayError is a string")
        .to_string()
}

// ---- the pure pipe ----

/// A MISS returns the upstream body VERBATIM — byte-for-byte, no field munging — and the
/// second identical call is a HIT that never reaches the upstream, with the response still
/// application/json.
#[tokio::test]
async fn miss_body_verbatim_then_hit_never_touches_upstream() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":7,"result":"0x1bc16d674ec80000"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let req = get_balance(7, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");

    let (status, headers, body) = rpc(&state, &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, upstream_body.as_bytes(), "miss: body verbatim");
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(stub.hits(), 1);

    let (status, headers, body) = rpc(&state, &req).await;
    assert_eq!(status, StatusCode::OK);
    // The hit body is a RE-SERIALIZED envelope (the documented id-substitution plumbing), so
    // assert semantically, not byte-for-byte: same id (no substitution needed — same caller),
    // same jsonrpc, and the result subtree untouched.
    let hit: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let upstream: serde_json::Value = serde_json::from_str(upstream_body).unwrap();
    assert_eq!(hit, upstream, "hit: same envelope, same id");
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
    assert_eq!(stub.hits(), 1, "hit: the upstream is never asked again");
}

/// `eth_sendRawTransaction` is the pure pipe's reason to exist: the stub receives the caller's
/// bytes EXACTLY as sent (spacing, key order, everything), the response comes back verbatim,
/// and nothing is ever cached — two identical sends are two upstream calls.
#[tokio::test]
async fn send_raw_transaction_passes_through_byte_faithfully_uncached() {
    let upstream_body =
        r#"{"jsonrpc":"2.0","id":5,"result":"0xabc1230000000000000000000000000000000000000000000000000000000000"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    // Deliberately unusual spacing/ordering: whatever the client serialized is what must land.
    let req = r#"{"params":["0xf86b0184aaa87be082520894abb",  {"gas":"21000","gasPrice":"0x4a817c800"}],"method":"eth_sendRawTransaction","id":5,"jsonrpc":"2.0"}"#;

    let (status, _, body) = rpc(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.last_body(), req, "the stub received the exact bytes");
    assert_eq!(body, upstream_body.as_bytes(), "response verbatim");
    assert_eq!(stub.hits(), 1);

    let (status, _, _) = rpc(&state, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 2, "eth_sendRawTransaction is NEVER cached");
}

/// An unknown method (not on the read allowlist) passes through uncached — the proxy does not
/// get to decide that a method it doesn't know is cacheable.
#[tokio::test]
async fn unknown_method_passes_through_uncached() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let req = r#"{"jsonrpc":"2.0","id":1,"method":"eth_someNewMethod","params":[]}"#;

    for expected_hits in 1..=2 {
        let (status, _, body) = rpc(&state, req).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, upstream_body.as_bytes());
        assert_eq!(stub.hits(), expected_hits, "uncached: every call goes up");
    }
}

/// The allowlist boundary, both sides of it, in one test: `eth_chainId` (allowlisted) is
/// served from the cache on the second identical call, while `eth_estimateGas` (deliberately
/// NOT allowlisted — it feeds a sign-and-send, see READ_METHOD_TTLS) hits the upstream every
/// time even for byte-identical params.
#[tokio::test]
async fn allowlisted_read_is_cached_while_estimate_gas_passes_through() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let chain_id = r#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#;
    let (status, _, _) = rpc(&state, chain_id).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, body) = rpc(&state, chain_id).await;
    assert_eq!(status, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["id"], 1, "hit keeps the (identical) caller id");
    assert_eq!(stub.hits(), 1, "allowlisted read: the second call is a hit");

    let estimate = r#"{"jsonrpc":"2.0","id":2,"method":"eth_estimateGas","params":[{"to":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","value":"0x1"}]}"#;
    for expected_hits in 2..=3 {
        let (status, _, _) = rpc(&state, estimate).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            stub.hits(),
            expected_hits,
            "eth_estimateGas passes through uncached, every time"
        );
    }
}

// ---- the cache ----

/// A HIT re-serializes the stored envelope with the CURRENT caller's id (JSON-RPC clients
/// match by id; the module header owns this decision) while the result subtree is untouched.
#[tokio::test]
async fn hit_rewrites_envelope_id_to_current_caller() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0x1bc16d674ec80000"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let (status, _, body) = rpc(&state, &get_balance(1, "0xaaa1")).await;
    assert_eq!(status, StatusCode::OK);
    let first: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        first["id"], 1,
        "miss: the caller's own round trip, verbatim"
    );

    let (status, _, body) = rpc(&state, &get_balance(99, "0xaaa1")).await;
    assert_eq!(status, StatusCode::OK);
    let second: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(second["id"], 99, "hit: THIS caller's id");
    assert_eq!(
        second["result"], first["result"],
        "hit: the result subtree is carried untouched"
    );
    assert_eq!(stub.hits(), 1);
}

/// TTL expiry: after the window passes, the next call is a MISS (a fresh upstream read) — a
/// cached value is bounded staleness, not a permanent answer.
#[tokio::test]
async fn ttl_expiry_refetches_after_the_window() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":3,"result":"0x7"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let proxy = EvmProxy::new(Some(url), DEFAULT_TIMEOUT);
    // Test seam: 60ms TTL — expiry observable without sleeping a real 2s window.
    proxy.set_ttl_override("eth_getBalance", Duration::from_millis(60));
    let state = state_with(proxy);
    let req = get_balance(3, "0xaaa2");

    let (status, _, _) = rpc(&state, &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 1);
    let (status, _, _) = rpc(&state, &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 1, "inside the window: served from cache");

    tokio::time::sleep(Duration::from_millis(120)).await;
    let (status, _, body) = rpc(&state, &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        upstream_body.as_bytes(),
        "expired: fresh miss, verbatim"
    );
    assert_eq!(stub.hits(), 2, "expired: the upstream is asked again");
}

/// Single-flight: two concurrent identical reads share ONE upstream call — the leader's
/// bytes go up, both callers get the answer, each with their own id.
#[tokio::test]
async fn single_flight_shares_one_upstream_call() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0xb"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        // Slow enough that both callers are provably in flight together.
        delay_ms: 120,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let req1 = get_balance(1, "0xaaa3");
    let req2 = get_balance(2, "0xaaa3");
    let ((s1, _, b1), (s2, _, b2)) = tokio::join!(rpc(&state, &req1), rpc(&state, &req2));
    assert_eq!(s1, StatusCode::OK);
    assert_eq!(s2, StatusCode::OK);
    assert_eq!(
        stub.hits(),
        1,
        "concurrent identical reads: ONE upstream call"
    );
    let v1: serde_json::Value = serde_json::from_slice(&b1).unwrap();
    let v2: serde_json::Value = serde_json::from_slice(&b2).unwrap();
    assert_eq!(v1["id"], 1, "leader: its own bytes' answer");
    assert_eq!(v2["id"], 2, "follower: its id substituted");
    assert_eq!(v1["result"], v2["result"]);
}

/// Canonical key ordering: param objects that differ only in key order are the SAME question
/// (cache hit); a genuinely different param value is a different question (miss).
#[tokio::test]
async fn canonical_key_ordering_makes_param_order_irrelevant() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0x54c98c81e6d91845"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let to = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    let ordered = format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{{"to":"{to}","data":"0x18160ddd"}},"latest"]}}"#
    );
    let shuffled = format!(
        r#"{{"jsonrpc":"2.0","id":8,"method":"eth_call","params":[{{"data":"0x18160ddd","to":"{to}"}},"latest"]}}"#
    );
    let different = format!(
        r#"{{"jsonrpc":"2.0","id":9,"method":"eth_call","params":[{{"to":"{to}","data":"0x70a08231"}},"latest"]}}"#
    );

    let (status, _, _) = rpc(&state, &ordered).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 1);

    let (status, _, body) = rpc(&state, &shuffled).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 1, "same question despite key order");
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["id"], 8, "hit with the shuffled caller's id");

    let (status, _, _) = rpc(&state, &different).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        stub.hits(),
        2,
        "a different param value is a different question"
    );
}

/// Canonical ordering is RECURSIVE: a param object nested inside another param object that
/// differs only in key order is still the same question. The cache key is built by
/// `canonical_json` (sorted keys at every depth), not by the wire bytes — two clients whose
/// serializers disagree about inner-object order still share one upstream read.
#[tokio::test]
async fn nested_object_key_order_is_canonicalized_too() {
    let upstream_body = r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let ordered = r#"{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x1","topics":["0xadd"],"address":"0xc02"}]}"#;
    let shuffled = r#"{"jsonrpc":"2.0","id":2,"method":"eth_getLogs","params":[{"topics":["0xadd"],"address":"0xc02","fromBlock":"0x1"}]}"#;

    let (status, _, _) = rpc(&state, ordered).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.hits(), 1);

    let (status, _, body) = rpc(&state, shuffled).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        stub.hits(),
        1,
        "nested key order alone is not a new question"
    );
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["id"], 2, "hit with the shuffled caller's id");
}

/// Cap eviction, expired-first: entries whose TTL has passed are purged on EVERY insert, so
/// they never occupy the cap and never push a FRESH entry out. With the cap set to 2, two
/// expired entries followed by two fresh inserts leave BOTH fresh entries cached — the fresh
/// pair only both survive because the stale pair was dropped first.
#[tokio::test]
async fn cap_eviction_purges_expired_entries_before_fresh_ones() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let proxy = EvmProxy::new(Some(url), DEFAULT_TIMEOUT);
    proxy.set_ttl_override("eth_getBalance", Duration::from_millis(60));
    proxy.set_cache_cap_override(2); // test seam: eviction observable with 2 entries
    let state = state_with(proxy);

    // Two entries, then let them expire.
    rpc(&state, &get_balance(1, "0xstale1")).await;
    rpc(&state, &get_balance(2, "0xstale2")).await;
    assert_eq!(stub.hits(), 2);
    tokio::time::sleep(Duration::from_millis(120)).await;

    // Two FRESH inserts. The expired pair must be purged on insert (never counted against
    // the cap), so both fresh entries fit WITHOUT evicting each other.
    rpc(&state, &get_balance(3, "0xfresh1")).await;
    rpc(&state, &get_balance(4, "0xfresh2")).await;
    assert_eq!(stub.hits(), 4);

    // Both fresh entries are still cached: two hits, zero upstream calls.
    rpc(&state, &get_balance(3, "0xfresh1")).await;
    rpc(&state, &get_balance(4, "0xfresh2")).await;
    assert_eq!(stub.hits(), 4, "expired entries never evicted a fresh one");
}

/// Cap eviction, arbitrary victim: when the cap is full of FRESH entries, inserting one more
/// evicts an arbitrary pre-existing entry (HashMap iteration order — documented, not LRU).
/// Observables, probed in an order that never re-perturbs the cache: (1) the NEW entry
/// survives its own insert; (2) at least ONE of the two pre-existing entries went missing at
/// that insert. (Probing the victims AFTER the new-entry check: a missed victim's re-insert
/// can itself evict again, so "exactly one miss" is not a stable observable — only ≥1 is.)
#[tokio::test]
async fn cap_eviction_at_full_cap_drops_exactly_one_arbitrary_victim() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let proxy = EvmProxy::new(Some(url), DEFAULT_TIMEOUT);
    proxy.set_cache_cap_override(2);
    let state = state_with(proxy);

    // Fill the cap with two fresh entries, then insert past it.
    rpc(&state, &get_balance(1, "0xvict1")).await;
    rpc(&state, &get_balance(2, "0xvict2")).await;
    rpc(&state, &get_balance(3, "0xnewer")).await;
    assert_eq!(stub.hits(), 3);

    // The NEW entry survived its own insert (the while-loop runs BEFORE the insert) — probed
    // first because a later victim's re-insert is allowed to evict anything, including this.
    rpc(&state, &get_balance(3, "0xnewer")).await;
    assert_eq!(
        stub.hits(),
        3,
        "the inserting entry is never its own victim"
    );

    // At least one pre-existing entry was the arbitrary victim at the third insert (with the
    // cap at 2 and 0xnewer cached, at most one of vict1/vict2 can still be resident).
    rpc(&state, &get_balance(1, "0xvict1")).await;
    rpc(&state, &get_balance(2, "0xvict2")).await;
    assert!(
        stub.hits() >= 4,
        "the cap forced an eviction: at least one pre-existing entry went missing (hits={})",
        stub.hits()
    );
}

// ---- failures: loud, honest, never cached ----

/// An upstream HTTP error status is relayed with the SAME status and the upstream body
/// VERBATIM — and a failure is never cached: the next caller asks again.
#[tokio::test]
async fn upstream_429_is_relayed_verbatim_and_never_cached() {
    let upstream_body =
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Too many requests"}}"#;
    let (stub, url) = spawn_stub(Script::Status {
        code: StatusCode::TOO_MANY_REQUESTS,
        body: upstream_body.to_string(),
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let req = get_balance(1, "0xrate1");

    for expected_hits in 1..=2 {
        let (status, _, body) = rpc(&state, &req).await;
        assert_eq!(
            status,
            StatusCode::TOO_MANY_REQUESTS,
            "same status, verbatim"
        );
        assert_eq!(body, upstream_body.as_bytes(), "same body, verbatim");
        assert_eq!(stub.hits(), expected_hits, "failures are never cached");
    }
}

/// A 200 whose body is a JSON-RPC ERROR envelope is NOT a success: it passes through verbatim
/// and is not cached (never cache a failure — any failure).
#[tokio::test]
async fn jsonrpc_error_envelope_on_200_is_not_cached() {
    let upstream_body =
        r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}"#;
    let (stub, url) = spawn_stub(Script::Ok {
        body: upstream_body.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let req = get_balance(1, "0xrevrt");

    for expected_hits in 1..=2 {
        let (status, _, body) = rpc(&state, &req).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, upstream_body.as_bytes(), "verbatim either way");
        assert_eq!(stub.hits(), expected_hits, "an error envelope is a failure");
    }
}

/// A 200 whose body is NOT EVEN JSON (a captive portal, a proxy error page) is not a success
/// either: it passes through VERBATIM — the pipe does not inspect or repair bodies, and the
/// cache refuses to hold what it cannot classify — so every call re-asks the upstream.
#[tokio::test]
async fn garbage_200_body_passes_through_verbatim_and_is_not_cached() {
    let garbage = "<html>gateway hiccup 1998</html>";
    let (stub, url) = spawn_stub(Script::Ok {
        body: garbage.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));
    let req = get_balance(1, "0xgarbg");

    for expected_hits in 1..=2 {
        let (status, _, body) = rpc(&state, &req).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            garbage.as_bytes(),
            "garbage in, garbage out, verbatim"
        );
        assert_eq!(
            stub.hits(),
            expected_hits,
            "an unparseable body is never cached"
        );
    }
}

/// A hanging upstream yields 504 within the configured timeout, carrying the
/// `evm-upstream-unreachable` MARKER (the client's walk contract) with a detail naming the
/// trouble — and never leaking the upstream URL or its api key (reqwest's error text embeds
/// the URL; the proxy classifies and drops it).
#[tokio::test]
async fn upstream_hang_answers_504_within_timeout_without_leaking_the_url() {
    let (stub, url) = spawn_stub(Script::Hang).await;
    let state = state_with(EvmProxy::new(Some(url), Duration::from_millis(150)));

    let started = Instant::now();
    let (status, _, body) = rpc(&state, &get_balance(1, "0xhang1")).await;
    let elapsed = started.elapsed();
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert!(
        elapsed < Duration::from_secs(2),
        "504 must come at the ~150ms timeout, not hang the caller (took {elapsed:?})"
    );
    assert_eq!(
        relay_error_code(&body),
        "evm-upstream-unreachable",
        "the 504 carries the relay-error marker"
    );
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(
        text.contains("evm upstream unreachable"),
        "the detail names the trouble: {text}"
    );
    assert!(
        !text.contains("stub-secret") && !text.contains("127.0.0.1"),
        "the upstream URL/api key never appears: {text}"
    );
    assert_eq!(stub.hits(), 1);
}

/// No upstream configured (`DPAY_EVM_RPC_URL` unset): the route still ANSWERS — a 503
/// carrying the `evm-unconfigured` MARKER, with a detail naming the exact misconfiguration.
/// An honest refusal, never a fake success, and never a hint of where a real upstream lives.
#[tokio::test]
async fn unset_upstream_answers_503_naming_the_env_var() {
    let state = state_with(EvmProxy::new(None, DEFAULT_TIMEOUT));

    let (status, _, body) = rpc(&state, &get_balance(1, "0xuncfg")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        relay_error_code(&body),
        "evm-unconfigured",
        "the 503 carries the relay-error marker"
    );
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(
        text.contains("DPAY_EVM_RPC_URL"),
        "the detail names the knob: {text}"
    );
    assert!(
        !text.contains("stub-secret") && !text.contains("api-key"),
        "no secret echoes: {text}"
    );
}

/// A connection REFUSED (the upstream address is a loopback port with no listener) is the
/// same relay-originated class as a hang: 504 with the `evm-upstream-unreachable` marker.
/// Pins the `is_connect` branch of `transport_refusal` — a transport refusal that fails
/// instantly, unlike the hang, which pins the timeout branch.
#[tokio::test]
async fn connection_refused_answers_504_with_the_unreachable_marker() {
    // Bind, read the port, drop the listener: the address now refuses connections. Same
    // trick the e2e harness uses for a "dead relay" — the tiny OS port-reuse race is
    // acceptable there and here.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind a listener to learn a closed port");
    let addr = listener.local_addr().expect("ephemeral addr");
    drop(listener);
    let url = format!("http://{addr}/?api-key=stub-secret");
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let (status, _, body) = rpc(&state, &get_balance(1, "0xrefus")).await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(relay_error_code(&body), "evm-upstream-unreachable");
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(
        !text.contains("stub-secret") && !text.contains(&addr.to_string()),
        "the refused address/key never appears: {text}"
    );
}

/// A request body that is not a JSON-RPC envelope is a client bug: 400, saying what was
/// expected — not a forwarding of garbage to the provider.
#[tokio::test]
async fn malformed_request_is_a_400_not_an_upstream_call() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: "{}".to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let (status, _, body) = rpc(&state, "this is not json{").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("JSON"),
        "the 400 says what was wrong"
    );

    let (status, _, _) = rpc(&state, r#"{"jsonrpc":"2.0","id":1,"params":[]}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no string method: 400");
    assert_eq!(stub.hits(), 0, "garbage never reaches the provider");
}

/// A JSON-RPC BATCH (a top-level array of envelopes) is a 400 by the route contract — the
/// app's EVM client never batches, and this pipe promises exactly ONE envelope per POST
/// (module header "Route contract" in src/evm.rs). A batch dies at the envelope parse (an
/// array has no string `method`), never at the provider.
#[tokio::test]
async fn jsonrpc_batch_array_is_a_400_by_contract() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: "{}".to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url), DEFAULT_TIMEOUT));

    let batch = format!(
        "[{},{}]",
        get_balance(1, "0xbtch1"),
        get_balance(2, "0xbtch2")
    );
    let (status, _, body) = rpc(&state, &batch).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a batch is one-call-too-many"
    );
    assert!(
        String::from_utf8_lossy(&body).contains("method"),
        "the 400 says what was missing"
    );
    assert_eq!(stub.hits(), 0, "a batch never reaches the provider");
}

// ---- chain multiplexing (spec 2026-09-26, D12) ----

/// The suffix route maps chain id → per-chain upstream: chain 42161's envelope goes to ITS
/// stub, the bare route (chain 1) stays on the default stub — and each chain's reads cache
/// independently (same (method, params) on two chains is two upstream calls, not one).
#[tokio::test]
async fn suffix_route_serves_the_per_chain_upstream_and_caches_per_chain() {
    let (stub1, url1) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let (stub_arb, url_arb) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0xa4b1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(
        EvmProxy::new(Some(url1), DEFAULT_TIMEOUT).with_chain(42161, Some(url_arb)),
    );
    let req = get_balance(1, "0xmulti");

    // Chain 42161 via the suffix → the Arbitrum stub.
    let (status, _, body) = rpc_path(&state, "/api/v1/evm/rpc/42161", &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub_arb.hits(), 1);
    assert_eq!(stub1.hits(), 0, "no cross-chain bleed");
    assert_eq!(body, r#"{"jsonrpc":"2.0","id":1,"result":"0xa4b1"}"#.as_bytes());

    // The BARE route stays chain 1 → the default stub.
    let (status, _, _) = rpc_path(&state, "/api/v1/evm/rpc", &req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub1.hits(), 1);
    assert_eq!(stub_arb.hits(), 1);

    // Per-chain cache: the same params asked again on 42161 is a HIT (no new upstream call),
    // and on chain 1 likewise — but they were never each other's answers.
    rpc_path(&state, "/api/v1/evm/rpc/42161", &req).await;
    assert_eq!(stub_arb.hits(), 1, "42161's second identical read is a hit");
    rpc_path(&state, "/api/v1/evm/rpc", &req).await;
    assert_eq!(stub1.hits(), 1, "chain 1's second identical read is a hit");
}

/// The bare route IS chain 1 — including the DPAY_EVM_RPC_URL_1 override: a per-chain var for
/// chain 1 wins over the default, exactly as it does for every other chain (D12).
#[tokio::test]
async fn chain_1_per_chain_override_wins_over_the_default() {
    let (stub_default, url_default) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0xdefault"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let (stub_override, url_override) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0xoverride"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(
        EvmProxy::new(Some(url_default), DEFAULT_TIMEOUT)
            .with_chain(1, Some(url_override)),
    );
    let (status, _, body) = rpc(&state, &get_balance(1, "0xdef1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        r#"{"jsonrpc":"2.0","id":1,"result":"0xoverride"}"#.as_bytes(),
        "the per-chain override served chain 1"
    );
    assert_eq!(stub_override.hits(), 1);
    assert_eq!(stub_default.hits(), 0);
}

/// NO cross-chain fallback, ever: a served chain without its own upstream answers the honest
/// 503 `evm-unconfigured` marker naming the EXACT variable — even when ANOTHER chain (here the
/// default, chain 1) is fully configured. Pointing 42161's traffic at a chain-1 node would be
/// a wrong-chain answer, not a degraded mode.
#[tokio::test]
async fn unconfigured_chain_answers_503_naming_its_own_env_var_without_fallback() {
    let (stub1, url1) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url1), DEFAULT_TIMEOUT));

    let (status, _, body) = rpc_path(&state, "/api/v1/evm/rpc/42161", &get_balance(1, "0xnofb")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        relay_error_code(&body),
        "evm-unconfigured",
        "the 503 carries the relay-error marker"
    );
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(
        text.contains("DPAY_EVM_RPC_URL_42161"),
        "the detail names the EXACT missing knob: {text}"
    );
    assert_eq!(stub1.hits(), 0, "chain 1's upstream was never borrowed");
}

/// A chain id outside the served set (or a non-numeric path segment) is a 404 carrying the
/// `evm-unknown-chain` marker: the relay will never serve that chain, so a walking client
/// stops instead of trying the next candidate. Routing happens BEFORE the body is read — a
/// garbage body on an unknown chain is still the 404.
#[tokio::test]
async fn unknown_chain_answers_404_with_the_marker_before_any_body_parse() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(Some(url.clone()), DEFAULT_TIMEOUT));

    for path in [
        "/api/v1/evm/rpc/999",   // numeric, not in SERVED_CHAINS
        "/api/v1/evm/rpc/abc",   // not a number at all
        "/api/v1/evm/rpc/0x1",   // hex-looking — the suffix is decimal
    ] {
        let (status, _, body) = rpc_path(&state, path, &get_balance(1, "0xunkno")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(relay_error_code(&body), "evm-unknown-chain", "{path}");
        // …and routing precedes parsing: even a garbage body gets the same 404.
        let (status, _, _) = rpc_path(&state, path, "this is not json{").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path} (garbage body)");
    }
    assert_eq!(stub.hits(), 0, "an unknown chain never reaches any upstream");

    // Sanity: the marker's detail names the served set (fixed strings only — no URL, no key).
    let (_, _, body) = rpc_path(&state, "/api/v1/evm/rpc/999", &get_balance(1, "0xunkno")).await;
    let text = String::from_utf8_lossy(&body).into_owned();
    assert!(text.contains("42161"), "detail names the served set: {text}");
    assert!(
        !text.contains("stub-secret"),
        "no secret echoes through the detail: {text}"
    );
}

/// The suffix route keeps EVERY pure-pipe guarantee: `eth_sendRawTransaction` over
/// /api/v1/evm/rpc/31337 goes out byte-faithfully and is never cached — multiplexing changes
/// WHERE the pipe points, never HOW it behaves.
#[tokio::test]
async fn suffix_route_send_is_byte_faithful_and_uncached() {
    let (stub, url) = spawn_stub(Script::Ok {
        body: r#"{"jsonrpc":"2.0","id":9,"result":"0xtxhash"}"#.to_string(),
        delay_ms: 0,
    })
    .await;
    let state = state_with(EvmProxy::new(None, DEFAULT_TIMEOUT).with_chain(31337, Some(url)));
    // Deliberately unusual spacing/ordering: whatever the client serialized is what must land.
    let req = r#"{"params":["0xdeadbeef"],"method":"eth_sendRawTransaction","id":9,"jsonrpc":"2.0"}"#;

    let (status, _, body) = rpc_path(&state, "/api/v1/evm/rpc/31337", req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stub.last_body(), req, "the stub received the exact bytes");
    assert_eq!(body, r#"{"jsonrpc":"2.0","id":9,"result":"0xtxhash"}"#.as_bytes());

    rpc_path(&state, "/api/v1/evm/rpc/31337", req).await;
    assert_eq!(stub.hits(), 2, "sends are NEVER cached on any chain");
}
