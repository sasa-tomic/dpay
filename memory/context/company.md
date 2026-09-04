# Context — company, stack & process

## Team

Solo founder & engineer (contact: sato.dpay@kalaj.org). Pre-seed stage.
Build estimate: ~1 month solo, or ~2 weeks with two people (one on canister + relay, one on the app).

## Tech stack (PoC) — the ORIGINAL plan, kept as the record of what was intended

**Read this table as history, not as fact** (marked 2026-09-04). Several rows were decided otherwise
once the thing was built: the relay is Rust + axum and settles nothing, the canister is Rust and is
off the value path, signing is `ed25519-dalek` in `dpay-core` through UniFFI/wasm rather than a JS
library, and money is multi-asset rather than a single `$`. What actually shipped:
`CLAUDE.md` → "What's built", and `docs/CANISTERS.md` for the canister side.
**One row is a security claim and is corrected rather than left standing: key at rest is NOT the
Android Keystore.** The identity persists in plain AsyncStorage under `dpay.identity.v1`
(`app/config/constants.ts`); hardening it is listed as deferred in `CLAUDE.md` → Scope.

| Layer | Choice (as planned) |
|-------|--------|
| Mobile app | React Native, **Android only** |
| QR generate | `react-native-qrcode-svg` |
| QR scan | vision-camera QR scanner |
| Signing | `@noble/ed25519` or `tweetnacl` + `react-native-get-random-values` |
| Key at rest | Android Keystore via `react-native-keychain` |
| Relay | Node + Express + `@dfinity/agent`; in-memory idempotency store |
| Canister | Motoko or Rust (Rust: `ed25519-dalek`), deployed with `dfx` |
| Value unit | integer minor units, displayed as `$`; backed by ckUSDC on ICP if moving off the internal demo ledger |

## Reliability requirements (demo-critical)

The relay is the only online dependency during the demo, so it must be rock solid:

- **Idempotency:** the signed envelope's request id is the key; the same bytes resubmitted settle once (enforced by the IC — settlement left the relay in the 2026-08-19 cutover, so nothing is de-duped there any more). Re-signing is a second payment, not a replay: `dpay_core::PaymentRequest`.
- **Retries + timeouts:** bounded retry with backoff on transient errors; clean "tap again" state, never a hanging spinner.
- **Pre-flight health check:** merchant app pings relay before the demo, shows a green dot.
- **Demo safe-mode:** local fallback runs the full visual flow if venue wifi dies.
- **Logging + one-glance status page** for quick diagnosis.

## Roadmap phases (open issues live in `OPEN_ISSUES.md`)

1. Week 1 — Ledger: canister + tests, deploy to testnet, relay skeleton.
2. Week 2 — App core: keygen, two-mode UI, QR, offline sign, merchant submit, receipt.
3. Week 3 — Reliability + polish: relay hardening, airplane-mode flow, error states, rehearsal.
4. Week 4 — Buffer: optional real ckUSDC on testnet, bug fixes, dry run.

## Explicitly deferred (as of the original plan)

iOS, login/KYC, fiat on/off-ramp, funding flow, secure-element hardening, contacts/P2P discovery, multi-merchant, real onboarding. Some of these were built anyway — the live scope line is `CLAUDE.md` → Scope, and this list is not maintained against it.

## Related

[[dpay]] · [[glossary]]
