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

**Completed 2026-09-05 — both spellings.** A freshly built physical-device app paid order `2609` in
native ICP. Ledger block `38,190,401` moved `0.00442682 ICP` plus the `0.00010000 ICP` fee, DFX
answered accepted for that exact block, and the shop rendered the order received. Later the same day
the same phone paid order `2610` in VCHF: ledger block `81,062`, submitted as the prefixed
`ly36x-…-cai:81062`, accepted. Both of DFX's tx-id spellings — bare index for native ICP,
`<ledger>:<index>` for every other ICRC ledger — are now live-proven with paid, credited orders.

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
acceptable only because the float is capped. It is why the cap matters. Both halves of that
tradeoff were exercised on 2026-09-05: the key was rotated after a partial local disclosure (spend
log below), and the old encrypted blob does remain in history — worthless now, because the old
principal is empty and must never be funded again.

## Spend log

The chain records *what* moved; it does not record *why*. That is this table's only job — it is not
a second copy of the balance.

| Date | Asset | Amount | To | Purpose | Result |
|------|-------|--------|-----|---------|--------|
| 2026-09-05 | ICP | 0.00442682 (+ 0.00010000 fee) | DFX Merch Shop payment principal `ygf2v-…-4ae` | Approved €0.01 OpenCryptoPay acceptance test, WooCommerce order `2609` | Confirmed at ICP block `38,190,401`; DFX `/tx` answered accepted and the shop rendered order received |
| 2026-09-05 | ICP | 0.01000000 (+ 0.00010000 fee) | Physical dpay test wallet `vi7yz-…-eqe` | Fund the freshly installed app for the approved €0.01 DFX OpenCryptoPay acceptance test without replacing the device's existing wallet | Confirmed at ICP block `38,190,338`; app detected the exact deposit |
| 2026-09-05 | ICP | 0.01000000 | ICPSwap pool `65mrh-…-cai` | Founder-authorized one-off ("try to swap with icpswap"): acquire the VCHF the €0.01 prefixed-acceptance test needs — external test-float tooling only, NOT a dpay product feature; the no-swap product rule is unchanged | `icrc2_approve` 1,020,000 e8s, 10-min expiry, spender = the pool (ICP block `38,193,124`; pool via factory `4mmnk-…-cai` `getPool`, fee tier 3000); `depositFromAndSwap` returned `0.02119881 VCHF` — exactly the pre-flight quote, `amountOutMinimum` 1,800,000 |
| 2026-09-05 | VCHF | 0.02000000 (+ 0.00010000 fee) | Physical dpay test wallet `vi7yz-…-eqe` | Fund the phone with the swapped VCHF for the €0.01 prefixed-acceptance test (order `2610`) | Confirmed at VCHF block `81,061`; phone received exactly `0.02` VCHF |
| 2026-09-05 | VCHF | 0.00950150 (+ 0.00010000 fee) | DFX Merch Shop payment principal `ygf2v-…-4ae` | Approved €0.01 OpenCryptoPay acceptance test, WooCommerce order `2610` (payment link `pl_136966f8a5d2aa1d`), paid from the physical phone wallet | Confirmed at VCHF block `81,062` (memo `d70430be…`, quote `plq_2f35197812d4c97c`, paid `2026-09-05T12:54:42Z`); the app submitted the LEDGER-PREFIXED id `ly36x-…-cai:81062` to DFX `/tx` and DFX answered accepted — the FIRST paid post-fix prefixed acceptance; the link now answers HTTP 409 "Payment complete". Phone balance arithmetic exact: `0.02` → `0.0103985` |
| 2026-09-05 | ICP + VCHF | 1.97960000 ICP + 0.00089881 VCHF (each + 0.00010000 fee) | New float principal `vloyo-…-5ae` (self) | Key rotation after the leak recorded below — move everything off the compromised old key | ICP block `38,193,953`; VCHF block `81,063`; balances re-measured on the new principal: 1.97960000 ICP + 0.00089881 VCHF + 0 ckBTC — float fully intact minus the two rotation fees |
| 2026-09-19 | ICP | 0.20000000 (+ 0.00010000 fee) | ICPSwap pool `65mrh-…-cai` (via the dpay app's own Convert, ICP→VCHF direct) | Live proof of the 2026-09-19 approve fix: the FIRST successful end-to-end in-app conversion on mainnet (the AllowanceChanged defect previously wedged every conversion at "Approving") | Approved + swapped through the app's real UI; ICP block `38,468,498`; received exactly the quoted `0.46359507 VCHF` (quote `0.4640173` gross at 1% slippage, min `0.45947612`); float after: 1.77940000 ICP + 0.46449388 VCHF |
| 2026-09-19 | VCHF | 0.40000000 (+ 0.00020000 fees) | ICPSwap pool `hx7nb-…-cai` (via the dpay app's own Convert, VCHF→ckUSDC direct — the founder's exact failing pair) | Second live proof: the approve fix + the new stale-quote guard together; the destination pick re-quotes (the old build showed the standing VCHF→ICP number relabeled as USDC) and the confirm re-quote gate passed clean | Converted panel: "0.47961 USDC received in your wallet. Payout record: 783528"; VCHF debit exact (0.4 + approve fee + pool pull fee); float after: 0.06429388 VCHF + 0.47961 ckUSDC + 1.77940000 ICP |
| 2026-09-19 | ICP | 0.30000000 (+ 0.00020000 fees) | ICPSwap pool `xmiu5-…-cai` (via the dpay app's own Convert, ICP→ckBTC direct) | Flow-04 live matrix step 1: the 2026-09-16 ckBTC pool proven forward on mainnet | Done panel + on-chain: ICP 1.88325395 → 1.58305395, ckBTC +0.00001045 (block `4,642,280`, pool mint memo `…94643`); float after: 1.58305395 ICP + 0.00001045 ckBTC |
| 2026-09-19 | ICP | 0.00010000 (approve fee only) | ICPSwap pool `xmiu5-…-cai` (flow-04 step-1 RE-RUN) | The fee-funded discovery of the settlement-probe false-positive: the same-pair same-amount re-run after a fresh browser store claimed the EARLIER run's payout row and displayed "Converted" while on-chain only the approve had executed — the approve's allowance expired unused. Fixed same day: the probes now refuse any row predating the record (commit `9b66796`) | Money impact: one 0.0001 ICP approve fee; the swap never executed so nothing else moved |
| 2026-09-19 | ckBTC | 0.00000045 (+ fee) | ICPSwap pool `akhru-…-cai` (via the dpay app's own Convert, ckBTC→ckETH direct) | Flow-04 live matrix step 2: the 2026-09-16 ckBTC↔ckETH pool proven forward on mainnet (tiny lot — the float only ever held ~0.00001 ckBTC) | Done panel; ckBTC 1045 → 980 sats, ckETH credited |
| 2026-09-19 | ICP | 0.15000000 (+ 0.00020000 fees) | ICPSwap pool `angxa-…-cai` (via the dpay app's own Convert, ICP→ckETH direct) | Flow-04 live matrix step 3: the ICP↔ckETH pool proven forward on mainnet — the SIXTH and last registered IC pool, so every direct conversion pair is now live-proven | Done panel + on-chain: ICP 1.58295395 → 1.43275395, ckETH +0.000161271245056496 |
| 2026-09-19 | ckUSDC | 0.01000000 (approve fee) | ICPSwap pools `mohjv-…-cai` + `angxa-…-cai` (via the dpay app's own Convert, ckUSDC→ckETH HUB via ICP, 4 legs) | Flow-04 live matrix step 4: the hub engine ran live — leg-1 approve executed, then a leg wedged before swap-1 landed and the record parked on the honest stuck panel ("A leg was sent but its outcome is unknown…"). The self-flip watch is blind against the pre-deploy prod relay (its `/api/v1/transactions` ICP-index probe 503s until the `05e2bca` mirror fix ships); offline, the hub lifecycle incl. mid-plan expiry trichotomy is pinned by flow 190 + jest. PARTIALLY proven live; the allowance expires harmlessly | Money impact: one 0.01 ckUSDC approve fee; no swap filled; float after: 0.12961 ckUSDC |

**Key-leak incident and rotation, 2026-09-05 — recorded honestly.** During the funding step, a
first attempt to hand-build a PKCS#8 PEM for dfx failed, and the dfx error message echoed **63 of
the 64 base64 characters of the old float key's DER** (all but the final byte) into a local tool
log. The key was treated as COMPROMISED from that moment. Rotation executed the same day: a
brand-new seed (generated in-memory, sops-encrypted with the existing age identity, plaintext
shredded immediately); the float principal is now
`vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae`; the old
`secrets/agent-icp.sops.json` was shredded and replaced, `secrets/agent-icp.pub.json` updated
(created 2026-09-05); both temporary dfx identities (`dpay-agent-ocp-temp`, `dpay-rotate-old`)
removed; every PEM/DER temporary shredded. The old principal
`lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe` is empty, compromised, and
abandoned — **it must never be funded again.**
