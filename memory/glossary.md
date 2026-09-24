# Glossary — dpay decoder ring

## Product terms

| Term | Meaning |
|------|---------|
| dpay | Working name for the offline-capable digital-dollar wallet. |
| offline payer | The customer's phone signs a payment while fully offline (airplane mode). |
| online merchant | The merchant's phone is online; it submits the payment and gets final confirmation. |
| authorization | The signed payment payload: `{from, to, amount, nonce, expiry}`. |
| spending cap | ~~User-set on-device limit — "like cash in a pocket." Enforced by the canister.~~ **Never built** (checked 2026-09-04: nothing in `app/` sets or enforces one; the canister's `per_tx_cap` init arg belongs to the dormant facade). Do not quote it as a feature. |
| the offline wedge | The strategic differentiator: crypto payments normally need both parties online; dpay needs only the merchant online. |

## Tech / infra

| Term | Meaning |
|------|---------|
| ICP | Internet Computer — decentralized ledger with fast finality; dpay's settlement layer. |
| canister | ICP smart contract. The facade described here — verify sig/nonce/expiry/cap/balance, move funds, return a receipt — is the DORMANT settlement kernel; since the 2026-08-19/20 cutover no dpay canister is on the value path. Authority: `docs/CANISTERS.md`. |
| relay | Rust + axum service (`crates/dpay-relay`). It does NOT settle payments — settlement left it in the 2026-08-19 cutover; the app signs and submits its own IC envelopes. It serves the compiled currency catalog, read-only balances/history, the web wallet, the faucet, and — by default since 2026-09-10, opt-out `DPAY_ENABLE_CHECKOUT=false` — the OpenCryptoPay checkout. |
| checkout | The merchant-side charge surface (the relay's OpenCryptoPay provider + the app's counter): the merchant opens a signed charge, the payer scans or taps it. **Renamed from "till" 2026-09-16 (founder decision; breaking, no external users):** the old word was British-retail English the sector does not use; "ring up" became "open a charge"; signed domains became `dpay-checkout-open-v1/v2`. Old copy quoted anywhere predates the rename. |
| dfx | ICP SDK / CLI used to build and deploy the canister. |
| ckUSDC | Chain-key USDC on ICP. It settles today, and so do ckBTC, ckETH, VCHF, native ICP, and SOL/USDC on Solana — the "would, one day" framing this row used to carry is years stale. Shipped set: `positioning.md`. |
| nonce | Unique per-payment value the merchant mints once. On the shipped rail it is the payee's reconciliation handle (it rides as the ICRC memo), NOT the thing that stops a replay; on the facade/DEMO rail it is the ledger nonce. Per-rail truth: `dpay_core::PaymentRequest`. |
| Ed25519 | Signature scheme used to sign/verify authorizations. One implementation, `ed25519-dalek` in `dpay-core`, reached from the app through UniFFI and from the browser through the wasm build — there is no JS signing library on the money path. |
| idempotency | Submitting the same signed ENVELOPE twice settles once — the IC admits a request id once. Re-SIGNING the same authorization is a second payment, not a replay. |
| safe-mode | A demo fallback that would run the full visual flow locally if venue wifi died. **Never built** (checked 2026-09-04: no such thing in `app/`, `crates/` or the justfile). It is a wish in the reliability plan, not a feature. |

## UI conventions

| Term | Meaning |
|------|---------|
| `$` | The BACKING currency symbol, shown when known (`$`, `€`, `CHF`, BTC, ETH, SOL); the wrapper symbol (`ck*`) only when the backing is unknown. Raw ledger/token identifiers are never shown — which is the rule this row used to overstate as "the ledger is never shown". |
| Pay mode | App mode where the payer scans a request and approves a payment. It also handles a scanned OpenCryptoPay checkout code and a dpay payment link — both land on an explicit review that never auto-signs. |
| Receive mode | App mode where the merchant shows a code. Two code forms: a dpay request QR, and — since 2026-09-04 — a checkout charge that any dpay wallet can pay (`app/components/CheckoutCharge.tsx`). |

## Comparisons often referenced

Venmo / Alipay / WeChat Pay / Twint (clean QR wallet UX), UPI (QR ubiquity), M-Pesa (proved mobile-money demand in emerging markets).
