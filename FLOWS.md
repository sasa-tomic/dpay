# E2E Test Flows — Manifest

> The authoritative catalog of every user flow tested by the e2e harness (`e2e/`). **40 flows.**
> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome
> against a real test relay (FakeLedger, offline). No UI stubs. The only shimmed I/O boundary is
> the camera scan (sanctioned smallest-boundary seam) and the NFC radio (physical-device gate).
>
> **This file is GENERATED** by `node e2e/gen-flows-md.mjs` from each flow's `meta` export. Never
> hand-edit the tables — edit the `meta` and re-run. Only the "Coverage gaps" / "How to add" prose
> is hand-maintained (inside that script).
>
> **Run:** `just e2e` (all flows, ~18s) · `DPAY_E2E_FILTER=07 node e2e/run.mjs` (one flow) ·
> `DPAY_E2E_FILTER=pay node e2e/run.mjs` (a whole journey) · `DPAY_E2E_FILTER=07,15 node e2e/run.mjs` (subset).

## Coverage matrix

Flows grouped by user journey; within each table, every row lists what the flow **verifies** and
the behavior **covers** slugs (the latter are filterable: `DPAY_E2E_FILTER=<slug>`).

wire (1) · onboard (4) · pay (14) · offline (2) · deposit (7) · withdraw (2) · nfc (2) · system (6) · tour (2)

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
| 37 | onboard-no-faucet | Onboard against a dead relay → wallet created with $0 (∂100 never shown), honest "~ approx." offline indicator, faucet fails with ECONNREFUSED. | onboard, faucet-failure, offline, dead-relay, right-reason, zero-balance |

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
| 36 | bad-qr | Scanning/pasting garbage (non-base64 + wrong-length) surfaces an honest 'bad request QR' error; review never mounts; scan surface re-arms. | bad-qr, malformed, error-handling, input-validation |

### Offline hand-off (the signature feature)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 20 | offline-handoff | Payer signs offline → relay unreachable → signed QR → merchant settles → payer reconnects → 'Paid ✓'. | offline-sign, qr-handoff, settle, reconcile, round-trip |
| 21 | receive-scan | Merchant 'Payer paid offline? Scan to settle' → scans the payer's signed QR → settles. | receive-scan, offline-settle |

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

### Withdrawal (ckBTC cash-out)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 15 | withdraw | Withdraw ckBTC: enter addr + amount → sign on-device → settle; success screen + Copy destination; balance debits at both the ledger AND the UI (Balances row drops to 0.00050000 BTC). | withdraw, sign, settle, clipboard, balance-delta, destination-copy, ui-balance-delta |
| 18 | withdraw-errors | Withdraw errors: below-min / over-balance / bad-addr UI guards (confirm disabled) + relay 422 (bad-sig/insufficient). | withdraw-errors, below-min, over-balance, bad-sig, bad-addr |

### NFC (tap-to-pay)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 11 | nfc | NFC phase transitions (Idle→Linking→Exchanging→Settling→Complete) render via the RNW event bus. | nfc-phases, event-bus |
| 32 | nfc-disclosure | NFC asset disclosure: mid-tap the status shows honest asset name + network + '0.00050000 BTC' BEFORE success. | nfc-disclosure, consent, asset-name, network |

### Settings & system

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 12 | settings | Settings: privacy policy is reachable, relay URL persists, and reset wallet wipes identity. | settings, relay-config, privacy-policy, reset, persist |
| 13 | offline | Relay down → faucet top-up surfaces honest 'Offline' (ECONNREFUSED, not unsafe-port), no crash; retry path. | offline, econnrefused, graceful, retry, right-reason |
| 14 | keyboard | Single-key shortcuts (P/R/T/A/Esc) switch tabs / top-up / add-money / close sheet; input + sheet guards work. | keyboard-shortcuts, tabs, sheet-guard, input-guard |
| 17 | scan-cleanup | Switch Pay→Receive→Pay: QrScanner listeners tear down cleanly (no leak across unmount/remount). | qr-scanner, teardown, unmount, listener-leak |
| 24 | wallet-cleanup | Seeded non-dollar balances/history render as asset cards/rows with known symbols (presence, not exact units). | asset-cards, labels, symbols |
| 38 | relay-retarget | Settings relay-switch retargets the LIVE balance poll: header changes from A's ∂100.00 to B's ∂500.00. | relay-retarget, settings-relay-switch, live-poll |

### Visual capture (UX tour)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 35 | ux-tour | Visual capture: screenshots of every major screen (Pay, Receive+QR, Balances, Settings, Ledger) for review. | visual-capture, screen-census, screenshots |
| 39 | store-screens | Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit). | visual-capture, store-screenshots |

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
