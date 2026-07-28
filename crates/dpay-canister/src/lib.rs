//! dpay demo ledger canister.
//!
//! Holds two pre-funded accounts, verifies an offline-signed [`SignedAuthorization`], enforces
//! nonce/expiry/cap/balance via `dpay-core`, and moves funds atomically.
//!
//! State lives in **stable structures** ([`StableBTreeMap`] / [`StableCell`]) backed by stable
//! memory, so it survives canister upgrades automatically — no `pre_upgrade`/`post_upgrade`
//! serialization, and the ledger can grow past the heap. The canister is single-threaded and no
//! message awaits, so the read-check-write in [`pay`] runs atomically.
//!
//! Money-critical logic lives in `dpay-core` (shared with the relay, app, and tests) — the canister
//! is state + candid glue.

use candid::CandidType;
use ic_cdk::{init, query, update};
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::storable::Bound;
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell, Storable};
use serde::Deserialize;
use std::borrow::Cow;
use std::cell::RefCell;

use dpay_core::{validate, SignedAuthorization, Currency, DEMO_USD, NONCE_LEN, PUBKEY_LEN};

type Memory = VirtualMemory<DefaultMemoryImpl>;

/// Stable-map key for a per-currency balance entry: a 32-byte account pubkey followed by the 4
/// little-endian bytes of a [`Currency`] (`u32`) tag. Fixed size; byte order equals the derived
/// `Ord` (pubkey-major, then currency), so map iteration order is well-defined. One row per
/// (account, currency) pair — funds in different currencies never commingle.
const CURRENCY_LEN: usize = core::mem::size_of::<Currency>();
const BALANCE_KEY_LEN: usize = PUBKEY_LEN + CURRENCY_LEN;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct BalanceKey([u8; BALANCE_KEY_LEN]);

impl BalanceKey {
    fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency) -> Self {
        let mut b = [0u8; BALANCE_KEY_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&pubkey);
        b[PUBKEY_LEN..].copy_from_slice(&currency.to_le_bytes());
        BalanceKey(b)
    }
}

impl Storable for BalanceKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; BALANCE_KEY_LEN];
        a.copy_from_slice(&bytes);
        BalanceKey(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: BALANCE_KEY_LEN as u32, is_fixed_size: true };
}

/// Stable-map key for a 16-byte nonce.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Nonce([u8; NONCE_LEN]);

impl Storable for Nonce {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; NONCE_LEN];
        a.copy_from_slice(&bytes);
        Nonce(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: NONCE_LEN as u32, is_fixed_size: true };
}

/// Index key for a settled transaction: `pubkey(32) | currency_le(4) | seq_be(8)` = 44 bytes.
/// pubkey-major ordering keeps every (account, currency) block contiguous; `seq` is big-endian so a
/// forward range walks oldest→newest (and reversing yields newest-first). One record is inserted
/// under `from` AND under `to`, so an account's full history is a single contiguous key range.
const SEQ_LEN: usize = 8;
const TXN_KEY_LEN: usize = PUBKEY_LEN + CURRENCY_LEN + SEQ_LEN;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct AccountTxnKey([u8; TXN_KEY_LEN]);

impl AccountTxnKey {
    fn new(pubkey: [u8; PUBKEY_LEN], currency: Currency, seq: u64) -> Self {
        let mut b = [0u8; TXN_KEY_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&pubkey);
        b[PUBKEY_LEN..PUBKEY_LEN + CURRENCY_LEN].copy_from_slice(&currency.to_le_bytes());
        b[PUBKEY_LEN + CURRENCY_LEN..].copy_from_slice(&seq.to_be_bytes());
        AccountTxnKey(b)
    }
}

impl Storable for AccountTxnKey {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Borrowed(&self.0)
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        let mut a = [0u8; TXN_KEY_LEN];
        a.copy_from_slice(&bytes);
        AccountTxnKey(a)
    }
    const BOUND: Bound = Bound::Bounded { max_size: TXN_KEY_LEN as u32, is_fixed_size: true };
}

/// One settled payment, recorded under each side's pubkey. 100 bytes fixed. Mirrors the wire
/// fields the payer already signed (no fee, no new surfaces — read-only-after-settle).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct TxnRecord {
    from: [u8; PUBKEY_LEN],
    to: [u8; PUBKEY_LEN],
    amount: u64,
    nonce: [u8; NONCE_LEN],
    currency: Currency,
    timestamp: u64, // unix seconds the ledger settled it (`ic time / 1e9`)
}

const TXN_RECORD_LEN: usize = PUBKEY_LEN + PUBKEY_LEN + 8 + NONCE_LEN + 4 + 8; // = 100

impl Storable for TxnRecord {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        let mut b = [0u8; TXN_RECORD_LEN];
        b[..PUBKEY_LEN].copy_from_slice(&self.from);
        b[PUBKEY_LEN..2 * PUBKEY_LEN].copy_from_slice(&self.to);
        b[2 * PUBKEY_LEN..2 * PUBKEY_LEN + 8].copy_from_slice(&self.amount.to_le_bytes());
        b[2 * PUBKEY_LEN + 8..2 * PUBKEY_LEN + 8 + NONCE_LEN].copy_from_slice(&self.nonce);
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4]
            .copy_from_slice(&self.currency.to_le_bytes());
        b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..].copy_from_slice(&self.timestamp.to_le_bytes());
        Cow::Owned(b.to_vec())
    }
    fn from_bytes(bytes: Cow<[u8]>) -> Self {
        assert_eq!(bytes.len(), TXN_RECORD_LEN, "TxnRecord fixed-size invariant");
        let b = &bytes[..];
        let mut from = [0u8; PUBKEY_LEN];
        from.copy_from_slice(&b[..PUBKEY_LEN]);
        let mut to = [0u8; PUBKEY_LEN];
        to.copy_from_slice(&b[PUBKEY_LEN..2 * PUBKEY_LEN]);
        let amount = u64::from_le_bytes(b[2 * PUBKEY_LEN..2 * PUBKEY_LEN + 8].try_into().unwrap());
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&b[2 * PUBKEY_LEN + 8..2 * PUBKEY_LEN + 8 + NONCE_LEN]);
        let currency = u32::from_le_bytes(
            b[2 * PUBKEY_LEN + 8 + NONCE_LEN..2 * PUBKEY_LEN + 8 + NONCE_LEN + 4]
                .try_into()
                .unwrap(),
        );
        let timestamp = u64::from_le_bytes(b[2 * PUBKEY_LEN + 8 + NONCE_LEN + 4..].try_into().unwrap());
        TxnRecord { from, to, amount, nonce, currency, timestamp }
    }
    const BOUND: Bound =
        Bound::Bounded { max_size: TXN_RECORD_LEN as u32, is_fixed_size: true };
}

thread_local! {
    static MEMORY: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    /// (account pubkey, currency) -> balance (minor units). Per-currency segregation means a
    /// payment in currency X can never debit or credit currency Y.
    static BALANCES: RefCell<StableBTreeMap<BalanceKey, u64, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(0)))));

    /// spent nonces (single-use). Value is `()` — the map is used as a set.
    static SPENT: RefCell<StableBTreeMap<Nonce, (), Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(1)))));

    /// per-transaction spending cap (minor units).
    static CAP: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(2))), 0).expect("init cap cell"),
    );

    /// Monotonic counter assigning each settled transaction a global sequence number. Drives the
    /// ordering key in ACCOUNT_TXNS (big-endian → chronological → reversed range = newest-first).
    static TXN_SEQ: RefCell<StableCell<u64, Memory>> = RefCell::new(
        StableCell::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(3))), 0).expect("init txn seq cell"),
    );

    /// (account pubkey, currency, seq) -> [`TxnRecord`]. Each settled payment is inserted twice
    /// (once under `from`, once under `to`) so an account's full history is a single contiguous key
    /// range. Stable-backed → survives upgrades.
    static ACCOUNT_TXNS: RefCell<StableBTreeMap<AccountTxnKey, TxnRecord, Memory>> =
        RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(4)))));
}

/// Init argument: two demo accounts (32-byte Ed25519 pubkeys as `blob`), their opening balances,
/// and a per-transaction spending cap (minor units).
#[derive(CandidType, Deserialize)]
struct InitArg {
    account_a: Vec<u8>,
    balance_a: u64,
    account_b: Vec<u8>,
    balance_b: u64,
    per_tx_cap: u64,
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct PayReceipt {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    new_from_balance: u64,
}

/// Candid-facing transaction view (byte fields decode as blobs → `Vec<u8>`). Direction (in/out) is
/// derived client-side by comparing the queried account's pubkey to `from`.
#[derive(CandidType, Deserialize, Clone, Debug)]
struct TxnView {
    from: Vec<u8>,
    to: Vec<u8>,
    amount: u64,
    nonce: Vec<u8>,
    currency: u32,
    timestamp: u64,
}

fn to_pubkey(v: &[u8]) -> Result<[u8; PUBKEY_LEN], String> {
    v.try_into().map_err(|_| "bad pubkey length".to_string())
}

#[init]
fn init(arg: InitArg) {
    let a = to_pubkey(&arg.account_a).expect("account_a must be 32 bytes");
    let b = to_pubkey(&arg.account_b).expect("account_b must be 32 bytes");
    // Demo accounts open in DEMO_USD (the play-money faucet currency). Multi-currency funding is
    // per-account/per-currency via `mint`.
    BALANCES.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(BalanceKey::new(a, DEMO_USD), arg.balance_a);
        m.insert(BalanceKey::new(b, DEMO_USD), arg.balance_b);
    });
    CAP.with(|c| c.borrow_mut().set(arg.per_tx_cap).expect("set cap"));
}

/// Settle an offline-signed authorization. `signed` is the wire form (carries the
/// `currency` tag inside the authorization). Reads, validates, and commits within one
/// (non-awaiting) message → atomic on the single-threaded canister.
#[update]
fn pay(signed: Vec<u8>) -> Result<PayReceipt, String> {
    let sa = SignedAuthorization::from_wire(&signed).map_err(|e| format!("decode: {e:?}"))?;
    let sig_ok = sa.verify();
    // dpay-core works in unix seconds; IC time is nanoseconds.
    let now_secs = ic_cdk::api::time() / 1_000_000_000;

    // The currency the payer signed is the currency we debit/credit — the merchant's request names
    // it, the payer binds it, and the ledger moves funds only within that currency's column.
    let from_key = BalanceKey::new(sa.auth.from, sa.auth.currency);
    let to_key = BalanceKey::new(sa.auth.to, sa.auth.currency);
    let nonce = Nonce(sa.auth.nonce);

    let balance = BALANCES.with(|b| b.borrow().get(&from_key).unwrap_or(0));
    let nonce_seen = SPENT.with(|s| s.borrow().contains_key(&nonce));
    let cap = CAP.with(|c| *c.borrow().get());

    validate(&sa.auth, now_secs, cap, balance, nonce_seen, sig_ok).map_err(|e| format!("{e:?}"))?;

    let new_from = balance - sa.auth.amount;
    BALANCES.with(|b| {
        let mut b = b.borrow_mut();
        b.insert(from_key, new_from);
        let to_bal = b.get(&to_key).unwrap_or(0) + sa.auth.amount;
        b.insert(to_key, to_bal);
    });
    SPENT.with(|s| {
        s.borrow_mut().insert(nonce, ());
    });

    // Record the settled payment for BOTH sides so either account's history is one contiguous key
    // range. A single global sequence (big-endian in the key) gives chronological ordering; the
    // query reverses to newest-first. This is read-only-after-settle — it records what already
    // happened; it never moves funds or gates settlement.
    let seq = TXN_SEQ.with(|c| {
        let v = *c.borrow().get();
        c.borrow_mut().set(v + 1).expect("advance txn seq");
        v
    });
    let rec = TxnRecord {
        from: sa.auth.from,
        to: sa.auth.to,
        amount: sa.auth.amount,
        nonce: sa.auth.nonce,
        currency: sa.auth.currency,
        timestamp: now_secs,
    };
    ACCOUNT_TXNS.with(|m| {
        let mut m = m.borrow_mut();
        m.insert(AccountTxnKey::new(sa.auth.from, sa.auth.currency, seq), rec);
        m.insert(AccountTxnKey::new(sa.auth.to, sa.auth.currency, seq), rec);
    });

    Ok(PayReceipt {
        from: sa.auth.from.to_vec(),
        to: sa.auth.to.to_vec(),
        amount: sa.auth.amount,
        nonce: sa.auth.nonce.to_vec(),
        new_from_balance: new_from,
    })
}

#[query]
fn balance_of(pubkey: Vec<u8>, currency: Currency) -> u64 {
    match to_pubkey(&pubkey) {
        Ok(pk) => BALANCES.with(|b| b.borrow().get(&BalanceKey::new(pk, currency)).unwrap_or(0)),
        Err(_) => 0,
    }
}

/// `transactions_of : (blob, nat32, nat32) -> (vec record {...}) query`. Returns this account's
/// settled transactions in `currency`, newest-first, up to `limit`. The (account, currency) block
/// is one contiguous key range (seq 0..=MAX). `StableBTreeMap::range` returns an `Iter` that also
/// implements `DoubleEndedIterator`, so `.rev()` walks the B-tree from the high (newest) end in
/// O(limit) rather than materializing the whole account — important because the wallet polls this
/// every 5s; a collect-all-then-reverse would be O(total) per query. Lets a wallet render a durable
/// history sourced from the ledger (the in-memory UI list is gone on restart; this is the source of
/// truth).
#[query]
fn transactions_of(pubkey: Vec<u8>, currency: Currency, limit: u32) -> Vec<TxnView> {
    let pk = match to_pubkey(&pubkey) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let start = AccountTxnKey::new(pk, currency, 0u64);
    let end = AccountTxnKey::new(pk, currency, u64::MAX);
    // Collect inside the borrow scope — the iterator borrows the map. `.rev()` yields newest→oldest
    // without materializing the range (DoubleEndedIterator walks the B-tree from the high end), so a
    // 5s-polled wallet history stays O(limit), not O(total account size).
    ACCOUNT_TXNS.with(|m| {
        m.borrow().range(start..=end)
            .rev() // forward range is oldest→newest; rev() yields newest→oldest in O(limit)
            .take(limit.max(1) as usize) // defensive lower bound
            .map(|(_, r)| TxnView {
                from: r.from.to_vec(),
                to: r.to.to_vec(),
                amount: r.amount,
                nonce: r.nonce.to_vec(),
                currency: r.currency,
                timestamp: r.timestamp,
            })
            .collect()
    })
}

#[query]
fn per_tx_cap() -> u64 {
    CAP.with(|c| *c.borrow().get())
}

/// Credit `to` with `amount` (minor units) of `currency` and return the new balance. **Open demo
/// faucet** — any caller may mint, including the anonymous principal the relay uses (so the relay
/// needs no controller identity). The demo currency is worthless and this is the PoC stand-in for a
/// real on-ramp; it will be replaced by an issuer-gated mint once funding moves on-chain (see
/// FUNDING.md).
#[update]
fn mint(to: Vec<u8>, currency: Currency, amount: u64) -> u64 {
    let pk = to_pubkey(&to).expect("account must be 32 bytes");
    let key = BalanceKey::new(pk, currency);
    BALANCES.with(|b| {
        let mut b = b.borrow_mut();
        let new = b.get(&key).unwrap_or(0).saturating_add(amount);
        b.insert(key, new);
        new
    })
}

ic_cdk::export_candid!();
