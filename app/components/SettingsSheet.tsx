import {useEffect, useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {PRIVACY_URL} from '../config/constants';
import {S} from '../styles';
import {useEscapeToClose} from '../hooks/useHotkeys';

/**
 * Settings sheet — relay URL + reset (app configuration only). Moved off the main wallet screen
 * (UX-V2: the relay URL + bare red reset were dev chrome on a consumer surface) into its own overlay.
 * Reset requires a confirmation dialog (UX-V3: one-tap identity wipe was dangerous). The demo faucet
 * used to live here too, but top-up is now consolidated in the Balances sheet (the wallet's single
 * money hub) so demo funds have exactly ONE home — no duplication between Settings and the balances.
 */
export function SettingsSheet({relayUrl, setRelayUrl, onClose, onReset}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draftRelay, setDraftRelay] = useState(relayUrl);
  useEffect(() => setDraftRelay(relayUrl), [relayUrl]);

  const relayClean = draftRelay.trim();
  const relayDirty = relayClean.length > 0 && relayClean !== relayUrl.trim();
  const applyRelay = () => { if (relayDirty) setRelayUrl(draftRelay); };

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
              <Pressable testID="btn-reset" style={S.linkBtn} onPress={() => setConfirmReset(true)} accessibilityRole="button" accessibilityLabel="Reset wallet" accessibilityState={{disabled: false}}>
                <Text style={S.resetLink}>Reset wallet</Text>
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

          {/* Advanced: Relay URL */}
          <View style={S.settingsSection}>
            <Text style={S.advancedLabel}>Advanced</Text>
            <Text style={S.inputLabel}>Relay URL</Text>
            <TextInput
              testID="settings-relay"
              style={S.relayInput}
              value={draftRelay}
              onChangeText={setDraftRelay}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://<ip>:8787"
              placeholderTextColor={C.sub2}
            />
            <Text style={S.dim2}>The server your wallet talks to. Changes apply when you tap Apply.</Text>
            <Pressable
              testID="btn-relay-apply"
              style={[S.applyBtn, !relayDirty && S.applyBtnDisabled]}
              disabled={!relayDirty}
              onPress={applyRelay}
              accessibilityRole="button"
              accessibilityLabel="Apply relay URL"
              accessibilityHint="Switch your wallet to the entered relay URL"
              accessibilityState={{disabled: !relayDirty}}>
              <Text style={S.applyBtnText}>Apply</Text>
            </Pressable>
          </View>

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
