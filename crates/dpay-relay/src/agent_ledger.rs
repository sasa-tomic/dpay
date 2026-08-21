//! The real read path: an [`AgentLedger`] that talks to the dpay facade canister + the ICRC
//! ledgers on a live IC network via [`ic-agent`]. Same [`Ledger`] trait the relay serves, so
//! the axum app is unchanged — only the seam is swapped.
//!
//! Behind the `agent` cargo feature (off by default) so the fast in-memory inner loop stays
//! offline. What it drives:
//!   - facade `currencies() -> vec CurrencyDescriptor` (query) — the asset catalog; every ledger
//!     principal the relay needs is resolved from here.
//!   - each ledger's own ICRC-1/ICRC-3 endpoints (free queries, no facade hop, no consensus):
//!     `icrc1_balance_of` for balances and `get_transactions` for history, read at the USER's
//!     principal (the 2026-08-19 IC-rail cutover shape).
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
    CkErc20OnrampParams, CurrencyDescriptor, DepositInfo, Ledger, LedgerError, MinterFamily,
    RampCapability, TxnRecord, U64String, ckerc20_onramp_from_descriptor,
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
        let rows = self
            .transactions_walk(&ledger, &me, currency, limit, memo, deadline)
            .await;
        if let Ok(rows) = rows {
            Ok(rows)
        } else {
            rows
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

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        // facade `currencies() -> vec CurrencyDescriptor` (query). Translate candid mirrors -> the
        // relay's text-principal serde structs. Errors are `Transient` (canister unreachable); there
        // is no permanent-policy failure on the catalog surface.
        let reply = tokio::time::timeout(
            Duration::from_secs(CANISTER_CALL_TIMEOUT_SECS),
            self.agent
                .query(&self.canister_id, "currencies")
                .with_arg(encode_args(()).map_err(|e| LedgerError::Transient(format!("encode currencies: {e}")))?)
                .call(),
        )
        .await
        .map_err(|_| {
            LedgerError::Transient(format!(
                "currencies query timed out after {CANISTER_CALL_TIMEOUT_SECS}s"
            ))
        })?
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
        // authoritative ERC-20 address; the deposit `principal` arg is the USER's own IC principal
        // (derived in-app), so no principal is served here.
        //
        // The `helper_address` is read at RUNTIME from the descriptor's minter
        // (`minter_helper_address` below — a direct `get_minter_info` query), because the helper
        // is NETWORK-scoped deploy state that a ckETH-minter upgrade can change; the verified
        // constants (via `ckerc20_onramp_from_descriptor`) are only the FALLBACK, served when the
        // runtime read fails or the minter doesn't configure the field. Fail-closed gate
        // (family, chain_id, token discrimination) stays single-sourced in the pure resolver.
        let catalog = self.currencies().await?;
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
