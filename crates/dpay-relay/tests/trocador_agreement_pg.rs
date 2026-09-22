//! The Trocador agreement's POSTGRES backend — GATED integration tests. They run ONLY when
//! `DPAY_TEST_PG_DSN` names a reachable postgres; unset (the offline dev loop — this machine
//! has NO running PG server) each test prints its skip reason and exits clean, so
//! `cargo test -p dpay-relay` stays green offline. With the variable set they exercise the
//! three properties the dual store promises: idempotent schema creation, access-log
//! insert + read-back, and order-event append + last-wins index rebuild across a restart.
//!
//! Isolation: the suite may share one database across runs and parallel tests, so every
//! correlation id this file mints is unique per run (`trod-pgtest-<pid>-<nanos>`); readers
//! always filter on those markers and never assume an empty table.
//!
//! These tests read rows back through their OWN connection — the store's writer thread stays
//! the write path under test.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use dpay_relay::trocador_agreement::{
    AccessLine, Agreement, AgreementConfig, WebhookOutcome,
};
use tokio_postgres::NoTls;

/// The gated DSN. `None` ⇒ print the reason, exit clean (a SKIP, never a failure).
fn pg_dsn() -> Option<String> {
    std::env::var("DPAY_TEST_PG_DSN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The unified skip: print the reason and return — the test binary stays green offline
/// (a `process::exit` here would kill the WHOLE harness, not just this test).
fn skip_reason() {
    println!(
        "skipping: DPAY_TEST_PG_DSN is unset — the postgres-gated trocador agreement \
         tests need a reachable PG (the offline dev loop has none by design)"
    );
}

/// Run-unique correlation id — safe against a shared database and parallel tests.
fn unique_id(tag: &str) -> String {
    static SEQ: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    format!(
        "trod-pgtest-{tag}-{}-{}-{}",
        std::process::id(),
        nanos,
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

fn pg_config(dsn: &str) -> AgreementConfig {
    AgreementConfig {
        pg_dsn: Some(dsn.to_string()),
        ..AgreementConfig::default()
    }
}

/// The store under test: `Agreement::open` IS the PG path (connect + schema + index rebuild
/// before the store is handed over).
async fn open_pg(dsn: &str) -> Agreement {
    Agreement::open(pg_config(dsn))
        .await
        .expect("PG agreement opens (connect + schema + rebuild all succeed)")
}

async fn direct_client(dsn: &str) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(dsn, NoTls)
        .await
        .expect("test connects directly to PG");
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

/// Schema creation is idempotent — TWO opens over the same database both succeed (the second
/// exercises every CREATE ... IF NOT EXISTS against existing objects) — and all three
/// objects actually exist.
#[tokio::test]
async fn pg_schema_is_created_idempotently() {
    let Some(dsn) = pg_dsn() else {
        skip_reason();
        return;
    };
    let _a = open_pg(&dsn).await;
    let _b = open_pg(&dsn).await;

    let client = direct_client(&dsn).await;
    for name in [
        "trocador_access_log",
        "trocador_order_events",
        "trocador_order_events_order_id_id_idx",
    ] {
        let row = client
            .query_one("SELECT to_regclass($1)::text IS NOT NULL", &[&name])
            .await
            .expect("to_regclass query");
        let exists: bool = row.get(0);
        assert!(exists, "{name} must exist after two idempotent opens");
    }
}

/// The access log: one `Agreement::log` per line shape, read back field-for-field through an
/// independent connection. The `-` renderings and the NULL correlation columns mirror the
/// JSONL line semantics exactly (never fabricated, absent = absent).
#[tokio::test]
async fn pg_access_log_inserts_and_reads_back() {
    let Some(dsn) = pg_dsn() else {
        skip_reason();
        return;
    };
    let a = open_pg(&dsn).await;
    let marker = unique_id("access");

    // The minimal shape: no visible client fingerprint, one correlation id.
    a.log(AccessLine {
        kind: "rate",
        route: "/api/v1/trocador/rate",
        method: "POST",
        ip: None,
        user_agent: None,
        accept_language: None,
        client_order_id: Some(marker.clone()),
        order_id: Some(unique_id("order")),
        trade_id: None,
        upstream_status: Some(200),
        duration_ms: Some(12),
        key_hash: None,
    })
    .await
    .expect("the PG access-log insert is acknowledged");

    // The webhook-unmatched shape: key_hash carries the correlation, everything else absent.
    a.log(AccessLine {
        kind: "webhook-unmatched",
        route: "/api/v1/trocador/webhook",
        method: "GET",
        ip: Some("203.0.113.9".into()),
        user_agent: Some("dpay-pgtest/1".into()),
        accept_language: Some("en-US".into()),
        client_order_id: None,
        order_id: None,
        trade_id: None,
        upstream_status: None,
        duration_ms: None,
        key_hash: Some("abcdef0123456789".into()),
    })
    .await
    .expect("the second insert is acknowledged");

    let client = direct_client(&dsn).await;
    let rows = client
        .query(
            "SELECT ts_unix, extract(epoch from ts)::bigint, kind, route, method, ip, \
             user_agent, accept_language, client_order_id, order_id, trade_id, \
             upstream_status, duration_ms, key_hash \
             FROM trocador_access_log WHERE client_order_id = $1 ORDER BY id",
            &[&marker],
        )
        .await
        .expect("read back");
    assert_eq!(rows.len(), 1, "exactly the one marker line");
    let row = &rows[0];
    let ts_unix: i64 = row.get(0);
    let ts_epoch: i64 = row.get(1);
    assert_eq!(ts_unix, ts_epoch, "ts renders the same instant as ts_unix");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    assert!(
        (now - ts_unix).abs() < 300,
        "ts_unix is the agreement's real clock: {ts_unix}"
    );
    assert_eq!(row.get::<_, String>(2), "rate");
    assert_eq!(row.get::<_, String>(3), "/api/v1/trocador/rate");
    assert_eq!(row.get::<_, String>(4), "POST");
    assert_eq!(row.get::<_, String>(5), "-", "no visible IP → `-`, never NULL");
    assert_eq!(row.get::<_, String>(6), "-");
    assert_eq!(row.get::<_, String>(7), "-");
    assert!(
        row.get::<_, Option<String>>(10).is_none(),
        "absent trade_id stays NULL (omitted from the JSONL line too)"
    );
    assert_eq!(row.get::<_, Option<i32>>(11), Some(200));
    assert_eq!(row.get::<_, Option<i64>>(12), Some(12));
    assert!(row.get::<_, Option<String>>(13).is_none());

    let rows = client
        .query(
            "SELECT ip, user_agent, accept_language, client_order_id, order_id, trade_id, \
             upstream_status, duration_ms, key_hash \
             FROM trocador_access_log WHERE key_hash = $1",
            &[&"abcdef0123456789"],
        )
        .await
        .expect("read back the unmatched line");
    assert_eq!(rows.len(), 1, "the webhook-unmatched line is there");
    let row = &rows[0];
    assert_eq!(row.get::<_, String>(0), "203.0.113.9");
    assert_eq!(row.get::<_, String>(1), "dpay-pgtest/1");
    assert_eq!(row.get::<_, String>(2), "en-US");
    assert!(row.get::<_, Option<String>>(3).is_none());
    assert!(row.get::<_, Option<String>>(4).is_none());
    assert!(row.get::<_, Option<String>>(5).is_none());
    assert!(row.get::<_, Option<i32>>(6).is_none());
    assert!(row.get::<_, Option<i64>>(7).is_none());
    assert_eq!(row.get::<_, Option<String>>(8).as_deref(), Some("abcdef0123456789"));
}

/// The order store: creation → trade_id attachment → two webhook state transitions, every
/// append acknowledged (the persist-first/blocking-ack discipline), then a RESTART — a fresh
/// `Agreement::open` on the same DSN — whose index is rebuilt last-wins from PG alone.
#[tokio::test]
async fn pg_order_events_last_wins_rebuild_across_restart() {
    let Some(dsn) = pg_dsn() else {
        skip_reason();
        return;
    };
    let a = open_pg(&dsn).await;
    let marker = unique_id("client");
    let trade_id = unique_id("trade");

    let order_id = a.open_order(Some(&marker));
    assert!(order_id.starts_with("trod-"), "the relay-minted id: {order_id}");
    a.attach_trade_id(&order_id, &trade_id);

    let payload_v1 = format!(
        r#"{{"trade_id":"{trade_id}","status":"waiting","validator":"pg-test-v1"}}"#
    );
    assert!(matches!(
        a.apply_webhook(&order_id, &payload_v1),
        WebhookOutcome::Matched { .. }
    ));
    // In-memory, the first delivery is already the cache.
    assert_eq!(a.cached_payload(&trade_id).as_deref(), Some(payload_v1.as_str()));

    let payload_v2 = format!(
        r#"{{"trade_id":"{trade_id}","status":"completed","validator":"pg-test-v2"}}"#
    );
    assert!(matches!(
        a.apply_webhook(&order_id, &payload_v2),
        WebhookOutcome::Matched { .. }
    ));

    // Every transition durably landed BEFORE the drop (blocking acks): creation + attach +
    // two webhooks = four event rows for this order.
    let client = direct_client(&dsn).await;
    let rows = client
        .query(
            "SELECT count(*) FROM trocador_order_events WHERE order_id = $1",
            &[&order_id],
        )
        .await
        .expect("count");
    let count: i64 = rows[0].get(0);
    assert_eq!(count, 4, "creation + attach + 2 webhooks: {order_id}");

    // ---- the restart: the old agreement (and its writer thread) is gone; a fresh open
    // rebuilds the index from PG alone and must land on the LATEST event per order.
    drop(a);
    drop(client);
    let b = open_pg(&dsn).await;

    let record = b
        .order_by_trade_id(&trade_id)
        .expect("the rebuilt index correlates trade_id → order");
    assert_eq!(record.order_id, order_id);
    assert_eq!(record.client_order_id.as_deref(), Some(marker.as_str()));
    assert_eq!(record.trade_id.as_deref(), Some(trade_id.as_str()));
    assert_eq!(
        record.last_status.as_deref(),
        Some("completed"),
        "last-wins: the SECOND webhook wins"
    );
    assert_eq!(
        record.last_webhook_payload.as_deref(),
        Some(payload_v2.as_str()),
        "the rebuilt cache serves the latest payload verbatim"
    );
    assert_eq!(
        b.cached_payload(&trade_id).as_deref(),
        Some(payload_v2.as_str())
    );

    // The rebuilt index is live: a new webhook on the NEW agreement appends and is served.
    let payload_v3 = format!(
        r#"{{"trade_id":"{trade_id}","status":"refunded","validator":"pg-test-v3"}}"#
    );
    assert!(matches!(
        b.apply_webhook(&order_id, &payload_v3),
        WebhookOutcome::Matched { .. }
    ));
    assert_eq!(b.cached_payload(&trade_id).as_deref(), Some(payload_v3.as_str()));
}
