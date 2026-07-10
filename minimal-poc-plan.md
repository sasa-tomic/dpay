# Minimal PoC — Build Plan (investor demo)

**Goal:** one unforgettable demo that proves the core idea — *pay while offline, merchant confirms instantly on a real ledger.* Android-only, two phones, ~60 seconds. Everything else is deferred.

Money is shown to users as **`$`** (e.g. `$5.00`). The underlying stablecoin ledger is an implementation detail and never appears in the UI.

---

## Background (so this doc stands alone)

[Working name] is a peer-to-peer payment app — think Venmo or Alipay, but it moves a USD-pegged stablecoin instead of bank balances, works across borders, and needs no bank account. Its distinctive feature: the **payer can pay while fully offline** (no signal), as long as the **merchant is online**. The payer's phone signs a spending authorization offline; the merchant relays it to a ledger that settles with instant finality and confirms on the merchant's trusted device.

Settlement runs on the **Internet Computer (ICP)**: a canister smart contract acts as the ledger, so funds are controlled by on-chain code rather than a company server. A single online party (the merchant) is enough to settle — which is what makes the offline-payer experience possible. This document specifies the smallest build that demonstrates that experience for investors; the fuller product/investor description lives in `pitch.md`.

---

## The demo (the whole point)

1. Hold up the **payer** phone and switch on **airplane mode** — visibly offline.
2. **Merchant** phone: type `$5.00`, tap **Request** → a QR appears.
3. **Payer** phone (still offline) scans it: *"Pay $5.00 to Café Demo"* → tap **Approve** → its screen shows a second QR (the signed authorization).
4. **Merchant** scans that QR → ~1 second later: *"Paid ✓ $5.00"* — both balances update.
5. Line to the room: *"That phone never touched the internet, and the payment is already final on a decentralized ledger."*

Optional flourish: a small ledger/explorer view ticking up, for credibility.

---

## Architecture (3 parts)

```
 PAYER app (offline)                 MERCHANT app (online)          RELAY            CANISTER (ICP)
 ────────────────────                ─────────────────────         ───────          ──────────────
 scan request QR                     enter $ amount → request QR
 build + SIGN authorization
   {from,to,amount,nonce,expiry}
 show authorization QR  ───scan──▶   POST authorization    ───────▶ validate ──────▶ verify sig + nonce
                                     show "Paid ✓"          ◀─receipt──  relay   ◀──── + cap + balance,
                                                                                       move funds, return
```

- **Mobile app** — one React Native app (Android only) with a **Pay** mode and a **Receive** mode. Generates an on-device key on first run, shows a `$` balance, does QR generate + scan, and — crucially — builds and **signs the authorization fully offline**. React Native is chosen so the ICP JS agent, QR, and crypto libraries all come for free.
- **Relay server** — a tiny Node service (Express + `@dfinity/agent`) that receives the merchant's submission and calls the canister. It exists so the merchant app only has to do QR + HTTPS, not on-device chain integration. **This is the only online dependency during the demo, so it has to be rock solid** (see below).
- **Canister (ICP)** — a small demo ledger. Verifies the payer's Ed25519 signature over the authorization, checks the nonce is unused and unexpired, checks the amount is within balance and within the spending cap, moves the balance atomically, records the nonce, and returns a receipt. Two accounts are pre-funded at init.

---

## Making the relay rock solid (demo-critical)

- **Idempotency:** the authorization's nonce is the idempotency key. Submitting the same one twice returns the *same* receipt and never double-charges (enforced in the canister; de-duped again in the relay).
- **Retries + timeouts:** bounded retry with backoff on transient canister/network errors; a clean "tap again" state if it exceeds the timeout — never a spinner that hangs.
- **Pre-flight health check:** the merchant app pings the relay before the demo and shows a green dot, so you know it's live before you're on stage.
- **Demo safe-mode toggle:** if venue wifi dies, a local fallback still runs the full visual flow. Insurance against a hostile network in the room.
- **Logging + a one-glance status page** for quick diagnosis.

---

## Scope

**In:** Android app (Pay + Receive), on-device key, QR generate/scan, offline signing, relay, canister ledger, two pre-funded demo accounts, single `$` unit, the airplane-mode flow.

**Out (deliberately):** iOS, login/KYC, fiat on/off-ramp, funding flow, secure-element hardening, contacts/P2P discovery, multi-merchant, real user onboarding. Software keys are fine for a demo.

---

## Timeline (~3–4 engineer-weeks)

- **Week 1 — Ledger:** canister with balances, Ed25519 verification, nonce/expiry/cap checks, atomic transfer, tests. Deploy to testnet, pre-seed two accounts. Relay skeleton wired to the canister.
- **Week 2 — App core:** keygen + secure storage, two-mode UI, QR generate + scan, offline build-and-sign, merchant submit via relay, receipt screen. Full happy path working across two devices.
- **Week 3 — Reliability + polish:** relay hardening (idempotency, retries, health, safe-mode), the airplane-mode flow, error states, balance animation, UI polish, and a full demo rehearsal.
- **Week 4 (buffer):** optional swap to real ckUSDC on testnet so "real chain-key USD" is literally true; spare time for bugs and a dry run against the actual pitch.

**Team:** ~1 month solo, or ~2 weeks with two people (one on canister + relay, one on the app).

---

## Honest framing (for the sharp investor in the room)

This demo proves the **experience** — offline payment, instant merchant confirmation, real settlement on a decentralized ledger. It does **not** yet prove hardened security: with software keys, real double-spend resistance comes from the canister's cap + nonce checks (included here) and, later, secure-element key binding (deferred). Worth saying plainly if asked, because it reads as maturity rather than a gap.

---

## Implementation notes

- **App:** React Native (Android). QR: `react-native-qrcode-svg` (generate) + a vision-camera QR scanner. Signing: `@noble/ed25519` or `tweetnacl` with `react-native-get-random-values`. Key at rest: Android Keystore via `react-native-keychain`.
- **Relay:** Node + Express + `@dfinity/agent`, small idempotency store (in-memory is enough for a demo).
- **Canister:** Motoko or Rust (Rust: `ed25519-dalek` for verification), deployed with `dfx`.
- **Value unit:** stored as integer minor units, displayed as `$`. Backed by a USD stablecoin (ckUSDC on ICP) when/if you move off the internal demo ledger — never surfaced in the UI.
