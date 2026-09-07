# Ops runbook — reconcile + key rotation + upgrades

The operator-side procedures, in the order they bite: the trap-closer, the keys, and the
upgrade loop they all serve. Every command here is founder-run; none may run unattended.

## 1. `reconcile` — when and how to run the trap-closer

### When

- **After any suspected trap.** The symptom is a debit-without-credit report (a payer's
  balance fell, the merchant says nothing arrived) or a duplicate-debit report (one transfer
  seemingly charged twice). `reconcile(currency)` walks that currency's recent ledger debits
  and repairs any whose credit never landed — the airtight close for the narrow window the
  `created_at_time` dedup only mitigates (canister `lib.rs`, "icrc3 reconcile").
- **On a stale-intent WARN.** The canister flags in-flight pay intents older than 1h (a
  transfer that neither settled nor released — the message was dropped mid-settle: stop/
  upgrade, or a stall) lazily on update ingress, at most one scan per hour — nothing runs in
  the background. Check what it saw with the free pull query
  `dfx canister query <facade-id> inflight_intents` (one row per open intent: nonce, age,
  stale, flagged), then run the sweep below.
- **As periodic hygiene.** Run the full sweep (`just reconcile`) monthly, and after any
  incident that paused or crashed the canister mid-transfer (upgrade included). A clean sweep
  is cheap; an orphan left for weeks is a support ticket with a stale trail.

### The command

```bash
just reconcile        # currency ids 0–9 — the hardcoded CURRENCIES list in scripts/reconcile.sh,
                      # kept current by hand when the compiled catalog grows
just reconcile 7      # just VCHF — the targeted form for a single-currency report
```

`scripts/reconcile.sh` derives the controller identity from `DPAY_CONTROLLER_SEED` (the same
derivation `faucet-verify.sh` proves), wraps it as a throwaway dfx identity under a temp
config root (never your real identity store, removed on exit), checks the principal matches,
and calls the canister's `reconcile` per currency. The seed is never echoed.

### Reading the report

Each currency answers one line: `currency=7 blocks_scanned=25 orphans_repaired=0`.

- `blocks_scanned` — how many recent ledger transactions the walk examined (bounded by the
  canister's per-call cap; a busy currency may need a second run to cover older orphans).
- `orphans_repaired` — debits whose matching credit was missing and has now been repaired.
  **Zero is the healthy answer.** Any non-zero run MUST be recorded below and read as an
  incident signal: something interrupted a transfer, and the cause (restart? trap? replay?)
  is worth knowing before the next one.
- A refusal (`FAIL: reconcile(c) refused: <reason>`) means the call was rejected — usually
  `unauthorized: admin ops require the controller principal`, i.e. the seed in
  `deploy/.env` no longer matches the canister's CONTROLLER cell (see key rotation below).

### Run log

Append one row per run (the point is the record, not the prose):

| Date | Command | Result | Notes |
|------|---------|--------|-------|
| — | — | — | No runs recorded yet. The first entry is yours. |

## 2. Key rotation, per scoped key

### `DPAY_CONTROLLER_SEED` — the relay's dedicated Ed25519 controller key

Powers the authenticated faucet mint and the admin ops (`mint`/`burn`/`reconcile`) via the
canister's CONTROLLER cell. Rotate in this order — the canister must accept the new key
BEFORE the relay starts signing with it, or every admin op 422s until it does:

1. Generate the new seed: `NEW_SEED="$(openssl rand -hex 32)"` (do not print it).
2. Derive its principal: `printf '%s' "$NEW_SEED" | cargo run -q -p dpay-icp-e2e --bin dev-principal -- --from-stdin`
   (the seed rides stdin, never argv — argv is visible in `ps` during the whole build+run window).
3. Rotate the cell — as the CURRENT controller (two-step; a locked canister can only be
   rotated by its controller, see `docs/GOVERNANCE.md`):
   `dfx canister call ssqti-wiaaa-aaaab-qhdia-cai set_controller '(opt principal "<NEW_PRINCIPAL>")' --network ic`
   (or let `just deploy-ic` arm it: it rotates when the cell differs).
4. Swap `deploy/.env`'s `DPAY_CONTROLLER_SEED` to the new value; `just up` to restart the
   relay on the new key.
5. Prove the wiring: `just faucet-verify` (seed ↔ controller cell ↔ IC controllers, all
   three legs). Then treat the old seed as compromised-by-exposure: it appears in shell
   history files at rotation time at most; clear those lines.

### The dfx deploy identity — the IC-level controller (upgrade authority)

Holds canister control at the IC level (code upgrades, stop/start) AND sits on the canister's
`ADMIN_CALLERS` operator list. It lives as a PEM in the dfx identity store — **cold-storage
discipline applies** (GOVERNANCE row 6 / pilot checklist: offline PEM, imported only at
deliberate deploys, never on the relay box).

1. On the ops machine (PEM imported): add the successor first —
   `dfx canister update-settings ssqti-wiaaa-aaaab-qhdia-cai --network ic --add-controller <NEW>`.
2. Confirm the addition (`dfx canister info … --network ic` lists controllers), THEN remove
   the old: `… --remove-controller <OLD>`.
3. If the old principal is on `ADMIN_CALLERS` (canister `lib.rs`), a canister upgrade is
   needed to drop it — bundle that source change into the next deploy and add its
   `docs/UPGRADES.md` row.
4. Cross-ref: `docs/GOVERNANCE.md` (the two control layers; who may admit whom).

### The receipt key — none

Retired by the 2026-08-19/20 user-principal cutover: `/receipt/{nonce}` and
`/receipt_pubkey` are deleted (2026-09-04), and "Paid ✓" now comes from the app's own
`read_state` poll of the envelope it submitted. There is no receipt key to rotate; this
section exists so nobody goes looking for one.

## 3. Upgrades — the loop the above serves

```bash
just deploy-ic          # upgrade the facade; auto-writes the fresh hash to the pin file + reminds
just integrity-check    # curl the live relay: status must be MATCH
```

Then add the `docs/UPGRADES.md` row (date, git commit, module hash, what changed) and commit
it with the pin file — that row IS the changelog `integrity-check` polices. The relay image
itself rides its own loop (`just verify-relay` → `just image && just up`); the facade loop is
this one. If `integrity-check` reports `MISMATCH`, someone upgraded outside this procedure —
find out who and why before re-recording.
