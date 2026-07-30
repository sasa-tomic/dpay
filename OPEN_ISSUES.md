# dpay — open issues & follow-ups

> **Read this before starting work** on dpay, alongside `CLAUDE.md` and `CODEBASE_ANALYSIS.md`.
> This is the authoritative list of known blockers and documented follow-ups after the verified
> fix-set (R1–R4 + ckBTC top-up + minter-arg + production deploy; gates green — `just check`,
> `just e2e` 15/15, `just verify`, live curl all 200). Most entries below are **deliberate,
> documented follow-ups**, not regressions — each carries its current mitigation and the concrete
> next step. Structural detail lives in `CODEBASE_ANALYSIS.md`.

## Severity key

- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.

## Open issues

### 1. (low) ckBTC live deposit→mint not yet exercised with real BTC

- **What/why.** No KYC/NNS allowlist is required to mint ckBTC — the mainnet ckBTC minter (`mqygn-kiaaa-aaaar-qaadq-cai`) runs in GeneralAvailability mode with **no KYC checker** (`get_minter_info` returns only `min_confirmations=4`, `kyt_fee=100`, `deposit_btc_min_amount=300`, `retrieve_btc_min_amount=50000`; the `btc_checker_principal` is unset). The minter's `UpdateBalanceError` has no "not allowed"/KYC variant; the only screening is automatic **KYT (Know-Your-Transaction)** that flags tainted *UTXOs*, not principals. A previous version of this issue incorrectly claimed a hard KYC/NNS blocker — that was an **unverified assumption**, disproven by the live minter config and by the facade's own `get_btc_address`/`update_balance` calls succeeding against mainnet.
- **Current state.** The full path is proven **offline end-to-end** (PocketIC + `dpay-mock-minter` + `FakeLedger`). Live, the wiring is proven reachable: `GET /deposit/address?currency=1` → 200 real `bc1...` address; `POST /deposit/refresh` → 200 `NoNewUtxos`; `GET /deposit/info` → 200. A clean, real BTC deposit (≥300 sats, 4 confirmations) will credit currency 1 with **no code change** — the mint lands at `Account{owner: facade, subaccount: pubkey}` where `balance_of`/`pay`/`transactions_of` already read.
- **Next step.** (Optional, costs real BTC) Send a small on-chain deposit to a facade deposit address, wait 4 confirmations, trigger `refresh_deposit`, and confirm the live mint credits currency 1. This is a final real-money confidence check, not a blocker.

### 8. (low) ckBTC live withdrawal not yet exercised with real BTC

- **What/why.** The withdrawal path (facade `withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`) is built and proven **offline end-to-end** (PocketIC through the real facade + `dpay-mock-minter` mirroring the real minter's exact candid; the relay's `FakeLedger`/route; the app's on-device-signed `WithdrawSheet`; e2e flow 15). It has NOT been exercised with real ckBTC against mainnet — there is no real ckBTC held at a facade subaccount to withdraw yet (issue 1's live deposit is the prerequisite). The wiring is proven reachable up to the minter (same as deposit); the live ceiling is "reaches `retrieve_btc_with_approval`".
- **Current mitigation.** Non-custodial by construction: `withdraw` moves nothing without a verified user Ed25519 signature over the canonical `WithdrawAuth` (single-use nonce in `WITHDRAW_NONCES`, MemoryId 12 → no double-burn). `RETRIEVE_BTC_MIN_AMOUNT = 50_000` mirrors the live minter's floor.
- **Next step.** (Optional, costs real ckBTC/BTC) Fund a facade subaccount with real ckBTC (via issue 1's live deposit), then withdraw ≥50_000 sats to a real BTC address and confirm the burn + on-chain BTC send. A final real-money confidence check, not a blocker.

### 9. (medium) Withdrawal approve→retrieve front-running residual (inherent to ckBTC)

- **What/why.** The facade's `withdraw` calls `icrc2_approve` then `retrieve_btc_with_approval` across an `await`. In principle a separate caller could invoke the minter's permissionless `retrieve_btc_with_approval` with the same subaccount + an attacker address in the gap, consuming the single-use allowance first. See CODEBASE_ANALYSIS risk 8.
- **Current mitigation.** Blast radius is bounded to the EXACT authorized `amount` (the approval is for that amount, consumed once) — never the user's whole balance. The facade's own retrieve follows immediately. This is the documented residual every `retrieve_btc_with_approval` client (incl. the NNS reference clients) carries; the minter offers no signature-binding-the-destination path, so no code fix is possible without a minter change. It is a known, bounded property, not a dpay-specific gap.
- **Next step.** Track ckBTC minter upgrades for a destination-bound retrieve variant; none exists today.

### 2. (high) R2 receipt key lives in stable memory, not IC chain-key

- **What/why.** The canister-signed receipt (R2) uses an Ed25519 key generated once from `management_canister::raw_rand` (strong consensus entropy) and stored in stable memory (`RECEIPT_SECRET`, MemoryId 10). This defeats the actual threat model — a lying merchant/relay cannot forge the outcome receipt, and the app verifies the signature before showing "Paid ✓" — and it is uniform with the app's existing Ed25519 verify path. The residual exposure: a canister compromise (e.g. a malicious upgrade) could exfiltrate the secret key from stable state.
- **Current mitigation.** The signing key only ever lives in the canister's own stable memory; only the canister signs. The threat the receipt actually defends against (lying merchant/relay) is fully closed. Controller governance (issue 3) bounds who can ever upgrade the canister to read it.
- **Next step.** Migrate receipt signing to **IC chain-key** (`sign_with_schnorr` / `sign_with_ecdsa`) so the key never lives in canister state. Do this before pilot.

### 3. (high) R4 external governance hand-off pending

- **What/why.** The IC-level *code controller* of the facade canister has not yet been handed to an SNS root or a blackhole. The code now fully supports a governed controller end-to-end (R1/R4: admin methods denied when `controller == null`, `InitArg.controller` seeds a governed principal at deploy, `set_controller` is two-step rotation) and `docs/GOVERNANCE.md` documents the exact operator steps. But until the external IC-level transfer actually lands, "we can't touch your funds" is a **promise, not an enforced property** — whoever holds the deploy key can still upgrade the wasm.
- **Current mitigation.** Controller currently locked to the `dpay` deploy identity; in-canister admin surface is closed (issue-context). Two distinct layers documented in `docs/GOVERNANCE.md` (in-canister `CONTROLLER` gates admin *methods*; IC-level code controller gates *upgrades* — both must be governed).
- **Next step.** Operator performs the SNS/blackhole transfer per the `docs/GOVERNANCE.md` pre-pilot checklist **before any pilot**.

### 4. (medium) `ADMIN_CALLERS` operator allowlist is the fixed deploy identity

- **What/why.** Cycles/admin operations (`provision_ledger_canister`, `transfer_cycles`) are gated to a hardcoded `ADMIN_CALLERS` operator allowlist — the fixed deploy identity, not a governed/rotatable principal.
- **Current mitigation.** These are ops/cycles functions only (not money-movement of user funds); bounded blast radius. Documented in `docs/GOVERNANCE.md`.
- **Next step.** Rotate `ADMIN_CALLERS` to a governed principal before pilot (`docs/GOVERNANCE.md` checklist).

### 5. (medium) R3 reconcile is bounded

- **What/why.** `reconcile(currency)` — which closes the cross-canister `pay()` trap window (R3) — is single-currency, walks recent in-canister blocks (`RECONCILE_MAX_BLOCKS` = 10k window), and is admin-triggered (not a heartbeat). Archived-block paging and automatic heartbeat triggering are deferred.
- **Current mitigation.** This is a **cycle-cost/operations tradeoff, NOT a correctness gap.** The trap window is already narrowed by the quantized `created_at_time` dedup (same-bucket retry → ledger `Duplicate`); reconcile is idempotent and admin-gated, so an operator can run it after any suspected trap or on a schedule. Proven on PocketIC via a reinstall-based trap simulation.
- **Next step.** Add a heartbeat auto-trigger + archived-range paging as scale/cycle-cost demands.

### 6. (medium) Merchant request QR defaults to currency 0 (DEMO_USD)

- **What/why.** The demo merchant request-generation UI defaults the request currency to 0 (DEMO_USD). The payment protocol itself is already currency-aware — `signAuthorization(..., req.currency)` honors the currency the merchant's request QR carries — so ckBTC **is** spendable today when a merchant issues a currency-1 request (proven: the e2e deposit flow credits currency 1 and the wallet shows an `asset-ckbtc` card). The gap is only in the demo UI's picker, not the protocol.
- **Current mitigation.** PoC scope is single-`$`/DEMO_USD by design; the multi-currency framing is the pitch/roadmap layer. No protocol limitation is being hidden.
- **Next step.** Add a multi-currency picker to the merchant request generation when the demo moves past single-currency.

### 7. (low) App↔canister config coupling

- **What/why.** `DEPOSIT_CURRENCY=1` is single-sourced in the app display layer and must match the canister's registered ckBTC currency id. They are aligned today; a future canister re-registration under a different currency id would silently desync the wallet's deposit card.
- **Current mitigation.** Treated as a deploy-config invariant (documented).
- **Next step.** Consider surfacing the canister's registered currencies so the wallet reads the currency id rather than hardcoding it.

## Resolved this session (changelog)

The following previously-open risks are now **CLOSED** (see `CODEBASE_ANALYSIS.md` for detail):

- ✅ **Open `mint()` / admin surface** → closed (R1): admin ops denied when `controller == null`; self-service `faucet` (fixed amount, rate-limited) is the demo on-ramp; relay `Ledger::mint` removed.
- ✅ **Unsigned receipt** → closed (R2): canister signs a canonical outcome receipt (`ReceiptClaim`, Ed25519); app verifies before "Paid ✓".
- ✅ **`pay()` cross-canister trap window** → closed/bounded (R3): admin-gated `icrc3` `reconcile(currency)` repairs trap-orphan debits; idempotent; PocketIC-proven.
- ✅ **ckBTC deposit unreachable in prod** → closed: the ckBTC minter call is now encoded as ONE record argument (was a 2-positional trap); proven LIVE — `GET /deposit/address?currency=1` returns a real `bc1...` address and the mint path is open (no KYC blocker; see issue 1).
- ✅ **minter-arg trap** → closed: facade encodes a single candid record arg to the ckBTC minter; mock aligned; an honesty-guard test fails if either reverts to the 2-tuple shape.
- ✅ **ckBTC top-up invisible** → closed (F1): wallet fetches currency 1 in parallel and renders a separate `asset-ckbtc` "Bitcoin" card (not merged into `$`); spendable when a merchant issues a currency-1 request.
- ✅ **e2e harness** → 15/15 flows driving the REAL app; relay isolated into `.dev/target-e2e` (clobber-proof) with a latent stale-binary build gate fixed (always invokes `cargo build`); parallel flow pool (~60s → ~13s, concurrency-safe, no assertions weakened). Old `ui/` parallel-component harness deleted.
- ✅ **NFC seam** → audited true: rides RNW's real `RCTDeviceEventEmitter` singleton (not a private registry).

## Resolved this wave (W2/W3/W4)

- ✅ **Withdrawal one-way valve** → closed (W2): the facade can now move ckBTC OUT to a native BTC address on a verified user Ed25519 signature (`withdraw` → `icrc2_approve` → minter `retrieve_btc_with_approval`; new `WithdrawAuth` wire type in dpay-core, `WITHDRAW_NONCES` MemoryId 12). Proven offline on PocketIC + the real app/relay/e2e (flow 15). Live real-money withdrawal is a documented follow-up (issue 8), not a blocker.
- ✅ **FakeLedger-vs-canister audit** → closed (W3): `FakeLedger.pay` now mirrors the canister's self-transfer + pay-to-mint-sentinel rejects (the two divergences found; both fixed + pinned by tests). The fee divergence is a documented accepted simplification (FakeLedger is the fee-less demo ledger).
- ✅ **Relay deploy-fidelity** → closed (W4): `build.rs` bakes the git commit; `GET /api/v1/version` exposes it; `just verify-relay` compares the live commit to HEAD (MATCH / BEHIND-N / MISMATCH). Feature-unconditional (in the prod image). The residual front-running risk of approve→retrieve is documented (issue 9 / risk 8) — inherent to ckBTC, not a dpay gap.
