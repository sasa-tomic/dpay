//! Fake-IC `/api/v2` gateway — the offline e2e stand-in for `https://icp-api.io`.
//!
//! Compiled ONLY under `test-helpers` (never in the prod image). The e2e harness points the
//! app's `IC_GATEWAY` seam (`__DPAY_TEST_IC_GATEWAY`) at this relay; every envelope the app
//! signs is verified and executed HERE with the SAME dpay-icp codecs the real boundary node
//! path uses (byte-identical arg/reply shapes, golden-pinned tables).
//!
//! Semantics mirrored from the measured mainnet PoC (2026-08-18-user-principal-rail.md):
//! - `call`: verify envelope (bad sig → 400, body echoes why) → ingress-window check
//!   (expired → 400 with 'expired' in the body) → request_id dedup (identical-byte resubmit
//!   → 202, executed ONCE) → execute → 202 empty body; outcome rides `read_state`.
//!   `get_btc_address` lives HERE: the real ckBTC minter exposes it as an UPDATE ONLY —
//!   the query form is rejected with 5 "Canister has no query method 'get_btc_address'"
//!   (prod bug 2026-08-23; the fake mirrors the rejection so the class can't recur).
//! - `query`: verify → execute → 200 CBOR `{status: replied, reply: {arg}}`; canister reject →
//!   `{status: rejected, reject_code, reject_message}`; bad sig → 400.
//! - `read_state`: verify → 200 CBOR `{certificate: {tree, signature}}` carrying
//!   `request_status/<rid>/{status, reply?}` and the certified `time` leaf (clock sync).
//!   The signature is 64 zero bytes — the gateway is a TEST seam, not a trust root (W6 owns
//!   real BLS verification).
//!
//! State model: balances keyed `Account{owner: user principal, subaccount}` per fake ledger,
//! exactly the user-principal rail the app now moves money on. No facade subaccounts, no
//! custody — the relay is not in the value path; it just plays the boundary node.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

use dpay_icp::envelope::verify_envelope;
use dpay_icp::icrc::{
    ApproveArg,
    decode_account_arg, decode_approve_arg, decode_legacy_transfer_arg, decode_minter_account_arg,
    decode_retrieve_btc_arg, decode_transfer_arg, decode_withdraw_erc20_arg,
    decode_withdraw_eth_arg, encode_approve_ok, encode_eip1559_price,
    encode_legacy_transfer_bad_fee, encode_legacy_transfer_insufficient_funds,
    encode_legacy_transfer_ok, encode_minter_ok, encode_nat8_reply, encode_nat_reply,
    encode_text_reply, encode_transfer_bad_fee, encode_transfer_insufficient_funds,
    encode_transfer_ok, uleb_bytes, Eip1559Price, RetrieveBtcArg, WithdrawEthArg,
};
use dpay_icp::principal::{Account, AccountIdentifier, Principal};
use dpay_icp::reply::{cbor_encode, tree_to_cbor, Cbor, Tree};

use crate::AppState;
use dpay_core::Currency;

/// A fake ledger's per-currency state (the gateway routes canister text → this).
#[derive(Clone)]
pub struct FakeLedgerState {
    pub currency: Currency,
    /// `icrc1_fee` the gateway enforces (None = accept the ledger default / any fee).
    pub fee: Option<u128>,
    pub decimals: u8,
}

#[derive(Clone)]
enum RequestState {
    Replied(Vec<u8>),
    Rejected { code: u64, message: String },
}

#[derive(Default)]
struct FakeIcState {
    /// canister text → ledger config (one per catalog currency with a rail).
    ledgers: HashMap<String, FakeLedgerState>,
    /// canister text → minter of (ledger text) — retrieve/withdraw burn their home ledger.
    minters: HashMap<String, String>,
    /// Balances are PER-LEDGER: `((ledger text), (owner text, subaccount)) → e8s`. Real ICRC
    /// semantics — the same principal holds independent balances on each ledger; a shared
    /// per-principal pot would cross-contaminate currencies (fauceting ckBTC would inflate
    /// ckUSDC).
    balances: HashMap<(String, (String, [u8; 32])), u128>,
    /// Allowances, likewise scoped to the ledger they were granted on.
    allowances: HashMap<((String, (String, [u8; 32])), (String, [u8; 32])), u128>,
    requests: HashMap<[u8; 32], RequestState>,
    txns: Vec<FakeTxn>,
    next_block: u64,
}

#[derive(Clone)]
struct FakeTxn {
    #[allow(dead_code)]
    kind: &'static str,
    from: String,
    to: String,
    amount: u128,
    currency: Currency,
    memo_hex: String,
    timestamp: u64,
    /// The block this row is — the same `next_block` counter the reply's block index comes from,
    /// so a caller that reads history sees the SAME identity the transfer's own reply returned.
    /// Global rather than per-ledger (the counter is), which is a fidelity gap a real replica
    /// does not have and no reader here depends on: a row is only ever compared with rows from
    /// the same ledger read.
    block: u64,
}

/// The gateway. Shared into relay `AppState` under `test-helpers` only.
pub struct FakeIc {
    state: Mutex<FakeIcState>,
    /// Test seam (2026-08-21): `POST /api/v1/test/hide_outcome` arms "hide THIS request_id's
    /// outcome for the next N `read_state`s" — those certs omit the rid's `request_status`
    /// entry, simulating the real boundary node's outcome latency: the app's in-tap poller
    /// sees a non-terminal state, its budget runs out, and the honest-unknown recovery path
    /// (reader handoff → background reconcile) gets exercised end to end. Without this seam
    /// the fake settles SYNCHRONOUSLY (the RequestState is inserted before the /call 202
    /// returns), so the non-terminal window — exactly the 2026-08-21 mainnet NFC
    /// false-pending bug — structurally never exists offline. RID-SCOPED so concurrent e2e
    /// flows against the SHARED relay are unaffected (each flow hides only its own rid).
    hidden_outcomes: Mutex<std::collections::HashMap<[u8; 32], usize>>,
}

fn now_ns() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as u64,
        // Only a host whose clock is set before 1970 reaches this. Substituting 0 would make every
        // ingress expiry look expired and every logged row look ancient, silently — so say what
        // happened instead of quietly answering with a wrong time.
        Err(e) => panic!("dpay-relay: fake-IC: the system clock is before the unix epoch ({e})"),
    }
}

/// Whole seconds since the epoch — the resolution the fake ledger's txn log and the eip-1559
/// quote carry (matching what the app renders).
fn now_secs() -> u64 {
    now_ns() / 1_000_000_000
}

fn owner_key(owner: &Principal) -> (String, [u8; 32]) {
    (owner.to_text(), [0u8; 32])
}

fn account_owner(a: &Account) -> (String, [u8; 32]) {
    (a.owner.to_text(), a.subaccount)
}

/// Balance-map key for `owner` (default subaccount) on `ledger`.
fn bal_key(ledger: &str, owner: &Principal) -> (String, (String, [u8; 32])) {
    (ledger.to_string(), owner_key(owner))
}

/// Balance-map key for an explicit `Account` on `ledger`.
fn acct_key(ledger: &str, a: &Account) -> (String, (String, [u8; 32])) {
    (ledger.to_string(), account_owner(a))
}

impl FakeIc {
    /// Build the gateway over the relay's COMPILED catalog ([`crate::catalog::ic_rows`] — the
    /// sole authority since 2026-08-28): every currency row with a non-empty `ledger` becomes a
    /// fake ledger keyed by that principal text; rows with a `minter` register the minter
    /// canister routed at the row's ledger.
    pub fn from_catalog() -> Arc<Self> {
        let mut st = FakeIcState::default();
        for d in crate::catalog::ic_rows() {
            if d.ledger.is_empty() {
                continue;
            }
            let fee = d.fee.as_ref().map(|f| u128::from(f.0));
            st.ledgers.insert(
                d.ledger.clone(),
                FakeLedgerState { currency: d.currency, fee, decimals: d.decimals.unwrap_or(0) as u8 },
            );
            if let Some(m) = d.minter.clone() {
                st.minters.insert(m, d.ledger.clone());
            }
        }
        Arc::new(FakeIc {
            state: Mutex::new(st),
            hidden_outcomes: Mutex::new(std::collections::HashMap::new()),
        })
    }

    /// Credit a fake ledger at the user principal (faucet / test seeding) and record a mint
    /// row in the txn log; returns the resulting balance. Mirrors the relay-era faucet contract
    /// (credit + return balance) on principal-keyed state.
    /// `currency` comes from the CALLER, which resolved `ledger_text` out of the ledger map to get
    /// here — re-looking it up would only add a "not found" case that cannot happen and would file
    /// the row under currency 0 (DEMO) if it ever did.
    fn credit_and_log(
        &self,
        s: &mut FakeIcState,
        ledger_text: &str,
        currency: Currency,
        owner: &Principal,
        amount: u128,
    ) -> u128 {
        let k = bal_key(ledger_text, owner);
        let to = k.1 .0.clone();
        let bal = *s.balances.get(&k).unwrap_or(&0) + amount;
        *s.balances.entry(k).or_insert(0) += amount;
        let block = s.next_block;
        s.next_block += 1;
        s.txns.push(FakeTxn {
            kind: "mint",
            from: String::new(),
            to,
            amount,
            currency,
            memo_hex: String::new(),
            timestamp: now_secs(),
            block,
        });
        bal
    }

    /// Faucet: credit the ledger registered for `currency` at `owner`; returns the new balance,
    /// or 0 when no ledger is registered for the currency.
    pub fn faucet_credit(&self, currency: Currency, owner: &Principal, amount: u128) -> u128 {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let Some(ledger_text) = s.ledgers.iter().find(|(_, l)| l.currency == currency).map(|(t, _)| t.clone()) else {
            return 0;
        };
        self.credit_and_log(&mut s, &ledger_text, currency, owner, amount)
    }

    /// Test seam armer (see `FakeIc::hidden_outcomes`): hide `rid`'s outcome for the next
    /// `polls` read_states. Called by the test-helpers-only `POST /api/v1/test/hide_outcome`.
    pub fn arm_hidden_outcome(&self, rid: [u8; 32], polls: usize) {
        self.hidden_outcomes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(rid, polls);
    }

    /// Per-currency balance map for an account across the catalog's ledgers (relay `/balances`).
    /// Balance of a currency's home ledger at `owner` (principal-keyed) — the single-currency
    /// twin of one `/balances` map entry. Returns 0 for unregistered currencies/fresh accounts
    /// (ICRC semantics).
    pub fn balance_for(&self, currency: Currency, owner: &Principal) -> u64 {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        for (text, st) in &s.ledgers {
            if st.currency == currency {
                return s.balances.get(&bal_key(text, owner)).copied().unwrap_or(0).min(u64::MAX as u128) as u64;
            }
        }
        0
    }

    pub fn balances_of(
        &self,
        catalog: &[crate::ledger::CurrencyDescriptor],
        account: &Account,
    ) -> std::collections::BTreeMap<String, crate::ledger::U64String> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut map = std::collections::BTreeMap::new();
        for d in catalog {
            let Some(l) = s.ledgers.get(&d.ledger) else { continue };
            if l.currency != d.currency {
                continue;
            }
            let bal = *s.balances.get(&acct_key(&d.ledger, account)).unwrap_or(&0);
            map.insert(d.currency.to_string(), crate::ledger::U64String(bal.min(u64::MAX as u128) as u64));
        }
        map
    }

    /// Newest-first transaction rows for an owner (relay `/transactions` test path).
    pub fn transactions(&self, owner: &Principal, currency: Currency, limit: usize, memo: Option<&str>) -> Vec<crate::ledger::TxnRecord> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let me = owner.to_text();
        let mut rows: Vec<crate::ledger::TxnRecord> = s
            .txns
            .iter()
            .filter(|t| (t.from == me || t.to == me) && t.currency == currency)
            .filter(|t| memo.is_none_or(|m| t.memo_hex.eq_ignore_ascii_case(m)))
            .map(|t| crate::ledger::TxnRecord {
                from: t.from.clone(),
                to: t.to.clone(),
                amount: crate::ledger::U64String(t.amount.min(u64::MAX as u128) as u64),
                nonce: String::new(),
                currency: t.currency,
                block: t.block,
                timestamp: t.timestamp,
                from_name: String::new(),
                to_name: String::new(),
                memo: t.memo_hex.clone(),
            })
            .collect();
        rows.reverse();
        rows.truncate(limit);
        rows
    }

    /// Execute a `call` envelope against the fake ledgers. The caller MUST hold the state lock
    /// (single critical section with the dedup check + outcome insert — see [`submit`]).
    fn execute_call(&self, s: &mut FakeIcState, env: &dpay_icp::envelope::VerifiedEnvelope) -> RequestState {
        let (Some(canister_p), Some(method), Some(arg)) = (&env.canister, &env.method_name, &env.arg) else {
            return RequestState::Rejected { code: 5, message: "call content missing canister/method/arg".into() };
        };
        let canister = canister_p.to_text();
        let arg: &[u8] = arg;
        let sender = account_owner(&Account { owner: env.sender.clone(), subaccount: [0u8; 32] });
        // All balance touches below are scoped to THIS ledger canister (per-ledger balances).
        let from_key = (canister.clone(), sender.clone());
        let block = s.next_block;
        s.next_block += 1;

        match method.as_str() {
            "icrc1_transfer" => Self::icrc1_transfer(s, &canister, &from_key, &sender, arg, block),
            "transfer" => Self::legacy_transfer(s, &canister, &from_key, &sender, arg, block),
            "icrc2_approve" => Self::icrc2_approve(s, &canister, &env.sender, arg, block),
            "retrieve_btc_with_approval" => {
                Self::burn_via_minter(s, &canister, &env.sender, "retrieve_btc_with_approval", arg, block)
            }
            "withdraw_eth" => Self::burn_via_minter(s, &canister, &env.sender, "withdraw_eth", arg, block),
            "withdraw_erc20" => Self::withdraw_erc20(s, &canister, &env.sender, arg, block),
            "get_btc_address" => Self::get_btc_address(s, &canister, arg),
            other => RequestState::Rejected { code: 3, message: format!("method {other:?} not available on the gateway") },
        }
    }

    /// `icrc1_transfer`: fee check → funds check → move → reply with the block index.
    fn icrc1_transfer(
        s: &mut FakeIcState,
        canister: &str,
        from_key: &(String, (String, [u8; 32])),
        sender: &(String, [u8; 32]),
        arg: &[u8],
        block: u64,
    ) -> RequestState {
        let Some(cfg) = s.ledgers.get(canister).cloned() else {
            return RequestState::Rejected { code: 3, message: format!("canister {canister} not found") };
        };
        let Ok(arg) = decode_transfer_arg(arg) else {
            return RequestState::Rejected { code: 5, message: "malformed icrc1_transfer arg".into() };
        };
        let to = (canister.to_string(), account_owner(&arg.to));
        if let Some(expected) = cfg.fee {
            if arg.fee != Some(expected) {
                return RequestState::Replied(encode_transfer_bad_fee(expected));
            }
        }
        let bal = *s.balances.get(from_key).unwrap_or(&0);
        let spend = arg.amount + arg.fee.unwrap_or(0);
        if bal < spend {
            return RequestState::Replied(encode_transfer_insufficient_funds(bal));
        }
        *s.balances.entry(from_key.clone()).or_insert(0) -= spend;
        *s.balances.entry(to.clone()).or_insert(0) += arg.amount;
        let memo_hex = arg.memo.clone().map(|m| m.iter().map(|b| format!("{b:02x}")).collect::<String>()).unwrap_or_default();
        // `to` is the per-ledger balance key (canister, account); the txn row wants the
        // PAYEE PRINCIPAL TEXT (to.1.0), not the canister id (to.0).
        let ts = now_secs();
        // The ledger was resolved at the top of this call (`cfg`) — its currency is known, not
        // guessed; a second lookup could only introduce a "not found" that files the row as DEMO.
        let currency = cfg.currency;
        s.txns.push(FakeTxn {
            kind: "transfer",
            from: sender.0.clone(),
            to: to.1 .0.clone(),
            amount: arg.amount,
            currency,
            memo_hex,
            timestamp: ts,
            block,
        });
        RequestState::Replied(encode_transfer_ok(block))
    }

    /// The ICP ledger's LEGACY `transfer` — same sequence as [`Self::icrc1_transfer`] (fee check →
    /// funds check → move → block index), in the legacy shapes: the payee is a raw 32-byte ACCOUNT
    /// IDENTIFIER, amounts are `Tokens{e8s}` (u64), the fee is mandatory, and the memo is a bare
    /// nat64.
    ///
    /// Mainnet-true gate: only the ICP ledger has this method (every ck*/ICRC-1 ledger is
    /// principal-addressed and would reject the call), so a `transfer` aimed anywhere else is
    /// rejected here exactly as the real replica would — the same reason the fake rejects the
    /// `get_btc_address` QUERY form.
    fn legacy_transfer(
        s: &mut FakeIcState,
        canister: &str,
        from_key: &(String, (String, [u8; 32])),
        sender: &(String, [u8; 32]),
        arg: &[u8],
        block: u64,
    ) -> RequestState {
        let Some(cfg) = s.ledgers.get(canister).cloned() else {
            return RequestState::Rejected { code: 3, message: format!("canister {canister} not found") };
        };
        if canister != crate::catalog::ICP_LEDGER_PRINCIPAL {
            return RequestState::Rejected {
                code: 3,
                message: format!("Canister {canister} has no update method 'transfer'"),
            };
        }
        let Ok(arg) = decode_legacy_transfer_arg(arg) else {
            return RequestState::Rejected { code: 5, message: "malformed transfer arg".into() };
        };
        if let Some(expected) = cfg.fee {
            if u128::from(arg.fee_e8s) != expected {
                let Ok(expected_e8s) = u64::try_from(expected) else {
                    return RequestState::Rejected {
                        code: 5,
                        message: format!("ledger {canister} fee {expected} does not fit Tokens{{e8s}}"),
                    };
                };
                return RequestState::Replied(encode_legacy_transfer_bad_fee(expected_e8s));
            }
        }
        // The signed arg names which of the sender's accounts pays; absent = their default one
        // (`from_key`, whose subaccount the caller already set to the default).
        let from = match arg.from_subaccount {
            None => from_key.clone(),
            Some(sub) => (canister.to_string(), (sender.0.clone(), sub)),
        };
        let bal = *s.balances.get(&from).unwrap_or(&0);
        let spend = u128::from(arg.amount_e8s) + u128::from(arg.fee_e8s);
        if bal < spend {
            let Ok(bal_e8s) = u64::try_from(bal) else {
                return RequestState::Rejected {
                    code: 5,
                    message: format!("balance {bal} does not fit Tokens{{e8s}}"),
                };
            };
            return RequestState::Replied(encode_legacy_transfer_insufficient_funds(bal_e8s));
        }
        let to = resolve_account_identifier(s, &arg.to);
        *s.balances.entry(from).or_insert(0) -= spend;
        *s.balances.entry((canister.to_string(), to.clone())).or_insert(0) += u128::from(arg.amount_e8s);
        // The legacy memo is a bare nat64, rendered big-endian hex — 16 chars, so it can never be
        // confused with (or matched against) a 16-BYTE dpay reconciliation memo, whose hex is 32
        // chars and is what `/api/v1/transactions?memo=` requires. `0` is the ledger's "no memo"
        // value (what dfx sends by default) and renders empty, like an absent icrc1 memo.
        let memo_hex = if arg.memo == 0 { String::new() } else { hex::encode(arg.memo.to_be_bytes()) };
        s.txns.push(FakeTxn {
            kind: "transfer",
            from: sender.0.clone(),
            to: to.0,
            amount: u128::from(arg.amount_e8s),
            currency: cfg.currency,
            memo_hex,
            timestamp: now_secs(),
            block,
        });
        RequestState::Replied(encode_legacy_transfer_ok(block))
    }

    /// `icrc2_approve`: pay the (optional) fee, record the allowance for the named spender.
    fn icrc2_approve(
        s: &mut FakeIcState,
        canister: &str,
        sender: &Principal,
        arg: &[u8],
        block: u64,
    ) -> RequestState {
        let Some(cfg) = s.ledgers.get(canister).cloned() else {
            return RequestState::Rejected { code: 3, message: format!("canister {canister} not found") };
        };
        let Ok(arg) = decode_approve_arg(arg) else {
            return RequestState::Rejected { code: 5, message: "malformed icrc2_approve arg".into() };
        };
        let fee = arg.fee.unwrap_or(0);
        let ApproveArg { from_subaccount, spender, amount, .. } = arg;
        let from = (
            canister.to_string(),
            (
                sender.to_text(),
                from_subaccount.unwrap_or([0u8; 32]),
            ),
        );
        if let Some(expected) = cfg.fee {
            if arg.fee != Some(expected) {
                return RequestState::Replied(encode_transfer_bad_fee(expected));
            }
        }
        let bal = *s.balances.get(&from).unwrap_or(&0);
        if bal < fee {
            return RequestState::Replied(encode_transfer_insufficient_funds(bal));
        }
        if fee > 0 {
            *s.balances.entry(from.clone()).or_insert(0) -= fee;
        }
        s.allowances.insert((from, account_owner(&spender)), amount.unwrap_or(0));
        RequestState::Replied(encode_approve_ok(block))
    }

    /// `retrieve_btc_with_approval` / `withdraw_eth`: burn the user's pre-approved funds on the
    /// minter's home ledger.
    fn burn_via_minter(
        s: &mut FakeIcState,
        canister: &str,
        sender: &Principal,
        method: &str,
        arg: &[u8],
        block: u64,
    ) -> RequestState {
        let (from_subaccount, amount) = match method {
            "retrieve_btc_with_approval" => {
                let Ok(arg) = decode_retrieve_btc_arg(arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed retrieve arg".into() };
                };
                let RetrieveBtcArg { from_subaccount, amount, .. } = arg;
                (from_subaccount, u128::from(amount))
            }
            _ => {
                let Ok(arg) = decode_withdraw_eth_arg(arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed withdraw_eth arg".into() };
                };
                let WithdrawEthArg { from_subaccount, amount, .. } = arg;
                (from_subaccount, u128::from(amount))
            }
        };
        let Some(home) = s.minters.get(canister).cloned() else {
            return RequestState::Rejected { code: 3, message: format!("canister {canister} is not a minter") };
        };
        match burn_approved(s, &home, canister, sender, from_subaccount, amount, block) {
            Ok(()) => RequestState::Replied(encode_minter_ok(block)),
            Err(msg) => RequestState::Rejected { code: 5, message: msg },
        }
    }

    /// `withdraw_erc20` — dual-ledger: gas (ckETH) + amount (ckERC20), both pre-approved to the
    /// minter. The arg names the ckERC20 ledger; the gas ledger is the minter's home ledger.
    fn withdraw_erc20(
        s: &mut FakeIcState,
        canister: &str,
        sender: &Principal,
        arg: &[u8],
        block: u64,
    ) -> RequestState {
        let Ok(arg) = decode_withdraw_erc20_arg(arg) else {
            return RequestState::Rejected { code: 5, message: "malformed withdraw_erc20 arg".into() };
        };
        let home = s.minters.get(canister).cloned().unwrap_or_default();
        if home.is_empty() {
            return RequestState::Rejected { code: 3, message: format!("canister {canister} is not a minter") };
        }
        let amount_ledger = arg.ckerc20_ledger_id.to_text();
        // Amount leg: the ckERC20 ledger itself, spent by the minter. Both legs of ONE user
        // operation carry the same block number: they land on DIFFERENT ledgers, and a block
        // index only ever identifies a row within the ledger it was read from.
        match burn_approved(s, &amount_ledger, canister, sender, arg.from_ckerc20_subaccount, arg.amount, block) {
            Ok(()) => {}
            Err(msg) => return RequestState::Rejected { code: 5, message: msg },
        }
        // Gas leg: the minter's home (ckETH) ledger, spent by the minter.
        match burn_approved(s, &home, canister, sender, arg.from_cketh_subaccount, GAS_FEE_WEI, block) {
            Ok(()) => {}
            Err(msg) => return RequestState::Rejected { code: 5, message: msg },
        }
        RequestState::Replied(encode_minter_ok(block))
    }

    /// `get_btc_address` — an UPDATE-only method on the real ckBTC minter (mainnet rejects the
    /// query form with "Canister has no query method 'get_btc_address'"; found on a physical
    /// device 2026-08-23 — the fake used to accept the query form, which is exactly the
    /// prod-only blind spot this mirroring closes). Deterministic fake address keyed by the
    /// OWNER principal — the deposit address pays Account{owner: user principal} (never facade
    /// custody). Shape mirrors the relay-era FakeLedger (`bc1qdpay` + 16 hex chars) so the
    /// deposit flows assert the same recognizable contract; the keyed bytes are the principal,
    /// not a facade pubkey.
    fn get_btc_address(s: &mut FakeIcState, canister: &str, arg: &[u8]) -> RequestState {
        if !s.minters.contains_key(canister) {
            return RequestState::Rejected {
                code: 3,
                message: "method \"get_btc_address\" not available on the gateway".into(),
            };
        }
        let Ok(a) = decode_minter_account_arg(arg) else {
            return RequestState::Rejected { code: 5, message: "malformed get_btc_address arg".into() };
        };
        let owner = a.owner.unwrap_or_else(Principal::anonymous);
        // Slice defensively: a decoded principal shorter than 8 bytes (e.g. the anonymous one
        // this fallback can substitute) used to panic on `&slice[..8]` — a hostile
        // `get_btc_address` arg must be a typed reject, not a crash.
        let Some(owner_prefix) = owner.as_slice().get(..8) else {
            return RequestState::Rejected { code: 5, message: "owner principal too short for the fake btc address".into() };
        };
        let addr = format!("bc1qdpay{}", hex::encode(owner_prefix));
        RequestState::Replied(encode_text_reply(&addr))
    }

    fn execute_query(&self, env: &dpay_icp::envelope::VerifiedEnvelope) -> Result<Vec<u8>, (u64, String)> {
        let (Some(canister_p), Some(method), Some(arg)) = (&env.canister, &env.method_name, &env.arg) else {
            return Err((5, "query content missing canister/method/arg".into()));
        };
        let canister = canister_p.to_text();
        let arg: &[u8] = arg;
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match method.as_str() {
            "icrc1_balance_of" => {
                let Ok(a) = decode_account_arg(&arg) else {
                    return Err((5, "malformed icrc1_balance_of arg".into()));
                };
                Ok(encode_nat_reply(*s.balances.get(&acct_key(&canister, &a)).unwrap_or(&0)))
            }
            "icrc1_decimals" => {
                let d = s.ledgers.get(&canister).map(|l| l.decimals).unwrap_or(2);
                Ok(encode_nat8_reply(d))
            }
            "icrc1_fee" => {
                let f = s.ledgers.get(&canister).and_then(|l| l.fee).unwrap_or(0);
                Ok(encode_nat_reply(f))
            }
            "get_btc_address" => {
                // Mainnet-true: the real ckBTC minter exposes get_btc_address as an UPDATE
                // only (verified against its candid) — the signed QUERY dies on prod with
                // exactly this message (found on a physical device 2026-08-23). The fake must
                // reject it identically so this class of bug can never sail through the
                // offline suite again.
                Err((5, "Canister has no query method 'get_btc_address'".into()))
            }
            "eip_1559_transaction_price" => {
                Ok(encode_eip1559_price(&Eip1559Price {
                    gas_limit: EIP1559_GAS_LIMIT,
                    max_fee_per_gas: EIP1559_MAX_FEE_PER_GAS,
                    max_priority_fee_per_gas: EIP1559_MAX_PRIORITY_FEE_PER_GAS,
                    max_transaction_fee: GAS_FEE_WEI,
                    timestamp: Some(now_secs()),
                }))
            }
            other => Err((3, format!("query {other:?} not available on the gateway"))),
        }
    }
}

/// Fixed gas price the gateway quotes + charges on the dual-ledger path.
const GAS_FEE_WEI: u128 = 78_000_000_000_000;
/// eip-1559 quote constants (the fixed price curve the gateway models):
const EIP1559_GAS_LIMIT: u128 = 30_000;
const EIP1559_MAX_FEE_PER_GAS: u128 = 2_500_000_000_000; // 2.5 kgwei
const EIP1559_MAX_PRIORITY_FEE_PER_GAS: u128 = 100_000_000; // 0.1 gwei

/// Balance-key owner prefix for an account identifier that matched no account the gateway
/// knows.
/// Deliberately NOT valid principal text (`:` is outside base32), so a synthetic key can never
/// collide with a real account, never parses back into one, and never surfaces in a user's
/// balances or history.
const EXTERNAL_ACCOUNT_ID_PREFIX: &str = "icp-account-id:";

/// Resolve the 32-byte ACCOUNT IDENTIFIER a legacy `transfer` names into a balance-key account.
///
/// An account identifier is a ONE-WAY hash of (owner, subaccount) — see
/// [`AccountIdentifier::from_principal`], the single derivation this repo has. It cannot be
/// inverted, so the only way to recognize a payee is to DERIVE the identifier of every account the
/// gateway already knows and compare. The search spans ALL ledgers because the identifier is a
/// pure function of (owner, subaccount): which ledger an account was first seen on says nothing
/// about who owns it. Limitation this inherits: an account the gateway has never seen at all
/// cannot be recognized, even if it belongs to a dpay user.
///
/// No match ⇒ a SYNTHETIC external key, never a silent drop: the money leaves the sender, so it
/// must land somewhere or the fake ledger would leak value and the sender-side assertions would be
/// checking a broken book. That is also honest — paying a 64-hex address that belongs to an
/// exchange is exactly a transfer OUT of every account this gateway knows.
fn resolve_account_identifier(s: &FakeIcState, to: &[u8; 32]) -> (String, [u8; 32]) {
    for (_ledger, account) in s.balances.keys() {
        if account.0.starts_with(EXTERNAL_ACCOUNT_ID_PREFIX) {
            continue;
        }
        let owner = match Principal::from_text(&account.0) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("dpay-relay: fake-IC: balance key {:?} is not principal text: {e}", account.0);
                continue;
            }
        };
        if AccountIdentifier::from_principal(&owner, &account.1).as_bytes() == to {
            return account.clone();
        }
    }
    (format!("{EXTERNAL_ACCOUNT_ID_PREFIX}{}", hex::encode(to)), [0u8; 32])
}

/// Burn `amount` of the user's pre-approved funds on `ledger_text`, spent by `spender_text`
/// (the minter the icrc2_approve named). The allowance+balance keys are PER-LEDGER; the spender
/// is the minter principal — for the dual-ledger withdraw_erc20 amount leg these are DIFFERENT
/// canisters (ckERC20 ledger ≠ minter home ledger), so they cannot be conflated.
#[allow(clippy::too_many_arguments)]
fn burn_approved(
    s: &mut FakeIcState,
    ledger_text: &str,
    spender_text: &str,
    sender: &Principal,
    from_subaccount: Option<[u8; 32]>,
    amount: u128,
    block: u64,
) -> Result<(), String> {
    // Resolved before anything moves: a burn on a ledger this gateway does not know would
    // otherwise be filed under currency 0 (DEMO) — a row in the wrong asset's history.
    let Some(cfg) = s.ledgers.get(ledger_text).cloned() else {
        return Err(format!("ledger {ledger_text} is not registered on this gateway"));
    };
    let from = (ledger_text.to_string(), (sender.to_text(), from_subaccount.unwrap_or([0u8; 32])));
    let spender = (spender_text.to_string(), [0u8; 32]);
    let allowed = *s.allowances.get(&(from.clone(), spender.clone())).unwrap_or(&0);
    if allowed < amount {
        return Err(format!("insufficient allowance: {allowed} < {amount}"));
    }
    let bal = *s.balances.get(&from).unwrap_or(&0);
    if bal < amount {
        return Err(format!("insufficient funds: {bal} < {amount}"));
    }
    s.allowances.insert((from.clone(), spender), allowed - amount);
    *s.balances.entry(from.clone()).or_insert(0) -= amount;
    s.txns.push(FakeTxn {
        kind: "burn",
        from: from.1 .0,
        to: String::new(),
        amount,
        currency: cfg.currency,
        memo_hex: String::new(),
        timestamp: now_secs(),
        block,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

fn cbor_response(status: StatusCode, body: Vec<u8>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/cbor"));
    (status, headers, body).into_response()
}

fn err_text(status: StatusCode, msg: &str) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain"));
    (status, headers, msg.to_string()).into_response()
}

/// POST `/api/v2/canister/{canister}/{kind}` — kind ∈ call | query | read_state.
pub async fn submit(
    State(state): State<AppState>,
    Path((canister, kind)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    let Some(fake) = state.fake_ic.clone() else {
        return err_text(StatusCode::NOT_FOUND, "fake-IC gateway not enabled on this relay");
    };
    let Ok(env) = verify_envelope(&body) else {
        return err_text(StatusCode::BAD_REQUEST, "invalid envelope: signature verification failed");
    };
    // The envelope names its canister; a mismatched path segment is a client bug (the real
    // boundary node would 404 the canister) — reject as a bad request. read_state content
    // carries NO canister_id (it targets the subnet), so the check applies to call/query only.
    if kind != "read_state"
        && env.canister.as_ref().map(|c| c.to_text()).as_deref() != Some(canister.as_str())
    {
        return err_text(StatusCode::NOT_FOUND, "canister id in path does not match envelope");
    }
    let now = now_ns();
    if env.ingress_expiry_ns <= now {
        return err_text(StatusCode::BAD_REQUEST, "request expired: ingress_expiry is in the past");
    }

    match kind.as_str() {
        "call" => submit_call(&fake, &env),
        "query" => submit_query(&fake, &env),
        "read_state" => submit_read_state(&fake),
        other => err_text(StatusCode::NOT_FOUND, &format!("unknown /api/v2 kind {other:?}")),
    }
}

/// The `call` branch: check → execute → insert under ONE lock acquisition (see the dedup
/// invariant note on the `requests` map).
fn submit_call(fake: &Arc<FakeIc>, env: &dpay_icp::envelope::VerifiedEnvelope) -> Response {
    // Dedup invariant (flow 09 relies on it): an identical-byte resubmit of a request_id
    // must NEVER execute twice. The check → execute → insert sequence runs under ONE
    // lock acquisition — the execute helpers take `&mut FakeIcState` — so two concurrent
    // identical submits cannot interleave (previously the check dropped the lock before
    // execute re-acquired it, racing a double execution).
    let rid = env.request_id;
    let mut s = fake.state.lock().unwrap_or_else(|p| p.into_inner());
    if s.requests.get(&rid).is_some() {
        // Identical-byte resubmit (same rid) — executed once, replay is free.
        return cbor_response(StatusCode::ACCEPTED, Vec::new());
    }
    let outcome = fake.execute_call(&mut s, env);
    s.requests.insert(rid, outcome);
    cbor_response(StatusCode::ACCEPTED, Vec::new())
}

/// The `query` branch: execute immediately, reply replied/rejected CBOR.
fn submit_query(fake: &Arc<FakeIc>, env: &dpay_icp::envelope::VerifiedEnvelope) -> Response {
    match fake.execute_query(env) {
        Ok(arg) => {
            let reply = Cbor::Map(vec![
                (Cbor::Text("status".into()), Cbor::Text("replied".into())),
                (
                    Cbor::Text("reply".into()),
                    Cbor::Map(vec![(Cbor::Text("arg".into()), Cbor::Bytes(arg))]),
                ),
            ]);
            cbor_response(StatusCode::OK, { let mut b = Vec::new(); cbor_encode(&reply, &mut b); b })
        }
        Err((code, message)) => {
            let reply = Cbor::Map(vec![
                (Cbor::Text("status".into()), Cbor::Text("rejected".into())),
                (Cbor::Text("reject_code".into()), Cbor::Uint(code)),
                (Cbor::Text("reject_message".into()), Cbor::Text(message)),
            ]);
            cbor_response(StatusCode::OK, { let mut b = Vec::new(); cbor_encode(&reply, &mut b); b })
        }
    }
}

/// The `read_state` branch: a cert covering ALL known request_status entries + the certified
/// time leaf. The app's read_state envelope asks for request_status/<rid> paths (+ time); we
/// cannot see the paths without decoding them (they live in the signed content), so the
/// simplest faithful behavior is the full tree — the client-side lookup prunes to what the
/// caller asked for.
fn submit_read_state(fake: &Arc<FakeIc>) -> Response {
    let tree = {
        let s = fake.state.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ns();
        let mut hidden = fake.hidden_outcomes.lock().unwrap_or_else(|p| p.into_inner());
        // Test seam (see FakeIc::hidden_outcomes): a hidden rid's entry is OMITTED from the
        // cert and its counter decremented — the client-side lookup finds nothing, exactly
        // like a real boundary node before the outcome has landed in state certification.
        // Counters at 0 are dropped so the map never grows.
        hidden.retain(|_, left| *left > 0);
        let entries: Vec<([u8; 32], RequestState)> = s
            .requests
            .iter()
            .filter(|(rid, _)| {
                match hidden.get_mut(*rid) {
                    Some(left) => {
                        *left -= 1;
                        false
                    }
                    None => true,
                }
            })
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        drop(s);
        let mut req_trees: Vec<Tree> = Vec::new();
        for (rid, st) in entries {
            let inner = match st {
                RequestState::Replied(arg) => {
                    let reply_leaf = Cbor::Map(vec![(Cbor::Text("arg".into()), Cbor::Bytes(arg))]);
                    let mut enc = Vec::new();
                    cbor_encode(&reply_leaf, &mut enc);
                    Tree::Fork(
                        Box::new(Tree::Labeled(b"status".to_vec(), Box::new(Tree::Leaf(b"replied".to_vec())))),
                        Box::new(Tree::Labeled(b"reply".to_vec(), Box::new(Tree::Leaf(enc)))),
                    )
                }
                RequestState::Rejected { code, message } => Tree::Fork(
                    Box::new(Tree::Labeled(b"status".to_vec(), Box::new(Tree::Leaf(b"rejected".to_vec())))),
                    Box::new(Tree::Fork(
                        Box::new(Tree::Labeled(
                            b"reject_code".to_vec(),
                            Box::new(Tree::Leaf(uleb_bytes(u128::from(code)))),
                        )),
                        Box::new(Tree::Labeled(
                            b"reject_message".to_vec(),
                            Box::new(Tree::Leaf(message.into_bytes())),
                        )),
                    )),
                ),
            };
            req_trees.push(Tree::Labeled(rid.to_vec(), Box::new(inner)));
        }
        let mut status_branch = req_trees.pop().unwrap_or(Tree::Empty);
        while let Some(t) = req_trees.pop() {
            status_branch = Tree::Fork(Box::new(t), Box::new(status_branch));
        }
        let rs = Tree::Labeled(b"request_status".to_vec(), Box::new(status_branch));
        let time_leaf = Tree::Labeled(b"time".to_vec(), Box::new(Tree::Leaf(uleb_bytes(u128::from(now)))));
        Tree::Fork(Box::new(rs), Box::new(time_leaf))
    };
    let tree_cbor = tree_to_cbor(&tree);
    let mut cert = Vec::new();
    cbor_encode(
        &Cbor::Map(vec![
            (Cbor::Text("tree".into()), tree_cbor),
            (Cbor::Text("signature".into()), Cbor::Bytes(vec![0u8; 64])),
        ]),
        &mut cert,
    );
    let mut body = Vec::new();
    cbor_encode(
        &Cbor::Map(vec![(Cbor::Text("certificate".into()), Cbor::Bytes(cert))]),
        &mut body,
    );
    cbor_response(StatusCode::OK, body)
}

/// GET `/api/v2/status` — minimal healthy response (the app only needs 200; ic:time comes
/// from read_state, measured on the real boundary node too).
pub async fn status() -> Response {
    let body = {
        let mut v = Vec::new();
        cbor_encode(
            &Cbor::Map(vec![(
                Cbor::Text("replica_health_status".into()),
                Cbor::Text("healthy".into()),
            )]),
            &mut v,
        );
        v
    };
    cbor_response(StatusCode::OK, body)
}
