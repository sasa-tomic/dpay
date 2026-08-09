# 2026-08-09 — ETH + SOL mainnet operational check

## Verdict

- **ETH mainnet deposit UX: OPERATIONAL** via the WalletConnect onramp path (`CkErc20DepositSheet` → `GET /onramp/ckerc20` → helper address + calldata). Confirmed 200 on prod for currency 6 (native ckETH) and the app never touches the broken endpoints for ETH-family.
- **ETH mainnet deposit metadata endpoints: BROKEN (3 family-blind methods)** — see §1. App-unaffected but real prod landmines.
- **ETH mainnet withdraw: PARTIAL** — native-ETH `withdraw_eth` is deployed (commit `9fc4a9f`); ckERC20 `withdraw_erc20` needs a prod WASM upgrade (founder op, tracked in OPEN_ISSUES).
- **ETH mainnet balance: OPERATIONAL** (`GET /balance?currency=6` → `{"balance":"0"}`, 200, 0.2s — queries the ledger directly, no minter call).
- **SOL mainnet: NOT OPERATIONAL** in the shipped APK — `SOLANA_RPC_URL` defaults to devnet; `scripts/check-prod-sol.mjs` fail-closes the build on a devnet/rate-limited default. Blocked on operator setting a paid Helius/QuickNode RPC URL (operator step, not autonomous). The guard is correct and should NOT be weakened.

## 1. The family-blind deposit bug (the fix this session)

### Root cause
`crates/dpay-canister/src/lib.rs` has three `#[update]` deposit methods that unconditionally call **BTC-minter-only** methods regardless of the currency's `minter_family`:

| Method (lib.rs) | Calls | BTC-only because |
|---|---|---|
| `deposit_address` (1368) | `get_btc_address` (calls.rs:72) | ckETH minter has no such method |
| `deposit_info` (1468) | `get_minter_info` + decodes as BTC `MinterInfo` (types.rs:944) | ckETH minter returns a different `MinterInfo` shape |
| `refresh_deposit` (1390) | `update_balance` (UTXO model) | ckETH deposits use EVM logs, not UTXOs |

### Prod impact (curl against `https://dpay.kalaj.org`)
- `GET /deposit/info?currency=6` (native ckETH) → **503** `CandidDecodeFailed … MinterInfo`
- `GET /deposit/info?currency=2` (ckUSDC) → **503** same
- `GET /deposit/address/…?currency=6` → **503** `Canister has no update method 'get_btc_address'`
- `GET /balance/…?currency=6` → **200** `{"balance":"0"}` (ledger-only, unaffected)
- `GET /onramp/ckerc20?currency=6` → **200** (the path the app actually uses)
- `GET /deposit/info?currency=1` (ckBTC) → **200** (baseline, BTC family works)

### App impact
**None.** `Wallet.tsx:422-424` renders `CkErc20DepositSheet` (which calls `ckerc20OnrampParams`) for `CkEthErc20` family and `DepositSheet` (which calls the BTC methods) only for `CkBtcUtxo`. The broken endpoints are never hit from the app. This is a prod-API-correctness + log-hygiene fix, not a UX-unblock.

### Fix
Gate all three methods on family = `CkBtcUtxo` (legacy "has minter, no family" → default BTC, same as `withdraw`'s dispatch at lib.rs:1576-1585). For `CkEthErc20` / `CkSol` / no-minter-no-family, return a clean typed `Err` directing to the onramp path. Mirror `withdraw`'s family-dispatch pattern exactly.

### TDD plan (PocketIC, `crates/dpay-canister-tests`)
1. RED: register a `CkEthErc20` currency → `deposit_info(eth)` returns Err (currently candid-crashes).
2. RED: `deposit_address(pk, eth)` returns Err (currently calls wrong minter method).
3. RED: `refresh_deposit(pk, eth)` returns Err (currently calls wrong minter method).
4. GREEN: gate on family; assert clean error messages.
5. Regression: existing BTC deposit tests (`deposit.rs`) still pass unchanged.

### Relay
No relay change required for correctness (relay maps facade Err → 503; the message will be clean instead of a candid crash). Optional future polish: map non-BTC family → 404 at the relay layer. Out of scope this session.

## 2. SOL mainnet (operator step, no autonomous work)
- `SOLANA_RPC_URL` (`app/config/constants.ts:91`) = devnet default. `IS_SOLANA_DEVNET` (line 98) derives from it.
- `scripts/check-prod-sol.mjs` (wired into `scripts/build-apk.sh`) fails the build if the baked default is devnet or a rate-limited public mainnet RPC.
- **No code change warranted.** The guard is correct. The operator sets `SOLANA_RPC_URL` via gradle `buildConfigField` / manifest placeholder before a prod build. This is documented and fail-closed.

## 3. Parallel general-instruction work (after the bug fix lands)
- UX review: default-tab/first-impression, seed/backup affordance (deferred from SOL session Subagent D).
- e2e gap analysis: read `FLOWS.md`, add coverage for the ETH deposit_info family-gate (new canister behavior) + any missing UX flows.
- Tech-debt: read `CODEBASE_ANALYSIS.md` risks, pick safe wins within the FROZEN-but-mutable wire window.
