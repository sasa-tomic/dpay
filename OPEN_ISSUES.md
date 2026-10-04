# OPEN_ISSUES — the authoritative open list

> **HARD RULE for every entry.** An item carries **value [1-10]** and **effort [S/M/L]**. Nothing
> below value 4 is filed at all — delete it instead of parking it. An item that is DONE is REMOVED
> from this file in the same change that finishes it, and struck wherever else it is mentioned;
> a closed item that survives here is a bug in this file. HARD blockers and founder-owned items
> carry the same two numbers, so the cost of the thing being blocked stays visible.

> Role: known blockers + documented follow-ups. Read top-down; work order first.
>
> **Pruned 2026-09-30** — every DONE record removed in the same change (work-order VCHF
> verification, objectives 2/3/3b/3c/5/F2/4/6/7/8, the Solana R1-R4 + S2/S3 records, the EVM rail
> D31 record, the PROD STATE history, the UX-swarm inventory, and the resolved rows under "Other
> open issues"). Each removal is a one-line disposition under "Retired this prune" with its
> commit/spec pointer; nothing was closed by the prune itself. Standing lessons the log carried:
> "closed without a reason is how a defect comes back", and the F1 correction (a resolver that
> infers money movement from a display field loses money — rule + fix in
> `docs/specs/2026-09-09-funding-routes-plan.md`). Full prune history:
> `git log --follow -p OPEN_ISSUES.md` (last pre-prune state at `a75f371d`).

## NEXT SESSION — work order

**APK WEB DOWNLOAD + IN-APP UPDATE FLOW (founder 2026-10-04): LANDED.**
(1) The landing page's download button was dead because `deploy/docker-compose.yml` always set
`DPAY_APK_PATH:` to an EMPTY string, overriding the Dockerfile's baked default, so the relay's
`load_apk()` disabled `/download/dpay.apk`. FIXED `46f7968c` (default = `/srv/dpay.apk`) and
verified live after redeploy: prod `/api/v1/version` = the deploy commit, the landing button
renders "Download for Android" with href `/download/dpay.apk?v=<etag>` and serves the APK as an
attachment (HTTP 200, ~59.2 MB, correct sha256 ETag). (2) In-app update check, update-lane wave
merged ff (8663cdb6 relay route, d69b8e65 app notice, f4ef75e0 pins): `scripts/build-apk.sh`
stamps `app/lib/buildStamp.ts` with BUILD_COMMIT and writes a `<apk>.commit` sidecar that
`deploy/build.sh` stages and the image carries; the relay answers `GET /api/v1/update` with
`{"apk":null}` or `{"apk":{"commit","url"}}` (missing sidecar = named warning, null arm); the
app fetches once per launch (`app/lib/updateCheck.ts`, silent on ANY failure and for dev
builds), and Home renders ONE line + ONE `btn-update-now` opening the download URL - browser
download + system installer = 2 clicks total. The route lights up on the deploy that carries a
stamped APK.

**CCTP LIVE ROUND TRIP (2026-10-03/04): COMPLETE - the burn landed live, the root cause was the
app's own encoder, and both product fixes are landed and gate-green.** Final state: the burn
0xbeac9fae… (10.139901 USDC, feeExecuted exactly the frozen 378582 cap, Circle attested ~20s,
forward COMPLETE, the Solana ATA credited 9.761319 = the record's mint floor to the digit;
screenshots /tmp/opencode/cctpfix2-*.png). ROOT CAUSE (proven by the diagnosis lane
ses_efbdbde95ffe82ATswpPRqs50H): `app/cctp.ts encodeDepositForBurnWithHook` wrote the dynamic
bytes-tail OFFSET one word short (0xe0 instead of 0x100 - the offset must point at the tail's
LENGTH word), so solc's ABI decoder failed and the TM reverted empty at ~29k gas; the smoke
golden pins had frozen the buggy bytes. FIXED (TDD RED->GREEN, fd281ec3: offset + pins + the
header note 'pin against the LIVE contract's decoder, never against the encoder's own output').
The parked-record resume gap also FIXED (7238d55c: the boot sweep re-drives crossing+device
records whose burnTxHash is still null) and VERIFIED LIVE (a parked watcher record flipped DONE
after an app restart during the night's drive). The in-app funding chain ran live end-to-end:
SOL->USDC via the app's jupiter row, USDC@Sol -> SideShift -> ICP -> ICPSwap -> 8.62542446 VCHF,
then the fresh CCTP record 8.4 VCHF -> IC legs 0-4 confirmed -> 10.139901 USDC@Eth delivered
(balanceOf-verified) -> the burn. Ledger rows 218-292, `funds reconcile` CLEAN; gates verify +
test-app 4007/4007 pass dirty=no @ f8b95751.
REMAINING (closed 2026-10-04, small): (1) PHANTOM-REFUSAL INSTANCE 3 CLOSED `0755961b` - an
UNKNOWN withdraw outcome is now verified at the destination too (`crossRailHopDelivered` probe
at all four unknown sites in `app/convert/execute.ts`; `probeStuckOnce` also resolves a
cross-rail record stuck on a SUBMITTED withdraw at destination), so delivered money continues
the crossing in-flow instead of stranding as failed/unknown. (2) maxFee honesty CLOSED
`36ecc017` - the crossing census is pinned to the SIGNED maxFee cap (0.377588, never the
unbuffered med+bps 0.314657; every surface already quoted the cap, the domain pin locks it).
(3) STILL OPEN: publicnode 403s archive eth_getLogs (EVM history display only) - a keyed
upstream is the founder's call (DO NOT NAG).

**CoW Swap D31 LIVE TRIP: COMPLETE (2026-10-04) - the full funding chain ran with existing funds, the order is FULFILLED.**
The prod relay runs `b300dff9` (deployed by the agent, founder-authorized; the CoW order-API proxy
ANSWERS live). The funding wall (SideShift's 9.9995 floor vs 9.761319 held) was crossed by the raw
Circle CCTP V1 Sol->Eth bridge (`scripts/cctp-sol-eth-bridge.mjs`, commit `32e48cd9`: Solana burn
`4r7PZfP5…`, MessageTransmitter v1 `0x0a992d19…` receiveMessage mint `0x311c948a…`, 1:1, attestation
<10s; V1 chosen over V2 for zero fee + instant rent reclaim), then the USDC->ZCHF V3 buy
(`scripts/evm-mainnet-usdc-zchf-buy.mjs`, 4 txs), then **ONE live CoW order placed IN THE APP**
(device-signed EIP-712, uid `0x5b5856f6…6ac1d345`, appCode dpay, **status fulfilled**, solver settled
via VaultRelayer, app approve `0xd973544d…` + WETH unwrap `0xc073203b…` -> **0.003445332536202788 ETH
received**, Home "Converted" panel cow-20.png). Total friction ≈0.26 USDC (V3 ~0.5% + CoW fee 0.0762
ZCHF + gas); ledger rows 293-313, `funds reconcile` CLEAN 26 pairs, lease closed loss CHF 0.
CoW Swap now carries its D31 live proof: the venue may claim 'supported'.
Historical wall text (superseded by the completed chain): the earlier blocker analysis (SideShift
fixed-quote floors, the no-ZCHF-in-app matrix fact, the ETH-gas requirement for the VaultRelayer
approve + WETH unwrap) is preserved in git history (09c1bf20); the defects observed on the run:
the 'Rate moved - Confirm again' loop (CoW's fee re-estimate jitters the quoted TOTAL +-0.04%
per fetch, which the confirm gesture treated as a moved quote) FIXED by `767c0951`: the confirm
gesture signs a LIVE quote as displayed - `cowQuoteFresh` keys on the quote's own validTo window
(the cefi order-is-the-lock precedent); only an expired window triggers one re-quote. The ZCHF
row's full-precision amount wrap FIXED by `f04fb99e` (the amount column holds one line, title
fixed earlier by 931c4201).

**BRUTAL-UX RESIDUALS (the 2026-10-02 audit list): LANDED - uxres wave `6421cf5d`..`0f95ab48`
(merged ff 2026-10-04), e2e-visual accounts baselines reseeded.** History rows read machine
references from the row, never the typed amount, and practice-money credits wear the quiet
ink (6421cf5d); the accounts row title holds one line beside its amount (931c4201); the setup
card's quote-derived estimates are capped and marked instead of fake-precise, 4 locales
(d00f184d); flow pins the nonce/receipt contract (0f95ab48). Dispositions without code:
money-format sweep (one formatter family; the variance is unit placement + honest ≈ markers),
readiness pill was a misread (liveness is flow-pinned), no-swap-confirm is the founder-set
2-tap grammar.

**flow 31 ckusdc-pay: FIXED `ba1056d9` (2026-10-04) - a catalog flap to empty mid-journey can
no longer strand the fee delivery (third instance of the cancelled-delivery family after
14b4eae0).** A mid-journey catalog refetch answering [] made intentLedger null, the fee
effect re-ran, its alive cleanup killed the in-flight fetchLedgerFee delivery, and
reviewBlocked (balance already settled) refused a replacement, so the Paid total stayed the
bare wire. Fix: a once-per-journey `startedFor` marker keyed on the intent object; the null
ledger render early-returns before touching it (delivery survives the flap), the refill run
is a no-op, delivery checks the marker at settle time; reviewBlocked stays a query-START
guard only (flow 101's zero-canister-call invariant); the alive cleanup is deleted. RED pin
in PayMode.test.tsx proven before the fix. Gates: test-app/e2e/e2e-visual pass dirty=no @
ba1056d9.

**GOAL (filed 2026-09-28): 2-tap swaps between ANY two supported currencies — LANDED 2026-09-30.**
Spec: `docs/specs/2026-09-28-any-to-any-swap-goal.md`; matrix doc `docs/CONVERT_MATRIX.md`
(generated by `scripts/gen_convert_matrix.mjs`, checked by the `convert-matrix --check` gate):
110 ordered pairs across 11 mainnet rails, 46 routable (direct pool / CeFi / Uniswap V3 /
IC hub 2-hop / composed / CCTP), 64 refused with a named reason. Uniswap V3 adapter shipped
(`app/evm/uniswap*.ts`; any ERC-20 via catalog chain_id+contract; WETH hub fallback for
same-chain token pairs). D31 CLOSED (2026-10-03): the live funds-ledgered ZCHF->ETH trip ran
through the real app on the emulator (float seed, prod relay) - device-signed approve+swap
both status 0x1 on Ethereum mainnet (blocks 26110182/26110183), 0.4 ZCHF pulled, the wallet's
own address credited ~0.000179 ETH (min floor honored), ledger rows 215-217. TWO live-trip
fixes landed on the way: the native-ETH destination quotes the chain WETH instead of feeding
the quoter an empty token (`3d307ce5`), and the pair red line compares rail-canonical ids so
a checksummed registry token prepares (`b6c93abd`). The venue may claim "supported".

- ~~"My address" chip on send sheets~~ **DONE `b0bc8be7` (2026-10-04).** `AddressField` grew an
  optional `ownAddress`; the chip renders ONLY on an empty field (empty stays send-elsewhere)
  and fills the wallet's own rail address; wired on the EVM sheet, the SOL sheet, and the IC
  send sheet (own principal resolves into the existing self-send warning); 4 locales; pins
  incl flow 104 (IC) + flow 221 (EVM); AddressesTab deliberately gets none.
- ~~Setup copy/pixel residuals from the 2026-10-02 brutal UX audit~~ **DONE - uxres wave
  `6421cf5d`..`0f95ab48` (2026-10-04) + `f04fb99e`.** ICP row title one line (931c4201), row
  amount one line (f04fb99e), history rows machine-refs off-row + practice-money ink
  (6421cf5d), setup-card estimates capped+marked 4 locales (d00f184d). Evidence notes stand:
  one formatter family (variance is unit placement + honest ≈), readiness pill was an audit
  misread (liveness flow-pinned), no-swap-confirm is the founder-set 2-tap grammar.
- ~~Residual CeFi papercut~~ **DONE `e85d435b` (2026-10-04).** The functional half (the watcher
  auto-sends the deposit) was already composfix; the residual was the review census saying
  "you send the deposit yourself" plus a manual address/amount/memo trio rendered ON TOP of
  the auto-send (a double-spend invitation). The panel + census now fork on the record's
  source rail: IC source gets the honest auto-note and the order handles it; another-rail
  sources keep the manual handoff verbatim (flows 197/198/199 untouched). RED pin in
  convertCefiConfirm; flows 187/194/208/209/223 updated.

**1. Objective 3 (card/bank funding) — HARD-BLOCKED on founder/legal; NOTHING is offline-buildable
until the blockers land. THE thing that unblocks it:**

- **(a) Onramp founder decisions — confirm-or-drop the 2026-07-30 set**
  (`docs/specs/2026-07-30-ckusdc-onramp-offramp.md` §6, also filed DO-NOT-NAG below): Q1
  direct-vs-partner sequencing, Q2 partner aggregator + venue list + static-vs-widget-vs-deeplink,
  Q3 KYC surfacing, Q4 chains, Q5 fees, Q14 wrong-network recourse.
- **(b) positioning.md decisions 1+2** (regulatory evidence: `docs/REGULATORY.md`): display a rate
  at all (quote, or only relay the provider's quote — computing one is the broker line), and pick
  the provider vs let the user pick (picking is routing — the clause with legal weight).
- **(c) Counsel answers** — `docs/REGULATORY.md` §7 Q1–Q5. Gates the DFX bank half outright.
- **(d) Card→native-ICP evidence gap** — Coinbase-Onramp-style 64-hex tx delivery is undocumented
  against ICRC-1; needs ONE real founder purchase to measure.
- **(e) Structural, measured 2026-09-04** — no compliant fiat rail into ANY chain-key asset exists;
  only Solana USDC and native ICP are card-reachable at all.

## Open defects and follow-ups (each with value / effort)

- **EVM history poll vs publicnode** (value 5, effort S). The upstream refuses `eth_getLogs`
  without an `address` outright and 403s 10k-block spans, but answers address+topic queries at
  ≤5000-block spans fine (proven by D31's four rail movements through the relay pipe). If the
  ZCHF·Ethereum history surface still shows the honest refusal at HEAD, the fix is the app's own
  query shape (carry the token address; cap the page at ~5k blocks) — not a new upstream.
- **Trocador chain routes disabled (founder call 2026-09-29) — value 7/M.** Chain-kind rows
  currently only render on venues that publish a locked settle figure (SideShift); Trocador
  chain rows fail closed at prepare because its trade payload carries no locked payout, so the
  exact-deposit gate has nothing to compare against. Founder: "we can leave trocador aside for
  now but please add an open issue to add it back (re-enable) and support variable (non-fixed)
  amounts. Many users are used to that anyway, and likely don't care much as long as we're
  transparent about it." Unblocking path: teach the chain prepare a variable-settle mode that
  quotes/polls the venue's live payout instead of gating on a locked figure, and surface it
  honestly on the review card ("you receive ≈" rather than "exactly"); re-enable Trocador
  chain rows behind it.
- **Multi-asset checkout needs the settlement asset INSIDE the signature** (value 7, effort M;
  wire + relay + app). Today the picked settlement asset is verified via the ANSWER's `asset`
  field because the checkout-open body's signed bytes are pinned
  (`dfx/checkout_open_signing.json`) and an unsigned field in a signed request is
  unattributable — a relay that only serves VCHF fails the app closed with a named fix, which
  is correct today but caps checkout at one asset. Fix shape: new signing domain version,
  regenerate the pin via `just wire-layout`, relay echoes it.
- **Trocador go-live gate** (effort S, one command): re-run `just trocador-probe` immediately
  BEFORE the venue serves its first real trade. Coverage measured 2026-09-22 and re-run
  2026-09-24: ICP markets LISTED but UNQUOTED (the `btc→xmr` control QUOTED both times), so the
  key, params and pins are proven and the venue's provider pool simply had no live ICP markets
  those days; the trocador-usdc/trocador-eurc venue rows stay UNREGISTERED — blocked on the
  venue, not on code. The app already renders the no-quote state honestly (four locales,
  flow 207). Founder note (no API flag refuses it): Trocador's `markup=0` pin keeps the USER's
  price at the venue's own baseline, but Trocador still accrues half of ITS own commission to
  the partner account — what happens to that accrual is a founder decision, outside code.
- **Withdrawal approve→retrieve front-running residual** (medium): includes the inherent
  dual-approve partial-failure class; documented mitigation in place.
- **"A third-party wallet can pay a dpay checkout" is a CAPABILITY, not a claim, until Oisy
  itself drives one** (founder account + a franc or two; its scanner sits behind Internet
  Identity). The rails are proven: provider-CORS sub-router + the merchant-side
  `icrc2_transfer_from` collection (`PullClaim` → `preparePull` → `collect`, flow 177). Until
  that run happens the sentence must not appear in a deck, a demo or an investor mail.
- **Signed name registry stays a founder follow-up, NOT in-tree** — history rows are named from
  DEVICE-SAVED annotations (`app/services/txNotes.ts`); payee-side payer names are impossible by
  design (the name lives on the payer's device, never on the rail; incoming rows keep the
  payer's principal prefix).
- **U5 tail: interactive watch verification pending** (value 4, effort S). The e2e watch's
  in-place-rebuild path (`watch.mjs` + sirv `--dev`) is exercised by construction but the
  interactive loop is unwired by design and cannot ride `just verify`; one manual watch session
  would close it.
- **Locate the CCTP wave's pulled 0.1385 ckUSDC** (value 4, effort S). The 2026-09-21 Route-B
  session's attempt #3 allowances left the IC float in exactly the allowance amounts; WHERE the
  0.1385 ckUSDC sits now is UNVERIFIED (evm-float `0x6B1C…83b9` as ERC20 is the candidate). The
  EVM rail's balance reads now make this a one-command check; `just funds reconcile` is CLEAN
  regardless (the evm-float reconcile measures only ETH).
- **ckSOL watch continues** (the mainnet ckSOL canisters are still the devnet variant).

## State — not issues (external services; no action without the founder)

- **ChangeNOW**: door closed (2026-09-21, support-confirmed) — no ICP in the partner API and no
  plans to add it; the site's ICP page renders off external backup liquidity, not the API. Key
  is sops-encrypted; remains an optional EUR↔USD-on-Solana redundancy rail (adapter unstarted).
- **StealthEX**: disqualified as an ICP-bridge candidate (2026-09-21) — `icp/mainnet` is listed
  but every needed estimate direction returns `NoPair`. Its schema remains the best adapter
  template in the class (`refund_address` at create, network-aware routes, fixed+floating with
  `rate_id`). Key is sops-encrypted.
- **SideShift**: the only live-settling ICP↔SOL venue; credential live in prod since 2026-09-27
  (`secrets/sideshift.sops.json` → generated `deploy/.env` + compose). Both EUR-rail legs
  (EURC→ICP and ICP→EURC) are live-proven end to end; `just funds reconcile` CLEAN.
- **VCHF multichain (verified 2026-09-30, `docs/specs/2026-09-30-vchf-multichain-verification.md`)**:
  canonical on 7 chains (ICP, Ethereum, Solana, Base, Celo, Stellar, Tezos); ISSUER burn/mint
  bridge (VNX-operated, account-gated, fees unpublished); `CURRENCY_RAILS.CHF` growing ETH/SOL
  entries is justified ROUTING, but chain-MOVING stays a VNX-platform operation, never an
  in-app route. Decimals differ per chain: ICP 8 / EVM 18 / SPL 9 — normalize by rail.

## Objective state (compressed history — the currency-first frame, founder 2026-09-04)

- **O1 home currency** — BUILT, gated green, shipped; spec
  [`docs/specs/2026-09-04-currency-first-wallet-plan.md`](docs/specs/2026-09-04-currency-first-wallet-plan.md).
- **O2 rail choice** — `3d44de1`→`470b0b6`; EUR dual-rail (VEUR@IC thin + EURC@Solana deep)
  `0ab1881`→`351952b`; same spec + its findings addenda.
- **O4 Revolut-IA home tab** — `b5912b6` + `711b0ef` + `798edc2` (Balances modal retired, flows
  133–136).
- **OpenCryptoPay is one interop rail among several, not the strategy** (founder, 2026-09-04). The
  checkout v1 build is complete (`702c359`; plan
  [`docs/specs/2026-09-02-merchant-side-plan.md`](docs/specs/2026-09-02-merchant-side-plan.md))
  and **served by default at every layer since 2026-09-10** (`d15b596`; `DPAY_ENABLE_CHECKOUT=false`
  is the operator opt-out). What remains of it is the two-handset tap (below). The cashier page
  (`8805027`), the OCP tx-id fix and the bearer-token revisit are done and recorded below/inline.

## Physical / outer-loop gates (NOT autonomous)

- **SOL HCE hardware tap** (AID `F06470617902`, `DpaySolNfc`) — never tapped on hardware. The
  IC-rail two-phone NFC tap (payer in airplane mode) + real-camera QR scan PASSED 2026-08-26
  (founder-run retest; commit `8940b1d`).
- **Checkout tap on two physical handsets** — the merchant counter arming the reader from a live
  charge. Rides the IC rail's proven HCE hop unchanged; a confirmation, not a design risk.
- **ckBTC live mainnet deposit→mint + withdrawal with real BTC** (low — final pre-pilot confidence
  checks after the testnet proofs).
- **ckUSDC live Sepolia withdraw proof** (needs funded ckUSDC + ckETH gas; PocketIC already proves
  the dual-ledger flow).
- **WalletConnect round trip with a REAL wallet app installed.** The dApp side is proven live
  (2026-08-30, emulator + R8 release APK + the real WC relay, driven by a scripted `sign-client`
  peer): session settles, `eth_sendTransaction` carries byte-exact `depositEth` calldata to the
  live minter, unknown-outcome resolves to honest "watching", wrong-chain approval refused, stale
  session tears down and re-pairs. Only a wallet on the device proves the rest: a real approval
  UI, whether Trust Wallet honours `metadata.redirect.native`, the deeplink foregrounding, and
  no-gas refusal before a prompt. Calling this a formality is what let four bugs sit on the only
  ckETH/ckUSDC deposit path — do not re-file it as low.
- **Tier-2 full Testnet4 mint** — externally blocked (faucet captcha + cycle-starved minter);
  optional, proves DFINITY infra, low dpay value.
- **Play launch ops** (pre-launch report + `just play-upload` with upload-key AAB + staged
  `mapping.txt` ready). First upload sanity-checks the store-listed size vs baselines
  (APK 93,728,358 B / AAB 39,649,424 B; pre-WC 87,540,415 / 36,233,482).

## FOUNDER-OWNED (DO NOT NAG)

- **Governance stance (founder-set):** govern in place, no NNS/SNS hand-off until critical mass —
  see docs/GOVERNANCE.md. `ADMIN_CALLERS` allowlist is accepted under this plan.
- **Gatekeeper RPC URL** (`beta.helius-rpc.com`) — NO config slot exists anywhere in the
  codebase; awaiting founder clarification on its purpose (2026-08-09 note — may be stale,
  confirm-or-drop).
- **Onramp founder launch decisions** (onramp plan §6 Q1–Q6,14): direct-vs-partner sequencing,
  partner aggregator, KYC posture, ckUSDC chains at launch, ramp fees partner-only, faucet
  retention once real ckUSDC exists, wrong-network recourse messaging (2026-07-30, pre-cutover —
  several may be stale; confirm-or-drop). Same decisions gate Objective 3(a) above.
- **Desktop-width /wallet design pass** (value 5, effort M-L — design-level, needs founder input).
- **Conversion PoC → officials confirmation** (post-PoC, founder-run): carry the built screen +
  the spec to the counsel/officials ask (`docs/REGULATORY.md` §7); the founder also owns the
  live-ship decision (`just up` ships the quote route).
- **Confirm-or-correct the reconstructed first-run UX decisions** —
  `docs/specs/2026-09-07-ux-decisions.md` records four decisions that are already SHIPPED IN CODE
  (preference-reason suppression, chooser preselect removal, first-run landing, rehearsal reframe)
  but that no founder statement in the repo supports. The doc says so itself and asks for
  confirmation; it is the only record, so leaving it unconfirmed means the code embodies decisions
  nobody can check. The first-run landing one is the sharp edge: it narrows a standing `CLAUDE.md`
  decision. Also open: the two forks in
  [`docs/specs/2026-09-08-first-run-redesign.md`](docs/specs/2026-09-08-first-run-redesign.md) §1.
- **Remaining convert externals, all founder-run**: a live Route-C (CCTP) value run; the DFX B2B
  revisit (its offline DEX-route PoC precondition is met); WC in-session signing + EVM deep-link
  design (spec §10 notes).

## Documented decisions / tripwires

- **ckETH `eip_1559_transaction_price` — no code change.** The app path is functionally correct
  against prod (same estimate the semantically-pure `None` call returns). The probe test is the
  regression tripwire: if the minter ever starts rejecting unregistered ledgers (the
  assert-printed `MEASURED:` line flips), flip `fetchGasFeeWei`'s native call site to the `None`
  arg. Launch check: a native-ETH withdrawal failing on prod with a minter reject mentioning
  `eip_1559_transaction_price` → look here first.
- **Live ckUSDC onramp params (O6)** — always READ AT RUNTIME via `get_minter_info`, never
  hardcode (verified live 2026-07-31; the full param table lives in this file's git history at
  `ad65174`).
- **dpay speaks no external payment standard, either direction — except Solana Pay, spoken in
  BOTH directions** (2026-09-05, `app/solana/payUri.ts` + `parseSolanaPayUri`). Everything else
  is refused by name with a practical instruction (BIP-21/321, EIP-681, BOLT-11 →
  `coin-request`; transaction-request `solana:https://…` refused as damaged — transfer requests
  only; non-USDC `spl-token` mints refused by name).
- **dpay holds no EVM key, never pays and never quotes gas** — the burn's ETH/gas is the user
  wallet's own; since 2026-09-20 the in-intent gas-fund offer funds that slice from the user's
  OWN holdings. Nothing dpay pays, holds, or custodies.

## Retired this prune (2026-09-30 — decision-shaped; do not re-file)

- **CoW Swap = the SECOND EVM venue (value 6/M; gates VERIFIED `92a2f515`)** — LANDED 2026-10-03,
  merged ff to main `92a2f515` (5 commits, 29 files +3054/-63). `34bbe73e`: the CoW Protocol
  order-API proxy in the relay (transport like every other venue call, no key on device).
  `25c72a9e`: the PURE order surface — EIP-712 signing over domain 'Gnosis Protocol' v2
  (chainId 1, verifyingContract `0x9008D19f58AAbD9eD0D60971565AA8510560ab41`), off-chain UID
  derivation, wire shapes; gasless for the trader (the solver pays gas, the fee comes off the
  sell amount and is surfaced exactly). `01617ce2`: the venue row `cowswap-eth` in the EVM AMM
  registry (ZCHF on Ethereum chainId 1), convert-matrix regen included. `3c2768d2`: the convert
  path — prepare, driver, record widening, the order UID frozen in the record, resume recovers
  submitted-but-unconfirmed orders by polling the order API, honest terminal on
  expired/cancelled, i18n x4. `92a2f515`: intent-sheet + state-panel wiring and the hermetic
  flow 226 pin. Rows at `92a2f515` dirty=no: flow 421.1s, test-app 291.1s, e2e 17.5s,
  e2e-visual 15.1s, verify composite, all PASS — overall VERIFIED. D31 discipline: the venue
  ships UNPROVEN until ONE live funds-ledgered ZCHF order through the real app (same rule as
  Uniswap V3 pre-trip); float has no EVM gas budget for a second live trip right now.

- **Swap-typing stage 2: the device signs its own CCTP burn (value 5/M; gates VERIFIED `0e60f985`)** —
  LANDED 2026-10-03, merged ff to main `0e60f985` (5 commits, 24 files +894/-161). (1) `27ca0189`:
  every cross-rail record freezes `burnSigner` ('device' | 'walletconnect') at prepare time, so a
  record survives restarts without forgetting WHO signs the crossing. (2) `810d1a7c`: the burn
  executor signs `approve` + `depositForBurnWithHook` on-device (fee-first with a frozen maxFee,
  gas gate, adoption-by-receipt); WalletConnect handoff stays as the override for those who
  prefer it. (3) `b0d252a9`: the sheet forks on disclosure - the device-signed path names the
  wallet as the burner; a refused burn is an honest dead-end copy, 4 locales. (4) `34526684`:
  flow tier drives the crossing via `installEvmRpcStub` (flows 186/195/200/209 rewritten);
  CeFi pins 187/194/197/198/199/208/223 untouched. (5) `0e60f985`: the smoke manifest points at
  `app/__tests__/cctpBurnSigner.test.ts` (house convention: manifest entries resolve against
  `__tests__/`). Slow-suite rows at the pre-rebase head `a63c724d` (flow 305.3s, test-app
  323.1s, dirty=no) + full gate chain on merged main (all 8 rows PASS dirty=no, e2e 16.2s,
  e2e-visual 14.6s, flow 402.2s, test-app 392.2s). Remaining discipline: the live ZCHF->USDC
  CCTP funds-ledgered trip before any "supported" claim in-app (D31), same as the Uniswap V3
  precedent.

- **Founder UX wave + test-infra hardening (founder 2026-10-02, "clunky setup loop"; gates VERIFIED `c200d4cc`)** —
  LANDED 2026-10-03, merged ff to main `c200d4cc`. (1) UX: ONE busy line
  `M.deposit.ata.settingUp` ("Please wait, your account is being set up. This should take
  1-2 minutes.", 4 locales) unifying busy+live with a no-idle run window
  (`busy = ataSetupBusy || ataSwapPending`, `824e7976`); failed panel shows the REAL error
  first plus next steps (`errNextSafe`/`errNextUnknown`, `ataSetupErrKind` held/unknown set
  only by the record watcher); amount fields grow + font steps down with typed length
  (`d6cd79f0`, `convertAmountSizing.test.ts`, 7 call sites); duplicated failed-branch dead
  code deleted (`76e0364f`). (2) Test infra: flow 187/194/209 balance pins moved to the
  record-lifecycle cefi auto-deposit semantics (`f2ba046e`); `jest.bigint-ipc-env.js` — a
  failing `expect(BigInt).toBe(BigInt)` carried raw BigInts through jest 29.7's JSON worker
  serialization outside any test, killing whole suites as "failed to run" (`09d04900`);
  seeded per-test ceiling `30s x BUDGET_MAX 6 + 30s` (`f81eb387`) and explicit `it()` closers
  must use `budgetCeiling(ms)`, never `scaled()` frozen at install factor (`a56279cd`);
  flow 214 kill arm gets one budget-scaled window per phase (`19cb7a51`); flow 223's
  awaited exact-debit pin (`71e84dbd`) SUPERSEDES the earlier "223 inverted hermeticity"
  framing — it was a stale pin + an async race, not hermeticity. (3) Root product fix for
  the recurring 214 kill-arm strand: the convert engine's `inflight` is now
  `Map<recordId, engineSession>` — a killed session's draining drive is a ghost that blocks
  nothing; the remounted engine's boot sweep drives the record and only the owner clears
  its flag (`0b66a47d` RED, `be425a51` fix, `77c9651a` settle-wait pin, `c200d4cc` dead
  diag export removed).

- **2026-10-01 audit follow-ups: F4/F6/F8-F15 + one setup card** — LANDED 2026-10-03,
  merged to main `f5e900fe` (7 commits, rebased). F4: Pay/Convert read the
  offline-adjusted SOL states (`Wallet.tsx`), and the extraction pin caught a real
  `slice(8)` off-by-one silently disabling all SPL offline deductions. F6+F13: balances
  carry `amountRaw`; `chooseRail` ranks the funded class by magnitude; readiness keys off
  raw amounts. F11: exact decimal comparison in the convert auto-pick. F9+F10:
  `fetchConvertQuote` requires its named venue (no bundled first-venue fallback); dead
  `resolveConvertDirection` deleted. F12: derived ICP ledger lookup (no `currency === 8`);
  OCP refusal keys on the SPL class. F8+F14+F15: ATA fund quotes every wrapped-SOL venue
  (venue id rides to confirm); stable-id fitness ties; sorted SOL registry walk.
  Card merge: ONE `AtaSetupCard`, `surface`-discriminated; `SolanaAtaSetupCard.tsx`
  deleted; 4 sheet callers keep exact testIDs. Gates: all 8 rows PASS dirty=no @
  `f5e900fe` (flow 413s, test-app 372s, e2e/e2e-visual green), smoke 697/697 (8 new
  audit pins). Earlier DONE from this list 2026-10-02 (`2060259c`): source line always
  renders, hidden-source gone, money actions mask, dead expander deleted. Full
  15-finding report: ses_f068eb67dffeadjrElCVm5z8d9.

- **P0 composed-strand + stuck-record waves (founder 2026-10-02, live-device findings)** —
  LANDED 2026-10-02, both merged to main `4157d272`. (1) COMPOSED fund-ic strand (POCO
  evidence `/tmp/opencode/p4`-`p15`: leg-1 settled on-chain, deposit never sent, card idle
  with button re-armed over a live record = double-spend invitation): the deposit send moved
  into the RECORD lifecycle — the watcher/resume path sends the cefi deposit for ANY
  non-terminal record at `awaiting_deposit` (composed AND direct), once per record via a
  persisted marker, restart-safe; `unknown` poll outcomes hand the run to the watcher; the
  setup card renders a LIVE state keyed on absent-target records (never idle-with-button
  while money moves). Commits `4012915a` (live card), `ba50bd86`/`a0fd87ff` merges,
  engine+card wave `fcb9c60f..a0fd87ff`. (2) STUCK records (founder's VCHF→ICP→SOL composed
  record sat past its window with no terminal state): the engine now RESOLVES expired stuck
  records to an honest terminal state instead of probing forever, and all six stuck surfaces
  show the evidence, the real error, and the dead window (`stuckExpiry.ts` + `stuckProbeLog.ts`;
  commits `72fe67a3`, `222bf443`, `4cfbaf68`, rebased `4157d272`). PROCESS landed with it:
  CLAUDE.md "money in motion is never silent" (`cb4d1bd8`, 3-evaluator consensus) + the
  global continuous-improvement meta-rule; qualification pins are family-scoped (the
  real-relay 216 pin is GREEN on main; existing families add theirs when next touched).

- **Connection-blame copy sweep** — DONE 2026-09-30 (merged `74c57e16`): `classifyTransportFailure`
  extracted to `app/transportFailure.ts` (+ `classifyIcReadFailure`), swept across fee /
  deposit / receive / checkout / engine surfaces, 4 locales, both arms jest-pinned; the flat
  "check your connection" engine copy retired.
- **Any-to-any GOAL implementation + founder UX gaps 1+2 (review 2026-09-30)** — LANDED
  2026-09-30: capability-derived matrix + Uniswap V3 adapter + WETH hub fallback (`73d4afb5`);
  one-tap ATA setup, a single "Complete setup" button, wallet-wide badge (`5d120a1c`; also
  fixed the SOL send sheet's inert confirm under unaffordable venue-deposit rent); swap
  payouts default to the wallet's OWN address with typed destination demoted
  (`5cc18f64`) and every asset row gets the Convert action (`b5dfe0fd`). The D31 live ZCHF
  trip remains in the work order; swap-typing stage 2/3 and the CeFi residual filed above.
- **ATA-setup UX defects (on-device report 2026-09-30: "Einrichtung nötig" twice per row,
  explains-only dead end)** — DONE 2026-09-30 (atafix wave `3e1f87e9..cde178e3`): ONE
  wallet-level banner replaces the duplicated per-row affordances (`28df5ce2`); the button
  ALWAYS acts - create = one tap, SPL fund = tap + confirm, new fund-ic kind swaps IC-side
  money (ckUSDC/VCHF/ICP) to SOL through the convert engine with venue-minimum sizing
  (`37693989`, `7a319659`, flow 214 pins it end to end `d72a803e`); a proven-unfundable run
  flips the banner to the honest refuse panel with the SOL receive address + copy
  (`2a34a00a`); name column fits its longest word and needSol names SOL exactly once
  (`d777eba6`); banner lines share one left alignment (`1e3f83fe`); accounts visual
  baselines reseeded light+dark (`cde178e3`). Verified on emulator (screencap rounds 1-4).
  Follow-up device defect ("setup still doesn't work" 2026-10-01): the tap fired but the
  refuse verdict was wiped ~100ms later - the identity-keyed reset effect re-armed the
  button whenever a balance poll re-created the plan model. Fix: verdicts reset on a plan
  SIGNATURE, never on model identity, and beginAtaSetup gained a catch (never silent idle)
  (`5b3345b2`, flow 214 churn arm + device re-drive: refuse stands through live polls).
  Regression guards: hard-rule comments pin the one-affordance + always-actionable
  invariants (`dc488ba5`).
- **Setup UX wave 2 (founder 2026-10-01: global banner unwanted, hidden source pick, real
  failures swallowed as "you can try again")** — DONE 2026-10-02 (`setupfix` wave
  `82e4b0da..4487fbd6`): the wallet-level banner is GONE; setup lives ONLY in the tapped
  currency's own view, one card per currency, per-currency testIDs; sizing is QUOTE FITNESS
  across ALL registered venues and routes (smallest input at a live-verifiable minimum,
  registry tie-break) - list position can no longer pick a route (`b15d813d`); the source
  asset and the exact minimum are stated UP FRONT, before any press; failures surface the
  venue's real cause (`failureDetail` verbatim) and the card's own copy never promises a
  hollow retry in any locale (`92604120`); flow 214 drives the fund-ic setup through the
  currency view (`7c9daa6c`) and its churn arm stands (`2adf26bf`); flow 27's ledger-row
  assert waits for the row, not the screen (`4487fbd6`). Root-cause depth: the incident's
  idiom was "registry/array position is policy for an autonomous money decision" - audit
  found 15 findings (ses_f068eb67dffeadjrElCVm5z8d9 report); the money-affecting trio
  (F1 fund-ic walk, F2 SPL fund walk, F3 first-venue pick) is FIXED; F4-F15 filed below.
  All 8 gate rows green on `4487fbd6` (verify/e2e/e2e-visual/flow/test-app/smoke/core/
  typecheck), dirty=no. LIVE GOOD-PATH TRIP DONE 2026-10-02 on the emulator with the
  float's play money (founder-sanctioned): trip2 (3 VCHF, 0 SOL, absent ATAs) -> card
  named ICP as source at the floating venue minimum -> the device itself sent the
  0.89848158 ICP deposit to the venue's LEGACY 64-hex account id (dispatch +
  `prepareLegacyTransfer`, `3596cee1`) -> SideShift settled 0.02402112 SOL to the rail ->
  the legacy reply decoder no longer aborts on moved money (terminal-but-opaque,
  `bda6d8a0`) -> one tap created both ATAs (rent 0.00149344) -> card and badges cleared,
  ATAs verified on-chain (USDC `8g1Qxk...`, EURC `3uRDom...`). Audit-copy wave
  (`2060259c`): the confirm sentence names each fact once (no "0.90 ICP of your ICP"), no
  venue/Anbieter jargon, the create card names its payer, a running setup masks the money
  actions, the dead expander machinery deleted; flow 212 waits for the settled headline
  (`67e2e854`). Final gates: all 8 rows green on `67e2e854`, dirty=no, overall VERIFIED.
  D31 note: this trip ran on the emulator with float funds via the prod relay; the
  founder's physical POCO re-drive stays available whenever the device is plugged in.

- **CHAIN route deposit broadcast** — RESOLVED 2026-09-29 same day (`dfde0468`, live-proven D33):
  `submitRawSolTx` adopts `skipPreflight: true, maxRetries: 0` and the rpcFetch walk widens to
  preflight-shaped refusals (same bytes, no re-sign, dedup by signature); pin
  `app/__tests__/chain-deposit-submit.test.ts`. D33 in-app chain row EURC→VCHF settled at the 1%
  floor to the last digit; ledger rows 207–212, reconcile CLEAN.
- **VCHF multichain verification** — DONE 2026-09-30 (`a75f371d`): 7 canonical chains, issuer
  burn/mint bridge, CHF rails = ROUTING; spec +
  `CODEBASE_ANALYSIS.md` § "VCHF multichain verification".
- **Objectives 2/3/3b/3c (conversion PoC, multi-venue readiness, swap-venue expansion,
  conversion-coverage expansion)** — DONE 2026-09-07..09-19: specs
  `2026-09-07-delegated-conversion-spec.md` (hardening plan `2026-09-08` found + fixed the
  reversed pool direction), `2026-09-08-multi-venue-readiness.md` (V1–V10),
  `2026-09-14-swap-venue-feasibility.md` (+ multihop spec), `2026-09-16-convert-coverage-expansion.md`
  (12 venues; the probe's 77×-mispricing evidence unregistered `icpswap-ckusdc-cketh`).
- **Objectives 5/F2 (funding routes)** — DONE 2026-09-09/12: six deposit surfaces; the resolver
  defect corrected; `PublishedCost` model; spec `2026-09-09-funding-routes-plan.md`.
- **Objective 4 (first-run experience)** — DONE 2026-09-08/09: Home overview landing, practice
  payment (`Practice.tsx`, flows 152–156); specs `2026-09-07-ux-decisions.md` +
  `2026-09-08-first-run-redesign.md`.
- **Objective 6 (till→checkout rename)** — DONE 2026-09-24: signed domains
  `dpay-checkout-open-v1/v2`, full-tree sweep incl. inflections; history in git.
- **Objective 7 (IC hub 2-hop generalization)** — DONE 2026-09-18: `hubRoutes` + 4-leg
  single-pass signing + D1–D6 destination UX; jest `convertHub.test.ts` (33) + flow 190.
- **Objective 8 (multi-currency build-out wave)** — DONE 2026-09-24: send terminal, CeFi
  lifecycle honesty + abort window, currency-grouped accounts, checkout settlement pick,
  grouped convert destinations, Trocador no-quote honesty + the generated convert matrix
  (flows 201–209). Its one open follow-up survives above (asset inside the signature).
- **Solana rails (dead key + R1/R2/R3/R4, S2/S3)** — DONE 2026-09-09..12: replacement key live,
  one `relayFetch` client, the `/api/v1/solana/rpc` proxy + cache, the 4-state transport
  classifier (`app/solana.ts`), the class-split receive copy, the single `getMultipleAccounts`
  poll. Full record: `docs/specs/2026-09-09-relay-ha-and-solana-proxy.md`.
- **EVM rail (generic ERC-20 custody)** — DONE 2026-09-26..28, LIVE-PROVEN by the D31 mainnet
  ZCHF round trip (buy via Uniswap V3 through the relay pipe, in-app send, offline-permit claim
  loop; ~CHF 2.7 of the CHF 25 ceiling). Spec `2026-09-26-evm-rail-spec.md` + addenda; per-leg
  table in `docs/live-testing/networks.md`.
- **PROD STATE history + the 2026-09-14 floor notes** — superseded by the derived floor
  (AGENTS.md; `just floor` resolves it; verify now recorded at the live commit `c7961d39`).
- **UX swarm 2026-09-08** — nothing open remained (the converge-on-"show my VCHF address"
  finding drove the first-run redesign); disposition records live in the two specs above.
- **Request QR = payment link** — DECIDED + DONE 2026-09-12 (founder reversal, shipped same day,
  flow 176; machine codes only on radio/confirm paths). No open residue.
- **`just demo` settles at HEAD** — fixed 2026-09-12 (demo-ledger env + real `icrc_ledger` +
  operator IC-gateway override, DEMO.md rewritten).
- **OCP tx-id fix** — prod-proven both spellings (`a913c6d`); tripwires `just ocp-ledger-probe`
  + flow 113; the DFX "CHF 1" residual written off by the founder 2026-09-14.
- **Helius key baked as a literal** — RESOLVED by R2 (key/url live in relay deploy config only);
  rotation before any repo publication stays the founder's call (git history keeps old literals).
- **History-name annotations** — SUPERSEDED 2026-09-11 by device-saved `txNotes`; the wire stays
  frozen. The open founder follow-up (signed registry) survives above.
- **Default-tab / first-impression** — REVERSED by the founder 2026-09-08 (opens on Home).
- **SOL glyph `◎`** — RESOLVED 2026-09-14: `•` U+2022 (covered by all four bundled faces).
- **Deploy-script candid-literal drift** — RESOLVED 2026-09-14: parameterized builders in
  `deploy/dfx-lib.sh`; byte-parity gate `just dfx-arg-parity`.
- **SideShift return legs (attempts #1–#10 narratives)** — DONE 2026-09-22: EURC→ICP and
  ICP→EURC both settled at the quoted amounts to the last decimal; disposition detail in git
  history at this file's pre-prune state.
- **Convert settle-probe budget parking records on `stuck`** — FIXED 2026-09-27 same day: the
  swap-unknown arm runs the pre-park ledger watch; pinned both ways in convert.test.ts. (The
  stuck→done reopen flip is e2e-covered offline only.)
- **Prod-relay deploy of the 2026-09-19/20 waves** — DONE 2026-09-27 (prod at `ef37c12` +
  `3bc53ff`; conversions no longer wedge; SideShift credential live).
- **Person-to-person request = price (gross display)** — RESOLVED by founder decision
  2026-09-14, offline half `9ec2a36`→`812f661`; wires stay netted, gross rides note metadata.
- **IC chain-key receipt migration** — RETIRED as stale 2026-09-06 (zero consumers post-cutover;
  clause: re-derive from scratch if the facade kernel re-enters the value path). The
  `dpay_core` receipt primitives stay, kept deliberately.
- **Canister-side `refresh_deposit` rate-gate** — MOOT (nothing calls it post-cutover; left in
  place under the leave-in-place precedent).

## Severity legend

- **HARD blocker** — blocks a specific path until an *external* step lands; cannot be fixed in
  code in this repo.
- **high** — should land before pilot.
- **medium** — production/scale tradeoff; defer with the documented mitigation in place.
- **low** — polish / config invariant.
