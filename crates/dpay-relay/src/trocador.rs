//! The Trocador aggregator proxy — the SECOND relay-held key surface, and the FIRST
//! AGGREGATOR venue (registered 2026-09-20; replaces SideShift as the primary CeFi rail
//! once the key arrives: 20+ backends behind one quote, automatic failover — choosing the
//! provider is the VENUE's own product, so one quote attributed to Trocador is one venue
//! fact and dpay never ranks beneath the aggregate).
//!
//! Trocador is a CeFi instant-exchange AGGREGATOR. Its API (pinned from the venue's own
//! docs page, https://trocador.app/en/docs/, fetched 2026-09-20) is ALL-GET and EVERY
//! method is key-gated through an `API-Key` header — there is NO keyless surface at all
//! (measured live 2026-09-20: every endpoint on `https://api.trocador.app`, status reads
//! included, answers `401 {"error":"Missing API key"}` without one). That is the one
//! structural difference from SideShift: the device cannot poll trade status directly, so
//! the status read is proxied HERE too, and the relay stays in the read path for the whole
//! lifecycle (never in the funds path — the user's deposit still goes to the VENUE's own
//! address, the settled payout still lands at the user's own address). The key is one
//! shared partner credential, and by the founder boundary it lives HERE, on the relay,
//! never on the device (`DPAY_TROCADOR_API_KEY` — requested from commercial@trocador.app;
//! the adapter is live-capable on its arrival, and until then every route answers the
//! 503-until-key marker, the exact contract SideShift shipped with).
//!
//! # What this module serves
//!
//! Three routes, all registered on EVERY build (the 503-not-404 philosophy):
//!
//! - `POST /api/v1/trocador/rate` — the query-only quote surface. The device posts rail
//!   identifiers (`depositLedger`, `settleLedger` — the registry's own pair ids) and a
//!   decimal `depositAmount` string. The relay maps the pair onto Trocador's own
//!   ticker/network codes, attaches the key, and issues the venue's `new_rate` (with
//!   `best_only=True` — the aggregator's own pick, one quote, no ranked list is ever
//!   surfaced). Success wraps `{"venue_id":<matched registry row's id>,"quote":<the
//!   venue's body VERBATIM>,"fetched_at":<unix secs>}` — the attribution + timestamp the
//!   delegated-conversion red lines require, numbers untouched.
//! - `POST /api/v1/trocador/trade` — trade creation (the venue's `new_trade`), same
//!   credential attachment, response VERBATIM (an order is not a quote surface). The
//!   device posts the rate id + provider named by the quote, the user's OWN settle
//!   address, and a REQUIRED `refundAddress` — the user's OWN address on the DEPOSIT
//!   rail, where the venue returns the funds when a deposit fails (without one they stay
//!   with the venue: a fund-loss). The relay validates the refund address is present and
//!   well-formed FOR THE DEPOSIT RAIL (the shared `crate::addrcheck` gate) and refuses
//!   the trade otherwise — 400, house error, before any upstream call. The venue answers
//!   with ITS deposit address (`address_provider`) — the user sends the deposit to
//!   TROCADOR's backend; that is what CeFi means and the app's disclosure says so.
//! - `GET /api/v1/trocador/trade?id=<trade_id>` — trade status (the venue's `trade`
//!   method), VERBATIM passthrough. This is the record's `statusUrl` target: the resume
//!   engine polls it device-direct exactly like every other provider URL — it just points
//!   at the relay, which attaches the key the device never sees.
//!
//! # Rate locking (what the docs truly offer, fail-closed)
//!
//! The docs document `fixed: True/False` on `new_trade` (a fixed-rate trade) but do NOT
//! document any lock window for a `new_rate` id — a rate the quote surface showed is an
//! ESTIMATE. So the app treats it as one: the TRADE is the lock and the consent point
//! (fixed=True is pinned relay-side, below), the awaiting-deposit panel renders the
//! trade's own figures verbatim, and no UI copy ever claims a locked rate before the
//! trade exists — the SideShift order doctrine, unchanged.
//!
//! # Founder pins (relay-side constants, never read from a request)
//!
//! - `markup=0`: dpay is paid NOTHING for a conversion. Trocador's docs: a markup > 0
//!   RAISES THE USER'S PRICE to pay the partner — that is a dpay cut in user cost and is
//!   never sent. OPEN (founder question, no API flag exists): even at markup=0 Trocador's
//!   terms accrue half of TROCADOR's OWN commission to the partner account; dpay cannot
//!   refuse the accrual over the API — what the founder does with the partner balance is
//!   a founder decision, and nothing in dpay's UI or math depends on it (the user's
//!   price is the venue's own baseline either way).
//! - `min_kycrating=A`: only NON-KYC backends (the venue's A rating: no KYC) — both for
//!   the quote and the trade, so the backend that executes is always one the quote
//!   filtered the same way.
//! - `fixed=True`: the venue's documented fixed-rate trade.
//!
//! # The pair mapping (and why the relay owns it)
//!
//! Same rule as `crate::sideshift`: the registry row names the pair in RAIL-CANONICAL ids
//! (an IC ledger principal and the wrapped-SOL mint); Trocador speaks its own
//! ticker/network codes. Mapping rail id → venue code is a fact about the VENUE, so it
//! lives here, next to the key. The routes accept a pair only if it is exactly the
//! registered Trocador row's pair (unordered) — a device cannot spend the key on a pair
//! dpay never registered, and cannot smuggle its own `markup`, `min_kycrating` or
//! `fixed` through: all three are attached HERE, from constants.
//! OPEN (one line): the venue's ticker/network codes and its status vocabulary are
//! themselves key-gated facts (`/coins`, `/trade` answer 401 without a key) — the codes
//! below follow the docs' own example vocabulary ("Mainnet" for an L1 network) and MUST
//! be re-pinned against a live `/coins` + `/trade` on key arrival, before the venue
//! serves a real trade.
//!
//! # Failure semantics (same contract as `crate::sideshift`)
//!
//! - Upstream HTTP error status → SAME status, upstream body VERBATIM (whatever refused
//!   is the venue, not us).
//! - Relay-originated failures carry the body marker
//!   `{"dpayRelayError":"trocador-unconfigured"|"trocador-upstream-unreachable",
//!   "detail":"…"}` (503 when the key env var is unset, 504 on transport trouble). The
//!   detail names the ENV VAR NAME and categories only.
//! - Malformed device bodies are 400s in the house `{"error": …}` shape, refused BEFORE
//!   any upstream call.
//! - The reqwest error text is never included (it embeds the request URL); redirects are
//!   not followed; the key is never logged, never echoed (every error body is a fixed
//!   string for exactly that reason).
//! - The docs document NO end-user-IP forwarding requirement (unlike SideShift's
//!   `x-user-ip` rule), so nothing of the kind is sent — the relay forwards no address
//!   it was not asked for.
//!
//! # The partner agreement (2026-09-21) — [`crate::trocador_agreement`]
//!
//! With the founder's signed partner agreement, three more obligations wrap AROUND these
//! routes without changing any answer above: a compliance ACCESS LOG for every proxied call
//! (append-only, ≥12-month retention), per-trade WEBHOOKS (`webhook`/`webhook_key` params at
//! creation when `DPAY_PUBLIC_ORIGIN` is set; the receiver route in app.rs answers 200 to any
//! probe or delivery), and UPSTREAM RATE LIMITS (status reads ≤1/min per trade, per-client
//! bounds on the rate and trade routes). See `crate::trocador_agreement` for the signed terms.

use std::time::{Duration, Instant};
use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::AppState;
use crate::trocador_agreement::{
    AccessLine, ClientFingerprint, LimitKind, ORDER_ID_HEADER, RATE_LIMITED_CODE,
    STATUS_THROTTLED_CODE, TRADE_LIMITED_CODE,
};

/// The venue id this adapter serves (must match the `cefi` row in `catalog.rs`).
pub const TROCADOR_VENUE_ID: &str = "trocador";

/// The Trocador API base (the dedicated API host — verified live 2026-09-20 answering the
/// venue's own `401 {"error":"Missing API key"}` on every method; the docs page also names
/// the equivalent `https://trocador.app/api/` prefix host). Overridable via
/// `DPAY_TROCADOR_API_BASE` (main.rs): the offline loop points it at the relay's own test
/// stub, and an operator may pin the docs' prefix host instead.
pub const DEFAULT_API_BASE: &str = "https://api.trocador.app";

/// Per-upstream-call timeout. Rate/trade/status are single round trips; no env knob (same
/// rule as the sideshift proxy — the solana proxy's knob exists for poll-loop calls).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// The partner markup, pinned to ZERO by the founder red line: dpay is paid nothing for a
/// conversion, and a nonzero markup would RAISE THE USER'S PRICE to pay it. Sent
/// explicitly (not omitted) so the wire shows the pin and a venue-side default change
/// cannot silently take one. NEVER set this from a request — it is a constant of this
/// integration. (See the module header's OPEN note for the accrual dpay cannot refuse.)
const MARKUP: &str = "0";

/// Only NON-KYC backends (the venue's A rating): both the quote and the trade carry the
/// same filter, so the backend that executes is always one the quote filtered the same
/// way. NEVER set from a request.
const MIN_KYCRATING: &str = "A";

/// The venue's documented fixed-rate trade — the TRADE is the rate lock and the consent
/// point (module header). NEVER set from a request.
const FIXED: &str = "True";

/// The venue rows this adapter serves: a PAIR alone no longer disambiguates a cefi
/// row (the sideshift row trades the same ICP↔SOL pair), so the adapter names its own
/// rows — attribution follows THIS list, never first-match-on-pair.
const TROCADOR_VENUE_IDS: &[&str] = &[TROCADOR_VENUE_ID];

/// Rail-canonical id → Trocador's own (ticker, network) for every rail a registered
/// Trocador pair names. BEST-EFFORT and UNVERIFIED until the founder's API key exists
/// (every route 503s until then — the keyless tripwire is unchanged): the venue's own
/// ticker/network vocabulary is itself key-gated (`/coins`), so these follow the docs'
/// own example vocabulary ("Mainnet" for an L1 network) and MUST be re-pinned against a
/// live `/coins` on key arrival (module header's OPEN note). The registered row trades
/// exactly the two rails below; further pairs (USDC/EURC) extend this table WITH
/// measurement, the sideshift-usdc coverage-expansion pattern.
/// Tuple shape: (rail id, venue ticker, venue network, ADDR-CHECK rail kind). The venue
/// network is what the upstream API receives; the addr-check kind ("icp" | "solana")
/// keys the shared refund-address validator — the venue's network name ("Mainnet") is
/// NOT a rail identity and must never reach the validator.
const TROCADOR_ASSETS: &[(&str, &str, &str, &str)] = &[
    (
        crate::catalog::ICP_LEDGER_PRINCIPAL,
        "icp",
        "Mainnet",
        "icp",
    ),
    (
        crate::catalog::WRAPPED_SOL_MINT,
        "sol",
        "Mainnet",
        "solana",
    ),
];

/// The proxy's state: the partner key (secret — module header), the API base, the shared
/// HTTP client and the per-call timeout — plus the partner-AGREEMENT layer
/// ([`crate::trocador_agreement`]: access log, order store, webhooks, upstream limits) when
/// attached. Held in an `Arc` on [`AppState`]; `unconfigured` decides between serving and the
/// 503 marker. The agreement is deployment config attached in main.rs; a proxy built without
/// it (unit tests) behaves exactly like the pre-agreement relay — no logs, no stores, no limits.
pub struct TrocadorProxy {
    api_key: Option<String>,
    base: String,
    timeout: Duration,
    #[allow(dead_code)] // read through `&self` in every call path; field kept for symmetry
    client: reqwest::Client,
    agreement: Option<Arc<crate::trocador_agreement::Agreement>>,
}

impl TrocadorProxy {
    /// Build the proxy. The key `None` (legal until the founder's request landed) leaves
    /// the routes registered but answering the 503 `trocador-unconfigured` marker naming
    /// exactly which variable is missing. The agreement layer starts UNATTACHED — see
    /// [`TrocadorProxy::with_agreement`].
    pub fn new(api_key: Option<String>, base: String, timeout: Duration) -> Self {
        TrocadorProxy {
            api_key,
            base,
            timeout,
            client: http_client(),
            agreement: None,
        }
    }

    /// Attach the partner-agreement layer (main.rs builds it from the env; the offline tests
    /// build it with explicit config + an injectable clock).
    pub fn with_agreement(mut self, agreement: crate::trocador_agreement::Agreement) -> Self {
        self.agreement = Some(Arc::new(agreement));
        self
    }

    /// The agreement layer, when attached.
    pub fn agreement(&self) -> Option<&Arc<crate::trocador_agreement::Agreement>> {
        self.agreement.as_ref()
    }

    /// Whether `X-Forwarded-For` may name the client IP (`DPAY_TRUST_PROXY`) — read by the
    /// [`ClientFingerprint`] extractor through the state.
    pub fn trust_proxy(&self) -> bool {
        self.agreement.as_ref().is_some_and(|a| a.trust_proxy())
    }

    /// The missing credential name(s). Unset is a LEGAL state (503, not 404).
    fn missing_credentials(&self) -> Vec<&'static str> {
        if self.api_key.is_none() {
            vec!["DPAY_TROCADOR_API_KEY"]
        } else {
            Vec::new()
        }
    }

    /// The key, when configured. Cloned per call (one short string); the None branch is
    /// handled by `missing_credentials` first.
    fn credential(&self) -> Option<String> {
        self.api_key.clone()
    }
}

/// `POST /api/v1/trocador/rate` — the quote surface. Request (device):
/// `{"depositLedger": "<rail id>", "settleLedger": "<rail id>", "depositAmount":
/// "<decimal string in the venue's own units>"}`. The pair must be exactly the registered
/// `cefi` row's pair (unordered). Success answers the attribution wrap (module header);
/// upstream errors pass through verbatim.
///
/// Agreement wrapping (see [`crate::trocador_agreement`]): the quote is an UPSTREAM-BOUND call,
/// so the per-client fixed window (`DPAY_TROCADOR_RATE_PER_MIN`, default 6/min) admits it right
/// before the call — 429 + `Retry-After` + the house marker when the window is full — and the
/// completed call appends one `kind:"rate"` line to the compliance access log. Device 400s and
/// the unconfigured 503 are neither counted nor logged: they never reach the venue.
pub async fn rate_proxy(
    State(state): State<AppState>,
    fp: ClientFingerprint,
    body: Bytes,
) -> Response {
    let proxy = state.trocador.clone();
    if let Some(response) = unconfigured(&proxy) {
        return response;
    }
    let api_key = proxy.credential().expect("checked above");

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) — POST /api/v1/trocador/rate takes \
                     {{depositLedger, settleLedger, depositAmount}}"
                ),
            );
        }
    };
    let (Some(deposit_ledger), Some(settle_ledger)) = (
        req.get("depositLedger").and_then(Value::as_str),
        req.get("settleLedger").and_then(Value::as_str),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs string fields `depositLedger` and `settleLedger` (the registry's \
             rail ids for the registered Trocador pair)",
        );
    };
    // The venue speaks DECIMAL strings in its own units — the device sends exactly the
    // amount the user is depositing, and the relay forwards it without converting,
    // rounding or range-checking (the venue's own min/max refusal is the authority).
    let Some(deposit_amount) = req.get("depositAmount").and_then(Value::as_str) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs a string `depositAmount` (decimal, in the deposit asset's own \
             units — the venue's own wire format)",
        );
    };
    if !is_decimal_string(deposit_amount) {
        return err(
            StatusCode::BAD_REQUEST,
            "`depositAmount` must be a plain decimal string (e.g. \"1.5\") — the venue's own \
             wire format, forwarded as-is",
        );
    }
    let Some((venue_id, t_from, n_from, t_to, n_to)) = pair_direction(deposit_ledger, settle_ledger)
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported pair: the registered Trocador venue rows trade exactly their \
             registered cross-rail pairs — pass one row's two rail ids as \
             depositLedger/settleLedger",
        );
    };

    // The venue's `new_rate`: the pair + amount, the founder pins, and `best_only=True` —
    // the AGGREGATOR's own pick, ONE quote (a ranked list is the venue's product to make,
    // never a surface dpay renders). Percent-encoding is the URL builder's job.
    // The agreement's per-client window admits the call right before it is made (upstream-bound
    // only — every refusal above this line is neither counted nor logged).
    if let Some(a) = proxy.agreement() {
        if let Err(retry) = a.admit(LimitKind::Rate, fp.ip.as_deref()) {
            return too_many(
                RATE_LIMITED_CODE,
                "trocador rate quotes are rate-limited for this client: the partner agreement \
                 bounds quote requests per client per minute",
                retry,
            );
        }
    }
    let started = Instant::now();
    let url = match build_url(
        &proxy.base,
        "new_rate",
        &[
            ("ticker_from", t_from),
            ("network_from", n_from),
            ("ticker_to", t_to),
            ("network_to", n_to),
            ("amount_from", deposit_amount),
            ("min_kycrating", MIN_KYCRATING),
            ("markup", MARKUP),
            ("best_only", "True"),
        ],
    ) {
        Ok(u) => u,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let outcome = get_upstream(&proxy, url, &api_key).await;
    // Agreement: the call WAS upstream-bound — count it at admit (above), log it here, after
    // it completed, so the line carries the upstream status and the real duration. PG mode
    // fail-closed: a refused write refuses the RESPONSE (the quote is never delivered
    // unlogged); JSONL mode cannot produce the error.
    if let Some(a) = proxy.agreement() {
        if let Err(e) = a
            .log(AccessLine {
                kind: "rate",
                route: "/api/v1/trocador/rate",
                method: "POST",
                ip: fp.ip.clone(),
                user_agent: fp.user_agent.clone(),
                accept_language: fp.accept_language.clone(),
                client_order_id: None,
                order_id: None,
                trade_id: None,
                upstream_status: Some(outcome.status.as_u16()),
                duration_ms: Some(started.elapsed().as_millis() as u64),
                key_hash: None,
            })
            .await
        {
            eprintln!("dpay-relay: trocador agreement: access-log write refused: {e}");
            return store_down();
        }
    }
    // Success: wrap for attribution + timestamp. The venue's numbers ride untouched under
    // `quote`. A 2xx body that is not a JSON object is passed VERBATIM instead — it is
    // what the venue said, and the wrap is only for bodies the app can actually read.
    if outcome.status.is_success() {
        if let Ok(Value::Object(venue_body)) = serde_json::from_slice::<Value>(&outcome.body) {
            let wrapped = json!({
                "venue_id": venue_id,
                "quote": Value::Object(venue_body),
                "fetched_at": crate::now_secs(),
            });
            return json_response(outcome.status, &Bytes::from(wrapped.to_string()));
        }
    }
    json_response(outcome.status, &outcome.body)
}

/// `POST /api/v1/trocador/trade` — trade creation. Request (device):
/// `{"rateId": "<id from the quote surface>", "provider": "<the provider the quote
/// named>", "settleAddress": "<the user's OWN address on the settle rail>",
/// "refundAddress": "<the user's OWN address on the DEPOSIT rail>", "depositLedger":
/// "<the deposit rail id>", "settleLedger": "<the settle rail id>", "depositAmount":
/// "<decimal string>"}`. Response VERBATIM (module header): the device persists
/// `trade_id` and `address_provider` (+`address_provider_memo`) off the venue's own
/// answer.
///
/// The refund address is a FUND-LOSS guard, not paperwork: when a deposit fails, the
/// venue returns the funds to `refundAddress` — and without one they stay with the venue.
/// It must be present and well-formed FOR THE DEPOSIT RAIL (named by `depositLedger` —
/// the shared `crate::addrcheck` gate), and it is the DEVICE's job to derive it from the
/// user's own key — a refund may only ever land at a user-owned address (the
/// non-custodial red line), never a dpay-controlled one. A missing or malformed field is
/// a client bug: the 400 house error, refused BEFORE any upstream call (this is a device
/// error, not a 503-class relay fact).
///
/// Agreement wrapping (see [`crate::trocador_agreement`]): an optional `clientOrderId` string
/// is accepted (the device's own order id — informational, length-clamped). The relay mints an
/// order id and persists the order BEFORE the upstream call; when `DPAY_PUBLIC_ORIGIN` is set
/// the upstream call carries `webhook=<origin>/api/v1/trocador/webhook` +
/// `webhook_key=<order_id>` (unset origin → NO webhook params — the offline default), the
/// response rides an `X-Dpay-Order-Id` header, and the venue's trade_id is persisted against
/// the order when the venue answers. The BODY stays the venue's VERBATIM answer either way.
/// The per-client trade window (`DPAY_TROCADOR_TRADE_PER_MIN`, default 4/min) admits the call;
/// a `kind:"trade"` access-log line is appended after it completes.
pub async fn trade_proxy(
    State(state): State<AppState>,
    fp: ClientFingerprint,
    body: Bytes,
) -> Response {
    let proxy = state.trocador.clone();
    if let Some(response) = unconfigured(&proxy) {
        return response;
    }
    let api_key = proxy.credential().expect("checked above");

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) — POST /api/v1/trocador/trade takes \
                     {{rateId, provider, settleAddress, refundAddress, depositLedger, \
                     settleLedger, depositAmount}}"
                ),
            );
        }
    };
    let (Some(rate_id), Some(provider), Some(settle_address), Some(refund_address), Some(deposit_ledger), Some(settle_ledger), Some(deposit_amount)) = (
        req.get("rateId").and_then(Value::as_str),
        req.get("provider").and_then(Value::as_str),
        req.get("settleAddress").and_then(Value::as_str),
        req.get("refundAddress").and_then(Value::as_str),
        req.get("depositLedger").and_then(Value::as_str),
        req.get("settleLedger").and_then(Value::as_str),
        req.get("depositAmount").and_then(Value::as_str),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs string fields `rateId`, `provider` (both from the rate surface's \
             own quote), `settleAddress` (the user's own address on the settle rail), \
             `refundAddress` (the user's own address on the DEPOSIT rail — where the venue \
             returns funds on failure), `depositLedger`, `settleLedger` and `depositAmount`",
        );
    };
    if rate_id.is_empty() || provider.is_empty() || settle_address.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "`rateId`, `provider` and `settleAddress` must be non-empty strings",
        );
    }
    if !is_decimal_string(deposit_amount) {
        return err(
            StatusCode::BAD_REQUEST,
            "`depositAmount` must be a plain decimal string (e.g. \"1.5\") — the venue's own \
             wire format, forwarded as-is",
        );
    }
    // Both rails must belong to the registered pair (unordered) — the same allowlist the
    // rate surface applied, so a trade can never ride rails no quote ever named.
    let Some((_, t_from, n_from, t_to, n_to)) = pair_direction(deposit_ledger, settle_ledger)
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported pair: `depositLedger`/`settleLedger` must be the registered \
             Trocador pair's two rail ids (the same ids the rate surface accepted)",
        );
    };
    // The refund rail is a fact about the DEPOSIT: the registered asset table names the
    // venue's own network for the rail id, and well-formedness is checked against THAT
    // (the shared validator both cefi adapters use).
    let Some(refund_network) = TROCADOR_ASSETS
        .iter()
        .find(|(rail_id, _, _, _)| *rail_id == deposit_ledger)
        .map(|(_, _, _, kind)| *kind)
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported deposit rail: `depositLedger` must be a registered Trocador pair's \
             rail id (the same id the rate surface accepted)",
        );
    };
    if refund_address.is_empty()
        || !crate::addrcheck::address_wellformed(refund_network, refund_address)
    {
        return err(
            StatusCode::BAD_REQUEST,
            "`refundAddress` must be a well-formed address on the DEPOSIT rail — an Internet \
             Computer principal, ICRC-1 account text, or 64-hex account identifier for icp, \
             a base58 32-byte pubkey for solana",
        );
    }
    // The venue's `new_trade`: the quote's own rate id + provider, the user's own
    // addresses, the SAME founder pins the rate carried (a trade can never re-attribute
    // the markup, loosen the KYC filter, or flip the rate type).
    //
    // Agreement: the device's optional clientOrderId rides the record (verbatim, clamped);
    // the per-client window admits the call; the order is minted + persisted BEFORE the
    // upstream call; and the webhook params ride only when DPAY_PUBLIC_ORIGIN is configured.
    let client_order_id = req
        .get("clientOrderId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(crate::trocador_agreement::MAX_CLIENT_ORDER_ID_CHARS).collect::<String>());
    let agreement = proxy.agreement();
    if let Some(a) = agreement {
        if let Err(retry) = a.admit(LimitKind::Trade, fp.ip.as_deref()) {
            return too_many(
                TRADE_LIMITED_CODE,
                "trocador trade creation is rate-limited for this client: the partner \
                 agreement bounds trade creation per client per minute",
                retry,
            );
        }
    }
    // Persist-first, fail-closed in PG mode: a refused order-store write refuses the TRADE
    // (no order id minted → no upstream call is ever issued unrecorded). JSONL mode keeps the
    // pre-PG lenience (a failed file append is a stderr note, the trade proceeds).
    let order_id = match agreement.as_ref().map(|a| a.try_open_order(client_order_id.as_deref()))
    {
        Some(Ok(id)) => Some(id),
        Some(Err(e)) => {
            eprintln!("dpay-relay: trocador agreement: {e}");
            return store_down();
        }
        None => None,
    };
    let webhook_url = agreement.as_ref().and_then(|a| a.webhook_url());
    let mut pairs: Vec<(&str, &str)> = vec![
        ("id", rate_id),
        ("ticker_from", t_from),
        ("network_from", n_from),
        ("ticker_to", t_to),
        ("network_to", n_to),
        ("amount_from", deposit_amount),
        ("address", settle_address),
        ("provider", provider),
        ("fixed", FIXED),
        ("refund", refund_address),
        ("min_kycrating", MIN_KYCRATING),
        ("markup", MARKUP),
    ];
    if let (Some(webhook), Some(order_id)) = (webhook_url.as_deref(), order_id.as_deref()) {
        // The venue probes this URL at trade creation and POSTs every status change to it,
        // echoing `webhook_key` back as `key` (module header / crate::trocador_agreement §2).
        pairs.push(("webhook", webhook));
        pairs.push(("webhook_key", order_id));
    }
    let url = match build_url(&proxy.base, "new_trade", &pairs) {
        Ok(u) => u,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let started = Instant::now();
    let outcome = get_upstream(&proxy, url, &api_key).await;
    // The venue's trade_id rides its 2xx answer — attach it to the order (and the log line)
    // when present. A refused trade (4xx/5xx) leaves the order trade_id-less: the venue's
    // own refusal is the authority, verbatim below.
    let mut trade_id: Option<String> = None;
    if outcome.status.is_success() {
        if let Ok(v) = serde_json::from_slice::<Value>(&outcome.body) {
            if let Some(t) = v.get("trade_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                trade_id = Some(t.to_string());
            }
        }
    }
    if let (Some(a), Some(order_id), Some(trade_id)) =
        (agreement.as_ref(), order_id.as_deref(), trade_id.as_deref())
    {
        a.attach_trade_id(order_id, trade_id);
    }
    if let Some(a) = agreement.as_ref() {
        if let Err(e) = a
            .log(AccessLine {
                kind: "trade",
                route: "/api/v1/trocador/trade",
                method: "POST",
                ip: fp.ip.clone(),
                user_agent: fp.user_agent.clone(),
                accept_language: fp.accept_language.clone(),
                client_order_id: client_order_id.clone(),
                order_id: order_id.clone(),
                trade_id: trade_id.clone(),
                upstream_status: Some(outcome.status.as_u16()),
                duration_ms: Some(started.elapsed().as_millis() as u64),
                key_hash: None,
            })
            .await
        {
            // Fail-closed in PG mode — but AFTER the upstream trade exists, refusing the
            // RESPONSE (never the trade): the device sees a clean relay error, the venue's
            // trade simply goes unclaimed by this response. The order itself IS durable
            // (persist-first above), so webhook correlation cannot orphan it.
            eprintln!("dpay-relay: trocador agreement: access-log write refused: {e}");
            return store_down();
        }
    }
    let mut response = json_response(outcome.status, &outcome.body);
    // The relay-side order id rides a response header ONLY when the public origin is set (the
    // device needs it to reason about webhooks; offline there is nothing to correlate).
    if webhook_url.is_some() {
        if let Some(order_id) = order_id.as_deref() {
            if let Ok(value) = HeaderValue::from_str(order_id) {
                response.headers_mut().insert(ORDER_ID_HEADER, value);
            }
        }
    }
    response
}

/// `GET /api/v1/trocador/trade?id=<trade_id>` — trade status (the venue's `trade`
/// method), VERBATIM passthrough. This route is the persisted record's `statusUrl`: the
/// resume engine polls it device-direct (a plain https GET answering the venue's own
/// body, whose top-level `status` string is the field the engine reads) while the key
/// rides HERE, server-side. `id` is required and non-empty; a missing or empty one is a
/// client bug — 400, no upstream call.
///
/// Agreement freshness (see [`crate::trocador_agreement`] §3): when a webhook-delivered
/// payload exists for the trade id, THAT is served verbatim with ZERO upstream calls (the
/// webhook is the primary channel). Otherwise the read is the promised FALLBACK — at most one
/// upstream read per trade_id per 60s (fixed, it is the promise): within the window the route
/// answers 429 + `Retry-After` with the house marker, and webhook-served responses never
/// count against any window. Every answered read appends a `kind:"status"` line to the
/// compliance access log, correlated with the order when the store knows the trade id.
pub async fn trade_status_proxy(
    State(state): State<AppState>,
    Query(params): Query<BTreeMap<String, String>>,
    fp: ClientFingerprint,
) -> Response {
    let proxy = state.trocador.clone();
    if let Some(response) = unconfigured(&proxy) {
        return response;
    }
    let api_key = proxy.credential().expect("checked above");
    let Some(trade_id) = params.get("id").map(String::as_str).filter(|s| !s.is_empty())
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs a non-empty `id` query parameter (the venue's own trade_id — the \
             key the trade creation answer carried)",
        );
    };
    let agreement = proxy.agreement();
    // The webhook cache answers FIRST and leaves no trace on any window: a matched delivery is
    // the freshest fact we hold, and reading it costs the venue nothing.
    if let Some(payload) = agreement.as_ref().and_then(|a| a.cached_payload(trade_id)) {
        if let Some(a) = agreement.as_ref() {
            let record = a.order_by_trade_id(trade_id);
            if let Err(e) = a
                .log(AccessLine {
                    kind: "status",
                    route: "/api/v1/trocador/trade",
                    method: "GET",
                    ip: fp.ip.clone(),
                    user_agent: fp.user_agent.clone(),
                    accept_language: fp.accept_language.clone(),
                    client_order_id: record.as_ref().and_then(|r| r.client_order_id.clone()),
                    order_id: record.as_ref().map(|r| r.order_id.clone()),
                    trade_id: Some(trade_id.to_string()),
                    upstream_status: None,
                    duration_ms: None,
                    key_hash: None,
                })
                .await
            {
                eprintln!("dpay-relay: trocador agreement: access-log write refused: {e}");
                return store_down();
            }
        }
        return json_response(StatusCode::OK, &Bytes::from(payload));
    }
    // The fallback upstream read: the promised 60s-per-trade spacing gates it (marking the
    // window BEFORE the call — a failed read still reached the venue).
    if let Some(a) = agreement {
        if let Err(remaining) = a.admit_status(trade_id) {
            return too_many(
                STATUS_THROTTLED_CODE,
                "trocador status for this trade was fetched upstream less than 60s ago (the \
                 partner agreement's organic-demand bound) — the next fresh read arrives when \
                 the window opens",
                remaining,
            );
        }
    }
    let url = match build_url(&proxy.base, "trade", &[("id", trade_id)]) {
        Ok(u) => u,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let started = Instant::now();
    let outcome = get_upstream(&proxy, url, &api_key).await;
    if let Some(a) = agreement.as_ref() {
        let record = a.order_by_trade_id(trade_id);
        if let Err(e) = a
            .log(AccessLine {
                kind: "status",
                route: "/api/v1/trocador/trade",
                method: "GET",
                ip: fp.ip.clone(),
                user_agent: fp.user_agent.clone(),
                accept_language: fp.accept_language.clone(),
                client_order_id: record.as_ref().and_then(|r| r.client_order_id.clone()),
                order_id: record.as_ref().map(|r| r.order_id.clone()),
                trade_id: Some(trade_id.to_string()),
                upstream_status: Some(outcome.status.as_u16()),
                duration_ms: Some(started.elapsed().as_millis() as u64),
                key_hash: None,
            })
            .await
        {
            eprintln!("dpay-relay: trocador agreement: access-log write refused: {e}");
            return store_down();
        }
    }
    json_response(outcome.status, &outcome.body)
}

/// Build an upstream GET URL: the base + method path + percent-encoded query pairs.
/// (`Url::parse_with_params` is the encoder — device-supplied strings never reach the
/// query unencoded.) A base that is not a URL is an operator configuration defect caught
/// at startup (main.rs), so the error here is the house 400 shape with a category only.
fn build_url(base: &str, method: &str, pairs: &[(&str, &str)]) -> Result<reqwest::Url, String> {
    reqwest::Url::parse_with_params(&format!("{base}/{method}"), pairs)
        .map_err(|_| format!("upstream URL could not be built for the {method} method"))
}

/// Map a (deposit, settle) rail-id pair onto Trocador's own codes — accepted only if it is
/// EXACTLY a registered `cefi` row's pair, unordered (the registry's own rule:
/// pair_ledgers carry no order; one row per pair, so the pair disambiguates the row).
/// This is the whole pair allowlist for the key: every cefi row, both directions. Returns
/// the matched row's venue_id first, so attribution names the row the pair actually
/// resolved to.
fn pair_direction(
    deposit: &str,
    settle: &str,
) -> Option<(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
)> {
    let row = crate::catalog::venues().into_iter().find(|v| {
        v.kind == crate::catalog::VenueKind::Cefi
            && TROCADOR_VENUE_IDS.contains(&v.venue_id)
            && (v.pair_ledgers == [deposit, settle] || v.pair_ledgers == [settle, deposit])
    })?;
    let lookup = |id: &str| {
        TROCADOR_ASSETS
            .iter()
            .find(|(rail_id, _, _, _)| *rail_id == id)
            .map(|(_, ticker, network, _)| (*ticker, *network))
    };
    let ((d_ticker, d_net), (s_ticker, s_net)) = (lookup(deposit)?, lookup(settle)?);
    Some((row.venue_id, d_ticker, d_net, s_ticker, s_net))
}

/// A plain non-negative decimal string (the venue's amount wire format). Structural
/// only — min/max and precision are the VENUE's own refusals to relay, not ours.
fn is_decimal_string(s: &str) -> bool {
    let mut seen_dot = false;
    let mut seen_digit = false;
    for c in s.chars() {
        match c {
            '0'..='9' => seen_digit = true,
            '.' if !seen_dot => seen_dot = true,
            _ => return false,
        }
    }
    seen_digit
}

/// The 503 answer for an unconfigured proxy, naming exactly the missing variable.
/// `None` when configured.
fn unconfigured(proxy: &TrocadorProxy) -> Option<Response> {
    let missing = proxy.missing_credentials();
    if missing.is_empty() {
        return None;
    }
    Some(json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        &relay_error_body(
            "trocador-unconfigured",
            &format!(
                "trocador proxy is not configured: set {} in the relay's environment (the \
                 partner API key — requested from commercial@trocador.app; see docs/OPS.md §3)",
                missing.join(" and ")
            ),
        ),
    ))
}

/// One upstream call: attach the key header (`API-Key` — the venue's documented auth),
/// GET the built URL, answer with the upstream's status + body verbatim — or the fixed
/// 504 marker for transport trouble. The reqwest error is DROPPED, not formatted (it
/// embeds the request URL).
async fn get_upstream(proxy: &TrocadorProxy, url: reqwest::Url, api_key: &str) -> Outcome {
    let request = proxy
        .client
        .get(url)
        .header("API-Key", api_key)
        .header(header::ACCEPT, "application/json")
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

/// One completed upstream call: status + body (the verbatim-passthrough currency of
/// this module — same shape as `crate::sideshift`).
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

/// The honest answer when Trocador could not be reached: a 504 carrying the
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
            "trocador-upstream-unreachable",
            &format!("trocador upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract shared with
/// `crate::solana` and `crate::sideshift`:
/// `{"dpayRelayError": <code>, "detail": <short human phrase>}`. Fixed inputs only (env
/// var NAMES and categories), so no secret can leak through.
pub(crate) fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(
        serde_json::json!({
            "dpayRelayError": code,
            "detail": detail,
        })
        .to_string(),
    )
}

/// The 429 answer for a limit the partner agreement imposes (crate::trocador_agreement §3):
/// the house marker + `Retry-After` in whole seconds. Fixed-string discipline as everywhere
/// else — the detail names the category, never a value.
fn too_many(code: &str, detail: &str, retry_after_secs: u64) -> Response {
    let mut response = json_response(StatusCode::TOO_MANY_REQUESTS, &relay_error_body(code, detail));
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(retry_after_secs));
    response
}

/// The fail-closed answer when the compliance store refuses a write in PG mode (founder rule
/// 2026-09-22: "postgres is being backed up, flat files are not" — the record MUST exist, so
/// the request is refused rather than proceed unlogged). Unreachable in JSONL mode: a failed
/// file append stays a stderr note there, exactly as before this store existed. Fixed-string
/// discipline — the store error text goes to stderr only, never into a response (the DSN
/// embeds credentials, and PG error text is not ours to forward).
fn store_down() -> Response {
    json_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        &relay_error_body(
            "trocador-store-unavailable",
            "the compliance store refused the write — the request is refused rather than \
             proceed unlogged; retry after the store recovers",
        ),
    )
}

/// The shared HTTP client (one per process; redirects NOT followed — same discipline
/// as every other proxy: exactly one hop, surfaced not chased).
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the trocador proxy's HTTP client")
        })
        .clone()
}

/// House error shape (`{"error": …}`, application/json) — client bugs, not
/// relay-path facts.
fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    use axum::Json;
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

/// A body-carrying response with a fixed status, `application/json` by contract.
pub(crate) fn json_response(status: StatusCode, body: &Bytes) -> Response {
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
    fn decimal_strings_are_structural_only() {
        assert!(is_decimal_string("1.5"));
        assert!(is_decimal_string("0"));
        assert!(is_decimal_string("100"));
        assert!(!is_decimal_string(""));
        assert!(!is_decimal_string("-1"));
        assert!(!is_decimal_string("1,5"));
        assert!(!is_decimal_string("1.5.5"));
        assert!(!is_decimal_string("abc"));
    }

    #[test]
    fn pair_direction_accepts_only_the_registered_trocador_pair_both_ways() {
        let icp = crate::catalog::ICP_LEDGER_PRINCIPAL;
        let sol = crate::catalog::WRAPPED_SOL_MINT;
        let usdc = crate::catalog::SOLANA_USDC_MINT;
        let eurc = crate::catalog::SOLANA_EURC_MINT;
        // Both directions of the registered cross-rail pair (the trocador row), with the
        // venue's own best-effort codes (re-pinned on key arrival — module header).
        assert_eq!(
            pair_direction(icp, sol),
            Some(("trocador", "icp", "Mainnet", "sol", "Mainnet"))
        );
        assert_eq!(
            pair_direction(sol, icp),
            Some(("trocador", "sol", "Mainnet", "icp", "Mainnet"))
        );
        // The pairs trocador rows do NOT (yet) exist for must not ride the key — even
        // though other cefi rows (sideshift-usdc/-eurc) trade exactly those pairs: the
        // pair disambiguates the ROW, and only the trocador row's pair is allowlisted here.
        assert!(pair_direction(icp, usdc).is_none());
        assert!(pair_direction(icp, eurc).is_none());
        // A real IC ledger that no cefi row pairs is refused.
        assert!(pair_direction(crate::catalog::VCHF_LEDGER_PRINCIPAL, sol).is_none());
        // Solana-rail pairs that EXIST (jupiter rows) are never cefi pairs.
        assert!(pair_direction(sol, usdc).is_none());
        assert!(pair_direction(usdc, eurc).is_none());
        assert!(pair_direction(icp, icp).is_none());
        assert!(pair_direction("", "").is_none());
    }

    #[test]
    fn founder_pins_are_the_documented_constants() {
        // The three relay-side constants are exactly the founder's pins — a request can
        // never change them, and this test is the tripwire that says so in review diffs.
        assert_eq!(MARKUP, "0", "dpay is paid nothing (a nonzero markup raises the user's price)");
        assert_eq!(MIN_KYCRATING, "A", "non-KYC backends only");
        assert_eq!(FIXED, "True", "the venue's documented fixed-rate trade");
    }

    #[test]
    fn build_url_percent_encodes_device_supplied_params() {
        let base = "https://api.trocador.app";
        let url = build_url(base, "new_trade", &[("address", "abc-def"), ("id", "1 2")])
            .expect("a valid base builds");
        assert_eq!(url.as_str(), "https://api.trocador.app/new_trade?address=abc-def&id=1+2");
        assert!(build_url("not a url", "new_rate", &[]).is_err());
    }

    #[test]
    fn unconfigured_proxy_names_exactly_the_missing_variable() {
        let none = TrocadorProxy::new(None, DEFAULT_API_BASE.to_string(), DEFAULT_TIMEOUT);
        let response = unconfigured(&none).expect("unconfigured → 503");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let full = TrocadorProxy::new(
            Some("key".into()),
            DEFAULT_API_BASE.to_string(),
            DEFAULT_TIMEOUT,
        );
        assert!(unconfigured(&full).is_none());
    }
}
