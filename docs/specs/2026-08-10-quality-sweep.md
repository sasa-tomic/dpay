# 2026-08-10 — Quality sweep (issue-finding → fix → UX → e2e hardening)

> Stream 1 (issue-finding sweep) ran as 5 parallel audit subagents. Findings consolidated below.
> **0 HIGH-severity** (codebase well-hardened by prior waves); ~20 MEDIUM/LOW actionable items.
> Prod deploy CONFIRMED LIVE this session: user ran `just deploy-ic && just apk && just up` →
> facade WASM + APK + relay image all at HEAD. Verified: TTL cache (deposit/refresh 15.2s→0.09s),
> family-gate fix (cur 6 clean error), 7 currencies. Resolves the 3 POSTPONE founder ops.

## PROD-DEPLOY VERIFIED (2026-08-10)

- `curl /health` → `{"status":"ok"}`.
- `curl /currencies` → 7 currencies, ckETH mainnet (id 6) present, no symbol collisions.
- `curl /deposit/info?currency=6` → clean `CkEthErc20` family-gate error (fix `3e60a56` LIVE).
- `POST /deposit/refresh/{hex}?currency=1` → first 15.2s (cold minter), second 0.09s (TTL cache HIT, 162× faster) — cycles-drain fix `91cae05` LIVE.
- Deploy command (founder-run, reusable): `just deploy-ic && just apk && just up`.

## Findings (consolidated, deduped across 5 audits)

### MEDIUM (do now)

| # | area | finding | fix | conf |
|---|---|---|---|---|
| M1 | relay | Query methods `transactions_of`/`currencies`/`receipt`/`healthy` lack `tokio::time::timeout` (2026-08-07 wave covered only UPDATE calls; `balance_of` already wrapped) | wrap in `tokio::time::timeout` | 8 |
| M2 | relay | `merchant.html` 3 `fetch()` (submit/health/receipt-poll) no timeout/AbortController — never-hardened served HTML | `AbortSignal.timeout(...)` | 8 |
| M3 | relay | Dead cluster after `934d8cd`: `refresh_all_if_stale`/`spawn_background_refresh_all`/`any_stale_for`/`last_refresh`/`refresh_balances`/`BALANCE_TTL_SECS` + `Ledger::refresh_all_if_stale` trait + stale doc comments | delete + fix docs | 9 |
| M4 | relay | 7× copy-pasted hex→`[u8;N]` decode in `app.rs` + 3× in `agent_ledger.rs` | `parse_pubkey_hex`/`decode_hex_array` helper | 9 |
| M5 | relay | `ledger.rs:425` chain_id wildcard → mainnet helper silently (future chain misroutes deposit) | explicit match, fail-closed on unknown | 6 |
| M6 | canister | 4× copy-pasted 14-line family-gate preamble (`deposit_address`/`refresh_deposit`/`deposit_info`/`withdraw`) | `require_btc_family_minter()` helper | 9 |
| M7 | canister | `lib.rs` 2164 lines > 2000 bar (grew back after 2026-08-06 split) | extract deposit/withdraw proxy surface → `proxy.rs` (pairs with M6) | 8 |
| M8 | app-ts | Dead imports: PayMode (EXPIRY_WINDOW/usd/randNonceHex/nowSecs + dead prop onWithdrawCurrencyChange), ReceiveMode (readJsonOrEmpty + dead props currentCurrency/onDepositCurrencyChange), Wallet (cmpRaw), SolReceiveMode (RECEIPT_UNREACHABLE), spl.ts (bs58) | drop | 10 |
| M9 | app-ts | Dead `reset()` fns: WithdrawSheet:102, SolanaWithdrawSheet:66 | delete | 10 |
| M10 | app-ts | `typecheck` script (`tsc --noEmit`) lacks `--noUnusedLocals`/`--noUnusedParameters` — M8's dead imports sail through the green gate | add flags (after M8) | 9 |
| M11 | app-ts | Relay TS client drops error bodies: `depositInfo`/`depositAddress`/`depositRefresh`/`ckerc20OnrampParams` throw status-only (sibling `withdrawFunds` surfaces body) | read body, surface `j?.error` | 8 |
| M12 | app-ts | Silent catches: DepositSheet:106,85 (deposit poll/info), useSolanaBalance:33, useTransactionHistory:49, catalog.ts:99 | `console.warn(e)` before fallthrough | 7 |
| M13 | app-ts | 6× copy-feedback pattern (copied state + setTimeout) across DepositSheet/WithdrawSheet/SettingsSheet/SolanaReceiveSheet/SolanaWithdrawSheet/SolReceiveMode | `useCopyFeedback()` hook | 8 |
| M14 | app-ts | Two hand-rolled base64 codecs: rpc.ts (standard) + base64url.ts (url-safe) — byte-identical except alphabet | unify into one `lib/base64.ts` | 7 |
| M15 | core+canister+app | `RETRIEVE_BTC_MIN_AMOUNT=50_000` in types.rs + ledger.rs + catalog.ts; `MINT_ACCOUNT=[0xFF;32]` in types.rs + ledger.rs + `MINT_HEX` format.ts — 2 literals × 3 locs, no drift alarm | single `dpay-core` consts + jest drift alarm (catalog_truth.json pattern) | 9 |
| M16 | android+core | NFC AIDs duplicated as Kotlin/Rust byte literal + XML hex (no compile-time link → silent routing break on mismatch) | build-time test decoding XML + asserting byte-equality | 7 |
| M17 | android | NFC card-side `onCardApdu` catch returns SW with no `errorEvent` (asymmetric w/ reader side): DpayNfc.kt:147, DpaySolNfc.kt:186 | `errorEvent(...)` before SW | 7 |

### LOW (do now, quick)

| # | area | finding | fix | conf |
|---|---|---|---|---|
| L1 | app-ts | SolReceiveMode inlines magic `300` (×2) for request-expiry instead of `EXPIRY_WINDOW` | import const | 8 |
| L2 | app-ts | Dead Rust `request_to_frames` (nfc.rs:1058) — zero callers | delete | 10 |
| L3 | app-ts | Unused `export` keywords: walletconnect PAIR_TIMEOUT_MS, cketh bytesToHex/selectors, nonce NONCE_ACCOUNT_LENGTH, solana SolReceipt | drop `export` | 9 |
| L4 | app-ts | `btn-share-receipt` (PayMode:184) wired but NO e2e coverage | add e2e flow | 8 |
| L5 | app-ts | BUNDLED_CATALOG missing ckETH mainnet (id 6) — cold load shows only 3 of 4 mainnet assets until live fetch | add entry | 7 |
| L6 | android | NFC `emit()` catch fully silent (DpayNfc.kt:71, DpaySolNfc.kt:82) | `Log.w` | 6 |
| L7 | relay | `connect_with` `fetch_root_key` no timeout (local-replica boot) | optional timeout | 6 |
| L8 | deploy | `dfx-deploy.sh` ICRC Init literal not factored (staging did) | move to dfx-lib.sh | 7 |

## Fix partition (parallel by file ownership — no race)

- **Subagent RELAY** (`crates/dpay-relay/**`): M1, M2, M3, M4, M5, L7. Relay-only.
- **Subagent CANISTER** (`crates/dpay-canister/**`): M6, M7, + define single Rust consts for M15 (RETRIEVE_BTC_MIN_AMOUNT, MINT_ACCOUNT in types.rs or core). Canister-only.
- **Subagent APP-TS** (`app/**/*.ts|.tsx` excl android + `app/__tests__`): M8, M9, M11, M12, M13, M14, L1, L3, L4(e2e), L5 + jest drift alarms for M15 (read catalog_truth.json/core). App-TS-only.
- **Subagent CORE+ANDROID** (`crates/dpay-core/**` + `app/android/**`): M16, M17, L2, L6. core+android-only.
- **Subagent TYPECHECK+DOCS** (sequenced AFTER the above): M10 (add flags once M8 clean) + AGENTS.md deploy-command note + OPEN_ISSUES founder-op-DONE strike + this plan's status.
