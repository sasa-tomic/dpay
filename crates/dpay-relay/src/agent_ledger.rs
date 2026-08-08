//! The real settlement path: an [`AgentLedger`] that talks to the dpay canister on a live IC
//! replica via [`ic-agent`]. Same [`Ledger`] trait the relay already orchestrates around
//! (idempotency / retries / health), so the axum app is unchanged — only the seam is swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. The candid surface it drives is exactly the facade canister's:
//!   - `pay        : (blob) -> (variant { Ok : PayReceipt; Err : text })`  [update]
//!   - `balance_of : (blob, nat32) -> (nat64) query`                       [query; display cache]
//!   - `refresh_balances : (blob, vec nat32) -> (variant { Ok : vec BalanceEntry; Err : text })`  [update; authoritative read + cache write, single + batch via the same call]
//!   - `faucet     : (blob, nat32) -> (variant { Ok : nat64; Err : text })`  [update; self-service, fixed amount, rate-limited]
//!   - `transactions_of : (blob, nat32, nat32) -> (vec record {...}) query`
//!
//! The 292-byte signed authorization wire is candid-encoded as a single `blob` argument — identical to
//! what `dpay-canister-tests` does with `encode_one(&wire)`. `balance` and `mint` pass `currency`
//! as a positional `nat32` next to the pubkey `blob`, matching the canister's multi-currency
//! `(pubkey, currency) -> balance` shape.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use ic_agent::Agent;
use serde::Deserialize;

use dpay_core::{Currency, NONCE_LEN, PUBKEY_LEN, SignedAuthorization};

use crate::ledger::{
    CkErc20OnrampParams, CurrencyDescriptor, DepositInfo,
    DepositRefresh, Ledger, LedgerError, MinterFamily, MintedUtxo, PendingUtxo, RampCapability,
    Receipt, TxnRecord, U64String, WithdrawReceipt, WithdrawRequest,
    ckerc20_onramp_from_descriptor,
};

/// Per-call I/O budget for every cross-canister call this ledger makes on the balance-poll path
/// (`balance_of`, `refresh_balances`, `refresh_deposit`). A stalled replica would otherwise wedge
/// the poll loop for the agent's full ~5min expiry before failing; this bound fails the call fast
/// (→ `LedgerError::Transient`, retried by the caller) so a single hung replica can't lock up the
/// 10s-poll liveness loop. Single source of truth — every `tokio::time::timeout` wrap below reads
/// this const. Sized to comfortably fit one poll interval (POLL=10s) while still tolerating a
/// healthy replica's normal round-trip latency.
const CANISTER_CALL_TIMEOUT_SECS: u64 = 10;

/// Bounded staleness window for a displayed balance. ONE background batch `refresh_balances`
/// per window catches facade-bypassing credits for ALL currencies; the rest of the polls hit the
/// fast cached `balance_of` query. Bounds displayed-balance staleness to ~TTL+one-refresh. Tunable.
const BALANCE_TTL_SECS: u64 = 15;

/// Read the settlement currency out of a 292-byte signed-authorization wire (the canister does the
/// same; the relay surfaces it in the receipt so the app can rebuild the `ReceiptClaim`). Falls back
/// to `DEMO_USD` on a malformed wire (which the canister would already have rejected).
fn currency_of_wire(wire: &[u8]) -> Currency {
    SignedAuthorization::from_wire(wire).map(|sa| sa.auth.currency).unwrap_or(dpay_core::DEMO_USD)
}

/// Candid mirror of the canister's `PayReceipt` (byte fields decode as `blob`s → `Vec<u8>`).
/// `block_index`/`settle_ts`/`receipt_sig`/`pubkey` (R2) carry the canister-signed receipt.
#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: Vec<u8>,
    pubkey: Vec<u8>,
}

/// Candid mirror of the canister's `ReceiptView` (the `receipt(nonce)` query return). Same shape as
/// `PayReceipt` MINUS `new_from_balance` (the durable receipt store records the outcome-attestation
/// fields, not the post-settle display balance — that's recoverable via a separate `balance` query).
/// `receipt_sig`/`pubkey` carry the canister-signed outcome so a payer verifies it under `pubkey`.
#[derive(CandidType, Deserialize, Debug)]
struct ReceiptView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    block_index: u64,
    settle_ts: u64,
    receipt_sig: Vec<u8>,
    pubkey: Vec<u8>,
}

/// Candid mirror of the canister's `TxnView` (one settled transaction row in the history list). The
/// canister decodes its fixed 32-byte name/memo fields to candid `text` (NUL-trimmed), so these come
/// back as `String`; the relay copies them straight through into the JSON-shaped [`TxnRecord`].
#[derive(CandidType, Deserialize, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
    from_name: String,
    to_name: String,
    memo: String,
}

/// Candid mirror of the canister's `BalanceEntry` (one entry of the `refresh_balances` result).
/// The refresh decodes these to mark every currency fresh in `last_refresh`.
#[derive(CandidType, Deserialize, Debug)]
struct BalanceEntryMirror {
    currency: u32,
    amount: u64,
}

// --- deposit-surface mirrors (§3.2 of the deposit-integration plan) --------------------------
// The canister's `DepositRefresh`/`DepositInfo` carry the minter's `Nat` block indices, which the
// candid wire format decodes as `candid::Nat`. These mirrors decode the wire faithfully, then the
// trait impls normalize `Nat` → `String` (a `Nat`/`u128` doesn't round-trip cleanly in JSON).

#[derive(CandidType, Deserialize, Debug)]
struct MintedUtxoMirror {
    block_index: Nat,
    amount: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct PendingUtxoMirror {
    value: u64,
    confirmations: u64,
}

#[derive(CandidType, Deserialize, Debug)]
struct DepositRefreshMirror {
    minted: Vec<MintedUtxoMirror>,
    minted_total: u64,
    pending: Vec<PendingUtxoMirror>,
    required_confirmations: u32,
}

#[derive(CandidType, Deserialize, Debug)]
struct DepositInfoMirror {
    min_confirmations: u32,
    deposit_fee: u64,
    deposit_min_amount: Option<u64>,
}

/// Candid mirror of the canister's `WithdrawRequest` (the W2 withdrawal endpoint). Byte fields are
/// `blob`s on the wire; the relay's JSON `WithdrawRequest` carries them as hex, so the trait impl
/// decodes hex → bytes here. Field labels match the canister's struct exactly.
#[derive(CandidType, serde::Serialize)]
struct WithdrawRequestMirror {
    from_pubkey: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    expiry: u64,
    currency: Currency,
    sig: Vec<u8>,
}

/// Candid mirror of the canister's `WithdrawReceipt` (the burn outcome). `block_index` is the ckBTC
/// ledger's burn transaction index.
#[derive(CandidType, Deserialize, Debug)]
struct WithdrawReceiptMirror {
    from: Vec<u8>,
    destination: String,
    amount: u64,
    nonce: Vec<u8>,
    currency: Currency,
    block_index: u64,
}

/// Candid mirror of the canister's `MinterFamily` variant (M0 catalog). The variant labels match the
/// relay's serde [`MinterFamily`] verbatim; the trait impl maps each candid variant to the relay's
/// text-JSON enum.
#[derive(CandidType, Deserialize, Debug)]
enum MinterFamilyMirror {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// Candid mirror of the canister's `RampCapability` variant (MC1 unit 5). Maps to the relay's
/// serde [`RampCapability`].
#[derive(CandidType, Deserialize, Debug)]
enum RampCapabilityMirror {
    Direct,
    Partner,
    Unavailable,
}

/// Candid mirror of the canister's `CurrencyDescriptor` (M0 catalog + MC1 unit 5 authoritative
/// metadata). Principals decode as `candid::Principal`; the trait impl round-trips each through
/// `.to_text()` into the relay's JSON-shaped [`CurrencyDescriptor`].
#[derive(CandidType, Deserialize, Debug)]
struct CurrencyDescriptorMirror {
    currency: u32,
    ledger: Principal,
    mintable: bool,
    minter: Option<Principal>,
    minter_family: Option<MinterFamilyMirror>,
    symbol: Option<String>,
    decimals: Option<u8>,
    wrapper_name: Option<String>,
    backing_symbol: Option<String>,
    network: Option<String>,
    display_decimals: Option<u8>,
    fee: Option<u64>,
    cap: Option<u64>,
    chain_id: Option<u32>,
    token_contract: Option<String>,
    onramp: RampCapabilityMirror,
    offramp: RampCapabilityMirror,
    /// The ckETH gas-ledger principal for a ckERC20 currency (the `withdraw_erc20` dual-ledger path).
    /// `None` for non-ckERC20 families. Appended LAST in the canister's candid record for backward
    /// compat (an older `currencies()` reply without it decodes with this as `None`).
    gas_ledger: Option<Principal>,
}

/// A [`Ledger`] backed by a real IC replica. Owns an [`Agent`] pointed at the replica/gateway URL
/// and the dpay canister's [`Principal`]. Cheap to `clone` semantically via `Arc` at the call site.
///
/// `last_refresh` (an `Arc<Mutex<...>>` so a background task can mutate it) is the
/// per-`(pubkey, currency)` TTL freshness clock for the batch refresh path (see
/// [`Self::any_stale_for`] / [`Self::refresh_balances`] / [`Self::spawn_background_refresh_all`]).
/// [`Ledger::balance`] is a PURE fast cached `balance_of` query (no consensus); the `/balances`
/// handler calls [`Ledger::refresh_all_if_stale`] ONCE after the fan-out, which — when ANY currency
/// for the pubkey is stale (or on cold start) — fires a SINGLE `refresh_balances` UPDATE in the
/// background (never blocking the response) so credits that bypass the facade (direct ICRC transfers
/// + async ckERC20 heartbeat mints) surface within one refresh cycle without waiting for a
/// `pay`/`mint`/`faucet` cache refresh. Collapses the old N per-currency background refreshes into
/// one consensus round.
pub struct AgentLedger {
    agent: Agent,
    canister_id: Principal,
    last_refresh: Arc<Mutex<HashMap<([u8; PUBKEY_LEN], Currency), Instant>>>,
}

impl AgentLedger {
    /// Connect to a **local, non-mainnet** replica at `url` (e.g. PocketIC's HTTP gateway) and
    /// target `canister_id`. Shorthand for [`connect_with`](Self::connect_with) with
    /// `fetch_root_key = true`.
    pub async fn connect(url: &str, canister_id: Principal) -> Result<Self, LedgerError> {
        Self::connect_with(url, canister_id, true).await
    }

    /// Connect to the replica at `url` and target `canister_id`.
    ///
    /// `fetch_root_key` is the **trust root of every reply the relay believes**, so it is an
    /// explicit argument rather than a default:
    ///
    /// * **Local replica / PocketIC → `true` (required).** Each local replica has its own random
    ///   root key; without fetching it the agent verifies replies against the hard-coded mainnet
    ///   key and every call fails.
    /// * **Mainnet (or any replica you don't own) → `false` (required).** [`Agent::fetch_root_key`]
    ///   trusts whatever key the endpoint hands back, which throws away the reply-verification that
    ///   makes a receipt worth anything: a MITM (or a hostile boundary node) could hand us its own
    ///   key and forge "Paid ✓" for a payment that never settled. Off mainnet this is fine because
    ///   we own the replica; on mainnet it is not, so the caller must say so out loud.
    ///
    /// The relay binary derives this from `DPAY_IC_FETCH_ROOT_KEY` and refuses the unsafe
    /// combination (fetch + a known mainnet endpoint) at startup.
    pub async fn connect_with(
        url: &str,
        canister_id: Principal,
        fetch_root_key: bool,
    ) -> Result<Self, LedgerError> {
        let agent = Agent::builder()
            .with_url(url)
            .build()
            .map_err(|e| LedgerError::Transient(format!("agent build: {e}")))?;
        if fetch_root_key {
            agent
                .fetch_root_key()
                .await
                .map_err(|e| LedgerError::Transient(format!("fetch_root_key: {e}")))?;
        }
        Ok(AgentLedger { agent, canister_id, last_refresh: Arc::new(Mutex::new(HashMap::new())) })
    }

    /// Read a balance via a real `balance_of(blob, nat32)` query. Test/demo introspection (mirrors
    /// [`crate::FakeLedger::balance_of`]); not part of the [`Ledger`] trait.
    pub async fn balance_of(
        &self,
        pubkey: &[u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<u64, LedgerError> {
        // Two positional args: the pubkey as a `blob`, the currency tag as a `nat32`. `currency`
        // is `u32` (the `Currency` alias), so `encode_args` emits `nat32` automatically.
        let arg = encode_args((pubkey.to_vec(), currency))
            .map_err(|e| LedgerError::Transient(format!("encode balance arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent.query(&self.canister_id, "balance_of").with_arg(arg).call(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "balance_of timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("balance_of query: {e}")))?;
        decode_one::<u64>(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode balance: {e}")))
    }

    /// AUTHORITATIVE balance via the facade's `refresh_balances(blob, vec nat32) -> Result<vec
    /// BalanceEntry, text>` UPDATE — does a cross-canister `icrc1_balance_of` for each REQUESTED
    /// currency inside ONE update call, writes `BAL_CACHE` for each, and returns the list. Covers
    /// credit paths the cached `balance_of` query can't see (direct ICRC transfers + async ckERC20
    /// heartbeat mints, which land on the ledger WITHOUT invoking the facade). Pass `[currency]`
    /// for a single-currency refresh, every registered id for a batch — same call either way.
    ///
    /// Pure canister-call wrapper (no freshness marking here — the caller owns the TTL clock; see
    /// [`spawn_background_refresh_all`]). Error mapping mirrors `faucet`'s update-call +
    /// `Result<_, String>` shape: a transport/replica failure is `Transient` (503, retried); a
    /// canister-level `Err(text)` is `Rejected` (422, never retried) — in practice the only `Err`
    /// here is a malformed pubkey (deploy-time invariant), since the call moves no value and is
    /// ungated (unknown/retired currency ids are best-effort SKIPPED inside the canister, not
    /// errors).
    async fn refresh_balances(
        &self,
        pubkey: &[u8; PUBKEY_LEN],
        currencies: &[Currency],
    ) -> Result<Vec<BalanceEntryMirror>, LedgerError> {
        let arg = encode_args((pubkey.to_vec(), currencies.to_vec()))
            .map_err(|e| LedgerError::Transient(format!("encode refresh_balances arg: {e}")))?;
        // The call does N inter-canister reads inside one update (~300-600ms for 6 currencies),
        // comfortably under the 10s I/O budget. A stalled replica still fails fast → Transient.
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "refresh_balances")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "refresh_balances timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("refresh_balances update: {e}")))?;
        let result: Result<Vec<BalanceEntryMirror>, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode refresh_balances reply: {e}")))?;
        result.map_err(LedgerError::Rejected)
    }

    /// Fire-and-forget an authoritative [`refresh_balances`](Self::refresh_balances) UPDATE for EVERY
    /// registered currency on a detached tokio task — never blocks the response path. The canister's
    /// `BAL_CACHE` (written by `refresh_balances`/`pay`/`mint`/`faucet`) persists in canister state
    /// across relay restarts, so [`Ledger::balance`] can safely return the fast cached `balance_of`
    /// query immediately; this ONE batch background refresh catches facade-bypassing credits (direct
    /// ICRC transfers + async ckERC20 mints) for ALL currencies within one poll cycle — collapsing the
    /// old N per-currency background spawns into a single update call (one consensus round).
    ///
    /// The unified canister method takes the REQUESTED currency ids (it no longer enumerates ALL
    /// ledgers itself), so this fetches the catalog (`currencies()`) inside the spawned task to get
    /// the full id list, then passes it to `refresh_balances`. `Agent` is `Clone` (its internals are
    /// `Arc`'d, so the clone is cheap) and `Principal` is `Copy`, so the owned snapshot handed to the
    /// spawned task is light. On success, EVERY currency in the reply is marked fresh (the batch just
    /// wrote BAL_CACHE for all); on failure the task logs the pubkey + error (`eprintln!` — no silent
    /// errors) and the entries stay stale, so the next stale poll re-attempts. `refresh_balances` is
    /// idempotent at the canister level, so overlapping tasks on a slow replica are safe (just
    /// wasteful — bounded by the poll interval).
    fn spawn_background_refresh_all(&self, pubkey: [u8; PUBKEY_LEN]) {
        let agent = self.agent.clone();
        let canister_id = self.canister_id;
        let last_refresh = Arc::clone(&self.last_refresh);
        tokio::spawn(async move {
            let ledger = AgentLedger { agent, canister_id, last_refresh };
            // The unified canister method takes the requested currency ids, so enumerate the catalog
            // (the source of truth for which currencies exist). An unreachable canister can't be
            // enumerated → log + give up (the entries stay stale; the next stale poll re-attempts).
            let catalog = match ledger.currencies().await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!(
                        "dpay-relay: background refresh_balances catalog fetch failed for pubkey={}: {e}",
                        hex::encode(pubkey)
                    );
                    return;
                }
            };
            let all_ids: Vec<Currency> = catalog.iter().map(|d| d.currency).collect();
            match ledger.refresh_balances(&pubkey, &all_ids).await {
                Ok(entries) => {
                    // Mark EVERY refreshed currency fresh — the batch just wrote BAL_CACHE for all.
                    let now = Instant::now();
                    let mut map = ledger.last_refresh.lock().unwrap_or_else(|p| p.into_inner());
                    for e in &entries {
                        map.insert((pubkey, e.currency), now);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "dpay-relay: background refresh_balances failed for pubkey={}: {e}",
                        hex::encode(pubkey)
                    );
                }
            }
        });
    }

    /// Whether ANY currency for `pubkey` is stale (or the pubkey has no refreshed entries yet — cold
    /// start). The single gate [`refresh_all_if_stale`] consults to decide whether to fire the batch.
    /// A per-pubkey linear scan of `last_refresh` (process-local, bounded by relay concurrency) —
    /// cheap relative to an IC update call.
    fn any_stale_for(&self, pubkey: [u8; PUBKEY_LEN]) -> bool {
        let map = self.last_refresh.lock().unwrap_or_else(|p| p.into_inner());
        let mut any_entry = false;
        for ((pk, _cur), t) in map.iter() {
            if *pk == pubkey {
                any_entry = true;
                if Instant::now().duration_since(*t).as_secs() >= BALANCE_TTL_SECS {
                    return true;
                }
            }
        }
        // No entries for this pubkey → cold start → stale. Otherwise all entries are fresh.
        !any_entry
    }
}

#[async_trait]
impl Ledger for AgentLedger {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Candid-encode the 292-byte wire as a single `blob` arg (== canister's `pay(blob)`). The
        // currency is read out of the wire by the canister — same as FakeLedger.
        let arg = encode_one(&wire)
            .map_err(|e| LedgerError::Transient(format!("encode pay arg: {e}")))?;

        // Update call, waited to completion. A transport/replica failure is a *transient*
        // infrastructure hiccup — the relay may retry it (the canister's single-use nonce keeps a
        // retry from double-spending even if a prior attempt landed). A canister-level `Err(text)`
        // is a *permanent* policy rejection (bad sig / expired / over-cap / insufficient / nonce
        // reused / malformed) — never retried.
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "pay")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "pay timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("pay update: {e}")))?;

        let result: Result<PayReceipt, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode pay reply: {e}")))?;

        match result {
            Ok(r) => Ok(Receipt {
                from: hex::encode(r.from),
                to: hex::encode(r.to),
                amount: U64String(r.amount),
                nonce: hex::encode(r.nonce),
                new_from_balance: U64String(r.new_from_balance),
                // The currency is read out of the wire by the canister; the relay re-decodes the
                // wire to surface it in the receipt (the app needs it to rebuild the claim). Cheap
                // pure decode, already done by the route — but the agent path decodes here.
                currency: currency_of_wire(&wire),
                block_index: U64String(r.block_index),
                settle_ts: r.settle_ts,
                receipt_sig: hex::encode(r.receipt_sig),
                pubkey: hex::encode(r.pubkey),
            }),
            Err(msg) => Err(LedgerError::Rejected(msg)),
        }
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        // Query-first (MC3 U2). The response path ALWAYS returns the fast cached `balance_of` query
        // (~200ms, no consensus). The authoritative refresh is now a SINGLE batch update fired by the
        // `/balances` handler via [`refresh_all_if_stale`] (ONE `refresh_balances` call for ALL
        // currencies, not a per-currency spawn here) — so this method is a pure fast query. The
        // canister's `BAL_CACHE` (written by `refresh_balances`/`pay`/`mint`/`faucet`) persists
        // across relay restarts, so `balance_of` returns the last-known value immediately; the batch
        // refresh catches direct ICRC transfers that bypass the facade within one poll cycle.
        self.balance_of(&pubkey, currency).await
    }

    async fn refresh_all_if_stale(&self, pubkey: [u8; PUBKEY_LEN]) {
        // The `/balances` handler calls this ONCE after fanning out the per-currency fast queries.
        // If ANY currency for this pubkey is stale (or none have been refreshed yet — cold start),
        // fire ONE batch `refresh_balances` update in the background. Collapses the old N
        // per-currency background spawns into a single consensus round. Fire-and-forget: the spawn
        // returns immediately; the task does the IC round trip and marks every currency fresh.
        if self.any_stale_for(pubkey) {
            self.spawn_background_refresh_all(pubkey);
        }
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        // facade `receipt_pubkey() -> opt blob` (query). `null` (key not yet generated) → empty vec
        // (the relay treats an absent pubkey as "no receipts verifiable yet").
        let reply = self
            .agent
            .query(&self.canister_id, "receipt_pubkey")
            .with_arg(encode_args(()).map_err(|e| LedgerError::Transient(format!("encode pubkey: {e}")))?)
            .call()
            .await
            .map_err(|e| LedgerError::Transient(format!("receipt_pubkey query: {e}")))?;
        let pk: Option<Vec<u8>> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode receipt_pubkey: {e}")))?;
        Ok(pk.unwrap_or_default())
    }

    /// Durable per-nonce receipt lookup via the facade's `receipt(blob) -> opt ReceiptView` query
    /// (MC4 U3). The canister stores a signed receipt per nonce (MC4 U1+U2 ensure one exists for every
    /// settled pay), so this returns `Some` for any nonce that settled — the durable source the relay
    /// falls back to when its process-local idempotency cache can't answer (restart / lost reply).
    ///
    /// `new_from_balance` is NOT carried by `ReceiptView` (the durable store records the outcome
    /// attestation, not the post-settle display balance); it surfaces as `0` on a recovered receipt.
    /// The app re-reads the live balance separately, so this loses no information the payer needs.
    async fn receipt(&self, nonce: [u8; NONCE_LEN]) -> Result<Option<Receipt>, LedgerError> {
        let arg = encode_one(nonce.to_vec())
            .map_err(|e| LedgerError::Transient(format!("encode receipt arg: {e}")))?;
        let reply = self
            .agent
            .query(&self.canister_id, "receipt")
            .with_arg(arg)
            .call()
            .await
            .map_err(|e| LedgerError::Transient(format!("receipt query: {e}")))?;
        let view: Option<ReceiptView> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode receipt: {e}")))?;
        Ok(view.map(|v| Receipt {
            from: hex::encode(v.from),
            to: hex::encode(v.to),
            amount: U64String(v.amount),
            nonce: hex::encode(v.nonce),
            // ReceiptView carries no post-settle balance; 0 is the honest "unknown on recovery" value.
            new_from_balance: U64String(0),
            currency: v.currency,
            block_index: U64String(v.block_index),
            settle_ts: v.settle_ts,
            receipt_sig: hex::encode(v.receipt_sig),
            pubkey: hex::encode(v.pubkey),
        }))
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        // The real canister's `faucet` mints a FIXED constants-sourced amount and ignores this; it
        // is kept in the trait signature so the permissive FakeLedger (demo) can honor it.
        _amount: u64,
    ) -> Result<u64, LedgerError> {
        // facade `faucet(blob, nat32) -> Result<nat64, text>` (update) — the self-service demo
        // on-ramp. No admin gate (the privileged `mint` is controller-only); the canister mints its
        // fixed amount and rate-limits per (account, currency). A canister-level `Err(text)` is a
        // permanent policy rejection ("not mintable", "faucet cooldown") → `Rejected` (422); a
        // transport/replica failure is `Transient` (503, retried).
        let arg = encode_args((to.to_vec(), currency))
            .map_err(|e| LedgerError::Transient(format!("encode faucet args: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "faucet")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "faucet timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("faucet update: {e}")))?;
        let result: Result<u64, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode faucet reply: {e}")))?;
        result.map_err(LedgerError::Rejected)
    }

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        // canister `transactions_of(blob, nat32, nat32) -> (vec record {...}) query`. Reads back the
        // per-(account,currency) history newest-first and maps the candid blob fields to hex strings
        // (matching `Receipt`).
        let arg = encode_args((pubkey.to_vec(), currency, limit))
            .map_err(|e| LedgerError::Transient(format!("encode transactions_of arg: {e}")))?;
        let reply = self
            .agent
            .query(&self.canister_id, "transactions_of")
            .with_arg(arg)
            .call()
            .await
            .map_err(|e| LedgerError::Transient(format!("transactions_of query: {e}")))?;
        let views: Vec<TxnView> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode transactions_of: {e}")))?;
        Ok(views
            .into_iter()
            .map(|v| TxnRecord {
                from: hex::encode(v.from),
                to: hex::encode(v.to),
                amount: U64String(v.amount),
                nonce: hex::encode(v.nonce),
                currency: v.currency,
                timestamp: v.timestamp,
                // The canister already NUL-trimmed the 32-byte fields to candid `text`; pass them
                // through verbatim (names + memo ride from the signed wire into history — N6/H3).
                from_name: v.from_name,
                to_name: v.to_name,
                memo: v.memo,
            })
            .collect())
    }

    async fn healthy(&self) -> bool {
        // Liveness = the replica answers the management canister's read-only `status`. Cheap, and
        // proves the gateway + replica are actually reachable (not just that a socket is open).
        self.agent.status().await.is_ok()
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError> {
        // facade `deposit_address(blob, nat32) -> Result<text, text>` (update). Per the deposit
        // plan's §0 error rule, *any* facade `Err(String)` maps to `Transient` — the deposit
        // endpoints have no permanent-policy failure (no sig, no cap, no replay). The only "config"
        // failure ("no minter for currency") is a deploy-time invariant that also surfaces as 503.
        let arg = encode_args((pubkey.to_vec(), currency))
            .map_err(|e| LedgerError::Transient(format!("encode deposit_address arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "deposit_address")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "deposit_address timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("deposit_address update: {e}")))?;
        let result: Result<String, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode deposit_address reply: {e}")))?;
        result.map_err(LedgerError::Transient)
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        // facade `refresh_deposit(blob, nat32) -> Result<DepositRefresh, text>` (update) → proxies
        // the ck minter's `update_balance`. Decode the candid `Nat` block_index into a `String`
        // (JSON-safe). Any `Err(String)` → `Transient` (§0).
        let arg = encode_args((pubkey.to_vec(), currency))
            .map_err(|e| LedgerError::Transient(format!("encode refresh_deposit arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "refresh_deposit")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "refresh_deposit timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("refresh_deposit update: {e}")))?;
        let result: Result<DepositRefreshMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode refresh_deposit reply: {e}")))?;
        let m = result.map_err(LedgerError::Transient)?;
        Ok(DepositRefresh {
            minted: m
                .minted
                .into_iter()
                .map(|u| MintedUtxo {
                    block_index: u.block_index.to_string(),
                    amount: U64String(u.amount),
                })
                .collect(),
            minted_total: U64String(m.minted_total),
            pending: m
                .pending
                .into_iter()
                .map(|p| PendingUtxo { value: U64String(p.value), confirmations: p.confirmations })
                .collect(),
            required_confirmations: m.required_confirmations,
        })
    }

    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError> {
        // facade `deposit_info(nat32) -> Result<DepositInfo, text>` (update) → proxies the minter's
        // `get_minter_info` + `get_deposit_fee`. All mirror fields are primitives, so this is a
        // straight copy. Any `Err(String)` → `Transient` (§0).
        let arg = encode_args((currency,))
            .map_err(|e| LedgerError::Transient(format!("encode deposit_info arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "deposit_info")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "deposit_info timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("deposit_info update: {e}")))?;
        let result: Result<DepositInfoMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode deposit_info reply: {e}")))?;
        let m = result.map_err(LedgerError::Transient)?;
        Ok(DepositInfo {
            min_confirmations: m.min_confirmations,
            deposit_fee: U64String(m.deposit_fee),
            deposit_min_amount: m.deposit_min_amount.map(U64String),
        })
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        // facade `currencies() -> vec CurrencyDescriptor` (query). Translate candid mirrors -> the
        // relay's text-principal serde structs. Errors are `Transient` (canister unreachable); there
        // is no permanent-policy failure on the catalog surface.
        let reply = self
            .agent
            .query(&self.canister_id, "currencies")
            .with_arg(encode_args(()).map_err(|e| LedgerError::Transient(format!("encode currencies: {e}")))?)
            .call()
            .await
            .map_err(|e| LedgerError::Transient(format!("currencies query: {e}")))?;
        let list: Vec<CurrencyDescriptorMirror> =
            decode_one(&reply).map_err(|e| LedgerError::Transient(format!("decode currencies: {e}")))?;
        Ok(list
            .into_iter()
            .map(|d| CurrencyDescriptor {
                currency: d.currency,
                ledger: d.ledger.to_text(),
                mintable: d.mintable,
                minter: d.minter.map(|p| p.to_text()),
                minter_family: d.minter_family.map(|f| match f {
                    MinterFamilyMirror::CkBtcUtxo => MinterFamily::CkBtcUtxo,
                    MinterFamilyMirror::CkEthErc20 => MinterFamily::CkEthErc20,
                    MinterFamilyMirror::CkSol => MinterFamily::CkSol,
                }),
                symbol: d.symbol,
                decimals: d.decimals,
                wrapper_name: d.wrapper_name,
                backing_symbol: d.backing_symbol,
                network: d.network,
                display_decimals: d.display_decimals,
                fee: d.fee.map(U64String),
                cap: d.cap.map(U64String),
                chain_id: d.chain_id,
                token_contract: d.token_contract,
                gas_ledger: d.gas_ledger.map(|p| p.to_text()),
                onramp: match d.onramp {
                    RampCapabilityMirror::Direct => RampCapability::Direct,
                    RampCapabilityMirror::Partner => RampCapability::Partner,
                    RampCapabilityMirror::Unavailable => RampCapability::Unavailable,
                },
                offramp: match d.offramp {
                    RampCapabilityMirror::Direct => RampCapability::Direct,
                    RampCapabilityMirror::Partner => RampCapability::Partner,
                    RampCapabilityMirror::Unavailable => RampCapability::Unavailable,
                },
            })
            .collect())
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // MC8 U2: resolve the onramp from the CATALOG descriptor (the live `currencies()` query),
        // not a hardcoded `currency == 2` guard. The descriptor's per-token `token_contract` is the
        // authoritative ERC-20 address; the `helper_address` is the verified mainnet ckETH deposit
        // helper (minter-scoped — ONE constant for ALL ckERC20 tokens). `facade_principal` is the
        // canister this AgentLedger is already pointed at (the depositErc20 `principal` arg). The
        // pure resolver (`ckerc20_onramp_from_descriptor`) is shared with the FakeLedger so the
        // fail-closed gate (no token_contract ⇒ 503, never a USDC fallback) is single-sourced.
        let catalog = self.currencies().await?;
        let desc = catalog.iter().find(|d| d.currency == currency);
        ckerc20_onramp_from_descriptor(desc, self.canister_id.to_text())
    }

    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // facade `withdraw(WithdrawRequest) -> Result<WithdrawReceipt, text>` (update). Decode the
        // JSON request's hex fields → candid `blob`s, matching the canister's struct. A transport /
        // replica failure is `Transient` (503, retried); a canister-level `Err(String)` is a
        // permanent policy rejection (bad sig / expired / below min / insufficient / nonce reused) →
        // `Rejected` (422), mirroring `pay`'s error mapping.
        let from = hex::decode(&req.from)
            .map_err(|e| LedgerError::Rejected(format!("bad from hex: {e}")))?;
        let nonce = hex::decode(&req.nonce)
            .map_err(|e| LedgerError::Rejected(format!("bad nonce hex: {e}")))?;
        let sig = hex::decode(&req.sig)
            .map_err(|e| LedgerError::Rejected(format!("bad sig hex: {e}")))?;
        let mirror = WithdrawRequestMirror {
            from_pubkey: from,
            destination: req.destination,
            amount: req.amount.0,
            nonce,
            expiry: req.expiry,
            currency: req.currency,
            sig,
        };
        let arg = encode_one(&mirror)
            .map_err(|e| LedgerError::Transient(format!("encode withdraw arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "withdraw")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "withdraw timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("withdraw update: {e}")))?;
        let result: Result<WithdrawReceiptMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode withdraw reply: {e}")))?;
        match result {
            Ok(m) => Ok(WithdrawReceipt {
                from: hex::encode(m.from),
                destination: m.destination,
                amount: U64String(m.amount),
                nonce: hex::encode(m.nonce),
                currency: m.currency,
                block_index: U64String(m.block_index),
            }),
            Err(msg) => Err(LedgerError::Rejected(msg)),
        }
    }
}
