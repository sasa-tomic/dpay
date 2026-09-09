# The relay in the Solana path, and more than one relay

**Two founder directions taken 2026-09-09, in this order and coupled.** Every verb below is a
roadmap verb; deployment state lives in `OPEN_ISSUES.md`.

1. **All Solana traffic — reads and broadcast — goes through the dpay relay.** The Helius key stops
   shipping in the client.
2. **dpay supports several relays, for high availability and fault tolerance.** One relay is a
   single point of failure, and direction 1 is what makes that failure total for the Solana rail.

## What happened first: the outage

The baked Helius key answered **HTTP 401 Unauthorized** when measured 2026-09-09 (it had answered
`429 max usage reached` on 2026-09-08 — the account moved from throttled to dead). Every shipped
build's SOL, USDC·Solana and EURC·Solana rows therefore read nothing at all, and EURC·Solana is the
preferred EUR rail, so a user who chose Euros landed on a rail the app could not read.

The founder supplied a replacement key the same day. It was swapped, `just check-prod-sol` passed
against it, and the outage ended. **The proxy below is not what fixes the outage — it is what stops
the next one**, and the two must not be confused when reporting status.

The cause was dpay's own demand: an idle wallet issued ~208 RPC requests/minute with no batching,
no dedup and no in-flight guard, which spent a month of provider quota in five and a half days. The
client-side half of that is already fixed and measured (`2026-09-08-solana-rpc-plan.md` owns the
arithmetic and the per-tick budget; it is not restated here).

### 401 is not 429, and the difference says the key was REVOKED

The founder asked the right question: *over-quota means it ran out, unauthorized means it was
switched off or deleted — so something changed its status rather than just using it up, and until
we know what, the same thing can happen to the new key no matter how much we reduce usage.*

Helius's own documentation settles the semantics. **401** is "an invalid API key … or access is
restricted due to RPC rules" — an authentication fact. **429** is "exceeded the request limit in a
given timeframe **or is out of credits**" — so credit exhaustion produces 429, and 401 does not
mean "used up" (`helius.dev/docs/faqs/error-codes`, read 2026-09-09). The old key therefore stopped
existing or stopped being authorised: deleted, regenerated, or given an IP/domain rule it now fails.

**The most likely explanation is benign and is one look away from being confirmed: creating the
replacement rotated the old one.** That is a founder-run check — does the old key still appear in
the dashboard's key list? If it is gone, the question is closed. If it is listed and disabled, it is
not, and Helius should be asked why, because whatever did it can do it again.

Re-measured 2026-09-09 in this repo: the old key still answers 401, the new key answers 200 on
`getHealth`. Neither response carries any rate-limit or quota header, so nothing about plan or usage
is readable from the RPC surface.

### The plan, the arithmetic, and what a usage alarm would actually take

Helius's published tiers (`helius.dev/pricing`, read 2026-09-09): **Free = 1M credits/month at 10
requests/second**; Developer $49 = 10M; Business $499 = 100M. Most RPC calls are 1 credit.

Against that ceiling the demand is the whole story:

| | requests/min per idle wallet | credits/month, one wallet | free tier (1M) lasts |
|---|---:|---:|---|
| Before the 2026-09-08 fix | ~208 | ~9.0M | ~3.3 days |
| After it (25× cut) | ~8 | ~350k | ~2.8 wallets, then it is gone |

So the free tier does not survive a pilot at any demand this app plausibly has, and **the shared
read cache in direction 1 is what changes the shape** — N wallets asking the same question in the
same second cost one upstream request rather than N. That is the quantified argument for the proxy,
independent of the key question.

**A usage alarm is possible, and not from the app.** Plan and credit usage are not exposed to the
RPC key; the CLI reads them (`helius usage --json`, `helius apikeys --json`) but authenticates with
a dashboard JWT or a keypair, not with the API key. Two honest options, both founder-gated:

- the founder reads it in the dashboard, on whatever cadence; Helius advertises "smart alerts" to
  prevent overages on its pricing page without naming a tier, so whether the free plan has them is
  unverified and must not be assumed;
- or a `helius login` is run once on the build box, after which `just check-prod-sol` can assert
  remaining credits and go RED before the rail does — the same tripwire shape the repo already uses
  for the swap venue and the OCP ledger.

Until one of those exists, the wallet's own honest-unreadable state is the only thing standing
between a dead key and a silent blank balance, which is why the failure taxonomy below is a
requirement rather than polish.

## What the app says when the relay is down and the phone is not

This is the question the founder put to direction 1, and it has a design answer rather than a copy
answer. Today `RailUnreadableNote` renders one sentence naming the CHAIN: *Solana isn't answering
right now*. After the proxy, a relay outage renders that same sentence — and it would be **false**.
Solana would be fine. dpay would be the thing that is down, on a rail whose one-line pitch is about
not needing a connection.

`CLAUDE.md`'s external-claims rule governs in-app copy exactly as it governs an investor email, so
blaming the wrong party is a defect, not a nuance. The requirement on R2, testable and ordered
before it:

1. **Three states, never collapsed into one.** The phone has no connectivity; the relay is
   unreachable while the phone is online; the relay answered and the upstream cluster refused.
   `BalanceView.status: 'error'` is a single bucket today and must carry the cause, classified at
   the transport seam every Solana read already passes through — not guessed at the component.
2. **The relay-down state names dpay as the cause**, says the money is untouched, and gives the
   action this document already promises: Settings ▸ Advanced points the wallet at any Solana
   endpoint and removes dpay from the path entirely. That satisfies the founder's 2026-08-29 rule —
   a state that only describes itself is a bug — and it is the same property that keeps
   `docs/REGULATORY.md` §4 constraint 2 answerable.
3. **It names what still works.** The IC rail submits app-signed envelopes straight to `icp-api.io`
   and does not touch the relay, so a relay outage leaves Internet Computer balances and payments
   working. Saying so is useful *and* true — and it is only true because the IC rail stays out of
   the proxy, which is an argument for keeping it that way.
4. **No cached value is ever presented as current**, on the client side as well as the relay's. A
   stale balance rendered as live is worse than a blank one.
5. **The offline-payment claim is unaffected and must not be quietly widened.** The payer still
   signs with no connection; the merchant was always online. What a relay outage costs is READS and
   broadcast, and the copy must not imply otherwise in either direction.

Direction 2 is what makes state (2) rare. It is not what makes it honest.

## Direction 1 — the proxy

### The objection, recorded because it was overruled

This must stay in the record, in these words, because it is the kind of thing counsel will ask
about and a decision nobody can find the reasoning for is a decision nobody can defend.

`docs/REGULATORY.md` §4 constraint 3 says: *"Let the user's own device submit the signed
transaction. Do not relay or broadcast through dpay infrastructure."* §1.9 gives the reason — FINMA
Circular 11/1 Rz 63–66 makes the operator of a payment system enabling third-party asset transfers
AMLA-subject, and in a three-or-more-party model *"immer ein unterstellter Finanzintermediär"*. The
same file calls this the largest open flag against dpay today.

Putting Solana **broadcast** through a dpay-operated proxy moves that limb from arguable toward
textbook, on the one rail that is currently clean: the IC rail has submitted app-signed envelopes
directly to `icp-api.io` since the 2026-08-19 settlement cutover, precisely so dpay is not in the
submission path. It also creates a control surface constraint 2 exists to deny — a proxy can delay
or drop a transaction, whether or not it ever does.

Proxying **reads** carries none of this. A balance query transfers nothing.

**The recommendation put to the founder was reads-only. The founder chose reads and broadcast, with
the objection stated.** That is the decision; it is implemented in full. Two consequences follow
and are owned here rather than argued again:

- Counsel question 1 in `docs/REGULATORY.md` §7 now has a second fact pattern attached to it. When
  the officials ask is made, the Solana submission path is part of it, not just the convert screen.
- The relay sees every Solana transaction a dpay user makes before the network does. That is a
  privacy surface as well as a control one, and it must be disclosed wherever dpay describes what
  the relay can see.

### Shape

- The relay exposes a Solana JSON-RPC surface under `/api/v1/`. The client's endpoint constant
  becomes a relay path rather than a provider URL; `solanaRpcUrl()` stays the single seam every
  Solana read and broadcast already goes through, so no call site changes.
- The provider key lives in relay configuration (the deploy environment, alongside the existing
  Cloudflare secrets), never in the app bundle, never in git.
- **Reads are cached and shared.** This is the actual win: N wallets asking the same question in
  the same second cost one upstream request instead of N. Per-method TTLs are the relay's to own.
- **Broadcast is a pass-through and nothing else.** It does not inspect, rewrite, hold, queue or
  reorder. It forwards bytes the device signed and returns what the cluster said. Any behaviour
  beyond that would be a design change requiring its own decision, because it is the difference
  between a pipe and a participant.
- **Failure is loud.** An upstream refusal is surfaced as an upstream refusal with its status; the
  relay never substitutes a cached value for a failed read, and never reports a broadcast as
  submitted that it did not submit. `RailUnreadableNote` already renders the honest unreadable
  state and is unchanged by this.
- The Settings ▸ Advanced Solana endpoint slot **stays**. It becomes the operator escape hatch: a
  pilot operator, or a user who does not want dpay in their Solana path, points the wallet at their
  own provider and the relay leaves the path entirely. This is also what keeps constraint 2
  answerable — dpay cannot prevent submission, because the user can route around it.

### What this costs, stated plainly

The Solana rail gains a dpay-operated dependency it did not have. If the relay is down, Solana
balances go dark and Solana sends cannot be broadcast, **even when the cluster and the provider are
both healthy**. That is a new failure mode, it is strictly worse than today on availability, and it
is the reason direction 2 exists.

The offline-payment story is unaffected: the payer still signs with no connection, and the online
side was always online.

## Direction 2 — several relays

### Why this is not a "fallback" under the no-fallbacks rule

`CLAUDE.md` forbids fallback paths, alternative implementations and graceful degradation to a
different code path. Multi-relay failover is none of those: it is **one implementation at more than
one address**. There is no second code path, no degraded mode and no "try the new way then the old
way". A relay either answers or it does not, and the client moves to the next address in a list.
If that distinction ever stops being true — if a second relay serves a different build, a different
catalog or a reduced surface — this stops being redundancy and becomes exactly the thing the rule
bans.

### What can be multi-homed safely, and what cannot

The relay's surfaces split cleanly, and the split is the whole design:

| Surface | Multi-homes? | Why |
|---|---|---|
| `/currencies`, `/version`, `/health`, `/integrity` | Yes | Compiled-in, identical across replicas of one build. |
| `/balances`, `/transactions`, `/deposit/info`, `/onramp/ckerc20` | Yes | Read-only queries against external ledgers. No relay-held state. |
| `/swap_quote` | Yes | Read-only; the quote is the venue's, read at request time. |
| Solana RPC proxy (direction 1) | Yes | Stateless pass-through plus a cache. The cache is an optimisation, so a cold replica is slower, never wrong. |
| **Till charges** (`/till`, `/till/void`, `/till/{id}`) | **No** | A charge is relay-held state. A charge opened on replica A does not exist on replica B, so a merchant mid-charge is session-affine and failover would lose the charge. |

So the till is the one surface that constrains the design, and it is off by default on every build
(`DPAY_ENABLE_TILL`). The honest options for it — shared state, sticky affinity, or "the till is
single-homed and says so" — are a decision this document does not pre-empt.

### Client shape

- The single relay URL becomes an ordered **list**. The existing `RELAY_STORAGE_KEY` slot and the
  Settings ▸ Advanced editor generalise to it; one entry must remain a valid configuration.
- Selection is **health-based and ordered**, not random and not raced: try the first, move to the
  next on a transport failure or a 5xx. A 4xx is an answer, not a failure — it does not trigger
  failover, because retrying a refused request on another replica would turn one honest refusal
  into several.
- **Build drift is a hard error, not a warning.** Replicas must agree on `/version` and
  `/integrity`. A client that sees two relays reporting different builds is looking at two
  different catalogs and must say so rather than silently mixing them. This is the property that
  keeps failover from becoming a fallback.

### Operator shape

Deployment topology, DNS, and whether replicas sit behind one hostname or several are operator
decisions and are `docs/OPS.md`'s to own once this is built. The property this document fixes is
that **the client can hold more than one address and choose between them**, which is what makes any
of those topologies possible.

## Order

Direction 2 is a prerequisite for direction 1 being an improvement rather than a regression:
shipping the proxy alone converts a provider outage into a total Solana outage with a dpay-shaped
single point of failure in the middle. Build the multi-relay client first, or ship them together.

## What landed

Nothing from either direction. The key swap that ended the outage is separate and is recorded in
`OPEN_ISSUES.md`.
