# 2026-08-28 - VCHF and ICP direct-payment support

> **Status:** U1–U8 implemented and fully verified 2026-08-28 — see **Status (2026-08-28)** below.
> Two founder steps remain pending (prod deploy; funded mainnet transfers).
> **Required analysis:** read
> [`../VCHF_ICP_ANALYSIS.md`](../VCHF_ICP_ANALYSIS.md) before editing. It contains the live canister
> evidence, standards boundary, ICP index contract, ICPSwap findings, and rejected shortcuts.
> Also read `CLAUDE.md`, `CODEBASE_ANALYSIS.md`, `OPEN_ISSUES.md`, and `FLOWS.md` as required by the
> repository instructions.

## Status (2026-08-28)

**U1–U7 implemented and fully verified; U8 (this status + doc currency updates) completes with it.**
ICPSwap buy/sell is NOT shipped — it remains out of scope for a separate future spec.

Evidence (compact):

- **Implementation** — catalog ids 7 (VCHF) / 8 (ICP) in both `app/config/catalog.ts::BUNDLED_NETWORKS`
  and the relay fake catalog (`crates/dpay-relay/src/ledger/fake.rs`), with both sides' drift alarms
  pinned to `dfx/catalog_truth.json` (now carrying `vchf_ledger`/`icp_ledger`/`icp_index` principals
  + `vchf`/`icp` decimals 8). Relay `is_testnet_row` treats `Internet Computer` as mainnet,
  fail-closed on unknown networks. Native ICP history via the index adapter in `agent_ledger.rs`:
  exact-principal dispatch, `icrc1_memo`-hex-only reconciliation (a legacy nat64 memo can never
  satisfy it), newest-first backward paging with memo-filter-before-limit, ≤10 round trips, 4s
  deadline, hand-rolled legacy account identifier (SHA-224+CRC32, golden-tested).
- **Registration** — `scripts/dfx-deploy-ic.sh` performs idempotent VCHF/ICP registration
  (probe → skip-if-identical; abort-on-mismatch without touching the peer asset; never reuses
  retired ids), proven via a full local-replica rehearsal including exact-record variant{Ok}
  validation, the skip branch, a ledger-mismatch abort, and a retired-id abort.
- **Gates** — `just verify` EXIT=0 on the final tree (96/96 e2e GREEN — full inner loop green);
  jest 64/64 suites, 1160/1160 tests; `just test-relay` 44/44; `just test-live` 62/62;
  `just ic-index-probe` PASS against mainnet `icp-api.io` (index `qhbym` fronts ledger `ryjl3` —
  `ledger_id` match + adapter query OK); orchestrator-verifier state-matrix audit APPROVED
  (12/12 rows, 7/7 cross-cutting risks, file:line evidence).
- **Device gates (emulator-5554, AVD dpay_api36)** — `just app` `DPAY_SELFCHECK PASS` (+SOL+INTL);
  offline cold start (airplane mode, `pm clear`, no catalog cache) renders the bundled VCHF/ICP
  rows (order ETH→VCHF→ICP→SOL), zai-vision clean (no `?` prefixes/clipping/duplicates/wrong
  ramps); VCHF and ICP Receive screens zai-vision clean (no ramp actions); online against the real
  prod relay pre-deploy shows exactly the 6 existing rows, no VCHF/ICP, no crash (correct —
  registration is the founder deploy step).
- **E2e** — 7 new flows (95–101: vchf-pay, icp-pay, vchf/icp-merchant-reconcile, nfc-native-assets,
  offline-bundled-assets, native-asset-fail-closed) incl. a fetch-recorder assertion that every
  canister call targets the exact ledgers; `FLOWS.md` regenerated via `node e2e/gen-flows-md.mjs`
  (97 flows = 96 default + 1 optional); visual baselines reseeded for flows 40 and 84.
- **Prod pre-deploy recon (2026-08-28)** — live catalog has NO ids 7/8 (required pre-deploy state
  confirmed); `just verify-relay` = live `81e39b4` ABOVE floor `28cc375` but BEHIND HEAD by exactly
  1 commit (`671caad` NFC illustrations, ships with this deploy); live ledger probes: `ly36x`
  symbol=VCHF decimals=8 fee=10_000; `ryjl3` symbol=ICP decimals=8 fee=10_000; `qhbym`
  `ledger_id=ryjl3` ✓.

**Outstanding — founder steps (explicitly pending, NOT done):**

1. **Prod deploy** — `just deploy-ic && just apk && just up` (idempotent registration; verified
   offline via the full local-replica rehearsal above). Afterward: re-fetch the relay catalog,
   verify section/metadata, and re-run the real-relay emulator checks per the deployment sequence
   below.
2. **Funded mainnet payment proof** — low-value app-signed VCHF + ICP mainnet transfers + receiver
   exact-memo reconciliation. BLOCKED on mainnet funds (hard external gate); production payment
   completeness is not claimed for these assets until this is recorded.

> **Addendum (2026-08-28, later the same day — founder decision):** catalog authority moved to the
> relay. The canister registry that U6's registration path targeted was REMOVED (ICP governance
> will not own the facade in the foreseeable future; the governed registry was pure friction).
> The relay's compiled catalog (`crates/dpay-relay/src/catalog.rs`) is now the sole catalog
> authority, so U6/registration is superseded and go-live = the relay deploy (`just up`, plus
> `just apk` for the bundled offline rows) — there is no facade registration step anymore and no
> catalog on the canister at all. The body of this spec below (including the registration
> rehearsal evidence and the deployment sequence) stands as history of the superseded path. The
> relay change is built and fully gated in-tree but NOT yet deployed at the time of this addendum.

## Goal

Ship VCHF and native ICP as complete first-class IC assets in the existing shared wallet surfaces:

- visible in Balance, Pay, Receive, and Ledger
- exact 8-decimal raw-unit request and payment handling
- app-signed direct `icrc1_transfer` from the user's principal
- exact receiver reconciliation and durable transaction history
- honest NFC disclosure
- no Add money or Cash out actions until a real compliant ramp exists
- mainnet classification in live and bundled Catalog v2

This is complete only when both assets work end to end. Adding two catalog rows while native ICP
history remains broken is not an acceptable partial implementation.

## Non-negotiables

- No dpay custody.
- No automatic or payment-time swaps.
- No VNX, DEX, or exchange credentials in the relay or canister.
- A request for VCHF settles VCHF; a request for ICP settles ICP.
- The app signs value-moving calls; the relay remains read-only.
- VCHF and ICP use the existing IC wallet IA, request codec, NFC transport, and rail service.
- No fake `minter_family` may be assigned merely to pass the current payability gate.
- `onramp = Unavailable` and `offramp = Unavailable` must hide ramp actions without hiding the asset
  or disabling Pay/Receive.
- No new dpay-owned canister is introduced.
- The inner loop remains autonomous and offline.

## Scope

### In scope

- VCHF and ICP catalog registration/fallback rows.
- Direct ICRC payability for complete no-minter ledgers.
- Relay Catalog v2 mainnet classification for `Internet Computer` rows.
- Native ICP history through the official ICP index canister.
- App formatting, selection, balance, request, Pay, Receive, Ledger, and NFC disclosure.
- Fake catalog/fake-IC support, unit/integration tests, e2e flows, generated `FLOWS.md`.
- Production catalog and real-relay emulator reconciliation.

### Out of scope

- ICPSwap quote/approve/swap UI.
- Automatic conversion when the payer lacks the requested asset.
- VNX institutional mint/redeem or fiat rails.
- Claiming VCHF is fiat CHF or chain-key-backed.
- Adding a generic catalog `index_canister` field. The one legacy ICP ledger/index pair is pinned in
  the relay until a second concrete ledger requires that abstraction.
- Changing the frozen payment request/wire/NFC formats.
- Following legacy ICP `query_blocks` archives for account history.

## Locked identities and metadata

Immediately before production registration, fetch the live catalog and verify candidate IDs 7 and
8 are absent. Registration must fail rather than skip if an occupied ID has a different ledger.

| Field | VCHF | ICP |
|---|---|---|
| candidate currency ID | `7` | `8` |
| ledger | `ly36x-wiaaa-aaaai-aqj7q-cai` | `ryjl3-tyaaa-aaaaa-aaaba-cai` |
| official index | existing ledger history | `qhbym-qaaaa-aaaaa-aaafq-cai` |
| ledger symbol / `wrapper_name` | `VCHF` | `ICP` |
| payment unit / `backing_symbol` | `VCHF` | `ICP` |
| `symbol` | `VCHF` | `ICP` |
| decimals | `8` | `8` |
| display decimals | `8` | `8` |
| fee raw | `10_000` | `10_000` |
| initial cap raw | `1_000_000_000_000` (10,000 VCHF) | `100_000_000_000` (1,000 ICP) |
| network | `Internet Computer` | `Internet Computer` |
| mintable | `false` | `false` |
| minter / family | `null` / `null` | `null` / `null` |
| onramp / offramp | `Unavailable` / `Unavailable` | `Unavailable` / `Unavailable` |
| chain/token/gas fields | all `null` | all `null` |

The canister's `register_currency` live validation must continue to verify ledger decimals, fee, and
symbol before committing either immutable identity.

## Work order

### U1 - Make direct ICRC payability independent of ramps

Files:

- `app/config/catalog.ts`
- `app/__tests__/catalog.test.ts`
- `app/__tests__/nfc-disclosure.test.ts`

Change `isPayableAsset` so a complete trusted ICRC descriptor is payable without a minter. Keep DEMO
as its explicit internal special case. For non-DEMO rows require:

- non-empty ledger principal text
- integer decimals in the supported range
- non-empty `wrapper_name`, `backing_symbol`, and `network`
- raw fee parseable as an unsigned integer
- raw cap parseable as a positive unsigned integer

Do not inspect `mintable`, `minter`, `minter_family`, `onramp`, or `offramp` for direct payability.
Do not broaden `familyDisplay`; it remains ramp-family display/dispatch configuration.

Tests must prove:

- the complete VCHF and ICP no-minter rows are payable
- `Unavailable` ramps do not disable payment
- missing ledger, decimals, identity, network, fee, or cap fails closed
- unknown currency IDs fail closed
- a malformed/unsupported family cannot supply missing direct-payment facts through a Bitcoin or
  Ethereum fallback
- NFC disclosure produces exact VCHF/ICP amount and `Internet Computer` network text

Update stale comments that currently state all no-minter ICRC assets are unsupported.

### U2 - Render textual VCHF/ICP amount prefixes honestly

Files:

- `app/config/catalog.ts`
- `app/components/ReceiveMode.tsx` only if layout needs a semantic wrapper change
- `app/styles.ts` only if the current fixed-width prefix clips
- corresponding Jest/UI tests

`currencySymbol` must not return `?` for the complete trusted VCHF and ICP rows. Use their exact
catalog payment units (`VCHF`, `ICP`) and make the prefix container content-sized if needed. Preserve
the existing DEMO, BTC, and USD glyph behavior and the `?` fallback for incomplete/unknown rows.

Exercise both narrow mobile and desktop/web render widths. Do not introduce a misleading franc glyph
or an unbundled token icon.

### U3 - Fix Catalog v2 mainnet partitioning

Files:

- `crates/dpay-relay/src/app.rs`
- relay route/catalog tests

Extend the relay's current explicit mainnet classification so `network = "Internet Computer"` lands
in the ICP mainnet section. Pin these cases:

- VCHF and ICP -> ICP mainnet
- DEMO (`network = null`) -> ICP mainnet
- Bitcoin and Ethereum rows remain mainnet
- Bitcoin Testnet and Sepolia rows remain testnet

Do not add duplicate app-side inference. The app must continue trusting the section's authoritative
`environment` field. Add a comment that display-string inference is temporary schema debt.

### U4 - Add the native ICP index history adapter

Files:

- `crates/dpay-relay/src/agent_ledger.rs`
- `crates/dpay-relay/Cargo.toml`
- `Cargo.lock` if the dependency graph changes
- `crates/dpay-relay/tests/live.rs`
- focused relay unit tests

Pin:

```text
ICP_LEDGER = ryjl3-tyaaa-aaaaa-aaaba-cai
ICP_INDEX  = qhbym-qaaaa-aaaaa-aaafq-cai
```

Dispatch history by exact ledger principal:

- canonical ICP ledger -> `get_account_transactions` on the official ICP index
- every other ledger -> existing `get_transactions` walker unchanged

Mirror only the required index Candid types locally. The query argument is:

```text
account = { owner = user principal; subaccount = null }
start = null or last-seen transaction id
max_results = bounded page size
```

Map the result to the existing `TxnRecord` REST contract:

- `Transfer`, `Mint`, `Burn` only; omit `Approve`
- `amount.e8s` as the existing decimal string/raw amount contract
- `timestamp` preferred, `created_at_time` fallback; nanoseconds divided by 1,000,000,000
- `icrc1_memo` preferred and hex encoded exactly; legacy memo is not allowed to satisfy a 16-byte
  dpay reconciliation match
- newest-first
- empty sender for mint and empty recipient for burn, matching existing history conventions
- currency copied from the requested catalog row

Direction compatibility is load-bearing. The index operations expose legacy textual account
identifiers, while the app determines direction by comparing `TxnRecord.from` with the user's
principal. Compute the default-subaccount ICP account identifier for the queried principal. When an
operation side equals it, emit the user's principal text for that side; emit the counterparty's
account-identifier text unchanged for the other side. Use `ic-ledger-types` behind the existing
`agent` feature if available in the offline cache rather than hand-rolling CRC/SHA account-ID logic.

Pagination and timeout behavior:

- ordinary history: stop as soon as `limit` matching rows are collected
- exact memo: page backward using the last transaction ID as `start`
- preserve the existing 4-second overall deadline and at most 10 index round trips
- never perform a ledger-wide `query_blocks` scan
- an index error or timeout fails that currency only; it must not blank history from other assets

Tests must cover:

- ledger dispatch selects the index only for the canonical ICP principal
- transfer in, transfer out, mint, burn, and approval omission
- principal/account-identifier direction mapping
- `icrc1_memo` byte preservation and exact-memo filtering before limit
- timestamp nanoseconds -> seconds
- newest-first pagination with `start`
- bounded no-match termination and timeout/error propagation
- amounts at `u64::MAX` without JS-number conversion

Extend the existing PocketIC/agent live harness with a test index responder at the pinned index
principal, preferably a universal canister returning golden Candid replies. Do not rely only on pure
mapper tests. Add a read-only mainnet smoke that verifies `ICP_INDEX.ledger_id() == ICP_LEDGER` and a
small real account-history query; keep it off the offline hot path if repository convention requires.

### U5 - Add authoritative/fallback catalog rows

Files:

- `dfx/catalog_truth.json`
- `app/config/catalog.ts::BUNDLED_NETWORKS`
- `crates/dpay-relay/src/ledger/fake.rs::fake_catalog`
- app catalog/assets tests
- relay fake-catalog/drift tests

Add both records exactly as locked above, in order after currency 6: VCHF 7, ICP 8. Extend the truth
file with:

- `vchf_ledger`
- `icp_ledger`
- `icp_index`
- `vchf` and `icp` decimals

Update both Rust and Jest drift alarms so principal, ID, decimals, fee, unit, network, no-minter
shape, no-ramp capabilities, and order cannot diverge.

`buildSelectableAssets` should require no production special case. Tests must prove:

- stable IDs `ic:7` and `ic:8`
- test keys `vchf` and `icp`
- VCHF and ICP are mainnet-visible when `showTestnet=false`
- selector/order survives a live catalog refresh
- zero-balance rows remain visible
- no Add/Cash actions are emitted for either row
- network labels distinguish the IC rows honestly

### U6 - Add idempotent production registration

Files:

- `scripts/dfx-deploy-ic.sh`
- `deploy/dfx-lib.sh` only if a reusable identity assertion is the smallest change
- deploy-script checks/tests if present

Follow the currency-6 `register_currency` pattern, but do not copy `${CAP}`. Use the locked per-asset
raw caps.

Before each registration:

1. Probe `currencies()`.
2. If the ID is absent, call `register_currency` with the exact record.
3. If the ID is present, assert its ledger equals the expected principal and its identity metadata
   is coherent; skip only when it is the same asset.
4. If present with another ledger, abort loudly. Do not silently skip.
5. If registration reports retired/duplicate/mismatch, abort and leave the other asset's state
   visible to the operator; never choose a new ID automatically in the script.

`register_currency` validates the external ledger on mainnet. A local deploy rehearsal cannot reach
those mainnet ledgers; use the existing expected-mismatch convention rather than weakening live
validation or adding fake production fallbacks.

Update the deploy script's top comments and registration summary to list DEMO, ckBTC, ckUSDC,
ckETH, VCHF, and ICP accurately.

### U7 - Exercise both assets through the real app flow

Files likely include:

- `e2e/tests/` (allocate the next free flow IDs from source)
- e2e fake-IC/catalog fixtures
- `FLOWS.md` generated by `node e2e/gen-flows-md.mjs`
- focused component/Jest tests where e2e cannot isolate a branch

Add coverage that exercises, rather than only snapshots, these paths for each asset:

1. Mainnet row appears in the shared asset selector with the exact unit/network and no ramp actions.
2. A merchant creates an 8-decimal request in that asset.
3. The payer scans/opens it, sees exact unit/network/amount, and explicitly approves.
4. The app signs an `icrc1_transfer` to the asset's exact ledger principal.
5. The transfer settles in fake-IC, both balances refresh, and no other currency changes.
6. Receiver exact-memo reconciliation reaches `Received` only on an exact row.
7. Ledger shows incoming/outgoing direction, amount, unit, and counterparty.
8. NFC disclosure identifies VCHF/ICP before signing.
9. Offline cold start renders both bundled rows.
10. Insufficient balance and malformed/unknown currency paths still fail closed.

For native ICP, include relay integration coverage of the index adapter; e2e fake history alone does
not prove the production backend. For VCHF, keep the existing generic ICRC history path.

Regenerate `FLOWS.md`; never hand-edit it.

### U8 - Documentation and structural analysis update

Files:

- `CLAUDE.md`
- `CODEBASE_ANALYSIS.md`
- `OPEN_ISSUES.md`
- this spec status section

Only after implementation and full verification:

- change VCHF/ICP from planned to shipped in `CLAUDE.md`
- document the pinned ICP index history exception and the resolved no-minter payability limitation in
  `CODEBASE_ANALYSIS.md`
- remove/close this item from `OPEN_ISSUES.md`
- mark completed units in this spec with the actual verification evidence

Do not describe ICPSwap buy/sell as shipped.

## State-matrix audit

The implementation session must walk every combination below before claiming completion:

| Area | VCHF | ICP | Expected behavior |
|---|---:|---:|---|
| cold/offline catalog | yes | yes | mainnet row visible from bundled catalog |
| live catalog | yes | yes | mainnet section, IDs 7/8, exact ledger |
| zero balance | yes | yes | visible, Pay/Receive available, ramps hidden |
| funded balance | yes | yes | exact 8-decimal balance |
| request create/decode | yes | yes | exact currency/raw amount |
| online transfer | yes | yes | direct ledger envelope, no facade value call |
| insufficient funds | yes | yes | no false settled state |
| receiver exact memo | yes | yes | exact row required before Received |
| ordinary history | generic ICRC | ICP index | newest-first, correct direction/unit |
| NFC review | yes | yes | asset, amount, Internet Computer disclosed |
| unknown/malformed row | shared | shared | declined before signing |
| Add/Cash actions | absent | absent | unavailable ramps are honest |
| testnet hidden | unchanged | unchanged | true testnet rows remain hidden by default |

## Verification gates

Run the smallest focused tests during implementation, then run the complete required gates once the
full slice is finished:

```sh
just test-relay
just test-core
just test-canister
just typecheck
just e2e
just verify
```

`just verify` is mandatory but not sufficient for this catalog/balance/UI change.

Production reconciliation required by `AGENTS.md`:

1. Fetch `https://dpay.kalaj.org/api/v1/currencies` and verify VCHF/ICP are in the ICP mainnet
   section with exact IDs/principals and no duplicate/testnet leakage.
2. Run a read-only live ICP index probe and verify `ledger_id` plus account-history decoding.
3. Drive the real app on the booted emulator against the real relay, not the e2e fake.
4. Capture the selector, VCHF Receive, ICP Receive, balances, and Ledger states; analyze screenshots
   with `zai-vision` for clipping, `?` prefixes, duplicate rows, and wrong network/ramp actions.
5. Because catalog/balance UI is touched, run the device gate required by the repository instructions
   if any changed path triggers it. At minimum the real-relay emulator pass is mandatory.
6. Before declaring payment complete, perform low-value app-signed mainnet transfers for both assets
   and confirm receiver exact-memo history. If the session lacks VCHF/ICP funds, this is a hard
   external gate: finish every autonomous test and record the precise blocked proof without claiming
   production payment completion.

Do not assert production is current from prose. Run `just verify-relay` and report its exact live
commit classification as required by `AGENTS.md`.

## Deployment sequence

1. Finish and verify code/fallbacks before mutating the production catalog.
2. Re-read the live production catalog; confirm IDs 7 and 8 are still absent.
3. Query both live ledgers again for symbol, decimals, fee, and supported standards.
4. Query the ICP index `ledger_id` and confirm the canonical ledger.
5. Founder runs the normal idempotent production deploy path. `register_currency` atomically validates
   and records each identity.
6. Re-fetch the relay catalog and verify section/metadata.
7. Run the real-relay emulator checks and low-value transfers.

If one registration succeeds and the second fails, do not roll back or retire the successful immutable
identity. Diagnose and rerun the idempotent script; it must verify-and-skip the correct row.

## Done definition

This spec is complete only when:

- every U1-U8 unit is implemented or explicitly proven unnecessary
- all focused and full offline gates pass
- VCHF and ICP use direct user-signed transfers to the exact canonical ledgers
- native ICP history and receiver reconciliation use the official index successfully
- both rows are mainnet-visible with no ramp actions and no ambiguous `?` prefix
- exact no-minter payability is tested while malformed rows remain fail-closed
- production catalog/real-relay UI reconciliation is clean
- low-value live transfer evidence exists for both assets, or that final proof is explicitly recorded
  as externally blocked without claiming production completeness
- `CLAUDE.md`, `CODEBASE_ANALYSIS.md`, `OPEN_ISSUES.md`, and this status are current

ICPSwap buy/sell remains a separate follow-up. Its future spec must include quote freshness,
price-impact/slippage bounds, exact allowance/expiry, asynchronous output/refund reconciliation,
residual allowance revocation, and persistent recovery states described in the analysis.
