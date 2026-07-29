# dpay codebase analysis

> **Living document.** This is a structural analysis of the dpay codebase — architecture health, where the design earns its keep, and risks to flag before a coding session. It is maintained alongside the code: when a change materially affects anything stated here (a risk resolved, a new surface added, an invariant changed), update this file in the same change.
>
> Last reviewed: see `git log` for this file. Scope: everything under the workspace (`dpay-core`, `dpay-canister`, `dpay-canister-tests`, `dpay-relay`, `dpay-ffi`, `dpay-sim`, `dpay-fixture`, `ui/`, `app/`).

## Architecture health: strong

The single most load-bearing decision — **one Rust core shared by every consumer** — is actually enforced everywhere:

- `dpay-core` (`lib.rs` 454 lines + `nfc.rs` 1663 lines) is the source of truth for signing, validation, codec, and NFC framing. The canister, relay, sim, fixture, and FFI all import it; the app reaches it via UniFFI → `libdpay_ffi.so`. There is no parallel JS/Kotlin reimplementation of money logic.
- Money-critical JS (`app/src/payments.ts`) is intentionally pure + jest-tested and stays on outcome classification (settled/rejected/unknown), never on signature math. Correct separation.

The wire format is frozen and byte-precise (`SIGNING_LEN=100`, `WIRE_LEN=196`, `REQUEST_LEN=68`), and `validate()` is pure/allocation-free — exactly what a canister hot path wants. Field order is documented as FROZEN, which is the right discipline for a protocol surface.

## The canister is a FACADE over external ICRC ledgers (not the ledger)

`dpay-canister` (`ssqti`) holds **no balances**. It is a pure facade with three jobs plus the offline-payer authorization gate:

1. **index** — a registry `currency(u32) -> {ledger principal, mintable}` (`LEDGERS`, stable), populated at init and extendable via `register_ledger`.
2. **routing** — `pay()` resolves the wire's `currency` to its ledger and settles there via the uniform ICRC interface (`icrc1_transfer` / `icrc1_balance_of` / `icrc1_fee`).
3. **cache** — a display-only `BAL_CACHE` backs the fast `balance_of` *query*.

PLUS the **authorization gate** (Ed25519 sig verify + nonce replay protection + expiry/cap), which stays *in the facade* — that is the offline-payer value-add, not ledger logic. Every currency = one real ICRC ledger canister (the DFINITY `ic-icrc1-ledger`); the facade routes every payment through this one interface.

**Money-safety rule (load-bearing):** `pay()` ALWAYS reads the AUTHORITATIVE ledger balance (`icrc1_balance_of`) before transferring. The cache is DISPLAY-ONLY — a stale cache (someone transferred directly on the ledger) can only make a shown number wrong, never cause a bad settlement. The cache is refreshed (re-read from the ledger) after every successful `pay` / `mint` / `burn`.

## Where the design earns its keep

- **Consent model is sound.** `PaymentRequest` carries no `from`/sig; `to_authorization(from)` copies everything verbatim, so the payer's signature binds exact amount+payee+nonce+currency. The `request_id` doubling as the nonce is elegant — single-scan single-use kills double-charge by construction.
- **Per-currency segregation is across *canisters*, the strongest no-swap guarantee.** A user pubkey maps to ICRC-1 `Account{owner: <facade>, subaccount: <pubkey>}` on each ledger independently. Funds in currency X physically cannot be drawn by a payment naming currency Y — they live on a different ledger canister. This is stronger than a per-currency map key inside one canister. Proven by `currencies_cannot_cross`.
- **Cross-canister atomicity + replay safety is handled honestly.** `pay()` spans `await`s (balance/fee/transfer), and the IC interleaves messages at await points. The nonce is **reserved synchronously before any transfer** (no await in the reserve), so a concurrent `pay` with the same nonce observes it as used and is rejected. Proven by `concurrent_pay_same_nonce_settles_once` (the double-spend regression). On a transient ledger failure the reservation is released (same nonce retriable); on `Ok`/`Duplicate`/permanent-error it stays spent. Defense-in-depth: `created_at_time` is quantized so a sequential retry of the same authorization lands in the ledger's `Duplicate` bucket → no second debit. (The airtight close is an `icrc3_get_blocks` reconcile on restart — a production item, not yet implemented.)
- **NFC transport reuses the exact QR bytes.** Same 196-byte wire, same `verify()`. The HCE/reader state machines are panic-free (`card_never_panics_on_arbitrary_input` proptest) and carry a `SessionPhase` the UI renders directly. AID registered under `category="other"` deliberately to avoid the Google Wallet clash — a subtle real-world trap handled correctly.
- **Relay is honest about failure modes.** `LedgerError::{Rejected(422), Transient(503)}`, retry only on Transient, idempotency keyed by nonce, `committed` guard stops transport errors overwriting a decided ledger outcome, reconcile via `/receipt/:nonce` before reporting failure. This is the "relay must be rock solid" requirement, met. The `Ledger` trait + `AgentLedger` are canister-agnostic (the relay targets the facade `ssqti` by configured id); the only facade-specific detail is that `mint`/`burn` are controller-gated `Result<nat64,text>` updates — `mint` returns the **new balance** (matching the `Ledger::mint` contract that the faucet surfaces directly as `{balance}`), `burn` returns the ledger block index (facade-internal, no relay consumer). Both are decoded in `AgentLedger`.
- **Durable transaction history is ledger-sourced-of-effect, locally indexed.** The facade appends every settled payment to a per-(account, currency) stable-memory index (`ACCOUNT_TXNS`, key = `pubkey|currency|seq_be`, stored under both `from` and `to`) and exposes `transactions_of(blob, nat32, nat32) -> vec` (newest-first, survives upgrades). `mint`/`burn` are recorded too (counterparty = the `MINT_ACCOUNT` sentinel). The query path uses `StableBTreeMap::range(..).rev().take(limit)` — O(limit), not O(total) — which matters because the wallet polls it every 5s.

## Stable-memory layout (upgrade compatibility)

State lives in stable structures so it survives upgrades automatically (no `pre_upgrade`/`post_upgrade`). The facade preserves the pre-facade shipping canister's `SPENT` (MemoryId 1, value `()` — a set), `CAP` (2), `TXN_SEQ` (3), and `ACCOUNT_TXNS` (4) at the **same** MemoryIds/types, so an in-place upgrade of `ssqti` keeps nonces + history. The legacy internal `BALANCES` (MemoryId 0) is abandoned-and-inert (orphaned play money; unread by the facade). New facade state uses fresh MemoryIds: `LEDGERS` (5), `CONTROLLER` (6), `BAL_CACHE` (7). NB: `SPENT` keeps value type `()` rather than a 1-byte Pending/Settled enum — reusing a MemoryId with a different value size would corrupt the B-tree on upgrade, and `contains_key` (the sole read) makes the set semantically equivalent. The MemoryId/type compatibility (1–4 reused with identical key/value layout; 5/6/7 on fresh MemoryIds; 0 abandoned-and-inert) is **verified by inspection** of the `thread_local!` block — it is not proven by a cross-version test. The regression test `upgrade_preserves_nonces_and_history` covers **stable-structure survival across an upgrade round-trip**, but note it upgrades facade → *same*-facade wasm, so it proves the stable-structure round-trip, NOT the real old-internal-canister → facade layout. TODO: a true old-wasm → facade cross-version test would be stronger, but the old internal-canister crate is deleted, so its wasm isn't readily available.

## Risks worth flagging before a coding session

**1. Canister controller is unaddressed in code.** `CLAUDE.md` calls this out as load-bearing ("whoever can upgrade can set fee=100%"), but there is no blackhole/SNS wiring visible — the canister ships with whatever controller `dfx`/PocketIC assigns. Fine for PoC; must be settled before any pilot. This is the single biggest "property vs promise" gap. (Distinct from the in-canister *governance* controller below — that gates admin *methods*, not code upgrades.)

**2. `mint`/`burn`/`register_ledger` are open when no governance controller is set.** These admin methods are gated by the in-canister `CONTROLLER` principal: open to any caller when `controller = null` (the demo default), or restricted to that principal when set. `set_controller` lets a fresh deployment lock down (and a locked one can only be rotated by the controller). For anything beyond the demo, `controller` MUST be set to a governed principal at init — otherwise an open `register_ledger` lets anyone repoint a currency at a ledger they control, and an open `mint` prints unbounded demo currency. Same risk class as the legacy `mint()` faucet; the gate exists, the discipline is "set the controller." (`provision_ledger_canister` and `transfer_cycles` are separately gated by a fixed `ADMIN_CALLERS` operator allowlist — the deploy identity; rotate to an SNS/governance principal before production. `transfer_cycles` additionally lets the operator move THIS canister's cycles to any canister, so it is itself a value-moving ops surface — fine for rebalancing/reclaim, but it means whoever holds the operator identity can drain the facade's cycle balance.)

**3. Receipt is unsigned.** Documented and defensible for PoC (the payer's sig already binds amount/payee/nonce, so a lying merchant only hurts themselves), but it means the payer's "Paid ✓" rests on merchant honesty for the *outcome*, not just the *terms*. `CLAUDE.md` notes a canister-signed receipt as production hardening — that's the right upgrade path.

**4. Cross-canister trap window (residual, mitigated).** If the canister *traps* between the ledger committing `Ok` and `settle_nonce` completing, the IC rolls back this canister's message — including the nonce reservation — while the ledger's debit does NOT roll back (separate canister). A blind retry could then transfer again. Mitigated (not eliminated) by the quantized `created_at_time` dedup bucket (retries within a bucket → ledger `Duplicate` → success branch). The airtight close is an `icrc3_get_blocks` reconcile on restart — a production item. The dominant realistic trap source is stable-memory exhaustion in `record_txn`.

**5. `opt-level=1` in dev profile.** Speeds the inner loop but means proptest counterexamples run under light optimization — fine, just don't debug release-only miscompiles here.

**6. Transaction history is unbounded + single-page only (production roadmap).** Every settled payment writes two `TxnRecord`s, ~144B each, with no pruning and no cursor — a long-lived wallet grows without bound and can only fetch the newest ≤100 rows. Acceptable for the PoC/demo; before a pilot the history needs a paginated cursor, a retention window, or off-canister indexing. Not a correctness or money-safety issue (records are write-only-after-settle and never gate settlement).

## Suggested session priorities

Given the above, the highest-leverage coding work right now is *not* new features — it's the production-readiness gates that the PoC explicitly defers but that determine whether the "we can't touch your funds" claim is a property:

1. Canister controller governance (blackhole/SNS) + governed fee schedule.
2. Set the in-canister governance `controller` to a governed principal for anything beyond local demo (closes the open `mint`/`register_ledger` surface).
3. Signed receipt (canister returns a sig over `Receipt`; payer verifies).
4. `icrc3_get_blocks` reconcile on restart (closes the cross-canister trap window airtight).

Everything else — multi-currency UI, NFC radio hop on two physical devices, real camera — is fidelity, not correctness, and the emulator/headless gates already cover the protocol.

## Maintenance contract

- **Read first.** Any agent starting work on this repo reads `CLAUDE.md` (project memory + non-negotiables) **and** this file before editing.
- **Keep it truthful.** When a change resolves a risk above (e.g. the controller is governed, the receipt is signed, the icrc3 reconcile ships), strike the risk and record the resolution with a one-line pointer to the commit/PR. When a change adds a new surface, invariant, or risk, add it here in the same change.
- **Don't let it drift.** If a statement here stops matching the code, the file is wrong, not the code — fix the file. Stale analysis is worse than none.
