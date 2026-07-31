# UX Audit Findings — 2026-07-31

> **No-mock UX + functional audit** of the REAL `dpay` web app (`app/App.tsx`, react-native-web) via three prongs:
> (1) zai-vision analysis of all 37 e2e screenshots in `e2e/shots/`; (2) interactive chrome-cli exploration of the live
> app served from `e2e/dist` against the real test relay (FakeLedger, offline); (3) DOM/accessibility inspection.
> **Method note:** screenshots are from the e2e harness (FakeLedger), so some values (deposit fee/min = 0) reflect
> the test ledger, not production. Where relevant this is noted. Brand name is confirmed **"dpay"** via DOM
> (`document.title = "dpay"`); zai-vision's inconsistent readings ("xpay"/"zpay"/"pay") were font-rendering misreads.

> **STATUS (2026-07-31): ALL 23 ISSUES RESOLVED OR MITIGATED.** 21 fully resolved, 2 mitigated (H3 short-hex
> until N6 wire change; M1 a11y fully closed in follow-up). Independent verifier confirmed. See `OPEN_ISSUES.md`
> "UX audit (2026-07-31)" section for per-issue resolution detail. Suite 26/26 GREEN.

## Critical (breaks flow / shows wrong info)

- **[C1] Approve button stays ACTIVE/ENABLED on an expired payment request.** The review-payment screen shows
  "The request expired" in red text BELOW a large, green, fully-enabled "Approve" button. Tapping it re-submits
  and fails again (422). The button is gated only by `disabled={busy}` (signing in-progress) — it is NOT disabled
  when an error is shown or the request is expired. A user seeing a green button will tap it, expecting it to work.
  | evidence: `e2e/shots/10-expired.png` | location: `app/App.tsx:1441` |
  *Fix:* disable `btn-approve` when `err` is non-null (or specifically when the error indicates expiry/rejection);
  visually grey it out and move the error text ABOVE the button.

- **[C2] Approve button stays ACTIVE/ENABLED when balance is insufficient.** Identical pattern: "Not enough balance"
  appears in red below a green enabled Approve button. The user can tap Approve, which submits a payment that will
  be rejected by the ledger. The warning is also placed BELOW the button, not above it, so it's easy to miss.
  | evidence: `e2e/shots/19-low-balance.png` | location: `app/App.tsx:1438-1442` |
  *Fix:* when online and `shownBalance != null && req.amount > shownBalance`, disable the Approve button and show
  the warning above it (not below). Move the error/warning text above the button in all cases.

- **[C3] Deposit fee/min shows "0.00000000 BTC" — reads as broken placeholder/stub data.** The deposit instructions
  line renders `Network fee 0.00000000 BTC · Min deposit 0.00000000 BTC`. Against FakeLedger (and the mock minter,
  which returns `kyt_fee:0, deposit_btc_min_amount:Some(0)`) these are genuinely zero. The real ckBTC minter returns
  `kyt_fee=100, deposit_btc_min_amount=300` (non-zero), so production would show real values — but the formatting
  (`0.00000000` with 8 trailing zeros) is ugly and when values ARE zero it looks like a stub. A premium app should
  never display "0.00000000 BTC" to a user.
  | evidence: `e2e/shots/03-deposit-address.png`, `ckbtc-deposit.png`; DOM-confirmed live |
  location: `app/App.tsx:1699-1700,1744` |
  *Fix:* hide the fee/min line entirely when the value is 0, or display "—" / "nominal" instead of formatting zero
  to 8 decimals.

## High (confusing / bad UX / wrong label)

- **[H1] ckUSDC asset card and picker row labeled "Ethereum" instead of "USDC".** The `FAMILY_DISPLAY` config for
  `CkEthErc20` sets `networkLabel: 'Ethereum'` (line 260), and every display label uses `networkLabel` as the asset
  name. So the asset picker shows row "Ethereum / Send USDC on Ethereum", the asset card shows label "Ethereum" with
  a USDC balance, and the deposit sheet title reads "Add Ethereum". The user wants to add **USDC**, not Ethereum.
  This inverts asset and network — a user scanning for "USDC" won't find it; a user seeing "Ethereum" may think they
  are adding ETH.
  | evidence: `e2e/shots/ckusdc-connect.png`, `ckusdc-enter.png`; DOM `asset-picker-row-ckusdc:"EthereumSend USDC on Ethereum"` |
  location: `app/App.tsx:260,883,2053-2054,1707,2186` |
  *Fix:* use `nativeAsset` ('USDC') or the catalog `symbol` ('ckUSDC') as the primary display label; keep
  `networkLabel` only in the "Send X on NETWORK" instruction line. Add a dedicated display name field if needed.

- **[H2] Transaction history only fetches currency=0 (DEMO_USD) — ckBTC/ckUSDC transactions never appear.** The
  history poll is hardcoded: `GET /api/v1/transactions/{hex}?currency=0&limit=20` (line 740). The app fetches
  balances for all currencies (0, 1, 2 — confirmed via network trace), but the "RECENT" list only ever shows
  currency-0 transactions. If a user deposits ckBTC and pays with it, those transactions are invisible in the
  wallet's history. This undermines the multi-currency story.
  | evidence: network trace (balance currency=1,2 fetched; transactions currency=0 only) |
  location: `app/App.tsx:740` |
  *Fix:* fetch history per currency (or union the results), grouping by asset in the RECENT list.

- **[H3] Counterparties shown as raw truncated hex pubkeys everywhere** (N6, re-confirmed). Transaction history rows
  show "to d322c169…" / "from 9496dde3…"; payment confirmations show "from da8281d6…". The username is NOT carried
  in the receipt, so the merchant/recipient sees a hex blob instead of a human name.
  | evidence: `e2e/shots/07-scan-pay.png`, `08-merchant-settle.png`, `21-receive-scan.png` |
  location: `app/App.tsx:903` (history row) + receipt path |
  *Fix:* carry the payer's username in the signed payload or receipt (core wire change, documented as N6); until
  then, show a friendlier fallback ("Someone" / a generated handle) instead of raw hex.

- **[H4] Hex pubkey ID appended to username in the header** — "Alice · 1b8a5ee7…". Every screen shows the user's
  truncated 32-byte public key next to their name. This is developer-facing protocol data that adds no value for an
  end user and makes the header look like a debug panel.
  | evidence: DOM `document.body.innerText` = "Alice · 1b8a5ee7…"; all wallet screenshots |
  location: `app/App.tsx` header rendering |
  *Fix:* show only the username; move the hex to a long-press/copy detail or hide it entirely from the main UI.

- **[H5] Deposit error message uses technical jargon** (N7, re-confirmed). The error reads "Could not reach the
  ledger for a deposit address / Check the relay is reachable, then reopen the sheet." The term "relay" and "reopen
  the sheet" are developer vocabulary. The real cause may be "no minter configured" (a deploy invariant), not relay
  reachability — so the message can be factually wrong.
  | evidence: `e2e/shots/22-deposit-error.png` | location: `app/App.tsx:1720` |
  *Fix:* replace with plain language ("Couldn't load your deposit address. Check your connection and try again.");
  distinguish "no minter configured" (show "This asset isn't available for deposits yet") from transient errors.

## Medium (polish / inconsistency / a11y)

- **[M1] No ARIA roles or labels on ANY interactive element.** All Pressable/TouchableOpacity render as bare `<div>`
  tags without `role="button"`, `aria-label`, or `aria-disabled`. A screen-reader user cannot identify or activate
  any button, tab, or link. Keyboard Tab navigation skips them entirely. The disabled state is not communicated.
  | evidence: DOM audit — all `[data-testid]` elements have `role:null, ariaLabel:null` |
  location: `app/App.tsx` (all `<Pressable>` components lack `accessibilityRole`/`accessibilityLabel`) |
  *Fix:* add `accessibilityRole="button"` + `accessibilityLabel` to every Pressable; add `accessibilityState={{disabled}}`.

- **[M2] Touch targets far below the 44pt minimum.** Measured at 390px viewport (CSS px): `btn-settings` = 17px tall,
  `btn-paste` = 19px, `tab-pay`/`tab-receive` = 32px, `btn-deposit` = 33px. Apple HIG requires ≥44pt; Material
  Design requires ≥48dp. The Settings link at 17px is nearly impossible to tap reliably.
  | evidence: DOM `getBoundingClientRect()` measurements |
  location: `app/App.tsx` style definitions (`S.linkBtn`, `S.tab`, etc.) |
  *Fix:* add `minHeight: 44` (or padding) to all interactive elements, especially text-link buttons.

- **[M3] Keyboard hint badges (P/R/T/A) are nearly invisible.** The single-letter hint badges are 10px font,
  ~6×11px, with no background or border. The "T" badge is muted gray (rgb(105,114,125)); the others are very dark
  on green. They are too small and low-contrast to serve their purpose of teaching shortcuts.
  | evidence: DOM computed-style measurement |
  location: `app/App.tsx` hint-badge rendering (useHotkeys section) |
  *Fix:* increase to 14px font in a visible bordered box (rounded square with subtle background); ensure ≥3:1 contrast.

- **[M4] "Press Esc to close" shown on a mobile app.** The deposit/withdraw/settings/asset-picker sheets show
  "Press Esc to close" at the bottom. On a phone there is no Esc key — this instruction is meaningless to the
  primary audience (Android app). It is a web-only affordance leaking into the mobile UI.
  | evidence: `e2e/shots/ckusdc-connect.png`, `ckusdc-enter.png`, settings sheet |
  location: `app/App.tsx` sheet footer text |
  *Fix:* gate the "Press Esc to close" text behind `Platform.OS === 'web'` (it may already be, but the web build
  shows it; on the actual Android app it should be hidden — verify the Platform guard is correct).

- **[M5] App is not responsive at desktop/tablet width.** At 1280px the content is a narrow centered column with
  massive empty black margins on both sides. While this is a mobile-first RN app, the web demo (used for investor
  presentations) looks unpolished on a laptop screen.
  | evidence: desktop screenshot at 1280×800 |
  location: `app/App.tsx` root layout |
  *Fix:* cap the content width (e.g., `maxWidth: 480`) and center it, or add a subtle frame/phone-mockup for desktop.

- **[M6] Empty-username defaults to "Name"** (N8, re-confirmed). When the username field is left blank, the wallet
  onboards with the generic default "Name". The result is a header showing "Name · 0465bff3…" — an unpersonalized,
  placeholder identity. The `username-input` also lacks a `testID` (only has placeholder).
  | evidence: `e2e/shots/23-username-default.png` | location: `app/App.tsx` onboarding |
  *Fix:* require a non-empty username, or use a less generic default; add `testID="username-input"`.

- **[M7] Onboarding button subtext is dev-facing.** "Generates a key on this device and adds demo $100 to start"
  exposes implementation details ("generates a key", "demo $100") that are meaningful to a developer, not a user.
  | evidence: `e2e/shots/12-settings.png` (onboarding screen) | location: `app/App.tsx` onboarding |
  *Fix:* rephrase to user-benefit language: "Creates your wallet and adds $100 in demo funds to get started."

- **[M8] ckUSDC deposit sheet has no gas-fee warning.** The ckUSDC onramp requires two Ethereum transactions
  (approve + deposit) that cost gas (ETH). The sheet warns about wrong-chain risk but never mentions that the user
  must have ETH for gas. A user with only USDC and no ETH will have their transactions fail.
  | evidence: `e2e/shots/ckusdc-enter.png` | location: `app/App.tsx` CkErc20DepositSheet |
  *Fix:* add a note: "You'll need a small amount of ETH for Ethereum network gas fees."

- **[M9] ckUSDC deposit processing state is ambiguous.** "Transactions submitted" (plural — the two ETH txs) with a
  spinner, then "Watching for your mint — the ckETH minter scrapes Ethereum every few minutes; credit typically
  lands within ~20 min." The word "scrapes" is jargon; the ~20min appears twice (confirmation + credit), which
  could confuse the user about which wait applies.
  | evidence: `e2e/shots/ckusdc-submitted.png` | location: `app/App.tsx` CkErc20DepositSheet |
  *Fix:* simplify to "Waiting for confirmation — your ckUSDC will appear in ~20 minutes." Remove "scrapes" jargon.

## Low (nitpick)

- **[L1] "Add money" button shadow/glow clipped at viewport edge** (N9, re-confirmed). The button's `shadowRadius: 12`
  overflows past the right viewport edge at 390px width. The text itself is NOT truncated (DOM confirms
  `scrollWidth == clientWidth`), but the shadow reads as cramped.
  | evidence: `e2e/shots/21-receive-scan.png` (vision read "Add mone" due to shadow clipping) |
  location: `app/App.tsx` header layout |
  *Fix:* add right padding to the header row or reduce the shadow radius.

- **[L2] "Paste request" is a bare text link.** It's the ONLY way to pay without a camera on web/desktop, but it's
  styled as small green text with no button affordance and a 19px touch target.
  | evidence: all wallet screenshots, DOM | location: `app/App.tsx` Pay screen |
  *Fix:* style as a secondary button or increase touch area + add an icon.

- **[L3] Withdraw success shows raw address without copy option.** "sent to bc1qtestwithdrawaldestination" is an
  unformatted long string with no copy button. Users can't easily verify or share the destination.
  | evidence: `e2e/shots/15-withdraw.png` | location: `app/App.tsx` WithdrawSheet success state |
  *Fix:* add a "Copy" button next to the address, or make it `selectable`.

- **[L4] "Payer offline? Scan their QR" instruction is ambiguous.** On the Receive screen, this text could mean
  "scan the payer's QR to pay them" or "the payer should scan your QR". The intended meaning (merchant scans the
  payer's signed QR) isn't clear from the wording alone.
  | evidence: `e2e/shots/06-request-qr.png` | location: `app/App.tsx` ReceiveMode |
  *Fix:* rephrase: "Payer paid offline? Scan their signed code to settle."

- **[L5] "request 9612e903fe03…" raw hex leaks in the review-payment screen.** The truncated request nonce is shown
  to the user below the amount. This is internal protocol data with no user value.
  | evidence: `e2e/shots/10-expired.png`, `19-low-balance.png` | location: `app/App.tsx:1437` |
  *Fix:* hide the request nonce from the user-facing review screen (move to a debug/long-press detail).

- **[L6] "to merchant" / "from merchant" is a generic label.** Payment confirmations show "Paid ✓ $25.00 / to
  merchant" rather than the actual recipient name. Since the request carries the merchant's username, this could
  show the real name.
  | evidence: `e2e/shots/07-scan-pay.png`, `08-merchant-settle.png` | location: `app/App.tsx` PayMode/ReceiveMode |
  *Fix:* use `req.name` (already available) instead of the generic "merchant".

## Confirmed working well (for confidence)

- **NFC success screen** — clear "Paid ✓" with checkmark, amount, and "Done" action; well-designed (shot 11-nfc).
- **Offline balance indicator** — the "~" prefix on "~$100.00" honestly signals a stale/approximate balance when
  offline (shot 13-offline).
- **Reset confirmation** (N3 fixed) — "Reset wallet" now shows a warning box ("This erases your wallet identity…
  Funds at this address become irrecoverable. This cannot be undone.") + "Yes, reset everything" / "Cancel" buttons.
- **Receipt verification** (R2) — the app verifies the canister-signed receipt before showing "Paid ✓"; a lying
  relay cannot forge the outcome.
- **Onboarding flow** — clean, single-screen, username + create; functional and fast.
- **Dark theme consistency** — high-contrast black/white/green palette is consistent across all screens.
- **Keyboard shortcuts** (P/R/T/A + Esc) work correctly on web; the hook is properly guarded (no-op when input
  focused or sheet open).
- **Paste-request affordance** exists (N10 fixed) — Pay is reachable without a camera via the "Paste request" link.
- **Faucet moved off header** into Settings with correct label "Add demo money" + cooldown note (N2 fixed).

## Flows that could NOT be fully tested (gaps)

- **ckUSDC onramp with a REAL wallet** — the e2e harness injects a mock `window.ethereum` recorder; the live ETH
  transactions (approve + deposit) require a real browser wallet extension (MetaMask/Rabby) which is not available
  in headless chrome. The byte-exact calldata is proven by the goldens, but the wallet-connect UX (extension popup,
  user signing) could not be interacted with.
- **ckBTC live deposit** — requires real BTC + 4 confirmations on mainnet; offline-only (FakeLedger/mock-minter).
  The fee/min display issue (C3) is only visible because the test ledger returns zeros; production values would
  differ.
- **NFC radio hop** — the physical tap between two phones is a device-only gate; the e2e seam drives the JS event
  plumbing but not the antenna coupling.
- **Real camera scan** — the camera is shimmed in the e2e harness; the live camera permission flow + scan accuracy
  could not be tested in headless chrome (shows "camera permission needed").
