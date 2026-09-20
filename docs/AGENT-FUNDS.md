# Agent test float — mechanism

The binding spend rules live in `CLAUDE.md` ("Non-negotiable: the agent test float"), because they
must be in context every session. This file is the mechanism and the record; it does not restate
the rules.

## Why this key exists

Some things about dpay's mainnet rails cannot be proven any other way. Verified 2026-09-01: the
OpenCryptoPay payment provider has **no sandbox** — `dev.api.dfx.swiss` is 502 and every method in a
live quote is mainnet. The same was true of the funded-transfer proof for VCHF and native ICP, which
the founder closed on 2026-09-01. A small real float is the only instrument that closes this class
of proof.

## The OpenCryptoPay payment test — use the €0.01 gateway (founder direction, 2026-09-04)

**`https://dfx.shop/produkt/dfx-testing-product/` — €0.01 — is the route to use.** Not the CHF 1
public test till (`artifacts/spar-test-till-qr.png`), which is fixed-amount and 100× the price. The
till stays as the fallback for the day the shop route turns out not to work.

Measured 2026-09-04, so the route is known to be real before anyone spends on it:

- the shop's own OpenCryptoPay code decodes to `https://api.dfx.swiss/v1/lnurlp/pl_3e6fe374fbc7dcb0`
  — the SAME provider and standard as the test till, so what it proves transfers;
- that link is a **Donation** link in `Public` mode with no pending charge, and the payer cannot
  supply the amount (`?amount=…` in four spellings all answer `404 No pending payment found`). A
  payable charge exists only after a real order is placed;
- so the test is a WooCommerce checkout — cart → checkout details → the OpenCryptoPay code — and
  **Claude drives the whole round trip in the browser**, order included, then pays the resulting
  charge from this float and verifies it with `just funds history`.
- The operator is the **DFX Merch Association**, not DFX AG. A separate counterparty from the one
  answering `api.dfx.swiss`, which is what the "ask before the first payment to a new counterparty"
  rule is about.

**Run it only when everything else is implemented and verified and this is the last pending check.**
Founder direction, and the reason is the loss path itself: the submission is one-shot, so every
attempt costs a real order at a real merchant and buys exactly one observation. An attempt spent
while something else is still broken is an attempt that proves nothing and cannot be repeated for
free. Green gates first (`just verify`, the device gate), then this.

**Completed 2026-09-05 — both spellings.** A freshly built physical-device app paid order `2609` in
native ICP. Ledger block `38,190,401` moved `0.00442682 ICP` plus the `0.00010000 ICP` fee, DFX
answered accepted for that exact block, and the shop rendered the order received. Later the same day
the same phone paid order `2610` in VCHF: ledger block `81,062`, submitted as the prefixed
`ly36x-…-cai:81062`, accepted. Both of DFX's tx-id spellings — bare index for native ICP,
`<ledger>:<index>` for every other ICRC ledger — are now live-proven with paid, credited orders.

## Commands

ONE entry point — `just funds <subcommand>` (founder ask 2026-09-20: a single way to do all of it):

    just funds                  # overview: EVERY wallet + EVERY live balance + the abandoned watch
    just funds address [W]      # the funding address, no decryption (W: icp-float | sol-float)
    just funds balance [W]      # live census for one wallet, measured (UNREADABLE is never 0)
    just funds history [W]      # what the money DID: ICP transfers + block indexes (IC wallets)
    just funds seed <W>         # the seed hex — DECRYPTS; only immediately before an approved spend
    just funds init <W>         # generate a NEW key for that wallet (refuses if one exists)
    just funds reconcile        # ledger-computed vs MEASURED — drift = unrecorded movement (exit 1)
    just funds doc              # re-render the GENERATED tables in this file from funds/

Wallet ids come from `funds/wallets.json`: `icp-float`, `sol-float`, `icp-float-old` (balance and
history also accept the abandoned id — measuring it is the watch). Recording a movement is part of
the same surface: `node scripts/funds.mjs add …` (hard rule — CLAUDE.md), then `just funds doc`.

The old recipe names (`just agent-balance`, `just agent-funds --seed`, `just agent-seed`,
`just funds-reconcile`, …) still work as DEPRECATED forwards — each prints a notice to stderr and
does exactly the equivalent above, byte-identically. They are deleted at the merge wave; do not
start new usage with them.

`just funds` is the one command a fresh session runs first: it prints every wallet the agent
controls (from the committed `funds/wallets.json` registry), each wallet's ADDRESS, and every live
balance measured at that moment. `just funds balance` remains the only balance statement for the IC
float; the overview renders it verbatim rather than reimplementing it. `just funds seed sol-float`
DECRYPTS and prints the SOL seed hex — same discipline as `just funds seed icp-float`: only
immediately before an approved spend.

`funds/` is the version-controlled record, and using it is a HARD rule (CLAUDE.md): every movement
of float funds — deposit, spend, conversion, fee, rotation — is appended to `funds/ledger.jsonl`
through `node scripts/funds.mjs add …` in the same session it happens. The JSONL is append-only
and never hand-edited; corrections are new `correction` rows. `just funds reconcile` compares the
ledger math against MEASURED balances and must be CLEAN before a session that moved funds claims
completion: DRIFT is an unrecorded movement (record it, never explain it away), UNKNOWN is a
balance nobody measured and is never treated as zero.

`just funds balance` is the only source of truth for what the float holds. Never state a balance
from memory or from this file — measure it. An unreachable ledger prints `UNREADABLE`, never `0`.

`just funds history` is how a spend is VERIFIED rather than reported. A payment made on a phone appears
here as an outgoing transfer with its amount, its destination and its block index — and for an
OpenCryptoPay payment that block index is the exact proof the wallet reported to the provider, so
"it paid" can be checked against the ledger instead of taken on trust. It reads the official ICP
index pinned in `dfx/catalog_truth.json`, and dies loudly rather than printing an empty history it
never actually read: after a real payment, "no transactions" and "could not ask" are opposite
answers.

## Wallet registry

Every wallet the agent controls, so a fresh session or a fresh context can find them all with one
read. The authoritative copy is the COMMITTED `funds/wallets.json` (founder ask 2026-09-19: the
record is version-controlled); this table is RENDERED from it by `scripts/funds.mjs doc` — edit
the JSON, never the table. The former gitignored `.dev/agent-wallets.json` is retired.

<!-- GENERATED:wallets -->
_GENERATED by `scripts/funds.mjs doc` from `funds/` — do not hand-edit. Record a movement with `node scripts/funds.mjs add …` (hard rule), then re-render with `just funds doc`._

| Wallet | Chain | Address | Secret | Status | What it is for |
|--------|-------|---------|--------|--------|----------------|
| `icp-float` | icp | `vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae` | `secrets/agent-icp.sops.json` | live | The mainnet test float itself — `just funds` measures EVERY ICRC ledger in the bundled catalog (currently ICP / VCHF / ckUSDC / ckBTC / ckETH); rules in CLAUDE.md, record in funds/ledger.jsonl; custody `scripts/agent-key.mjs` |
| `sol-float` | solana | `4CuaczYGkB4yXmB2op59JKeCd5G6rNBzTSfzSNitUsmU` | `secrets/agent-sol.sops.json` | live-unfunded | Solana-side float (native SOL + USDC/EURC SPL); funded via the SideShift partner key (secrets/sideshift.sops.json) or a direct founder drip; custody `scripts/agent-sol.mjs` |
| `icp-float-old` | icp | `lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe` | none (destroyed) | **abandoned — NEVER FUND** | Pre-rotation principal, compromised 2026-09-05 (partial key disclosure into a local tool log) and emptied by the same-day rotation; seed DESTROYED — a misdirected send here is unrecoverable. `just funds` watches it; `funds reconcile` anchors it at measured 0 |
<!-- /GENERATED:wallets -->

Both live secrets are sops-encrypted with the SAME age identity (`.dev/age/agent-key.txt`), so the
Recovery rule below covers both wallets: one identity to back up, and losing it strands both.

### The SOL wallet's funding path (resolved 2026-09-19: the founder provided the SideShift partner key)

The SOL wallet was created unfunded and the agent had NO keyless route to fill it: SideShift — the
only IC→SOL conversion route — requires a partner key for every quote/order (`x-sideshift-secret`;
measured 2026-09-19: `/permissions` and `/shifts/{id}` are keyless, creation is not). The founder
provided the partner account the same day; it is stored sops-encrypted at
`secrets/sideshift.sops.json` (same age identity as the seeds; contains the account secret and the
affiliate id). A relay run with `DPAY_SIDESHIFT_SECRET` / `DPAY_SIDESHIFT_AFFILIATE_ID` decrypted
from that file makes the CeFi venues live; the device still never sees the key.

Measured pair minimums that size any agent CeFi spend (2026-09-19): ICP→SOL min deposit
**1.0357 ICP**; EURC(SOL)→ICP min deposit **8.702923 EURC**. Both are founder-approved for the
FX-matrix live proofs (value moves between the agent's OWN wallets; net cost is the shift fee).

~~To fund the SOL wallet: shift ICP from the IC float to `4CuaczYGkB4yXmB2op59JKeCd5G6rNBzTSfzSNitUsmU`, or the founder drips SOL directly.~~ **DONE 2026-09-20 — but the funded rail is the app-DERIVED address, not this registered wallet.** The app signs SOL transfers ONLY from the SLIP-10 `m/44'/501'/0'/0'` key derived from the IC float seed (`app/solana/identity.ts`), so an in-app CeFi shift settles at `BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX` and the registered raw-seed `sol-float` (`4Cuacz…`, which no app code can sign from) stays measured-0 by design. The shift ran 2026-09-20 09:02:24Z: order via the real Convert UI (venue `sideshift`, partner-key proxy) → deposit icp block 38488907 (1.08 ICP exact) → **SOL 0.02744109 at `BzFNJ…` in 24 s** (`sol:5KKQUqG9…TWN`) — first live CeFi order in dpay history; the SOL rail then proved Jupiter swaps both ways live (SOL→USDC, USDC→EURC, EURC→USDC) and the reverse IC pool leg ckUSDC→VCHF filled (record 81765). Rows 40-54; `just funds reconcile` CLEAN. Measure the derived rail with `node e2e/live-sol.mjs` — `just funds` shows sol-float at 0 and that is correct, not a gap.

**First live attempt (2026-09-20, FX-matrix phase 1) — BLOCKED at the quote layer, zero spend.**
Driving the real app against the local partner-key relay (ICP→SOL via `sideshift`, settle at the
app's own derived SOL rail `BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX` — see below), the UI
reached the CeFi surface (route leaf, mechanism, settle-address gate all green) but the venue
quote never rendered. Root cause, measured through the relay's proxy with the exact registered
pair: SideShift's upstream refuses every partner request whose `x-user-ip` is not a PUBLIC end-user
IP — verbatim: `{"error":{"message":"The x-user-ip header must be set to the end-user IP address"}}`.
The relay forwards its TCP peer (`ClientIp`, `sideshift.rs:195`); a local peer is loopback/LAN
(trycloudflare tunnel included — cloudflared connects over loopback), so LOCAL partner-key proofs
are structurally impossible until the relay honors a trusted-proxy header (`X-Forwarded-For` when
the peer is loopback/private) in `sideshift.rs`. Prod additionally needs the partner key wired per
docs/OPS.md §3 (checked 2026-09-20: prod at commit `44762b3` answers `sideshift-unconfigured`).
Nothing moved on-chain; the driver's pre-signature gates refused all spends. Also corrected by
this attempt: the APP's Solana rail address is NOT the `sol-float` wallet — `app/solana/identity.ts`
derives it by SLIP-10 ed25519 m/44'/501'/0'/0' FROM THE IC float seed (one backup recovers both
rails), so any in-app shift settles at `BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX`, not
`4Cuacz…` (the registered `sol-float` is an independent raw-seed key no app code signs from;
measured 0 via `just funds` throughout; watch the derived address with `node e2e/live-sol.mjs`).

## Funding the float — do not guess the address

A top-up sent to a wrong address string is not recoverable by care — only by procedure. The old
float principal `lrdna-…-mqe` (full form in the registry above) is DESTROYED: its seed no longer
exists anywhere, so a misdirected send there is gone forever. `just funds` watches it every
run and trips a loud MISDIRECTED FUNDING alarm if funds ever appear — but the alarm is the
post-mortem, the procedure below is the prevention:

1. run `just funds address` and copy the address from ITS OUTPUT — never from memory, chat
   scrollback, or an older doc;
2. paste-send the top-up;
3. within a minute run `just funds history` and CONFIRM the IN row — only then is the top-up
   considered landed.

Same discipline for the SOL wallet: `just funds address sol-float`, paste-send, then `just funds`
must show the arrival before anything depends on it.

## Recovery

Two independent halves, and you need both:

- `secrets/agent-icp.sops.json` + `secrets/agent-sol.sops.json` — the encrypted seeds (IC float,
  SOL wallet). Committed; survive any clone.
- `.dev/age/agent-key.txt` — the age identity, the ONE key that decrypts both. Gitignored, and
  `.dev/` is **not** backed up.

So the age identity is the single point of failure. **Back up that one line to a password manager.**
Without it the encrypted seed is unrecoverable and anything the float holds is gone.

The seed is a plain 32-byte Ed25519 seed and the principal is derived by the same committed wasm
core the app signs with, so this is a real dpay identity — not a script-only key. A plain node
script cannot print it as a 24-word mnemonic (`app/lib/bip39.ts` reaches the RN i18n module through
`app/lib/format.ts`, so it will not load outside the app), but the mnemonic is not the way in:
Onboarding restores from the **64-hex seed** directly (`restoreMode: 'hex'`, `app/components/
Onboarding.tsx`), which is exactly what `just funds seed icp-float` prints. So an on-device funded test with
this float is possible today, with no code change.

## Known limits of the encryption

An encrypted blob in git is safe to push or mirror. It is **not** protection against local
compromise: anyone with read access to this working copy has both halves on the same disk. And a
commit is forever — if this key is ever rotated, the old encrypted blob stays in history. That is
acceptable only because the float is capped. It is why the cap matters. Both halves of that
tradeoff were exercised on 2026-09-05: the key was rotated after a partial local disclosure (spend
log below), and the old encrypted blob does remain in history — worthless now, because the old
principal is empty and must never be funded again.

## Spend log

The chain records *what* moved; it does not record *why*. That is this table's only job — it is not
a second copy of the balance. The authoritative record is the COMMITTED, APPEND-ONLY
`funds/ledger.jsonl`; this table is RENDERED from it by `scripts/funds.mjs doc`. Record a movement
with `node scripts/funds.mjs add …` in the same session it happens (hard rule — CLAUDE.md), then
`just funds doc`; a row hand-written here would be lost on the next render.

<!-- GENERATED:spendlog -->
_GENERATED by `scripts/funds.mjs doc` from `funds/` — do not hand-edit. Record a movement with `node scripts/funds.mjs add …` (hard rule), then re-render with `just funds doc`._

| Date | Kind | Wallet | Asset | Amount | To / From | Tx | Purpose |
|------|------|--------|-------|--------|-----------|----|---------|
| 2026-09-05 | spend | `icp-float-old` | ICP | -0.00442682 | DFX Merch Shop payment principal ygf2v-…-4ae (OpenCryptoPay) | `icp:38190401` | €0.01 OpenCryptoPay acceptance test, WooCommerce order 2609; DFX /tx answered accepted, shop rendered order received (+0.0001 fee) |
| 2026-09-05 | spend | `icp-float-old` | ICP | -0.01000000 | physical dpay test wallet vi7yz-…-eqe | `icp:38190338` | fund the freshly installed app wallet for the order-2609 test; app detected the exact deposit (+0.0001 fee) |
| 2026-09-05 | convert | `icp-float-old` | ICP | -0.01000000 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai (approve + depositFromAndSwap) | `icp:38193124` | founder-authorized one-off ("try to swap with icpswap"): acquire the VCHF the prefixed-acceptance test needs — external float tooling, NOT a dpay product feature; swap returned exactly the quoted 0.02119881 VCHF (+0.0001 fee) |
| 2026-09-05 | convert | `icp-float-old` | VCHF | +0.02119881 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai | — | proceeds of the founder-authorized ICPSwap acquisition (icp:38193124); VCHF-side block not recorded at the time |
| 2026-09-05 | spend | `icp-float-old` | VCHF | -0.02000000 | physical dpay test wallet vi7yz-…-eqe | `vchf:81061` | fund the phone with the swapped VCHF for order 2610; phone received exactly 0.02 VCHF (+0.0001 fee) |
| 2026-09-05 | spend | `icp-float-old` | VCHF | -0.00950150 | DFX Merch Shop payment principal ygf2v-…-4ae (OpenCryptoPay) | `vchf:81062` | €0.01 prefixed-acceptance test, WooCommerce order 2610 (link pl_136966f8a5d2aa1d, submitted as ly36x-…-cai:81062); DFX accepted — first paid post-fix prefixed acceptance (+0.0001 fee) |
| 2026-09-05 | convert | `icp-float-old` | ICP | -1.97960000 | rotation to the new float principal vloyo-…-5ae | `icp:38193953` | key rotation after partial key disclosure (63/64 DER chars echoed into a local tool log — the key-leak incident in docs/AGENT-FUNDS.md); move everything off the compromised key (+0.0001 fee) |
| 2026-09-05 | convert | `icp-float` | ICP | +1.97960000 | rotation in from the pre-rotation principal lrdna-…-mqe | `icp:38193953` | key rotation — float intact on the new principal |
| 2026-09-05 | convert | `icp-float-old` | VCHF | -0.00089881 | rotation to the new float principal vloyo-…-5ae | `vchf:81063` | key rotation (+0.0001 fee) |
| 2026-09-05 | convert | `icp-float` | VCHF | +0.00089881 | rotation in from the pre-rotation principal lrdna-…-mqe | `vchf:81063` | key rotation — float intact on the new principal |
| 2026-09-19 | convert | `icp-float` | ICP | -0.20000000 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai (in-app Convert ICP→VCHF) | `icp:38468498` | flow-04 live matrix: the approve-fix proof — first successful end-to-end in-app conversion on mainnet (AllowanceChanged used to wedge every conversion at Approving); received exactly the quoted 0.46359507 VCHF (+0.0002 fees) |
| 2026-09-19 | convert | `icp-float` | VCHF | +0.46359507 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai | `icp:38468498` | proceeds of the ICP→VCHF conversion (quote-exact; min 0.45947612 at 1% slippage) |
| 2026-09-19 | convert | `icp-float` | VCHF | -0.40000000 | icpswap pool hx7nb-diaaa-aaaar-qbxsa-cai (in-app Convert VCHF→ckUSDC) | `payout-record:783528` | the founder's exact failing pair proven: approve fix + stale-quote guard; destination pick re-quotes and the confirm re-quote gate passed clean (+0.0002 fees) |
| 2026-09-19 | convert | `icp-float` | ckUSDC | +0.479610 | icpswap pool hx7nb-diaaa-aaaar-qbxsa-cai | `payout-record:783528` | proceeds of the VCHF→ckUSDC conversion (done panel: 0.47961 USDC received in your wallet) |
| 2026-09-19 | convert | `icp-float` | ICP | -0.30000000 | icpswap pool xmiu5-jqaaa-aaaag-qbz7q-cai (in-app Convert ICP→ckBTC) | `ckbtc:4642280` | flow-04 live matrix: the 2026-09-16 ckBTC pool proven forward on mainnet (+0.0002 fees); received 0.00001045 ckBTC (pool mint memo …94643) |
| 2026-09-19 | convert | `icp-float` | ckBTC | +0.00001045 | icpswap pool xmiu5-jqaaa-aaaag-qbz7q-cai | `ckbtc:4642280` | proceeds of the ICP→ckBTC conversion |
| 2026-09-19 | fee | `icp-float` | ICP | -0.00010000 | icpswap pool xmiu5-jqaaa-aaaag-qbz7q-cai | — | approve fee of the same-pair re-run that exposed the settlement-probe false-positive: a fresh browser store claimed the EARLIER run's payout row and showed Converted while on-chain only the approve had executed; the allowance expired unused. Fixed same day, commit 9b66796 |
| 2026-09-19 | convert | `icp-float` | ckBTC | -0.00000045 | icpswap pool akhru-myaaa-aaaag-qcvna-cai (in-app Convert ckBTC→ckETH) | — | flow-04 live matrix: the ckBTC↔ckETH pool proven forward (tiny lot — the float only ever held ~0.00001 ckBTC; 1045 → 980 sats incl fees) |
| 2026-09-19 | convert | `icp-float` | ckETH | +0.000011650912378492 | icpswap pool akhru-myaaa-aaaag-qcvna-cai | — | proceeds of the ckBTC→ckETH swap, derived from measured census deltas (total 0.000172922157434988 minus the ICP→ckETH proceeds below); on-chain block not captured at the time |
| 2026-09-19 | convert | `icp-float` | ICP | -0.15000000 | icpswap pool angxa-baaaa-aaaag-qcvnq-cai (in-app Convert ICP→ckETH) | — | flow-04 live matrix: the SIXTH and last registered IC pool — every direct conversion pair now live-proven (+0.0002 fees); received 0.000161271245056496 ckETH |
| 2026-09-19 | convert | `icp-float` | ckETH | +0.000161271245056496 | icpswap pool angxa-baaaa-aaaag-qcvnq-cai | — | proceeds of the ICP→ckETH conversion (on-chain confirmed per the done panel) |
| 2026-09-19 | fee | `icp-float` | ckUSDC | -0.01000000 | icpswap pools mohjv-bqaaa-aaaag-qjyia-cai + angxa-baaaa-aaaag-qcvnq-cai (hub leg-1 approve) | — | flow-04 live matrix hub attempt — ORIGINAL interpretation: leg-1 approve fee only, "no swap filled", float after 0.12961 ckUSDC; CORRECTED by the correction row below |
| 2026-09-19 | deposit | `icp-float` | ICP | +0.06923693 | bca85666f3d2de1d135d399a9ccc96d38090601e784e1e5467b87fb3334ec1e0 | `icp:38469400` | IN row unattributed at log time — resolved: hub leg-1 payout (see the correction row) |
| 2026-09-19 | deposit | `icp-float` | ICP | +0.03461702 | bca85666f3d2de1d135d399a9ccc96d38090601e784e1e5467b87fb3334ec1e0 | `icp:38469853` | IN row unattributed at log time — resolved: hub leg-1 payout (see the correction row) |
| 2026-09-19 | correction | `icp-float` | ICP | +0.00000000 | — | `icp:38469400/38469853` | CORRECTION of the 2026-09-19 hub row: leg-1 (ckUSDC→ICP, pool mohjv-bqaaa-aaaag-qjyia-cai) DID fill — 0.34 ckUSDC swapped into the two IN rows above totaling 0.10385395 ICP. Evidence: the payer account id equals pool mohjv's default account id EXACTLY (wasm-derived 2026-09-19; one match among all six pool candidates), and the arithmetic closes exactly: 0.47961 − 0.01 fee − 0.12961 measured-after = 0.34 out, and the ICP float-after figures close with +0.10385395 in. The wedge was leg-2 (ICP→ckETH in angxa), not swap-1. ~0.104 ICP of the float is unspent leg-1 proceeds. |
| 2026-09-19 | fee | `icp-float` | ckUSDC | -0.010000 | icpswap pool hx7nb-diaaa-aaaar-qbxsa-cai (approve spender) | `null` | FX-matrix live proof A — REVERSE pool swap ckUSDC→VCHF through the real app UI (0.1 USDC in, min 0.08048997 VCHF at 1%): icrc2_approve EXECUTED on-chain (fee burn is the only movement; balance 0.129610→0.119610) but the pool's depositFromAndSwap never pulled — no payout/refund in ~25 min (VCHF 0.06429388 unchanged; no ckUSDC index row ≥783534); the 0.1 principal was never at risk (allowance expired unused 22:30 CEST). Reverse pool leg NOT proven; forward was proven earlier today (payout-record 783528). UI behaved honestly: Unknown-outcome panel stated exact terms + expiry |
| 2026-09-20 | genesis | `icp-float` | ICP | +1.43275395 | — | — | measured opening balance (live census via balance --json) — ledger rows above this anchor are absorbed history; reconcile counts only rows after it |
| 2026-09-20 | genesis | `icp-float` | VCHF | +0.06429388 | — | — | measured opening balance (live census via balance --json) — ledger rows above this anchor are absorbed history; reconcile counts only rows after it |
| 2026-09-20 | genesis | `icp-float` | ckUSDC | +0.129610 | — | — | measured opening balance (live census via balance --json) — ledger rows above this anchor are absorbed history; reconcile counts only rows after it |
| 2026-09-20 | genesis | `icp-float` | ckBTC | +0.00000980 | — | — | measured opening balance (live census via balance --json) — ledger rows above this anchor are absorbed history; reconcile counts only rows after it |
| 2026-09-20 | genesis | `icp-float` | ckETH | +0.000172922157434988 | — | — | measured opening balance (live census via balance --json) — ledger rows above this anchor are absorbed history; reconcile counts only rows after it |
| 2026-09-20 | genesis | `icp-float-old` | ICP | +0 | — | — | measured opening balance — the abandoned principal, anchored at its measured 0 so the agent-funds watch and reconcile certify it empty |
| 2026-09-20 | genesis | `icp-float-old` | VCHF | +0 | — | — | measured opening balance — the abandoned principal, anchored at its measured 0 so the agent-funds watch and reconcile certify it empty |
| 2026-09-20 | genesis | `icp-float-old` | ckUSDC | +0 | — | — | measured opening balance — the abandoned principal, anchored at its measured 0 so the agent-funds watch and reconcile certify it empty |
| 2026-09-20 | genesis | `icp-float-old` | ckBTC | +0 | — | — | measured opening balance — the abandoned principal, anchored at its measured 0 so the agent-funds watch and reconcile certify it empty |
| 2026-09-20 | genesis | `icp-float-old` | ckETH | +0 | — | — | measured opening balance — the abandoned principal, anchored at its measured 0 so the agent-funds watch and reconcile certify it empty |
| 2026-09-20 | genesis | `sol-float` | SOL | +0 | — | — | measured opening balance — the wallet starts unfunded (SideShift partner key now available for the first shift) |
| 2026-09-20 | genesis | `sol-float` | USDC | +0 | — | — | measured opening balance — the wallet starts unfunded (SideShift partner key now available for the first shift) |
| 2026-09-20 | genesis | `sol-float` | EURC | +0 | — | — | measured opening balance — the wallet starts unfunded (SideShift partner key now available for the first shift) |
| 2026-09-20 | spend | `icp-float` | ICP | -1.08000000 | sideshift shift deposit account 3dd4f274bf1c32d813441c6290914f4cb0be190b042fb95c82131188ca148638 | `icp:38488907` | FX-matrix live proof B — FIRST live CeFi order in dpay history: Convert ICP->SOL via venue sideshift (partner-key proxy), founder-approved ~1.04 shift sized 1.08 = venue's moved live min (1.0357 yesterday -> 1.07469909 -> 1.07663288 today; +3.85% vs approved, flagged for ratification). Order created through the real app UI (settle gate BzFNJ verified); deposit sent via the app's own Pay>Send legacy transfer; driver wait died at 5s but tx landed. Expected settle ~0.0274 SOL at the app-derived SOL rail BzFNJ... (SLIP-10 of the IC float seed); settlement polled. |
| 2026-09-20 | fee | `icp-float` | ICP | -0.00010000 | ICP ledger transfer fee (op-B venue deposit, block 38488907) | `icp:38488907` | FX-matrix live proof B — the legacy transfer's own fee on the 1.08 ICP venue deposit; row 40 recorded the principal, this is the fee the ledger charged alongside it. |
| 2026-09-20 | convert | `icp-float` | SOL | +0.02744109 | sideshift shift settle -> app-derived SOL rail BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX (SLIP-10 of the IC float seed) | `sol:5KKQUqG9zLrw1sB2PwawWgtZcCNgiFWNMLTpiTtkUQAkXDdeUMfYifcr3W6KcJQW7NUXoByo1GHLrYF4CqrCzTWN` | FX-matrix proof B SETTLED — first live CeFi order in dpay history completed end-to-end: order (venue sideshift, partner-key proxy) -> deposit icp:38488907 (1.08 ICP exact) -> SOL 0.02744109 verbatim the app's locked settleAmount, 24s deposit-to-settlement. app-derived rail custody = the float seed's SLIP-10 m/44'/501'/0'/0' (one backup recovers both rails); registered sol-float 4Cuacz NOT involved (finding stands). |
| 2026-09-20 | convert | `icp-float` | SOL | -0.00759346 | jupiter swap SOL->USDC on the app-derived SOL rail (device-signed) | `sol:4ppvBQAbCLr4dgqN8L6MqTa4ovKjm2Us2FDPv8uWxp8p9PrCe8FJwV5qKSXocQfNiH2nZqwf42S2jXwCXndkUjsh` | FX-matrix live proof C1 — SOL->USDC via venue jupiter (lite-api), real Convert UI on the SOL rail: 0.006 SOL quoted 0.649285 USDC (min 0.642793 @1%), received 0.64864 USDC; measured SOL delta 0.00759346 (swap + tx/rent overhead). NOTE: two earlier attempts parked convert-stuck ('no RPC endpoint configured') — the e2e build disables the SOL rail by default; fixed driver-side (solRpcUrl derive). |
| 2026-09-20 | convert | `icp-float` | USDC | +0.64864 | jupiter swap payout (SPL USDC on the app-derived SOL rail) | `sol:4ppvBQAbCLr4dgqN8L6MqTa4ovKjm2Us2FDPv8uWxp8p9PrCe8FJwV5qKSXocQfNiH2nZqwf42S2jXwCXndkUjsh` | FX-matrix live proof C1 — USDC leg in; measured via live-sol.mjs and the app's done panel verbatim. |
| 2026-09-20 | convert | `icp-float` | USDC | -0.500000 | jupiter(-sibling) swap USDC->EURC on the app-derived SOL rail (device-signed) | `sol:2F4WzVbMDWTfJWe6TkDVj9wRsAa4i7zr37q4YsYUQCxQZ1w3gQdpE4KKYGuHJsLDaYCmZkwRhJegSVFzhRDpYAx7` | FX-matrix live proof C2 — USDC->EURC via the new SOL-rail venue, real Convert UI (source asset sol-usdc): 0.5 USDC in; received 0.4349 EURC (app done panel verbatim; measured EURC 0.4349). Measured SOL fee delta 0.01984765->0.01835421. |
| 2026-09-20 | convert | `icp-float` | EURC | +0.434900 | jupiter(-sibling) swap payout (SPL EURC on the app-derived SOL rail) | `sol:2F4WzVbMDWTfJWe6TkDVj9wRsAa4i7zr37q4YsYUQCxQZ1w3gQdpE4KKYGuHJsLDaYCmZkwRhJegSVFzhRDpYAx7` | FX-matrix live proof C2 — EURC leg in (first EURC on the SOL rail in dpay history). |
| 2026-09-20 | fee | `icp-float` | SOL | -0.00149344 | SOL-rail tx fees + SPL rent (C1+C2 swaps) | `null` | FX-matrix live proofs C1+C2 — measured SOL delta beyond the swap principals (0.02744109->0.01984765 after C1's 0.006; ->0.01835421 after C2's 0.5-USDC swap); tx fees + temporary WSOL/ATA rent; signatures 4ppvBQAbCLr4..., 2F4WzVbMDWTf... |
| 2026-09-20 | convert | `icp-float` | EURC | -0.200000 | jupiter swap EURC->USDC reverse on the app-derived SOL rail (device-signed) | `sol:b7BB6EexJJix6xc6nrVmzMYq9DYZApujYeoJiSvtnvvxh95LsqF2bMsexLBoeVxw9DWyVQcP1MdT89UpSP9PSzd` | FX-matrix live proof C3 — EUR->USD round trip completed BOTH ways live: 0.2 EURC in, received 0.229905 USDC (implies EUR/USD 1.1495, consistent with C2's 1.149); measured EURC 0.4349->0.2349. |
| 2026-09-20 | convert | `icp-float` | USDC | +0.229905 | jupiter swap payout (SPL USDC, EURC->USDC reverse) | `sol:b7BB6EexJJix6xc6nrVmzMYq9DYZApujYeoJiSvtnvvxh95LsqF2bMsexLBoeVxw9DWyVQcP1MdT89UpSP9PSzd` | FX-matrix live proof C3 — USDC leg in. |
| 2026-09-20 | fee | `icp-float` | SOL | -0.00000500 | SOL-rail tx fee (C3 swap) | `null` | FX-matrix live proof C3 — measured SOL delta 0.01835421->0.01834921. |
| 2026-09-20 | correction | `icp-float` | EURC | -0 | none — no movement | `null` | FX-matrix EURC->ICP attempt — NOT EXECUTABLE in this build: the app's EURC (SOL rail) convert screen offers only in-wallet SOL/USDC destinations; no ICP row renders because resolveSolDestinations walks solana_amm venues only and cefi rows (sideshift-eurc, registered ICP<->EURC and offered ICP-side as 'EURC — to your Solana address') are excluded. Zero spend; the venue's 8.695552 EURC min-error is untestable from the SOL side until cefi venues render as SOL-side destinations (asymmetry finding). |
| 2026-09-20 | convert | `icp-float` | ckUSDC | -0.099000 | icpswap pool hx7nb-diaaa-aaaar-qbxsa-cai (ckUSDC->VCHF reverse swap, approve+depositFromAndSwap) | `null` | FX-matrix live proof A-2 — REVERSE pool leg PROVEN (yesterday's attempt burned only the 0.01 approve fee; today's fresh approve+swap filled in ~2 min): 0.099 in (sized under the fund gate: 0.1 + 2 ledger fees > 0.11961 held), received 0.08048646 VCHF, VCHF payout record 81765; measured ckUSDC 0.119610->0.000610, VCHF 0.06429388->0.14478034. |
| 2026-09-20 | fee | `icp-float` | ckUSDC | -0.020000 | IC ledger approve + swap fees (op A-2) | `null` | FX-matrix live proof A-2 — the two ledger fees the fund gate names (0.119610 - 0.099 - 0.020 = 0.000610 residual, measured). |
| 2026-09-20 | convert | `icp-float` | VCHF | +0.08048646 | icpswap pool hx7nb payout (VCHF ledger block 81765) | `icp:81765` | FX-matrix live proof A-2 — VCHF leg in; with yesterday's forward row (payout record 783528) the pool hx7nb pair is proven BOTH directions live. |
<!-- /GENERATED:spendlog -->

**Key-leak incident and rotation, 2026-09-05 — recorded honestly.** During the funding step, a
first attempt to hand-build a PKCS#8 PEM for dfx failed, and the dfx error message echoed **63 of
the 64 base64 characters of the old float key's DER** (all but the final byte) into a local tool
log. The key was treated as COMPROMISED from that moment. Rotation executed the same day: a
brand-new seed (generated in-memory, sops-encrypted with the existing age identity, plaintext
shredded immediately); the float principal is now
`vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae`; the old
`secrets/agent-icp.sops.json` was shredded and replaced, `secrets/agent-icp.pub.json` updated
(created 2026-09-05); both temporary dfx identities (`dpay-agent-ocp-temp`, `dpay-rotate-old`)
removed; every PEM/DER temporary shredded. The old principal
`lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe` is empty, compromised, and
abandoned — **it must never be funded again.**
