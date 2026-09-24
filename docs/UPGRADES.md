# Facade upgrades — the recorded changelog

Every upgrade of the facade canister (`ssqti-wiaaa-aaaab-qhdia-cai` on mainnet) gets ONE row
here: when it shipped, which source built it, the sha256 of the wasm the IC installed, and what
changed. The row is the contract `just integrity-check` polices — the relay bakes the newest
row's hash at image-build time (`deploy/facade-module-hash.txt`, tracked) and reports the live
canister against it at `GET /api/v1/integrity`, so an upgrade that skipped this file is a
`MISMATCH` anyone can curl (GOVERNANCE row 7: upgrades must be user-detectable).

How the pieces fit:

- The sequence that produces a row — and the gate that makes skipping it stop the deploy — is
  `docs/OPS.md` §3.
- `just integrity-check` curls the live relay and asserts `status == MATCH`.
  `UNPINNED`/`MISMATCH`/`UNREACHABLE` each say what to do next.
- To measure the live hash by hand (no relay in the loop):
  `dfx canister info ssqti-wiaaa-aaaab-qhdia-cai --network ic` → the `Module hash: 0x…` line.
  `just verify-deploy` additionally proves the live wasm is byte-identical to the current
  source (builds from HEAD and compares).

| Date | Git commit | Module hash (sha256) | Notes |
|------|------------|----------------------|-------|
| 2026-09-20 | `71b3c454438bed7241c117e7c0c5e8b1c0d541c1` | `0e75899b95e34105e22b24de86b7b545667e0c3bc397c5a49c36e880d3455312` | Founder ran `just deploy-ic` (OPS §3) on 2026-09-20 ~22:26. Ships the canister source at `03af21b`: one canister change since the row below — the checkout charge-open carries a customer note under its own tag (`4fdc08e`) — plus the settlement-probe timestamp floor (`9b66796`) rebuilt into the wasm. The deploy's auto-commit (founder friction call 2026-09-10) recorded the new pin as `71b3c45` and left `/api/v1/integrity` at `MISMATCH` by design between the deploy's halves: the relay image still pins `e537056e` (relay_commit `44762b3`, 2026-09-19) until the relay redeploy ships an image built from `71b3c45`. `just verify-deploy` PASS at this commit describes the installed wasm exactly. |
| 2026-09-08 | `20133499671579758f331ba22afd9f33f12cfc6f` | `e537056e9bf44b17777563d0f3e08f4ceef9c29fd4d4d924f1f9cd16928fe1cc` | Ships `90f5930`, the only canister-source change since the row below: no heartbeat — the stale-intent sweep runs lazily and rate-limited on update ingress, `reconcile` walks the ledger in pages, and `inflight_intents` is added (`dfx/dpay_canister.did` regenerated). Recorded a deploy late: the founder ran `just deploy-ic` on 2026-09-08 and shipped the relay image before this row and the pin were committed, so prod reported `20133499…-dirty`. `just verify-deploy` PASSes at this commit (source-built sha == live module hash), so the row describes the installed wasm exactly. |
| 2026-09-06 | `41b8bf4fcee7a326064e10bbeead5541bb45ea31` | `0978386f70a4313e8548937d3e7abb5210deea06682620a54da0e1b69588722c` | The pin starts here — the live hash, measured off mainnet and recorded as the initial pin. `just verify-deploy` PASSed at this commit (live == source at HEAD), so the row describes the canister exactly. Upgrades before this date were not recorded; this row is the baseline, not the history. |
