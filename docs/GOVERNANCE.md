# dpay canister governance

> **Who can upgrade the canister, and who can call its privileged ops, is a money-critical design
> question — not ops trivia.** Whoever controls the canister can change its behavior (including, in a
> future version, the fee schedule), so "we can't touch your funds" is only a *property* (not a
> promise) when control is governed. This doc is the operator-facing path to make it one.

This is a **code-level** governance guide. The canister code (after R1) supports a governed
controller out of the box; the actual hand-off to an SNS / NNS / blackhole is an **external, human
step** the operator performs at deploy — it cannot be faked in code, and it is not done here.

## Two layers of control (both must be governed)

The dpay facade canister has **two independent layers** of control. Governing one does not govern
the other.

1. **In-canister governance controller** (`CONTROLLER`, stable MemoryId 6). Gates the privileged
   *methods*: `mint` / `burn` / `register_ledger` / `register_minter` / `reconcile` / `set_controller`.
   - **Denied when `controller == null`** (the R1 flip): a deployment that forgets to seed a
     controller cannot have its currency repointed or its demo currency printed by any caller. The
     self-service `faucet` (fixed amount, rate-limited) is the only value-creating path open without a
     controller.
   - `set_controller` keeps a one-time open-mode lockdown (callable when `null`) plus two-step
     rotation once locked (only the current controller rotates). The **production path is to seed a
     governed principal at `init`** so the canister never runs in open mode against an adversary.
2. **IC-level canister (code) controller** — the principal that can `install_code` / upgrade /
   uninstall the canister's wasm. This is set by `dfx`/the management canister at deploy and is
   **distinct** from layer 1: it controls *code upgrades*, not admin methods. It starts as your
   deploy identity and **must be rotated to an SNS/governance principal or a blackhole** before any
   pilot — otherwise whoever holds the deploy key can upgrade the canister to a version that ignores
   layer 1 entirely.

`provision_ledger_canister` and `transfer_cycles` are separately gated by the fixed `ADMIN_CALLERS`
operator allowlist (an ops/cycles function); rotate that list to a governed principal before
production too.

## 1. Seed the in-canister controller at deploy (layer 1)

The `init` argument carries the controller. The demo default is `null` (open, for local/PocketIC):

```
// dfx/args/init.arg  (demo default — DO NOT ship this to a governed deployment)
(record { ledgers = vec {}; per_tx_cap = 100000 : nat64; controller = null })
```

To deploy **governed**, set `controller` to your governance principal (an SNS root, an NNS-governed
canister, or a governance-controlled principal):

```sh
# Example: a governed controller principal (replace with your SNS root / governance principal).
GOV=rrkah-fqaaa-aaaaa-aaaaq-cai
cat > dfx/args/init.governed.arg <<EOF
(record { ledgers = vec { record { currency = 0 : nat32; principal = principal "${LEDGER_DUSD}"; mintable = true } }; per_tx_cap = 100000 : nat64; controller = opt principal "${GOV}" })
EOF

dfx deploy dpay_canister --network ic --mode install --argument-file dfx/args/init.governed.arg
```

After this, `mint`/`burn`/`register_*`/`reconcile`/`set_controller` succeed **only** when called by
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

### Option A — SNS-governed (recommended for a revenue-generating canister)

Hand the canister to an SNS via the standard SNS `dapp_canister` ownership transfer (an NNS proposal
that lists this canister id). After the proposal executes, the SNS **root** canister is the code
controller; upgrades then require an SNS proposal (the community votes). This is what makes the fee
schedule and "we can't touch your funds" a *governed property* — see `CLAUDE.md` §Monetization.

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

## Checklist before any pilot

- [ ] Layer 1: `init` seeds a governed `controller` (never ship `controller = null` to production).
- [ ] Layer 2: the IC-level code controller is an SNS root or a blackhole (not your deploy key).
- [ ] `ADMIN_CALLERS` (the cycles operator allowlist in `lib.rs`) is rotated to a governed principal.
- [ ] `receipt_pubkey()` is fetched and the app verifies receipt signatures (R2) before "Paid ✓".
- [ ] `reconcile(currency)` is wired into ops runbooks (run after any suspected trap / on a schedule).

## Non-custodial invariant (unchanged)

None of this changes dpay's core posture: the canister **never holds user funds it can move at will**.
User balances live on external ICRC ledgers at `Account{owner: facade, subaccount: pubkey}`; the
facade moves them only under a user's offline-signed authorization (`pay`), or the self-service
faucet's fixed-amount demo mint. Governing the controller closes the "can the operator change the
rules" question — it does not give the operator a new ability to move user funds.
