# Funding ("Add money" / "Cash out") — the product shape

**What this file owns:** the *shape* of getting money in and out — the direct-vs-partner split, and the
promise that the user never has to know which one they got. `monetization.md` delegates the
fiat-provider question here, so this is the one place that answer lives.

**What this file must never restate:** how any rail actually works. Every mechanism has exactly one
owner, and a copy here is a copy that drifts — this file spent a month asserting a custody model the
code had already abandoned, which is why the mechanism half is now a pointer table and nothing more.

| Mechanism | Owner |
|---|---|
| Where user funds live | `docs/CANISTERS.md` |
| ckBTC deposit address | `railBtcDepositAddress`, `app/services/rail.ts` |
| ckETH / ckERC20 deposit | `app/components/CkErc20DepositSheet.tsx` |
| VCHF / ICP deposit (no minter) | `app/components/IcrcDepositSheet.tsx` |
| "Already on the Internet Computer?" on the ck\* sheets | `app/components/IcrcAccountSection.tsx` |
| SOL deposit + withdraw (device key) | `app/components/SolanaReceiveSheet.tsx`, `app/solana/` |
| Cash out — which rail an address routes to | `app/lib/destination.ts` |
| Cash out — the chain-key burn | `CODEBASE_ANALYSIS.md` § "Withdrawal proxy" |
| Cash out — the durable double-burn guard | `app/services/offrampPersist.ts`, `app/services/offrampRetry.ts` |
| Catalog rows and ramp capability flags | `crates/dpay-relay/src/catalog.rs` |

## The one principle

**Balance appears because value arrived. dpay never holds it and cannot move it.** dpay's job is a
*screen*: show the address, show the instructions, show the resulting balance. It is not a
counterparty and holds no omnibus. The non-custodial rule itself is a non-negotiable and lives in
`CLAUDE.md`; this file only says what it means for Add money.

Two honest exceptions to "value arrived", both visible as such to the user:

- **DEMO (currency 0) is play money.** Its faucet conjures balance by design and must stay visibly
  separated from real assets.
- **A chain-key mint is not dpay's mint.** It is performed by an ICP Chain-Fusion ck-minter, triggered
  by a confirmed on-chain deposit. This is also the real answer to *"a random Joe must not be able to
  mint"*: there is no free mint to gate — the gate is *a real deposit happened*.

## How value actually arrives — four shapes, one screen

The user picks what they have; the app picks the shape. Three of the four need no minter at all, which
is the fact this document previously got wrong by assuming funding *meant* a ck-minter.

1. **Chain-key, via a minter (ckBTC, ckETH, ckUSDC).** A ck-minter derives a deterministic
   per-principal deposit address on the external chain via threshold signatures — no bridge, no
   custodian, dpay not in the flow. Withdrawal is the mirror: burn, and the minter sends native.
2. **Direct ICRC-1 transfer in (VCHF, native ICP).** These rows have no minter and no fiat ramp, and
   they still fund perfectly well: the user's own ICRC-1 account, as QR and copyable text, funded by a
   plain transfer from any Internet Computer wallet.
3. **Already on the Internet Computer (every ck\* asset).** A chain-key asset is *also* an ICRC-1
   token, so a holder transfers straight in with no Bitcoin/Ethereum round trip, no minter wait and no
   gas. The surface names the **ledger token** (ckBTC, never BTC) — plain BTC cannot be sent to an IC
   principal.
4. **Native device key (SOL, and USDC on Solana).** The deposit address *is* the device's own Solana
   address; withdrawal signs from the same key. No IC canister is involved.

**`onramp = Unavailable` on a catalog row means no FIAT ramp — it is not a transfer-in blocker.** That
distinction is the single easiest thing to read wrong here: VCHF and ICP are `Unavailable` on both
ramps and are fully fundable by shape 2. Founder hard rule (2026-08-29, `CLAUDE.md`): every step,
especially a dead end, must give the user an instruction they can act on — an asset with no fiat ramp
still gets a complete answer, not an apology.

**The instructions screen is the contract**, whichever shape applies: asset, network, address + QR,
estimated arrival, the fee, whether a memo is needed, and the honest line — *"this is your money at
your address — we never hold it."*

## Fiat and unsupported assets → an embedded licensed provider

**Status: unstarted. This is the only part of this document that is not built.**

**And the shape below has a hard external limit, measured 2026-09-04:** no card on-ramp anywhere
delivers a chain-key asset or VCHF — only native ICP reaches the Internet Computer at all. So
"pre-fill the user's deposit address at a provider" works for Solana and for native ICP, and for
nothing else on the IC. Which providers reach what, and the bank-transfer route that does reach
VCHF: `docs/specs/2026-09-04-currency-first-wallet-plan.md`.

Hand off to an embedded **licensed third-party provider** (Onramper / Transak / Changelly-class
aggregator) with the user's deposit address **pre-filled as the destination**. The provider is the
counterparty of record and carries the licensing; dpay supplies an address and shows a status — the
same one-tap UX MetaMask and Phantom use, with none of the liability. A static "send here, then to X"
page is the zero-integration fallback and is equally clean.

This is what keeps a fiat ramp compatible with the non-custodial non-negotiable: the user authorizes
the provider **directly**, and dpay never becomes the counterparty. Whether dpay may quote, route, or
take a cut of that provider's business is open and belongs to `monetization.md`; the regulatory
evidence is `docs/REGULATORY.md`.

## The user never sees "supported vs. unsupported"

One **"Add money"** screen: pick what you have. Under the hood it is *direct* or *via partner (est. fee
+ time)*. Same on the way out.

## The invariant any future funding work must keep

The payer's signature is the only authority, and dpay cannot move funds. Funding is orthogonal to the
offline-sign → online-submit payment flow, and must stay that way.
