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
//!   DPAY_ENABLE_FAUCET      (offline fixture build only — `test-helpers` without `agent`) serve
//!                           `POST /api/v1/faucet`, which credits demo funds on the fake-IC
//!                           gateway (default: true on `memory`). The AGENT build compiles a
//!                           different faucet, which mints through the facade canister: its gate
//!                           is DPAY_CONTROLLER_SEED below, and this flag is not consulted there.
//!                           Whichever build, the resolved answer is what
//!                           `GET /api/v1/capabilities` reports as `demo_faucet`.
//!   DPAY_ENABLE_CHECKOUT        register the OpenCryptoPay checkout's eight routes (`POST /api/v1/checkout`,
//!                           `POST /api/v1/checkout/void`, `GET /api/v1/checkout/{id}`,
//!                           `GET /v1/lnurlp/{id}|/cb/{id}|/tx/{id}`, `GET /pl/`, `GET /checkout/{id}`
//!                           — the cashier's watch page). Default TRUE on every build and every
//!                           ledger (founder decision 2026-09-10); `false` is the operator's
//!                           opt-out. The gate, and what a merchant must sign to reach the two
//!                           POSTs: `app.rs` and `checkout.rs`.
//!   DPAY_CONTROLLER_SEED    (ic, agent build) hex-encoded 32-byte Ed25519 seed of the facade
//!                           canister's CONTROLLER key. When set, the relay's agent signs its
//!                           calls with this identity and `POST /api/v1/faucet` is served: the
//!                           relay enforces the cooldown locally and drives the canister's
//!                           admin-gated `mint`, crediting the USER principal (the 2026-08-20
//!                           founder-approved faucet design). When unset the agent stays
//!                           ANONYMOUS — read-only routes are unaffected, but the faucet is
//!                           UNAVAILABLE: `/api/v1/capabilities` reports `demo_faucet:false` and
//!                           the route answers 503 naming this variable (an anonymous mint is
//!                           refused by the canister's `require_admin` anyway).
//!                           The seed must be the SAME key material that deployed the canister
//!                           (`DPAY_DFX_IDENTITY`'s identity.pem): export it with
//!                           `openssl ec -in identity.pem -text -noout` (the `priv:` half) or
//!                           `icp-cli identity export-seed` if available; hex, 64 chars. Treat
//!                           it as a secret (same sensitivity as the PEM itself).
//!   DPAY_APK_PATH           path to an Android build to serve at `GET /download/dpay.apk` and light
//!                           up the landing page's download button. Unset → downloads disabled.
//!   DPAY_SOLANA_RPC_URL     the Solana JSON-RPC provider endpoint proxied at POST
//!                           /api/v1/solana/rpc (spec 2026-09-09, Direction 1) — the FULL URL
//!                           including its api key (e.g. `https://…-rpc.com/?api-key=…`).
//!                           SECRET deploy config: never logged, never echoed in a response,
//!                           never committed. Unset is legal — the route still registers and
//!                           answers 503 naming this variable; only a SET-but-malformed URL
//!                           refuses startup (EXIT_CONFIG).
//!   DPAY_SOLANA_TIMEOUT_MS  per-call upstream timeout for the solana proxy in milliseconds
//!                           (default 10000). `0` or non-numeric → startup refuses (EXIT_CONFIG).
//!   DPAY_SIDESHIFT_SECRET   the SideShift partner ACCOUNT SECRET for the partner-key proxy
//!                           (founder decision 3, 2026-09-14 — POST /api/v1/sideshift/*; see
//!                           src/sideshift.rs and the feasibility spec's Partner-key
//!                           infrastructure section). Attached server-side as the
//!                           `x-sideshift-secret` header; the device never sees it. SECRET
//!                           deploy config: never logged, never echoed, never committed.
//!                           Unset is LEGAL — the routes still register and answer 503
//!                           naming this variable (the venue is simply absent until the
//!                           founder signs up at sideshift.ai; docs/OPS.md §3).
//!   DPAY_SIDESHIFT_AFFILIATE_ID
//!                           the SideShift partner ACCOUNT ID (the same account's public
//!                           half — SideShift's own docs call it the affiliateId). Attached
//!                           server-side with the secret; unset behaves exactly like the
//!                           secret being unset (503 naming the variable(s) missing).
//!   DPAY_SIDESHIFT_API_BASE the SideShift API base the proxy posts to (default
//!                           `https://sideshift.ai/api/v2` — verified live 2026-09-15; the
//!                           old api.sideshift.ai host is NXDOMAIN). The offline loop points
//!                           it at the relay's own test stub. A set-but-malformed URL
//!                           refuses startup (EXIT_CONFIG).
//!   DPAY_JUPITER_API_BASE   the Jupiter API base the quote/swap proxy calls (default
//!                           `https://lite-api.jup.ag` — the venue's keyless lite host; see
//!                           src/jupiter.rs, 2026-09-16 founder ask). The venue has NO
//!                           credential, so this is not a secret and there is no unconfigured
//!                           state — the routes serve on every build. The offline loop points
//!                           it at the relay's own test stub. A set-but-malformed URL
//!                           refuses startup (EXIT_CONFIG).
//!   DPAY_TROCADOR_API_KEY   the Trocador partner API key for the aggregator proxy
//!                           (registered 2026-09-20 — POST+GET /api/v1/trocador/*; see
//!                           src/trocador.rs; tracked credential: `secrets/trocador.sops.json`
//!                           — decrypt into the env, never a plaintext .env). Attached
//!                           server-side as the `API-Key`
//!                           header (the venue's own auth header — every method is
//!                           key-gated, including the status read); the device never sees
//!                           it. SECRET deploy config: never logged, never echoed, never
//!                           committed. Unset is LEGAL — the routes still register and
//!                           answer 503 naming this variable (the key does not exist yet:
//!                           requested from commercial@trocador.app; docs/OPS.md §3).
//!   DPAY_TROCADOR_API_BASE  the Trocador API base the proxy calls (default
//!                           `https://api.trocador.app` — verified live 2026-09-20
//!                           answering the venue's own key gate; the docs also name the
//!                           equivalent `https://trocador.app/api/` prefix host). The
//!                           offline loop points it at the relay's own test stub. A
//!                           set-but-malformed URL refuses startup (EXIT_CONFIG).
//!   DPAY_PUBLIC_ORIGIN      the public https origin THIS relay is served at (e.g.
//!                           `https://dpay.kalaj.org`). When set, Trocador trade creation
//!                           appends `webhook=<ORIGIN>/api/v1/trocador/webhook` and
//!                           `webhook_key=<order_id>` to the upstream new_trade call (the
//!                           partner agreement's per-trade webhooks — every status change
//!                           POSTs the trade body back to us, and the venue PROBES the URL
//!                           at creation, so the route must be publicly reachable) and the
//!                           trade answer rides an `X-Dpay-Order-Id` response header. When
//!                           unset there are NO webhook params and no header — the
//!                           dev/offline behavior stays byte-identical. A set-but-malformed
//!                           origin refuses startup (EXIT_CONFIG).
//!   DPAY_TROCADOR_LOG_DIR   the directory for the partner-agreement's append-only files
//!                           `trocador-access.jsonl` (the compliance access log — one JSON
//!                           line per relay→Trocador proxied call + every webhook delivery;
//!                           ≥12-month retention is a deployment property, nothing the relay
//!                           runs ever deletes) and `trocador-orders.jsonl` (the order store
//!                           the webhook correlation rebuilds its index from at startup).
//!                           Default: the process's current directory. Created on first
//!                           write, so an unconfigured relay that never proxies anything
//!                           creates nothing.
//!   DPAY_TRUST_PROXY        `=1` (or true) when the relay sits behind a reverse proxy that
//!                           sets X-Forwarded-For: the FIRST XFF entry is taken as the
//!                           client IP (for the trocador compliance access log and its
//!                           per-client limits). Unset (default): the connecting peer
//!                           address is the client IP and the header is IGNORED — spoofable
//!                           from outside. (The server already wires ConnectInfo via
//!                           into_make_service_with_connect_info.)
//!   DPAY_TROCADOR_PG_DSN    the postgres connection string for the partner-agreement's
//!                           compliance records (e.g. postgres://user:pass@host/db; the
//!                           tracked credential lives in secrets/trocador-pg.sops.json —
//!                           decrypt into the env, never into a plaintext .env). SET →
//!                           BOTH stores — the access log and the order store — live in PG
//!                           (tables `trocador_access_log` + `trocador_order_events`,
//!                           created idempotently at startup; APPEND-ONLY: the code only
//!                           ever INSERTs, so ≥12-month retention rides the deployment's PG
//!                           backups). PG is the BACKED-UP store: the prod compose stack
//!                           mounts no volume, so prod MUST set this for durable records.
//!                           Fail-closed: a DSN that is set but unreachable (or whose user
//!                           cannot create/read the tables) refuses startup (EXIT_CONFIG),
//!                           a refused access-log write refuses the request, and order
//!                           creation persists BEFORE the upstream trade call. Unset
//!                           (default) → the JSONL files under DPAY_TROCADOR_LOG_DIR,
//!                           byte-identical to the pre-PG relay (the offline dev loop).
//!                           SECRET: the DSN embeds credentials — never logged, never
//!                           echoed; store errors carry fixed strings.
//!   DPAY_TROCADOR_RATE_PER_MIN   the per-client per-minute bound on POST
//!                           /api/v1/trocador/rate (the agreement's organic-demand pattern;
//!                           default 6). Upstream-bound calls only — device 400s and the
//!                           unconfigured 503 are never counted. A zero or non-numeric value
//!                           refuses startup (EXIT_CONFIG).
//!   DPAY_TROCADOR_TRADE_PER_MIN  the per-client per-minute bound on POST
//!                           /api/v1/trocador/trade (default 4). Same rules as the rate
//!                           bound above. The STATUS read has NO knob: at most one upstream
//!                           read per trade per 60s is the signed promise itself.

use std::net::SocketAddr;
use std::process;
use std::sync::Arc;

use dpay_relay::{app, AppState, FakeLedger, Ledger};

/// Exit code for a bad/unsafe configuration — distinct from a runtime failure (1), so an
/// orchestrator restarting the container can tell "operator error" from "ledger was down".
const EXIT_CONFIG: i32 = 2;

#[tokio::main]
async fn main() {
    // scripts/demo.sh helper (DEMO.md runbook, F1 2026-09-12): print the self-authenticating
    // principal of the DPAY_CONTROLLER_SEED identity and exit — the demo installs the facade
    // with THIS principal as its controller (inline init arg), so the relay agent's faucet
    // `mint` passes the canister's admin gate on first try, with no set_controller dance.
    #[cfg(feature = "agent")]
    if std::env::args().any(|a| a == "--print-controller-principal") {
        use ic_agent::identity::Identity as _;
        match parse_controller_seed()
            .map(|key: [u8; 32]| ic_agent::identity::BasicIdentity::from_raw_key(&key))
        {
            Some(ident) => match ident.sender() {
                Ok(p) => {
                    println!("{p}");
                    process::exit(0);
                }
                Err(e) => {
                    eprintln!("dpay-relay: could not derive the controller principal: {e}");
                    process::exit(EXIT_CONFIG);
                }
            },
            None => {
                eprintln!(
                    "dpay-relay: DPAY_CONTROLLER_SEED is unset or malformed — nothing to print"
                );
                process::exit(EXIT_CONFIG);
            }
        }
    }

    let cfg = Config::from_env().unwrap_or_else(|e| {
        eprintln!("dpay-relay: bad configuration: {e}");
        process::exit(EXIT_CONFIG);
    });

    // F1 (2026-09-12, demo runbook): validate DPAY_DEMO_LEDGER once at startup. The catalog
    // override re-points the DEMO row at the local replica's icrc_ledger; a typo'd principal
    // would silently strand every DEMO read/write on a canister that doesn't exist. Validated
    // here (not in catalog.rs) because `candid` is feature-gated to `agent` — the only build
    // the demo script runs. Every other build leaves the env unset and never sees this.
    #[cfg(feature = "agent")]
    if let Some(v) = non_empty("DPAY_DEMO_LEDGER") {
        if let Err(e) = candid::Principal::from_text(&v) {
            eprintln!("dpay-relay: DPAY_DEMO_LEDGER={v:?} is not a principal: {e}");
            process::exit(EXIT_CONFIG);
        }
    }

    let (ledger, faucet_available) = build_ledger(&cfg).await;
    let apk = load_apk();
    let state = AppState::new(ledger.clone())
        .with_apk(apk)
        .with_checkout(cfg.checkout)
        // The ONE faucet predicate: `GET /api/v1/capabilities` reports it and `POST
        // /api/v1/faucet` refuses on it. Derived from the backend that was actually built, right
        // above — never from the build's feature flags, which is how the relay came to advertise
        // no faucet while serving one.
        .with_faucet(faucet_available);
    // Name the facade for GET /api/v1/integrity: the route reads the canister's live module hash
    // off the public state tree and compares it against the build-time pin. Only an IC-backed
    // ledger has one; a memory demo relay honestly reports it has no live hash instead.
    let state = if let LedgerCfg::Ic {
        ref canister_id, ..
    } = cfg.ledger
    {
        state.with_facade_canister(canister_id.clone())
    } else {
        state
    };
    // The Solana RPC proxy (spec 2026-09-09, Direction 1): the route is registered on EVERY
    // build — an unconfigured proxy answers 503 naming DPAY_SOLANA_RPC_URL rather than 404ing
    // — and gets its upstream + per-call timeout here. The URL is SECRET (it embeds the
    // provider api key): never logged, never echoed in a response.
    let state = state.with_solana(dpay_relay::solana::SolanaProxy::new(
        cfg.solana_rpc_url.clone(),
        cfg.solana_timeout,
    ));
    // The SideShift partner-key proxy (founder decision 3, 2026-09-14): same
    // always-registered contract — unconfigured it answers 503 naming the missing
    // variable(s). BOTH credential halves are SECRET deploy config (the partner account
    // credentials): never logged, never echoed in a response. See src/sideshift.rs.
    let state = state.with_sideshift(dpay_relay::sideshift::SideShiftProxy::new(
        cfg.sideshift_secret.clone(),
        cfg.sideshift_affiliate_id.clone(),
        cfg.sideshift_api_base.clone(),
        dpay_relay::sideshift::DEFAULT_TIMEOUT,
    ));
    // The Trocador aggregator proxy (registered 2026-09-20): same always-registered
    // contract — an unset key answers 503 naming the missing variable. The key is SECRET
    // deploy config: never logged, never echoed in a response. UNLIKE sideshift the status
    // read is proxied too — every venue method is key-gated. See src/trocador.rs.
    //
    // The partner-AGREEMENT layer (2026-09-21, src/trocador_agreement.rs) attaches here,
    // ALWAYS: the compliance access log + the order store (JSONL files under
    // DPAY_TROCADOR_LOG_DIR by default — or the BACKED-UP Postgres when DPAY_TROCADOR_PG_DSN
    // is set), the webhook registration (only when DPAY_PUBLIC_ORIGIN is set), and the
    // promised upstream limits (status 60s/trade fixed; per-client rate/trade bounds).
    // Without the attachment (unit tests) the proxy behaves exactly as before the agreement.
    // `Agreement::open` (not `new`) because a set DSN needs the fail-closed startup: connect
    // + schema + order-index rebuild BEFORE the relay can serve — any failure is the
    // config-style exit, never a degraded mode.
    let trocador_agreement = dpay_relay::trocador_agreement::Agreement::open(
        dpay_relay::trocador_agreement::AgreementConfig {
            public_origin: cfg.public_origin.clone(),
            log_dir: cfg.trocador_log_dir.clone(),
            pg_dsn: cfg.trocador_pg_dsn.clone(),
            trust_proxy: cfg.trust_proxy,
            rate_per_min: cfg.trocador_rate_per_min,
            trade_per_min: cfg.trocador_trade_per_min,
        },
    )
    .await
    .unwrap_or_else(|e| {
        eprintln!("dpay-relay: bad configuration: {e}");
        process::exit(EXIT_CONFIG);
    });
    let state = state.with_trocador(
        dpay_relay::trocador::TrocadorProxy::new(
            cfg.trocador_api_key.clone(),
            cfg.trocador_api_base.clone(),
            dpay_relay::trocador::DEFAULT_TIMEOUT,
        )
        .with_agreement(trocador_agreement),
    );
    // The Jupiter proxy (2026-09-16 founder ask: quotes + swap-tx builds "through our relay
    // (for caching etc)"). ALWAYS serving — the venue is keyless and the base has a constant
    // default, so there is no unconfigured branch and no secret: the base may be named
    // plainly (it carries no credential). See src/jupiter.rs.
    let state = state.with_jupiter(dpay_relay::jupiter::JupiterProxy::new(
        cfg.jupiter_api_base.clone(),
        dpay_relay::jupiter::DEFAULT_TIMEOUT,
    ));
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
    // What DPAY_ENABLE_FAUCET means depends on which faucet this binary compiled, so say which one
    // the operator is looking at. `faucet_available` (above) is what the route and
    // `/api/v1/capabilities` both obey; these lines only explain how it was reached.
    #[cfg(all(feature = "test-helpers", not(feature = "agent")))]
    println!(
        "POST /api/v1/faucet: {} — the offline fixture faucet (DPAY_ENABLE_FAUCET={}), which \
         credits the fake-IC gateway.",
        if faucet_available {
            "ENABLED"
        } else {
            "unavailable"
        },
        cfg.faucet
    );
    #[cfg(feature = "agent")]
    println!(
        "POST /api/v1/faucet: {} — the production faucet, gated by the relay agent's identity \
         (DPAY_CONTROLLER_SEED), not by DPAY_ENABLE_FAUCET (={}, not consulted on this build).",
        if faucet_available {
            "ENABLED"
        } else {
            "unavailable"
        },
        cfg.faucet
    );
    #[cfg(not(any(feature = "test-helpers", feature = "agent")))]
    println!(
        "POST /api/v1/faucet: not registered — this build has no faucet route at all \
         (DPAY_ENABLE_FAUCET={} is not consulted).",
        cfg.faucet
    );
    // The checkout's state belongs in the log the founder reads (`docker logs`), because which
    // surfaces an image serves is an operator's decision and one that came up wrong should be
    // visible without a probe.
    if cfg.checkout {
        println!(
            "OpenCryptoPay checkout ENABLED (DPAY_ENABLE_CHECKOUT unset or true) — /api/v1/checkout, \
             /api/v1/checkout/void and /v1/lnurlp/* are served. Ringing up and cancelling both \
             require the merchant's own signature over the request (dpay_core::CheckoutOpen); the \
             payer routes are public reads."
        );
    } else {
        println!(
            "OpenCryptoPay checkout OFF — /api/v1/checkout and /v1/lnurlp/* are not registered (404). \
             DPAY_ENABLE_CHECKOUT=false is set; unset it (or set true) to serve them."
        );
    }
    // The proxy's one banner line says WHETHER, never WHERE: the upstream URL embeds the
    // provider api key, and even the docker log must not carry it.
    if cfg.solana_rpc_url.is_some() {
        println!(
            "POST /api/v1/solana/rpc: ENABLED — pure pipe + read cache against the configured \
             upstream (DPAY_SOLANA_RPC_URL). sendTransaction and every unallowlisted method are \
             passed through byte-faithfully, uncached; allowlisted reads share a per-method TTL \
             cache; upstream failures come back with their own status, never a stale cache hit."
        );
    } else {
        println!(
            "POST /api/v1/solana/rpc: unconfigured — the route answers 503 until \
             DPAY_SOLANA_RPC_URL (the provider endpoint, full URL incl. api key) is set in the \
             deploy environment."
        );
    }
    // Same one-line WHETHER (never the values — they are the partner account's
    // credentials), naming the exact variable(s) an operator must set.
    if cfg.sideshift_secret.is_some() && cfg.sideshift_affiliate_id.is_some() {
        println!(
            "POST /api/v1/sideshift/*: ENABLED — the partner-key proxy (quotes + fixed-order \
             creation) attaches DPAY_SIDESHIFT_SECRET server-side; the device never sees it. \
             Shift status stays the venue's own keyless device-direct GET."
        );
    } else {
        let mut missing = Vec::new();
        if cfg.sideshift_secret.is_none() {
            missing.push("DPAY_SIDESHIFT_SECRET");
        }
        if cfg.sideshift_affiliate_id.is_none() {
            missing.push("DPAY_SIDESHIFT_AFFILIATE_ID");
        }
        println!(
            "POST /api/v1/sideshift/*: unconfigured — the routes answer 503 until {} set in the \
             deploy environment (the SideShift partner account credentials; see docs/OPS.md §3).",
            missing.join(" and ")
        );
    }

    // The Trocador one-line WHETHER (never the value — the partner API key).
    if cfg.trocador_api_key.is_some() {
        println!(
            "POST /api/v1/trocador/*: ENABLED — the aggregator proxy (rate + trade + the \
             key-gated status read) attaches DPAY_TROCADOR_API_KEY server-side; the device \
             never sees it."
        );
    } else {
        println!(
            "POST /api/v1/trocador/*: unconfigured — the routes answer 503 until \
             DPAY_TROCADOR_API_KEY set in the deploy environment (the Trocador partner API \
             key, requested from commercial@trocador.app; see docs/OPS.md §3)."
        );
    }

    // The partner agreement's one line per leg (2026-09-21): which parts are live, where the
    // append-only files land, and the promised bounds. Values printed here are not secrets
    // (the origin is public, the dir and the limits are operator config).
    match &cfg.public_origin {
        Some(origin) => println!(
            "POST /api/v1/trocador/webhook: ENABLED — trade creation registers \
             {origin}/api/v1/trocador/webhook with webhook_key=<order_id> upstream \
             (DPAY_PUBLIC_ORIGIN); the receiver answers 200 to probes and deliveries."
        ),
        None => println!(
            "POST /api/v1/trocador/webhook: registered but DORMANT — set DPAY_PUBLIC_ORIGIN \
             to have trade creation register the per-trade webhook upstream (the offline \
             default sends no webhook params)."
        ),
    }
    let store_line = if cfg.trocador_pg_dsn.is_some() {
        "trocador agreement: access log + order store append-only in POSTGRES \
         (DPAY_TROCADOR_PG_DSN — the backed-up store; schema created, order index \
         rebuilt; fail-closed on refused writes)"
            .to_string()
    } else {
        format!(
            "trocador agreement: access log + order store append-only under {} \
             (DPAY_TROCADOR_LOG_DIR — JSONL; set DPAY_TROCADOR_PG_DSN for the backed-up \
             Postgres store)",
            cfg.trocador_log_dir.display()
        )
    };
    println!(
        "{store_line}; upstream limits: rate {}/min and trade {}/min per client \
         (DPAY_TROCADOR_RATE_PER_MIN / DPAY_TROCADOR_TRADE_PER_MIN), status reads at most \
         1/min per trade — the signed 60s promise, no knob; XFF trust: {}.",
        cfg.trocador_rate_per_min,
        cfg.trocador_trade_per_min,
        if cfg.trust_proxy { "on (DPAY_TRUST_PROXY)" } else { "off" },
    );

    println!(
        "POST /api/v1/jupiter/*: ENABLED — the quote cache + swap pipe against {} \
         (DPAY_JUPITER_API_BASE, default the venue's keyless lite host). Upstream error \
         statuses pass through verbatim; transport death answers 504 \
         jupiter-upstream-unreachable.",
        cfg.jupiter_api_base
    );

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

    // Connection info is wired into the request extensions so the SideShift proxy can
    // forward the CONNECTING client's IP as `x-user-ip` — SideShift's own proxying rule
    // (their permissions doc: server-sent requests must identify the end user's IP). The
    // relay forwards the best IP it can actually see and omits the header when there is
    // none (oneshot-driven tests); it never fabricates one.
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
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
        // Set but not UTF-8 is not "not set", and saying so sent an operator hunting for a
        // variable they had already exported. Named, like every other env read in this file.
        Err(std::env::VarError::NotUnicode(raw)) => {
            eprintln!(
                "dpay-relay: warn: DPAY_APK_PATH is set to a value that is not valid UTF-8 ({raw:?}); \
                 APK downloads disabled"
            );
            None
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
    checkout: bool,
    /// The solana proxy's upstream, when configured (`DPAY_SOLANA_RPC_URL`). Carries the
    /// provider api key — treat as secret end to end.
    solana_rpc_url: Option<String>,
    /// Per-call upstream timeout for the solana proxy (`DPAY_SOLANA_TIMEOUT_MS`).
    solana_timeout: std::time::Duration,
    /// The SideShift partner account secret (`DPAY_SIDESHIFT_SECRET`) — one half of the
    /// FIRST relay-held partner credential (founder decision 3). SECRET: never logged,
    /// never echoed, never committed. Unset is legal (503 naming the variable).
    sideshift_secret: Option<String>,
    /// The SideShift partner account id / affiliateId (`DPAY_SIDESHIFT_AFFILIATE_ID`) —
    /// the credential's public half. Unset is legal, same 503 as the secret.
    sideshift_affiliate_id: Option<String>,
    /// The SideShift API base (`DPAY_SIDESHIFT_API_BASE`); default the verified-live host.
    sideshift_api_base: String,
    /// The Jupiter API base (`DPAY_JUPITER_API_BASE`); default the venue's keyless lite
    /// host. Not a secret (no credential exists for this venue).
    jupiter_api_base: String,
    /// The Trocador partner API key (`DPAY_TROCADOR_API_KEY`) — the SECOND relay-held
    /// partner credential. SECRET: never logged, never echoed, never committed. Unset is
    /// legal (503 naming the variable).
    trocador_api_key: Option<String>,
    /// The Trocador API base (`DPAY_TROCADOR_API_BASE`); default the verified-live host.
    trocador_api_base: String,
    /// The relay's public origin (`DPAY_PUBLIC_ORIGIN`) — when set, Trocador trade creation
    /// registers the per-trade webhook + key upstream and the trade answer carries the relay
    /// order id header. Unset is the offline default (no webhook params at all).
    public_origin: Option<String>,
    /// The partner-agreement log dir (`DPAY_TROCADOR_LOG_DIR`, default "."): the append-only
    /// access log + order store live here — the JSONL backend, used only when the PG DSN
    /// below is unset.
    trocador_log_dir: std::path::PathBuf,
    /// The partner-agreement postgres DSN (`DPAY_TROCADOR_PG_DSN`): when set, BOTH
    /// compliance stores persist to the backed-up Postgres instead of the JSONL files.
    /// SECRET — embeds credentials; never logged, never echoed.
    trocador_pg_dsn: Option<String>,
    /// Whether X-Forwarded-For names the client IP (`DPAY_TRUST_PROXY`).
    trust_proxy: bool,
    /// The per-client rate-quote bound (`DPAY_TROCADOR_RATE_PER_MIN`, default 6).
    trocador_rate_per_min: u32,
    /// The per-client trade-creation bound (`DPAY_TROCADOR_TRADE_PER_MIN`, default 4).
    trocador_trade_per_min: u32,
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
            Some(other) => {
                return Err(format!("DPAY_LEDGER={other:?} — expected `ic` or `memory`"))
            }
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

        // The operator's switch for the OFFLINE FIXTURE faucet (the only one it gates — see
        // `memory_faucet_available`). Default: on for the in-memory ledger, where it credits a
        // fake gateway, and off otherwise, because a faucet mints.
        let faucet = match non_empty("DPAY_ENABLE_FAUCET") {
            Some(s) => parse_bool("DPAY_ENABLE_FAUCET", &s)?,
            None => matches!(ledger, LedgerCfg::Memory),
        };

        // The checkout is served BY DEFAULT on every ledger and every build (founder decision
        // 2026-09-10, reversing the 2026-09-04 opt-in): an operator who does not want the surface
        // must say `DPAY_ENABLE_CHECKOUT=false` — an explicit act, not a default nobody chose. A
        // malformed value is a config error, not a silent default: an operator who meant the
        // opposite of what they typed must hear about it.
        let checkout = match non_empty("DPAY_ENABLE_CHECKOUT") {
            Some(s) => parse_bool("DPAY_ENABLE_CHECKOUT", &s)?,
            None => true,
        };

        // The Solana RPC proxy's upstream (spec 2026-09-09, Direction 1). UNSET is a legal
        // state — the route still registers and answers 503 naming the variable — but a set
        // value that isn't a URL is refused here rather than surfacing as a 504 per request
        // with no hint why. The value embeds the provider api key, so it never appears in an
        // error message, a log line, or a response (url::ParseError's text names the defect,
        // not the URL — deliberately not interpolated here).
        let solana_rpc_url = match non_empty("DPAY_SOLANA_RPC_URL") {
            Some(url) => {
                reqwest::Url::parse(&url)
                    .map_err(|e| format!("DPAY_SOLANA_RPC_URL is not a valid URL: {e}"))?;
                Some(url)
            }
            None => None,
        };
        let solana_timeout = match non_empty("DPAY_SOLANA_TIMEOUT_MS") {
            Some(raw) => {
                let ms: u64 = raw
                    .parse()
                    .map_err(|e| format!("DPAY_SOLANA_TIMEOUT_MS={raw:?} is not a number: {e}"))?;
                if ms == 0 {
                    return Err(
                        "DPAY_SOLANA_TIMEOUT_MS=0 — a zero timeout refuses every upstream call \
                         before it is made"
                            .into(),
                    );
                }
                std::time::Duration::from_millis(ms)
            }
            None => dpay_relay::solana::DEFAULT_TIMEOUT,
        };

        // The SideShift partner-key credentials (founder decision 3, 2026-09-14). EITHER may
        // be unset — that is a legal state: the routes still register and answer 503 naming
        // exactly the variable(s) missing (the venue is simply absent until the founder's
        // signup produces both halves; docs/OPS.md §3). The secret is SECRET deploy config —
        // it never appears in an error, log, or response; there is deliberately no shape
        // validation because SideShift documents none (a hex-ish string per their examples,
        // but only the upstream can judge it, and its own 401 is the honest refusal).
        let sideshift_secret = non_empty("DPAY_SIDESHIFT_SECRET");
        let sideshift_affiliate_id = non_empty("DPAY_SIDESHIFT_AFFILIATE_ID");
        // The API base defaults to the host verified live 2026-09-15 (docs.sideshift.ai;
        // the old api.sideshift.ai is NXDOMAIN). A set-but-malformed URL refuses startup —
        // same discipline as DPAY_SOLANA_RPC_URL, and the ParseError text names the defect,
        // never the value.
        let sideshift_api_base = match non_empty("DPAY_SIDESHIFT_API_BASE") {
            Some(base) => {
                reqwest::Url::parse(&base)
                    .map_err(|e| format!("DPAY_SIDESHIFT_API_BASE is not a valid URL: {e}"))?;
                base
            }
            None => dpay_relay::sideshift::DEFAULT_API_BASE.to_string(),
        };

        // The Jupiter proxy's upstream (2026-09-16 founder ask). There is no "unset" branch
        // to reason about — the base always exists (the constant default; src/jupiter.rs) —
        // but a SET-but-malformed URL still refuses startup here rather than surfacing as a
        // mystery 504 per request. Same ParseError discipline as the other bases: the text
        // names the defect, never the value.
        let jupiter_api_base = match non_empty("DPAY_JUPITER_API_BASE") {
            Some(base) => {
                reqwest::Url::parse(&base)
                    .map_err(|e| format!("DPAY_JUPITER_API_BASE is not a valid URL: {e}"))?;
                base
            }
            None => dpay_relay::jupiter::DEFAULT_API_BASE.to_string(),
        };

        // The Trocador partner key (2026-09-20). UNSET is a legal state — the routes still
        // register and answer 503 naming the variable (the founder's key request to
        // commercial@trocador.app is outstanding). There is deliberately no shape
        // validation: Trocador documents no format, only the upstream can judge it, and
        // its own 401 is the honest refusal. The base defaults to the host verified live
        // 2026-09-20; a set-but-malformed URL refuses startup — same ParseError discipline
        // as the other bases (the text names the defect, never the value).
        let trocador_api_key = non_empty("DPAY_TROCADOR_API_KEY");
        let trocador_api_base = match non_empty("DPAY_TROCADOR_API_BASE") {
            Some(base) => {
                reqwest::Url::parse(&base)
                    .map_err(|e| format!("DPAY_TROCADOR_API_BASE is not a valid URL: {e}"))?;
                base
            }
            None => dpay_relay::trocador::DEFAULT_API_BASE.to_string(),
        };

        // The partner-agreement layer (2026-09-21). The origin is optional (unset = the
        // offline default with NO webhook params); a set-but-malformed one refuses startup —
        // same ParseError discipline as the other URL envs. The log dir defaults to the
        // process's cwd and is created on first write, never eagerly. The limits default to
        // the agreement's own numbers; zero would refuse every call, so it is a config error
        // like the solana proxy's zero timeout.
        let public_origin = match non_empty("DPAY_PUBLIC_ORIGIN") {
            Some(origin) => {
                let url = reqwest::Url::parse(&origin)
                    .map_err(|e| format!("DPAY_PUBLIC_ORIGIN is not a valid URL: {e}"))?;
                if url.scheme() != "https" && url.scheme() != "http" {
                    return Err(format!(
                        "DPAY_PUBLIC_ORIGIN={origin:?} must be an http(s) origin (got scheme {:?})",
                        url.scheme()
                    ));
                }
                Some(origin.trim_end_matches('/').to_string())
            }
            None => None,
        };
        let trocador_log_dir = std::path::PathBuf::from(
            non_empty("DPAY_TROCADOR_LOG_DIR").unwrap_or_else(|| ".".into()),
        );
        // The compliance records' PG DSN (2026-09-22 dual store). Unset is the legal default
        // (JSONL backend). NO shape validation here on purpose — a postgres connection string
        // is the driver's grammar, not ours; a DSN that does not CONNECT is caught by the
        // fail-closed startup in `Agreement::open` below (same EXIT_CONFIG outcome).
        let trocador_pg_dsn = non_empty("DPAY_TROCADOR_PG_DSN");
        let trust_proxy = match non_empty("DPAY_TRUST_PROXY") {
            Some(s) => parse_bool("DPAY_TRUST_PROXY", &s)?,
            None => false,
        };
        let parse_per_min = |key: &str, default: u32| -> Result<u32, String> {
            match non_empty(key) {
                Some(raw) => {
                    let n: u32 = raw
                        .parse()
                        .map_err(|e| format!("{key}={raw:?} is not a number: {e}"))?;
                    if n == 0 {
                        return Err(format!(
                            "{key}=0 — a zero bound refuses every call before it is made"
                        ));
                    }
                    Ok(n)
                }
                None => Ok(default),
            }
        };
        let trocador_rate_per_min =
            parse_per_min("DPAY_TROCADOR_RATE_PER_MIN", dpay_relay::trocador_agreement::DEFAULT_RATE_PER_MIN)?;
        let trocador_trade_per_min =
            parse_per_min("DPAY_TROCADOR_TRADE_PER_MIN", dpay_relay::trocador_agreement::DEFAULT_TRADE_PER_MIN)?;

        Ok(Config {
            addr,
            ledger,
            faucet,
            checkout,
            solana_rpc_url,
            solana_timeout,
            sideshift_secret,
            sideshift_affiliate_id,
            sideshift_api_base,
            jupiter_api_base,
            trocador_api_key,
            trocador_api_base,
            public_origin,
            trocador_log_dir,
            trocador_pg_dsn,
            trust_proxy,
            trocador_rate_per_min,
            trocador_trade_per_min,
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
    [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "[::1]",
        "host.docker.internal",
    ]
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

/// Build the read backend, and with it the ONE fact `/api/v1/faucet` and `/api/v1/capabilities`
/// both obey: whether this deployment's faucet can actually credit (`AppState::with_faucet`). On
/// the `ic` path a failure to connect is **fatal**: coming up on the in-memory catalog instead
/// would silently serve a demo catalog and zero balances as if they were real.
async fn build_ledger(cfg: &Config) -> (Arc<dyn Ledger>, bool) {
    match &cfg.ledger {
        LedgerCfg::Ic {
            url,
            canister_id,
            fetch_root_key,
        } => connect_ic(url, canister_id, *fetch_root_key).await,
        LedgerCfg::Memory => {
            println!("read surface on the in-memory demo catalog (balances are always 0 — value lives on the IC rail)");
            (
                Arc::new(FakeLedger::new()),
                memory_faucet_available(cfg.faucet),
            )
        }
    }
}

/// Whether `POST /api/v1/faucet` can credit anything on the IN-MEMORY ledger. Only the offline
/// fixture build has a faucet that can: it credits the fake-IC gateway attached above, gated by
/// the operator's `DPAY_ENABLE_FAUCET`.
#[cfg(all(feature = "test-helpers", not(feature = "agent")))]
fn memory_faucet_available(enabled: bool) -> bool {
    enabled
}

/// The other builds: the agent faucet mints THROUGH the facade canister, which an in-memory
/// ledger has no way to reach, and a build with neither feature registers no faucet route at all.
/// Either way the answer is no, whatever `DPAY_ENABLE_FAUCET` says.
#[cfg(not(all(feature = "test-helpers", not(feature = "agent"))))]
fn memory_faucet_available(_enabled: bool) -> bool {
    false
}

/// Connect the agent read backend, and report whether its faucet can credit: the mint is an
/// AUTHENTICATED call, so it needs the identity built from `DPAY_CONTROLLER_SEED`. This is the
/// relay-side half of the gate — whether that identity is the canister's actual controller stays
/// the canister's own `require_admin` call, surfaced verbatim to the caller.
#[cfg(feature = "agent")]
async fn connect_ic(url: &str, canister_id: &str, fetch_root_key: bool) -> (Arc<dyn Ledger>, bool) {
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
                if fetch_root_key {
                    "fetched — local replica"
                } else {
                    "pinned — mainnet"
                },
                if seed.is_some() {
                    "controller — faucet ENABLED (authenticated mint)"
                } else {
                    "anonymous — read-only (faucet unavailable: the canister's mint is admin-gated)"
                }
            );
            (Arc::new(l), seed.is_some())
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
async fn connect_ic(
    _url: &str,
    _canister_id: &str,
    _fetch_root_key: bool,
) -> (Arc<dyn Ledger>, bool) {
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
            Err(e) => {
                // This relay will now ignore SIGTERM, so `docker stop` waits out its grace period
                // and then SIGKILLs — a hard kill nobody could explain from the logs.
                eprintln!(
                    "dpay-relay: warn: could not install a SIGTERM handler ({e}) — this process \
                     will only shut down cleanly on Ctrl-C; `docker stop` will end in a SIGKILL"
                );
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
