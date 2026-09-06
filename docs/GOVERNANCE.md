# dpay canister governance

> **Who can upgrade the canister, and who can call its privileged ops, is a money-critical design
> question — not ops trivia.** Whoever controls the canister can change its behavior, so "we can't
> touch your funds" is only a *property* (not a promise) when control is governed. This doc is the
> operator-facing path to make it one.

## Stance (founder-set 2026-08-20): govern IN PLACE, no NNS/SNS handoff

**We are not moving the canister or relay under NNS/SNS control.** Convincing the general ICP
community to vote on our upgrades is unrealistic until critical mass. Therefore:

- The founder keys (IC-level controller + in-canister controller/operator) are the **permanent root
  of trust for the foreseeable future**, not a transitional state. The strategy is to make that
  acceptable — **safe without governance** — via least-authority, scoping, and verifiability, not via
  a hand-off we can't get.
- The SNS/blackhole mechanics below stay as **reference for the eventual critical-mass end-state**
  (blackholing also remains a per-canister freeze option if a surface is ever feature-complete).
  They are explicitly **not** pre-pilot gates.

> **Founder decision (2026-08-28): catalog authority moved to the relay.** ICP governance will not
> own the facade canister in the foreseeable future, so the governed currency registry was pure
> friction and was removed from the canister (`register_*`/`retire_currency`/`currencies()` are gone;
> init arg is now `record { demo_ledger; per_tx_cap; controller }`). The sole catalog authority is
> the relay's compiled catalog (`crates/dpay-relay/src/catalog.rs`): adding a currency is a relay
> code change through git review, live with the next `just up`. The registry is easy to re-add if a
> governance handoff ever becomes real and would add value then; the catalog-lock items below that
> targeted the registry are superseded (annotated in place).

## Objectives (the plan's acceptance bars)

- **O1 — Bounded blast radius.** Compromise of ANY single online component (relay box, faucet seed,
  relay image) must be unable to (a) move resting user balances, (b) hold standing sweep rights over
  user ck-assets, or (c) upgrade canister code.
- **O2 — Cheap, independent rotation.** Every scoped key must rotate without touching any other
  (faucet seed swap ≠ root key ≠ IC controller), in minutes, with no canister data migration.
- **O3 — Detectability.** Any code upgrade of a money-path canister must be independently
  discoverable by a user/app even though it is not preventable.
- **O4 — No custodial drift.** No architecture change may quietly move authority over user funds
  toward the operator (standing approvals, relay-held sweep keys, custody subaccounts). The
  non-custodial hard rule in `CLAUDE.md` is the boundary; this plan only works *inside* it.
- **O5 — Realism.** No plan item may depend on NNS/SNS adoption, a token, or community votes.

## The govern-in-place plan

### P0 — Foundations (DONE or in flight, 2026-08-20)

| # | Item | Status |
|---|------|--------|
| 1 | Value at USER principals, facade out of the value path (post-cutover) | ✅ done (2026-08-19) |
| 2 | Per-op exact-amount minter approvals; no standing approvals ever | ✅ done (withdraw paths) |
| 3 | Faucet mint fixed-amount + rate-limited; admin ops denied without controller (R1) | ✅ done |
| 4 | **Dedicated Ed25519 faucet controller key** (`DPAY_CONTROLLER_SEED`) ≠ dfx root ≠ IC controller; deploy script arms it; `just faucet-verify` proves the wiring (seed↔controller↔IC-controller legs + optional live mint) | ✅ shipped — `just faucet-verify --mint` PASSED against prod 2026-08-30, all 5 legs incl. a live 200 mint |
| 5 | Refusal surface pinned verbatim in tests (`live_faucet_refuses_non_controller_identities_verbatim`, `admin_ops_are_gated_by_controller`, `admin_ops_admit_operators_alongside_the_controller`) | ✅ shipped — proven live by the same 2026-08-30 `faucet-verify --mint` run (leg 3 readback + leg 5 mint) |

### P1 — Hardening the online surface (next, pre-pilot)

| # | Item | Closes |
|---|------|--------|
| 6 | **Cold storage for the IC-level controller identity** (upgrade authority): PEM offline, imported only at deliberate deploys, never on the relay box | O1(c) |
| 7 | **Module-hash pinning/publishing**: relay `/api/v1/health` (or a `/api/v1/integrity`) reports the live facade module hash (read_state); changelog per upgrade | ✅ shipped — `GET /api/v1/integrity` compares the live hash against the pin baked at build time (`deploy/facade-module-hash.txt`; `just integrity-check` gates MATCH); the changelog is `docs/UPGRADES.md`, and `just deploy-ic` re-pins + reminds: add a row on every upgrade (live with the next relay image — floor `face8fba` predates it) |
| 8 | ~~**`lock_catalog` one-way ratchet** (canister): after lock, `register_ledger`/`register_currency_meta` refuse changes (or require a timelocked path) — closes the ledger-repoint phishing vector from a leaked faucet key~~ — **struck 2026-08-28: superseded by the founder decision above.** The registry (and with it the ledger-repoint vector) no longer exists on the canister; catalog authority is relay code behind git review + drift alarms | ~~O1~~ closed structurally |
| 9 | Ops runbook: `reconcile` on a schedule + after any suspected trap; key-rotation runbook for each scoped key | ✅ shipped — `docs/OPS.md` (when/how to `just reconcile`, how to read the report, run log; per-key rotation for the controller seed, the IC-level controller PEM, and the retired receipt key; the upgrade loop) |

### P2 — Pre-real-money (when real value flows, still no NNS)

| # | Item | Closes |
|---|------|--------|
| 10 | **Timelock canister as IC-level controller** (self-governance, "poor man's DAO"): upgrades execute only after a public delay — users get exit time; no community vote needed | O1(c), O3 |
| 11 | Receipt/audit hardening: app verifies canister-signed receipts (R2) before "Paid ✓" | O3 |
| 12 | Optional per-surface blackholing once a canister surface is feature-complete forever | O1 |

### Honest residual (accepted, revisit at critical mass)

Without governance, upgrade authority is irreducibly founder-held. This plan makes compromise
harder, slower to exploit, cheaper to recover from, and visible — not impossible. Items 10+ are the
bridge; the SNS reference below is the end-state if critical mass ever makes it realistic.

### Strategy pillars behind the plan

1. **Least authority in code (structural).** The operator's worst case must be bounded by the code
   they *can't* quietly change users' exposure to: value sits at USER principals (post-2026-08-19
   cutover); minter approvals are per-op exact-amount (never standing); faucet mint is fixed-amount +
   rate-limited; admin ops are denied without a controller.
2. **Scope and separate keys.** The relay's faucet key (`DPAY_CONTROLLER_SEED`, Ed25519) is a
   DEDICATED key that gates only play-money DUSD mint + config — it is not the deploy identity
   (dfx identities are secp256k1; the relay agent signs Ed25519) and not an IC-level controller. A
   leaked seed's blast radius: unlimited demo-$ mint — no catalog repoint is possible from the
   canister anymore (registry removed 2026-08-28; the catalog is relay code, changed only through
   git review + deploy) — rotatable via
   `set_controller` + seed swap without touching the root keys.
3. **Cold-storage discipline for the root keys.** The IC-level controller identity (upgrade
   authority — the one power that supersedes everything) lives offline; it is used only during
   deliberate deploys, never on the always-on relay box.
4. **Verifiability without governance.** Publish/pin the canister module hash; the relay exposes it
   and the app can check it (read_state) so an unexpected upgrade is *detectable* by users even
   though it isn't preventable. Upgrades get a public changelog.
5. **Optional future hardening (no NNS needed):** a timelock/self-governance canister as IC-level
   controller (upgrades execute only after a delay, giving users exit time) — the "poor man's DAO";
   defer until real value flows. Blackhole a surface only when it is feature-complete forever.

This is a **code-level** governance guide. The canister code (after R1) supports a governed
controller out of the box; any hand-off remains an **external, human step** the operator performs at
deploy — it cannot be faked in code, and it is deliberately not done in this repo.

## Two layers of control (both must be governed)

The dpay facade canister has **two independent layers** of control. Governing one does not govern
the other.

1. **In-canister governance controller** (`CONTROLLER`, stable MemoryId 6). Gates the privileged
   *methods*: `mint` / `burn` / `reconcile` / `set_controller` (the `register_*` family was removed
   with the registry, 2026-08-28).
   - **Denied when `controller == null`** (the R1 flip): a deployment that forgets to seed a
      controller cannot have its demo currency printed by any caller (currency repoint ceased to
      exist with the registry). The
      self-service `faucet` (fixed amount, rate-limited) is the only value-creating path open without a
      controller.
   - `set_controller` keeps a one-time open-mode lockdown (callable when `null`) plus two-step
     rotation once locked (only the current controller rotates). The **production path is to seed a
     governed principal at `init`** so the canister never runs in open mode against an adversary.
2. **IC-level canister (code) controller** — the principal that can `install_code` / upgrade /
   uninstall the canister's wasm. This is set by `dfx`/the management canister at deploy and is
   **distinct** from layer 1: it controls *code upgrades*, not admin methods. It starts as your
   deploy identity, and whoever holds that key can upgrade the canister to a version that ignores
   layer 1 entirely — which is the whole reason the Stance section's least-authority and cold-storage
   discipline exists. (This paragraph used to say the key **must** be rotated to an SNS principal or
   a blackhole before any pilot. That contradicted the founder stance above, which is explicit that
   those are not pre-pilot gates, and the stance wins.)

`provision_ledger_canister` and `transfer_cycles` are separately gated by the fixed `ADMIN_CALLERS`
operator allowlist (an ops/cycles function); rotate that list to a governed principal before
production too.

## 1. Seed the in-canister controller at deploy (layer 1)

The `init` argument carries the controller. The demo default is `null` (open, for local/PocketIC):

```
// dfx/args/init.arg  (demo default — DO NOT ship this to a governed deployment)
(record { demo_ledger = principal "td2nx-oaaaa-aaaab-qhdnq-cai"; per_tx_cap = 100000 : nat64; controller = null })
```

To deploy **governed**, set `controller` to your governance principal (an SNS root, an NNS-governed
canister, or a governance-controlled principal):

```sh
# Example: a governed controller principal (replace with your SNS root / governance principal).
GOV=rrkah-fqaaa-aaaaa-aaaaq-cai
cat > dfx/args/init.governed.arg <<EOF
(record { demo_ledger = principal "${LEDGER_DUSD}"; per_tx_cap = 100000 : nat64; controller = opt principal "${GOV}" })
EOF

dfx deploy dpay_canister --network ic --mode install --argument-file dfx/args/init.governed.arg
```

After this, `mint`/`burn`/`reconcile`/`set_controller` succeed **only** when called by
`$GOV`. Verify:

```sh
# Anonymous mint is refused (no controller-as-caller). A controller-as-caller mint would need to be
# submitted through the governance principal's own call path (SNS proposal → canister call).
dfx canister call dpay_canister mint '(vec {}, 0, 10000 : nat64)' --network ic   # → Err("...no controller set...")
```

To **rotate** the controller later (e.g. SNS root → a new governance principal), the current
controller calls `set_controller` — typically via an SNS/governance proposal:

```sh
NEW_GOV=...
dfx canister call dpay_canister set_controller '(opt principal "'${NEW_GOV}'")' --network ic   # called AS the current controller
```

## 2. Set the IC-level code controller (layer 2)

After install, the canister's **code controller** is your deploy identity. Rotate it to governance:

### Option A — SNS-governed

Hand the canister to an SNS via the standard SNS `dapp_canister` ownership transfer (an NNS proposal
that lists this canister id). After the proposal executes, the SNS **root** canister is the code
controller; upgrades then require an SNS proposal (the community votes). Reference for the
critical-mass end-state, per the Stance section — not a recommendation for now.

See the SNS lifecycle docs: <https://internetcomputer.org/docs/current/developer-docs/defi/sns>

### Option B — blackhole (no further upgrades possible)

For a canister you intend never to upgrade again, set the code controller to a blackhole (a principal
no one controls). After this, **no one** can upgrade the code:

```sh
# The canonical blackhole canister id (verify against current IC docs before using):
BLACKHOLE=7kym-tiaaa-aaaaq-aaaaa-cai
dfx canister update-settings dpay_canister --controller $BLACKHOLE --network ic
```

⚠️ Blackholing is **irreversible** — verify the canister is in its final intended state first.

### Verify the code controller

```sh
dfx canister status dpay_canister --network ic | grep controller
```

## Checklist before any pilot (govern-in-place edition)

- [ ] Layer 1: `init` seeds a `controller` (never ship `controller = null` to production); the
      relay's faucet key is the DEDICATED Ed25519 seed (not the dfx identity's key material).
- [ ] Layer 2: the IC-level code controller identity lives in **cold storage** (offline PEM, used
      only at deliberate deploys; never on the relay box).
- [ ] Blast-radius review: no standing approvals (per-op exact-amount only), faucet fixed-amount +
      cooldown; catalog changes ride the relay-deploy path (git review + drift alarms — registry
      repoint ceased to exist with the 2026-08-28 registry removal).
- [x] Module hash of the deployed facade is pinned/published (relay health surface) so upgrades are
      user-detectable; upgrades ship with a changelog. — `GET /api/v1/integrity` (live vs the
      build-time pin) + `just integrity-check`; `docs/UPGRADES.md` is the changelog (2026-09-06).
      (Live with the next relay image — floor `face8fba` predates it.)
- ~~[ ] `receipt_pubkey()` is fetched and the app verifies receipt signatures (R2) before "Paid ✓".~~
  **Struck 2026-09-04 — retired by the cutover, not done.** `/receipt/{nonce}` and `/receipt_pubkey`
  are deleted; "Paid ✓" comes from the app's own `read_state` poll of the envelope it submitted.
- [x] `reconcile(currency)` is wired into ops runbooks (run after any suspected trap / on a schedule).
      — `docs/OPS.md` §1 (symptoms, cadence, report reading, run log); `just reconcile` is the
      founder-run hook (2026-09-06).

## Non-custodial invariant

None of this changes dpay's core posture: the canister **never holds user funds it can move at will**.
**Corrected 2026-09-04** — this paragraph still described the pre-cutover facade, which held user
balances at `Account{owner: facade, subaccount: pubkey}` and moved them under an offline-signed
`pay`. Since the 2026-08-19/20 cutover the property is stronger and simpler: user funds sit at the
**user's own principal** on the external ICRC ledgers and move only under the user's own signature,
with no dpay canister on the value path at all (`docs/CANISTERS.md` is the authority). Governing the
controller closes the "can the operator change the rules" question — it never was, and still is not,
a way for the operator to move user funds.
