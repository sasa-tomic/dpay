# Context — company, stack & process

## Team

Solo founder & engineer (contact: tomic.cld@kalaj.org). Pre-seed stage.
Build estimate: ~1 month solo, or ~2 weeks with two people (one on canister + relay, one on the app).

## Tech stack (PoC)

| Layer | Choice |
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

- **Idempotency:** authorization nonce is the key; same nonce → same receipt, never double-charge (enforced in canister, de-duped in relay).
- **Retries + timeouts:** bounded retry with backoff on transient errors; clean "tap again" state, never a hanging spinner.
- **Pre-flight health check:** merchant app pings relay before the demo, shows a green dot.
- **Demo safe-mode:** local fallback runs the full visual flow if venue wifi dies.
- **Logging + one-glance status page** for quick diagnosis.

## Roadmap phases (see TASKS.md for dated items)

1. Week 1 — Ledger: canister + tests, deploy to testnet, relay skeleton.
2. Week 2 — App core: keygen, two-mode UI, QR, offline sign, merchant submit, receipt.
3. Week 3 — Reliability + polish: relay hardening, airplane-mode flow, error states, rehearsal.
4. Week 4 — Buffer: optional real ckUSDC on testnet, bug fixes, dry run.

## Explicitly deferred

iOS, login/KYC, fiat on/off-ramp, funding flow, secure-element hardening, contacts/P2P discovery, multi-merchant, real onboarding.

## Related

[[dpay]] · [[glossary]]
