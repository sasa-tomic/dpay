# VCHF multichain verification (2026-09-30)

**Status:** verification-only research note (no rails added). Verifies the founder claim
"we also have VCHF on ICP, ETH, SOL" and settles the mechanism question, so a future
`CURRENCY_RAILS.CHF` ETH/SOL addition is decided on evidence: ROUTING (same asset moving
chains) versus EXCHANGE (a swap between different assets). Companion evidence already in
this repo: `docs/VCHF_ICP_ANALYSIS.md` (live mainnet `dfx` probes of the ICP ledger).

## Verdict table

| Chain | Canonical address | Standard / decimals | Bridge | Evidence |
|---|---|---|---|---|
| ICP | `ly36x-wiaaa-aaaai-aqj7q-cai` | ICRC-2 / 8 | issuer (VNX-ledger native) | VNX registry [1]; dpay `dfx/catalog_truth.json` pin; Oisy env pin [2]; ICP dashboard titles it "VCHF Ledger Canister" [3]; live `dfx icrc1_metadata` probes in `docs/VCHF_ICP_ANALYSIS.md` |
| Ethereum | `0x79d4f0232A66c4c91b89c76362016A1707CFBF4f` | ERC-20 / 18 | issuer burn/mint | VNX registry [1]; Blockscout token read: "VNX Swiss Franc", VCHF, 18dp [4]; Etherscan token page at the same address [5] |
| Solana | `AhhdRu5YZdjVkKR3wbnUDaymVQL2ucjMQ63sZ3LFHsch` | SPL Token Program / 9 | issuer burn/mint | VNX registry [1]; Solana mainnet RPC `getAccountInfo`: owned by `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, mint + freeze authority `51b5UJs8hyyDunrZMWL6ACDXY8FQc1hLLA3M54UksxaY` [6]; Jupiter metadata: "VNX Swiss Franc" [7] |
| Base | `0x1fca74d9ef54a6ac80ffe7d3b14e76c4330fd5d8` | ERC-20 / 18 | issuer burn/mint | VNX registry [1]; Blockscout Base: "VNX Franc", VCHF, 18dp [8]; Basescan token page [9] |
| Celo | `0xc5ebea9984c485ec5d58ca5a2d376620d93af871` | ERC-20 / 18 | issuer burn/mint | VNX registry [1]; Blockscout Celo: "VNX Franc", VCHF, 18dp [10] |
| Stellar | issuer `GDXLSLCOPPHTWOQXLLKSVN4VN3G67WD2ENU7UMVAROEYVJLSPSEWXIZN`, code `VCHF` | Stellar issued asset / 7 | issuer burn/mint | VNX registry [1]; Horizon API asset record live (138 accounts) [11] |
| Tezos | `KT1LssxZqfQtRFv1CRkzX9E9gzap9iFrtWmq` | FA1.2 | issuer burn/mint (per registry) | VNX registry only [1] - UNVERIFIED beyond registry (no explorer check run; a TzKT contract page would settle it) |

Registry: [1] https://vnx.gitbook.io/vnx-global/transparency/standards-and-contracts.md (VNX's
self-declared "authoritative contract-address registry ... verify here before transacting").
Oisy pins: [2] `third_party/oisy-wallet/src/frontend/src/env/tokens/tokens.icrc.json` (ledger +
index `4cx56-naaaa-aaaai-aqkaa-cai` + mintingAccount `6csfo-tvgcf-7i47c-4ohs3-tdxbt-wr3dw-bstba-koumv-oiwcb-jnfu3-nqe`,
shared with VEUR, and the `isVCHFToken` exact-ledger guard in `src/icp-eth/utils/token.utils.ts`).
Dashboard: [3] https://dashboard.internetcomputer.org/canister/ly36x-wiaaa-aaaai-aqj7q-cai
(controllers: canister `cpbhu-5iaaa-aaaad-aalta-cai` + two opaque principals).
[4] https://eth.blockscout.com/api/v2/tokens/0x79d4f0232A66c4c91b89c76362016A1707CFBF4f
[5] https://etherscan.io/token/0x79d4f0232a66c4c91b89c76362016a1707cfbf4f
[6] Solana mainnet JSON-RPC, `getAccountInfo` on the mint (run 2026-09-30).
[7] https://lite-api.jup.ag/tokens/v2/search?query=AhhdRu5YZdjVkKR3wbnUDaymVQL2ucjMQ63sZ3LFHsch
[8] https://base.blockscout.com/api/v2/tokens/0x1fca74d9ef54a6ac80ffe7d3b14e76c4330fd5d8
[9] https://basescan.org/address/0x1fca74d9ef54a6ac80ffe7d3b14e76c4330fd5d8
[10] https://celo.blockscout.com/api/v2/tokens/0xc5ebea9984c485ec5d58ca5a2d376620d93af871
[11] https://horizon.stellar.org/assets?asset_code=VCHF&asset_issuer=GDXLSLCOPPHTWOQXLLKSVN4VN3G67WD2ENU7UMVAROEYVJLSPSEWXIZN

## Mechanism verdict: ISSUER burn/mint bridge, not a third-party bridge

Primary sources:

- VNX Bridge product page: "VNX Bridge is operated by VNX as the token issuer: we burn the token
  on the source chain and mint a fresh, native unit on the destination. ... no wrapped IOUs, no
  third-party liquidity." Claims 0 bps bridge fee, median 12-30s, 2-of-3 multisig mint
  authorisation with sanctions/Travel-Rule screening.
  https://vnx.io/bridge
- VNX GitBook Bridge page (institutional, stricter wording): "The Bridge uses a burn-and-mint
  model ... No wrapped or synthetic representation is created, and total supply across all chains
  is unchanged"; "you always hold canonical VCHF ... never a wrapped or IOU version; the token
  minted on the destination chain is the same contract integrators already use"; "Supported
  bridge routes track the chains on which each token is live". Also states: "Bridge fees are not
  yet published" (in tension with the 0 bps marketing claim; pricing is unsettled).
  https://vnx.gitbook.io/vnx-global/institutional/products/bridge.md
- VNX GitBook stablecoins page: "VCHF and VGBP are the same logical asset"; one segregated fiat
  reserve behind every deployment; token standards per chain family (OpenZeppelin ERC-20 / SPL /
  Stellar issued asset / ICRC). https://vnx.gitbook.io/vnx-global/institutional/products/stablecoins.md
- VNX API: `mintTokens(asset, blockchain, ...)` and `burnTokens(asset, ...)` are
  chain-parameterized issuer operations. https://docs.vnx.io/

Secondary (consistent, not load-bearing):

- Zerion's Solana stablecoin guide describes VNX coins as "burned at the source and minted at the
  destination". https://zerion.io/blog/solana-stablecoins-the-complete-guide/
- Dune dashboard: "VCHF is deployed on 7 blockchains: Ethereum, Solana, Base, Stellar, Tezos,
  Internet Computer, Celo". https://dune.com/vnx/vnx-stablecoins

No third-party bridge (Across, Wormhole, deBridge, etc.) appears in any VNX source. The mint
authority on every chain is VNX's own (ICP: the ledger's controllers + pinned minting account;
Solana: mint authority `51b5UJs8...` per [6], VNX ownership attested by the registry; EVM:
registry-issued OpenZeppelin contracts).

## ROUTING versus EXCHANGE

**Semantically this is ROUTING.** The official registry and bridge docs define VCHF on each chain
as the same logical asset (same reserve, same redemption right, canonical on every chain, never a
wrapped derivative). Moving VCHF ICP to ETH is relocating the user's own holding between chains,
exactly like dpay's USD story treats ckUSDC (IC) and USDC (SOL) as rails of one currency.
`CURRENCY_RAILS.CHF` growing ETH/SOL entries is therefore justified in kind, mirroring
`USD: ['ckUSDC', 'USDC']` (`app/config/currency.ts`).

**Mechanically it is issuer-mediated, not permissionless.** The only chain-moving mechanism is
VNX's own bridge: it runs through the VNX platform (login, AML/sanctions/Travel-Rule screening,
multisig mint authorisation), it is not an on-chain lock/unlock contract pair, and dpay cannot
execute it inside the wallet or atomically. So:

- Adding VCHF-on-ETH / VCHF-on-SOL catalog rows + `CURRENCY_RAILS.CHF` entries is a clean,
  evidence-backed ROUTING decision: each row is the same currency on another rail; the user picks
  which chain they hold CHF on, as they already do for USD.
- Chain-MOVING itself stays OUTSIDE dpay's transfer path today. A user moves VCHF across chains
  by withdrawing/depositing through VNX (bridge, mint account, or on/off-ramp); dpay's in-app
  convert between VCHF rails would be a DEX/venue operation (exchange-like), not the bridge.
- Do NOT model the VNX bridge as dpay's CCTP-style cross-rail route: it is account-gated,
  compliance-screened, fee-unpublished, and platform-mediated. If in-app chain-moving is ever
  wanted, the honest near-term path is CeFi/venue legs (already the `composed` convert shape),
  not a mint-authority integration dpay does not have.

## Founder claim check

- "VCHF on ICP, ETH, SOL": CONFIRMED on all three, with addresses above.
- Left out: Base, Celo, Stellar, Tezos (7 chains total per the registry and Dune). The marketing
  "deployed across 13+ chains" figure on https://vnx.io/defi-access counts all three VNX tokens
  (VCHF, VGBP, VNXAU) and includes VNXAU-only Etherlink.
- Not found anywhere in VNX materials: Arbitrum, Avalanche, or a "Q chain" deployment (searched
  2026-09-30). If those names are in circulation, VNX's own chain map does not back them.
- Minor registry inconsistencies (cosmetic): the stablecoins page prose says "VCHF on 6 chains"
  while its own table says 7; the standards page use-case text says "VCHF (6 chains)" while its
  table says "deployed on 7 chains". The address tables are consistent and are the load-bearing
  part. ERC-20 token name differs by chain ("VNX Swiss Franc" on Ethereum vs "VNX Franc" on
  Base/Celo); symbol is `VCHF` everywhere.

## Decimals trap

The same asset carries different precision per chain: ICP 8 (dpay's own `dfx` probes,
`docs/VCHF_ICP_ANALYSIS.md`), EVM 18 (Blockscout [4][8][10]), SPL 9 (RPC [6], Jupiter [7]).
Any future multi-rail VCHF code must normalize by rail (same lesson as the EVM uint256 width
note in `CODEBASE_ANALYSIS.md`); ICP 8dp raw figures must never cross an 18dp or 9dp boundary
unconverted.

## Recommendations if dpay acts on this

1. Pin the exact per-chain addresses in `dfx/catalog_truth.json`-style truth before any catalog
   row exists (precedent: Oisy's `isVCHFToken` exact-ledger guard, and the registry's own
   "verify here before transacting" instruction). EVM addresses above are checksummed.
2. Grow `CURRENCY_RAILS.CHF` the way USD models it; rail identity stays `tokenEq` on the asset's
   `linkToken`, so new rows need no new resolver logic (the file's own comment anticipates
   "a new rail row (EURC, VCHF on Solana)").
3. Treat ICP-to-ETH/SOL VCHF movement as an external, user-driven VNX-platform operation for
   now; document it as such rather than building a bridge UI.
4. Liquidity caveat: observed per-chain supplies are thin (ETH ~26.1k, Base ~528.5k, Celo ~13.6k,
   SOL ~950.4k, raw units converted from [4][6][8][10]; DefiLlama total ~$2.56m,
   https://defillama.com/stablecoins). Solana is the deepest non-ICP VCHF rail (Raydium/Orca/
   Meteora pools per https://vnx.io/defi-access); Ethereum is small. Rail order should reflect that.

## UNVERIFIED (and what would settle each)

- Tezos `KT1LssxZqfQtRFv1CRkzX9E9gzap9iFrtWmq`: registry-only. Settle with a TzKT contract page
  showing FA1.2 + `VCHF` metadata.
- The role of ICP controller canister `cpbhu-5iaaa-aaaad-aalta-cai` (unnamed on the dashboard;
  plausibly VNX's ops/minter canister). Settle with `dfx canister status` + candid read, or VNX
  docs naming it.
- Whether VNX's Bridge UI/API explicitly lists ICP as a source/destination chain: the bridge page
  names Ethereum, Solana, Stellar "and partner chains"; the chain map includes ICP; the GitBook
  says routes track live deployments. Almost certainly covered, but no page names ICP as a bridge
  endpoint. Settle by exercising the bridge UI or asking VNX.
- Bridge fee schedule (0 bps marketing vs "not yet published" GitBook).
- On-chain attribution of Solana mint authority `51b5UJs8hyyDunrZMWL6ACDXY8FQc1hLLA3M54UksxaY`
  to VNX as an entity (registry attests it; an on-chain link would need a VNX-signed statement
  or a known VNX funding graph).
