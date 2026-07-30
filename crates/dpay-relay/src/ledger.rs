//! The ledger seam. The relay orchestrates (idempotency, retries, HTTP); *settlement* — the
//! read-check-write of money — lives behind this trait.
//!
//! Two impls today:
//! - [`FakeLedger`]: an in-memory ledger that mirrors the canister's `pay` semantics EXACTLY
//!   (same `dpay_core::validate` rules, same atomic transfer, unix-seconds time). This is what
//!   the fast offline inner loop runs against.
//! - [`FlakyLedger`] (test-only): wraps any ledger and fails the first N calls with a transient
//!   error, to exercise the relay's retry path.
//!
//! A real ICP-agent impl (talking to the canister) is out of scope here — it slots in behind the
//! same trait.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use ed25519_dalek::{Signature, SigningKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use dpay_core::{
    sign_receipt, validate, CodecError, Currency, PayError, ReceiptClaim, SignedAuthorization,
    WithdrawAuth, DEMO_USD, NONCE_LEN, PUBKEY_LEN,
};

/// The minimal withdrawal amount the facade honors, in sats. Mirrors the LIVE ckBTC minter's
/// `retrieve_btc_min_amount` (= 50_000, returned by `get_minter_info` on `mqygn-kiaaa-aaaar-qaadq-cai`
/// and confirmed in OPEN_ISSUES.md) and the canister's `RETRIEVE_BTC_MIN_AMOUNT`. Single-sourced here
/// so the relay's local pre-check + the FakeLedger simulation can't drift from the real floor.
const RETRIEVE_BTC_MIN_AMOUNT: u64 = 50_000;

/// Sentinel "account" the canister reserves for mint/burn history rows (`[0xFF; 32]`). A real
/// Ed25519 pubkey is a valid curve point, so this all-ones value can never be a user's pubkey
/// (`verify_strict` rejects it). The canister rejects a `pay` that names it as the payee; the
/// FakeLedger mirrors that reject so the two can't diverge (W3 audit).
const MINT_ACCOUNT: [u8; PUBKEY_LEN] = [0xFF; PUBKEY_LEN];

/// Verified mainnet constants for the ckUSDC onramp (ckERC-20 family). ckUSDC has NO per-principal
/// IC deposit address and NO user-callable mint — the user performs two Ethereum transactions from
/// their own wallet (approve + depositErc20); the relay only surfaces these so the app can build the
/// calldata (see OPEN_ISSUES.md O6 + `app/cketh.ts`). In production these are read at runtime from the
/// ckETH minter's `get_minter_info`; the constants below are the authoritative mainnet values
/// (verified 2026-07-31 — do not re-derive). Single-sourced here so the FakeLedger + AgentLedger
/// impls can't drift from the verified addresses.
pub(crate) const CKERC20_HELPER_ADDRESS: &str = "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68";
pub(crate) const CKUSDC_ERC20_ADDRESS: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/// What the merchant sees on success. Byte fields are hex so the JSON is a plain string map.
/// Mirrors the canister's `PayReceipt` (which returns the same fields as candid `blob`s).
///
/// `receipt_sig` + `pubkey` (R2) carry the canister's Ed25519 signature over the canonical
/// `ReceiptClaim` and the canister's public key — the payer verifies `receipt_sig` over the claim
/// built from `{nonce, from, to, amount, currency, block_index, settle_ts}` under `pubkey` before
/// trusting the outcome. `block_index`/`settle_ts`/`currency` are the remaining claim fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Receipt {
    pub from: String,
    pub to: String,
    pub amount: u64,
    pub nonce: String,
    pub new_from_balance: u64,
    pub currency: Currency,
    pub block_index: u64,
    pub settle_ts: u64,
    /// Hex-encoded 64-byte Ed25519 signature over the canonical ReceiptClaim.
    pub receipt_sig: String,
    /// Hex-encoded 32-byte receipt public key (the signer's). Verify the sig under this.
    pub pubkey: String,
}

/// One settled transaction, as the wallet's history list shows it. Byte fields are hex (matches
/// [`Receipt`]). `timestamp` is unix seconds. Direction (in/out) is derived by the caller comparing
/// the queried account's pubkey to `from`. Mirrors the canister's `TxnView`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TxnRecord {
    pub from: String,
    pub to: String,
    pub amount: u64,
    pub nonce: String,
    pub currency: Currency,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Deposit surface (ckBTC-style top-up). These mirror the canister's deposit
// types (§3.1 of the deposit-integration plan) but live here as serde structs
// so the relay's HTTP layer speaks plain JSON. The agent impl (feature
// `agent`) translates between these and the candid `Nat`-bearing mirrors.
// ---------------------------------------------------------------------------

/// One UTXO the minter has *already* minted in this refresh call. `block_index` is the ckBTC
/// ledger's block index — a candid `nat` on the wire, so it is carried as a `String` (a `Nat` /
/// `u128` doesn't round-trip cleanly in JSON). Mirrors the canister's `MintedUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MintedUtxo {
    pub block_index: String,
    pub amount: u64,
}

/// One UTXO seen on-chain but not yet confirmed enough to mint. Mirrors the canister's `PendingUtxo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingUtxo {
    pub value: u64,
    pub confirmations: u64,
}

/// Result of a deposit refresh — what the wallet's "Add money" sheet polls. `minted_total > 0`
/// means real ck-asset was just credited to the user's subaccount; the wallet then re-reads its
/// balance. Mirrors the canister's `DepositRefresh`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositRefresh {
    pub minted: Vec<MintedUtxo>,
    pub minted_total: u64,
    pub pending: Vec<PendingUtxo>,
    pub required_confirmations: u32,
}

/// Static instructions for a currency's deposit path (min confirmations, fee, min amount). Lets the
/// wallet render "Send BTC here · ~N confirmations · min X sats" before showing the address. Mirrors
/// the canister's `DepositInfo`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositInfo {
    pub min_confirmations: u32,
    pub deposit_fee: u64,
    pub deposit_min_amount: Option<u64>,
}

// ---------------------------------------------------------------------------
// Withdrawal surface (ckBTC → native BTC out). These mirror the canister's
// `WithdrawRequest` / `WithdrawReceipt` (§W2) but live here as serde structs so the relay's HTTP
// layer speaks plain JSON (byte fields are hex, matching [`Receipt`]). The agent impl (feature
// `agent`) translates these to/from the canister's candid `blob` fields.
// ---------------------------------------------------------------------------

/// Request body for `POST /api/v1/withdraw`: the user's signed withdrawal authorization. `from` is
/// the hex Ed25519 pubkey (the debit subaccount), `nonce`/`sig` are hex (16/64 bytes), `amount` is
/// satoshis. The facade verifies `sig` over the canonical [`WithdrawAuth`] signing bytes under
/// `from` before moving any funds (non-custodial).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithdrawRequest {
    pub from: String,
    pub btc_address: String,
    pub amount: u64,
    pub nonce: String,
    pub expiry: u64,
    pub currency: Currency,
    pub sig: String,
}

/// Settlement receipt for a successful withdrawal: echoes the authorization + the ckBTC ledger's burn
/// block index. Mirrors the canister's `WithdrawReceipt`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WithdrawReceipt {
    pub from: String,
    pub btc_address: String,
    pub amount: u64,
    pub nonce: String,
    pub currency: Currency,
    pub block_index: u64,
}

// ---------------------------------------------------------------------------
// Catalog surface (M0). The canister now exposes `currencies() -> vec
// CurrencyDescriptor` (query) — the wallet's runtime source of truth for which
// assets exist and how to display/fund them, closing the hardcoded-
// `DEPOSIT_CURRENCY` coupling (issue #7). These serde structs are the relay's
// JSON shape: principals are TEXT (the candid `principal` is round-tripped
// through `.to_text()` by the agent impl so the HTTP layer stays plain JSON),
// and `MinterFamily` is the plain PascalCase variant tag (matches the candid
// variant label and the JSON string the wallet reads). The agent impl (feature
// `agent`) translates between these and its candid mirrors.
// ---------------------------------------------------------------------------

/// The proxy family a ck currency's minter belongs to — drives per-family ramp dispatch in the
/// wallet. Mirrors the canister's `MinterFamily` candid variant; serialized as the plain variant
/// name (e.g. `"CkBtcUtxo"`), matching both the candid label and the wallet's JSON contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum MinterFamily {
    CkBtcUtxo,
    CkEthErc20,
    CkSol,
}

/// One currency the wallet can hold/fund — the runtime catalog entry. Mirrors the canister's
/// `CurrencyDescriptor`. `minter` is `Some` only for ck currencies with a registered ramp;
/// `minter_family`/`symbol`/`decimals` are `None` when unregistered (the wallet falls back).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CurrencyDescriptor {
    pub currency: Currency,
    /// Principal of the currency's ICRC ledger, as canonical TEXT (hex/canonical) — keeps the
    /// relay's JSON clean and matches how the app consumes it.
    pub ledger: String,
    pub mintable: bool,
    /// Ramp (ck minter) principal as text, when a minter is registered for this currency.
    pub minter: Option<String>,
    pub minter_family: Option<MinterFamily>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
}

/// Onramp parameters for a ckERC-20 currency (ckUSDC etc.). The app builds the user's two Ethereum
/// transactions (approve + depositErc20) from these; the user signs in their own wallet (non-custodial).
/// `facade_principal` is the canister id encoded as the depositErc20 `principal` arg; the user's pubkey
/// is the subaccount. In production these come from the ckETH minter's `get_minter_info`; the offline
/// FakeLedger returns the verified mainnet constants.
#[derive(Serialize)]
pub struct CkErc20OnrampParams {
    pub helper_address: String,     // the CkDeposit helper contract (0x…)
    pub erc20_address: String,      // the token's ERC-20 contract (0x…) — per-token
    pub facade_principal: String,   // the facade canister principal (text) — the depositErc20 `principal` arg
}

/// Settlement outcome. `Rejected` is a permanent policy failure (bad sig, expired, over cap,
/// insufficient funds, reused nonce, malformed wire) — the relay must NOT retry it and surfaces
/// it as `422`. `Transient` is an infrastructure hiccup (e.g. the agent/canister was briefly
/// unreachable) — the relay retries it a bounded number of times.
#[derive(Clone, Debug, Error)]
pub enum LedgerError {
    #[error("rejected: {0}")]
    Rejected(String),
    #[error("transient: {0}")]
    Transient(String),
}

/// A clock returning unix seconds. Injectable so tests can pin `now` (matching the canister,
/// which divides `ic_cdk::api::time()` ns down to seconds).
pub trait Clock: Send + Sync {
    fn now_secs(&self) -> u64;
}

/// Real wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

/// A clock pinned to a fixed instant (tests / deterministic demos).
pub struct FixedClock(pub u64);

impl Clock for FixedClock {
    fn now_secs(&self) -> u64 {
        self.0
    }
}

/// The settlement seam. `async_trait` keeps it dyn-compatible so `Arc<dyn Ledger>` works.
#[async_trait]
pub trait Ledger: Send + Sync {
    /// Settle a 196-byte signed authorization (the payer's QR, decoded to wire bytes). The
    /// settlement currency is read out of the wire — the payer copied the merchant's request
    /// currency into their authorization — so `pay` itself takes no currency argument.
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError>;

    /// Read an account's balance (minor units) of `currency`. Lets a wallet show its live balance
    /// for the asset it actually holds when online.
    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError>;

    /// Self-service demo faucet: credit `to` with `amount` of `currency`, returning the new balance.
    /// Funds a freshly-generated on-device account (the demo on-ramp).
    ///
    /// **Two faithful models.** [`FakeLedger`] (the offline demo ledger) credits the REQUESTED
    /// `amount` and applies no cooldown — it is play money, and the e2e flow exercises a repeatable
    /// top-up. [`AgentLedger`](crate::AgentLedger) (the real canister) IGNORES `amount` and calls the
    /// canister's `faucet(account, currency)`, which mints a FIXED constants-sourced amount and is
    /// rate-limited per (account, currency) — a client cannot print unbounded funds or pick an
    /// amount. The relay's `/faucet` route passes `amount` through; the canister overrides it. The
    /// canister's rate-limiting + fixed-amount are proven on PocketIC (see `dpay-canister-tests`).
    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError>;

    /// List this account's settled transactions in `currency`, newest-first, up to `limit`. Lets a
    /// wallet render a durable history sourced from the ledger (the in-memory UI list is gone on
    /// restart; this is the source of truth).
    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError>;

    /// ckBTC-style deposit address for `pubkey`/`currency` — the native-chain address the user
    /// sends to (the minter derives it per-principal via threshold signatures). Revealing it only
    /// lets someone send *to* the user, so the facade proxy needs no payer auth. The relay just
    /// hands it back.
    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError>;

    /// Refresh the deposit for `pubkey`/`currency`: asks the facade (→ ck minter `update_balance`)
    /// to mint any now-confirmed UTXOs. Value-creating but idempotent (a no-op when nothing is
    /// confirmed). Returns what was minted + what's still pending. Per the deposit plan's §0 error
    /// rule, the proxy endpoints have **no permanent-policy failure**, so impls surface only
    /// [`LedgerError::Transient`].
    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError>;

    /// Static deposit instructions for `currency` (min confirmations, fee, min amount).
    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError>;

    /// The full currency catalog — the wallet's runtime source of truth for which assets exist and
    /// how to display/fund them (closes the hardcoded-`DEPOSIT_CURRENCY` coupling). Joins the
    /// canister's LEDGERS + MINTERS + CURRENCY_META. Unauthenticated (catalog only — no balances).
    /// Impl errors are `Transient` (an unreachable canister); there is no permanent-policy failure.
    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError>;

    /// ckERC-20 onramp parameters (helper contract, ERC-20 address, facade principal) for the given
    /// currency. Only meaningful for CkEthErc20-family currencies. Returns Transient(503) if the
    /// currency has no ckERC-20 onramp configured.
    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError>;

    /// Withdraw ckBTC to a native BTC address on a VERIFIED user signature. The request carries the
    /// [`WithdrawAuth`] fields + the Ed25519 signature (hex); the ledger verifies the signature under
    /// `from` (== the debit subaccount) before moving any funds. On success the ckBTC is debited from
    /// `Account{facade, subaccount: from}` and the burn block index is returned.
    ///
    /// Error mapping mirrors the deposit surface's §0 rule for *transient* failures (a transport /
    /// minter-unavailable hiccup → `Transient` → HTTP 503), but a **permanent policy failure** (bad
    /// signature, expired, below min, insufficient funds, nonce reused) is `Rejected` → HTTP 422 — the
    /// relay must not signal "retry" for a rejection that will never succeed.
    ///
    /// The default returns a permanent `Rejected` so ledgers that don't support withdrawal (e.g.
    /// narrow test stubs) refuse cleanly rather than silently no-op. [`FakeLedger`] and
    /// [`AgentLedger`](crate::AgentLedger) override it.
    async fn withdraw(&self, _req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        Err(LedgerError::Rejected("withdraw not supported on this ledger".into()))
    }

    /// The receipt-signing public key (32 bytes) of the ledger/canister, so a payer can verify a
    /// `Receipt`'s `receipt_sig` over its canonical `ReceiptClaim`. `FakeLedger` returns a stable
    /// test key; `AgentLedger` queries the canister's `receipt_pubkey`. (A receipt also carries its
    /// own `pubkey` field, so this is an optional cross-check / pre-fetch.)
    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError>;

    /// Seed a pending deposit for `pubkey`/`currency` (the test-helpers hook a browser e2e harness
    /// uses to simulate a confirmed ckBTC deposit landing). Mirrors `FakeLedger::register_deposit`:
    /// the next `deposit_status` drains it and credits the balance.
    ///
    /// **Test-only.** Feature-gated behind `test-helpers` so the method — and the HTTP route that
    /// calls it (`POST /api/v1/test/deposit/seed`) — do not compile into the prod image. Only
    /// [`FakeLedger`] implements this for real; the default returns a permanent `Rejected` so any
    /// other ledger (e.g. the real `AgentLedger`) refuses rather than silently no-ops. The route is
    /// only ever wired against a `FakeLedger` in the local e2e harness.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        // Deliberately consume the args so unused-variable lints stay clean on impls that take the
        // default (every real impl overrides this).
        let _ = (pubkey, currency, amount);
        Err(LedgerError::Rejected("seed_deposit not supported on this ledger".into()))
    }

    /// Liveness for the merchant's pre-flight green dot.
    async fn healthy(&self) -> bool;
}

// ---------------------------------------------------------------------------
// FakeLedger — in-memory, canister-faithful.
// ---------------------------------------------------------------------------

struct FakeState {
    /// Composite key `(pubkey, currency)` → balance in minor units. A single account may hold
    /// multiple currencies independently — they're different assets, not one pool.
    balances: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    spent: HashSet<[u8; NONCE_LEN]>,
    /// Single-use withdrawal idempotency keys (mirror of the canister's `WITHDRAW_NONCES`, kept
    /// SEPARATE from `spent` so a withdraw nonce can't collide with/block a pay nonce). A signed
    /// [`WithdrawAuth`] may be submitted at most once; a replay is `Rejected` (NonceReused).
    withdraw_nonces: HashSet<[u8; NONCE_LEN]>,
    /// Settled transactions, oldest-first (the order they were pushed). `transactions_of` reverses
    /// to newest-first and filters by (currency, account). Mirrors the canister's ACCOUNT_TXNS so
    /// the relay's inner loop is canister-faithful on history too.
    txns: Vec<TxnRecord>,
    /// Test/demo seeding for the deposit path: a pending (unconfirmed) inbound UTXO per
    /// `(pubkey, currency)`. `deposit_status` drains this and credits `balances`, mirroring the
    /// minter's `update_balance` mint-after-confirmation. Lets the offline inner loop prove the
    /// deposit→mint→balance flow without a real ckBTC minter.
    pending_deposits: HashMap<([u8; PUBKEY_LEN], Currency), u64>,
    /// Monotonic stand-in for the ICRC ledger block index (the FakeLedger has no real ledger), so
    /// each settled pay gets a distinct `block_index` for its receipt claim — matching the real
    /// canister's outcome-attestation shape.
    next_block: u64,
}

/// In-memory ledger. Balances + spent-nonces behind one `Mutex` so the read-check-write is
/// atomic (the real canister is single-threaded, giving the same guarantee for free).
pub struct FakeLedger {
    state: Mutex<FakeState>,
    per_tx_cap: u64,
    clock: Box<dyn Clock>,
    /// Stable TEST-ONLY Ed25519 key the FakeLedger signs receipts with (the real canister generates
    /// its own via `raw_rand`). A fixed seed keeps it deterministic across runs; its public half is
    /// exposed via [`Ledger::receipt_pubkey`] and embedded in each receipt. Test code only — never
    /// in the prod canister/relay image (FakeLedger itself is the offline demo ledger).
    receipt_sk: SigningKey,
}

impl FakeLedger {
    /// Pre-fund the two demo accounts in `DEMO_USD` and set the per-transaction cap. Uses the wall
    /// clock.
    pub fn new(
        account_a: [u8; PUBKEY_LEN],
        balance_a: u64,
        account_b: [u8; PUBKEY_LEN],
        balance_b: u64,
        per_tx_cap: u64,
    ) -> Self {
        Self::with_clock(
            account_a,
            balance_a,
            account_b,
            balance_b,
            per_tx_cap,
            Box::new(SystemClock),
        )
    }

    /// Same, with an injected clock (deterministic tests / demos).
    pub fn with_clock(
        account_a: [u8; PUBKEY_LEN],
        balance_a: u64,
        account_b: [u8; PUBKEY_LEN],
        balance_b: u64,
        per_tx_cap: u64,
        clock: Box<dyn Clock>,
    ) -> Self {
        // Pre-funding is in DEMO_USD — the demo ledger's only asset. A real ledger's init would
        // carry the currency alongside each balance; here there's just one.
        let mut balances = HashMap::new();
        if balance_a > 0 {
            balances.insert((account_a, DEMO_USD), balance_a);
        }
        if balance_b > 0 {
            balances.insert((account_b, DEMO_USD), balance_b);
        }
        FakeLedger {
            state: Mutex::new(FakeState {
                balances,
                spent: HashSet::new(),
                withdraw_nonces: HashSet::new(),
                txns: Vec::new(),
                pending_deposits: HashMap::new(),
                next_block: 0,
            }),
            per_tx_cap,
            clock,
            // Fixed test seed (documented test-only). The real canister's receipt key comes from
            // `raw_rand`; this stable key lets the offline e2e verify a real signature end-to-end.
            receipt_sk: SigningKey::from_bytes(&[0xf5; 32]),
        }
    }

    /// Read a balance (test/demo introspection; not part of the trait).
    pub fn balance_of(&self, pubkey: &[u8; PUBKEY_LEN], currency: Currency) -> u64 {
        let s = self.state.lock().unwrap();
        *s.balances.get(&(*pubkey, currency)).unwrap_or(&0)
    }

    /// Seed a pending deposit for `pubkey`/`currency` (test/demo hook). The next `deposit_status`
    /// call drains it and credits the balance, mirroring the ck minter minting after confirmations.
    /// Multiple seeds for the same `(pubkey, currency)` accumulate.
    pub fn register_deposit(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency, amount: u64) {
        let mut s = self.state.lock().unwrap();
        *s.pending_deposits.entry((pubkey, currency)).or_insert(0) += amount;
    }
}

/// The catalog the offline FakeLedger reports — mirrors a demo deployment: DEMO_USD (currency 0,
/// mintable, the `$` faucet asset) + ckBTC (currency 1, the CkBtcUtxo deposit/withdraw ramp asset) +
/// ckUSDC (currency 2, the CkEthErc20 onramp asset). The principal text values are the canonical
/// management/anon/minter stand-ins the demo uses (`aaaaa-aa` = the mgmt canister, `2vxsx-fae` = the
/// anonymous principal, `mqygn-kiaaa-aaaar-qaadq-cai` = the live ckBTC minter, `sv3dd-…` = the live
/// ckETH minter, `xevnm-…` = the live ckUSDC ledger); the wallet only reads
/// `currency`/`symbol`/`decimals`/`minter_family` for display. Hardcoded as TEXT (not built via
/// `candid::Principal`) because `candid` is feature-gated to `agent` and `ledger.rs` ships in the lean
/// offline build.
fn fake_catalog() -> Vec<CurrencyDescriptor> {
    vec![
        CurrencyDescriptor {
            currency: DEMO_USD,
            ledger: "aaaaa-aa".to_string(), // management canister text
            mintable: true,
            minter: None,
            minter_family: None,
            symbol: Some("$".into()),
            decimals: Some(2),
        },
        CurrencyDescriptor {
            currency: 1, // ckBTC-shaped deposit currency
            ledger: "2vxsx-fae".to_string(), // anonymous principal text
            mintable: false,
            minter: Some("mqygn-kiaaa-aaaar-qaadq-cai".to_string()),
            minter_family: Some(MinterFamily::CkBtcUtxo),
            symbol: Some("₿".into()),
            decimals: Some(8),
        },
        CurrencyDescriptor {
            currency: 2, // ckUSDC (ckERC-20 onramp currency)
            ledger: "xevnm-gaaaa-aaaar-qafnq-cai".to_string(), // ckUSDC ledger principal text
            mintable: false,
            minter: Some("sv3dd-oaaaa-aaaar-qacoa-cai".to_string()), // ckETH minter
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: Some("ckUSDC".to_string()),
            decimals: Some(6),
        },
    ]
}

/// Map a `dpay_core::PayError` (or codec failure) to the relay's rejection string. All of these
/// are permanent — none should be retried.
fn rejected(e: PayError) -> LedgerError {
    LedgerError::Rejected(format!("{e:?}"))
}

#[async_trait]
impl Ledger for FakeLedger {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Decode + verify are pure; do them outside the lock.
        let sa = SignedAuthorization::from_wire(&wire)
            .map_err(|e: CodecError| LedgerError::Rejected(format!("decode: {e:?}")))?;
        let sig_ok = sa.verify();
        let now = self.clock.now_secs();
        let currency = sa.auth.currency;

        // Cheap local rejects that mirror the canister's `pay` body EXACTLY (W3 audit: the FakeLedger
        // must not accept a payment the real canister rejects). The canister rejects a self-transfer
        // (`from == to`) and a payment to the mint sentinel (`to == [0xFF;32]`) before reserving the
        // nonce; the FakeLedger does the same so the two can't diverge.
        if sa.auth.from == sa.auth.to {
            return Err(LedgerError::Rejected("self transfer".to_string()));
        }
        if sa.auth.to == MINT_ACCOUNT {
            return Err(LedgerError::Rejected("pay to mint sentinel".to_string()));
        }

        // Single critical section: read balance/nonce, validate, commit atomically — exactly the
        // canister's `pay` body. Lookups are keyed by (pubkey, currency) — debiting/crediting the
        // asset the authorization actually names.
        let mut s = self.state.lock().unwrap();
        let from = sa.auth.from;
        let balance = *s.balances.get(&(from, currency)).unwrap_or(&0);
        let nonce_seen = s.spent.contains(&sa.auth.nonce);

        validate(&sa.auth, now, self.per_tx_cap, balance, nonce_seen, sig_ok).map_err(rejected)?;

        let new_from = balance - sa.auth.amount;
        s.balances.insert((from, currency), new_from);
        *s.balances.entry((sa.auth.to, currency)).or_insert(0) += sa.auth.amount;
        s.spent.insert(sa.auth.nonce);
        // Record the settled payment so the wallet's history list is sourced from the ledger (not an
        // ephemeral UI state). Matches the canister's per-(account,currency) index; FakeLedger keeps
        // one flat list and filters on read.
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: sa.auth.amount,
            nonce: hex::encode(sa.auth.nonce),
            currency,
            timestamp: now,
        });
        // Assign a monotonic block index (stand-in for the ICRC ledger block) and sign the receipt
        // claim with the FakeLedger's stable test key — the offline analogue of the canister's
        // canister-signed outcome receipt. The app verifies `receipt_sig` under `pubkey` before
        // showing "Paid ✓".
        let block_index = s.next_block;
        s.next_block += 1;
        let claim = ReceiptClaim {
            nonce: sa.auth.nonce,
            from,
            to: sa.auth.to,
            amount: sa.auth.amount,
            currency,
            block_index,
            settle_ts: now,
        };
        let sig = sign_receipt(&self.receipt_sk, &claim).to_bytes();
        let pubkey = self.receipt_sk.verifying_key().to_bytes();

        Ok(Receipt {
            from: hex::encode(from),
            to: hex::encode(sa.auth.to),
            amount: sa.auth.amount,
            nonce: hex::encode(sa.auth.nonce),
            new_from_balance: new_from,
            currency,
            block_index,
            settle_ts: now,
            receipt_sig: hex::encode(sig),
            pubkey: hex::encode(pubkey),
        })
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        Ok(self.balance_of(&pubkey, currency))
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        Ok(self.receipt_sk.verifying_key().to_bytes().to_vec())
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        // FakeLedger is the permissive DEMO model: credit the requested amount, no cooldown (play
        // money; the e2e flow exercises a repeatable top-up). The real canister's faucet mints a
        // FIXED amount and rate-limits — proven on PocketIC, not modeled here.
        let mut s = self.state.lock().unwrap();
        let bal = s.balances.entry((to, currency)).or_insert(0);
        *bal = bal.saturating_add(amount);
        Ok(*bal)
    }

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        let s = self.state.lock().unwrap();
        let pk_hex = hex::encode(pubkey);
        // FakeState pushes oldest-first; filter to this (currency, account) and reverse to newest.
        let mut rows: Vec<TxnRecord> = s
            .txns
            .iter()
            .filter(|t| t.currency == currency && (t.from == pk_hex || t.to == pk_hex))
            .cloned()
            .collect();
        rows.reverse();
        Ok(rows.into_iter().take(limit.max(1) as usize).collect())
    }

    async fn healthy(&self) -> bool {
        // In-memory ledger is healthy iff its mutex isn't poisoned.
        self.state.lock().is_ok()
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        _currency: Currency,
    ) -> Result<String, LedgerError> {
        // Deterministic fake address: a recognizable `bc1qdpay` prefix + the first 8 pubkey bytes
        // (hex). Distinct per pubkey, stable across calls — enough to drive the wallet's "show my
        // deposit address" UI offline. Mirrors how a real minter derives per-principal addresses.
        Ok(format!("bc1qdpay{}", hex::encode(&pubkey[..8])))
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        // Drain the pending deposit for this (pubkey, currency) and credit the balance — the
        // offline analogue of the minter's `update_balance` minting confirmed UTXOs. A second call
        // finds nothing pending and reports minted_total = 0.
        let mut s = self.state.lock().unwrap();
        if let Some(amount) = s.pending_deposits.remove(&(pubkey, currency)) {
            let bal = s.balances.entry((pubkey, currency)).or_insert(0);
            *bal = bal.saturating_add(amount);
            Ok(DepositRefresh {
                minted: vec![MintedUtxo { block_index: "0".to_string(), amount }],
                minted_total: amount,
                pending: vec![],
                required_confirmations: 1,
            })
        } else {
            Ok(DepositRefresh {
                minted: vec![],
                minted_total: 0,
                pending: vec![],
                required_confirmations: 1,
            })
        }
    }

    async fn deposit_info(&self, _currency: Currency) -> Result<DepositInfo, LedgerError> {
        // Fake deposit params: 1 confirmation, no fee, no minimum — the most permissive config, so
        // the offline loop's "Add money" sheet always renders instructions.
        Ok(DepositInfo {
            min_confirmations: 1,
            deposit_fee: 0,
            deposit_min_amount: Some(0),
        })
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        Ok(fake_catalog())
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        if currency == 2 {
            Ok(CkErc20OnrampParams {
                helper_address: CKERC20_HELPER_ADDRESS.to_string(),
                erc20_address: CKUSDC_ERC20_ADDRESS.to_string(),
                // demo placeholder; offline mode never broadcasts — the calldata encoding is
                // shape-correct regardless of the value, and the mock window.ethereum in e2e never
                // submits. In production this is the facade canister principal.
                facade_principal: "aaaaa-aa".to_string(),
            })
        } else {
            Err(LedgerError::Transient("no ckERC-20 onramp for currency".into()))
        }
    }

    /// Withdraw ckBTC to a native BTC address. Mirrors the canister's `withdraw` settlement EXACTLY
    /// (W3 audit: the FakeLedger's accept/reject must match the real canister). Single critical
    /// section under the `FakeState` mutex (the canister is single-threaded; same guarantee). There
    /// is no real minter here, so the "burn" is modeled as a direct debit of `amount` from the user's
    /// subaccount (the net ledger effect of retrieve_btc_with_approval). The signed WithdrawAuth is
    /// verified under `from` (== the debit subaccount) before any state change — non-custodial.
    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Decode hex fields outside the lock (pure; a bad shape is a permanent reject).
        let from = hex::decode(&req.from)
            .map_err(|e| LedgerError::Rejected(format!("bad from hex: {e}")))
            .and_then(|b| {
                <[u8; PUBKEY_LEN]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("from must be 32 bytes".into()))
            })?;
        let nonce = hex::decode(&req.nonce)
            .map_err(|e| LedgerError::Rejected(format!("bad nonce hex: {e}")))
            .and_then(|b| {
                <[u8; NONCE_LEN]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("nonce must be 16 bytes".into()))
            })?;
        let sig_arr = hex::decode(&req.sig)
            .map_err(|e| LedgerError::Rejected(format!("bad sig hex: {e}")))
            .and_then(|b| {
                <[u8; 64]>::try_from(b.as_slice())
                    .map_err(|_| LedgerError::Rejected("sig must be 64 bytes".into()))
            })?;
        let sig = Signature::from_bytes(&sig_arr);

        // NON-CUSTODIAL GATE: rebuild the WithdrawAuth + verify the signature under `from` BEFORE
        // reserving the nonce or touching the balance. `from` is both the verify key AND the debit
        // subaccount, so a signature under any other key moves no funds. (Mirrors the canister, which
        // checks the sig before the nonce reserve.)
        let auth = WithdrawAuth {
            from_pubkey: from,
            btc_address: req.btc_address.clone(),
            amount: req.amount,
            nonce,
            expiry: req.expiry,
            currency: req.currency,
        };
        if !auth.verify(&from, &sig) {
            return Err(LedgerError::Rejected("bad signature".to_string()));
        }

        let now = self.clock.now_secs();
        // Cheap local rejects (mirror the canister's pre-burn checks).
        if req.amount == 0 {
            return Err(LedgerError::Rejected("zero amount".to_string()));
        }
        if req.expiry < now {
            return Err(LedgerError::Rejected("expired".to_string()));
        }
        if req.amount < RETRIEVE_BTC_MIN_AMOUNT {
            return Err(LedgerError::Rejected(format!(
                "amount below retrieve_btc_min_amount ({RETRIEVE_BTC_MIN_AMOUNT})"
            )));
        }

        // Single critical section: reserve the withdraw nonce, check funds, commit the burn atomically.
        let mut s = self.state.lock().unwrap();
        if !s.withdraw_nonces.insert(nonce) {
            return Err(LedgerError::Rejected("nonce already used".to_string()));
        }
        let balance = *s.balances.get(&(from, req.currency)).unwrap_or(&0);
        if req.amount > balance {
            // Insufficient funds: the canister RELEASES the nonce (retryable pre-burn failure); mirror
            // that here so a later deposit + same-auth retry can succeed within the expiry window.
            s.withdraw_nonces.remove(&nonce);
            return Err(LedgerError::Rejected(format!("InsufficientFunds: balance {balance}")));
        }
        // Commit the burn: debit the user's subaccount. (No fee model — the FakeLedger is the fee-less
        // demo ledger; the real canister + ledger enforce the ckBTC transfer fee authoritatively.)
        let new_balance = balance - req.amount;
        s.balances.insert((from, req.currency), new_balance);
        // Record the withdrawal as a history row (counterparty = MINT_ACCOUNT sentinel, like `burn`).
        let block_index = s.next_block;
        s.next_block += 1;
        s.txns.push(TxnRecord {
            from: hex::encode(from),
            to: hex::encode(MINT_ACCOUNT),
            amount: req.amount,
            nonce: hex::encode(nonce),
            currency: req.currency,
            timestamp: now,
        });
        Ok(WithdrawReceipt {
            from: hex::encode(from),
            btc_address: req.btc_address,
            amount: req.amount,
            nonce: hex::encode(nonce),
            currency: req.currency,
            block_index,
        })
    }

    /// Test-only deposit seed (feature-gated; see [`Ledger::seed_deposit`]). Delegates to the
    /// existing `register_deposit` hook so the e2e harness's `POST /api/v1/test/deposit/seed`
    /// exercises the *exact* pending→credited path a real refresh would, through the real router.
    #[cfg(feature = "test-helpers")]
    async fn seed_deposit(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<(), LedgerError> {
        self.register_deposit(pubkey, currency, amount);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// FlakyLedger — test-only retry harness.
// ---------------------------------------------------------------------------

/// Wraps a ledger and returns [`LedgerError::Transient`] for the first `fail_first` calls to
/// `pay`, then delegates. Used to prove the relay's retry loop eventually succeeds. Not compiled
/// into the shipping binary in spirit, but kept in the lib so integration tests can reach it.
pub struct FlakyLedger<L: Ledger> {
    inner: L,
    fail_first: Mutex<u32>,
}

impl<L: Ledger> FlakyLedger<L> {
    pub fn new(inner: L, fail_first: u32) -> Self {
        FlakyLedger {
            inner,
            fail_first: Mutex::new(fail_first),
        }
    }
}

#[async_trait]
impl<L: Ledger> Ledger for FlakyLedger<L> {
    async fn pay(&self, wire: Vec<u8>) -> Result<Receipt, LedgerError> {
        // Decrement-and-check under the lock, then release before awaiting inner.
        let should_fail = {
            let mut n = self.fail_first.lock().unwrap();
            if *n > 0 {
                *n -= 1;
                true
            } else {
                false
            }
        };
        if should_fail {
            return Err(LedgerError::Transient("flaky: injected transient".into()));
        }
        self.inner.pay(wire).await
    }

    async fn balance(&self, pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Result<u64, LedgerError> {
        self.inner.balance(pubkey, currency).await
    }

    async fn faucet(
        &self,
        to: [u8; PUBKEY_LEN],
        currency: Currency,
        amount: u64,
    ) -> Result<u64, LedgerError> {
        self.inner.faucet(to, currency, amount).await
    }

    async fn transactions_of(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
        limit: u32,
    ) -> Result<Vec<TxnRecord>, LedgerError> {
        self.inner.transactions_of(pubkey, currency, limit).await
    }

    async fn healthy(&self) -> bool {
        self.inner.healthy().await
    }

    async fn deposit_address(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<String, LedgerError> {
        // FlakyLedger only injects transients into `pay` (the retry path under test); the deposit
        // surface is a clean passthrough, mirroring how balance/mint delegate.
        self.inner.deposit_address(pubkey, currency).await
    }

    async fn deposit_status(
        &self,
        pubkey: [u8; PUBKEY_LEN],
        currency: Currency,
    ) -> Result<DepositRefresh, LedgerError> {
        self.inner.deposit_status(pubkey, currency).await
    }

    async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError> {
        self.inner.deposit_info(currency).await
    }

    async fn currencies(&self) -> Result<Vec<CurrencyDescriptor>, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the catalog surface delegates unchanged, mirroring deposit/balance delegation.
        self.inner.currencies().await
    }

    async fn ckerc20_onramp_params(&self, currency: Currency) -> Result<CkErc20OnrampParams, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the ckERC-20 onramp surface delegates unchanged, mirroring catalog/deposit delegation.
        self.inner.ckerc20_onramp_params(currency).await
    }

    async fn withdraw(&self, req: WithdrawRequest) -> Result<WithdrawReceipt, LedgerError> {
        // Clean passthrough: FlakyLedger only injects transients into `pay` (the retry path under
        // test); the withdrawal surface delegates unchanged, mirroring balance/faucet/deposit.
        self.inner.withdraw(req).await
    }

    async fn receipt_pubkey(&self) -> Result<Vec<u8>, LedgerError> {
        self.inner.receipt_pubkey().await
    }
}
