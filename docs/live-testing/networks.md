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
| SideShift (CeFi) | none | smallest supported order (venue minimum moves with rate: 2026-09-28 ICP→ETH min deposit 1.0037228 ICP, EURC→ICP ~8.698 EURC) | 2026-09-28 | Mainnet-only; exact-amount deposit windows. Prod proxy LIVE with the deployed (docs-example) credentials; the LOCAL relay proxy is live-proven too (2026-09-28: quotes AND order creation 201 through the loopback relay + xff proxy). ICP→EURC: venue min exceeds the float (8.698); that leg's live proof stands from 2026-09-22 (shift d61b2eec). ICP→ETH (sideshift-eth): quotes + orders LIVE-PROVEN in-app 2026-09-28 (3.2 ICP → 0.00354669 ETH, settle = the device's own EVM identity verbatim, payout rail named "native ETH on Ethereum mainnet") — the deposit leg is blocked on the SOL-rail ATA-rent wall, see the dead-end log. |
| ZCHF (ERC-20) reads | yes (keyless, free) | `just evm-probe-mainnet` — symbol/decimals/DOMAIN_SEPARATOR on publicnode + arb1 | 2026-09-28 | READ path free and proven. WRITES (a real transfer round trip) are mainnet-only: gas is dust ETH, no ZCHF faucet on either chain. 2026-09-28: the app renders the ZCHF·Eth/ZCHF·Arb rows live through the relay pipe (balance poll 0 at the unfunded rail); the EVM history poll 403s on publicnode ("Archive requests…", see dead-end log) — balances poll fine, history shows the honest refusal. |
| Arbitrum Sepolia (D29) | blocked on gas | `just evm-probe-sepolia` (keyless, GREEN); funded trip: `node scripts/evm-sepolia-roundtrip.mjs` (ready, BLOCKED ON GAS) | 2026-09-27 | Probe green: official RPC answers 421614, ~250ms blocks, ~0.03 gwei, dev-token env-row mechanism verified. Funded trip blocked: every no-login faucet refuses a zero-mainnet-balance address and the agent float is empty — dead-end log below. |

## EVM rail (ZCHF-first) — live facts (2026-09-28)

**2026-09-28 (second trip, D31 continued) — THE FULL MAINNET ZCHF ROUND TRIP IS PROVEN, drip-free,
self-funded from the existing float.** Chain: EURC→SOL via the in-app convert (jupiter-eurc — a
native-payout route exists: direct Whirlpool, Jupiter's program-owned shared WSOL account, NO taker
ATA rent; simulated clean pre-broadcast), then 18 EURC→ICP via in-app sideshift (settled in ~1 min),
4.0 ICP→native ETH via in-app flow-223 sideshift-eth (settle = the device EVM rail EIP-55-exact),
the Uniswap V3 buy, the in-app ZCHF send, and the offline-permit claim loop. Per-leg record:

| Leg | Route | Amounts | Fee | Tx |
|---|---|---|---|---|
| 0 self-fund | in-app Convert EURC→SOL (jupiter-eurc, sim-clean route) | 1.5 EURC → 0.014362347 SOL | net (realized payout) | `sol:4cSBsbpYjnEYFKFjqJKyUxhC7MKsRDR5EynND1WUFTTcS44m2LMihVbHZU3H1KjUoF51s6BpK1PH4Ah3MkS9U1Nr` |
| 1 shift | in-app Convert EURC→ICP (sideshift-eurc, settle = icp-float) | 18 EURC → 6.69860354 ICP | venue-side | deposit `sol:2gZcVMb3s1fst7DT4TvV4rMf97LrUghqg7i6rgNjmwUnedyaXjDVoqADm9T9sB1G233wE9yncmhc7g9NKcotQTzg`, settle `icp:38660671` |
| 2 shift | in-app Convert ICP→ETH (sideshift-eth flow-223, settle = evm-rail exact) | 4.0 ICP → 0.0044058 ETH | venue-side | `icp:38660718` in, payout `0x234d6fda00bf27e21b99b6c1d4b032576f166261bbf02a7fb994c4e4a710531f` |
| 3 BUY | staging script, Uniswap V3 SwapRouter02 through the relay pipe | 1.5 ZCHF ← 0.000679768180797145 ETH (exact) | 4-tx staging gas 0.0005654 + a 0.0000486 reverted first attempt | swap `0x0ab8f11a0dea11fbc4ad760490957f3d39007b63cd04c66b607a91c4263c7801` |
| 4 SEND | in-app EvmWithdrawSheet (production path) | 0.5 ZCHF rail→B | 0.0000431 ETH | `0x2168a18e268214d5801f9270e0eb200ab69b940144338bb0d71f7a77eb1f65d1` |
| 5 CLAIM | offline sign in-app (connectivity pinned down) → B settles (permit + transferFrom) | 0.4 + 0.1 + 0.1 ZCHF rail→B across three claims | B settle gas ~0.0001/claim | permit `0x505267d9…af84ab0` / transferFrom `0x546a44b4…13afe7dd`; third claim transferFrom `0x986e7eb3…f1171a407` |

Final rails: evm-rail 0.4 ZCHF + 0.001041 ETH; evm-rail-b 1.1 ZCHF + 0.001687 ETH; icp-float
3.2043 ICP residue; sol-rail 1.621347 EURC + 0.014572 SOL. Reconcile CLEAN (26 pairs). Total
float cost: ~CHF 1.2 of shift fees + ~CHF 1.5 gas, all inside the CHF 25 ceiling. "ZCHF held /
sent / received offline-capable in dpay on mainnet" = **PROVEN**.

**Script bugs the trip shook out (all in the never-executed staged scripts, fixed in-tree):**
QuoterV2 takes its own 5-field tuple (not the router's 8); SwapRouter02's `exactOutputSingle` has
NO deadline field (7 fields — expiry lives in `multicall(uint256,bytes[])`); `bytes[]` needs
per-element offset+len words; ETH input needs wrap+approve (the router's V3 path pulls WETH from
msg.sender — wrapETH mints to the router, so the one-tx wrap pattern belongs to the Universal
Router); sequential nonces must be tracked locally (pending-count reads race under load); the
settle verify must poll (publicnode serves load-balanced reads that lag the head by a block).

**2026-09-28 — the D31 mainnet round-trip attempt (blocked at leg 1, everything before the wall
proven).** Local relay = main-HEAD binary (73c8a7bc) at 127.0.0.1:8899 behind the xff proxy
(8898), configured exactly like prod (DPAY_LEDGER=ic, real ssqti behind icp-api.io, SideShift
partner creds from sops, keyed Solana provider from deploy/.env) PLUS `DPAY_EVM_RPC_URL=https://
ethereum-rpc.publicnode.com` + `DPAY_EVM_RPC_URL_42161=https://arbitrum-one-rpc.publicnode.com`
(prod is one founder redeploy behind: no EVM routes there yet). Verified BEFORE touching the app:
(a) `/api/v1/currencies` carries both EVM sections (chain 1 ZCHF `0xB58E…21cB` + chain 42161);
(b) POST `/api/v1/evm/rpc` `eth_chainId` → `0x1`, `/42161` → `0xa4b1` through publicnode;
(c) IC answers (`/api/v1/balances` 200 with the float's real balances). In the REAL app (browser,
float seed restored, `?relay=` at the local relay, both rails' RPC derived from the relay base):
EVM rows render (ZCHF·Eth / ZCHF·Arb), the balance poll measures the rail through the pipe, and
the in-app ICP→ETH CeFi surface quotes LIVE (SideShift verbatim, settle address = the device's
own EVM identity EIP-55-exact, payout rail named). Four EURC→ICP CeFi orders were created
in-app (quotes verbatim, settle = the float's 64-hex identifier) and ALL expired unfunded: the
deposit handoff is blocked on the SOL-rail ATA-rent wall (dead-end log) — zero value ever in
flight. The Uniswap buy / send / offline-permit legs have ready scripts
(`scripts/evm-mainnet-zchf-buy.mjs`, `scripts/evm-mainnet-claim-settle.mjs`,
`scripts/evm-live-trip.mjs`) and are unexecuted pending the float unblock.

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

## Practical routes with the current float (2026-09-29, D32)

- **D33 (2026-09-29) — THE CHAIN ROUTE IS LIVE: the founder's pair EURC→ICP→VCHF completed in
  ONE consent, drip-free, on the broadcast fix.** In-app chain row `chain:sideshift-eurc:icpswap`
  (the standing twin-CHF review), Max-net prefill 10.895323 EURC, verbatim attributed quote
  ("Executed via SideShift / Swap EURC → ICP on SideShift / Swap ICP → VCHF on ICPSwap",
  ≥9.76419582 VCHF at 1% slippage), ONE CTA press:
  order `ebda94c3edeacc757eeb` FIRST (locked settle 3.62188403 ICP, settle = float IC account
  verified on-screen, expires 8:34Z) → frozen deposit broadcast **FINALIZED** (sig
  `4PdWhqaX…1hJiZ`, slot 451585937, err null — the D32 fix working) → venue **settled**
  3.62188403 ICP → float block **38680561** → phase 2 signed from the frozen plan → pool deposit
  block **38680566** → **VCHF 9.92442112** = 0.03015628 + 9.89426484 (the record's expectedNet
  floor) to the last digit. UI narration == chain == ledger on every leg (rows 207–212,
  reconcile CLEAN). The record UI parked `stuck` mid-legs under prod latency while the chain
  completed (the 2026-09-27 honest-unknown class — the legs landed anyway). Driver:
  `e2e/live-d33.mjs`. SOL cost: 0.00149344 (tx fee + venue ATA rent). ICP cost: 0.0002 (approve
  + transfer fees). End state: IC wallet 9.92442112 VCHF + dust; Solana rail 0 EURC.

- **D32 (2026-09-29) — the SELF-FUNDED round trip, founder-authorized ("use the existing float").**
  Phase 1 ICP→EURC: DONE + verified end to end. In-app Convert on the ICP row (cross-rail cefi
  `sideshift-eurc`), Max-net prefill 3.20421219 ICP, review verbatim ("Quote from SideShift,
  fetched 7:11 AM", ≈9.23 EURC, payout = the float SOL rail shown on-screen), ONE consent, then
  the honest CeFi handoff: the deposit is the user's own IC send (block 38678542, exact amount,
  fee 0.0001). Venue settled in ~2 min: shift `293f9f3d562dd23e943e`, 9.273976 EURC = the locked
  settleAmount to the last digit (payout `FgBxRYpF…cDx`), rail 1.621347 → 10.895323, record done,
  reconcile CLEAN. Ledger rows 202-206.
  Phase 2 EURC→ICP→VCHF (the NEW chain row `chain:sideshift-eurc:icpswap`): BLOCKED by a real
  defect — see the dead-end log + OPEN_ISSUES. Two consecutive attempts: order created (verbatim
  locked settle 2.98010364 / 2.96580455 ICP, settle = float IC account verified on-screen), the
  SPL deposit signed — and the broadcast NEVER reaches Solana (getSignatureStatuses null with
  history search for both sigs; rail EURC measured 10.895323 unchanged through every attempt;
  the relay's solana pipe answers 200 from curl). Orders expired unfunded; ZERO value at risk.
- Venue minimums FLOAT with the rate (EURC→ICP: 8.789539 at plan time → 8.807226 ~70 min later);
  an "exact minimum" deposit is un-hittable — size min + ~2% headroom.
- IC side (2026-09-29 after D32 phase 1): ICP 0 + VCHF 0.0302 + ckETH dust. Solana rail:
  EURC 10.895323 + USDC 0.829 + SOL 0.0146 (covers the ~0.00204 ATA rent).

## Dead-end log (do not re-search before last-checked + 24h)

- **2026-09-29 — the CHAIN route's deposit broadcast never reaches Solana (RESOLVED same day).**
  Two consecutive in-app attempts on `chain:sideshift-eurc:icpswap` (EURC→VCHF
  via ICP, prod relay, real float): the record freezes correctly (order first, verbatim locked
  settle, settle = the user's own IC account verified on-screen), signs the SPL deposit — and
  nothing lands: `getSignatureStatuses` null (history-searched) for sigs `5YbxaMGz…kpQS` and
  `2voWTQ6Y…GNux`, rail EURC measured unchanged (10.895323) through every attempt, ICP/VCHF
  unchanged, orders expired unfunded at the venue (refund address = the user's own rail; nothing
  to refund). The relay's own solana pipe answers 200 from curl in the same window. The record
  flips to `stuck` ~2 min post-CTA with the POOL's copy ("the pool's answer did not arrive") on
  a legs=[] chain phase-1 record — mislabeled state line (cosmetic twin of the defect). Drivers:
  `e2e/live-d32.mjs` (phase 1, works) / `e2e/live-d32-p2.mjs` (phase 2, reproduces).
  **RESOLUTION (dfde0468):** the bytes were proven valid (byte-exact rebuild simulated clean on
  mainnet); `submitRawSolTx` ran preflight ON and the provider's simulation layer refused in
  place — not blockhash-shaped, so the walk never fired. Fix: skipPreflight posture + the walk
  widens to preflight-shaped refusals. Pin: `chain-deposit-submit.test.ts`. Live-proven the same
  day by D33 (see the routes section): deposit finalized, venue settled, pool leg executed,
  VCHF 9.92442112 = the floor to the digit.

- **2026-09-28 — the leg-1 rent wall was SELF-FUNDED AWAY the same day (resolved).** The 1.5-EURC→SOL
  in-app convert took the rail from 0.0017 to 0.0161 SOL without needing the feared taker WSOL ATA
  rent: Jupiter's build used a direct Whirlpool route whose WSOL handling is program-owned (the
  simulation — quote→build→sign→simulateTransaction with sigVerify through the relay pipe — was
  clean before any broadcast). The venue-deposit ATA rent then paid normally on the EURC→ICP
  deposit. The dead end below stands as the float-arithmetic record; the unblock ask is VOID.
- **2026-09-28 — the EVM history poll 403 on publicnode needs a sharper diagnosis (updated).**
  `eth_getLogs` WITHOUT an `address` is refused outright by publicnode (`-32701 Please specify an
  address`), and 10k-block spans 403 even with one. WITH the token address + Transfer topic,
  5000-block spans answer fine (the trip's 4 rail movements came back exactly). So the app's
  history walk should survive if its query carries the token address and its page stays ≤ ~5k
  blocks; if the ZCHF·Eth history surface still renders the honest refusal at HEAD, the app-side
  query shape (not the upstream) is the thing to fix.
- **2026-09-28 — the D31 leg-1 wall: the SOL rail cannot pay a venue-deposit ATA's rent.** Every
  EURC→ICP deposit handoff needs an SPL transfer that CREATES the venue's fresh EURC ATA
  (~2_039_280 lamports rent, paid by the sender; the app discloses the exact figure on the
  review: "Creating it costs about 0.00204428 SOL"), and the rail holds 1_702_955 lamports —
  ~0.00034 SOL short. On-chain verified for all four order deposit addresses (ATA not created);
  the app refused every send PRE-broadcast (SOL measured unchanged end to end; four unfunded
  orders expired harmlessly at the venue). Nothing to retry — this is float arithmetic. **Unblock
  (either):** a founder drip of ≥0.0004 SOL to `BzFNJ…MkZgX` (then the proven EURC→ICP shift runs,
  then ICP→ETH per flow-223), or ≥0.6 ICP to the float (then the DIRECT in-app ICP→ETH single
  shift funds the rail — no SOL needed at all; venue min 1.0037228 ICP vs float 0.5058).
  Finding filed alongside: the send sheet's confirm press is INERT when the ATA rent is
  unaffordable — the review shows the cost but no terminal state or next action follows the press
  (founder rule: useful practical instructions on every step, especially the error path).
- **2026-09-28 — the EVM history poll 403s on publicnode ("Archive requests…").** The app's
  eth_getLogs history walk (`EVM_LOG_PAGE_SIZE` blocks back) exceeds what publicnode serves free
  (`{"code":-32602,"message":"Archive requests re…"}`), so the ZCHF·Eth history surface shows the
  honest refusal while balances poll fine. Not money-blocking; needs either an archive-capable
  upstream in DPAY_EVM_RPC_URL or a smaller log page on chain 1. Recorded as a finding, no code
  change made in this docs-only session.
- **2026-09-28 — shared-host incident: background relays are swept by concurrent sessions.** The
  session's OpenCode background relay + xff proxy were killed mid-trip (another session's
  orphan-process cleanup; one unfunded order expired as a result — zero value at risk, row 173).
  Resolution for future live trips: run the relay + proxy DETACHED (`setsid nohup` + pidfiles in
  `~/projects/dpay/tmp/`, e.g. `tmp/run-dpay-relay-live.sh`), never as session background tasks.

- **2026-09-27 — the convert settle probe parks a LIVE record on `stuck` too early under prod
  latency (finding, filed in OPEN_ISSUES).** The flagship leg-1 ICPSwap swap settled on-chain
  at ~+11 s (ICP block 38641313 -> VCHF payout 82188) while the app had already parked the
  record on `stuck` at ~+9 s. The honest-unknown design held (no false done, correct "do not
  start a second swap" guidance, funds never at risk), but a real boundary round trip under
  host contention beats the probe budget. Related harness note: conversion records are
  context-local, so a dead browser mid-flow loses the record (funds survive in the wallet; an
  unfunded venue order expires harmlessly). The stuck -> done reopen flip is still unverified
  on web.
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
