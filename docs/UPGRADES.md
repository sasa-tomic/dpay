# Facade upgrades — the recorded changelog

Every upgrade of the facade canister (`ssqti-wiaaa-aaaab-qhdia-cai` on mainnet) gets ONE row
here: when it shipped, which source built it, the sha256 of the wasm the IC installed, and what
changed. The row is the contract `just integrity-check` polices — the relay bakes the newest
row's hash at image-build time (`deploy/facade-module-hash.txt`, tracked) and reports the live
canister against it at `GET /api/v1/integrity`, so an upgrade that skipped this file is a
`MISMATCH` anyone can curl (GOVERNANCE row 7: upgrades must be user-detectable).

How the pieces fit:

- `just deploy-ic` upgrades the canister, then **auto-writes** the fresh hash into
  `deploy/facade-module-hash.txt` and prints the reminder to add the row here. Commit both
  together (the pin is only a pin if the changelog and the file move as one).
- `just integrity-check` curls the live relay and asserts `status == MATCH`.
  `UNPINNED`/`MISMATCH`/`UNREACHABLE` each say what to do next.
- To measure the live hash by hand (no relay in the loop):
  `dfx canister info ssqti-wiaaa-aaaab-qhdia-cai --network ic` → the `Module hash: 0x…` line.
  `just verify-deploy` additionally proves the live wasm is byte-identical to the current
  source (builds from HEAD and compares).

| Date | Git commit | Module hash (sha256) | Notes |
|------|------------|----------------------|-------|
| 2026-09-06 | `41b8bf4fcee7a326064e10bbeead5541bb45ea31` | `0978386f70a4313e8548937d3e7abb5210deea06682620a54da0e1b69588722c` | The pin starts here — the live hash, measured off mainnet and recorded as the initial pin. `just verify-deploy` PASSed at this commit (live == source at HEAD), so the row describes the canister exactly. Upgrades before this date were not recorded; this row is the baseline, not the history. |
