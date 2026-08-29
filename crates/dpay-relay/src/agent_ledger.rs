//! The real read path: an [`AgentLedger`] that talks to the ICRC ledgers (and, for the
//! faucet/deposit metadata, the dpay facade canister) on a live IC network via [`ic-agent`].
//! Same [`Ledger`] trait the relay serves, so the axum app is unchanged — only the seam is
//! swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. What it drives:
//!   - each ledger's own ICRC-1/ICRC-3 endpoints (free queries, no facade hop, no consensus):
//!     `icrc1_balance_of` for balances and `get_transactions` for history, read at the USER's
//!     principal (the 2026-08-19 IC-rail cutover shape). Ledger principals resolve from the
//!     relay's COMPILED catalog ([`crate::catalog`], sole authority since 2026-08-28 — the
//!     facade's registry is gone and no code path queries it for currencies anymore).
//!   - facade `deposit_info(nat32)` (update, ~60s-TTL cached on the relay — see the method) —
//!     static deposit metadata for the "Add money" sheet.
//!   - the ckETH-family MINTER's `get_minter_info` (query) — the runtime source for the ckERC20
//!     onramp's CkDeposit `helper_address` (falls back to the verified constants, logged).
//!   - the facade's CONTROLLER-GATED `mint` UPDATE, signed with the agent's authenticated
//!     identity when one is installed ([`AgentLedger::connect_with_identity`] — the
//!     `DPAY_CONTROLLER_SEED` production faucet, 2026-08-20). Without an identity the agent is
//!     ANONYMOUS: every method above still works (they are queries / anonymous-safe updates),
//!     only `faucet_mint` will be refused by the canister's `require_admin`.
//!
//! History does NOT come from a facade-maintained index: `transactions_on_ledger` walks the ledger's
//! own transaction log (icrc3-style `get_transactions`) backwards from `log_length` — see the
//! walk's doc below for the budget + archived-blocks semantics.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use candid::{decode_one, encode_args, encode_one, CandidType, Principal, Nat};
use ic_agent::identity::BasicIdentity;
use ic_agent::Agent;
use icrc_ledger_types::icrc1::account::Account;
use icrc_ledger_types::icrc3::blocks::GetBlocksRequest;
use icrc_ledger_types::icrc3::transactions::{GetTransactionsResponse, Transaction};
use num_traits::ToPrimitive;
use serde::Deserialize;

use dpay_core::{Currency, PUBKEY_LEN};

use crate::ledger::{
    CkErc20OnrampParams, DepositInfo, Ledger, LedgerError, TxnRecord, U64String,
    ckerc20_onramp_from_descriptor,
};

/// Per-call I/O budget for every query this ledger makes (balance polls, catalog reads, each
/// history-walk page). A stalled replica would otherwise wedge the poll loop for the agent's full
/// ~5min expiry before failing; this bound fails the call fast (→ `LedgerError::Transient`,
/// retried by the caller) so a single hung replica can't lock up the liveness loop. Single source
/// of truth — every `tokio::time::timeout` wrap below reads this const. Sized to comfortably fit
/// one poll interval (POLL=10s) while still tolerating a healthy replica's normal round-trip
/// latency.
const CANISTER_CALL_TIMEOUT_SECS: u64 = 10;

/// Timeout for the facade `deposit_info` update (it proxies the ck-minter's `get_minter_info` +
/// `get_deposit_fee`, which can perform Bitcoin indexing — an inter-canister call whose
/// latency shows up at 7–15s on mainnet, well past the 10s default). 30s gives ample headroom for
/// the slowest healthy minter round-trip.
const MINTER_CALL_TIMEOUT_SECS: u64 = 30;

/// TTL of the [`AgentLedger::deposit_info`] cache. The facade's `deposit_info` MUST stay a
/// consensus UPDATE (it `await`s two inter-canister minter calls — `get_minter_info` +
/// `get_deposit_fee` — which is impossible in query context, and the replica rejects a query call
/// to an update endpoint), yet the sheet opens on every "Add money" tap. The cache bounds that
/// cost to ONE update call per currency per TTL while keeping the metadata fresh enough (it is
/// effectively static: min-confirmations/fee/min-amount change on minter upgrades, not per call).
/// 60s ≪ the minter's 7–15s round-trip cadence the app polls at, and ≫ a sheet-open burst.
const DEPOSIT_INFO_CACHE_TTL_SECS: u64 = 60;

/// Timeout for the `agent.status()` liveness probe behind [`Ledger::healthy`]. The wallet polls
/// `/api/v1/health`, so a hung replica would otherwise wedge the connectivity dot for ic-agent's
/// full ~5min expiry before flipping it red. 5s comfortably covers a healthy replica's status
/// round-trip while keeping the pre-flight responsive.
const STATUS_TIMEOUT_SECS: u64 = 5;

// ---- icrc3 history-walk budget ---------------------------------------------------------------
// Mirrors the canister's reconcile budget (RECONCILE_MAX_BLOCKS = 10_000): the walk examines at
// most ~10k blocks and makes at most ~10 round trips per /transactions request, so a huge ledger
// can never wedge the relay. Pages of 1_000 blocks; the first page doubles as the log_length
// probe (a response always carries it).

/// Blocks per `get_transactions` round trip.
const HISTORY_PAGE_BLOCKS: u64 = 1_000;
/// Total round-trip budget for one history walk (the log_length probe included).
const HISTORY_MAX_ROUND_TRIPS: usize = 10;
/// Wall-clock budget for one whole history walk (probe + pages). The per-call
/// CANISTER_CALL_TIMEOUT_SECS bounds a single hung replica round trip, but a healthy-yet-slow
/// ledger (mature mainnet logs, archived-boundary pages) could still burn the FULL round-trip
/// budget serially — tens of seconds per request. History is a "recent blocks" read polled
/// every few seconds per client: returning what was collected when the budget expires keeps the
/// documented recent-blocks-only semantic (older rows simply aren't served) and the relay
/// responsive under load (2026-08-21 fix: unbounded walks saturated the relay → edge 502s and
/// client aborts on currencies whose logs walk slowly).
const HISTORY_WALK_TIMEOUT_SECS: u64 = 4;
/// Consecutive zero-match TAIL pages after which the walk stops early. A user with no rows in
/// the newest 2×1_000 blocks has no "recent" history by definition — walking 8 more pages of
/// a mature ledger to confirm that is pure load (the row-limit early-break never fires when
/// nothing matches).
const HISTORY_EMPTY_PAGE_STOP: usize = 2;
/// TTL of the per-(ledger, account, currency) history cache. The wallet re-polls /transactions

// ---- native ICP index history (the ONE legacy-ledger exception) --------------------------------
//
// The canonical native ICP ledger has NO icrc3 surface: `get_transactions` answers IC0536 and
// `query_blocks` is a ~38M-block LEDGER-WIDE scan with no account keying (docs/specs/
// 2026-08-28-vchf-icp-support-spec.md U4 + docs/VCHF_ICP_ANALYSIS.md gap 3). Its per-account
// history lives in the OFFICIAL ICP INDEX, whose `get_account_transactions` query returns
// newest-first pages keyed by transaction id. The (ledger → index) pair below is PINNED here —
// the catalog carries no index_canister field, and the analysis doc live-verified the index's
// `ledger_id()` maps back to exactly this ledger.

/// The canonical native ICP ledger on the Internet Computer — the ONLY ledger whose history is
/// served by the ICP index (every other ledger keeps the icrc3 walk below, byte-identical).
/// Single-sourced from the compiled catalog's [`crate::catalog::ICP_LEDGER_PRINCIPAL`] pin
/// (both cross-checked against `dfx/catalog_truth.json`).
pub const ICP_LEDGER: &str = crate::catalog::ICP_LEDGER_PRINCIPAL;
/// The official ICP index canister serving `get_account_transactions` for [`ICP_LEDGER`].
pub const ICP_INDEX: &str = "qhbym-qaaaa-aaaaa-aaafq-cai";
/// Rows requested per `get_account_transactions` round trip. Kept modest so one reply stays a
/// bounded message; depth comes from paging (bounded by HISTORY_MAX_ROUND_TRIPS).
const ICP_INDEX_PAGE_SIZE: u64 = 100;

/// History routing: `Some(index)` ONLY for the canonical ICP ledger principal, `None` for every
/// other ledger (the icrc3 walk). Pure so the dispatch is unit-pinnable.
pub fn icp_index_for_ledger(ledger: &Principal) -> Option<Principal> {
    let canonical = Principal::from_text(ICP_LEDGER).expect("hardcoded canister id parses");
    (ledger == &canonical).then(|| Principal::from_text(ICP_INDEX).expect("hardcoded canister id parses"))
}

// Locally mirrored index Candid surface — only the fields history reads (candid record
// subtyping ignores extra wire fields, and the index's `kind` text tag is redundant with the
// option tags). Operation from/to values are LEGACY ACCOUNT IDENTIFIER hex strings (the
// 32-byte textual form the ICP ecosystem used before ICRC-1 accounts), NOT principal texts —
// that asymmetry is why `map_icp_index_txn` needs the account-identifier shim below.
//
// `pub` (behind the `agent` feature) so the live PocketIC harness can construct golden replies
// and the opt-in mainnet probe can reuse the arg type.

/// `record { e8s: nat64 }` — the index's token amount (the full u64 range must survive intact).
#[derive(CandidType, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct IcpIndexTokens {
    pub e8s: u64,
}

/// Query argument: `record { account; start: opt nat; max_results: nat }` — `start` is the
/// exclusive cursor (return transactions OLDER than this id); `None` = newest page. The
/// `account` field is the standard ICRC-1 `Account` (identical wire shape), default subaccount.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexGetAccountTransactionsArgs {
    pub account: Account,
    pub start: Option<Nat>,
    pub max_results: Nat,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexTransfer {
    pub to: String,
    pub fee: Option<IcpIndexTokens>,
    pub from: String,
    pub memo: Option<u64>,
    pub icrc1_memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
    pub amount: IcpIndexTokens,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexMint {
    pub to: String,
    pub memo: Option<u64>,
    pub icrc1_memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
    pub amount: IcpIndexTokens,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexBurn {
    pub from: String,
    pub memo: Option<u64>,
    pub icrc1_memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
    pub amount: IcpIndexTokens,
}

/// Approve is decoded ONLY to be recognized and dropped (`map_icp_index_txn` → `None`) —
/// approvals move no balance the wallet renders. Fields beyond `from` are never read.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexApprove {
    pub from: String,
}

/// One index `Transaction`. `timestamp` is NANOSECONDS since epoch (the rows contract is unix
/// seconds — divided in the mapper). At most one operation option is `Some` on the wire.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexTransaction {
    pub burn: Option<IcpIndexBurn>,
    pub mint: Option<IcpIndexMint>,
    pub approve: Option<IcpIndexApprove>,
    pub transfer: Option<IcpIndexTransfer>,
    pub timestamp: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexTransactionWithId {
    pub id: Nat,
    pub transaction: IcpIndexTransaction,
}

/// Success reply: `transactions` is NEWEST-FIRST within the page; `oldest_tx_id` is the id of
/// the oldest row in THIS reply when older transactions may exist, `None` when the account's
/// history is exhausted.
#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct IcpIndexAccountTransactionsOk {
    pub transactions: Vec<IcpIndexTransactionWithId>,
    pub oldest_tx_id: Option<Nat>,
}

#[derive(CandidType, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum IcpIndexAccountTransactionsErr {
    InvalidRequest,
    Other,
}

/// The full reply variant: `variant { ok; err }` — mirrors the index's
/// `GetAccountIdentifierTransactionsResult`.
pub type IcpIndexAccountTransactionsResult =
    Result<IcpIndexAccountTransactionsOk, IcpIndexAccountTransactionsErr>;

/// Candid mirror of the facade's `DepositInfo` reply (static deposit metadata).
#[derive(CandidType, Deserialize, Debug)]
struct DepositInfoMirror {
    min_confirmations: u32,
    deposit_fee: u64,
    deposit_min_amount: Option<u64>,
}

/// Minimal candid mirror of the ckETH-family minter's `get_minter_info` reply. The REAL minter's
/// `MinterInfo` (verified against the live `sv3dd-oaaaa-aaaar-qacoa-cai` `candid:service`) carries
/// ~a dozen fields, ALL optional; candid record subtyping ignores wire fields absent from the
/// mirror, and the one load-bearing label here is
/// `deposit_with_subaccount_helper_contract_address` — the CkDeposit helper the user's
/// approve+depositErc20 / depositEth txs target. `None` on the wire = the minter has no
/// subaccount helper configured (the pre-2024 shape) → the caller falls back to the verified
/// constants.
#[derive(CandidType, Deserialize, Debug)]
struct CkEthMinterInfoMirror {
    deposit_with_subaccount_helper_contract_address: Option<String>,
}

/// One [`AgentLedger::deposit_info`] cache entry: the reply plus the instant it was fetched.
/// `std::time::Instant` is a monotonic clock, so TTL checks are immune to wall-clock jumps.
struct DepositInfoCacheEntry {
    fetched_at: std::time::Instant,
    info: DepositInfo,
}

/// A [`Ledger`] backed by a real IC replica. Owns an [`Agent`] pointed at the replica/gateway URL
/// and the dpay canister's [`Principal`]. Cheap to `clone` semantically via `Arc` at the call site.
///
/// Balance reads go DIRECTLY to each currency's ICRC-1 ledger via [`Ledger::balance_on_ledger`]
/// (free `icrc1_balance_of` queries, no facade hop, no consensus, no `BAL_CACHE`) — see the
/// `/balances` handler in [`crate::app`]. The facade's cached `balance_of` / `refresh_balances`
/// surface is no longer invoked from the relay's read path.
pub struct AgentLedger {
    agent: Agent,
    canister_id: Principal,
    /// TTL cache for the facade `deposit_info` UPDATE (see [`DEPOSIT_INFO_CACHE_TTL_SECS`]) —
    /// keyed by currency id. `std::sync::Mutex` (the relay's established interior-mutability
    /// pattern): the lock is only held for a HashMap get/insert, never across an await.
    deposit_info_cache: Mutex<HashMap<Currency, DepositInfoCacheEntry>>,
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
        Self::connect_inner(url, canister_id, fetch_root_key, None).await
    }

    /// [`connect_with`](Self::connect_with) + an AUTHENTICATED identity built from `seed` — the
    /// raw 32-byte ed25519 seed (RFC 8032 5.1.5) behind the production faucet's controller key
    /// (`DPAY_CONTROLLER_SEED`, hex; the SAME key material the founder's dfx/`icp-cli` deploy
    /// identity used, which made it the canister controller). The derived self-authenticating
    /// principal is what the facade's `require_admin` checks on `mint`.
    ///
    /// This is the founder-approved 2026-08-20 trade-off, accepted on the rationale that the
    /// facade is OUT of the value path post-cutover: a relay-held controller key only exposes
    /// play-money DEMO minting + canister governance (already founder-managed), while keeping the
    /// cooldown logic in the relay (cheap to test/tune/redeploy, no canister upgrade cycle).
    ///
    /// Test-friendly: live PocketIC tests install the facade with the controller set to this
    /// seed's self-authenticating principal, then drive the faucet through this constructor.
    pub async fn connect_with_identity(
        url: &str,
        canister_id: Principal,
        fetch_root_key: bool,
        seed: [u8; 32],
    ) -> Result<Self, LedgerError> {
        Self::connect_inner(url, canister_id, fetch_root_key, Some(seed)).await
    }

    /// Shared connect: anonymous unless `seed` is given. The anonymous build is the read-only
    /// default — balance/history/catalog/deposit queries are all unsigned, so the whole read
    /// surface is unaffected by the identity choice; only the authenticated `mint` (faucet) needs
    /// the controller key.
    async fn connect_inner(
        url: &str,
        canister_id: Principal,
        fetch_root_key: bool,
        seed: Option<[u8; 32]>,
    ) -> Result<Self, LedgerError> {
        let mut builder = Agent::builder().with_url(url);
        if let Some(seed) = seed {
            builder = builder.with_identity(BasicIdentity::from_raw_key(&seed));
        }
        let agent = builder
            .build()
            .map_err(|e| LedgerError::Transient(format!("agent build: {e}")))?;
        if fetch_root_key {
            tokio::time::timeout(
                Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
                agent.fetch_root_key(),
            )
            .await
            .map_err(|_| {
                LedgerError::Transient(format!(
                    "fetch_root_key timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
                ))
            })?
            .map_err(|e| LedgerError::Transient(format!("fetch_root_key: {e}")))?;
        }
        Ok(AgentLedger {
            agent,
            canister_id,
            deposit_info_cache: Mutex::new(HashMap::new()),
        })
    }

}

/// The USER's ICRC-1 account on a ledger — the rail's addressing shape since the 2026-08-19
/// cutover: `owner = self_authenticating(DER(pubkey))`, `subaccount = None`. Built from a dpay
/// pubkey; the owner derivation is dpay-icp's `Principal::self_authenticating_ed25519`
/// (golden-proven byte-identical to the app's wasm signer), so the relay and the app read the
/// SAME account. `Account`'s `PartialEq` compares effective subaccounts (None == all-zeros),
/// matching how the ledger itself treats the default subaccount.
fn user_account(pubkey: &[u8; PUBKEY_LEN]) -> Account {
    let owner = dpay_icp::principal::Principal::self_authenticating_ed25519(pubkey);
    Account {
        owner: Principal::from_slice(owner.as_slice()),
        subaccount: None,
    }
}

#[async_trait]
impl Ledger for AgentLedger {
    /// Direct `icrc1_balance_of(account) -> nat` QUERY on the currency's ledger — free, always-live.
    /// The batch `/balances` handler fans this out per catalog currency. USER-PRINCIPAL RAIL
    /// (2026-08-19 cutover): funds live at `Account{owner: self_authenticating(DER(pubkey)),
    /// subaccount: None}` on the external ledgers — the facade-custody subaccount shape is GONE.
    /// The owner derivation is dpay-icp's `Principal::self_authenticating_ed25519` (golden-proven
    /// byte-identical to the app's wasm signer), so the relay and the app read the SAME account.
    /// `ledger_text` is the catalog's text Principal; `_currency` is unused (the ledger IS the
    /// right one for that currency).
    async fn balance_on_ledger(
        &self,
        ledger_text: &str,
        pubkey: [u8; PUBKEY_LEN],
        _currency: Currency,
    ) -> Result<u64, LedgerError> {
        let ledger = Principal::from_text(ledger_text).map_err(|e| {
            LedgerError::Transient(format!("parse ledger principal '{ledger_text}': {e}"))
        })?;
        let me = user_account(&pubkey);
        let arg = encode_one(&me)
            .map_err(|e| LedgerError::Transient(format!("encode icrc1_balance_of arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent.query(&ledger, "icrc1_balance_of").with_arg(arg).call(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "icrc1_balance_of timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("icrc1_balance_of query: {e}")))?;
        // ICRC-1 returns `nat`; candid decodes it into `u128` (balances are bounded far below u64).
        let bal: u128 = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode icrc1_balance_of reply: {e}")))?;
        u64::try_from(bal)
            .map_err(|_| LedgerError::Transient("icrc1_balance_of result exceeds u64".into()))
    }

    /// History = the ledger's OWN transaction log, walked BACKWARDS (newest first) from the
    /// response's `log_length` snapshot with `get_transactions` (the typed ICRC-3 read exposed by
    /// every ic-icrc1-ledger; a free query, no facade index involved). Rows are mapped newest-first
    /// into the existing [`TxnRecord`] shape — the app/hooks/jest/e2e contract is unchanged.
    ///
    /// Why backwards: a user's recent transactions live at the log's TAIL. A mature mainnet ledger
    /// archives its OLDEST blocks (the local log holds only the newest ones), so a forward walk
    /// from block 0 hits the archived boundary immediately and the user's recent rows are silently
    /// absent. The walk therefore:
    ///   1. **Probes** with one `(start=0, length=PAGE)` round trip — every reply carries
    ///      `log_length`, and for a short log (≤ PAGE blocks) the probe's page IS the whole live
    ///      log: one round trip total, served reversed. For a longer log the probe's rows (the
    ///      OLDEST blocks — usually the archived/empty ones) are discarded and only its
    ///      `log_length` snapshot is used.
    ///   2. **Walks backwards** in [`HISTORY_PAGE_BLOCKS`] pages from that snapshot: page
    ///      `[end-PAGE, end)`, rows consumed newest→oldest, so `rows` is globally newest-first
    ///      with no final reversal. Stops as soon as `limit` matching rows are collected.
    ///   3. **Terminates** on any of: block 0 reached; an EMPTY page; or a page whose response
    ///      marks the archived boundary (`archived_transactions` non-empty) — that page serves
    ///      what it can and ENDS the walk: archived blocks need a per-archive callback fetch this
    ///      endpoint doesn't do, so history is RECENT-BLOCKS-ONLY — documented behavior, not a
    ///      silent gap (PocketIC tests never archive, so tests see the full log).
    ///
    /// Drift safety: every page anchors on the response's `first_index` (the ACTUAL first block
    /// index of the returned range — NOT necessarily the requested `start` once archiving is in
    /// play), the same datum the canister's reconcile walk relies on (`calls.rs`
    /// `ledger_get_transactions`): block indices are derived as `first_index + i`, and the next
    /// page's `end` is set to the CURRENT page's `first_index`, so a ledger that serves a
    /// shifted/short range is re-asked from where it actually served — never skipping or
    /// double-counting blocks. New blocks landing while the walk runs are simply absent from the
    /// stale `log_length` snapshot — they appear on the NEXT request (the drift-tolerance
    /// property the live icrc3 test pins).
    ///
    /// Budget: pages of [`HISTORY_PAGE_BLOCKS`] and at most [`HISTORY_MAX_ROUND_TRIPS`] round
    /// trips total (probe included) — mirroring the canister's reconcile budget
    /// (RECONCILE_MAX_BLOCKS) so a huge ledger can't wedge the relay; the walk simply stops
    /// (older rows exist but aren't served).
    ///
    /// Filtering: a row renders when `from` or `to` is the user's account (default subaccount
    /// only — subaccount-keyed flows never show, matching what the app can sign). Kinds:
    /// `Transfer` always; `Mint` always (a mint TO the user renders `in`, with the empty `from`
    /// the app shows as its mint sentinel); `Burn` only when the user is the `from`; `Approve`
    /// never (not a value movement the wallet displays).
    async fn transactions_on_ledger(
        &self,
        ledger_text: &str,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
        memo: Option<&str>,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let ledger = Principal::from_text(ledger_text).map_err(|e| {
            LedgerError::Transient(format!("parse ledger principal '{ledger_text}': {e}"))
        })?;
        let me = user_account(&pubkey);
        let limit = limit.max(1) as usize;

        // NO result cache, deliberately: a just-settled payment must be visible to the payer's
        // VERY NEXT history poll (a freshness contract the live tests pin). The walk itself is
        // bounded — HISTORY_WALK_TIMEOUT_SECS overall deadline + the zero-match early-stop —
        // so serving every poll directly stays cheap even for no-history accounts.
        let deadline = std::time::Instant::now() + Duration::from_secs(HISTORY_WALK_TIMEOUT_SECS);
        // THE ONE LEGACY EXCEPTION: the canonical native ICP ledger has no icrc3 surface
        // (IC0536; `query_blocks` is a ledger-wide scan) — its history comes from the official
        // ICP index instead. Every other ledger keeps the icrc3 walk, byte-identical.
        match icp_index_for_ledger(&ledger) {
            Some(index) => {
                self.icp_index_history(&index, &me, currency, limit, memo, deadline)
                    .await
            }
            None => {
                self.transactions_walk(&ledger, &me, currency, limit, memo, deadline)
                    .await
            }
        }
    }

    async fn healthy(&self) -> bool {
        // Liveness = the replica answers the management canister's read-only `status`. Cheap, and
        // proves the gateway + replica are actually reachable (not just that a socket is open). Bounded
        // by STATUS_TIMEOUT_SECS so a hung replica flips the merchant terminal's green dot red within
        // one poll cycle (the terminal hits /health every 3s) instead of wedging for ic-agent's full
        // ~5min expiry.
        tokio::time::timeout(
            Duration::from_secs(STATUS_TIMEOUT_SECS),
            self.agent.status(),
        )
        .await
        .map(|status_result| status_result.is_ok())
        .unwrap_or(false)
    }

    async fn faucet_mint(
        &self,
        pubkey: &[u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        // The trait method is just the seam — the real call + its docs live on the inherent
        // [`AgentLedger::faucet_mint`](Self::faucet_mint) (same receiver, zero indirection).
        Self::faucet_mint(self, pubkey, currency, amount).await
    }

    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError> {
        // facade `deposit_info(nat32) -> Result<DepositInfo, text>` (update) → proxies the minter's
        // `get_minter_info` + `get_deposit_fee`. Any `Err(String)` → `Transient` (§0).
        //
        // The facade method MUST be an update (it `await`s two inter-canister minter calls —
        // `Call::bounded_wait`, impossible in query context), so a query call here is a wire
        // contract the replica rejects. Instead of paying the 7–15s consensus round trip on every
        // "Add money" sheet open, cache each currency's reply for [`DEPOSIT_INFO_CACHE_TTL_SECS`]
        // — the payload is effectively static (min-confirmations/fee/min-amount change on minter
        // UPGRADES, not per call), so 60s staleness is safe while cutting steady-state cost to
        // one update per TTL. A failed fetch does NOT poison the cache: the entry is only
        // inserted on success, so the next caller retries immediately.
        if let Some(entry) = self.deposit_info_cache.lock().unwrap_or_else(|p| p.into_inner()).get(&currency) {
            if entry.fetched_at.elapsed() < Duration::from_secs(DEPOSIT_INFO_CACHE_TTL_SECS) {
                return Ok(entry.info.clone());
            }
        }
        let arg = encode_args((currency,))
            .map_err(|e| LedgerError::Transient(format!("encode deposit_info arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(MINTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "deposit_info")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "deposit_info timed out after {MINTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("deposit_info update: {e}")))?;
        let result: Result<DepositInfoMirror, String> = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode deposit_info reply: {e}")))?;
        let m = result.map_err(LedgerError::Transient)?;
        let info = DepositInfo {
            min_confirmations: m.min_confirmations,
            deposit_fee: U64String(m.deposit_fee),
            deposit_min_amount: m.deposit_min_amount.map(U64String),
        };
        self.deposit_info_cache.lock().unwrap_or_else(|p| p.into_inner()).insert(
            currency,
            DepositInfoCacheEntry { fetched_at: std::time::Instant::now(), info: info.clone() },
        );
        Ok(info)
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // MC8 U2: resolve the onramp from the CATALOG descriptor (the relay's compiled catalog,
        // [`crate::catalog::ic_rows`] — sole authority since 2026-08-28), not a hardcoded
        // `currency == 2` guard. The descriptor's per-token `token_contract` is the
        // authoritative ERC-20 address; the deposit `principal` arg is the USER's own IC principal
        // (derived in-app), so no principal is served here.
        //
        // The `helper_address` is read at RUNTIME from the descriptor's minter
        // (`minter_helper_address` below — a direct `get_minter_info` query), because the helper
        // is NETWORK-scoped deploy state that a ckETH-minter upgrade can change; the verified
        // constants (via `ckerc20_onramp_from_descriptor`) are only the FALLBACK, served when the
        // runtime read fails or the minter doesn't configure the field. Fail-closed gate
        // (family, chain_id, token discrimination) stays single-sourced in the pure resolver.
        let catalog = crate::catalog::ic_rows();
        let desc = catalog.iter().find(|d| d.currency == currency);
        let mut params = ckerc20_onramp_from_descriptor(desc)?;
        if let Some(minter_text) = desc.and_then(|d| d.minter.as_deref()) {
            match self.minter_helper_address(minter_text).await {
                Ok(Some(helper)) => params.helper_address = helper,
                Ok(None) => {} // field unset on the minter — keep the verified-constant fallback
                Err(e) => eprintln!(
                    "dpay: ckerc20 onramp helper read from minter {minter_text} failed ({e}); \
                     falling back to the verified compile-time constant"
                ),
            }
        }
        Ok(params)
    }

}

impl AgentLedger {
    /// The icrc3 walk itself (probe + backwards pages), bounded by `deadline`. Split from
    /// [`AgentLedger::transactions_on_ledger`] so the cache wrapper stays readable.
    async fn transactions_walk(
        &self,
        ledger: &Principal,
        me: &Account,
        currency: Currency,
        limit: usize,
        memo: Option<&str>,
        deadline: std::time::Instant,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let ledger = *ledger;

        let fetch_page = |start: u64, length: u64| async move {
            let arg = encode_args((GetBlocksRequest {
                start: Nat::from(start),
                length: Nat::from(length),
            },))
            .map_err(|e| LedgerError::Transient(format!("encode get_transactions arg: {e}")))?;
            let reply = tokio::time::timeout(
                Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
                self.agent
                    .query(&ledger, "get_transactions")
                    .with_arg(arg)
                    .call(),
            )
            .await
            .map_err(|_| {
                LedgerError::Transient(format!(
                    "get_transactions timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
                ))
            })?
            .map_err(|e| LedgerError::Transient(format!("get_transactions query: {e}")))?;
            decode_one::<GetTransactionsResponse>(&reply)
                .map_err(|e| LedgerError::Transient(format!("decode get_transactions reply: {e}")))
        };

        // 1. Probe: (start=0, length=PAGE). For a short log this page IS the whole live log
        //    (ascending) — serve it reversed and done in one round trip.
        let probe = fetch_page(0, HISTORY_PAGE_BLOCKS as u64).await?;
        let probe_len = probe.transactions.len() as u64;
        let total = nat_to_u64(&probe.log_length, "log_length")?;
        let mut rows: Vec<TxnRecord> = Vec::new();
        let probe_served_upto = nat_to_u64(&Nat(probe.first_index.0.clone()), "first_index")?
            .saturating_add(probe_len);
        if probe_served_upto >= total {
            for txn in probe.transactions.iter().rev() {
                if let Some(record) = map_icrc_txn(txn, &me, currency)
                    .filter(|r| memo.is_none_or(|m| r.memo.eq_ignore_ascii_case(m)))
                {
                    rows.push(record);
                }
            }
            rows.truncate(limit); // newest-first already
            return Ok(rows);
        }

        // 2. Long log: DISCARD the probe's rows (the OLDEST live blocks — the user's recent txns
        //    are at the tail) and walk BACKWARDS from the probe's log_length snapshot.
        let mut end = total; // exclusive upper block index of the next page
        let mut empty_pages = 0usize; // consecutive tail pages with ZERO rows for this user
        for _ in 1..HISTORY_MAX_ROUND_TRIPS {
            // Wall-clock budget: serve what we have (recent-blocks-only semantic) instead of
            // burning the full round-trip budget on a slow/archived ledger.
            if std::time::Instant::now() >= deadline {
                break;
            }
            let start = end.saturating_sub(HISTORY_PAGE_BLOCKS);
            let page = fetch_page(start, end - start).await?;
            let page_len = page.transactions.len() as u64;
            // Drift datum: the ACTUAL first block index of the served range (never assume the
            // requested `start` — the canister reconcile pattern).
            let first_index = nat_to_u64(&Nat(page.first_index.0.clone()), "first_index")?;

            let before = rows.len();
            // Serve this page newest→oldest; across pages `rows` stays globally newest-first.
            for txn in page.transactions.iter().rev() {
                if let Some(record) = map_icrc_txn(txn, &me, currency)
                    .filter(|r| memo.is_none_or(|m| r.memo.eq_ignore_ascii_case(m)))
                {
                    rows.push(record);
                }
            }
            if rows.len() >= limit {
                break; // enough NEWEST rows — older pages can't add anything the caller renders
            }
            // Zero-match early stop: a user absent from the newest empty_pages×1_000 blocks has
            // no "recent" history — walking a mature ledger further is pure load (the limit
            // break above can never fire when nothing matches).
            if memo.is_none() && rows.len() == before {
                empty_pages += 1;
                if empty_pages >= HISTORY_EMPTY_PAGE_STOP {
                    break;
                }
            } else {
                empty_pages = 0;
            }

            // Archived boundary: this response could not serve (part of) the asked range from the
            // local log — the walk stops here (recent-blocks-only; see method doc).
            if !page.archived_transactions.is_empty() {
                break;
            }
            // Empty page or block 0 reached: nothing older exists to ask for.
            if page_len == 0 || first_index == 0 {
                break;
            }
            // Drift-safe anchor: continue from where the ledger ACTUALLY served, not from the
            // requested `start` (a shifted/short range is re-asked from its true front; blocks
            // are never skipped or double-counted).
            end = first_index;
        }

        rows.truncate(limit);
        Ok(rows)
    }

    /// Native-ICP history from the official ICP index: `get_account_transactions` QUERY pages
    /// keyed by the last reply's `oldest_tx_id`, mapped newest-first into the same
    /// [`TxnRecord`] contract the icrc3 walk serves. Budget contract mirrors the icrc3 walk:
    /// [`HISTORY_WALK_TIMEOUT_SECS`] overall deadline (partial serve on expiry — the
    /// recent-rows-first semantic), at most [`HISTORY_MAX_ROUND_TRIPS`] round trips, and any
    /// error fails THIS currency's request only (`Transient` — the /transactions handler maps
    /// it to a 503 for this one call; other currencies' requests are separate calls and
    /// unaffected).
    async fn icp_index_history(
        &self,
        index: &Principal,
        me: &Account,
        currency: Currency,
        limit: usize,
        memo: Option<&str>,
        deadline: std::time::Instant,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let index = *index;
        let account = me.clone();
        let agent = &self.agent;
        let fetch = move |start: Option<Nat>| async move {
            let arg = encode_args((IcpIndexGetAccountTransactionsArgs {
                account: account.clone(),
                start,
                max_results: Nat::from(ICP_INDEX_PAGE_SIZE),
            },))
            .map_err(|e| {
                LedgerError::Transient(format!("encode get_account_transactions arg: {e}"))
            })?;
            let reply = tokio::time::timeout(
                Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
                agent
                    .query(&index, "get_account_transactions")
                    .with_arg(arg)
                    .call(),
            )
            .await
            .map_err(|_| {
                LedgerError::Transient(format!(
                    "get_account_transactions timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
                ))
            })?
            .map_err(|e| {
                LedgerError::Transient(format!("get_account_transactions query: {e}"))
            })?;
            decode_one::<IcpIndexAccountTransactionsResult>(&reply)
                .map_err(|e| {
                    LedgerError::Transient(format!("decode get_account_transactions reply: {e}"))
                })?
                .map_err(|e| {
                    LedgerError::Transient(format!(
                        "icp index get_account_transactions error: {e:?}"
                    ))
                })
        };
        let my_account_id = icp_legacy_account_identifier(&me.owner);
        Self::icp_index_walk(fetch, &me.owner, &my_account_id, currency, limit, memo, deadline).await
    }

    /// The index walk's control flow, generic over the page fetch so the unit tests can drive
    /// it with synthetic pages (no replica needed) while the live path drives it with real
    /// agent queries. Pure policy: page backward from `start = None` following each reply's
    /// `oldest_tx_id`; stop as soon as `limit` MATCHING rows are collected (memo filter applies
    /// BEFORE the limit, exactly like the icrc3 walk), on exhaustion (`oldest_tx_id = None`),
    /// on an empty page, on a non-advancing cursor (defensive against a stuck index), on the
    /// round-trip cap, or on the wall-clock deadline (serve what was collected).
    async fn icp_index_walk<F, Fut>(
        mut fetch: F,
        me: &Principal,
        my_account_id: &str,
        currency: Currency,
        limit: usize,
        memo: Option<&str>,
        deadline: std::time::Instant,
    ) -> Result<Vec<TxnRecord>, LedgerError>
    where
        F: FnMut(Option<Nat>) -> Fut,
        Fut: Future<Output = Result<IcpIndexAccountTransactionsOk, LedgerError>>,
    {
        let mut rows: Vec<TxnRecord> = Vec::new();
        let mut start: Option<Nat> = None;
        for _ in 0..HISTORY_MAX_ROUND_TRIPS {
            // Wall-clock budget: serve what we have (recent-rows-first) instead of burning the
            // full round-trip budget on a slow index — the same contract as the icrc3 walk.
            if std::time::Instant::now() >= deadline {
                break;
            }
            let page = fetch(start.clone()).await?;
            for txn in page.transactions.iter() {
                if let Some(record) =
                    map_icp_index_txn(&txn.transaction, me, my_account_id, currency)
                        .filter(|r| memo.is_none_or(|m| r.memo.eq_ignore_ascii_case(m)))
                {
                    rows.push(record);
                }
                if rows.len() >= limit {
                    break; // enough NEWEST matching rows — older pages can't add anything
                }
            }
            if rows.len() >= limit {
                break;
            }
            // Termination: exhausted history / empty page / cursor that doesn't advance.
            let Some(oldest) = page.oldest_tx_id.clone() else {
                break;
            };
            if page.transactions.is_empty() || start.as_ref() == Some(&oldest) {
                break;
            }
            start = Some(oldest);
        }
        rows.truncate(limit);
        Ok(rows)
    }

    /// Runtime CkDeposit-helper read: `get_minter_info()` on the ckETH-family minter, returning
    /// `Ok(Some(address))` when the minter configures
    /// `deposit_with_subaccount_helper_contract_address`. The live ckETH minter exposes it as a
    /// QUERY (verified against the `sv3dd-oaaaa-aaaar-qacoa-cai` candid:service), so this is a
    /// free replica read — no consensus, no `MINTER_CALL_TIMEOUT_SECS`. Decode uses a minimal
    /// candid mirror (record subtyping drops the minter's other ~a dozen optional fields). Any
    /// transport/decode failure is the CALLER's fallback signal (logged there), never a user-facing
    /// 503: a momentarily unreachable minter must not break the onramp sheet when the verified
    /// constants are still correct.
    async fn minter_helper_address(&self, minter_text: &str) -> Result<Option<String>, LedgerError> {
        let minter = Principal::from_text(minter_text).map_err(|e| {
            LedgerError::Transient(format!("parse minter principal '{minter_text}': {e}"))
        })?;
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .query(&minter, "get_minter_info")
                .with_arg(encode_args(()).map_err(|e| LedgerError::Transient(format!("encode get_minter_info: {e}")))?)
                .call(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "get_minter_info timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
        .map_err(|e| LedgerError::Transient(format!("get_minter_info query: {e}")))?;
        let info: CkEthMinterInfoMirror = decode_one(&reply)
            .map_err(|e| LedgerError::Transient(format!("decode get_minter_info reply: {e}")))?;
        Ok(info.deposit_with_subaccount_helper_contract_address)
    }

    /// The relay faucet's settlement leg: the facade's CONTROLLER-GATED `mint` UPDATE
    /// `mint(blob pubkey, nat32 currency, nat64 amount) -> Result<nat64, text>`, signed with the
    /// agent's identity (only [`connect_with_identity`](Self::connect_with_identity) installs
    /// one; an anonymous agent is REFUSED by the canister's `require_admin`). Since the
    /// 2026-08-20 re-target the canister credits the USER-principal account
    /// (`Account{self_authenticating(DER(pubkey)), None}`) — the account the app reads.
    ///
    /// A canister `Err(text)` is passed through VERBATIM as `LedgerError::Rejected(text)` (the
    /// 422 app.rs mapping keeps the body `{error: text}` intact) — the app's Wallet surfaces the
    /// reason string as-is (N5), so any mint failure text reaches the user unaltered. On success
    /// returns the NEW post-mint balance at the user principal (the canister's return contract).
    pub async fn faucet_mint(
        &self,
        pubkey: &[u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        let arg = encode_args((pubkey.to_vec(), currency, amount))
            .map_err(|e| LedgerError::Transient(format!("encode mint arg: {e}")))?;
        let reply = tokio::time::timeout(
            Duration::from_secs(MINTER_CALL_TIMEOUT_SECS),
            self.agent
                .update(&self.canister_id, "mint")
                .with_arg(arg)
                .call_and_wait(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!("mint timed out after {MINTER_CALL_TIMEOUT_SECS}s"))
        })?
        .map_err(|e| LedgerError::Transient(format!("mint update: {e}")))?;
        decode_one::<Result<u64, String>>(&reply).map_err(|e| {
            LedgerError::Transient(format!("decode mint reply: {e}"))
        })?
        .map_err(|text| LedgerError::Rejected(text))
    }
}

// ---- icrc3 history helpers --------------------------------------------------------------------

/// `candid::Nat` → `u64` (history-walk indices/lengths are bounded far below u64).
fn nat_to_u64(n: &Nat, field: &str) -> Result<u64, LedgerError> {
    n.0.to_u64()
        .ok_or_else(|| LedgerError::Transient(format!("icrc3 {field} exceeds u64")))
}

/// Map one ICRC-3 transaction to the relay's [`TxnRecord`] row when it concerns `me`; `None`
/// otherwise (not ours, or a kind the wallet never renders). See `transactions_on_ledger`'s doc
/// for the filtering rules. Counterparties render as PRINCIPAL TEXT (the app shortens them); a
/// Mint/Burn's ledger-side account (mint account / burn sink) renders as the empty string, which
/// the app displays as its mint/burn sentinel label.
fn map_icrc_txn(txn: &Transaction, me: &Account, currency: Currency) -> Option<TxnRecord> {
    let account_text = |a: &Account| a.owner.to_text();
    let memo_hex = |m: &Option<icrc_ledger_types::icrc1::transfer::Memo>| {
        m.as_ref().map(|b| hex::encode(b.0.as_slice())).unwrap_or_default()
    };
    let ts = txn.timestamp / 1_000_000_000; // ICRC-3 timestamps are NANOSECONDS; rows contract is unix SECONDS

    if let Some(transfer) = txn.transfer.as_ref() {
        let from_is_me = transfer.from == *me;
        let to_is_me = transfer.to == *me;
        if !from_is_me && !to_is_me {
            return None;
        }
        let amount = u64::try_from(transfer.amount.0.clone())
            .map_err(|_| ())
            .ok()?; // amounts are bounded far below u64; skip rather than fail the whole walk
        return Some(TxnRecord {
            from: account_text(&transfer.from),
            to: account_text(&transfer.to),
            amount: U64String(amount),
            nonce: String::new(), // IC-rail rows carry no dpay nonce
            currency: currency as u32,
            timestamp: ts,
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&transfer.memo),
        });
    }
    if let Some(mint) = txn.mint.as_ref() {
        if mint.to != *me {
            return None;
        }
        let amount = u64::try_from(mint.amount.0.clone()).map_err(|_| ()).ok()?;
        return Some(TxnRecord {
            from: String::new(), // mint-account side renders as the sentinel label
            to: account_text(&mint.to),
            amount: U64String(amount),
            nonce: String::new(),
            currency: currency as u32,
            timestamp: ts,
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&mint.memo),
        });
    }
    if let Some(burn) = txn.burn.as_ref() {
        // Only the burner's side renders — the burn's `to` is the ledger's burn sink, not a
        // counterparty the user knows.
        if burn.from != *me {
            return None;
        }
        let amount = u64::try_from(burn.amount.0.clone()).map_err(|_| ()).ok()?;
        return Some(TxnRecord {
            from: account_text(&burn.from),
            to: String::new(), // burn sink renders as the sentinel label
            amount: U64String(amount),
            nonce: String::new(),
            currency: currency as u32,
            timestamp: ts,
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&burn.memo),
        });
    }
    // Approve (and future kinds): never rendered — approvals move no user-visible balance.
    None
}

// ---- icp index history helpers ------------------------------------------------------------------

/// The LEGACY ICP account identifier of `owner`'s DEFAULT subaccount — the 64-hex-char textual
/// form the official ICP index's operations use for `from`/`to` (and what dfx/quill display as
/// an "account id"). Construction: `crc32_be(sha224("\x0aaccount-id" || principal || 0^32))`
/// followed by the 28-byte SHA-224 digest — the domain-separated hash of the principal blob and
/// the all-zero subaccount, checksummed (CRC-32/IEEE, big-endian) in its FIRST 4 bytes.
///
/// The derivation itself lives in [`dpay_icp::principal::AccountIdentifier::from_principal`] —
/// the ONE implementation in this repo (the fake-IC gateway resolves a legacy `transfer` payee
/// with the same function). This wrapper only adapts the `candid::Principal` this module speaks to
/// it and pins the DEFAULT subaccount. Correctness is pinned by a golden test against a pair
/// derived independently by the OFFICIAL dfx toolchain (dfx 0.32.0, offline:
/// `dfx identity get-principal` / `dfx ledger account-id` of the default identity) — see
/// `icp_legacy_account_identifier_matches_an_independently_derived_golden`.
pub fn icp_legacy_account_identifier(owner: &Principal) -> String {
    // `candid::Principal` cannot hold more than 29 bytes (fixed-capacity blob), which is the only
    // way `from_bytes` rejects — so this is unreachable rather than a swallowed error.
    let owner = dpay_icp::principal::Principal::from_bytes(owner.as_slice())
        .expect("candid::Principal is always a valid ≤29-byte IC principal");
    dpay_icp::principal::AccountIdentifier::from_principal(&owner, &[0u8; 32]).to_text()
}

/// Map one index transaction to the relay's [`TxnRecord`] when it concerns `me`; `None`
/// otherwise (stranger rows, Approve). The DIRECTION-COMPATIBILITY SHIM lives here: the index
/// addresses operation sides as legacy textual ACCOUNT IDENTIFIERS while the app derives in/out
/// by comparing `TxnRecord.from` with the user's PRINCIPAL — so any side equal to
/// `my_account_id` (the queried principal's default-subaccount identifier) is rewritten to the
/// PRINCIPAL TEXT, and counterparty identifiers pass through unchanged. Memo: ONLY `icrc1_memo`
/// renders (byte-preserving hex); the legacy nat64 `memo` is dropped so it can NEVER satisfy a
/// 16-byte dpay reconciliation exact-memo match. Amounts flow `e8s: u64` → [`U64String`]
/// untouched (u64::MAX survives — no JS-number/f64 anywhere). Timestamp: the transaction's ns
/// timestamp preferred, the operation's `created_at_time` fallback, ÷ 1e9 → unix seconds.
fn map_icp_index_txn(
    txn: &IcpIndexTransaction,
    me: &Principal,
    my_account_id: &str,
    currency: Currency,
) -> Option<TxnRecord> {
    let side = |acct: &str| {
        if acct.eq_ignore_ascii_case(my_account_id) {
            me.to_text()
        } else {
            acct.to_owned()
        }
    };
    let is_me = |acct: &str| acct.eq_ignore_ascii_case(my_account_id);
    let ts_secs = |created_at_ns: Option<u64>| {
        let ns = if txn.timestamp > 0 { txn.timestamp } else { created_at_ns.unwrap_or(0) };
        ns / 1_000_000_000
    };
    let memo_hex = |m: &Option<Vec<u8>>| m.as_deref().map(hex::encode).unwrap_or_default();

    if let Some(transfer) = txn.transfer.as_ref() {
        if !is_me(&transfer.from) && !is_me(&transfer.to) {
            return None; // not ours (the index should never serve these; defensive all the same)
        }
        return Some(TxnRecord {
            from: side(&transfer.from),
            to: side(&transfer.to),
            amount: U64String(transfer.amount.e8s),
            nonce: String::new(), // IC-rail rows carry no dpay nonce
            currency: currency as u32,
            timestamp: ts_secs(transfer.created_at_time),
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&transfer.icrc1_memo),
        });
    }
    if let Some(mint) = txn.mint.as_ref() {
        if !is_me(&mint.to) {
            return None;
        }
        return Some(TxnRecord {
            from: String::new(), // mint side renders as the app's mint sentinel
            to: side(&mint.to),
            amount: U64String(mint.amount.e8s),
            nonce: String::new(),
            currency: currency as u32,
            timestamp: ts_secs(mint.created_at_time),
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&mint.icrc1_memo),
        });
    }
    if let Some(burn) = txn.burn.as_ref() {
        if !is_me(&burn.from) {
            return None; // only the burner's side renders
        }
        return Some(TxnRecord {
            from: side(&burn.from),
            to: String::new(), // burn sink renders as the sentinel
            amount: U64String(burn.amount.e8s),
            nonce: String::new(),
            currency: currency as u32,
            timestamp: ts_secs(burn.created_at_time),
            from_name: String::new(),
            to_name: String::new(),
            memo: memo_hex(&burn.icrc1_memo),
        });
    }
    // Approve (and future kinds): never rendered — approvals move no user-visible balance.
    None
}

// ---- icp index history unit tests ---------------------------------------------------------------
// Focused + fast (no replica): the mapper, the dispatch, the account-identifier derivation and
// the walk's pure control flow, driven through synthetic pages. The wire path (agent → PocketIC
// → candid) is proven by tests/icp_index_live.rs; the mainnet pair by the opt-in probe.

#[cfg(test)]
mod icp_index_tests {
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    use super::*;

    /// Golden pair derived OFFLINE by the OFFICIAL dfx toolchain (dfx 0.32.0:
    /// `dfx identity get-principal` + `dfx ledger account-id` of the machine's default
    /// identity) — an implementation INDEPENDENT of this hand-rolled derivation. If the
    /// construction above ever drifts (domain separator, digest, checksum placement), this pin
    /// fails. The pair is public dfx-default-identity output on this dev machine, not a secret.
    const GOLDEN_PRINCIPAL: &str = "hhwti-hb7f7-4ojco-uvazw-vcwr7-fqd6o-3oljb-aezpo-iheay-3gxmx-rqe";
    const GOLDEN_ACCOUNT_ID: &str =
        "7839b276bbf13961134746b623507d6baeef510873615f683ee93050c5de1a42";

    /// A counterparty account identifier DISTINCT from every fixture side (arbitrary hex).
    const COUNTER_ACCOUNT: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";

    const TS_NS: u64 = 1_750_000_000_123_456_789; // a ns timestamp whose seconds are unambiguous

    fn golden_principal() -> Principal {
        Principal::from_text(GOLDEN_PRINCIPAL).unwrap()
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn deadline_ahead() -> std::time::Instant {
        std::time::Instant::now() + Duration::from_secs(60)
    }

    fn transfer_txn(
        from: &str,
        to: &str,
        e8s: u64,
        icrc1_memo: Option<Vec<u8>>,
        legacy_memo: Option<u64>,
        ts_ns: u64,
    ) -> IcpIndexTransaction {
        IcpIndexTransaction {
            burn: None,
            mint: None,
            approve: None,
            transfer: Some(IcpIndexTransfer {
                to: to.to_owned(),
                fee: None,
                from: from.to_owned(),
                memo: legacy_memo,
                icrc1_memo,
                created_at_time: Some(1_600_000_000_000_000_000),
                amount: IcpIndexTokens { e8s },
            }),
            timestamp: ts_ns,
        }
    }

    fn mint_txn(to: &str, e8s: u64, ts_ns: u64) -> IcpIndexTransaction {
        IcpIndexTransaction {
            burn: None,
            mint: Some(IcpIndexMint {
                to: to.to_owned(),
                memo: None,
                icrc1_memo: None,
                created_at_time: None,
                amount: IcpIndexTokens { e8s },
            }),
            approve: None,
            transfer: None,
            timestamp: ts_ns,
        }
    }

    fn burn_txn(from: &str, e8s: u64, ts_ns: u64) -> IcpIndexTransaction {
        IcpIndexTransaction {
            burn: Some(IcpIndexBurn {
                from: from.to_owned(),
                memo: None,
                icrc1_memo: None,
                created_at_time: None,
                amount: IcpIndexTokens { e8s },
            }),
            mint: None,
            approve: None,
            transfer: None,
            timestamp: ts_ns,
        }
    }

    fn page(
        rows: Vec<(u64, IcpIndexTransaction)>,
        oldest: Option<u64>,
    ) -> IcpIndexAccountTransactionsOk {
        IcpIndexAccountTransactionsOk {
            transactions: rows
                .into_iter()
                .map(|(id, transaction)| IcpIndexTransactionWithId {
                    id: Nat::from(id),
                    transaction,
                })
                .collect(),
            oldest_tx_id: oldest.map(Nat::from),
        }
    }

    fn nat_opt(n: &Option<Nat>) -> Option<u64> {
        n.as_ref().map(|v| v.0.to_u64().expect("test ids fit u64"))
    }

    #[test]
    fn icp_index_dispatch_selects_the_index_only_for_the_canonical_icp_ledger() {
        let icp = Principal::from_text(ICP_LEDGER).unwrap();
        let index = Principal::from_text(ICP_INDEX).unwrap();
        assert_eq!(
            icp_index_for_ledger(&icp),
            Some(index),
            "the canonical ICP ledger routes to the pinned index"
        );
        // Every other ledger keeps the icrc3 walker — our own mainnet DUSD ledger, ckBTC's,
        // and the anonymous/system principals included.
        for text in ["td2nx-oaaaa-aaaab-qhdnq-cai", "mxzaz-hqaaa-aaaar-qaada-cai"] {
            let ledger = Principal::from_text(text).unwrap();
            assert_eq!(
                icp_index_for_ledger(&ledger),
                None,
                "{text} must keep the icrc3 walk"
            );
        }
        assert_eq!(icp_index_for_ledger(&Principal::management_canister()), None);
        assert_ne!(icp, index, "the pinned pair is two different canisters");
    }

    #[test]
    fn icp_legacy_account_identifier_matches_an_independently_derived_golden() {
        assert_eq!(
            icp_legacy_account_identifier(&golden_principal()),
            GOLDEN_ACCOUNT_ID,
            "the shared core derivation must match dfx 0.32.0's offline derivation"
        );
        // And it is account-SPECIFIC (a different principal yields a different identifier).
        assert_ne!(
            icp_legacy_account_identifier(&Principal::management_canister()),
            GOLDEN_ACCOUNT_ID
        );
    }

    #[test]
    fn icp_index_map_transfers_mint_burn_direction_and_omits_approve() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        let cur: Currency = 7;

        // Transfer IN: the index says to = MY account identifier → the app needs MY PRINCIPAL
        // TEXT there; the counterparty identifier passes through UNCHANGED.
        let tin = map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, &me_id, 100, Some(b"change".to_vec()), None, TS_NS),
            &me,
            &me_id,
            cur,
        )
        .unwrap();
        assert_eq!(tin.from, COUNTER_ACCOUNT);
        assert_eq!(tin.to, me.to_text(), "my account-identifier side → my principal text");
        assert_eq!(tin.amount.0, 100);
        assert_eq!(tin.currency, cur);

        // Transfer OUT: mirrored.
        let tout = map_icp_index_txn(
            &transfer_txn(&me_id, COUNTER_ACCOUNT, 250, Some(vec![0u8; 16]), None, TS_NS),
            &me,
            &me_id,
            cur,
        )
        .unwrap();
        assert_eq!(tout.from, me.to_text(), "my account-identifier side → my principal text");
        assert_eq!(tout.to, COUNTER_ACCOUNT);

        // Mint TO me: empty `from` (the app's mint sentinel), `to` = my principal text.
        let m = map_icp_index_txn(&mint_txn(&me_id, 10_000, TS_NS), &me, &me_id, cur).unwrap();
        assert_eq!(m.from, "");
        assert_eq!(m.to, me.to_text());
        assert_eq!(m.amount.0, 10_000);

        // Burn BY me: `from` = my principal text, empty `to` (the burn-sink sentinel).
        let b = map_icp_index_txn(&burn_txn(&me_id, 5, TS_NS), &me, &me_id, cur).unwrap();
        assert_eq!(b.from, me.to_text());
        assert_eq!(b.to, "");

        // Approve: never rendered, even when it concerns me.
        let approve = IcpIndexTransaction {
            burn: None,
            mint: None,
            approve: Some(IcpIndexApprove { from: me_id.clone() }),
            transfer: None,
            timestamp: TS_NS,
        };
        assert!(map_icp_index_txn(&approve, &me, &me_id, cur).is_none());

        // Rows that do not concern me: dropped (transfer, mint-to-other, burn-by-other).
        let other = "2222222222222222222222222222222222222222222222222222222222222222";
        assert!(map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, other, 1, None, None, TS_NS),
            &me, &me_id, cur
        )
        .is_none());
        assert!(map_icp_index_txn(&mint_txn(other, 1, TS_NS), &me, &me_id, cur).is_none());
        assert!(map_icp_index_txn(&burn_txn(other, 1, TS_NS), &me, &me_id, cur).is_none());
    }

    #[test]
    fn icp_index_map_memo_is_icrc1_bytes_only_and_timestamps_fall_back() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        let cur: Currency = 7;

        // icrc1_memo bytes are preserved EXACTLY as hex (arbitrary bytes, byte-for-byte).
        let bytes = vec![0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80, 0xaa, 0x55];
        let row = map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, &me_id, 1, Some(bytes.clone()), None, TS_NS),
            &me, &me_id, cur,
        )
        .unwrap();
        assert_eq!(row.memo, hex::encode(&bytes), "memo is the exact bytes, hex-encoded");

        // A LEGACY nat64 memo alone renders EMPTY — it can never satisfy the 16-byte dpay
        // reconciliation exact-memo match (the walk filter compares against row.memo).
        let legacy = map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, &me_id, 1, None, Some(42), TS_NS),
            &me, &me_id, cur,
        )
        .unwrap();
        assert_eq!(legacy.memo, "", "legacy nat64 memo is dropped, not rendered");
        let settlement_hex = hex::encode([7u8; 16]);
        assert!(
            !legacy.memo.eq_ignore_ascii_case(&settlement_hex),
            "a dropped memo must not match any reconciliation hex"
        );

        // ns → unix seconds, transaction timestamp preferred…
        assert_eq!(row.timestamp, 1_750_000_000);
        // …created_at_time as the fallback when the transaction timestamp is 0/absent.
        let fallback = map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, &me_id, 1, None, None, 0),
            &me, &me_id, cur,
        )
        .unwrap();
        assert_eq!(
            fallback.timestamp, 1_600_000_000,
            "created_at_time ns → seconds fallback"
        );
        // No timestamp anywhere (mint with ts 0 and created_at_time None): 0, no panic.
        let nowhere = map_icp_index_txn(&mint_txn(&me_id, 1, 0), &me, &me_id, cur).unwrap();
        assert_eq!(nowhere.timestamp, 0);
    }

    #[test]
    fn icp_index_amounts_survive_u64_max_as_decimal_strings() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        let row = map_icp_index_txn(
            &transfer_txn(COUNTER_ACCOUNT, &me_id, u64::MAX, None, None, TS_NS),
            &me, &me_id, 7,
        )
        .unwrap();
        assert_eq!(row.amount.0, u64::MAX, "u64::MAX e8s survives untouched (no f64)");
        // And it crosses the JSON boundary as the exact DECIMAL STRING (the U64String contract).
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(
            json["amount"].as_str(),
            Some("18446744073709551615"),
            "amount serializes as the raw decimal string"
        );
    }

    #[test]
    fn icp_index_walk_pages_backward_by_oldest_tx_id_newest_first() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        let p1 = page(
            vec![
                (1002, transfer_txn(COUNTER_ACCOUNT, &me_id, 100, Some(b"change".to_vec()), None, TS_NS)),
                (1001, transfer_txn(&me_id, COUNTER_ACCOUNT, 250, Some([0u8; 16].to_vec()), None, TS_NS)),
            ],
            Some(1000),
        );
        let p2 = page(vec![(1000, mint_txn(&me_id, 10_000, TS_NS))], None);

        let starts: Rc<RefCell<Vec<Option<u64>>>> = Rc::new(RefCell::new(Vec::new()));
        let seen = starts.clone();
        let fetch = move |start: Option<Nat>| {
            let seen = seen.clone();
            let p1 = p1.clone();
            let p2 = p2.clone();
            async move {
                seen.borrow_mut().push(nat_opt(&start));
                match seen.borrow().len() {
                    1 => Ok(p1),
                    _ => Ok(p2),
                }
            }
        };

        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 30, None, deadline_ahead(),
        ))
        .unwrap();

        assert_eq!(
            rows.iter().map(|r| r.amount.0).collect::<Vec<_>>(),
            vec![100, 250, 10_000],
            "rows stay globally newest-first ACROSS pages"
        );
        assert_eq!(
            *starts.borrow(),
            vec![None, Some(1000)],
            "page 2 is requested with start = page 1's oldest_tx_id"
        );
    }

    #[test]
    fn icp_index_walk_filters_memo_before_limit() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        // Newest row does NOT match; the older row carries the 16-byte settlement memo.
        let settlement = [3u8; 16];
        let p1 = page(
            vec![
                (1002, transfer_txn(COUNTER_ACCOUNT, &me_id, 5, Some(b"change".to_vec()), None, TS_NS)),
                (1001, transfer_txn(&me_id, COUNTER_ACCOUNT, 250, Some(settlement.to_vec()), None, TS_NS)),
            ],
            Some(1000),
        );
        let calls = Rc::new(Cell::new(0usize));
        let counter = calls.clone();
        let fetch = move |_start: Option<Nat>| {
            let calls = counter.clone();
            let p1 = p1.clone();
            async move {
                calls.set(calls.get() + 1);
                Ok(p1)
            }
        };

        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 1, Some(hex::encode(settlement).as_str()), deadline_ahead(),
        ))
        .unwrap();

        assert_eq!(
            rows.iter().map(|r| r.amount.0).collect::<Vec<_>>(),
            vec![250],
            "the memo filter applies BEFORE limit truncation — the older matching row survives limit=1"
        );
        assert_eq!(calls.get(), 1, "limit reached mid-page: no further round trips");
    }

    #[test]
    fn icp_index_walk_terminates_bounded_when_nothing_matches() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);
        // A hostile index: always a full page of STRANGER rows with an advancing cursor — the
        // walk must cap at HISTORY_MAX_ROUND_TRIPS and serve Ok(empty), never loop.
        let calls = Rc::new(Cell::new(0usize));
        let counter = calls.clone();
        let fetch = move |start: Option<Nat>| {
            let calls = counter.clone();
            async move {
                let n = calls.get();
                calls.set(n + 1);
                let id = 10_000u64 - 100 * n as u64; // strictly advancing oldest_tx_id
                let _ = start;
                Ok(page(
                    vec![(id, transfer_txn(COUNTER_ACCOUNT, "3333333333333333333333333333333333333333333333333333333333333333", 1, None, None, TS_NS))],
                    Some(id - 1),
                ))
            }
        };
        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 30, None, deadline_ahead(),
        ))
        .unwrap();
        assert!(rows.is_empty(), "no matching rows ever");
        assert_eq!(
            calls.get(),
            HISTORY_MAX_ROUND_TRIPS,
            "the round-trip cap bounds the walk at {} fetches",
            HISTORY_MAX_ROUND_TRIPS
        );
    }

    #[test]
    fn icp_index_walk_stops_on_empty_page_and_non_advancing_cursor() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);

        // Empty page (even with a cursor): stop after one round trip.
        let calls = Rc::new(Cell::new(0usize));
        let counter = calls.clone();
        let fetch = move |_start: Option<Nat>| {
            let calls = counter.clone();
            async move {
                calls.set(calls.get() + 1);
                Ok(page(vec![], Some(5)))
            }
        };
        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 30, None, deadline_ahead(),
        ))
        .unwrap();
        assert!(rows.is_empty());
        assert_eq!(calls.get(), 1, "empty page terminates immediately");

        // Cursor that never advances (oldest == the start we sent): stop, don't spin.
        let calls = Rc::new(Cell::new(0usize));
        let counter = calls.clone();
        let row_owner = me_id.clone();
        let fetch = move |start: Option<Nat>| {
            let calls = counter.clone();
            let me_id = row_owner.clone();
            async move {
                calls.set(calls.get() + 1);
                let cursor = start
                    .as_ref()
                    .and_then(|n| n.0.to_u64())
                    .unwrap_or(7);
                Ok(page(
                    vec![(cursor, transfer_txn(COUNTER_ACCOUNT, &me_id, 1, None, None, TS_NS))],
                    Some(7),
                ))
            }
        };
        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 30, None, deadline_ahead(),
        ))
        .unwrap();
        assert_eq!(rows.len(), 2, "the repeated page is absorbed exactly once before the non-advance is detected");
        assert_eq!(calls.get(), 2, "a non-advancing cursor ends the walk on round trip 2");
    }

    #[test]
    fn icp_index_walk_deadline_bounds_round_trips_and_errors_fail_only_this_call() {
        let me = golden_principal();
        let me_id = icp_legacy_account_identifier(&me);

        // Deadline already expired: ZERO round trips, Ok(empty) — the partial-serve semantic
        // (identical to the icrc3 walk's wall-clock budget).
        let called = Rc::new(Cell::new(false));
        let witness = called.clone();
        let fetch = move |_start: Option<Nat>| {
            let called = witness.clone();
            async move {
                called.set(true);
                Ok(page(vec![], None))
            }
        };
        let rows = rt().block_on(AgentLedger::icp_index_walk(
            fetch, &me, &me_id, 7, 30, None, std::time::Instant::now(),
        ))
        .unwrap();
        assert!(rows.is_empty());
        assert!(!called.get(), "an expired deadline prevents ANY round trip");

        // A fetch error propagates as THIS call's failure (Transient; the endpoint named) —
        // the per-currency isolation mechanism: each /transactions call serves exactly one
        // currency, so the Err fails only that currency's request, never the others.
        let fetch = move |_start: Option<Nat>| async move {
            Err::<IcpIndexAccountTransactionsOk, _>(LedgerError::Transient(
                "get_account_transactions query: boom".into(),
            ))
        };
        let err = rt()
            .block_on(AgentLedger::icp_index_walk(
                fetch, &me, &me_id, 7, 30, None, deadline_ahead(),
            ))
            .unwrap_err();
        match err {
            LedgerError::Transient(msg) => assert!(
                msg.contains("get_account_transactions"),
                "the error names the index endpoint: {msg}"
            ),
            other => panic!("expected Transient, got {other:?}"),
        }
    }
}
