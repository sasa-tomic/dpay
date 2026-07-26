# Funding ("Add money") — plan / spec

How money gets **into** a dpay account. Companion to the non-custodial and monetization docs; read
those non-negotiables first (`CLAUDE.md` → "dpay never holds, swaps, or can move user funds").

## The one principle

**Balance only ever appears because real value was deposited. dpay never conjures it and never holds
or moves it.** In production the "mint" is performed by an ICP **Chain-Fusion ck-minter** minting a
chain-key asset (ckUSDC, ckBTC, …) **to the user's own principal**, triggered by a confirmed on-chain
deposit — not by dpay. dpay's job is a *screen*: show the deposit address, show instructions, show the
resulting balance. It is not a counterparty and holds no omnibus.

This is also the real answer to "a random Joe must not be able to mint": minting requires depositing
real funds to an address the minter derived for that user. There is no free mint to gate — the gate
is *a real deposit happened*.

## Today (demo) vs. production

| | Demo (now) | Production |
|---|---|---|
| Ledger | `dpay-canister` internal balances | the **ckUSDC** ledger (ICRC-1); user holds ckUSDC at **their own** principal |
| Funding | operator runs `just mint <acct> <cents>` (controller-only) to simulate a confirmed deposit | ck-minter mints to the user's principal on a real external deposit |
| Who mints | a canister **controller** (the operator), gated by `is_controller` | the **ck-minter**, gated by an on-chain deposit; dpay does not mint at all |
| dpay custody | none (demo funds are play money) | none (user's key, user's principal, user's ck-asset) |

The controller-gated `mint` shipped today is explicitly the **stand-in** for "a deposit confirmed." It
is retired (or kept only for local/testnet demos) once real funding lands. **An internal dpay balance
backed by pooled ckUSDC would be an omnibus = custody = forbidden** — production reads the user's *own*
ckUSDC balance; it does not keep a shadow ledger of user funds.

## Supported chain-key asset → native per-principal deposit address

Each user is an IC principal (their on-device key). A ck-minter derives a **deterministic
per-principal deposit address on the external chain via threshold signatures** — no bridge, no
custodian, dpay not in the flow.

- **ckBTC — the canonical model.** `get_btc_address(owner = user_principal, subaccount)` returns a
  real BTC address. The user sends BTC; after confirmations, `update_balance(owner, subaccount)` mints
  ckBTC to the user's principal. Withdrawal is the mirror: the minter burns ckBTC and sends to the
  user's native BTC address.
- **ckUSDC (launch rail) — USDC on Ethereum → ckERC20.** Deposits go through the ckETH/ckERC20 minter
  (a deposit **helper contract** on Ethereum carries the user's principal, or a per-principal deposit
  address). **VERIFY before building:** the current ckUSDC minter canister id + exact deposit
  mechanism, and confirm ckUSDC (not just ckETH) is wired end-to-end.
- **SOL / ckSOL:** the building blocks (threshold Ed25519 + the SOL RPC canister) are shipped, but a
  per-principal ckSOL minter is **not confirmed** — verify status before promising a SOL deposit
  address.

**User flow (one asset):**
1. dpay calls the minter's get-address for the user's principal → shows the address + QR.
2. Instructions screen: asset, network, address/QR, est. arrival time + network fee, and the honest
   line: *"This is your money at your address — we never hold it."*
3. dpay polls the ck-asset ledger (`icrc1_balance_of` at the user's principal) and the minter's
   `update_balance`, surfacing **pending → credited**. The credited balance *is* the displayed `$`.

## Unsupported asset / fiat → embedded licensed on-ramp

Hand off to an embedded **licensed third-party provider** (Onramper / Transak / Changelly-class
aggregator) with the user's ck deposit address **pre-filled as the destination**. The provider is the
counterparty of record and carries the licensing; dpay supplies an address and shows status — the same
one-tap UX MetaMask / Phantom use, with none of the liability. A static "send here, then to X" page is
the zero-integration fallback.

## The user never sees "supported vs. unsupported"

One **"Add money"** screen: pick what you have. Under the hood it routes to *direct* (ck-minter) or
*via partner (est. fee + time)*. Same on the way out ("Cash out").

## Concrete build order (when we get there)

1. **Address:** call the right ck-minter get-address for the user's principal; render address + QR.
2. **Instructions:** asset / network / address / est. time + fee / non-custody line.
3. **Status:** poll `icrc1_balance_of(user_principal)` + minter `update_balance`; show pending →
   credited.
4. **Withdraw (mirror):** user authorizes the minter to burn + send to their native address.
5. **Fiat / unsupported:** embed the on-ramp with the address pre-filled.

## Interplay with offline settlement (out of scope here, noted)

Funding is orthogonal to the offline-sign → online-submit *payment* flow. Whether payments settle
directly on ckUSDC (ICRC-1/ICRC-2 with an offline-authorized transfer) or keep a thin dpay canister
layer is a **separate settlement spec**. Whatever that is, it must keep the same property: the payer's
signature is the only authority, and dpay can't move funds.

## Open items to verify (rigor — do not build on assumptions)

- ckUSDC minter canister id + deposit mechanism on mainnet (helper-contract-with-principal vs.
  per-principal address). ckEURC availability for the EUR rail.
- ckSOL / per-principal Solana deposit addresses: confirm a shipped minter, not just primitives.
- Confirmation latency + fee ranges per asset (to set honest "arrives in ~N min, ~$X fee" copy).
- Minimum deposit / dust thresholds each minter enforces.
