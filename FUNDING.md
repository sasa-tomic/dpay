# Funding ("Add money") — plan / spec

How money gets **into** a dpay account. Companion to the non-custodial and monetization docs; read
those non-negotiables first (`CLAUDE.md` → "dpay never holds, swaps, or can move user funds").

> **Status.** The **ckBTC deposit/top-up path is implemented** as a facade-proxy surface:
> `dpay-canister` exposes `deposit_address` / `refresh_deposit` / `deposit_info` (+ admin
> `register_minter`), the relay serves `/api/v1/deposit/*`, and the app renders a `DepositSheet`.
> Everything below describes that **implemented** model for ckBTC and the not-yet-built production
> shape for the other assets. Build contract: `deposit-integration-plan.md`; risk posture:
> `CODEBASE_ANALYSIS.md`.

## The one principle

**Balance only ever appears because real value was deposited. dpay never conjures it and never holds
or moves it.** The "mint" is performed by an ICP **Chain-Fusion ck-minter** minting a chain-key asset
(ckUSDC, ckBTC, …) onto its ICRC ledger, triggered by a confirmed on-chain deposit — not by dpay.
dpay's job is a *screen*: show the deposit address, show instructions, show the resulting balance. It
is not a counterparty and holds no omnibus.

**Where the mint lands (implemented).** The facade proxies the minter with
`owner = canister_self()`, `subaccount = <the user's pubkey>`, so a confirmed mint credits the ICRC
ledger at `Account{owner: facade, subaccount: pubkey}` — the *same* segregated subaccount
`pay`/`balance_of` already read (not an omnibus, and not a free mint). The user's on-device key
authorizes movement of *their* subaccount; dpay never holds a user seed and cannot move funds without
the payer's signature. (A standalone wallet that held ck-assets at the *user's own principal* is the
eventual shape; the implemented canister-routed model uses facade-owned subaccounts, consistent with
how all dpay settlement already works.)

This is also the real answer to "a random Joe must not be able to mint": minting requires depositing
real funds to an address the minter derived for that user. There is no free mint to gate — the gate
is *a real deposit happened*.

## Today (demo) vs. production

| | Demo (now) | Production |
|---|---|---|
| Ledger | `dpay-canister` internal balances | the ck-asset's **ICRC-1 ledger** (ckBTC today; ckUSDC = launch rail, follow-up). The user's key maps to a segregated subaccount `Account{owner: facade, subaccount: pubkey}` — not a pooled balance |
| Funding | operator runs `just mint <acct> <cents>` (controller-only) to simulate a confirmed deposit | ck-minter mints to the user's subaccount on a real external deposit (**ckBTC: implemented** via the facade deposit proxy; ckUSDC/ckETH: follow-up) |
| Who mints | a canister **controller** (the operator), gated by `is_controller` | the **ck-minter**, gated by an on-chain deposit; dpay does not mint at all |
| dpay custody | none (demo funds are play money) | none (user's key, user's subaccount, user's ck-asset) |

The controller-gated `mint` shipped today is explicitly the **stand-in** for "a deposit confirmed." It
is retired (or kept only for local/testnet demos) once real funding lands. **An internal dpay balance
backed by pooled ckUSDC would be an omnibus = custody = forbidden** — production reads the user's *own*
ckUSDC balance; it does not keep a shadow ledger of user funds.

## Supported chain-key asset → native per-principal deposit address

Each user is an IC principal (their on-device key). A ck-minter derives a **deterministic
per-principal deposit address on the external chain via threshold signatures** — no bridge, no
custodian, dpay not in the flow.

- **ckBTC — the canonical model, and the one implemented today.** The facade proxies the ckBTC minter:
  `deposit_address` → `get_btc_address`, `refresh_deposit` → `update_balance`, `deposit_info` →
  `get_minter_info` + `get_deposit_fee`. The minter is called with `owner = canister_self()`,
  `subaccount = <user pubkey>`, so it derives a **per-user native BTC deposit address** and — after
  confirmations — mints ckBTC to `Account{owner: facade, subaccount: pubkey}`, the same subaccount the
  wallet already reads as its balance (a confirmed deposit is automatically the next balance poll's
  number). No settlement/balance/history code changed to add it. Mainnet canister IDs: **minter
  `mqygn-kiaaa-aaaar-qaadq-cai`**, **ledger `mxzaz-hyaaa-aaaar-qaada-cai`**
  (`docs.internetcomputer.org/references/chain-key-canister-ids/`). **Governance step (not code):** the
  facade principal must be **KYC-allowlisted** for ckBTC mainnet minting, or the minter refuses to mint.
  Withdrawal is the mirror (the minter burns ckBTC and sends to the user's native BTC address) — a
  follow-up, not yet wired through the facade.
- **ckUSDC (launch rail) — USDC on Ethereum → ckERC20.** Deposits go through the ckETH/ckERC20 minter
  (a deposit **helper contract** on Ethereum carries the user's principal, or a per-principal deposit
  address). **VERIFY before building:** the current ckUSDC minter canister id + exact deposit
  mechanism, and confirm ckUSDC (not just ckETH) is wired end-to-end.
- **SOL / ckSOL:** the building blocks (threshold Ed25519 + the SOL RPC canister) are shipped, but a
  per-principal ckSOL minter is **not confirmed** — verify status before promising a SOL deposit
  address.

**User flow (one asset):**
1. dpay asks the facade (→ minter `get_btc_address`) for the user's deposit address → shows it + QR.
2. Instructions screen: asset, network, address/QR, est. arrival time + network fee, and the honest
   line: *"This is your money at your address — we never hold it."*
3. dpay polls the ck-asset ledger (`icrc1_balance_of` at the user's subaccount) and the facade's
   `refresh_deposit` (→ minter `update_balance`), surfacing **pending → credited**. The credited
   balance *is* the displayed amount.

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

- ✅ **ckBTC:** resolved + implemented — minter `mqygn-kiaaa-aaaar-qaadq-cai`, ledger
  `mxzaz-hyaaa-aaaar-qaada-cai`; facade-proxy deposit surface shipped (`deposit_address` /
  `refresh_deposit` / `deposit_info` + `register_minter`). The items below remain open.
- **ckETH / ckERC20 (the ckUSDC launch rail):** the facade-proxy seam is reusable, but the ckETH
  minter exposes different methods (Ethereum-side deposit *helper contract* carrying the user's
  principal, vs. ckBTC's per-principal `get_btc_address`). Verify the exact mechanism and wire it as a
  follow-up. ckEURC availability for the EUR rail.
- ckSOL / per-principal Solana deposit addresses: confirm a shipped minter, not just primitives.
- Confirmation latency + fee ranges per asset (to set honest "arrives in ~N min, ~$X fee" copy).
- Minimum deposit / dust thresholds each minter enforces.
