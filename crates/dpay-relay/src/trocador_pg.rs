//! The Trocador partner-agreement's POSTGRES store — the backed-up sink for the compliance
//! access log and the order store (founder directive, 2026-09-22: "postgres is being backed
//! up, flat files are not"). The prod compose stack mounts NO volume, so the JSONL files die
//! on every rebuild/redeploy; with `DPAY_TROCADOR_PG_DSN` set, both records live in PG and
//! ride the deployment's PG backups. Unset DSN → the store is never constructed and the JSONL
//! behavior is byte-identical to the pre-PG relay ([`crate::trocador_agreement`] §1 and "The
//! order store").
//!
//! # Shape: ONE dedicated writer thread, ONE connection
//!
//! Every INSERT — access lines and order events alike — is funneled through a single named
//! thread (`trocador-pg`) that owns a dedicated connection on its own current-thread runtime.
//! Callers hand writes to an mpsc channel and get acks back:
//!
//! - the ACCESS log (async handlers) awaits a tokio oneshot ack — a refused write fails the
//!   request (fail-closed: an unlogged proxied call is an agreement violation);
//! - the ORDER store (the agreement's SYNC methods — `open_order`/`attach_trade_id`/
//!   `apply_webhook`, whose sync signatures are pinned by the offline test suite) blocks on a
//!   plain std channel ack. From an async handler that parks a worker thread for the
//!   duration of one INSERT — bounded by the 10s write timeout, and the volume here is the
//!   agreement's own: per-client 4 trades/min and a webhook per status change.
//!
//! The single writer is what buys the append-only ORDERING guarantee the JSONL files get
//! from write-under-lock: durable insert order == in-memory state-transition order, so the
//! last-wins index rebuild (startup `DISTINCT ON (order_id) ... ORDER BY id DESC`) replays
//! exactly the sequence the live process went through. It is also why there is DELIBERATELY
//! NO connection pool: one serialized writer makes pool fan-out dead weight, and no pool is
//! what keeps the sync methods servable without borrowing a runtime.
//!
//! # Failure semantics (fail-closed at the edges, best-effort where the venue forces it)
//!
//! - Startup: connect + schema + index rebuild happen BEFORE the store is handed over; any
//!   failure is an `Err` that main turns into the config-style exit (EXIT_CONFIG) — a relay
//!   that cannot record is a relay that must not take trades.
//! - Mid-request: a refused/timed-out write drops the connection; the next write reconnects.
//!   The access-log caller refuses the request; `attach_trade_id`/`apply_webhook` log to
//!   stderr and carry on (the upstream trade already exists, and the webhook contract
//!   forbids failing a delivery — see [`crate::trocador_agreement`] §2).
//! - Error text: PG errors go to STDERR only; responses carry fixed strings (the DSN embeds
//!   credentials and is never logged, never echoed).

use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

use tokio_postgres::NoTls;

use crate::trocador_agreement::{OrderRecord, OrdersInner};

/// Connect bound at startup and on reconnect — a hung PG must not hang the relay boot.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-write bound — a wedged PG parks writers at most this long before the ack carries the
/// failure and the caller applies its own policy (refuse / stderr-and-carry-on).
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Queued-write bound before `send` backpressures its caller. The agreement's own limits
/// (4 trades/min/client, one webhook per status change) never approach this; the slack only
/// absorbs a short PG stall without refusing writers outright.
const CHANNEL_CAP: usize = 4096;

/// The schema, created idempotently at every startup (CREATE TABLE/INDEX IF NOT EXISTS —
/// running an old image against a migrated DB and vice versa are both no-ops). APPEND-ONLY
/// by contract: the code below only ever INSERTs — no UPDATE, no DELETE — so the ≥12-month
/// retention is a property of the founder's PG backups, not of anything the relay runs.
/// Advisory-lock key gating the schema DDL below (any nonzero i64; "dpayTROC" so other
/// tools can identify it). Session-scoped: auto-released when the owning connection dies.
const SCHEMA_LOCK_KEY: i64 = 0x6470_6179_5452_4F43;

const SCHEMA: [&str; 3] = [
    // Field-for-field the JSONL access line (kind/route/method/ip/ua/accept-language +
    // upstream_status/duration_ms, the correlation ids, and both timestamp renderings).
    // ip/user_agent/accept_language are NOT NULL and carry the same `-` the JSONL line
    // records when the value is not visible — never NULL, never fabricated.
    "CREATE TABLE IF NOT EXISTS trocador_access_log (
        id              BIGSERIAL PRIMARY KEY,
        ts              TIMESTAMPTZ NOT NULL,
        ts_unix         BIGINT NOT NULL,
        kind            TEXT NOT NULL,
        route           TEXT NOT NULL,
        method          TEXT NOT NULL,
        ip              TEXT NOT NULL,
        user_agent      TEXT NOT NULL,
        accept_language TEXT NOT NULL,
        client_order_id TEXT,
        order_id        TEXT,
        trade_id        TEXT,
        upstream_status INTEGER,
        duration_ms     BIGINT,
        key_hash        TEXT
    )",
    // One row per order state transition; `event` is the EXACT JSON the JSONL store would
    // have appended (order_record_line), so both backends parse records with one reader.
    // Last-wins read semantics = the latest id per order_id.
    "CREATE TABLE IF NOT EXISTS trocador_order_events (
        id              BIGSERIAL PRIMARY KEY,
        order_id        TEXT NOT NULL,
        client_order_id TEXT,
        ts              TIMESTAMPTZ NOT NULL,
        event           JSONB NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS trocador_order_events_order_id_id_idx
        ON trocador_order_events (order_id, id)",
];

const ACCESS_INSERT: &str = "INSERT INTO trocador_access_log (
        ts, ts_unix, kind, route, method, ip, user_agent, accept_language,
        client_order_id, order_id, trade_id, upstream_status, duration_ms, key_hash
    ) VALUES (
        to_timestamp($1::double precision), $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14
    )";

const EVENT_INSERT: &str = "INSERT INTO trocador_order_events (order_id, client_order_id, ts, event)
    VALUES ($1, $2, to_timestamp($3::double precision), $4::text::jsonb)";
// ^ `event` travels as TEXT — the exact bytes the JSONL store would have appended — and the
// server casts to jsonb. ($4::jsonb alone would make the driver serialize a Rust String as
// the jsonb wire type, which tokio-postgres only implements behind `with-serde_json-1` —
// and that impl would re-serialize through serde_json::Value, losing the line's key order.)
// JSONB storage normalizes internally regardless; readers parse (never byte-compare).

/// Startup index rebuild — the same last-wins rule the JSONL replay implements, sourced from
/// PG: the highest id per order_id IS the latest state transition.
const INDEX_REBUILD: &str = "SELECT DISTINCT ON (order_id) event::text
    FROM trocador_order_events ORDER BY order_id, id DESC";

/// One access-log row's owned fields — the wire form of [`crate::trocador_agreement`]
/// `AccessLine` plus its timestamp, safe to cross the channel into the writer thread.
pub(crate) struct AccessRow {
    ts: u64,
    kind: String,
    route: String,
    method: String,
    ip: String,
    user_agent: String,
    accept_language: String,
    client_order_id: Option<String>,
    order_id: Option<String>,
    trade_id: Option<String>,
    upstream_status: Option<i32>,
    duration_ms: Option<i64>,
    key_hash: Option<String>,
}

impl AccessRow {
    /// Mirror of the JSONL line builder in [`crate::trocador_agreement`]: `ip`/`user_agent`/
    /// `accept_language` render `-` when not visible (never NULL, never fabricated); the
    /// correlation fields stay NULL when absent (omitted from the JSONL line).
    pub(crate) fn from_line(line: &crate::trocador_agreement::AccessLine<'_>, ts: u64) -> Self {
        AccessRow {
            ts,
            kind: line.kind.to_string(),
            route: line.route.to_string(),
            method: line.method.to_string(),
            ip: line.ip.clone().unwrap_or_else(|| "-".into()),
            user_agent: line.user_agent.clone().unwrap_or_else(|| "-".into()),
            accept_language: line.accept_language.clone().unwrap_or_else(|| "-".into()),
            client_order_id: line.client_order_id.clone(),
            order_id: line.order_id.clone(),
            trade_id: line.trade_id.clone(),
            upstream_status: line.upstream_status.map(i32::from),
            duration_ms: line.duration_ms.map(|d| d as i64),
            key_hash: line.key_hash.clone(),
        }
    }
}

enum Write {
    /// One access-log line — the async path awaits its ack (fail-closed).
    Access {
        row: AccessRow,
        ack: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    /// One order state transition — the sync path blocks on the std-channel ack (this is
    /// what keeps `open_order`/`attach_trade_id`/`apply_webhook` sync signatures).
    OrderEvent {
        record: OrderRecord,
        ts: u64,
        ack: SyncSender<Result<(), String>>,
    },
}

/// Clone-cheap handle to the writer thread. `Arc` only because the channel sender is not
/// `Clone`-by-value through the store enum's move sites; sharing one sender preserves the
/// single ordered queue.
#[derive(Clone)]
pub(crate) struct PgStore {
    tx: Arc<SyncSender<Write>>,
}

impl PgStore {
    /// Connect, create the schema, rebuild the order index — all on the writer thread, all
    /// BEFORE any caller can touch the store. `Err` ⇒ the relay refuses to start (main.rs
    /// turns this into the config-style exit): a DSN that does not yield a working,
    /// initialized store is a deployment defect, never a degraded mode.
    pub(crate) async fn open(dsn: &str) -> Result<(PgStore, OrdersInner), String> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Write>(CHANNEL_CAP);
        let dsn = dsn.to_string();
        std::thread::Builder::new()
            .name("trocador-pg".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runtime {
                    Ok(rt) => rt.block_on(store_thread(&dsn, rx, ready_tx)),
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!(
                            "DPAY_TROCADOR_PG_DSN: cannot start the store's writer thread: {e}"
                        )));
                    }
                }
            })
            .map_err(|e| format!("DPAY_TROCADOR_PG_DSN: cannot spawn the store thread: {e}"))?;
        let orders = ready_rx
            .await
            .map_err(|_| {
                "DPAY_TROCADOR_PG_DSN: the store thread died before the store was ready"
                    .to_string()
            })??;
        Ok((PgStore { tx: Arc::new(tx) }, orders))
    }

    /// One access-log insert, awaited to durability. `Err` ⇒ the caller refuses the request
    /// (the agreement's record must exist; JSONL mode never produces `Err`).
    pub(crate) async fn insert_access(&self, row: AccessRow) -> Result<(), String> {
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        self.send(Write::Access { row, ack: ack_tx })?;
        ack_rx
            .await
            .map_err(|_| "postgres store stopped before the write was answered".to_string())?
    }

    /// One order state transition, BLOCKED ON to durability — the sync callers'
    /// (open_order/attach_trade_id/apply_webhook) persist-under-the-lock discipline: the
    /// ack returns only after the INSERT committed, so in-memory order == durable order.
    /// Parks the calling thread for one INSERT (bounded by WRITE_TIMEOUT); the agreement's
    /// own volume makes that sub-millisecond on a healthy store.
    pub(crate) fn insert_order_event(&self, record: &OrderRecord, ts: u64) -> Result<(), String> {
        let (ack_tx, ack_rx) = std::sync::mpsc::sync_channel(1);
        self.send(Write::OrderEvent {
            record: record.clone(),
            ts,
            ack: ack_tx,
        })?;
        ack_rx
            .recv()
            .map_err(|_| "postgres store stopped before the write was answered".to_string())?
    }

    fn send(&self, cmd: Write) -> Result<(), String> {
        self.tx
            .send(cmd)
            .map_err(|_| "postgres store thread is gone".to_string())
    }
}

/// The writer thread's whole life: connect + prepare, hand the ready index back, then drain
/// the write queue forever (until every `PgStore` handle is dropped and the channel closes).
async fn store_thread(
    dsn: &str,
    rx: Receiver<Write>,
    ready: tokio::sync::oneshot::Sender<Result<OrdersInner, String>>,
) {
    // `Option` is the reconnect discipline: a failed/timed-out write takes the connection,
    // the next write reconnects (see `ensure_client`).
    let mut client = match connect_and_prepare(dsn).await {
        Ok((client, orders)) => {
            let _ = ready.send(Ok(orders));
            Some(client)
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return; // rx drops here → every pending/late send() errors → callers fail-closed
        }
    };
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Write::Access { row, ack } => {
                let _ = ack.send(write_access(&mut client, dsn, &row).await);
            }
            Write::OrderEvent { record, ts, ack } => {
                let _ = ack.send(write_event(&mut client, dsn, &record, ts).await);
            }
        }
    }
}

async fn connect_and_prepare(
    dsn: &str,
) -> Result<(tokio_postgres::Client, OrdersInner), String> {
    let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(dsn, NoTls))
        .await
        .map_err(|_| "postgres: connect timed out (10s)".to_string())?
        .map_err(|e| format!("postgres: connect failed: {e}"))?;
    // The connection future must be driven for the client's queries to complete; on THIS
    // thread's runtime, so it is polled while the write loop awaits between queue reads.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("dpay-relay: trocador agreement: postgres connection ended: {e}");
        }
    });
    // Serialize DDL across concurrent openers (parallel test runs; two relay instances
    // starting against one database): CREATE TABLE IF NOT EXISTS checks-then-creates, and
    // two sessions can race past the check together — the loser dies with "relation already
    // exists", and fail-closed startup would then refuse a perfectly good start. The whole
    // block runs under one session-level advisory lock, unlocked explicitly below on the
    // live-connection path (and by the connection dying on any earlier error path).
    client
        .execute("SELECT pg_advisory_lock($1)", &[&SCHEMA_LOCK_KEY])
        .await
        .map_err(|e| format!("postgres: schema lock failed: {e}"))?;
    let mut schema_err: Option<String> = None;
    for statement in SCHEMA {
        if let Err(e) = client.execute(statement, &[]).await {
            schema_err = Some(format!(
                "postgres: schema setup failed: {e} — the DSN's user may lack CREATE on its schema"
            ));
            break;
        }
    }
    let _ = client
        .execute("SELECT pg_advisory_unlock($1)", &[&SCHEMA_LOCK_KEY])
        .await;
    if let Some(err) = schema_err {
        return Err(err);
    }
    // Last-wins replay into the same in-memory index the JSONL replay builds — webhook
    // correlation survives a relay restart identically under both backends.
    let rows = client
        .query(INDEX_REBUILD, &[])
        .await
        .map_err(|e| format!("postgres: order index rebuild failed: {e}"))?;
    let mut orders = OrdersInner::default();
    for row in rows {
        let event: String = row.get(0);
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&event) else {
            continue; // a torn/unparsable event is skipped, never fatal — the JSONL rule
        };
        if let Some(record) = crate::trocador_agreement::parse_order_record(&value) {
            orders.insert(record);
        }
    }
    Ok((client, orders))
}

/// The shared connection discipline: ensure a live client (reconnect when a prior write
/// dropped it), run one bounded write, and on ANY failure drop the connection so the NEXT
/// write starts clean. The error never names the DSN.
async fn ensure_client<'a>(
    client: &'a mut Option<tokio_postgres::Client>,
    dsn: &str,
) -> Result<&'a tokio_postgres::Client, String> {
    if client.is_none() {
        let (fresh, connection) =
            tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(dsn, NoTls))
                .await
                .map_err(|_| "postgres: reconnect timed out (10s)".to_string())?
                .map_err(|e| format!("postgres: reconnect failed: {e}"))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("dpay-relay: trocador agreement: postgres connection ended: {e}");
            }
        });
        *client = Some(fresh);
    }
    Ok(client.as_ref().expect("ensured above"))
}

async fn write_access(
    client: &mut Option<tokio_postgres::Client>,
    dsn: &str,
    row: &AccessRow,
) -> Result<(), String> {
    let ts = row.ts as f64;
    let ts_unix = row.ts as i64;
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 14] = [
        &ts,
        &ts_unix,
        &row.kind,
        &row.route,
        &row.method,
        &row.ip,
        &row.user_agent,
        &row.accept_language,
        &row.client_order_id,
        &row.order_id,
        &row.trade_id,
        &row.upstream_status,
        &row.duration_ms,
        &row.key_hash,
    ];
    let outcome = match ensure_client(client, dsn).await {
        Ok(c) => match tokio::time::timeout(WRITE_TIMEOUT, c.execute(ACCESS_INSERT, &params)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("postgres: access-log insert refused: {e}")),
            Err(_) => Err("postgres: access-log insert timed out (10s)".to_string()),
        },
        Err(e) => Err(e),
    };
    if outcome.is_err() {
        *client = None; // a failed/timed-out write leaves the connection suspect — reconnect next op
    }
    outcome
}

async fn write_event(
    client: &mut Option<tokio_postgres::Client>,
    dsn: &str,
    record: &OrderRecord,
    ts: u64,
) -> Result<(), String> {
    let event = crate::trocador_agreement::order_record_line(record);
    let ts = ts as f64;
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 4] = [
        &record.order_id,
        &record.client_order_id,
        &ts,
        &event,
    ];
    let outcome = match ensure_client(client, dsn).await {
        Ok(c) => match tokio::time::timeout(WRITE_TIMEOUT, c.execute(EVENT_INSERT, &params)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("postgres: order event insert refused: {e}")),
            Err(_) => Err("postgres: order event insert timed out (10s)".to_string()),
        },
        Err(e) => Err(e),
    };
    if outcome.is_err() {
        *client = None;
    }
    outcome
}
