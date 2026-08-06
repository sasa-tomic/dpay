# 2026-08-06 — SOL native device-key MVP session report

> Hand-off brief for the next session. The SOL MVP (online SOL in/out) is **SHIPPED + green on all
> inner-loop gates**. This report records exactly what shipped, what is deliberately NOT-yet-done
> (follow-ups), and the verified gate state. Read alongside `OPEN_ISSUES.md` (part-4 summary + the
> "SOL MVP — follow-ups" subsection) and `CODEBASE_ANALYSIS.md` (the "Native device-key SOL rail"
> section).

## 1. TL;DR

Native SOL now moves in and out of the wallet via a **device-held Solana key** — no IC canister, no
relay, no facade, no wire change. Fully app-scoped. All inner-loop gates green:

- `just e2e` **46/46** (added flow 45) in ~81s
- jest **295/295** across 18 suites (added 4 solana suites: identity/tx/rpc/seam)
- `just typecheck` clean (tsc --noEmit exit 0)
- Wire FROZEN (292/196/132) — zero wire/relay/facade/canister/core change

Commits `0fafae7` → `fffc0c0` (7 commits). No new native dependency (hand-rolled with
`@noble/curves` + `@noble/hashes` + `bs58`, all already transitive in `app/node_modules`).

The 3 founder forks resolved as recommended: standard `m/44'/501'/0'/0'` (Phantom-compatible);
config-driven RPC URL defaulting to public devnet (no key needed); scope = online in/out
(native SOL only; offline durable-nonce rail = follow-on).

## 2. What shipped (by unit, with commits)

| Commit | Unit | Files |
|--------|------|-------|
| `0fafae7` | SLIP-10 ed25519 key derivation + legacy System.transfer tx builder | `app/solana/identity.ts`, `app/solana/tx.ts`, + 2 jest tests |
| `26c84a7` | minimal Solana JSON-RPC client (getBalance/blockhash/sendTransaction/confirm) | `app/solana/rpc.ts`, `app/__tests__/solana-rpc.test.ts` |
| `1b418a0` | isolation-boundary seam + config `SOLANA_RPC_URL` (offline-loop-safe) | `app/solana.ts`, `app/config/constants.ts`, `app/jest.setup.js`, `e2e/harness/driver.mjs`, `app/__tests__/solana-seam.test.ts` |
| `544c7c7` | native SOL receive/send UI + balance hook | `app/hooks/useSolanaBalance.ts`, `app/components/{SolanaReceiveSheet,SolanaWithdrawSheet}.tsx`, `app/components/{BalancesSheet,Wallet}.tsx`, `app/solana/identity.ts` (+isValidSolanaAddress), `app/__tests__/solana-identity.test.ts`, `app/config/constants.ts`, `e2e/tests/40-visual-regression.mjs`, `e2e/shots/baselines/balances.png` |
| `0b377c9` | device-gate SOL self-check (`DPAY_SOL_SELFCHECK`) | `app/App.tsx`, `scripts/rn-run.sh` |
| `329b4d5` | e2e flow 45 (SOL card + receive QR) + FLOWS.md regen | `e2e/tests/45-sol-receive.mjs`, `FLOWS.md` |
| `fffc0c0` | docs | `OPEN_ISSUES.md`, `CODEBASE_ANALYSIS.md`, `CLAUDE.md` |

### Architecture (as shipped)

```
app/solana/identity.ts   (PURE, static-imported)  SLIP-10 ed25519 m/44'/501'/0'/0'
app/solana/tx.ts         (PURE, static-imported)  legacy System.transfer build+sign
app/solana/rpc.ts        (NETWORK, dynamic-imported) JSON-RPC over fetch, bounded timeouts
app/solana.ts            (SEAM)                    pure fns static; rpc dynamic-imported
app/hooks/useSolanaBalance.ts                     polls getSolanaBalance, empty-RPC no-op
app/components/SolanaReceiveSheet.tsx             address QR (mirrors DepositSheet)
app/components/SolanaWithdrawSheet.tsx            send (signs LOCALLY + broadcasts, no relay)
app/components/BalancesSheet.tsx                  SOL card SEPARATE from catalog loop
app/components/Wallet.tsx                         derives solAddress via useMemo, threads through
```

**Offline-loop safety (the key invariant):** `SOLANA_RPC_URL = __DPAY_TEST_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com'`.
Both `jest.setup.js` and `e2e/harness/driver.mjs` set the override `''` → the SOL balance hook
no-ops, the card renders with `—`, and jest + e2e **never hit devnet**. This is the exact WC-disable
pattern (`__DPAY_TEST_WALLETCONNECT_PROJECT_ID`).

**Proven correctness:** SLIP-10 derivation matches the SLIP-10 spec ed25519 vector 1 + is
Python-stdlib-cross-checked on the real seed. The tx builder is byte-exact vs `@solana/web3.js`
v1.98.4 (message + signature + full wire all match golden). The RPC client is JSON-RPC-shape-tested
with a mocked fetch.

## 3. Verified gate state (end of session)

- `just e2e` **46/46 GREEN** (~81s). New flow: `45-sol-receive` (deposit journey).
- jest **295/295** (18 suites). New: solana-identity (14), solana-tx (6), solana-rpc (7), solana-seam (3).
- `just typecheck` clean.
- git: on `main`, working tree clean after `fffc0c0`. 7 SOL commits this session.
- **NOT run this session (outer-loop):** `just app` (device gate — needs the API-36 emulator),
  `just ondevice`, `just verify` (full — includes Rust slices untouched by this work).

## 4. SOL MVP — follow-ups (partially-implemented / outer-loop / fragile)

> Ordered by risk. Full detail in `OPEN_ISSUES.md` "SOL MVP — follow-ups".

1. **🔴 Transitive deps not declared (FRAGILE — do first).** `@noble/curves`, `@noble/hashes`,
   `bs58` are used by the rail but **NOT in `app/package.json`** (transitive only). A dep upgrade
   that dedupes/drops any silently breaks SOL + the self-check. **Fix:** declare all three explicitly
   (pin to resolved versions), `npm install --offline`, confirm jest + `just app` green. No code change.
2. **🟠 Device gate not yet run (`just app`).** `DPAY_SOL_SELFCHECK` code is in place but never
   executed on the emulator. Proves noble/bs58 bundle under Hermes. Assert BOTH
   `DPAY_SELFCHECK PASS` and `DPAY_SOL_SELFCHECK PASS` in logcat.
3. **🟠 Real devnet round-trip from the APP never proven.** tx.ts is byte-exact in jest; the PoC
   proved the round-trip with `@solana/web3.js`, **not** the hand-rolled `rpc.ts`. `sendSol` has
   never broadcast a real tx. Prove: set `SOLANA_RPC_URL`=devnet, fund the derived address from the
   PoC key (`GhcChfSJAtmamScaRnQ9nwAJgbW65bJtWdHkxDYbCr8T`, ~4.93 SOL in `.dev/sol-poc/keys.json`),
   send 0.001 SOL.
4. **🟡 Offline-pay durable-nonce rail (+5-7 days).** PoC on-chain-proven; not in the app. Adds
   `app/solana/nonce.ts` + the `solpay:` offline-sign QR flow + merchant broadcast + receipt-nonce
   hand-back. One offline payment per nonce-sync.
5. **🟡 Mainnet RPC config (operator step).** Edit `config/constants.ts` to a Helius/QuickNode
   URL+key. No code change.
6. **🟢 e2e SOL send flow (deferred).** Needs a funded balance (incompatible with offline e2e).
   Defer to the devnet/device path (item 3).

## 5. Commit index (this session)

```
0fafae7 feat(sol): SLIP-10 ed25519 key derivation + legacy System.transfer tx builder
26c84a7 feat(sol): minimal Solana JSON-RPC client (getBalance/blockhash/sendTransaction/confirm)
1b418a0 feat(sol): isolation-boundary seam + config SOLANA_RPC_URL (offline-loop-safe)
544c7c7 feat(sol): native SOL receive/send UI + balance hook
0b377c9 feat(sol): device-gate SOL self-check (DPAY_SOL_SELFCHECK)
329b4d5 test(e2e): flow 45 — SOL native card + receive address QR
fffc0c0 docs: SOL native device-key MVP shipped (OPEN_ISSUES/CODEBASE_ANALYSIS/CLAUDE)
```
