# Multi-Currency Implementation Plan

## Goal

Add a `currency: u8` concept throughout the stack. `DEMO_USD = 0` is play money mintable via a one-click faucet (open on mainnet for the investor demo). The merchant's request names the settlement currency; the payer copies it into their signed authorization — same as amount/payee/nonce/expiry. This is **greenfield**: wire formats can change freely, no backward compat.

## Wire format changes

| Constant | Old | New | Layout |
|----------|-----|-----|--------|
| `SIGNING_LEN` | 96 | 97 | `from(32) \| to(32) \| amount_le(8) \| nonce(16) \| expiry_le(8) \| currency(1)` |
| `WIRE_LEN` | 192 | 193 | `signing_bytes(97) \| sig(64) \| from_pub(32)` |
| `REQUEST_LEN` | 64 | 65 | `to(32) \| amount_le(8) \| nonce(16) \| expiry_le(8) \| currency(1)` |

base64url: wire 193B → 258 chars (was 256), request 65B → 87 chars (was 86).

NFC: `DEFAULT_MAX_CHUNK = 240`, both payloads still fit in one frame.

## Partial work already done

`crates/dpay-core/src/lib.rs`: `Authorization` struct already has `currency: Currency` field added, `signing_bytes()` already writes it at byte[96], `SIGNING_LEN` already 97, `WIRE_LEN` already updated. `Currency` type alias and `DEMO_USD` const already defined.

**Still broken in dpay-core**: `from_wire()` doesn't read currency, `PaymentRequest` has no currency field, `to_authorization()` doesn't set currency, all tests construct structs without currency, base64 length assertions are wrong.

## Layer-by-layer changes

### Layer 1: dpay-core (`crates/dpay-core/src/lib.rs`)

1. **`from_wire()`**: read `currency` at byte[96] of signing region → into Authorization.
2. **`PaymentRequest`**: add `currency: Currency` field.
   - `to_bytes()`: append currency at byte[64].
   - `from_bytes()`: read currency at byte[64].
3. **`to_authorization(from)`**: copy `self.currency` into Authorization.
4. **Update all proptests**: every `Authorization { ... }` and `PaymentRequest { ... }` construction needs the `currency` field. Add `currency: DEMO_USD` (or `any::<u8>()` in proptest strategies). Update base64 length assertions: wire 256→258, request 86→87.
5. **NFC comments**: update `crates/dpay-core/src/nfc.rs` line 4 ("192-byte" → "193-byte") and line 57 ("64 B request, 192 B wire" → "65 B request, 193 B wire"). No logic change needed — NFC uses `WIRE_LEN`/`REQUEST_LEN` constants which auto-propagate.

**Verify**: `cargo nextest run -p dpay-core --features rng` (or `cargo test -p dpay-core --features rng`).

### Layer 2: dpay-canister (`crates/dpay-canister/src/lib.rs`)

1. **BALANCES key**: `StableBTreeMap<PubKey, u64>` → `StableBTreeMap<(PubKey, u8), u64>`. Need `Storable` impl for `(PubKey, u8)` = 33 bytes. Or use a `BalanceKey` struct wrapping `[u8;33]`.
2. **`pay(signed: Vec<u8>)`**: decode wire (gets currency from auth), use `(*from, currency)` and `(*to, currency)` for balance lookups/updates.
3. **`mint(to: PubKey, currency: u8, amount: u64) -> u64`**: credit `(*to, currency)`.
4. **`balance_of(pubkey: PubKey, currency: u8) -> u64`**: read `(*pubkey, currency)`.
5. **`InitArg`**: pre-fund accounts in DEMO_USD currency. Keep the same `{account_a, balance_a, account_b, balance_b, per_tx_cap}` shape (all DEMO_USD).
6. **`export_candid!()`**: will auto-update from the struct/query signatures.
7. **Update `dfx/dpay_canister.did`** (extracted candid) if it's checked in.

**Verify**: `cargo nextest run -p dpay-canister-tests` (PocketIC tests).

**Tests to update** (`crates/dpay-canister-tests/tests/pay.rs`):
- All `mint()` calls need `currency` arg.
- All `balance_of()` calls need `currency` arg.
- `mint_only_by_controller` test → rename to `mint_open_to_anyone`, assert open mint works (controller gate already removed from canister).
- Happy path / nonce / expiry / cap / insufficient tests: add currency param.

### Layer 3: dpay-relay (`crates/dpay-relay/src/`)

1. **`Ledger` trait** (`ledger.rs`):
   - `balance(&self, pubkey: [u8;32], currency: u8) -> u64`
   - `mint(&self, to: [u8;32], currency: u8, amount: u64) -> u64`
   - `pay` stays the same (wire carries currency internally).
2. **`FakeLedger`**: `HashMap<[u8;32], u64>` → `HashMap<([u8;32], u8), u64>`.
3. **`AgentLedger`**: `mint()` call signature changes to include `currency`. `balance()` call includes `currency`.
4. **API** (`app.rs`):
   - `GET /api/v1/balance/:hex?currency=0` → `{balance}` (default currency=0).
   - `POST /api/v1/faucet {account, currency, amount?}` → mint.
   - `POST /api/v1/pay` stays the same.
5. **Tests**: update all `balance()`/`mint()` calls with currency param.

**Verify**: `cargo nextest run -p dpay-relay` (fast in-memory tests).

### Layer 4: dpay-ffi (`crates/dpay-ffi/`)

1. **`src/lib.rs`** (or `.udl`): expose `currency: u8` param in `sign_authorization`, `encode_request`, `decode_request`. Add `DEMO_USD` constant.
2. **Python roundtrip test** (`tests/roundtrip.py`): add currency to all calls.

**Verify**: `just ffi` (runs UniFFI generate + Python roundtrip).

### Layer 5: dpay-sim + dpay-fixture

1. **dpay-sim**: construct `Authorization`/`PaymentRequest` with `currency: DEMO_USD`. Update any wire-length assertions.
2. **dpay-fixture**: init args unchanged (all DEMO_USD).

**Verify**: `cargo build -p dpay-sim -p dpay-fixture`.

### Layer 6: RN App (`app/App.tsx` + native)

1. **`DpayCore` native module**: add `currency` param to `signAuthorization` and `encodeRequest` (Kotlin + UniFFI binding).
2. **App.tsx**: pass `currency: 0` (DEMO_USD) in all sign/encode calls. Top-up button mints DEMO_USD. Show "DEMO $" label.
3. **`DpayNfc`**: add currency to `buildRequest`.

**Verify**: `just app` or at minimum confirm it compiles.

## Execution order (dependency chain)

```
Layer 1 (core) ──────┬──► Layer 2 (canister) ──► Layer 5 (sim+fixture)
                     ├──► Layer 3 (relay) ──────► Layer 6 (app)
                     └──► Layer 4 (ffi) ────────► Layer 6 (app)
```

Layer 1 must complete first. Then 2/3/4 can proceed (but serialize to avoid cargo target/ conflicts). Then 5. Then 6.

## Final verification

`just verify` — runs core + canister + relay + UI goldens.
