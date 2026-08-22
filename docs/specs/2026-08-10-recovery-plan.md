# Recovery UX fix — plan (2026-08-10)

Make wallet **Restore** prominent in Onboarding (equal visual weight with Create, not a muted
afterthought) and add a **Restore wallet** option to SettingsSheet (so a user can import a wallet
post-creation without resetting/wiping first).

This is the planning document. No source is changed by this file; the implementation follows the
order in §7.

---

## 1. Analysis

### 1.1 Current state (verified by reading the code)

**Onboarding (`app/components/Onboarding.tsx`, 123L)** already has a working restore flow:
- `mode: 'create' | 'restore'` state (line 18); `restore()` (lines 46–58) validates the seed with
  `/^[0-9a-f]{64}$/`, calls `DpayCore.keypairFromSecret(s)`, writes the identity to AsyncStorage, and
  calls `onCreated(id)` — no faucet (a restored wallet has its on-chain funds).
- In **create mode**, the Restore entry is the LAST element (lines 113–116): a `Pressable` styled
  `S.linkBtn` containing `<Text style={S.linkTextMuted}>Restore wallet</Text>` — a muted bottom link,
  visually subordinate to the Privacy-style links, not equal-weight with Create. testID `btn-restore`.
- In **restore mode** the seed form (lines 86–101) uses testIDs `restore-seed-input`, `btn-restore-confirm`,
  `btn-restore-cancel`, and reuses `username-input`.

**SettingsSheet (`app/components/SettingsSheet.tsx`, 228L)** has Reset (lines 77–94) and Backup
(lines 99–162) but **no Restore**. Backup is the parallel idiom to follow: an entry button
(`btn-backup`, `S.backupEntryBtn` — brand-tinted bordered) → a two-step confirm gate
(`btn-backup-confirm` → revealed `seed-phrase` + `btn-copy-seed` + `btn-backup-hide`/`btn-backup-cancel`).
Reset uses `btn-reset` (`S.resetEntryBtn` — red-tinted bordered) → confirm dialog
(`btn-reset-confirm` / `btn-reset-cancel` inside `S.resetConfirmBox`). The sheet accepts
`{relayUrl, setRelayUrl, onClose, onReset, secretHex}`.

**App.tsx (`app/App.tsx`, 112L)** owns the identity lifecycle:
- `onReset` (line 101): `await AsyncStorage.removeItem(STORAGE_KEY); setIdentity(null)`.
- Identity loaded from AsyncStorage on mount (lines 41–55); `STORAGE_KEY = 'dpay.identity.v1'`.
- There is **no** `onRestore` / identity-replace callback today.

**Wallet.tsx (`app/components/Wallet.tsx`, 454L)** mounts `SettingsSheet` at lines 443–451, passing
`onReset`, `secretHex={identity.secretHex}`, etc.

**Identity model (`app/lib/types.ts:64`):** `Identity = {secretHex; publicHex; username}`. Seed =
64-hex (32 bytes). `DpayCore.keypairFromSecret(secretHex)` (FFI + web shim at `e2e/web/dpay-core.ts:310`)
derives the keypair; the web shim uses `hexToBytes` (throws on odd length). Onboarding's regex is the
sole validation today.

**Styles (`app/styles.ts`, one `StyleSheet.create` block — must NOT be partitioned):**
- `primary` (line 98): filled brand, 56pt, shadow — Create + Restore-confirm.
- `secondaryBtn` (line 144): bordered neutral, 56pt, `C.field` bg, `C.line2` border — **already used
  by PayMode/SolPayMode Cancel**. The correct existing style for a prominent-but-secondary Restore button.
- `linkBtn`/`linkTextMuted` (lines 134/136): the current muted Restore link — what we're moving away from.
- `backupEntryBtn`/`backupEntryText` (216/217): brand-tinted bordered entry — the Backup button chrome.
- `resetEntryBtn`/`resetEntryText` (208/209): red-tinted bordered entry — the Reset button chrome.
- `backupConfirmBox` (218): neutral field-tinted box for the Backup confirm/reveal body.
- `seedInput` (33): monospace multiline 64-hex input — already exists (Onboarding restore uses it).

### 1.2 E2e surface (verified)

The harness matches **testID + textContent**. Relevant flows:
- **Flow 58 `restore-wallet`** — drives Onboarding restore: `btn-restore` → `restore-seed-input` +
  `username-input` → `btn-restore-confirm` → asserts `balance` mounts + `identity.secretHex` equals the
  entered seed. **testIDs must stay stable** (we only restyle the entry button, not rename it).
- **Flow 40 `visual-regression`** — pixel-diffs 5 surfaces incl. **`settings`** (baseline at
  `e2e/shots/baselines/settings.png`). Adding a Restore section to SettingsSheet WILL drift this
  baseline → must re-seed + commit (the documented Backup-feature precedent: "settings.png re-seeded
  31.9% drift → 0%"). Onboarding is **not** baseline-diffed (flow 35 tours but flow 40 captures only
  post-onboarding surfaces), so the Onboarding redesign has **no** baseline impact.
- **Flow 41 `a11y-census`** — the `settings` surface census array is
  `['btn-settings-close', 'settings-relay', 'btn-relay-apply', 'btn-reset', 'privacy-policy']` (line 59).
  **Pre-existing gap:** `btn-backup` is NOT in this list (missed when Backup shipped). New interactive
  controls added to Settings are not auto-censused; we should add them.
- **Flow 12 `settings`** — relay edit + reset round-trip. Unaffected by a new Restore section.
- **Flow 57 `settings-seed-backup`** — Backup reveal/copy. Unaffected.
- **Flow 01/23/37** — onboarding create paths. The Onboarding restyle doesn't change `btn-create` /
  `username-input`, so these are unaffected.

**Next free flow number: 63** (flows 00–62 exist).

### 1.3 Constraints (from AGENTS.md / CLAUDE.md)

- `styles.ts` is ONE `StyleSheet.create` block — reuse existing keys, add new ones only if needed.
- Relative imports only (no `@/`).
- E2e harness matches testID + textContent — renaming a testID breaks flows.
- Non-custodial: Restore is pure local key-derivation (no relay, no canister) — already the case in
  Onboarding; the new Settings path reuses the same `keypairFromSecret`.
- **Device-gate trigger checklist:** this change does NOT touch `app/android/**`, `crates/dpay-ffi/**`,
  wire consts, NFC AIDs, `react-native.config.js`, `app/index.js`, or introduce a new Web API dep.
  `keypairFromSecret` already shipped on the bridge (2026-08-09, device-gate-proven then) and is reused
  as-is. **→ `just app` / `just ondevice` are NOT triggered by this change.** Inner loop stays `just verify`.

---

## 2. Architecture decision

### 2.1 Onboarding: promote the Restore entry button (keep the expandable model)

**Decision:** Keep the existing `mode: 'create' | 'restore'` expandable interaction and ALL existing
testIDs (`btn-restore`, `restore-seed-input`, `btn-restore-confirm`, `btn-restore-cancel`,
`username-input`). Only **restyle + reposition** the Restore entry:
- Change the `btn-restore` `Pressable` from `S.linkBtn` → **`S.secondaryBtn`** (bordered, full-width,
  56pt — same height/width as the Create primary).
- Change its text from `S.linkTextMuted` → **`S.secondaryBtnText`**.
- **Reorder** so `btn-restore` sits **immediately after `btn-create`**, forming a primary/secondary
  button pair, with the Create-specific helper notes (`S.dim2` + `S.dpayGlyphNote`) moved BELOW the pair.

**Rationale (why not a Create|Restore tab toggle):**
- A returning user sees Restore at true parity with Create (same 56pt, same width, bordered) — "equal
  visual weight" as required — while a new user still lands on Create as the obvious primary (filled
  brand). Correct hierarchy without hiding Create behind a tab.
- **Zero e2e churn** for flow 58 (testIDs unchanged) and no new style keys (`secondaryBtn` already
  exists for PayMode/SolPayMode Cancel).
- Minimal diff (~6 lines moved/restyled in Onboarding), low risk.

### 2.2 SettingsSheet: new Restore section mirroring Backup (inline, not shared component)

**Decision:** Add a "Restore" section to SettingsSheet, placed **immediately after Backup** (grouping
the wallet-key operations together: Backup → Restore → Reset), before About. Flow:
1. Entry button `btn-settings-restore` styled `S.secondaryBtn` (neutral bordered — reads as "import",
   not destructive-red like Reset, not brand-green like Backup). Mirrors the Backup/Reset entry shape.
2. Tapping it expands an inline form (inside a `S.backupConfirmBox`-style neutral box) containing:
   - A warning banner (`S.warnNote`): "This replaces your current wallet with the one recovered from
     this seed. Back up your current wallet first if you haven't — its funds are only reachable via its
     own seed."
   - The seed input: `settings-restore-seed-input` styled `S.seedInput` (the existing 64-hex monospace
     input). Placeholder "64 hex characters".
   - `btn-settings-restore-confirm` styled `S.primary` (gated disabled while seed empty/invalid or busy).
   - `btn-settings-restore-cancel` styled `S.linkBtn`/`S.linkTextMuted` (collapses the form).
3. On confirm: validate the seed (regex + non-empty) → `DpayCore.keypairFromSecret(seed)` → build
   `Identity = {secretHex, publicHex, username: <current username>}` → call `onRestore(id)`.

**Username handling:** the restored identity **keeps the current `identity.username`** (the seed
recovers keys, not local display metadata). The user is already in a wallet, so a username exists;
preserving it is least-surprising. (If the founder prefers a username field, it's a small addition —
pre-filled with the current name. Noted as an open option in §8.)

**Why inline in SettingsSheet, not a shared `RestoreForm` component:** the two restore contexts differ
(Onboarding: username field + faucet-skip + onCreated; Settings: warning banner + username-preserve +
replace semantics + onRestore). A shared component would need props for all of these, negating the DRY
benefit. The only true duplication is ~10 lines (TextInput + regex). **YAGNI** — keep it inline.

### 2.3 Small DRY helper: `validateSeed` in `app/lib/format.ts`

Extract the seed validation (currently inline in Onboarding.restore, lines 47–49) into a tiny pure
helper next to `hexToBytes`:

```ts
// Validate a 64-hex recovery seed. Returns null if valid, else an error message.
export function validateSeed(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) return 'Recovery seed must be 64 hex characters (0-9, a-f).';
  return null;
}
```

Used by both Onboarding.restore and the new SettingsSheet restore. Low-risk, high-clarity. (Optional —
the plan is implementable without it, but recommended.)

### 2.4 `onRestore` callback wiring

- **`App.tsx`** — add `onRestore` alongside `onReset`:
  ```ts
  const onRestore = useCallback(async (id: Identity) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
    setIdentity(id);
  }, []);
  ```
  Pass `onRestore={onRestore}` to `<Wallet>`. App.tsx remains the sole owner of AsyncStorage writes
  (onReset removes; onRestore writes — symmetric).
- **`Wallet.tsx`** — accept `onRestore: (id: Identity) => Promise<void>` in props; forward to
  `<SettingsSheet onRestore={onRestore} ... />`.
- **`SettingsSheet.tsx`** — accept `onRestore: (id: Identity) => Promise<void>`; do the
  `DpayCore.keypairFromSecret` call + Identity build inline (mirrors Onboarding.restore doing the FFI
  call inline), then hand the built Identity to `onRestore`. SettingsSheet imports `DpayCore` (from
  `../services/native`), `Identity` type (from `../lib/types`), and `validateSeed` (from `../lib/format`).

**Why SettingsSheet does the FFI call (not App.tsx):** consistency with Onboarding (which does
`generateKeypair`/`keypairFromSecret` inline and owns its busy/error state), and the form's busy/error
feedback stays co-located with the input. App.tsx stays a thin persistence owner.

---

## 3. File-by-file changes

### 3.1 `app/lib/format.ts` (Simple, optional)
- Add `validateSeed(s: string): string | null` as in §2.3.

### 3.2 `app/components/Onboarding.tsx` (Simple)
- `restore()` (line 47): replace inline regex with `const e = validateSeed(s); if (e) { setErr(e); return; }`.
- In create-mode JSX (lines 102–117): restyle the `btn-restore` `Pressable`:
  - `style={S.linkBtn}` → `style={S.secondaryBtn}`
  - `<Text style={S.linkTextMuted}>` → `<Text style={S.secondaryBtnText}>`
  - Keep testID `btn-restore`, `accessibilityRole="button"`, `accessibilityLabel="Restore wallet"`, etc.
- **Reorder:** move the `btn-restore` block to sit immediately after `btn-create` (before the `S.dim2`
  + `S.dpayGlyphNote` helper lines). The helper notes are Create-specific context and read fine below
  the Create/Restore pair.
- No change to restore-mode JSX (the seed form) — testIDs `restore-seed-input`, `btn-restore-confirm`,
  `btn-restore-cancel` stay.

### 3.3 `app/App.tsx` (Simple)
- Add `onRestore` `useCallback` (§2.4).
- Pass `onRestore={onRestore}` to `<Wallet>` (line 111).

### 3.4 `app/components/Wallet.tsx` (Simple)
- Add `onRestore: (id: Identity) => Promise<void>` to the props destructure (line 33).
- Forward `onRestore={onRestore}` to `<SettingsSheet>` (line 444).

### 3.5 `app/components/SettingsSheet.tsx` (Medium — the bulk of the change)
- Props: add `onRestore: (id: Identity) => Promise<void>` to the destructure (line 31). `Identity` is
  already imported indirectly; add `import type {Identity} from '../lib/types'` if not present (it's
  not currently imported — SettingsSheet only takes `secretHex: string`).
- Imports: add `DpayCore` from `../services/native`; `validateSeed` from `../lib/format`; `Identity` type.
- State: add `confirmRestore` (bool — form expanded?), `restoreSeed` (string), `restoreBusy` (bool),
  `restoreErr` (string | null). Mirror the `confirmBackup`/`backupRevealed` pattern (lines 47–48).
- Add a `doRestore` async fn: validate → `DpayCore.keypairFromSecret` → build `Identity` (username =
  current identity's — **note: SettingsSheet doesn't currently receive the username, only `secretHex`**.
  Two options: (a) pass `username` as a new prop from Wallet (`identity.username`), or (b) read it from
  the restored identity's perspective — but we don't have it. **Add `username: string` prop** to
  SettingsSheet (forwarded from `identity.username` in Wallet.tsx). Minimal.) → call `onRestore(id)` →
  on success the Wallet re-mounts under the new identity (App.tsx setIdentity); on error set `restoreErr`.
- JSX: insert a new `<View style={S.settingsSection}>` **after the Backup section (line 162) and before
  About (line 164)**:
  - `<Text style={S.inputLabel}>Restore</Text>`
  - `confirmRestore` false → entry button `btn-settings-restore` (`S.secondaryBtn`):
    `<Text style={S.secondaryBtnText}>Restore wallet…</Text>` (ellipsis signals "opens a form").
  - `confirmRestore` true → `<View style={S.backupConfirmBox}>` (reuse the neutral confirm box):
    - `<Text style={S.warnNote}>` warning (§2.2).
    - `<TextInput testID="settings-restore-seed-input" style={S.seedInput} ... />` (multiline, monospace,
      autoCapitalize none, autoCorrect false, placeholder "64 hex characters").
    - `restoreErr ? <Text style={S.err}>{restoreErr}</Text> : null`
    - `btn-settings-restore-confirm` (`S.primary`, disabled while `restoreBusy || invalid`):
      `<Text style={S.primaryText}>{restoreBusy ? 'Restoring…' : 'Restore wallet'}</Text>`
    - `btn-settings-restore-cancel` (`S.linkBtn`/`S.linkTextMuted`): "Cancel" → resets form state.
- All new testIDs namespaced `btn-settings-restore*` / `settings-restore-seed-input` — **no collision**
  with Onboarding's `btn-restore`/`restore-seed-input` (the two surfaces are never mounted simultaneously:
  Onboarding renders when `identity === null`, SettingsSheet when the wallet is open).

### 3.6 No `styles.ts` change required
All needed styles exist: `secondaryBtn`/`secondaryBtnText` (Onboarding Restore entry + Settings Restore
entry), `primary`/`primaryText` (confirm buttons), `backupConfirmBox` (Settings restore form body),
`warnNote` (warning), `seedInput` (seed field), `err` (error text), `inputLabel` (section header),
`linkBtn`/`linkTextMuted` (cancel). The single-block constraint is respected by reuse, not partition.

---

## 4. New testIDs (canonical list)

| testID | Where | Purpose |
|---|---|---|
| `btn-settings-restore` | SettingsSheet (entry) | Open the restore form |
| `settings-restore-seed-input` | SettingsSheet (form) | 64-hex seed input |
| `btn-settings-restore-confirm` | SettingsSheet (form) | Confirm → replace identity |
| `btn-settings-restore-cancel` | SettingsSheet (form) | Collapse the restore form |

Onboarding testIDs (`btn-restore`, `restore-seed-input`, `btn-restore-confirm`, `btn-restore-cancel`)
are **unchanged** — only the entry button's style + position change.

---

## 5. E2e changes

### 5.1 New flow: `e2e/tests/63-settings-restore.mjs` (system journey)
Proves the new surface end-to-end against the real app + FakeLedger relay:
1. `onboardWallet(driver, 'alice')` → read `identity.secretHex` (A) + `publicHex` (A) via `accountOf`.
2. Open Settings → tap `btn-settings-restore` → `settings-restore-seed-input` is visible.
3. **Same-seed restore:** type A's `secretHex` → `btn-settings-restore-confirm` → wallet re-mounts.
   Assert the new `identity.secretHex` == A's secretHex AND `publicHex` == A's publicHex (proves
   `keypairFromSecret` ran and identity was *replaced*, not wiped). Username preserved ('alice').
4. **Different-seed restore:** open Settings again → `btn-settings-restore` → type the fixed
   `'22'.repeat(32)` seed (same as flow 58) → confirm → wallet re-mounts with the new key. Assert
   `identity.secretHex == '22'.repeat(32)` AND `publicHex` is a non-empty 64-hex AND username still
   'alice' (preserved across restore).
5. `screenshot('63-settings-restore')`.

`meta`: `id: '63', name: 'settings-restore', journey: 'system', covers: ['restore-seed', 'settings-restore', 'identity-replace', 'keypair-from-secret'], verifies: 'Settings → Restore replaces the wallet identity from a 64-hex seed (no wipe); username preserved.', timeoutMs: 20_000`.

### 5.2 `e2e/tests/41-a11y-census.mjs` (update — fix pre-existing gap + add new controls)
- Add `'btn-backup'` to the `settings` array (line 59) — **pre-existing gap** (Backup shipped without
  census coverage; `btn-backup` is always-visible at first Settings open).
- Add `'btn-settings-restore'` to the `settings` array.
- Add a new surface `settingsRestoreConfirm: ['settings-restore-seed-input', 'btn-settings-restore-confirm', 'btn-settings-restore-cancel']` (mirror `settingsResetConfirm` at line 61).
- Add a census step after the Reset-confirm census (around line 169): cancel out of reset → tap
  `btn-settings-restore` → `census('settingsRestoreConfirm')` → tap `btn-settings-restore-cancel`.

### 5.3 `e2e/tests/40-visual-regression.mjs` (baseline re-seed, no code change)
- The `settings` surface WILL drift (new Restore section). Run
  `DPAY_E2E_REGEN_BASELINES=1 just e2e-visual` (or full `just e2e` with the env var) to re-seed
  `e2e/shots/baselines/settings.png`, then **commit the new baseline**. Documented precedent: the
  Backup feature re-seeded this exact file (31.9% → 0%).
- Onboarding has **no** baseline-diffed surface — the Onboarding redesign needs no baseline work.

### 5.4 `FLOWS.md` (auto-regenerate)
- After adding flow 63, run `node e2e/gen-flows-md.mjs` (or the `just` target) to regenerate FLOWS.md
  with the new row + the bumped flow count (62 → 63) + journey tally.

### 5.5 Flows that need NO change
- **58 (restore-wallet)** — Onboarding testIDs unchanged; only the entry button's *style* changed (the
  harness matches testID, not style). Stays GREEN.
- **01 / 23 / 37 (onboard paths)** — `btn-create` / `username-input` untouched. GREEN.
- **12 (settings)** — Reset path untouched; the new Restore section sits alongside without interfering. GREEN.
- **57 (settings-seed-backup)** — Backup path untouched. GREEN.

---

## 6. Visual baseline impact

| Baseline | Impact | Action |
|---|---|---|
| `e2e/shots/baselines/settings.png` | **Drifts** (new Restore section changes layout) | Re-seed + commit (`DPAY_E2E_REGEN_BASELINES=1`) |
| `wallet-pay.png`, `receive-request.png`, `balances.png`, `ledger.png` | None | — |
| (Onboarding has no baseline) | None | — |

---

## 7. Implementation order

1. **`app/lib/format.ts`** — add `validateSeed` (optional DRY helper).
2. **`app/App.tsx`** — add `onRestore` callback; pass to `<Wallet>`.
3. **`app/components/Wallet.tsx`** — accept + forward `onRestore`; also forward `username` to SettingsSheet.
4. **`app/components/SettingsSheet.tsx`** — add `onRestore` + `username` props; add Restore section
   (entry + expandable form); wire `doRestore` (validate → `keypairFromSecret` → build Identity →
   `onRestore`).
5. **`app/components/Onboarding.tsx`** — restyle `btn-restore` (`linkBtn`→`secondaryBtn`,
   `linkTextMuted`→`secondaryBtnText`); reorder to sit right after `btn-create`; use `validateSeed`.
6. **`just typecheck`** — must pass (stricter: `--noUnusedLocals --noUnusedParameters`).
7. **`e2e/tests/63-settings-restore.mjs`** — new flow.
8. **`e2e/tests/41-a11y-census.mjs`** — add `btn-backup` + `btn-settings-restore` to `settings`;
   add `settingsRestoreConfirm` surface + census step.
9. **`DPAY_E2E_REGEN_BASELINES=1 just e2e`** — green run that re-seeds `settings.png`; commit the baseline.
10. **`node e2e/gen-flows-md.mjs`** — regenerate FLOWS.md; commit.
11. **`just verify`** — full green (core + canister + relay + typecheck + bridge-parity + aid-parity + e2e).
    (No `just app` / `just ondevice` required — no bridge/AID/native-dep change; see §1.3.)

---

## 8. Risks & open options

1. **Keyboard/scroll on the Settings restore form** — SettingsSheet uses a plain `ScrollView`
   (`keyboardShouldPersistTaps="handled"`) inside `SheetOverlay`, NOT a `KeyboardAvoidingView` (Onboarding
   uses KAV). The multiline seed input mid-sheet should be reachable via the ScrollView, but verify on
   web (e2e) and flag for the device gate if a keyboard-crowding issue appears. Low risk.
2. **Username on restore** — the plan **preserves the current username**. Open option: add a username
   field to the Settings restore form (pre-filled with the current name) if the founder wants the user
   to rename on import. Small addition (one more input + prop thread).
3. **Destructive semantics** — Restore *replaces* the current identity. The warning banner must be
   unambiguous ("back up your current wallet first"). Two-tap parity with Reset (entry → confirm form).
   The old wallet is recoverable only via its own seed — honest, non-custodial.
4. **TestID namespace clarity** — `btn-restore` (Onboarding) vs `btn-settings-restore*` (Settings).
   They never co-mount, but the distinct namespaces keep the a11y census + future tests unambiguous.
5. **Pre-existing a11y-census gap** — `btn-backup` was never added to the census. This change fixes it
   opportunistically (§5.2). If the founder prefers to keep this change minimal, the `btn-backup` add
   can be dropped (the census still passes without it — it's a coverage gap, not a failure).
6. **`D4` BIP-39 (deferred, HIGH effort)** — OPEN_ISSUES notes the 64-hex seed is hard to transcribe;
  BIP-39 mnemonic is the documented long-term fix. This UX change does NOT address D4 (it's a
  key-derivation change, out of scope for a prominence fix). The restore seed input remains 64-hex.
7. **No device-gate trigger** — confirmed: no `app/android/**`, no FFI, no wire consts, no AID, no
  native-dep, no new Web API. `keypairFromSecret` already ships on the bridge. Inner loop = `just verify`.

---

## 9. Suggested commit messages

Split into two commits for reviewability (or one if preferred):

**Commit 1 — Onboarding: promote Restore to equal-weight secondary button**
```
Onboarding: promote Restore to a prominent secondary button

Restore wallet was a muted bottom link (S.linkBtn/S.linkTextMuted), making
recovery an afterthought. Restyle to S.secondaryBtn (bordered, 56pt, full-width
— the same chrome PayMode/SolPayMode Cancel use) and move it to sit immediately
after Create, forming a primary/secondary pair. Create stays the filled-brand
default; Restore is now equal visual weight but distinct prominence. testIDs
unchanged (btn-restore etc.) → flow 58 stays green. Seed validation extracted to
lib/format.ts validateSeed (shared with the new Settings restore).
```

**Commit 2 — Settings: add Restore wallet (import without wipe)**
```
Settings: add Restore wallet alongside Backup

A user who loses their phone had no in-app import path — they had to Reset
(wipe identity) first, then restore from Onboarding. Add a Restore section to
SettingsSheet (entry btn-settings-restore → seed form → confirm) mirroring the
Backup two-step idiom. On confirm: DpayCore.keypairFromSecret → build Identity
(preserves the current username) → onReplace persists + App.tsx setIdentity.
Restore REPLACES identity directly (no wipe); the old wallet stays recoverable
via its own seed. New App.tsx onRestore callback (symmetric with onReset).
New flow 63 (settings-restore); a11y census gains btn-backup (pre-existing gap)
+ btn-settings-restore + a settingsRestoreConfirm surface; settings.png baseline
re-seeded.
```

---

## 10. Summary

**Recommended approach:** (a) Onboarding — restyle the Restore entry from muted link to `secondaryBtn`
+ reorder after Create (keep expandable model + all testIDs). (b) Settings — add a Restore section
mirroring Backup, inline (no shared component), with a new `onRestore(id)` callback in App.tsx that
persists + setIdentity (Restore replaces, never wipes). Extract `validateSeed` for DRY validation.

**Files affected (6 source + 2 e2e + 1 baseline + 1 generated doc):**
- `app/lib/format.ts`, `app/App.tsx`, `app/components/Wallet.tsx`, `app/components/SettingsSheet.tsx`,
  `app/components/Onboarding.tsx`
- `e2e/tests/63-settings-restore.mjs` (new), `e2e/tests/41-a11y-census.mjs` (update)
- `e2e/shots/baselines/settings.png` (re-seed), `FLOWS.md` (regenerate)
- `styles.ts` — **unchanged** (all styles reused)

**Estimated effort:** Small overall. SettingsSheet is the only Medium slice (~40 lines: props + state +
section JSX + doRestore). The rest are Simple (1–10 lines each). E2e: one new flow + census update +
baseline re-seed. ~half a day end-to-end including verify.

**Top risks:** (1) `settings.png` baseline must be re-seeded or flow 40 REDS (documented). (2) Username
preservation is a product call (default: keep current). (3) Keyboard/scroll on the Settings seed input
(verify on web; flag for device if needed). (4) No device-gate trigger — correctly scoped to the
`just verify` inner loop.
