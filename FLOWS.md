# E2E Test Flows — Manifest

> The authoritative catalog of the chrome flow tier (`e2e/`). **9 flows**
> (9 in the default `just e2e` run).
> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome
> against a real test relay with an in-process fake-IC `/api/v2` gateway (offline). The app signs
> real user-principal IC envelopes; the fake gateway verifies and settles them exactly like the
> boundary nodes would (the relay's catalog/faucet sugar persists around it). No UI stubs. The
> only shimmed I/O boundary is the camera scan (sanctioned smallest-boundary seam) and the NFC
> radio (physical-device gate).
>
> **RETIRED TO JEST (2026-09):** the other 201 chrome flows no longer exist under `e2e/tests/`.
> Per the jest-flow-migration porting map they run as jest twins: behavioral flows at
> `app/__tests__/flow/<domain>/NN-slug.test.tsx` (`just flow`), the real-chain EVM proofs
> (former flows 219/220/222) at `app/__tests__/node-anvil/` (`just node-anvil`), and the
> ALREADY-COVERED ids (00, 34, 92, 105, 160) in the pre-existing jest suites the map names.
> Chrome remains ONLY for this catalog (visual capture, pixel baselines, QR scannability,
> viewport/layout metrics, PWA boot) plus the `just e2e-visual` pixel gate.
>
> **This file is GENERATED** by `node e2e/gen-flows-md.mjs` from each flow's `meta` export. Never
> hand-edit the tables — edit the `meta` and re-run. Only the "Coverage gaps" / "Where a new flow
> goes" prose is hand-maintained (inside that script).
>
> **Run:** `just e2e` (the visual flows — merge gate) · `DPAY_E2E_FILTER=NN node e2e/run.mjs` (one flow) ·
> `just e2e-visual` (the pixel-diff gate alone) · `just e2e-store` (the Play Store capture).

## Coverage matrix

Flows grouped by user journey; within each table, every row lists what the flow **verifies** and
the behavior **covers** slugs (the latter are filterable: `DPAY_E2E_FILTER=<slug>`).

pay (1) · offline (1) · system (2) · tour (5)

---

### Payments (the core offline-pay flow)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 146 | money-forms-fit | The two forms a user types money into — the checkout charge-open (the shared Receive amount row with the checkout checkbox checked) and Send-to-address — render entirely inside the phone viewport in both a short and the app’s longest locale: each form’s mode surface is no wider than its content column, and every rendered box in it (the unit prefix, the amount fields, the Max button, the hints and the primary buttons) sits between the two viewport edges with no horizontal page scroll. | checkout, merchant-checkout, send-to-address, layout, viewport-fit, receive, vchf, i18n, regression |

### Offline hand-off (the signature feature)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 151 | offline-web-boot | The shipped /wallet is served by its service worker after the origin is killed — the app reaches READY, generates a key offline, and /api/v1/* is still refused rather than served stale. | offline, cold-start, service-worker, web-prod, pwa, honesty |

### Settings & system

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 158 | header-fits | With a long username the header stays inside the phone column and keeps its shape: the wordmark renders on ONE line (never one glyph per line), the account chip sits BELOW the identity row and spans the column, the chip stays fully on screen, and the username truncates on screen while header-who still carries the whole name. Home renders NO chip at all — it would name a different account than its own headline — and keeps its labelled Accounts pill as the single switcher. | header, layout, overflow, home-tab, a11y |
| 83 | mobile-viewport | On a 390px mobile-web viewport the tab row fits: no horizontal document overflow and the Transactions tab renders fully inside the viewport. | layout, viewport |

### Visual capture (UX tour)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 35 | ux-tour | Visual capture: screenshots of every major screen (Pay, Receive+QR, Home, Accounts, Settings, Ledger) for review. | visual-capture, screen-census, screenshots |
| 39 | store-screens | Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit), rail-funded. | visual-capture, store-screenshots |
| 40 | visual-regression | Pixel-diff the 8 surfaces (6 primary — Pay, Receive+QR, Home, Accounts, Settings, Ledger — plus the convert venue-chooser and pre-sign checklist, on a private two-venue relay) vs committed light baselines, failing on drift >0.5%; and prove the ledger amount cannot be moved by a wider timestamp, so a baseline can only go red for a code change. | visual-regression, pixel-diff, row-layout, convert, venue-chooser |
| 78 | qr-scannable | every rendered <QrCode> stays machine-decodable: request-qr (244/M + brand mark) decodes to the exact encoded value (__DPAY_QR_LAST byte-for-byte) and sol-receive-qr (200/L) decodes to the Solana Pay URI — solana:<address>?reference=<base58> for SOL, solana:<owner>?spl-token=<USDC mint>&reference=<base58> for USDC — rasterized pixels through the same vendored jsQR the prod web wallet ships | qr-scannable, qr-brand-mark, quiet-zone, solana-pay |
| 84 | visual-dark | Pixel-diff the 8 surfaces (6 primary + the convert venue-chooser and pre-sign checklist, on a private two-venue relay) under an emulated OS dark scheme (prefers-color-scheme: dark) vs the dark-theme baselines in shots/baselines-dark/; the gate that the DARK palette renders on every surface the light flow walks. | visual-regression, pixel-diff, dark-theme, convert, venue-chooser |

---

## Coverage gaps (honestly documented)

These behaviors are **not** covered and why (the jest twins inherit each gap):

- **Exact 2/6/8/18-decimal amount transport at the JS/Kotlin boundary** — the jest twin (`app/__tests__/flow/pay/29-exact-amount.test.tsx`) proves the >2^53 raw amount round-trips byte-exact through the TS↔relay stack, but values around `2^53` and excess fractional input at the Kotlin/UniFFI boundary are not exercised.
- **Non-dollar NFC consent over the radio** — the jest twin (`app/__tests__/flow/nfc/ic-card.test.tsx`) injects JS phase/request events; it does not carry a real nonzero-currency request over the actual ISO-DEP radio (physical-device gate).
- **Android React Native bridge parity** — instrumented tests mostly exercise UniFFI directly, not the full `NativeModules` argument/return surface.
- **External-credit balance freshness** — the jest deposit twins assert direct ledger/FakeLedger credit while missing stale facade `BAL_CACHE` behavior.
- **NFC radio round trip** (two phones, HCE↔reader, full DPN2 + signed-result transit over ISO-DEP) — physical-device gate. The jest twin (`app/__tests__/flow/nfc/error-paths.test.tsx`) proves the merchant and offline-payer ownership halves; `just ondevice` proves request→fragmented bundle→authenticated C6 result through the real core/UniFFI state machines. Only antenna coupling and Android AID routing between two physical phones remain.
- **ckUSDC onramp final ETH hop** (wallet signs → tx mined → minter scrapes ~20min) — inherent outer-loop gate; the jest twin proves the calldata wiring + byte-exactness.
- **ckBTC live deposit/withdrawal with real BTC** — requires real mainnet funds; offline path proven via FakeLedger seed (issues 1/8 in OPEN_ISSUES.md).

> **Closed gaps:** destination-address format validation (jest `destination.test.ts` + `flow/withdraw/send-to-address.test.tsx`); the multi-currency Ledger row exact units (folded into `flow/pay/27-asset-pay.test.tsx`); the withdraw UI balance delta (folded into the withdraw jest flow); malformed-QR scanning (`flow/pay/36-bad-qr.test.tsx`); onboarding-time faucet failure against a dead relay (`flow/onboard/01-onboard.test.tsx` dead-relay branch).

---

## Where a new flow goes (the chrome tier is FROZEN)

1. Behavioral screen flows: `app/__tests__/flow/<domain>/NN-slug.test.tsx` — a jest full-app
   mount against the spawned test relay (`just flow`). Copy an existing twin; the harness lives
   at `app/__tests__/flow/harness/`.
2. Real-chain EVM proofs: `app/__tests__/node-anvil/` (`just node-anvil`).
3. Component/service pins: `app/__tests__/*.test.*` (`just test-app`); money-defining
   invariants may enter smoke via `app/__tests__/smoke/manifest.ts` (AGENTS.md test tiers).
4. Do NOT add chrome flows. Chrome exists only for the visual/PWA catalog above plus the
   `just e2e-visual` pixel gate.

### Conventions

- **testID + textContent only** in jest assertions too. Style regressions are invisible to
  that net — the pixel baselines (`just e2e-visual`) own them; keep `styles.ts` as ONE
  `StyleSheet.create` block.
- **Fast-poll seam.** `globalThis.__DPAY_TEST_POLL` (25ms in the jest flow harness, injected
  pre-mount). Never hardcode a `setTimeout` that depends on the prod poll interval.
- **Fail closed.** Ported flows keep the browser-e2e rule: every request/failure is recorded,
  and `driver.allowRequestFailuresFrom(origin)` pre-declares allowed dead origins — an
  undeclared failure fails the jest test at teardown.
- **No broad mocking.** Narrow (one route), transparent (calls through), self-uninstalling.
- **Per-test timeout.** Jest's 30s testTimeout is the hang backstop, the e2e `meta.timeoutMs`
  equivalent.
