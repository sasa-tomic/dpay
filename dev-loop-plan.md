# Autonomous local dev loop — plan

**Hard requirement (non-negotiable):** Claude must run the full dev cycle — analyze UI, test, identify/debug, fix, verify the fix — **fully autonomously, locally, offline, in seconds.** No human in the loop, no GUI, no network on the inner loop. Any design that forces a slow, online, or human-gated step into core iteration is unacceptable; restructure instead.

This document specifies how we hit that, given what the agent's execution environment can actually do.

---

## 1. Environment grounding (measured, not assumed)

Claude's shell runs in an isolated Linux VM — **not** the user's machine, and **not** an Android device. Measured:

- Ubuntu 24.04, x86_64, 16 vCPU, 38 GB RAM — plenty for parallel Rust builds.
- **No `/dev/kvm`.** No hardware virtualization. A hardware-accelerated Android emulator cannot run here; software emulation would be minutes-per-cycle and needs a display anyway.
- `docker` + `podman` present; `python3`, `java`/`javac` present. Headless UI screenshots run against a **vendored `chrome-headless-shell` in `.dev/browser/`** — the system `/usr/bin/chromium-browser` is a non-functional Ubuntu snap stub, so the UI harness downloads a real headless Chrome once (online) and runs it offline thereafter.
- Rust, Node, dfx, adb, Playwright: not preinstalled, but installable; outbound internet works for a one-time prefetch.

**The load-bearing consequence:** the Android emulator / physical device is a **fidelity gate**, not part of the inner loop. Everything money- and protocol-critical must be runnable headlessly. So we push that logic out of the UI and into a strongly-typed Rust core that the agent can test in seconds.

---

## 2. Design principle — push correctness into a shared Rust core

The demo's correctness lives in *logic*, not pixels: build an authorization, sign it offline, encode/decode the QR, verify the signature, check nonce/expiry/cap/balance, move funds atomically, return a receipt. None of that needs a phone.

So all of it goes into one Rust core crate, reused four ways:

```
                         ┌─────────────────┐
                         │    dpay-core     │  types + protocol + crypto
                         │  (pure, tested)  │  Ed25519 sign/verify, nonce,
                         └────────┬─────────┘  expiry, cap, QR codec
              ┌───────────────────┼───────────────────┬───────────────────┐
              ▼                   ▼                   ▼                   ▼
       dpay-canister         dpay-relay          dpay-ffi            dpay-sim
       (ic-cdk, on ICP)   (axum submit svc)   (UniFFI → RN app)   (headless e2e)
```

**The code Claude tests headlessly is byte-for-byte the code that signs on the phone** — the RN app calls `dpay-core` through a UniFFI Turbo Module (`uniffi-bindgen-react-native`), not a reimplementation. "Green in the sim" therefore means the protocol is correct on-device; only the native shell/UX still needs a device check.

This revises the earlier `minimal-poc-plan.md` decision of a **Node** relay: we make the relay **Rust (axum)** so the whole end-to-end path runs in one language, in-process, under `cargo test`. A Node relay can still be kept as a thin alternative later, but it should not be on the agent's iteration path.

---

## 3. Crate layout (cargo workspace)

| Crate | Role | How the agent tests it (offline, seconds) |
|-------|------|-------------------------------------------|
| `dpay-core` | Authorization `{from,to,amount,nonce,expiry}`, canonical serialization (borsh), Ed25519 sign/verify, nonce/expiry/cap logic, QR payload codec. Pure, `no_std`-friendly. | `cargo nextest` unit tests + `proptest` invariants. <1s. |
| `dpay-canister` | `ic-cdk` canister: ledger state (balances, spent-nonce set), calls `dpay-core` to verify + settle atomically, returns receipt. Two accounts pre-funded at init. | **PocketIC** in-process (no daemon, no Docker, deterministic). ~1–3s. |
| `dpay-relay` | `axum` service: receives merchant submission, calls canister via `ic-agent`. Canister access behind a `Ledger` trait. Idempotency, bounded retries+timeout, `/health`, safe-mode. | Trait swapped for a `FakeLedger` or PocketIC in tests. ~1s. |
| `dpay-sim` | Headless end-to-end "demo without glass": plays payer (offline sign) + merchant (submit) → asserts `Paid ✓` + balance deltas + nonce consumed. | One `cargo run -p dpay-sim` / test. ~1s. |
| `dpay-ffi` | UniFFI wrapper exposing `dpay-core` to the RN app (Kotlin/JNI Turbo Module). | Bindings generated in CI/outer loop; logic already covered by core tests. |

---

## 4. The two-tier loop

**Inner loop — where the agent lives (offline, headless, target < ~10s total):**

1. `cargo nextest run` — unit + integration across core, canister (PocketIC), relay (fake/PocketIC), plus the `dpay-sim` e2e.
2. `proptest` money invariants: no double-spend, nonce single-use, spend ≤ cap, spend ≤ balance, **conservation of funds** (sum of balances constant), expiry enforced.
3. Deterministic **time control via PocketIC** to test expiry without waiting.
4. **UI, headlessly:** render the RN screens via `react-native-web`, drive + screenshot with headless `chromium-browser` (Playwright/puppeteer). The QR camera is faked by injecting the payload string, so the agent exercises Request → Approve → Paid ✓ and *reads the resulting screenshots* to analyze layout, states, and copy.

**Outer loop — fidelity gate, occasional, on the user's machine or CI (minutes):**

- `dfx start --pocketic` + `dfx deploy` to exercise the real `ic-agent` path end-to-end.
- Android emulator (with KVM) or a real device + a **Maestro** flow for native rendering and the physical airplane-mode gesture.

The inner loop never depends on the outer loop.

---

## 5. How each verb in the requirement is met — autonomously

- **Analyze UI** → `react-native-web` + headless chromium screenshots; snapshot/visual diff against golden images.
- **Test** → `cargo nextest`, `proptest`, PocketIC integration, `dpay-sim` e2e.
- **Identify / debug** → Rust backtraces + `tracing` logs; PocketIC lets the agent query canister state (balances, spent nonces) mid-test; fixed RNG seeds make failures reproducible on demand; chromium console + trace for UI.
- **Fix** → edit Rust / TS.
- **Verify** → re-run the exact same second-scale suite; golden snapshot assertions; screenshot compare. Green = fixed.

---

## 6. Offline strategy

One-time online **bootstrap**, then air-gapped:

- Pin the Rust toolchain (`rust-toolchain.toml`); `cargo vendor` deps into the repo; `.cargo/config.toml` set to offline.
- Pre-download the **PocketIC server** binary (pinned) and `dfx`.
- `npm ci` from a local cache; use the system `/usr/bin/chromium-browser` (or vendored Playwright chromium).
- A `justfile` exposes `just test`, `just sim`, `just ui`, `just check` — all run with `--offline` / no network. CI can enforce "no sockets" to catch accidental online deps.

---

## 7. Speed budget (targets)

| Stage | Target |
|-------|--------|
| `dpay-core` unit + proptest | < 1 s |
| `dpay-canister` PocketIC suite | 1–3 s |
| `dpay-sim` e2e | ~1 s |
| UI screenshot pass | 3–5 s |
| **Whole inner loop** | **< ~10 s** |

If any inner-loop stage drifts past this, it gets split, parallelized, or demoted to the outer loop.

---

## 8. Bootstrap order

1. Cargo workspace + `dpay-core` (Authorization + sign/verify + QR codec) with tests green in seconds.
2. `dpay-canister` + PocketIC tests: happy path, nonce reuse, expired auth, over-cap, insufficient balance.
3. `dpay-sim` e2e tying payer+merchant+canister together.
4. `dpay-relay` with trait-abstracted ledger + fake, then wired to PocketIC.
5. UI harness (`react-native-web` + chromium screenshots) — only after logic is proven.
6. `dpay-ffi` Turbo Module into the RN app; emulator/device as the outer fidelity gate.

---

## 9. Honest caveats

- **No KVM in the agent sandbox** → Claude cannot run the Android emulator on the inner loop. Device fidelity (native rendering, real camera, the airplane-mode gesture) is verified by the user or CI. Mitigation: the phone's crypto/logic *is* the Rust core the agent tests, so logic correctness transfers; only the native shell needs a device.
- **`react-native-web` ≠ native rendering.** Use it for logic, state, layout, and copy — not pixel-perfect native parity. Pixel parity is an outer-loop concern.
- **Relay language change** from the original Node plan to Rust is deliberate (single-language in-process e2e). Noted so it's a conscious decision, not drift.
