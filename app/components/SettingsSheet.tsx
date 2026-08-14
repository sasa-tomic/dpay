import {useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {PRIVACY_URL} from '../config/constants';
import {S} from '../styles';
import {validateSeed} from '../lib/format';
import {hexToWords, wordsToString} from '../lib/bip39';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {SheetOverlay} from './SheetOverlay';

/**
 * Settings sheet — server config + reset (app configuration only). Moved off the main wallet screen
 * (UX-V2: the relay URL + bare red reset were dev chrome on a consumer surface) into its own overlay.
 * Reset requires a confirmation dialog (UX-V3: one-tap identity wipe was dangerous). The demo faucet
 * used to live here too, but top-up is now consolidated in the Balances sheet (the wallet's single
 * money hub) so demo funds have exactly ONE home — no duplication between Settings and the balances.
 *
 * Audit 2026-08-05 P1/P2:
 *  - "Relay URL" → "Server" (jargon a non-technical user has no mental model for).
 *  - The Server input lives behind an "Advanced" disclosure so a curious user doesn't trip a
 *    one-paste-away brick. The disclosure DEFAULTS COLLAPSED (U5, 2026-08-10) — e2e flows that need
 *    `settings-relay` expand it first via `btn-advanced-toggle` (wired in the harness `setRelay`
 *    helper). A curious user can expand it; most users never need to.
 *  - Helper text moved ABOVE the input so the user reads the consequence before editing.
 *  - Apply is visually distinct (brand shadow) when the draft differs from the active URL; neutral
 *    when the draft matches it (the existing dirty-gate). The dirty/apply state still gates on the
 *    last-known-good URL, so a typed-then-reverted draft does not enable Apply.
 *  - Reset entry-point: a bordered red-outline button "Reset wallet…" with an ellipsis signaling that
 *    the action opens a confirmation dialog (the destructive gate stays in place). Visually distinct
 *    from the "Privacy policy" link above it (which previously shared the same link chrome).
 */
export function SettingsSheet({relayUrl, setRelayUrl, onClose, onReset, onRestore, secretHex, username}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onClose: () => void;
  onReset: () => void;
  // Replace the current identity with a restored one (built from a 64-hex seed the user pastes).
  // Mirrors Onboarding's restore semantics; App.tsx persists + setIdentity. Restore REPLACES the
  // identity directly (no wipe) — the old wallet stays recoverable via its own seed.
  onRestore: (id: Identity) => Promise<void>;
  // The IC ed25519 seed hex (32 bytes). The same seed derives BOTH the IC account and the Solana
  // keypair (app/solana/identity.ts SLIP-10 derivation), so revealing this ONE secret is the full
  // backup. Pure display + copy; no money logic, no persistence (it already lives in AsyncStorage).
  secretHex: string;
  // The current wallet's username — PRESERVED across a restore (the seed recovers keys, not local
  // display metadata). Passed to the rebuilt Identity so the user keeps their display name.
  username: string;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);
  // Backup reveal is a TWO-step gate (mirrors the reset confirm idiom): `confirmBackup` opens the
  // warning + btn-backup-confirm; `backupRevealed` (set only after confirming) shows the seed. This
  // keeps the seed off-screen until the user has explicitly acknowledged the BOTH-rails warning — no
  // accidental shoulder-surf reveal on a first tap. `copied` mirrors DepositSheet/WithdrawSheet.
  const [confirmBackup, setConfirmBackup] = useState(false);
  const [backupRevealed, setBackupRevealed] = useState(false);
  // The revealed backup shows the 24 BIP-39 words by default (the human-readable serialization of
  // the 32-byte seed) with a toggle to the raw 64-hex view. Defaults to `'mnemonic'` and is reset
  // back to it on Hide so re-revealing always starts at the words view (the friendlier default).
  const [seedFormat, setSeedFormat] = useState<'mnemonic' | 'hex'>('mnemonic');
  // Restore form state (mirrors the backup/reset confirm pattern): `confirmRestore` opens the inline
  // seed-input form; `restoreSeed` holds the user-entered 64-hex; `restoreBusy` gates the confirm
  // button during the keypairFromSecret FFI call; `restoreErr` surfaces a validation/derivation
  // failure (bad seed shape, FFI throw). On a successful confirm the parent replaces the identity
  // and this sheet unmounts (App.tsx setIdentity → wallet re-mounts under the new key).
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  const {copied, copy: doCopy, clear: clearCopied} = useCopyFeedback();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draftRelay, setDraftRelay] = useState(relayUrl);
  // `lastApplied` tracks the URL the app is actually using (the parent's `relayUrl` updates AFTER
  // Apply succeeds). It's the source of truth for the "draft differs from active" gate so the Apply
  // button stays neutral after a successful apply (when draftRelay === relayUrl === lastApplied).
  const [lastApplied, setLastApplied] = useState(relayUrl);
  useEffect(() => { setDraftRelay(relayUrl); setLastApplied(relayUrl); }, [relayUrl]);

  const relayClean = draftRelay.trim();
  const relayDirty = relayClean.length > 0 && relayClean !== lastApplied.trim();
  const applyRelay = () => { if (relayDirty) { setRelayUrl(draftRelay); setLastApplied(draftRelay.trim()); } };

  // Copy the seed via the shared clipboard-feedback hook (real clipboard on web, Share on native;
  // surfaces the "Copied ✓"/"Shared ✓" confirmation for 1500ms).
  const copySeed = () => { void doCopy(secretHex); };

  // The 24 BIP-39 words for the mnemonic backup view. The 32-byte seed never changes for a given
  // identity, so this memoizes on `secretHex` (a prop) — one synchronous SHA-256 per identity, not
  // per render. Cheap enough to compute inline, but memoizing avoids a redundant encode on every
  // `copied`/format-toggle re-render.
  const mnemonicWords = useMemo(() => hexToWords(secretHex), [secretHex]);
  const mnemonicString = useMemo(() => wordsToString(mnemonicWords), [mnemonicWords]);
  const copyMnemonic = () => { void doCopy(mnemonicString); };

  // Validate + derive + replace the identity from a pasted 64-hex seed. Mirrors Onboarding.restore:
  // validateSeed → keypairFromSecret → build Identity (username preserved) → hand to onRestore
  // (App.tsx persists + setIdentity → wallet re-renders under the new key). On success we ALSO
  // dismiss the sheet: a Wallet re-render (not unmount) follows a non-null identity replace, so
  // without `onClose` the Settings sheet would stay open over the now-replaced wallet. Closing it
  // lands the user back at the wallet view (the natural "I just restored → show me my wallet"
  // expectation), and is symmetric with Reset (which makes the whole Wallet unmount). The form's
  // busy/error state stays co-located with the input (same idiom as Onboarding restore).
  async function doRestore() {
    if (restoreBusy) return;
    const e = validateSeed(restoreSeed);
    if (e) { setRestoreErr(e); return; }
    const seed = restoreSeed.trim().toLowerCase();
    setRestoreBusy(true); setRestoreErr(null);
    try {
      const kp = await DpayCore.keypairFromSecret(seed);
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username};
      await onRestore(id);
      onClose();
      // On success the sheet unmounts (Wallet setSettingsOpen(false)); no need to reset local form
      // state — the component is gone.
    } catch (err: unknown) {
      setRestoreErr(err instanceof Error ? err.message : String(err));
      setRestoreBusy(false);
    }
  }

  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Settings</Text>
          <Pressable testID="btn-settings-close" style={S.sheetClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close settings" accessibilityState={{disabled: false}}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          {/* Backup — reveal the IC seed (which ALSO derives the Solana key) behind a two-step confirm
              gate. Pure display + copy; the seed already lives in AsyncStorage. The warning names the
              BOTH-rails consequence so the user stores it before any shoulder-surf risk. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Backup</Text>
            {backupRevealed ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>This seed recovers BOTH your IC and Solana funds. Store it safely. Never share it.</Text>
                {seedFormat === 'mnemonic' ? (
                  <>
                    <View testID="mnemonic-words" style={{flexDirection: 'row', flexWrap: 'wrap', marginTop: 4}}>
                      {mnemonicWords.map((w, i) => (
                        <View
                          key={i}
                          testID={`mnemonic-word-${i}`}
                          style={{flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, margin: 3, borderWidth: 1, borderColor: C.line2}}>
                          <Text style={{color: C.sub2, fontFamily: 'monospace', fontSize: 12, marginRight: 6}}>{i + 1}</Text>
                          <Text style={{color: C.ink, fontSize: 15}}>{w}</Text>
                        </View>
                      ))}
                    </View>
                    <Pressable
                      testID="btn-copy-mnemonic"
                      style={[S.primaryWide, {marginTop: 16}]}
                      onPress={copyMnemonic}
                      accessibilityRole="button"
                      accessibilityLabel={copied === 'clipboard' ? 'Words copied' : copied === 'shared' ? 'Words shared' : 'Copy words'}
                      accessibilityHint="Copies your 24 recovery words to the clipboard"
                      accessibilityState={{disabled: false}}>
                      <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy words'}</Text>
                    </Pressable>
                    <Pressable
                      testID="btn-backup-show-hex"
                      style={S.linkBtn}
                      onPress={() => setSeedFormat('hex')}
                      accessibilityRole="button"
                      accessibilityLabel="Show seed as hex"
                      accessibilityHint="Switches to the raw 64-hex recovery seed view"
                      accessibilityState={{disabled: false}}>
                      <Text style={S.linkTextMuted}>Show as hex</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <View style={S.seedBox}>
                      <Text testID="seed-phrase" style={S.seedText} selectable={true}>{secretHex}</Text>
                    </View>
                    <Pressable
                      testID="btn-copy-seed"
                      style={[S.primaryWide, {marginTop: 16}]}
                      onPress={copySeed}
                      accessibilityRole="button"
                      accessibilityLabel={copied === 'clipboard' ? 'Seed copied' : copied === 'shared' ? 'Seed shared' : 'Copy seed'}
                      accessibilityHint="Copies your recovery seed to the clipboard"
                      accessibilityState={{disabled: false}}>
                      <Text style={S.primaryText}>{copied === 'clipboard' ? 'Copied ✓' : copied === 'shared' ? 'Shared ✓' : 'Copy seed'}</Text>
                    </Pressable>
                    <Pressable
                      testID="btn-backup-show-hex"
                      style={S.linkBtn}
                      onPress={() => setSeedFormat('mnemonic')}
                      accessibilityRole="button"
                      accessibilityLabel="Show seed as words"
                      accessibilityHint="Switches to the 24-word recovery phrase view"
                      accessibilityState={{disabled: false}}>
                      <Text style={S.linkTextMuted}>Show as words</Text>
                    </Pressable>
                  </>
                )}
                <Pressable
                  testID="btn-backup-hide"
                  style={S.linkBtn}
                  onPress={() => { setBackupRevealed(false); setConfirmBackup(false); setSeedFormat('mnemonic'); clearCopied(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Hide seed"
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>Hide</Text>
                </Pressable>
              </View>
            ) : confirmBackup ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>This seed recovers BOTH your IC and Solana funds. Store it safely. Never share it.</Text>
                <Pressable
                  testID="btn-backup-confirm"
                  style={[S.primaryWide, {marginTop: 16}]}
                  onPress={() => setBackupRevealed(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Reveal recovery seed"
                  accessibilityHint="Shows your seed on screen — anyone viewing your screen can copy it"
                  accessibilityState={{disabled: false}}>
                  <Text style={S.primaryText}>Reveal seed</Text>
                </Pressable>
                <Pressable
                  testID="btn-backup-cancel"
                  style={S.linkBtn}
                  onPress={() => setConfirmBackup(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel backup"
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                testID="btn-backup"
                style={S.backupEntryBtn}
                onPress={() => setConfirmBackup(true)}
                accessibilityRole="button"
                accessibilityLabel="Back up wallet"
                accessibilityHint="Reveals your recovery seed — backs up both your IC and Solana funds"
                accessibilityState={{disabled: false}}>
                <Text style={S.backupEntryText}>Back up wallet…</Text>
              </Pressable>
            )}
          </View>

          {/* Restore — import a wallet from a 64-hex seed WITHOUT resetting first. Mirrors the Backup
              two-step idiom (entry button → expandable seed form → confirm) so a user who loses their
              phone has an in-app import path: they no longer need to wipe (Reset) then restore from
              Onboarding. On confirm: keypairFromSecret → build Identity (username preserved) → onRestore
              (App.tsx persists + setIdentity). Restore REPLACES identity directly (no wipe); the old
              wallet stays recoverable via its own seed. Entry button uses `secondaryBtn` (neutral
              bordered — reads as "import", not destructive-red like Reset, not brand-green like Backup). */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Restore</Text>
            {confirmRestore ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>This replaces your current wallet with the one recovered from this seed. Back up your current wallet first if you haven't — its funds are only reachable via its own seed.</Text>
                <TextInput
                  testID="settings-restore-seed-input"
                  style={S.seedInput}
                  value={restoreSeed}
                  onChangeText={setRestoreSeed}
                  placeholder="64 hex characters"
                  placeholderTextColor={C.sub2}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  accessibilityLabel="Recovery seed"
                  accessibilityHint="The 64-hex seed shown by Backup that recovers your wallet"
                />
                {restoreErr ? <Text style={S.err}>{restoreErr}</Text> : null}
                <Pressable
                  testID="btn-settings-restore-confirm"
                  style={[S.primary, (restoreBusy || restoreSeed.trim() === '') && S.dim]}
                  disabled={restoreBusy || restoreSeed.trim() === ''}
                  onPress={doRestore}
                  accessibilityRole="button"
                  accessibilityLabel="Restore wallet"
                  accessibilityHint="Replaces your current wallet with the one recovered from this seed"
                  accessibilityState={{disabled: restoreBusy || restoreSeed.trim() === ''}}>
                  <Text style={S.primaryText}>{restoreBusy ? 'Restoring…' : 'Restore wallet'}</Text>
                </Pressable>
                <Pressable
                  testID="btn-settings-restore-cancel"
                  style={S.linkBtn}
                  onPress={() => { setConfirmRestore(false); setRestoreSeed(''); setRestoreErr(null); }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel restore"
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                testID="btn-settings-restore"
                style={S.secondaryBtn}
                onPress={() => { setConfirmRestore(true); setRestoreErr(null); }}
                accessibilityRole="button"
                accessibilityLabel="Restore wallet"
                accessibilityHint="Import a wallet from your 64-hex recovery seed — replaces your current wallet"
                accessibilityState={{disabled: false}}>
                <Text style={S.secondaryBtnText}>Restore wallet…</Text>
              </Pressable>
            )}
          </View>

          {/* Reset — the destructive action goes LAST in the wallet-management group (Backup → Restore
              → Reset), so a user scanning top-down encounters the protective actions first. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Reset</Text>
            {confirmReset ? (
              <View style={S.resetConfirmBox}>
                <Text style={S.warnNote}>This erases your wallet identity from this device. Funds at this address become irrecoverable. This cannot be undone.</Text>
                <Pressable testID="btn-reset-confirm" style={[S.primaryWide, {backgroundColor: C.bad, marginTop: 16}]} onPress={onReset} accessibilityRole="button" accessibilityLabel="Yes, reset everything" accessibilityHint="Permanently erase your wallet from this device — funds become irrecoverable" accessibilityState={{disabled: false}}>
                  <Text style={S.primaryText}>Yes, reset everything</Text>
                </Pressable>
                <Pressable testID="btn-reset-cancel" style={S.linkBtn} onPress={() => setConfirmReset(false)} accessibilityRole="button" accessibilityLabel="Cancel reset" accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable testID="btn-reset" style={S.resetEntryBtn} onPress={() => setConfirmReset(true)} accessibilityRole="button" accessibilityLabel="Reset wallet" accessibilityHint="Opens a confirmation dialog — permanently erases your wallet from this device" accessibilityState={{disabled: false}}>
                <Text style={S.resetEntryText}>Reset wallet…</Text>
              </Pressable>
            )}
          </View>

          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>About</Text>
            <Pressable
              testID="privacy-policy"
              style={S.linkBtn}
              onPress={() => Linking.openURL(PRIVACY_URL)}
              accessibilityRole="link"
              accessibilityLabel="Privacy policy">
              <Text style={S.linkTextMuted}>Privacy policy</Text>
            </Pressable>
          </View>

          {/* Advanced: Server (the relay URL) — disclosure COLLAPSES by default so a curious
              consumer doesn't see the relay URL input + a one-paste-away brick on first open.
              The header is the toggle; testID `btn-advanced-toggle` is the expansion step the e2e
              flows add before reading `settings-relay`. Expanding is one tap — keep it cheap. */}
          <View style={S.settingsSection}>
            <Pressable
              testID="btn-advanced-toggle"
              style={S.advancedToggle}
              onPress={() => setAdvancedOpen(o => !o)}
              accessibilityRole="button"
              accessibilityLabel={advancedOpen ? 'Hide advanced settings' : 'Show advanced settings'}
              accessibilityHint="Server configuration for the wallet's relay"
              accessibilityState={{disabled: false, expanded: advancedOpen}}>
              <Text style={S.advancedLabel}>Advanced</Text>
              <Text style={S.advancedCaret}>{advancedOpen ? '▾' : '▸'}</Text>
            </Pressable>
            {advancedOpen ? (
              <View>
                <Text style={S.dim2}>The server your wallet talks to. Changes apply when you tap Apply.</Text>
                <Text style={S.inputLabel}>Server</Text>
                <TextInput
                  testID="settings-relay"
                  style={S.relayInput}
                  value={draftRelay}
                  onChangeText={setDraftRelay}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="http://<ip>:8787"
                  placeholderTextColor={C.sub2}
                  accessibilityLabel="Server"
                  accessibilityHint="The server your wallet talks to"
                />
                <Pressable
                  testID="btn-relay-apply"
                  style={[S.applyBtn, !relayDirty && S.applyBtnDisabled]}
                  disabled={!relayDirty}
                  onPress={applyRelay}
                  accessibilityRole="button"
                  accessibilityLabel="Apply server URL"
                  accessibilityHint="Switch your wallet to the entered server URL"
                  accessibilityState={{disabled: !relayDirty}}>
                  <Text style={S.applyBtnText}>Apply</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SheetOverlay>
  );
}
