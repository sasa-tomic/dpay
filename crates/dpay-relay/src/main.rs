//! The relay binary — the merchant's submit-and-confirm service, and dpay's only online
//! dependency. It also serves the marketing **landing page** (`GET /`) and the **web wallet**
//! (`GET /wallet` — the real RN-web app; `/merchant` is a 308 redirect to it), so the whole
//! merchant side of the demo is one process: open the terminal on a laptop, scan the payer's QR,
//! get "Paid ✓". The JSON API lives under `/api/v1` (e.g. `POST /api/v1/pay`,
//! `GET /api/v1/health`); an Android build, when configured via `DPAY_APK_PATH`, is served at
//! `GET /download/dpay.apk`.
//!
//! Everything the relay needs is configured through the environment, so the *same* binary (and the
//! same container image) runs the offline demo and a real deployment — only env differs.
//!
//! Settlement seam (same `Ledger` trait either way), chosen by `DPAY_LEDGER`:
//!   * `ic`     — a real canister on a real IC network via ic-agent (`--features agent`).
//!                **Never silently degrades**: if the ledger can't be reached, the relay exits
//!                rather than come up on a pretend ledger and hand out receipts for payments that
//!                did not settle.
//!   * `memory` — an in-memory `FakeLedger` pre-funded with the demo accounts. Offline, no replica.
//!
//! Env:
//!   DPAY_LEDGER             `ic` | `memory`  (default: `ic` if DPAY_CANISTER_ID is set, else `memory`)
//!   DPAY_RELAY_ADDR         bind address (default 0.0.0.0:8787 — a phone/LAN/container can reach it)
//!   DPAY_PER_TX_CAP         per-transaction cap, minor units (default 100000 = $1000.00).
//!                           `memory` ledger only — on `ic` the canister enforces its own cap.
//!   DPAY_CANISTER_ID        (ic) canister principal to settle on — required
//!   DPAY_IC_URL             (ic) replica / boundary-node URL (default http://127.0.0.1:4943)
//!   DPAY_IC_FETCH_ROOT_KEY  (ic) fetch the replica's root key. Required for a local replica
//!                           (each has its own key); MUST be false on mainnet, where it would mean
//!                           trusting whatever key the endpoint returns. Default: true only when
//!                           DPAY_IC_URL is a loopback/local address. See `AgentLedger::connect_with`.
//!   DPAY_ENABLE_FAUCET      serve `POST /api/v1/faucet`, which mints (default: true on `memory`,
//!                           false on `ic` — an exposed faucet on a real ledger is an open money printer)
//!   DPAY_APK_PATH           path to an Android build to serve at `GET /download/dpay.apk` and light
//!                           up the landing page's download button. Unset → downloads disabled.

use std::net::SocketAddr;
use std::process;
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

/// Exit code for a bad/unsafe configuration — distinct from a runtime failure (1), so an
/// orchestrator restarting the container can tell "operator error" from "ledger was down".
const EXIT_CONFIG: i32 = 2;

#[tokio::main]
async fn main() {
    let cfg = Config::from_env().unwrap_or_else(|e| {
        eprintln!("dpay-relay: bad configuration: {e}");
        process::exit(EXIT_CONFIG);
    });

    let ledger = build_ledger(&cfg).await;
    let apk = load_apk();
    let state = AppState::new(ledger.clone()).with_apk(apk);
    // IC-rail cutover (test-helpers / memory mode only): attach the fake-IC `/api/v2` gateway.
    // The app signs envelopes and POSTs them HERE instead of icp-api.io; the gateway verifies the
    // real envelope signature and moves principal-keyed balances. Prod (`agent` mode) never builds
    // this — the app talks straight to icp-api.io there.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let state = {
        let fake = dpay_relay::ic_gateway::FakeIc::from_catalog(&*ledger).await;
        println!("fake-IC /api/v2 gateway ENABLED (test-helpers) — envelopes settle in-memory at user principals");
        state.with_fake_ic(fake)
    };
    state.set_faucet_enabled(cfg.faucet);
    if cfg.faucet {
        println!(
            "! POST /api/v1/faucet is ENABLED — it mints. Never expose this on a real deployment."
        );
    }

    let listener = tokio::net::TcpListener::bind(cfg.addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("dpay-relay: bind {}: {e}", cfg.addr);
            process::exit(1);
        });
    let bound = listener.local_addr().unwrap_or(cfg.addr);
    println!(
        "dpay relay:  landing http://{bound}/  ·  wallet http://{bound}/wallet  ·  \
         API http://{bound}/api/v1  (POST /api/v1/pay, GET /api/v1/health)  ·  \
         APK http://{bound}/download/dpay.apk"
    );

    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("relay server error");
}

/// Load the Android build to serve, if `DPAY_APK_PATH` names one. A set-but-unreadable path is a
/// loud warning, not a hard stop: the relay still serves payments, just without a download link.
fn load_apk() -> Option<Vec<u8>> {
    match std::env::var("DPAY_APK_PATH") {
        Ok(path) if !path.trim().is_empty() => {
            let path = path.trim().to_string();
            match std::fs::read(&path) {
                Ok(bytes) => {
                    println!(
                        "serving APK from {path} ({} bytes) at /download/dpay.apk",
                        bytes.len()
                    );
                    Some(bytes)
                }
                Err(e) => {
                    eprintln!(
                        "dpay-relay: warn: DPAY_APK_PATH={path:?} is set but unreadable ({e}); \
                         APK downloads disabled"
                    );
                    None
                }
            }
        }
        _ => {
            println!("no DPAY_APK_PATH set — APK downloads disabled (/download/dpay.apk → 404)");
            None
        }
    }
}

// ---- configuration ----

/// Which ledger the relay settles on, and everything needed to reach it.
enum LedgerCfg {
    /// In-memory demo ledger. Offline; pre-funds the demo payer.
    Memory,
    /// A real canister on a real IC network.
    Ic {
        url: String,
        canister_id: String,
        fetch_root_key: bool,
    },
}

struct Config {
    addr: SocketAddr,
    per_tx_cap: u64,
    ledger: LedgerCfg,
    faucet: bool,
}

impl Config {
    fn from_env() -> Result<Config, String> {
        let addr: SocketAddr = match non_empty("DPAY_RELAY_ADDR") {
            Some(s) => s
                .parse()
                .map_err(|e| format!("DPAY_RELAY_ADDR={s:?} is not a socket address: {e}"))?,
            None => SocketAddr::from(([0, 0, 0, 0], 8787)),
        };

        let per_tx_cap: u64 = match non_empty("DPAY_PER_TX_CAP") {
            Some(s) => s
                .parse()
                .map_err(|e| format!("DPAY_PER_TX_CAP={s:?} is not a number: {e}"))?,
            None => 100_000,
        };

        let canister_id = non_empty("DPAY_CANISTER_ID");

        // Default to the real ledger exactly when a canister was named — so a deployment that
        // configures a canister can never come up on the in-memory one by accident.
        let kind = match non_empty("DPAY_LEDGER").as_deref() {
            Some("ic") => "ic",
            Some("memory") => "memory",
            Some(other) => return Err(format!("DPAY_LEDGER={other:?} — expected `ic` or `memory`")),
            None if canister_id.is_some() => "ic",
            None => "memory",
        };

        let ledger = if kind == "ic" {
            let canister_id = canister_id.ok_or(
                "DPAY_LEDGER=ic needs DPAY_CANISTER_ID (the canister principal to settle on)",
            )?;
            let url = non_empty("DPAY_IC_URL").unwrap_or_else(|| "http://127.0.0.1:4943".into());
            let local = is_local_url(&url);
            let fetch_root_key = match non_empty("DPAY_IC_FETCH_ROOT_KEY") {
                Some(s) => parse_bool("DPAY_IC_FETCH_ROOT_KEY", &s)?,
                // A local replica has its own random root key and cannot work without fetching it;
                // anything else is treated as untrusted by default.
                None => local,
            };
            // The money-critical guard. Fetching the root key from a network we don't own means
            // trusting whatever key it returns — the agent would then "verify" forged replies, and
            // the relay would report "Paid ✓" for payments that never settled.
            if fetch_root_key && is_mainnet_url(&url) {
                return Err(format!(
                    "refusing to start: DPAY_IC_FETCH_ROOT_KEY=true with DPAY_IC_URL={url} (mainnet). \
                     Fetching the root key there means trusting whatever key the endpoint hands back, \
                     which is exactly the check that makes a receipt trustworthy. Unset it (or set false)."
                ));
            }
            if !fetch_root_key && local {
                return Err(format!(
                    "DPAY_IC_FETCH_ROOT_KEY=false with a local replica (DPAY_IC_URL={url}): every \
                     call would fail signature verification, since a local replica has its own root \
                     key. Set it true for local replicas."
                ));
            }
            LedgerCfg::Ic {
                url,
                canister_id,
                fetch_root_key,
            }
        } else {
            LedgerCfg::Memory
        };

        // The faucet mints. Safe on the in-memory ledger, a money printer on a real one.
        let faucet = match non_empty("DPAY_ENABLE_FAUCET") {
            Some(s) => parse_bool("DPAY_ENABLE_FAUCET", &s)?,
            None => matches!(ledger, LedgerCfg::Memory),
        };

        Ok(Config {
            addr,
            per_tx_cap,
            ledger,
            faucet,
        })
    }
}

/// `std::env::var`, treating an empty/whitespace value as unset — compose passes `FOO=` for an
/// unset variable, and an empty canister id must not read as "configured".
fn non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_bool(key: &str, raw: &str) -> Result<bool, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!("{key}={other:?} — expected true or false")),
    }
}

/// Is this URL a replica we're running ourselves (loopback / the docker host)?
fn is_local_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "host.docker.internal"]
        .iter()
        .any(|h| u.contains(h))
}

/// Known public IC endpoints. Deliberately a denylist for the *guard* only: an unrecognised host
/// still defaults to "don't fetch the root key", so a boundary node on a custom domain is treated
/// as untrusted rather than assumed safe.
fn is_mainnet_url(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    ["ic0.app", "icp0.io", "icp-api.io", "internetcomputer.org"]
        .iter()
        .any(|h| u.contains(h))
}

// ---- settlement backend ----

/// Build the settlement backend. On the `ic` path a failure to connect is **fatal**: coming up on
/// the in-memory ledger instead would mean handing out receipts for payments that never happened.
async fn build_ledger(cfg: &Config) -> Arc<dyn Ledger> {
    match &cfg.ledger {
        LedgerCfg::Ic {
            url,
            canister_id,
            fetch_root_key,
        } => connect_ic(url, canister_id, *fetch_root_key).await,
        LedgerCfg::Memory => {
            println!("settling on the in-memory demo ledger (payer pre-funded $5000.00)");
            Arc::new(FakeLedger::new(PAYER, 500_000, MERCHANT, 0, cfg.per_tx_cap))
        }
    }
}

#[cfg(feature = "agent")]
async fn connect_ic(url: &str, canister_id: &str, fetch_root_key: bool) -> Arc<dyn Ledger> {
    let principal = candid::Principal::from_text(canister_id).unwrap_or_else(|e| {
        eprintln!("dpay-relay: DPAY_CANISTER_ID={canister_id:?} is not a principal: {e}");
        process::exit(EXIT_CONFIG);
    });
    match dpay_relay::AgentLedger::connect_with(url, principal, fetch_root_key).await {
        Ok(l) => {
            println!(
                "settling on canister {canister_id} via {url} (root key: {})",
                if fetch_root_key { "fetched — local replica" } else { "pinned — mainnet" }
            );
            Arc::new(l)
        }
        // Exit rather than degrade. A relay that can't reach the ledger must fail loudly; the
        // orchestrator restarts it, and no payment is ever reported settled when it wasn't.
        Err(e) => {
            eprintln!("dpay-relay: cannot reach the ledger ({canister_id} via {url}): {e}");
            process::exit(1);
        }
    }
}

#[cfg(not(feature = "agent"))]
async fn connect_ic(_url: &str, _canister_id: &str, _fetch_root_key: bool) -> Arc<dyn Ledger> {
    eprintln!(
        "dpay-relay: DPAY_LEDGER=ic, but this binary was built WITHOUT the `agent` feature, so it \
         has no way to reach a real canister. Rebuild with `--features agent` (see deploy/build.sh)."
    );
    process::exit(EXIT_CONFIG);
}

/// Ctrl-C (and SIGTERM, so `docker stop` is graceful) for a clean exit.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    println!("\ndpay-relay shutting down");
}
