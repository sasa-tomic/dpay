# E2E Test Flows — Manifest

> The authoritative catalog of every user flow tested by the e2e harness (`e2e/`). **75 flows**
> (74 in the default `just e2e` run, 1 optional capture-only flow via the dedicated recipe).
> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome
> against a real test relay (FakeLedger, offline). No UI stubs. The only shimmed I/O boundary is
> the camera scan (sanctioned smallest-boundary seam) and the NFC radio (physical-device gate).
>
> **This file is GENERATED** by `node e2e/gen-flows-md.mjs` from each flow's `meta` export. Never
> hand-edit the tables — edit the `meta` and re-run. Only the "Coverage gaps" / "How to add" prose
> is hand-maintained (inside that script).
>
> **Run:** `just e2e` (all default flows, ~18s) · `DPAY_E2E_FILTER=07 node e2e/run.mjs` (one flow) ·
> `DPAY_E2E_FILTER=pay node e2e/run.mjs` (a whole journey) · `DPAY_E2E_FILTER=07,15 node e2e/run.mjs` (subset) ·
> `just e2e-store` (the optional Play Store capture flow).

## Coverage matrix

Flows grouped by user journey; within each table, every row lists what the flow **verifies** and
the behavior **covers** slugs (the latter are filterable: `DPAY_E2E_FILTER=<slug>`). Flows marked
`optional` are render-only capture harnesses excluded from the default run.

wire (1) · onboard (7) · pay (20) · offline (7) · deposit (8) · withdraw (7) · nfc (5) · system (17) · tour (3)

---

### Wire-format cross-validation (no browser)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 00 | cross-val | JS ed25519 shim is byte-exact vs the Rust core (withdraw sig, pay golden, receipt-claim golden) — no browser, ~0.1s. | wire-format, ed25519-parity, golden-bytes, receipt-claim |

### Onboarding & funding

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 01 | onboard | New user enters a name → wallet created, faucet funds ∂100, balance + empty history render. | onboard, faucet, first-balance, empty-history |
| 02 | faucet | Returning user taps 'Add demo money' → faucet top-up works, balance increases. | faucet, topup, balance-delta |
| 23 | username-default | New user leaves name empty → creates → defaults to 'me', onboards + funds. | onboard, default-username |
| 37 | onboard-no-faucet | Onboard against a dead relay → faucet failure surfaces an honest "Continue" prompt (not a silent $0 transition), wallet created with $0 (∂100 never shown), honest "~ DEMO approx." offline indicator, faucet fails with ECONNREFUSED. | onboard, faucet-failure, offline, dead-relay, right-reason, zero-balance |
| 54 | testnet-toggle | Balances testnet toggle reveals + hides a "BTC testnet" row (catalog-driven testnet detection). | testnet, catalog, toggle, balances |
| 58 | restore-wallet | A wallet can be restored from the 64-hex recovery seed (toggle to hex mode; no faucet; secretHex matches). | restore-seed, keypair-from-secret, both-rails-recovery, btn-restore-mode-toggle |
| 68 | mnemonic-backup-restore | The 24 mnemonic words shown at create time recover the exact same wallet keypair (publicHex match) when entered on restore. | mnemonic-backup, mnemonic-word-{0..23}, mnemonic-backup-checkbox, btn-mnemonic-continue, restore-mnemonic-input, bip39-round-trip, restore-via-mnemonic |

### Payments (the core offline-pay flow)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 06 | request-qr | Merchant enters amount → request QR renders AND decodes to a valid 132-byte request (to_name + memo). | request-qr, encode, merchant, to-name, memo |
| 07 | scan-pay | Payer scans → reviews → approves: two-wallet real ed25519 sign + relay settle → 'Paid ✓', balances correct. | scan, sign, settle, receipt, history, recipient-name |
| 08 | merchant-settle | Merchant side sees the incoming payment settle → recipient 'Received $X' confirmation. | receive, settle, confirmation |
| 09 | double-spend | Replay of a captured signed code is refused (nonce single-use), no double debit. | replay-defense, nonce, single-use |
| 10 | expired | Payer scans an already-expired request → refused, Approve disabled, no leaked nonce. | expiry, disabled-approve |
| 19 | low-balance | Insufficient funds: offline review-lowbal warning; online Approve disabled, 'Not enough balance'. | low-balance, insufficient, disabled-approve |
| 25 | asset-request | ckBTC chip + BTC amount → request QR encodes RUNTIME currency 1 + 50000 sats; readout '0.00050000 BTC' (no $). | asset-request, ckbtc, currency-id, encode, btc-units |
| 26 | names-memo | Alice pays Bob with memo 'coffee' → both histories show friendly names + memo (wire-format v2, no raw hex). | names, memo, history, wire-v2, friendly-counterparties |
| 27 | asset-pay | ckBTC pay: review shows '0.00050000 BTC' (no $); per-asset balance gate (60000≥50000 sats) → settles on currency 1; Ledger row shows the exact ckBTC units. | asset-pay, ckbtc, per-asset-balance, locked-asset-display, ledger-units |
| 28 | ckusdc-request | ckUSDC chip + 0.05 amount → request QR encodes currency 2 + 50000 raw (6-dec); readout '0.050000 USDC' (no $0.05). | ckusdc-merchant-create, request-asset-picker, multi-currency, 6-decimal, byte-exact |
| 29 | exact-amount | Raw amount > 2^53 round-trips byte-exact through faucet/request-wire/sign/settle (BigInt codec, u64 LE). | exact-amount, decimal-transport, u64, bigint-codec |
| 30 | trusted-receipt | Malicious relay returns a wrong-key receipt → app's key-pin rejects it → honest 'Couldn't verify', no debit. | receipt-key-pin, malicious-relay, honest-error |
| 31 | ckusdc-pay | ckUSDC (currency 2, 6-decimal) pay end-to-end: review '0.050000 USDC', byte-exact raw, settles on currency 2. | ckusdc-pay, multi-currency, 6-decimal, byte-exact |
| 36 | bad-qr | Scanning/pasting garbage (non-base64 + wrong-length) surfaces a friendly 'This isn't't a dpay payment code' error; review never mounts; scan surface re-arms. | bad-qr, malformed, error-handling, input-validation |
| 42 | receipt-reject | Tampered receipt (wrong pubkey / flipped sig) → verifyOutcomeReceipt rejects → honest "Couldn't verify", no fake Paid ✓, no debit. | receipt, receipt-reject, malicious-relay, verifyOutcomeReceipt |
| 43 | decimal-edges | 8-dec (ckBTC) + 6-dec (ckUSDC) + 18-dec (ckDAI) amounts render with exact decimals on review (no rounding, no sci-notation, no trailing-zero drift). | decimal, format, ckbtc, ckerc20, 18-decimal |
| 49 | deeplink-request | dpay:req deeplink opens the pay review screen pre-filled with the merchant request (no auto-approve). | deeplink, request-link, prefill, pay-review |
| 50 | deeplink-receipt | merchant verifies a dpay:pay receipt (canister-signed) via the web ?pay= path + reconciles as Received. | deeplink, receipt-link, verify, receive, handback |
| 59 | share-receipt | After an online settle, btn-share-receipt hands a dpay:pay/<base64url> receipt link to Share. | share-receipt, receipt-link, handback, online-settle, deeplink |
| 61 | merchant-received-name | Merchant's 'Received' confirmation shows the payer's friendly name (from_name) — not the raw short pubkey prefix — when the payer chose a name. | receive, settle, confirmation, from-name, wire-v2, friendly-counterparties |

### Offline hand-off (the signature feature)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 20 | offline-handoff | Payer signs offline → relay unreachable → signed QR → merchant settles → payer reconnects → 'Paid ✓'. | offline-sign, qr-handoff, settle, reconcile, round-trip |
| 21 | receive-scan | Merchant 'Payer paid offline? Scan to settle' → scans the payer's signed QR → settles. | receive-scan, offline-settle |
| 46 | sol-offline-handoff | SOL v2 scan solreq:v2 → offline sign (no setup, no nonce) → solpay:v2 QR → honest pending. | sol-offline-sign, qr-handoff, honest-pending |
| 51 | sol-merchant-broadcast | SOL v2 merchant: createSolPaymentRequest (ONLINE) → scan real signed solpay → broadcast → Received. | sol-merchant, sol-broadcast, sol-v2-strict-verify, qr-scan |
| 53 | sol-merchant-error | SOL v2 merchant broadcast error surfaces a friendly message (not raw RPC, not false Received). | sol-merchant, sol-error, sol-v2-rejected, friendly-error |
| 67 | sol-setup-error | SOL v2: SolPayMode mounts in scan with no setup; valid req signs offline; expired req is rejected with a friendly error. | sol-no-setup, sol-expired-request, sol-v2-freshness |
| 74 | sol-usdc-payment | USDC@Sol v2 full cycle: createSolPaymentRequest (USDC) → signSplPayment (TransferChecked) → broadcast → Received. | sol-usdc-payment, sol-spl-sign, sol-merchant, sol-broadcast, sol-v2-strict-verify |

### Deposits & onramp (ckBTC + ckUSDC + ckERC20)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 03 | deposit-address | ckBTC deposit sheet: address + QR + instructions + fee/min; deep-link ?screen=deposit works. | deposit-address, qr, instructions, fee-min, deep-link |
| 04 | deposit-copy | 'Copy address' writes the REAL address to the clipboard (not the Share noop). | deposit-address, clipboard |
| 05 | deposit-credited | ckBTC deposit lands via test-helpers seed → 'Deposited ✓', balance updates, asset card appears. | deposit-credit, mint, asset-card, balance-update |
| 16 | ckusdc-onramp | ckUSDC onramp: connect wallet → enter USDC → approve+deposit (EIP-1193 seam, byte-exact calldata, ETH gas note). | ckusdc, onramp, eip-1193, calldata, eth-gas |
| 22 | deposit-error | Relay unreachable when opening the deposit sheet → honest error ('Check connection'), no spinner-forever. | deposit-error, offline, graceful |
| 33 | ckerc20-persist | ckERC20 deposit watching PERSISTS across restart: reload rehydrates watching (no reconnect), resumed notice shown. | ckerc20, persist, restart, watching-resume |
| 34 | onramp-provider-resolution | Onramp resolver: window.ethereum wins when present; WC branch unreachable on web even when 'configured' → honest null. | onramp-resolver, eip-1193, walletconnect-gate |
| 45 | sol-receive | Native SOL rail: device-derived SOL card in Balances + receive address QR via the Receive tab "My address" sub-mode (offline, no devnet). | sol-card, sol-derive, sol-receive, qr, address, sol-tab-ia, sol-clipboard |

### Withdrawal (ckBTC cash-out)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 15 | withdraw | Withdraw ckBTC: enter addr + amount → sign on-device → settle; success screen + Copy destination; balance debits at both the ledger AND the UI (Balances row drops to 0.00050000 BTC). | withdraw, sign, settle, clipboard, balance-delta, destination-copy, ui-balance-delta |
| 18 | withdraw-errors | Withdraw UI guards: below-min / over-balance / bad-addr warnings disable the confirm button (relay 4xx gates covered relay-direct in relay.rs). | withdraw-errors, below-min, over-balance, bad-addr |
| 44 | cketh-withdraw | Withdraw native ckETH: Cash-out button renders for a CkEthErc20 + token_contract=null asset; enter 0x addr + ETH amount → sign on-device at 18-dec Wei → settle; balance debits at both the ledger AND the UI (family-dispatch UI path). | native-eth-withdraw, cketh, family-dispatch, withdraw, sign, settle, balance-delta, ui-balance-delta |
| 48 | ckusdc-withdraw | ckUSDC Cash-out: the flipped cashable gate renders Cash-out for a ckERC20 token; enter 0x addr + USDC amount → gas-dependency note renders → sign on-device at 6-dec → settle; balance debits at both the ledger AND the UI. | ckerc20-offramp, cashable-gate, ckusdc, withdraw, sign, settle, balance-delta, ui-balance-delta, gas-note |
| 52 | sol-withdraw | SOL withdraw: select SOL → Pay tab "Send to address" → enter addr+amount → sign+broadcast (stub) → Sent ✓. | sol-withdraw, sol-send, sol-tab-ia, sign |
| 56 | withdraw-saved-addr | A successful withdraw persists the destination (AsyncStorage); reopening the sheet shows a "Use last" chip that pre-fills the address input. | saved-address, btn-withdraw-saved, withdraw-persist |
| 77 | sol-usdc-withdraw | USDC send to address: happy path (USDC units + rent disclosure note → Sent ✓) and the below-rent pre-check failure (friendly error, no Sent). | sol-usdc-withdraw, spl-transfer, ata-note, rent-precheck, sol-send |

### NFC (tap-to-pay)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 11 | nfc | NFC phase transitions (Idle→Linking→Exchanging→Settling→Complete) render via the RNW event bus. | nfc-phases, event-bus |
| 32 | nfc-disclosure | NFC asset disclosure: mid-tap the status shows honest asset name + network + '0.00050000 BTC' BEFORE success. | nfc-disclosure, consent, asset-name, network |
| 47 | sol-nfc | SOL v2 NFC tap: arm card → auto-sign → receipt (rid+sig match) → Paid ✓ | sol-nfc, sol-v2-receipt, event-bus |
| 60 | nfc-error | NFC tap failure modes: a mid-tap transport error surfaces honest "Tap failed" (not Paid ✓); a decline surfaces "Declined"; a late error after settling is ignored (no false failure over a decided outcome). | nfc-error, nfc-declined, nfc-phases, error-handling, no-fake-paid, terminal-escape |
| 66 | sol-nfc-error | SOL v2 NFC tap failure modes: expired solreq → Declined + expired; transport error → Tap failed; late error after settling ignored; merchant reader sees the decline. | sol-nfc-decline, sol-nfc-error, sol-nfc-receipt-unreachable, sol-nfc-phases, sol-nfc-reader-decline, no-fake-paid, terminal-escape |

### Settings & system

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 12 | settings | Settings: privacy policy is reachable, relay URL persists, and reset wallet wipes identity. | settings, relay-config, privacy-policy, reset, persist |
| 13 | offline | Relay down → faucet top-up surfaces honest 'Offline' (ECONNREFUSED, not unsafe-port), no crash; retry path. | offline, econnrefused, graceful, retry, right-reason |
| 14 | keyboard | Single-key shortcuts (P/R/T/A/L/Esc) switch tabs / top-up / add-money / ledger / close sheet; input + sheet guards work. | keyboard-shortcuts, tabs, sheet-guard, input-guard |
| 17 | scan-cleanup | Switch Pay→Receive→Pay: QrScanner listeners tear down cleanly (no leak across unmount/remount). | qr-scanner, teardown, unmount, listener-leak |
| 24 | wallet-cleanup | Seeded non-dollar balances/history render as asset cards/rows with known symbols (presence, not exact units). | asset-cards, labels, symbols |
| 38 | relay-retarget | Settings relay-switch retargets the LIVE balance poll: header changes from A's ∂100.00 to B's ∂500.00. | relay-retarget, settings-relay-switch, live-poll |
| 41 | a11y-census | Every interactive element (btn-*/tab-*/inputs/picker rows) carries a non-empty aria-label + role on every primary surface. | a11y, accessibility, aria |
| 55 | balances-select-asset | Selecting an asset in Balances binds the header: chip DEMO→ckBTC→SOL and the balance text follows the active-rail branch. | asset-select, header-balance-binding, active-rail-chip |
| 57 | settings-seed-backup | Seed stays hidden behind a confirm gate; once revealed the 24 mnemonic words show by default, hex view toggles in and matches identity.secretHex; copy writes the seed to the real clipboard. | seed-backup, confirm-gate, secret-reveal, clipboard-copy, mnemonic-backup, mnemonic-word-{0..23}, btn-backup-show-hex, btn-copy-mnemonic, btn-copy-seed |
| 63 | picker-sol-rail | SOL is selectable in the Receive currency picker → switches the active rail to SolReceiveMode. | receive-picker, sol-rail, currency-switch |
| 64 | settings-restore | Settings → Restore replaces wallet identity from 64-hex seed (no wipe); username preserved. | restore-seed, settings-restore, identity-replace, keypair-from-secret |
| 69 | sol-usdc-selection | IC USDC ↔ Solana USDC: unified picker switches rail + clears amount (symmetric in both directions). | asset-picker, ic-usdc, sol-usdc, rail-switch, amount-clear |
| 70 | deeplink-ic-routing | A dpay:req deeplink arriving while SOL is idle-selected routes to the IC Pay engine (PayMode review), not SolPayMode — the blob is never silently lost. | deeplink-routing, ic-engine-routing, solana-to-ic-handoff, prefill-preserve |
| 71 | selection-lock | An in-flight pay review locks the idle asset selection: the Balances button is disabled + a no-op, and canceling the review re-enables it. | selection-lock, in-flight-preserve, balances-disable, nfc-arming-invariant |
| 72 | sol-usdc-send | Solana USDC "Send to address": fail-closed device-ATA gate → one-tap create (busy → form appears) and the create-failure leg (err shown, sheet stays usable). | sol-usdc-send, spl-transfer, fail-closed-ata, asset-aware-send, ata-create-one-tap |
| 75 | seam-fail-loud | Every injection seam (scan/NFC/SOL-NFC) throws when no listener is mounted — regression guard against silent-drop bugs. | seam-integrity, fail-loud, regression-guard |
| 76 | sol-usdc-ata-gate | USDC receive gate: absent→setup card + Request blocked; insufficient→disabled; funded→one-tap create flips to the address QR; balance→direct address. | sol-usdc, ata-gate, tri-state, ata-setup-card, request-block, ata-create |

### Visual capture (UX tour)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 35 | ux-tour | Visual capture: screenshots of every major screen (Pay, Receive+QR, Balances, Settings, Ledger) for review. | visual-capture, screen-census, screenshots |
| 39 | store-screens — optional (`just e2e-store`) | Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit). | visual-capture, store-screenshots |
| 40 | visual-regression | Pixel-diff the 5 primary surfaces (Pay, Receive+QR, Balances, Settings, Ledger) vs committed baselines; fails on drift >0.5%. | visual-regression, pixel-diff |

---

## Coverage gaps (honestly documented)

These flows are **not** covered and why:

- **Exact 2/6/8/18-decimal amount transport at the JS/Kotlin boundary** — `29-exact-amount` proves the >2^53 raw amount round-trips byte-exact through the TS↔relay stack, but values around `2^53` and excess fractional input at the Kotlin/UniFFI boundary are not exercised.
- **Non-dollar NFC consent over the radio** — `11-nfc` + `32-nfc-disclosure` inject JS phase/request events; they do not carry a real nonzero-currency request over the actual ISO-DEP radio (physical-device gate).
- **Android React Native bridge parity** — instrumented tests mostly exercise UniFFI directly, not the full `NativeModules` argument/return surface.
- **External-credit balance freshness** — deposit tests assert direct ledger/FakeLedger credit while missing stale facade `BAL_CACHE` behavior.
- **NFC radio round trip** (two phones, HCE↔reader, full wire transit over ISO-DEP) — physical-device gate; the web NFC shim's `approveCard(wireHex)` is a no-op, so driving the full round trip would inject the wire the test built itself (false confidence). Signing/settlement are byte-exact in `00`; phase plumbing in `11`.
- **ckUSDC onramp final ETH hop** (wallet signs → tx mined → minter scrapes ~20min) — inherent outer-loop gate; offline e2e proves the calldata wiring + byte-exactness.
- **ckBTC live deposit/withdrawal with real BTC** — requires real mainnet funds; offline path proven via FakeLedger seed (issues 1/8 in OPEN_ISSUES.md).

> **Closed gaps:** destination-address format validation (`18-withdraw-errors`); the multi-currency Ledger row exact units (folded into `27-asset-pay`); the withdraw UI balance delta (folded into `15-withdraw`); malformed-QR scanning (`36-bad-qr`); onboarding-time faucet failure against a dead relay (`37-onboard-no-faucet`).

---

## How to add a new flow

1. Copy `e2e/tests/NN-name.mjs` → `e2e/tests/<next>-<slug>.mjs` (zero-padded number).
2. Edit the `meta` export at the top: `id`, `name` (the slug), `journey` (a value from the matrix above), `covers` (slugs), `verifies` (one line), `timeoutMs`.
3. Import `{setup, onboardWallet, assert, ...}` from `../harness/lib.mjs`.
4. `export async function run() { ... }` — the harness calls it; `setup()` returns `{driver, relayBaseURL, ...}`.
5. Call `onboardWallet(ctx.driver, 'name')` to get a funded wallet in <1s.
6. Use `findByTestID`, `waitForText`, `click`, `type` from the driver. Take a screenshot: `ctx.driver.screenshot('NN-name')`.
7. Assert behavior (button states, text content, balance changes) — not pixel layout.
8. Run: `DPAY_E2E_FILTER=<id|name|journey> node e2e/run.mjs` to iterate in <10s (one flow or one journey), then `just e2e` for the full suite.
9. Regenerate this file: `node e2e/gen-flows-md.mjs` (commits the new row).

### Conventions

- **testID + textContent only.** The e2e net does NOT pixel-diff. Style regressions are invisible to the suite — keep `styles.ts` as ONE `StyleSheet.create` block.
- **Fast-poll seam.** `globalThis.__DPAY_TEST_POLL` is injected by the harness (150ms intervals). Never hardcode a `setTimeout` that depends on the prod poll interval.
- **One relay per run.** The relay + web server + browser are shared; each test gets a fresh incognito context (fresh identity, no cross-test state). Serialize web-building runs (the `e2e/dist` cache is a shared path).
- **Browser errors fail closed.** Page exceptions, app `console.error`, `DPAY_SELFCHECK FAIL`, and failed requests make the owning flow RED at teardown. A deliberate offline flow must call `driver.allowRequestFailuresFrom(deadOrigin)` before retargeting, scoped to its unique closed-port origin.
- **No broad mocking.** The `fetch` recorder in `09-double-spend` is the sanctioned pattern: narrow (one route), transparent (calls through), self-uninstalling.
- **Per-test timeout.** Each flow's `meta.timeoutMs` is enforced by the orchestrator — a hung test fails loudly instead of stalling the pool.
