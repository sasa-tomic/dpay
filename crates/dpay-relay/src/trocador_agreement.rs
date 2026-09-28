//! The Trocador partner-agreement layer — the relay's three SIGNED promises to Trocador.app,
//! shipped as one wrapper around the [`crate::trocador`] proxy. 2026-09-21: the founder's
//! partner agreement is signed and the venue's API access is live; the webhook terms below are
//! confirmed by Trocador's commercial email of the same date. The proxy's route contract is
//! UNCHANGED — every route still answers exactly as before when the key is unset (the 503
//! naming `DPAY_TROCADOR_API_KEY`, the 400-class device errors, the verbatim venue bodies) —
//! this layer adds what the agreement obliges the relay to run AROUND those calls. It is
//! attached in main.rs from the env (always — the defaults are the agreement's terms); a proxy
//! built without it (unit tests) simply has no agreement layers and behaves byte-identically
//! to the pre-agreement relay.
//!
//! # 1. The compliance access log (live before the first proxied trade)
//!
//! Every relay→Trocador proxied request — rate quote, trade creation, status read — appends
//! one compliance record: the timestamp (RFC3339 + unix seconds), the source IP, the
//! User-Agent, the Accept-Language, the route and method, the upstream status, the duration,
//! and — once known — the correlation ids (our internal `order_id` and the venue's
//! `trade_id`). The venue's webhook deliveries log here too (`kind`: "webhook", or
//! "webhook-unmatched" when a delivery cannot be correlated to an order). The store is
//! APPEND-ONLY and no code path truncates or deletes: the agreement's ≥12-month retention is
//! satisfied by the deployment (the founder's backed-up Postgres, or a mounted volume),
//! never by anything the relay runs. Two backends, ONE behavior (2026-09-22 dual store):
//!
//! - `DPAY_TROCADOR_PG_DSN` SET → Postgres (`crate::trocador_pg`): both records live in the
//!   founder's BACKED-UP database (the prod compose stack mounts no volume — flat files die
//!   on redeploy, PG does not). Fail-closed: an unreachable DSN refuses startup, and a
//!   refused access-log write refuses the request — an unlogged proxied call is an
//!   agreement violation.
//! - UNSET (default) → the append-only JSONL files under `DPAY_TROCADOR_LOG_DIR` (default:
//!   the process's current directory; created on first write, so an unconfigured relay that
//!   never proxies anything creates nothing): `trocador-access.jsonl` (one line per proxied
//!   call) and `trocador-orders.jsonl` (below). Writes are fsync-free fast appends — a
//!   failed write goes to stderr and NEVER fails the request (a compliance log must not
//!   become a trade outage; this lenience is the OFFLINE mode's alone — PG mode is strict).
//!
//! # 2. Webhooks (per-trade, key-echoed, probe-tested, never retried)
//!
//! When `DPAY_PUBLIC_ORIGIN` is set, trade creation appends `webhook=<origin>/api/v1/trocador/webhook`
//! and `webhook_key=<order_id>` to the upstream `new_trade` call (the venue echoes the key back
//! as the `key` query parameter on every notification). Trocador's terms: every status change
//! POSTs the SAME transaction data the trade endpoint returns to that URL; the venue PROBES the
//! URL at trade creation, which must answer 2xx and must NOT redirect (a failed probe fails the
//! trade); and failed deliveries are NOT retried. Hence the receiver's shape: registered on
//! EVERY build, answering 200 to POST (deliveries) AND GET (the probe-shaped lenient sink) —
//! parse failures, unknown keys and probes all still 200, because a 4xx/5xx or a redirect would
//! fail the trade outright and a dropped delivery is never re-sent. A matched, well-formed
//! delivery updates the order (last_status, status_ts, the full payload VERBATIM) so the status
//! route can serve the latest known state with ZERO upstream calls. Unknown status words are
//! stored verbatim and classify as honest-unknown — see [`classify_status`].
//!
//! # 3. Upstream rate limiting (the promised organic-demand pattern)
//!
//! The upstream status read is the FALLBACK channel (webhooks are primary): at most ONE
//! upstream read per trade_id per 60 s — the promise. Within the window
//! the route answers 429 with the house `dpayRelayError` marker + `Retry-After` (the remaining
//! seconds); webhook-served responses never count against the window. The rate and
//! trade-creation routes are bounded per client IP — defaults 6/min and 4/min, overridable via
//! `DPAY_TROCADOR_RATE_PER_MIN` / `DPAY_TROCADOR_TRADE_PER_MIN`. The limits apply ONLY to
//! upstream-bound calls: 400-class device errors, the unconfigured 503, webhook-served cache
//! reads and the webhook receiver itself are exempt. Counters are in-process fixed windows (a
//! poison-tolerant `Mutex<HashMap>`, pruned when large) — no new dependencies, no shared state.
//!
//! ONE deliberate seam on the 60 s spacing (2026-09-28): the OFFLINE test world has no
//! partner budget to protect, and the e2e cefi flows were spending ~55 s per lifecycle
//! transition waiting out the 429 Retry-After. `main.rs` therefore reads
//! `DPAY_TROCADOR_STATUS_SPACING_SECS` under `#[cfg(feature = "test-helpers")]` ALONE —
//! the same reasoning as the app-side engine seam (`app/config/convert.ts` stands its
//! trocador poll floor down when `__DPAY_TEST_CONVERT_ENGINE` is present). A prod binary
//! is built without the feature, so the promise is a compile-time property there: the env
//! cannot stand it down, and the default stays exactly 60.
//!
//! # The order store
//!
//! Trade creation mints a relay-side order id (`trod-` + 16 lowercase hex from the OS CSPRNG —
//! the same source the checkout's charge ids draw from) and persists the order BEFORE the upstream
//! call (in PG mode the INSERT is acknowledged before the id is returned — the promise holds
//! under both backends); the venue's trade_id is attached when the venue answers. Records are
//! appended — JSONL lines under the orders lock, or `trocador_order_events` rows through the
//! PG writer's single ordered queue — and the in-memory index is rebuilt at startup
//! (file replay, or the PG `DISTINCT ON` last-wins read), so webhook correlation survives a
//! relay restart on either backend. The optional `clientOrderId` string the device may send
//! rides the record verbatim (trimmed, length-clamped).
//!
//! # Client-IP honesty (what "source IP" means here)
//!
//! `DPAY_TRUST_PROXY=1` says the relay sits behind a reverse proxy that sets
//! `X-Forwarded-For`: the FIRST entry is the client IP. Unset, the connecting peer address
//! (`ConnectInfo`, wired by `into_make_service_with_connect_info` in main.rs) is the client IP
//! and the header is IGNORED — spoofable from outside. When neither is visible (oneshot-driven
//! tests), the log records `-`: never a fabricated address.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::AppState;

/// The access-log file (one JSON object per line, append-only — module doc §1).
pub const ACCESS_LOG_FILE: &str = "trocador-access.jsonl";
/// The order store (one JSON object per line per state transition, append-only — module doc
/// "The order store").
pub const ORDERS_LOG_FILE: &str = "trocador-orders.jsonl";
/// The webhook receiver's own path (what `DPAY_PUBLIC_ORIGIN` builds the per-trade URL from).
pub const WEBHOOK_PATH: &str = "/api/v1/trocador/webhook";
/// The agreement's per-client rate-quote bound (`DPAY_TROCADOR_RATE_PER_MIN` default).
pub const DEFAULT_RATE_PER_MIN: u32 = 6;
/// The agreement's per-client trade-creation bound (`DPAY_TROCADOR_TRADE_PER_MIN` default).
pub const DEFAULT_TRADE_PER_MIN: u32 = 4;
/// The promised status-read spacing per trade_id: at most one UPSTREAM read per minute. The
/// DEFAULT and the prod-only value — the only code that may install a smaller window is
/// `main.rs` under `#[cfg(feature = "test-helpers")]` (the offline stub world; module doc §3).
pub const STATUS_SPACING_SECS: u64 = 60;
/// House `dpayRelayError` codes for the three 429s (same marker contract as the proxy's 503/504).
pub const RATE_LIMITED_CODE: &str = "trocador-rate-limited";
pub const TRADE_LIMITED_CODE: &str = "trocador-trade-limited";
pub const STATUS_THROTTLED_CODE: &str = "trocador-status-throttled";
/// The response header trade creation answers with (only when `DPAY_PUBLIC_ORIGIN` is set):
/// the relay-side order id the webhook key echoes.
pub const ORDER_ID_HEADER: &str = "X-Dpay-Order-Id";
/// The order-id prefix (`trod-` + 16 lowercase hex — see `fresh_order_id`).
pub const ORDER_ID_PREFIX: &str = "trod-";
/// The device's optional `clientOrderId` is informational — carried verbatim but clamped so a
/// hostile body cannot bloat the store or the log lines.
pub const MAX_CLIENT_ORDER_ID_CHARS: usize = 200;
/// Prune thresholds for the in-process maps — the relay is long-lived and both maps are keyed
/// by unbounded externals (client IPs, trade ids). Entries outside the current window / older
/// than an hour are behaviorally dead (they pass every gate), so dropping them changes nothing.
const MAP_PRUNE_LEN: usize = 8192;

/// The agreement's clock: unix seconds, injectable so the 60s spacing and the fixed windows are
/// testable offline (`with_clock`). Production reads [`crate::now_secs`] — the crate's one clock.
pub type NowFn = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Which upstream-bound surface a limit admission is for (the per-IP fixed windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitKind {
    /// `POST /api/v1/trocador/rate` — the quote surface.
    Rate,
    /// `POST /api/v1/trocador/trade` — trade creation.
    Trade,
}

impl LimitKind {
    fn window_key(self) -> &'static str {
        match self {
            LimitKind::Rate => "rate",
            LimitKind::Trade => "trade",
        }
    }
}

/// The agreement's configuration, read once at startup (main.rs from the env).
#[derive(Clone, Debug)]
pub struct AgreementConfig {
    /// `DPAY_PUBLIC_ORIGIN` — e.g. `https://dpay.kalaj.org`. When set, trade creation appends
    /// the webhook params to the upstream call and the order id rides the response header.
    /// When unset there are NO webhook params (the offline default) and no header.
    pub public_origin: Option<String>,
    /// `DPAY_TROCADOR_LOG_DIR` — the directory for both append-only files. Default: the
    /// process's current directory. Created on first write. Used ONLY when `pg_dsn` is None
    /// (the JSONL backend; the offline default).
    pub log_dir: PathBuf,
    /// `DPAY_TROCADOR_PG_DSN` — when set, BOTH stores (the access log and the order store)
    /// persist to Postgres (the backed-up store) instead of the JSONL files. Unset (the
    /// default) keeps the JSONL behavior byte-identical. Wired via [`Agreement::open`]
    /// (the async constructor — PG needs a startup connect + index rebuild);
    /// [`Agreement::new`] refuses a set DSN (a sync constructor cannot fail honestly).
    pub pg_dsn: Option<String>,
    /// `DPAY_TRUST_PROXY` — see "Client-IP honesty" in the module doc.
    pub trust_proxy: bool,
    /// `DPAY_TROCADOR_RATE_PER_MIN` — per-client per-minute rate-quote bound (default 6).
    pub rate_per_min: u32,
    /// `DPAY_TROCADOR_TRADE_PER_MIN` — per-client per-minute trade-creation bound (default 4).
    pub trade_per_min: u32,
    /// The upstream status-read spacing in seconds (module doc §3). Defaults to
    /// [`STATUS_SPACING_SECS`] — the promise. The ONLY setter of a smaller value is the
    /// offline test world: `main.rs` reads `DPAY_TROCADOR_STATUS_SPACING_SECS` under
    /// `#[cfg(feature = "test-helpers")]` alone, so a prod binary (built without the
    /// feature) cannot stand the promise down even with the env set — it is a
    /// compile-time property there, not a config default. Mirrors the app-side engine
    /// seam (`app/config/convert.ts` stands the trocador poll floor down when
    /// `__DPAY_TEST_CONVERT_ENGINE` is present): an offline stub world has no partner
    /// budget to protect.
    pub status_spacing_secs: u64,
}

impl Default for AgreementConfig {
    fn default() -> Self {
        AgreementConfig {
            public_origin: None,
            log_dir: PathBuf::from("."),
            pg_dsn: None,
            trust_proxy: false,
            rate_per_min: DEFAULT_RATE_PER_MIN,
            trade_per_min: DEFAULT_TRADE_PER_MIN,
            status_spacing_secs: STATUS_SPACING_SECS,
        }
    }
}

/// One order record — the in-memory form of a `trocador-orders.jsonl` state line (last-wins on
/// load). Field-for-field the agreement's record shape.
#[derive(Clone, Debug)]
pub struct OrderRecord {
    /// The relay-minted order id — ALSO the `webhook_key` sent at trade creation (the venue
    /// echoes it back as `key`), which is what makes webhook correlation key-lookup-simple.
    pub order_id: String,
    /// The device's own order id, when it sent one (`clientOrderId`).
    pub client_order_id: Option<String>,
    /// The venue's trade id — attached after a successful creation, or learned from a webhook.
    pub trade_id: Option<String>,
    /// Unix seconds at order creation.
    pub created_at: u64,
    /// The venue's own status word from the last matched webhook delivery (verbatim, never
    /// translated — an unknown word stays the word it is).
    pub last_status: Option<String>,
    /// Unix seconds of that delivery.
    pub status_ts: Option<u64>,
    /// The FULL venue payload of the last matched delivery, verbatim. This is what the status
    /// route serves when present — the zero-upstream webhook cache.
    pub last_webhook_payload: Option<String>,
}

/// The in-memory order index — identical under both backends: the JSONL file replay and the
/// PG last-wins rebuild produce exactly this shape, and every read the routes serve
/// (webhook cache, trade-id correlation) comes from it, never from the store.
#[derive(Default)]
pub(crate) struct OrdersInner {
    /// order_id → latest record.
    by_order: HashMap<String, OrderRecord>,
    /// trade_id → order_id (built from records with a trade_id; the status route's correlation).
    by_trade: HashMap<String, String>,
}

impl OrdersInner {
    /// Index one record: last-wins on `by_order`, and the trade-id correlation learns the id.
    pub(crate) fn insert(&mut self, record: OrderRecord) {
        if let Some(t) = &record.trade_id {
            self.by_trade.insert(t.clone(), record.order_id.clone());
        }
        self.by_order.insert(record.order_id.clone(), record);
    }
}

/// What one webhook delivery taught the store (the receiver's log/answer only cares which).
pub enum WebhookOutcome {
    /// Key matched an order and the body was a usable venue payload: the order was updated.
    Matched { order_id: String, trade_id: Option<String> },
    /// The key matched an order but the body was not a usable venue payload — logged as
    /// `webhook-unmatched` (still a 200: never signal retry-worthy, module doc §2).
    Invalid,
    /// The key matched nothing (or was absent): 200, logged as `webhook-unmatched`.
    Unmatched,
}

/// The partner-agreement state: configuration + the append-only stores + the in-process limit
/// windows + the injectable clock. Held in an `Arc` inside [`crate::trocador::TrocadorProxy`].
pub struct Agreement {
    public_origin: Option<String>,
    trust_proxy: bool,
    rate_per_min: u32,
    trade_per_min: u32,
    /// The upstream status-read spacing this instance enforces (seconds). The promise's 60
    /// unless the offline test world stood it down (see [`AgreementConfig::status_spacing_secs`]).
    status_spacing_secs: u64,
    /// The record sink — both the access log and the order store ride ONE backend choice
    /// (`DPAY_TROCADOR_PG_DSN` set ⇒ PG, else JSONL), never a mix.
    store: Store,
    orders: Mutex<OrdersInner>,
    /// Fixed-window counters: "rate|<ip>" → (window bucket start, hits in bucket).
    limiter: Mutex<HashMap<String, (u64, u32)>>,
    /// trade_id → unix secs of the last UPSTREAM status read (the 60s promise).
    spacing: Mutex<HashMap<String, u64>>,
    now: NowFn,
}

/// The compliance records' sink: one backend for BOTH the access log and the order store.
/// The JSONL arm keeps the pre-PG behavior byte-identical (fast appends, stderr-only
/// failures); the PG arm is fail-closed where the agreement demands the record exist.
enum Store {
    Jsonl { dir: PathBuf },
    Pg(crate::trocador_pg::PgStore),
}

impl Store {
    fn load_jsonl_orders(&self) -> OrdersInner {
        match self {
            Store::Jsonl { dir } => load_orders(&dir.join(ORDERS_LOG_FILE)),
            // The PG index is rebuilt during `PgStore::open` (before the store is handed
            // over); this arm is only reachable from the sync constructor, which never
            // builds a PG store.
            Store::Pg(_) => OrdersInner::default(),
        }
    }

    /// Append one order state transition. JSONL: the append IS the semantics — a failed
    /// write is a stderr note and `Ok` (the offline mode's lenience; unchanged from the
    /// pre-PG relay). PG: the insert is acknowledged BEFORE returning — `Err` means the
    /// transition did NOT durably land, and the caller applies fail-closed policy.
    fn persist_order_event(&self, record: &OrderRecord, ts: u64) -> Result<(), String> {
        match self {
            Store::Jsonl { dir } => {
                write_jsonl(dir, &dir.join(ORDERS_LOG_FILE), &order_record_line(record));
                Ok(())
            }
            Store::Pg(pg) => pg.insert_order_event(record, ts),
        }
    }

    /// Append one access-log line. JSONL: identical to the pre-PG relay (stderr on failure,
    /// always `Ok`). PG: awaited to durability — `Err` refuses the request.
    async fn log_access(
        &self,
        line: &AccessLine<'_>,
        now: u64,
    ) -> Result<(), String> {
        match self {
            Store::Jsonl { dir } => {
                write_jsonl(dir, &dir.join(ACCESS_LOG_FILE), &access_line_json(line, now));
                Ok(())
            }
            Store::Pg(pg) => {
                pg.insert_access(crate::trocador_pg::AccessRow::from_line(line, now))
                    .await
            }
        }
    }
}

impl Agreement {
    /// Build the agreement and REBUILD the order index from `trocador-orders.jsonl` (last-wins
    /// per order_id; corrupt lines skipped — append-only files must tolerate a torn tail). This
    /// is what makes webhook correlation survive a relay restart. JSONL backend ONLY — a set
    /// `pg_dsn` is refused here (the sync constructor cannot honestly fail, which PG startup
    /// must be allowed to): use [`Agreement::open`].
    pub fn new(config: AgreementConfig) -> Self {
        assert!(
            config.pg_dsn.is_none(),
            "dpay-relay: trocador agreement: DPAY_TROCADOR_PG_DSN is set — build the agreement \
             with Agreement::open (PG needs a startup connect + index rebuild), never Agreement::new"
        );
        let store = Store::Jsonl {
            dir: config.log_dir.clone(),
        };
        let orders = store.load_jsonl_orders();
        Self::assemble(config, store, orders)
    }

    /// The async constructor — the ONE that handles a set `DPAY_TROCADOR_PG_DSN`: connect,
    /// create the schema, rebuild the order index — all before the store is handed over.
    /// `Err` ⇒ the deployment is defective (a DSN that does not yield a working, initialized
    /// store): main.rs turns this into the config-style exit (fail-closed — a relay that
    /// cannot record must not take trades). No DSN ⇒ identical to [`Agreement::new`].
    pub async fn open(config: AgreementConfig) -> Result<Self, String> {
        let store = match config.pg_dsn.as_deref() {
            None => Store::Jsonl {
                dir: config.log_dir.clone(),
            },
            Some(dsn) => {
                let (pg, orders) = crate::trocador_pg::PgStore::open(dsn).await?;
                return Ok(Self::assemble(config, Store::Pg(pg), orders));
            }
        };
        let orders = store.load_jsonl_orders();
        Ok(Self::assemble(config, store, orders))
    }

    /// The common field setup — every field normalizes exactly as it always has.
    fn assemble(config: AgreementConfig, store: Store, orders: OrdersInner) -> Self {
        Agreement {
            public_origin: config
                .public_origin
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string()),
            trust_proxy: config.trust_proxy,
            rate_per_min: config.rate_per_min,
            trade_per_min: config.trade_per_min,
            status_spacing_secs: config.status_spacing_secs,
            store,
            orders: Mutex::new(orders),
            limiter: Mutex::new(HashMap::new()),
            spacing: Mutex::new(HashMap::new()),
            now: Arc::new(crate::now_secs),
        }
    }

    /// Swap the clock. Test seam ONLY (the offline tests need to walk the 60s window without
    /// sleeping); production never calls this.
    pub fn with_clock(mut self, now: NowFn) -> Self {
        self.now = now;
        self
    }

    /// The configured public origin (trailing slash trimmed), when any.
    pub fn public_origin(&self) -> Option<&str> {
        self.public_origin.as_deref()
    }

    /// The per-trade webhook URL trade creation registers upstream — set iff the public origin
    /// is configured (module doc §2).
    pub fn webhook_url(&self) -> Option<String> {
        Some(format!(
            "{}{}",
            self.public_origin.as_deref()?, WEBHOOK_PATH
        ))
    }

    /// Whether `X-Forwarded-For` may name the client IP (module doc "Client-IP honesty").
    pub fn trust_proxy(&self) -> bool {
        self.trust_proxy
    }

    /// Mint an order id, persist the order BEFORE the upstream call (the agreement's
    /// persist-first promise), and return the id. The id doubles as the `webhook_key`.
    /// JSONL mode (the tests, the offline loop) cannot fail here; PG mode uses
    /// [`Agreement::try_open_order`]'s `Err` → this panics with the full reason, the same
    /// no-fallback discipline as `fresh_order_id`: a relay that cannot durably mint an order
    /// must not return a tradeable id.
    pub fn open_order(&self, client_order_id: Option<&str>) -> String {
        self.try_open_order(client_order_id).unwrap_or_else(|e| {
            panic!("dpay-relay: trocador agreement: {e} — cannot mint a durable order id")
        })
    }

    /// The fallible form of [`Agreement::open_order`] — the trade route's entry point, so a
    /// refused PG write surfaces as a handler error (fail-closed: the trade is NOT created
    /// unrecorded), not a panic. The in-memory index mirrors the store: a refused write
    /// removes the record it would have guarded.
    pub fn try_open_order(&self, client_order_id: Option<&str>) -> Result<String, String> {
        let order_id = fresh_order_id();
        let record = OrderRecord {
            order_id: order_id.clone(),
            client_order_id: client_order_id.map(str::to_string),
            trade_id: None,
            created_at: (self.now)(),
            last_status: None,
            status_ts: None,
            last_webhook_payload: None,
        };
        let mut orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        orders.insert(record.clone());
        // The write is issued under the same lock that guards the map so concurrent state
        // transitions land in durable order (a bounded blocking ack — never held across the
        // caller's awaits; in PG mode this waits out one INSERT, sub-millisecond at the
        // agreement's own volume).
        if let Err(e) = self.store.persist_order_event(&record, record.created_at) {
            orders.by_order.remove(&order_id);
            return Err(format!(
                "the order store refused the creation write (order NOT created): {e}"
            ));
        }
        Ok(order_id)
    }

    /// Attach the venue's trade_id to an order (after a successful creation, or when a webhook
    /// teaches it) and append the state transition. Best-effort persistence in BOTH backends
    /// (a failed file append is stderr; a failed PG insert is stderr too): the upstream trade
    /// EXISTS at this point, so failing the handler could strand a device believing a trade
    /// never happened while funds are already moving — the honest posture is the loud note.
    pub fn attach_trade_id(&self, order_id: &str, trade_id: &str) {
        let mut orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        orders
            .by_trade
            .insert(trade_id.to_string(), order_id.to_string());
        let Some(record) = orders.by_order.get_mut(order_id) else {
            return;
        };
        record.trade_id = Some(trade_id.to_string());
        if let Err(e) = self.store.persist_order_event(record, (self.now)()) {
            eprintln!(
                "dpay-relay: trocador agreement: trade_id attachment NOT durably stored \
                 (order {order_id}, trade {trade_id}): {e}"
            );
        }
    }

    /// Apply one webhook delivery. `key` is the echoed `webhook_key` (= the order id). The body
    /// must be the venue's trade JSON (module doc §2); its `trade_id`/`status` update the order
    /// and the FULL payload is stored verbatim. A matched-but-unusable body is `Invalid`, an
    /// unknown key `Unmatched` — both still answer 200 at the route (never retry-worthy).
    pub fn apply_webhook(&self, key: &str, body: &str) -> WebhookOutcome {
        let parsed: Option<Value> =
            serde_json::from_str::<Value>(body).ok().filter(|v: &Value| v.is_object());
        let Some(parsed) = parsed else {
            // Unusable body: matched-key or not, there is nothing honest to store.
            let matched = self
                .orders
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .by_order
                .contains_key(key);
            return if matched {
                WebhookOutcome::Invalid
            } else {
                WebhookOutcome::Unmatched
            };
        };
        let trade_id = parsed
            .get("trade_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let status = parsed
            .get("status")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let mut orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        let Some(record) = orders.by_order.get_mut(key) else {
            return WebhookOutcome::Unmatched;
        };
        if let Some(t) = &trade_id {
            record.trade_id = Some(t.clone());
        }
        if let Some(s) = &status {
            record.last_status = Some(s.clone());
            record.status_ts = Some((self.now)());
        }
        // The FULL payload, verbatim — the status route serves this string byte-for-byte.
        record.last_webhook_payload = Some(body.to_string());
        // Own the updated state (ends the map borrow): the trade index learns the id below,
        // and the persist runs against the SAME owned snapshot the index now reflects.
        let record = record.clone();
        if let Some(t) = &trade_id {
            orders.by_trade.insert(t.clone(), key.to_string());
        }
        // Persist under the lock, but BEST-EFFORT in both backends: the receiver answers 200
        // unconditionally (module doc §2 — the venue never retries, and a 4xx/5xx would fail
        // the trade at probe time), so a refused write can only be a loud stderr note.
        if let Err(e) = self.store.persist_order_event(&record, (self.now)()) {
            eprintln!(
                "dpay-relay: trocador agreement: webhook update NOT durably stored \
                 (order {key}): {e}"
            );
        }
        WebhookOutcome::Matched {
            order_id: key.to_string(),
            trade_id,
        }
    }

    /// The latest webhook-delivered payload for a trade id, verbatim — the status route's
    /// zero-upstream cache. `None` when no matched delivery is known for the id.
    pub fn cached_payload(&self, trade_id: &str) -> Option<String> {
        let orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        let order_id = orders.by_trade.get(trade_id)?;
        orders
            .by_order
            .get(order_id)
            .and_then(|r| r.last_webhook_payload.clone())
    }

    /// The order a trade id belongs to (the access log's correlation on status lines).
    pub fn order_by_trade_id(&self, trade_id: &str) -> Option<OrderRecord> {
        let orders = self.orders.lock().unwrap_or_else(|p| p.into_inner());
        let order_id = orders.by_trade.get(trade_id)?;
        orders.by_order.get(order_id).cloned()
    }

    /// Admit one upstream-bound call under the per-client fixed window. `Ok(())` = proceed (and
    /// the call IS counted); `Err(remaining)` = the window is full — answer 429 with
    /// `Retry-After: remaining`. Exempt by their call sites: device 400s, the unconfigured 503,
    /// webhook/cache-served reads.
    pub fn admit(&self, kind: LimitKind, ip: Option<&str>) -> Result<(), u64> {
        const WINDOW: u64 = 60;
        let limit = match kind {
            LimitKind::Rate => self.rate_per_min,
            LimitKind::Trade => self.trade_per_min,
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

    /// The 60s-per-trade_id spacing gate on the UPSTREAM status read (module doc §3). Marks the
    /// window BEFORE the call — a failed upstream read still hit the venue's infra, and the
    /// promise bounds reads, not successes. `Err(remaining)` = 429 + `Retry-After`.
    /// Webhook-served responses never reach this gate (their call site returns first).
    ///
    /// The window length is `status_spacing_secs` (the promise's 60 unless the offline
    /// test world stood it down — see [`AgreementConfig::status_spacing_secs`]); 0 never
    /// throttles (`elapsed < 0` is never true).
    pub fn admit_status(&self, trade_id: &str) -> Result<(), u64> {
        let now = (self.now)();
        let mut map = self.spacing.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(&last) = map.get(trade_id) {
            let elapsed = now.saturating_sub(last);
            if elapsed < self.status_spacing_secs {
                return Err(self.status_spacing_secs - elapsed);
            }
        }
        if map.len() > MAP_PRUNE_LEN {
            // Entries older than an hour are dead weight: a trade polled that long ago passes
            // the gate whether or not the entry survives.
            map.retain(|_, ts| now.saturating_sub(*ts) < 3600);
        }
        map.insert(trade_id.to_string(), now);
        Ok(())
    }

    /// Append one access-log line (module doc §1). The timestamp comes from the agreement's
    /// clock. JSONL mode keeps the pre-PG contract: a failed write is a stderr note and this
    /// NEVER fails. PG mode is fail-closed: the insert is awaited to durability and `Err`
    /// MUST refuse the request — an unlogged proxied call is an agreement violation.
    pub async fn log(&self, line: AccessLine<'_>) -> Result<(), String> {
        let now = (self.now)();
        self.store.log_access(&line, now).await
    }
}

/// One access-log line's fields (the timestamp pair is filled by [`Agreement::log`]). Optional
/// correlation fields are omitted from the JSON when `None`; `ip`/`user_agent`/
/// `accept_language` render as `-` when not visible — never fabricated. The correlation fields
/// are owned strings (they usually outlive the request's borrows); kind/route/method are
/// always static literals at the call sites.
pub struct AccessLine<'a> {
    pub kind: &'a str,
    pub route: &'a str,
    pub method: &'a str,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub accept_language: Option<String>,
    pub client_order_id: Option<String>,
    pub order_id: Option<String>,
    pub trade_id: Option<String>,
    pub upstream_status: Option<u16>,
    pub duration_ms: Option<u64>,
    /// sha256 prefix of the webhook `key` on unmatched deliveries — correlation without
    /// echoing arbitrary (possibly hostile, possibly log-injecting) request text.
    pub key_hash: Option<String>,
}

/// `trod-` + 16 lowercase hex from the OS CSPRNG — the checkout's `fresh_id` discipline (a bearer
/// correlation token gets real randomness, not a hash of a clock), pointed at a different
/// prefix so the two id spaces can never collide.
fn fresh_order_id() -> String {
    let mut bytes = [0u8; 8];
    match getrandom::getrandom(&mut bytes) {
        Ok(()) => format!("{ORDER_ID_PREFIX}{}", hex::encode(bytes)),
        // No fallback, deliberately — same reasoning as the checkout: a relay whose CSPRNG is
        // unavailable stops here rather than minting guessable order ids.
        Err(e) => panic!(
            "dpay-relay: trocador: the OS CSPRNG is unavailable ({e}) — cannot mint an order id"
        ),
    }
}

/// One order record as a JSON line (optional fields omitted; `last_webhook_payload` embedded as
/// the verbatim payload string). Append-only: readers do last-wins. The SAME bytes the PG
/// backend stores as the `event` jsonb — one record reader for both backends.
pub(crate) fn order_record_line(record: &OrderRecord) -> String {
    let mut object = serde_json::Map::new();
    object.insert("order_id".into(), json!(record.order_id));
    if let Some(v) = &record.client_order_id {
        object.insert("client_order_id".into(), json!(v));
    }
    if let Some(v) = &record.trade_id {
        object.insert("trade_id".into(), json!(v));
    }
    object.insert("created_at".into(), json!(record.created_at));
    if let Some(v) = &record.last_status {
        object.insert("last_status".into(), json!(v));
    }
    if let Some(v) = record.status_ts {
        object.insert("status_ts".into(), json!(v));
    }
    if let Some(v) = &record.last_webhook_payload {
        object.insert("last_webhook_payload".into(), json!(v));
    }
    Value::Object(object).to_string()
}

/// One access-log line as JSON — byte-identical to the pre-PG builder (the same keys, the
/// same `-` renderings, the same omission of absent correlation fields).
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
    if let Some(v) = &line.client_order_id {
        object.insert("client_order_id".into(), json!(v));
    }
    if let Some(v) = &line.order_id {
        object.insert("order_id".into(), json!(v));
    }
    if let Some(v) = &line.trade_id {
        object.insert("trade_id".into(), json!(v));
    }
    if let Some(v) = line.upstream_status {
        object.insert("upstream_status".into(), json!(v));
    }
    if let Some(v) = line.duration_ms {
        object.insert("duration_ms".into(), json!(v));
    }
    if let Some(v) = &line.key_hash {
        object.insert("key_hash".into(), json!(v));
    }
    Value::Object(object).to_string()
}

/// Rebuild the order index from the append-only store (last-wins per order_id). A missing file
/// is the empty store; a torn/corrupt line is skipped, never fatal — the agreement's log
/// outlives any single write.
fn load_orders(path: &Path) -> OrdersInner {
    let mut inner = OrdersInner::default();
    let Ok(text) = std::fs::read_to_string(path) else {
        return inner;
    };
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(record) = parse_order_record(&value) {
            inner.insert(record);
        }
    }
    inner
}

/// One stored order line/event → a record. The shared reader for BOTH backends (the JSONL
/// replay and the PG `event` jsonb hold the same bytes). `None` = not a usable record
/// (no `order_id`) — skipped by every reader, never fatal.
pub(crate) fn parse_order_record(value: &Value) -> Option<OrderRecord> {
    let order_id = value.get("order_id").and_then(Value::as_str)?;
    Some(OrderRecord {
        order_id: order_id.to_string(),
        client_order_id: value
            .get("client_order_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        trade_id: value.get("trade_id").and_then(Value::as_str).map(str::to_string),
        created_at: value
            .get("created_at")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        last_status: value
            .get("last_status")
            .and_then(Value::as_str)
            .map(str::to_string),
        status_ts: value.get("status_ts").and_then(Value::as_u64),
        last_webhook_payload: value
            .get("last_webhook_payload")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// One append-only JSONL write. Creates the dir on first use; a failure is a stderr note and
/// NEVER a request failure (module doc §1). fsync-free by design — the agreement buys volume,
/// the deployment buys durability.
fn write_jsonl(dir: &Path, path: &Path, line: &str) {
    use std::io::Write;
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!(
            "dpay-relay: trocador agreement: cannot create log dir {}: {e}",
            dir.display()
        );
        return;
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            if let Err(e) = writeln!(file, "{line}") {
                eprintln!(
                    "dpay-relay: trocador agreement: append to {} failed: {e}",
                    path.display()
                );
            }
        }
        Err(e) => eprintln!(
            "dpay-relay: trocador agreement: cannot open {} for append: {e}",
            path.display()
        ),
    }
}

/// The connecting client's fingerprint for the access log: the resolved client IP (per
/// `DPAY_TRUST_PROXY` — module doc "Client-IP honesty"), the User-Agent and the
/// Accept-Language. Infallible, so every route works identically under both servers (prod's
/// `into_make_service_with_connect_info` and oneshot-driven tests).
pub struct ClientFingerprint {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub accept_language: Option<String>,
}

impl FromRequestParts<AppState> for ClientFingerprint {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        // Under DPAY_TRUST_PROXY the proxy's XFF names the client — its FIRST entry (the
        // de-facto standard's original client). Untrusted, the header is ignored outright
        // (spoofable from outside) and the connecting peer is the truth. `-` in the log when
        // neither is visible (oneshot tests); never fabricated.
        let ip = if state.trocador.trust_proxy() {
            xff_first(parts)
        } else {
            None
        }
        .or_else(|| {
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip().to_string())
        });
        Ok(ClientFingerprint {
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

/// The FIRST `X-Forwarded-For` entry, trimmed, when present and non-empty.
fn xff_first(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(header::HeaderName::from_static("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `POST /api/v1/trocador/webhook` — the venue's status-change deliveries (module doc §2).
/// ALWAYS 200. The body is the venue's trade JSON; `?key=` is the echoed `webhook_key`.
pub async fn webhook_receiver(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
    fp: ClientFingerprint,
    body: Bytes,
) -> Response {
    webhook_sink(&state, &params, &fp, Some(&body)).await
}

/// `GET /api/v1/trocador/webhook` — the probe-shaped lenient sink. The venue tests the URL at
/// trade creation and the probe's method is not ours to assume: a GET must 200 exactly like a
/// POST (module doc §2). It carries no body, so it can only ever be an unmatched line.
pub async fn webhook_probe(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
    fp: ClientFingerprint,
) -> Response {
    webhook_sink(&state, &params, &fp, None).await
}

/// The one sink both methods share: correlate `key` → order, update the store on a matched,
/// usable delivery, log the line, answer 200 — unconditionally (a 4xx/5xx or redirect would
/// fail the trade at creation, and failed deliveries are never retried). That contract is why
/// the PG backend's strict log rule does NOT apply here: this route has no "proceed" to
/// refuse, and answering non-200 could only ever break a trade creation probe while never
/// recovering the delivery — a refused PG write is a stderr note, nothing else.
async fn webhook_sink(
    state: &AppState,
    params: &BTreeMap<String, String>,
    fp: &ClientFingerprint,
    body: Option<&Bytes>,
) -> Response {
    let started = Instant::now();
    let agreement = state.trocador.agreement();
    let key = params.get("key").map(String::as_str).unwrap_or("");
    let mut line = AccessLine {
        kind: "webhook-unmatched",
        route: WEBHOOK_PATH,
        method: if body.is_some() { "POST" } else { "GET" },
        ip: fp.ip.clone(),
        user_agent: fp.user_agent.clone(),
        accept_language: fp.accept_language.clone(),
        client_order_id: None,
        order_id: None,
        trade_id: None,
        upstream_status: None,
        duration_ms: Some(started.elapsed().as_millis() as u64),
        key_hash: (!key.is_empty()).then(|| key_hash(key)),
    };
    if let Some(a) = agreement {
        if let Some(bytes) = body.filter(|b| !b.is_empty()) {
            match a.apply_webhook(key, std::str::from_utf8(bytes).unwrap_or("")) {
                WebhookOutcome::Matched { order_id, trade_id } => {
                    line.kind = "webhook";
                    line.key_hash = None; // a matched key IS our own order id — logged plainly
                    line.client_order_id = trade_id
                        .as_deref()
                        .and_then(|t| a.order_by_trade_id(t))
                        .and_then(|record| record.client_order_id);
                    line.order_id = Some(order_id);
                    line.trade_id = trade_id;
                }
                WebhookOutcome::Invalid | WebhookOutcome::Unmatched => {}
            }
        }
        if let Err(e) = a.log(line).await {
            eprintln!(
                "dpay-relay: trocador agreement: webhook line not durably stored: {e}"
            );
        }
    }
    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

/// sha256 prefix of a webhook key — correlation for unmatched lines without echoing arbitrary
/// request text (log-injection hygiene).
fn key_hash(key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(key.as_bytes());
    hex::encode(&digest[..8])
}

/// The venue status vocabulary classifier — the relay-side mirror of the reader the STATUS
/// ROUTE's consumers use (`app/convert/providerStatus.ts`'s PROVIDER_STATUS_MAP, the vocabulary
/// the resume engine reads the route's verbatim body with), so "terminal" means the same thing
/// on the webhook path as on the poll path. Word-for-word additive parity; an unknown word is
/// Unknown — an unmapped status is never a verdict (honest-unknown, the route's own rule).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusClass {
    AwaitingDeposit,
    Processing,
    Completed,
    Expired,
    Refunded,
    Unknown,
}

/// Classify one venue status word (trimmed, case-insensitive — the map's own normalization).
pub fn classify_status(word: &str) -> StatusClass {
    match word.trim().to_ascii_lowercase().as_str() {
        "awaiting_deposit" | "waiting_for_deposit" | "pending" | "pending_deposit" | "waiting" => {
            StatusClass::AwaitingDeposit
        }
        "deposit_received" | "deposit_confirmed" | "confirmed" | "processing" | "swapping"
        | "executing" | "multiple" => StatusClass::Processing,
        "completed" | "complete" | "done" | "settled" | "success" => StatusClass::Completed,
        "expired" | "quote_expired" | "expired_quote" | "timed_out" => StatusClass::Expired,
        "refunded" | "refund" | "reversed" => StatusClass::Refunded,
        _ => StatusClass::Unknown,
    }
}

/// Unix seconds → RFC3339 UTC (`YYYY-MM-DDTHH:MM:SSZ`), no new dependencies: Howard Hinnant's
/// civil-from-days algorithm over the epoch day count. The access log's `ts` field.
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
    fn rfc3339_formats_known_instants() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        // A leap day (2000-02-29) — the classic civil-calendar trap.
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339(4_102_444_800), "2100-01-01T00:00:00Z");
    }

    #[test]
    fn classifier_mirrors_the_route_readers_vocabulary() {
        // The words the e2e stub + the app's own map exercise (providerStatus.ts parity).
        assert_eq!(classify_status("Waiting"), StatusClass::AwaitingDeposit);
        assert_eq!(classify_status(" processing "), StatusClass::Processing);
        assert_eq!(classify_status("Completed"), StatusClass::Completed);
        assert_eq!(classify_status("settled"), StatusClass::Completed);
        assert_eq!(classify_status("expired"), StatusClass::Expired);
        assert_eq!(classify_status("refunded"), StatusClass::Refunded);
        // Honest-unknown: the venue's future words are NOT verdicts.
        assert_eq!(classify_status("Holding"), StatusClass::Unknown);
        assert_eq!(classify_status(""), StatusClass::Unknown);
    }

    #[test]
    fn order_ids_have_the_pinned_shape() {
        let id = fresh_order_id();
        assert!(id.starts_with(ORDER_ID_PREFIX), "{id}");
        let hex = id.trim_start_matches(ORDER_ID_PREFIX);
        assert_eq!(hex.len(), 16, "{id}");
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{id}");
        assert_ne!(fresh_order_id(), fresh_order_id(), "CSPRNG ids do not repeat");
    }

    #[test]
    fn webhook_url_comes_from_the_trimmed_origin_only() {
        let mut a = Agreement::new(AgreementConfig {
            public_origin: Some("https://dpay.kalaj.org/".into()),
            ..AgreementConfig::default()
        });
        assert_eq!(
            a.webhook_url().as_deref(),
            Some("https://dpay.kalaj.org/api/v1/trocador/webhook")
        );
        a.public_origin = None;
        assert!(a.webhook_url().is_none(), "no origin → no webhook params");
    }
}
