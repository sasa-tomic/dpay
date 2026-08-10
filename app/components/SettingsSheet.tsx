import {useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {PRIVACY_URL} from '../config/constants';
import {S} from '../styles';
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
 *    one-paste-away brick. The disclosure DEFAULTS OPEN — many e2e flows (12/13/19/20/22/38/41) type
 *    into `settings-relay` immediately after opening Settings, so a default-collapsed disclosure would
 *    break the e2e contract (`settings-relay`/`btn-relay-apply` must be present at first render). The
 *    user CAN collapse it via `btn-advanced-toggle`; a future default-collapse needs the e2e flows
 *    updated to expand first.
 *  - Helper text moved ABOVE the input so the user reads the consequence before editing.
 *  - Apply is visually distinct (brand shadow) when the draft differs from the active URL; neutral
 *    when the draft matches it (the existing dirty-gate). The dirty/apply state still gates on the
 *    last-known-good URL, so a typed-then-reverted draft does not enable Apply.
 *  - Reset entry-point: a bordered red-outline button "Reset wallet…" with an ellipsis signaling that
 *    the action opens a confirmation dialog (the destructive gate stays in place). Visually distinct
 *    from the "Privacy policy" link above it (which previously shared the same link chrome).
 */
export function SettingsSheet({relayUrl, setRelayUrl, onClose, onReset, secretHex}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onClose: () => void;
  onReset: () => void;
  // The IC ed25519 seed hex (32 bytes). The same seed derives BOTH the IC account and the Solana
  // keypair (app/solana/identity.ts SLIP-10 derivation), so revealing this ONE secret is the full
  // backup. Pure display + copy; no money logic, no persistence (it already lives in AsyncStorage).
  secretHex: string;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);
  // Backup reveal is a TWO-step gate (mirrors the reset confirm idiom): `confirmBackup` opens the
  // warning + btn-backup-confirm; `backupRevealed` (set only after confirming) shows the seed. This
  // keeps the seed off-screen until the user has explicitly acknowledged the BOTH-rails warning — no
  // accidental shoulder-surf reveal on a first tap. `copied` mirrors DepositSheet/WithdrawSheet.
  const [confirmBackup, setConfirmBackup] = useState(false);
  const [backupRevealed, setBackupRevealed] = useState(false);
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

  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Settings</Text>
          <Pressable testID="btn-settings-close" style={S.sheetClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close settings" accessibilityState={{disabled: false}}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          {/* Reset */}
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

          {/* Backup — reveal the IC seed (which ALSO derives the Solana key) behind a two-step confirm
              gate. Pure display + copy; the seed already lives in AsyncStorage. The warning names the
              BOTH-rails consequence so the user stores it before any shoulder-surf risk. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Backup</Text>
            {backupRevealed ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>This seed recovers BOTH your IC and Solana funds. Store it safely. Never share it.</Text>
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
                  testID="btn-backup-hide"
                  style={S.linkBtn}
                  onPress={() => { setBackupRevealed(false); setConfirmBackup(false); clearCopied(); }}
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
