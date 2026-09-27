# Trocador partner agreement — record and delivery map (2026-09-22)

The founder's signed agreement with **Trocador.app** (their commercial team; API access enabled
**2026-09-22** — note their proxy may take up to 60 minutes from the email before the key answers).
This doc is the RECORD of the agreed terms, the map of each term to the code that implements it,
and the remaining founder/ops steps to go live. The compliance surfaces it names (access log,
order store, webhook route, upstream limiters, privacy section, probe tool) land with this
agreement's delivery branch.

## 1. The agreed terms (substance of the email thread)

**Origin — organic demand, with a per-transaction budget.** The partnership came to Trocador as
the organic-demand pattern: users arriving through dpay asking for a conversion their wallets
cannot do natively (the registered ICP↔SOL pair first). Trocador's commercial team promised a
**per-transaction budget** on their side for the partner account — their commitment, theirs to
administer; dpay sends nothing to trigger it beyond the registered attribution itself.

**Webhook-first status.** Trade status is **webhook-first**: dpay registers a webhook URL at
trade creation and Trocador pushes state changes to it. The webhook carries
`webhook_key = <dpay's internal order id>` — the correlation key is OURS, not the venue's trade
id, so a webhook can never be confused across orders. The webhook URL is **probed at trade
creation** (Trocador verifies it answers before the trade proceeds). Trocador performs **no
retries** on a missed webhook — a missed push is final — so the client falls back to **polling at
at most 1 request/minute**, and **stops at the first terminal state** (never polling a settled or
failed trade again).

**Data retention — the signed commitment, verbatim in substance:**

> Since users reach you through our backend, we are the party holding the connection data. For
> every request we proxy to Trocador (rate, trade creation, status) we will log and retain,
> correlated with the Trocador trade id and our internal order id: timestamp, source IP address,
> device info (User-Agent), user language (Accept-Language). Records are kept for at least
> 12 months; once we receive a request relating to a specific trade, the data for that trade is
> preserved until the request is resolved, and longer where applicable law requires. We will
> respond promptly to any valid request you forward to us.

The public-facing form of this commitment lives in the served privacy policy
(`crates/dpay-relay/assets/privacy.html`, served at `/privacy`, §7 "Conversion venue request
records") — including that the records are **disclosed to the venue** (e.g. an exchange
aggregator) when that venue forwards a valid information request about a trade.

**Commercial pin — markup=0.** dpay sets `markup=0` on every quote and trade: a nonzero markup
would RAISE THE USER'S PRICE to pay dpay, which the founder red line forbids (dpay is paid
nothing for a conversion). Founder-owned note, kept open on record and NOT elaborated here: even
at `markup=0`, Trocador's terms accrue half of TROCADOR's OWN commission to the partner account;
dpay cannot refuse the accrual over the API, and what happens to that partner balance is a
**founder decision, already on record** (`OPEN_ISSUES.md` Trocador bullet; the
`crates/dpay-relay/src/trocador.rs` module header). Nothing in dpay's UI or math depends on it.

## 2. Term → implementation map

| # | Agreement term | Where it is implemented |
|---|---|---|
| 1 | Log + retain connection data for every proxied request (timestamp, source IP, User-Agent, Accept-Language) | Relay access log **`trocador-access.jsonl`** (one JSON line per proxied call), enabled by **`DPAY_TROCADOR_LOG_DIR`** — `crates/dpay-relay` (this branch). Since 2026-09-22 the records persist to **Postgres** — the backed-up store — when **`DPAY_TROCADOR_PG_DSN`** is set (tables `trocador_access_log` / `trocador_order_events`, created idempotently at startup, append-only: the code only ever INSERTs, retention unchanged); unset keeps the JSONL files for the offline dev loop. The DSN credential's tracked source of truth is `secrets/trocador-pg.sops.json` (sops) — decrypt into the env at deploy, never a plaintext .env |
| 2 | Correlation with the Trocador trade id AND dpay's internal order id | Relay order store **`trocador-orders.jsonl`** (same dir/log-dir env); the app stamps every trade with its **`clientOrderId`** and the header **`X-Dpay-Order-Id`** — the relay records both next to the venue's own `trade_id` |
| 3 | Webhook-first status, `webhook_key` = internal order id, URL probed at creation | Relay route **`POST /api/v1/trocador/webhook`** (this branch); the webhook URL handed to the venue is built from **`DPAY_PUBLIC_ORIGIN`** so the probe at creation resolves a real public origin |
| 4 | No-retry webhooks → fallback polling ≤1/min, stop at first terminal state | App poll discipline (this branch): minimum 60 s between status polls, hard stop at the first terminal state word — the resume engine never re-polls a settled/failed trade |
| 5 | Honest client source IPs behind the tunnel | **`DPAY_TRUST_PROXY=1`** in prod (the relay takes the client address from the forwarded header only when explicitly told the proxy is trusted — never by default) |
| 6 | Protect the shared partner key from abuse (the limiter half of "we proxy everything") | Relay upstream limiters in the Trocador proxy paths (this branch) — the device can never spend the key faster than the relay allows |
| 7 | Public retention/disclosure commitment | `crates/dpay-relay/assets/privacy.html` **§7 "Conversion venue request records"** (served at `/privacy`) |
| 8 | Re-pin coin/network codes + status vocabulary on key arrival | **`just trocador-probe`** → `scripts/trocador_live_probe.mjs` (below) |
| 9 | This record | `docs/specs/2026-09-22-trocador-partner-agreement.md` (this file) |

## 3. Remaining founder/ops steps to go live

1. **Set `DPAY_TROCADOR_API_KEY` in the deploy environment.** Access was enabled 2026-09-22;
   their proxy may need up to 60 minutes from the email before the key answers. The key's
   tracked source of truth is `secrets/trocador.sops.json` (sops, all three age recipients) —
   decrypt into the env, never a plaintext .env; `scripts/gen-deploy-env.sh` emits it into the
   generated `deploy/.env` (already wired — `DPAY_TROCADOR_API_KEY` is in its mapping).
2. **Set `DPAY_PUBLIC_ORIGIN` and `DPAY_TRUST_PROXY=1` in prod.** The first builds the webhook
   URL the venue probes at creation; the second makes the access log's IP field honest instead of
   a tunnel-internal address.
3. **BEFORE the first real trade: run `just trocador-probe`** and re-pin from its output:
   (a) the coin/network codes the adapter pins (`crates/dpay-relay/src/trocador.rs`
   `TROCADOR_ASSETS` — VERIFIED against the live vocabulary 2026-09-22: exact pair matches, no
   re-pin needed), and (b) the trade-status vocabulary (still a /trade fact; the quote body
   previews only `status:"new"`). A wrong code fails loudly at the venue; an unpinned status
   word renders honest-`unknown`. The probe prints both vocabularies and flags any mismatch
   against the current pins. FIRST-RUN RESULT 2026-09-22: pins verified; the registered pair is
   listed but currently UNQUOTED (rig verified via a btc→xmr control quote — exit 3) → re-run
   this probe before go-live; SideShift remains the live ICP↔SOL venue until then.
   RE-RUN RESULT 2026-09-24: same verdict (exit 3) — pins verified, icp→sol still listed but
   unquoted (the btc→xmr control quoted, so the rig and key are sound). Same-day pair
   measurements toward registration: icp→usdc answered "no resulting quote" too (usdc/SOL is
   listed, minimum 5.51); EURC has NO Solana row at all — only "Euro Coin (ERC20)",
   ticker `EURC`, network `ERC20` (a different rail than dpay's EURC-on-Solana); usdc→icp
   resolves the pair and refused 2 USDC as below the venue minimum. → The trocador-usdc /
   trocador-eurc registry rows stay UNREGISTERED: a listed-but-unquoted venue is no venue to
   route through, and the app's honest no-quote verdict (the cefi noQuote state, flow 207) is
   the product behavior until a probe run actually QUOTES the pairs.
4. **Deploy is founder-run.** The one runbook is **`docs/OPS.md` §3** — it is deliberately not
   restated here (image build, the between-steps commit record, `just verify-relay`/`just floor`
   afterwards).

## 4. The live probe tool

`scripts/trocador_live_probe.mjs` (Node, no new deps), wired as the opt-in recipe
**`just trocador-probe`** — **NOT** part of `verify`/`check` by design (it makes LIVE key-gated
calls to the venue; it must never run in tests or CI). It refuses to run without
`DPAY_TROCADOR_API_KEY` in the environment, then:

1. `GET {DPAY_TROCADOR_API_BASE:-https://api.trocador.app}/coins` — prints the FULL
   coin/network vocabulary (pretty JSON), then the rows relevant to dpay's pins (ICP, SOL, USDC,
   EURC on Solana/mainnet) NEXT TO the adapter's current pinned codes, flagging any MISMATCH.
2. ONE rate probe for the registered pair (ICP↔SOL, `fixed=True`, `best_only=True`,
   `min_kycrating=A`, `markup=0`, small amount) — prints the venue's attributed quote and, if the
   response carries it, the status vocabulary.

Usage: `DPAY_TROCADOR_API_KEY=… just trocador-probe` (optionally `DPAY_TROCADOR_API_BASE=…`
to point at the docs' alternate host; `DPAY_TROCADOR_PROBE_AMOUNT=…` to change the small amount).
Exit 0 = vocabulary matches the pins and the quote answered; exit 2 = MISMATCH — re-pin before
the first real trade.
