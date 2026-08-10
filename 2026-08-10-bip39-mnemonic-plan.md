# BIP-39 Mnemonic Recovery (D4) — Plan

> **Status:** PLANNED (HIGH effort → split into medium tasks per IMPORTANT 9).
> **Open issue:** OPEN_ISSUES.md D4 — "64-hex recovery seed is hard to transcribe."
> **Non-negotiables:** Non-custodial (the seed never leaves the device). No backward compatibility (pre-pilot; wire mutable).

## Problem

The recovery seed is a 64-character hex string (`SettingsSheet.tsx:107`). Hex is:
- Error-prone to transcribe (no error detection — a single wrong char silently produces a different wallet).
- Unfriendly for paper backup (users skip spaces, confuse 0/O, 1/l).
- Not the consumer-wallet standard (BIP-39 mnemonic is universal — Phantom, MetaMask, Ledger, Trezor).

## Recommended approach: mnemonic as ENCODING (not key-derivation change)

The 32-byte IC Ed25519 seed IS the BIP-39 entropy. The mnemonic is a pure encoding of those bytes:

```
32-byte IC seed ←→ BIP-39 mnemonic (24 words, 256-bit entropy + 8-bit checksum)
```

**No PBKDF2 seed derivation** (that's only needed for BIP-32 Bitcoin wallets — we don't use BIP-32). No key derivation changes at all. The 32 bytes that `DpayCore.generateKeypair()` produces today are identical to the 32 bytes recovered from the mnemonic tomorrow. SOL derivation (`deriveSolip10Ed25519` from the same 32 bytes) is unchanged.

### Why this is clean
- **Single source of truth:** the 32-byte seed. The mnemonic is just a human-readable serialization.
- **Error detection:** BIP-39 appends a SHA-256 checksum — a single wrong word is caught at restore time, not silently producing a wrong wallet.
- **No cryptographic changes:** the Ed25519 key, the SLIP-10 Solana derivation, the wire format — all identical.
- **Standard:** 24-word BIP-39 is the hardware-wallet standard (Ledger, Trezor).

### Why NOT the PBKDF2 approach
The OPEN_ISSUES D4 description suggested "generate a mnemonic at onboarding, derive the IC Ed25519 seed from it." This would mean mnemonic → PBKDF2 → 64-byte seed → first 32 bytes = IC seed. That changes BOTH the IC key and the SOL key (SLIP-10 master changes), bricks every existing wallet, and adds complexity for zero benefit (we don't need BIP-32 Bitcoin derivation).

## Tasks (each MEDIUM effort, independently committable)

### Task A — BIP-39 entropy ↔ mnemonic codec (MED)

**Files:** new `app/lib/bip39.ts` + `app/__tests__/bip39.test.ts`

Pure functions, no React, no network:
- `entropyToMnemonic(bytes: Uint8Array): string[]` — 32 bytes → 24 words. Uses SHA-256 checksum + the 2048-word English wordlist (vendored as a typed array — ~8KB).
- `mnemonicToEntropy(words: string[]): Uint8Array` — reverse. Validates checksum; throws on invalid.
- `validateMnemonic(words: string[]): boolean` — total function (returns false, never throws).
- `generateMnemonic(): string[]` — calls `DpayCore.generateKeypair()` → takes `secretHex` → `entropyToMnemonic`. (Or generates 32 random bytes directly if we want to decouple from the FFI.)

**Wordlist:** vendor the official BIP-39 English wordlist (`english.txt`, 2048 words). ~8KB. Store as `app/lib/bip39-wordlist.ts` (a `string[]` export).

**Tests (jest):**
- Official BIP-39 test vectors (entropy → mnemonic → entropy round-trip).
- Checksum validation (flip one word → invalid).
- Invalid input (wrong word count, non-wordlist words).
- 24 words for 32 bytes.

**Effort:** ~3 hours. No dependencies on other tasks.

### Task B — Onboarding: show mnemonic for backup (MED)

**Files:** `app/components/Onboarding.tsx`

Changes to the `create()` flow:
1. After `DpayCore.generateKeypair()`, compute `mnemonic = entropyToMnemonic(hexToBytes(kp.secretHex))`.
2. Show a new "Backup your wallet" screen with the 24 words (numbered, grouped 4×6 or 6×4).
3. Require the user to write down the words (a checkbox "I've written down my recovery phrase" before proceeding — standard UX).
4. Store `mnemonic` alongside `secretHex` in the `Identity` type (or derive on-the-fly from `secretHex` — simpler, no storage change).

**Design constraints:**
- The words are the SAME secret as the hex — display them with the same care (no screenshots, warn about digital storage).
- `secretHex` stays the canonical storage format in AsyncStorage (the mnemonic is derived on demand). This avoids a storage migration.

**Effort:** ~3 hours. Depends on Task A.

### Task C — Restore: accept mnemonic (MED)

**Files:** `app/components/Onboarding.tsx` (restore path)

Changes to the `restore()` flow:
1. Replace the hex input with a mnemonic word input (24 text fields or a single textarea that splits on whitespace).
2. `validateMnemonic(words)` → if invalid, show "Some words are wrong or out of order" (checksum catches typos).
3. If valid: `mnemonicToEntropy(words)` → hex → `DpayCore.keypairFromSecret(hex)` → same as today.
4. Keep a "Enter hex instead" toggle in the Advanced disclosure for power users / debugging.

**Effort:** ~2 hours. Depends on Task A.

### Task D — Backup screen: show mnemonic (MED)

**Files:** `app/components/SettingsSheet.tsx`

Changes to the backup display:
1. Replace the hex display with the mnemonic words (numbered, grouped).
2. Copy button copies the mnemonic (space-separated words).
3. Keep hex in an "Advanced" disclosure (for debugging / FFI testing).

**Effort:** ~1 hour. Depends on Task A.

### Task E — E2e + jest updates (MED)

**Files:** e2e flows that onboard/restore + jest tests for Onboarding

1. Update `e2e/harness/lib.mjs` `onboardWallet()` — if onboarding now shows a mnemonic screen, the helper must dismiss it.
2. Update flow 57 (`settings-seed-backup`) — assert mnemonic words are shown.
3. Update flow 58 (`restore-wallet`) — enter mnemonic words instead of hex.
4. New flow: mnemonic backup → restore cycle (write down → restore → assert same address).

**Effort:** ~2 hours. Depends on Tasks B+C+D.

## Total: ~5 medium tasks, ~11 hours. Each independently committable.

## What does NOT change
- Key derivation (Ed25519 seed, SLIP-10 SOL path) — byte-identical.
- Wire format, canister, relay, FFI — untouched.
- AsyncStorage storage format (`secretHex` stays canonical).
- `DpayCore.keypairFromSecret(hex)` — still takes 64-hex, still produces the same key.

## Risks
- **Wordlist size:** 2048 words (~8KB) added to the bundle. Acceptable (the app is already 94MB APK).
- **User confusion:** 24 words is a lot. Mitigate with grouping (4×6 grid), numbering, and a clear "write these down in order" instruction. 12-word alternative (128-bit entropy) would require generating 16 bytes + PBKDF2 stretching to 32 bytes — more complex, changes keys. Not recommended.
- **Concurrent session:** The concurrent review-sweep session has uncommitted changes in `Onboarding.tsx`. Task B must rebase on top of those changes.

## Decision needed
None — this plan follows the project's non-custodial + KISS + no-backward-compat rules. The entropy-as-encoding approach is the simplest correct solution.

## Execution order
A (codec) → B+C+D (UI, parallelizable) → E (e2e/jest). Commit each task.
