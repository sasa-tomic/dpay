# dpay canister topology

> **Two dpay-owned canisters live on mainnet, plus the external ones they depend on.** For how many
> external ones, read the table under "External IC chain-key dependencies" — a count here rotted
> once already (it said four; the table grew on 2026-08-30, and VCHF, ICP and the ICP index are not
> chain-key at all), so it is not restated. This is the authoritative
> map of which canisters exist on mainnet (`ic`), who owns them, and what each is for. The tracked
> `canister_ids.json` (repo root) holds the durable mainnet ids of the two owned canisters; the
> per-replica local ids live in the gitignored `.dfx/local/canister_ids.json`.
>
> **Post-cutover reality (2026-08-19/20, the "IC rail → user-principal" switch W1–W8):** user funds
> live at **user principals directly on the external ICRC ledgers**
> (`Account { owner: <self-authenticating(device ed25519 pubkey)>, subaccount: None }`). The app
> signs full IC `/api/v2` request envelopes locally (`crates/dpay-icp` via the FFI/wasm core) and
> submits them to the IC boundary nodes (`icp-api.io` in prod; the relay's in-process fake-IC gateway
> in tests). **Neither owned canister is on the value-movement path anymore.** Pre-cutover
> facade-subaccount balances were not migrated (no prod users; DEMO play money only).

## Owned canisters (dfx-managed, in `dfx.json`)

### `dpay_canister` — the facade (value-path dispatch residual + DEMO plumbing; settlement kernel dormant)
- **Mainnet id:** `ssqti-wiaaa-aaaab-qhdia-cai`
- **Registry removal (founder decision 2026-08-28):** the public, mutable currency registry
  (`register_ledger`/`register_minter`/`register_currency`/`register_currency_meta`/
  `retire_currency` + the `currencies()` catalog) is GONE from the canister — the relay's compiled
  catalog (`crates/dpay-relay/src/catalog.rs`) is the sole catalog authority (see
  `CODEBASE_ANALYSIS.md`). Currency resolution inside the canister is the `demo_ledger` init arg
  (DEMO 0) + compile-time ck ledger/minter consts for ckBTC(1)/ckUSDC(2)/ckETH(6); the init arg is
  `record { demo_ledger; per_tx_cap; controller }`.
- **Role at HEAD — display read surface, consumed via the relay (`AgentLedger`, cargo feature
  `agent`):**
  - `transactions_of(pubkey, currency, limit)` (query) — the durable per-account history index →
    relay `GET /api/v1/transactions/{hex}`. Facade-era rows only: user-principal rail transfers do
    **not** write this index (see `CODEBASE_ANALYSIS.md`).
  - `deposit_info(currency)` (update; proxies the minter's static instructions) → relay
    `GET /api/v1/deposit/info`.
  - The ckERC20/ckETH onramp params (relay `GET /onramp/ckerc20`) resolve from the relay's compiled
    catalog; the CkDeposit `helper_address` is read at RUNTIME from the currency's minter
    (`get_minter_info` — the minter principal is a compile-time const in the canister since the
    registry removal), falling back to the verified compile-time constants when the minter leaves
    the field unset or the read fails. ~~`facade_principal` (this canister's id) is still
    embedded in the helper-contract `depositErc20`/`depositEth` calldata…~~ — **struck 2026-08-20
    (commit 82377e4)**: the onramp calldata no longer carries any facade principal. The relay
    serves helper/chain constants only (pinned by `relay.rs` + `relay.test.ts`), and the app
    encodes the deposit owner itself as `principalToBytes32(icpSelfPrincipal())` with the default
    subaccount — ETH-side deposits mint at the USER's own principal, exactly where the
    user-principal balance read path looks. No invisible-deposit residue remains on this surface.
- **Settlement kernel: still in the wasm, one play-money production caller.** The deployed canister
  still
  carries `pay`/`withdraw`/`faucet`/`mint`/`burn`/`reconcile`/`refresh_balances`/`deposit_address`/
  `refresh_deposit` + the canister-signed-receipt machinery (the crate, its 81+ PocketIC tests, and
  `dpay-sim` still exercise them), but nothing on the value path calls them EXCEPT `mint` — the
  production faucet (2026-08-20, founder-approved): the relay's agent-build
  `POST /api/v1/faucet` rate-limits per account relay-side (1h window, old canister canon's exact
  error text) and drives the controller-gated `mint` authenticated via `DPAY_CONTROLLER_SEED`;
  `mint` credits the USER principal (`calls::user_account_of`), so the top-up lands exactly where
  the app's balance reads look. Everything else stays dormant: the app signs envelopes
  itself, balances are read directly off each ledger (`icrc1_balance_of` at the user principal — the
  relay no longer touches `BAL_CACHE`/`refresh_balances`), BTC deposit addresses come from a
  user-signed minter UPDATE (`get_btc_address` at the user principal — an update method only on the
  real minter, polled via `request_status`; the signed-query form fails on mainnet), and offramps
  are user-signed `icrc2_approve` + minter calls. The relay routes that used to front these
  (`/pay`, `/withdraw`, `/receipt/{nonce}`, `/receipt_pubkey`, `/deposit/address`,
  `/deposit/refresh`) are deleted.
- **Why `just deploy-ic` still ships it:** the facade WASM install/upgrade (wasm only — since the
  2026-08-28 registry removal there is NO registration step and no catalog on the canister), the
  DEMO faucet target (the controller-gated `mint` on the DUSD ledger), the dormant settlement
  kernel + receipts, the deposit-info read surface, and the staging provisioning vehicle
  (`provision_ledger_canister`). An evil upgrade can no longer *move* user funds — but it can
  still misreport history/display info and mint DEMO, so the governance hand-off below remains
  real.
- **Source:** `crates/dpay-canister` → `target/wasm32-unknown-unknown/release/dpay_canister.wasm`;
  candid `dfx/dpay_canister.did`.
- **Control:** currently the deploy identity (founder). Admin methods are denied once
  `controller == null` (R1/R4). The hand-off to an SNS / blackhole is an external operator step —
  see `docs/GOVERNANCE.md`.

### `dpay_canister_staging` — the staging facade (testnet chain-key wiring)
- **Mainnet id:** provisioned on first deploy via `provision_ledger_canister` on `ssqti` (id lands in
  `canister_ids.json` under `dpay_canister_staging.ic` + `deploy/.env` as `DPAY_STAGING_CANISTER_ID`).
- **Role:** a SEPARATE facade wired to IC's FREE testnet chain-key tokens (ckBTC Testnet on Bitcoin
  Testnet4, ckSepoliaUSDC, ckSepoliaETH on Sepolia). ~~Same wasm as the prod facade; differs only
  in its registered currencies~~ — **registry-era wording (struck 2026-08-28):** the facade
  registry is removed, so the staging-specific `register_currency` wiring this section described
  no longer exists; the testnet currencies surface via the relay's compiled catalog instead
  (single display-only testnet fixture `ckTESTBTC`, hidden in-app behind the testnet toggle).
  The staging path is dormant post-removal and would need rework before use. The e2e-live Tier 1
  flow (`e2e-live/tests/01-testnet-wiring.mjs`, `just e2e-live-testnet`) drives its read surface
  end-to-end (dormant until the staging path is chosen; the deposit/withdraw entry points are
  post-cutover dormant like prod's).
- **Provisioning:** `scripts/dfx-deploy-ic-staging.sh` provisions the facade (200 TC) + a staging DUSD
  ledger (20 TC) from `ssqti`'s cycle balance (the `dpay` identity is in `ADMIN_CALLERS`). The staging
  DUSD ledger is staging-owned (NOT prod `td2nx` — whose minting_account.owner is `ssqti`, so the
  staging facade cannot mint from it). Local rehearsal: `just deploy-ic-staging` (DPAY_DFX_NETWORK=local,
  mock DUSD ledger, no cycles).
- **Control:** the `dpay` deploy identity (set_controller locks the facade-level controller after init).
- **Currencies:** DEMO(0, staging DUSD), ckBTC Testnet(3, `mc6ru-…`/`ml52i-…`), ckSepoliaUSDC(4,
  `yfumr-…`/`jzenf-…`), ckSepoliaETH(5, `apia6-…`/`jzenf-…`). ~~Exact validated metadata in the
  deploy script — do not edit.~~ Registry-era list (struck 2026-08-28): these staging registrations
  cannot be replayed post-registry-removal; the deploy script's registration section is stale and
  must be updated before any staging use.

### `icrc_ledger` — the DUSD ICRC-3 ledger
- **Mainnet id:** `td2nx-oaaaa-aaaab-qhdnq-cai`
- **Role at HEAD:** backs the **DEMO currency** (currency `0`, token symbol `DUSD`, 2 decimals) as
  its DEMO ledger — the facade's `demo_ledger` init arg (since the 2026-08-28 registry removal) and
  the compiled catalog's DEMO row. Post-cutover nothing in prod touches it on the value path: the
  prod relay
  image's faucet (`POST /api/v1/faucet`, agent build — 2026-08-20) drives the FACADE's
  controller-gated `mint()` (with the relay-held `DPAY_CONTROLLER_SEED`), which in turn mints on
  this ledger via its `minting_account`; the cooldown lives relay-side. A DEMO payment — if anyone
  held DUSD — is an ordinary user-principal `icrc1_transfer` on this ledger. Pre-cutover
  settlement flows through `facade.mint()`'s custody shape are retired (the 2026-08-20 re-target
  points `mint()` at the USER principal). `minting_account.owner = ssqti` (only the facade may
  mint).
- **Standard:** a modern ICRC ledger built from `third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm`. It
  advertises **ICRC-1, ICRC-2, ICRC-3** (plus 10/21/103/106). This single ledger **is** the ICRC-3
  ledger; there is no separate one.
- **Play money:** holds no real funds. The deploy script reinstalls it solely to set
  `minting_account.owner` to the facade; the reinstall is lossless.

## External IC chain-key dependencies (NOT owned)

These are Internet Computer chain-key canisters operated by DFINITY / the chain. **dpay cannot
upgrade or otherwise manage them.** Post-cutover these ledgers (not any dpay canister) are where
user funds actually live: the app reads balances via signed `icrc1_balance_of` queries at the user
principal, drives deposits via user-signed minter queries/calls, and offramps via user-signed
`icrc2_approve` + `retrieve_btc_with_approval` / `withdraw_eth` / `withdraw_erc20`. They appear in
the relay's compiled catalog (served at `GET /api/v1/currencies` — the sole catalog authority since
the 2026-08-28 registry removal) but are deliberately absent from `canister_ids.json` (dfx must
not treat them as build/install targets).

| Currency | Role     | Principal                  |
|----------|----------|----------------------------|
| 1 ckBTC  | ledger   | `mxzaz-hqaaa-aaaar-qaada-cai` |
| 1 ckBTC  | minter   | `mqygn-kiaaa-aaaar-qaadq-cai` |
| 2 ckUSDC | ledger   | `xevnm-gaaaa-aaaar-qafnq-cai` |
| 2 ckUSDC | minter   | `sv3dd-oaaaa-aaaar-qacoa-cai` (the ckETH minter; ckERC20s share it) |
| 6 ckETH  | ledger   | `ss2fx-dyaaa-aaaar-qacoq-cai` (native ETH mainnet; `token_contract=null`) |
| 6 ckETH  | minter   | `sv3dd-oaaaa-aaaar-qacoa-cai` (same ckETH minter; single-ledger `withdraw_eth`) |
| 7 VCHF   | ledger   | `ly36x-wiaaa-aaaai-aqj7q-cai` (external VNX ICRC ledger; no dpay minter, no ramps; served live by the relay's compiled catalog since 2026-08-30) |
| 8 ICP    | ledger   | `ryjl3-tyaaa-aaaaa-aaaba-cai` (the canonical ICP ledger; no dpay minter, no ramps; served live by the relay's compiled catalog since 2026-08-30) |
| 8 ICP    | index    | `qhbym-qaaaa-aaaaa-aaafq-cai` (official ICP index — a relay code pin for ICP history, not a catalog entry) |

## Notes

- A third mainnet canister referenced by the founder was a development artifact created during testing
  and is not stored or referenced anywhere in this repo (scripts, config, code, docs). It is treated as
  nonexistent. If a stray canister is ever found, identify it with `dfx canister info <id> --network ic`
  before any action.
- `canister_ids.json` is **tracked** (durable mainnet ids). Adding a new owned canister means adding a
  `dfx.json` entry + its `ic` id here. Local-replica ids (`.dfx/local/canister_ids.json`) stay ignored.
