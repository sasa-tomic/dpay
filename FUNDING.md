# Funding ("Add money") — plan / spec

How money gets **into** a dpay account. Companion to the non-custodial and monetization docs; read
those non-negotiables first (`CLAUDE.md` → "dpay never holds, swaps, or can move user funds").

> **STATUS: this file is PRE-CUTOVER and its custody model is FALSE.** Flagged 2026-09-04 without
> being rewritten, because the rewrite is a piece of work in its own right and a silent half-fix
> would be worse. Everything below that says user funds live at
> `Account{owner: facade, subaccount: pubkey}`, that the facade proxies the minter and `pay()` reads
> that subaccount, or that the wallet displays a facade `BAL_CACHE`, describes the world before the
> 2026-08-19/20 user-principal cutover. Since then funds sit at the **user's own principal** on the
> external ICRC ledgers, the deposit owner is encoded by the app rather than by the facade, balances
> are direct `icrc1_balance_of` reads, and `register_minter` / `/api/v1/deposit/address` /
> `/api/v1/deposit/refresh` no longer exist. **`docs/CANISTERS.md` is the authority for all of it;
> prefer it over any sentence in this file.** What remains useful here is the *intent* — the shape of
> Add money and the partner-vs-direct split — not the mechanism. Also absent and now the funding path
> for the asset the till settles in: assets with no minter and no ramp (VCHF, native ICP), where
> adding money is a plain transfer to your own ICRC-1 account.

## The one principle

**Balance only ever appears because real value was deposited. dpay never conjures it and never holds
or moves it.** The "mint" is performed by an ICP **Chain-Fusion ck-minter** minting a chain-key asset
(ckUSDC, ckBTC, …) onto its ICRC ledger, triggered by a confirmed on-chain deposit — not by dpay.
dpay's job is a *screen*: show the deposit address, show instructions, show the resulting balance. It
is not a counterparty and holds no omnibus.

**Where the mint lands (implemented).** The facade proxies the minter with
`owner = canister_self()`, `subaccount = <the user's pubkey>`, so a confirmed mint credits the ICRC
ledger at `Account{owner: facade, subaccount: pubkey}` — the *same* segregated subaccount
that `pay()` reads authoritatively and the display cache is intended to represent (not an omnibus,
and not a free mint). The user's on-device key
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
| Ledger | A demo ICRC ledger routed through the facade | Each ck-asset's real **ICRC-1 ledger**. The user's key maps to a segregated subaccount `Account{owner: facade, subaccount: pubkey}` — not a pooled balance |
| Funding | The fixed, rate-limited self-service faucet credits demo currency 0 | A ck-minter credits the user's subaccount after a real external deposit (**ckBTC proxy and initial browser ckUSDC submission are implemented; production gaps remain**) |
| Who mints | The demo ledger's configured minting account via the faucet path | The **ck-minter**, gated by an on-chain deposit; dpay does not mint real assets |
| dpay custody | none (demo funds are play money) | none (user's key, user's subaccount, user's ck-asset) |

The demo faucet is explicitly play money and must remain visibly separate from real assets. **An
internal dpay balance backed by pooled ckUSDC would be an omnibus = custody = forbidden** — production
reads the user's segregated ckUSDC ledger subaccount; it does not keep a shadow ledger of user funds.

## Supported chain-key asset → native per-principal deposit address

Each user is an IC principal (their on-device key). A ck-minter derives a **deterministic
per-principal deposit address on the external chain via threshold signatures** — no bridge, no
custodian, dpay not in the flow.

- **ckBTC — the canonical model, and the one implemented today.** The facade proxies the ckBTC minter:
  `deposit_address` → `get_btc_address`, `refresh_deposit` → `update_balance`, `deposit_info` →
  `get_minter_info` + `get_deposit_fee`. The minter is called with `owner = canister_self()`,
  `subaccount = <user pubkey>`, so it derives a **per-user native BTC deposit address** and — after
  confirmations — mints ckBTC to `Account{owner: facade, subaccount: pubkey}`, the same authoritative
  ledger subaccount that `pay()` reads. The current wallet display path instead reads facade `BAL_CACHE`,
  which `refresh_deposit` does not refresh, so a confirmed deposit can be spendable before it is visible;
  fixing that freshness contract is `OPEN_ISSUES.md` MC3. Mainnet canister IDs: **minter
  `mqygn-kiaaa-aaaar-qaadq-cai`**, **ledger `mxzaz-hqaaa-aaaar-qaada-cai`**
  (`docs.internetcomputer.org/references/chain-key-canister-ids/`). **No KYC step:** the mainnet
  ckBTC minter runs in GeneralAvailability mode with no KYC checker (`get_minter_info` confirms only
  automatic KYT — Know-Your-Transaction — that screens tainted UTXOs, not principals); the facade
  mints for any clean, confirmed deposit with no allowlist.
  Withdrawal is the mirror (the minter burns ckBTC and sends to the user's native BTC address); the
  facade/app path is implemented, while live real-money verification and robust uncertain-outcome
  status handling remain open.
- **ckUSDC (launch rail) — USDC on Ethereum → ckERC20.** Deposits go through the ckETH/ckERC20 minter
  using a deposit **helper contract** on Ethereum that carries the user's principal/subaccount. The
  live helper/token parameters and calldata are known, and an injected-browser-wallet submission path
  exists. It is not launch-complete until MC3/MC8 add authoritative credited-balance observation,
  chain-ID enforcement, receipt/revert handling, durable pending state, and an Android handoff.
- **SOL / ckSOL:** the building blocks (threshold Ed25519 + the SOL RPC canister) are shipped, but a
  per-principal ckSOL minter is **not confirmed** — verify status before promising a SOL deposit
  address.

**User flow (one asset):**
1. dpay asks the facade (→ minter `get_btc_address`) for the user's deposit address → shows it + QR.
2. Instructions screen: asset, network, address/QR, est. arrival time + network fee, and the honest
   line: *"This is your money at your address — we never hold it."*
3. dpay refreshes the relevant minter where applicable and reads an authoritative or explicitly fresh
   ck-asset ledger balance for the user's subaccount, surfacing **pending → credited**. The current
   facade display cache does not yet satisfy this contract for every external credit path (MC3).

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
3. **Status:** refresh the relevant minter and read an authoritative/fresh ledger balance; show
   pending → credited.
4. **Withdraw (mirror):** user authorizes the minter to burn + send to their native address.
5. **Fiat / unsupported:** embed the on-ramp with the address pre-filled.

## Interplay with offline settlement (out of scope here, noted)

Funding is orthogonal to the offline-sign → online-submit *payment* flow. Whether payments settle
directly on ckUSDC (ICRC-1/ICRC-2 with an offline-authorized transfer) or keep a thin dpay canister
layer is a **separate settlement spec**. Whatever that is, it must keep the same property: the payer's
signature is the only authority, and dpay can't move funds.

## Open items to verify (rigor — do not build on assumptions)

- ✅ **ckBTC:** resolved + implemented — minter `mqygn-kiaaa-aaaar-qaadq-cai`, ledger
  `mxzaz-hqaaa-aaaar-qaada-cai`; facade-proxy deposit surface shipped (`deposit_address` /
  `refresh_deposit` / `deposit_info` + `register_minter`). The items below remain open.
- **ckETH / ckERC20 (the ckUSDC launch rail):** the Ethereum helper-contract mechanism, live ckUSDC
  parameters, and browser transaction submission are implemented. Remaining: chain/receipt safety,
  durable pending state, Android wallet/partner handoff, authoritative credit observation, and
  token-specific runtime adapters so ckEURC or another ckERC20 is not treated as USDC.
- ckSOL / per-principal Solana deposit addresses: confirm a shipped minter, not just primitives.
- Confirmation latency + fee ranges per asset (to set honest "arrives in ~N min, ~$X fee" copy).
- Minimum deposit / dust thresholds each minter enforces.
