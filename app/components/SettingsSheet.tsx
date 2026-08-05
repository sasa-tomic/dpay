import {useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {PRIVACY_URL} from '../config/constants';
import {S} from '../styles';
import {useEscapeToClose} from '../hooks/useHotkeys';

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
export function SettingsSheet({relayUrl, setRelayUrl, onClose, onReset}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [draftRelay, setDraftRelay] = useState(relayUrl);
  // `lastApplied` tracks the URL the app is actually using (the parent's `relayUrl` updates AFTER
  // Apply succeeds). It's the source of truth for the "draft differs from active" gate so the Apply
  // button stays neutral after a successful apply (when draftRelay === relayUrl === lastApplied).
  const [lastApplied, setLastApplied] = useState(relayUrl);
  useEffect(() => { setDraftRelay(relayUrl); setLastApplied(relayUrl); }, [relayUrl]);

  const relayClean = draftRelay.trim();
  const relayDirty = relayClean.length > 0 && relayClean !== lastApplied.trim();
  const applyRelay = () => { if (relayDirty) { setRelayUrl(draftRelay); setLastApplied(draftRelay.trim()); } };

  return (
    <View style={S.sheetOverlay}>
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

          {/* Advanced: Server (the relay URL) — collapsed-capable disclosure. Defaults open so the
              e2e flows that type into `settings-relay` immediately after opening Settings still work
              without an extra "expand" step. The header is the toggle; testID `btn-advanced-toggle`
              lets a future default-collapse add an expand-first step to those flows. */}
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
    </View>
  );
}
