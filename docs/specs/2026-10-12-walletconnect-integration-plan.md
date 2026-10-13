# WalletConnect + Mt Pelerin integration plan (2026-10-12)

Builds on the feasibility analysis, `2026-10-11-walletconnect-feasibility.md`: verdict FEASIBLE on the EVM (Ethereum Virtual Machine) rail, zero new key surface. This plan turns it into an execution order, incorporating the
founder's directives of 2026-10-12 and the consensus of a five-agent verification swarm (each
aspect re-measured against the providers' live docs and the repo on 2026-10-12).

## 0. Founder directives (2026-10-12)

> Founder, verbatim: "On and off ramp: high prio. Explorer listing: high prio, ideally would be
> seamlessly integrated into the balances tab. Revenue sharing: leave open, FINMA restrictions
> are not permanent. Solana support: if feasible yes, medium prio. Run a swarm of agents to
> confirm with a consensus each aspect. Write a spec/plan .MD document."

- On-ramp AND off-ramp: high priority.
- WalletConnect Explorer listing: high priority, "ideally would be seamlessly integrated into the
  balances tab" (the balances surface is Home + Accounts; see §2.5).
- Revenue sharing: leave open; FINMA (Swiss Financial Market Supervisory Authority)
  restrictions are not permanent (decision deferred, §6).
- Solana namespace: yes if feasible, medium priority (it is feasible, §2.4).
- Process: iterate with subagent swarms until perfection; every validation round's findings
  land in these docs before merge.

## 1. Consensus verdicts (five-agent swarm, 2026-10-12)

| Aspect | Verdict | Delta vs feasibility doc |
|---|---|---|
| Wallet-side SDK (software development kit) | FEASIBLE, one mandatory design correction | "shared core" is UNSAFE: wallet side must pass an explicit isolated `Core` (§2.1) |
| Mt Pelerin specifics | CONFIRMED, 2 corrections | Their picker is Explorer-driven (listing = automatic appearance); `_ctkn` is a manual review process, not self-serve (§2.2) |
| Explorer listing | CONFIRMED | Free, 7-10 business days, QA (quality assurance) matrix adds `eth_signTypedData_v4` to the v1 method surface (§2.3) |
| Solana namespace | FEASIBLE, zero new key material | Full method surface mapped; gap list smaller than feared, the review decoder is the largest item (feasibility §9.6; Track S steps 2-3) |
| In-app UX | CONFIRMED with a naming correction | No "Balances" tab exists: nav is Home / Pay / Receive / Transactions; integration points identified (§2.5) |

Two decisions the swarm settles outright:

1. **The in-app ramp flows need NO WalletConnect code.** dpay signs the address-validation
   message with the device key and, for off-ramp, sends with its own transfer path. WalletConnect
   (WC) is what lets THIRD-PARTY apps, Mt Pelerin's widget in a browser or any other dApp
   (decentralized application), reach dpay as a wallet. Tracks R and W below are independent and
   can be built in parallel.
2. **Route B (embed `react-native-mtp-onofframp`) is rejected.** The SDK is a thin WebView
   wrapper, last published 2024-10-31 (~24 months stale); opening the widget link directly with
   URL parameters achieves the same with zero new dependencies.

## 2. Verified fact base (all external facts re-measured 2026-10-12)

### 2.1 Wallet-side SDK (corrects feasibility §4)

- `@reown/walletkit` 1.6.0 is current. The React Native install needs, beyond the already-present
  `@walletconnect/react-native-compat`: `@react-native-async-storage/async-storage`,
  `@react-native-community/netinfo`, and `react-native-get-random-values` (all three already in
  `app/package.json`), plus `fast-text-encoding` (comes transitively but docs require it
  explicitly) and `@walletconnect/utils` (direct dep, for `buildApprovedNamespaces`/`getSdkError`).
- **Mandatory:** construct the Core yourself and isolate it with
  `WalletKit.init({ core: new Core({ projectId, customStoragePrefix: "walletkit" }), metadata })`.
  Core instances are shared globally by default (`globalThis._walletConnectCore_<prefix>`), and
  storage keys carry no client identity (`wc@2:client:<ver><prefix>//session` for the sign-client
  session store, `wc@2:core:<ver><prefix>//pairing` for the core pairing store, on core 2.25.0):
  without the prefix, the wallet-side client and the shipped dApp-side provider write the SAME
  session and pairing stores (last-writer-wins corruption, double event delivery). Version skew
  makes this worse, not better: walletkit 1.6.0 pins core/sign-client 2.25.0 exact; the dApp-side
  `@walletconnect/ethereum-provider` 2.23.10 pins 2.23.10 exact. A second Core with the default
  prefix is never even created; core returns the globally shared instance, leaving one Core
  behind both SignClients over the same session/pairing stores. Only a distinct fixed prefix
  yields two isolated Cores and stores. Never rely on init order.
- `@walletconnect/react-native-compat` must be imported before any `@reown/*` import; relevant to
  the lazy-import seam the house pattern uses.
- Same project ID works for both sides; the dashboard "App or Wallet" classification is reported
  changeable (swarm dashboard inspection, 2026-10-12; re-confirm in the dashboard at W2
  submission time) and only feeds the Explorer listing (HIGH priority per §0; see §2.3).
- Android `wc:` scheme intent-filter is the standard same-device inbound path (confirmed against
  historic + current docs); Link Mode (universal links) is an optional latency optimization, not
  a listing requirement.
  - Requests arrive only while the relay socket is live: init in the post-identity path (Wallet
    mount or the identity-loaded effect), never before an EVM address exists.
  - While onboarding is active, an inbound pairing is dropped (Wallet is not mounted, W1 step 4).
  - Wallet-side push exists in the SDK (EchoClient) but is undocumented today: defer.
- Session API surface confirmed: `pair`, `session_proposal` → `buildApprovedNamespaces` +
  `approveSession` / `rejectSession`, `respondSessionRequest`, `updateSession`, `extendSession`,
  `disconnectSession`, `emitSessionEvent`.

### 2.2 Mt Pelerin (developers.mtpelerin.com + live widget bundle + live tokens JSON)

- Chains: all-EVM plus Bitcoin/Lightning/Tezos. **No Solana, no ICP.** (Complete list: feasibility
  §2; re-confirmed 2026-10-12 against their docs page and the live widget bundle.)
- **Their widget ships WalletConnect v2 with Web3Modal v2 whose wallet list is fetched from the
  WalletConnect Explorer API.** A listed wallet appears in their picker automatically; a generic
  "WalletConnect" QR/deep-link option also exists. No Mt Pelerin-specific listing process exists.
- **Integration key `_ctkn` is a manual review process:** email hello@mtpelerin.com with the app
  URL; review; NO prod keys for non-live projects (documented localhost test key exists).
  - NOT an R1 (on-ramp) blocker: direct widget links are self-serve per their docs and carry
    the full prefill.
  - The key gates iframe/popup embedding.
  - Revenue sharing itself is self-serve via the `rfr` invite code (see §6).
  - The same email thread requests the off-ramp (R2) conversion webhook setup (on-request per
    their docs).
- Address validation (both directions): widget URL query params `addr`, `code` (4-digit,
  1000 to 9999; their docs require a per-address code and state re-use is rejected at
  validation, see R1 step 2),
  `hash` (base64 of raw `personal_sign` bytes over `MtPelerin-{code}`), `net`, optional `chain`
  (EIP-1271/EIP-6492, Ethereum Improvement Proposal standards for smart-wallet signature
  verification). Golden vectors published on their how-to-test page (m/44'/60'). Caveats:
  `addr` must be unique per user; an address already registered on another Mt Pelerin account
  is rejected.
- On-ramp (buy): delivery straight to the validated address; prefill params per their parameter
  docs, `dnet` (buy destination network), `bsc`/`bdc` (buy source fiat / destination crypto),
  `bsa`/`bda` (buy source / destination amount), `curs`/`crys` (authorized fiat / crypto lists).
  The validation signature is the
  ONLY signature a plain buy needs.
- Off-ramp (sell): their flow offers WC AND an explicit "I've sent the crypto manually" path to
  their deposit address. Completion: conversion webhook (echoes `oid`, `Mtp-Signature`
  HMAC-SHA256, Hash-based Message Authentication Code) plus widget postMessage events
  (`paymentSubmitted`, `orderCreated`; the order carries `offRampAddress`).
- Fees/limits (their published figures, 2026-10-12): bank ramps 0% on the first CHF 500 per user
  per year, then a decreasing fee starting at 1.3%; card 2.5%+ (min CHF 1.20, max CHF 5k/tx);
  ERC-20 (the Ethereum token standard) delivery on Ethereum costs $1, ETH and all other chains
  free; no minimum
  buy; CHF via SIC (Swiss Interbank Clearing) free. ZCHF↔fiat conversions are 0% via their
  Frankencoin Association partnership (buys and cash-outs, any supported fiat, no volume limits;
  their announcement, published 2025-09-23, updated 2026-08-03). KYC (Know Your Customer): none
  to CHF
  999/30d (Short Message Service text + email; bank on-ramps held 7 days), verified to CHF 100k/tx, card = KYC.
  Restrictions: US persons and Russian citizens are barred outright; the forbidden-countries API
  lists 32 barred countries including the US and Russia (the docs page additionally names South
  Sudan; Latvia is absent from the API; api.mtpelerin.com/countries/forbidden, checked
  2026-10-12).
- Asset/delivery fit for dpay's wired chains: ZCHF → Ethereum (wired today; ERC-20); USDC → Ethereum or Arbitrum REQUIRES adding the EVM catalog row first (token address, decimals,
  ramp flags; the rail carries only ZCHF today); ETH is gas-balance-only today (no selectable
  asset row; bought ETH lands as the gas balance, disclosed in the buy copy). Mt Pelerin lists
  ZCHF on Ethereum/Base/Gnosis/Optimism, NOT Arbitrum, where dpay carries it today.

### 2.3 Explorer listing (docs.walletconnect.com)

- Portal: dashboard.walletconnect.com (reown inc). Flow: project type "Wallet" → WalletGuide tab →
  wizard (name/homepage/description/logo, wallet types, chains, test instructions) → submit.
  Review 7-10 business days, ~24 h live after approval; free (Reown pricing is usage-based, $0
  starter tier); submission "recommended but optional".
- QA matrix (their published test list): connect via QR AND via deep link, chain switch, account
  switch, disconnect, Verify-API scam flag; **EVM requires `personal_sign`,
  `eth_signTypedData_v4`, `eth_sendTransaction`.** This adds `eth_signTypedData_v4` to dpay's v1
  method surface: a NEW pure module `app/evm/typedData.ts` (encodeType + encodeData for the full
  EIP-712 atomic grammar, dynamic bytes/string, arrays, one nesting level of structs; refuse
  unknown value types with an explicit error; r||s||v hex response shape), with golden vectors from
  the EIP-712 spec's example set in `app/__tests__/evm-typed-data.test.ts` (the `evm-*.test.ts`
  convention); 1-2 days with tests. `permit.ts`'s fixed EIP-2612 digest builders do not
  generalize.
- Web wallets are listable ("Web Wallet" type; `platforms` is a live Explorer query param, docs
  example values `ios,android,mac,injected`; re-check the swarm's `web` value against a real
  project ID at W2 submission). Listing metadata (typed deep links) becomes the picker's launch
  targets, so `dpay://` must work from a browser context before submitting.
- "WalletConnect Certified" is a separate gated trust/rank/revenue program (S3 2026 is
  payments-themed): optional and not needed for v1.

### 2.4 Solana namespace (for Track S)

- Method surface: `solana_getAccounts`, `solana_requestAccounts`,
  `solana_signMessage` (message AND signature base58), `solana_signTransaction` (base64 serialized
  tx, canonical; the instruction-array shape is deprecated upstream, their docs: "not compatible
  with versioned transactions"; dpay rejects it locally with its own explicit
  unsupported-format error rather than relying on a documented upstream one), `solana_signAllTransactions`,
  `solana_signAndSendTransaction` (base58 signature).
- `solana_signMessage` = plain ed25519 over the provided bytes; the off-chain-message format
  is a dApp-side construction, not a wallet obligation. dpay's `ed25519.sign` +
  bs58 suffice (~20 lines).
- CAIP-2 (Chain Agnostic Improvement Proposal 2): `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`
  mainnet; accept both the `chains`-array and
  the singleton proposal forms; ecosystem norm `supportedTransactionVersions: ["legacy", 0]`.

### 2.5 The balances surface (repo facts, corrects the "balances tab" framing)

- Bottom nav is **Home / Pay / Receive / Transactions** (`app/components/Wallet.tsx:2680`). Home
  is the currency-first balances surface: summed home-currency balance plus the action row
  `btn-home-add-funds` / `btn-home-withdraw` / `btn-home-more` (`app/components/HomeTab.tsx:230`).
  Accounts (`btn-home-accounts`) is the per-asset list. The directive's "balances tab" therefore
  means: Home's action row + the per-asset surfaces it opens.
- On-ramp mounts, all precedented: the HomeTab action row; the existing `FundingRoutes` card in
  the Receive surfaces (`ReceiveMode.tsx:564`, `EvmReceiveMode.tsx:199`); `DepositSheet` next to
  `TrustWalletFundButton` (`DepositSheet.tsx:239`; the "same-surfaces Add-money entry,
  caller owns eligibility" rule). `FundingRoutes` currently renders provider domains as inert
  text pending the routing-discretion decision; the founder's directive resolves that question in
  favor of an interactive named option.
- Off-ramp eligibility is already on the wire: EVM catalog rows carry
  `onramp`/`offramp: RampCapability` ('Direct' | 'Partner' | 'Unavailable', fail-closed) parsed in `app/lib/evmCatalog.ts`
  (`parseRamp` :34, applied in `parseEvmRow` :82-83; the row fields sit at :54-55). Gate on `offramp !== 'Unavailable'` and token in {USDC, ZCHF} on
  wired rows (bought ETH is gas-balance-only, §2.2); after R2 step 1's
  flip this yields exactly ZCHF on Ethereum (today's catalog
  has both EVM ZCHF rows at `offramp: 'Unavailable'`; USDC joins once its R1-step-0 rows exist
  and R2 step 1 flips the eligible rows; testnet stays `Unavailable`). Do NOT read the IC (Internet Computer)
  `CurrencyDescriptor.onramp/offramp` flags for EVM gating (those describe the ck-minter rail, a
  different thing; the EVM rows carry their own `RampCapability` flags in the same shared
  vocabulary). The send itself: `EvmWithdrawSheet` already does device-key ERC-20 transfers with
  address book and the submitted-not-settled terminal. The v1 cash-out covers catalog-row assets
  only (ZCHF, then USDC); native-ETH cash-out is later work (a native send, not the ERC-20 path)
  and carries no catalog row.
- Status tracking: reuse the convert machinery wholesale (`ConvertStep` state machine +
  `PROVIDER_CONVERT_STEPS`, `StatePanel`), with the Trocador contract (webhook-first,
  correlation key = dpay's own order id, 1 req/min poll fallback, stop at first terminal);
  abort/watch rules
  per `2026-09-24-cefi-lifecycle-abort.md`.

## 3. The plan

### Track R: in-app Mt Pelerin ramps (HIGH; no WC code involved)

**R0 (day 0, no code, not blocking R1):**
- Email hello@mtpelerin.com (the founder sends it, or an agent drafts it for the founder to send)
  requesting the integration key (app URL: https://dpay.kalaj.org, describe wallet +
  widget-link integration) AND the R2 conversion webhook setup (on-request per their docs).
- Blocking: only R2's key/webhook work, not R1; R1 does not wait (§2.2); direct widget links
  are self-serve and carry the full prefill; the key gates iframe/popup embedding only;
  revenue share is self-serve via `rfr` (see §6).
- Development: R2's API work develops against their documented localhost test key and golden
  vectors.
- No env-gated rows: the off-ramp flip is unconditional in code (R2 step 1), and
  `DPAY_MTPELERIN_CTKN` (sops) gates only the conversion proxy (see R2 step 1).
- Ship gate: R2 ships only once the relay config lands.
- Embed upgrade path: once the `_ctkn` key lands, R1's buy surface can host their widget in-app
  (iframe/modal) so the user never leaves dpay; v1 ships the external-browser direct link
  because direct links need no key (self-serve) while embedding waits on their manual review.

**R1: on-ramp, fiat → dpay address (~4-7 days).**

0. Catalog: add USDC rows for Arbitrum One + Ethereum.
   - Relay side: `evm_sections_with` (`crates/dpay-relay/src/catalog.rs`), `onramp: 'Partner'`,
     `offramp: 'Unavailable'` (R2 step 1 flips the eligible rows later).
   - App registry: a `USDC_TOKEN` entry in the token registry `app/evm/chains.ts`, mirroring
     `ZCHF_TOKEN`'s `Partial<Record<EvmChainId, ...>>` shape (`chains.ts:76`) with its own
     accessor (the `evmZchfToken` pattern). USDC's permit domain is NOT `'minimal'`: its
     deployed EIP-712 domain is name+version, the `'full'` kind; verify on-chain before any
     permit use. No R1/R2 step signs a USDC permit, so the accessor must not copy
     `evmZchfDeployment`'s hard-coded `'minimal'` at `chains.ts:134`.
   - Wire rows: USDC rows in `BUNDLED_NETWORKS`'s EVM sections (`app/config/catalog.ts:354-376`)
     matching the EVM ZCHF rows' field shape exactly (no `domainKind` on the wire rows, the
     parser has none) and the in-memory key `minFractionDigits: 2`, exactly as the ZCHF bundled
     rows do (relay-side the rows serialize `min_fraction_digits: 2`, the value the Solana USDC
     row precedent carries), checksummed
     addresses per the parser's EIP-55 gate; append each USDC row AFTER the ZCHF row in its
     section's assets so `zchf_rows_wire_byte_shape`'s `rows[0]` pin survives. The bundled
     catalog feeds cold/offline first load; `app/lib/evmCatalog.ts` itself needs no change.
   - Addresses: Circle's canonical USDC deployments on Ethereum and Arbitrum One, EIP-55
     checksummed, 6 decimals; verify against api.mtpelerin.com/currencies/tokens and pin them.
   - Truth pins: the EVM money literals are pinned by the catalog-truth pins, four sources
     that must agree, namely `dfx/catalog_truth.json` (the declared single source of truth; add
     `erc20_contracts.usdc_*` + `decimals.usdc`), the `app/__tests__/catalog.test.ts` smoke
     pin, the EVM-row pin `zchf_rows_wire_byte_shape` in `mod wire_byte_shape_tests`
     (`catalog.rs:2250`), and `evm_rows_match_truth_and_locked_shape` (`catalog.rs:2078`).
     Only `evm_rows_match_truth_and_locked_shape`'s `rows.len() == 1` assertions
     (`catalog.rs:2101-2102`) and the `app/__tests__/catalog.test.ts` bundled-literals test go
     red at step 0; the test's per-row `Unavailable` loop covers the two ZCHF rows only and
     stays green until the R2 step 1 flip. `zchf_rows_wire_byte_shape` keeps passing (its
     `rows[0]` pins are untouched) and is
     EXTENDED in the same change with a `rows[1]` USDC wire-byte literal per section, so the new
     rows are byte-pinned before the R2 step 1 flip turns them red. Those pins going red is the
     intended forcing function, not a regression.
   - Buy copy: bought ETH needs no new row (§2.2; the gas balance already renders); disclose
     that in the buy copy.
1. `app/evm/personalSign.ts`: EIP-191 digest + device-key sign + base64. Pure, golden-vector
   tested against Mt Pelerin's published vectors. (Shared with W1: build once.)
2. `app/ramp/mtpelerin.ts`: widget link builder. Validation code:
   - Derived deterministically per address:
     `(first 4 bytes of keccak256(lowercase address) as uint32 mod 9000) + 1000`, pure in
     `mtpelerin.ts`, jest-pinned. Their docs require the code
     to differ per address and state re-use is rejected at validation (§2.2); a deterministic
     derivation is per-address by construction but cannot guarantee distinct codes.
   - Collision fallback: a persisted per-address salt in a new `app/ramp/` AsyncStorage key
     (keyed by address, written on first derivation) whenever two of a user's addresses derive
     the same code (the wallet's own address is normally not an address-book row, so the book
     cannot hold the salt). Validation binds (addr, code, hash), so a colliding user still
     validates with their own code and hash.
   - Params: `net`/`dnet`, `bsc`/`bdc`, `bsa`/`bda`, `addr`, `code`, `hash`.
   - Asset→delivery-chain table: ZCHF→Ethereum (wired today); USDC→Arbitrum or Ethereum (after
     step 0, the sheet's delivery-chain picker); bought ETH renders as the gas balance, no row
     (§2.2; fee facts shown to the user verbatim, dated).
3. UI:
   - HomeTab "Add funds" gains a deposit-vs-buy choice (HomeMenu overflow pattern); the buy
     choice renders only when the headline asset is an EVM catalog row with a delivery chain
     in the step-2 table (ZCHF, USDC); other assets render deposit only, unchanged. The buy
     surface is a new `app/components/MtpBuySheet.tsx` (widget link + validation-sign
     confirmation), mounted by `Wallet` from its `onBuy` handler (Wallet-owned sheet state, the
     `receiptTxn` pattern); the FundingRoutes/DepositSheet entries route into the same state.
     It lists Mt Pelerin as a named provider option.
   - The receive surfaces' `FundingRoutes` card gains the interactive Mt Pelerin row; the row
     lives inside `FundingRoutes` (shared by `ReceiveMode.tsx:564`, `EvmReceiveMode.tsx:199`,
     `SolReceiveMode.tsx:244`) and renders ONLY when the card's asset is an EVM catalog row with
     a delivery chain in the step-2 table (SOL assets render no Mt Pelerin row).
   - `DepositSheet` gains a buy entry next to `TrustWalletFundButton`.
   - `Wallet` threads the buy opener into `ReceiveMode`/`EvmReceiveMode` (forwarded to
     `FundingRoutes`) and `DepositSheet`.
   - The widget opens externally (browser) with full prefill; open failure keeps the sheet with
     a failed-link note (the `TrustWalletFundButton` pattern). Upgrade once R0's `_ctkn` lands:
     host their widget in-app (iframe/modal) so the user never leaves dpay (their iframe
     allow-list already covers clipboard/payment).
   - The in-app sign confirmation shows the review line (message `MtPelerin-{code}`, address,
     chain); Cancel aborts with a typed user-rejected error; approve signs and opens the widget.
   - Closing the widget early loses nothing: arrival reconciles through the `useEvmBalances`
     poll plus an explicit `refresh()` fired by the `useAppActive` hook (AppState `'active'` on
     native, window focus/visibility on web) after the widget was opened.
   - Copy via `M.*`, all four locales: keys live in `domains/<locale>/deposit.ts` (which
     already carries the Deposit+Withdraw message groups; `keys.ts` picks the shape up from
     `domains/en/deposit` automatically). Provider named as counterparty, their fee figures with
     as-of date, the 7-day unverified-bank hold, the $1 Ethereum ERC-20 delivery fee (§2.2) where it
     applies.
   - Harness note: `onBuy` (plus the sheet-state routing) is threaded from `Wallet` as optional
     props (`?:`); the direct-mount HomeTab harnesses (`HomeTab.test.tsx`,
     `HomeRailHonesty.test.tsx`) stay green unchanged, and nothing renders differently when the
     prop is absent.
4. Tests:
   - Jest domain suite (`app/__tests__/mtpelerin.test.ts`): link-builder param vectors,
     sign vectors.
   - Smoke: the EIP-191 golden vector in a NEW flat `app/__tests__/evm-signing.test.ts`
     (created in this step; kebab per the `evm-*.test.ts` convention; the param-fill vector
     joins it in W1
     step 5), admitted via the one-line `'evm-signing.test.ts'` entry in
     `app/__tests__/smoke/manifest.ts` (enforced by `smokeManifest.test.ts`).
   - Flow: `app/__tests__/flow/pay/51-mtp-buy-entry.test.tsx` (number assigned at
     implementation, pattern per `50-deeplink-receipt.test.tsx`).
   - Fixtures: one golden widget link per asset (ZCHF→Ethereum, USDC→Arbitrum, USDC→Ethereum),
     parameter spelling and casing pinned per their parameter docs (e.g. `net=mainnet`,
     `dnet=mainnet`, `bsc=CHF`, `bdc=ZCHF`); `bsa`/`bda` are numbers per their parameter
     docs, serialized by dpay as plain decimal strings (dot separator, no grouping, no
     currency symbol).
   - Baselines: new USDC rows and later `Partner` flags change rendered balances chrome;
     re-seed the frozen visual baselines with `just e2e-visual-seed` in the same change
     (flow 40, likely 83/146 too).

**R2: off-ramp, dpay asset → fiat (~5-8 days).**

1. Relay proxy for the Mt Pelerin API + webhook receiver, on the
   `2026-09-22-trocador-partner-agreement.md` §2 precedent + the privacy.html §7 disclosure
   update.
   - Proxy + receiver: access log/order store, HMAC `Mtp-Signature` verification; correlation
     and poll discipline per that doc's §2, terms 2 and 4.
   - Config: webhook URL + signing secret configured with Mt Pelerin (partner setup, on
     request, same thread as R0); the secret lives as `DPAY_MTPELERIN_WEBHOOK_SECRET` in a
     sops file, surfaced via the deploy-env path (Trocador precedent).
   - The flip: `offramp: 'Partner'` unconditionally in code, staged within this step. Commit 1
     flips ZCHF on Ethereum (the only eligible row until then); commit 2 flips the R1-step-0
     USDC rows once they exist.
   - Three places per commit: relay `evm_sections_with` (`catalog.rs`), app
     `BUNDLED_NETWORKS` (`catalog.ts`), and the pins asserting today's `Unavailable`, namely
     `app/__tests__/catalog.test.ts`, the EVM-row pin `zchf_rows_wire_byte_shape` in
     `mod wire_byte_shape_tests` (`catalog.rs:2250`), which asserts the exact JSON including
     `"offramp":"Unavailable"`, and `evm_rows_match_truth_and_locked_shape`
     (`catalog.rs:2078`), whose per-row `offramp == Unavailable` loop assertion goes red for
     the flipped Ethereum row at commit 1 (the Arbitrum row stays green until commit 2 flips
     the USDC rows); extend both EVM-row pins in the same change.
   - Testnet rows stay `Unavailable`. `catalog_truth.json` carries no ramp fields, so the flip
     does not touch it.
   - Guard: the runtime gate is the existing `RampCapability` check reading the fetched
     catalog, and while `DPAY_MTPELERIN_CTKN` is absent the conversion proxy's 503
     `mtpelerin-unconfigured` is the guard (the unconfigured-refusal pattern: Trocador's
     keyless tripwire 503s every route until the key lands, `crates/dpay-relay/src/trocador.rs`;
     `docs/AGENT-FUNDS.md` records the same shape as SideShift's `sideshift-unconfigured`
     answer, reads keyless, creation not).
   - Routes: `/api/v1/mtpelerin/quote`, `POST /api/v1/mtpelerin/conversion`, and
     `POST /api/v1/mtpelerin/webhook`, mirroring the Trocador route layout
     (`crates/dpay-relay/src/app.rs:91-94`).
   - Baselines: re-seed the frozen visual baselines (`just e2e-visual-seed`) for the flipped
     rows.
2. UI + order flow: per-asset "Cash out" entry gated on `RampCapability` (§2.5).
   - Eligibility: Wallet resolves the headline asset's EVM row via the existing
     `evmAssetsOf(networks)` (`Wallet.tsx:364`) and passes a new `cashOutEligible` prop (plus
     `onCashOut`) into HomeTab; the action row's Withdraw control becomes cash-out-aware when
     the row is an eligible EVM row (`offramp !== 'Unavailable'`, token ZCHF/USDC; the
     one-action-row pattern of the §8 item 1 recommendation, applied to the Withdraw control).
   - Sheet: a new `app/components/MtpCashOutSheet.tsx` (an International Bank Account Number
     field, plus holder name, quote, and lifecycle, mirroring `EvmWithdrawSheet`'s prefill
     pattern), mounted by `Wallet` from its `onCashOut` handler; `btn-home-withdraw` opens it
     for `cashOutEligible` rows instead of the pay-surface withdraw flow. Copy keys live in
     `domains/<locale>/deposit.ts` in all four locales (the sheet joins the existing
     Deposit+Withdraw message groups; `keys.ts` picks the shape up automatically).
   - Validation: the sheet signs `MtPelerin-{code}` for the dpay address, taking `code` from
     the R1 step 2 derivation and salt store in `app/ramp/mtpelerin.ts` (the same per-address
     code the buy flow validated), via the R1 `app/evm/personalSign.ts` primitive where the
     conversion request requires it (per §2.2
     "both directions").
   - Order: order creation is SERVER-SIDE through the proxy (POST conversion; correlation id =
     dpay's order id; the response's `offRampAddress` + `oid` persist into the convert record).
   - Quote: fetched via the proxy; rendered per the §4 disclosure rules.
   - Send: on confirm, dpay's own ERC-20 send to `offRampAddress` through `EvmWithdrawSheet`
     (the submitted-not-settled terminal applies).
   - Lifecycle: states through `ConvertStep` + `ConvertStatePanel` (its `failed_refunded` slot
     carries the refund card) with the abort/watch rules of
     `2026-09-24-cefi-lifecycle-abort.md`.
   - Manual-send note: the widget's own manual-send flow stays available to users who prefer
     Mt Pelerin's UI directly; it needs no dpay code and gets no lifecycle tracking, disclosed
     as such.
   - Harness note: `cashOutEligible` + `onCashOut` are optional props (`?:`); the direct-mount
     HomeTab harnesses (`HomeTab.test.tsx`, `HomeRailHonesty.test.tsx`) stay green unchanged,
     and nothing renders differently when the prop is absent.
3. Tests: relay route tests in `crates/dpay-relay/src/` (`mod mtpelerin_tests` covering HMAC
   verify, poll cap, terminal dedupe; gate `just test-relay`), jest flow for the sheet lifecycle
   (`app/__tests__/flow/pay/52-mtp-cashout.test.tsx`, number assigned at
   implementation), and a node-anvil broadcast proof: a new
   `app/__tests__/node-anvil/<next free number>-mtp-broadcast.test.ts` (number assigned at
   implementation, after W1's 225; the 219-224 convention), reusing the existing EVM send path.

**2026-10-13 update (the API closure consequence; history above unchanged):** Mt Pelerin
closed dpay's API tier - server-side order creation requires the USER'S OWN credentials (the
widget) or B2B own-name authorizations dpay does not hold. The relay's upstream order POST is
REMOVED (`0eb6f7f9`): `POST /api/v1/mtpelerin/conversion` is purely local (it mints the
`mtp-…` correlation id and answers the record; no CTKN needed on it - the quote proxy keeps
the key gate). R2 step 2's send step is REPLACED by the widget handoff: after registration the
sheet opens the venue's sell widget EXTERNAL (the R1 open pattern), and the lifecycle record
is born at registration with NO `providerDeposit` block (dpay never learns a deposit address -
the webhook payload `{id, external_id, amount, currency}` never carries one and the address
exists only in the user's own widget session). The repo's pinned parameter docs cover the
ON-RAMP parameters only: no sell-side prefill and no `oid`/free-form correlation parameter
exists, so the sell link is the documented bare widget URL and the webhook's `external_id`
correlation CANNOT be established from dpay's side - deliveries for widget-created orders
stay Unmatched until the venue documents a correlation parameter (founder ask). The
node-anvil broadcast proof above is obsolete with the send step (dpay signs nothing in this
flow). IBAN/holder collection is gone from the sheet (the widget collects bank details); the
relay accepts but ignores the legacy fields.

### Track W: WalletConnect wallet-side + listing (HIGH)

**W1: responder v1, EVM (~1-2 weeks, per feasibility §4 as corrected).**

1. Deps: add `fast-text-encoding` (explicit), `@walletconnect/utils`, `@reown/walletkit` 1.6.0.
   Compat import ordered before any `@reown/*` import in the new module.
2. `app/walletkit.ts` mirrors the `walletconnect.ts` seam:
   - Static import of the SDK, reached from the app only through a lazy dynamic import.
   - Jest stub: add a `'^@reown/.*'` entry to `app/jest.config.js`'s `moduleNameMapper`, mapping
     to a NEW `app/__stubs__/walletkit-stub.ts` exporting no-op `WalletKit` covering
     `init`/`pair`/the methods `walletkit.ts` imports, and `Core`, mirroring
     `__stubs__/walletconnect-stub.ts`.
   - An end-to-end test alias, disabled guard on web/empty project ID.
   - ISOLATED core (`customStoragePrefix: "walletkit"`), metadata +
     `redirect: { native: 'dpay://' }`, initialized in the post-identity path (Wallet mount),
     never before an EVM address exists.
3. Methods:
   - `personal_sign` (shared R1 primitive); `eth_accounts`/`eth_chainId`.
   - `eth_signTypedData_v4`: build the new pure module `app/evm/typedData.ts` with the
     golden-vector suite `app/__tests__/evm-typed-data.test.ts` exactly per §2.3 (encodeType +
     encodeData, dynamic bytes/string, arrays, one struct nesting level, explicit unknown-type
     refusal, r||s||v hex; 1-2 days with tests; listing-QA requirement).
   - `eth_sendTransaction`: param-fill nonce/gas/chainId when omitted; the review sheet decodes
     ERC-20 transfer/permit calldata; unknown calldata renders as raw hex behind an explicit
     warning, never auto-approve; broadcast via relay proxy; submitted-not-settled.
   - `wallet_switchEthereumChain` (wired chains only; refusal uses the SDK's chain error,
     `getSdkError('UNSUPPORTED_CHAINS')`, code 5100).
   - Namespaces: `eip155:1` + `eip155:42161`, events `chainChanged`/`accountsChanged`.
   Review-sheet seam: a new `app/components/WcRequestSheet.tsx` mounted from `Wallet`, fed by
   an event-emitter subscription exported from `walletkit.ts` (init registers the listener;
   `Wallet` subscribes post-identity). A request arriving while the sheet is open is rejected
   with `getSdkError` USER_REJECTED (5000): one review at a time in v1, and
   `respondSessionRequest` is reachable only via sheet approve.
4. Inbound pairing:
   - Manifest: `wc:` intent-filter (new manifest entry) with a `Wallet.handleUrl` branch.
   - QR: a `wc:` kind in `app/lib/scan.ts`'s fallback classifier, handled in all three pay-mode
     scan handlers (`PayMode`, `SolPayMode`, `EvmPayMode`) via a new `onWalletConnectPair` prop
     threaded from `Wallet`, mirroring `onScannedLink`.
   - Other scan surfaces (`AddressField`, `ReceiveMode`) keep their current parsers.
   - Copy keys `M.pay.scannedWc*` in all four locales; both inbound paths land in the same
     pairing entry.
   - Capture point: Wallet's existing mount-time `getInitialURL` + foreground `Linking` listener
     (`Wallet.tsx:1636-1652`, feeding `handleUrl`) is the single capture point; `App.tsx` gets
     no code.
   - No identity: a `wc:` arriving while no identity exists is dropped. Wallet is not mounted,
     so the OS cold-start URI has nothing to render to (no note, no persistence).
   - Redirect re-open: the WalletKit redirect (`dpay://…?requestId=…`, not a `wc:` URI) is
     recognized in `handleUrl` and ignored in v1 (responses ride the foreground socket, no
     session-resume parsing). A dedicated branch keeps it from reaching the pay-link/receipt
     parsers.
   - Harness note: `onWalletConnectPair` is an optional prop (`?:`); the scan handlers call
     `onWalletConnectPair?.(...)` so the direct-mount harnesses (`PayMode.test.tsx`,
     `SolPayMode.test.tsx`, `sol-send-offline-ownership.test.tsx`) stay green unchanged, and
     nothing renders differently when the prop is absent.
5. Tests:
   - Conformance: the fake extended to the responder (proposal→approve→request→respond matrix,
     `respondSessionRequest` reachable only via sheet approve).
   - Vectors: personal_sign + typed-data (joining `evm-typed-data.test.ts`). Smoke: the
     param-fill vector joins `app/__tests__/evm-signing.test.ts` (admitted via a
     `smoke/manifest.ts` one-liner, the R1 step 4 pattern).
   - Real chain: anvil sign→broadcast→mine proof as a node-anvil test file, a new
     `app/__tests__/node-anvil/225-wc-broadcast.test.ts` (number assigned at implementation,
     the 219-224 convention).
   - Units: the `wc:` kind classifier (the scan.ts test file); the `Wallet.handleUrl` `wc:`
     branch in the flow tier via the `__DPAY_TEST_DEEPLINK` seam (the
     `flow/pay/50-deeplink-receipt.test.tsx` pattern; `__tests__/deeplink.test.ts` is the pure
     codec suite).
   - Live gates: WalletConnect's test dapp, then Mt Pelerin's widget.

**W2: Explorer listing (~0.5 day prep + 7-10 business days external, per §2.3; requires founder access
to the dashboard.walletconnect.com account owning `WALLETCONNECT_PROJECT_ID`).**

- Checklist:
  - square logo (hosted at https://dpay.kalaj.org/<path>; path decided in W2 prep);
  - name "dpay";
  - homepage https://dpay.kalaj.org;
  - wallet types Mobile (`dpay://` + universal https://dpay.kalaj.org/wallet/pay/ today; a
    `/wallet` pathPrefix + assetlinks entry is extra app-side work if the listing should
    deep-link there) and Web (the Progressive Web App);
  - chains `eip155:1` + `eip155:42161`;
  - test instructions;
  - QA-matrix pass on their lab dapp first.
- Inventory before submitting: hosted square-logo URL (app icons exist in android res, no hosted
  URL recorded), whether a Play listing exists at all (none found in docs or app; drop the field
  if not), the relay download route (404 unless an APK is configured, `app.rs:165`).
- Verify the §2.3 `dpay://`-from-browser requirement before submitting.
- Because Mt Pelerin's picker is Explorer-driven (§2.2), listing alone makes dpay appear there; send
  them the coordination email anyway (same thread as R0) to confirm and to note the platform keys.

### Track S: Solana namespace (MEDIUM, fast-follow after W1)

Feasible with zero new key material (§2.4). Work, in order:

1. Hours: `solana_getAccounts`/`requestAccounts` (identity pubkey), `solana_signMessage` (plain
   ed25519, base58 in/out), `solana_signAndSendTransaction` (the relay pipe forwards uncached
   methods byte-verbatim, `crates/dpay-relay/src/solana.rs`; only allowlisted reads are cached).
2. Days: generalize `decodeVenueSwapTx`/`signVenueSwapTx` (`app/solana/tx.ts:439/499`):
   - Multi-signer slots (sigCount is hard-coded 1).
   - Fee payer: the review sheet always displays the fee payer; v1 signs only when the dpay
     pubkey is among the required signers, else refuses with an explicit error (sponsored txs
     must not be silently refused or silently accepted).
   - Encoding: base64 in, base58 sig out; accept `legacy` + `0`.
3. Days: a new pure module `app/solana/wcDecode.ts`, the semantic instruction decoder for the
   `WcRequestSheet` review UI covering System transfer, Solana Program Library
   `transfer` + `transferChecked`, memo; raw-hex fallback with explicit warning.
   `settleVerify.ts` is structural only.
4. Namespace dispatch in `walletkit.ts`; advertise
   `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (the §2.4 mainnet CAIP-2 id) alongside `eip155:*`.
   v1 `buildApprovedNamespaces` for `solana:*` advertises exactly: `solana_getAccounts`,
   `solana_requestAccounts`, `solana_signMessage`, `solana_signTransaction`,
   `solana_signAndSendTransaction`; `solana_signAllTransactions` stays out of v1 because step 2
   covers single-transaction multi-signer slots only, and joins once decode/sign extends to
   transaction batches (never advertise an unimplemented method).
5. Scope note: Mt Pelerin has no Solana support; this track serves generic WC apps only.
6. Tests (new file `app/__tests__/solana-wc-decode.test.ts`): `solana_signMessage` base58
   golden vectors, decoder golden vectors for the review UI, and a conformance pin that the
   advertised method list never exceeds the implemented set.

Total: ~3-5 days after W1.

## 4. Disclosure rules (bind all tracks)

- Provider named as counterparty: Mt Pelerin, an SRO ramp
  affiliated with SO-FIT (its Geneva-based self-regulatory body, formerly OAR-G, its
  predecessor body, FINMA-recognised), `docs/REGULATORY.md` §1.6.
- Quotes relayed, attributed, timestamped, never computed; published-shape rates only,
  unpublished figures omitted, never invented.
- No "best" labels; alphabetical provider order; no referral params.
- Funds never touch a dpay-controlled address; dpay takes no cut (markup=0 precedent).
- Gas display (dpay never pays or quotes gas) unchanged on the WC path.

## 5. Invariants check

Restated from feasibility §7 for this plan's scope: non-custodial, no-swap, offline-first,
regulatory fit. The one addition this plan makes explicit: the WC and ramp surfaces are
online-only and never touch the offline pay rails, NFC, or the IC
envelope path.

## 6. Revenue sharing: DEFERRED (founder directive, 2026-10-12)

Default remains NO cut. For the record, Mt Pelerin's program is self-serve via an `rfr` invite
code: 25%, up to 50% with their Mt Pelerin Shares liquidity, paid in USDC on Polygon.
Enabling it later is a
FINMA "Ertragsflüsse" indicator (`docs/REGULATORY.md` §1.6, via the §1.4 indicator) and would require an in-UI indicator.
Revisit when the founder re-opens it; nothing in this plan depends on it.

## 7. Sequencing

- Immediately: R0 email (see R0; external dependency for the R2 webhook and any later
  embedding; R1 ships on direct links meanwhile).
- Parallel: R1 (on-ramp) and W1 (responder). Shared files:
  - `app/evm/personalSign.ts` (a dependency-free pure module; whichever track reaches it first
    creates it).
  - The golden-vector file `app/__tests__/evm-signing.test.ts` (created by whichever track
    lands first; append-only after creation), the append-only touches to
    `app/__tests__/smoke/manifest.ts`, and the per-locale domain files under the four
    `app/i18n/domains/<locale>/` trees (de/en/es/fr; e.g. `pay.ts`).
  - `app/components/Wallet.tsx`: R1 step 3 threads the buy entry (an `onBuy` prop into
    `HomeTab`, mirroring `onDeposit`) while W1 steps 2-4 edit the same file (the walletkit init
    wiring in the post-identity path, the WcRequestSheet mount, `handleUrl`,
    `onWalletConnectPair`); land R1's Wallet.tsx thread first and rebase
    W1, or sequence the two Wallet.tsx edits.
- Then: R2 (off-ramp) adds the relay proxy + webhook receiver per R2.1; it reuses
  `app/evm/personalSign.ts` from R1 step 1, the per-address code derivation and salt store from
  R1 step 2's `app/ramp/mtpelerin.ts`, and R1 step 0's USDC catalog rows, plus the existing
  send/lifecycle machinery; beyond those, no R1 milestone gates R2. W2 (listing
  submission once W1 passes the QA matrix), S (fast-follow).
- No slow suites during iteration; the slow gates run exactly once before merge per AGENTS.md.

## 8. Decision status (recommendations attached; none block R0/W1 starts)

Absent founder input, implement the marked recommendations: these are agent-resolvable UI
defaults and do not gate R1 step 3 or R2 step 2.

1. HomeTab "Add funds": deposit-vs-buy chooser (recommended: one action row, HomeMenu pattern)
   vs a separate Buy action.
2. Mt Pelerin row in FundingRoutes: alphabetical peer among providers (recommended; the founder
   directive upgrades rows to interactive) vs a single highlighted option.
3. ZCHF on-ramp delivery chain: Ethereum (recommended, wired today; the $1 ERC-20 delivery fee, §2.2) vs
   wiring Base (free delivery, new rail chain).
4. Off-ramp v1 payout: bank in CHF via SIC (recommended; no-KYC to CHF 999/30d with the 7-day hold
   disclosed, §2.2) vs card-adjacent flows (KYC-required).
5. WC push notifications: settled, no decision needed. Defer is forced: the SDK surface exists
   but is undocumented upstream today.

## 9. Sources

Feasibility: `2026-10-11-walletconnect-feasibility.md` (2026-10-11 measurements). Swarm
re-measurements (2026-10-12): docs.walletconnect.com (walletkit install/usage/link-mode/
best-practices/submit-wallet/explorer-api/certified/verify, solana chain page, CAIP-25 namespaces
spec), developers.mtpelerin.com (supported chains, parameters/message-to-sign/how-to-test,
on-ramp parameters, conversion webhook, events, getting-started, troubleshooting, unsupported
countries), npm registry (walletkit 1.6.0, ethereum-provider 2.23.10 pins, mtp-onofframp 1.0.3),
live widget bundle (Web3Modal + explorer-api usage), api.mtpelerin.com/currencies/tokens, and the
dpay repo files cited inline.
