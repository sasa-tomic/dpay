# Positioning — the main pitch

*This is dpay's primary go-to-market story. Lead with it in decks, demos, and marketing. Last updated 2026-09-06; every asset-availability fact carries the date it was last measured, and anything older than the current session is re-verified before it goes into a public promise.*

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

### Roadmap, not built: conversion the user authorizes, delegated and itemised

**Direction LANDED 2026-09-07 (founder): dpay will NOT be an exchange; it WILL integrate existing
DeFi and CeFi venues so the user can convert quickly — delegated (the user's own device signs
with the venue, dpay never a party), itemised, and recipient/merchant-side first (converting
proceeds already settled to the merchant's own account, where being online and choosing accepted
currencies already live). Aligned with the precedents that won (no custody, user sole
decision-maker, venue's own attributed quote, no routing discretion, no dpay cut). A
compliant-by-construction PoC — ICPSwap ICP↔VCHF, user-device-signed — is specced:
`docs/specs/2026-09-07-delegated-conversion-spec.md`; once it exists, the founder asks the
officials to confirm the shape. Until the PoC is verified and the answers land, this subsection
stays in roadmap verbs and must never be quoted in the present tense.**

dpay will offer conversion between assets, with the exchange itself performed by a third party or an on-chain protocol — a licensed provider the user authorizes directly, or a pool contract the user's own device signs into. That is the same shape this section already describes for a payer who lacks the merchant's asset — the difference is that it becomes a deliberate feature with its own screen instead of an edge case. The frame does not move and is not re-opened here: dpay will not exchange one asset for another on a user's behalf, will not hold the funds while it happens, and will not take price risk (`CLAUDE.md`). What is on the table is the **screen**: dpay showing the venue's offer (provider or pool), and the user authorizing that venue directly.

**"Transparent for the user" is the whole feature, so it has to be checkable.** Before the user authorizes anything, the screen would have to name — in their own language, on one surface, without a tap to reveal it:

- **Who the counterparty is:** the provider's legal name, and that they, not dpay, perform the exchange and owe the user the result.
- **The rate**, as a number the user can compare, with its source and the instant it was quoted.
- **Every fee, separately:** the provider's spread or commission, the network fee on each leg, and whether dpay is paid anything for this — and if so, how much.
- **What the user ends up with**, in the destination asset, after all of the above.
- **What happens if it fails:** which asset they are left holding, and who to contact, because dpay will not be able to reverse it.

A screen that shows one blended "you get X" and hides the split is not transparent, however accurate X is.

**Decision status after the 2026-09-07 direction** (regulatory evidence: `docs/REGULATORY.md`; the
answers below are PoC-scoped and conservative — product-final stays open until the officials/counsel
step answers them):

1. **Quote, or only relay the provider's quote.** Displaying a rate at all is near the line that turns a wallet into a broker. **PoC: relay the venue's own quote verbatim, attributed + timestamped; dpay computing or blending one stays refused.**
2. **Pick the provider, or let the user pick.** Picking is routing, and routing is the clause with legal weight (`monetization.md`). **PoC: exactly one venue per pair, so no routing surface exists at all; when a second venue arrives, the user picks — never dpay.**
3. **Take a cut, or not** — already open in `monetization.md`. **PoC: none, and the screen says so explicitly.**
4. **Where the funds sit mid-swap.** The only acceptable answer is "never with dpay" — **taken, and it was never open.** A provider integration that requires depositing to an address dpay controls is refused, not negotiated — that is custody by another name. For a DeFi venue, the pool transiently pulls via the user's own ICRC-2 approval — disclosed on screen as temporary pool custody with recovery risk.

**Prep needed now: the PoC (2026-09-07).** The wallet is already asset-first — the merchant names the settlement asset, the payer pays that exact asset, nothing converts implicitly — so the conversion surface is additive rather than a rework, and the direction is decided enough to build the conservative shape without YAGNI risk. The property that makes any of this possible stays absolute: dpay remains a screen, never a counterparty. "Hands-off" means one tap for the user — never unattended automation, which stays out until the officials/counsel step answers for it.

**The risk to name honestly:** an embedded flow smooth enough to feel like "dpay converted my money" may be judged on that substance rather than on the contract behind it — the same activity test already flagged for the relay under MiCA. Disclosure is the mitigation, which is why it is the requirement and not the polish.

## Speed & finality

The "seconds" promise comes from settling on the **Internet Computer**, where chain-key token transfers finalize in ~1–2s. Native layer-1 settlement can't match this — real Bitcoin mainnet blocks are ~10 minutes — so **"pay with BTC" means ckBTC on the IC**, not a mainnet Bitcoin transaction. The same holds for other assets: dpay's instant, final tap is an IC-ledger property. (SOL is the exception: it settles natively on Solana, also ~1s, via the device-key rail.)

## Asset availability & roadmap

IC rows re-measured against the production catalog (`GET https://dpay.kalaj.org/api/v1/currencies`)
on 2026-09-04. The EUR and CHF rows were re-measured the same day against the ledgers and mints
themselves, replacing 2026-07 desk research that had both wrong. The EUR dual-rail rows (VEUR@IC,
EURC@Solana) were re-measured 2026-09-06, the day both were catalogued.

A currency may name **more than one rail** (founder decision 2026-09-04). Which rail dpay should
put a user on, and the measured liquidity and ramp evidence behind that choice, is
`docs/specs/2026-09-04-currency-first-wallet-plan.md` — not restated here.

| Currency | Rail(s) | Status | Notes |
|----------|---------|--------|-------|
| USD | ckUSDC | **Live** — primary launch rail | The default; tourist lingua franca. (ckUSDT = future ckERC20 candidate.) |
| BTC | ckBTC | **Live** | Fast & final on IC; not mainnet BTC. |
| ETH | ckETH | **Live** | Same. |
| ICP | native ICP | **Live** — payable, no fiat ramp | Catalog id 8, ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`. In and out by ordinary ICRC-1 transfer from any Internet Computer wallet; no ramp to francs or dollars. |
| EUR | EURC on **Solana** (deep) · VEUR on the **IC** (thin) | **Built in-app 2026-09-06 — not yet live** (relay serves the rows after the founder deploy; `OPEN_ISSUES.md`) | Founder decision 2026-09-06: EUR spans **both** rails, superseding 2026-09-04's EURC-only call. **EURC@Solana:** Circle-issued, EMI/MiCA-licensed, the dominant euro stablecoin, ~105M circulating — catalogued liquidity `deep`. Circle's mint carries a non-null freeze authority — the same issuer-risk class as every Circle token; named here as prose deliberately, NOT as a UI con line, because cons must be machine-checkable from catalog fields and the catalog has no freeze-authority field. **VEUR@IC:** the VNX Euro ledger (`wu6g4-6qaaa-aaaan-qmrza-cai`, 8dec, fee 0.0001 VEUR), catalogued `thin` — on-chain supply is a verified stub (~1.5 VEUR) — and **sell-only via DFX** (the catalog's first Partner off-ramp, `ramp_partner:"DFX"`; no compliant on-ramp). VEUR is VNX-issued — the same issuer and minter principal as VCHF — so the CHF row's issuer-risk rule below applies verbatim; the `thin` tier must be **re-checked against the live ledger whenever the rail is touched** (the tier is catalog data, not a measurement). The rejected IC alternative stays rejected: ckEURC (`pe5t5-diaaa-aaaar-qahwa-cai`) is deployed but empty (53.99 tokens, no venue), and the earlier "bring EURC to the IC as a ck-ERC20" line remains withdrawn. MiCA/issuer-licensing due diligence on both issuers is founder-owned. |
| SOL | native rail (device-key, direct RPC) | **Shipped in-app** | SOL + USDC-on-Solana settle natively (~1s); mainnet RPC live in the shipped APK. ckSOL-on-IC: no minter exists — not available. |
| CHF | VCHF on the IC (**live**) · VCHF on **Solana** (planned, not built) | **Live on the IC** — payable, no fiat ramp in-app | IC: catalog id 7, ledger `ly36x-wiaaa-aaaai-aqj7q-cai`; a funded VCHF payment was made on a physical device with real funds on 2026-09-01. Solana: the same issuer's token on a second rail, with materially more float and depth — measured in the spec. **Both rails carry the same issuer risk and it must be said whenever VCHF is named:** a franc-denominated token issued by a third party, **not** chain-key-backed, its peg the issuer's claim and not something dpay verifies. Measured 2026-09-04: the VCHF ledgers are controlled by ordinary company keys rather than NNS Root (unlike ckUSDC), the Solana mint holds both mint and freeze authority, and no independent reserve attestation was found — so never write "audited" or "attested" about VCHF. CHF **can** be bought as VCHF on the IC by bank transfer from a licensed Swiss provider (DFX.swiss); there is no card route to it anywhere. Still no **ckCHF** — chain-key CHF does not exist; the wider issuance picture: CHFAU (AllUnity) on Ethereum ~Feb 2026, Safirum CHF-S planned Q3 2026 on Solana, a UBS-led Swiss-bank sandbox on Ethereum through 2026 (institutional). |

## Why we win where it matters (abroad)

- **vs Apple Pay / Google Pay / Visa contactless:** their payer must be **online** at tap, and cross-border payments add FX + interchange. dpay's payer is **offline**, and same-asset settlement has **no card-network FX toll**.
- **vs other crypto wallets:** they need connectivity to broadcast, settle in minutes on L1, and surface tokens/gas. dpay authorizes offline, finalizes in seconds on the IC, and shows plain `$`/`€`.

## Honest edges (say these plainly)

- The promise is "**you** don't need signal," not "nobody needs signal." If the *merchant* is also offline (remote market, mountain hut), settlement defers until they reach the network (store-and-forward the signed authorization); the offline receipt round-trip tells the payer the outcome once it settles.
- Volatile crypto (BTC/ETH/SOL) acceptance is a **merchant opt-in** who then holds price risk; "spend crypto, merchant receives stable dollars" is a **licensed-partner edge feature**, never a dpay-native swap.
- Any cross-asset conversion, on-ramp, or off-ramp is a third party or on-chain protocol the user authorizes directly — never dpay. Keep dpay demonstrably a technical/UI layer (`docs/REGULATORY.md`); the conversion screen's whole job is to make that demonstrable.

## Scope

**Shipped today:** DEMO $ + mainnet ckBTC/ckUSDC/ckETH + VCHF + native ICP + the native SOL rail; NFC tap-to-pay + QR offline fallback; multi-currency is the product, not the roadmap. Nothing here changes the non-custodial or no-swap non-negotiables; it operationalizes them for a multi-currency world.

**Built 2026-09-04, not yet live — the merchant side.** dpay's relay can *be* an OpenCryptoPay provider: a shop rings a price up in francs on its own phone and is paid VCHF at its own account, with no licence, no bank, no signup and no POS hardware. Two things go with that sentence every time it is used.

- **It ships on by default since 2026-09-10** (`DPAY_ENABLE_TILL=false` is the operator opt-out). Production deployment state: `OPEN_ISSUES.md`.
- **Only a dpay wallet can pay it.** No wallet on the standard's own compatibility list settles any Internet Computer asset — measured twice against the provider's own list — so serving the standard is future-proofing, not distribution, and third-party wallet reach must never appear in a deck, a demo script, a video or an investor email.

The asymmetry underneath it is worth stating exactly, because it is where dpay beats the standard it conforms to: **a dpay payer can be offline** over NFC or QR, and **an OpenCryptoPay payer cannot** — that standard makes its payer fetch the quote, fetch the destination and report the proof over https.
