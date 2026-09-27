# Live testing: testnets vs mainnet

One compact, current home for how to exercise dpay's money paths: free paths (testnets, faucets)
where they exist, cheapest live probes where they do not. Every agent touching conversion or
payment code reads this first and updates it with findings in the SAME session.

## Working rules (backed by CLAUDE.md, "live round-trip verification")

1. **Update discipline.** Same-session updates only, always date-stamped. Correct stale claims;
   never let two rows contradict. Scripts added under `scripts/` here must stay runnable.
2. **Free-path search.** For a venue/network with no documented free test path: search at most
   10 minutes, at most once per day. Skip entirely if the row's last-checked date is less than
   24h old. Found: document it, then use it. Not found: mainnet at the smallest allowed amount,
   and append the dead end to the log with the date.
3. **Real money.** The agent float is REAL money: float policy lives in `CLAUDE.md` (CHF 25
   ceiling, <=CHF 2 auto-spend, smallest amount the platform allows, never retry failed or
   abnormally-slow transfers). Measure, never assume: `just funds`. AI agents MUST USE `just funds`
   to record ANY MOVEMENTS THEY MAKE (HARD HARD RULE) — `just funds add` appends to
   `funds/ledger.jsonl`, `just funds doc` re-renders.
4. **Round trip.** The acceptance bar is a real round trip per affected path (convert there and
   back, pay and be paid back), driven through the real UI, adversarially where the venue itself
   produces refusals. Blocked: skip, continue the session, disclose in the final report.
5. **Keep it compact.** Tables and short lines. If a note grows past a paragraph, it is the wrong
   note.

## Layout

- `networks.md` — per-rail and per-venue facts, the dead-end log.
- `scripts/` — probes and helpers, as they appear (none yet).

Related but external: `scripts/funds.mjs` (float ledger), `funds/ledger.jsonl` (movement record),
`CLAUDE.md` section "live round-trip verification of money paths" (the binding rule).
