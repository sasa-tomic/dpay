# Solana RPC — how to move forward

**Status: proposal. Nothing here is decided.** Written 2026-09-08 against `0e9719c`.

The founder asked: *"For Solana, propose how to move forward."* This file is the authority for the
request arithmetic and the options. `OPEN_ISSUES.md`'s "LIVE OUTAGE" block restates the 208/128
totals; when this lands, cut that block to a pointer at this file.

---

## 0. The one-paragraph answer

The endpoint is dead because the quota is gone, and a client that idles at **128 requests a minute**
is why quota goes. Buying a bigger plan first would be paying for the right to keep wasting it. The
cheap structural fixes cut the idle **request** rate about **25×** — and the *billed* rate by
somewhere between 6× and 25×, depending on a provider billing detail that must be read off their
page and not assumed (§2 C1) — and they cost nothing but code. Do those first, rotate the key (it is
published at a public URL — I read it out of the production bundle), and put a **liveness probe in
the release gate** so the next exhaustion is caught by a build and not by a user.

Then the surprise from the provider research: at the current rate one phone left on a table exhausts
a free month in **5.4 days**, and at the post-fix rate the same free tier carries roughly **190
wallets** — so after the demand cut there may be nothing to buy for the pilot at all (§3.1). The two
decisions that stay the founder's are whether to buy anyway for margin, and whether dpay's relay is
allowed to proxy Solana reads.

---

## 1. Measured facts

Everything in this section was checked this session. "Measured" = I ran it. "Read" = I read the code
or the served bytes. Nothing here is from memory.

### 1.1 The endpoint is refusing (measured)

```
POST https://mainnet.helius-rpc.com/?api-key=76929a9c-… {"method":"getHealth"}
→ HTTP 429
→ max usage reached
```

**It is quota exhaustion, not a rate limit — and the reasoning matters because Helius does not
document this.** Their published 429 semantics cover rate limits only ("Rate limits reset every
minute"); what a key does when its monthly credits run out appears on no Helius page we could find
(§3). So the message text is not proof on its own. The proof is the shape of my probe: **two single
requests, hours apart, each the only request in flight.** One request cannot trip a 10 req/s cap. A
persistent 429 under those conditions is an account-state refusal, and no client-side backoff fixes
it. The public endpoint, by contrast, answered fine at the same moment:

```
POST https://api.mainnet-beta.solana.com {"method":"getHealth"} → HTTP 200 {"result":"ok"} (0.53s)
```

The production relay is at HEAD (`GET /api/v1/version` → `commit: 0e9719c…`) and its catalog serves
all three Solana rows including EURC with its mainnet mint (`GET /api/v1/currencies`). So the live
product offers EUR, and EUR's preferred rail is the one that cannot be read.

**A contradiction only the founder can resolve.** The commit that baked this key
(`b2459ca`, 2026-08-09) calls it "paid Helius mainnet endpoint". The endpoint says the usage is
spent. Either it was never a paid plan, or a paid plan's monthly allowance ran out. I cannot see the
Helius dashboard; this is a founder-only fact and it changes which option is right.

### 1.2 The key is public, not merely extractable (measured)

The commit note reasoned about this as an APK secret — *"extractable from the APK regardless. If the
repo is to go public, rotate the key."* That threat model missed the surface that actually ships it.
The web wallet publishes the key as plain text at a stable URL, no decompilation required:

```
curl -s https://dpay.kalaj.org/assets/wallet-YUXs7qXc.js | grep -o 'mainnet.helius-rpc.com/?api-key=[0-9a-f-]*'
→ mainnet.helius-rpc.com/?api-key=76929a9c-…   (the full literal, byte-identical to constants.ts)
```

One literal, one build-time constant, every install and every browser session sharing it. An abuser
gets free general-purpose Solana RPC on dpay's quota — they do not need the app, only `curl`. The
key signs nothing and holds nothing (the device key signs; `CLAUDE.md` non-custodial rule holds), so
the loss is quota and money, not funds. **I cannot tell self-inflicted burn from third-party abuse
from the outside**; §1.5 shows our own burn is easily sufficient on its own, so do not assume abuse
without the dashboard.

### 1.3 What the release guard actually enforces (read)

`scripts/check-prod-sol.mjs`, wired at `scripts/build-apk.sh:47`:

1. Extracts the `??` default out of `app/config/constants.ts` by regex; fails if absent.
2. If `DPAY_SOL_RPC` is set, the baked literal must equal it exactly (catches a stale constant after
   an operator flips the value). **`DPAY_SOL_RPC` does not set anything — it only asserts.**
3. Fails if the literal matches `/devnet/i`, `/testnet/i`, or `/api\.mainnet-beta\.solana\.com/i`.

Two gaps, both real:

- **It is a string check, never a liveness check.** It passes happily on a key that has been
  answering 429 for hours. It was blind to the exact thing that broke.
- **It guards the APK path only.** `grep -rn check-prod-sol` matches `scripts/build-apk.sh` and
  nothing else. The web wallet build (`just web` → vite `--mode web-prod` → `e2e/dist-prod`, embedded
  by the relay's `build.rs` and served at `/wallet`) never runs it. Half the shipped surface is
  unguarded, and it is the half that publishes the key.
- **Its public-endpoint pattern can be walked around by spelling.** The regex is
  `/api\.mainnet-beta\.solana\.com/i`, but Solana's docs now name the mainnet endpoint
  **`api.mainnet.solana.com`** — which does not match. **Verified twice, independently:**
  `api.mainnet.solana.com` answers `getHealth` with HTTP 200 and the same
  `x-ratelimit-tier: free` / `rps-limit: 250` / `method-limit: 150` headers as the `-beta` name (the
  `x-rpc-node` id differs by point of presence, as expected of a geo-balanced endpoint), and
  `node -e "/api\.mainnet-beta\.solana\.com/i.test(…)"` returns `true` for the old spelling and
  `false` for the new one. So the guard blocks one spelling of the endpoint it means to block and
  waves the other through. Match on the parsed host against a set of names, not on one substring.

### 1.4 There is no runtime config slot (read)

`CODEBASE_ANALYSIS.md:251` says *"`SOLANA_RPC_URL` is config-driven so an operator pastes a
Helius/QuickNode URL+key later."* **That is misleading and should be corrected.** What exists:

| Seam | Reality |
|---|---|
| `SOLANA_RPC_URL` in `app/config/constants.ts` | A build-time literal. Changing it means editing source. |
| `__DPAY_TEST_SOLANA_RPC_URL` | A test-only global (`jest.setup.js`, e2e driver). Prod never sets it. |
| `DPAY_SOL_RPC` env var | Assertion input to the guard. Does not inject a value. |
| AsyncStorage / Settings | **Nothing.** `grep -i solana app/components/Settings*.tsx` matches only the seed-backup prose (one seed derives both rails) and a currency group label — no endpoint field, no storage key. |
| `process.env` in `config/`, `lib/`, `services/` | Zero matches. |

Compare the relay URL, which is a real runtime slot: `RELAY_STORAGE_KEY`, persisted, editable in
Settings behind an advanced marker, applied explicitly. The Solana endpoint has none of that. So
today, **rotating the key is a source edit, an APK rebuild, and a Play release** — days, not seconds.
That is the operational wound underneath the outage.

The long-standing `beta.helius-rpc.com` "gatekeeper" note (`OPEN_ISSUES.md:211`) is **still true**: I
grepped every `.md`, `.ts`, `.tsx`, `.rs`, `.mjs` in the tree and that host appears in exactly one
place — the open-issue line itself. No config slot, no code reference, no test. It has been open
since 2026-08-09. Confirm its purpose or drop it.

### 1.5 The demand arithmetic (re-derived from the code, not estimated)

Shipped Solana rails: **3 rows, 2 SPL mints** — SOL (native), USDC, EURC — in both the bundled
catalog (`app/config/catalog.ts:320,321,327`) and the relay's compiled catalog.

**Pollers, and what each costs per tick.** Both hooks are mounted at `Wallet.tsx` top level
(lines 249, 275), so they run on *every* screen — Home, Pay, Receive, Convert, Settings. The mint
list is `visibleSolanaMints(networks)`, which is every coherent catalog mint, not what is on screen.
`grep -rn "AppState|visibilitychange"` finds two uses, neither of which pauses a poll (the camera,
and an NFC-status re-read). **Nothing stops when the app is backgrounded.**

| Poller | Interval | Requests per tick | Per minute |
|---|---|---|---|
| `useSolanaBalances` SOL effect | `POLL.balance` = 2500 ms | 1 (`getBalance`) | 24 |
| `useSolanaBalances` token effect, USDC | 2500 ms | 2 — `getAccountInfo` then `getTokenAccountBalance` (`solana.ts:346,348`) | 48 |
| `useSolanaBalances` token effect, EURC | 2500 ms | 2, same shape | 48 |
| `useSolanaHistory` | `POLL.history` = 15000 ms | 2 `getSignaturesForAddress` (owner + USDC ATA) + one `getTransaction` per uncached signature, cap 20 | 8 warm / 88 cold |
| | | **steady state** | **128** |
| | | **before today's detail cache** | **208** |

Both previously-reported numbers reconstruct exactly: `24+48+48+88 = 208`, and `24+48+48+8 = 128`.
The 80/min delta is entirely the transaction-detail cache; the in-flight guard removes amplification
under latency but not steady-state count.

- **Cold-load burst, counted separately:** 1 (SOL) + 2 (USDC) + 2 (EURC) + 2 (signature pages) + up
  to 20 (`getTransaction`) = **up to 27 requests in the first second or two**, most of them
  concurrent.
- **Scaling with rails:** +2 requests/tick = **+48/min per additional SPL mint**. A fourth Solana
  rail (VCHF on Solana is in the currency model) makes it 176/min.
- **Scaling with screen:** none. That is the defect.
- **Per month, one continuously-open wallet:** 128 × 60 × 24 × 30.44 ≈ **5.6M requests**. A wallet
  open 30 min/day ≈ **117k/month**. Either number is large against a free tier, and note the first
  one is reachable by a single phone left on a table, because nothing stops on background (above).
- **What a payment costs, for scale:** creating a request is 1–2 (`getGenesisHash`, cached per
  session, + `getLatestBlockhash`); broadcasting is `isBlockhashValid` + `getBlockHeight` +
  `sendTransaction` + a `getSignatureStatuses` poll every 1.5 s, so ≈ 4–24. **An idle wallet spends
  5–25 payments' worth of quota every minute doing nothing** — a fast confirm at the top of that
  range, a slow one at the bottom.

The client hardening landed today (per-endpoint 429 cooldown, in-flight guard, detail cache) **is
live in production** — I verified it in the served bytes, not in the source:
`https://dpay.kalaj.org/assets/rpc-BC7BQojV.js` contains both `Retry-After` and the
`solana rpc rate limit` message, and `assets/history-ByGHfvq0.js` contains the 200-entry detail
cache. (My first pass looked only at the main bundle and wrongly concluded production was
un-hardened; the RPC and history modules are dynamic-imported into their own chunks.) It bounds the
bleeding — under a 429 the wallet probes once per backoff window instead of 128 times a minute — and
it does not and cannot restore service.

### 1.6 What a EUR user actually gets today

`app/config/currency.ts:58` — `EUR: ['EURC', 'VEUR']`. EURC on Solana is preferred. CHF (VCHF) and
USD (ckUSDC first) are both IC-preferred and unaffected. **EUR is the only currency whose default
rail is dead.**

Three consequences, in increasing order of how much they matter:

1. **The landing screen shows a bare `—` and says nothing; the explanation is one screen deeper.**
   `lib/assetBalances.ts` maps `'error'` to "preserve the prior balance", so on a cold start it is
   `null` → `—`, visually identical to a first poll still in flight. The honest copy *does* exist and
   *is* wired — `AccountsTab.tsx:160–166` emits `M.errors.rail.unreadable(network)` once per
   settlement network, immediately above the first affected row, with a dedicated test file
   (`app/__tests__/HomeRailHonesty.test.tsx`). **`OPEN_ISSUES.md`'s S1 row is stale; correct it.**
   What is *not* done is `HomeTab.tsx:84` — `balances[homeAsset.id]?.displayText ?? '—'`, with no
   status branch at all. Since the founder's 2026-09-08 reversal made Home the landing screen, a EUR
   user's first sight of the wallet is an unexplained dash, and the sentence explaining it lives in
   the Accounts list they have not opened. That is the remaining violation of the 2026-08-29
   every-step-instruction rule. *(Read from code — the deployed SPA would not boot in the headless
   browser available here, so I did not see either state rendered. `app/components/**` is also being
   edited by another agent as I write, so re-check `HomeTab.tsx` before acting on this.)*

2. **Every safety gate that depends on knowing the token account exists fails open.** By design:
   `solPayGate` and `solSplSignGate` (`app/config/assets.ts`) treat `'error'` as *unknown* and allow,
   because an offline payer must still be able to sign. Correct for airplane mode; wrong for a
   permanently dead endpoint. Net effect: a EUR user with no EURC token account can sign an EURC
   payment that the merchant's broadcast will be rejected on-chain — the dead-QR case
   `solSplSignGate` was written to prevent. The persisted fact store
   (`services/solTokenStatePersist`) covers wallets that once polled successfully; a wallet that
   never has is unprotected.

3. **EURC has no transaction history at all, and this is independent of the outage.**
   `fetchSolanaHistory` queries the owner address and `deriveAta(owner, USDC_MINT_ADDRESS)` — USDC
   only. `usdcDeltasByOwner` filters on `mint !== USDC_MINT_ADDRESS`. The row type is
   `SolanaHistoryToken = 'SOL' | 'USDC'`, and `toTxn` maps anything non-SOL to `'solana:USDC'`. So an
   **incoming EURC payment is invisible** (the wallet is not in the transaction's account list, only
   its ATA is, and that ATA is never queried), and an **outgoing one renders as a ~0.000005 SOL
   debit**. On the preferred EUR rail. Fixing it costs one more signature query per mint — which is
   exactly why the request budget has to be settled first.

### 1.7 What the relay already does, and where the line is

Relay routes (`crates/dpay-relay/src/app.rs:236–311`), all read-only since the 2026-08-19 cutover:
`/balances/{hex}`, `/transactions/{hex}`, `/deposit/info`, `/currencies`, `/onramp/ckerc20`,
`/health`, `/capabilities`, `/version`, `/integrity`, `/swap_quote`, plus the flag-gated till.

- `/balances/{hex}` is a **concurrent fan-out**: one `icrc1_balance_of` per catalog currency under
  `join_all`, each with its own timeout, best-effort (a wedged ledger is omitted and logged).
  Structurally identical to what a Solana read proxy would be.
- `/swap_quote` is explicitly documented in-code as *"a READ PROXY (same class as the balance
  fan-out)"* — allowlist the pool, return the venue's own numbers verbatim, never compute a rate.
- The relay already holds three TTL caches (`agent_ledger.rs`): `deposit_info` 60 s,
  `swap_pool_metadata` 60 s, and per-`(ledger, account, currency)` history.
- It already has a keyed windowed limiter: `faucet::FaucetCooldown`, per-account, extendable.
- `reqwest` (rustls) is already linked in the prod image transitively via `ic-agent`, so an outbound
  HTTP proxy adds no new crate to the build — though it would need declaring explicitly rather than
  relying on a transitive.

**What does NOT go through dpay: value.** The app signs IC `/api/v2` envelopes and submits them to
the boundary nodes itself; there is no `/pay`, no settlement `Ledger` trait, no relay broadcast path
on any rail.

**Where the line is drawn.** `docs/REGULATORY.md` §4, the design-constraint checklist:

> 1. Never route funds through a dpay-controlled address or contract, even momentarily.
> 2. Never be able to release, stop, or reverse a transaction.
> 3. **Let the user's own device submit the signed transaction. Do not relay or broadcast through
>    dpay infrastructure.** … this is the limb most arguable against dpay today (§1.9).

(Both "§1.9" references above are `REGULATORY.md`'s, not this file's; it flags that the relay *may
already be a payment system* under FINMA Circ. 11/1 Rz 63–66.)

So: **reads are inside the line and precedented; broadcast is named on the wrong side of it.**

---

## 2. Options

### A — Buy a paid key, still baked in the client

**Fixes:** the outage, today, with one line and a release.
**Does not fix:** the 128/min burn (you are now paying for it); the published key (you are paying for
strangers' RPC too); the days-long rotation latency; the blindness that let it ship dead; the EUR
rail's missing history; the fail-open gates.
**Cost:** $49/mo at the entry tier for either Helius or QuickNode (§3) + one constant + an APK
release + a web redeploy. Note what that buys against measured demand: Helius Developer's 10M credits
is 10× the free tier, i.e. it moves the 5.4-day burn to about 54 days. It postpones; it does not fix.
**Non-negotiables touched:** none.
**Time:** hours, mostly Play review.
**Forecloses:** nothing. It is strictly a purchase.

Honest read: A is necessary but is not a plan. On its own it re-arms the same trap on a bigger fuse.

### B — Proxy Solana READS through the relay

Relay holds the key; the app calls `GET /api/v1/sol/*` (allowlisted methods, TTL cache, per-client
limit); the device keeps signing and broadcasting.

**Does this put dpay in the money path?** *Reads: no. Broadcast: yes, and that is why broadcast must
not move.*

- A read proxy cannot alter a transaction, cannot forge a signature, cannot move funds, and cannot
  release/stop/reverse anything. It touches neither constraint #1 nor #2.
- It **can** lie or stall — serve a stale blockhash, hide a balance, withhold a confirmation. That is
  censorship-and-delay, not control of funds. The distinction survives the non-custodial rule
  (`CLAUDE.md`: no custody, no key, no ability to move funds — all intact).
- Constraint #3 names broadcast explicitly. Moving `sendTransaction` to the relay would put dpay in
  the transmission path on the one rail where it currently is not, and would strengthen the `REGULATORY.md` §1.9
  payment-system flag against us. **Do not move broadcast.**
- The honest cost that is easy to miss: it does not cross the line, but it **thickens the thing
  already flagged**. Today the SOL rail has zero dpay dependency; after B, a dpay outage blanks it.

**And B does not actually hide the key.** If broadcast stays on device (it must), the device needs
*some* endpoint for `sendTransaction`, so either it keeps a credential — leak persists — or it
broadcasts to the public endpoint, which Solana documents as not for production. Adding a fallback
between them is forbidden by the one-code-path rule, so this is a real fork, not a detail.
**What B genuinely buys is that the leak stops mattering:** polling is ~99% of the traffic, and once
polling is server-side a leaked device credential is worth a handful of requests per payment instead
of 128 a minute. Plus central rotation with no client release, and a place to cache the one read that
is genuinely shared across all users — `getLatestBlockhash`.

**Cost:** ~150–250 lines of relay + tests, reusing three existing shapes (fan-out handler, TTL cache,
`FaucetCooldown`); declare `reqwest`; app-side swap of the RPC base URL. Privacy: the relay learns
every user's Solana address and polling pattern — it already learns the IC pubkey via
`/balances/{hex}`, so this is an extension of an accepted exposure, not a new class.
**Time:** 1–2 days.
**Forecloses:** nothing technically. It does spend some of the `REGULATORY.md` §1.9 argument, which is the reason
this is a founder decision and not an engineering one.

### C — Cut demand structurally

Four independent moves, each quantified against §1.5's 128/min baseline.

| | Change | Result | Effort |
|---|---|---|---|
| **C1** | Collapse the balance fan-out into one `getMultipleAccounts([wallet, usdcAta, eurcAta])` per tick — 5 requests → 1 | balance 120 → 24/min; total **128 → 32/min** | S |
| **C2** | Idle cadence: 2.5 s only while a money flow is live, 20–30 s otherwise; history 15 s → 60 s idle | total **32 → ~5/min** | S |
| **C3** | Stop polling when backgrounded (`AppState` on native, `visibilitychange` on web) | **0/min** while not on screen | S |
| **C4** | Replace polling with websocket `accountSubscribe` on the three accounts | ~0 steady state; push on change | M–L |

C1 + C2 together are **about a 25× cut, and they cost nothing but code.** That is a bigger win than
any tier upgrade, which is the whole reason this option is first in the recommendation.

Three things about C1 that must not be skipped:

- A JSON-RPC 2.0 **batch** (array body, one HTTP POST) is the zero-risk variant — same methods, same
  responses, no new parsing. But whether a provider bills a batch as one call or as N **must be
  verified against that provider's own docs**; if it bills N, a batch cuts HTTP requests and not
  quota. The same question applies to `getMultipleAccounts` itself: it is one *call*, but a provider
  billing in compute units may price it per account returned. **Confirm the billing unit before
  claiming the 25× — the HTTP-request reduction is certain, the quota reduction is not until that
  page is read.**
- `getMultipleAccounts` returns `null` for a non-existent account, so the `'absent'` vs `'balance'`
  distinction the ATA gates depend on is preserved exactly. **Measured today**, not assumed — one
  request against the public endpoint for `[USDC mint, <random valid pubkey>]` returned
  `[{owner: Tokenkeg…, lamports: 533414245631, data: <base64>}, null]`. The same response shape
  carries a plain wallet's `lamports`, which is why one call replaces all five.
- It returns raw account **data**, so the SPL token amount must be decoded client-side, and the
  RPC-side `decimals` cross-check in `getTokenAccountBalance` is lost. **I have not verified the SPL
  token-account byte layout and will not assert it from memory** — pin it against the SPL Token
  program's published Account layout before writing the decoder, and read the mint account once per
  session to confirm decimals rather than trusting the catalog silently.

And one on C2: **`POLL.balance` is shared with the IC rail** (`hooks/useBalancePoll.ts:160`), which
fans out to mainnet ledgers through the relay on the same 2.5 s beat. Do not implement idle cadence
by editing that constant — that silently re-times a second rail. Add the cadence as a hook-level
concept so each rail's change is deliberate. (The IC rail probably wants the same treatment; that is
a separate decision with its own evidence, and it is not this file's to make.)

C4 turned out **not** to depend on a paid tier — Helius, Alchemy and Chainstack all include standard
`accountSubscribe` on their free plans (§3). What it does depend on is the concurrent-connection cap
(Helius Free: 5), which may be per key and therefore incompatible with a shared baked key. Do not
attempt it before C1–C3, which may make it unnecessary anyway.

**Non-negotiables touched:** none, with one caveat — C2/C3 must not degrade the offline-payer path.
They are read-cadence changes only; signing is already pure and offline.
**Forecloses:** nothing.

### D — Make the endpoint operator-configurable at runtime

A persisted `dpay.solanaRpc.v1` slot plus an advanced Settings field, mirroring `RELAY_STORAGE_KEY`
exactly: draft state, explicit Apply, default from the baked constant.

**Fixes:** the rotation wound. Key rotation becomes seconds instead of a Play release. A pilot points
at its own key with no fork and no custom build.
**Does not fix:** the burn rate, the default key's exposure, or the blindness.
**Cost:** small, and the pattern is already in the tree. Risk: a user-supplied endpoint can lie about
balances and blockhashes — partly mitigated already, since `getGenesisHash` is checked against
`SOL_GENESIS_HASH` and fails closed on the wrong cluster. Mark it advanced, like the relay URL.
**Non-negotiables touched:** none.
**Forecloses:** nothing; complements both A and B.

### E — Stop preferring a rail the app cannot read

**Recommend against, and the measurement is the reason.** Per `positioning.md:91`, re-measured
2026-09-06: EURC on Solana is Circle-issued, MiCA-licensed, **~105M circulating**, catalogued `deep`.
VEUR on the IC has **on-chain supply of a verified stub ≈1.5 VEUR**, catalogued `thin`, and is
**sell-only via DFX with no compliant on-ramp**. Preferring VEUR would move EUR users off a rail that
is temporarily unreadable and onto one that is permanently unusable — a worse dead end, and one no
amount of money fixes.

The honest interim is not to swap the preference. It is to **make the unreadable state say so on the
screen the user actually lands on** (§1.6.1) and to fix §1.6's
fail-open hazard narrowly: refuse to sign an SPL payment when the wallet has **no persisted fact for
that mint** *and* the endpoint is in an open 429 cooldown. That is a genuinely different state from
"the payer is in airplane mode", which keeps its fail-open behaviour. It touches the offline-first
non-negotiable at the edge, so it wants the founder's read before it is written.

### F — Make the release gate catch this (added; the founder did not list it)

Extend `check-prod-sol.mjs` from a string check to a **liveness probe**: POST `getHealth` to the
baked endpoint and fail the build on 429, on a non-`ok` result, or on no answer. Ten lines. While
there, fix the host match (§1.3 — `api.mainnet.solana.com` currently walks past it) by parsing the
URL's host and comparing against a set of names rather than regexing the whole string. Then run it on
the **web** build path too, not only `build-apk.sh`.

This is the single check that would have caught the outage before a user did. Keep it on the release
path only — `build-apk.sh` is already an outer-loop script that needs network and credentials, so
this does not touch the offline-inner-loop non-negotiable, and `just verify` must stay offline.

**Cost:** trivial. **Forecloses:** nothing.

---

## 3. Provider reality

All figures read from the providers' own pages on **2026-09-08**. Anything unconfirmed is marked.

| Provider | Free tier | Cheapest paid | Billing model | Websocket `accountSubscribe` |
|---|---|---|---|---|
| **Helius** | **1M credits/mo, 10 RPS**, 5 concurrent WS conns × 1,000 subs | **$49/mo** Developer — 10M credits, 50 RPS; then $5/M | credits **+** an RPS cap; 1 credit/call (10 for `getProgramAccounts`/archival) | **Yes, on Free** for standard methods (Helius *extensions* are paid). WS metered 2 credits/0.1 MB + 1 to open; 10-min idle timeout |
| **QuickNode** | **None** — a 1-month trial only (10M credits, 15 RPS) | **$49/mo** Build — 80M credits, 50 RPS | credits + RPS cap; also a flat-rate RPS product (Solana 75 RPS = **$1,199/mo**, unmetered) | Yes, same credit pool; **0.1 MB = 15 credits** since the 2026 switch off per-message billing |
| **Alchemy** | **30M CU/mo**, 500 CU/s (~25 req/s), 100 WS conns | usage-based, no base fee — $0.45/M CU (~$104/mo at 10M requests) | compute units + CU/s ceiling; `getBalance`/`getAccountInfo` = **10 CU** | **Yes, full Solana subscription API.** Billed by bandwidth (1 byte = .0002 CU); **100 WS conns on Free** |
| **Triton One** | None | **$125 minimum prepaid**, 12-month validity | pure usage: **$0.08/GB + $10/M calls**; no credits, no tiers | Yes — full standard set ("Whirligig") |
| **Public** `api.mainnet-beta.solana.com` | free, **per-IP** | — | none | Yes (port 443, root path) — but **`x-ratelimit-pubsub-limit: 10`** |

Documented public-endpoint limits (`solana.com/docs/references/clusters`): **100 requests/10s per IP,
40/10s for a single RPC method, 40 concurrent connections, 100 MB/30s**, with the standing warning:

> "The public RPC endpoints are not intended for production applications… The public services are
> subject to abuse and rate limits may change without prior notice. Likewise, high-traffic websites
> may be blocked without prior notice."

**Two findings that change the shape of the decision.**

1. **Free tiers include standard websocket account subscriptions — Helius, Alchemy and Chainstack
   all do.** C4 is not a paid-tier feature. That was the assumption worth checking and it was wrong.
2. **A shared baked key concentrates every user's demand into one quota; per-IP limits divide it
   among them.** The public endpoint's limits are **per IP**, so they get easier as users are added,
   while one literal shared by every install gets harder. That asymmetry is an argument for D
   (per-operator keys) independent of who we pay — though note §3.1 shows a shared free key still
   carries ~190 wallets *after* the demand cut, so this is a scaling argument, not a blocker today.

**A hard catch on C4 that must be checked before building it:** Helius Free allows **5 concurrent
websocket connections**. As read, that is a limit on the *plan*. If it is per key rather than per
client IP, then websockets over a shared baked key cap the product at **five simultaneous users** —
a ceiling polling does not have. Confirm this with Helius before choosing C4, and note that it does
not arise under D (each operator's own key) or under B (the relay multiplexes one connection).

**What could not be verified, and must not be treated as settled:** Helius's documented behaviour on
credit exhaustion (the exact failure we hit — nothing on their site describes it); free-tier
websocket access on Shyft, dRPC and Blockdaemon; Triton's per-tier rate-limit values. Two providers
also contradict themselves on their own pages (Helius on data add-on prices, Alchemy on the free
throughput number: 500 CU/s on the pricing page vs 300 CU/s in a docs example). Also note Syndica's
self-serve pricing page is gone and `instantnodes.io` now redirects elsewhere — neither is buildable
on today.

### 3.1 The arithmetic that actually decides this

Against **Helius Free = 1M credits/month**:

| Demand | One continuously-open wallet | Free tier lasts | Wallets supported at 30 min/day |
|---|---|---|---|
| **Today (128/min)** | 5.6M requests/month | **~5.4 days** | ~9 |
| **After C1+C2 (~5/min)** | 219k/month | ~4.5 months | **~190** |

That first row is almost certainly the whole story of this outage. **One phone left on a table
exhausts a 1M-credit month in five and a half days**, and nothing in the app stops when it is
backgrounded (§1.5). No abuse of the published key is required to explain what happened — though the
key being public means abuse cannot be ruled out either, and only the dashboard can separate them.

The second row is the reason the sequencing in §4 is what it is: **after the demand cut, a free tier
plausibly carries the entire pilot.** Alchemy's free 30M CU (~3M requests at 10 CU) is roughly three
times larger again. Buying before cutting would be buying the first row's problem at retail.

Two caveats on that table, both honest: it counts requests, not credits, and a provider that prices
`getMultipleAccounts` per account returned would shift the post-C1 column (§2 C1); and it assumes a
cold start costs ~23 requests (one balance read, two signature pages, up to twenty transaction
details on a first-ever load), which is folded into the 30 min/day column but is worth watching
because it is the one burst C1 does not flatten.

### 3.2 On the public endpoint specifically

`check-prod-sol.mjs` refuses to ship it, on the then-correct grounds that its documented limits
cannot carry a 2.5 s poll. **C1+C2 change that premise**, and its limits are per-IP rather than
per-account, so it is the one option that gets *easier* as users are added. Two reasons not to reach
for it anyway:

- **Solana disclaims it in writing** (quoted above), including the right to block a high-traffic
  site without notice. Building the product's EUR rail on that is a policy risk, not a technical one.
- **It enforces per-method limits independent of overall load** — measured this session, not read:
  two `getTokenLargestAccounts` calls twelve seconds apart both returned
  `{"code":429,"message":"Too many requests for a specific RPC call"}` while `getHealth` and
  `getMultipleAccounts` answered normally on the same connection. So an aggregate request budget does
  not predict whether it will serve a given method, and `x-ratelimit-pubsub-limit: 10` caps
  subscriptions besides.

Treat it as a credible emergency floor, not as the plan.

---

## 4. Recommendation

**The demand is the bug. Fix that first, and there may be nothing to buy.**

The research (§3.1) sharpened this from "buy second" to something stronger: at today's 128/min, one
phone left on a table burns a 1M-credit month in **5.4 days**; at the post-C1+C2 rate it supports
roughly **190 wallets**. And standard websocket subscriptions turn out to be included on the free
tiers of Helius, Alchemy and Chainstack — so the structural fix is not gated on a purchase either.
Rotate the key today because it is public, and hold the purchase decision until there is a measured
post-fix number to size it against.

### Today — an agent can do all of this, no money, no signature

1. **C1** — one `getMultipleAccounts` per tick. 128 → 32/min. Pin the SPL account layout against the
   primary source; keep `null` ⇒ `'absent'`; read the mint once per session for decimals.
2. **C2** — idle cadence. 32 → ~5/min.
3. **C3** — stop on background.
4. **F** — three changes to `check-prod-sol.mjs`: add the liveness probe, fix the host match so
   `api.mainnet.solana.com` is blocked alongside the `-beta` spelling (§1.3), and run it on the web
   build path as well as the APK one.
5. **Carry the rail-outage line onto Home** (§1.6.1). The Accounts list already explains a dead rail;
   the landing screen does not, and it is where a EUR user starts. Also fix the stale S1 row in
   `OPEN_ISSUES.md`, which says this is undone everywhere. *Sequencing: `app/components/**` is being
   edited by another agent right now; this waits for them.*
6. **S3** — the e2e request-budget assertion (§5).
7. **Correct `CODEBASE_ANALYSIS.md:251`** — "config-driven so an operator pastes a URL" is not true
   (§1.4). Either make it true (D) or fix the sentence. Do not leave both.

### Next — cheap, and it is the fix for the *operational* wound

8. **D** — the runtime slot. Rotation in seconds, pilots on their own keys, no store release. This is
   the thing whose absence turned a dead key into a multi-day outage.
9. **EURC history** (§1.6.3) — query the EURC ATA, generalise `SolanaHistoryToken` past `'SOL' |
   'USDC'`. Do it after C1/C2 so the added signature query lands inside a budget, not on top of 128.
10. **C4 websockets** — now known to be available on free tiers (§3), so the question is no longer
    cost but the **5-concurrent-connection catch**: confirm with the provider whether that limit is
    per key or per client. If per key, C4 is incompatible with a shared baked key and must wait for D
    or B. Do it only if C1–C3 leave a reason.

### Founder-only — money, credentials, or posture

- **Read the Helius dashboard.** Is this key on a paid plan? What burned it — our wallets, or someone
  using the published key? §1.1's contradiction and §1.2's exposure both resolve there and nowhere
  else. This is the first thing to do, because it changes which provider tier is right.
- **Rotate the key.** It is published at a stable public URL (§1.2). Rotate it whatever else is
  decided — and note that with D landed, rotating is a Settings edit rather than a release.
- **Decide whether to buy at all, and when.** §3.1 says a free tier plausibly carries the whole pilot
  once C1+C2 land (~190 wallets on Helius Free; roughly 3× that on Alchemy's). The disciplined order
  is: cut demand, measure the real per-wallet number against the dashboard, then size a plan. If you
  want a paid key today anyway for margin, both Helius and QuickNode start at **$49/mo** — but treat
  that as buying calm, not as the fix.
- **Confirm the websocket connection limit** with whichever provider is chosen (per key or per
  client?). It decides whether C4 is reachable without D or B, and no page states it.
- **Decide option B.** Whether dpay's relay may proxy Solana *reads*. Reads are precedented and
  inside `REGULATORY.md` §4's line; broadcast is not and must stay on the device. The cost is that it
  thickens the relay that `REGULATORY.md` §1.9 already flags. This is posture, not engineering.
- **Decide the narrow fail-closed refinement** in option E, which touches offline-first at the edge.
- **`beta.helius-rpc.com`** — confirm or drop (`OPEN_ISSUES.md:211`, open since 2026-08-09, still
  zero code references).

### Not recommended

- **A alone, and especially A first.** Buying capacity for a client that wastes it, with the key still
  published and the gate still blind. The measured 5.4-day burn says a bigger plan buys weeks, not a
  fix.
- **The public endpoint as the plan** (§3.2). A credible emergency floor; Solana disclaims it for
  production in writing and caps subscriptions at 10.
- **E as written.** VEUR at ~1.5 tokens of supply and no on-ramp is a worse EUR rail than a
  temporarily unreadable one.

---

## 5. How we will know it worked

1. **A request-budget assertion in e2e — worth building, and the only automated guard that can see
   this.** Nothing else in the inner loop counts requests, which is precisely why 208/min shipped
   silently and cost the whole rail. The seam is already there: every Solana e2e flow installs
   `globalThis.__DPAY_TEST_SOLANA_RPC_STUB` as a plain method→handler object (e.g.
   `e2e/tests/132-eurc-solana-pay.mjs:54`). Wrap each handler in a counter, mount the wallet with all
   three Solana rails, run K poll ticks, assert the count.
   **Express the budget per tick, never per second** — the e2e driver overrides every `POLL` value to
   150 ms (`e2e/harness/driver.mjs:757`), so a wall-clock budget is meaningless. Post-C1 the assertion
   is: ≤1 balance request per balance tick, ≤2 signature requests per history tick, ≤20 detail
   requests across the whole flow. Effort S, not M — it is one flow file plus a counter helper.
2. **The release gate refuses a dead endpoint** (F). Verify by pointing the baked constant at the
   exhausted key and confirming the build fails — *not* by setting `DPAY_SOL_RPC`, which only asserts
   the literal and would pass (§1.3). Add a second case for `https://api.mainnet.solana.com`, which
   the guard waves through today.
3. **The live probe passes after deploy** — the same `curl` from §1.1 returns `{"result":"ok"}`, and
   `GET /api/v1/currencies` still serves the EURC row.
4. **A EUR user sees a number.** Drive the deployed wallet, select EUR, confirm the EURC row shows a
   balance rather than `—`, and that a deliberately broken endpoint shows the `rail.unreadable`
   copy rather than a silent dash. *(I could not do this today: the deployed SPA did not boot in the
   headless browser available here. Whoever ships this should drive it in real Chrome.)*
5. **The provider dashboard.** After C1+C2, monthly usage per active wallet should fall roughly 25×.
   Founder-only — it needs dashboard access, and it is the only end-to-end confirmation that the
   arithmetic in §1.5 describes the real world.

---

## 6. What was our fault, plainly

Not the provider's, and worth writing down so the same shape is recognised next time.

- **We built a wallet that reads a paid resource 128 times a minute while nobody is looking at it**,
  polls rails that are not on screen, and never stops when backgrounded. Quota exhaustion was the
  designed outcome; the only question was the date.
- **We published the key and reasoned about it as if we had not.** The commit note worried about APK
  extraction and about the repo going public, and shipped it in a JavaScript bundle served from our
  own domain at a stable URL. The threat model examined the harder attack and missed the trivial one.
- **We wrote a release guard that checks the spelling of the endpoint and never asks whether it
  answers**, and wired it into one of the two build paths. It passed, green, throughout the outage.
  It also checks the *wrong* spelling: it blocks `api.mainnet-beta.solana.com` and lets
  `api.mainnet.solana.com` — the same service, and the name Solana's own docs now use — straight
  through. A substring where a host comparison belonged.
- **We claimed a config seam that does not exist.** `CODEBASE_ANALYSIS.md` has said the endpoint is
  operator-configurable since 2026-08-09; there has never been a runtime slot, and that claim is why
  rotating a key is a Play release.
- **We made the dead rail the default for a currency.** EUR prefers EURC on Solana, correctly and on
  measured liquidity — but nothing anywhere checks that a preferred rail is *readable* before the
  chooser offers it.
- **The gates fail open, and that was right until it wasn't.** Fail-open on unknown balance is
  correct for an offline payer and became a way to sign doomed payments once the endpoint died
  permanently. We never distinguished "the payer is offline" from "the endpoint is gone".
