# Wire-format evolution: display names + memo (N6/H3 closure)

Date: 2026-07-31. Status: APPROVED (foundamer decision). Authoritative spec for the change.

## Why

N6/H3: the payee sees a raw `from` pubkey in transaction history because the payer's display
name is carried **nowhere** on the wire. The payee name rides an out-of-band `|name` QR suffix
(format.ts:19), unauthenticated and outside the single-source-of-truth bytes. While the wire is
still free (greenfield, single deployment), fold **both display names + a memo** into the signed
bytes so history is self-describing on both sides and the `|name` hack is deleted.

## Decisions (locked)

- **Encoding:** fixed-width 32 B per field, UTF-8, trailing-NUL padded, truncate to 32 B.
  `Authorization` stays `Copy` + fixed array; canister `TxnRecord` stays fixed-size `Storable`.
- **Fields:** `from_name` (payer's own), `to_name` (merchant's, was QR suffix), `memo`
  (merchant-set, optional). All three inside `Authorization::signing_bytes` → authenticated.
- **`PaymentRequest`** gains `to_name` + `memo` (merchant-defined; payer copies them into the auth
  verbatim, like `amount`). `from_name` is NOT in the request (payer supplies own). This deletes
  the `|name` QR-suffix hack — name now lives in the request bytes (single source of truth).
- **`ReceiptClaim`:** UNCHANGED (outcome-only; names live in auth + history, not the receipt).
- **`WithdrawAuth`:** UNCHANGED. **Unsigned 17 B `Receipt`:** UNCHANGED (NFC transport).
- **No version byte** (antithetical to the freeze; greenfield single deployment).

## Exact new layouts (FROZEN after this change)

### `Authorization::signing_bytes` → `[u8; 196]` (was 100)
```
from(32)       [0..32]
to(32)         [32..64]
amount_le(8)   [64..72]
nonce(16)      [72..88]
expiry_le(8)   [88..96]
currency_le(4) [96..100]
from_name(32)  [100..132]
to_name(32)    [132..164]
memo(32)       [164..196]
```
`SIGNING_LEN = 196`. New consts `NAME_LEN = 32`, `MEMO_LEN = 32`.

### `SignedAuthorization` wire → `[u8; 292]` (was 196)
```
signing_bytes(196)  [0..196]
sig(64)             [196..260]
from_pub(32)        [260..292]
```
`WIRE_LEN = 292` (base64url ≈ 389 chars; QR-fine). NFC: 292 > DEFAULT_MAX_CHUNK(240) → **2 frames**.

### `PaymentRequest::to_bytes` → `[u8; 132]` (was 68)
```
to(32)         [0..32]
amount_le(8)   [32..40]
nonce(16)      [40..56]
expiry_le(8)   [56..64]
currency_le(4) [64..68]
to_name(32)    [68..100]
memo(32)       [100..132]
```
`REQUEST_LEN = 132` (base64url ≈ 176 chars). NFC: 132 < 240 → 1 frame.

## Cascade (single source of truth = core consts; propagate by name)

| Layer | File(s) | Change |
|---|---|---|
| **core** | `crates/dpay-core/src/lib.rs` | consts; `Authorization{+from_name,+to_name,+memo}`; `signing_bytes`→196; `PaymentRequest{+to_name,+memo}`; `to_bytes/from_bytes`→132; `to_authorization(from, from_name)` copies to_name+memo; `SignedAuthorization::to_wire/from_wire` offsets→292; update doc comments + frozen-layout comments; tests (wire len 262→389-ish b64, roundtrips, tamper covers new fields). |
| **core NFC** | `crates/dpay-core/src/nfc.rs` | offsets auto-propagate via consts. **ADD a multi-frame NFC round-trip test** (292 B wire is the first payload > 240 → spans 2 frames; chunking is built but only single-frame payloads existed). Update the doc comment at L57 (wire now 2 frames). |
| **fixture** | `crates/dpay-fixture/src/main.rs` | `pay` section: add from_name/to_name/memo field specs + offsets + golden values (deterministic ASCII, e.g. `"Alice"`/`"Bob"`/`"dinner"` NUL-padded); recompute golden signing_hex (calls core → auto). `request` section: add to_name/memo. Regenerate `dfx/wire_layout.json`. Round-trip test. |
| **canister** | `crates/dpay-canister/src/lib.rs` | `TxnRecord{+from_name,+to_name,+memo}` (fixed 32 each) → `TXN_RECORD_LEN` 100→196; update `Storable` (to_bytes/from_bytes offsets); `pay()` extracts names from the decoded `Authorization` and stores them; `TxnView{+from_name,+to_name,+memo}` (candid, as `String` — decode NUL-padded); `transactions_of` returns them; update the stale "frozen 196-byte INPUT" comment (input IS touched now). Regenerate `.did` if present. |
| **relay** | `crates/dpay-relay/src/{lib,ledger}.rs` | `TxnRecord{+from_name,+to_name,+memo}` (serde, hex or String); `FakeLedger::pay` parses new wire + stores names; `Ledger::transactions_of` returns names; `/history` JSON carries names. |
| **TS shim** | `e2e/web/dpay-core.ts` | mirror new signing(196)+wire(292)+request(132) layouts exactly (this is what `00-cross-val` proves against the golden). Add NUL-pad/trim name+memo helpers. |
| **app** | `app/lib/format.ts` | **delete** `parseRequestQR` `|name` split (name now in bytes); request QR = plain base64url. Add name/memo encode+trim helpers. |
| **app** | `app/components/ReceiveMode.tsx` | build `PaymentRequest` with `to_name` = own username + optional `memo`; request QR no longer appends `|name`. |
| **app** | `app/components/PayMode.tsx` | build `Authorization` with `from_name` = own username + copied `to_name`/`memo`; show `to_name` + memo at review; confirmation uses `to_name`. |
| **app** | `app/components/Wallet.tsx` | history rows render `from_name`/`to_name` from `transactions_of` (closes N6/H3 — no more raw hex counterparties). |
| **e2e harness** | `e2e/harness/wire.mjs` | request/sign builders mirror new 132/196/292 layouts (read offsets from wire_layout.json). |
| **e2e** | `e2e/tests/00-cross-val.mjs` | update pay + request assertions (new offsets/lengths; verify names in signing bytes). |
| **e2e** | `e2e/tests/*` | any test building a request QR / signing updates; fixtures may use real names. |
| **e2e** | NEW `e2e/tests/26-names-memo.mjs` | end-to-end: payer "Alice" pays payee "Bob" with memo "coffee"; assert Bob's history shows "from Alice" + memo, Alice's shows "to Bob" (no raw hex). Closes N6/H3. |
| **docs** | `CODEBASE_ANALYSIS.md`, `OPEN_ISSUES.md`, `FLOWS.md` | wire-format section; N6+H3 → RESOLVED; new flow 26. |

## Order + gates (dependency-strict; no parallel drift across layers)

1. **Wave 1 (sequential, one subagent): core + fixture.** New consts/structs/layouts/tests +
   multi-frame NFC test + regenerate `wire_layout.json`. Gates: `just test-core` + `cargo test -p
   dpay-fixture`. **Commit.** This is the source of truth; everything downstream reads the new
   golden offsets.
2. **Verify the golden** (me): inspect `dfx/wire_layout.json` pay+request sections match the offsets
   above.
3. **Wave 2 (parallel, 2 subagents): canister + relay.** Both depend only on core. Gates:
   `just test-canister`, `just test-relay` (+ test-helpers). **Commit each.**
4. **Wave 3 (sequential, one subagent): TS shim + app + harness + e2e + new flow 26.** Depends on
   the stable golden. Gate: `just e2e` (25→26 flows green) + `cd app && npx tsc --noEmit` + jest.
   **Commit.**
5. **Wave 4 (one subagent): docs.** Commit.
6. **Final:** `just verify` GREEN; working tree clean.

## Rules honored
- Single source of truth = core consts; every layer reads offsets from `wire_layout.json` or the
  core by name. No magic numbers.
- TDD: the cross-val golden is the cross-layer contract; flow 26 proves the user-visible N6/H3 fix.
- No backward compat (greenfield): old 100/196/68 layouts are gone everywhere in one change.
- No silent errors: NUL-pad/trim + length checks return `Err` on overflow, not truncate silently in
  prod (the 32 B cap is enforced at the builder).
