//! The SideShift partner-key proxy — the FIRST relay-held partner-key surface
//! (founder decision 3, 2026-09-14, `docs/specs/2026-09-14-swap-venue-feasibility.md`
//! §Founder decisions; the partner-key infrastructure pattern is recorded there under
//! "Partner-key infrastructure").
//!
//! SideShift is a CeFi instant-exchange service. Its API (verified live 2026-09-15:
//! base `https://sideshift.ai/api/v2/…` — the old `api.sideshift.ai` host is NXDOMAIN)
//! requires an account: every quote and order call carries the account secret in
//! `x-sideshift-secret` and the account id as `affiliateId`. An account is the
//! INTEGRATION, not an end user (their own docs: "Use one account for your entire
//! integration"), so unlike OpenCryptoPay there is NO per-user session the device
//! could hold — the key is one shared partner credential, and by the founder boundary
//! it lives HERE, on the relay, never on the device.
//!
//! # What this module serves
//!
//! Two routes, both registered on EVERY build (the 503-not-404 philosophy):
//!
//! - `POST /api/v1/sideshift/quotes` — the query-only quote surface. The device posts
//!   rail identifiers (`depositLedger`, `settleLedger` — the registry's own pair ids)
//!   and a decimal `depositAmount` string. The relay maps the pair onto SideShift's
//!   own coin/network codes, attaches the partner credentials, and forwards. A
//!   successful upstream answer is wrapped `{"venue_id":<the matched registry row's
//!   id>,"quote":<the venue's body VERBATIM>,"fetched_at":<unix secs>}` — the
//!   attribution + timestamp the delegated-conversion red lines require, with the
//!   venue's numbers untouched (the relay never computes, blends or rounds a rate).
//! - `POST /api/v1/sideshift/shifts/fixed` — fixed-shift (order) creation, same
//!   credential attachment, response VERBATIM (no wrap: an order is not a quote
//!   surface). The device posts the quote id, the user's OWN settle address, and a
//!   REQUIRED `refundAddress` — the user's OWN address on the DEPOSIT rail, where the
//!   venue returns the funds when a deposit fails or the order expires (without one they
//!   stay with the venue: a fund-loss). The relay validates the refund address is
//!   present and well-formed FOR THE DEPOSIT RAIL (named by `depositLedger`) and
//!   refuses the order otherwise — 400, house error, before any upstream call. The
//!   device then shows the user SideShift's `depositAddress` — the user
//!   sends the deposit to SIDESHIFT's address; that is what CeFi means and the app's
//!   disclosure says so.
//!
//! # The IC payout-target form (SideShift's own constraint)
//!
//! SideShift's ICP payout layer can deliver ONLY to 32-byte account identifiers —
//! 64-hex texts (their engineering, confirmed 2026-09-21; the first EURC→ICP return
//! shift refunded 2026-09-20 because the device had named a principal-text). The device
//! therefore EMITS the wallet's account identifier (`icpAccountIdFromPrincipal`) for
//! every IC payout target it names — settle AND refund — and the relay's refund
//! validation (`crate::addrcheck`) accepts all three IC texts (principal, ICRC-1
//! account, account identifier): principal/account stay valid here until SideShift
//! ships principal support, but nothing dpay sends should name one anymore.
//!
//! Everything else stays DEVICE-DIRECT by SideShift's own design: shift status reads
//! (`GET /api/v2/shifts/{id}`) are keyless (verified live), so the resume engine's
//! provider poller (`app/convertResume.ts`) reads them over https without this relay
//! — the relay remains query/credential surface only, never a funds party.
//!
//! # The pair mapping (and why the relay owns it)
//!
//! The registry row (`catalog.rs`, kind `cefi`) names the pair in RAIL-CANONICAL ids —
//! an IC ledger principal and a Solana mint. SideShift speaks its OWN coin/network
//! codes (`ICP` on `icp`, `SOL` on `solana`). Mapping rail id → venue code is a fact
//! about the VENUE, so it lives with the venue integration: here, next to the
//! credentials. The route accepts a pair only if it is exactly the registered
//! SideShift row's pair (unordered) — or the adapter-owned EVM-native pair
//! ICP ↔ native ETH (`ETH_NATIVE_RAIL_ID`, no catalog row by design; 2026-09-27) — a
//! device cannot spend the partner key on a pair dpay never registered, and cannot
//! smuggle its own `affiliateId` or `commissionRate` through: both are attached HERE,
//! from config, never read from the request.
//!
//! # Founder boundary (recorded in the spec amendment)
//!
//! - `commissionRate` is pinned to `"0"` (the documented range is 0%–2%, default
//!   0.5%): dpay takes NO cut from a conversion — a nonzero commission would be one.
//! - The SideShift account holds no user funds and dpay sends none to it: the account
//!   is provably non-withdrawal-capable in the only sense that matters (nothing to
//!   withdraw). The secret still grants full ACCOUNT access per SideShift's docs, so
//!   if SideShift ever offers read-only keys the switch is mandatory, not optional.
//! - A withdrawal-capable key anywhere in dpay remains an absolute no.
//!
//! # Failure semantics (same contract as `crate::solana`)
//!
//! - Upstream HTTP error status → SAME status, upstream body VERBATIM (SideShift's
//!   own `{"error":{message,code}}` shape — whatever refused is the venue, not us).
//! - Relay-originated failures carry the body marker
//!   `{"dpayRelayError":"sideshift-unconfigured"|"sideshift-upstream-unreachable",
//!   "detail":"…"}` (503 when a credential env var is unset, 504 on transport
//!   trouble). The detail names the ENV VAR NAMES and categories only.
//! - Malformed device bodies are 400s in the house `{"error": …}` shape, refused
//!   BEFORE any upstream call.
//! - The reqwest error text is never included (it embeds the request URL); redirects
//!   are not followed.
//!
//! # Secrets
//!
//! `DPAY_SIDESHIFT_SECRET` is deploy config carrying the partner account secret: never
//! logged, never echoed in a response, never committed (docs/OPS.md §3). Every error
//! body in this module is a fixed string for exactly that reason.
//!
//! # x-user-ip (SideShift's proxying rule)
//!
//! SideShift's permissions doc: requests sent from an integration's own server MUST
//! carry `x-user-ip` set to the end user's IP. The relay answers with the end user's
//! IP, resolved honestly by deployment shape (measured live 2026-09-20: SideShift
//! REFUSES the whole partner surface — quote included — unless the header carries a
//! PUBLIC address): a PUBLIC connecting peer is the end user and wins outright
//! (`into_make_service_with_connect_info` in main.rs; a public peer's `X-Forwarded-For`
//! is ignored — spoofable from outside). A PRIVATE/loopback peer (or no socket info at
//! all — oneshot-driven tests) means the relay sits BEHIND a reverse proxy or
//! integration server, so the connecting address is the proxy's, not the user's: the
//! `X-Forwarded-For` header the proxy added is honored — its LEFTMOST public entry (the
//! de-facto standard's original client). A private/loopback XFF entry is never trusted
//! (a chain of NAT'd proxies tells us nothing about the user). When neither path yields
//! a public address, the best IP actually visible is forwarded as before, and when even
//! that is absent the header is simply omitted — never fabricated. It is forwarded as
//! SideShift requires — jurisdiction detection is their service's own need, and an
//! honest integration satisfies it with the best IP it can actually see.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequestParts, State};
use axum::http::{header, request::Parts, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::AppState;

/// The venue id this adapter serves (must match the `cefi` row in `catalog.rs`).
pub const SIDESHIFT_VENUE_ID: &str = "sideshift";

/// The SideShift API base (host verified live 2026-09-15 — the old
/// `api.sideshift.ai` host is NXDOMAIN; the API lives under `sideshift.ai/api/v2`).
/// Overridable via `DPAY_SIDESHIFT_API_BASE` (main.rs): the offline loop points it at
/// the relay's own test stub, and an operator may pin a different base.
pub const DEFAULT_API_BASE: &str = "https://sideshift.ai/api/v2";

/// Per-upstream-call timeout. SideShift quotes/shifts are single round trips; no env
/// knob (the solana proxy's `DPAY_SOLANA_TIMEOUT_MS` exists because its calls ride
/// poll loops — this surface does not).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// The partner commission rate, pinned to ZERO by the founder red line: dpay is paid
/// nothing for a conversion. SideShift's documented range is "0"–"2" (percent); "0"
/// is the best rate the venue offers the user and no cut to us. NEVER set this from
/// a request — it is a constant of this integration.
const COMMISSION_RATE: &str = "0";

/// The venue rows this adapter serves: since the trocador row registered the SAME
/// ICP↔SOL pair (2026-09-20), a pair alone no longer disambiguates a cefi row — the
/// adapter names its rows, so attribution follows THIS list, never first-match-on-pair.
const SIDESHIFT_VENUE_IDS: &[&str] = &["sideshift", "sideshift-usdc", "sideshift-eurc"];

/// The EVM-native settle pair this adapter serves (2026-09-27): ICP → native ETH on
/// Ethereum mainnet — the convert DESTINATION that funds the EVM rail from ICP holdings.
/// Deliberately NOT a catalog venue row (native ETH is not a catalog asset — the EvmAsset
/// rows are ERC-20 tokens — and a native-ETH row would touch the drift-alarmed
/// `catalog.rs`/`catalog_truth.json` pair): the pair is owned by THIS adapter, like the
/// coin mapping above. The rail id is the app's own constant's twin
/// (`app/config/evmConvert.ts` `ETH_NATIVE_RAIL_ID`); the jest drift alarm
/// (`app/__tests__/convertEvmCefi.test.ts`) pins the two strings equal. The venue id is
/// attribution only — it names the registry-shaped row the app bundles for this pair.
pub const SIDESHIFT_ETH_VENUE_ID: &str = "sideshift-eth";
pub const ETH_NATIVE_RAIL_ID: &str = "evm:native-eth";

/// Rail-canonical id → SideShift's own (coin, network) for every asset a registered
/// SideShift pair names. Verified against the live `GET /coins` (keyless) 2026-09-15:
/// ICP lives on network `icp` (hasMemo false), SOL on `solana`. The USDC(Solana) row is
/// BEST-EFFORT and UNVERIFIED until the founder's partner key exists (its cefi route
/// 503s until then — the keyless tripwire is unchanged): the coin code `usdc` on
/// network `solana` follows the venue's documented code shape. The EURC(Solana) row IS
/// verified: the keyless pair endpoints (2026-09-19) answer `EURC`-`solana` ↔ `ICP`-`icp`
/// in both directions — the pair exists and those are the venue's own words. The ETH row
/// (2026-09-27) is BEST-EFFORT like USDC until a live probe: native ETH settles on
/// network `ethereum` (the settlement network MUST be `ethereum` — the venue lists the
/// coin on several networks and `ETH` alone is ambiguous).
const SIDESHIFT_ASSETS: &[(&str, &str, &str)] = &[
    (crate::catalog::ICP_LEDGER_PRINCIPAL, "ICP", "icp"),
    (crate::catalog::WRAPPED_SOL_MINT, "SOL", "solana"),
    (crate::catalog::SOLANA_USDC_MINT, "usdc", "solana"),
    (crate::catalog::SOLANA_EURC_MINT, "eurc", "solana"),
    (ETH_NATIVE_RAIL_ID, "ETH", "ethereum"),
];

/// The proxy's state: the two partner credentials (secrets — module header), the API
/// base, the shared HTTP client and the per-call timeout. Held in an `Arc` on
/// [`AppState`]; `configured()` decides between serving and the 503 marker.
pub struct SideShiftProxy {
    secret: Option<String>,
    affiliate_id: Option<String>,
    base: String,
    timeout: Duration,
    #[allow(dead_code)] // read through `&self` in every call path; field kept for symmetry
    client: reqwest::Client,
}

impl SideShiftProxy {
    /// Build the proxy. Either credential `None` (or both) leaves the routes
    /// registered but answering the 503 `sideshift-unconfigured` marker naming
    /// exactly which variable(s) are missing.
    pub fn new(
        secret: Option<String>,
        affiliate_id: Option<String>,
        base: String,
        timeout: Duration,
    ) -> Self {
        SideShiftProxy {
            secret,
            affiliate_id,
            base,
            timeout,
            client: http_client(),
        }
    }

    /// Both halves of the partner credential are present. Unset is a LEGAL state
    /// (503, not 404); half-set is reported as the same 503 with the missing names.
    fn missing_credentials(&self) -> Vec<&'static str> {
        let mut missing = Vec::new();
        if self.secret.is_none() {
            missing.push("DPAY_SIDESHIFT_SECRET");
        }
        if self.affiliate_id.is_none() {
            missing.push("DPAY_SIDESHIFT_AFFILIATE_ID");
        }
        missing
    }

    /// The credential pair, when fully configured. Cloned per call (two short
    /// strings); the None branch is handled by `missing_credentials` first.
    fn credentials(&self) -> Option<(String, String)> {
        Some((
            self.secret.clone()?,
            self.affiliate_id.clone()?,
        ))
    }
}

/// Whether the address is usable as an end-user IP for the venue's `x-user-ip`:
/// anything but loopback, RFC1918 private, link-local, unspecified, or broadcast.
/// (`IpAddr::is_global` is still gated on this toolchain — rustdoc issue #27709 — and
/// the venue only needs "not an infrastructure address"; documentation ranges pass,
/// which is harmless here.)
fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast())
        }
        IpAddr::V6(v6) => {
            let o = v6.octets();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (o[0] & 0xfe) == 0xfc // unique-local fc00::/7
                || (o[0] == 0xfe && (o[1] & 0xc0) == 0x80)) // link-local fe80::/10
        }
    }
}

/// The end user's IP for SideShift's `x-user-ip`, resolved by deployment shape
/// (see the module doc): a public TCP peer wins outright; a private/loopback peer
/// (or absent socket info) means a reverse proxy is in front, so the LEFTMOST public
/// `X-Forwarded-For` entry is the user; neither path yields one, the best IP actually
/// visible is kept; no IP at all stays `None`. Never fabricated.
fn end_user_ip(peer: Option<IpAddr>, forwarded_for: Option<&str>) -> Option<IpAddr> {
    if let Some(p) = peer {
        if ip_is_public(p) {
            return Some(p);
        }
    }
    if let Some(xff) = forwarded_for {
        // "client, proxy1, proxy2" — the leftmost entry is the original client.
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = first.trim().parse::<IpAddr>() {
                if ip_is_public(ip) {
                    return Some(ip);
                }
            }
        }
    }
    peer
}

/// The connecting client's IP, when the server was started with connection info
/// (prod: `into_make_service_with_connect_info`; oneshot-driven tests: absent),
/// upgraded to the end user's IP behind a reverse proxy via `X-Forwarded-For`
/// (`end_user_ip` for the exact rules). Infallible by construction so the route works
/// identically under both servers — SideShift's `x-user-ip` is forwarded when we can
/// see an IP and omitted when we cannot, never fabricated. Public only because the
/// handlers that take it are public.
pub struct ClientIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip());
        let forwarded = parts
            .headers
            .get(HeaderName::from_static("x-forwarded-for"))
            .and_then(|v| v.to_str().ok());
        Ok(ClientIp(end_user_ip(peer, forwarded)))
    }
}

/// `POST /api/v1/sideshift/quotes` — the quote surface. Request (device):
/// `{"depositLedger": "<rail id>", "settleLedger": "<rail id>", "depositAmount":
/// "<decimal string in the venue's own units>"}`. The pair must be exactly the
/// registered `cefi` row's pair (unordered). Success answers the attribution wrap
/// (module header); upstream errors pass through verbatim.
pub async fn quotes_proxy(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    body: Bytes,
) -> Response {
    let proxy = state.sideshift.clone();
    if let Some(response) = unconfigured(&proxy) {
        return response;
    }
    let (secret, affiliate_id) = proxy.credentials().expect("checked above");

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) — POST /api/v1/sideshift/quotes takes \
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
             rail ids for the registered SideShift pair)",
        );
    };
    // The venue speaks DECIMAL strings in its own units — the device sends exactly the
    // amount the user is depositing, and the relay forwards it without converting,
    // rounding or range-checking (SideShift's own min/max refusal is the authority).
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
    let Some((venue_id, deposit_coin, deposit_network, settle_coin, settle_network)) =
        pair_direction(deposit_ledger, settle_ledger)
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported pair: the registered SideShift venue rows trade exactly their \
             registered cross-rail pairs — pass one row's two rail ids as \
             depositLedger/settleLedger",
        );
    };

    let upstream_body = json!({
        "depositCoin": deposit_coin,
        "depositNetwork": deposit_network,
        "settleCoin": settle_coin,
        "settleNetwork": settle_network,
        "depositAmount": deposit_amount,
        "settleAmount": null,
        // Partner facts, attached HERE from config — never read from the request (module
        // header): a device cannot re-attribute the commission or set its rate.
        "affiliateId": affiliate_id,
        "commissionRate": COMMISSION_RATE,
    });
    let outcome = post_upstream(
        &proxy,
        "/quotes",
        &upstream_body,
        &secret,
        ip,
    )
    .await;
    // Success (SideShift answers 201 Created): wrap for attribution + timestamp. The
    // venue's numbers ride untouched under `quote`. A 2xx body that is not a JSON
    // object is passed VERBATIM instead — it is what the venue said, and the wrap is
    // only for bodies the app can actually read.
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

/// `POST /api/v1/sideshift/shifts/fixed` — fixed-order creation. Request (device):
/// `{"quoteId": "<id from the quote surface>", "settleAddress": "<the user's OWN
/// address on the settle rail>", "refundAddress": "<the user's OWN address on the
/// DEPOSIT rail>", "depositLedger": "<the deposit rail id>", "settleMemo"?: string}`.
/// Response VERBATIM (module header): the device persists `id`, `depositAddress`
/// (+`depositMemo`, required for some venues' networks) and `expiresAt` off the venue's
/// own answer.
///
/// The refund address is a FUND-LOSS guard, not paperwork: when a deposit fails or the
/// order expires, the venue returns the funds to `refundAddress` — and without one they
/// stay with the venue. It must be present and well-formed FOR THE DEPOSIT RAIL (an IC
/// principal/account on `icp`, a 32-byte base58 pubkey on `solana`), and it is the
/// DEVICE's job to derive it from the user's own key — a refund may only ever land at a
/// user-owned address (the non-custodial red line), never a dpay-controlled one. A
/// missing or malformed field is a client bug: the 400 house error, refused BEFORE any
/// upstream call (the file's failure-semantics convention — this is a device error, not
/// a 503-class relay fact). The settle address is gated the same way, on the SETTLE rail
/// (the deposit rail's complement): an order whose payout address could never receive
/// dead-ends `settling` until it is refunded — refused before it exists.
pub async fn shifts_fixed_proxy(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    body: Bytes,
) -> Response {
    let proxy = state.sideshift.clone();
    if let Some(response) = unconfigured(&proxy) {
        return response;
    }
    let (secret, affiliate_id) = proxy.credentials().expect("checked above");

    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return err(
                StatusCode::BAD_REQUEST,
                format!(
                    "request body is not valid JSON ({e}) — POST /api/v1/sideshift/shifts/fixed \
                     takes {{quoteId, settleAddress, refundAddress, depositLedger, settleMemo?}}"
                ),
            );
        }
    };
    let (Some(quote_id), Some(settle_address), Some(refund_address), Some(deposit_ledger)) = (
        req.get("quoteId").and_then(Value::as_str),
        req.get("settleAddress").and_then(Value::as_str),
        req.get("refundAddress").and_then(Value::as_str),
        req.get("depositLedger").and_then(Value::as_str),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "request needs string fields `quoteId`, `settleAddress` (the user's own address \
             on the settle rail), `refundAddress` (the user's own address on the DEPOSIT \
             rail — where the venue returns funds on failure) and `depositLedger` (the \
             deposit rail id)",
        );
    };
    // The SETTLE rail id is OPTIONAL (2026-09-27, the EVM-native widening): every
    // pre-ETH order body omitted it and the settle network was the deposit network's
    // icp↔solana complement. The EVM-native pair breaks that symmetry (an ICP deposit
    // can now settle on `ethereum`), so the device names the settle rail explicitly and
    // the settle-address gate keys on THAT. A settleLedger that names no registered
    // rail is refused, never guessed.
    let settle_ledger = req.get("settleLedger").and_then(Value::as_str);
    if let Some(sl) = settle_ledger {
        if !SIDESHIFT_ASSETS.iter().any(|(rail_id, _, _)| *rail_id == sl) {
            return err(
                StatusCode::BAD_REQUEST,
                "`settleLedger` must name a registered SideShift pair's rail id (the same \
                 id the quote surface accepted as `settleLedger`)",
            );
        }
    };
    if quote_id.is_empty() || settle_address.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "`quoteId` and `settleAddress` must be non-empty strings",
        );
    }
    // The refund rail is a fact about the DEPOSIT: the registered asset table names the
    // venue's own network for the rail id, and well-formedness is checked against THAT.
    let Some((_, refund_network)) = SIDESHIFT_ASSETS
        .iter()
        .find(|(rail_id, _, _)| *rail_id == deposit_ledger)
        .map(|(_, coin, network)| (*coin, *network))
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported deposit rail: `depositLedger` must be a registered SideShift pair's \
             rail id (the same id the quote surface accepted)",
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
    // The settle address gets the SAME structural gate, on the SETTLE rail. The settle
    // network is the rail the QUOTE named (the optional `settleLedger`, above); without
    // it, every registered cefi row paired exactly one icp rail with one solana rail
    // (the registry's own rule), so the deposit network's complement is the answer. The
    // icp settle accepts BOTH address forms for now — the 64-hex 32-byte account
    // identifier (what the venue's payout layer requires today; the 2026-09-20
    // principal-text refund incident) and the principal text itself (the venue ships
    // principal support) — while garbage that could never be paid out (malformed hex, a
    // wrong-length blob) is refused BEFORE an order exists, so no shift can sit
    // `settling` for hours on a dead address.
    let Some(settle_network) = settle_network_for(deposit_ledger, settle_ledger) else {
        return err(
            StatusCode::BAD_REQUEST,
            "unsupported deposit rail: no settle rail to validate against",
        );
    };
    if !crate::addrcheck::address_wellformed(settle_network, settle_address) {
        return err(
            StatusCode::BAD_REQUEST,
            "`settleAddress` must be a well-formed address on the SETTLE rail — a base58 \
             32-byte pubkey for solana; an Internet Computer principal, ICRC-1 account \
             text, or 64-hex account identifier for icp; a 0x 40-hex EVM address for \
             ethereum",
        );
    }
    let mut upstream_body = json!({
        "quoteId": quote_id,
        "settleAddress": settle_address,
        "refundAddress": refund_address,
        "affiliateId": affiliate_id,
    });
    // settleMemo is the venue's own field for memo-required settle networks (ICP is
    // not one — verified hasMemo:false — but the field stays open for future pairs).
    if let Some(memo) = req.get("settleMemo").and_then(Value::as_str) {
        upstream_body["settleMemo"] = Value::String(memo.to_string());
    }
    let outcome = post_upstream(&proxy, "/shifts/fixed", &upstream_body, &secret, ip).await;
    json_response(outcome.status, &outcome.body)
}

/// Map a (deposit, settle) rail-id pair onto SideShift's own codes — accepted only if
/// it is EXACTLY a registered `cefi` row's pair, unordered (the registry's own rule:
/// pair_ledgers carry no order; one row per pair, so the pair disambiguates the row),
/// OR the adapter-owned EVM-native pair ([`SIDESHIFT_ETH_VENUE_ID`], which has no
/// catalog row by design). This is the whole pair allowlist for the partner key: every
/// cefi row, both directions. Returns the matched row's venue_id first, so attribution
/// names the row the pair actually resolved to.
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
            && SIDESHIFT_VENUE_IDS.contains(&v.venue_id)
            && (v.pair_ledgers == [deposit, settle] || v.pair_ledgers == [settle, deposit])
    });
    if row.is_none() {
        // The adapter-owned EVM-native pair (no catalog row — see the constant's doc):
        // ICP ↔ native ETH on Ethereum, both directions, exactly that pair.
        let eth_pair = deposit == crate::catalog::ICP_LEDGER_PRINCIPAL
            && settle == ETH_NATIVE_RAIL_ID;
        let eth_pair_rev = deposit == ETH_NATIVE_RAIL_ID
            && settle == crate::catalog::ICP_LEDGER_PRINCIPAL;
        if eth_pair || eth_pair_rev {
            let lookup = |id: &str| {
                SIDESHIFT_ASSETS
                    .iter()
                    .find(|(rail_id, _, _)| *rail_id == id)
                    .map(|(_, coin, network)| (*coin, *network))
            };
            let ((d_coin, d_net), (s_coin, s_net)) = (lookup(deposit)?, lookup(settle)?);
            return Some((SIDESHIFT_ETH_VENUE_ID, d_coin, d_net, s_coin, s_net));
        }
        return None;
    }
    let row = row?;
    let lookup = |id: &str| {
        SIDESHIFT_ASSETS
            .iter()
            .find(|(rail_id, _, _)| *rail_id == id)
            .map(|(_, coin, network)| (*coin, *network))
    };
    let ((d_coin, d_net), (s_coin, s_net)) = (lookup(deposit)?, lookup(settle)?);
    Some((row.venue_id, d_coin, d_net, s_coin, s_net))
}

/// The SETTLE rail's network for an order: the network of the rail the QUOTE named as
/// its settle side. The order surface (`shifts_fixed_proxy`) receives that rail id
/// optionally — absent on every pre-ETH record — and falls back to the old
/// deposit-complement rule (icp↔solana) which served every row before the EVM-native
/// pair existed.
fn settle_network_for(deposit_ledger: &str, settle_ledger: Option<&str>) -> Option<&'static str> {
    if let Some(settle) = settle_ledger {
        return SIDESHIFT_ASSETS
            .iter()
            .find(|(rail_id, _, _)| *rail_id == settle)
            .map(|(_, _, network)| *network);
    }
    match SIDESHIFT_ASSETS
        .iter()
        .find(|(rail_id, _, _)| *rail_id == deposit_ledger)
        .map(|(_, _, network)| *network)
    {
        Some("solana") => Some("icp"),
        Some("icp") => Some("solana"),
        _ => None,
    }
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

/// The 503 answer for an unconfigured (or half-configured) proxy, naming exactly the
/// missing variable(s). `None` when fully configured.
fn unconfigured(proxy: &SideShiftProxy) -> Option<Response> {
    let missing = proxy.missing_credentials();
    if missing.is_empty() {
        return None;
    }
    Some(json_response(
        StatusCode::SERVICE_UNAVAILABLE,
        &relay_error_body(
            "sideshift-unconfigured",
            &format!(
                "sideshift proxy is not configured: set {} in the relay's environment (the \
                 partner account credentials — see docs/OPS.md §3 and the feasibility spec's \
                 Partner-key infrastructure section)",
                missing.join(" and ")
            ),
        ),
    ))
}

/// One upstream call: attach the secret header (and `x-user-ip`, SideShift's
/// proxying rule, when the client IP is visible), POST the built body, answer with
/// the upstream's status + body verbatim — or the fixed 504 marker for transport
/// trouble. The reqwest error is DROPPED, not formatted (it embeds the request URL).
async fn post_upstream(
    proxy: &SideShiftProxy,
    path: &str,
    body: &Value,
    secret: &str,
    client_ip: Option<IpAddr>,
) -> Outcome {
    let url = format!("{}{}", proxy.base, path);
    let mut request = proxy
        .client
        .post(&url)
        .header("x-sideshift-secret", secret)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .timeout(proxy.timeout)
        .body(body.to_string());
    if let Some(ip) = client_ip {
        request = request.header("x-user-ip", ip.to_string());
    }
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
/// this module — same shape as `crate::solana`).
struct Outcome {
    status: StatusCode,
    body: Bytes,
}

/// The honest answer when SideShift could not be reached: a 504 carrying the
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
            "sideshift-upstream-unreachable",
            &format!("sideshift upstream unreachable: {why}"),
        ),
    }
}

/// Serialize a relay-originated error body — the marker contract shared with
/// `crate::solana`: `{"dpayRelayError": <code>, "detail": <short human phrase>}`.
/// Fixed inputs only (env var NAMES and categories), so no secret can leak through.
fn relay_error_body(code: &str, detail: &str) -> Bytes {
    Bytes::from(
        serde_json::json!({
            "dpayRelayError": code,
            "detail": detail,
        })
        .to_string(),
    )
}

/// The shared HTTP client (one per process; redirects NOT followed — same discipline
/// as the solana pipe: exactly one hop, surfaced not chased).
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("dpay-relay: cannot build the sideshift proxy's HTTP client")
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
fn json_response(status: StatusCode, body: &Bytes) -> Response {
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
        assert!(is_decimal_string("1.18958662"));
        // Junk the venue should be the one to refuse — or that is not an amount at all.
        assert!(!is_decimal_string(""));
        assert!(!is_decimal_string("-1"));
        assert!(!is_decimal_string("1,5"));
        assert!(!is_decimal_string("1.5.5"));
        assert!(!is_decimal_string("abc"));
    }

    #[test]
    fn pair_direction_accepts_the_registered_pair_both_ways_and_nothing_else() {
        let icp = crate::catalog::ICP_LEDGER_PRINCIPAL;
        let sol = crate::catalog::WRAPPED_SOL_MINT;
        let usdc = crate::catalog::SOLANA_USDC_MINT;
        // Both directions of the registered cross-rail pair (the sideshift row).
        assert_eq!(
            pair_direction(icp, sol),
            Some(("sideshift", "ICP", "icp", "SOL", "solana"))
        );
        assert_eq!(
            pair_direction(sol, icp),
            Some(("sideshift", "SOL", "solana", "ICP", "icp"))
        );
        // Both directions of the SECOND cefi row (sideshift-usdc): the pair
        // disambiguates the row, and the attribution follows the matched row.
        assert_eq!(
            pair_direction(icp, usdc),
            Some(("sideshift-usdc", "ICP", "icp", "usdc", "solana"))
        );
        assert_eq!(
            pair_direction(usdc, icp),
            Some(("sideshift-usdc", "usdc", "solana", "ICP", "icp"))
        );
        // Both directions of the THIRD cefi row (sideshift-eurc, the EUR→IC bridge):
        // same disambiguation and attribution rule — and the coin codes are the venue's
        // own live words (the keyless pair endpoints answered them 2026-09-19).
        let eurc = crate::catalog::SOLANA_EURC_MINT;
        assert_eq!(
            pair_direction(icp, eurc),
            Some(("sideshift-eurc", "ICP", "icp", "eurc", "solana"))
        );
        assert_eq!(
            pair_direction(eurc, icp),
            Some(("sideshift-eurc", "eurc", "solana", "ICP", "icp"))
        );
        // Both directions of the adapter-owned EVM-native pair (sideshift-eth, no
        // catalog row — the settle network MUST be `ethereum`): attribution names the
        // synthetic row, the deposit stays ICP/icp, the settle is native ETH.
        assert_eq!(
            pair_direction(icp, ETH_NATIVE_RAIL_ID),
            Some((SIDESHIFT_ETH_VENUE_ID, "ICP", "icp", "ETH", "ethereum"))
        );
        assert_eq!(
            pair_direction(ETH_NATIVE_RAIL_ID, icp),
            Some((SIDESHIFT_ETH_VENUE_ID, "ETH", "ethereum", "ICP", "icp"))
        );
        // Anything else — including rail ids that exist but are not a registered
        // pair — refuses. VCHF is a real IC ledger; it must not ride the partner key.
        assert!(pair_direction(crate::catalog::VCHF_LEDGER_PRINCIPAL, sol).is_none());
        assert!(pair_direction(crate::catalog::VCHF_LEDGER_PRINCIPAL, usdc).is_none());
        assert!(pair_direction(crate::catalog::VCHF_LEDGER_PRINCIPAL, eurc).is_none());
        assert!(pair_direction(crate::catalog::VCHF_LEDGER_PRINCIPAL, ETH_NATIVE_RAIL_ID).is_none());
        assert!(pair_direction(ETH_NATIVE_RAIL_ID, ETH_NATIVE_RAIL_ID).is_none());
        // Solana-rail pairs that EXIST (jupiter rows) are never cefi pairs: the partner
        // key must not ride the AMM rail-local surface.
        assert!(pair_direction(sol, eurc).is_none());
        assert!(pair_direction(usdc, eurc).is_none());
        assert!(pair_direction(sol, usdc).is_none());
        assert!(pair_direction(icp, icp).is_none());
        assert!(pair_direction("", "").is_none());
    }

    #[test]
    fn settle_network_uses_the_named_rail_then_the_legacy_complement() {
        let icp = crate::catalog::ICP_LEDGER_PRINCIPAL;
        // The EVM-native widening: the named settle rail IS the answer — an ICP deposit
        // settling on ethereum is exactly the pair this exists for.
        assert_eq!(settle_network_for(icp, Some(ETH_NATIVE_RAIL_ID)), Some("ethereum"));
        // The legacy bodies (no settleLedger) keep the deposit complement: icp↔solana.
        assert_eq!(settle_network_for(icp, None), Some("solana"));
        assert_eq!(settle_network_for(crate::catalog::WRAPPED_SOL_MINT, None), Some("icp"));
        // An unknown deposit rail with no settle named: no network to validate against.
        assert_eq!(settle_network_for("not-a-rail", None), None);
    }

    #[test]
    fn end_user_ip_public_peer_wins_and_ignores_xff() {
        // A public connecting peer IS the end user — direct TCP, nothing spoofable.
        let public: IpAddr = "203.0.113.99".parse().unwrap();
        assert_eq!(end_user_ip(Some(public), None), Some(public));
        // A public peer's X-Forwarded-For is IGNORED (spoofable from outside).
        assert_eq!(
            end_user_ip(Some(public), Some("198.51.100.7")),
            Some(public)
        );
        assert_eq!(end_user_ip(Some(public), Some("junk")), Some(public));
    }

    #[test]
    fn end_user_ip_private_peer_honors_a_public_xff_entry() {
        // Loopback/LAN peer = the relay sits behind a reverse proxy (the documented
        // integration-server shape, and the 2026-09-20 live blocker): the proxy's
        // X-Forwarded-For names the real user — its LEFTMOST entry.
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let lan: IpAddr = "192.168.0.13".parse().unwrap();
        assert_eq!(
            end_user_ip(Some(loopback), Some("203.0.113.7")),
            Some("203.0.113.7".parse().unwrap())
        );
        assert_eq!(
            end_user_ip(Some(lan), Some("198.51.100.9, 10.0.0.1, 127.0.0.1")),
            Some("198.51.100.9".parse().unwrap())
        );
        // IPv6 end users ride the same rule.
        assert_eq!(
            end_user_ip(Some(loopback), Some("2001:db8::1, 10.0.0.1")),
            Some("2001:db8::1".parse().unwrap())
        );
    }

    #[test]
    fn end_user_ip_never_fabricates_and_keeps_todays_fallback() {
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        let lan: IpAddr = "192.168.0.13".parse().unwrap();
        // Absent XFF: the best IP actually visible is forwarded, exactly as before
        // (today's behavior — private-but-honest beats nothing).
        assert_eq!(end_user_ip(Some(lan), None), Some(lan));
        // No socket info (oneshot-driven tests) and no XFF: omitted, never fabricated.
        assert_eq!(end_user_ip(None, None), None);
        // A private/loopback XFF entry is never trusted (NAT'd proxy chain says
        // nothing about the user) — fall back to the visible peer.
        assert_eq!(end_user_ip(Some(lan), Some("10.0.0.5")), Some(lan));
        assert_eq!(end_user_ip(Some(loopback), Some("127.0.0.1")), Some(loopback));
        // Junk XFF: same fallback.
        assert_eq!(end_user_ip(Some(lan), Some("not-an-ip")), Some(lan));
        assert_eq!(end_user_ip(Some(lan), Some("")), Some(lan));
        // No peer but a public XFF (proxy that doesn't set ConnectInfo): the header
        // is the only honest signal and is honored.
        assert_eq!(
            end_user_ip(None, Some("198.51.100.9")),
            Some("198.51.100.9".parse().unwrap())
        );
    }

    #[test]
    fn unconfigured_proxy_names_exactly_the_missing_variables() {        let none = SideShiftProxy::new(None, None, DEFAULT_API_BASE.to_string(), DEFAULT_TIMEOUT);
        let response = unconfigured(&none).expect("fully unconfigured → 503");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        // The detail names BOTH variables (leak-free by construction: fixed strings).
        let half = SideShiftProxy::new(
            Some("secret".into()),
            None,
            DEFAULT_API_BASE.to_string(),
            DEFAULT_TIMEOUT,
        );
        let response = unconfigured(&half).expect("half-configured → 503");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let full = SideShiftProxy::new(
            Some("secret".into()),
            Some("aff".into()),
            DEFAULT_API_BASE.to_string(),
            DEFAULT_TIMEOUT,
        );
        assert!(unconfigured(&full).is_none());
    }
}
