//! The Jupiter quote + swap-tx proxy — `GET /api/v1/jupiter/quote` and
//! `POST /api/v1/jupiter/swap` (2026-09-16 founder ask: "get live quotes from them …
//! possibly through our relay (for caching etc)" — docs/specs/2026-09-16-convert-coverage-expansion.md
//! §2 decision 3, amending the feasibility spec's device-direct note).
//!
//! Jupiter (`lite-api.jup.ag`) is the solana_amm venue behind the Convert surface's SOL
//! conversions. It is KEYLESS — no credential, no account, nothing to hold server-side — so
//! unlike the SideShift partner-key proxy ([`crate::sideshift`]) there is NO 503 state: these
//! routes are registered on every build and always serve. What the relay adds is one egress
//! point for the venue (attribution, a place to cache) and the same failure contract as every
//! other proxy here.
//!
//! # What this module serves
//!
//! - `GET /api/v1/jupiter/quote?inputMint=…&outputMint=…&amount=…&slippageBps=…` — the quote
//!   surface, piped to `{base}/swap/v1/quote?<canonical query>` and cached under the
//!   CANONICAL (sorted) query string for a SHORT TTL. The answer is byte-faithful: no wrap,
//!   no attribution envelope, no dpay-mutated field — the device gets Jupiter's own JSON
//!   body. The cache is the "caching etc" of the founder ask: N wallets quoting the same
//!   pair/amount within the TTL share one upstream call.
//! - `POST /api/v1/jupiter/swap` — the swap-tx build, a byte-faithful PIPE and NEVER cached:
//!   the device posts Jupiter's own quoteResponse back (plus its address and the wrap/
//!   legacy flags), and the reply's `swapTransaction` must reach the device unmodified — the
//!   device verifies the tx's beneficiaries against those exact bytes before signing.
//!
//! # The venue endpoint stays an identity, not a dial target
//!
//! The registry row's `endpoint` (`https://lite-api.jup.ag`) is the venue's identity and
//! attribution (it renders in the UI's pool/attribution line), no longer a host the device
//! dials: quotes and swap builds ride the relay. An operator override can still point the
//! relay's upstream elsewhere via `DPAY_JUPITER_API_BASE` (main.rs) — the offline loop points
//! it at the relay's own test stub.
//!
//! # Failure semantics (same contract as `crate::solana` / `crate::sideshift`)
//!
//! - Upstream HTTP error status → SAME status, upstream body VERBATIM (Jupiter's own refusal
//!   shape — whatever refused is the venue, not us).
//! - Transport death (connect/timeout) → 504 carrying the body marker
//!   `{"dpayRelayError":"jupiter-upstream-unreachable","detail":"…"}`. The detail is a
//!   category ("timed out after N ms" / "connection failed" / "request failed"), never the
//!   error text: a reqwest error embeds the request URL.
//! - No 503 state exists: the upstream is keyless and its base has a constant default. Only
//!   a SET-but-malformed `DPAY_JUPITER_API_BASE` refuses startup (EXIT_CONFIG in main.rs).
//! - Malformed device requests: an empty/oversized query string is a 400 in the house
//!   `{"error": …}` shape, refused BEFORE any upstream call. The swap POST's body is not
//!   inspected at all — a pure pipe, so the VENUE is the authority on its shape.
//! - Redirects are not followed: exactly one hop, surfaced not chased.
//!
//! # Cache shape (deliberately small — the solana read cache's idiom)
//!
//! One `Mutex<HashMap>` of canonical query → (upstream success body, expiry), with lazy
//! expired-entry cleanup on lookup/insert, a hard entry cap, and a per-entry BODY cap (a
//! quote body above [`MAX_CACHED_BODY_BYTES`] passes through uncached rather than bloating
//! the map). Failures are never cached, and a hit is bounded staleness of at most
//! [`QUOTE_TTL`] — quotes are the venue's own live numbers, so the TTL is seconds: the cache
//! collapses concurrent identical asks, it never serves an old price as fresh. No
//! single-flight: a quote GET is one cheap idempotent round trip, and the TTL already
//! collapses the steady state.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;

/// The Jupiter API base (the keyless lite host the venue documents). Overridable via
/// `DPAY_JUPITER_API_BASE` (main.rs): the offline loop points it at the relay's own test
/// stub, and an operator may pin a different base. NOT a secret — no credential exists.
pub const DEFAULT_API_BASE: &str = "https://lite-api.jup.ag";

/// Per-upstream-call timeout. Quotes and swap builds are single round trips; no env knob
/// (same reasoning as the sideshift proxy — this surface does not ride a poll loop).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// The quote cache TTL. Seconds on purpose (module header): the quote feeds the user's
/// review decision, and the cache exists to collapse repeated identical asks, never to
/// serve an old price as fresh. The swap POST is never cached, whatever this is.
pub const QUOTE_TTL: Duration = Duration::from_secs(5);

/// Hard cap on cached quote entries — the solana read cache's own bound (a few thousand
/// small JSON bodies is single-digit MB; past that something is wrong upstream of the cache).
const MAX_CACHE_ENTRIES: usize = 4096;

/// Per-entry body cap: a quote body larger than this is answered through but never cached.
/// Real lite-api quote bodies are well under this; the cap only stops a pathological upstream
/// from turning the cache into a memory hose.
const MAX_CACHED_BODY_BYTES: usize = 64 * 1024;

/// The canonical query string's length cap. The cache key IS the canonical query, so an
/// unbounded one would be an unbounded key; a real quote URL is a few hundred bytes.
const MAX_QUERY_LEN: usize = 2048;

/// The relay-originated marker code for transport death (the client's failure-vocabulary
/// contract: this code maps to `unreachable`, while an upstream's own status keeps its own
/// meaning). Stable by contract — do not rename without the app client.
pub const UPSTREAM_UNREACHABLE: &str = "jupiter-upstream-unreachable";

/// The proxy's state: the upstream base, the shared HTTP client, the per-call timeout and
/// the short-TTL quote cache. Held in an `Arc` on [`AppState`]; the Mutex is the repo's
/// poison-tolerant kind and is never held across an await.
pub struct JupiterProxy {
    base: String,
    timeout: Duration,
    client: reqwest::Client,
    /// canonical query → cached upstream SUCCESS body + expiry (ms since epoch).
    cache: Mutex<HashMap<String, CachedEntry>>,
    /// Test-only TTL override so expiry is observable without sleeping real seconds.
    /// `None` in production — [`QUOTE_TTL`] is the authority. Deliberately NOT
    /// feature-gated: a gated field no-feature builds never read is a dead-code warning
    /// (the solana proxy's `set_ttl_override` precedent).
    ttl_override: Mutex<Option<Duration>>,
}

/// One cached quote: the upstream's success body VERBATIM and when it expires.
struct CachedEntry {
    body: Bytes,
    expires_at_ms: u64,
}

/// One completed upstream call: status + body (the verbatim-passthrough currency of this
/// module — same shape as `crate::solana`).
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

impl JupiterProxy {
    /// Build the proxy. There is no unconfigured state (module header): the base always
    /// has a value (the constant default, the env override, or the test stub).
    pub fn new(base: String, timeout: Duration) -> Self {
        JupiterProxy {
            base,
            timeout,
            client: http_client(),
            cache: Mutex::new(HashMap::new()),
            ttl_override: Mutex::new(None),
        }
    }

    /// Test seam ONLY: shrink the quote TTL (e.g. to 60 ms) so expiry is observable without
    /// sleeping real seconds. Production reads [`QUOTE_TTL`] and never calls this. Public
    /// because integration tests link the lib crate; deliberately NOT feature-gated — same
    /// reasoning as [`SolanaProxy::set_ttl_override`](crate::solana::SolanaProxy::set_ttl_override).
    pub fn set_ttl_override(&self, ttl: Duration) {
        *self.ttl_override.lock().unwrap_or_else(|p| p.into_inner()) = Some(ttl);
    }

    /// The effective quote TTL: the test override when armed, else [`QUOTE_TTL`].
    fn quote_ttl(&self) -> Duration {
        self.ttl_override
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .unwrap_or(QUOTE_TTL)
    }

    /// Fresh cache lookup. An expired entry is lazily dropped here — the caller must not
    /// be able to observe it, and neither must the size cap.
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
    /// housekeeping moment: drop expired entries, then enforce the size cap (expired
    /// first, arbitrary after that — bounded and explainable, not an LRU empire).
    fn cache_insert(&self, key: String, body: Bytes, ttl: Duration) {
        let expires_at_ms = crate::now_millis().saturating_add(ttl.as_millis() as u64);
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        let now = crate::now_millis();
        cache.retain(|_, entry| entry.expires_at_ms > now);
        while cache.len() >= MAX_CACHE_ENTRIES {
            // Still full after purging the expired: no principled victim — drop arbitrary
            // ones until there is room. At this scale simple beats clever (solana's rule).
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
}

/// `GET /api/v1/jupiter/quote` — the quote surface (module header). The raw query string is
/// canonicalized (pairs sorted) and becomes BOTH the upstream query and the cache key, so
/// the same params in any order share one entry.
pub async fn quote_proxy(State(state): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    let proxy = state.jupiter.clone();
    // Refuse the empty/oversized cases BEFORE any upstream call (house shape — client bugs,
    // not relay-path facts). Anything else is the venue's own business.
    let Some(raw) = raw else {
        return err(
            StatusCode::BAD_REQUEST,
            "quote route needs a query string (inputMint, outputMint, amount, slippageBps)",
        );
    };
    if raw.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "quote route needs a query string (inputMint, outputMint, amount, slippageBps)",
        );
    }
    if raw.len() > MAX_QUERY_LEN {
        return err(StatusCode::BAD_REQUEST, "query string is too long");
    }
    let canonical = canonical_query(&raw);

    // The cache: a HIT is bounded staleness of at most QUOTE_TTL, and a failure is NEVER
    // answered from cache (module header) — an upstream that would fail is one the caller
    // gets to hear about.
    if let Some(body) = proxy.cache_lookup(&canonical) {
        return json_response(StatusCode::OK, &body);
    }

    let outcome = get_upstream(&proxy, &canonical).await;
    if outcome.status.is_success() && outcome.body.len() <= MAX_CACHED_BODY_BYTES {
        proxy.cache_insert(canonical, outcome.body.clone(), proxy.quote_ttl());
    }
    json_response(outcome.status, &outcome.body)
}

/// `POST /api/v1/jupiter/swap` — the swap-tx build (module header). Byte-faithful pipe,
/// never cached: the device posts Jupiter's own quoteResponse back and the reply's
/// `swapTransaction` must reach it unmodified.
pub async fn swap_proxy(State(state): State<AppState>, body: Bytes) -> Response {
    let proxy = state.jupiter.clone();
    let outcome = post_upstream(&proxy, "/swap/v1/swap", body).await;
    json_response(outcome.status, &outcome.body)
}

/// Sort the raw `k=v` pairs (split on `&`, empty segments dropped) — the canonical form is
/// BOTH the cache key and the upstream query, so order variants of the same params dedup.
/// Values stay exactly as the client encoded them: the pipe is byte-faithful upstream.
fn canonical_query(raw: &str) -> String {
    let mut pairs: Vec<&str> = raw.split('&').filter(|p| !p.is_empty()).collect();
    pairs.sort_unstable();
    pairs.join("&")
}

/// One upstream GET: `{base}/swap/v1/quote?<canonical query>` — or the fixed 504 marker for
/// transport trouble. The reqwest error is DROPPED, not formatted (it embeds the request URL).
async fn get_upstream(proxy: &JupiterProxy, canonical_query: &str) -> Outcome {
    let url = format!("{}/swap/v1/quote?{}", proxy.base, canonical_query);
    let attempt = proxy
        .client
        .get(&url)
        .header(header::ACCEPT, "application/json")
        .timeout(proxy.timeout)
        .send()
        .await;
    let response = match attempt {
        Ok(r) => r,
        Err(e) => return transport_refusal(e, proxy.timeout),
    };
    let status = response.status();
    match response.bytes().await {
        Ok(bytes) => Outcome { status, body: bytes },
        Err(e) => transport_refusal(e, proxy.timeout),
    }
}

/// One upstream POST: `{base}{path}` with the device's ORIGINAL body bytes, answered with
/// the upstream's status + body verbatim — or the fixed 504 marker for transport trouble.
async fn post_upstream(proxy: &JupiterProxy, path: &str, body: Bytes) -> Outcome {
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
        Err(e) => return transport_refusal(e, proxy.timeout),
    };
    let status = response.status();
    match response.bytes().await {
        Ok(bytes) => Outcome { status, body: bytes },
        Err(e) => transport_refusal(e, proxy.timeout),
    }
}

/// The honest answer when Jupiter could not be reached: a 504 carrying the relay-originated
/// marker, category only (never the error, never the URL) — the sideshift proxy's own
/// refusal, with this venue's marker code.
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
            UPSTREAM_UNREACHABLE,
            &format!("jupiter upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract shared with
/// `crate::solana` / `crate::sideshift`: `{"dpayRelayError": <code>, "detail": <short
/// human phrase>}`. Fixed inputs only (categories), so nothing of the request can leak.
fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(json!({"dpayRelayError": code, "detail": detail}).to_string())
}

/// The shared HTTP client (one per process; redirects NOT followed — same discipline as
/// the solana pipe: exactly one hop, surfaced not chased).
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the jupiter proxy's HTTP client")
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
    fn canonical_query_sorts_pairs_and_drops_empties() {
        assert_eq!(
            canonical_query("slippageBps=100&inputMint=A&outputMint=B&amount=9"),
            "amount=9&inputMint=A&outputMint=B&slippageBps=100"
        );
        // Same params, different order → the SAME canonical key (the dedup property).
        assert_eq!(
            canonical_query("amount=9&outputMint=B&inputMint=A&slippageBps=100"),
            canonical_query("slippageBps=100&inputMint=A&outputMint=B&amount=9")
        );
        // Empty segments (a trailing '&' or a doubled one) vanish; values stay untouched.
        assert_eq!(canonical_query("a=1&&b=2&"), "a=1&b=2");
        assert_eq!(canonical_query("a=%2Fb"), "a=%2Fb");
    }
}
