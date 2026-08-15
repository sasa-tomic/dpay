# Positioning — the main pitch

*This is dpay's primary go-to-market story. Lead with it in decks, demos, and marketing. Last updated 2026-08-15; asset-availability facts are dated and should be re-verified before any public promise.*

## One-liner

**Tap to pay abroad — even when your phone has no signal.** Instant payments that work offline. Pay a local merchant in seconds; your phone never needs a connection.

## Who / what

- **Who:** travelers and tourists in foreign countries, and anyone on weak or no connectivity — foreign SIM with no data, roaming switched off, or dead signal inside airports, malls, hotels, stadiums, basements, and metros.
- **What:** tap-to-pay over NFC or scan-to-pay over QR to a local merchant. One tap, done. No bank account, no card networks, no roaming.

## Why the architecture fits this user *exactly*

dpay's design lets the **payer** authorize a payment fully offline; a party that *is* online submits it and settlement finalizes in seconds. That design has one asymmetry — someone in the transaction has to reach the network.

In the tourist scenario that asymmetry disappears as a problem, because **the person without signal is precisely the payer** — the tourist — and **the merchant is the one who's online** (the local shop, cafe, hotel, or taxi has wifi/local data). So the exact thing dpay's protocol requires (an online submitter) is supplied for free by the merchant, while the exact thing dpay uniquely enables (an offline authorizer) is exactly what the tourist needs. The weakness in a generic "both people offline" story becomes the whole selling point here.

## Multi-currency: multi-**rail**, never a swap

This is the load-bearing rule, and it is a direct consequence of the non-custodial / no-swap non-negotiable (see `CLAUDE.md`). dpay can support many currencies and assets **as parallel same-asset rails**:

- The merchant's payment request **names the settlement asset** (e.g. "€12 in euros", "$8 in dollars", "0.0002 in ckBTC").
- The payer reviews and pays **that exact asset**; the canister settles **that same asset**. No conversion happens inside dpay.
- The offline flow is untouched — the signed authorization `{from, to, amount, nonce, expiry}` just carries the asset id. No change to the offline signing path.

What dpay must **never** do is bridge a mismatch — e.g. payer holds dollars, merchant wants euros, and dpay converts. That is FX / a swap / price risk, which the charter forbids dpay from doing on a user's behalf. When the payer doesn't hold the merchant's asset, the fix is an **edge conversion by a licensed third party** that the user authorizes **directly** with that partner; dpay supplies an address and shows status, and stays a screen. In practice, **USDC is the tourist lingua franca** — if the tourist holds dollars and the merchant accepts dollars, there is no conversion at all, which is the cleanest and cheapest path.

UI rule (extends the existing one): show the **currency** the user thinks in — `$`, `€`, `CHF` — never the underlying token name (ckUSDC, EURC, …).

## Speed & finality

The "seconds" promise comes from settling on the **Internet Computer**, where chain-key token transfers finalize in ~1–2s. Native layer-1 settlement can't match this — real Bitcoin mainnet blocks are ~10 minutes — so **"pay with BTC" means ckBTC on the IC**, not a mainnet Bitcoin transaction. The same holds for other assets: dpay's instant, final tap is an IC-ledger property. (SOL is the exception: it settles natively on Solana, also ~1s, via the device-key rail.)

## Asset availability & roadmap (as of 2026-07)

| Currency | Asset on IC | Status (Jul 2026) | Notes |
|----------|-------------|-------------------|-------|
| USD | ckUSDC | **Live** — primary launch rail | The default; tourist lingua franca. (ckUSDT = future ckERC20 candidate.) |
| BTC | ckBTC | **Live** | Fast & final on IC; not mainnet BTC. |
| ETH | ckETH | **Live** | Same. |
| ICP | — | **Not offered** | No ICP rail in the prod catalog (verified 2026-08-15); do not promise. |
| EUR | EURC (→ chain-key ERC-20) | **Near-term** | EURC is EMI/MiCA-licensed and the dominant euro stablecoin. Since the MiCA transitional period closed 30 Jun 2026, only licensed euro stablecoins are legal to offer in the EU — EURC qualifies. Bringing it to the IC as a ck-ERC20 is feasible; **verify ckEURC minting/liquidity before promising**. |
| SOL | native rail (device-key, direct RPC) | **Shipped in-app** | SOL + USDC-on-Solana settle natively (~1s); mainnet RPC live in the shipped APK. ckSOL-on-IC: no minter exists — not available. |
| CHF | (none on IC yet) | **Roadmap, nascent** | CHFAU (AllUnity, MiCA-compliant) launched ~Feb 2026 on Ethereum; Safirum CHF-S planned Q3 2026 on Solana; a UBS-led Swiss-bank sandbox runs on Ethereum through 2026 (institutional). No ckCHF exists; liquidity is thin. Treat CHF as "coming as issuance matures." |

## Why we win where it matters (abroad)

- **vs Apple Pay / Google Pay / Visa contactless:** their payer must be **online** at tap, and cross-border payments add FX + interchange. dpay's payer is **offline**, and same-asset settlement has **no card-network FX toll**.
- **vs other crypto wallets:** they need connectivity to broadcast, settle in minutes on L1, and surface tokens/gas. dpay authorizes offline, finalizes in seconds on the IC, and shows plain `$`/`€`.

## Honest edges (say these plainly)

- The promise is "**you** don't need signal," not "nobody needs signal." If the *merchant* is also offline (remote market, mountain hut), settlement defers until they reach the network (store-and-forward the signed authorization); the offline receipt round-trip tells the payer the outcome once it settles.
- Volatile crypto (BTC/ETH/SOL) acceptance is a **merchant opt-in** who then holds price risk; "spend crypto, merchant receives stable dollars" is a **licensed-partner edge feature**, never a dpay-native swap.
- Any cross-asset conversion, on-ramp, or off-ramp is a licensed third party the user deals with directly — keep dpay demonstrably a technical/UI layer (the same MiCA "transfer services on behalf of clients" line already flagged for the relay).

## Scope

**Shipped today (2026-08-15):** DEMO $ + mainnet ckBTC/ckUSDC/ckETH + the native SOL rail; NFC tap-to-pay + QR offline fallback; multi-currency is the product, not the roadmap. Nothing here changes the non-custodial or no-swap non-negotiables; it operationalizes them for a multi-currency world.
