//! The real settlement path: an [`AgentLedger`] that talks to the dpay canister on a live IC
//! replica via [`ic-agent`]. Same [`Ledger`] trait the relay already orchestrates around
//! (idempotency / retries / health), so the axum app is unchanged — only the seam is swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. The candid surface it drives is exactly the facade canister's:
//!   - `pay        : (blob) -> (variant { Ok : PayReceipt; Err : text })`  [update]
//!   - `balance_of : (blob, nat32) -> (nat64) query`                       [query; display cache]
//!   - `faucet     : (blob, nat32) -> (variant { Ok : nat64; Err : text })`  [update; self-service, fixed amount, rate-limited]
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

use dpay_core::{Currency, PUBKEY_LEN, SignedAuthorization};

use crate::ledger::{
    CKERC20_HELPER_ADDRESS, CKUSDC_ERC20_ADDRESS, CkErc20OnrampParams, CurrencyDescriptor, DepositInfo,
    DepositRefresh, Ledger, LedgerError, MinterFamily, MintedUtxo, PendingUtxo, Receipt, TxnRecord,
    WithdrawReceipt, WithdrawRequest,
};

/// Read the settlement currency out of a 196-byte signed-authorization wire (the canister does the
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

/// Candid mirror of the canister's `WithdrawRequest` (the W2 withdrawal endpoint). Byte fields are
/// `blob`s on the wire; the relay's JSON `WithdrawRequest` carries them as hex, so the trait impl
/// decodes hex → bytes here. Field labels match the canister's struct exactly.
#[derive(CandidType, serde::Serialize)]
struct WithdrawRequestMirror {
    from_pubkey: Vec<u8>,
    btc_address: String,
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
    btc_address: String,
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

/// Candid mirror of the canister's `CurrencyDescriptor` (M0 catalog). Principals decode as
/// `candid::Principal`; the trait impl round-trips each through `.to_text()` into the relay's
/// JSON-shaped [`CurrencyDescriptor`].
#[derive(CandidType, Deserialize, Debug)]
struct CurrencyDescriptorMirror {
    currency: u32,
    ledger: Principal,
    mintable: bool,
    minter: Option<Principal>,
    minter_family: Option<MinterFamilyMirror>,
    symbol: Option<String>,
    decimals: Option<u8>,
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
                // The currency is read out of the wire by the canister; the relay re-decodes the
                // wire to surface it in the receipt (the app needs it to rebuild the claim). Cheap
                // pure decode, already done by the route — but the agent path decodes here.
                currency: currency_of_wire(&wire),
                block_index: r.block_index,
                settle_ts: r.settle_ts,
                receipt_sig: hex::encode(r.receipt_sig),
                pubkey: hex::encode(r.pubkey),
            }),
            Err(msg) => Err(LedgerError::Rejected(msg)),
        }
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        self.balance_of(&pubkey, currency).await
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
        let reply = self
            .agent
            .update(&self.canister_id, "faucet")
            .with_arg(arg)
            .call_and_wait()
            .await
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
            })
            .collect())
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // TODO(M2): fetch from facade/minter at runtime once the canister surfaces ckERC20 onramp
        // config. The verified mainnet constants are correct for ckUSDC today; the runtime-fetch is a
        // documented follow-up (the canister ckERC20 ramp dispatch is not built yet). `facade_principal`
        // is the canister this AgentLedger is already pointed at (the depositErc20 `principal` arg);
        // the helper + ERC-20 addresses are the verified mainnet values single-sourced in ledger.rs.
        if currency == 2 {
            Ok(CkErc20OnrampParams {
                helper_address: CKERC20_HELPER_ADDRESS.to_string(),
                erc20_address: CKUSDC_ERC20_ADDRESS.to_string(),
                facade_principal: self.canister_id.to_text(),
            })
        } else {
            Err(LedgerError::Transient("no ckERC-20 onramp for currency".into()))
        }
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
            btc_address: req.btc_address,
            amount: req.amount,
            nonce,
            expiry: req.expiry,
            currency: req.currency,
            sig,
        };
        let arg = encode_one(&mirror)
            .map_err(|e| LedgerError::Transient(format!("encode withdraw arg: {e}")))?;
        let reply = self
            .agent
            .update(&self.canister_id, "withdraw")
            .with_arg(arg)
            .call_and_wait()
            .await
            .map_err(|e| LedgerError::Transient(format!("withdraw update: {e}")))?;
        let result: Result<WithdrawReceiptMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode withdraw reply: {e}")))?;
        match result {
            Ok(m) => Ok(WithdrawReceipt {
                from: hex::encode(m.from),
                btc_address: m.btc_address,
                amount: m.amount,
                nonce: hex::encode(m.nonce),
                currency: m.currency,
                block_index: m.block_index,
            }),
            Err(msg) => Err(LedgerError::Rejected(msg)),
        }
    }
}
