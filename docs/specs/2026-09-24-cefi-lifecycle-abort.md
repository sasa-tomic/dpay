# CeFi lifecycle + convert abort windows (2026-09-24)

The state machine decisions behind "convert: late-deposit watch after quote expiry",
"convert: cefi panel expiry and last-checked lines", "convert: provider + crossrail stop",
and e2e flows 208/209. Flows 208/209 numbers RESERVED for this stream (201–207 belong to
other streams).

## 1. `quote_expired` is a watch, not the end (B1)

`expired` from `awaiting_deposit` lands the record at `quote_expired` (terminal — no state
transitions left). The old copy claimed the story was over ("never received the deposit, so
nothing needs reversing"). That claim was never ours to make: only the venue knows whether a
LATE deposit landed after its quote window died, and venues refund late deposits.

Decision: the step stays terminal (no new state, no transition matrix rewrite); the ENGINE
keeps a SLOW watch on it, and the provider driver honors the venue's own later words:

- from `quote_expired`: `refunded` → `provider_refunded`; `processing`-family →
  `provider_processing` (live again, re-enters the matrix); `completed` → `done` (first
  terminal word lands, term 4). Never backwards: a repeated `expired` or an awaiting status
  resurrects nothing.
- cadence: ONE poll per `CONVERT_ENGINE_STUCK_WATCH_MS` window — the stuck-watch precedent
  (a record that cannot be advanced any faster must not be polled any faster).
- exits: the venue's word, or the user's abort flag (the flag retires the watch; the step is
  never rewritten — abort must not un-terminal a record).
- copy: names the watch ("if a deposit lands late anyway, the venue returns it — dpay keeps
  watching") instead of a verdict. Jest: convertResume.test.ts (matrix + engine + abort).
  E2e: flow 208 (expired → polls continue → refunded lands on its own).

## 2. The honest CeFi wait lines (B1 ii/iii)

- `cefi.noExpiryLine` — Trocador orders carry `expiresAt: null` (the venue publishes no
  expiry; never invented). The awaiting_deposit panel renders the no-expiry fact instead of
  letting an unfunded order read as quietly abandoned. The exit is the stop (§3); the poll
  floor keeps the watching cheap. Jest-pinned (flow 208's sideshift stub always carries an
  expiry, so the null branch is jest-only).
- `cefi.lastCheckedLine` — `provider_processing` shows the engine's last COMPLETED status
  read (`providerLastCheckedAtMs`, session-local, never persisted — a timestamp, not an SLA;
  no verdict implied; hidden until this session's own first read lands).

## 3. Abort windows (C1–C4)

C1 — PRE-BROADCAST INVARIANT: no record exists before the confirm tap. Every prepare*Record
runs AT the confirm gesture and only then adopts; back at review discards in-memory state.
Nothing persisted, nothing to clean up (pinned: convertMode.test.tsx, convertCefiConfirm.test.tsx).
The ONE pre-broadcast side effect is CeFi's: confirming CREATES the venue order — the
documented invariant sits on the `app/convert/types.ts` header.

C2 — PROVIDER STOP: the Stop button extends to `awaiting_deposit` / `provider_processing`.
New abort flavor `provider`: BOTH truths — a deposit never sent means nothing can move and
the order dies unfunded at the venue; a deposit already sent means the trade may still
settle (check Balances + the venue's status page). The aborted card renders the venue's
shift id so the "status page" instruction is actionable. Abort retires the poll loop
(`fetchProviderStatus` never again; stub-counter-proven in flow 209).

C3 — LATER-LEG STOPS: `crossing` → aborted with the `watching` flavor (the burn is out;
Circle may still complete the mint; the funds land at the user's OWN ATA either way — never
"nothing moved"). `sol_ready` → aborted `clean` (the final Jupiter leg was UNSIGNED; the
card names where the USDC sits and the exit). `convertAbortFlavor` reads the cross-rail /
provider phases FIRST — the plan-based reads would misread confirmed IC approvals as `fee`.

C4 — INVARIANT PIN: parametric jest — `aborted` records are skipped by the resume driver
for EVERY record shape (direct / planned / hub / cefi / crossrail / solana). The abort guard
in the executor's `advance` and the engine's `commit` collapses any late in-flight
transition to `aborted` (pinned in convertResume.test.ts).

## 4. Copy rules honored

Every new surface states only what the speaker knows: dpay watched / stopped watching; the
venue holds the facts; where the funds sit; what the user can do next. No SLA, no reversal
promises, no "nothing moved" where value is in flight. Four locales (en/de/es/fr), same key
set, venue names and addresses passed in as locale-invariant arguments.
