//! The real settlement path: an [`AgentLedger`] that talks to the dpay canister on a live IC
//! replica via [`ic-agent`]. Same [`Ledger`] trait the relay already orchestrates around
//! (idempotency / retries / health), so the axum app is unchanged — only the seam is swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. The candid surface it drives is exactly the facade canister's:
//!   - `pay        : (blob) -> (variant { Ok : PayReceipt; Err : text })`  [update]
//!   - `balance_of : (blob, nat32) -> (nat64) query`                       [query; display cache]
//!   - `mint       : (blob, nat32, nat64) -> (variant { Ok : nat64; Err : text })`  [update]
//!   - `transactions_of : (blob, nat32, nat32) -> (vec record {...}) query`
//!
//! The 196-byte signed authorization is candid-encoded as a single `blob` argument — identical to
//! what `dpay-canister-tests` does with `encode_one(&wire)`. `balance` and `mint` pass `currency`
//! as a positional `nat32` next to the pubkey `blob`, matching the canister's multi-currency
//! `(pubkey, currency) -> balance` shape.

use async_trait::async_trait;
use candid::{decode_one, encode_args, encode_one, CandidType, Nat, Principal};
use ic_agent::Agent;
use serde::Deserialize;

use dpay_core::{Currency, PUBKEY_LEN};

use crate::ledger::{
    DepositInfo, DepositRefresh, Ledger, LedgerError, MintedUtxo, PendingUtxo, Receipt, TxnRecord,
};

/// Candid mirror of the canister's `PayReceipt` (byte fields decode as `blob`s → `Vec<u8>`).
#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

/// Candid mirror of the canister's `TxnView` (one settled transaction row in the history list).
#[derive(CandidType, Deserialize, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
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

/// A [`Ledger`] backed by a real IC replica. Owns an [`Agent`] pointed at the replica/gateway URL
/// and the dpay canister's [`Principal`]. Cheap to `clone` semantically via `Arc` at the call site.
pub struct AgentLedger {
    agent: Agent,
    canister_id: Principal,
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
        Ok(AgentLedger { agent, canister_id })
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
        let reply = self
            .agent
            .query(&self.canister_id, "balance_of")
            .with_arg(arg)
            .call()
            .await
            .map_err(|e| LedgerError::Transient(format!("balance_of query: {e}")))?;
        decode_one::<u64>(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode balance: {e}")))
    }
}

#[async_trait]
impl Ledger for AgentLedger {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Candid-encode the 196-byte wire as a single `blob` arg (== canister's `pay(blob)`). The
        // currency is read out of the wire by the canister — same as FakeLedger.
        let arg = encode_one(&wire)
            .map_err(|e| LedgerError::Transient(format!("encode pay arg: {e}")))?;

        // Update call, waited to completion. A transport/replica failure is a *transient*
        // infrastructure hiccup — the relay may retry it (the canister's single-use nonce keeps a
        // retry from double-spending even if a prior attempt landed). A canister-level `Err(text)`
        // is a *permanent* policy rejection (bad sig / expired / over-cap / insufficient / nonce
        // reused / malformed) — never retried.
        let reply = self
            .agent
            .update(&self.canister_id, "pay")
            .with_arg(arg)
            .call_and_wait()
            .await
            .map_err(|e| LedgerError::Transient(format!("pay update: {e}")))?;

        let result: Result<PayReceipt, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode pay reply: {e}")))?;

        match result {
            Ok(r) => Ok(Receipt {
                from: hex::encode(r.from),
                to: hex::encode(r.to),
                amount: r.amount,
                nonce: hex::encode(r.nonce),
                new_from_balance: r.new_from_balance,
            }),
            Err(msg) => Err(LedgerError::Rejected(msg)),
        }
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        self.balance_of(&pubkey, currency).await
    }

    async fn mint(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        // facade `mint(blob, nat32, nat64) -> Result<nat64, text>` (update). The facade gates minting
        // behind its governance controller (and settles on the ledger), so it returns a candid
        // variant rather than a bare nat64: a `Rejected` maps to a permanent policy failure. Three
        // positional args: pubkey, currency (encoded as `nat32` since `Currency = u32`), amount.
        let arg = encode_args((to.to_vec(), currency, amount))
            .map_err(|e| LedgerError::Transient(format!("encode mint args: {e}")))?;
        let reply = self
            .agent
            .update(&self.canister_id, "mint")
            .with_arg(arg)
            .call_and_wait()
            .await
            .map_err(|e| LedgerError::Transient(format!("mint update: {e}")))?;
        let result: Result<u64, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode mint reply: {e}")))?;
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
                amount: v.amount,
                nonce: hex::encode(v.nonce),
                currency: v.currency,
                timestamp: v.timestamp,
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
        let reply = self
            .agent
            .update(&self.canister_id, "deposit_address")
            .with_arg(arg)
            .call_and_wait()
            .await
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
        let reply = self
            .agent
            .update(&self.canister_id, "refresh_deposit")
            .with_arg(arg)
            .call_and_wait()
            .await
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
                    amount: u.amount,
                })
                .collect(),
            minted_total: m.minted_total,
            pending: m
                .pending
                .into_iter()
                .map(|p| PendingUtxo { value: p.value, confirmations: p.confirmations })
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
        let reply = self
            .agent
            .update(&self.canister_id, "deposit_info")
            .with_arg(arg)
            .call_and_wait()
            .await
            .map_err(|e| LedgerError::Transient(format!("deposit_info update: {e}")))?;
        let result: Result<DepositInfoMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode deposit_info reply: {e}")))?;
        let m = result.map_err(LedgerError::Transient)?;
        Ok(DepositInfo {
            min_confirmations: m.min_confirmations,
            deposit_fee: m.deposit_fee,
            deposit_min_amount: m.deposit_min_amount,
        })
    }
}
