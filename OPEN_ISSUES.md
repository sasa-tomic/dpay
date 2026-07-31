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

### 7. (low) App↔canister config coupling ✅ CLOSED (M0)

- ✅ **RESOLVED** by the `currencies()` catalog (commits 849ad59/66703af/736746d): the app now fetches +
  AsyncStorage-caches currency ids/display metadata at runtime (`GET /api/v1/currencies`) and keys ramp
  assets off `minter_family` instead of a hardcoded `DEPOSIT_CURRENCY=1`. Adding a currency is
  canister-config-only (`register_ledger`/`register_minter`/`register_currency_meta` — no app redeploy).
  Verified live: mainnet `GET /api/v1/currencies` returns all 3 (DEMO_USD, ckBTC/CkBtcUtxo, ckUSDC/CkEthErc20).

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

## UX review findings (2026-07-30)

> **Status (F-wave, commit bb315ba):** N2/N4/N5/N7/N8/N9/N10 + UX-V2/V3 are **FIXED** (SettingsSheet
> with reset-confirm; faucet moved off header + label/amount corrected + real cooldown surfaced; mint
> sentinel labeled "Demo funds"/"Withdrawal"; deposit error distinguishes no-minter vs transient;
> onboarding testID + Enter-to-create; header right-padding; paste-request affordance). N3 deploy
> blocker fixed (`scripts/dfx-deploy.sh` sets controller before `register_ledger`). **Deferred:** N1
> (FakeLedger has no rate-limit — accepted simplification; real cooldown is surfaced in the UI); N6
> (counterparties are raw hex — needs the username carried in the signed payload, overlaps with a core
> wire change); UX-V5 full single-key shortcuts (only Enter-to-create shipped; polish). ✅ **UX-V5
> FIXED (1b):** full keyboard surface shipped — `useHotkeys` (single source of truth; `useEscapeToClose`
> delegates to it) wires P=Pay / R=Receive / T=Top-up / A=Add money on the Wallet main view (input +
> sheet-open guarded; web-only), with always-visible-but-subtle on-UI hint badges on each target.
>
> From a NO-MOCK UX review: the REAL web app (`app/App.tsx`, react-native-web) driven through
> chrome-cli against the REAL canister (facade + ic-icrc1-ledger on a local dfx/PocketIC replica) via
> the relay's `AgentLedger` (`--features agent`). Every money path (onboard/faucet, two-wallet
> Pay→settle→Receive, history, offline, reset) ran against the real ledger — only the camera scan is
> shimmed (the sanctioned smallest-boundary seam; decode/sign/verify/settle are all real). Screenshots
> in `e2e/shots/` + this session's `/tmp/ux/`. The e2e harness uses `FakeLedger`, which **masks** two
> of the divergences below (N1/N2) — those are invisible to `just e2e`.

### CONFIRMED already-known seed items (from `2026-07-30-ux-e2e-radical.md`)
- **UX-V2 CONFIRMED** — a `LEDGER` settings bar (the `settings-relay` TextInput seeded with the relay
  URL, e.g. `http://127.0.0.1:8787`) + a bare red `reset` link sit on the MAIN wallet screen. Dev-facing.
- **UX-V3 CONFIRMED** — `reset` wipes the on-device identity with **NO confirmation**: one tap →
  `AsyncStorage.removeItem` → straight back to onboarding (verified: identity gone, onboarding shown,
  no dialog). A user loses access to the funds at that pubkey irreversibly.
- **UX-V4 CONFIRMED** — header is crowded: `$balance` + `+$50` outline pill + filled `＋ Add money` all
  share one right-aligned row; the `Add money` right edge lands at 389/390 px (viewport-kissing).
- **UX-V5 CONFIRMED → ✅ FIXED (1b)** — only `Escape` was wired (`useEscapeToClose`, sheets only); no
  global shortcuts (no Enter-to-submit on onboarding/amount, no T/A/R action keys), and the only
  on-UI hint was "Press Esc to close" inside the deposit/withdraw sheets. **Now resolved:** the
  wallet is fully keyboard-driveable (P/R/T/A + Esc) via `useHotkeys`, with on-UI hint badges.
- **UX-V1 REJECTED** — the `＋ Add money` button text is **NOT truncated** at standard balances
  (`scrollWidth == clientWidth == 111`; full "＋ Add money" renders). The original "+ Add mo" claim is
  not reproducible. Reframed as the edge-kissing/glow-clip issue N9 (P3).

### NEW findings
- **N1 (high) | functional | wallet header | The `+$50` faucet top-up button is BROKEN against the real
  canister for ~1 hour after onboarding.** Onboarding consumes the canister faucet's once-per-hour
  slot (`FAUCET_COOLDOWN_SECS = 3600`); the `+$50` button calls `/api/v1/faucet` again and the canister
  rejects it (`"faucet cooldown: try again in ~58 min"` → 422). The app then shows "Faucet unavailable"
  and the balance is unchanged. Reproduced live. The e2e harness (`FakeLedger`) has **no rate limit**,
  so flow 02-faucet passes while the real path fails — a false-confidence divergence.
  *Fix:* surface the cooldown (the canister already returns the retry time) and either disable the
  button while cooling down, or make the demo top-up a separate non-rate-limited path. Reconcile
  FakeLedger's faucet with the canister's (rate-limit + fixed-amount) so e2e catches this.
- **N2 (medium) | functional | wallet header | The `+$50` button would mint `$100`, not `$50`, even when
  it works.** The canister `faucet(blob, nat32)` has **no amount parameter** and mints the fixed
  `FAUCET_AMOUNT` ($100); `AgentLedger::faucet` takes `_amount` and discards it. `FakeLedger` honors the
  requested 5000 ($50). So the button's label is wrong against the real ledger.
  *Fix:* either let the canister faucet honor a capped requested amount, or relabel the button to the
  fixed amount and stop sending `amount`.
- **N3 (high) | functional/deploy | canister | `register_ledger` is DENIED in open-demo mode
  (`controller == null`)**, returning `"admin ops disabled: no controller set"`. This **breaks the
  documented `scripts/dfx-deploy.sh`**, which installs the facade with `ledgers = vec {}` then relies on
  an open `register_ledger` call. It also contradicts `CODEBASE_ANALYSIS.md` and the `.did` comment
  ("open only when controller is unset, i.e. the demo") — R1 actually locks down ALL admin ops when the
  controller is null. Verified live (register_ledger → Err until a controller was set via `set_controller`).
  *Fix:* either seed the ledger at `init` (correct for `dfx-deploy.sh`), or fix `dfx-deploy.sh`/docs to
  set a controller first. Correct the `.did` + `CODEBASE_ANALYSIS.md` comments.
- **N4 (medium) | visual | history + receipt | The faucet mint surfaces as a transaction `from ffffffff…`
  (the raw `MINT_ACCOUNT` 0xFF sentinel).** Internal protocol data leaks to end users as a
  counterparty. *Fix:* label mint/burn rows as "Faucet"/"Demo funds" (or hide them) instead of the hex
  sentinel.
- **N5 (medium) | flow | wallet header | "Faucet unavailable" discards the helpful reason.** The canister
  returns `"faucet cooldown: try again in ~58 min"`; the app maps any non-OK to the generic "Faucet
  unavailable" (App.tsx `topUp`). The user gets no clue why or when to retry. *Fix:* surface the relay's
  error body (or parse "cooldown … ~N min").
- **N6 (medium) | flow/a11y | pay/receive success + history | Counterparties are shown as raw truncated
  hex pubkeys** ("from d082b3af…", "to d7011269…"). The request QR carries the username, but the
  *receipt* only carries the from-pubkey, so the merchant never learns the payer's name (Alice saw
  "Received $25.00 from d082b3af…" for Bob). *Fix:* carry the payer's username in the signed payload or
  the receipt so the merchant/recipient sees a name; fall back to a friendly truncated handle.
- **N7 (low) | flow | deposit sheet | The deposit error misleads.** With no ck-minter registered for
  currency 1, the sheet shows "Could not reach the ledger for a deposit address / Check the relay is
  reachable, then reopen the sheet" — but the real cause is "currency 1 has no ck minter" (a deploy
  invariant), not relay reachability. *Fix:* distinguish 503-transient from "no minter" and message it.
- **N8 (low) | flow | onboarding | Empty username defaults to "me".** A generic placeholder identity;
  the plan already flagged "username default" as a harness/UX gap. The username `TextInput` also has no
  `testID` (only a placeholder), so it is harder to target for a11y/harness. *Fix:* require a name or
  pick a less generic default; add a testID.
- **N9 (low) | visual | wallet header | The `＋ Add money` button's drop shadow/glow is clipped at the
  viewport right edge** (right edge 389/390 px; `shadowRadius: 12` overflows). Reads as cramped.
  *Fix:* give the header row right padding / move `Add money` out of the balance row.
- **N10 (low) | flow | pay screen | No manual "paste request" fallback.** The payer can ONLY acquire a
  request via the camera (or NFC). On web/desktop (and when a camera is absent/unreliable) there is no
  paste-a-request-string path, so Pay is unreachable without a working camera. *Fix:* add a "Paste
  request" affordance (the decode path already accepts a string).

## Onramp/offramp + multi-currency findings (2026-07-30)

> From two orchestrated investigation subagents. Full plan + citations: `2026-07-30-ckusdc-onramp-offramp.md`.
> **Linchpin:** ckUSDC is NOT a ckBTC-style chain-key token — it is a ckERC-20 handled by the **ckETH
> minter** (`sv3dd-oaaaa-aaaar-qacoa-cai`) via an Ethereum helper-contract deposit + heartbeat log
> scraping. The existing ckBTC deposit/withdraw proxy does NOT generalize. There are ≥3 ck-minter
> families (UTXO-minter=ckBTC; ckETH/ckERC20=ckUSDC; ckSOL). The ICRC ledger layer (balance/pay/history)
> already works for ckUSDC with a `register_ledger` call — only the *ramp* is ckBTC-shaped.

- **O1 (high) | architecture | canister/relay/app | The deposit+withdraw ramp is hard-wired to the
  ckBTC minter family.** ✅ **RESOLVED for onramp (M0+M2)** — `MinterFamily` is now the per-family
  dispatch key (canister `currencies()` + `register_currency_meta`, M0); the ckUSDC onramp is built
  CLIENT-SIDE (no canister ramp dispatch needed — the onramp bypasses the canister: the user does 2 ETH
  txs, the mint lands at `Account{owner:facade, subaccount:pubkey}`, dpay just polls the ledger balance).
  Shipped: `app/cketh.ts` byte-exact calldata builder, `app/wallet.ts` EIP-1193 seam, `CkErc20DepositSheet`
  wallet-connect flow (connect→approve→deposit→watch), relay `GET /api/v1/onramp/ckerc20`, ckUSDC registered
  on mainnet. The ckERC20 **offramp** (canister `withdraw_erc20` dual-ledger dispatch) is NOT built —
  deferred per Fork-C (no ckETH gas source; offramp via third-party, never dpay). So the onramp is
  multi-family; the direct offramp remains ckBTC-only.
- **O2 (high) | architecture | core wire | `WithdrawAuth` binds a BTC-address field** ✅ **RESOLVED (M3,
  commit 4a98c89)** — renamed `WithdrawAuth.btc_address` → `destination` across 14 files. **Wire-safe**:
  `signing_bytes()` was already chain-agnostic (the address is a u32-length-prefixed UTF-8 string — the
  field NAME never touched the bytes). Proven: the regenerated `wire_layout.json` withdraw.golden
  `signing_hex`/`sig_hex` are byte-identical before/after. The signed-withdrawal now reads as chain-agnostic
  without a FROZEN-wire version bump.
- **O3 (high) | dependency | ckUSDC offramp | The user MUST hold ckETH to pay Ethereum gas** 🟡 **DEFERRED
  (Fork-C)** — the ckERC20 direct offramp (`withdraw_erc20`, dual-ledger approve) is NOT built. Per the
  locked founder decision, gas is provided via a THIRD-PARTY (user authorizes a 3rd-party ckUSDC→ckETH
  conversion directly; dpay is a screen only — preserves no-swap). The ckUSDC asset card has NO cash-out
  button (honest deferral); ckBTC cash-out works (with saved-address reuse, M3).
- **O4 (medium) | risk | ckERC20 offramp front-running (extends #9/risk 8)** 🟡 **DEFERRED** — applies
  only when the ckERC20 offramp lands (see O3). The dual-approve + partial-failure (`CkErc20LedgerError`
  after `CkEthLedgerError` → reimbursement) residual is documented; inherent to the ckETH minter, not
  dpay-specific.
- **O5 (medium) | UX/config | single-sourcing** — ✅ **CLOSED by M0** (commits 849ad59/66703af/736746d).
  Canister `currencies()` + relay `GET /api/v1/currencies` + app runtime catalog shipped; `DEPOSIT_CURRENCY`
  deleted; adding a currency is config-only.
- **O6 (low) | verification | live ckUSDC params** — ✅ **VERIFIED 2026-07-31** via mainnet query
  (`dfx canister --network ic call sv3dd-oaaaa-aaaar-qacoa-cai get_minter_info`) + authoritative source
  (`dfinity/ic` `DepositHelperWithSubaccount.sol`, `templates/principal_to_bytes.js`, `tests/principal_to_bytes_test.js`).
  Findings (all to be READ AT RUNTIME via `get_minter_info`, never hardcoded):
  - `deposit_with_subaccount_helper_contract_address` = `0x18901044688D3756C35Ed2b36D93e6a5B8e00E68` ✓
  - `minimum_withdrawal_amount` = `5_000_000_000_000_000` (5e15 wei; minter-wide gas floor, shared by ckETH+ckERC20)
  - ckUSDC in `supported_ckerc20_tokens`: ERC-20 `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, ledger
    `xevnm-gaaaa-aaaar-qafnq-cai`, symbol `ckUSDC` ✓. **11 ckERC20 tokens live**: ckUSDC, ckUSDT, ckEURC,
    ckWBTC, ckLINK, ckUNI, ckWSTETH, ckPEPE, ckOCT, ckSHIB, ckXAUT.
  - ckUSDC ledger: `icrc1_symbol`="ckUSDC", `icrc1_decimals`=6, `icrc1_fee`=10_000 (0.01 USDC),
    `icrc1_name`="ckUSDC" ✓.
  - `minter_address`=`0xb25eA1D493B49a1DeD42aC5B1208cC618f9A9B80`, `cketh_ledger_id`=`ss2fx-dyaaa-aaaar-qacoq-cai`,
    `evm_rpc_id`=`7hfb6-caaaa-aaaar-qadga-cai`.
  - **`depositErc20` ABI (LIVE helper `CkDeposit`):** `depositErc20(address erc20Address, uint256 amount,
    bytes32 principal, bytes32 subaccount)` — **first arg is the ERC-20 contract address, NOT a token_id**
    (corrects the investigation's "token_id" framing). Emits `ReceivedEthOrErc20(erc20Addr indexed, owner
    indexed, amount, principal indexed, bytes32 subaccount)`; calls `erc20.safeTransferFrom(msg.sender,
    minterAddress, amount)` so user must `approve(helper, amount)` on the ERC-20 first.
  - **principal→bytes32 encoding (authoritative):** base32-decode (incl 4-byte CRC32 prefix) → `slice(4)`
    strips CRC → length-prefix into 32 bytes: `[1-byte N=len][N principal-bytes][31-N zero pad]`. Golden
    vectors: `k2t6j-...-6ae`→`0x1db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000`;
    `opspt-...-vqe`→`0x1dca62f9ef706b80db8a5293779a08cbe067e69206ac4eee9d27931d2b020000`;
    `2chl6-4hpzw-vqaaa-aaaaa-c`→`0x09efcdab00000000000100000000000000000000000000000000000000000000`.
  - **No pending-deposit IC query exists** — `get_minter_info` has no per-account pending field; minting is
    heartbeat-scraped (~3min). The ONLY onramp signal is the ckUSDC ledger balance growing. (Answers Q3.)
- **🚩 Founder decisions (plan §6 Q1–Q6,14):** direct-vs-partner sequencing at launch; partner aggregator
  choice + mode; KYC-surfacing posture; ckUSDC chains at launch (Ethereum only?); ramp fees = partner's
  only (zero dpay cut); keep the demo faucet once real ckUSDC exists; wrong-network recourse messaging.
