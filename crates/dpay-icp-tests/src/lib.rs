//! Shared harness for the user-principal-rail tests (`tests/*.rs`).
//!
//! Boots a private PocketIC instance with the REAL DFINITY `ic-icrc1-ledger` (and, for the offramp
//! test, the mock ckBTC minter), exposes it through PocketIC's `make_live()` gateway — the `/api/v2`
//! endpoints fronted by the PRODUCTION `ic_validator` (real Ed25519 signature + expiry checks) —
//! and drives it with dpay-icp-signed envelopes over plain HTTP. That is the exact rail the app's
//! user principal uses on mainnet; funding/minting setup goes through the PocketIC admin API
//! (senders asserted without crypto — scaffolding only, the RAIL is envelope-only).
//!
//! Everything dpay-icp is isolated in [`wire`] so a dpay-icp reshape lands in one place.

use candid::{decode_one, encode_one, CandidType, Deserialize, Nat, Principal as CandidPrincipal};
use ed25519_dalek::SigningKey;
use pocket_ic::PocketIc;
use reqwest::blocking::Client;

pub mod wire;

// ---- read_state / query reply decode ------------------------------------------------------------
// Minimal hand-decode of the two CBOR replies the rail needs (the request_status record is a cert
// TREE, not a flat map — leaves are looked up by path, per ic-agent's response_authentication).

/// Terminal state of a submitted update, decoded from the certified request_status record.
pub enum RequestStatus {
    Replied { arg: Vec<u8> },
    Rejected { reject_code: u64, reject_message: String },
}

fn cbor_map_get<'v>(v: &'v serde_cbor::Value, key: &str) -> Option<&'v serde_cbor::Value> {
    match v {
        serde_cbor::Value::Map(m) => m.get(&serde_cbor::Value::Text(key.to_string())),
        _ => None,
    }
}

fn value_str(v: &serde_cbor::Value) -> Option<&str> {
    match v {
        serde_cbor::Value::Text(s) => Some(s),
        _ => None,
    }
}

fn value_u64(v: &serde_cbor::Value) -> Option<u64> {
    match v {
        serde_cbor::Value::Integer(i) => u64::try_from(*i).ok(),
        _ => None,
    }
}

fn value_bytes(v: &serde_cbor::Value) -> &[u8] {
    match v {
        serde_cbor::Value::Bytes(b) => b,
        _ => panic!("expected CBOR bytes, got {v:?}"),
    }
}

/// reject_code leaves are bare unsigned LEB128, not CBOR ints. Trusted gateway
/// scaffolding, but decoders are panic-free by house rule: a truncated or overlong
/// encoding saturates at the value accumulated so far (and never executes a
/// shift ≥ 64).
fn uleb128(b: &[u8]) -> u64 {
    let mut v = 0u64;
    for (i, byte) in b.iter().enumerate() {
        if 7 * i >= 64 {
            return v; // more groups than a u64 can hold
        }
        v |= ((byte & 0x7f) as u64) << (7 * i);
        if byte & 0x80 == 0 {
            return v;
        }
    }
    v // truncated mid-group
}

// ---- ledger / minter install (mirrors crates/dpay-canister-tests/tests/withdraw.rs) -------------

fn workspace_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn ledger_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_ICRC_LEDGER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read ledger wasm at {}: {e}", path.display()))
}

fn mock_minter_wasm() -> Vec<u8> {
    let path = std::env::var("DPAY_MOCK_MINTER_WASM")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root().join("target/wasm32-unknown-unknown/release/dpay_mock_minter.wasm")
        });
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read mock-minter wasm at {}: {e}", path.display()))
}

#[allow(dead_code)]
#[derive(CandidType, serde::Serialize)]
enum MetadataValue {
    Nat(Nat),
    Int(candid::Int),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(CandidType, serde::Serialize)]
struct FeatureFlags {
    icrc2: bool,
    icrc152: bool,
}

#[derive(CandidType, serde::Serialize)]
struct ArchiveOptions {
    num_blocks_to_archive: u64,
    max_transactions_per_response: Option<u64>,
    trigger_threshold: u64,
    max_message_size_bytes: Option<u64>,
    cycles_for_archive_creation: Option<u64>,
    node_max_memory_size_bytes: Option<u64>,
    controller_id: CandidPrincipal,
    more_controller_ids: Option<Vec<CandidPrincipal>>,
}

#[derive(CandidType, serde::Serialize)]
struct LedgerInitArgs {
    minting_account: icrc_ledger_types::icrc1::account::Account,
    fee_collector_account: Option<icrc_ledger_types::icrc1::account::Account>,
    transfer_fee: Nat,
    decimals: Option<u8>,
    max_memo_length: Option<u16>,
    token_symbol: String,
    token_name: String,
    metadata: Vec<(String, MetadataValue)>,
    initial_balances: Vec<(icrc_ledger_types::icrc1::account::Account, Nat)>,
    feature_flags: Option<FeatureFlags>,
    archive_options: ArchiveOptions,
    index_principal: Option<CandidPrincipal>,
}

#[derive(CandidType, serde::Serialize)]
enum LedgerArg {
    Init(LedgerInitArgs),
}

#[derive(CandidType, serde::Serialize)]
struct MockMinterInit {
    amount_ledger: CandidPrincipal,
    gas_ledger: Option<CandidPrincipal>,
}

/// The mock minter's `retrieve_btc_with_approval` argument — mirrors the REAL ckBTC minter's candid
/// exactly (see crates/dpay-mock-minter/src/lib.rs). Encoded here so the offramp test can sign a
/// call against the minter through the rail.
#[derive(CandidType, serde::Serialize)]
pub struct RetrieveBtcWithApprovalArgs {
    pub address: String,
    pub amount: u64,
    pub from_subaccount: Option<Vec<u8>>,
}

#[derive(CandidType, Deserialize, Debug)]
pub struct RetrieveBtcOk {
    pub block_index: Nat,
}

#[derive(CandidType, Deserialize, Debug)]
pub enum RetrieveBtcWithApprovalError {
    MalformedAddress(String),
    AlreadyProcessing,
    AmountTooLow(u64),
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TemporarilyUnavailable(String),
    GenericError { error_message: String, error_code: Nat },
}

fn install_ledger(pic: &PocketIc, minting_account: icrc_ledger_types::icrc1::account::Account) -> CandidPrincipal {
    let ledger = pic.create_canister();
    pic.add_cycles(ledger, 10_000_000_000_000);
    // icrc2 MUST be on: the offramp rail is icrc2_approve (user) + icrc2_transfer_from (minter).
    let init = LedgerArg::Init(LedgerInitArgs {
        minting_account,
        fee_collector_account: None,
        transfer_fee: Nat::from(crate::wire::LEDGER_FEE),
        decimals: Some(8),
        max_memo_length: None,
        token_symbol: "RAIL".into(),
        token_name: "Rail proof token".into(),
        metadata: vec![],
        initial_balances: vec![],
        feature_flags: Some(FeatureFlags { icrc2: true, icrc152: false }),
        archive_options: ArchiveOptions {
            num_blocks_to_archive: 10_000,
            max_transactions_per_response: None,
            trigger_threshold: 10_000_000,
            max_message_size_bytes: None,
            cycles_for_archive_creation: None,
            node_max_memory_size_bytes: None,
            controller_id: minting_account.owner,
            more_controller_ids: None,
        },
        index_principal: None,
    });
    pic.install_canister(ledger, ledger_wasm(), encode_one(&init).unwrap(), None);
    ledger
}

// ---- booted environment --------------------------------------------------------------------------

/// A private PocketIC instance + real ledger (+ optional mock minter) + the live `/api/v2` gateway.
/// Every test boots its own and tears it down on drop (`stop_live` + instance delete).
pub struct Env {
    pub pic: PocketIc,
    /// The ic-icrc1-ledger canister, as the rail addresses it (dpay-icp principal).
    pub ledger: wire::Principal,
    /// The mock ckBTC minter (offramp env only), as the rail addresses it.
    pub minter: Option<wire::Principal>,
    /// Owner of the ledger's minting account (the burn sink). Scaffolding-only identity: it is
    /// driven via the PocketIC admin API, never through the rail.
    mint_owner: CandidPrincipal,
    /// Gateway base URL, always with a trailing '/' (e.g. `http://localhost:39703/`).
    pub base: String,
    http: Client,
}

impl Env {
    /// Ledger whose minting account is a throwaway principal (plain-transfer tests): funds are
    /// seeded via the PocketIC admin API as that principal.
    pub fn ledger_only() -> Env {
        let pic = PocketIc::new();
        // Any principal works as the scaffolding mint owner — it is only ever asserted by the
        // PocketIC admin API. [9; 32] keeps it disjoint from the device keys used in tests.
        let mint_owner =
            CandidPrincipal::self_authenticating(&der_ed25519(&SigningKey::from([9u8; 32]).verifying_key().to_bytes()));
        let ledger = install_ledger(&pic, icrc_ledger_types::icrc1::account::Account {
            owner: mint_owner,
            subaccount: None,
        });
        Env::go_live(pic, ledger, None, mint_owner)
    }

    /// Ledger + mock minter wired the mainnet ckBTC way: `minting_account.owner = minter`, so the
    /// minter's default account is the burn sink and its `retrieve_btc_with_approval` burn semantics
    /// are faithful (see crates/dpay-mock-minter/src/lib.rs).
    pub fn offramp() -> Env {
        let pic = PocketIc::new();
        let minter = pic.create_canister();
        pic.add_cycles(minter, 10_000_000_000_000);
        let ledger = install_ledger(
            &pic,
            icrc_ledger_types::icrc1::account::Account { owner: minter, subaccount: None },
        );
        pic.install_canister(
            minter,
            mock_minter_wasm(),
            encode_one(&MockMinterInit { amount_ledger: ledger, gas_ledger: None }).unwrap(),
            None,
        );
        Env::go_live(pic, ledger, Some(minter), minter)
    }

    fn go_live(
        mut pic: PocketIc,
        ledger: CandidPrincipal,
        minter: Option<CandidPrincipal>,
        mint_owner: CandidPrincipal,
    ) -> Env {
        let url = pic.make_live(None);
        let mut base = url.to_string();
        if !base.ends_with('/') {
            base.push('/');
        }
        Env {
            pic,
            ledger: wire::Principal::from_text(&ledger.to_text()).unwrap_or_else(|e| panic!("ledger principal: {e}")),
            minter: minter.map(|m| wire::Principal::from_text(&m.to_text()).unwrap_or_else(|e| panic!("minter principal: {e}"))),
            mint_owner,
            base,
            http: Client::builder().timeout(std::time::Duration::from_secs(10)).build().unwrap(),
        }
    }

    /// Seed `amount` at `owner`'s default subaccount (scaffolding: PocketIC admin API as the
    /// minting-account owner — no envelope, no crypto; the rail itself is never used for minting).
    pub fn fund_default(&self, owner: &wire::Principal, amount: u64) {
        use icrc_ledger_types::icrc1::transfer::TransferArg;
        let arg = TransferArg {
            from_subaccount: None,
            to: icrc_ledger_types::icrc1::account::Account {
                owner: wire::to_candid(owner),
                subaccount: None,
            },
            amount: Nat::from(amount),
            fee: None,
            memo: None,
            created_at_time: None,
        };
        let reply = self
            .pic
            .update_call(
                wire::to_candid(&self.ledger),
                self.mint_owner,
                "icrc1_transfer",
                encode_one(&arg).unwrap(),
            )
            .expect("seed icrc1_transfer rejected");
        decode_one::<Result<Nat, icrc_ledger_types::icrc1::transfer::TransferError>>(&reply)
            .expect("seed transfer decode")
            .expect("seed transfer failed");
    }

    /// `icrc1_balance_of` via the PocketIC admin API (scaffolding read, for cross-checking the
    /// rail's own signed-query reads).
    pub fn pic_balance(&self, owner: &wire::Principal) -> u64 {
        nat_u64(&self.ledger_query(owner, None, "icrc1_balance_of"))
    }

    fn ledger_query(&self, owner: &wire::Principal, sub: Option<[u8; 32]>, method: &str) -> Vec<u8> {
        let acct = icrc_ledger_types::icrc1::account::Account {
            owner: wire::to_candid(owner),
            subaccount: sub.map(icrc_ledger_types::icrc1::account::Subaccount::from),
        };
        self.pic
            .query_call(
                wire::to_candid(&self.ledger),
                CandidPrincipal::anonymous(),
                method,
                encode_one(&acct).unwrap(),
            )
            .expect("ledger query rejected")
    }

    // ---- rail (signed-envelope transport over /api/v2) -----------------------------------------

    fn post(&self, canister: &wire::Principal, verb: &str, envelope: &[u8]) -> reqwest::blocking::Response {
        let url = format!("{}api/v2/canister/{}/{}", self.base, canister.to_text(), verb);
        self.http
            .post(&url)
            .header("Content-Type", "application/cbor")
            .body(envelope.to_vec())
            .send()
            .unwrap_or_else(|e| panic!("{verb} POST to {url} failed: {e}"))
    }

    /// Submit a signed update envelope; assert HTTP 202 (the ingress validator accepted it).
    pub fn call_ok(&self, canister: &wire::Principal, envelope: &[u8]) {
        let r = self.post(canister, "call", envelope);
        let status = r.status().as_u16();
        let body = r.text().unwrap_or_default();
        assert_eq!(status, 202, "call not accepted: {status} {body}");
    }

    /// Submit a signed update envelope; return (HTTP status, body) without asserting — for the
    /// rejection-semantics tests.
    pub fn call_raw(&self, canister: &wire::Principal, envelope: &[u8]) -> (u16, String) {
        let r = self.post(canister, "call", envelope);
        (r.status().as_u16(), r.text().unwrap_or_default())
    }

    /// Poll the certified request_status record until terminal (30 s deadline, 250 ms interval).
    pub fn wait_terminal(&self, sk: &SigningKey, canister: &wire::Principal, rid: &[u8; 32]) -> RequestStatus {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if let Some(st) = self.status(sk, canister, rid) {
                return st;
            }
            assert!(std::time::Instant::now() < deadline, "request_status did not reach a terminal state within 30s");
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }

    /// One signed read_state round-trip; `None` while the request is still in flight
    /// (received/processing/unknown). Leaf layout mirrors ic-agent's response_authentication:
    /// `status` is bare utf8, `reply` is the raw DIDL arg, `reject_code` is bare uleb128.
    fn status(&self, sk: &SigningKey, canister: &wire::Principal, rid: &[u8; 32]) -> Option<RequestStatus> {
        let envelope = wire::read_state_envelope(sk, rid);
        let r = self.post(canister, "read_state", &envelope);
        assert_eq!(r.status().as_u16(), 200, "read_state http status");
        let body = r.bytes().expect("read_state body");
        let reply: serde_cbor::Value = serde_cbor::from_slice(&body).expect("read_state reply CBOR");
        let cert_bytes = value_bytes(cbor_map_get(&reply, "certificate").expect("certificate field")).to_vec();
        let cert: ic_certification::Certificate =
            serde_cbor::from_slice(&cert_bytes).expect("certificate CBOR");
        let base: Vec<&[u8]> = vec![b"request_status", rid];
        let leaf = |label: &str| {
            match cert.tree.lookup_path(base.iter().copied().chain([label.as_bytes()])) {
                ic_certification::LookupResult::Found(l) => l.to_vec(),
                ic_certification::LookupResult::Absent => panic!("record said {label:?} but leaf is absent"),
                other => panic!("cert lookup of {label} failed: {other:?}"),
            }
        };
        // No record at all yet (routed but not visible in state) = still in flight, keep polling.
        let status_leaf = match cert.tree.lookup_path(base.iter().copied().chain(["status".as_bytes()])) {
            ic_certification::LookupResult::Found(l) => l.to_vec(),
            ic_certification::LookupResult::Absent => return None,
            other => panic!("cert lookup of status failed: {other:?}"),
        };
        match String::from_utf8(status_leaf).expect("status utf8").as_str() {
            "replied" => Some(RequestStatus::Replied { arg: leaf("reply") }),
            "rejected" => Some(RequestStatus::Rejected {
                reject_code: uleb128(&leaf("reject_code")),
                reject_message: String::from_utf8(leaf("reject_message")).expect("reject_message utf8"),
            }),
            // received/processing: still in flight
            _ => None,
        }
    }

    /// Signed query round-trip: Ok(reply DIDL arg) or Err(reject message).
    pub fn query(&self, sk: &SigningKey, canister: &wire::Principal, method: &str, arg: &[u8]) -> Result<Vec<u8>, String> {
        let envelope = wire::sign_query(sk, canister, method, arg, wire::expiry_ahead(240));
        let r = self.post(canister, "query", &envelope);
        assert_eq!(r.status().as_u16(), 200, "query http status for {method}");
        let body = r.bytes().expect("query body");
        let reply: serde_cbor::Value = serde_cbor::from_slice(&body).expect("query reply CBOR");
        match cbor_map_get(&reply, "status").and_then(value_str) {
            Some("replied") => Ok(value_bytes(
                cbor_map_get(cbor_map_get(&reply, "reply").expect("reply field"), "arg")
                    .expect("reply.arg field"),
            )
            .to_vec()),
            Some("rejected") => Err(format!(
                "{}: {}",
                cbor_map_get(&reply, "reject_code").and_then(value_u64).unwrap_or(0),
                cbor_map_get(&reply, "reject_message").and_then(value_str).unwrap_or("?")
            )),
            other => panic!("unexpected query reply status: {other:?} in {reply:?}"),
        }
    }

    /// `icrc1_balance_of(owner)` via the RAIL (signed query as `sk`'s principal).
    pub fn rail_balance(&self, sk: &SigningKey, owner: &wire::Principal) -> u64 {
        let arg = wire::balance_of_arg(&wire::account(owner));
        let reply = self
            .query(sk, &self.ledger, "icrc1_balance_of", &arg)
            .unwrap_or_else(|e| panic!("signed balance_of rejected: {e}"));
        wire::decode_int_u64(&reply)
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.pic.stop_live();
    }
}

/// DER SPKI prefix for a raw ed25519 public key (per .dev/briefs/A-envelope-signing.md).
fn der_ed25519(raw: &[u8]) -> Vec<u8> {
    const DER_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    [DER_PREFIX.as_slice(), raw].concat()
}

/// Decode a candid `nat` (already parsed) to u64 — rail amounts are sat-scale, always u64-fitting.
pub fn nat_u64_of(n: &Nat) -> u64 {
    num_traits::ToPrimitive::to_u64(&n.0).expect("nat fits u64")
}

fn nat_u64(didl: &[u8]) -> u64 {
    let n: Nat = decode_one(didl).expect("nat decode");
    nat_u64_of(&n)
}
