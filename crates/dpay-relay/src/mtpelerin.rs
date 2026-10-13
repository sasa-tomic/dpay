//! The Mt Pelerin off-ramp proxy + conversion webhook receiver — the THIRD relay-held
//! key surface (2026-10-12, WalletConnect integration plan R2 step 1; the Trocador
//! layout mirrored: proxy routes + access log + order store + webhook receiver in one
//! module). Mt Pelerin SA is a Geneva SRO-affiliated fiat ramp (docs/REGULATORY.md §1.6).
//!
//! # What is pinned from the venue's own docs (fetched 2026-10-12)
//!
//! - Price quote API (developers.mtpelerin.com/integration-guides/informational-apis/
//!   price-quote-api.md): `POST {base}/currency_rates/convert` with a JSON body
//!   (`sourceCurrency`, `destCurrency`, exactly one of `sourceAmount`/`destAmount`,
//!   `sourceNetwork`, `destNetwork`, `isCardPayment`). The answer's `destAmount` is the
//!   NET final amount (their fees included) — numbers relay VERBATIM, never computed.
//! - Conversion webhook (developers.mtpelerin.com/integration-guides/conversion-webhook.md):
//!   on request, Mt Pelerin registers a webhook URL + exchanges two keys with the partner.
//!   A delivery POSTs `{"id": <their transaction id>, "amount": <number>,
//!   "currency": <code>, "external_id": <the `oid` we passed>}` — the webhook fires when a
//!   transaction COMPLETES, so a matched delivery IS the terminal fact. The `Mtp-Signature`
//!   header carries HMAC-SHA256 over the FULL request body, hex-encoded, keyed with the
//!   signature key (their own JS example: `createHmac('sha256', KEY).update(body).digest('hex')`).
//!   An `Authentication` header key is also part of their setup: the venue exchanges TWO
//!   keys (the authKey and the signature key). dpay wires the SIGNATURE key
//!   (`DPAY_MTPELERIN_WEBHOOK_SECRET`) because that is what authenticates the payload;
//!   the authKey (`DPAY_MTPELERIN_WEBHOOK_AUTH_KEY`) is OPTIONAL: when the operator has
//!   exchanged and configured it, the receiver also requires the `Authentication` header
//!   to match it exactly (constant-time) BEFORE the signature check; unset, the HMAC
//!   alone guards.
//! - Sell orders (developers.mtpelerin.com/integration-guides/events.md): the venue's
//!   order carries `offRampAddress` — the VENUE's own deposit address the user's crypto is
//!   sent to — and their own `id`. dpay never creates that order server-side (see below):
//!   the id persists when the completion webhook names it; the address stays a record
//!   field for whenever a venue payload carries one.
//!
//! # What Mt Pelerin answered (founder-forwarded, 2026-10-13): the order POST is GONE
//!
//! dpay's API tier is CLOSED: server-side order creation requires the USER'S OWN
//! credentials (they recommend the widget) or B2B own-name orders (legal-entity
//! verification plus regulatory authorizations dpay does not hold and must not imply).
//! The upstream order POST is therefore REMOVED. The conversion route is purely local:
//! validate the device body, mint our `mtp-…` correlation id, persist the record, answer
//! with it. The order id reaches Mt Pelerin on the widget link's `oid` parameter; their
//! completion webhook echoes it back as `external_id`, and that is the whole correlation
//! story. The quote proxy keeps calling the documented `currency_rates/convert` upstream.
//!
//! # The guard (the unconfigured-refusal pattern)
//!
//! `DPAY_MTPELERIN_CTKN` (the integration key, sops: secrets/mtpelerin.sops.json) gates
//! the QUOTE surface, the one route that still dials upstream. Unset, it answers 503
//! `mtpelerin-unconfigured` naming the variable, and the route is registered on every
//! build (503-not-404 philosophy, crate::trocador). The conversion routes are LOCAL: they
//! dial nothing and work with no key at all. The webhook receiver's credential is the
//! SIGNATURE key: until `DPAY_MTPELERIN_WEBHOOK_SECRET` is set it answers 503 naming that
//! variable, because an unverifiable delivery must never mutate an order. Both unset
//! states are LEGAL: the venue is simply absent until the keys are exchanged.
//!
//! # Correlation + poll discipline (the Trocador partner-agreement precedent, §2 terms 2+4)
//!
//! The correlation id is OURS: conversion creation mints `mtp-` + 16 lowercase hex (the
//! checkout's CSPRNG discipline), persists the order BEFORE anything else, and answers
//! with the `X-Dpay-Order-Id` header. The id reaches the venue on the widget link's `oid`
//! parameter; a webhook delivery echoes it back as `external_id`, and the venue's own
//! `id` rides the same record. Status reads
//! (the webhook's FALLBACK channel — Mt Pelerin documents no retry) are the store's
//! webhook-first answer with ZERO upstream calls, spaced at most one read per order id per
//! 60 s (`mtpelerin-status-throttled` 429 + `Retry-After` beyond that; the promise is
//! compile-time in prod — the only smaller window comes from the test-helpers-only env
//! seam, crate::trocador_agreement §3's reasoning verbatim). Terminal dedupe: the FIRST
//! completed delivery wins — later deliveries (redeliveries, replays after a restore) are
//! answered 200 idempotently and never overwrite the stored payload.
//!
//! # Per-client bounds (the Trocador agreement's limiter pattern)
//!
//! The quote and conversion surfaces admit each call under a per-client fixed 60s window
//! (6/min quote, 4/min conversion; `DPAY_MTPELERIN_QUOTE_PER_MIN` /
//! `DPAY_MTPELERIN_CONVERSION_PER_MIN` override) and answer 429 + `Retry-After` + the
//! house marker when the window is full, keyed per client IP (`DPAY_TRUST_PROXY`
//! honesty). Device 400s are never counted; the webhook receiver is not windowed (the
//! auth key + the HMAC gate it).
//!
//! # Failure semantics (same contract as crate::trocador)
//!
//! The QUOTE surface passes the upstream through verbatim: same HTTP status, same body.
//! Relay-originated failures carry
//! `{"dpayRelayError": "mtpelerin-unconfigured"|"mtpelerin-upstream-unreachable"|
//! "mtpelerin-status-throttled", "detail": …}` (503 unconfigured, 504 transport, 429 the
//! poll cap). The CTKN, the webhook secret and the reqwest error text are never logged,
//! never echoed; redirects are not followed. Conversion creation is local: its refusals
//! are 400 house errors (device body) and 429 (window full), and nothing else. The access
//! log + order store are the Trocador agreement's
//! JSONL pattern (append-only, `mtpelerin-access.jsonl` / `mtpelerin-orders.jsonl` under
//! `DPAY_MTPELERIN_LOG_DIR`, last-wins replay at startup) — the Postgres arm is the
//! documented follow-up when the founder's webhook setup lands (the Trocador store's
//! "postgres is being backed up" rule will apply to prod).

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::AppState;

/// The venue id this adapter serves (attribution constant of THIS module — the catalog
/// flip is a separate lane's change; the quote wrap names the venue the way
/// crate::trocador's wrap does).
pub const MTPELERIN_VENUE_ID: &str = "mtpelerin";

/// The venue's API host (the price-quote doc's own URL). Overridable via
/// `DPAY_MTPELERIN_API_BASE` (main.rs): the offline loop points it at the relay's own
/// test stub.
pub const DEFAULT_API_BASE: &str = "https://api.mtpelerin.com";

/// The documented price-quote path (price-quote-api.md, fetched 2026-10-12). Never
/// overridden — the doc pins it. The ONLY upstream path this module dials: order creation
/// has no upstream leg (the venue's API tier is closed for dpay, module header).
pub const QUOTE_PATH: &str = "/currency_rates/convert";

/// Per-upstream-call timeout (same rule as crate::trocador: single round trips, no knob).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// The poll-cap promise: at most one status read per order id per 60 s (the Trocador
/// agreement's term 4 discipline; module header). Prod cannot stand it down — the only
/// smaller window comes from the test-helpers-only env seam in main.rs.
pub const STATUS_SPACING_SECS: u64 = 60;

/// House `dpayRelayError` codes (the marker contract shared with crate::trocador).
pub const UNCONFIGURED_CODE: &str = "mtpelerin-unconfigured";
pub const UNREACHABLE_CODE: &str = "mtpelerin-upstream-unreachable";
pub const STATUS_THROTTLED_CODE: &str = "mtpelerin-status-throttled";

/// The 401 code for a webhook delivery whose `Mtp-Signature` does not verify.
pub const WEBHOOK_UNAUTHORIZED_CODE: &str = "mtpelerin-webhook-unauthorized";

/// The webhook authentication header (Mt Pelerin's documented name, conversion-webhook
/// setup): carries the exchanged authKey when the operator configured
/// `DPAY_MTPELERIN_WEBHOOK_AUTH_KEY`.
pub const AUTH_HEADER: &str = "Authentication";

/// The per-client per-minute quote bound (`DPAY_MTPELERIN_QUOTE_PER_MIN` default): the
/// Trocador agreement's limiter budget mirrored (6/min on the quote surface).
pub const DEFAULT_QUOTE_PER_MIN: u32 = 6;
/// The per-client per-minute conversion bound (`DPAY_MTPELERIN_CONVERSION_PER_MIN`
/// default; 4/min on order creation, the Trocador trade budget's twin).
pub const DEFAULT_CONVERSION_PER_MIN: u32 = 4;

/// The 429 house codes for the per-client windows (the trocador marker style).
pub const QUOTE_LIMITED_CODE: &str = "mtpelerin-quote-limited";
pub const CONVERSION_LIMITED_CODE: &str = "mtpelerin-conversion-limited";

/// The response header conversion creation answers with: the relay-minted order id — the
/// `oid` on the widget link, the value the webhook echoes back as `external_id`, and the
/// status route's key.
pub const ORDER_ID_HEADER: &str = "X-Dpay-Order-Id";

/// The order-id prefix (`mtp-` + 16 lowercase hex — see `fresh_order_id`; a distinct
/// space from the trocador `trod-` ids by design).
pub const ORDER_ID_PREFIX: &str = "mtp-";

/// The device's optional `clientOrderId` rides the record verbatim but clamped (the
/// trocador agreement's rule — a hostile body cannot bloat the store).
pub const MAX_CLIENT_ORDER_ID_CHARS: usize = 200;

/// The access-log file (one JSON object per line, append-only — the trocador pattern).
pub const ACCESS_LOG_FILE: &str = "mtpelerin-access.jsonl";
/// The order store (one JSON object per state transition, append-only, last-wins).
pub const ORDERS_LOG_FILE: &str = "mtpelerin-orders.jsonl";

/// The webhook signature header (the venue's own name, docs pinned 2026-10-12).
pub const SIGNATURE_HEADER: &str = "Mtp-Signature";

/// Prune threshold for the in-process spacing map (the trocador agreement's rule: entries
/// older than an hour are behaviorally dead).
const MAP_PRUNE_LEN: usize = 8192;

/// The proxy's clock: unix seconds, injectable so the 60 s poll cap is testable offline
/// (the trocador agreement's `with_clock` seam verbatim).
pub type NowFn = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Which upstream-bound surface a limit admission is for (the per-client fixed windows;
/// the trocador agreement's `LimitKind` mirrored).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    /// `GET /api/v1/mtpelerin/quote`, the quote surface.
    Quote,
    /// `POST /api/v1/mtpelerin/conversion`, order creation.
    Conversion,
}

impl LimitKind {
    fn window_key(self) -> &'static str {
        match self {
            LimitKind::Quote => "quote",
            LimitKind::Conversion => "conversion",
        }
    }
}

/// The proxy's configuration, read once at startup (main.rs from the env).
#[derive(Clone, Debug)]
pub struct MtPelerinConfig {
    /// `DPAY_MTPELERIN_CTKN` — the integration key. SECRET: never logged, never echoed.
    /// Unset is legal (every proxy route 503s naming the variable).
    pub ctkn: Option<String>,
    /// `DPAY_MTPELERIN_WEBHOOK_SECRET` — the webhook signature key (HMAC-SHA256 over the
    /// raw body). SECRET. Unset is legal (the receiver 503s naming the variable).
    pub webhook_secret: Option<String>,
    /// `DPAY_MTPELERIN_WEBHOOK_AUTH_KEY`, the webhook's OPTIONAL authentication key
    /// (Mt Pelerin's docs exchange an authKey alongside the signature key). When set,
    /// the receiver requires the `Authentication` header to equal it exactly
    /// (constant-time) before the signature check; unset, the HMAC alone guards. SECRET.
    pub webhook_auth_key: Option<String>,
    /// `DPAY_MTPELERIN_QUOTE_PER_MIN`, the per-client per-minute quote bound
    /// (default 6).
    pub quote_per_min: u32,
    /// `DPAY_MTPELERIN_CONVERSION_PER_MIN`, the per-client per-minute conversion bound
    /// (default 4).
    pub conversion_per_min: u32,
    /// `DPAY_MTPELERIN_API_BASE` — default the venue's documented host.
    pub api_base: String,
    /// `DPAY_MTPELERIN_LOG_DIR` — the append-only records' directory (default ".").
    pub log_dir: PathBuf,
    /// `DPAY_TRUST_PROXY` — the shared client-IP honesty flag (trocador agreement doc).
    pub trust_proxy: bool,
    /// The poll-cap window in seconds (module header: 60 in prod).
    pub status_spacing_secs: u64,
}

impl Default for MtPelerinConfig {
    fn default() -> Self {
        MtPelerinConfig {
            ctkn: None,
            webhook_secret: None,
            webhook_auth_key: None,
            quote_per_min: DEFAULT_QUOTE_PER_MIN,
            conversion_per_min: DEFAULT_CONVERSION_PER_MIN,
            api_base: DEFAULT_API_BASE.to_string(),
            log_dir: PathBuf::from("."),
            trust_proxy: false,
            status_spacing_secs: STATUS_SPACING_SECS,
        }
    }
}

/// One order record — the in-memory form of a `mtpelerin-orders.jsonl` state line
/// (last-wins on load). The correlation triple is OUR order id (the widget link's `oid`,
/// the webhook's `external_id`, the status route's key), the venue's own `id` (which only
/// a webhook delivery can name, since dpay creates no venue-side order), and the
/// `offRampAddress` a venue payload named. The requested conversion's own detail
/// (currencies + amount) is known at creation and rides the record from the first line.
#[derive(Clone, Debug)]
pub struct OrderRecord {
    pub order_id: String,
    pub client_order_id: Option<String>,
    /// Mt Pelerin's own transaction/order id (their `id` field), set only by a webhook
    /// delivery (no upstream order call exists anymore).
    pub venue_order_id: Option<String>,
    /// The VENUE's deposit address for the off-ramp (their `offRampAddress`) — the user
    /// sends THEIR OWN crypto transfer to it; funds never touch a dpay-controlled address.
    /// Populated only from a venue payload; creation cannot know it.
    pub offramp_address: Option<String>,
    /// The requested pair, verbatim from the device body.
    pub source_currency: Option<String>,
    pub dest_currency: Option<String>,
    /// Which amount field the device passed (`sourceAmount` or `destAmount`) and its
    /// validated decimal number.
    pub amount_field: Option<String>,
    pub amount: Option<serde_json::Number>,
    pub created_at: u64,
    /// Whether a completion webhook has been applied (the webhook fires on completion —
    /// a matched delivery IS the terminal fact; first terminal wins).
    pub terminal: bool,
    pub status_ts: Option<u64>,
    /// The FULL venue payload of the terminal delivery, verbatim.
    pub last_webhook_payload: Option<String>,
}

/// The in-memory order index: order id → latest record, venue id → order id.
#[derive(Default)]
struct OrdersInner {
    by_order: HashMap<String, OrderRecord>,
    by_venue: HashMap<String, String>,
}

impl OrdersInner {
    fn insert(&mut self, record: OrderRecord) {
        if let Some(v) = &record.venue_order_id {
            self.by_venue.insert(v.clone(), record.order_id.clone());
        }
        self.by_order.insert(record.order_id.clone(), record);
    }
}

/// What one webhook delivery taught the store (the receiver's log line cares which).
pub enum WebhookOutcome {
    /// First terminal delivery for a known order: the record was updated.
    Matched { order_id: String },
    /// A known order, already terminal: idempotent 200, NOTHING overwritten.
    DuplicateTerminal { order_id: String },
    /// The body was not a usable venue payload for a known order.
    Invalid,
    /// `external_id` matched no order (or was absent).
    Unmatched,
}

/// The proxy + webhook receiver state (one struct — the module IS the venue's whole
/// relay surface). Built unconfigured by default; `main` attaches the env values.
pub struct MtPelerinProxy {
    ctkn: Option<String>,
    webhook_secret: Option<String>,
    webhook_auth_key: Option<String>,
    base: String,
    timeout: Duration,
    client: reqwest::Client,
    log_dir: PathBuf,
    trust_proxy: bool,
    status_spacing_secs: u64,
    quote_per_min: u32,
    conversion_per_min: u32,
    orders: Mutex<OrdersInner>,
    /// order/query id → unix secs of the last status read (the 60 s promise).
    spacing: Mutex<HashMap<String, u64>>,
    /// `"kind|ip"` → (window bucket, admitted count): the per-client fixed windows
    /// (the trocador agreement's limiter verbatim).
    limiter: Mutex<HashMap<String, (u64, u32)>>,
    now: NowFn,
}

impl MtPelerinProxy {
    /// Build the proxy from its config and REBUILD the order index from the append-only
    /// store (last-wins per order id; corrupt lines skipped — append-only files tolerate
    /// a torn tail). A missing file is the empty store: an unconfigured relay that never
    /// proxied anything creates nothing.
    pub fn new(config: MtPelerinConfig) -> Self {
        let orders = load_orders(&config.log_dir.join(ORDERS_LOG_FILE));
        MtPelerinProxy {
            ctkn: config.ctkn,
            webhook_secret: config.webhook_secret,
            webhook_auth_key: config.webhook_auth_key,
            base: config.api_base,
            timeout: DEFAULT_TIMEOUT,
            client: http_client(),
            log_dir: config.log_dir,
            trust_proxy: config.trust_proxy,
            status_spacing_secs: config.status_spacing_secs,
            quote_per_min: config.quote_per_min,
            conversion_per_min: config.conversion_per_min,
            orders: Mutex::new(orders),
            spacing: Mutex::new(HashMap::new()),
            limiter: Mutex::new(HashMap::new()),
            now: Arc::new(crate::now_secs),
        }
    }

    /// Swap the clock. Test seam ONLY (the offline tests walk the 60 s window without
    /// sleeping); production never calls this.
    pub fn with_clock(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    /// Whether `X-Forwarded-For` may name the client IP (the shared `DPAY_TRUST_PROXY`).
    pub fn trust_proxy(&self) -> bool {
        self.trust_proxy
    }

    /// The missing QUOTE-proxy credential name (the CTKN gates the one upstream-bound
    /// surface; the conversion routes are local and need no key). Unset is a LEGAL state
    /// (503, not 404).
    fn missing_credential(&self) -> Option<&'static str> {
        if self.ctkn.is_none() {
            Some("DPAY_MTPELERIN_CTKN")
        } else {
            None
        }
    }

    /// The missing webhook credential name, likewise.
    fn missing_webhook_secret(&self) -> Option<&'static str> {
        if self.webhook_secret.is_none() {
            Some("DPAY_MTPELERIN_WEBHOOK_SECRET")
        } else {
            None
        }
    }

    /// The 60 s-per-id spacing gate on the status read (the poll cap; the trocador
    /// agreement's `admit_status` verbatim). Marks the window BEFORE the answer — the
    /// promise bounds reads, not successes. `Err(remaining)` = 429 + `Retry-After`.
    fn admit_status(&self, id: &str) -> Result<(), u64> {
        let now = (self.now)();
        let mut map = self.spacing.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(&last) = map.get(id) {
            let elapsed = now.saturating_sub(last);
            if elapsed < self.status_spacing_secs {
                return Err(self.status_spacing_secs - elapsed);
            }
        }
        if map.len() > MAP_PRUNE_LEN {
            map.retain(|_, ts| now.saturating_sub(*ts) < 3600);
        }
        map.insert(id.to_string(), now);
        Ok(())
    }

    /// Admit one upstream-bound call under the per-client fixed window (the trocador
    /// agreement's `admit` verbatim). `Ok(())` = proceed (and the call IS counted);
    /// `Err(remaining)` = the window is full: answer 429 with `Retry-After: remaining`.
    /// Exempt by their call sites: device 400s, the unconfigured 503, status reads (the
    /// poll cap has its own spacing), every webhook delivery.
    fn admit(&self, kind: LimitKind, ip: Option<&str>) -> Result<(), u64> {
        const WINDOW: u64 = 60;
        let limit = match kind {
            LimitKind::Quote => self.quote_per_min,
            LimitKind::Conversion => self.conversion_per_min,
        };
        let now = (self.now)();
        let bucket = now - now % WINDOW;
        let key = format!("{}|{}", kind.window_key(), ip.unwrap_or("-"));
        let mut map = self.limiter.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > MAP_PRUNE_LEN {
            map.retain(|_, (b, _)| *b == bucket);
        }
        let entry = map.entry(key).or_insert((bucket, 0));
        if entry.0 != bucket {
            *entry = (bucket, 0);
        }
        if entry.1 >= limit {
            return Err((bucket + WINDOW - now).max(1));
        }
        entry.1 += 1;
        Ok(())
    }

    /// Mint an order id and persist the record FIRST (the persist-first promise: the
    /// correlation id exists before anything else can happen to it). Carries the
    /// requested conversion's own detail (pair + amount) so the store line is complete
    /// from birth. JSONL appends are best-effort (stderr on failure) — the in-memory
    /// index is still the correlation source of truth. Returns the full record.
    fn open_order(
        &self,
        client_order_id: Option<&str>,
        source_currency: &str,
        dest_currency: &str,
        amount_field: &str,
        amount: serde_json::Number,
    ) -> OrderRecord {
        let order_id = fresh_order_id();
        let record = OrderRecord {
            order_id: order_id.clone(),
            client_order_id: client_order_id.map(str::to_string),
            venue_order_id: None,
            offramp_address: None,
            source_currency: Some(source_currency.to_string()),
            dest_currency: Some(dest_currency.to_string()),
            amount_field: Some(amount_field.to_string()),
            amount: Some(amount),
            created_at: (self.now)(),
            terminal: false,
            status_ts: None,
            last_webhook_payload: None,
        };
        let mut orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        orders.insert(record.clone());
        write_jsonl(
            &self.log_dir,
            &self.log_dir.join(ORDERS_LOG_FILE),
            &order_record_line(&record),
        );
        record
    }

    /// Apply one webhook delivery: `external_id` is the echoed `oid`. FIRST terminal
    /// wins — a matched order that is already terminal is answered idempotently and its
    /// stored payload is never overwritten. Unknown ids stay `Unmatched`.
    fn apply_webhook(&self, external_id: &str, body: &str) -> WebhookOutcome {
        let parsed: Option<Value> = serde_json::from_str::<Value>(body)
            .ok()
            .filter(|v: &Value| v.is_object());
        let Some(parsed) = parsed else {
            let matched = self
                .orders
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .by_order
                .contains_key(external_id);
            return if matched {
                WebhookOutcome::Invalid
            } else {
                WebhookOutcome::Unmatched
            };
        };
        let venue_order_id = json_string_field(&parsed, "id");
        let mut orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        let Some(record) = orders.by_order.get_mut(external_id) else {
            return WebhookOutcome::Unmatched;
        };
        if record.terminal {
            return WebhookOutcome::DuplicateTerminal {
                order_id: external_id.to_string(),
            };
        }
        if let Some(v) = &venue_order_id {
            record.venue_order_id = Some(v.clone());
        }
        record.terminal = true;
        record.status_ts = Some((self.now)());
        record.last_webhook_payload = Some(body.to_string());
        // Own the updated state (ends the map borrow): the trade index learns the id
        // below, and the persist runs against the SAME owned snapshot the index holds.
        let record = record.clone();
        if let Some(v) = &venue_order_id {
            orders.by_venue.insert(v.clone(), external_id.to_string());
        }
        drop(orders);
        write_jsonl(
            &self.log_dir,
            &self.log_dir.join(ORDERS_LOG_FILE),
            &order_record_line(&record),
        );
        WebhookOutcome::Matched {
            order_id: external_id.to_string(),
        }
    }

    /// The order an id names — by OUR order id first, then by the venue's own id.
    fn order_by_any_id(&self, id: &str) -> Option<OrderRecord> {
        let orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(r) = orders.by_order.get(id) {
            return Some(r.clone());
        }
        orders
            .by_venue
            .get(id)
            .and_then(|oid| orders.by_order.get(oid))
            .cloned()
    }

    /// Append one access-log line (best-effort JSONL, the trocador JSONL-mode contract).
    fn log(&self, line: &AccessLine<'_>) {
        write_jsonl(
            &self.log_dir,
            &self.log_dir.join(ACCESS_LOG_FILE),
            &access_line_json(line, (self.now)()),
        );
    }
}

/// `GET /api/v1/mtpelerin/quote` — the query-only quote surface, proxied to the venue's
/// documented `POST /currency_rates/convert`. Query params (whitelisted — a device
/// cannot smuggle anything else upstream): `sourceCurrency`, `destCurrency` (required),
/// exactly one of `sourceAmount`/`destAmount`, `sourceNetwork`, `destNetwork`,
/// `isCardPayment=true|false`. Success wraps
/// `{"venue_id":"mtpelerin","quote":<the venue's body VERBATIM>,"fetched_at":<unix secs>}`
/// — attribution + timestamp, numbers untouched (plan §4: never computed).
pub async fn quote_proxy(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
    fp: MtpFingerprint,
) -> Response {
    let proxy = state.mtpelerin.clone();
    if let Some(response) = unconfigured(proxy.missing_credential()) {
        return response;
    }
    for (k, _) in &params {
        if !QUOTE_PARAMS.contains(&k.as_str()) {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "unknown quote parameter `{k}` - the quote surface accepts exactly: {}",
                    QUOTE_PARAMS.join(", ")
                ),
            );
        }
    }
    let (Some(source_currency), Some(dest_currency)) = (
        params.get("sourceCurrency").map(String::as_str),
        params.get("destCurrency").map(String::as_str),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "quote needs string query params `sourceCurrency` and `destCurrency` (the \
             venue's own currency codes)",
        );
    };
    if source_currency.is_empty() || dest_currency.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "`sourceCurrency` and `destCurrency` must be non-empty",
        );
    }
    if params.contains_key("sourceAmount") && params.contains_key("destAmount") {
        return err(
            StatusCode::BAD_REQUEST,
            "pass exactly one of `sourceAmount` or `destAmount` - the venue refuses both \
             with a 400",
        );
    }
    if !params.contains_key("sourceAmount") && !params.contains_key("destAmount") {
        return err(
            StatusCode::BAD_REQUEST,
            "pass exactly one of `sourceAmount` or `destAmount` - there is no conversion \
             to quote without one",
        );
    }
    if let Some(card) = params.get("isCardPayment").map(String::as_str) {
        if card != "true" && card != "false" {
            return err(
                StatusCode::BAD_REQUEST,
                "`isCardPayment` must be `true` or `false`",
            );
        }
    }
    let mut body = serde_json::Map::new();
    body.insert("sourceCurrency".into(), json!(source_currency));
    body.insert("destCurrency".into(), json!(dest_currency));
    for key in ["sourceAmount", "destAmount"] {
        if let Some(amount) = params.get(key) {
            match decimal_json_number(amount) {
                Some(n) => {
                    body.insert(key.into(), Value::Number(n));
                }
                None => {
                    return err(
                        StatusCode::BAD_REQUEST,
                        format!("`{key}` must be a plain decimal number (e.g. 100 or 1.5)"),
                    );
                }
            }
        }
    }
    for key in ["sourceNetwork", "destNetwork"] {
        if let Some(net) = params.get(key) {
            body.insert(key.into(), json!(net));
        }
    }
    if let Some(card) = params.get("isCardPayment") {
        body.insert("isCardPayment".into(), json!(card == "true"));
    }

    // The per-client window admits the call right before it is made (the trocador
    // discipline: device 400s above are never counted, only upstream-bound calls).
    if let Err(retry) = proxy.admit(LimitKind::Quote, fp.ip.as_deref()) {
        return too_many(
            QUOTE_LIMITED_CODE,
            "mtpelerin quote requests are rate-limited for this client: at most a \
             fixed number of quotes per client per minute reach the venue",
            retry,
        );
    }

    let url = match reqwest::Url::parse(&format!("{}{}", proxy.base, QUOTE_PATH)) {
        Ok(u) => u,
        Err(_) => {
            return err(
                StatusCode::BAD_REQUEST,
                "upstream URL could not be built for the quote method",
            )
        }
    };
    let started = Instant::now();
    // The quote endpoint is keyless upstream (the docs name no auth header) — the CTKN
    // tripwire above is dpay's own availability gate for the surface, not a wire secret.
    let outcome = post_upstream(&proxy, url, &Bytes::from(Value::Object(body).to_string())).await;
    proxy.log(&AccessLine {
        kind: "quote",
        route: "/api/v1/mtpelerin/quote",
        method: "GET",
        ip: fp.ip.clone(),
        user_agent: fp.user_agent.clone(),
        accept_language: fp.accept_language.clone(),
        order_id: None,
        venue_order_id: None,
        upstream_status: Some(outcome.status.as_u16()),
        duration_ms: Some(started.elapsed().as_millis() as u64),
    });
    if outcome.status.is_success() {
        if let Ok(Value::Object(venue_body)) = serde_json::from_slice::<Value>(&outcome.body) {
            let wrapped = json!({
                "venue_id": MTPELERIN_VENUE_ID,
                "quote": Value::Object(venue_body),
                "fetched_at": (proxy.now)(),
            });
            return json_response(outcome.status, &Bytes::from(wrapped.to_string()));
        }
    }
    json_response(outcome.status, &outcome.body)
}

/// `POST /api/v1/mtpelerin/conversion` - LOCAL order registration (no upstream call; the
/// venue's API tier is closed for dpay, module header). Request (device):
/// `{"sourceCurrency", "destCurrency", "sourceAmount"|"destAmount", "sourceNetwork",
/// "clientOrderId"?}` - the pair, the network and exactly one amount are required.
/// `iban`/`holderName` stay ACCEPTED but are no longer required: they fed the closed
/// upstream order call, and the venue's own widget session collects bank details now.
/// The relay
/// mints the correlation id (`mtp-…`), persists the order (pair + amount + `created_at`)
/// FIRST, and answers 200 with the record in the status route's own shape plus the order
/// id riding `X-Dpay-Order-Id`. The order id reaches Mt Pelerin on the widget link's
/// `oid` parameter; their completion webhook echoes it back as `external_id`, and that
/// delivery is what names the venue's `id` (and any deposit address) in the store. No
/// CTKN is required here: the route dials nothing (the quote proxy keeps the key gate).
pub async fn conversion_proxy(
    State(state): State<AppState>,
    fp: MtpFingerprint,
    body: Bytes,
) -> Response {
    let proxy = state.mtpelerin.clone();
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) - POST /api/v1/mtpelerin/conversion \
                     takes {{sourceCurrency, destCurrency, sourceAmount|destAmount, \
                     sourceNetwork}}"
                ),
            );
        }
    };
    let str_field = |name: &str| {
        req.get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let (Some(source_currency), Some(dest_currency), Some(_source_network)) = (
        str_field("sourceCurrency"),
        str_field("destCurrency"),
        str_field("sourceNetwork"),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs non-empty string fields `sourceCurrency`, `destCurrency` and \
             `sourceNetwork`",
        );
    };
    let source_amount = req.get("sourceAmount");
    let dest_amount = req.get("destAmount");
    let amount = match (source_amount.is_some(), dest_amount.is_some()) {
        (true, true) | (false, false) => {
            return err(
                StatusCode::BAD_REQUEST,
                "pass exactly one of `sourceAmount` or `destAmount` (a decimal number)",
            );
        }
        (true, false) => ("sourceAmount", source_amount.unwrap()),
        (false, true) => ("destAmount", dest_amount.unwrap()),
    };
    let amount_number = match amount.1.as_str() {
        Some(s) => match decimal_json_number(s.trim()) {
            Some(n) => n,
            None => {
                return err(
                    StatusCode::BAD_REQUEST,
                    format!("`{}` must be a plain decimal number", amount.0),
                );
            }
        },
        None if amount.1.is_number() => match decimal_json_number(&amount.1.to_string()) {
            Some(n) => n,
            None => {
                return err(
                    StatusCode::BAD_REQUEST,
                    format!("`{}` must be a plain decimal number", amount.0),
                );
            }
        },
        None => {
            return err(
                StatusCode::BAD_REQUEST,
                format!("`{}` must be a decimal number", amount.0),
            );
        }
    };
    let client_order_id = req
        .get("clientOrderId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_CLIENT_ORDER_ID_CHARS).collect::<String>());

    // The per-client window admits the call BEFORE the order is minted (the trocador
    // trade rule: a refused call persists nothing).
    if let Err(retry) = proxy.admit(LimitKind::Conversion, fp.ip.as_deref()) {
        return too_many(
            CONVERSION_LIMITED_CODE,
            "mtpelerin conversion creation is rate-limited for this client: at most a \
             fixed number of orders per client per minute are registered",
            retry,
        );
    }

    // Persist FIRST (the correlation id exists before anything else), then answer with
    // the record: the same status-shape body the GET route serves for this id, with the
    // venue fields still absent (only a webhook delivery can name them).
    let started = Instant::now();
    let record = proxy.open_order(
        client_order_id.as_deref(),
        source_currency,
        dest_currency,
        amount.0,
        amount_number,
    );
    proxy.log(&AccessLine {
        kind: "conversion",
        route: "/api/v1/mtpelerin/conversion",
        method: "POST",
        ip: fp.ip.clone(),
        user_agent: fp.user_agent.clone(),
        accept_language: fp.accept_language.clone(),
        order_id: Some(record.order_id.clone()),
        venue_order_id: None,
        upstream_status: None,
        duration_ms: Some(started.elapsed().as_millis() as u64),
    });
    let mut response = json_response(StatusCode::OK, &status_body(&record));
    if let Ok(value) = HeaderValue::from_str(&record.order_id) {
        response.headers_mut().insert(ORDER_ID_HEADER, value);
    }
    response
}

/// `GET /api/v1/mtpelerin/conversion?id=<order id>` — the status read: the webhook's
/// FALLBACK channel (Mt Pelerin documents no delivery retry). The store answers with ZERO
/// upstream calls (webhook-first), so the route needs no CTKN (the key gates the quote
/// proxy, the one upstream-bound surface), and the promised poll cap bounds reads: at
/// most one per id per 60 s, 429 + `Retry-After` beyond (`mtpelerin-status-throttled`).
/// `id` is dpay's order id (the `X-Dpay-Order-Id` creation carried); the venue's own id
/// resolves too. Unknown ids are a 404 house error.
pub async fn conversion_status(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
    fp: MtpFingerprint,
) -> Response {
    let proxy = state.mtpelerin.clone();
    let Some(id) = params.get("id").map(String::as_str).filter(|s| !s.is_empty())
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs a non-empty `id` query parameter (dpay's order id - the \
             X-Dpay-Order-Id the conversion answer carried)",
        );
    };
    // The poll cap marks BEFORE the read (the promise bounds reads, not successes).
    if let Err(remaining) = proxy.admit_status(id) {
        return too_many(
            STATUS_THROTTLED_CODE,
            "status for this order was read less than 60s ago (the poll fallback's own \
             discipline: at most one read per order per minute, stopping at the first \
             terminal state)",
            remaining,
        );
    }
    let record = proxy.order_by_any_id(id);
    proxy.log(&AccessLine {
        kind: "status",
        route: "/api/v1/mtpelerin/conversion",
        method: "GET",
        ip: fp.ip.clone(),
        user_agent: fp.user_agent.clone(),
        accept_language: fp.accept_language.clone(),
        order_id: record.as_ref().map(|r| r.order_id.clone()),
        venue_order_id: record.as_ref().and_then(|r| r.venue_order_id.clone()),
        upstream_status: None,
        duration_ms: None,
    });
    let Some(record) = record else {
        return err(StatusCode::NOT_FOUND, "no such conversion order");
    };
    json_response(StatusCode::OK, &status_body(&record))
}

/// One order record in the status route's JSON shape: the body BOTH the status read and
/// the creation answer serve (creation answers the record exactly as the store now holds
/// it). The venue's facts (`venue_order_id`, `offRampAddress`, `payload`) are null until
/// a verified webhook delivery names them.
fn status_body(record: &OrderRecord) -> Bytes {
    let payload = record
        .last_webhook_payload
        .as_deref()
        .and_then(|p| serde_json::from_str::<Value>(p).ok());
    let body = json!({
        "order_id": record.order_id,
        "venue_order_id": record.venue_order_id,
        "offRampAddress": record.offramp_address,
        "terminal": record.terminal,
        "created_at": record.created_at,
        "status_ts": record.status_ts,
        "payload": payload,
    });
    Bytes::from(body.to_string())
}

/// `POST /api/v1/mtpelerin/webhook` — the conversion webhook receiver. Contract
/// (conversion-webhook.md, fetched 2026-10-12): the delivery carries the `Mtp-Signature`
/// header — HMAC-SHA256 over the FULL raw body, hex, keyed with the signature key — and
/// the body `{"id", "amount", "currency", "external_id"}` where `external_id` echoes our
/// `oid`. A matched, verified delivery marks the order TERMINAL (the webhook fires on
/// completion); the first terminal payload wins and later deliveries are idempotent.
/// Verified-but-unknown ids and probes still answer 200 (they are authentic venue
/// traffic — a non-2xx could only invite redelivery of what we cannot correlate);
/// authentication and signature failures answer 401 and mutate nothing. When
/// `DPAY_MTPELERIN_WEBHOOK_AUTH_KEY` is configured, the `Authentication` header must
/// equal it exactly (constant-time) BEFORE the signature is even considered.
pub async fn webhook_receiver(
    State(state): State<AppState>,
    headers: HeaderMap,
    fp: MtpFingerprint,
    body: Bytes,
) -> Response {
    let proxy = state.mtpelerin.clone();
    if let Some(response) = unconfigured(proxy.missing_webhook_secret()) {
        return response;
    }
    let secret = proxy.webhook_secret.clone().expect("checked above");
    let started = Instant::now();
    // The OPTIONAL authKey gate, BEFORE the signature check (the docs exchange two keys:
    // the authKey rides the `Authentication` header, the signKey keys the HMAC). Only
    // enforced when the operator configured it: until then the HMAC alone guards.
    if let Some(auth_key) = proxy.webhook_auth_key.as_deref() {
        let presented = headers
            .get(auth_header_name())
            .and_then(|v| v.to_str().ok())
            .map(str::trim);
        let matches = presented
            .map(|p| constant_time_eq(p.as_bytes(), auth_key.as_bytes()))
            .unwrap_or(false);
        if !matches {
            proxy.log(&AccessLine {
                kind: "webhook-unauthorized",
                route: "/api/v1/mtpelerin/webhook",
                method: "POST",
                ip: fp.ip.clone(),
                user_agent: fp.user_agent.clone(),
                accept_language: fp.accept_language.clone(),
                order_id: None,
                venue_order_id: None,
                upstream_status: None,
                duration_ms: Some(started.elapsed().as_millis() as u64),
            });
            return json_response(
                StatusCode::UNAUTHORIZED,
                &relay_error_body(
                    WEBHOOK_UNAUTHORIZED_CODE,
                    "webhook authentication missing or invalid - when the Authentication \
                     key is exchanged the Authentication header must carry it exactly",
                ),
            );
        }
    }
    let signature = headers
        .get(signature_header_name())
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !verify_signature(&secret, &body, signature.as_deref()) {
        proxy.log(&AccessLine {
            kind: "webhook-unauthorized",
            route: "/api/v1/mtpelerin/webhook",
            method: "POST",
            ip: fp.ip.clone(),
            user_agent: fp.user_agent.clone(),
            accept_language: fp.accept_language.clone(),
            order_id: None,
            venue_order_id: None,
            upstream_status: None,
            duration_ms: Some(started.elapsed().as_millis() as u64),
        });
        return json_response(
            StatusCode::UNAUTHORIZED,
            &relay_error_body(
                WEBHOOK_UNAUTHORIZED_CODE,
                "webhook signature missing or invalid - the Mtp-Signature header must be \
                 the HMAC-SHA256 (hex) of the full request body under the exchanged \
                 signature key",
            ),
        );
    }
    let body_text = std::str::from_utf8(&body).unwrap_or("");
    let external_id = serde_json::from_str::<Value>(body_text)
        .ok()
        .and_then(|v| json_string_field(&v, "external_id"))
        .unwrap_or_default();
    let outcome = proxy.apply_webhook(&external_id, body_text);
    let kind = match &outcome {
        WebhookOutcome::Matched { .. } => "webhook",
        WebhookOutcome::DuplicateTerminal { .. } => "webhook-duplicate",
        WebhookOutcome::Invalid => "webhook-unmatched",
        WebhookOutcome::Unmatched => "webhook-unmatched",
    };
    let record = proxy.order_by_any_id(&external_id);
    proxy.log(&AccessLine {
        kind,
        route: "/api/v1/mtpelerin/webhook",
        method: "POST",
        ip: fp.ip.clone(),
        user_agent: fp.user_agent.clone(),
        accept_language: fp.accept_language.clone(),
        order_id: record.as_ref().map(|r| r.order_id.clone()),
        venue_order_id: record.as_ref().and_then(|r| r.venue_order_id.clone()),
        upstream_status: None,
        duration_ms: Some(started.elapsed().as_millis() as u64),
    });
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

/// The quote surface's whitelisted query params (the venue's documented request fields).
const QUOTE_PARAMS: &[&str] = &[
    "sourceCurrency",
    "destCurrency",
    "sourceAmount",
    "destAmount",
    "sourceNetwork",
    "destNetwork",
    "isCardPayment",
];

/// Verify an HMAC-SHA256 hex signature over the exact raw body bytes. Any tamper, any
/// cross-body signature reuse, a missing or non-hex header fails. The comparison itself
/// is constant-time (`Mac::verify_slice`).
pub fn verify_signature(secret: &str, body: &[u8], signature: Option<&str>) -> bool {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let Some(sig) = signature.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let Ok(expected) = hex::decode(sig) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&expected).is_ok()
}

/// The `Mtp-Signature` header name, lowercase static (axum wants the lowercase form).
fn signature_header_name() -> header::HeaderName {
    header::HeaderName::from_static("mtp-signature")
}

/// The `Authentication` header name, lowercase static (axum's lookup is
/// case-insensitive; the static avoids a runtime parse).
fn auth_header_name() -> header::HeaderName {
    header::HeaderName::from_static("authentication")
}

/// Constant-time byte equality for equal-purpose secrets: both sides are hashed to
/// fixed 32-byte digests first (so length never leaks and the compare is a fixed-size
/// XOR fold, the classic `constant_time_eq` shape). Only ever answers "equal or not";
/// never logs either side.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use sha2::{Digest, Sha256};
    let da = Sha256::digest(a);
    let db = Sha256::digest(b);
    let mut diff = 0u8;
    for (x, y) in da.iter().zip(db.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// `mtp-` + 16 lowercase hex from the OS CSPRNG — the checkout's `fresh_id` discipline,
/// pointed at its own prefix so the id spaces can never collide.
fn fresh_order_id() -> String {
    let mut bytes = [0u8; 8];
    match getrandom::getrandom(&mut bytes) {
        Ok(()) => format!("{ORDER_ID_PREFIX}{}", hex::encode(bytes)),
        Err(e) => panic!(
            "dpay-relay: mtpelerin: the OS CSPRNG is unavailable ({e}) — cannot mint an \
             order id"
        ),
    }
}

/// A plain decimal string → a JSON number (the venue's own request shape: amounts ride
/// as numbers, per the price-quote doc's examples). `serde_json`'s float printing is
/// shortest-round-trip, so ordinary decimal amounts re-serialize exactly.
fn decimal_json_number(s: &str) -> Option<serde_json::Number> {
    if s.is_empty() {
        return None;
    }
    let mut seen_dot = false;
    let mut seen_digit = false;
    for c in s.chars() {
        match c {
            '0'..='9' => seen_digit = true,
            '.' if !seen_dot => seen_dot = true,
            _ => return None,
        }
    }
    if !seen_digit {
        return None;
    }
    if let Ok(i) = s.parse::<i64>() {
        return Some(serde_json::Number::from(i));
    }
    if let Ok(u) = s.parse::<u64>() {
        return Some(serde_json::Number::from(u));
    }
    // Not an integer: the float path (serde_json prints f64 shortest-round-trip, so
    // ordinary decimal amounts re-serialize exactly as they arrived).
    s.parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .and_then(serde_json::Number::from_f64)
}

/// One string field off a JSON object (trimmed, non-empty).
fn json_string_field(v: &Value, name: &str) -> Option<String> {
    v.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// One order record as a JSON line (optional fields omitted; the payload embedded
/// verbatim). Append-only: readers do last-wins.
fn order_record_line(record: &OrderRecord) -> String {
    let mut object = serde_json::Map::new();
    object.insert("order_id".into(), json!(record.order_id));
    if let Some(v) = &record.client_order_id {
        object.insert("client_order_id".into(), json!(v));
    }
    if let Some(v) = &record.venue_order_id {
        object.insert("venue_order_id".into(), json!(v));
    }
    if let Some(v) = &record.offramp_address {
        object.insert("offramp_address".into(), json!(v));
    }
    if let Some(v) = &record.source_currency {
        object.insert("source_currency".into(), json!(v));
    }
    if let Some(v) = &record.dest_currency {
        object.insert("dest_currency".into(), json!(v));
    }
    if let Some(v) = &record.amount_field {
        object.insert("amount_field".into(), json!(v));
    }
    if let Some(v) = &record.amount {
        object.insert("amount".into(), json!(v));
    }
    object.insert("created_at".into(), json!(record.created_at));
    object.insert("terminal".into(), json!(record.terminal));
    if let Some(v) = record.status_ts {
        object.insert("status_ts".into(), json!(v));
    }
    if let Some(v) = &record.last_webhook_payload {
        object.insert("last_webhook_payload".into(), json!(v));
    }
    Value::Object(object).to_string()
}

/// One access-log line as JSON — the trocador agreement's field-for-field shape.
fn access_line_json(line: &AccessLine<'_>, now: u64) -> String {
    let mut object = serde_json::Map::new();
    object.insert("ts".into(), json!(rfc3339(now)));
    object.insert("ts_unix".into(), json!(now));
    object.insert("kind".into(), json!(line.kind));
    object.insert("route".into(), json!(line.route));
    object.insert("method".into(), json!(line.method));
    object.insert("ip".into(), json!(line.ip.as_deref().unwrap_or("-")));
    object.insert(
        "user_agent".into(),
        json!(line.user_agent.as_deref().unwrap_or("-")),
    );
    object.insert(
        "accept_language".into(),
        json!(line.accept_language.as_deref().unwrap_or("-")),
    );
    if let Some(v) = &line.order_id {
        object.insert("order_id".into(), json!(v));
    }
    if let Some(v) = &line.venue_order_id {
        object.insert("venue_order_id".into(), json!(v));
    }
    if let Some(v) = line.upstream_status {
        object.insert("upstream_status".into(), json!(v));
    }
    if let Some(v) = line.duration_ms {
        object.insert("duration_ms".into(), json!(v));
    }
    Value::Object(object).to_string()
}

/// One access-log line's fields (the timestamp pair is filled by the writer).
pub struct AccessLine<'a> {
    pub kind: &'a str,
    pub route: &'a str,
    pub method: &'a str,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub accept_language: Option<String>,
    pub order_id: Option<String>,
    pub venue_order_id: Option<String>,
    pub upstream_status: Option<u16>,
    pub duration_ms: Option<u64>,
}

/// Rebuild the order index from the append-only store (last-wins per order_id). A missing
/// file is the empty store; a torn/corrupt line is skipped, never fatal.
fn load_orders(path: &Path) -> OrdersInner {
    let mut inner = OrdersInner::default();
    let Ok(text) = std::fs::read_to_string(path) else {
        return inner;
    };
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(order_id) = value.get("order_id").and_then(Value::as_str) else {
            continue;
        };
        inner.insert(OrderRecord {
            order_id: order_id.to_string(),
            client_order_id: value
                .get("client_order_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            venue_order_id: value
                .get("venue_order_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            offramp_address: value
                .get("offramp_address")
                .and_then(Value::as_str)
                .map(str::to_string),
            source_currency: value
                .get("source_currency")
                .and_then(Value::as_str)
                .map(str::to_string),
            dest_currency: value
                .get("dest_currency")
                .and_then(Value::as_str)
                .map(str::to_string),
            amount_field: value
                .get("amount_field")
                .and_then(Value::as_str)
                .map(str::to_string),
            amount: value.get("amount").and_then(Value::as_number).cloned(),
            created_at: value.get("created_at").and_then(Value::as_u64).unwrap_or(0),
            terminal: value
                .get("terminal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            status_ts: value.get("status_ts").and_then(Value::as_u64),
            last_webhook_payload: value
                .get("last_webhook_payload")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    inner
}

/// One append-only JSONL write. Creates the dir on first use; a failure is a stderr note
/// and NEVER a request failure (the offline mode's lenience — the trocador store's rule).
///
/// Concurrency shape: ONE relay process owns this directory (the deployment shape — the
/// prod compose runs one relay container). Every line leaves as a single `writeln!` on an
/// `O_APPEND` handle, so concurrent in-process requests (or a second process, if an
/// operator ever runs one) cannot interleave mid-line; readers do last-wins per order id
/// on reload ([`load_orders`]), and a torn tail line is skipped, never fatal.
fn write_jsonl(dir: &Path, path: &Path, line: &str) {
    use std::io::Write;
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("dpay-relay: mtpelerin: cannot create log dir {}: {e}", dir.display());
        return;
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            if let Err(e) = writeln!(file, "{line}") {
                eprintln!(
                    "dpay-relay: mtpelerin: append to {} failed: {e}",
                    path.display()
                );
            }
        }
        Err(e) => eprintln!(
            "dpay-relay: mtpelerin: cannot open {} for append: {e}",
            path.display()
        ),
    }
}

/// The connecting client's fingerprint for the access log (the trocador agreement's
/// extractor, pointed at this proxy's `trust_proxy`). Infallible; `-` in the log when
/// neither XFF (trusted) nor ConnectInfo is visible.
pub struct MtpFingerprint {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub accept_language: Option<String>,
}

impl FromRequestParts<AppState> for MtpFingerprint {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let ip = if state.mtpelerin.trust_proxy() {
            parts
                .headers
                .get(header::HeaderName::from_static("x-forwarded-for"))
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        }
        .or_else(|| {
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip().to_string())
        });
        Ok(MtpFingerprint {
            ip,
            user_agent: parts
                .headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
            accept_language: parts
                .headers
                .get(header::ACCEPT_LANGUAGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        })
    }
}

/// The 503 answer for a missing credential, naming exactly which variable (one marker,
/// two credentials: the proxy's CTKN and the receiver's signature key).
fn unconfigured(missing: Option<&'static str>) -> Option<Response> {
    let missing = missing?;
    Some(json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        &relay_error_body(
            UNCONFIGURED_CODE,
            &format!(
                "mtpelerin proxy is not configured: set {missing} in the relay's \
                 environment (the Mt Pelerin integration key or webhook signature key - \
                 exchanged with hello@mtpelerin.com; see docs/OPS.md §3)"
            ),
        ),
    ))
}

/// One upstream call: POST the JSON body, answer with the upstream's status + body
/// verbatim — or the fixed 504 marker for transport trouble. The reqwest error is
/// DROPPED, not formatted (it embeds the request URL).
async fn post_upstream(proxy: &MtPelerinProxy, url: reqwest::Url, body: &Bytes) -> Outcome {
    let request = proxy
        .client
        .post(url)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .body(body.clone())
        .timeout(proxy.timeout);
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => return transport_refusal(e, proxy.timeout),
    };
    let status = response.status();
    match response.bytes().await {
        Ok(bytes) => Outcome { status, body: bytes },
        Err(e) => transport_refusal(e, proxy.timeout),
    }
}

/// One completed upstream call: status + body (the verbatim-passthrough currency).
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

/// The honest answer when Mt Pelerin could not be reached: a 504 carrying the
/// relay-originated marker, category only (never the error, never the URL).
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
            UNREACHABLE_CODE,
            &format!("mtpelerin upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract shared with
/// crate::trocador: `{"dpayRelayError": <code>, "detail": <short human phrase>}`. Fixed
/// inputs only (env var NAMES and categories), so no secret can leak through.
fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(
        serde_json::json!({
            "dpayRelayError": code,
            "detail": detail,
        })
        .to_string(),
    )
}

/// The 429 answer for the poll cap: the house marker + `Retry-After` in whole seconds.
fn too_many(code: &str, detail: &str, retry_after_secs: u64) -> Response {
    let mut response = json_response(StatusCode::TOO_MANY_REQUESTS, &relay_error_body(code, detail));
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(retry_after_secs));
    response
}

/// The shared HTTP client (one per process; redirects NOT followed — exactly one hop,
/// surfaced not chased, the crate::trocador discipline).
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the mtpelerin proxy's HTTP client")
        })
        .clone()
}

/// House error shape (`{"error": …}`, application/json) — client bugs, not relay facts.
fn err(status: StatusCode, msg: impl Into<String>) -> Response {
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

/// Unix seconds → RFC3339 UTC — the trocador agreement's own civil-from-days renderer
/// (kept byte-identical so both venues' logs read the same).
fn rfc3339(unix: u64) -> String {
    let days = (unix / 86_400) as i64;
    let rem = unix % 86_400;
    let (h, min, sec) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{sec:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_vector_is_the_rfc_4231_test_case() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?".
        let sig = hmac_hex("Jefe", b"what do ya want for nothing?");
        assert_eq!(
            sig,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert!(verify_signature("Jefe", b"what do ya want for nothing?", Some(&sig)));
        // Tampered body, wrong key, missing header, garbage hex: all refuse.
        assert!(!verify_signature(
            "Jefe",
            b"what do ya want for nothing?",
            Some(&hmac_hex("other", b"what do ya want for nothing?"))
        ));
        assert!(!verify_signature("Jefe", b"tampered", Some(&sig)));
        assert!(!verify_signature("Jefe", b"what do ya want for nothing?", None));
        assert!(!verify_signature(
            "Jefe",
            b"what do ya want for nothing?",
            Some("not-hex-at-all")
        ));
        assert!(!verify_signature("Jefe", b"what do ya want for nothing?", Some("")));
    }

    /// The hex HMAC this module verifies (test-side mirror so the vector above is not
    /// circular through `verify_signature` itself).
    fn hmac_hex(key: &str, data: &[u8]) -> String {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        let mut mac = <Hmac<Sha256>>::new_from_slice(key.as_bytes()).expect("key");
        mac.update(data);
        hex::encode(mac.finalize().into_bytes())
    }

    #[test]
    fn order_ids_have_the_pinned_shape() {
        let id = fresh_order_id();
        assert!(id.starts_with(ORDER_ID_PREFIX), "{id}");
        let hexpart = id.trim_start_matches(ORDER_ID_PREFIX);
        assert_eq!(hexpart.len(), 16, "{id}");
        assert!(
            hexpart
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "{id}"
        );
        assert_ne!(fresh_order_id(), fresh_order_id(), "CSPRNG ids do not repeat");
    }

    #[test]
    fn decimal_numbers_survive_the_round_trip() {
        for (raw, expect) in [
            ("100", "100"),
            ("0", "0"),
            ("1.5", "1.5"),
            ("0.1", "0.1"),
            ("123.45", "123.45"),
        ] {
            let n = decimal_json_number(raw).expect(raw);
            assert_eq!(n.to_string(), expect, "{raw}");
        }
        assert!(decimal_json_number("").is_none());
        assert!(decimal_json_number("abc").is_none());
        assert!(decimal_json_number("1,5").is_none());
        assert!(decimal_json_number("-1").is_none());
        assert!(decimal_json_number("1.5.5").is_none());
        assert!(decimal_json_number(".").is_none());
    }

    #[test]
    fn constant_time_eq_answers_exactly_equality() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"same", b"sam"));
        assert!(!constant_time_eq(b"same", b"same "));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(!constant_time_eq(b"a", b"b"));
    }

    #[test]
    fn unconfigured_names_exactly_the_missing_variable() {
        let none = MtPelerinProxy::new(MtPelerinConfig::default());
        assert_eq!(
            none.missing_credential(),
            Some("DPAY_MTPELERIN_CTKN"),
            "the proxy's missing variable"
        );
        assert_eq!(
            none.missing_webhook_secret(),
            Some("DPAY_MTPELERIN_WEBHOOK_SECRET"),
            "the receiver's missing variable"
        );
        let response = unconfigured(none.missing_credential()).expect("unconfigured → 503");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        // A configured proxy names nothing.
        let full = MtPelerinProxy::new(MtPelerinConfig {
            ctkn: Some("ctkn".into()),
            webhook_secret: Some("whsec".into()),
            ..MtPelerinConfig::default()
        });
        assert!(full.missing_credential().is_none());
        assert!(full.missing_webhook_secret().is_none());
        assert!(unconfigured(full.missing_credential()).is_none());
    }
}
