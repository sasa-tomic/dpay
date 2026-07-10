//! The real settlement path: an [`AgentLedger`] that talks to the dpay canister on a live IC
//! replica via [`ic-agent`]. Same [`Ledger`] trait the relay already orchestrates around
//! (idempotency / retries / health), so the axum app is unchanged — only the seam is swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. The candid surface it drives is exactly the canister's:
//!   - `pay      : (blob) -> (variant { Ok : PayReceipt; Err : text })`  [update]
//!   - `balance_of : (blob) -> (nat64) query`
//!
//! The 192-byte signed authorization is candid-encoded as a single `blob` argument — identical to
//! what `dpay-canister-tests` does with `encode_one(&wire)`.

use async_trait::async_trait;
use candid::{decode_one, encode_one, CandidType, Principal};
use ic_agent::Agent;
use serde::Deserialize;

use dpay_core::PUBKEY_LEN;

use crate::ledger::{Ledger, LedgerError, Receipt};

/// Candid mirror of the canister's `PayReceipt` (byte fields decode as `blob`s → `Vec<u8>`).
#[derive(CandidType, Deserialize, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

/// A [`Ledger`] backed by a real IC replica. Owns an [`Agent`] pointed at the replica/gateway URL
/// and the dpay canister's [`Principal`]. Cheap to `clone` semantically via `Arc` at the call site.
pub struct AgentLedger {
    agent: Agent,
    canister_id: Principal,
}

impl AgentLedger {
    /// Connect to a **local, non-mainnet** replica at `url` (e.g. PocketIC's HTTP gateway) and
    /// target `canister_id`.
    ///
    /// Calls [`Agent::fetch_root_key`], which is REQUIRED off mainnet: the agent otherwise verifies
    /// replies against the hard-coded mainnet key and every call fails. (Never call this against
    /// mainnet — it would trust whatever key the endpoint hands back.)
    pub async fn connect(url: &str, canister_id: Principal) -> Result<Self, LedgerError> {
        let agent = Agent::builder()
            .with_url(url)
            .build()
            .map_err(|e| LedgerError::Transient(format!("agent build: {e}")))?;
        agent
            .fetch_root_key()
            .await
            .map_err(|e| LedgerError::Transient(format!("fetch_root_key: {e}")))?;
        Ok(AgentLedger { agent, canister_id })
    }

    /// Read a balance via a real `balance_of` query. Test/demo introspection (mirrors
    /// [`crate::FakeLedger::balance_of`]); not part of the [`Ledger`] trait.
    pub async fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN]) -> Result<u64, LedgerError> {
        let arg = encode_one(pubkey.to_vec())
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
        // Candid-encode the 192-byte wire as a single `blob` arg (== canister's `pay(blob)`).
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

    async fn healthy(&self) -> bool {
        // Liveness = the replica answers the management canister's read-only `status`. Cheap, and
        // proves the gateway + replica are actually reachable (not just that a socket is open).
        self.agent.status().await.is_ok()
    }
}
