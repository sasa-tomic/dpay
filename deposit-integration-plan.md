# ck-Canister Deposit / Top-Up Integration — build plan

Seamless **ckBTC-style** funding for dpay: app → deposit address → instructions → live
status/progress → credited balance. The facade **proxies the ck minter**; the mint lands exactly
where the facade's `icrc1_balance_of` already reads (`Account{owner: facade, subaccount: pubkey}`),
so `balance_of` / `pay` / history need **no change**. This is purely a new informational +
orchestration surface on top of the existing facade.

> Scope: the **ckBTC deposit model** (`get_btc_address` / `update_balance`). ckETH/ckERC20 share the
> facade proxy seam but use different minter methods — documented follow-up, out of scope here.
> Non-negotiables hold: non-custodial, no swaps, no exchange creds, facade never becomes a
> counterparty, holds no omnibus.

---

## 0. Design decision (locked)

- The **facade** owns the `owner = canister_self()` account relationship, so it calls the minter with
  `owner = Some(self)`, `subaccount = Some(pubkey)`. The minted ckBTC lands on the ckBTC ledger at the
  facade's subaccount = the user's pubkey — identical to where `pay`/`balance_of` already operate.
- The minter methods are permissionless (GeneralAvailability on mainnet); the facade proxy endpoints
  need **no payer auth** (a deposit address is not secret — revealing it only lets someone send *to*
  the user). `refresh_deposit` is value-creating (triggers the mint) but is idempotent and safe to
  call by anyone (a no-op when no confirmed UTXOs exist).
- **Error rule:** all three deposit-proxy endpoints map any facade `Err(String)` →
  `LedgerError::Transient` (→ HTTP 503). They have **no permanent-policy failure** (no sig, no cap,
  no replay). The only "config" failure ("no minter registered for currency") is a deploy-time
  invariant and also surfaces as 503 (acceptable; documented).
- **Offline proof:** a tiny **mock minter** canister implements the ckBTC minter's 5 methods and
  mints onto a REAL `ic-icrc1-ledger` in PocketIC, proving deposit_address → deposit → mint →
  balance end-to-end, fully offline.

---

## 1. Canister side — `crates/dpay-canister/src/lib.rs` (+ `dfx/dpay_canister.did`)

### 1.1 New stable map `MINTERS` (MemoryId 8)

A currency MAY have a ck minter (only ck currencies). Separate map so the existing
`LedgerEntry{principal, mintable}` stable encoding (1+29 bytes, MemoryId 5) is **untouched** — no
upgrade-layout churn.

```rust
// in thread_local! { ... }  — after BAL_CACHE
/// currency -> its ck-minter principal. MemoryId 8 (new facade state). A currency has a minter only
/// if it is a ck currency (ckBTC/ckETH/...). Absent => the facade has no deposit path for it.
static MINTERS: RefCell<StableBTreeMap<Currency, Principal, Memory>> =
    RefCell::new(StableBTreeMap::init(MEMORY.with(|m| m.borrow().get(MemoryId::new(8)))));
```
`Currency` (= `u32`) and `Principal` are already `Storable` (StableBTreeMap requires `Ord` on the key;
`u32` is `Ord`). Confirm `Principal: Storable` is used elsewhere — it is not directly, so add a small
`PrincipalStorable` wrapper OR store the principal's bytes. **Use the same approach the codebase
already uses** (`ControllerStorable` at lib.rs:156): a 1-byte-present + ≤29 principal bytes struct is
overkill for a non-Option; store raw `Principal` via `Storable` impl that delegates to
`to_vec`/`from_slice` (bounded max 29). Add a `PrincipalStorable(Principal)` newtype with
`BOUND = Bounded{29, is_fixed_size:false}`.

```rust
fn minter_for(currency: Currency) -> Result<Principal, String> {
    MINTERS.with(|m| m.borrow().get(&currency))
        .ok_or_else(|| format!("currency {currency} has no ck minter"))
}
```

### 1.2 New candid types (minter-agnostic, normalized for the app)

```rust
#[derive(CandidType, Deserialize, Clone, Debug)]
struct DepositInfo {
    min_confirmations: u32,
    deposit_fee: u64,            // get_deposit_fee (sats)
    deposit_min_amount: Option<u64>, // get_minter_info.deposit_btc_min_amount
}

#[derive(CandidType, Deserialize, Clone, Debug)]
struct MintedUtxo { block_index: Nat, amount: u64 }

#[derive(CandidType, Deserialize, Clone, Debug)]
struct PendingUtxo { value: u64, confirmations: u64 }

#[derive(CandidType, Deserialize, Clone, Debug)]
struct DepositRefresh {
    minted: Vec<MintedUtxo>,       // UTXOs minted by THIS update_balance call
    minted_total: u64,             // sum of minted amounts
    pending: Vec<PendingUtxo>,     // awaiting confirmations (from NoNewUtxos)
    required_confirmations: u32,   // threshold (from NoNewUtxos / minter info)
}
```

### 1.3 Minter candid mirrors (for decoding the real ckBTC minter replies)

Decode the minter's exact variant types. Use `candid::Reserved` for sub-records we don't surface
(`utxo`, `NoNewUtxos` inner) — candid subtype matching lets Reserved absorb any value.

```rust
use candid::Reserved;
#[derive(CandidType, Deserialize)]
enum UtxoStatus {
    Minted { block_index: Nat, minted_amount: Nat, utxo: Reserved },
    Checked(Reserved),
    ValueTooSmall(Reserved),
    Tainted(Reserved),
}
#[derive(CandidType, Deserialize)]
enum UpdateBalanceError {
    NoNewUtxos {
        current_confirmations: Option<u64>,
        required_confirmations: u32,
        pending_utxos: Option<Vec<PendingUtxoMirror>>,
        suspended_utxos: Option<Reserved>,
    },
    AlreadyProcessing,
    TemporarilyUnavailable(String),
    GenericError { error_code: Option<Nat>, error_message: String },
}
#[derive(CandidType, Deserialize)]
struct PendingUtxoMirror { outpoint: Reserved, value: Nat, confirmations: Option<u64> }
#[derive(CandidType, Deserialize)]
struct MinterInfo {
    min_confirmations: u32,
    retrieve_btc_min_amount: u64,
    kyt_fee: u64,
    deposit_btc_min_amount: Option<u64>,
}
```
> If the real minter's exact field names/types diverge at mainnet time, adjust these mirrors to be
> candid *subtypes* (drop fields / use `Option`/`Reserved`). Subtype decode is robust to extra fields.

### 1.4 New endpoints (all `#[update]` — they `await` cross-canister calls)

The minter args are `(opt principal, opt blob)`: `owner = Some(canister_self())`,
`subaccount = Some(pubkey.to_vec())`.

```rust
/// (blob pubkey, nat32 currency) -> Result<text, text>. Proxies minter `get_btc_address`.
#[update]
async fn deposit_address(pubkey: Vec<u8>, currency: Currency) -> Result<String, String> { ... }

/// (blob pubkey, nat32 currency) -> Result<DepositRefresh, text>. Proxies minter `update_balance`
/// (the value-creating call that mints after confirmations). NoNewUtxos -> Ok(refresh with pending).
#[update]
async fn refresh_deposit(pubkey: Vec<u8>, currency: Currency) -> Result<DepositRefresh, String> { ... }

/// (nat32 currency) -> Result<DepositInfo, text>. Proxies minter `get_minter_info` + `get_deposit_fee`.
#[update]
async fn deposit_info(currency: Currency) -> Result<DepositInfo, String> { ... }

/// (nat32 currency, principal) -> Result<(), text>. Register the ck minter for a currency. require_admin.
#[update]
fn register_minter(currency: Currency, minter: Principal) -> Result<(), String> {
    require_admin()?;
    MINTERS.with(|m| m.borrow_mut().insert(currency, minter));
    Ok(())
}
```

Cross-canister call helper (mirror `ledger_balance_of` at lib.rs:482):

```rust
async fn minter_call_btc_address(minter: Principal, sub: Vec<u8>) -> Result<String, String> {
    let arg = (Some(canister_self()), Some(sub));
    let r = Call::bounded_wait(minter, "get_btc_address").with_arg(arg).await
        .map_err(|e| format!("get_btc_address rejected: {e:?}"))?;
    let addr: String = r.candid().map_err(|e| format!("get_btc_address decode: {e:?}"))?;
    Ok(addr)
}
// similarly: minter_call_update_balance -> Result<Vec<UtxoStatus>, UpdateBalanceError>
//            minter_call_minter_info -> MinterInfo ; minter_call_deposit_fee -> u64
```
`update_balance` returns `Result<Vec<UtxoStatus>, UpdateBalanceError>` — decode with
`response.candid::<Result<Vec<UtxoStatus>, UpdateBalanceError>>()`.

`refresh_deposit` body maps the minter reply → `DepositRefresh`:
- `Ok(statuses)`: `minted` = each `Minted{block_index, minted_amount→u64}`; `minted_total` = sum;
  `pending = []`; `required_confirmations` = 0 (we just minted; nothing pending-relevant).
- `Err(NoNewUtxos{required_confirmations, pending_utxos, ..})`: `minted=[]`, `minted_total=0`,
  `pending` = mapped `(value, confirmations.unwrap_or(0))`, `required_confirmations` from the error.
- `Err(AlreadyProcessing | TemporarilyUnavailable | GenericError)` → `Err(String)` (→ relay Transient).

### 1.5 `.did` — hand-maintain `dfx/dpay_canister.did`

Add the new types + service methods (the existing `.did` is hand-written with comments; match style).
`export_candid!()` at lib.rs:893 auto-derives the types from the Rust structs — the checked-in `.did`
must be regenerated/edited to match. New service entries:
```
register_minter : (nat32, principal) -> (Result_3) query_or_update;  // update
deposit_address : (blob, nat32) -> (Result_5);        // Result_5 = variant { Ok: text; Err: text }
refresh_deposit : (blob, nat32) -> (Result_6);        // Result_6 = variant { Ok: DepositRefresh; Err: text }
deposit_info    : (nat32) -> (Result_7);              // Result_7 = variant { Ok: DepositInfo; Err: text }
```

### 1.6 Canister verification
`cargo build -p dpay-canister --target wasm32-unknown-unknown --release` (== `just build-canister`)
must compile. The deposit logic is exercised end-to-end by the canister-tests (Wave C).

---

## 2. Mock-minter canister — NEW `crates/dpay-mock-minter/`

A tiny `cdylib` that implements the 5 ckBTC-minter methods, minting onto a REAL ICRC ledger so the
full flow is provable offline in PocketIC. NOT shipped to mainnet (the real ckBTC minter is used
there) — test/build artifact only.

### 2.1 Cargo.toml
```toml
[package]
name = "dpay-mock-minter"
version.workspace = true
edition.workspace = true
license.workspace = true
description = "Test-only mock of the ckBTC minter: derives a deposit address and mints onto a real ICRC ledger. For offline PocketIC proofs."

[lib]
crate-type = ["cdylib"]

[dependencies]
ic-cdk = { workspace = true }
candid = { workspace = true }
serde = { version = "1", features = ["derive"] }
icrc-ledger-types = { workspace = true }
num-traits = "0.2"
```
Add `"crates/dpay-mock-minter"` to workspace `members` (NOT `default-members` — it's a cdylib, like
dpay-canister).

### 2.2 `src/lib.rs`
```rust
//! Mock ckBTC minter. init(ledger, minting_owner). Owns the ledger's minting account so it can mint.
//! get_btc_address -> deterministic fake bech32-ish text from hash(owner||subaccount).
//! register_deposit(owner, subaccount, amount) [test-only update] -> seeds a pending deposit.
//! update_balance -> for each pending deposit, icrc1_transfer from minting account to
//!   Account{owner, subaccount}, return [Minted{block_index, minted_amount}], clear pending.
//!   No pending -> Err(NoNewUtxos{required_confirmations:0, ...}).
//! get_minter_info -> MinterInfo{min_confirmations:1, deposit_btc_min_amount:Some(0), ...}.
//! get_deposit_fee -> 0.  get_known_utxos -> [].
```
State (thread_local + ic-stable-structures OR plain `RefCell<HashMap>` — stable not needed for a
test canister, but use stable-structures to mirror real canister style; either is fine). Use a simple
`std::cell::RefCell<HashMap<(Principal,Vec<u8>), u64>>` for pending deposits.

`update_balance` cross-canister `icrc1_transfer` mirrors the facade's `ledger_transfer`
(`Call::bounded_wait(ledger, "icrc1_transfer").with_arg(TransferArg{from_subaccount:None, to,
amount, fee:None, created_at_time:Some(time()), memo:None})`). The mock minter IS the ledger's
minting-account owner, so `from_subaccount: None` (minting account default subaccount) is authorized.

### 2.3 justfile — new build step
```makefile
build-mock-minter:
    cargo build -p dpay-mock-minter --target wasm32-unknown-unknown --release
```
`test-canister` recipe prepends `build-mock-minter` and exports
`DPAY_MOCK_MINTER_WASM := root/"target/wasm32-unknown-unknown/release/dpay_mock_minter.wasm"`.

---

## 3. Relay — `crates/dpay-relay/src/{ledger,app,agent_ledger,lib}.rs`

### 3.1 `ledger.rs` — trait + types + FakeLedger + FlakyLedger
Add serde structs mirroring the canister types:
```rust
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MintedUtxo { pub block_index: String, pub amount: u64 }   // block_index as nat -> string
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PendingUtxo { pub value: u64, pub confirmations: u64 }
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositRefresh {
    pub minted: Vec<MintedUtxo>, pub minted_total: u64,
    pub pending: Vec<PendingUtxo>, pub required_confirmations: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DepositInfo {
    pub min_confirmations: u32, pub deposit_fee: u64, pub deposit_min_amount: Option<u64>,
}
```
Add 3 methods to `trait Ledger`:
```rust
async fn deposit_address(&self, pubkey: [u8;PUBKEY_LEN], currency: Currency) -> Result<String, LedgerError>;
async fn deposit_status(&self, pubkey: [u8;PUBKEY_LEN], currency: Currency) -> Result<DepositRefresh, LedgerError>;
async fn deposit_info(&self, currency: Currency) -> Result<DepositInfo, LedgerError>;
```
- **FakeLedger:** add `pending_deposits: HashMap<([u8;PUBKEY_LEN], Currency), u64>` to `FakeState`.
  - `deposit_address` → deterministic fake: `format!("bc1qdpay{}", hex::encode(&pubkey[..8]))`.
  - `deposit_info` → `DepositInfo{min_confirmations:1, deposit_fee:0, deposit_min_amount:Some(0)}`.
  - `deposit_status` → drain pending: for the amount, credit via the existing balances map (mirror a
    mint), return `DepositRefresh{minted:[MintedUtxo{block_index:"0", amount}], minted_total:amount,
    pending:[], required_confirmations:1}`. No pending → `minted=[]`, `minted_total=0`, `pending:[]`.
  - new **pub** test hook `register_deposit(&self, pubkey, currency, amount)` seeds pending.
  `FlakyLedger` delegates all 3 to `inner`.
- **`minted.block_index` as String:** `Nat`/`u128` don't round-trip in JSON safely; serialize as
  string (matches how the canister's `Nat` block index is represented over HTTP).

### 3.2 `agent_ledger.rs` — proxy the new facade endpoints (feature `agent`)
Mirror the canister reply types (`DepositInfoMirror`, `DepositRefreshMirror` with `block_index: Nat`).
- `deposit_address` → `update("deposit_address")` with `encode_args((pubkey.to_vec(), currency))`,
  decode `Result<String,String>` → Ok/`Err→Transient`.
- `deposit_status` → `update("refresh_deposit")`, decode `Result<DepositRefreshMirror,String>`,
  map `block_index: Nat` → string. `Err→Transient`.
- `deposit_info` → `update("deposit_info")` with `encode_args((currency,))`, decode
  `Result<DepositInfoMirror,String>`. `Err→Transient`.

### 3.3 `app.rs` — 3 new REST routes
```
GET  /api/v1/deposit/address/{hex}?currency=N  -> 200 {address} | 503
POST /api/v1/deposit/refresh/{hex}?currency=N  -> 200 {minted_total, minted:[], pending:[], required_confirmations} | 503
GET  /api/v1/deposit/info?currency=N           -> 200 {min_confirmations, deposit_fee, deposit_min_amount} | 503
```
Wire into the `api` Router (app.rs:107). All deposit-proxy `LedgerError::Transient` → 503 (no 422 path —
see §0 error rule). Reuse the existing `err(StatusCode, msg)` helper. New body structs
`DepositAddressBody{address}`, `DepositRefreshBody{...}`, `DepositInfoBody{...}`. Path/query parsing
mirrors `balance` (app.rs:180) — 32-byte hex pubkey + optional `currency` (default DEMO_USD).

### 3.4 Relay verification
`just test-relay` (FakeLedger, offline) must pass incl. new deposit unit tests (address determinism,
deposit_status credits + drains, register_deposit hook). `just test-live` (agent feature) proves the
real facade path after the canister is built.

---

## 4. App — `app/App.tsx` (+ relay client helper)

Replace the single demo `topUp` (POST /faucet) with a **Deposit sheet** for ck currencies, keeping
the DEMO_USD faucet button for play money.

- New relay client helpers: `depositAddress(hex,currency)`, `depositRefresh(hex,currency)`,
  `depositInfo(currency)` hitting the 3 new routes.
- Wallet screen: a "Top Up" affordance (`btn-topup` stays for demo $; add a `btn-deposit` /
  currency toggle "Demo $" | "ckBTC"). Opening ckBTC shows the **Deposit sheet**:
  1. `GET deposit/info` → instructions ("Send BTC to this address · ~N confirmations · min X sats").
  2. `GET deposit/address` → the address (render a QR via the existing `DpayCore.encodeQr` / `QrBox`,
     + Copy button). QR payload = the bare address string.
  3. While open: `POST deposit/refresh` every ~10 s. `minted_total > 0` → "Deposited ✓" toast; the
     existing 2.5 s balance poll then reflects the new ckBTC balance.
- Add a `DEPOSIT_CURRENCY` constant (default `1`) + a `btc(sats)` formatter (8 decimals) for the
  ckBTC balance/amounts, parallel to `usd(cents)`. Currency is passed as `number` everywhere (existing
  convention).
- Keep changes **additive** so existing golden shots stay valid; if `just ui` needs a new shot for
  the deposit sheet, add it + its golden. Do NOT break the existing Pay/Receive/NFC flows.

### App verification
`just ui` (headless react-native-web + screenshots) must be green. RN runtime correctness is the
outer-loop device gate (out of the offline inner loop).

---

## 5. Docs (LIVING — required by AGENTS.md)

- **`CODEBASE_ANALYSIS.md`:** add the new `MINTERS` (MemoryId 8) surface + the 4 deposit endpoints to
  the architecture map; note the new risk surface (deposit proxy is unauthenticated — acceptable, see
  §0) and that `refresh_deposit` is value-creating but idempotent. Strike/refresh any funding-risk
  note now resolved by having a concrete deposit path.
- **`FUNDING.md`:** replace the "shape recorded" placeholder with the implemented facade-proxy model
  + mainnet canister IDs (ckBTC minter `mqygn-kiaaa-aaaar-qaadq-cai`, ledger
  `mxzaz-hqaaa-aaaar-qaada-cai`). NOTE: ckBTC mainnet minting needs **no KYC** — the minter runs in
  GeneralAvailability mode with no KYC checker (only automatic KYT screening of tainted UTXOs).
- **`dfx/dpay_canister.did`:** the hand-maintained candid (§1.5).

---

## 6. Workstream / wave plan (for the orchestration swarm)

Files are disjoint across waves; each task works against THIS contract (no cross-task coordination).

**Wave A (parallel, disjoint files):**
- **A1 Canister** — `crates/dpay-canister/src/lib.rs` + `dfx/dpay_canister.did`. Verify: `just build-canister`.
- **A2 Relay** — `crates/dpay-relay/src/{ledger,app,agent_ledger}.rs` (+ unit tests). Verify: `just test-relay`.
- **A3 App** — `app/App.tsx` (+ relay helper). Verify: `just ui`.

**Wave B (after A; parallel):**
- **B1 Mock minter** — NEW `crates/dpay-mock-minter/` + workspace `Cargo.toml` members. Verify: `just build-mock-minter`.
- **B2 Docs** — `CODEBASE_ANALYSIS.md`, `FUNDING.md`. (No code verify; review.)

**Wave C (after A1 + B1):**
- **C1 Canister-tests** — NEW `crates/dpay-canister-tests/tests/deposit.rs` + its `Cargo.toml` (no
  new deps likely) + justfile `test-canister` (add `build-mock-minter`, export
  `DPAY_MOCK_MINTER_WASM`). Verify: `just test-canister`.

**Verification swarm (after C):** `just check` (core+canister+relay) + `just test-live` (agent
integration) + `just ui`; iterate to all-green. Update `CODEBASE_ANALYSIS.md` per AGENTS.md.

---

## 7. Mainnet ckBTC canister IDs (for FUNDING.md / deploy)
- ckBTC minter: `mqygn-kiaaa-aaaar-qaadq-cai`
- ckBTC ledger: `mxzaz-hqaaa-aaaar-qaada-cai`
- ckETH minter: `sv3dd-oaaaa-aaaar-qacoq-cai` (follow-up)
- ckETH ledger: `ss2fx-dyaaa-aaaar-qacoq-cai` (follow-up)
- ckUSDC ledger: `xevnm-gaaaa-aaaar-qafnq-cai` (follow-up)
- Reference: `docs.internetcomputer.org/references/chain-key-canister-ids/`
- ckBTC minting needs **no KYC/allowlist** on mainnet — the minter runs in GeneralAvailability mode
  with no KYC checker (only automatic KYT that screens tainted UTXOs, not principals). Any clean,
  confirmed deposit mints; the facade's own `get_btc_address`/`update_balance` calls were proven LIVE.
