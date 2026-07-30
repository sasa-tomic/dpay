# Tasks

> A live TODO board, not a history dump. Completed work is summarized at the bottom; open items
> mirror `OPEN_ISSUES.md` (read it for severity, mitigation, and next steps). Structural detail
> lives in `CODEBASE_ANALYSIS.md`.

## Open

### Before pilot (high)

- [ ] **External governance hand-off (R4).** Hand the facade canister's IC-level *code controller*
      to an SNS root or a blackhole. Code supports it; this is the operator step.
      (`docs/GOVERNANCE.md` checklist.)
- [ ] **Chain-key receipt signing (R2 follow-up).** Migrate the receipt key out of stable memory to
      IC `sign_with_schnorr` / `sign_with_ecdsa` so the key never lives in canister state.
- [ ] **Rotate `ADMIN_CALLERS`** off the fixed deploy identity to a governed principal.
      (`docs/GOVERNANCE.md` checklist.)

### Optional real-money check (not a blocker)

- [ ] (Optional, costs real BTC) Send a small on-chain deposit to a facade deposit address, wait 4
      confirmations, trigger `refresh_deposit`, confirm the live mint credits currency 1. The path is
      open — ckBTC mainnet minting needs **no KYC** (minter is GeneralAvailability, no KYC checker;
      verified via `get_minter_info`).

### Production / scale (medium — defer with the documented mitigation)

- [ ] **Generalize R3 reconcile** — add a heartbeat auto-trigger + archived-block paging.
      (Single-currency / recent-blocks / admin-triggered today; correctness is already covered by
      the quantized-dedup mitigation.)
- [ ] **Multi-currency merchant request picker.** The protocol is currency-aware (ckBTC is spendable
      on a currency-1 request); only the demo request-QR UI defaults to currency 0.

### Polish (low)

- [ ] **Decouple `DEPOSIT_CURRENCY=1`** from the app display layer — surface registered currencies
      from the canister instead of hardcoding the currency id.

## Real-hardware fidelity only (not on the inner loop)

- [ ] Two physical arm64 phones for the **NFC radio hop** (HCE ↔ reader) + the airplane-mode gesture.
- [ ] A real camera for the scan (the demo fakes it today).

## Done (verified)

The PoC + a large production-readiness fix-set are **done and independently verified APPROVED**.
Gates green: `just check` (core 35 + canister 25 + relay 28), `just e2e` 15/15 in ~13s, `just verify`,
live curl all 200.

- **Canister ledger** — Ed25519 verify + nonce/expiry/cap/balance checks, atomic transfer; PocketIC
  tests (happy/nonce/expiry/cap/insufficient).
- **Facade over external ICRC ledgers** — per-currency routing, display-only balance cache, durable
  per-account transaction history; no-swap enforced across canisters (proven).
- **Relay** — axum; idempotency/retries/`/health`/safe-mode over a `Ledger` trait; `AgentLedger`
  verified end-to-end against the live canister.
- **Mobile app** — Android RN Pay/Receive; on-device key; QR generate/scan; offline signing via the
  real Rust core (UniFFI); NFC HCE glue; runs on the emulator with tap-driven Pay→Paid✓.
- **Shared Rust core** — signing/verify/validate/QR codec + NFC transport framing; proptests incl.
  conservation-of-funds + tamper; UniFFI + Python gate + Kotlin binding.
- **ckBTC deposit / top-up (seamless e2e)** — `deposit_address` / `refresh_deposit` / `deposit_info`;
  wallet renders a separate `asset-ckbtc` "Bitcoin" card; minter-arg encoding fixed (one record arg);
  live `GET /deposit/address?currency=1` → real `bc1...`.
- **Production-readiness fixes** — R1 (admin surface closed + self-service faucet), R2 (canister-
  signed receipts, app verifies before Paid), R3 (icrc3 reconcile closes the pay() trap window),
  R4 (governance path documented + code-supported).
- **e2e harness** — 15/15 flows driving the REAL app; relay isolated into `.dev/target-e2e`
  (clobber-proof, stale-binary gate fixed); parallel pool (~60s → ~13s). Old `ui/` harness deleted.
- **NFC seam audited** — rides RNW's real `RCTDeviceEventEmitter` singleton.
