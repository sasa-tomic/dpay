# dpay canister topology

> **Two dpay-owned canisters + four external IC chain-key dependencies.** This is the authoritative
> map of which canisters exist on mainnet (`ic`), who owns them, and what each is for. The tracked
> `canister_ids.json` (repo root) holds the durable mainnet ids of the two owned canisters; the
> per-replica local ids live in the gitignored `.dfx/local/canister_ids.json`.

## Owned canisters (dfx-managed, in `dfx.json`)

### `dpay_canister` — the facade / settlement gateway
- **Mainnet id:** `ssqti-wiaaa-aaaab-qhdia-cai`
- **Role:** the core. Settlement kernel, canister-signed receipts, multi-currency catalog
  (`currencies()`), per-currency caps, DEMO faucet entrypoint (`mint`), `reconcile`, `refresh_balances`.
  All user funds live at `{ owner: facade, subaccount: <ed25519 pubkey> }`.
- **Source:** `crates/dpay-canister` → `target/wasm32-unknown-unknown/release/dpay_canister.wasm`;
  candid `dfx/dpay_canister.did`.
- **Control:** currently the deploy identity (founder). Admin methods are denied once `controller == null`
  (R1/R4). The hand-off to an SNS / blackhole is an external operator step — see `docs/GOVERNANCE.md`.

### `dpay_canister_staging` — the staging facade (testnet chain-key wiring)
- **Mainnet id:** provisioned on first deploy via `provision_ledger_canister` on `ssqti` (id lands in
  `canister_ids.json` under `dpay_canister_staging.ic` + `deploy/.env` as `DPAY_STAGING_CANISTER_ID`).
- **Role:** a SEPARATE facade wired to IC's FREE testnet chain-key tokens (ckBTC Testnet on Bitcoin
  Testnet4, ckSepoliaUSDC, ckSepoliaETH on Sepolia) — the live testnet path that closes OPEN_ISSUES
  #1/#2/#8. Same wasm as the prod facade; differs only in its registered currencies (DEMO + the 3
  testnet chain-key currencies vs prod's DEMO + ckBTC + ckUSDC + ckETH — the prod catalog also
  carries the same 3 testnet variants, hidden in-app behind the testnet toggle). The e2e-live Tier 1
  flow
  (`e2e-live/tests/01-testnet-wiring.mjs`, `just e2e-live-testnet`) drives it end-to-end.
- **Provisioning:** `scripts/dfx-deploy-ic-staging.sh` provisions the facade (200 TC) + a staging DUSD
  ledger (20 TC) from `ssqti`'s cycle balance (the `dpay` identity is in `ADMIN_CALLERS`). The staging
  DUSD ledger is staging-owned (NOT prod `td2nx` — whose minting_account.owner is `ssqti`, so the
  staging facade cannot mint from it). Local rehearsal: `just deploy-ic-staging` (DPAY_DFX_NETWORK=local,
  mock DUSD ledger, no cycles).
- **Control:** the `dpay` deploy identity (set_controller locks the facade-level controller after init).
- **Currencies:** DEMO(0, staging DUSD), ckBTC Testnet(3, `mc6ru-…`/`ml52i-…`), ckSepoliaUSDC(4,
  `yfumr-…`/`jzenf-…`), ckSepoliaETH(5, `apia6-…`/`jzenf-…`). Exact validated metadata in the deploy
  script — do not edit.

### `icrc_ledger` — the DUSD ICRC-3 ledger
- **Mainnet id:** `td2nx-oaaaa-aaaab-qhdnq-cai`
- **Role:** backs the **DEMO currency** (currency `0`, token symbol `DUSD`, 2 decimals). Every new
  wallet's `∂100` faucet mints here (`facade.mint()` → `icrc1_transfer`); every `∂` payment settles
  here as a cross-canister `icrc1_transfer`. `minting_account.owner = ssqti` (the facade) — only the
  facade may mint.
- **Standard:** a modern ICRC ledger built from `third_party/ic-icrc1-ledger/ic-icrc1-ledger.wasm`. It
  advertises **ICRC-1, ICRC-2, ICRC-3** (plus 10/21/103/106). This single ledger **is** the ICRC-3
  ledger; there is no separate one.
- **Play money:** holds no real funds. The deploy script reinstalls it solely to set
  `minting_account.owner` to the facade; the reinstall is lossless.

## External IC chain-key dependencies (NOT owned)

These are Internet Computer chain-key canisters operated by DFINITY / the chain. dpay reads balances
and triggers deposits/withdrawals cross-canister; **dpay cannot upgrade or otherwise manage them.**
They appear in the facade `currencies()` response but are deliberately absent from `canister_ids.json`
(dfx must not treat them as build/install targets).

| Currency | Role     | Principal                  |
|----------|----------|----------------------------|
| 1 ckBTC  | ledger   | `mxzaz-hqaaa-aaaar-qaada-cai` |
| 1 ckBTC  | minter   | `mqygn-kiaaa-aaaar-qaadq-cai` |
| 2 ckUSDC | ledger   | `xevnm-gaaaa-aaaar-qafnq-cai` |
| 2 ckUSDC | minter   | `sv3dd-oaaaa-aaaar-qacoa-cai` (the ckETH minter; ckERC20s share it) |
| 6 ckETH  | ledger   | `ss2fx-dyaaa-aaaar-qacoq-cai` (native ETH mainnet; `token_contract=null`) |
| 6 ckETH  | minter   | `sv3dd-oaaaa-aaaar-qacoa-cai` (same ckETH minter; single-ledger `withdraw_eth`) |

## Notes

- A third mainnet canister referenced by the founder was a development artifact created during testing
  and is not stored or referenced anywhere in this repo (scripts, config, code, docs). It is treated as
  nonexistent. If a stray canister is ever found, identify it with `dfx canister info <id> --network ic`
  before any action.
- `canister_ids.json` is **tracked** (durable mainnet ids). Adding a new owned canister means adding a
  `dfx.json` entry + its `ic` id here. Local-replica ids (`.dfx/local/canister_ids.json`) stay ignored.
