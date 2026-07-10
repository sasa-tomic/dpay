//! The relay binary — the merchant's submit-and-confirm service, and the demo's only online
//! dependency. It also serves the **merchant terminal** web page (`GET /`) so the whole merchant
//! side of the demo is one process: open the page on a laptop, scan the payer's QR, get "Paid ✓".
//!
//! Settlement seam (same `Ledger` trait either way):
//!   * **real** — with `--features agent` and `DPAY_CANISTER_ID` set, it settles on a live IC
//!     replica via ic-agent (this is what `just demo` runs against a `dfx` replica).
//!   * **in-memory** — otherwise, a `FakeLedger` pre-funded with the demo accounts, so the flow
//!     still works offline with no replica.
//!
//! Env:
//!   DPAY_RELAY_ADDR    bind address (default 0.0.0.0:8787 so a phone/laptop on the LAN can reach it)
//!   DPAY_PER_TX_CAP    per-transaction cap in minor units (default 100000 = $1000.00)
//!   DPAY_CANISTER_ID   (agent feature) canister principal to settle on — enables the real path
//!   DPAY_IC_URL        (agent feature) replica/gateway URL (default http://127.0.0.1:4943)

use std::net::SocketAddr;
use std::sync::Arc;

use dpay_relay::{app, AppState, FakeLedger, Ledger};

// The SAME deterministic demo accounts the phone app + dpay-fixture use, so a payment the phone
// signs (from PAYER) settles here. PAYER = Ed25519 pubkey of seed [1;32]; MERCHANT = seed [2;32].
const PAYER: [u8; 32] = [
    0x8a, 0x88, 0xe3, 0xdd, 0x74, 0x09, 0xf1, 0x95, 0xfd, 0x52, 0xdb, 0x2d, 0x3c, 0xba, 0x5d, 0x72,
    0xca, 0x67, 0x09, 0xbf, 0x1d, 0x94, 0x12, 0x1b, 0xf3, 0x74, 0x88, 0x01, 0xb4, 0x0f, 0x6f, 0x5c,
];
const MERCHANT: [u8; 32] = [
    0x81, 0x39, 0x77, 0x0e, 0xa8, 0x7d, 0x17, 0x5f, 0x56, 0xa3, 0x54, 0x66, 0xc3, 0x4c, 0x7e, 0xcc,
    0xcb, 0x8d, 0x8a, 0x91, 0xb4, 0xee, 0x37, 0xa2, 0x5d, 0xf6, 0x0f, 0x5b, 0x8f, 0xc9, 0xb3, 0x94,
];

#[tokio::main]
async fn main() {
    let addr: SocketAddr = std::env::var("DPAY_RELAY_ADDR")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 8787)));

    let per_tx_cap: u64 = std::env::var("DPAY_PER_TX_CAP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);

    let ledger = build_ledger(per_tx_cap).await;
    let state = AppState::new(ledger);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    let bound = listener.local_addr().unwrap_or(addr);
    println!("dpay merchant terminal + relay:  http://{bound}/   (POST /pay, GET /health)");

    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("relay server error");
}

/// Choose the settlement backend. Real IC replica when `--features agent` + `DPAY_CANISTER_ID`;
/// otherwise an in-memory ledger pre-funded with the demo accounts.
async fn build_ledger(per_tx_cap: u64) -> Arc<dyn Ledger> {
    #[cfg(feature = "agent")]
    {
        if let Ok(cid) = std::env::var("DPAY_CANISTER_ID") {
            let url =
                std::env::var("DPAY_IC_URL").unwrap_or_else(|_| "http://127.0.0.1:4943".into());
            let principal =
                candid::Principal::from_text(&cid).expect("DPAY_CANISTER_ID must be a principal");
            match dpay_relay::AgentLedger::connect(&url, principal).await {
                Ok(l) => {
                    println!("settling on the real canister {cid} via {url}");
                    return Arc::new(l);
                }
                Err(e) => eprintln!("! agent connect failed ({e:?}); falling back to in-memory"),
            }
        }
    }
    println!("settling on the in-memory demo ledger (payer pre-funded $5000.00)");
    Arc::new(FakeLedger::new(PAYER, 500_000, MERCHANT, 0, per_tx_cap))
}

/// Ctrl-C for a clean demo exit.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    println!("\ndpay-relay shutting down");
}
