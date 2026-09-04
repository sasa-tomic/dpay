# Project — dpay

> **This file is a condensed copy of `pitch.md`, which its own "Source docs" section already names
> as the source.** It is the July-2026 pre-build pitch and is superseded by `positioning.md`. Do not quote
> it for anything current, and do not edit it in parallel with `pitch.md` — fix the source. What was
> false about the money has been deleted here too (2026-09-04): no spending cap exists, and no
> ledger on the shipped rail refuses a second payment.

## One-liner

A consumer wallet with Venmo-like UX that settles in digital dollars on the Internet Computer, where the **payer can pay fully offline** as long as the merchant is online.

## Problem

Paying with digital dollars still feels like using a blockchain: both ends effectively need to be online, confirmation is slow/uncertain, and there's no tap-and-go consumer experience. QR wallets (Alipay, WeChat Pay, Twint) proved everyday demand but are locked to domestic bank rails and fiat — no cross-border, no unbanked reach.

## Solution

Scan-to-pay wallet settling in digital dollars. The payer's phone authorizes a payment fully offline; the online merchant submits it and gets real, final confirmation in seconds. Familiar gesture, no bank account, borderless by default.

## How it works

- **Settlement:** fast decentralized ledger (ICP). Payments denominated in digital dollars, finalize in seconds, negligible fees.
- **Offline payer:** on-device key signs an authorization with no connectivity.
- **Online merchant:** scans the signed authorization by QR, submits to the ledger (single source of truth). Instant validation; the same signed bytes handed over twice settle once.
- **Custody by code:** funds sit at the user's own account on a public ledger and move only under the user's own signature; analytics/telemetry kept separate from the money ledger.

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

The PoC proves the **experience**, not hardened security; secure-element key binding is deferred and the seed lives in plain app storage. The sentence that used to sit here — "double-spend resistance comes from the canister's cap + nonce checks" — was deleted 2026-09-04: no cap was ever built, the canister is off the value path, and the nonce is the payee's reconciliation handle rather than a replay guard. What actually makes a replay settle once: `dpay_core::PaymentRequest`.

## Source docs

- `pitch.md` — product/investor description.
- `minimal-poc-plan.md` — the original build plan.
