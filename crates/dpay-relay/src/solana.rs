//! The Solana JSON-RPC proxy — `POST /api/v1/solana/rpc` (spec 2026-09-09, Direction 1).
//!
//! A PURE PIPE with a read cache. The app POSTs its JSON-RPC envelope here verbatim
//! (`{jsonrpc:"2.0", id, method, params}`); the relay forwards the ORIGINAL BYTES to the
//! configured upstream and answers with the upstream's body VERBATIM on a miss. It does not
//! inspect, rewrite, hold, queue or reorder anything — anything beyond that is a participant,
//! not a pipe (founder rule; REGULATORY.md §4.3's objection was recorded and over-ruled, see
//! the spec). The ONE thing read out of the envelope is the `method` field, and only to decide
//! routing: allowlisted reads go through the shared TTL cache below, everything else —
//! `sendTransaction` above all, and any unknown method — passes straight through with zero
//! caching and zero single-flight.
//!
//! Why this exists: the free-tier RPC quota. N wallets asking the same question (a balance, a
//! blockhash) become 1 upstream request. The cache applies ONLY to the explicit READ allowlist
//! in [`READ_METHOD_TTLS`]; a cache HIT is bounded staleness of at most that method's TTL — and
//! the trade is made here, in the relay, never in the client (no cached value is EVER
//! substituted for a failed read: on upstream failure the caller gets the failure).
//!
//! # The id-substitution decision
//!
//! A cached body carries the FIRST caller's JSON-RPC `id`, but ids are per-request — a JSON-RPC
//! client matches responses by id and must not tolerate a mismatch. So on a cache hit (and for
//! single-flight followers) the stored envelope is re-serialized with the CURRENT caller's id.
//! This is response-envelope plumbing only: the `result` subtree is carried untouched, and it
//! is pinned by tests (`read_hit_…rewrites_id`, `single_flight_…`). A caller whose envelope has
//! no `id` (a notification) gets the stored body verbatim. The MISS path never substitutes:
//! the body a solo caller's own request produced is returned byte-for-byte.
//!
//! # Failure semantics (loud, honest)
//!
//! Two KINDS of failure come back from this route, and the client must be able to tell them
//! apart without trusting prose:
//!
//! - Upstream HTTP error status (429/500/…) → SAME status, upstream body VERBATIM. Whatever
//!   answered is the PROVIDER, not the relay.
//! - Relay-originated failures (and ONLY these two) carry a machine-readable marker in the
//!   BODY: `{"dpayRelayError":"solana-upstream-unreachable", "detail":"…"}` for an upstream
//!   transport failure/timeout (504), and `{"dpayRelayError":"solana-unconfigured",`
//!   `"detail":"…"}` when `DPAY_SOLANA_RPC_URL` is unset (503). A body marker, not a response
//!   header: response headers are unreadable cross-origin unless the relay also plays the
//!   CORS `Access-Control-Expose-Headers` game, while a body field the client already reads
//!   needs no new dance. The `dpayRelayError` CODE is the contract (`solana-unconfigured` |
//!   `solana-upstream-unreachable`); `detail` is a short human phrase that may change at any
//!   time and must never be parsed.
//! - The 400s for a malformed envelope keep the house `{"error": …}` shape — they are client
//!   bugs, not relay-path facts, and nothing walks or classifies on them.
//!
//! The reqwest error text is NEVER included in a 504: it embeds the request URL, and the URL
//! carries the provider api key.
//! - `DPAY_SOLANA_RPC_URL` unset → the route is still REGISTERED (always, on every build —
//!   unlike the checkout there is no registration gate) and answers the 503 marker above: an
//!   honest refusal, never a fake success.
//! - No silent retries. No queueing. No redirects followed (`Policy::none`): the pipe forwards
//!   exactly one hop, and an upstream that moves is surfaced, not chased.
//!
//! # Route contract
//!
//! `POST /api/v1/solana/rpc` takes exactly ONE JSON-RPC envelope (`{jsonrpc, id, method,
//! params}`). A JSON-RPC BATCH (a top-level JSON array of envelopes) is a 400 — the envelope
//! parse below finds no string `method` on an array. That is deliberate and pinned: the app's
//! client (`app/solana/rpc.ts`) never batches (one request per call, by design — a batch
//! couples unrelated calls to one fate), so batches are not a shape this pipe promises to
//! forward. Do not "fix" this into a passthrough without changing the client and this note.
//!
//! # Secrets
//!
//! `DPAY_SOLANA_RPC_URL` is deploy config containing a provider api key: it is never logged,
//! never echoed in any response, and never in the repo (it lives in `deploy/.env`, see
//! docs/OPS.md §3). Every error body in this module is a fixed string for exactly that reason.
//!
//! # Cache shape (deliberately small)
//!
//! One `Mutex<HashMap>` of `(method, canonical params)` → `(upstream success body, expiry)`,
//! with lazy expired-entry cleanup on insert and a hard size cap with expired-first eviction —
//! bounded and explainable, not an LRU empire. Single-flight rides a second map of
//! `tokio::sync::OnceCell`s keyed the same way: concurrent identical reads share ONE upstream
//! call (first one wins, followers get its answer, with their own id substituted); tokio's
//! `OnceCell` makes concurrent `get_or_init` callers wait for the in-progress initialization.
//! Failures are never cached, and never answered from cache: an upstream that would fail is
//! one the caller gets to hear about.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use tokio::sync::OnceCell;

use crate::AppState;

/// The READ allowlist — the ONLY methods the proxy may cache, each with its TTL (seconds).
/// Everything else, known or unknown, is a pure pass-through. The values are deliberate:
pub const READ_METHOD_TTLS: &[(&str, u64)] = &[
    // Balances/account state: the wallet's poll cadence is ~2s, so a 2s TTL turns every
    // concurrent poll across wallets into one upstream read while never being staler than
    // what the next poll would show anyway.
    ("getBalance", 2),
    ("getAccountInfo", 2),
    ("getMultipleAccounts", 2),
    ("getTokenAccountBalance", 2),
    // Chain progress probes: intentionally near-live, they gate retry loops.
    ("getBlockHeight", 2),
    ("isBlockhashValid", 2),
    ("getSignatureStatuses", 2),
    ("getHealth", 2),
    // The blockhash a send will be checked against: 4s ≈ how long a fresh one stays the
    // right answer to "what's current" without serving one a newer caller would reject.
    ("getLatestBlockhash", 4),
    // History: newest-first lists and single-tx lookups; 5s batches the "did it land?" poll.
    ("getSignaturesForAddress", 5),
    ("getTransaction", 5),
    // Fees are stable for minutes at a time; 60s collapses every wallet's fee preview.
    ("getFeeForMessage", 60),
    // The chain id changes never; an hour is arbitrarily short.
    ("getGenesisHash", 3600),
];

/// Per-upstream-call timeout default. Configurable via `DPAY_SOLANA_TIMEOUT_MS` (main.rs).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Hard cap on cached entries. A few thousand small JSON envelopes is single-digit MB; past
/// that something is wrong upstream of this cache, and evicting beats growing.
const MAX_CACHE_ENTRIES: usize = 4096;

/// The proxy's state: the upstream URL (secret — see the module header), the shared HTTP
/// client, and the two maps that make the free tier survive (TTL cache + single-flight).
/// Cloned into an `Arc` on [`AppState`]; the interior Mutexes are the repo's poison-tolerant
/// kind and are never held across an await.
pub struct SolanaProxy {
    upstream: Option<String>,
    timeout: Duration,
    client: reqwest::Client,
    /// `(method, canonical params)` → cached upstream SUCCESS body + expiry (ms since epoch).
    cache: Mutex<HashMap<String, CachedEntry>>,
    /// Same key → the shared outcome of the one in-flight upstream call, so concurrent
    /// identical reads share it. Removed on completion; the TTL cache takes over from there.
    inflight: Mutex<HashMap<String, Arc<OnceCell<Outcome>>>>,
    /// Test-only TTL overrides (sub-second windows so expiry is observable without sleeping
    /// for real TTLs). Empty in production — [`READ_METHOD_TTLS`] is the authority.
    ttl_overrides: Mutex<HashMap<String, Duration>>,
    /// Test-only cache-cap override (a tiny cap makes cap eviction observable without
    /// thousands of inserts). `None` in production — [`MAX_CACHE_ENTRIES`] is the authority.
    cache_cap_override: Mutex<Option<usize>>,
}

/// One cached read: the upstream's success body VERBATIM (only ever re-serialized for the
/// id-substitution documented in the module header) and when it expires.
struct CachedEntry {
    body: Bytes,
    expires_at_ms: u64,
}

/// One completed upstream call, shared between the single-flight leader and its followers:
/// the upstream status (200, or an error status to relay verbatim) and the upstream body.
#[derive(Clone)]
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

impl SolanaProxy {
    /// Build the proxy. `upstream` is the full provider URL including its api key
    /// (`DPAY_SOLANA_RPC_URL`); `None` leaves the route registered but answering 503.
    pub fn new(upstream: Option<String>, timeout: Duration) -> Self {
        SolanaProxy {
            upstream,
            timeout,
            client: shared_client(),
            cache: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            ttl_overrides: Mutex::new(HashMap::new()),
            cache_cap_override: Mutex::new(None),
        }
    }

    /// Test seam ONLY: shrink one method's TTL (e.g. to 60ms) so expiry is observable without
    /// sleeping a real TTL. Production reads [`READ_METHOD_TTLS`] and never calls this. Public
    /// because integration tests link the lib crate; deliberately NOT feature-gated — a gated
    /// *field* that no-feature builds never read would be a dead-code warning, and this is
    /// smaller than the faucet's map.
    pub fn set_ttl_override(&self, method: &str, ttl: Duration) {
        self.ttl_overrides
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(method.to_string(), ttl);
    }

    /// Test seam ONLY: shrink the cache's size cap (e.g. to 2) so cap eviction is observable
    /// without inserting thousands of entries. Production uses [`MAX_CACHE_ENTRIES`] and never
    /// calls this. Same exposure reasoning as [`set_ttl_override`].
    pub fn set_cache_cap_override(&self, cap: usize) {
        *self
            .cache_cap_override
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(cap);
    }

    /// The TTL for a cacheable method, or `None` for everything that must pass through
    /// uncached (`sendTransaction`, unknown methods, …) — the ONE routing decision this
    /// module makes, and the only thing it reads the envelope's `method` field for.
    fn ttl_for(&self, method: &str) -> Option<Duration> {
        if let Some(ttl) = self
            .ttl_overrides
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(method)
        {
            return Some(*ttl);
        }
        READ_METHOD_TTLS
            .iter()
            .find(|(m, _)| *m == method)
            .map(|(_, secs)| Duration::from_secs(*secs))
    }

    /// Fresh cache lookup. An expired entry is lazily dropped here — the caller must not be
    /// able to observe it, and neither must the size cap.
    fn cache_lookup(&self, key: &str) -> Option<Bytes> {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        match cache.get(key) {
            Some(entry) if entry.expires_at_ms > crate::now_millis() => Some(entry.body.clone()),
            _ => {
                cache.remove(key);
                None
            }
        }
    }

    /// Store an upstream SUCCESS body with its expiry. Insertion is the cache's one
    /// housekeeping moment: drop expired entries, then enforce the size cap (expired first,
    /// arbitrary after that — bounded and explainable, not an LRU empire).
    fn cache_insert(&self, key: String, body: Bytes, ttl: Duration) {
        let expires_at_ms = crate::now_millis().saturating_add(ttl.as_millis() as u64);
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        let now = crate::now_millis();
        cache.retain(|_, entry| entry.expires_at_ms > now);
        let cap = self
            .cache_cap_override
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or(MAX_CACHE_ENTRIES);
        while cache.len() >= cap {
            // Still full after purging the expired: every remaining entry is fresh, so there
            // is no principled victim — drop arbitrary ones until there is room. At this
            // scale (a bounded map of small envelopes) simple beats clever.
            let Some(victim) = cache.keys().next().cloned() else {
                break;
            };
            cache.remove(&victim);
        }
        cache.insert(
            key,
            CachedEntry {
                body,
                expires_at_ms,
            },
        );
    }

    /// Single-flight: run (or join) the ONE upstream call for this key. Returns the shared
    /// outcome plus whether THIS caller was the leader (the one whose bytes went upstream —
    /// only the leader is guaranteed the body with its own id; followers get the outcome with
    /// their id substituted, see the module header).
    async fn shared_fetch(&self, key: &str, upstream: &str, body: Bytes) -> (Outcome, bool) {
        // Lock scope: get-or-create the shared cell, then let go — never held across the await.
        let (cell, leader) = {
            let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
            match inflight.entry(key.to_owned()) {
                std::collections::hash_map::Entry::Vacant(v) => {
                    let cell = Arc::new(OnceCell::new());
                    v.insert(cell.clone());
                    (cell, true)
                }
                std::collections::hash_map::Entry::Occupied(o) => (o.get().clone(), false),
            }
        };
        let client = self.client.clone();
        let upstream = upstream.to_string();
        let timeout = self.timeout;
        // Concurrent get_or_init callers: tokio's OnceCell runs one future, the rest wait for
        // it. If every caller is dropped mid-flight the cell simply re-runs for the next one.
        let outcome = cell
            .get_or_init(|| async move { fetch_once(client, upstream, body, timeout).await })
            .await
            .clone();
        // Completed: retire the shared cell (only its creator — ptr_eq — so a *newer* cell a
        // later request may have already installed survives) and let the TTL cache serve.
        {
            let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(current) = inflight.get(key) {
                if Arc::ptr_eq(current, &cell) {
                    inflight.remove(key);
                }
            }
        }
        (outcome, leader)
    }
}

/// The one upstream call. Pure: forwards the client's ORIGINAL bytes, answers with the
/// upstream's status + body verbatim, or the fixed 504 text for transport trouble. The
/// reqwest error is deliberately DROPPED, not formatted: it embeds the request URL, whose
/// query carries the provider api key (module header, "Secrets").
async fn fetch_once(
    client: reqwest::Client,
    upstream: String,
    body: Bytes,
    timeout: Duration,
) -> Outcome {
    let attempt = client
        .post(&upstream)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .timeout(timeout)
        .body(body)
        .send()
        .await;
    let response = match attempt {
        Ok(r) => r,
        Err(e) => return transport_refusal(e, timeout),
    };
    let status = response.status();
    match response.bytes().await {
        Ok(bytes) => Outcome {
            status,
            body: bytes,
        },
        // Body read failed after headers: same class as a transport failure.
        Err(e) => transport_refusal(e, timeout),
    }
}

/// The honest answer when the upstream could not be reached or timed out: a 504 carrying the
/// relay-originated error MARKER (module header, "Failure semantics") with a detail naming
/// the trouble in category only — never the error, never the URL.
fn transport_refusal(e: reqwest::Error, timeout: Duration) -> Outcome {
    let why = if e.is_timeout() {
        format!("timed out after {} ms", timeout.as_millis())
    } else if e.is_connect() {
        "connection failed".to_string()
    } else {
        "request failed".to_string()
    };
    Outcome {
        status: StatusCode::GATEWAY_TIMEOUT,
        body: relay_error_body(
            "solana-upstream-unreachable",
            &format!("solana upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract from the module header:
/// `{"dpayRelayError": <code>, "detail": <short human phrase>}`. The CODE is the client's
/// contract (never parsed prose); the detail is human-optional and may change at any time.
/// Built from FIXED inputs only (the callers' `why`/detail strings name categories and env
/// var NAMES, never the upstream URL or key), so no secret can leak through it.
fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(
        serde_json::json!({
            "dpayRelayError": code,
            "detail": detail,
        })
        .to_string(),
    )
}

/// `POST /api/v1/solana/rpc` — the route. Request: the client's JSON-RPC envelope, verbatim.
/// Response: the upstream's status + body verbatim on a miss (or a pure pass-through), a
/// TTL-fresh cached body with the caller's id on a hit, or an honest 4xx/5xx naming what is
/// wrong. Content-Type is `application/json` both ways, always.
pub async fn rpc_proxy(State(state): State<AppState>, body: Bytes) -> Response {
    let proxy = state.solana.clone();
    let Some(upstream) = proxy.upstream.clone() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            &relay_error_body(
                "solana-unconfigured",
                "solana rpc proxy is not configured: set DPAY_SOLANA_RPC_URL in the relay's \
                 environment (the full provider endpoint, including its api key) - see docs/OPS.md §3",
            ),
        );
    };
    let envelope: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) - POST /api/v1/solana/rpc takes the \
                     client's JSON-RPC envelope {{jsonrpc, id, method, params}} as-is"
                ),
            )
        }
    };
    // A top-level ARRAY — a JSON-RPC batch — also dies HERE: `Value::as_str` on an array's
    // missing "method" is None. That is the documented route contract (module header), not
    // an accident to fix.
    let Some(method) = envelope.get("method").and_then(Value::as_str) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request has no string `method` field - not a JSON-RPC envelope",
        );
    };
    let caller_id = envelope.get("id").cloned();

    match proxy.ttl_for(method) {
        None => {
            // PURE PIPE: not on the read allowlist (sendTransaction, unknown methods, …).
            // The original bytes go out, the upstream's status + body come back, and nothing
            // is cached, shared, inspected or rewritten on the way.
            let outcome = fetch_once(proxy.client.clone(), upstream, body, proxy.timeout).await;
            json_response(outcome.status, &outcome.body)
        }
        Some(ttl) => {
            let mut key = String::with_capacity(method.len() + 32);
            key.push_str(method);
            key.push('\u{1}');
            canonical_json(envelope.get("params").unwrap_or(&Value::Null), &mut key);
            // HIT: the stored success body, with THIS caller's id (module header — the
            // id-substitution decision). The result subtree is carried untouched.
            if let Some(cached) = proxy.cache_lookup(&key) {
                return json_response(StatusCode::OK, &with_caller_id(&cached, caller_id.as_ref()));
            }
            // MISS (or expired): one shared upstream call for everyone asking this right now.
            let (outcome, leader) = proxy.shared_fetch(&key, &upstream, body).await;
            // Cache ONLY a 200 that parses as a JSON-RPC result envelope. A failure is never
            // cached — not an HTTP error status, not a JSON-RPC error body — and never
            // answered from cache: the caller hears what the upstream said.
            if outcome.status == StatusCode::OK && is_jsonrpc_success(&outcome.body) {
                proxy.cache_insert(key, outcome.body.clone(), ttl);
            }
            let body_out = if leader {
                outcome.body
            } else {
                with_caller_id(&outcome.body, caller_id.as_ref())
            };
            json_response(outcome.status, &body_out)
        }
    }
}

/// The shared HTTP client. One per process: per-request timeout rides the request builder,
/// so there is nothing per-proxy about it. Redirects are NOT followed — the pipe forwards
/// exactly one hop (module header).
fn shared_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the solana proxy's HTTP client")
        })
        .clone()
}

/// House error shape (`{"error": …}`, application/json) — same wire shape as the rest of
/// `/api/v1`, with fixed strings that can never leak the upstream URL.
fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    use axum::Json;
    use serde_json::json;
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

/// A body-carrying response with a fixed status. `application/json` by the route contract.
fn json_response(status: StatusCode, body: &Bytes) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        body.clone(),
    )
        .into_response()
}

/// Substitute the envelope's `id` with the caller's own — response-envelope plumbing ONLY
/// (the `result` subtree is carried untouched; see the module header). A caller that sent no
/// id (a JSON-RPC notification) gets the stored body verbatim; a body that does not parse as
/// a JSON object falls back to verbatim rather than being mangled.
fn with_caller_id(body: &Bytes, id: Option<&Value>) -> Bytes {
    let Some(id) = id else {
        return body.clone();
    };
    let Ok(Value::Object(mut map)) = serde_json::from_slice::<Value>(body) else {
        return body.clone();
    };
    map.insert("id".to_string(), id.clone());
    match serde_json::to_vec(&Value::Object(map)) {
        Ok(bytes) => Bytes::from(bytes),
        // Unreachable for a Value that parsed; verbatim beats a 500 from a cache hit.
        Err(_) => body.clone(),
    }
}

/// Is this upstream body a cacheable SUCCESS? Only a 200 body that parses as a JSON object
/// with NO top-level `error` key. This is the one look the pipe takes at a response body,
/// and only to keep a failure out of the cache (never-cache-a-failure).
fn is_jsonrpc_success(body: &[u8]) -> bool {
    match serde_json::from_slice::<Value>(body) {
        Ok(v) => v.is_object() && v.get("error").is_none(),
        Err(_) => false,
    }
}

/// Canonical JSON serialization for the cache key: identical to `serde_json`'s value
/// serialization except object keys are ALWAYS emitted in sorted order, so two wallets whose
/// param objects differ only in key order ask the cache the same question. Written explicitly
/// (rather than trusting `to_string`) so the invariant holds even if some future dependency
/// turns on serde_json's `preserve_order`.
fn canonical_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => {
            out.push_str(&serde_json::to_string(s).expect("a str always serializes"))
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(*k).expect("a str always serializes"));
                out.push(':');
                canonical_json(&map[*k], out);
            }
            out.push('}');
        }
    }
}
