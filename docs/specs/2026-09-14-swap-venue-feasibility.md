# Swap venue feasibility — ICP ↔ SOL / ETH / USDC / BTC (research, 2026-09-14)

Question (founder, 2026-09-14): "Explore the feasibility of swapping currencies (non-custodial
of course) leveraging one of the existing DEX or CEX platforms. It should ideally be KYC-free,
and support ICP swap with SOL, ETH, USDC, etc."

Everything below was **measured live against mainnet on 2026-09-14** (anonymous read-only
canister queries + public HTTP APIs), not read from marketing copy. This doc is research
only — no code, no venue registrations. It slots into the existing delegated-conversion frame
(`2026-09-07-delegated-conversion-spec.md`) and the multi-venue registry
(`2026-09-08-multi-venue-readiness.md`, V1–V10 landed; V11 = Solana venue boundary).

## Hard constraints recap (why a venue passes or fails)

From CLAUDE.md + the conversion spec — non-negotiable for any *registered* dpay venue:

1. dpay never a party to the trade; no dpay key/address/canister in the funds path.
2. User's device signs every funds-moving call (ICRC-2 approve + venue call, or Solana tx).
3. **No exchange API keys ever** — holding withdrawal-capable credentials IS custody. This
   eliminates every CEX account-based integration (Binance, Kraken, etc.) outright.
4. Venue's own quote rendered verbatim, attributed, timestamped; no ranking/blending.
5. No dpay cut.
6. KYC-free *preferred*: pure on-chain AMMs/aggregators are KYC-free by construction; any
   venue that can trigger identity checks mid-flow fails the tourist story.

## Findings per venue

### ICPSwap (IC AMM, `kind: ic_amm`) — the only venue both live and already integrated-shaped

Factory `4mmnk-kiaaa-aaaag-qbllq-cai`, `getPools()` queried live. Relevant mainnet pools
(key = token0_token1_feeTier; depths from each pool's `getTokenAmountState()`, 2026-09-14):

| pair | pool canister | live depth (raw side readings) |
|---|---|---|
| ICP↔VCHF | `65mrh-fqaaa-aaaar-qapoa-cai` (shipped PoC pool) | 229,277 VCHF / 83,978 ICP |
| ICP↔ckUSDC | `mohjv-bqaaa-aaaag-qjyia-cai` | 9,236 ICP / 392,105 ckUSDC (6 dec) |
| ICP↔ckETH | `angxa-baaaa-aaaag-qcvnq-cai` | 11,312 ICP / 51.63 ckETH |
| ICP↔ckBTC | `xmiu5-jqaaa-aaaag-qbz7q-cai` | 34,642 ICP / 0.562 ckBTC |

- Same factory, same `depositFromAndSwap` shape, same ICRC-2 approve flow the PoC already
  exercises. Registering any of these = a `venues[]` row in `dfx/catalog_truth.json` +
  disclosure copy + fake-IC fixture — **zero new architecture** (V11 explicitly says venue
  onboarding is its own surface, not a gap).
- ckUSDC/ckETH pools have real tourist-scale depth; the ckBTC pool's BTC side (0.56 BTC) is
  thin — disclose, let the venue's own quote speak, as with the saturated VCHF↔ckUSDC pool
  already refused in the PoC UI.

### dpay's already-shipped burn-withdraw turns IC-side assets into native ETH/USDC

`cketh.ts` burn/withdraw ckETH→native ETH and ckUSDC(ckERC20)→ERC20 is BUILT and
live-proven (Sepolia round-trip). Therefore, with only ICPSwap pool registrations:

- **ICP→USDC(Ethereum)**: ICP→ckUSDC on ICPSwap (device-signed), then existing
  burn-withdraw (device-signed) → USDC at the user's own ETH address. Two legs, both
  already-supported transaction types, one new venue row.
- **ICP→ETH**: ICP→ckETH on ICPSwap, then existing burn-withdraw. Same shape.
- The reverse direction (ETH/USDC→ICP) is the already-supported ckERC20 deposit + swap.
  Multi-leg conversions are explicitly a PoC non-goal, but *sequenced* user-driven legs
  (Convert → Withdraw) need no new machinery.

### Solana — no non-custodial ICP↔SOL path exists today

- **ckSOL**: the official `dfinity/cksol` repo's mainnet canisters
  (`ljyxk-riaaa-aaaar-qb5mq-cai` minter, `la34w-haaaa-aaaar-qb5na-cai` ledger) exist and
  respond, but the ledger's own `icrc1_metadata` reports name/symbol **"ckDevnetSOL"** —
  this is the devnet variant; repo README says "under active development". No production
  mainnet ckSOL. When it lands: ICP↔ckSOL pool on an IC AMM + a SOL burn-withdraw leg
  exactly parallels the ckETH pattern — the architecture is already ready for it.
- **Jupiter (Solana aggregator)**: live check `GET lite-api.jup.ag/swap/v1/quote` (keyless):
  1 SOL→10.36 USDC, price impact 0.003%, `platformFee: null` (no integrator fee — fits the
  no-dpay-cut rule), slippage honored. KYC-free, non-custodial, user device signs. This is
  the venue V11 named for the Solana rail — registering it (`kind: solana_amm` or similar
  new enum value) is what un-gates Convert for `protocol === 'solana'`. It does **not**
  give ICP↔SOL (different chain, no ICP listing).
- **THORChain**: KYC-free cross-chain DEX — BTC/ETH/XRP/BNB/SOL/TRON/DOGE/BCH/LTC, **no
  ICP**. Only relevant as a future ETH↔SOL leg inside a multi-hop, which the spec defers.
- **Chainflip**: BTC/ETH/SOL/POL — **no ICP**. Same status.

### KongSwap — measured dead, reject

The venue Oisy integrated (backend `2ipq2-uqaaa-aaaar-qailq-cai`, the id in Oisy's
`dfx.json` remote): `tokens()` still lists 132 IC tokens, but `pools()` returns
`(variant { Ok = vec {} })` — **zero pools, drained**. `kongswap.io` and all subdomains
return Cloudflare 530/1016 (origin gone). CoinGecko shows ~$2.44 24h volume on KONG.
Its 2025 "bridgeless native BTC/ETH/SOL" marketing was real (Chain-Fusion) but there is
no usable venue there today. SNS DAO still exists on-paper
(`ormnc-tiaaa-aaaaq-aadyq-cai`). Do not build against it; revisit only if it demonstrably
relaunches.

### KYC-light instant exchangers (ChangeNOW, SimpleSwap, etc.) — custodial mid-trade

They list ICP↔SOL/ETH with no signup, but funds transit an exchange-controlled address and
KYC can be triggered by their risk engine. Under constraint 3's spirit (no dpay-held creds)
they could only ever appear as a *user-directed external handoff* (user opens their site
themselves, like any browser link) — **not** as a registered quote venue in dpay's
multi-venue list. Recommend: out of scope for the Convert screen.

## Feasibility matrix (asked pairs)

| pair | verdict | path |
|---|---|---|
| ICP↔USDC | **Feasible now** | ICPSwap ICP↔ckUSDC pool (live, deep) [+ existing burn-withdraw if native-ETH USDC wanted] |
| ICP↔ETH | **Feasible now** | ICPSwap ICP↔ckETH + existing ckETH burn-withdraw (both legs shipped surfaces) |
| ICP↔BTC | Feasible, thin | ICPSwap ICP↔ckBTC pool live but 0.56 BTC side — quote verbatim + disclose |
| ICP↔SOL | **Not yet, non-custodially** | No venue lists ICP with native SOL. Real paths: (a) mainnet ckSOL lands → IC AMM + SOL burn-withdraw (architecture ready); (b) multi-hop ICP→ckETH→ETH→SOL via THORChain/Chainflip (multi-hop is a spec non-goal today); (c) CeFi handoff (custodial, out of scope). Watch `dfinity/cksol`. |
| ICP↔VCHF | Shipped | the live PoC |
| SOL↔USDC (rail-local) | Feasible when Solana venue registered | Jupiter (V11's named venue), keyless API, no platform fee |

All DEX paths above are KYC-free by construction; no CEX passes the no-API-keys rule as a
registered venue.

## Recommended unblocked next steps (in work-order terms)

1. Register ICPSwap `ICP↔ckUSDC` and `ICP↔ckETH` as additional pair-scoped venues
   (`dfx/catalog_truth.json` rows + disclosure copy + fake-IC fixtures; probe pins like
   `just swap-venue-probe` extended per pool). Pure onboarding; V1–V10 machinery applies
   as-is (N-venue chooser, quote verbatim, recovery engine).
2. Keep the ckBTC pool out until depth improves, or register with the same honest-depth
   refusal the saturated VCHF↔ckUSDC pool got.
3. Jupiter stays the named candidate for the first `kind: solana_*` venue (V11) when the
   SOL Convert surface is prioritized — its keyless, fee-less, slippage-honest API fits
   every invariant tested in V9.
4. ckSOL: no action possible until the mainnet (non-devnet) minter/ledger deploy; re-run
   this probe (`icrc1_name` on the ledger) when the repo announces launch.
5. KongSwap: rejected with evidence above; do not revisit without a live pools() reading.

Regulatory posture is unchanged: officials/counsel confirmation of the delegated-conversion
frame remains founder-owned (spec §After PoC) — this research adds venues inside that same
frame, it does not alter it.
