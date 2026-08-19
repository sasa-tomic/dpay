//! Golden parity tests — byte equality against vectors produced by the PRODUCTION
//! encoder stack (ic-transport-types 0.48.1 + serde_cbor 0.11.2 + ed25519-dalek 2.2
//! for envelopes; candid 0.10.22 + icrc-ledger-types 0.1.12 for DIDL args/replies).
//! Generated offline by the ic-dump scratch crate; if one of these fails the
//! production encoder and this crate have diverged — fix the crate, never the golden.
//!
//! Reply goldens use the REAL ledger shape (bare `variant { Ok; Err }`, no record
//! wrapper) exactly as ic-icrc1-ledger replies on replica AND mainnet; the
//! LIVE-CAPTURED vectors (real-ledger transfer reply, mainnet DUSD decimals) pin
//! that claim to observed wire bytes, not just the generator.

use dpay_icp::icrc::{self, ApproveError, ApproveResult, TransferError, TransferResult};
use dpay_icp::{sign_query, sign_read_state, sign_update, Account, CallRequest, Principal, RidValue, request_id};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

/// RFC 8032 test-vector-1 key — the exact identity the goldens were signed with.
fn sk() -> ed25519_dalek::SigningKey {
    let mut b = [0u8; 32];
    for (i, pair) in ["9d", "61", "b1", "9d", "ef", "fd", "5a", "60", "ba", "84", "4a", "f4", "92", "ec", "2c", "c4",
                      "44", "49", "c5", "69", "7b", "32", "69", "19", "70", "3b", "ac", "03", "1c", "ae", "7f", "60"]
        .iter().enumerate() {
        b[i] = u8::from_str_radix(pair, 16).unwrap();
    }
    ed25519_dalek::SigningKey::from_bytes(&b)
}

const EXPIRY: u64 = 1_685_570_400_000_000_000;

fn selfauth() -> Principal {
    Principal::from_bytes(&unhex("3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d202")).unwrap()
}

/// k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae
fn to_principal() -> Principal {
    Principal::from_bytes(&unhex("b56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c02")).unwrap()
}

fn acct7() -> Account {
    Account { owner: selfauth(), subaccount: [7u8; 32] }
}
const G_QUERY_ENVELOPE: &str = "d9d9f7a367636f6e74656e74a66c726571756573745f747970656571756572796e696e67726573735f6578706972791b1764595927e9c0006673656e646572581d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d2026b63616e69737465725f69644800000000000004d26b6d6574686f645f6e616d657069637263315f62616c616e63655f6f6663617267585a4449444c036c02b3b0dac30368ad86ca8305016e026d7b0100011d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d202012007070707070707070707070707070707070707070707070707070707070707076d73656e6465725f7075626b6579582c302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a6a73656e6465725f736967584067e584ddd3b99f61c5b1e7b30360a2ae1684517cabc5ddfd0f6dae9524a152da366e0199a129d68f7bc45352392a309a5a3b73408e470a0d51512de1958caa01";
const G_READ_STATE_ENVELOPE: &str = "d9d9f7a367636f6e74656e74a46c726571756573745f747970656a726561645f73746174656e696e67726573735f6578706972791b1764595927e9c0006673656e646572581d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d20265706174687381824e726571756573745f73746174757358201d1091364d6bb8a6c16b203ee75467d59ead468f523eb058880ae8ec80e2b1016d73656e6465725f7075626b6579582c302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a6a73656e6465725f73696758407e9b7de95eba4f07b3e80760b9ea8bdd9492f2b78d67156c6c22c9e215540e86dd9f8ac7e2c40189eaee7bbfedcc10f87a60e504e21f231b290e056a0fe66c07";
const G_U64_NONCE_ENVELOPE: &str = "d9d9f7a367636f6e74656e74a76c726571756573745f747970656463616c6c656e6f6e63654808070605040302016e696e67726573735f6578706972791b1764595927e9c0006673656e646572581d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d2026b63616e69737465725f6964490000000000000000026b6d6574686f645f6e616d656e69637263315f7472616e7366657263617267589c4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100011d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d2020120070707070707070707070707070707070707070707070707070707070707070701904e0108aaaaaaaaaaaaaaaa000100c0e92759596417959aef3a6d73656e6465725f7075626b6579582c302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a6a73656e6465725f736967584051d2843e47d5552c67d0519f31a1a5d8a216cc609a797f1e8112b64645d9423cf890c84a3d4b4166226bd403ecf3bce1e80ddc5d38436f7c0d1cbb91d03d520b";
const G_TRANSFER_FULL: &str = "4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100011d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d2020120070707070707070707070707070707070707070707070707070707070707070701904e0108aaaaaaaaaaaaaaaa000100c0e92759596417959aef3a";
const G_TRANSFER_MINIMAL: &str = "4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e780100011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c02000000012000000000000000000000000000000000000000000000000000000000000000000000";
const G_APPROVE: &str = "4449444c066c08c6fcb60201ba89e5c20402a2de94eb060282f3f3910c04d8a38ca80d7d919c9cbf0d01dea7f7da0d04cb96dcb40e056e7d6e036d7b6e786c02b3b0dac30368ad86ca830502010001904e000000c0843d000163c0e92759596417011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c0201200909090909090909090909090909090909090909090909090909090909090909";
const G_BALANCE_OF_ARG: &str = "4449444c036c02b3b0dac30368ad86ca8305016e026d7b0100011d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d20201200707070707070707070707070707070707070707070707070707070707070707";
const G_ALLOWANCE_ARG: &str = "4449444c046c02adf9e78a0a01cb96dcb40e016c02b3b0dac30368ad86ca8305026e036d7b0100011d3d9bdaa34fe81df16699403f3e17d6030488fc8c9e37ab61036482d20201200707070707070707070707070707070707070707070707070707070707070707011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c0200";
const G_INT_NAT_BIG: &str = "4449444c00017dfba094a58d1d"; // nat 1_000_000_000_123 (balance-class reply)
const G_INT_NAT_0: &str = "4449444c00017d00"; // nat 0 (fresh-account balance)
const G_INT_NAT8: &str = "4449444c00017b02"; // nat8 2 — LIVE-CAPTURED mainnet DUSD icrc1_decimals
const G_INT_NAT8_8: &str = "4449444c00017b08"; // nat8 8 — LIVE-CAPTURED mainnet ckBTC icrc1_decimals
const G_INT_NAT16: &str = "4449444c00017a2c01"; // nat16 300
const G_INT_NAT32: &str = "4449444c00017970110100"; // nat32 70_000
const G_INT_NAT64: &str = "4449444c000178000008c5a1d8ccf9"; // nat64 18e18
const G_INT_INT8_NEG: &str = "4449444c000177fb"; // int8 -5
const G_INT_INT16_NEG: &str = "4449444c000176d4fe"; // int16 -300
const G_INT_INT32: &str = "4449444c00017540e20100"; // int32 123_456
const G_INT_INT64_NEG: &str = "4449444c000174ffffffffffffffff"; // int64 -1
const G_INT_INT_BIG: &str = "4449444c00017c8180808080808080808080808080808080807e"; // int i128::MIN (sleb)
const G_INT_INT_POS_LEB: &str = "4449444c00017ce807"; // int 1000 (positive sleb)
const G_RID_REAL_TRANSFER: &str = "775c99aa0766bd8890e7784dd5081104195302f7d7029e47421c4d4e60585a54";
const G_RID_SPEC_CALL: &str = "1d1091364d6bb8a6c16b203ee75467d59ead468f523eb058880ae8ec80e2b101";
// --- TransferResult replies: the REAL ic-icrc1-ledger shape (bare variant; Ok : nat,
// Err → the TransferError variant) regenerated with candid 0.10.22 from ledger.did types.
const G_TR_OK: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d010000d209";
const G_TR_BADFEE: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000104904e";
const G_TR_BADBURN: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d0100010201";
const G_TR_INSUFFICIENTFUNDS: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d0100010700";
const G_TR_TOOOLD: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000106";
const G_TR_CREATEDINFUTURE: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d0100010500c0e92759596417";
const G_TR_TEMPORARILYUNAVAILABLE: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000101";
const G_TR_DUPLICATE: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d010001032a";
const G_TR_GENERICERROR: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d0100010004626f6f6d2a";
// --- ApproveResult replies: same real shape (Ok : BlockIndex nat per ledger.did:42).
const G_AR_OK: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d01000007";
const G_AR_GENERICERROR: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d01000100046e6f706507";
const G_AR_TEMPORARILYUNAVAILABLE: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d01000101";
const G_AR_DUPLICATE: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d0100010209";
const G_AR_BADFEE: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d01000103904e";
const G_AR_ALLOWANCECHANGED: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d0100010405";
const G_AR_CREATEDINFUTURE: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d0100010500c0e92759596417";
const G_AR_TOOOLD: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d01000106";
const G_AR_EXPIRED: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d0100010763c0e92759596417";
const G_AR_INSUFFICIENTFUNDS: &str = "4449444c086b02bc8a017dc5fed201016b09d1c4987c02c291ecb9027feb82a8970403a1c3ebfd07049c84e8fc0805f087e6db090693e5bec80c7f858fee950f06eb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c018bbdf29b017d6c01bf9bb7f00d7d6c0192aecee50f7d6c01a3bb918c0a786c019cbab69c027d0100010803";
/// LIVE-CAPTURED (dfx replica, P1→P2 on the real ic-icrc1-ledger, 2026-08): the exact
/// 123-byte `icrc1_transfer` Ok reply — block index 2. Its type table is byte-identical
/// to the generated G_TR_* tables (same real-ledger shape).
const G_LIVE_REAL_LEDGER_TRANSFER_OK: &str = "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018bbdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000002";
/// The artifact-encoded one-field record wrapper around the result variant — the shape
/// the REAL ledger never sends; the decoder must reject it (bare-only contract).
const G_WRAPPER_REJECTED: &str = "4449444c016c01bc8a0100011d01000001";

fn assert_eq_hex(actual: &[u8], golden: &str, what: &str) {
    let a: String = actual.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(a, golden, "{what} diverged from the production encoder");
}

#[test]
fn golden_real_transfer_request_id() {
    // rid of the 464B production envelope (§7.3): self-auth sender, canister 00*8 02,
    // nonce [1u8;16] — the u64-nonce CallRequest can't express a 16B nonce, but the
    // public request_id() covers it: nonce hashes as its raw wire bytes.
    let rid = request_id(&[
        ("request_type", RidValue::Str("call".into())),
        ("nonce", RidValue::Bytes(vec![1u8; 16])),
        ("ingress_expiry", RidValue::U64(EXPIRY)),
        ("sender", RidValue::Bytes(selfauth().as_slice().to_vec())),
        (
            "canister_id",
            RidValue::Bytes(vec![0, 0, 0, 0, 0, 0, 0, 0, 2]),
        ),
        ("method_name", RidValue::Str("icrc1_transfer".into())),
        (
            "arg",
            RidValue::Bytes(icrc::transfer_arg(
                &acct7(),
                None,
                123_456_789,
                Some(10_000),
                Some(vec![0xAA; 8]),
                Some(EXPIRY),
            )),
        ),
    ]);
    assert_eq_hex(&rid, G_RID_REAL_TRANSFER, "real transfer request_id");
}

#[test]
fn golden_selfauth_query_envelope() {
    let arg = icrc::balance_of_arg(&acct7());
    assert_eq_hex(&arg, G_BALANCE_OF_ARG, "balance_of arg");
    let env = sign_query(&sk(), &CallRequest {
        canister: Principal::from_bytes(&[0, 0, 0, 0, 0, 0, 0x04, 0xd2]).unwrap(),
        method_name: "icrc1_balance_of".into(),
        arg,
        ingress_expiry_ns: EXPIRY,
        nonce: None,
    });
    assert_eq_hex(&env, G_QUERY_ENVELOPE, "query envelope");
}

#[test]
fn golden_selfauth_read_state_envelope() {
    let rid = unhex(G_RID_SPEC_CALL);
    let path: &[&[u8]] = &[b"request_status", &rid];
    let env = sign_read_state(&sk(), &[path], EXPIRY);
    assert_eq_hex(&env, G_READ_STATE_ENVELOPE, "read_state envelope");
}

#[test]
fn golden_u64_nonce_transfer_envelope() {
    // nonce 0x0102030405060708 → wire bytes 08 07 06 05 04 03 02 01 (LE vec)
    let env = sign_update(&sk(), &CallRequest {
        canister: Principal::from_bytes(&[0, 0, 0, 0, 0, 0, 0, 0, 0x02]).unwrap(),
        method_name: "icrc1_transfer".into(),
        arg: icrc::transfer_arg(
            &acct7(), None, 123_456_789, Some(10_000), Some(vec![0xAA; 8]), Some(EXPIRY),
        ),
        ingress_expiry_ns: EXPIRY,
        nonce: Some(0x0102030405060708),
    });
    assert_eq_hex(&env, G_U64_NONCE_ENVELOPE, "u64-nonce update envelope");
}

#[test]
fn golden_transfer_arg_full() {
    let b = icrc::transfer_arg(&acct7(), None, 123_456_789, Some(10_000), Some(vec![0xAA; 8]), Some(EXPIRY));
    assert_eq_hex(&b, G_TRANSFER_FULL, "transfer arg (all fields set)");
}

#[test]
fn golden_transfer_arg_minimal() {
    // explicit Some([0;32]) from_subaccount must stay an opt-some on the wire
    let to = Account { owner: to_principal(), subaccount: [0u8; 32] };
    let b = icrc::transfer_arg(&to, Some([0u8; 32]), 0, None, None, None);
    assert_eq_hex(&b, G_TRANSFER_MINIMAL, "transfer arg (minimal)");
}

#[test]
fn golden_approve_arg() {
    let spender = Account { owner: to_principal(), subaccount: [9u8; 32] };
    let b = icrc::approve_arg(None, &spender, Some(1_000_000), None, Some(EXPIRY + 99), None, None, Some(10_000));
    assert_eq_hex(&b, G_APPROVE, "approve arg");
}

#[test]
fn golden_allowance_arg() {
    let spender = Account { owner: to_principal(), subaccount: [0u8; 32] };
    let b = icrc::allowance_arg(&acct7(), &spender);
    assert_eq_hex(&b, G_ALLOWANCE_ARG, "allowance arg");
}

#[test]
fn golden_decode_transfer_results() {
    use TransferError::*;
    use TransferResult::*;
    let cases: Vec<(&str, TransferResult)> = vec![
        ("Ok", Ok(1234)),
        ("BadFee", Err(BadFee { expected_fee: 10_000 })),
        ("BadBurn", Err(BadBurn { min_burn_amount: 1 })),
        ("InsufficientFunds", Err(InsufficientFunds { balance: 0 })),
        ("TooOld", Err(TooOld)),
        ("CreatedInFuture", Err(CreatedInFuture { ledger_time: EXPIRY })),
        ("TemporarilyUnavailable", Err(TemporarilyUnavailable)),
        ("Duplicate", Err(Duplicate { duplicate_of: 42 })),
        ("GenericError", Err(GenericError { error_code: 42, message: "boom".into() })),
    ];
    let goldens = [
        ("Ok", G_TR_OK), ("BadFee", G_TR_BADFEE), ("BadBurn", G_TR_BADBURN),
        ("InsufficientFunds", G_TR_INSUFFICIENTFUNDS), ("TooOld", G_TR_TOOOLD),
        ("CreatedInFuture", G_TR_CREATEDINFUTURE),
        ("TemporarilyUnavailable", G_TR_TEMPORARILYUNAVAILABLE),
        ("Duplicate", G_TR_DUPLICATE), ("GenericError", G_TR_GENERICERROR),
    ];
    for (name, want) in &cases {
        let hexs = goldens.iter().find(|(n, _)| n == name).unwrap().1;
        assert_eq!(icrc::decode_transfer_result(&unhex(hexs)).unwrap(), *want, "{name}");
    }
    // The artifact wrapper shape (rec{0: variant}) is NOT the real ledger's — reject.
    assert!(icrc::decode_transfer_result(&unhex(G_WRAPPER_REJECTED)).is_err());
    // Truncated type table and trailing bytes after the value are both fatal.
    assert!(icrc::decode_transfer_result(&unhex("4449444c086b02bc8a01")).is_err());
    let mut trailing = unhex(G_TR_OK);
    trailing.push(0x00);
    assert!(icrc::decode_transfer_result(&trailing).is_err());
}

#[test]
fn golden_decode_approve_results() {
    use ApproveError::*;
    use ApproveResult::*;
    let cases: Vec<(&str, ApproveResult)> = vec![
        ("Ok", Ok(7)), // Ok carries the BlockIndex nat per ledger.did:42
        ("GenericError", Err(GenericError { error_code: 7, message: "nope".into() })),
        ("TemporarilyUnavailable", Err(TemporarilyUnavailable)),
        ("Duplicate", Err(Duplicate { duplicate_of: 9 })),
        ("BadFee", Err(BadFee { expected_fee: 10_000 })),
        ("AllowanceChanged", Err(AllowanceChanged { current_allowance: 5 })),
        ("CreatedInFuture", Err(CreatedInFuture { ledger_time: EXPIRY })),
        ("TooOld", Err(TooOld)),
        ("Expired", Err(Expired { ledger_time: EXPIRY + 99 })),
        ("InsufficientFunds", Err(InsufficientFunds { balance: 3 })),
    ];
    let goldens = [
        ("Ok", G_AR_OK), ("GenericError", G_AR_GENERICERROR),
        ("TemporarilyUnavailable", G_AR_TEMPORARILYUNAVAILABLE), ("Duplicate", G_AR_DUPLICATE),
        ("BadFee", G_AR_BADFEE), ("AllowanceChanged", G_AR_ALLOWANCECHANGED),
        ("CreatedInFuture", G_AR_CREATEDINFUTURE), ("TooOld", G_AR_TOOOLD),
        ("Expired", G_AR_EXPIRED), ("InsufficientFunds", G_AR_INSUFFICIENTFUNDS),
    ];
    for (name, want) in &cases {
        let hexs = goldens.iter().find(|(n, _)| n == name).unwrap().1;
        assert_eq!(icrc::decode_approve_result(&unhex(hexs)).unwrap(), *want, "{name}");
    }
    assert!(icrc::decode_approve_result(&unhex(G_WRAPPER_REJECTED)).is_err());
    let mut trailing = unhex(G_AR_OK);
    trailing.push(0x00);
    assert!(icrc::decode_approve_result(&trailing).is_err());
}

#[test]
fn golden_decode_int_replies() {
    // every integer prim the ICRC-1 read methods can return, plus signed edge cases
    let cases: [(&str, i128); 13] = [
        ("nat big", 1_000_000_000_123),
        ("nat 0", 0),
        ("nat8 (mainnet DUSD decimals)", 2),
        ("nat8 (mainnet ckBTC decimals)", 8),
        ("nat16", 300),
        ("nat32", 70_000),
        ("nat64", 18_000_000_000_000_000_000),
        ("int8 neg", -5),
        ("int16 neg", -300),
        ("int32", 123_456),
        ("int64 neg", -1),
        ("int i128::MIN", -170_141_183_460_469_231_731_687_303_715_884_105_727),
        ("int pos sleb", 1_000),
    ];
    let goldens = [
        G_INT_NAT_BIG, G_INT_NAT_0, G_INT_NAT8, G_INT_NAT8_8, G_INT_NAT16, G_INT_NAT32,
        G_INT_NAT64, G_INT_INT8_NEG, G_INT_INT16_NEG, G_INT_INT32, G_INT_INT64_NEG,
        G_INT_INT_BIG, G_INT_INT_POS_LEB,
    ];
    for ((name, want), g) in cases.iter().zip(goldens) {
        assert_eq!(icrc::decode_int(&unhex(g)).unwrap(), *want, "{name}");
    }
    // non-integer prims are rejected: text (tag -15 = 0x71)
    assert!(icrc::decode_int(&unhex("4449444c000171")).is_err());
    // trailing bytes are rejected
    assert!(icrc::decode_int(&unhex("4449444c00017d00ff")).is_err());
}

#[test]
fn golden_decode_uleb_overlong_is_err() {
    // Adversarial LEB128s at the type-table count — the first uleb every decoder
    // reads. Pre-fix these executed a `7*k >= 128` shift: debug panicked on the
    // spot; release masked the shift and silently decoded a WRONG value.
    // Reproducer: DIDL + 80×19 + 00 (a 20-group encoding of 0) must Err everywhere.
    let repro = unhex(&format!("4449444c{}00", "80".repeat(19)));
    assert!(icrc::decode_transfer_result(&repro).is_err());
    assert!(icrc::decode_approve_result(&repro).is_err());
    assert!(icrc::decode_int(&repro).is_err());
    // DIDL + ff×25 — oversized payload AND overlong; never a legal u128.
    let ff = unhex(&format!("4449444c{}", "ff".repeat(25)));
    assert!(icrc::decode_transfer_result(&ff).is_err());
    assert!(icrc::decode_approve_result(&ff).is_err());
    assert!(icrc::decode_int(&ff).is_err());
    // DIDL + 80×19 + 01 — a 20-group encoding of the small value 1 (the release-mode
    // masked-shift class: pre-fix this silently decoded 32). Must Err.
    let overlong_small = unhex(&format!("4449444c{}01", "80".repeat(19)));
    assert!(icrc::decode_transfer_result(&overlong_small).is_err());
    assert!(icrc::decode_approve_result(&overlong_small).is_err());
    assert!(icrc::decode_int(&overlong_small).is_err());
}

#[test]
fn golden_decode_uleb_wide_legal_values() {
    // Wide-but-legal LEB128s keep decoding exactly.
    // nat 1<<100: 15 groups (80×14 + 04 — payload 4 at shift 98).
    let mut nat_1s100 = b"DIDL\x00\x01\x7d".to_vec(); // 0 types, 1 arg, arg0 = nat
    nat_1s100.extend_from_slice(&[0x80; 14]);
    nat_1s100.push(0x04);
    assert_eq!(icrc::decode_int(&nat_1s100).unwrap(), 1i128 << 100);
    // nat 1<<126: the widest legal shape — 19 groups (80×18 + 01; the final payload 1
    // fits the 2 bits left after 18×7 = 126).
    let mut nat_1s126 = b"DIDL\x00\x01\x7d".to_vec();
    nat_1s126.extend_from_slice(&[0x80; 18]);
    nat_1s126.push(0x01);
    assert_eq!(icrc::decode_int(&nat_1s126).unwrap(), 1i128 << 126);
    // u128::MAX as a BadFee payload (ff×18 + 03 — the exact 19-group ceiling), riding
    // the golden transfer/approve type tables with only the value bytes swapped.
    let mut tr = unhex(G_TR_BADFEE);
    tr.truncate(tr.len() - 2); // drop the 10_000 (90 4e) value
    tr.extend_from_slice(&[0xff; 18]);
    tr.push(0x03);
    assert_eq!(
        icrc::decode_transfer_result(&tr).unwrap(),
        TransferResult::Err(TransferError::BadFee { expected_fee: u128::MAX })
    );
    let mut ar = unhex(G_AR_BADFEE);
    ar.truncate(ar.len() - 2); // drop the 10_000 (90 4e) value
    ar.extend_from_slice(&[0xff; 18]);
    ar.push(0x03);
    assert_eq!(
        icrc::decode_approve_result(&ar).unwrap(),
        ApproveResult::Err(ApproveError::BadFee { expected_fee: u128::MAX })
    );
}

#[test]
fn golden_decode_sleb_extremes_and_overlong_is_err() {
    // LEGAL extremes — the exact bytes the cached production candid 0.10.22 crate
    // emits for the i128 boundary values (scratch `candid::encode_one` dump). These
    // pin the byte-exact contract the stricter sleb guard must keep decoding; if one
    // fails the guard over-reached — fix the guard, never the golden.
    let legal: [(&str, &str, i128); 4] = [
        ("i128::MIN", "4449444c00017c8080808080808080808080808080808080807e", i128::MIN),
        ("i128::MAX", "4449444c00017cffffffffffffffffffffffffffffffffffff01", i128::MAX),
        ("-1", "4449444c00017c7f", -1),
        ("1", "4449444c00017c01", 1),
    ];
    for (name, g, want) in &legal {
        assert_eq!(icrc::decode_int(&unhex(g)).unwrap(), *want, "{name}");
    }
    // HOSTILE 19-group overlong NON-canonical tails (verifier reproducers): DIDL int
    // + 80×18 + a final payload that is NOT an exact sign extension of the 2 bits an
    // i128 has left after 126. The production candid crate silently mis-decodes all
    // four (40→0, 02→i128::MIN, 3f→-1, 41→garbage); the house bar is
    // stricter-than-reference — every one must Err.
    for tail in ["40", "02", "3f", "41"] {
        let repro = unhex(&format!("4449444c00017c{}{}", "80".repeat(18), tail));
        assert!(
            icrc::decode_int(&repro).is_err(),
            "19-group overlong sleb tail {tail} must Err"
        );
    }
}

#[test]
fn golden_live_real_ledger_transfer_reply() {
    // LIVE-CAPTURED permanent fixture: the exact bytes a REAL ic-icrc1-ledger replied
    // to a signed icrc1_transfer (dfx replica; mainnet replies share this shape).
    assert_eq!(
        icrc::decode_transfer_result(&unhex(G_LIVE_REAL_LEDGER_TRANSFER_OK)).unwrap(),
        TransferResult::Ok(2),
        "the captured real-ledger reply must decode as Ok(block 2)"
    );
}

#[test]
fn golden_mainnet_dusd_principal_and_balance_arg() {
    // LIVE vector: the PROD DUSD ICRC-3 ledger id (docs/CANISTERS.md) parses through
    // the strict canonical base32+CRC32 text codec and builds a balance query for it.
    let dusd = Principal::from_text("td2nx-oaaaa-aaaab-qhdnq-cai")
        .unwrap_or_else(|e| panic!("prod DUSD ledger id must parse: {e}"));
    assert_eq!(dusd.to_text(), "td2nx-oaaaa-aaaab-qhdnq-cai", "canonical round-trip");

    // Balance query for the DUSD default account: the golden-pinned balance_of table
    // prefix, the owner blob embedded verbatim right after it, and the zero
    // subaccount canonicalized to opt-null with nothing trailing.
    let arg = icrc::balance_of_arg(&Account { owner: dusd.clone(), subaccount: [0u8; 32] });
    let owner = dusd.as_slice();
    let mut blob = vec![owner.len() as u8];
    blob.extend_from_slice(owner);
    let at = arg.windows(blob.len()).position(|w| w == &blob[..]).expect("owner blob embedded");
    assert_eq!(at, 26, "owner blob sits right after the 26-byte DIDL header (magic+table+arg ref)");
    assert_eq!(*arg.last().unwrap(), 0x00, "zero subaccount = opt null");
    assert_eq!(arg.len(), 26 + 1 + owner.len() + 1, "no trailing bytes");

    // and the LIVE-CAPTURED mainnet decimals reply for this very canister decodes to 2
    assert_eq!(icrc::decode_int(&unhex(G_INT_NAT8)).unwrap(), 2);
}

// --- minter args (ckBTC get_btc_address/retrieve_btc_with_approval, ckETH withdraw_eth /
// --- withdraw_erc20 / eip_1559_transaction_price) — regenerated with the cached production
// --- candid 0.10.22 (same generator + versions as every other golden in this file) ---

#[test]
fn golden_minter_args() {
    let owner = Principal::from_text("aaaaa-aa").unwrap(); // anonymous owner (probe shape)
    // get_btc_address(MinterAccount{owner, subaccount: None})
    assert_eq!(
        icrc::minter_account_arg(&owner, None),
        unhex("4449444c046c02b3b0dac30301ad86ca8305026e686e036d7b010001010000"),
        "get_btc_address arg must be the exact 1-record DIDL (2-tuples trap IC0503 on the real minter)"
    );
    // retrieve_btc_with_approval({address, amount: 50_000 sats, from_subaccount: None})
    assert_eq!(
        icrc::retrieve_btc_arg("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", 50_000, None),
        unhex("4449444c036c03a2de94eb0601b4e3ade80971d8a38ca80d786e026d7b0100002a626331717879326b676479676a727371747a71326e30797266323439337038336b6b666a687830776c6850c3000000000000"),
        "retrieve_btc_with_approval arg (address, opt blob, nat64 amount)"
    );
    // withdraw_eth({recipient, amount: 1e18 Wei, from_subaccount: None})
    assert_eq!(
        icrc::withdraw_eth_arg("0x1234567890abcdef1234567890abcdef12345678", 1_000_000_000_000_000_000, None),
        unhex("4449444c036c03d9f78b9a0571a2de94eb0601d8a38ca80d7d6e026d7b01002a30783132333435363738393061626364656631323334353637383930616263646566313233343536373800808090bbbad6adf00d"),
        "withdraw_eth arg (opt blob, text recipient, nat amount)"
    );
    // withdraw_erc20({amount, ckerc20_ledger_id, recipient, from_cketh, from_ckerc20})
    let ckusdc = Principal::from_text("xevnm-gaaaa-aaaar-qafnq-cai").unwrap();
    assert_eq!(
        icrc::withdraw_erc20_arg(1_000_000, &ckusdc, "0x1234567890abcdef1234567890abcdef12345678", None, None),
        unhex("4449444c036c059ea7a9980268d9f78b9a0571b0b4dbff0801d597edb90a01d8a38ca80d7d6e026d7b0100010a000000000230015b01012a3078313233343536373839306162636465663132333435363738393061626364656631323334353637380000c0843d"),
        "withdraw_erc20 dual-ledger arg (nat, principal, text, opt blob, opt blob)"
    );
    // eip_1559_transaction_price(opt {ckerc20_ledger_id})
    assert_eq!(
        icrc::eip1559_price_arg(&ckusdc),
        unhex("4449444c026e016c019ea7a9980268010001010a000000000230015b0101"),
        "gas-price query arg (opt record with ckerc20 ledger principal)"
    );
    // decode_text round-trip (get_btc_address reply shape): DIDL magic, empty type table,
    // 1 arg of prim text (sleb -22), then the 49-char bech32 string.
    let mut reply = unhex("4449444c00");
    reply.extend_from_slice(&[0x01, 0x6a]);
    let addr_bytes = b"bc1qxaqqw85nxuvst3q5kjkm5vxyz7mt2qlnjgvpmpx5l8895";
    reply.push(addr_bytes.len() as u8);
    reply.extend_from_slice(addr_bytes);
    let addr = icrc::decode_text(&reply).expect("btc address reply decodes");
    assert_eq!(addr, "bc1qxaqqw85nxuvst3q5kjkm5vxyz7mt2qlnjgvpmpx5l8895", "bare text reply (49-char bech32)");

    // eip_1559_transaction_price reply (production candid 0.10.22): field-hash order
    // max_priority_fee, max_fee, max_tx_fee, timestamp(opt), gas_limit.
    let price = icrc::decode_eip1559_price(&unhex(
        "4449444c026c05ded6aceb037de3eb88d2067dca82b683097dd6a9bbae0a01d5f8acd20a7d6e78010080c2d72f80d0f29ce14880c0abd28cde110100f1536500000000b0ea01",
    ))
    .expect("eip1559 reply decodes");
    assert_eq!(price.gas_limit, 30_000);
    assert_eq!(price.max_fee_per_gas, 2_500_000_000_000u128);
    assert_eq!(price.max_priority_fee_per_gas, 100_000_000u128);
    assert_eq!(price.max_transaction_fee, 78_000_000_000_000u128);
    assert_eq!(price.timestamp, Some(1_700_000_000));
}

#[test]
fn gateway_codecs_round_trip() {
    use dpay_icp::icrc::{
        decode_account_arg, decode_approve_arg, decode_transfer_arg, encode_nat8_reply,
        encode_nat_reply, encode_text_reply, encode_transfer_bad_fee, encode_transfer_duplicate,
        encode_transfer_insufficient_funds, encode_transfer_ok, encode_transfer_too_old,
    };
    use dpay_icp::principal::Principal;

    let owner = Principal::from_text("mxzaz-hqaaa-aaaar-qaada-cai").unwrap();
    let to = dpay_icp::principal::Account { owner: owner.clone(), subaccount: [0u8; 32] };
    let memo = vec![0xabu8; 16];

    // transfer arg round-trip (hash order to/fee/memo/from_subaccount/created_at/amount)
    let arg = dpay_icp::icrc::transfer_arg(&to, None, 250_000, Some(10), Some(memo.clone()), None);
    let d = decode_transfer_arg(&arg).unwrap();
    assert_eq!(d.to, to);
    assert_eq!(d.amount, 250_000);
    assert_eq!(d.fee, Some(10));
    assert_eq!(d.memo, Some(memo));
    assert_eq!(d.from_subaccount, None);
    assert_eq!(d.created_at_time_ns, None);

    // approve arg round-trip
    let arg = dpay_icp::icrc::approve_arg(None, &to, Some(1000), None, None, None, None, Some(10));
    let d = decode_approve_arg(&arg).unwrap();
    assert_eq!(d.spender, to);
    assert_eq!(d.amount, Some(1000));
    assert_eq!(d.fee, Some(10));

    // balance_of arg round-trip
    let arg = dpay_icp::icrc::balance_of_arg(&to);
    assert_eq!(decode_account_arg(&arg).unwrap(), to);

    // reply encoders decode through the production decoders
    let ok = encode_transfer_ok(1234);
    match dpay_icp::icrc::decode_transfer_result(&ok).unwrap() {
        dpay_icp::icrc::TransferResult::Ok(b) => assert_eq!(b, 1234),
        other => panic!("expected Ok, got {other:?}"),
    }
    match dpay_icp::icrc::decode_transfer_result(&encode_transfer_insufficient_funds(77)).unwrap() {
        dpay_icp::icrc::TransferResult::Err(dpay_icp::icrc::TransferError::InsufficientFunds { balance }) => {
            assert_eq!(balance, 77)
        }
        other => panic!("expected InsufficientFunds, got {other:?}"),
    }
    match dpay_icp::icrc::decode_transfer_result(&encode_transfer_bad_fee(10_000)).unwrap() {
        dpay_icp::icrc::TransferResult::Err(dpay_icp::icrc::TransferError::BadFee { expected_fee }) => {
            assert_eq!(expected_fee, 10_000)
        }
        other => panic!("expected BadFee, got {other:?}"),
    }
    assert!(matches!(
        dpay_icp::icrc::decode_transfer_result(&encode_transfer_too_old()).unwrap(),
        dpay_icp::icrc::TransferResult::Err(dpay_icp::icrc::TransferError::TooOld)
    ));
    match dpay_icp::icrc::decode_transfer_result(&encode_transfer_duplicate(42)).unwrap() {
        dpay_icp::icrc::TransferResult::Err(dpay_icp::icrc::TransferError::Duplicate { duplicate_of }) => {
            assert_eq!(duplicate_of, 42)
        }
        other => panic!("expected Duplicate, got {other:?}"),
    }

    // int / text replies round-trip through the live-captured golden decoders
    assert_eq!(dpay_icp::icrc::decode_int(&encode_nat_reply(0)).unwrap(), 0);
    assert_eq!(dpay_icp::icrc::decode_int(&encode_nat_reply(u64::MAX as u128 + 7)).unwrap(), u64::MAX as i128 + 7);
    assert_eq!(dpay_icp::icrc::decode_int(&encode_nat8_reply(8)).unwrap(), 8);
    assert_eq!(
        dpay_icp::icrc::decode_text(&encode_text_reply("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")).unwrap(),
        "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
    );

    // the encoder output is byte-identical to the live-captured Ok golden (block 1234)
    let ok_golden = unhex(G_TR_OK);
    let ours = encode_transfer_ok(1234);
    assert_eq!(&ok_golden[..], &ours[..]);
}
