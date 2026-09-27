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
| Arbitrum Sepolia (D29) | blocked on gas | `just evm-probe-sepolia` (keyless, GREEN); funded trip: `node scripts/evm-sepolia-roundtrip.mjs` (ready, BLOCKED ON GAS) | 2026-09-27 | Probe green: official RPC answers 421614, ~250ms blocks, ~0.03 gwei, dev-token env-row mechanism verified. Funded trip blocked: every no-login faucet refuses a zero-mainnet-balance address and the agent float is empty — dead-end log below. |

## EVM rail (ZCHF-first) — live facts (2026-09-27)

All numbers from `scripts/evm-float-recon.mjs` / `scripts/evm-probe-arbitrum-sepolia.mjs` runs on
2026-09-27 (read-only; every contract address re-verified on-chain during the run, not quoted from
memory).

- **Sepolia read path (D29, green):** official RPC `https://sepolia-rollup.arbitrum.io/rpc` —
  chainId 421614, 10 blocks advanced in a 2.5s window (~250ms cadence), gas 0.031 gwei (a 60k
  transfer ≈ 0.0000019 ETH). The dev-token env-row mechanism verified in BOTH directions through
  the harness relay: `DPAY_EVM_SEPOLIA_TOKEN` unset → no catalog section, served-but-unconfigured
  421614 → 503 `evm-unconfigured` naming `DPAY_EVM_RPC_URL_421614`, unserved chain → 404
  `evm-unknown-chain`; set → testnet section at exactly that address + pipe forward.
- **Funded round trip (D29):** `scripts/evm-sepolia-roundtrip.mjs` is ready (deploy or reuse
  MockZCHF, two harness-derived addresses, both transfer legs through the relay pipe, receipts +
  gas + latency + decoded Transfer logs + the getLogs range the RPC tolerates). NOT YET EXECUTED —
  blocked on faucet gas (dead-end log). Nothing to record in the way of tx hashes yet.
- **Agent float (D31 premise check, on-chain):** `0x6B1C4D33832ba8B21Fa454C1F16E332D4c1183b9`
  (m/44'/60'/0'/0/0, sops-verified against `secrets/agent-evm.pub.json`) holds ZERO everywhere:
  ETH 0 on Ethereum AND Arbitrum One, ZCHF 0 on both, nonce 0 on both — the address was never
  funded. The spec's "float key already exists with mainnet ETH" premise is false on-chain;
  staging needs a top-up before anything moves.
- **Staging swap route (verified on-chain):** NO ZCHF venue exists on Arbitrum One — Uniswap V3
  `getPool` returned zero in all 4 standard fee tiers against WETH / native USDC / USDC.e, no
  Sushi or Camelot pair, and the V4 PoolManager `0x0000…4444` has no code there. On ETHEREUM
  mainnet the Uniswap V3 **ZCHF/WETH 0.3% pool `0x79dc831d556954fbc37615a711df16b0b61df083` is
  liquid** (liquidity 3.78e21): QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` quotes a
  50-ZCHF exact-output buy at **0.02251 WETH** (≈ $60.7 at ETH $2694.85 → implied $1.21/ZCHF, on
  peg). The ZCHF/USDC pool `0x4bcb28e111b4e54bd719fdbdcb742ba4938855d0` exists but is EMPTY — do
  not route through it. SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` has code on
  both chains (same address).
- **Staging cost (2026-09-27):** mainnet gas 0.05 gwei → swap (87k) + 4 transfers (~60k each) +
  slack ≈ 367k gas ≈ 0.000019 ETH ≈ **$0.05**; dust 0.001 ETH covers 60x. Buy-and-stage on
  ETHEREUM directly beats the Arbitrum-first sketch: there is no Arbitrum ZCHF liquidity to
  bridge into, and mainnet gas is currently the same order as Arbitrum's.

## Practical routes with the current float (2026-09-26)

- IC side is nearly depleted (VCHF dust, ~CHF 0.11 in ICP): any IC round trip needs a top-up or
  an in-policy swap of held assets first.
- Solana app rail holds EURC 9.19 + USDC 0.26 + SOL 0.0017: EURC receive-side flows and small
  CeFi probes toward EURC are exercisable now within the <=CHF 2 auto-spend line.

## Dead-end log (do not re-search before last-checked + 24h)

- **2026-09-27 · Arbitrum Sepolia ETH faucets (~7 min).** Searched the official Arbitrum docs
  route, QuickNode, Alchemy, Chainlink, GetBlock, TrianglePlatform, plus the PoW-mine + canonical
  bridge path. QuickNode (`faucet.quicknode.com/arbitrum/sepolia`) is ALIVE but rejects any
  address without a "small mainnet balance" (its own page claims "no minimum mainnet balance" —
  the form disagrees); Alchemy needs an account + 0.001 mainnet ETH + mainnet activity; Chainlink
  needs a wallet connect (MetaMask/WalletConnect/Coinbase); GetBlock needs signup;
  TrianglePlatform responds "This service has been suspended"; the pk910 PoW faucet is Ethereum
  Sepolia only (+ a ~15 min bridge, out of timebox). Kicker: the agent float holds 0 ETH on
  mainnet (on-chain verified, nonce 0), so the mainnet-balance-gated faucets are unusable from
  every address we control. **Unblock:** any address with ≥0.001 ETH mainnet → QuickNode claim →
  forward on Sepolia; or a founder drip directly to the dev address.
