# Agent test float — mechanism

The binding spend rules live in `CLAUDE.md` ("Non-negotiable: the agent test float"), because they
must be in context every session. This file is the mechanism and the record; it does not restate
the rules.

## Why this key exists

Some things about dpay's mainnet rails cannot be proven any other way. Verified 2026-09-01: the
OpenCryptoPay payment provider has **no sandbox** — `dev.api.dfx.swiss` is 502 and every method in a
live quote is mainnet. The same was true of the funded-transfer proof for VCHF and native ICP, which
the founder closed on 2026-09-01. A small real float is the only instrument that closes this class
of proof.

## The OpenCryptoPay payment test — use the €0.01 gateway (founder direction, 2026-09-04)

**`https://dfx.shop/produkt/dfx-testing-product/` — €0.01 — is the route to use.** Not the CHF 1
public test till (`artifacts/spar-test-till-qr.png`), which is fixed-amount and 100× the price. The
till stays as the fallback for the day the shop route turns out not to work.

Measured 2026-09-04, so the route is known to be real before anyone spends on it:

- the shop's own OpenCryptoPay code decodes to `https://api.dfx.swiss/v1/lnurlp/pl_3e6fe374fbc7dcb0`
  — the SAME provider and standard as the test till, so what it proves transfers;
- that link is a **Donation** link in `Public` mode with no pending charge, and the payer cannot
  supply the amount (`?amount=…` in four spellings all answer `404 No pending payment found`). A
  payable charge exists only after a real order is placed;
- so the test is a WooCommerce checkout — cart → checkout details → the OpenCryptoPay code — and
  **Claude drives the whole round trip in the browser**, order included, then pays the resulting
  charge from this float and verifies it with `just agent-history`.
- The operator is the **DFX Merch Association**, not DFX AG. A separate counterparty from the one
  answering `api.dfx.swiss`, which is what the "ask before the first payment to a new counterparty"
  rule is about.

**Run it only when everything else is implemented and verified and this is the last pending check.**
Founder direction, and the reason is the loss path itself: the submission is one-shot, so every
attempt costs a real order at a real merchant and buys exactly one observation. An attempt spent
while something else is still broken is an attempt that proves nothing and cannot be repeated for
free. Green gates first (`just verify`, the device gate), then this.

## Commands

    just agent-principal   # the funding address (no decryption)
    just agent-balance     # live mainnet balances, measured (no decryption)
    just agent-history     # what the money DID: transfers + block indexes (no decryption)
    just agent-seed        # the seed hex — DECRYPTS; only immediately before a spend

`agent-balance` is the only source of truth for what the float holds. Never state a balance from
memory or from this file — measure it. An unreachable ledger prints `UNREADABLE`, never `0`.

`agent-history` is how a spend is VERIFIED rather than reported. A payment made on a phone appears
here as an outgoing transfer with its amount, its destination and its block index — and for an
OpenCryptoPay payment that block index is the exact proof the wallet reported to the provider, so
"it paid" can be checked against the ledger instead of taken on trust. It reads the official ICP
index pinned in `dfx/catalog_truth.json`, and dies loudly rather than printing an empty history it
never actually read: after a real payment, "no transactions" and "could not ask" are opposite
answers.

## Recovery

Two independent halves, and you need both:

- `secrets/agent-icp.sops.json` — the encrypted seed. Committed; survives any clone.
- `.dev/age/agent-key.txt` — the age identity. Gitignored, and `.dev/` is **not** backed up.

So the age identity is the single point of failure. **Back up that one line to a password manager.**
Without it the encrypted seed is unrecoverable and anything the float holds is gone.

The seed is a plain 32-byte Ed25519 seed and the principal is derived by the same committed wasm
core the app signs with, so this is a real dpay identity — not a script-only key. A plain node
script cannot print it as a 24-word mnemonic (`app/lib/bip39.ts` reaches the RN i18n module through
`app/lib/format.ts`, so it will not load outside the app), but the mnemonic is not the way in:
Onboarding restores from the **64-hex seed** directly (`restoreMode: 'hex'`, `app/components/
Onboarding.tsx`), which is exactly what `just agent-seed` prints. So an on-device funded test with
this float is possible today, with no code change.

## Known limits of the encryption

An encrypted blob in git is safe to push or mirror. It is **not** protection against local
compromise: anyone with read access to this working copy has both halves on the same disk. And a
commit is forever — if this key is ever rotated, the old encrypted blob stays in history. That is
acceptable only because the float is capped. It is why the cap matters.

## Spend log

The chain records *what* moved; it does not record *why*. That is this table's only job — it is not
a second copy of the balance.

| Date | Asset | Amount | To | Purpose | Result |
|------|-------|--------|-----|---------|--------|
| _(none yet — key generated 2026-09-01; nothing has been spent. What it HOLDS is `just agent-balance`, never this table)_ | | | | | |
