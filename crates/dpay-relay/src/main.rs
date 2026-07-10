//! Minimal relay binary for manual / demo use. Serves the same `app` the tests drive, backed by a
//! [`FakeLedger`] pre-funded with two demo accounts. Tests never run this — they hit the `Router`
//! in-process, so this is the *only* place a socket is bound.
//!
//! Not the shipping entry point (that would swap in a real ICP-agent ledger); it exists so the
//! flow can be poked with `curl` during the demo.
//!
//! Env:
//!   DPAY_RELAY_ADDR   bind address (default 127.0.0.1:8787)
//!   DPAY_PER_TX_CAP   per-transaction cap in minor units (default 100000 = $1000.00)

use std::net::SocketAddr;
use std::sync::Arc;

use dpay_relay::{app, AppState, FakeLedger};

// Deterministic demo accounts. In the real flow these come from the two phones' on-device keys;
// here we just need two distinct 32-byte pubkeys with opening balances so `/pay` has something to
// move. (These are placeholder pubkeys — a real payer key would replace `account_a`.)
const DEMO_A: [u8; 32] = [0xA1; 32];
const DEMO_B: [u8; 32] = [0xB2; 32];

#[tokio::main]
async fn main() {
    let addr: SocketAddr = std::env::var("DPAY_RELAY_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8787)));

    let per_tx_cap: u64 = std::env::var("DPAY_PER_TX_CAP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);

    let ledger = FakeLedger::new(DEMO_A, 500_000, DEMO_B, 0, per_tx_cap);
    let state = AppState::new(Arc::new(ledger));

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    let bound = listener.local_addr().unwrap_or(addr);
    println!("dpay-relay listening on http://{bound}  (POST /pay, GET /health)");

    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("relay server error");
}

/// Ctrl-C for a clean demo exit.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("\ndpay-relay shutting down");
}
