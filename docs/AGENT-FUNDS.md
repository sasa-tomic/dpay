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
public test checkout (`artifacts/spar-test-checkout-qr.png`), which is fixed-amount and 100× the price. The
checkout stays as the fallback for the day the shop route turns out not to work.

Measured 2026-09-04, so the route is known to be real before anyone spends on it:

- the shop's own OpenCryptoPay code decodes to `https://api.dfx.swiss/v1/lnurlp/pl_3e6fe374fbc7dcb0`
  — the SAME provider and standard as the test checkout, so what it proves transfers;
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

    just funds                  # overview: EVERY wallet + EVERY live balance + CHF totals + fees paid + the abandoned watch
    just funds address [W]      # the funding address, no decryption
                                # (W: icp-float | sol-rail | sol-float | evm-float)
    just funds balance [W]      # live census for one wallet, measured (UNREADABLE is never 0)
    just funds history [W]      # what the money DID: ICP transfers + block indexes (IC wallets)
    just funds seed <W>         # the seed hex — DECRYPTS; only immediately before an approved spend
    just funds init <W>         # generate a NEW key for that wallet (refuses if one exists)
    just funds reconcile        # ledger-computed vs MEASURED — drift = unrecorded movement (exit 1)
    just funds doc              # re-render the GENERATED tables in this file from funds/

Wallet ids come from `funds/wallets.json`: `icp-float`, `sol-rail`, `sol-float`, `evm-float`,
`icp-float-old` (balance and history also accept the abandoned id — measuring it is the watch).
A derived wallet (`sol-rail`) has no seed of its own: `seed`/`init` on it REFUSE and point at the
root wallet. Recording a movement is part of the same surface: `just funds add …`
(HARD HARD RULE — CLAUDE.md: AI agents MUST USE `just funds` to record ANY MOVEMENTS THEY MAKE),
then `just funds doc`.

The old recipe names (`just agent-balance`, `just agent-funds --seed`, `just agent-seed`,
`just funds-reconcile`, …) are DELETED (2026-09-20) — no forwarding stubs remain. `just funds
<subcommand>` above is the one way; every driver and doc has been repointed to it.

## Agent fund leases (2026-09-29)

The ledger records what money DID. A **lease** records who is ALLOWED to touch it and what they
account for afterwards (founder directive: agents may draw on the float at any time, but no funds
may ever be lost silently — CLAUDE.md float rules). One command surface, `just funds-agents`:

    just funds-agents open    # declare BEFORE touching float: --agent <session-id> --mandate "…"
                              # --cap-chf N [--claim WALLET/ASSET=AMOUNT]…  (0 cap = watch-only;
                              # worktree/branch auto-detected; free text with shell
                              # metacharacters goes via FUNDS_MANDATE=… / FUNDS_NOTE=…)
    just funds-agents         # the report: every open lease (agent, worktree, branch, mandate,
                              # cap, claims, age), per-lease claimed vs MEASURED vs ledger math,
                              # every unaccounted delta as a loud LOSS line (exit 1), open-cap
                              # exposure vs the CHF 25 ceiling, closed-lease loss history
    just funds-agents close <id> [--note "…"]   # final holdings + reconciliation; exits 1 on any
                                                # loss, but the close always lands (a lingering
                                                # open lease hides exposure)

`open` refuses a cap that would push total open exposure past the CHF 25 ceiling, and one agent
cannot hold two open leases. A lease file is written once at open and only ever gains `events`
(append-only, like the ledger — the ledger itself has no write path from here; movements still go
through `just funds add`). Balances are measured through the same chain children `just funds`
uses, and the ledger math mirrors `just funds reconcile` exactly, so the report can never
disagree with the ledger.

**Store: `<main checkout>/funds/leases/`, gitignored — deliberately.** Leases are transient
per-host claims (open and closed within a session), while the ledger stays tracked; tracking
leases would put commit noise on main and split the record across worktrees. The script resolves
the MAIN checkout via `git worktree list` no matter which worktree it runs from, so every
worktree sees ONE shared store and "which agent in which worktree uses funds" has a single
answer. What survives in git is what must never be lost: the ledger, the registry, this doc.

`just funds` is the one command a fresh session runs first: it prints every wallet the agent
controls (from the committed `funds/wallets.json` registry), each wallet's ADDRESS, and every live
balance measured at that moment. `just funds balance` remains the only balance statement for the IC
float; the overview measures it by spawning the same child with `--json` and re-renders its exact
human format — one balance implementation per chain, not a reimplementation. `just funds seed
sol-float` DECRYPTS and prints the SOL seed hex — same discipline as `just funds seed icp-float`: only
immediately before an approved spend.

`funds/` is the version-controlled record, and using it is a HARD rule (CLAUDE.md): every movement
of float funds — deposit, spend, conversion, fee, rotation — is appended to `funds/ledger.jsonl`
through `just funds add …` in the same session it happens. The JSONL is append-only
and never hand-edited; corrections are new `correction` rows. `just funds reconcile` compares the
ledger math against MEASURED balances and must be CLEAN before a session that moved funds claims
completion: DRIFT is an unrecorded movement (record it, never explain it away), UNKNOWN is a
balance nobody measured and is never treated as zero.

Two more founder hard rules (2026-09-20), same session discipline as the ledger rule:

**The census rule.** Every wallet AND derived address that holds or receives value MUST be
registered in `funds/wallets.json` in the same session it is created or first used; `just funds`
is the complete census. An address appearing in any history, reconciliation, or driver log that is
NOT a registered wallet is a defect to fix immediately — no ephemeral or side addresses, ever.
(What exposed it: the app's derived SOL rail held the real SOL/USDC/EURC while `just funds`
showed only an unused wallet — the rail is now registered as `sol-rail`.)

**The persistence rule.** Every private key the agent creates or uses is sops-encrypted under
`secrets/` (matching the `.sops.yaml` creation rule), committed, and decrypt-verified (`sops -d`
round-trip, no material printed) in the same session it is created. A key that is not persisted is
forbidden from holding value — the destroyed-principal precedent (`icp-float-old`). Derived keys
have no file of their own; their derivation paths are documented below so a fresh session can
always re-derive from the root seed.

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
_GENERATED by `scripts/funds.mjs doc` from `funds/` — do not hand-edit. Record a movement with `just funds add …` (HARD HARD RULE — CLAUDE.md), then re-render with `just funds doc`._

| Wallet | Chain | Address | Secret | Status | What it is for |
|--------|-------|---------|--------|--------|----------------|
| `icp-float` | icp | `vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae` | `secrets/agent-icp.sops.json` | live | The mainnet test float itself — `just funds` measures EVERY ICRC ledger in the bundled catalog (currently ICP / VCHF / ckUSDC / ckBTC / ckETH); rules in CLAUDE.md, record in funds/ledger.jsonl; custody `scripts/agent-key.mjs` |
| `sol-rail` | solana | `BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX` | `secrets/agent-icp.sops.json + SLIP-10 m/44'/501'/0'/0'` | live | The app's OWN Solana rail — the address every in-app SOL/USDC/EURC action signs from and every CeFi shift settles at (derived from the IC float seed, so ONE backup recovers both rails); all SOL-rail movements record under THIS id, never icp-float; custody `scripts/agent-key.mjs (the IC float seed) + e2e/harness/jupiter.mjs deriveSolanaKeypair (no key of its own)` |
| `sol-float` | solana | `4CuaczYGkB4yXmB2op59JKeCd5G6rNBzTSfzSNitUsmU` | `secrets/agent-sol.sops.json` | live-unfunded | Independent raw-seed SOL key created before the app's derived rail (sol-rail) was known — unused, no app code can sign from it; kept measured so it can never silently hold value; custody `scripts/agent-sol.mjs` |
| `evm-rail` | evm | `0x18884BC8e867eEf401703b702097220bdAe27668` | `secrets/agent-icp.sops.json + SLIP-10 m/44'/60'/0'/0/0` | live-unfunded | The app's OWN EVM rail — the address every in-app ZCHF action signs from on every EVM chain (derived from the IC float seed, so ONE backup recovers all three rails); balances measured BOTH chains (ETH gas + ZCHF, chain-qualified ledger labels ETH·Eth/ZCHF·Eth/ETH·Arb/ZCHF·Arb); all EVM-rail movements record under THIS id, never evm-float; custody `scripts/agent-key.mjs (the IC float seed) + e2e/harness/evm/evm-core.mjs deriveEvmKeypair (no key of its own)` |
| `evm-rail-b` | evm | `0xAa228406823f3816E04709DB4640009E6A0a2B56` | `secrets/agent-icp.sops.json + SLIP-10 m/44'/60'/0'/0/1` | live-unfunded | The EVM-rail COUNTERPARTY (the 'B'/merchant side of the D31 mainnet round trip): receives the in-app ZCHF send leg and the offline-permit claim settlement; settles the claim itself (permit + transferFrom) from its own ETH gas. Movements record under THIS id with the same chain-qualified labels; never an ephemeral address (census rule); custody `scripts/agent-key.mjs (the IC float seed) + e2e/harness/evm/evm-core.mjs deriveSlip10Secp256k1Node at m/44'/60'/0'/0/1 (no key of its own)` |
| `evm-float` | evm | `0x6B1C4D33832ba8B21Fa454C1F16E332D4c1183b9` | `secrets/agent-evm.sops.json` | live | Dust EVM wallet — the OP2 gas-funder live proof: native-ETH gas destination for cross-rail converts (CCTP burns user-side to Ethereum; USDC lands at this address). Keyed by a fresh secp256k1 keypair; EIP-55 address committed plaintext in secrets/agent-evm.pub.json; custody `e2e/harness/evm-sign.mjs (sops key decrypted in-process; status/approve/cctp-burn today — spend surface grows with the EVM rail staging)` |
| `icp-float-old` | icp | `lrdna-ain6m-ja6ko-ac4j2-jqk3t-nqs22-4irws-bsm3b-trzzq-3yfz6-mqe` | none (destroyed) | **abandoned — NEVER FUND** | Pre-rotation principal, compromised 2026-09-05 (partial key disclosure into a local tool log) and emptied by the same-day rotation; seed DESTROYED — a misdirected send here is unrecoverable. `just funds` watches it; `funds reconcile` anchors it at measured 0 |
<!-- /GENERATED:wallets -->

The live secrets are sops-encrypted with the SAME age identity (`.dev/age/agent-key.txt`), so the
Recovery rule below covers all four wallets: one identity to back up, and losing it strands all.

**Derivation paths (the persistence rule's re-derive requirement):**

- `sol-rail` — SLIP-10 **ed25519 m/44'/501'/0'/0'** of the IC float seed
  (`secrets/agent-icp.sops.json` `seed_hex`); every level hardened, the master step HMAC-keyed
  `'ed25519 seed'`. Code: `e2e/harness/jupiter.mjs deriveSolanaKeypair`, the mirror of
  `app/solana/identity.ts` — ONE derivation, the app's. Re-derive + measure keylessly:
  `just funds balance sol-rail`.
- `evm-rail` — SLIP-10 **secp256k1 m/44'/60'/0'/0/0** of the same IC float seed (the standard
  Ethereum coin-type path, non-hardened levels per BIP-32 for secp256k1). Code:
  `e2e/harness/evm/evm-core.mjs deriveEvmKeypair`, the mirror of `app/evm/identity.ts` — ONE
  derivation, the app's; flow 218 cross-checks both implementations. Re-derive + measure
  keylessly: `just funds balance evm-rail` (both mainnet chains, ETH gas + ZCHF).
- `evm-float` — a fresh **secp256k1** key (node `crypto`), NOT derived from any seed; the private
  key lives whole in `secrets/agent-evm.sops.json` (`private_key_hex`), the EIP-55 address
  plaintext in `secrets/agent-evm.pub.json`.

### The EVM rail wallet (registered 2026-09-27 — the ZCHF rail, unfunded pending D31 staging)

`evm-rail` `0x18884BC8e867eEf401703b702097220bdAe27668` is the app's OWN EVM address: every
in-app ZCHF action (balance, send, offline permit claim) signs from this key, derived from the
IC float seed so ONE backup recovers all three rails (ICP, SOL, EVM). It starts unfunded; the
D31 mainnet round trip stages dust ETH + ZCHF into it from `evm-float` (and, if the float stays
dry, via a CeFi shift from the SOL rail — founder-approved value movement between the agent's
OWN wallets). Movements record under `evm-rail` with chain-qualified labels
(`ETH·Eth`/`ZCHF·Eth`/`ETH·Arb`/`ZCHF·Arb`); `funds balance evm-rail` measures both chains
keylessly via `scripts/agent-evm.mjs --census rail` (ZCHF contracts read from
`dfx/catalog_truth.json`, never restated).

### The EVM dust wallet (created 2026-09-20 — the gas-funder live proof)

`evm-float` `0x6B1C4D33832ba8B21Fa454C1F16E332D4c1183b9` is a fresh secp256k1 keypair generated
locally (node `crypto` `generateKeyPairSync`; address = keccak256(uncompressed pubkey)[12:], EIP-55).
The secret lives ONLY in `secrets/agent-evm.sops.json`; the checksummed address is committed
plaintext in `secrets/agent-evm.pub.json`. It exists for the cross-rail gas-funder mechanic: the
app's convert card funds native-ETH gas INTO this address (verified via publicnode `eth_getBalance`
in the live driver), and the CCTP burn parks USDC at it — recoverable with the sops key. It has a
signing tool since 2026-09-26: `e2e/harness/evm-sign.mjs` decrypts the key in-process (never
printed, never on disk) and signs status/approve/cctp-burn on mainnet — the surface the D31
staging extends. `funds balance evm-float` measures keylessly (publicnode `eth_getBalance` +
USDC `eth_call`, `scripts/agent-evm.mjs` — the chain's one balance implementation, rendered by the
overview too); `funds history` is IC-only — EVM movement evidence lives in the ledger rows' `tx`
fields.

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

~~To fund the SOL wallet: shift ICP from the IC float to `4CuaczYGkB4yXmB2op59JKeCd5G6rNBzTSfzSNitUsmU`, or the founder drips SOL directly.~~ **DONE 2026-09-20 — but the funded rail is the app-DERIVED address, not this registered wallet.** The app signs SOL transfers ONLY from the SLIP-10 `m/44'/501'/0'/0'` key derived from the IC float seed (`app/solana/identity.ts`), so an in-app CeFi shift settles at `BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX` and the registered raw-seed `sol-float` (`4Cuacz…`, which no app code can sign from) stays measured-0 by design. The shift ran 2026-09-20 09:02:24Z: order via the real Convert UI (venue `sideshift`, partner-key proxy) → deposit icp block 38488907 (1.08 ICP exact) → **SOL 0.02744109 at `BzFNJ…` in 24 s** (`sol:5KKQUqG9…TWN`) — first live CeFi order in dpay history; the SOL rail then proved Jupiter swaps both ways live (SOL→USDC, USDC→EURC, EURC→USDC) and the reverse IC pool leg ckUSDC→VCHF filled (record 81765). Rows 40-54; `just funds reconcile` CLEAN. Measure the derived rail with `just funds balance sol-rail` — since 2026-09-20 it is a registered wallet of its own (census rule); `sol-float` measuring 0 is correct (it is unused by design).

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
measured 0 via `just funds` throughout; watch the derived address with `just funds balance
sol-rail` — registered as its own wallet 2026-09-20).

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
with `just funds add …` in the same session it happens (HARD HARD RULE — CLAUDE.md), then
`just funds doc`; a row hand-written here would be lost on the next render.

<!-- GENERATED:spendlog -->
_GENERATED by `scripts/funds.mjs doc` from `funds/` — do not hand-edit. Record a movement with `just funds add …` (HARD HARD RULE — CLAUDE.md), then re-render with `just funds doc`._

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
| 2026-09-20 | deposit | `icp-float` | ICP | +3.0 | founder | `38489263` | founder top-up for the approved EURC->ICP round trip |
| 2026-09-20 | correction | `icp-float` | ckUSDC | -0.01 | pool hx7nb (icpswap) | `op-A-2 deposit` | the pool pulled the full 0.1 approve, the row recorded the 0.099 net — amount correction |
| 2026-09-20 | spend | `icp-float` | ICP | -1.10000000 | sideshift shift deposit account df52ecb3369b6cf81bfa3d37faa3dea1ec59dafe0a898a67cf47a9bbd3d9f617 | `icp:38491868` | FX-matrix OP1 shift #2 — ICP->SOL via venue sideshift through the real app UI (settle gate BzFNJ verified on-screen); sized 1.10 = live min band (1.08948429 at 13:44, 1.09127319 at 13:58, +1.9% vs approved ~1.08). Deposit sent via the app's Pay>Send after the awaiting-deposit panel froze 'Exact deposit amount: 1.1 ICP'. |
| 2026-09-20 | fee | `icp-float` | ICP | -0.00010000 | ICP ledger transfer fee (shift #2 venue deposit, block 38491868) | `icp:38491868` | OP1 shift #2 — the ledger's own fee alongside the 1.1 venue deposit. |
| 2026-09-20 | convert | `icp-float` | SOL | +0.02764513 | sideshift shift #2 settle -> app-derived SOL rail BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX | `sol:5dpUrHhtvvwFoSkaN731WyKdo3ZVw1wPdGCdxxSQ1k4FmnxrCQjiDP5BzrWVywUnW6hXiuanrTBK4WbH7zSBM4qc` | OP1 shift #2 SETTLED — 1.1 ICP in, SOL 0.02764513 out (measured 0.01834921->0.04599434); displayed quote 0.02764258, the ORDER's settle is the lock (locks-on-order design proven live); 31s deposit-to-settlement. |
| 2026-09-20 | spend | `icp-float` | ICP | -1.10000000 | sideshift shift #3 deposit account 2801c8f42547032596b80ce17c9ff8cb60e6b9cef719df9653eaaaaa6fd4bee6 | `icp:38491941` | FX-matrix OP1 shift #3 — ICP->SOL venue sideshift, full driver loop in ONE run (order -> app Pay>Send deposit -> in-app watch to convert-done). Sized 1.1 again (live min band still ~1.09). |
| 2026-09-20 | fee | `icp-float` | ICP | -0.00010000 | ICP ledger transfer fee (shift #3 venue deposit, block 38491941) | `icp:38491941` | OP1 shift #3 — ledger fee alongside the 1.1 venue deposit. |
| 2026-09-20 | convert | `icp-float` | SOL | +0.02761925 | sideshift shift #3 settle -> app-derived SOL rail BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX | `sol:2qpQcGUEDNgTWBmPUq3KqViqZWmnBLJBVVrRm4cN3KrepKyszJjEmeFuidhtzs1YYhQT6WhwWtfVSvKxv5Tjgme5` | OP1 shift #3 SETTLED — app convert-done panel verbatim '0.02761925 SOL received in your wallet'; measured rail 0.04599434->0.07361359; ~25s deposit-to-settlement. |
| 2026-09-20 | spend | `icp-float` | ICP | -1.10000000 | sideshift shift #4 deposit account (per driver log /tmp/op-shift4.log) | `icp:38491947` | FX-matrix OP1 shift #4 — third live ICP->SOL CeFi shift; deposit via the app's Pay>Send; sized 1.1 under the founder-approved ~1.08x3 round-trip budget. |
| 2026-09-20 | fee | `icp-float` | ICP | -0.00010000 | ICP ledger transfer fee (shift #4 venue deposit, block 38491947) | `icp:38491947` | OP1 shift #4 — ledger fee alongside the venue deposit. |
| 2026-09-20 | convert | `icp-float` | SOL | +0.02759878 | sideshift shift #4 settle -> app-derived SOL rail BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX | `sol:4nKwmExN3XxrMPPUjWHEgMtzLZ6bTtWVATeJLXc2NeiWrWweeLTxTSAxjy2RbtKx1ywXQpoKBShaajEoBbvrwmWk` | OP1 shift #4 SETTLED — app convert-done '0.02759878 SOL received'; measured rail 0.07361359->0.10121237. |
| 2026-09-20 | convert | `icp-float` | SOL | -0.09657882 | jupiter swap SOL->USDC on the app-derived SOL rail (device-signed) | `sol:ddgsoNW355xjib3vhG3rxb7yi6chb6XdaXB1Z2p9xHgAFNNEBfuN4ZigrXioGacek1CKoaaeh9Tr4Gqn3ZDA3oo` | FX-matrix OP1b C1 — SOL->USDC via venue jupiter, real Convert UI: 0.095 SOL typed, quoted 10.267296 USDC (min 10.164624 @1%), received 10.280766; measured SOL delta incl. tx+rent overhead (0.10121237 -> X, see c2 row). |
| 2026-09-20 | convert | `icp-float` | USDC | +10.280766 | jupiter swap payout (SPL USDC on the app-derived SOL rail) | `sol:ddgsoNW355xjib3vhG3rxb7yi6chb6XdaXB1Z2p9xHgAFNNEBfuN4ZigrXioGacek1CKoaaeh9Tr4Gqn3ZDA3oo` | OP1b C1 — USDC leg in; app convert-done verbatim. |
| 2026-09-20 | correction | `icp-float` | SOL | +0.001564725 | row 66 amount correction (no movement) | `sol:ddgsoNW355xjib3vhG3rxb7yi6chb6XdaXB1Z2p9xHgAFNNEBfuN4ZigrXioGacek1CKoaaeh9Tr4Gqn3ZDA3oo` | C1 SOL-out correction: measured delta 0.10121237->0.006198275 = 0.095014095 (row 66 said 0.09657882); this row restores the measured balance. |
| 2026-09-20 | convert | `icp-float` | USDC | -10.400000 | jupiter swap USDC->EURC on the app-derived SOL rail (device-signed) | `sol:N4iegBdQ3mfPLfExA6cW4k5UbpRi34kMbnn4AAYNh6m8GXiEWeZ7A3yDfkiah57cgs6fjLaAho6JmH8oPtY7892` | FX-matrix OP1b C2 — USDC->EURC via venue jupiter: 10.4 USDC typed, quoted 9.049171 EURC (min 8.95868 @1%), received 9.049171 verbatim. |
| 2026-09-20 | convert | `icp-float` | EURC | +9.049171 | jupiter swap payout (SPL EURC on the app-derived SOL rail) | `sol:N4iegBdQ3mfPLfExA6cW4k5UbpRi34kMbnn4AAYNh6m8GXiEWeZ7A3yDfkiah57cgs6fjLaAho6JmH8oPtY7892` | OP1b C2 — EURC leg in; rail EURC 0.2349->9.284071 (with C1 +3.33 SOL->USDC legs = the founder's ICP 3.3 converted to ~9.28 EURC). |
| 2026-09-20 | spend | `icp-float` | EURC | -9.284071 | sideshift RETURN-shift (EURC->ICP) deposit address 7nY7Xmo9TA85ZNQTJFw9rFGggKjK63vpD8QykDgZsSpQ — the NEW SOL-side cefi destination group's handoff | `sol:2mgwLHpv1isq8e6EgzHckmipM1ZhL1Ua1H5qNJhv6AKKvQXxbK19SDnZoEuY588zG4mXc8DvbYRXGyKGpFk6bZEJ` | OP1c RETURN shift — the app's SOL Convert EURC screen offered 'ICP on Internet Computer — via SideShift' (the merged SOL-side cefi surface); settle address shown BEFORE the order = the float's OWN IC principal vloyo-...-5ae (non-custodial: payout to the user's own address); deposit = SPL transfer the UI instructs, typed into the app's own Pay>Send sheet (SolanaWithdrawSheet). Order created in-app (awaiting-deposit panel verbatim 'Exact deposit amount: 9.284071 EURC'); on-chain measured EURC 9.284071 -> 0. |
| 2026-09-20 | fee | `icp-float` | SOL | -0.00149344 | SOL tx fee + venue-deposit ATA rent (return-shift SPL deposit) | `sol:2mgwLHpv1isq8e6EgzHckmipM1ZhL1Ua1H5qNJhv6AKKvQXxbK19SDnZoEuY588zG4mXc8DvbYRXGyKGpFk6bZEJ` | OP1c — measured SOL 0.006193275->0.004699835: the venue's fresh deposit ATA rent (payer-funded, standard SPL) + network fee. |
| 2026-09-20 | genesis | `evm-float` | ETH | +0 | null | `null` | Genesis anchor at 0 — fresh secp256k1 keypair generated locally (node crypto), address keccak256(pubkey)[12:] EIP-55; on-chain eth_getBalance measured 0x0 at creation. The wallet starts EMPTY; every wei that arrives gets its own row. |
| 2026-09-20 | correction | `sol-rail` | SOL | -0 | — | — | REMAP — every SOL-rail row above this point (recorded under icp-float: the sweep settles, the OP1/C1/C2 shifts, the RETURN shift) is THIS wallet's history: the app's derived rail was unregistered when they happened. No movement; these rows sit before the genesis anchor in file order and stay absorbed history |
| 2026-09-20 | correction | `sol-rail` | USDC | -0 | — | — | REMAP — SOL-rail USDC rows above (recorded under icp-float) belong to THIS wallet; absorbed history, no movement |
| 2026-09-20 | correction | `sol-rail` | EURC | -0 | — | — | REMAP — SOL-rail EURC rows above (recorded under icp-float) belong to THIS wallet; absorbed history, no movement |
| 2026-09-20 | genesis | `sol-rail` | SOL | +0.004699835 | — | — | Genesis anchor at MEASURED (agent-sol balance, keyless mainnet RPC) — the app's derived rail: SLIP-10 ed25519 m/44'/501'/0'/0' of the IC float seed, derivation verified = the known BzFNJ... rail; prior rail rows live absorbed under icp-float above |
| 2026-09-20 | genesis | `sol-rail` | USDC | +0.259311 | — | — | Genesis anchor at MEASURED (SPL USDC on the derived rail) — post RETURN-shift remainder |
| 2026-09-20 | genesis | `sol-rail` | EURC | +0 | — | — | Genesis anchor at MEASURED (SPL EURC on the derived rail) — the RETURN shift emptied it |
| 2026-09-21 | convert | `sol-rail` | EURC | +9.284071 | sideshift refund (shift R) | `4e7rYtFvHmTp5rGkV5M3QDf9TnzVJxvRGGkyZQNhmbzEbtRppyFr9xiUn3JT7C36SUnjpQ9CUBTMAqUhsDX5gQWY (venue sweep of our deposit)` | SideShift refunded the stuck settling shift — their ICP payout layer rejected our settle-address format; format answer pending from their engineers |
| 2026-09-21 | deposit | `sol-rail` | EURC | +9.284071 | sideshift (return-shift refund) | `sideshift refund, sig on-chain` | SideShift refunded the full return-shift deposit after their settlement bug - the founder's 9.284071 EURC is back on the sol-rail |
| 2026-09-21 | correction | `sol-rail` | EURC | -9.284071 | duplicate of the 09:10:15 refund row | `dedupe row-80/row-81` | the same SideShift refund was appended twice (two handlers raced); this correction removes the double-count |
| 2026-09-21 | spend | `icp-float` | ckBTC | -0.0000098 | icpswap ckBTC/ckETH pool akhru | `ckbtc ledger ~12:07Z; payout ckETH block ~1108048` | Route-B record 1: probe-confirm ckBTC->ckETH driven through the real app UI (cctp-live session live-drive probe-confirm2): 0.0000096 principal + 2x0.0000001 IC ledger fees (icrc2 approve + pool pull) |
| 2026-09-21 | convert | `icp-float` | ckETH | +0.000291876642414143 | from akhru (pool) | `ckETH ledger transfer, memo 0xdd0d, ts 12:08:48.267Z` | Route-B record 1 payout: pool akhru sent 0.000291876642414143 ckETH for the 0.0000096 ckBTC swap leg (ICPSwap swap fee netted in-pool) |
| 2026-09-21 | spend | `icp-float` | ckBTC | -0.0000098 | icpswap-akhru-pool | `payout-record-1108048` | Record 1 of Route-B live proof: ckBTC 0.0000095 principal (+0.0000001 approve fee +0.0000001 swap fee) -> 0.000291876642414143 ckETH in-wallet via akhru (ICPSwap ckBTC/ckETH), driven through the real app UI (e2e/live-drive.mjs probe-confirm2) |
| 2026-09-21 | convert | `icp-float` | ckETH | +0.000291876642414143 | icpswap-akhru-pool | `payout-record-1108048` | Record 1 payout: 0.000291876642414143 ckETH received in-wallet (net of 0.000002 pool output fee); Route-B live proof leg |
| 2026-09-21 | convert | `icp-float` | VCHF | -0.1447 | to icpswap VCHF/ckUSDC pool hx7nb | `VCHF ledger, approve 0.1446 ts 12:09:53.708Z + transfer_from 0.1445 ts 12:09:57.150Z` | Route-B fuel swap (real app Convert, conv-evm vchf): 0.1445 VCHF principal + 0.0001 icrc2 approve fee + 0.0001 IC transfer fee into the DIRECT VCHF/ckUSDC pool hx7nb (no ICP hop) |
| 2026-09-21 | convert | `icp-float` | ckUSDC | +0.167977 | from hx7nb (pool) | `ckUSDC ledger transfer, memo 0x5ff3, ts 12:10:09.001Z` | Route-B fuel swap payout: pool hx7nb sent 0.167977 ckUSDC for the 0.1445 VCHF leg |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.000002 | ckETH ledger fee, approve to minter sv3dd (allowance 0.00013361881533) | `ckETH ledger approve, ts 12:19:35.759Z` | icrc2 approve fee for ckERC20 withdraw #1 (0.158587 USDC -> evm-float 0x6B1C...83b9), driven via app Send surface |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckUSDC ledger fee, approve to minter (allowance 0.168587) | `ckUSDC ledger approve, ts 12:19:37.783Z` | icrc2 approve fee for ckERC20 withdraw #1 (0.158587 USDC -> evm-float 0x6B1C...83b9) |
| 2026-09-21 | spend | `icp-float` | ckETH | -0.000131763083270000 | to ckETH minter sv3dd (gas burn) | `ckETH ledger burn, memo ckUSDC + 0x6B1C...83b9, ts 12:20:41.308Z` | ckERC20 withdraw #1 gas burn by the ckETH minter; the withdraw FAILED downstream and the minter refunded (next row) - value recovered, no repeat attempted |
| 2026-09-21 | convert | `icp-float` | ckETH | +0.000129763083270000 | from ckETH minter sv3dd (refund mint) | `ckETH ledger mint, refund memo, ts 12:23:35.811Z` | minter refund of the failed withdraw #1 gas burn: 0.00012976308327 ckETH (= burn minus the 0.000002 ledger fee kept by the ledger); net cost of the failed attempt: 0.000002 |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.000002 | ckETH ledger fee, approve to minter sv3dd (allowance 0.00015077527946) | `ckETH ledger approve, ts 12:28:40.328Z` | icrc2 approve fee for ckERC20 withdraw attempt #2; driver halted at REVIEW with no burn - allowance left unspent |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckUSDC ledger fee, approve to minter (allowance 0.158587) | `ckUSDC ledger approve, ts 12:28:45.681Z` | icrc2 approve fee for ckERC20 withdraw attempt #2; no burn followed (driver halted at REVIEW) - ckUSDC intact, allowance unspent |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckerc20-minter | `withdraw-attempt-1-1219` | ckUSDC->0x6B1C EVM withdraw attempt 1 (0.168587): minter fee pulled at accept; withdraw_erc20 submitted ~12:20, in flight canister-side (~15-40min ckERC20 timing) |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckerc20-minter | `withdraw-attempt-2-1228` | ckUSDC->0x6B1C EVM withdraw attempt 2 (0.158587): minter fee pulled at accept; submitted ~12:29 |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.000006 | ckerc20-minter | `withdraw-tolls-1219-1228` | ckETH gas tolls pulled by minter minus refunds, net across both withdraw attempts (0.000464798799849131 -> 0.000458798799849131 measured) |
| 2026-09-21 | convert | `icp-float` | ckUSDC | +0.167977 | icpswap-hx7nb-pool | `record-2-hx7nb` | Record 2 payout: 0.167977 ckUSDC received in-wallet (12:10, activity row 5ff3); Route-B live proof leg |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.000002 | sv3dd-oaaaa-aaaar-qacoa-cai | `approve-attempt3-1108074` | ckERC20 withdraw attempt #3 approve fee (cctp-live session, send-usdc rounds 12-15): allowance 0.00018052378682 ckETH to the ckETH minter; attempt failed at the withdraw form, no minter burn followed, allowance live-unspent |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | sv3dd-oaaaa-aaaar-qacoa-cai | `approve-attempt3-784479` | ckERC20 withdraw attempt #3 approve fee (cctp-live session): allowance 0.1385 ckUSDC to the ckETH minter (ckERC20 withdraw entry); attempt failed before the burn, allowance live-unspent |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckusdc-ledger | `withdraw-attempt-3-1336` | approve ledger fee burned; withdraw_erc20 never accepted (driver closed before leg 3 submitted) |
| 2026-09-21 | fee | `icp-float` | ckUSDC | -0.01 | ckusdc-ledger | `withdraw-attempt-5-1351` | approve ledger fee burned (successful attempt, FIXED approve amount+fee) |
| 2026-09-21 | spend | `icp-float` | ckUSDC | -0.1285 | ckminter-sv3dd | `0xc0b1bd64e0ecae5b42f2000dc95a8ad2fc6544118eee7aa9a086df955953f176` | ckUSDC 0.1285 burned via withdraw_erc20 after the amount+fee approve fix; minter withdrawal_id ~1108xxx; USDC delivered to evm-float on Ethereum |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.000002 | cketh-ledger | `withdraw-attempt-3-cketh` | attempt-3 ckETH deltas (approve fee et al), no withdrawal resulted |
| 2026-09-21 | fee | `icp-float` | ckETH | -0.00017915756721 | ckminter-sv3dd | `withdraw-toll-attempt-5` | minter gas toll pull for the successful ckUSDC withdrawal (actual priced gas) |
| 2026-09-21 | correction | `icp-float` | ckUSDC | -0.1385 | sv3dd-oaaaa-aaaar-qacoa-cai (minter transfer_from) | `attempt3 allowance pull, cctp-live send-usdc rounds 12-15` | reconcile arbitration (OPEN_ISSUES ledger-duplication warning: main rows 83-92 vs cctp-live 83-89, arbitrated by MEASURED): main row 92 said attempt-3 allowance 0.1385 ckUSDC 'live-unspent' but the minter DID pull it — measured 0.138587->0.000087 requires exactly this outflow |
| 2026-09-21 | correction | `icp-float` | ckETH | -0.000179157567210 | sv3dd-oaaaa-aaaar-qacoa-cai (minter gas burn net of refund) | `attempt3 gas burn, cctp-live send-usdc rounds 12-15` | reconcile arbitration, same event set as the ckUSDC row: main row 91 recorded only the 0.000002 approve fee; the burn 0.00018052378682 minus refund kept 0.000179157567210 net (measured 0.000456798799849131->0.000277641232639131) |
| 2026-09-21 | correction | `sol-rail` | EURC | -0 | sideshift-eurc shift b4f0dd3e0ad88d4b1617 (expired) | `shift b4f0dd3e0ad88d4b1617 status=expired 14:23:25Z, no deposit sig exists` | EURC->ICP retry attempt (the ONE permitted): settle slot showed the fixed 64-hex account identifier 9fac39d1...030a41 and the venue ACCEPTED it in the order (settleAddress recorded verbatim; settleAmount 3.5819747 ICP); order created 14:08:32Z; BOTH app send-sheet submits hung in 'submitting' (no outcome, no error) and NO transfer ever left the rail (on-chain: no new sig, EURC measured 9.284071 unchanged) — shift expired unexercised, zero value at risk; HARD STOP honored, no new orders |
| 2026-09-21 | deposit | `evm-float` | USDC | +0.1285 | ckminter-sv3dd | `0xc0b1bd64e0ecae5b42f2000dc95a8ad2fc6544118eee7aa9a086df955953f176` | Route-A LIVE proof complete: ckUSDC 0.1285 burned on ICP via the ckETH minter (withdraw_erc20 after the amount+fee approve fix), USDC delivered on Ethereum to evm-float. Withdrawal tx hash = the minter's USDC.transfer; first dpay IC->EVM value delivery at this size |
| 2026-09-21 | genesis | `evm-float` | USDC | +0.1285 | ckminter-sv3dd | `0xc0b1bd64e0ecae5b42f2000dc95a8ad2fc6544118eee7aa9a086df955953f176` | Genesis anchor at MEASURED: the CCTP-burned USDC census now measured on the EVM side (agent-evm USDC balanceOf row); the delivery row above records the movement |
| 2026-09-21 | correction | `icp-float` | ICP | -1.43335395 | cross-branch ledger union | `union arbitration 2026-09-21` | net computed to measured census: cctp-live + main + live-ops branches recorded overlapping Route-B movements (union arbitration) |
| 2026-09-21 | correction | `icp-float` | VCHF | -0.06449388 | cross-branch ledger union | `union arbitration 2026-09-21` | net computed to measured census (cross-branch duplicate of the Route-B fuel movements) |
| 2026-09-21 | correction | `icp-float` | ckUSDC | -0.459087 | cross-branch ledger union | `union arbitration 2026-09-21` | net computed to measured census (cross-branch duplicates incl. rows 87/97 and the pre-applied 105 arbitration) |
| 2026-09-21 | correction | `icp-float` | ckBTC | -0.0000002 | cross-branch ledger union | `union arbitration 2026-09-21` | net computed to measured census |
| 2026-09-21 | correction | `icp-float` | ckETH | -0.000277641232639131 | cross-branch ledger union | `union arbitration 2026-09-21` | net computed to measured census (cross-branch duplicates rows 83/85 + gas tolls) |
| 2026-09-21 | correction | `sol-rail` | EURC | -0 | sideshift-eurc shift fd69ad57fd6bb988e235 (expired) | `shift fd69ad57fd6bb988e235 status=expired 15:19:47Z, no deposit sig exists` | EURC->ICP corrected-path retry (the ONE attempt of this session, seam fix 2ab8d5f live in the served bundle — marker verified): settle slot + venue order again carried the 64-hex account identifier 9fac39d1...030a41 (order-level fix proof, second consecutive); live min 8.717468 < 9.284071; order created 15:04:55Z; the send submit's fields verified in-DOM (type-race fixed), click landed 15:07:54 — then the balance poll tripped the 3-strike offline threshold MID-SEND and the offline gate replaced the sheet body, so no terminal surface (outcome/unknown/error) ever rendered; NO transfer broadcast (on-chain: no new sig, EURC 9.284071 unchanged); RPC healthy before/during/after (direct Helius 200 ~150ms, relay pipe 200) — the flip is the app's threshold vs transient jitter, and the gate destroying an in-flight send's terminal UI is the remaining defect; shift expired unexercised, zero value at risk; HARD STOP honored |
| 2026-09-21 | correction | `icp-float` | ICP | +1.43335395 | null | `null` | reconcile repair of the cross-branch union arbitration (row 111): the union of cctp-live+main+live-ops rows 98-115 computes icp-float ICP to -1.38100000 — a balance the wallet can never hold — vs MEASURED 0.05235395 (official ICP index, live). This row nets the union to the measured census; the residual also shows the union double-counts ~1.43 ICP of Route-B outflows against the 1.43275395 genesis anchor. Note: row 111 carries a NEGATIVE amount (-1.43335395) that funds.mjs validate() rejects today — it predates this session's commit and needs the founder's eye on how it entered the file |
| 2026-09-21 | correction | `icp-float` | VCHF | +0.06449388 | null | `null` | reconcile repair, same union-arbitration event as row 117: rows 98-115 compute VCHF to -0.06441354 (impossible) vs MEASURED 0.00008034; nets the union to the measured census |
| 2026-09-21 | correction | `icp-float` | ckUSDC | +0.459610 | null | `null` | reconcile repair, same union-arbitration event as row 117: rows 98-115 compute ckUSDC to -0.459523 (impossible) vs MEASURED 0.000087; nets the union to the measured census |
| 2026-09-21 | correction | `icp-float` | ckBTC | +0.00001 | null | `null` | reconcile repair, same union-arbitration event as row 117: rows 98-115 compute ckBTC to -0.00001000 (impossible) vs MEASURED 0.00000000; nets the union to the measured census |
| 2026-09-21 | correction | `icp-float` | ckETH | +0.000172922157434988 | null | `null` | reconcile repair, same union-arbitration event as row 117: rows 98-115 compute ckETH to 0.000104719075204143 vs MEASURED 0.000277641232639131; nets the union to the measured census |
| 2026-09-21 | correction | `icp-float` | ICP | +1.43335395 | cross-branch ledger union (cctp-live/main/live-ops) | `counter row-111` | COUNTER-CORRECTION of row 111 (union arbitration 2026-09-21): row 111 DOUBLE-APPLIED — the union ledger already computed icp-float ICP to the measured 0.05235395 before it (genesis 1.43275395 + rows 40/41/55/57/58/60/61/63/64 net exactly; no cctp-live row touched ICP). Reverses row 111 in full. No movement. |
| 2026-09-21 | correction | `icp-float` | VCHF | +0.06449388 | cross-branch ledger union (cctp-live/main/live-ops) | `counter row-112` | COUNTER-CORRECTION of row 112: DOUBLE-APPLIED — pre-arbitration computed was already the measured 0.00008034 (genesis 0.06429388 + row 54 in 0.08048646 − row 87 out 0.1447; cctp-live's own duplicate VCHF row was already dropped in the merge). Reverses row 112 in full. No movement. |
| 2026-09-21 | correction | `icp-float` | ckUSDC | +0.459087 | cross-branch ledger union (cctp-live/main/live-ops) | `counter row-113` | COUNTER-CORRECTION of row 113: DOUBLE-APPLIED and mis-sized (took 0.459087 out where the union drift vs measured was 0.098477). Reverses row 113 in full; the honest netting of the true union duplicates follows as its own rows (95=90, 96=94, 101=100, 98=88, 106=102+103). No movement. |
| 2026-09-21 | correction | `icp-float` | ckBTC | +0.0000002 | cross-branch ledger union (cctp-live/main/live-ops) | `counter row-114` | COUNTER-CORRECTION of row 114: DOUBLE-APPLIED — pre-arbitration computed (-0.0000098) reaches the measured 0 through the single row-85 duplicate reversal below. Reverses row 114 in full. No movement. |
| 2026-09-21 | correction | `icp-float` | ckETH | +0.000277641232639131 | cross-branch ledger union (cctp-live/main/live-ops) | `counter row-115` | COUNTER-CORRECTION of row 115: DOUBLE-APPLIED and mis-sized (0.000277641232639131 out where the true union drift was 0.000104719075204143). Reverses row 115 in full; the honest netting follows as its own rows (86=84, 107=105, 104=99, 97 spurious). No movement. |
| 2026-09-21 | correction | `icp-float` | ICP | -1.43335395 | concurrent-session arbitration race (rows 116-121) | `counter row-122` | Reverses my own row 122: it was appended against a stale file view. Rows 117-121 (the concurrent reconcile-repair, ts 15:21-15:22Z) had ALREADY countered the double-applied arbitration rows 111-115 and folded the duplicate netting in; row 122's counter of row 111 therefore double-counted. Same append-only protocol: rows are never edited, only countered. No movement. |
| 2026-09-21 | correction | `icp-float` | VCHF | -0.06449388 | concurrent-session arbitration race (rows 116-121) | `counter row-123` | Reverses my own row 123 — superseded by row 118 (identical amount/direction) from the concurrent reconcile-repair. No movement. |
| 2026-09-21 | correction | `icp-float` | ckUSDC | -0.459087 | concurrent-session arbitration race (rows 116-121) | `counter row-124` | Reverses my own row 124 — superseded by row 119, which carries the SAME total as one row (0.459087 counter of row 113 + 0.000523 netting of the union duplicates: row 98 dup of 88 (-0.167977), row 106 dup of 102+103 (+0.1385), rows 95/96/101 dups of 90/94/100 (+0.03)). No movement. |
| 2026-09-21 | correction | `icp-float` | ckBTC | -0.0000002 | concurrent-session arbitration race (rows 116-121) | `counter row-125` | Reverses my own row 125 — superseded by row 120 (0.00001 = row 114's 0.0000002 + the row-85-dup-of-83 netting 0.0000098, one row). No movement. |
| 2026-09-21 | correction | `icp-float` | ckETH | -0.000277641232639131 | concurrent-session arbitration race (rows 116-121) | `counter row-126` | Reverses my own row 126 — superseded by row 121, which carries the SAME total as one row (0.000277641232639131 counter of row 115 − 0.000104719075204143 netting: row 86 dup of 84 (-0.000291876642414143), row 107 dup of 105 (+0.000179157567210), row 104 dup of 99 (+0.000002), row 97 spurious vs rows 89+91/92+93 (+0.000006)). No movement. |
| 2026-09-21 | correction | `sol-rail` | EURC | -0 | sideshift-eurc fixed order (created ~16:36Z, id uncaptured — awaiting panel never rendered) | `no deposit sig exists; order unfunded, expired ~16:51Z` | EURC->ICP corrected-path attempt #3 (send fixes 0ec60f5 live in the served bundle: bounded chunk-load marker + tracer verified pre-flight): settle slot again 9fac39d1...030a41 (vector-gated), live min 8.719534 < 9.284071; the confirm loop locked up — 30 re-confirm attempts, surface alternating 'Could not reach SideShift' + 'Quote changed'; proxy log shows exactly ONE shifts/fixed 201 (the order EXISTS venue-side, requested 9.284071 EURC) but the awaiting-deposit surface never adopted it, so the deposit leg never started; NO transfer broadcast (EURC measured 9.284071 unchanged; newest rail sig still 2026-09-20); zero value at risk; HARD STOP honored. Diagnosis layer moved UPSTREAM of the send (tracer never fired — the sheet was never submitted): the confirm->order->adopt handoff is the failing seam. Offline flow 197 at HEAD: lifecycle reaches done but RED on 'status poll keyed every read by the order id' (>=3 statusCalls) — separate gate-red for next session (poller untouched by the merge wave: flake or indirect). Relay stderr: one 'balances: currency 1 query timed out after 5000ms' (mainnet IC latency class) |
| 2026-09-21 | correction | `sol-rail` | EURC | -0 | sideshift-eurc shift 004c5d8c60918dc27b93 (expired) | `no deposit sig exists; shift unfunded, expired 18:19:30Z` | EURC->ICP attempt #5 (confirm-fix 5801964 validated): the confirm fix WORKED — first-try order, no livelock (shift created 18:04:38Z, exact 8.8 EURC, settle 3.41897546 ICP at the 64-hex identifier 9fac39d1...030a41 verbatim, refund = our rail; live min 8.716579). Deposit leg: fields verified in-DOM round 0, click landed, and the NEW TRACER named every await then the exact failure: sender-ata-check -> recipient-ata-check (createIdempotent joins) -> sender-balance-check -> sign -> blockhash -> broadcast FAILED 'Transaction simulation failed: Blockhash not found' — sheet ERROR (nothing accepted), clean terminal, no spinner. A fresh blockhash rejected at simulation within ~1s: relay cache EXONERATED (getLatestBlockhash TTL 4s; Solana validity ~60-90s) — points at a Helius-side simulation anomaly or endpoint-shard race; fixer's next diagnostic. EURC measured 9.284071 unchanged; shift expired unexercised, zero value at risk; HARD STOP honored — no retry of a failed transfer |
| 2026-09-21 | spend | `sol-rail` | EURC | -0.01 | self (BzFNJ EURC ATA) | `5HCVuLRvNDgBddqHybKvB3bTNRUiv9JE2vFYK97ZyLWTy5aQ92HGHZ1SUkxkWNtgksVuWDmJ13Y1BtbxViLx11is` | attempt-6 discriminator: SPL self-send to an EXISTING recipient ATA (no ATA-create tx) — same sendSpl+blockhash seam that Helius refused twice with 'Blockhash not found'; byte-exact replay to the public RPC was ACCEPTED (provider send-path proof). Leg 1/2. |
| 2026-09-21 | deposit | `sol-rail` | EURC | +0.01 | self (BzFNJ EURC ATA) | `5HCVuLRvNDgBddqHybKvB3bTNRUiv9JE2vFYK97ZyLWTy5aQ92HGHZ1SUkxkWNtgksVuWDmJ13Y1BtbxViLx11is` | attempt-6 discriminator self-send, return leg 2/2 — net EURC zero. |
| 2026-09-21 | fee | `sol-rail` | SOL | -0.000005 | null | `5HCVuLRvNDgBddqHybKvB3bTNRUiv9JE2vFYK97ZyLWTy5aQ92HGHZ1SUkxkWNtgksVuWDmJ13Y1BtbxViLx11is` | network fee of the attempt-6 discriminator self-send (1-sig legacy tx). |
| 2026-09-21 | correction | `sol-rail` | EURC | -0 | sideshift-eurc shift b46a9ac6aa1f8f3ed436 (expired unfunded 21:31:46Z) | `no deposit sig exists; order unfunded, nothing broadcast` | EURC->ICP attempt #8 (the staged last attempt; sheet-gate fix 2790436 served, marker verified in bundle + relay embed): order creation FIFTH consecutive first-try, this time driven directly through the relay partner proxy (quote d2ca0073 201 + shifts/fixed 201, settle = the float 64-hex identifier verbatim, refund = the rail owner; settleAmount 3.34336885 ICP; live window 15 min). APP-SIDE ALL VALIDATED LIVE: stale-ok confirm enabled at 0s on BOTH presses (no balance-poll demand), the sheet surface was never torn down (offline only as the in-sheet note), native-setter fill + echo + enable-wait driver behaved, and the full money tracer fired end to end. Deposit leg refused TWICE pre-money, zero movement both times (on-chain verified after each: EURC 9.284071 unchanged, newest sig still 19:24:16Z from the #6 discriminator). Press 1: RIG DEFECT (mine) - relay started against the rate-limited PUBLIC RPC instead of deploy/.env keyed endpoint; console wall of 429s through the sheet burst; broadcast sim refused; relay restarted mid-attempt with the documented env (r9d->r9e). Press 2 on the corrected rig: the KEYED provider itself refused the broadcast with a blockhash-not-found-class error, the rpc-failover seam (ff2f0be) FIRED LIVE for the first time (127.0.0.1:8898 -> api.mainnet-beta.solana.com) and the failover hop refused too (Transaction simulation failed) - the #5/#6 provider anomaly REPRODUCES on the keyed endpoint and the app failover chain currently ends at a write-incapable public endpoint. HARD STOP honored; reconcile 18 pairs CLEAN at this commit. Remaining defect class is the RPC provider relationship, not the app: next lead is a second KEYED failover provider (or provider-side resolution of the blockhash shard-skew with this new signature as proof) |
| 2026-09-21 | spend | `icp-float` | ICP | -3.38 | sideshift-eurc shift c3644b54ba21a36dabd8 deposit 83d5d27c302ad22097780d8cebae93b3a3f56eaec4c791b460c2063fed7c5c6c (venue swept it; shift settled) | `icp:38520213` | REVERSE cefi leg ICP->EURC LANDS (attempt #10): 3.38 ICP sent through the real app IC send sheet at 22:40:25Z to the venue's deposit account (order created in-app 22:37:51Z, convert-dest-route-multihop:...:jupiter-usdc-eurc group + convert-dest-mech-sideshift-eurc mechanism; settle shown BEFORE confirm = census EURC ATA owner BzFNJ verbatim, refund = float 64-hex identifier 9fac39d1...2279 verbatim in the venue shift object); venue settle transfer sol:5uqg3tuP...tcB8a hit the ATA at 22:41:02Z = 37s after broadcast |
| 2026-09-21 | fee | `icp-float` | ICP | -0.0001 | ICP ledger transfer fee (reverse-shift deposit, block 38520213) | `icp:38520213` | attempt-#10 reverse leg — ledger fee alongside the venue deposit; float ICP 3.39528652 -> 0.01518652 = -3.3801 measured |
| 2026-09-21 | deposit | `sol-rail` | EURC | +8.724345 | sideshift-eurc shift c3644b54ba21a36dabd8 settle -> app-derived SOL rail BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX (EURC ATA 2f3WrCR93g3hYp6rC8Hk5Nz472Eb9XdthyUGpuj3jzn1) | `sol:5uqg3tuPQZyu8HFx16QhcUb4mhqby4WwPFCA4wDrzdinVPm3MpxY3nPbrLu2SCzHoa1YZhjdAsJWf8YpUjbtcB8a` | attempt-#10 SETTLED — independent on-chain read: ATA 0.474071 -> 9.198416 = +8.724345 = the order settleAmount EXACTLY (rate 2.581167159763 locked at order creation); slot 449192651, 22:41:02Z, 37s after the deposit broadcast |
| 2026-09-22 | fee | `sol-rail` | SOL | -0.000005 | dust-probe p9 tx 43x7oNa4dAnM2iYbX1pWTxFuhR6iuHSQsu9sJV6jdLQiPNEyjha4n4dFX6WkkKF9yD7gbp89FqSR8N9iMn2V2YT6 | `43x7oNa4dAnM2iYbX1pWTxFuhR6iuHSQsu9sJV6jdLQiPNEyjha4n4dFX6WkkKF9yD7gbp89FqSR8N9iMn2V2YT6` | attempt-#9 dust broadcast probe, network fee: the skipPreflight seam (817954d) PROVEN LIVE through the real app UI - sendSpl -> sign -> broadcast accepted (no provider preflight refusal) -> on-chain confirmed in ~3s |
| 2026-09-22 | spend | `sol-rail` | SOL | -0.00148844 | dust-probe p9 tx 43x7oNa4...2YT6 - ATA rent | `43x7oNa4dAnM2iYbX1pWTxFuhR6iuHSQsu9sJV6jdLQiPNEyjha4n4dFX6WkkKF9yD7gbp89FqSR8N9iMn2V2YT6` | attempt-#9 dust probe: probe-spec error (mine) - recipient given as the own ATA ADDRESS 2f3WrCR instead of the owner BzFNJ; the app correctly treats a destination as OWNER and derived ATA(2f3WrCR, EURC), which createIdempotent created (rent 1488440 lamports); that authority is off-curve so the rent is stranded. The seam itself (createIdempotent join + skipPreflight broadcast) is exactly what the funding leg needs and it worked |
| 2026-09-22 | spend | `sol-rail` | EURC | -0.01 | dust-probe p9 tx 43x7oNa4...2YT6 - stranded at ATA(2f3WrCR, EURC) | `43x7oNa4dAnM2iYbX1pWTxFuhR6iuHSQsu9sJV6jdLQiPNEyjha4n4dFX6WkkKF9yD7gbp89FqSR8N9iMn2V2YT6` | attempt-#9 dust probe: the 0.01 EURC landed at the derived ATA whose authority is the off-curve ATA address 2f3WrCR (no private key exists) - unrecoverable; net EURC across keys I control: -0.01; lesson recorded: diagnostics self-sends must name the OWNER (BzFNJ) so the derived ATA is the existing own ATA (the #6 precedent did exactly that) |
| 2026-09-22 | spend | `sol-rail` | EURC | -8.8 | sideshift-eurc shift d61b2eec59d5e5d45d6b deposit (venue ATA swept it; shift settled) | `5aU5jrY2nX8iShD8mfAac3Cwbtqfgfat3WJgYWw4zYP4hC9ydETSCipY3rVLVFUbWiQhYKzKkXWp4UZT9desFkt1` | THE EURC->ICP LEG LANDS (attempt #9): 8.8 EURC broadcast through the real app send sheet under the skipPreflight posture (817954d) at 22:14:39Z, on-chain confirmed ~3s, venue swept, shift SETTLED 22:17:26Z; settle 3.34293257 ICP at the float 64-hex identifier 9fac39d1...2279 verbatim, refund = rail owner BzFNJ; deposit ATA for the venue created by the tx createIdempotent join |
| 2026-09-22 | fee | `sol-rail` | SOL | -0.000005 | sideshift-eurc shift d61b2eec... deposit tx fee | `5aU5jrY2nX8iShD8mfAac3Cwbtqfgfat3WJgYWw4zYP4hC9ydETSCipY3rVLVFUbWiQhYKzKkXWp4UZT9desFkt1` | network fee of the attempt-#9 funding deposit (one legacy 1-sig tx) |
| 2026-09-22 | spend | `sol-rail` | SOL | -0.00148844 | sideshift-eurc shift d61b2eec... venue EURC ATA rent | `5aU5jrY2nX8iShD8mfAac3Cwbtqfgfat3WJgYWw4zYP4hC9ydETSCipY3rVLVFUbWiQhYKzKkXWp4UZT9desFkt1` | rent-exempt lamports locked into the venue deposit ATA the tx created (createIdempotent, one-time per destination; the venue owns/reclaims it going forward) |
| 2026-09-22 | deposit | `icp-float` | ICP | +3.34293257 | sideshift-eurc shift d61b2eec59d5e5d45d6b payout at the 64-hex identifier | `shift d61b2eec59d5e5d45d6b settled 22:17:26Z; independent ledger read: ICP 0.05235395 -> 3.39528652` | the ICP side of the EURC->ICP leg arrives: EXACTLY the quoted settleAmount to the last decimal (venue paid the ledger transfer fee); independent ICRC-1 check via just funds balance, never the shift object |
| 2026-09-27 | genesis | `evm-rail` | ETH·Eth | +0 | — | — | measured opening balance — the wallet starts unfunded (staging for the D31 mainnet ZCHF round trip pending) |
| 2026-09-27 | genesis | `evm-rail` | ZCHF·Eth | +0 | — | — | measured opening balance — the wallet starts unfunded (staging for the D31 mainnet ZCHF round trip pending) |
| 2026-09-27 | genesis | `evm-rail` | ETH·Arb | +0 | — | — | measured opening balance — the wallet starts unfunded (staging for the D31 mainnet ZCHF round trip pending) |
| 2026-09-27 | genesis | `evm-rail` | ZCHF·Arb | +0 | — | — | measured opening balance — the wallet starts unfunded (staging for the D31 mainnet ZCHF round trip pending) |
| 2026-09-27 | convert | `icp-float` | ICP | -0.01 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai (depositFromAndSwap pull from pool account ea65441e...60d6fc) | `icp:38634949` | LIVE round-trip trip-1 IC leg (uix branch acceptance, 2026-09-26/27): real app convert sheet ICP->VCHF, tap-2 confirm 'Convert 0.01 ICP', device-signed icrc2_approve + depositFromAndSwap through RNW web build against prod relay; quote-at-confirm 2.57 VCHF/ICP verbatim attributed+timestamped; settled in seconds; floor promised 0.00972766 VCHF at 1% (per-amount re-quote) |
| 2026-09-27 | fee | `icp-float` | ICP | -0.0001 | ICP ledger transfer fee (pool deposit, block 38634949) | `icp:38634949` | trip-1 input ledger fee alongside the approved amount; float ICP 0.01518652 -> 0.00498652 = -0.0102 measured exactly (0.01 + 2x0.0001) |
| 2026-09-27 | fee | `icp-float` | ICP | -0.0001 | ICP ledger icrc2_approve fee | `icp:approve-trip1` | trip-1 approve-leg ledger fee (the second of the two 0.0001 fees the sheet's census disclosed as Input fee 0.0001 ICP / approve) |
| 2026-09-27 | convert | `icp-float` | VCHF | +0.02562143 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai payout | `vchf:82178` | trip-1 SETTLED — done panel reports SEEN ledger figure verbatim ('You received 0.02562143 VCHF via ICPSwap, payout record 82178'); independent just funds balance read: VCHF 0.00008034 -> 0.02570177 = +0.02562143 EXACT |
| 2026-09-27 | convert | `sol-rail` | EURC | -0.5 | jupiter-usdc-eurc (lite-api Whirlpool route ArisQNcb...) swap EURC ATA -> venue pool | `sol:394mcX6X5d5k95kUfCe3MzD4pq583fVKxmJtEVE39ZEV2DJ7K7CiPVEJekX9D6UVcnovhwCdchAxFzWF9MvGwwDv` | TRIP-2 SETTLED (uix 145ec40 live acceptance, 2026-09-27): first live Jupiter execution after the asLegacyTransaction fix; real app two-tap convert 0.5 EURC -> USDC, standing target USD, device-signed venue-built tx, ONE broadcast via relay /api/v1/solana/rpc; independent RPC read: EURC ATA 9.198416 -> 8.698416 = -0.500000 EXACT; slot 450842679 |
| 2026-09-27 | convert | `sol-rail` | USDC | +0.569229 | jupiter-usdc-eurc Whirlpool payout to own USDC ATA (beneficiary check held: owner BzFNJ... both ATAs) | `sol:394mcX6X5d5k95kUfCe3MzD4pq583fVKxmJtEVE39ZEV2DJ7K7CiPVEJekX9D6UVcnovhwCdchAxFzWF9MvGwwDv` | TRIP-2 SETTLED — done panel figure == chain delta to the last digit (0.569229; implied rate 1.138458 USDC/EURC vs quote 1.138435, platformFee null); independent RPC read: USDC ATA 0.259311 -> 0.828540 |
| 2026-09-27 | fee | `sol-rail` | SOL | -0.000005 | Solana tx fee (Jupiter swap broadcast, user is fee payer) | `sol:394mcX6X5d5k95kUfCe3MzD4pq583fVKxmJtEVE39ZEV2DJ7K7CiPVEJekX9D6UVcnovhwCdchAxFzWF9MvGwwDv` | TRIP-2 network fee — exactly 5000 lamports, no priority fee charged; float SOL 0.001707955 -> 0.001702955 measured |
| 2026-09-27 | deposit | `icp-float` | ICP | +5 | founder | `icp:38640611` | founder top-up — history IN 5.0 ICP at block 38640611 from the same sender account 51e1d97c... as the 2026-09-20 top-up; census closes exact: recorded 0.00498652 + 5.00000000 = 5.00498652 measured via just funds balance |
| 2026-09-27 | convert | `icp-float` | ICP | -4.5 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai pull to pool account ea65441e...60d6fc (leg-1 SWAP of the VCHF flagship round trip: real app two-tap convert ICP->VCHF against prod relay) | `icp:38641313 memo 000000000002f26e` | LIVE round-trip leg-1: quote at confirm verbatim 11.69475451 VCHF @ 2.59883433 (min-out 11.57780696, 1%); measured float delta EXACTLY -4.50000000 |
| 2026-09-27 | fee | `icp-float` | ICP | -0.0002 | ICP ledger fees (icrc2 approve + pool deposit transfer) on the leg-1 SWAP input side | `icp:38641313` | measured leg-1 delta 5.00498652 -> 0.50478652 = -(4.5 + 2x0.0001); the two-fee census the sheet disclosed as Input fee 0.0001 ICP |
| 2026-09-27 | convert | `icp-float` | VCHF | +11.69465451 | icpswap pool 65mrh payout (leg-1 SWAP settled; app parked honest stuck at ~9s, chain settled at +11s; record flips done on reopen) | `vchf:82188 memo 000000000002f26e` | leg-1 payout = quote 11.69475451 minus the disclosed 0.0001 VCHF output ledger fee; above the signed min-out; independent just funds read 0.02570177 -> 11.72035628 |
| 2026-09-27 | convert | `icp-float` | VCHF | -11.69 | icpswap pool 65mrh sell (FLAGSHIP leg: composed VCHF->EURC via composed:icpswap:sideshift-eurc, real app two-tap; quote at confirm: SideShift verbatim 12.326598 EURC on 4.4265099 ICP midpoint, combined 1.054456 EURC/VCHF) | `vchf:82190` | flagship IC sell leg signed and settled in seconds; browser context died mid-flow ~t+98s (CDP hang under host contention) AFTER this swap settled — the composed record is device-local and was lost with it; funds landed in the wallet, nothing at any venue |
| 2026-09-27 | fee | `icp-float` | VCHF | -0.0002 | VCHF ledger fees (icrc2 approve + pool deposit transfer) on the flagship sell leg | `vchf:82190` | measured delta 11.72035628 -> 0.03015628 = -(11.69 + 2x0.0001) |
| 2026-09-27 | convert | `icp-float` | ICP | +4.47112213 | icpswap pool 65mrh payout (flagship IC leg settled; above the 4.4265099 minimum the venue pinned) | `icp:38641372` | pool out 4.47112213 ICP; engine next step (CeFi order + deposit) died with the browser context — completed below via the direct sideshift-eurc surface |
| 2026-09-27 | convert | `icp-float` | ICP | -4.47 | sideshift-eurc order deposit identifier e89628b1e766ebe56d326cc2eef802d76dced277231f57b3238313a5e46119a2 (order created in-app 11:49:45 via the relay proxy, docs-example partner creds PASS auth; the direct cefi surface narrates: you send the deposit to the venue address yourself) | `icp:38641763 memo 27` | flagship CeFi completion: new direct ICP->EURC conversion (SideShift verbatim quote 12.422931 EURC @ 2.779179, payout to own BzFNJ address shown on screen); deposit signed with the float device key, exact amount 4.47 ICP, inside the 15-min window |
| 2026-09-27 | fee | `icp-float` | ICP | -0.0001 | ICP ledger transfer fee on the venue deposit (block 38641763) | `icp:38641763` | measured delta 4.97590865 -> 0.50580865 = -(4.47 + 0.0001) |
| 2026-09-27 | convert | `sol-rail` | EURC | +12.422931 | sideshift-eurc payout to own EURC ATA BzFNJ... (venue-paid fee; app done panel: "12.422931 EURC received in your wallet", payout record 4D2cpJi3...fZcY) | `sol:4D2cpJi3ixayrdB4ii9mgmEYFKosBVRncWUv5X6QMbY1RRLdCcQZLMAecJD857mefSGpneuTKPL21fAfDHZvFZcY slot 450989680` | FLAGSHIP SETTLED: independent RPC read via relay proxy 8.698416 -> 21.121347 = +12.422931 = the verbatim quoted settleAmount to the last digit; done panel == chain == ledger |
| 2026-09-28 | genesis | `evm-rail-b` | ETH·Eth | +0 | null | `null` | measured opening balance (rail census, publicnode) — the EVM-rail counterparty B (m/44'/60'/0'/0/1 of the IC float seed) starts unfunded; D31 mainnet trip counterparty |
| 2026-09-28 | genesis | `evm-rail-b` | ZCHF·Eth | +0 | null | `null` | measured opening balance (rail census) — B starts with no ZCHF on Ethereum mainnet |
| 2026-09-28 | genesis | `evm-rail-b` | ETH·Arb | +0 | null | `null` | measured opening balance (rail census) — B is chain-1-only in the D31 trip; anchored so reconcile certifies it empty |
| 2026-09-28 | genesis | `evm-rail-b` | ZCHF·Arb | +0 | null | `null` | measured opening balance (rail census) — B is chain-1-only in the D31 trip; anchored so reconcile certifies it empty |
| 2026-09-28 | correction | `sol-rail` | EURC | +0 | null | `no deposit sig exists; sideshift-eurc shift 8d32dbf766593d4ac4f expired 11:04Z unfunded` | fund-icp attempt 1 — order created in-app (8.8 EURC -> 3.29678351 ICP, settle = float identifier verbatim), then the LOCAL relay + xff proxy were swept mid-handoff by a concurrent session's orphan-process cleanup (connection refused on every relay call) — the SPL deposit was never signed or broadcast (on-chain: EURC 21.121347 unchanged, no new sig); zero value at risk; order expired harmlessly. Infra restarted DETACHED with pidfiles; the re-run creates a FRESH order (no transfer was ever in flight — infra recovery, not a transfer retry) |
| 2026-09-28 | correction | `sol-rail` | EURC | +0 | null | `no deposit sig exists; orders 46013447ee6d85a8c015 / b4831152dd22e847c0f3 / f74c65be4a9dd4ba1ccd expired unfunded` | fund-icp attempts 2-4 (the swept-relay recovery runs): each order created in-app cleanly (settle = float identifier verbatim, SideShift quotes verbatim), but every deposit send died PRE-BROADCAST at the venue-ATA rent wall — the venue's fresh EURC deposit ATA does not exist (on-chain verified for all four deposit addresses) and creating it costs ~2039280 lamports while the rail holds 1702955; the app's review shows the exact cost honestly but the confirm press is INERT (no terminal state — UX finding, filed). Zero value ever in flight: EURC 21.121347 + SOL 0.001702955 measured unchanged throughout. LEG 1 BLOCKED on float-SOL dust (~0.00034 SOL short); disclosed in the trip report with the unblock asks (founder drip >=0.0004 SOL to BzFNJ… or >=0.6 ICP to the float for the direct ICP->ETH single shift) |
| 2026-09-28 | convert | `sol-rail` | EURC | -1.5 | jupiter-eurc in-app Convert via the local relay proxy | `sol:4cSBsbpYjnEYFKFjqJKyUxhC7MKsRDR5EynND1WUFTTcS44m2LMihVbHZU3H1KjUoF51s6BpK1PH4Ah3MkS9U1Nr` | D31 step-1 SELF-FUND: 1.5 EURC to SOL via the REAL app Convert (EUR rail to SOL rail, jupiter-eurc auto-pick, quote verbatim 0.014387047) |
| 2026-09-28 | convert | `sol-rail` | SOL | +0.014362347 | jupiter-eurc in-app Convert via the local relay proxy | `sol:4cSBsbpYjnEYFKFjqJKyUxhC7MKsRDR5EynND1WUFTTcS44m2LMihVbHZU3H1KjUoF51s6BpK1PH4Ah3MkS9U1Nr` | D31 step-1 proceeds: app done panel verbatim 0.014362347\ SOL\ received\ in\ your\ wallet (realized = fee payer post-pre, fee embedded) |
| 2026-09-28 | convert | `sol-rail` | EURC | -18 | sideshift shift 44d41b82c474a6bee578 deposit address Bz1HMvY6mGmHHPg6b7NLqXGWvR2rA2V5UowRxGgELM7v | `sol:2gZcVMb3s1fst7DT4TvV4rMf97LrUghqg7i6rgNjmwUnedyaXjDVoqADm9T9sB1G233wE9yncmhc7g9NKcotQTzg` | D31 step-2 EURC to ICP shift: in-app Convert order (settle = icp-float account id 9fac39d1..9279 verified on-screen), deposit sent via the app SOL send sheet, exact 18 EURC, venue confirmed funds, payout locked |
| 2026-09-28 | fee | `sol-rail` | SOL | -0.00149344 | SOL tx fee + venue deposit ATA rent for shift 44d41b82c474a6bee578 | `sol:2gZcVMb3s1fst7DT4TvV4rMf97LrUghqg7i6rgNjmwUnedyaXjDVoqADm9T9sB1G233wE9yncmhc7g9NKcotQTzg` | D31 step-2 measured SOL delta 0.016065302 to 0.014571862 on the deposit send (UNBLOCKED by step-1: the ATA rent the rail could not pay before) |
| 2026-09-28 | convert | `icp-float` | ICP | +6.69860354 | sideshift shift 44d41b82c474a6bee578 settle to icp-float 9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279 | `icp:38660671` | D31 step-2 SETTLED: 18 EURC in, 6.69860354 ICP out (venue-side fee embedded, implies 2.687 EURC per ICP vs 2.62 fair), float ICP 0.50580865 to 7.20441219 |
| 2026-09-28 | convert | `icp-float` | ICP | -4.0 | sideshift shift 85ebb666e8ec67b96688 deposit account 3c32f1a7bbd6504f4ab9d74179d46d90ad6e0d3ce9f5e942e79b8ad713c7b04e | `icp:38660718` | D31 step-3 ICP to ETH shift: in-app Convert (flow-223 sideshift-eth, quote 0.0044047 ETH verbatim, settle = evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 verified exact on-screen), deposit via the app IC send sheet, exact 4 ICP |
| 2026-09-28 | fee | `icp-float` | ICP | -0.0001 | ICP ledger transfer fee on the 4 ICP shift deposit | `icp:38660718` | D31 step-3 ICP to ETH shift: in-app Convert (flow-223 sideshift-eth, quote 0.0044047 ETH verbatim, settle = evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 verified exact on-screen), deposit via the app IC send sheet, exact 4 ICP |
| 2026-09-28 | convert | `evm-rail` | ETH·Eth | +0.0044058 | sideshift shift 85ebb666e8ec67b96688 settle to evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 | `0x234d6fda00bf27e21b99b6c1d4b032576f166261bbf02a7fb994c4e4a710531f` | D31 step-3 SETTLED: 4 ICP in, 0.0044058 native ETH out (app done panel verbatim, on-chain balanceOf confirms 4405800000000000 wei) - the EVM rail is funded |
| 2026-09-28 | fee | `evm-rail` | ETH·Eth | -0.00004856137228218 | Uniswap SwapRouter02 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 gas on a reverted multicall | `0x0193cb99ddee105bd9cb6ea5976f6e84678c80ea7d69bb76aa1dd8ce5314b28a` | D31 step-4 first attempt REVERTED at 27380 gas (block 26075896): the staged multicall lacked wrapETH so the WETH pull failed - diagnosed code bug in the never-executed script, gas burned and recorded, one corrected re-run follows (not a blind retry) |
| 2026-09-28 | convert | `evm-rail` | ETH·Eth | -0.000679768180797145 | Uniswap V3 ZCHF-WETH pool 0x79dc831d556954fbc37615a711df16b0b61df083 via SwapRouter02 | `0x0ab8f11a0dea11fbc4ad760490957f3d39007b63cd04c66b607a91c4263c7801` | D31 step-4 LEG-2 RECEIVE: 1.5 ZCHF bought on Ethereum mainnet, transfer from pool to rail verified on-chain, swap tx through the relay pipe |
| 2026-09-28 | convert | `evm-rail` | ZCHF·Eth | +1.5 | Uniswap V3 swap proceeds to rail 0x18884BC8e867eEf401703b702097220bdAe27668 | `0x0ab8f11a0dea11fbc4ad760490957f3d39007b63cd04c66b607a91c4263c7801` | D31 step-4 proceeds: rail ZCHF 0 to 1.5 (exact quote principal paid, 5 pct headroom swept back to ETH) |
| 2026-09-28 | fee | `evm-rail` | ETH·Eth | -0.000565362959482638 | Ethereum mainnet gas for the buy staging - 7 txs across 3 runs (duplicate deposits and approves from the never-executed scripts shakedown, all landed) | `0xb730c34b43bad5171e5318ee753473ebcc99526e44eb8fbeb3fb59fcca4a398e` | D31 step-4 total staging gas across deposit approve swap sweep on runs B C D (reverted first-attempt gas already ledgered row 183) |
| 2026-09-28 | spend | `evm-rail` | ETH·Eth | -0.002 | evm-rail-b 0xAa228406823f3816E04709DB4640009E6A0a2B56 settle-gas staging | `0xf17ade396930634fcd4753f444005616f65ce16f811bfc4736255b582db177b5` | D31 B-gas staging: 0.002 ETH rail to B (the app has no native-ETH send row by design - ERC-20 custody, ETH is gas - staged via the harness EIP-1559 stack through the relay pipe, gas 0.000027670253751) |
| 2026-09-28 | fee | `evm-rail` | ETH·Eth | -0.000027670253751 | Ethereum mainnet gas for the B-gas staging send | `0xf17ade396930634fcd4753f444005616f65ce16f811bfc4736255b582db177b5` | D31 B-gas staging: 0.002 ETH rail to B (the app has no native-ETH send row by design - ERC-20 custody, ETH is gas - staged via the harness EIP-1559 stack through the relay pipe, gas 0.000027670253751) |
| 2026-09-28 | deposit | `evm-rail-b` | ETH·Eth | +0.002 | evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 B-gas staging in | `0xf17ade396930634fcd4753f444005616f65ce16f811bfc4736255b582db177b5` | D31 B-gas staging in: B holds settle gas for the offline-permit claim (permit + transferFrom) |
| 2026-09-28 | spend | `evm-rail` | ZCHF·Eth | -0.5 | evm-rail-b 0xAa228406823f3816E04709DB4640009E6A0a2B56 in-app ZCHF send | `0x2168a18e268214d5801f9270e0eb200ab69b940144338bb0d71f7a77eb1f65d1` | D31 step-5 LEG-3 SEND: 0.5 ZCHF sent in-app (EvmWithdrawSheet, fee line verbatim, Sent seen on Ethereum) - production path through the relay pipe |
| 2026-09-28 | fee | `evm-rail` | ETH·Eth | -0.000043134889248804 | Ethereum mainnet gas for the in-app ZCHF send | `0x2168a18e268214d5801f9270e0eb200ab69b940144338bb0d71f7a77eb1f65d1` | D31 step-5 gas: measured receipt 51708 x 834201463 wei |
| 2026-09-28 | deposit | `evm-rail-b` | ZCHF·Eth | +0.5 | evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 step-5 in | `0x2168a18e268214d5801f9270e0eb200ab69b940144338bb0d71f7a77eb1f65d1` | D31 step-5 in: B receives 0.5 ZCHF (the merchant side of the round trip) |
| 2026-09-28 | deposit | `evm-rail-b` | ZCHF·Eth | +0.4 | evm-rail 0x18884BC8e867eEf401703b702097220bdAe27668 step-6 in | `0x546a44b4b0f03dc61f49bd7d77eb2fbbf5a901c104353812b0e54a1113afe7dd` | D31 step-6 in: B receives 0.4 ZCHF from the settled offline permit |
| 2026-09-28 | spend | `evm-rail` | ZCHF·Eth | -0.4 | claim settle for rid 077638fafd644fd2a8eb6fa359b946e5 - B permit + transferFrom, on-chain verified rail 1.0 to 0.6 | `0x546a44b4b0f03dc61f49bd7d77eb2fbbf5a901c104353812b0e54a1113afe7dd` | D31 step-6 LEG-4 OFFLINE PERMIT: request signed in the app with connectivity pinned offline, B settled the claim on mainnet, permit nonce consumed, B delta exactly 0.4 |
| 2026-09-28 | fee | `evm-rail-b` | ETH·Eth | -0.000113505656707782 | Ethereum mainnet settle gas paid by B - permit 74528 + transferFrom 37753 gas at 0.51 gwei base | `0x505267d9e069d53d8364ba2be14105e3357c709c5ecc61429b9ebaf1eaf84ab0` | D31 step-6 B settle gas for permit + transferFrom |
| 2026-09-28 | spend | `evm-rail` | ZCHF·Eth | -0.1 | claim settle rid f158b882a701af70fea0189a79f622f1d - B permit + transferFrom, on-chain verified rail 0.6 to 0.5, B 0.9 to 1.0 | `0x9f18355d3ac23a1c7ea78c87b8df34f196c000c4a36c99aa4dc816f938e8dd6e` | D31 step-6 second claim in the combined live loop - the settle legs landed on-chain, the scripts post-check tripped on a lagging RPC read, verified by balance and nonce reads |
| 2026-09-28 | deposit | `evm-rail-b` | ZCHF·Eth | +0.1 | claim settle rid f158b882a701af70fea0189a79f622f1d - B permit + transferFrom, on-chain verified rail 0.6 to 0.5, B 0.9 to 1.0 | `0x9f18355d3ac23a1c7ea78c87b8df34f196c000c4a36c99aa4dc816f938e8dd6e` | D31 step-6 second claim in the combined live loop - the settle legs landed on-chain, the scripts post-check tripped on a lagging RPC read, verified by balance and nonce reads |
| 2026-09-28 | fee | `evm-rail-b` | ETH·Eth | -0.000097361533537823 | Ethereum mainnet settle gas paid by B - B ETH 0.001886494343292218 to 0.001789132809754395 | `0x9f18355d3ac23a1c7ea78c87b8df34f196c000c4a36c99aa4dc816f938e8dd6e` | D31 step-6 second-claim B settle gas for permit + transferFrom, measured by B balance delta |
| 2026-09-28 | spend | `evm-rail` | ZCHF·Eth | -0.1 | claim settle rid 5b8e35112acc6276b383e34dc159bc - the full loop in one live app context, offline sign then settle then app badge cleared | `0x986e7eb3ac56ec8ec3557fa826a22096047ce8287ec47016273a6ebf1171a407` | D31 step-6 APP-CATCH-UP PROOF: offline sign - settle PASS - back online the pending badge resolved on its own against the chain - on-chain rail 0.5 to 0.4, B 1.0 to 1.1 |
| 2026-09-28 | deposit | `evm-rail-b` | ZCHF·Eth | +0.1 | claim settle rid 5b8e35112acc6276b383e34dc159bc - the full loop in one live app context, offline sign then settle then app badge cleared | `0x986e7eb3ac56ec8ec3557fa826a22096047ce8287ec47016273a6ebf1171a407` | D31 step-6 APP-CATCH-UP PROOF: offline sign - settle PASS - back online the pending badge resolved on its own against the chain - on-chain rail 0.5 to 0.4, B 1.0 to 1.1 |
| 2026-09-28 | fee | `evm-rail-b` | ETH·Eth | -0.000102164688507077 | Ethereum mainnet settle gas paid by B - B ETH 0.001789132809754395 to 0.001686968121247318 | `0x986e7eb3ac56ec8ec3557fa826a22096047ce8287ec47016273a6ebf1171a407` | D31 step-6 third-claim B settle gas, measured by B balance delta |
| 2026-09-29 | convert | `icp-float` | ICP | -3.20421219 | sideshift shift 293f9f3d562dd23e943e deposit account 650925cac9051cb233c39d9eeaa6fdda7281ec13829fd4bde3a4d5b2fd0f66fe | `icp:38678542` | D32 phase-1 leg (self-funded ICP-EURC-ICP-VCHF round): in-app Convert ICP-EURC cefi row, max-net prefill 3.20421219, review verbatim "Quote from SideShift, fetched 7:11 AM" ~9.23 EURC, settle = float SOL rail BzFNJ verified on-screen; deposit sent via the app IC send sheet (the handoff second press) |
| 2026-09-29 | fee | `icp-float` | ICP | -0.0001 | ICP ledger transfer fee on the D32 phase-1 shift deposit | `icp:38678542` | D32 phase-1: measured delta 3.20431219 to 0 (send 3.20421219 + ledger fee 0.0001) |
| 2026-09-29 | convert | `sol-rail` | EURC | +9.273976 | sideshift shift 293f9f3d562dd23e943e payout to rail BzFNJ (venue-paid fee), settleHash FgBxRYpFuWiQ4MXK1KBbkDALoLhnKDnKVEZRKChSLuh3iDTDt6JUDhsgSo15KE65o7giEw7bkXmresdH7FDFcDx | `sol:FgBxRYpFuWiQ4MXK1KBbkDALoLhnKDnKVEZRKChSLuh3iDTDt6JUDhsgSo15KE65o7giEw7bkXmresdH7FDFcDx` | D32 phase-1 SETTLED: venue status settled, 3.20421219 ICP in at rate 2.894307695646, 9.273976 EURC out; measured rail 1.621347 to 10.895323 = the verbatim settleAmount to the last digit; record step done; done panel == chain == ledger |
| 2026-09-29 | correction | `sol-rail` | EURC | +0 | null | `no deposit sig on chain; orders 2db2e552feb1e6054ea8 + cea244851f4d8fa29c44 (+ one 07:29Z order id unrecorded) expired unfunded` | D32 phase-2 chain-route attempts BLOCKED by a submit-path defect: the chain record freezes order + locked settle (verbatim, settle = float IC account 9fac39d1 verified on-screen) and signs the SPL deposit, but the broadcast never reaches Solana - getSignatureStatuses null (history-searched) for sigs 5YbxaMGz...kpQS and 2voWTQ6Y...GNux, rail EURC measured 10.895323 unchanged through every attempt, ICP/VCHF unchanged; relay solana pipe answers 200; record flips to stuck ~2min post-CTA with mislabeled pool copy on a legs=[] chain phase-1 record. ZERO value at risk: no transfer ever in flight (infra defect, not a transfer retry); disclosed, OPEN_ISSUES filed |
| 2026-09-29 | correction | `icp-float` | ICP | +0 | null | `no deposit sig exists; the 07:11Z ICP-EURC order (id unrecorded, driver killed pre-send) expired unfunded at the venue` | D32 phase-1 first attempt: order created in-app (order before signature, zero value in flight), driver aborted before the deposit press; a fresh order 293f9f3d562dd23e943e in the next run completed. No movement |
| 2026-09-29 | convert | `sol-rail` | EURC | -10.895323 | sideshift shift ebda94c3edeacc757eeb deposit account 3mmw4sTC12ASPHfbuZFXvRQ5tWBVeA4o9cNXcDKkUpXg | `sol:4PdWhqaXRucHkWFuPUELLYPoBGuCZBDMTFoSr7MUVVvMTwk7GDyrCcnooxTvTUBqs3q3pvWAdYJEJWqXDv71hJiZ` | D33 chain phase-1 (the D32 broadcast FIX live-proven): in-app chain row EURC-VCHF via ICPSwap, Max-net 10.895323, order created FIRST (verbatim locked settle 3.62188403 ICP, settle = float IC account verified on-screen), frozen deposit broadcast skipPreflight - FINALIZED slot 451585937 err null; rail 10.895323 to 0 |
| 2026-09-29 | fee | `sol-rail` | SOL | -0.00149344 | SOL tx fee + venue deposit ATA rent for shift ebda94c3edeacc757eeb | `sol:4PdWhqaXRucHkWFuPUELLYPoBGuCZBDMTFoSr7MUVVvMTwk7GDyrCcnooxTvTUBqs3q3pvWAdYJEJWqXDv71hJiZ` | D33 chain deposit: measured SOL delta 0.014571862 to 0.013078422 on the deposit send |
| 2026-09-29 | convert | `icp-float` | ICP | +3.62188403 | sideshift shift ebda94c3edeacc757eeb settle to float IC account 9fac39d1..2279 (venue settleHash ref 38680543) | `icp:38680561` | D33 chain phase-1 SETTLED: 10.895323 EURC in, 3.62188403 ICP out at rate 0.332425576552 = the verbatim locked settleAmount to the last digit |
| 2026-09-29 | convert | `icp-float` | ICP | -3.62168403 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai deposit (chain phase-2 leg-1 self-funded input: floor 3.62188403 minus 2x ledger fee) | `icp:38680566` | D33 chain phase-2 leg 1: icrc2_approve + pool deposit transfer signed from the frozen plan, executed on-chain (the record UI parked stuck on the slow watch while the chain completed - the 2026-09-27 prod-latency class) |
| 2026-09-29 | fee | `icp-float` | ICP | -0.0002 | ICP ledger fees: icrc2_approve + pool deposit transfer on the chain phase-2 legs | `icp:38680566` | D33 chain phase-2: balance math IN 3.62188403 - OUT 3.62168403 - fees 0.0002 = 0 measured |
| 2026-09-29 | convert | `icp-float` | VCHF | +9.89426484 | icpswap pool 65mrh-fqaaa-aaaar-qapoa-cai payout (chain phase-2 leg-2: ICP-VCHF, 1% slippage floor honored exactly) | `vchf:pool-payout-d33 (pool transfer; VCHF delta 0.03015628 to 9.92442112 = +9.89426484 = the record expectedNet to the last digit)` | D33 chain phase-2 LEG 2 SETTLED - THE FOUNDER PAIR COMPLETE: EURC 10.895323 -> ICP 3.62188403 -> VCHF 9.89426484 net; UI narration == chain == ledger on every leg |
| 2026-10-02 | spend | `icp-float` | VCHF | -3.00 | qwpyc-dtbsp-hcdqu-o2uzl-xz6pe-rpfbv-s7ib3-tyy5n-wq64h-dj2lz-iqe (trip2 ATA-lane VCHF deposit, no memo) | `vchf:82546` | lane-G founder-approved test spend: 3.00 VCHF to the trip2 wallet via the REAL web wallet Withdraw/send sheet (prod relay dpay.kalaj.org, in-app icrc1_transfer, review verbatim fee 0.0001 VCHF total 3.0001 VCHF, Sent + Ledger block 82546 on-screen) |
| 2026-10-02 | fee | `icp-float` | VCHF | -0.0001 | VCHF ledger transfer fee on block 82546 | `vchf:82546` | ICRC-1 ledger fee for the lane-G 3.00 VCHF send to trip2 |
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
