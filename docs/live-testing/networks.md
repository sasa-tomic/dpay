# Testnet vs mainnet: per rail and venue

Dates gate the free-path search: if a row's last-checked date is less than 24h old, skip the
search; otherwise at most 10 minutes, then record the outcome here.

| Rail / venue | Free test path? | Cheapest live probe | Last checked | Notes |
|---|---|---|---|---|
| ICP ledger | none useful | ICP transfer (fee 0.0001 ICP) | 2026-09-26 | IC testnets exist but carry no ICRC venue liquidity; dpay's catalog is mainnet-only. Design-time knowledge, full search not yet run. |
| VCHF (ICRC) | none | swap ICP to VCHF on ICPSwap, smallest amount | 2026-09-26 | Mainnet-only token, no faucet. Design-time knowledge. |
| ckUSDC / ckBTC / ckETH | none | smallest ICPSwap swap | 2026-09-26 | No free path in the dpay catalog. Design-time knowledge. |
| ICPSwap (IC DEX) | none | smallest pool swap (icrc2 approve + swap) | 2026-09-26 | Mainnet-only DEX. Design-time knowledge. |
| Solana devnet | partial | SOL faucet; devnet USDC via Circle faucet | 2026-09-26 | EURC is not issued on devnet; Jupiter devnet is limited; dpay venues do not run devnet. Design-time knowledge. |
| EURC (Solana) | none | receive-side exercises are free with an existing EURC balance (float holds some) | 2026-09-26 | Circle issues EURC mainnet-only. Design-time knowledge. |
| Trocador (CeFi) | none | smallest supported order (venue minimum, roughly $5-20) | 2026-09-26 | Mainnet-only; partner API terms (poll floor) apply. Design-time knowledge. |
| SideShift (CeFi) | none | smallest supported order | 2026-09-26 | Mainnet-only; exact-amount deposit windows. Design-time knowledge. |
| ZCHF (ERC-20) reads | yes (keyless, free) | `just evm-probe-mainnet` — symbol/decimals/DOMAIN_SEPARATOR on publicnode + arb1 | 2026-09-27 | READ path free and proven. WRITES (a real transfer round trip) are mainnet-only: gas is dust ETH, no ZCHF faucet on either chain. |
| Arbitrum Sepolia (D29) | unverified | claim a faucet, run the round trip in `scripts/evm-probe-arbitrum-sepolia.mjs` (NOT YET WRITTEN) | 2026-09-27 | Not searched yet (no script, no need while no live trip is scheduled). Write the probe before any Sepolia attempt. |

## Practical routes with the current float (2026-09-26)

- IC side is nearly depleted (VCHF dust, ~CHF 0.11 in ICP): any IC round trip needs a top-up or
  an in-policy swap of held assets first.
- Solana app rail holds EURC 9.19 + USDC 0.26 + SOL 0.0017: EURC receive-side flows and small
  CeFi probes toward EURC are exercisable now within the <=CHF 2 auto-spend line.

## Dead-end log (do not re-search before last-checked + 24h)

(None yet. Each entry: date, venue/network, what was searched, outcome, search duration.)
