import {useState} from 'react';
import {View, Text, Pressable, TextInput, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {useEscapeToClose} from '../hooks/useHotkeys';

/**
 * Settings sheet — relay URL, demo faucet, reset. Moved off the main wallet screen (UX-V2: the
 * relay URL + bare red reset were dev chrome on a consumer surface) into its own overlay. Reset now
 * requires a confirmation dialog (UX-V3: one-tap identity wipe was dangerous). The demo faucet lives
 * here too (founder decision: keep it, label it clearly, surface the cooldown).
 */
export function SettingsSheet({relayUrl, setRelayUrl, onTopUp, topUpBusy, topUpErr, onClose, onReset}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  onTopUp: () => void;
  topUpBusy: boolean;
  topUpErr: string | null;
  onClose: () => void;
  onReset: () => void;
}) {
  useEscapeToClose(onClose);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <View style={S.sheetOverlay}>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Settings</Text>
          <Pressable testID="btn-settings-close" style={S.sheetClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close settings" accessibilityState={{disabled: false}}><Text style={S.sheetCloseX}>✕</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetBody} keyboardShouldPersistTaps="handled">
          {/* Relay URL */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Relay URL</Text>
            <TextInput
              testID="settings-relay"
              style={S.relayInput}
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://<ip>:8787"
              placeholderTextColor={C.sub2}
            />
            <Text style={S.dim2}>The server your wallet talks to. Change this to point at a different network.</Text>
          </View>

          {/* Demo faucet */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Demo funds</Text>
            <Text style={S.dim2}>Add play money for testing. Limited to once per hour on the real network.</Text>
            <Pressable
              testID="btn-topup"
              style={[S.primaryWide, topUpBusy && S.dim]}
              disabled={topUpBusy}
              onPress={onTopUp}
              accessibilityRole="button"
              accessibilityLabel="Add demo money"
              accessibilityState={{disabled: topUpBusy}}>
              {topUpBusy
                ? <ActivityIndicator size="small" color={C.brandInk} />
                : <Text style={S.primaryText}>Add demo money</Text>}
            </Pressable>
            {topUpErr ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text> : null}
          </View>

          {/* Reset */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>Reset</Text>
            {confirmReset ? (
              <View style={S.resetConfirmBox}>
                <Text style={S.warnNote}>This erases your wallet identity from this device. Funds at this address become irrecoverable. This cannot be undone.</Text>
                <Pressable testID="btn-reset-confirm" style={[S.primaryWide, {backgroundColor: C.bad, marginTop: 16}]} onPress={onReset} accessibilityRole="button" accessibilityLabel="Yes, reset everything" accessibilityState={{disabled: false}}>
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

          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
