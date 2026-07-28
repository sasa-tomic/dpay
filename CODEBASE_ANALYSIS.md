# dpay codebase analysis

> **Living document.** This is a structural analysis of the dpay codebase — architecture health, where the design earns its keep, and risks to flag before a coding session. It is maintained alongside the code: when a change materially affects anything stated here (a risk resolved, a new surface added, an invariant changed), update this file in the same change.
>
> Last reviewed: see `git log` for this file. Scope: everything under the workspace at the time of review (`dpay-core`, `dpay-canister`, `dpay-canister-tests`, `dpay-relay`, `dpay-ffi`, `dpay-sim`, `dpay-fixture`, `ui/`, `app/`), plus the non-shipping ICRC-ledger integration demo crates (`dpay-canister-icrc`, `dpay-icrc-tests`, and a cached copy of the real DFINITY `ic-icrc1-ledger` wasm in `third_party/`) covered in the "Integration surface" section below.

## Architecture health: strong

The single most load-bearing decision — **one Rust core shared by every consumer** — is actually enforced everywhere:

- `dpay-core` (`lib.rs` 454 lines + `nfc.rs` 1663 lines) is the source of truth for signing, validation, codec, and NFC framing. The canister, relay, sim, fixture, and FFI all import it; the app reaches it via UniFFI → `libdpay_ffi.so`. There is no parallel JS/Kotlin reimplementation of money logic.
- Money-critical JS (`app/src/payments.ts`) is intentionally pure + jest-tested and stays on outcome classification (settled/rejected/unknown), never on signature math. Correct separation.

The wire format is frozen and byte-precise (`SIGNING_LEN=100`, `WIRE_LEN=196`, `REQUEST_LEN=68`), and `validate()` is pure/allocation-free — exactly what a canister hot path wants. Field order is documented as FROZEN, which is the right discipline for a protocol surface.

## Where the design earns its keep

- **Consent model is sound.** `PaymentRequest` carries no `from`/sig; `to_authorization(from)` copies everything verbatim, so the payer's signature binds exact amount+payee+nonce+currency. The `request_id` doubling as the nonce is elegant — single-scan single-use kills double-charge by construction.
- **Per-currency segregation in the canister** (`BalanceKey = pubkey32 | currency_le4`) means funds in asset X cannot be drawn by an authorization naming asset Y. This is the protocol-level enforcement of the no-swap non-negotiable.
- **NFC transport reuses the exact QR bytes.** Same 196-byte wire, same `verify()`. The HCE/reader state machines are panic-free (`card_never_panics_on_arbitrary_input` proptest) and carry a `SessionPhase` the UI renders directly. AID registered under `category="other"` deliberately to avoid the Google Wallet clash — a subtle real-world trap handled correctly.
- **Relay is honest about failure modes.** `LedgerError::{Rejected(422), Transient(503)}`, retry only on Transient, idempotency keyed by nonce, `committed` guard stops transport errors overwriting a decided ledger outcome, reconcile via `/receipt/:nonce` before reporting failure. This is the "relay must be rock solid" requirement, met.
- **`AgentLedger::connect_with` refuses `fetch_root_key=true` on mainnet and `=false` on local.** That's a real security intuition coded as an invariant — fetching on mainnet would trust whatever key the endpoint returns (MITM → forged Paid).
- **Durable transaction history is ledger-sourced, not in-memory.** The canister appends every settled payment to a per-(account, currency) stable-memory index (`ACCOUNT_TXNS`, key = `pubkey|currency|seq_be`, each payment stored under both `from` and `to`) and exposes `transactions_of(blob, nat32, nat32) -> vec` (newest-first, survives upgrades). The relay surfaces it at `GET /api/v1/transactions/{hex}`; the app fetches + polls it instead of a `useState` list that reset on restart. Read-only-after-settle (records what already happened; never moves funds or gates settlement) — the non-custodial invariant is intact. The append runs in the same non-awaiting message as the balance move (lines after `BALANCES`/`SPENT` writes in `pay()`), so ICP message-level atomicity guarantees no half-committed state (balance moved but no record, or vice-versa). The query path uses `StableBTreeMap::range(..).rev().take(limit)` — O(limit), not O(total) — because `Iter` implements `DoubleEndedIterator` and `.rev()` walks the B-tree from the newest end; this matters because the wallet polls it every 5s.

## Risks worth flagging before a coding session

**1. Canister controller is unaddressed in code.** `CLAUDE.md` calls this out as load-bearing ("whoever can upgrade can set fee=100%"), but there is no blackhole/SNS wiring visible — the canister ships with whatever controller `dfx`/PocketIC assigns. Fine for PoC; must be settled before any pilot. This is the single biggest "property vs promise" gap.

**2. `mint()` is an open anonymous faucet.** `mint_open_to_anyone` is a *test* that proves any caller can mint unbounded DEMO_USD. Correct for a demo ledger, but there's no feature flag or caller guard — if this canister ever touches anything real, this is the first thing to fence.

**3. Receipt is unsigned.** Documented and defensible for PoC (the payer's sig already binds amount/payee/nonce, so a lying merchant only hurts themselves), but it means the payer's "Paid ✓" rests on merchant honesty for the *outcome*, not just the *terms*. `CLAUDE.md` notes a canister-signed receipt as production hardening — that's the right upgrade path.

**4. `TASKS.md` is stale** — all Week 1–4 items unchecked while `CLAUDE.md` says everything is green. Either delete it or reconcile it; a stale task file will waste cycles in any planning session.

**5. `opt-level=1` in dev profile.** Speeds the inner loop but means proptest counterexamples run under light optimization — fine, just don't debug release-only miscompiles here.

**6. Transaction history is unbounded + single-page only (production roadmap).** Every settled payment writes two `TxnRecord`s (from + to), ~144B each in stable memory, with no pruning and no retention window — a long-lived wallet account grows without bound. The query takes a `limit` but has **no offset/cursor**, so a wallet can only ever fetch the newest ≤100 rows (relay caps `limit` at 100); older history is currently unreachable over the API. Both are acceptable for the PoC/demo (tiny volumes, no "show more" UX), but before a pilot the history needs either a paginated cursor keyed on `seq`, a retention window, or off-canister indexing. Not a correctness or money-safety issue — the records are write-only-after-settle and never gate settlement.

## Integration surface (non-shipping, demonstrated)

Two **isolated** crates — `dpay-canister-icrc`, `dpay-icrc-tests` — demonstrate settling payments on the **real DFINITY `ic-icrc1-ledger`** (the same ledger that backs ckBTC/SNS on mainnet) instead of inside the canister's own `BALANCES` map. dpay holds no balances and contains no ledger implementation; it only calls standard ICRC endpoints on external ledger(s). The crates are workspace members but **not** in `default-members`, so the shipping inner loop is untouched. The real ledger wasm + `.did` are cached in `third_party/ic-icrc1-ledger/` (gitignored) — it is **not** a release asset, so it was built once from `dfinity/ic` source (repro steps in `ICRC3_INTEGRATION.md`). Full analysis in `ICRC3_INTEGRATION.md`; runnable via `just icrc-demo`.

- **Shape:** the dpay canister holds no balances; each pubkey maps to ICRC-1 `Account{owner: <dpay canister>, subaccount: <pubkey>}` on each registered ledger. `pay()` keeps the signature/nonce/expiry/cap gate, then issues a cross-canister `icrc1_transfer` on the ledger named by the wire's `currency`. The offline-payer property is preserved (signature verification stays in the canister; the ledger never authorizes a human). Difficulty is **moderate**, concentrated in the canister. Demo passes 8/8 PocketIC tests offline against two real ledgers.
- **Multi-currency + mintable demo currency.** A registry `currency(u32) -> {ledger principal, mintable}` resolves the ledger per payment; the same pubkey is a subaccount on *each* ledger, so balances cannot cross currencies (segregation across canisters — a stronger no-swap guarantee than the shipping canister's per-currency map key). One currency is the `mintable` demo token (`mint`/`burn` via transfer from/to the ledger's minting account); others are real ck currencies (`mintable=false`) that dpay can move but not create. Per-ledger fee is read live via `icrc1_fee` and included in the transfer with a fee-inclusive sufficiency check. `register_ledger` adds a currency at runtime.
- **Why it's tracked here, not just in a separate doc:** it changes an invariant the rest of the analysis treats as settled — *the canister is the ledger*. Under this integration, balance authority moves to the external ledger(s), atomicity spans cross-canister calls (nonce recorded only after the ledger confirms; transient errors do not burn the nonce), and `balance_of` becomes an `update` (canister queries can't make cross-canister calls). Any agent editing the shipping canister's `BALANCES`/`pay()` path should know this proven alternative exists, so a future migration isn't designed blind.
- **It is a demo, not the shipping path.** The real ledgers run on PocketIC here, not governed mainnet instances. The production-readiness gates below (controller governance, gated `register_ledger`, guarded minting, signed receipt) apply to the dpay-icrc variant too. dpay's Rust types pin `icrc-ledger-types = 0.1.12` (offline-cache-capped) while the real ledger builds against `0.2.0`; they interop over the standard ICRC candid wire format (verified by the passing tests). Note: an unfenced `register_ledger` and the `mint`/`burn` faucet are new open-surface risks here, same class as the shipping `mint()` faucet (Risk 2) — both must be governance-gated before any pilot.

## Suggested session priorities

Given the above, the highest-leverage coding work right now is *not* new features — it's the production-readiness gates that the PoC explicitly defers but that determine whether the "we can't touch your funds" claim is a property:

1. Canister controller governance (blackhole/SNS) + governed fee schedule.
2. `mint()` guard behind a feature/identity for anything beyond local demo.
3. Signed receipt (canister returns a sig over `Receipt`; payer verifies).

Everything else — multi-currency UI, NFC radio hop on two physical devices, real camera — is fidelity, not correctness, and the emulator/headless gates already cover the protocol.

## Maintenance contract

- **Read first.** Any agent starting work on this repo reads `CLAUDE.md` (project memory + non-negotiables) **and** this file before editing.
- **Keep it truthful.** When a change resolves a risk above (e.g. `mint()` gets a guard, the controller is governed, the receipt is signed), strike the risk and record the resolution with a one-line pointer to the commit/PR. When a change adds a new surface, invariant, or risk, add it here in the same change.
- **Don't let it drift.** If a statement here stops matching the code, the file is wrong, not the code — fix the file. Stale analysis is worse than none.
