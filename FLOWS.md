# E2E Test Flows — Manifest

> The authoritative catalog of every user flow tested by the e2e harness (`e2e/`).
> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome
> against a real test relay (FakeLedger, offline). No UI stubs. The only shimmed I/O boundary is
> the camera scan (sanctioned smallest-boundary seam) and the NFC radio (physical-device gate).
>
> **Run:** `just e2e` (all flows, ~15s) · `DPAY_E2E_FILTER=07 node e2e/run.mjs` (one flow) ·
> `DPAY_E2E_FILTER=07,15 node e2e/run.mjs` (subset).

## How to read this

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|

Flows are numbered `NN-name.mjs` in `e2e/tests/`. Categories group related flows; within a category,
positive paths come first, then error/edge paths.

---

## Wire-format cross-validation (no browser)

| # | Flow | Verifies |
|---|------|----------|
| 00 | cross-val | JS ed25519 shim is **byte-exact** vs the Rust core: withdraw signing_hex/sig_hex, pay golden, and receipt-claim golden all reconstruct from `wire_layout.json` offsets and verify. ~0.1s, no browser/relay. |

## Onboarding & funding

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 01 | onboard | New user enters name → taps "Create & fund wallet" | Wallet created, $100 funded, balance visible. |
| 02 | faucet | Returning user taps "Add demo money" | Faucet top-up works, balance increases. |
| 23 | username-default | New user leaves name empty → creates | Defaults to 'me', onboards + funds successfully. |

## Payments (the core offline-pay flow)

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 06 | request-qr | Merchant enters amount → shows request QR | QR renders AND decodes to a valid 132-byte request (incl. to_name + memo). |
| 07 | scan-pay | Payer scans request → reviews → approves | Two-wallet real ed25519 sign + relay settle → "Paid ✓", balance correct. Recipient name shown ("to Bob"). |
| 08 | merchant-settle | Merchant side: sees incoming payment → settles | The recipient's "Received $X" confirmation. |
| 09 | double-spend | Attacker replays a captured signed code | Replay refused (nonce single-use), no double debit. |
| 10 | expired | Payer scans an already-expired request | Expiry refused, Approve button disabled, no leaked nonce. |
| 19 | low-balance | Payer with insufficient funds scans a request | Offline: review-lowbal warning. Online: Approve disabled, "Not enough balance". |
| 26 | names-memo | Alice pays Bob with memo "coffee" | Both wallets' history shows friendly names (from_name/to_name) + memo, no raw-hex counterparties. Proves N6/H3 closure via wire-format v2. |

## Offline hand-off (the signature feature)

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 20 | offline-handoff | Payer signs offline → relay unreachable → shows signed QR → merchant settles later → payer reconnects | Full round trip: offline sign → QR hand-off → online settle → receipt reconciliation → "Paid ✓". |
| 21 | receive-scan | Merchant: "Payer paid offline? Scan their signed code" → scans payer's signed QR | Receive-side scan path settles the offline payer's signed code. |

## Deposits (ckBTC + ckUSDC onramp)

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 03 | deposit-address | User opens ckBTC deposit sheet | Address + QR + instructions + fee/min (or "—" if zero). Deep-link `?screen=deposit` works. |
| 04 | deposit-copy | User taps "Copy address" | REAL clipboard write (not Share noop). |
| 05 | deposit-credited | ckBTC deposit lands via test-helpers seed | "Deposited ✓" after mint, balance updates, asset card appears. |
| 16 | ckusdc-onramp | User connects wallet → enters USDC amount → approves+deposits | Wiring of the non-custodial ckERC20 flow (calldata byte-exact, EIP-1193 seam). ETH gas note shown. |
| 22 | deposit-error | Relay unreachable when opening deposit sheet | Honest error ("Check your connection"), no spinner-forever. |

## Withdrawal (ckBTC cash-out)

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 15 | withdraw | User enters BTC address + amount → confirms | Withdrawal submitted, success screen with copy-destination button. |
| 18 | withdraw-errors | Below-min / over-balance / relay-rejected | UI guards (confirm disabled) + relay-level 422 enforcement (bad-sig/insufficient/below-min). |

## NFC (tap-to-pay)

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 11 | nfc | Tap phase transitions (Idle→Linking→Exchanging→Settling→Complete) | NFC seam wired to RNW event bus; phase UI renders. (Radio hop = physical-device gate.) |

## Settings & system

| # | Flow | User journey | Verifies |
|---|------|-------------|----------|
| 12 | settings | User opens Settings → edits relay URL → resets wallet | Relay URL persists across reload; reset wipes identity → back to onboarding. |
| 13 | offline | Relay goes down → user tries top-up | Graceful offline (ECONNREFUSED), no crash/blank, retry path. |
| 14 | keyboard | User presses P/R/T/A/Esc keys | Single-key shortcuts switch tabs / top-up / add-money / close sheet. Input-guard + sheet-guard work. |
| 17 | scan-cleanup | Switch Pay→Receive→Pay | QrScanner listeners teardown correctly (no leak across unmount/remount). |
| 24 | wallet-cleanup | Multi-currency wallet view | Asset labels use symbol ("ckBTC"/"ckUSDC"), multi-currency history, header shows username only, counterparties are short hex. |

---

## Coverage gaps (honestly documented)

These flows are **not** covered and why:

- **NFC radio round trip** (two phones, HCE↔reader, full wire transit over ISO-DEP) — physical-device gate; the web NFC shim's `approveCard(wireHex)` is a no-op, so driving the full round trip would inject the wire the test built itself (false confidence). Signing/settlement are already byte-exact in `00`; the phase plumbing is proven in `11`. (The v2 wire is now 292 B → 2 ISO-DEP frames; the multi-frame chunking path is unit-tested in core, but the over-the-air round trip still needs two phones.)
- **ckUSDC onramp final ETH hop** (wallet signs → tx mined → minter scrapes ~20min) — inherent outer-loop gate; offline e2e proves the calldata wiring + byte-exactness.
- **ckBTC live deposit/withdrawal with real BTC** — requires real mainnet funds; offline path proven via FakeLedger seed (issues 1/8 in OPEN_ISSUES.md).

> **Closed gap:** destination-address format validation is now covered (flow `18-withdraw-errors`
> asserts a bad-addr UI warning + disabled confirm), so it no longer appears above.

## How to add a new flow

1. Copy `e2e/tests/NN-name.mjs` → `e2e/tests/<next>-<slug>.mjs` (zero-padded number).
2. Import `{setup, onboardWallet, assert, ...}` from `../harness/lib.mjs`.
3. `export async function test(ctx) { ... }` — the harness calls it with `{driver, relayBaseURL, ...}`.
4. Call `onboardWallet(ctx.driver, 'name')` to get a funded wallet in <1s.
5. Use `findByTestID`, `waitForText`, `click`, `type` from the driver. Take a screenshot: `ctx.driver.screenshot('NN-name')`.
6. Assert behavior (button states, text content, balance changes) — not pixel layout.
7. Run: `DPAY_E2E_FILTER=<number> node e2e/run.mjs` to iterate in ~10s (one flow), then `just e2e` for the full suite.
8. Add a row to the table above.

### Conventions

- **testID + textContent only.** The e2e net does NOT pixel-diff. Style regressions are invisible to the suite — keep `styles.ts` as ONE `StyleSheet.create` block.
- **Fast-poll seam.** `globalThis.__DPAY_TEST_POLL` is injected by the harness (150ms intervals). Never hardcode a `setTimeout` that depends on the prod poll interval.
- **One relay per run.** The relay + web server + browser are shared; each test gets a fresh incognito context (fresh identity, no cross-test state). Serialize web-building runs (the `e2e/dist` cache is a shared path).
- **No broad mocking.** The `fetch` recorder in `09-double-spend` is the sanctioned pattern: narrow (one route), transparent (calls through), self-uninstalling.
