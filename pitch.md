# [Working name] — a digital-dollar payment app you can use offline

**As simple to use as Venmo or Alipay, but it moves digital dollars instead of bank balances — and the payer can pay even with no phone signal, as long as the merchant is online.**

## The problem

Digital dollars have become a trusted way to hold and move money, but *paying* with them still feels like using a blockchain: both ends effectively need to be online, confirmation is slow or uncertain, and there's no consumer-grade tap-and-go experience. Apps like Alipay, WeChat Pay, and Switzerland's Twint proved that a clean QR wallet can win everyday payments — but they're locked to domestic bank rails and fiat, so they don't cross borders and don't reach the unbanked.

## The solution

A consumer wallet with the look and feel of Venmo that settles in digital dollars. Users pay merchants and each other by scanning a QR code. The key move: the payer's phone can authorize a payment **fully offline**; the merchant — who is online — submits it and gets a real, final confirmation on their own device within seconds. Same familiar gesture, no bank account required, borderless by default.

## How it works

- **Settlement:** built on a fast, decentralized ledger (the Internet Computer). Payments are denominated in digital dollars, finalize in seconds with negligible fees, and run on decentralized infrastructure rather than a company-owned server.
- **Offline payer:** the app holds an on-device key scoped to a user-set spending cap — like cash in a pocket. It signs a payment authorization with no connectivity needed.
- **Online merchant:** scans the signed authorization by QR and submits it to the ledger, which is the single source of truth. Validation is instant and double-spending is impossible, so the merchant sees a definitive "paid" on a trusted device.
- **Custody by code, not by us:** funds are controlled by on-chain logic, and non-sensitive systems (analytics, telemetry) are kept fully separate from the money ledger.

## Why it's different

- **The offline wedge:** nearly all crypto payments assume both parties are connected. Ours needs only the merchant online — unlocking transit, poor-signal venues, and the emerging markets where mobile money like M-Pesa already proved the demand, anywhere the customer's connectivity is the weak link.
- **Venmo-familiar UX on digital-dollar rails:** consumer-simple, but borderless and bank-optional.
- **Stronger trust story:** decentralized custody instead of a private key sitting on a company server.

## Why now

Digital dollars have crossed into mainstream settlement volumes, sub-second-finality infrastructure makes instant confirmation real, and QR/NFC wallet behavior is now second nature to consumers after Alipay, UPI, and Venmo.

## Status & ask

Concept validated. Next step is a working proof-of-concept of the offline-pay / online-confirm flow over QR, settled in digital dollars on the Internet Computer. Fiat on/off-ramps, licensing, and a possible local-currency version are deliberately deferred until the core payment experience is proven. **[Ask — e.g., pre-seed to build the PoC and run a first pilot.]**
