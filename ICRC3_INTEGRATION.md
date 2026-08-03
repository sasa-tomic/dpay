# Integrating against a real ICRC-1/3 ledger instead of the bespoke canister ledger

> This document answers: **how hard is it to stop storing balances inside `dpay-canister` and settle on a separate, standard ICRC ledger canister?** It records the verdict, the chosen integration shape, where the difficulty actually lives, and a runnable offline demo that proves it.
>
> **UPDATE — this integration is now the SHIPPING architecture (no longer a demo).** The isolated
> `dpay-canister-icrc` / `dpay-icrc-tests` crates have been **retired**; their hardened logic was
> folded into the canonical `dpay-canister` (the facade `ssqti`) and the canonical
> `dpay-canister-tests`. The dpay canister IS now the facade described in "Shape A" below: it holds
> no balances, routes each payment to a real ICRC ledger, keeps the offline-sig/nonce/expiry/cap
> gate, and adds a display-only balance cache. See `CODEBASE_ANALYSIS.md` ("The canister is a
> FACADE over external ICRC ledgers") for the current authoritative analysis. The recipes below are
> superseded: the PocketIC proof is now `just test-canister` (multi-ledger, incl. the double-spend
> regression), the local dfx deploy is `just deploy` (`scripts/dfx-deploy.sh`), and the mainnet
> verify is `just deploy-ic` (`scripts/dfx-deploy-ic.sh`, targeting `ssqti` — the ONE mainnet path; also registers currency metadata).
> The rest of this document is retained as the historical design rationale for that integration.
>
> Historical status (pre-promotion): **demonstrated** via two isolated crates plus a pre-built copy
> of the **real DFINITY `ic-icrc1-ledger`** wasm (cached in `third_party/ic-icrc1-ledger/`). dpay
> no longer ships or contains *any* ledger implementation — it settles on the real one.

## Verdict: feasible, moderate difficulty, concentrated in the canister

The integration is **moderate** — not a rewrite, not free. Above the `pay(blob) -> receipt` candid seam **nothing changes**: the 196-byte wire, the Ed25519 signature, the NFC/QR transport, the relay's `Ledger` trait, and the app are all unaware of where balances live. The work is entirely *inside* the canister and its tests.

The one property that must survive — and does — is the **offline-payer** premise: the payer signs once, offline, and never speaks to the ledger. Shape A below keeps signature verification inside the dpay canister, so the ICRC ledger is never asked to authorize a human.

## Shapes considered

**Shape A — chosen.** The dpay canister holds **no balances**. Each user pubkey maps to an ICRC-1 account owned by the canister: `Account { owner: <dpay canister>, subaccount: Some(<pubkey32>) }`. `pay()` keeps its signature/nonce/expiry/cap gate, then issues a cross-canister `icrc1_transfer` on the ledger. The ledger enforces that only the dpay canister (as `from.owner`) can move those subaccounts. The payer's authorization never reaches the ledger; it is checked by the dpay canister alone.

**Shape B — rejected.** ICRC-2 `approve` + `transfer_from`, with the payer's funds under the payer's own principal. This requires the payer to sign and submit an `approve` to the ledger *online* before payment — which destroys the offline-payer property the whole protocol is built around.

**Shape C — rejected.** Let the relay talk to the ledger directly. There is then no signature/nonce/expiry/cap gate at all — the relay becomes the trusted party and the protocol's value proposition (the payer's sig is the only thing that moves funds) is gone.

## Where the difficulty actually lives

1. **Atomicity now spans cross-canister calls.** The current canister reads balance, validates, debits, and credits in a single non-`await` message — message-level atomic. Under Shape A, `pay()` does `icrc1_balance_of` (cross-call) → `validate()` → `icrc1_transfer` (cross-call), so the read and the write are in *different* messages. This is safe **only** because the dpay canister is the sole withdrawer of its subaccounts (the ledger's `from.owner` rule) and each canister is single-threaded per message — but the nonce must be recorded **only after** the ledger confirms the transfer, not before. The residual failure window (canister traps between ledger confirmation and nonce write) is the *same* reconcile surface the relay already handles via `committed`/`/receipt/:nonce`. The demo encodes this: on `InsufficientFunds`/`TemporarilyUnavailable` it returns a transient error and does **not** burn the nonce.

2. **`balance_of` becomes an `update`, not a `query`.** A canister query cannot make cross-canister calls, so a balance lookup that must consult the ledger has to be an update. This is a real integration cost for any caller (relay, app) that previously treated balance as a cheap query. The demo canister makes `balance_of` an update that proxies the ledger.

3. **Fee semantics.** A real ICRC ledger charges a per-transfer fee. The payer signs an exact amount, so on a non-zero-fee ledger the merchant receives `amount − fee` (or the canister must top up the fee). This is a UX/policy decision, not a protocol blocker; the demo ledger runs with `fee = 0`.

4. **History sourcing.** `transactions_of` should ultimately be backed by `icrc3_get_blocks` rather than a local mirror. The demo keeps a local history alongside the ledger (the shipping canister already does this), and the tests additionally read the ledger's own `icrc3_get_blocks` chain to prove the blocks are really there.

## Custody and non-custodial posture

Custody optics are **unchanged or better**. Today balances live inside `dpay-canister`'s own stable memory; under Shape A they live on a standard, separately-governed ICRC ledger whose audit trail is the ICRC-3 block log. The dpay canister remains the *only* thing that can move a given subaccount (single `from.owner` rule), so it is still the sole mover — but the funds are now on an audited ledger rather than in a private map. This does not weaken the non-custodial claim; it strengthens the auditability of it.

## Multi-currency: one ledger per currency, plus a mintable demo currency

The wire already carries a `currency: u32`. The canister keeps a registry `currency -> {ledger principal, mintable}` and resolves the ledger from the payment's currency before settling. The same pubkey maps to a subaccount on **each** ledger independently (`Account{owner: dpay, subaccount: pubkey}` is identical across ledgers), so a balance in currency X physically cannot be drawn by a payment naming currency Y — they live on different canisters. This is a *stronger* no-swap guarantee than the shipping canister's per-currency map key: segregation is enforced by the ledger topology, not by a key prefix.

Two kinds of currency, distinguished only by a `mintable` flag:

- **Demo currency (`mintable = true`).** The ledger's `minting_account.owner` is the dpay canister, so `mint()` (transfer from the minting account) and `burn()` (transfer to the minting account — the ICRC convention for a burn) work. This is play money, fenced for production exactly like the shipping `mint()` faucet.
- **Real ck currency (`mintable = false`, e.g. ckBTC/ckETH/ckUSDT).** dpay cannot mint or burn — `mint()`/`burn()` refuse. Funds arrive via the token's native minting/deposit path (ckBTC minter, erp minting canister, or an incoming ICRC transfer). `pay()` and `balance_of()` work once a subaccount is funded; dpay only ever *moves* pre-funded balances.

Per-ledger **fee** is honored: each `pay()` reads `icrc1_fee` for the resolved ledger and includes it in the transfer, with a fee-inclusive sufficiency check (`amount + fee <= balance`) before the nonce is committed — so a ckBTC payment carries ckBTC's fee, not zero. `register_ledger(currency, principal, mintable)` adds a currency at runtime (demo: open; production must be governance-gated — same risk class as the open faucet).

## What the demo proves

`just icrc-demo` builds the dpay variant canister (the real `ic-icrc1-ledger` wasm is pre-built and cached) and runs eight PocketIC tests that install **two real ledgers** (a mintable DUSD and a non-mintable CKX stand-in for a ck token), then assert the load-bearing invariants by reading the **ledgers directly**, not via the dpay canister:

- `offline_sign_settles_on_demo_currency` — funding via the dpay canister moves balances *on the DUSD ledger*, and its `icrc3_get_blocks` chain grows.
- `non_mintable_currency_settles_and_cannot_be_minted` — the CKX ledger is pre-funded externally; dpay refuses to mint CKX but settles an offline-signed CKX payment on it.
- `currencies_cannot_cross` — a sender with DUSD but zero CKX cannot settle a CKX payment; neither ledger moves (the no-swap guarantee, enforced across canisters).
- `burn_destroys_demo_currency` — burning DUSD back to the minting account drops the balance; over-burn is refused.
- `replay_is_rejected_and_ledger_unchanged`, `over_cap_is_rejected`, `insufficient_balance_is_rejected`, `expired_auth_is_rejected` — the gate still holds and the ledger is never touched.

The ledger is the same `ic-icrc1-ledger` that backs ckBTC and SNS tokens on mainnet — the full ICRC-1/2/3 surface (`icrc1_*`, `icrc2_*`, `icrc3_get_blocks`/`get_tip_certificate`/`get_archives`/`supported_block_types`). Because the dpay canister only ever calls standard ICRC endpoints, it is wire-compatible with governed mainnet deployments of this same ledger without code changes. Adding ckBTC, ckETH, etc. is a `register_ledger` call, not a code change. (dpay's Rust types are pinned to `icrc-ledger-types 0.1.12` for the offline cache; the real ledger builds against `0.2.0`. The candid wire format is the ICRC standard, so they interop — confirmed by the passing cross-canister decode.)

## Run it

```sh
just icrc-demo          # offline: builds the dpay canister + runs 14 PocketIC tests against two real ledgers
just icrc-deploy        # spins up a real dfx replica: installs both canisters + proves mint/pay/replay end-to-end
just build-canister-icrc   # build only the dpay variant wasm
```

`icrc-demo` is the fast, deterministic test gate (PocketIC). `icrc-deploy` (`scripts/dfx-deploy-icrc.sh`) is the real-world deploy proof: it `dfx start`s a local replica, builds and installs both canisters, funds the payer via `mint`, reads the balance **directly off the ledger** (`icrc1_balance_of`), submits an offline-signed `pay`, asserts the replay is refused, and asserts the ledger-side balances moved (`payer = INIT_A − amount`, `merchant = amount`). Fully automated; `trap` tears the replica down on exit.

The real ledger wasm is pre-built and cached at `third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm` (gitignored). The two dpay crates are workspace members but are **not** in `default-members`, so the shipping inner loop (`just verify`, `just test-canister`, etc.) is unaffected.

### Controlling archive-canister spend (cost tuning)

The ledger spawns **archive canisters** only once its local block log exceeds `archive_options.trigger_threshold`. The demo sets this to **10,000,000** blocks (in both the PocketIC tests and the dfx deploy) — so archives effectively never spawn during any demo or pilot (you'd need 10M settled transactions first). The optional **index canister is omitted** (`index_principal = null`): ICRC-3 (`icrc3_get_blocks`, served by the ledger itself) plus dpay's own local history make it unnecessary, and it would burn cycles. `cycles_for_archive_creation` is left null. The tradeoff: without archives the ledger's stable memory grows by one record per block, but at demo volumes that never matters; a production deployment approaching ledger-memory limits would lower the threshold.

## The ledger wasm: build-from-source (one-time, online)

The proper ICRC-3 ledger (`ic-icrc1-ledger`) is **not** a published release asset. The `dfinity/ic` GitHub `canisters.tar` ships only the legacy ICP `ledger-canerald.wasm.gz`, which is ICRC-1/2 but *not* ICRC-3. So the real ledger must be built from source once, then cached. To reproduce the cached artifact:

```sh
git clone --depth 1 --filter=tree:0 https://github.com/dfinity/ic.git
cd ic
cargo build -p ic-icrc1-ledger --target wasm32-unknown-unknown --release --locked
# → target/wasm32-unknown-unknown/release/ic-icrc1-ledger.wasm (~91 MB, release+debuginfo)
wasm-strip target/wasm32-unknown-unknown/release/ic-icrc1-ledger.wasm -o ic-icrc1-ledger.wasm  # → ~2.8 MB
cp ic-icrc1-ledger.wasm      <dpay>/third_party/ic-icrc1-ledger/
cp rs/ledger_suite/icrc1/ledger/ledger.did <dpay>/third_party/ic-icrc1-ledger/
```

This requires network (clone + a one-time rustup install of the toolchain pinned by `dfinity/ic`'s `rust-toolchain.toml`, currently 1.97.x). The stripped artifact is committed to the gitignored `third_party/` cache so the inner loop never needs the network for it again. The build is plain `cargo` (no Bazel needed).

## What is NOT done here (production path)

These are the real remaining items, consistent with the risks already flagged in `CODEBASE_ANALYSIS.md`:

- Deploy governed mainnet instances of `ic-icrc1-ledger` — one per supported currency (the demo runs two on PocketIC; production ckBTC/ckETH/etc. are each a separately governed ledger). Register each with `register_ledger`.
- Fee policy: the demo passes the ledger's live `icrc1_fee` through and checks `amount + fee <= balance`; decide whether the merchant absorbs the fee or the canister subsidizes it (a UX/policy decision, not code).
- For ckBTC specifically: the dpay canister principal must be KYC-allowlisted as a recipient on the ckBTC `kyc_canister` (governance step, not dpay code) — `ic-ckbtc-ledger` rejects transfers to non-KYC'd accounts. Generic ICRC ledgers and erp tokens have no such gate.
- Back `transactions_of` with `icrc3_get_blocks` and reconcile the local mirror against it.
- The same production-readiness gates that apply to the shipping canister — governed controller, gated `register_ledger`, guarded minting, signed receipt — apply to the dpay-icrc variant, and remain the higher-leverage work.
