//! The relay binary — dpay's read-and-host surface, and the only online dependency the app
//! has that we run. Since the 2026-08-19 IC-rail cutover value never flows through it: the
//! app signs `/api/v2` envelopes locally and submits them straight to boundary nodes. What
//! this process serves is the marketing **landing page** (`GET /`), the **web wallet**
//! (`GET /wallet` — the real RN-web app; `/merchant` is a 308 redirect to it), the APK
//! download, and the READ-ONLY JSON API under `/api/v1` (balances, transactions, currencies,
//! deposit info, onramp metadata, `GET /api/v1/health`).
//!
//! Everything the relay needs is configured through the environment, so the *same* binary (and the
//! same container image) runs the offline demo and a real deployment — only env differs.
//!
//! Read backend (same `Ledger` trait either way), chosen by `DPAY_LEDGER`:
//!   * `ic`     — the real ICRC ledgers via ic-agent (`--features agent`). The currency catalog
//!                is COMPILED IN (catalog.rs — sole authority since 2026-08-28); the canister is
//!                only the faucet mint + deposit-info backend. **Never silently degrades**: if
//!                the IC can't be reached, the relay exits rather than come up on a pretend
//!                backend and serve zeros.
//!   * `memory` — the in-memory `FakeLedger` (balances read 0; value only exists on the rail or
//!                the test-helpers fake-IC gateway). Offline, no replica.
//!
//! Env:
//!   DPAY_LEDGER             `ic` | `memory`  (default: `ic` if DPAY_CANISTER_ID is set, else `memory`)
//!   DPAY_RELAY_ADDR         bind address (default 0.0.0.0:8787 — a phone/LAN/container can reach it)
//!   DPAY_CANISTER_ID        (ic) facade canister principal (faucet mint + deposit info) — required
//!   DPAY_IC_URL             (ic) replica / boundary-node URL (default http://127.0.0.1:4943)
//!   DPAY_IC_FETCH_ROOT_KEY  (ic) fetch the replica's root key. Required for a local replica
//!                           (each has its own key); MUST be false on mainnet, where it would mean
//!                           trusting whatever key the endpoint returns. Default: true only when
//!                           DPAY_IC_URL is a loopback/local address. See `AgentLedger::connect_with`.
//!   DPAY_ENABLE_FAUCET      (test-helpers build only) serve `POST /api/v1/faucet`, which mints
//!                           demo funds on the fake-IC gateway (default: true on `memory`)
//!   DPAY_ENABLE_TILL        register the OpenCryptoPay till's seven routes (`POST /api/v1/till`,
//!                           `POST /api/v1/till/void`, `GET /api/v1/till/{id}`,
//!                           `GET /v1/lnurlp/{id}|/cb/{id}|/tx/{id}`, `GET /pl/`). Default FALSE,
//!                           on every build and every ledger — the gate, and what a merchant must
//!                           sign to reach the two POSTs: `app.rs` and `till.rs`.
//!   DPAY_CONTROLLER_SEED    (ic, agent build) hex-encoded 32-byte Ed25519 seed of the facade
//!                           canister's CONTROLLER key. When set, the relay's agent signs its
//!                           calls with this identity and `POST /api/v1/faucet` is served: the
//!                           relay enforces the cooldown locally and drives the canister's
//!                           admin-gated `mint`, crediting the USER principal (the 2026-08-20
//!                           founder-approved faucet design). When unset the agent stays
//!                           ANONYMOUS — read-only routes are unaffected, but the faucet's mint
//!                           is refused by the canister's `require_admin` (the route answers
//!                           422 "unauthorized: admin ops require the controller principal").
//!                           The seed must be the SAME key material that deployed the canister
//!                           (`DPAY_DFX_IDENTITY`'s identity.pem): export it with
//!                           `openssl ec -in identity.pem -text -noout` (the `priv:` half) or
//!                           `icp-cli identity export-seed` if available; hex, 64 chars. Treat
//!                           it as a secret (same sensitivity as the PEM itself).
//!   DPAY_APK_PATH           path to an Android build to serve at `GET /download/dpay.apk` and light
//!                           up the landing page's download button. Unset → downloads disabled.

use std::net::SocketAddr;
use std::process;
use std::sync::Arc;

use dpay_relay::{app, AppState, FakeLedger, Ledger};

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
    let state = AppState::new(ledger.clone()).with_apk(apk).with_till(cfg.till);
    // IC-rail cutover (test-helpers / memory mode only): attach the fake-IC `/api/v2` gateway.
    // The app signs envelopes and POSTs them HERE instead of icp-api.io; the gateway verifies the
    // real envelope signature and moves principal-keyed balances. Prod (`agent` mode) never builds
    // this — the app talks straight to icp-api.io there.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    let state = {
        let fake = dpay_relay::ic_gateway::FakeIc::from_catalog();
        println!("fake-IC /api/v2 gateway ENABLED (test-helpers) — envelopes settle in-memory at user principals");
        state.with_fake_ic(fake)
    };
    state.set_faucet_enabled(cfg.faucet);
    if cfg.faucet {
        // The faucet only exists in the test-helpers build (it credits the fake-IC gateway).
        #[cfg(feature = "test-helpers")]
        println!(
            "! POST /api/v1/faucet is ENABLED — it credits the fake-IC gateway (test-helpers only)."
        );
        #[cfg(not(feature = "test-helpers"))]
        eprintln!("dpay-relay: warn: DPAY_ENABLE_FAUCET is set, but the faucet route only exists in the test-helpers build.");
    }
    // The till's state belongs in the log the founder reads (`docker logs`), because which
    // surfaces an image serves is an operator's decision and one that came up wrong should be
    // visible without a probe.
    if cfg.till {
        println!(
            "OpenCryptoPay till ENABLED (DPAY_ENABLE_TILL) — /api/v1/till, /api/v1/till/void and \
             /v1/lnurlp/* are served. Ringing up and cancelling both require the merchant's own \
             signature over the request (dpay_core::TillOpen); the payer routes are public reads."
        );
    } else {
        println!(
            "OpenCryptoPay till OFF — /api/v1/till and /v1/lnurlp/* are not registered (404). \
             Set DPAY_ENABLE_TILL=true to serve them."
        );
    }

    let listener = tokio::net::TcpListener::bind(cfg.addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("dpay-relay: bind {}: {e}", cfg.addr);
            process::exit(1);
        });
    let bound = listener.local_addr().unwrap_or(cfg.addr);
    // Honest banner: only the surfaces this build actually serves. The /api/v2 gateway line is
    // printed by the test-helpers block above when it is attached; prod has no /api/v2 at all
    // (the app talks to icp-api.io directly).
    println!(
        "dpay relay:  landing http://{bound}/  ·  wallet http://{bound}/wallet  ·  \
         read API http://{bound}/api/v1  (GET /api/v1/health)  ·  \
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

/// Which settlement backend to build: the in-memory demo ledger or a real IC replica.
enum LedgerCfg {
    Ic {
        url: String,
        canister_id: String,
        fetch_root_key: bool,
    },
    Memory,
}

struct Config {
    addr: SocketAddr,
    ledger: LedgerCfg,
    faucet: bool,
    till: bool,
}

impl Config {
    fn from_env() -> Result<Config, String> {
        let addr: SocketAddr = match non_empty("DPAY_RELAY_ADDR") {
            Some(s) => s
                .parse()
                .map_err(|e| format!("DPAY_RELAY_ADDR={s:?} is not a socket address: {e}"))?,
            None => SocketAddr::from(([0, 0, 0, 0], 8787)),
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

        // The till is served only when asked for, on every ledger and every build: which surfaces an
        // image exposes is the operator's call, and one it never made is one it did not ask for. A
        // malformed value is a config error, not a silent "off": an operator who meant to turn it on
        // must hear about it.
        let till = match non_empty("DPAY_ENABLE_TILL") {
            Some(s) => parse_bool("DPAY_ENABLE_TILL", &s)?,
            None => false,
        };

        Ok(Config {
            addr,
            ledger,
            faucet,
            till,
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

// ---- read backend ----

/// Build the read backend. On the `ic` path a failure to connect is **fatal**: coming up on
/// the in-memory catalog instead would silently serve a demo catalog and zero balances as if
/// they were real.
async fn build_ledger(cfg: &Config) -> Arc<dyn Ledger> {
    match &cfg.ledger {
        LedgerCfg::Ic {
            url,
            canister_id,
            fetch_root_key,
        } => connect_ic(url, canister_id, *fetch_root_key).await,
        LedgerCfg::Memory => {
            println!("read surface on the in-memory demo catalog (balances are always 0 — value lives on the IC rail)");
            Arc::new(FakeLedger::new())
        }
    }
}

#[cfg(feature = "agent")]
async fn connect_ic(url: &str, canister_id: &str, fetch_root_key: bool) -> Arc<dyn Ledger> {
    let principal = candid::Principal::from_text(canister_id).unwrap_or_else(|e| {
        eprintln!("dpay-relay: DPAY_CANISTER_ID={canister_id:?} is not a principal: {e}");
        process::exit(EXIT_CONFIG);
    });
    // Optional authenticated identity (the production faucet's controller key, hex Ed25519
    // seed). Unset → anonymous agent (read-only); set-but-malformed is a CONFIG error, not a
    // silent anonymous downgrade — an operator who deployed the faucet must not quietly lose it.
    let seed = parse_controller_seed();
    let connected = match seed {
        Some(seed) => {
            dpay_relay::AgentLedger::connect_with_identity(url, principal, fetch_root_key, seed)
                .await
        }
        None => dpay_relay::AgentLedger::connect_with(url, principal, fetch_root_key).await,
    };
    match connected {
        Ok(l) => {
            println!(
                "reading facade {canister_id} via {url} (root key: {}, identity: {})",
                if fetch_root_key { "fetched — local replica" } else { "pinned — mainnet" },
                if seed.is_some() {
                    "controller — faucet ENABLED (authenticated mint)"
                } else {
                    "anonymous — read-only (faucet mint will be refused by the canister)"
                }
            );
            Arc::new(l)
        }
        // Exit rather than degrade. A relay that can't reach the catalog/ledgers must fail loudly;
        // the orchestrator restarts it, and no stale demo data is ever served as real.
        Err(e) => {
            eprintln!("dpay-relay: cannot reach the IC ({canister_id} via {url}): {e}");
            process::exit(1);
        }
    }
}

/// Parse `DPAY_CONTROLLER_SEED` (hex Ed25519 seed) into the 32 bytes `BasicIdentity::from_raw_key`
/// consumes. Accepts an optional `0x` prefix and surrounding whitespace; any other shape is a
/// config error.
#[cfg(feature = "agent")]
fn parse_controller_seed() -> Option<[u8; 32]> {
    let raw = non_empty("DPAY_CONTROLLER_SEED")?;
    let hex = raw.strip_prefix("0x").unwrap_or(&raw);
    let mut seed = [0u8; 32];
    match hex::decode(hex.trim()) {
        Ok(bytes) if bytes.len() == 32 => {
            seed.copy_from_slice(&bytes);
            Some(seed)
        }
        Ok(len) => {
            eprintln!(
                "dpay-relay: DPAY_CONTROLLER_SEED must be 64 hex chars (32 bytes), got {len:?} bytes — \
                 treating it as UNSET (anonymous, faucet mint refused). Fix it to enable the faucet."
            );
            None
        }
        Err(e) => {
            eprintln!(
                "dpay-relay: DPAY_CONTROLLER_SEED is not valid hex ({e}) — treating it as UNSET \
                 (anonymous, faucet mint refused). Fix it to enable the faucet."
            );
            None
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
