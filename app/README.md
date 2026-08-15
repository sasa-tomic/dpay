# dpay — React Native app

Non-custodial Android wallet for instant payments that work offline. Settles
on the Internet Computer (chain-key assets) and directly on Solana (native
device-key rail). The shared Rust core (`dpay-core` + `dpay-ffi`) is consumed
via UniFFI; the RN layer is a thin presentational + orchestration shell.

**Entry docs:** `../CLAUDE.md` (project memory + non-negotiables),
`../AGENTS.md` (repo working guide), `../OPEN_ISSUES.md` (known blockers),
`../CODEBASE_ANALYSIS.md` (architecture health + risks), `../FLOWS.md` (e2e flow catalog).

## Structure

```
App.tsx              root — identity + relay load, self-check, route Onboarding | Wallet
relayConfig.ts       relay url resolution (imported ONLY by App.tsx — the ?relay= e2e override anchor)
config/              palette; constants (POLL, receipt pin, RPC urls); catalog + asset selection
lib/                 pure helpers: types, format/amount (BigInt exact), assetBalances, bip39
                     (mnemonic), deepLink, clipboard, timeouts, base64(+url)
hooks/               useHotkeys, useCatalog, useBalancePoll, useSolanaBalances, useNfcTapState,
                     useTransactionHistory, useCopyFeedback, useReportLock
services/            the single NativeModules.DpayCore/DpayNfc destructure; relay/withdraw/receipt
                     fetch clients; solMerchantPersist, ckerc20Persist
solana/              the native SOL rail: tx (canonical messages + verify), spl, rpc, qr, identity,
                     payments, errors, selfcheck, constants
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
just verify      # core + canister + relay + typecheck + bridge-parity + aid-parity + e2e
just e2e         # the browser harness driving the REAL app via react-native-web (75 flows)
just typecheck   # tsc --noEmit --noUnusedLocals --noUnusedParameters
just app         # rebuild APK + launch on emulator (outer-loop device gate)
just ondevice    # 11 instrumented tests on the emulator
```

See `../CLAUDE.md` for the full toolchain + non-negotiables (non-custodial, no-swap,
offline inner loop, frozen wire format).
