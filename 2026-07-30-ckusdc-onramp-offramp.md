# Plan — REAL ckUSDC onramp/offramp + multi-currency scaling

> Created 2026-07-30 by orchestrating two investigation/planning subagents (IC-mechanism+gap;
> multi-currency UI/UX). **Read alongside `CLAUDE.md` (§Funding), `OPEN_ISSUES.md` (issues 1,6,7,8,9),
> `CODEBASE_ANALYSIS.md` (risk 7), and the sibling plan `2026-07-30-ux-e2e-radical.md`.**
>
> Non-negotiables honored: NON-CUSTODIAL, NO SWAPS, NO exchange creds, user never sees "supported
> vs unsupported", backing native symbol shown (raw `ck*`/ledger ids never surfaced). Verified by the
> mechanism subagent: the ckUSDC path is **non-custodial** (dpay never touches the ETH key / USDC) and
> **no-swap** (ckUSDC is the same USDC asset 1:1, not a conversion).

---

## 0. THE LINCHPIN FACT (load-bearing — read first)

**ckUSDC is NOT a ckBTC-style chain-key token. It is a ckERC-20 token handled by the ckETH minter,
with a completely different onramp/offramp mechanism.** dpay's existing ckBTC proxy
(`get_btc_address` / `update_balance` / `retrieve_btc_with_approval` + the `MinterAccount` /
`UtxoStatus` mirror types) **does NOT generalize to ckUSDC and cannot be reused**.

There are **at least THREE distinct ck-minter API families** on IC — "generalize the ckBTC proxy"
is the wrong frame; the right frame is **per-family ramp dispatch** keyed off a registered
`minter_family` per currency:

| Family | Tokens | Minter | Deposit model | Withdraw model |
|---|---|---|---|---|
| **UTXO-minter** (what dpay built) | ckBTC, ckDOGE | `mqygn-…` | per-principal native addr via `get_btc_address`; `update_balance` triggers mint | `retrieve_X_with_approval` — single-ledger approve |
| **ckETH/ckERC20** (ckUSDC) | ckETH, ckUSDC, ckEURC… | `sv3dd-oaaaa-aaaar-qacoa-cai` | **NO IC deposit method.** Static Ethereum helper contract; minter scrapes ETH logs on heartbeat | `withdraw_erc20` — **DUAL-ledger** approve (ckETH gas + ckERC20 amount) |
| **ckSOL** (roadmap) | ckSOL | `lh22c…` (`dfinity/cksol`) | `get_deposit_address`; `process_deposit` (cycles-paid RPC) | threshold-Ed25519 `withdraw` |

> **ICRC ledger layer (balance / pay / history) already works for ckUSDC with ZERO code change** if
> the ckUSDC ledger is `register_ledger`'d — it is pure ICRC. Only the *ramp* (deposit address /
> mint trigger / withdraw) is ckBTC-shaped and needs new surface.

---

## 1. IC mechanism — ckUSDC onramp & offramp (verified, cited)

Sources: ICP docs (`docs.internetcomputer.org/guides/digital-assets/chain-key-tokens/`, `…/references/chain-key-canister-ids/`); DFINITY `ic` repo `rs/ethereum/cketh/docs/ckerc20.adoc` + `minter/src/endpoints.rs` + `endpoints/ckerc20.rs` + `lib.rs`.

- **ckUSDC ledger**: `xevnm-gaaaa-aaaar-qafnq-cai` (ICRC-1, **6 decimals**).
- **ckETH minter** (shared by ckETH + all ckERC20): `sv3dd-oaaaa-aaaar-qacoa-cai`.
- **USDC ERC-20** (Ethereum mainnet): `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
- **ckERC-20 helper contract**: `0x18901044688D3756C35Ed2b36D93e6a5B8e00E68` (read at runtime from
  `get_minter_info.deposit_with_subaccount_helper_contract_address` — **never hardcode**, it can
  change on minter upgrade).

### 1a. Onramp (USDC → ckUSDC) — informational on dpay's side
- **No per-principal IC deposit address, no user-callable mint trigger.** The user performs TWO
  Ethereum transactions from their OWN wallet (not dpay — that would be custody):
  1. `approve(helper, amount)` on the USDC ERC-20 contract.
  2. `depositErc20(token_id, amount, principal_as_bytes32, subaccount)` on the helper contract.
- The helper `transferFrom`s USDC to the minter and emits `ReceivedEthOrErc20(...)`; the minter
  **scrapes Ethereum logs on a heartbeat timer** (~3 min: `SCRAPING_ETH_LOGS_INTERVAL`, `MINT_RETRY_DELAY`)
  and mints ckUSDC to `(principal, subaccount)` on the ckUSDC ledger. Total credit ~20 min.
- dpay's "deposit address" = the **static helper contract** + the encoded `(principal, subaccount)`
  the user must pass in `depositErc20` calldata. dpay's `refresh_deposit` has **no minter call** —
  "refresh" = re-read the ckUSDC ledger balance; "pending" can only be inferred from ETH tx
  confirmation, not an IC minter reply.
- `get_minter_info()` exists but returns a **totally different shape** than ckBTC's
  (`…helper_contract_address`, `supported_ckerc20_tokens`, `minimum_withdrawal_amount`,
  `last_gas_fee_estimate`, `cketh_ledger_id`, `evm_rpc_id`, …).
- **Non-custodial + cleaner than ckBTC on the onramp:** dpay never touches the ETH key / USDC and
  is not in the deposit flow at all — the minter credits the ledger at the user's subaccount directly.

### 1b. Offramp (ckUSDC → USDC) — the HARD half
- Method: `withdraw_erc20(WithdrawErc20Arg) -> Result<RetrieveErc20Request, WithdrawErc20Error>`
  on the ckETH minter.
  - `WithdrawErc20Arg { amount; ckerc20_ledger_id; recipient: text /* 0x… */; from_cketh_subaccount; from_ckerc20_subaccount }`.
  - `RetrieveErc20Request { cketh_block_index; ckerc20_block_index }` (status via `retrieve_erc20`).
  - `WithdrawErc20Error { TokenNotSupported | RecipientAddressBlocked | CkEthLedgerError | CkErc20LedgerError{partial→reimbursement} | TemporarilyUnavailable | … }`.
- **DUAL-ledger approve** (ckBTC is single): `icrc2_approve(minter, gas_fee)` on the **ckETH ledger**
  + `icrc2_approve(minter, amount)` on the **ckUSDC ledger**, then `withdraw_erc20`.
- **The user MUST hold ckETH to pay Ethereum gas** (ERC-20 transfers need ETH gas; minter burns
  ckETH to fund it). This is a funding dependency the app must surface (and arguably needs its own
  ckETH onramp — compounding scope).
- Ethereum-mainnet-only today (chain_id exists architecturally for multi-chain, but only mainnet is live).
- minter enforces an Ethereum-address **blocklist** on deposit sender + withdrawal recipient.

---

## 2. Code gap (what exists → what must change)

Ordered must-do-first. File:line refs are current as of this analysis.

### Canister `crates/dpay-canister/src/lib.rs`
- **`MINTERS` registry** (lib.rs:559-562) maps `currency → PrincipalStorable` (minter principal) but
  carries **no family/shape info**. → add a `minter_family` (enum `CkBtcUtxo | CkEthErc20 | CkSol | …`)
  to the minter registry value (new MemoryId; 9 is taken by FAUCET_COOLDOWN, 13+ free) OR a parallel
  `MINTER_FAMILIES` map.
- **Deposit proxy is ckBTC-only** (`deposit_address`→`minter_call_btc_address`, `refresh_deposit`→
  `minter_call_update_balance`, `deposit_info`→`minter_call_minter_info`+`_deposit_fee`; mirror types
  `UtxoStatus`/`UpdateBalanceError`/`PendingUtxoMirror`/`MinterInfo` lib.rs:706-740,749-753). For
  ckERC20 the deposit branch returns the **static helper address + encoded principal/subaccount**
  (no minter call for the address either; read from `get_minter_info`), and `refresh_deposit` is a
  **no-op-success** ("minting is heartbeat-driven; re-read balance"). Needs a parallel ckETH `MinterInfo`
  mirror + dispatch on `minter_family`.
- **Withdraw proxy is ckBTC-only** (`withdraw` lib.rs:1669-1816 → single `icrc2_approve` + `retrieve_btc_with_approval`;
  `RetrieveBtcWithApprovalArgs`/`RetrieveBtcWithApprovalError` lib.rs:772-793). For ckERC20: dual
  `icrc2_approve` (ckETH + ckUSDC ledgers) + `withdraw_erc20`, decoding `WithdrawErc20Error`. Requires
  knowing **two** ledger principals per ckERC20 currency (ckETH + the ckERC20 ledger) — `ledger_for(currency)`
  returns one today → needs the ckETH gas ledger resolved too.
- **`RETRIEVE_BTC_MIN_AMOUNT=50_000`** (lib.rs:770) is ckBTC sats; ckUSDC min is dynamic
  (`MinterInfo.minimum_withdrawal_amount`, USDC 6-decimal units).
- **`WithdrawAuth`** (`dpay-core/src/lib.rs:154-167`) binds a single BTC-address field named for BTC.
  Generalizing the signed withdrawal to carry a chain-agnostic destination + currency + (ckERC20)
  the ckETH gas subaccount is a **core wire-shape change** (FROZEN-field discipline applies — additive
  or versioned, decide). Must keep the on-device-signature non-custodial gate.

### Relay `crates/dpay-relay/src/{ledger.rs,app.rs,agent_ledger.rs}`
- **`Ledger` trait** deposit/withdraw types (`MintedUtxo`/`PendingUtxo`/`DepositRefresh`/`DepositInfo`
  ledger.rs:85-117; `WithdrawRequest`/`WithdrawReceipt` 130-151) are **UTXO-shaped**. For ckERC20 the
  deposit payload differs (helper address + encoded principal + "watch your balance") and withdraw
  needs the ckETH-gas notion.
- **The `?currency=N` query param** (app.rs:287,310,328) is the right dispatch key — **no new route URLs
  needed**; relay already routes per-currency. `deposit_address` returns the helper contract for ckERC20
  currencies; `deposit/refresh` becomes a balance-only re-read. `AgentLedger` (agent_ledger.rs:321-449)
  hard-codes the ckBTC candid decode → needs new mirror structs for the ckERC20-family facade replies
  (preferred: keep facade reply SHAPES stable and only the calls differ).
- **`RETRIEVE_BTC_MIN_AMOUNT`** (ledger.rs:31) + app `WITHDRAW_MIN_SATS` (App.tsx:157) must become
  per-currency.

### App `app/App.tsx`
- Hard-coded ckBTC constants to delete/generalize: `DEPOSIT_CURRENCY=1` (152), `DEPOSIT_NETWORK='Bitcoin'`
  (218), `DEPOSIT_ASSET='BTC'` (219), `BTC_BLOCK_MIN=10` (220), `WITHDRAW_MIN_SATS=50_000` (157),
  `DEPOSIT_REFRESH_MS=10_000` (153). `DepositSheet` (1263-1442) + `WithdrawSheet` (1451+) hardcode
  "Send BTC to Bitcoin address", a BTC QR, UTXO confirmation meter, `bc1q…` input, `btc()` formatting.
- → make both sheets **currency/chain-aware**, driven by per-currency metadata (network/asset symbol/
  address placeholder/min/units formatter/chain family). For ckUSDC: network "Ethereum", asset "USDC",
  "address" = helper contract + copyable `depositErc20` calldata (principal-as-bytes32 + subaccount),
  status = "watching for your mint (~20 min)", withdraw input = `0x…` Ethereum address, USDC 6-decimal
  formatting.

### Config coupling (OPEN_ISSUES #7)
- `DEPOSIT_CURRENCY=1` single-sourcing breaks worse under multi-currency. **Resolution:** add a canister
  query `currencies() -> Vec<CurrencyDescriptor>` joining `LEDGERS`+`MINTERS`+new metadata; relay
  `GET /api/v1/currencies`; app reads currency ids/metadata at runtime (cache in AsyncStorage, bundled
  default fallback when offline) → **never hardcodes a currency id again.** This closes #7 and is the
  precondition for the multi-currency UI.

### Mock-minter / tests `crates/dpay-mock-minter/src/lib.rs`
- The mock mirrors the **ckBTC** minter candid exactly (the honesty guard that caught the live trap).
  A ckERC20 onramp **cannot be mocked the same way** (no IC minter deposit method; minting is
  ETH-event-driven). Offline ckUSDC onramp proof = register the ckUSDC ledger + seed a balance via
  test-helpers, assert `balance_of`/`pay` work (they will — pure ICRC). The **offramp** (`withdraw_erc20`)
  needs a new mock-minter variant mirroring the ckETH minter's dual-ledger `withdraw_erc20`.

---

## 3. UI/UX design summary + data contract (full spec in §5 of design subagent report)

Unified "Add money" / "Cash out" that scales config-only to many currencies/chains, with per-currency/chain instructions, hiding direct-vs-partner from the user.

### 3a. IA & entry points
- Header: primary balance + **`＋ Add money`** + **`⇄ Cash out`** (new) with real right padding (fixes N9
  glow-clip). **Remove the `+$50` faucet from the header** → Settings, demo-labeled (closes N1/N2/N9;
  surfaces cooldown per N5).
- Generalize the single `asset-ckbtc` card → a stack of **`AssetCard`s** (one per catalog asset with
  balance>0 or onrampable), each with `＋ Add` / `⇄ Cash` deep-links that skip the picker.
- Sheets stack above the wallet (never a separate surface): `AssetPickerSheet(mode)` →
  `DepositFlowSheet`/`WithdrawFlowSheet({asset, chain?})`. `ChainSelector` appears when
  `asset.chains.length > 1`.

### 3b. The data contract (single-sourced; "add a currency = config-only")
```ts
type CurrencyDescriptor = {
  key: string;                 // stable id, never shown: "usd"|"btc"|"eth"|"eur"|"icp"
  currency: number;            // Currency u32 — read from canister, NEVER hardcoded
  kind: 'fiat-stable' | 'crypto';
  display: { backingSymbol, backingLabel, wrapperSymbol?, decimals, unitName };
  rail: 'direct' | 'partner' | 'static';   // HIDDEN from the user
  chains: ChainConfig[];       // one+ deposit/withdraw chains
  partner?: PartnerConfig;     // present when rail !== 'direct'
  primary?: boolean;           // the header-balance asset (USD)
};
type ChainConfig = { chainKey, networkLabel, nativeAsset, addressKind, minConfirmations,
                     depositFee?, minAmount?, estBlockMinutes, withdrawMinRaw?, defaultChain? };
type PartnerConfig = { provider, mode:'widget'|'handoff'|'static', widgetUrlTemplate?,
                       handoffUrlTemplate?, staticSteps?, kyc:'provider'|'none', estFeeNote? };
```
- New canister query **`currencies() -> Vec<CurrencyDescriptor>`** + relay **`GET /api/v1/currencies`**.
- **`formatAmount(raw, display)`** replaces hardcoded `usd()`/`btc()` (backing-symbol rule enforced).
- **`InstructionCard({asset, chain, direction, depositInfo?})`** — pure presentational, config-driven,
  supersedes the hand-coded `instrCard`. Worked examples (see spec §4.5): ckUSDC direct (Ethereum),
  ckBTC direct (Bitcoin), SOL partner/static.

### 3c. Add money / Cash out flows (state machines)
- **Add money:** `intro → (ChainSelector) → address|provider → instructions → watching → credited`.
  The `address` step renders by `rail`: `direct` = QR + native address + Copy; `partner` = embedded
  widget/handoff with dpay's ck-asset deposit addr prefilled; `static` = "go here, then send to X".
  `watching` = `POST /deposit/refresh?currency=N` poll + manual `Check now`.
- **Cash out:** `intro → form (dest addr + amount, paste affordance) → instructions → review →
  submitting (on-device sign `WithdrawAuth`) → done|error`.
- **N7 fix:** distinguish 503-transient ("reconnect") from "no minter" (→ pivot to partner/static rail
  for that asset, framed as "use [provider]", NEVER "unsupported").

### 3d. A11y / keyboard / paste (closes N10 + UX-V5)
- Enter-to-confirm on every primary action; `A`=Add, `C`/`W`=Cash out, `Esc`=close, `↑/↓` picker,
  `←/→` chain. Paste affordance (`navigator.clipboard.readText()` + native paste). Hint line when no
  text field focused.
- New testIDs: `btn-cashout`, `asset-picker`, `asset-picker-row-<key>`, `chain-selector`,
  `chain-opt-<chainKey>`, `partner-panel`, `btn-paste`, `instruction-card`, `flow-err-no-minter`,
  `flow-err-unreachable`.

### 3e. Offline fit
- Onramp/offramp **require a connection** (distinct from core offline-PAY). When offline, show
  *"Not connected — Add money / Cash out need a connection. Your payments still work offline."*
  The airplane-mode demo stays pure (exercises Pay/Receive/NFC only).

---

## 4. Waves of work (sequencing)

> Folds into the active plan `2026-07-30-ux-e2e-radical.md`. The onramp is the easy half
> (informational); the offramp is the hard half (dual-ledger + ckETH gas). Recommend
> **onramp-first + multi-currency-metadata (#7) + the shared UI refactor** before the ckERC20 offramp.

**Wave M0 — foundations (closes issue #7, unblocks everything)**
- Canister `currencies() -> Vec<CurrencyDescriptor>` (join `LEDGERS`+`MINTERS`+new metadata store;
  `minter_family` field). Relay `GET /api/v1/currencies`. App reads + caches catalog, **deletes
  `DEPOSIT_CURRENCY`**. `formatAmount` per-asset formatter.

**Wave M1 — shared multi-currency UI refactor (rides on the UX-F waves)**
- `AssetPickerSheet`, generalized `AssetCard`, `DepositFlowSheet`/`WithdrawFlowSheet` + `InstructionCard`
  + `ChainSelector` + `PartnerPanel`. Header rework (Add/Cash out, faucet→Settings, N9 padding). Settings
  screen with reset-confirm (UX-V2/V3). Keyboard shortcuts + paste (N10/UX-V5). N7 error distinction.

**Wave M2 — ckUSDC ONRAMP (real stable, the user's headline ask)**
- Canister: add `CkEthErc20` family; `deposit_address` returns helper contract + encoded principal/
  subaccount; `deposit_info` reads the ckETH `MinterInfo`; `refresh_deposit` = no-op-success (heartbeat
  mint). Relay: `?currency=N` dispatch to the ckERC20-family facade replies. App: ckUSDC
  `CurrencyDescriptor` (Ethereum chain), `InstructionCard` (approve+depositErc20 steps, ~20 min,
  wrong-network warning). **Mostly informational; fully non-custodial.**
- Verify live before shipping (§6 open Qs).

**Wave M3 — ckUSDC OFFRAMP (the hard half)**
- Core wire-shape change: generalize `WithdrawAuth` (chain-agnostic destination + currency + ckETH gas
  subaccount; decide additive vs versioned; keep on-device sig gate). Canister: dual-ledger
  `icrc2_approve` (ckETH gas + ckUSDC) + `withdraw_erc20`, decode `WithdrawErc20Error`, surface
  partial-failure/reimbursement. ckETH gas dependency UX ("hold ckETH for gas"). New mock-minter variant
  for the ckERC20 withdraw (honesty guard). Document the dual-approve front-running residual (extends
  issue #9 / risk 8).

**Wave M4 — partner/static rail + many currencies (roadmap readiness)**
- `PartnerConfig` (Onramper/Transak): widget/handoff/static modes with dpay deposit addr prefilled.
- ckETH asset (also CkEthErc20 family — reuse). EUR/EURC (verify ckEURC). ckSOL (third family —
  separate proxy if SOL enters scope).

---

## 5. Non-negotiables check (verified)

- **Non-custodial: PRESERVED (cleaner on the onramp).** ckUSDC deposit value-movement is the USER's
  Ethereum tx from their own wallet; dpay never touches the ETH key/USDC. The minter credits the ckUSDC
  ledger at the user's subaccount directly. Offramp keeps the on-device-signature gate before any burn.
- **No-swap: PRESERVED.** ckUSDC↔USDC is a 1:1 bridge retrieve, not a conversion; no price risk, no quote.
- **No exchange creds: PRESERVED.** User authorizes the helper/minter directly; dpay holds nothing.
- **NEW risks to document (extend risk 8 / issue 9):**
  1. **Dual-approve front-running** — ckERC20 `withdraw_erc20` approve-then-retrieve across `await`s
     with the same bounded blast radius (exact authorized amount, single-use) as ckBTC, PLUS a
     dual-approve window. Inherent to the ckETH minter (every `withdraw_erc20` client carries it).
  2. **Partial-failure** — `CkErc20LedgerError` after `CkEthLedgerError` → minter schedules a
     reimbursement, not an atomic fail. New terminal state to surface.
  3. **ckETH gas dependency** — offramp requires the user hold ckETH (gas). Funding dependency.
  4. **Blocklist** — minter enforces ETH-address blocklist on deposit sender + withdrawal recipient.

---

## 6. Open questions (verify before implementation; founder decisions flagged 🚩)

1. **🚩 ckUSDC direct vs partner at launch** — does direct ckUSDC deposit ship before the partner
   fallback, or together? (Design is rail-agnostic; only sets the descriptor's `rail`.) Recommend
   direct-onramp-first (M2) since it's informational + fully non-custodial.
2. **🚩 Partner aggregator** — Onramper vs Transak vs Changelly? widget/handoff/static for v0? Geo/fees/licensing.
3. **🚩 KYC surfacing** — confirm partner KYC is entirely provider-side (dpay collects ZERO PII) and dpay
   only shows "complete identity at [provider]".
4. **🚩 ckUSDC chains at launch** — Ethereum only, or also Solana/Polygon/Base? (Determines ChainSelector.)
5. **🚩 Fees/monetization on ramp** — confirm ramp fees are the partner's/minter's, passed through with
   zero dpay cut (no counterparty/price risk). See `monetization.md`.
6. **🚩 Persist relay URL / Settings** — onramp/offramp reliability wants `relayUrl` persisted (AsyncStorage);
   fold with the Settings screen + reset-confirm (UX-V2/V3). Also: keep the demo faucet at all once real
   ckUSDC exists? (N1/N2/N5/N9 say move it to Settings, demo-labeled.)
7. **Verify live `get_minter_info`** for ckUSDC: confirm `deposit_with_subaccount_helper_contract_address`,
   current `minimum_withdrawal_amount`, ckUSDC in `supported_ckerc20_tokens`. →
   `dfx canister --network ic call sv3dd-oaaaa-aaaar-qacoa-cai get_minter_info`.
8. **Verify ckUSDC ledger params** — `icrc1_decimals` (expect 6), `icrc1_fee`, `icrc1_symbol`, `icrc1_logo`.
   → query `xevnm-gaaaa-aaaar-qafnq-cai`.
9. **Pending-deposit query?** Confirm there is NO per-account "pending ckERC20 mint" IC query (unlike
   ckBTC's UTXO pending). Determines whether deposit status shows anything better than "watching your balance".
10. **`withdraw_erc20` status endpoint** — confirm `retrieve_erc20(RetrieveErc20Request)` exists + status
    enum (sending/sent/finalized/reimbursed) via the minter `.did`.
11. **Principal→bytes32 encoding** for `depositErc20` — confirm the exact transform the helper contract
    expects for the facade principal (`cketh-principal-to-hex`). **Must be correct (wrong = lost funds).**
12. **ckETH gas account model** — does `from_cketh_subaccount` require registering the ckETH ledger at the
    facade + the user holding ckETH there? Confirm the gas-burn account.
13. **`WithdrawAuth` wire change** — additive field vs versioned for the chain-agnostic destination + ckETH
    gas subaccount; confirm offline-payer signature path stays intact.
14. **🚩 Wrong-network recourse** — confirm honest messaging (direct-minter wrong-asset/chain = generally
    lost; partner may offer recovery). Preemptive InstructionCard warning is the only defense.

---

## 7. Verification gates (per wave)

- **M0:** `just test-canister` (new `currencies()` test); `just test-relay` (new route); app renders
  catalog without hardcoding ids; e2e still 16/16 (or expanded).
- **M2 (onramp):** register ckUSDC ledger on PocketIC → balance/pay/history work (pure ICRC); relay
  `?currency=N` returns helper address + encoded principal; app shows ckUSDC Add-money instructions;
  live `get_minter_info` sanity check.
- **M3 (offramp):** new mock-minter ckERC20 honesty guard; `just test-canister` dual-ledger withdraw +
  `WithdrawErc20Error` paths; e2e withdraw-error flow (false-confidence fix from the harness review);
  document dual-approve front-running in OPEN_ISSUES/CODEBASE_ANALYSIS.
- All waves: `just verify` green; no new mock broader than the smallest-boundary rule; constants
  single-sourced; all I/O has timeouts; no silent errors.

---

*Investigation complete. Founder decisions locked below (2026-07-30).*

---

## 8. LOCKED founder decisions + hard constraints (2026-07-30)

All forks resolved. This section supersedes the 🚩 open questions in §6 where they conflict.

### Decisions
1. **Onramp: direct first** (ckETH-minter path). Partner support LATER (static mode as v0). Partner
   candidates to evaluate when built: **NowPayments** (founder-suggested) + Onramper/Transak.
2. **Partner mode: static first** (zero-integration instructions page; dpay just shows deposit addr + steps).
3. **KYC: dpay does ZERO KYC, collects ZERO PII.** Partner handles all KYC; dpay only shows "complete
   identity at [provider]". Maximize smoothness within that constraint.
4. **Chains: Ethereum only at launch.** ChainSelector ready but ships with one chain.
5. **Fees: ZERO dpay cut initially** (building customer base). Pass through partner/minter costs only.
6. **Demo faucet: KEEP.** Clearly label **"Demo$"** in the currency-selection UI; make it the **DEFAULT
   currency for now** (real ckUSDC is a secondary asset card until user funds it). Also moves to Settings
   (demo-labeled, cooldown surfaced) per N1/N2/N5/N9.
7. **Wrong-network: honest, prominent, preemptive warning** above the address (no false recovery promise).
8. **Fork A = A1 (wallet-connect flow for ONRAMP).** ckUSDC direct deposit is a contract CALL
   (`approve` + `depositErc20` with encoded principal/subaccount), NOT a plain transfer — "send to
   address, done" is impossible. A1: user connects their own Ethereum wallet (MetaMask/Rabby via
   WalletConnect on Android, `window.ethereum` on web); dpay BUILDS the approve+depositErc20 txs; the
   user's wallet SIGNS them; dpay never sees the key (standard non-custodial dApp pattern; not custody,
   not an exchange credential). Build web/browser-wallet first (matches e2e harness), WalletConnect-Android after.
9. **Fork B = offramp is the NEXT wave, MUST be "NUTS simple".** Good news: offramp needs NO
   wallet-connect — it's an ICP-side action gated by the **on-device dpay Ed25519 key** (the existing
   sign path). So Cash out = pick saved external address + amount → confirm → done. Add a
   **Profile/Settings section** that stores the user's saved external address(es) (one per chain,
   last-used default) + username; use it for semi-automatic offramp.
10. **Fork C = defer gas; when done, gas-via-THIRD-PARTY not dpay.** "Convert some funds to gas" = a
    swap; the no-swap non-negotiable forbids dpay doing it. Compliant form: the USER authorizes a third
    party to do the tiny ckUSDC→ckETH conversion directly (dpay = screen only). HARD CONSTRAINT — never
    let dpay take price risk / hold funds / do the conversion.

### HARD constraints (from founder, non-negotiable)
- **C-UI:** the multi-currency UI MUST be genuinely smooth + cohesive, not clunky or randomly assembled.
  Treat visual/flow polish as a first-class acceptance gate, not an afterthought.
- **C-MOCK:** a mock is ONLY acceptable if it can be PROVEN to be an absolutely accurate representation
  of the real external interface being mocked. For the wallet-connect seam this means the constructed
  approve+depositErc20 calldata is byte-exact vs the REAL helper-contract ABI / function selectors /
  principal→bytes32 encoding, pinned from authoritative sources — NOT invented. HARD MUST.
- **C-CONF:** must be testable fully autonomously in the offline inner loop, iterating to **≥9/10
  confidence prod-ready** before considering a wave done. Real Ethereum tx / radio hops remain outer-loop gates.

### Build sequence (consolidated with `2026-07-30-ux-e2e-radical.md`)
Per founder's "fix all documented pre-existing issues first" (m0001), the F/E waves precede M-waves.
Execution order: **E-fast-poll** (harness 23s→6-8s, accelerates everything) → **F-wave fixes**
(N3 deploy blocker; N1/N2/N4/N5 faucet divergence + labels + cooldown; UX-V2/V3 Settings+confirm;
N6 usernames; N10 paste-request; keyboard shortcuts) → **M0** (currencies() catalog, closes #7) →
**M1** (multi-currency UI: AssetPicker/AssetCard/DepositFlow/WithdrawFlow/InstructionCard, header
rework, Profile/Settings) → **M2** (ckUSDC direct onramp w/ wallet-connect, C-MOCK calldata golden) →
**M3** (offramp: WithdrawAuth wire generalize, dual-ledger approve, NUTS-simple saved-address flow;
gas deferred per Fork C) → **V** verify + update OPEN_ISSUES/CODEBASE_ANALYSIS/AGENTS.

Orchestrate via subagent swarms; TDD (RED then GREEN); commit each unit; no backward-compat/dead-code;
constants single-sourced; all I/O has timeouts; no silent errors.
