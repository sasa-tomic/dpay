# Ops runbook — reconcile + key rotation + upgrades

The operator-side procedures, in the order they bite: the trap-closer, the keys, and the deploy
sequence they all serve. Every command here is founder-run; none may run unattended.

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

## 3. Ship to prod — the one sequence

This is the only prod deploy procedure; nothing else may restate it. Founder-run, in order,
from a clean tree:

```bash
# 1. upgrade the facade canister. Re-bakes deploy/facade-module-hash.txt (TRACKED) with the
#    hash the IC now runs, and prints the docs/UPGRADES.md row for step 2.
just deploy-ic

# 2. record it: paste that row into docs/UPGRADES.md, filling in what changed, then commit
#    the row WITH the pin — neither means anything without the other.
git add deploy/facade-module-hash.txt docs/UPGRADES.md && git commit

# 3. signed APK/AAB, then the prod relay image — both built from that commit.
just apk && just up

# 4. prove what is live: /version == HEAD and NOT `-dirty`; facade hash == the baked pin.
just verify-relay
just integrity-check
```

**Nothing changed on the canister?** Skip 1–2 — `just apk && just up`, then 4. `up` swaps only
the relay image, so relay- or app-side changes need no canister step.

**Step 2 is enforced by auto-commit, not by refusal.** `deploy/build.sh` (via
`deploy/git-lib.sh` `committed_tree_for`) COMMITS a dirty tree before building — whatever is in
the tree is what ships, so it is made a commit and the image corresponds to exactly that
commit. On 2026-09-08, before any gate, the sequence shipped `20133499…-dirty` at
`/api/v1/version` and nothing could say what was running; the refusal that fixed it became the
friction the founder removed on 2026-09-10 — auto-commit buys the same guarantee (a commit
describes what shipped) without a mandatory manual commit between steps. `just deploy-ic`
still dirties the tree *by construction* (the pin it writes is tracked), so paste the
`docs/UPGRADES.md` row as its own commit — the pin and the row belong together, and the
auto-commit cannot write your changelog row for you.

If `integrity-check` reports `MISMATCH`, someone upgraded outside this procedure — find out who
and why before re-recording. If `verify-relay` reports `BEHIND`/`MISMATCH`, the running image
predates the source: re-run from step 3.

**Where deploy secrets live (sops, since 2026-09-27).** Every secret the deploy needs is
sops-encrypted under `secrets/*.sops.json` (recipients + rules: `.sops.yaml`). `deploy/.env` is
NEVER hand-edited: it is generated by `scripts/gen-deploy-env.sh` (`just deploy-env`) from
`deploy/env.config` (tracked, non-secret config) + the sops files, and every deploy path
regenerates it automatically (no-op when fresh; fails closed naming the file, the key, and
`sops <file>` when something is undecryptable or missing). To add or rotate a secret:
`sops secrets/<file>.sops.json`, then `just deploy-env` (or just deploy — regeneration is
automatic). Deploy secrets live in `secrets/deploy.sops.json` (`CF_TUNNEL_TOKEN`,
`CF_API_TOKEN`, `DPAY_SOLANA_RPC_URL`, `DPAY_CONTROLLER_SEED`), venue keys in
`secrets/sideshift.sops.json` / `secrets/trocador.sops.json` / `secrets/trocador-pg.sops.json`
(mapper in the generator renames sops `account_id`/`secret` to the relay's
`DPAY_SIDESHIFT_AFFILIATE_ID`/`DPAY_SIDESHIFT_SECRET`); agent identity seeds stay in
`secrets/agent-{icp,sol,evm}.sops.json`, consumed directly by the funds tooling, never via
`.env`.

**Solana RPC proxy env** (the one §-local env note): `DPAY_SOLANA_RPC_URL` (sops:
`secrets/deploy.sops.json`) must be the FULL provider endpoint including its api key (e.g.
`https://mainnet.helius-rpc.com/?api-key=…`) — SECRET, never logged/echoed/committed. Unset →
`POST /api/v1/solana/rpc` answers 503 naming it, and the pre-build probe FAILS (it stages the
tree's relay with exactly this env — a build whose rail is dark does not ship). Optional
`DPAY_SOLANA_TIMEOUT_MS` (default 10000, set it in `deploy/env.config`). See
`scripts/gen-deploy-env.sh` and `crates/dpay-relay/src/solana.rs`.

**SideShift partner-key env** (2026-09-15, first relay-held venue credential): `DPAY_SIDESHIFT_SECRET`
+ `DPAY_SIDESHIFT_AFFILIATE_ID` — emitted into the generated `deploy/.env` from
`secrets/sideshift.sops.json` (keys `secret` / `account_id`) — the partner account's secret and
public id (the signup at sideshift.ai is a FOUNDER step; one account for the whole integration,
per their docs). SECRET, never logged/echoed/committed. EITHER unset is LEGAL — the
`POST /api/v1/sideshift/*` routes still register and answer 503 naming the missing variable(s);
the app fails closed with "not set up on this relay" copy. Optional `DPAY_SIDESHIFT_API_BASE`
(default `https://sideshift.ai/api/v2`, verified live 2026-09-15 — the old `api.sideshift.ai`
host is NXDOMAIN; set-but-malformed fails startup). Rotate/edit with
`sops secrets/sideshift.sops.json` + `just deploy-env`. See
`docs/specs/2026-09-14-swap-venue-feasibility.md` §"Partner-key infrastructure" and
`crates/dpay-relay/src/sideshift.rs`. NOTE: `deploy/docker-compose.yml` maps a fixed key set
into the relay container — the SideShift/Trocador-API vars are in `.env` but not yet in that
mapping, so wiring them through compose is a deliberate deploy-time change, not something the
generator does silently. `STEALTH_EX_API_KEY` (`secrets/stealthex.sops.json`) is deliberately
NOT emitted anywhere — the relay has no StealthEx routes yet.

**The Solana probe targets the tree, not prod (2026-09-10, founder friction call).** Every
shipping build stages the relay THIS TREE builds on loopback, hands it `DPAY_SOLANA_RPC_URL`
from `deploy/.env`, and runs the strict probe against that
(`scripts/stage-relay-probe.sh`, called by `build-apk.sh` and `build.sh`). The verdict covers
the relay code + the key + the upstream on every build — including the first R2 ship, which
deadlocked the old prod-targeted probe (`just apk` needed the new relay live; `just up`
embeds the apk). What is already LIVE is `just verify-relay`'s question, answered after the
deploy.
