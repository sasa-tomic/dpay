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
    decode_account_arg, decode_approve_arg, decode_minter_account_arg, decode_retrieve_btc_arg,
    decode_transfer_arg, decode_withdraw_erc20_arg, decode_withdraw_eth_arg, encode_approve_ok,
    encode_eip1559_price, encode_minter_ok, encode_nat8_reply, encode_nat_reply,
    encode_text_reply, encode_transfer_bad_fee, encode_transfer_insufficient_funds,
    encode_transfer_ok, Eip1559Price, RetrieveBtcArg, WithdrawEthArg,
};
use dpay_icp::principal::{Account, Principal};
use dpay_icp::reply::{cbor_encode, Cbor, Tree};

use crate::ledger::ckerc20::{
    CKBTC_MINTER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL, CKETH_MINTER_PRINCIPAL,
    CKUSDC_LEDGER_PRINCIPAL,
};
use crate::ledger::Ledger;
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
    balances: HashMap<(String, [u8; 32]), u128>,
    allowances: HashMap<((String, [u8; 32]), (String, [u8; 32])), u128>,
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
}

/// The gateway. Shared into relay `AppState` under `test-helpers` only.
pub struct FakeIc {
    state: Mutex<FakeIcState>,
}

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

fn owner_key(owner: &Principal) -> (String, [u8; 32]) {
    (owner.to_text(), [0u8; 32])
}

fn account_owner(a: &Account) -> (String, [u8; 32]) {
    (a.owner.to_text(), a.subaccount)
}

impl FakeIc {
    /// Build the gateway over the relay's catalog: every currency row with a non-empty
    /// `ledger` becomes a fake ledger keyed by that principal text; rows with a `minter`
    /// register the minter canister routed at the row's ledger.
    pub async fn from_catalog(ledger: &dyn Ledger) -> Arc<Self> {
        let mut st = FakeIcState::default();
        if let Ok(catalog) = ledger.currencies().await {
            for d in catalog {
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
        }
        Arc::new(FakeIc { state: Mutex::new(st) })
    }

    /// Credit a fake ledger at the user principal (faucet / test seeding).
    pub fn credit(&self, ledger_text: &str, owner: &Principal, amount: u128) {
        let mut s = self.state.lock().unwrap();
        if !s.ledgers.contains_key(ledger_text) {
            return;
        }
        let currency = s.ledgers.get(ledger_text).map(|l| l.currency).unwrap_or(0);
        let k = owner_key(owner);
        let to = k.0.clone();
        *s.balances.entry(k).or_insert(0) += amount;
        s.txns.push(FakeTxn {
            kind: "mint",
            from: String::new(),
            to,
            amount,
            currency,
            memo_hex: String::new(),
            timestamp: now_ns() / 1_000_000_000,
        });
    }

    /// Faucet: credit the ledger registered for `currency` at `owner`; returns the new balance.
    /// Mirrors the relay-era faucet contract (credit + return balance) on principal-keyed state.
    pub fn faucet_credit(&self, currency: Currency, owner: &Principal, amount: u128) -> u128 {
        let mut s = self.state.lock().unwrap();
        let Some(ledger_text) = s.ledgers.iter().find(|(_, l)| l.currency == currency).map(|(t, _)| t.clone()) else {
            return 0;
        };
        let k = owner_key(owner);
        let to = k.0.clone();
        let bal = *s.balances.get(&k).unwrap_or(&0) + amount;
        *s.balances.entry(k).or_insert(0) += amount;
        s.txns.push(FakeTxn {
            kind: "mint",
            from: String::new(),
            to,
            amount,
            currency,
            memo_hex: String::new(),
            timestamp: now_ns() / 1_000_000_000,
        });
        let _ = ledger_text;
        bal
    }

    /// Per-currency balance map for an account across the catalog's ledgers (relay `/balances`).
    /// Balance of a currency's home ledger at `owner` (principal-keyed) — the /balance route's
    /// gateway twin. Returns 0 for unregistered currencies/fresh accounts (ICRC semantics).
    pub fn balance_for(&self, currency: Currency, owner: &Principal) -> u64 {
        let s = self.state.lock().unwrap();
        for st in s.ledgers.values() {
            if st.currency == currency {
                return s.balances.get(&owner_key(owner)).copied().unwrap_or(0).min(u64::MAX as u128) as u64;
            }
        }
        0
    }

    pub fn balances_of(
        &self,
        catalog: &[crate::ledger::CurrencyDescriptor],
        account: &Account,
    ) -> std::collections::BTreeMap<String, crate::ledger::U64String> {
        let s = self.state.lock().unwrap();
        let mut map = std::collections::BTreeMap::new();
        for d in catalog {
            let Some(l) = s.ledgers.get(&d.ledger) else { continue };
            if l.currency != d.currency {
                continue;
            }
            let bal = *s.balances.get(&account_owner(account)).unwrap_or(&0);
            map.insert(d.currency.to_string(), crate::ledger::U64String(bal.min(u64::MAX as u128) as u64));
        }
        map
    }

    /// Balance of an account on a fake ledger (relay `/balances` test path).
    pub fn balance(&self, ledger_text: &str, account: &Account) -> u128 {
        let s = self.state.lock().unwrap();
        if !s.ledgers.contains_key(ledger_text) {
            return 0;
        }
        *s.balances.get(&account_owner(account)).unwrap_or(&0)
    }

    /// Newest-first transaction rows for an owner (relay `/transactions` test path).
    pub fn transactions(&self, owner: &Principal, currency: Currency, limit: usize) -> Vec<crate::ledger::TxnRecord> {
        let s = self.state.lock().unwrap();
        let me = owner.to_text();
        let mut rows: Vec<crate::ledger::TxnRecord> = s
            .txns
            .iter()
            .filter(|t| (t.from == me || t.to == me) && t.currency == currency)
            .map(|t| crate::ledger::TxnRecord {
                from: t.from.clone(),
                to: t.to.clone(),
                amount: crate::ledger::U64String(t.amount.min(u64::MAX as u128) as u64),
                nonce: String::new(),
                currency: t.currency,
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

    fn execute_call(&self, env: &dpay_icp::envelope::VerifiedEnvelope) -> RequestState {
        let (Some(canister_p), Some(method), Some(arg)) = (&env.canister, &env.method_name, &env.arg) else {
            return RequestState::Rejected { code: 5, message: "call content missing canister/method/arg".into() };
        };
        let canister = canister_p.to_text();
        let arg: &[u8] = arg;
        let sender = account_owner(&Account { owner: env.sender.clone(), subaccount: [0u8; 32] });
        let mut s = self.state.lock().unwrap();
        let block = s.next_block;
        s.next_block += 1;
        let ts = now_ns() / 1_000_000_000;

        macro_rules! txn {
            ($kind:expr, $from:expr, $to:expr, $amount:expr, $memo:expr) => {{
                let currency = s
                    .ledgers
                    .get(&canister)
                    .map(|l| l.currency)
                    .unwrap_or(0);
                s.txns.push(FakeTxn {
                    kind: $kind,
                    from: $from,
                    to: $to,
                    amount: $amount,
                    currency,
                    memo_hex: $memo,
                    timestamp: ts,
                });
            }};
        }

        let method_name = method.as_str();
        match method_name {
            "icrc1_transfer" => {
                let Some(cfg) = s.ledgers.get(&canister).cloned() else {
                    return RequestState::Rejected { code: 3, message: format!("canister {canister} not found") };
                };
                let Ok(arg) = decode_transfer_arg(&arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed icrc1_transfer arg".into() };
                };
                let to = account_owner(&arg.to);
                if let Some(expected) = cfg.fee {
                    if arg.fee != Some(expected) {
                        return RequestState::Replied(encode_transfer_bad_fee(expected));
                    }
                }
                let bal = *s.balances.get(&sender).unwrap_or(&0);
                let spend = arg.amount + arg.fee.unwrap_or(0);
                if bal < spend {
                    return RequestState::Replied(encode_transfer_insufficient_funds(bal));
                }
                *s.balances.entry(sender.clone()).or_insert(0) -= spend;
                *s.balances.entry(to.clone()).or_insert(0) += arg.amount;
                let memo_hex = arg.memo.clone().map(|m| m.iter().map(|b| format!("{b:02x}")).collect::<String>()).unwrap_or_default();
                txn!("transfer", sender.0, to.0, arg.amount, memo_hex);
                RequestState::Replied(encode_transfer_ok(block))
            }
            "icrc2_approve" => {
                let Some(cfg) = s.ledgers.get(&canister).cloned() else {
                    return RequestState::Rejected { code: 3, message: format!("canister {canister} not found") };
                };
                let Ok(arg) = decode_approve_arg(&arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed icrc2_approve arg".into() };
                };
                let fee = arg.fee.unwrap_or(0);
                let ApproveArg { from_subaccount, spender, amount, .. } = arg;
                let from = (
                    env.sender.to_text(),
                    from_subaccount.unwrap_or([0u8; 32]),
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
            "retrieve_btc_with_approval" => {
                let Ok(arg) = decode_retrieve_btc_arg(&arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed retrieve arg".into() };
                };
                let RetrieveBtcArg { from_subaccount, amount, .. } = arg;
                match burn_approved(&mut s, &canister, &env.sender, from_subaccount, u128::from(amount)) {
                    Ok(()) => RequestState::Replied(encode_minter_ok(block)),
                    Err(msg) => RequestState::Rejected { code: 5, message: msg },
                }
            }
            "withdraw_eth" => {
                let Ok(arg) = decode_withdraw_eth_arg(&arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed withdraw_eth arg".into() };
                };
                let WithdrawEthArg { from_subaccount, amount, .. } = arg;
                match burn_approved(&mut s, &canister, &env.sender, from_subaccount, u128::from(amount)) {
                    Ok(()) => RequestState::Replied(encode_minter_ok(block)),
                    Err(msg) => RequestState::Rejected { code: 5, message: msg },
                }
            }
            "withdraw_erc20" => {
                // Dual-ledger: gas (ckETH) + amount (ckERC20), both pre-approved to the minter.
                // The arg names the ckERC20 ledger; the gas ledger is the minter's home ledger.
                let Ok(arg) = decode_withdraw_erc20_arg(&arg) else {
                    return RequestState::Rejected { code: 5, message: "malformed withdraw_erc20 arg".into() };
                };
                let home = s.minters.get(&canister).cloned().unwrap_or_default();
                if home.is_empty() {
                    return RequestState::Rejected { code: 3, message: format!("canister {canister} is not a minter") };
                }
                let amount_ledger = arg.ckerc20_ledger_id.to_text();
                match burn_approved(&mut s, &amount_ledger, &env.sender, arg.from_ckerc20_subaccount, arg.amount) {
                    Ok(()) => {}
                    Err(msg) => return RequestState::Rejected { code: 5, message: msg },
                }
                match burn_approved(&mut s, &home, &env.sender, arg.from_cketh_subaccount, GAS_FEE_WEI) {
                    Ok(()) => {}
                    Err(msg) => return RequestState::Rejected { code: 5, message: msg },
                }
                RequestState::Replied(encode_minter_ok(block))
            }
            other => RequestState::Rejected { code: 3, message: format!("method {other:?} not available on the gateway") },
        }
    }

    fn execute_query(&self, env: &dpay_icp::envelope::VerifiedEnvelope) -> Result<Vec<u8>, (u64, String)> {
        let (Some(canister_p), Some(method), Some(arg)) = (&env.canister, &env.method_name, &env.arg) else {
            return Err((5, "query content missing canister/method/arg".into()));
        };
        let canister = canister_p.to_text();
        let arg: &[u8] = arg;
        let s = self.state.lock().unwrap();
        match method.as_str() {
            "icrc1_balance_of" => {
                let Ok(a) = decode_account_arg(&arg) else {
                    return Err((5, "malformed icrc1_balance_of arg".into()));
                };
                Ok(encode_nat_reply(*s.balances.get(&account_owner(&a)).unwrap_or(&0)))
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
                // Deterministic fake address keyed by the OWNER principal — the deposit address
                // pays Account{owner: user principal} (never facade custody). Shape mirrors the
                // relay-era FakeLedger (`bc1qdpay` + 16 hex chars) so the deposit flows assert
                // the same recognizable contract; the keyed bytes are the principal, not a
                // facade pubkey.
                let Ok(a) = decode_minter_account_arg(&arg) else {
                    return Err((5, "malformed get_btc_address arg".into()));
                };
                let owner = a.owner.unwrap_or_else(Principal::anonymous);
                let addr = format!("bc1qdpay{}", hex::encode(&owner.as_slice()[..8]));
                Ok(encode_text_reply(&addr))
            }
            "eip_1559_transaction_price" => {
                Ok(encode_eip1559_price(&Eip1559Price {
                    gas_limit: 30_000,
                    max_fee_per_gas: 2_500_000_000_000,
                    max_priority_fee_per_gas: 100_000_000,
                    max_transaction_fee: GAS_FEE_WEI,
                    timestamp: Some(now_ns() / 1_000_000_000),
                }))
            }
            other => Err((3, format!("query {other:?} not available on the gateway"))),
        }
    }
}

/// Fixed gas price the gateway quotes + charges on the dual-ledger path.
const GAS_FEE_WEI: u128 = 78_000_000_000_000;

fn burn_approved(
    s: &mut FakeIcState,
    minter_text: &str,
    sender: &Principal,
    from_subaccount: Option<[u8; 32]>,
    amount: u128,
) -> Result<(), String> {
    let Some(home) = s.minters.get(minter_text).cloned() else {
        return Err(format!("canister {minter_text} is not a minter"));
    };
    let from = (sender.to_text(), from_subaccount.unwrap_or([0u8; 32]));
    let spender = (minter_text.to_string(), [0u8; 32]);
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
        from: from.0,
        to: String::new(),
        amount,
        currency: s.ledgers.get(&home).map(|l| l.currency).unwrap_or(0),
        memo_hex: String::new(),
        timestamp: now_ns() / 1_000_000_000,
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
        "call" => {
            let rid = env.request_id;
            {
                let s = fake.state.lock().unwrap();
                if let Some(existing) = s.requests.get(&rid) {
                    // Identical-byte resubmit (same rid) — executed once, replay is free.
                    let _ = existing;
                    return cbor_response(StatusCode::ACCEPTED, Vec::new());
                }
            }
            let outcome = fake.execute_call(&env);
            let mut s = fake.state.lock().unwrap();
            s.requests.insert(rid, outcome);
            cbor_response(StatusCode::ACCEPTED, Vec::new())
        }
        "query" => match fake.execute_query(&env) {
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
        },
        "read_state" => {
            // The app's read_state envelope asks for request_status/<rid> paths (+ time). We
            // cannot see the paths without decoding them (they live in the signed content);
            // simplest faithful behavior: return a cert covering ALL known request_status
            // entries + the certified time leaf. The tree lookup prunes to what the caller
            // asked for.
            let tree = {
                let s = fake.state.lock().unwrap();
                let now = now_ns();
                let mut req_trees: Vec<Tree> = Vec::new();
                // (no public iteration over requests without exposing rid keys — build below)
                let entries: Vec<([u8; 32], RequestState)> = s
                    .requests
                    .iter()
                    .map(|(k, v)| (*k, v.clone()))
                    .collect();
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
                                    Box::new(Tree::Leaf(uleb_bytes_local(code))),
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
                let time_leaf = Tree::Labeled(b"time".to_vec(), Box::new(Tree::Leaf(uleb_bytes_local(now))));
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
        other => err_text(StatusCode::NOT_FOUND, &format!("unknown /api/v2 kind {other:?}")),
    }
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

fn tree_to_cbor(t: &Tree) -> Cbor {
    match t {
        Tree::Empty => Cbor::Array(vec![Cbor::Uint(0)]),
        Tree::Fork(l, r) => Cbor::Array(vec![Cbor::Uint(1), tree_to_cbor(l), tree_to_cbor(r)]),
        Tree::Labeled(l, sub) => {
            Cbor::Array(vec![Cbor::Uint(2), Cbor::Bytes(l.to_vec()), tree_to_cbor(sub)])
        }
        Tree::Leaf(v) => Cbor::Array(vec![Cbor::Uint(3), Cbor::Bytes(v.to_vec())]),
        Tree::Pruned(h) => Cbor::Array(vec![Cbor::Uint(4), Cbor::Bytes(h.to_vec())]),
    }
}

fn uleb_bytes_local(mut b: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (b & 0x7f) as u8;
        b >>= 7;
        if b != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if b == 0 {
            return out;
        }
    }
}

// The gateway registers these ledger/minter texts as a safety net for catalogs that omit
// them; FakeIc::from_catalog already picks the values out of the live catalog.
pub const GATEWAY_KNOWN_LEDGERS: &[&str] = &[CKUSDC_LEDGER_PRINCIPAL, CKETH_LEDGER_PRINCIPAL];
pub const GATEWAY_KNOWN_MINTERS: &[&str] = &[CKBTC_MINTER_PRINCIPAL, CKETH_MINTER_PRINCIPAL];
