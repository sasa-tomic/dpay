# Agent test float — mechanism

The binding spend rules live in `CLAUDE.md` ("Non-negotiable: the agent test float"), because they
must be in context every session. This file is the mechanism and the record; it does not restate
the rules.

## Why this key exists

Some things about dpay's mainnet rails cannot be proven any other way. Verified 2026-09-01: the
OpenCryptoPay payment provider has **no sandbox** — `dev.api.dfx.swiss` is 502 and every method in a
live quote is mainnet. Its test till is a fixed CHF 1, `min == max`, so there is no smaller smoke
test. The same is true of the outstanding funded-transfer proof for VCHF and native ICP. A small
real float is the only instrument that closes those.

## Commands

    just agent-principal   # the funding address (no decryption)
    just agent-balance     # live mainnet balances, measured (no decryption)
    just agent-seed        # the seed hex — DECRYPTS; only immediately before a spend

`agent-balance` is the only source of truth for what the float holds. Never state a balance from
memory or from this file — measure it. An unreachable ledger prints `UNREADABLE`, never `0`.

## Recovery

Two independent halves, and you need both:

- `secrets/agent-icp.sops.json` — the encrypted seed. Committed; survives any clone.
- `.dev/age/agent-key.txt` — the age identity. Gitignored, and `.dev/` is **not** backed up.

So the age identity is the single point of failure. **Back up that one line to a password manager.**
Without it the encrypted seed is unrecoverable and anything the float holds is gone.

The seed is a plain 32-byte Ed25519 seed and the principal is derived by the same committed wasm
core the app signs with, so this is a real dpay identity — not a script-only key. It is not
currently exposed as a 24-word mnemonic (the app's `app/lib/bip39.ts` transitively imports the RN
i18n module, so it will not load in a plain node script); until that import is untangled the key
cannot be restored into the phone app. Worth knowing before planning an on-device funded test.

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
| _(none yet — key generated 2026-09-01, unfunded)_ | | | | | |
