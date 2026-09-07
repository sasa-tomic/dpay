//! LIVE PocketIC/agent proof of the native ICP index history adapter (feature `agent`).
//!
//! The adapter under test lives in `dpay_relay::agent_ledger`: history requests whose ledger
//! principal is the CANONICAL ICP ledger (`ryjl3-tyaaa-aaaaa-aaaba-cai`) are served by
//! `get_account_transactions` queries against the official ICP index
//! (`qhbym-qaaaa-aaaaa-aaafq-cai`) instead of the icrc3 `get_transactions` walker.
//!
//! There is no real ICP-index wasm offline (pocket-ic 14 has no universal-canister and the
//! offline cargo graph has no `wat`/`ic-test-utilities-*` crates), so this harness serves the
//! index side with a HAND-ASSEMBLED minimal wasm canister installed at the PINNED index
//! principal (`create_canister_with_id`). The responder speaks the REAL canister query ABI —
//! export `canister_query get_account_transactions` (the exact export-name convention
//! ic-cdk-macros emits), args read via the `ic0` system API (`msg_arg_data_size` /
//! `msg_arg_data_copy`), replies written via `msg_reply_data_append` / `msg_reply` — so the
//! fixture replies travel the REAL agent → HTTP gateway → PocketIC → replica → wasm query
//! path, not a mapper shortcut.
//!
//! The responder dispatches on the incoming argument BYTES: the test precomputes the exact
//! Candid bytes the adapter must send for each page request (same mirror types, same
//! `max_results = 100` page size) and bakes (offset, byte) probes into the wasm that pick the
//! matching golden reply. Any unexpected argument traps the query (→ 503 → loud test
//! failure), which doubles as drift detection on the wire contract.
//!
//! Asserted through the HTTP route (`GET /api/v1/transactions/{hex}?currency=8`):
//!   1. DISPATCH: the compiled catalog's ICP row names the canonical ICP ledger as its ledger
//!      principal, so the request is answered by the index responder (the rows below only exist
//!      in its golden replies);
//!   2. DIRECTION MAPPING: sides equal to the user's LEGACY ACCOUNT IDENTIFIER (the hex form
//!      the real index returns) are rewritten to the user's PRINCIPAL TEXT; the counterparty's
//!      account-identifier string passes through UNCHANGED;
//!   3. MEMO FILTERING applied client-side BEFORE limit truncation (a newer non-matching row
//!      on the same page must not push the older settlement row out of a `limit=1` result);
//!   4. PAGINATION: the mint fixture lives only on page 2 — it can appear in the result only
//!      if the adapter paged backward with `start = <page-1 oldest_tx_id>` over the real path;
//!   5. u64::MAX amounts survive as raw decimal strings end-to-end;
//!   6. A stranger account gets an empty history.
//!
//! Prereqs: none beyond the offline cargo graph — the responder wasm is hand-assembled below
//! and the catalog is compiled into the relay, so no canister wasm fixture is read at all.

#![cfg(feature = "agent")]

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // oneshot

use candid::{encode_args, encode_one, Nat, Principal};
use pocket_ic::{PocketIc, PocketIcBuilder};

use dpay_core::generate_keypair;
use dpay_relay::agent_ledger::{
    icp_legacy_account_identifier, IcpIndexAccountTransactionsOk,
    IcpIndexAccountTransactionsResult, IcpIndexApprove, IcpIndexBurn,
    IcpIndexGetAccountTransactionsArgs, IcpIndexMint, IcpIndexTokens, IcpIndexTransaction,
    IcpIndexTransactionWithId, IcpIndexTransfer, ICP_INDEX,
};
use dpay_relay::{app, AgentLedger, AppState};
use icrc_ledger_types::icrc1::account::Account;

/// The compiled catalog's ICP row (`crate::catalog`, currency 8): its ledger principal IS the
/// canonical ICP ledger — exactly the row the adapter dispatches to the pinned index below.
const CURRENCY: u32 = 8;
/// MUST equal `agent_ledger::ICP_INDEX_PAGE_SIZE` (a private const): the responder's expected
/// args are built with this value, so drift traps every query instead of silently matching.
const ADAPTER_PAGE_SIZE: u64 = 100;
/// The counterparty's LEGACY account identifier in the fixtures — deliberately NOT a principal
/// text: it must pass through to the REST reply byte-for-byte (direction mapping rewrites only
/// the user's own identifier).
const COUNTER_ACCT: &str = "1111111111111111111111111111111111111111111111111111111111111111";
/// Nanosecond timestamps (the index speaks ns); the adapter must serve unix SECONDS.
const TS2_NS: u64 = 1_750_000_002_000_000_000;
const TS1_NS: u64 = 1_750_000_001_000_000_000;
const TS0_NS: u64 = 1_750_000_000_000_000_000;
const SETTLEMENT_MEMO: [u8; 16] = [3u8; 16];

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    (status, json)
}

/// RAII teardown for the PocketIC gateway (see tests/live.rs for the leak war story).
struct LivePocketIc(PocketIc);

impl Drop for LivePocketIc {
    fn drop(&mut self) {
        self.0.stop_live();
    }
}

// --- hand-assembled wasm index responder ---------------------------------------------------------
//
// A valid wasm module with exactly one export, `canister_query get_account_transactions`,
// following the raw canister ABI: `fn()` — no wasm params/results; the argument arrives via
// the ic0 system API and the reply leaves via msg_reply_data_append + msg_reply. Binary
// sections are emitted by hand (type/import/function/memory/export/code/data) with LEB128
// helpers — no `wat` crate exists in the offline graph.

fn uleb(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

fn sleb32(v: i32, out: &mut Vec<u8>) {
    let mut v = v as i64;
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        let done = (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0);
        out.push(if done { b } else { b | 0x80 });
        if done {
            break;
        }
    }
}

fn wasm_section(id: u8, payload: &[u8]) -> Vec<u8> {
    let mut s = vec![id];
    uleb(payload.len() as u64, &mut s);
    s.extend_from_slice(payload);
    s
}

fn wasm_name(s: &str, out: &mut Vec<u8>) {
    uleb(s.len() as u64, out);
    out.extend_from_slice(s.as_bytes());
}

const RESPONDER_ARG_BUF: i32 = 0x800; // incoming query arg lands here (args are tiny)
const RESPONDER_DATA_BASE: i32 = 0x1000; // golden replies live here, packed back to back

/// Build the responder wasm for `routes` = (probes, reply) pairs. A route matches when EVERY
/// (offset, byte) probe equals the corresponding byte of the incoming argument; the first
/// matching route's reply is returned. No match → trap (visible as a rejected query).
fn build_index_responder_wasm(routes: &[(Vec<(u32, u8)>, &[u8])]) -> Vec<u8> {
    // type section: t0 ()->i32, t1 (i32,i32,i32)->(), t2 (i32,i32)->(), t3 ()->()
    let mut types = vec![0x04];
    types.extend_from_slice(&[0x60, 0x00, 0x01, 0x7F]);
    types.extend_from_slice(&[0x60, 0x03, 0x7F, 0x7F, 0x7F, 0x00]);
    types.extend_from_slice(&[0x60, 0x02, 0x7F, 0x7F, 0x00]);
    types.extend_from_slice(&[0x60, 0x00, 0x00]);

    // import section: the four ic0 system functions this query needs (func indices 0..=3).
    let mut imports = vec![0x04];
    for (typeidx, name) in [
        "msg_arg_data_size",
        "msg_arg_data_copy",
        "msg_reply_data_append",
        "msg_reply",
    ]
    .iter()
    .enumerate()
    {
        wasm_name("ic0", &mut imports);
        wasm_name(name, &mut imports);
        imports.push(0x00); // func import
        imports.push(typeidx as u8);
    }

    // function section: one defined function (index 4) of type t3.
    let funcs = vec![0x01, 0x03];

    // memory section: one memory, min 1 page (everything fits well under 64 KiB).
    let memory = vec![0x01, 0x00, 0x01];

    // export section: the query export + memory (conventional for canisters).
    let mut exports = vec![0x02];
    wasm_name("memory", &mut exports);
    exports.extend_from_slice(&[0x02, 0x00]); // mem idx 0
    wasm_name("canister_query get_account_transactions", &mut exports);
    exports.extend_from_slice(&[0x00, 0x04]); // func idx 4

    // code section body.
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(&[0x01, 0x01, 0x7F]); // locals: one i32
                                                 // size = msg_arg_data_size()
    body.extend_from_slice(&[0x10, 0x00]); // call 0
    body.extend_from_slice(&[0x21, 0x00]); // local.set 0
                                           // msg_arg_data_copy(ARG_BUF, 0, size)
    body.push(0x41);
    sleb32(RESPONDER_ARG_BUF, &mut body);
    body.push(0x41);
    sleb32(0, &mut body);
    body.extend_from_slice(&[0x20, 0x00]); // local.get 0
    body.extend_from_slice(&[0x10, 0x01]); // call 1
                                           // routes: if (load8_u(ARG_BUF+o1)==b1 && ...) { reply(...); msg_reply(); return }
    let mut data: Vec<u8> = Vec::new();
    let mut ptr = RESPONDER_DATA_BASE;
    for (probes, reply) in routes {
        for (k, (off, byte)) in probes.iter().enumerate() {
            body.push(0x41);
            sleb32(RESPONDER_ARG_BUF, &mut body);
            body.push(0x2D); // i32.load8_u
            uleb(0, &mut body); // align 2^0
            uleb(*off as u64, &mut body); // offset
            body.push(0x41);
            sleb32(*byte as i32, &mut body);
            body.push(0x46); // i32.eq
            if k > 0 {
                body.push(0x71); // i32.and — folds each further probe into the conjunction
            }
        }
        body.extend_from_slice(&[0x04, 0x40]); // if (void)
        body.push(0x41);
        sleb32(ptr, &mut body);
        body.push(0x41);
        sleb32(reply.len() as i32, &mut body);
        body.extend_from_slice(&[0x10, 0x02]); // call msg_reply_data_append
        body.extend_from_slice(&[0x10, 0x03]); // call msg_reply
        body.push(0x0F); // return
        body.push(0x0B); // end if
        ptr += reply.len() as i32;
        data.extend_from_slice(reply);
    }
    body.push(0x00); // unreachable — no route matched: trap loudly
    body.push(0x0B); // end function
    let mut code = vec![0x01];
    uleb(body.len() as u64, &mut code);
    code.extend_from_slice(&body);

    // data section: one active segment with every reply packed at DATA_BASE.
    let mut seg = vec![0x00]; // active, memory 0
    seg.push(0x41);
    sleb32(RESPONDER_DATA_BASE, &mut seg);
    seg.push(0x0B); // end offset expr
    uleb(data.len() as u64, &mut seg);
    seg.extend_from_slice(&data);
    let data_sec = {
        let mut d = vec![0x01];
        d.extend_from_slice(&seg);
        d
    };

    let mut wasm = b"\0asm".to_vec();
    wasm.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // version 1
    wasm.extend(wasm_section(1, &types));
    wasm.extend(wasm_section(2, &imports));
    wasm.extend(wasm_section(3, &funcs));
    wasm.extend(wasm_section(5, &memory));
    wasm.extend(wasm_section(7, &exports));
    wasm.extend(wasm_section(10, &code));
    wasm.extend(wasm_section(11, &data_sec));
    wasm
}

/// Probes that distinguish `mine` from every `other` expected argument: for each other arg, the
/// first differing byte becomes a (offset, byte-of-mine) probe. Jointly the probes reject every
/// non-matching argument; an unexpected argument that shares ALL probed bytes traps instead of
/// mis-serving (and the distinct-principal fixtures keep that from happening accidentally).
fn probes_for(mine: &[u8], others: &[&[u8]]) -> Vec<(u32, u8)> {
    let mut probes = Vec::new();
    for other in others {
        let mut i = 0usize;
        while i < mine.len().min(other.len()) && mine[i] == other[i] {
            i += 1;
        }
        assert!(
            i < mine.len().min(other.len()),
            "expected index args differ only in length — probes cannot distinguish them; \
             use distinct principals/ids so the byte streams diverge",
        );
        if !probes.iter().any(|(o, _)| *o as usize == i) {
            probes.push((i as u32, mine[i]));
        }
    }
    probes
}

// --- golden index fixtures -----------------------------------------------------------------------

fn tx_transfer(
    id: u64,
    from: &str,
    to: &str,
    e8s: u64,
    memo: Vec<u8>,
    ts_ns: u64,
) -> IcpIndexTransactionWithId {
    IcpIndexTransactionWithId {
        id: Nat::from(id),
        transaction: IcpIndexTransaction {
            burn: None,
            mint: None,
            approve: None,
            transfer: Some(IcpIndexTransfer {
                to: to.into(),
                fee: Some(IcpIndexTokens { e8s: 10_000 }),
                from: from.into(),
                memo: None, // legacy nat64 memo absent; icrc1_memo carries the payload
                icrc1_memo: Some(memo),
                created_at_time: Some(ts_ns + 7), // fallback exists but `timestamp` must win
                amount: IcpIndexTokens { e8s },
            }),
            timestamp: ts_ns,
        },
    }
}

fn tx_mint(id: u64, to: &str, e8s: u64, memo: Vec<u8>, ts_ns: u64) -> IcpIndexTransactionWithId {
    IcpIndexTransactionWithId {
        id: Nat::from(id),
        transaction: IcpIndexTransaction {
            burn: None,
            mint: Some(IcpIndexMint {
                to: to.into(),
                memo: None,
                icrc1_memo: Some(memo),
                created_at_time: None,
                amount: IcpIndexTokens { e8s },
            }),
            approve: None,
            transfer: None,
            timestamp: ts_ns,
        },
    }
}

#[allow(dead_code)]
fn tx_unused_approve_and_burn_shaped_correctly() {
    // Approve/burn shapes exist for decode parity; the fixtures below never send them, and the
    // unit tests in agent_ledger.rs cover their omission from the REST contract.
    let _ = (
        IcpIndexApprove {
            from: String::new(),
        },
        IcpIndexBurn {
            from: String::new(),
            memo: None,
            icrc1_memo: None,
            created_at_time: None,
            amount: IcpIndexTokens { e8s: 0 },
        },
    );
}

/// Encode a `get_account_transactions` argument EXACTLY the way the adapter does — this is
/// what the responder's routes are keyed against.
fn index_arg(account: &Account, start: Option<u64>) -> Vec<u8> {
    encode_args((IcpIndexGetAccountTransactionsArgs {
        account: account.clone(),
        start: start.map(Nat::from),
        max_results: Nat::from(ADAPTER_PAGE_SIZE),
    },))
    .expect("encode index arg")
}

fn ok_reply(rows: Vec<IcpIndexTransactionWithId>, oldest_tx_id: Option<u64>) -> Vec<u8> {
    encode_one(&IcpIndexAccountTransactionsResult::Ok(
        IcpIndexAccountTransactionsOk {
            transactions: rows,
            oldest_tx_id: oldest_tx_id.map(Nat::from),
        },
    ))
    .expect("encode index reply")
}

#[test]
fn live_icp_index_history_dispatch_direction_memo_pagination_real_agent_path() {
    std::env::set_var("POCKET_IC_MUTE_SERVER", "1");
    // The pinned ICP_INDEX principal falls in PocketIC's NNS id range — the instance needs an
    // NNS subnet to host it (the application subnet hosts the ordinary canisters).
    let mut pic = PocketIcBuilder::new()
        .with_application_subnet()
        .with_nns_subnet()
        .build();
    let gateway_url = pic.make_live(None).to_string();
    let pic = LivePocketIc(pic); // teardown guaranteed on every exit path from here

    // Users: the dpay account shape is `owner = self_authenticating_ed25519(pubkey)`.
    let user_pk = generate_keypair().verifying_key().to_bytes();
    let stranger_pk = generate_keypair().verifying_key().to_bytes();
    let user_account = Account {
        owner: Principal::from_slice(
            dpay_icp::principal::Principal::self_authenticating_ed25519(&user_pk).as_slice(),
        ),
        subaccount: None,
    };
    let stranger_account = Account {
        owner: Principal::from_slice(
            dpay_icp::principal::Principal::self_authenticating_ed25519(&stranger_pk).as_slice(),
        ),
        subaccount: None,
    };
    let user_principal_text = user_account.owner.to_text();

    // The legacy ACCOUNT IDENTIFIER the real index speaks for the user's default subaccount —
    // the exact string the adapter must recognize and rewrite to the principal text.
    let my_acct = icp_legacy_account_identifier(&user_account.owner);
    assert_ne!(my_acct, COUNTER_ACCT, "fixtures must be distinguishable");

    // Golden replies, newest-first per the real index contract.
    let reply_p1 = ok_reply(
        vec![
            // id 1002 — transfer IN, u64::MAX amount, plain memo
            tx_transfer(
                1002,
                COUNTER_ACCT,
                &my_acct,
                u64::MAX,
                b"change".to_vec(),
                TS2_NS,
            ),
            // id 1001 — transfer OUT with the 16-byte settlement memo (dpay reconciliation shape)
            tx_transfer(
                1001,
                &my_acct,
                COUNTER_ACCT,
                250,
                SETTLEMENT_MEMO.to_vec(),
                TS1_NS,
            ),
        ],
        Some(1000),
    );
    let reply_p2 = ok_reply(
        vec![
            // id 1000 — mint of the user; ONLY on page 2: proves `start`-keyed pagination
            tx_mint(1000, &my_acct, 10_000, vec![0xAA], TS0_NS),
        ],
        None,
    );
    let reply_stranger = ok_reply(vec![], None);

    // The three argument byte-streams the adapter must produce (computed, not guessed).
    let arg_user_p1 = index_arg(&user_account, None);
    let arg_user_p2 = index_arg(&user_account, Some(1000));
    let arg_stranger_p1 = index_arg(&stranger_account, None);
    let routes = [
        (
            probes_for(&arg_user_p1, &[&arg_user_p2, &arg_stranger_p1]),
            reply_p1.as_slice(),
        ),
        (
            probes_for(&arg_user_p2, &[&arg_user_p1, &arg_stranger_p1]),
            reply_p2.as_slice(),
        ),
        (
            probes_for(&arg_stranger_p1, &[&arg_user_p1, &arg_user_p2]),
            reply_stranger.as_slice(),
        ),
    ];

    // Reserve the PINNED index principal and install the responder at it.
    let index = Principal::from_text(ICP_INDEX).expect("pinned index id parses");
    pic.0
        .create_canister_with_id(None, None, index)
        .expect("reserve the pinned ICP_INDEX principal on PocketIC");
    pic.0.add_cycles(index, 1_000_000_000_000);
    let wasm = build_index_responder_wasm(&routes);
    pic.0.install_canister(index, wasm, vec![], None);

    // The routes resolve the ICP row (currency 8) from the COMPILED catalog: its ledger
    // principal IS the canonical ICP ledger (no such ledger canister exists on this PocketIC —
    // the adapter must never touch it; history dispatch goes straight to the index). Nothing
    // consults the facade for the catalog anymore, so an empty canister id is all
    // `AgentLedger::connect` needs here.
    let dpay = pic.0.create_canister();
    pic.0.add_cycles(dpay, 2_000_000_000_000);

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async move {
        let agent = AgentLedger::connect(&gateway_url, dpay)
            .await
            .expect("agent connect");
        let state = AppState::new(Arc::new(agent));
        let base = format!("/api/v1/transactions/{}", hex::encode(user_pk));

        // 1. Ordinary history across TWO index pages: [1002, 1001, 1000], newest-first.
        //    The mint (1000) exists only on page 2 — its presence proves the adapter paged
        //    backward with start = page-1's oldest_tx_id through the real agent path.
        let (code, b) = call(&state, get(&format!("{base}?currency={CURRENCY}&limit=30"))).await;
        assert_eq!(code, StatusCode::OK, "body: {b}");
        let rows = b["transactions"].as_array().expect("transactions array");
        assert_eq!(rows.len(), 3, "both pages collected: {b}");

        // 1002: counterparty account-id passes through UNCHANGED; user side becomes the
        // principal text; u64::MAX survives as a raw decimal string; ns → unix seconds.
        assert_eq!(rows[0]["from"], json!(COUNTER_ACCT));
        assert_eq!(rows[0]["to"], json!(user_principal_text));
        assert_eq!(rows[0]["amount"], json!("18446744073709551615"));
        assert_eq!(rows[0]["memo"], json!(hex::encode("change")));
        assert_eq!(rows[0]["timestamp"], json!(1_750_000_002));
        assert_eq!(rows[0]["currency"], json!(CURRENCY));

        // 1001: the user's legacy account identifier is rewritten to the principal text;
        // the 16-byte icrc1 memo is byte-preserving hex.
        assert_eq!(rows[1]["from"], json!(user_principal_text));
        assert_eq!(rows[1]["to"], json!(COUNTER_ACCT));
        assert_eq!(rows[1]["amount"], json!("250"));
        assert_eq!(rows[1]["memo"], json!(hex::encode(SETTLEMENT_MEMO)));
        assert_eq!(rows[1]["timestamp"], json!(1_750_000_001));

        // 1000: mint — empty sender sentinel, user as recipient.
        assert_eq!(rows[2]["from"], json!(""));
        assert_eq!(rows[2]["to"], json!(user_principal_text));
        assert_eq!(rows[2]["amount"], json!("10000"));
        assert_eq!(rows[2]["memo"], json!("aa"));
        assert_eq!(rows[2]["timestamp"], json!(1_750_000_000));

        // 2. limit=1 truncates to the newest row (limit respected on the real path).
        let (code, b) = call(&state, get(&format!("{base}?currency={CURRENCY}&limit=1"))).await;
        assert_eq!(code, StatusCode::OK, "body: {b}");
        let rows = b["transactions"].as_array().expect("transactions array");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["amount"], json!("18446744073709551615"));

        // 3. Exact-memo filtering BEFORE limit truncation: the settlement row is OLDER than
        //    the non-matching newest row, yet limit=1 must return the MATCHING row, not the
        //    newest one — the responder always returns both, so this proves the adapter (not
        //    the fixture) filters, and that the filter precedes the limit.
        let (code, b) = call(
            &state,
            get(&format!(
                "{base}?currency={CURRENCY}&limit=1&memo={}",
                hex::encode(SETTLEMENT_MEMO)
            )),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "body: {b}");
        let rows = b["transactions"].as_array().expect("transactions array");
        assert_eq!(rows.len(), 1, "filter runs before limit: {b}");
        assert_eq!(rows[0]["memo"], json!(hex::encode(SETTLEMENT_MEMO)));
        assert_eq!(rows[0]["amount"], json!("250"));

        // 4. A stranger's account: the responder's empty page → empty history, 200.
        let (code, b) = call(
            &state,
            get(&format!(
                "/api/v1/transactions/{}?currency={CURRENCY}&limit=30",
                hex::encode(stranger_pk)
            )),
        )
        .await;
        assert_eq!(code, StatusCode::OK, "body: {b}");
        let rows = b["transactions"].as_array().expect("transactions array");
        assert_eq!(rows.len(), 0, "stranger sees no rows: {b}");
    });
}
