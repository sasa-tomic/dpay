# dpay — React Native app

Non-custodial offline-payment Android app settling on the Internet Computer (IC).
The shared Rust core (`dpay-core` + `dpay-ffi`) is consumed via UniFFI; the RN
layer is a thin presentational + orchestration shell.

**Entry docs:** `../CLAUDE.md` (project memory + non-negotiables),
`../AGENTS.md` (repo working guide), `../OPEN_ISSUES.md` (known blockers),
`../CODEBASE_ANALYSIS.md` (architecture health + risks), `../FLOWS.md` (e2e flow catalog).

## Structure

```
App.tsx              root — identity + relay load, self-check, route Onboarding | Wallet
config/              palette, constants (POLL, currency catalog, timeouts), catalog helpers
lib/                 types + pure format/amount helpers (BigInt exact parser), clipboard + deep-link utilities
hooks/               useHotkeys, useEscapeToClose (the only TRUE hooks — others moved to lib/)
services/            NativeModules destructure, relay/withdraw/receipt fetch clients (+ payAndClassify, readJsonOrEmpty)
styles.ts            ONE StyleSheet.create block (do NOT partition — e2e matches testID + text)
components/          all presentational components (Wallet container, sheets, NfcTap, QrScanner…)
payments.ts          pure settlement-outcome logic + receipt↔request nonce-match helper
wallet.ts            EIP-1193 onramp provider resolution
cketh.ts             byte-exact ckERC20 calldata builder
walletconnect.ts     the ONLY file that statically imports @walletconnect/* (lazy-loaded)
```

## Dev loop

The inner loop is fully offline via `just` (from the repo root) and runs in seconds:

```
just verify      # core + canister + relay + typecheck + bridge-parity + e2e (37 flows)
just e2e         # the 37-flow browser harness driving the REAL app via react-native-web
just typecheck   # tsc --noEmit
just app         # rebuild APK + launch on emulator (outer-loop device gate)
just ondevice    # 8 instrumented tests on the emulator
```

See `../CLAUDE.md` for the full toolchain + non-negotiables (non-custodial, no-swap,
offline inner loop, frozen wire format).
