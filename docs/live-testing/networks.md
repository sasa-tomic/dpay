# Testnet vs mainnet: per rail and venue

Dates gate the free-path search: if a row's last-checked date is less than 24h old, skip the
search; otherwise at most 10 minutes, then record the outcome here.

| Rail / venue | Free test path? | Cheapest live probe | Last checked | Notes |
|---|---|---|---|---|
| ICP ledger | none useful | ICP transfer (fee 0.0001 ICP) | 2026-09-26 | IC testnets exist but carry no ICRC venue liquidity; dpay's catalog is mainnet-only. Design-time knowledge, full search not yet run. |
| VCHF (ICRC) | none | swap ICP to VCHF on ICPSwap, smallest amount | 2026-09-27 | Mainnet-only token, no faucet. LIVE-PROVEN 2026-09-27: 0.01 ICP -> 0.02562143 VCHF via the app (see dead-end log for the trip record). |
| ckUSDC / ckBTC / ckETH | none | smallest ICPSwap swap | 2026-09-26 | No free path in the dpay catalog. Design-time knowledge. |
| ICPSwap (IC DEX) | none | smallest pool swap (icrc2 approve + swap) | 2026-09-27 | Mainnet-only DEX. LIVE-PROVEN 2026-09-27: pool 65mrh-…-cai executed icrc2_approve + depositFromAndSwap from the app; quoted 2.57 VCHF/ICP verbatim; settled in seconds; fees exactly the two 0.0001 ICP census lines. |
| Jupiter (Solana) | none | smallest quote (free, read-only) through the relay proxy; smallest swap (Solana tx fee 0.000005 SOL) | 2026-09-27 | Quotes live + verbatim through /api/v1/jupiter/quote. Execution was BLOCKED by venue drift (asLegacyTransaction 400, see dead-end log) — RESOLVED by uix 145ec40; LIVE-PROVEN 2026-09-27: 0.5 EURC -> 0.569229 USDC through jupiter-usdc-eurc, one broadcast, fee exactly 0.000005 SOL, no priority fee. |
| Solana devnet | partial | SOL faucet; devnet USDC via Circle faucet | 2026-09-26 | EURC is not issued on devnet; Jupiter devnet is limited; dpay venues do not run devnet. Design-time knowledge. |
| EURC (Solana) | none | receive-side exercises are free with an existing EURC balance (float holds some) | 2026-09-27 | Circle issues EURC mainnet-only. Float rail measured 9.198416 EURC 2026-09-27; app derivation re-proven (in-app derived rail shows the exact float balances). |
| Trocador (CeFi) | none | smallest supported order (venue minimum, roughly $5-20) | 2026-09-26 | Mainnet-only; partner API terms (poll floor) apply; relay holds no DPAY_TROCADOR_API_KEY yet (routes 503). Design-time knowledge. |
| SideShift (CeFi) | none | smallest supported order | 2026-09-27 | Mainnet-only; exact-amount deposit windows. Prod relay holds NO partner credential — the app's 503 tripwire copy confirmed live 2026-09-27 ("SideShift is not set up on this relay yet… Nothing is wrong with your wallet."). Round trips need the founder key first. |

## Practical routes with the current float (2026-09-27)

- IC side (after the 2026-09-27 trip): ICP 0.005 + VCHF 0.0257 + ckETH dust. Tiny IC probes
  still possible; anything CeFi- or Ethereum-sized needs a top-up (above the <=CHF 2 line).
- Solana app rail (after the 2026-09-27 trip 2): EURC 8.698 + USDC 0.829 + SOL 0.0017. Both
  directions of EURC<->USDC are now live-proven through Jupiter at the smallest sensible size;
  SOL-gas headroom is ~0.0017 (roughly 300 more swaps at 5000 lamports each).
- Composed VCHF->EURC (flagship deposit-leg route): blocked on prod twice over — VCHF float is
  dust (CeFi minimums ~CHF 10-15) and the CeFi legs have no partner credential on prod (503
  tripwire). Route resolution + honest fail-closed states verified offline-only 2026-09-27.

## Dead-end log (do not re-search before last-checked + 24h)

- **2026-09-27 — Jupiter lite-api swap build (Solana execution leg): RESOLVED same day.**
  Found: lite-api quotes now carry `"transactionVersion": 0`, and the app's build body
  (`asLegacyTransaction: true`) got a deterministic `400 NOT_SUPPORTED` — every Jupiter
  execution blocked; no funds ever moved (verified on-chain per attempt). Resolution: uix
  commit **145ec40** omits the param when the quote self-describes its version (build-refusal
  copy also made honest, 4 locales); the fail-closed shape check stays in
  `verifyVenueSwapTxBeneficiaries`. Re-verified live the same session: the fixed build ran the
  real two-tap convert **0.5 EURC -> 0.569229 USDC** via jupiter-usdc-eurc (Whirlpool
  `ArisQNcb…`), one broadcast, tx `sol:394mcX6X…MvGwwDv`, fee exactly 0.000005 SOL, chain
  deltas == done panel == ledger. Entry kept as the resolved-dead-end record; no re-search
  needed.
- (No free-testnet search was due: every row's last-checked was same-day/next-day and the
  affected venues are mainnet-only per the table.)
