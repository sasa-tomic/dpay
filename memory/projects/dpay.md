# Project — dpay

## One-liner

A consumer wallet with Venmo-like UX that settles in digital dollars on the Internet Computer, where the **payer can pay fully offline** as long as the merchant is online.

## Problem

Paying with digital dollars still feels like using a blockchain: both ends effectively need to be online, confirmation is slow/uncertain, and there's no tap-and-go consumer experience. QR wallets (Alipay, WeChat Pay, Twint) proved everyday demand but are locked to domestic bank rails and fiat — no cross-border, no unbanked reach.

## Solution

Scan-to-pay wallet settling in digital dollars. The payer's phone authorizes a payment fully offline; the online merchant submits it and gets real, final confirmation in seconds. Familiar gesture, no bank account, borderless by default.

## How it works

- **Settlement:** fast decentralized ledger (ICP). Payments denominated in digital dollars, finalize in seconds, negligible fees.
- **Offline payer:** on-device key scoped to a user-set spending cap signs an authorization with no connectivity.
- **Online merchant:** scans the signed authorization by QR, submits to the ledger (single source of truth). Instant validation; double-spend impossible.
- **Custody by code:** funds controlled by on-chain logic; analytics/telemetry kept separate from the money ledger.

## Differentiators

- **The offline wedge** — only the merchant needs to be online. Unlocks transit, poor-signal venues, emerging markets.
- **Venmo-familiar UX on digital-dollar rails** — consumer-simple, borderless, bank-optional.
- **Stronger trust story** — decentralized custody vs a private key on a company server.

## PoC (investor demo)

Goal: one unforgettable demo — pay while offline, merchant confirms instantly on a real ledger. Android-only, two phones, ~60 seconds.

Demo flow: payer phone → airplane mode → merchant enters `$5.00`, shows request QR → payer scans, approves, shows signed-authorization QR → merchant scans → ~1s later "Paid ✓ $5.00", both balances update. Optional: a ledger/explorer view ticking up.

Three parts: React Native app (Android) · Node relay · ICP canister ledger. See [[glossary]] and [[company]] for stack details.

## Status & ask

Concept validated. Next: working PoC of the offline-pay / online-confirm flow over QR, settled in digital dollars on ICP. Fiat on/off-ramps, licensing, and a local-currency version deliberately deferred until the core experience is proven. Ask: pre-seed to build the PoC and run a first pilot.

## Honest framing

The PoC proves the **experience**, not hardened security. With software keys, double-spend resistance comes from the canister's cap + nonce checks (included); secure-element key binding is deferred. Worth stating plainly — reads as maturity, not a gap.

## Source docs

- `pitch.md` — product/investor description.
- `minimal-poc-plan.md` — the build plan seeded into `TASKS.md`.
