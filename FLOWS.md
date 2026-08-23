# E2E Test Flows — Manifest

> The authoritative catalog of every user flow tested by the e2e harness (`e2e/`). **90 flows**
> (89 in the default `just e2e` run, 1 optional capture-only flow via the dedicated recipe).
> Each flow drives the **REAL** app (`app/App.tsx` via react-native-web) in a real headless Chrome
> against a real test relay with an in-process fake-IC `/api/v2` gateway (offline). The app signs
> real user-principal IC envelopes; the fake gateway verifies and settles them exactly like the
> boundary nodes would (the relay's catalog/faucet sugar persists around it). No UI stubs. The
> only shimmed I/O boundary is the camera scan (sanctioned smallest-boundary seam) and the NFC
> radio (physical-device gate).
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

wire (1) · onboard (13) · pay (18) · offline (8) · deposit (8) · withdraw (7) · nfc (8) · system (21) · tour (6)

---

### Wire-format cross-validation (no browser)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 00 | cross-val | JS byte builders (pay wire, request QR, amount parser, icp transfer/balance/rid) are byte-exact vs the Rust core goldens — no browser, ~0.1s. | wire-format, ed25519-parity, golden-bytes, icp-builders |

### Onboarding & funding

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 01 | onboard | New user enters a name → wallet created, faucet funds ∂100, balance + empty history render; custody honesty copy present at create + backup. | onboard, faucet, first-balance, empty-history, non-custodial |
| 02 | faucet | Returning user taps 'Add demo money' → faucet top-up works, balance increases. | faucet, topup, balance-delta |
| 23 | username-default | New user leaves name empty → creates → defaults to 'me', onboards + funds. | onboard, default-username |
| 37 | onboard-no-faucet | Onboard against a dead relay → faucet failure surfaces an honest "Continue" prompt (not a silent $0 transition), wallet created with $0 (∂100 never shown), honest "~ DEMO approx." offline indicator, faucet fails with ECONNREFUSED. | onboard, faucet-failure, offline, dead-relay, right-reason, zero-balance |
| 54 | testnet-toggle | Balances testnet toggle reveals + hides a "BTC testnet" row (catalog-driven testnet detection). | testnet, catalog, toggle, balances |
| 58 | restore-wallet | A wallet can be restored from the 64-hex recovery seed (toggle to hex mode; no faucet; secretHex matches). | restore-seed, keypair-from-secret, both-rails-recovery, btn-restore-mode-toggle |
| 68 | mnemonic-backup-restore | The 24 mnemonic words shown at create time recover the exact same wallet keypair (publicHex match) when entered on restore. | mnemonic-backup, mnemonic-word-{0..23}, mnemonic-backup-checkbox, btn-mnemonic-continue, restore-mnemonic-input, bip39-round-trip, restore-via-mnemonic |
| 82 | own-seed-create | Create a wallet from a pasted seed (words OR hex) instead of a random one; invalid seed is rejected on the form. | own-seed, btn-own-seed-toggle, own-seed-input, create-from-seed, faucet, mnemonic-backup |
| 88 | walkthrough | a fresh boot shows the walkthrough instead of the create form,scenes advance via Next; only the active scene is mounted,each scene body carries its comprehension-critical truth,the final Next reads "Get started" and reveals the create form unchanged,creating from there lands in the funded Wallet,walkthroughDone is persisted in the journey store | walkthrough, education, first-run-gate, journey-stamps |
| 89 | walkthrough-skip-replay | Skip dismisses the walkthrough instantly and reveals the create form,Skip also persists walkthroughDone,a pre-seeded walkthroughDone stamp suppresses the walkthrough on the next boot,Settings → How dpay works replays the walkthrough with a close affordance and no Skip,the replay leaves the journey store unchanged | walkthrough, education, settings-replay, journey-stamps, skip-path |
| 90 | rehearsal | the backup gate stays MANDATORY (ritual sentence reframes, never weakens: checkbox + disabled Continue),RECOVERY SAVED stamp beat plays after the faucet and auto-advances (no extra tap),the ONE-page rehearsal shows all 3 steps together with verbatim education copy + the offline punchline (mounting awards flowUnderstood),Try with demo funds lands on the funded Pay surface,recoverySaved + flowUnderstood persist in dpay.journey.v1 | recovery-ritual-sentence, mnemonic-backup-checkbox, btn-mnemonic-continue, recovery-saved-stamp, rehearsal, rehearsal-step-{1..3}, rehearsal-body-{1..3}, rehearsal-punchline, btn-rehearsal-next, btn-rehearsal-skip, flowUnderstood-stamp, recoverySaved-stamp, pay-tab-default-landing |
| 91 | coach-tips | each coaching tip mounts on its surface exactly once per identity: presence, dismiss, re-entry → absent; pendingOutcome never appears on a confirmed Paid screen; the offline hand-off still settles (counterparty submit + reconcile) | coach-payReview, coach-receiveRequest, coach-offlineQr, coach-pendingOutcome, btn-coach-*-dismiss, journey-seen-markers, one-time-coaching |
| 94 | trip-passport | Trip readiness passport: 3/4 after onboarding → confirmed payment fills the 4th → TRIP READY capstone → Done collapses the card → Settings archive keeps it forever. | readiness, funds-ready, payment-tested, capstone, collapse, archive, persistence |

### Payments (the core offline-pay flow)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 06 | request-qr | Merchant enters amount → request QR renders AND decodes to a valid 132-byte request (to_name + memo). | request-qr, encode, merchant, to-name, memo |
| 07 | scan-pay | Payer scans → reviews → approves: two-wallet real ed25519 sign + relay settle → 'Paid ✓', balances correct. | scan, sign, settle, receipt, history, recipient-name |
| 08 | merchant-settle | Merchant scans the payer's signed icrc1_transfer envelope, submits it to the IC gateway → recipient 'Received' confirmation. | receive, settle, confirmation |
| 09 | double-spend | identical-byte envelope resubmit is idempotent on the IC gateway (request_id dedup): both POSTs 202, transfer executed once, payee credited once — and re-signing is a NEW request (the never-retry-by-resigning hazard) | pay, replay-safety, confirmation |
| 10 | expired | Payer scans an already-expired request → refused, Approve disabled, no leaked nonce. | expiry, disabled-approve |
| 19 | low-balance | Insufficient funds: offline review-lowbal warning; online Approve disabled, 'Not enough balance'. | low-balance, insufficient, disabled-approve |
| 25 | asset-request | ckBTC chip + BTC amount → request QR encodes RUNTIME currency 1 + 50000 sats; readout '0.00050000 BTC' (no $). | asset-request, ckbtc, currency-id, encode, btc-units |
| 26 | names-memo | Alice pays Bob with memo 'coffee' → review shows the name + short pubkey + memo (U-F5), both histories show friendly names + memo (wire-format v2, no raw hex). | names, memo, history, wire-v2, friendly-counterparties, review-short-payee |
| 27 | asset-pay | ckBTC pay (faucet-funded at principal): review '0.00050000 BTC' (no $) + short pubkey (U-F5); per-asset balance gate (60000≥50000 sats) → app-signed icrc1_transfer settles on currency 1; Ledger row shows the exact ckBTC units. | asset-pay, ckbtc, per-asset-balance, locked-asset-display, ledger-units, review-short-payee |
| 28 | ckusdc-request | ckUSDC chip + 0.05 amount → request QR encodes currency 2 + 50000 raw (6-dec); readout '0.050000 USDC' (no $0.05). | ckusdc-merchant-create, request-asset-picker, multi-currency, 6-decimal, byte-exact |
| 29 | exact-amount | Raw amount > 2^53 round-trips byte-exact through faucet/request-wire/signed-envelope/ledger-settle on the IC rail (BigInt codec, uleb128 + u128 ledger, decimal strings). | exact-amount, decimal-transport, u64, bigint-codec |
| 31 | ckusdc-pay | ckUSDC (currency 2, 6-decimal) pay end-to-end (faucet-funded at principal): review '0.050000 USDC', byte-exact raw, app-signed icrc1_transfer settles on currency 2. | ckusdc-pay, multi-currency, 6-decimal, byte-exact |
| 36 | bad-qr | Scanning/pasting garbage (non-base64 + wrong-length) surfaces a friendly 'This isn't't a dpay payment code' error; review never mounts; scan surface re-arms. | bad-qr, malformed, error-handling, input-validation |
| 43 | decimal-edges | 8-dec (ckBTC) + 6-dec (ckUSDC) + 18-dec (ckDAI) amounts render with exact decimals on review (no rounding, no sci-notation, no trailing-zero drift). | decimal, format, ckbtc, ckerc20, 18-decimal |
| 49 | deeplink-request | dpay:req deeplink opens the pay review screen pre-filled with the merchant request (no auto-approve). | deeplink, request-link, prefill, pay-review |
| 50 | deeplink-receipt | merchant treats dpay:pay as a trigger; a forged proof before settlement never flips Received — only the exact nonce-bound ledger row does; never routes to Pay. | deeplink, receipt-link, rail-proof, receive, handback, forgery |
| 59 | share-receipt | After an online settle, btn-share-receipt hands an openable /wallet?pay= receipt URL to Share and flips to "Link copied ✓". | share-receipt, receipt-link, handback, online-settle, deeplink |
| 61 | merchant-received-name | IC-rail counterparty rendering: history shows the short PRINCIPAL TEXT (not full principal, not hex pubkey) and the memo (reconciliation key) is visible; friendly names died with the facade settlement. | receive, settle, confirmation, counterparty-rendering, memo-reconciliation |

### Offline hand-off (the signature feature)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 20 | offline-handoff | offline payer signs an icrc1_transfer envelope QR (base64url, memo = request nonce); counterparty submits it to the IC gateway; payer reconnects and reconciles to Paid by request_id (read_state); payee balance grows | offline-pay, hand-off, reconcile |
| 21 | receive-scan | merchant scans a base64url icrc1_transfer envelope (memo = request nonce) via the camera seam → app submits it to the IC gateway → read_state poll flips "Received"; balance + history follow from the ledger | receive-scan, offline-settle |
| 46 | sol-offline-handoff | SOL v2 scan solreq:v2 → review shows the short destination (U-F5) → offline sign (no setup, no nonce) → solpay:v2 QR → honest pending. | sol-offline-sign, qr-handoff, honest-pending, review-short-payee |
| 51 | sol-merchant-broadcast | SOL v2 merchant: createSolPaymentRequest (ONLINE) → scan real signed solpay → broadcast → Received. | sol-merchant, sol-broadcast, sol-v2-strict-verify, qr-scan |
| 53 | sol-merchant-error | SOL v2 merchant broadcast error surfaces a friendly message (not raw RPC, not false Received). | sol-merchant, sol-error, sol-v2-rejected, friendly-error |
| 67 | sol-setup-error | SOL v2: SolPayMode mounts in scan with no setup; valid req signs offline; expired req is rejected with a friendly error. | sol-no-setup, sol-expired-request, sol-v2-freshness |
| 74 | sol-usdc-payment | USDC@Sol v2 full cycle: createSolPaymentRequest (USDC) → signSplPayment (TransferChecked) → broadcast → Received. | sol-usdc-payment, sol-spl-sign, sol-merchant, sol-broadcast, sol-v2-strict-verify |
| 92 | offline-peak | first OFFLINE confirmed payment plays the one-shot campaign peak (offline-peak + campaign line → settles to first-offline-stamp remnant); second offline payment and online paid show NO peak; pending hand-off never shows peak or stamp | offline-pay, hand-off, reconcile, delight-peak, journey-stamps |

### Deposits & onramp (ckBTC + ckUSDC + ckERC20)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 03 | deposit-address | ckBTC deposit sheet: address + QR + instructions + fee/min; deep-link ?screen=deposit works. | deposit-address, qr, instructions, fee-min, deep-link |
| 04 | deposit-copy | 'Copy address' writes the REAL address to the clipboard (not the Share noop). | deposit-address, clipboard |
| 05 | deposit-credited | ckBTC deposit lands via faucet-at-principal → balance-recheck delta "Deposited ✓", relay balance grows, asset row appears. | deposit-credit, mint-delta, asset-card, balance-update |
| 16 | ckusdc-onramp | ckUSDC onramp: connect wallet → enter USDC → approve+deposit (EIP-1193 seam, byte-exact calldata, ETH gas note). | ckusdc, onramp, eip-1193, calldata, eth-gas |
| 22 | deposit-error | IC gateway unreachable when opening the deposit sheet → honest error ('Check connection'), no spinner-forever. | deposit-error, offline, graceful |
| 33 | ckerc20-persist | ckERC20 deposit watching PERSISTS across restart: reload rehydrates watching (no reconnect), resumed notice shown. | ckerc20, persist, restart, watching-resume |
| 34 | onramp-provider-resolution | Onramp resolver: window.ethereum wins when present; WC branch unreachable on web even when 'configured' → honest null. | onramp-resolver, eip-1193, walletconnect-gate |
| 45 | sol-receive | Native SOL rail: device-derived SOL card in Balances + receive address QR via the Receive tab "My address" sub-mode (offline, no devnet). | sol-card, sol-derive, sol-receive, qr, address, sol-tab-ia, sol-clipboard |

### Withdrawal (ckBTC cash-out)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 15 | withdraw | Withdraw ckBTC: faucet-fund at the principal → enter addr + amount → sign approve + retrieve on-device → gateway burns → "Withdrawn ✓" + Copy destination; balance debits at both the gateway AND the UI (row drops to 0.00050000 BTC). | withdraw, icrc2-approve, retrieve_btc_with_approval, sign, settle, clipboard, balance-delta, destination-copy, ui-balance-delta |
| 18 | withdraw-errors | Withdraw error paths: below-min / over-balance / bad-addr warnings disable the confirm button; a minter-refused full-balance withdraw surfaces the "insufficient funds" reject in withdraw-err with a fee-only debit. | withdraw-errors, below-min, over-balance, bad-addr, rail-rejection, money-safe |
| 44 | cketh-withdraw | Withdraw native ckETH: faucet-fund at the principal → enter 0x addr + ETH amount → query the minter gas price + sign approve + withdraw_eth on-device → gateway burns → "Withdrawn ✓"; balance debits fee+amount at both the gateway AND the UI (row drops to 3.990000 ETH). | native-eth-withdraw, cketh, family-dispatch, withdraw, icrc2-approve, withdraw_eth, gas-quote, sign, settle, balance-delta, ui-balance-delta |
| 48 | ckusdc-withdraw | ckUSDC Send-to-address: gas-dependency note renders (no-swap honesty) → enter 0x addr + USDC amount → query gas + sign gas-approve + amount-approve + withdraw_erc20 on-device → gateway burns BOTH ledgers → "Withdrawn ✓"; ckUSDC debits fee+amount, ckETH debits gas-fee + gas at the gateway AND the UI row drops to 998.990000 USDC. | ckerc20-offramp, ckusdc, withdraw, icrc2-approve, withdraw_erc20, dual-ledger-gas, gas-note, sign, settle, balance-delta, ui-balance-delta |
| 52 | sol-withdraw | SOL withdraw: select SOL → Pay tab "Send to address" → enter addr+amount → sign+broadcast (stub) → Sent ✓. | sol-withdraw, sol-send, sol-tab-ia, sign |
| 56 | withdraw-saved-addr | A successful rail withdraw (approve + retrieve settled on /api/v2) persists the destination (AsyncStorage); reopening the sheet shows a "Use last" chip that pre-fills the address input. | saved-address, btn-withdraw-saved, withdraw-persist |
| 77 | sol-usdc-withdraw | USDC send to address: happy path (USDC units + rent disclosure note → Sent ✓) and the below-rent pre-check failure (friendly error, no Sent). | sol-usdc-withdraw, spl-transfer, ata-note, rent-precheck, sol-send |

### NFC (tap-to-pay)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 11 | nfc | NFC transport phases (Idle→Linking→Exchanging→Settling) render via the RNW event bus. | nfc-phases, event-bus |
| 32 | nfc-disclosure | NFC asset disclosure: mid-tap the status shows honest asset name + network + '0.00050000 BTC' BEFORE success. | nfc-disclosure, consent, asset-name, network |
| 47 | sol-nfc | SOL v2 NFC tap: arm card → auto-sign → receipt (rid+sig match) → Paid ✓ | sol-nfc, sol-v2-receipt, event-bus |
| 60 | nfc-error | NFC tap failure modes: a mid-tap transport error surfaces honest "Tap failed" (not Paid ✓); a decline surfaces "Declined"; a late error after settling is ignored (no false failure over a decided outcome). | nfc-error, nfc-declined, nfc-phases, error-handling, no-fake-paid, terminal-escape |
| 66 | sol-nfc-error | SOL v2 NFC tap failure modes: expired solreq → Declined + expired; transport error → Tap failed; late error after settling ignored; merchant reader sees the decline. | sol-nfc-decline, sol-nfc-error, sol-nfc-receipt-unreachable, sol-nfc-phases, sol-nfc-reader-decline, no-fake-paid, terminal-escape |
| 86 | nfc-unknown-reconcile | Offline payer supplies update + signed read_state; receiver alone settles, exact-history binds success, and queues the returned result. | nfc, settle, history, reconcile |
| 87 | nfc-payer-settle | Offline card prepares update+read_state, never submits, and only a nonce/rid-bound merchant result resolves Paid. | nfc, payer, offline, returned-result, exact-once |
| 93 | tap-motion | every NFC phase renders its pinned textContent + its own motion beat (breath/segments/key/stamp/ellipsis/shake); pending carries no stamp mark and no campaign line (honesty) | nfc-phases, event-bus, delight-motion, honesty-guard |

### Settings & system

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 12 | settings | Settings: privacy policy is reachable, the non-custodial statement is present, relay URL persists, and reset wallet wipes identity. | settings, relay-config, privacy-policy, non-custodial, reset, persist |
| 13 | offline | Relay down → faucet top-up surfaces honest 'Offline' (ECONNREFUSED, not unsafe-port), no crash; retry path. | offline, econnrefused, graceful, retry, right-reason |
| 14 | keyboard | Single-key shortcuts (P/R/T/A/L/Esc) switch tabs / top-up / add-money / ledger / close sheet; input + sheet guards work; keyboard focus paints the brand :focus-visible ring (U-F4). | keyboard-shortcuts, tabs, sheet-guard, input-guard, focus-visible |
| 17 | scan-cleanup | Switch Pay→Receive→Pay: QrScanner listeners tear down cleanly (no leak across unmount/remount). | qr-scanner, teardown, unmount, listener-leak |
| 24 | wallet-cleanup | Funded non-dollar balances/history (rail faucet + icrc1_transfer on currency 1) render as asset cards/rows with known symbols and short principal-text counterparties. | asset-cards, labels, symbols |
| 38 | relay-retarget | Settings relay-switch retargets the LIVE balance poll: header changes from A's ∂100.00 to B's faucet-funded ∂500.00 (B's fresh per-process gateway). | relay-retarget, settings-relay-switch, live-poll |
| 41 | a11y-census | Every interactive element (btn-*/tab-*/inputs/picker rows) carries a non-empty aria-label + role on every primary surface. | a11y, accessibility, aria |
| 55 | balances-select-asset | Selecting an asset in Balances binds the header: label DEMO→ckBTC→SOL and the balance text follows the active-rail branch. | asset-select, header-balance-binding, active-asset-label |
| 57 | settings-seed-backup | Seed stays hidden behind a confirm gate; once revealed the 24 mnemonic words show by default, hex view toggles in and matches identity.secretHex; copy writes the seed to the real clipboard. | seed-backup, confirm-gate, secret-reveal, clipboard-copy, mnemonic-backup, mnemonic-word-{0..23}, btn-backup-show-hex, btn-copy-mnemonic, btn-copy-seed |
| 63 | picker-sol-rail | SOL is selectable in the Receive currency picker → switches the active rail to SolReceiveMode. | receive-picker, sol-rail, currency-switch |
| 64 | settings-restore | Settings → Restore replaces wallet identity from 24 words OR 64-hex seed (no wipe); username preserved. | restore-seed, restore-mnemonic-words, settings-restore, identity-replace, keypair-from-secret |
| 69 | sol-usdc-selection | IC USDC ↔ Solana USDC: unified picker switches rail + clears amount (symmetric in both directions). | asset-picker, ic-usdc, sol-usdc, rail-switch, amount-clear |
| 70 | deeplink-ic-routing | A dpay:req deeplink arriving while SOL is idle-selected routes to the IC Pay engine (PayMode review), not SolPayMode — the blob is never silently lost. | deeplink-routing, ic-engine-routing, solana-to-ic-handoff, prefill-preserve |
| 71 | selection-lock | An in-flight pay review locks the idle asset selection: the Balances button is disabled + a no-op, and canceling the review re-enables it. | selection-lock, in-flight-preserve, balances-disable, nfc-arming-invariant |
| 72 | sol-usdc-send | Solana USDC "Send to address": fail-closed device-ATA gate → one-tap create (busy → form appears) and the create-failure leg (err shown, sheet stays usable). | sol-usdc-send, spl-transfer, fail-closed-ata, asset-aware-send, ata-create-one-tap |
| 75 | seam-fail-loud | Every injection seam (scan/NFC/SOL-NFC) throws when no listener is mounted — regression guard against silent-drop bugs. | seam-integrity, fail-loud, regression-guard |
| 76 | sol-usdc-ata-gate | USDC receive gate: absent→setup card + Request blocked; insufficient→disabled; funded→one-tap create flips to the address QR; balance→direct address. | sol-usdc, ata-gate, tri-state, ata-setup-card, request-block, ata-create |
| 79 | sol-fund-first-pay | SOL Pay tab: known-zero → fund panel replaces scanner+NFC, 1-tap to deposit QR, auto-release on funding, fail-open on unknown. | sol-fund-first, pay-gate, nfc-disarm, fail-open, zero-funds |
| 80 | sol-fund-funnel | SOL zero→pay journey: absent-ATA setup card with fund hatch (no dead-end copy), 1-tap to SOL address, funded unlock, one-tap create, badge truth. | sol-fund-funnel, ata-setup, needs-setup-badge, escape-hatch, zero-funds |
| 81 | ic-fund-first-pay | the IC Pay tab shows the fund-first panel on a KNOWN-zero non-DEMO asset (online), routes to the deposit address in one tap, fails open offline, and gates the send sub-mode identically | ic-fund-first, pay-gate, fail-open, zero-funds, send-gate |
| 83 | mobile-viewport | On a 390px mobile-web viewport the tab row fits: no horizontal document overflow and the Transactions tab renders fully inside the viewport. | layout, viewport |

### Visual capture (UX tour)

| # | Flow | Verifies | Covers |
|---|------|----------|--------|
| 35 | ux-tour | Visual capture: screenshots of every major screen (Pay, Receive+QR, Balances, Settings, Ledger) for review. | visual-capture, screen-census, screenshots |
| 39 | store-screens — optional (`just e2e-store`) | Visual capture: 5 hero screenshots for Play Store compositing (wallet, request, balances, ledger, deposit), rail-funded. | visual-capture, store-screenshots |
| 40 | visual-regression | Pixel-diff the 5 primary surfaces (Pay, Receive+QR, Balances, Settings, Ledger) vs committed baselines; fails on drift >0.5%. | visual-regression, pixel-diff |
| 78 | qr-scannable | every rendered <QrCode> stays machine-decodable: request-qr (244/M + brand mark) decodes to the exact encoded value (__DPAY_QR_LAST byte-for-byte) and sol-receive-qr (200/L, base58 address) decodes to the on-screen address — rasterized pixels through the same vendored jsQR the prod web wallet ships | qr-scannable, qr-brand-mark, quiet-zone |
| 84 | visual-dark | Pixel-diff the 5 primary surfaces under an emulated OS dark scheme (prefers-color-scheme: dark) vs the dark-theme baselines in shots/baselines-dark/; the gate that the DARK palette renders on every surface the light flow walks. | visual-regression, pixel-diff, dark-theme |
| 85 | theme-toggle | Two-tier theme: header flip toggles Light↔Dark on a single click (target-state label), root bg flips, choice survives reload; Settings 3-way control (Light/Dark/Auto) drives the same state and Auto returns to the OS scheme. | theme-toggle, dark-theme, persistence, settings, auto-theme |

---

## Coverage gaps (honestly documented)

These flows are **not** covered and why:

- **Exact 2/6/8/18-decimal amount transport at the JS/Kotlin boundary** — `29-exact-amount` proves the >2^53 raw amount round-trips byte-exact through the TS↔relay stack, but values around `2^53` and excess fractional input at the Kotlin/UniFFI boundary are not exercised.
- **Non-dollar NFC consent over the radio** — `11-nfc` + `32-nfc-disclosure` inject JS phase/request events; they do not carry a real nonzero-currency request over the actual ISO-DEP radio (physical-device gate).
- **Android React Native bridge parity** — instrumented tests mostly exercise UniFFI directly, not the full `NativeModules` argument/return surface.
- **External-credit balance freshness** — deposit tests assert direct ledger/FakeLedger credit while missing stale facade `BAL_CACHE` behavior.
- **NFC radio round trip** (two phones, HCE↔reader, full DPN2 + signed-result transit over ISO-DEP) — physical-device gate. Flows 86/87 prove the merchant and offline-payer ownership halves; `just ondevice` proves request→fragmented bundle→authenticated C6 result through the real core/UniFFI state machines. Only antenna coupling and Android AID routing between two physical phones remain.
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
