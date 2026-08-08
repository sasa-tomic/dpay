import {useState} from 'react';
import {KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StatusBar, Text, Pressable, TextInput} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {STORAGE_KEY, BALANCE_TIMEOUT_MS} from '../config/constants';
import {base} from '../lib/format';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {fetchWithTimeout} from '../services/relay';
import {Logo, Wordmark} from './Logo';

export function Onboarding({relayUrl, onCreated}: {relayUrl: string; onCreated: (id: Identity) => void}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<Identity | null>(null);

  async function create() {
    const name = username.trim() || 'me';
    setBusy(true); setErr(null);
    try {
      const kp = await DpayCore.generateKeypair();
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username: name};
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      // Fund the new account from the demo faucet (best-effort — works when the ledger is reachable).
      // Bounded by a 4s timeout so a hanging/dead relay can't stall onboarding (fail fast → $0, fund later).
      try {
        await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex})}, BALANCE_TIMEOUT_MS);
        onCreated(id);
      } catch {
        setPendingId(id);
        setBusy(false);
      }
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} translucent={false} />
      {/* B1 — keep the CTA visible while the keyboard is up. `behavior="padding"` on iOS lifts the
          form above the keyboard (the username input + Create wallet CTA otherwise sit ~y1509-1656,
          fully under the ~y1200+ keyboard). Android already gets adjustResize from AndroidManifest
          (the system resizes the window), so `behavior` is undefined there and we only apply a small
          `keyboardVerticalOffset` to absorb the status-bar height. The ScrollView lets the column
          scroll if the keyboard still crowds it on a small device. */}
      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 0}>
        <ScrollView style={{flex: 1}} contentContainerStyle={S.onboard} keyboardShouldPersistTaps="handled">
          <Logo size={104} />
          <Wordmark style={S.wordmarkBig} />
          <Text style={S.onboardSub}>Tap or scan to pay — online or offline.</Text>
          {pendingId ? (
            <>
              <Text testID="onboard-faucet-failed" style={S.warnNote}>Wallet created, but starter funds couldn't be added. The server may be offline — you can add funds later from Balances.</Text>
              <Pressable testID="btn-onboard-continue" style={S.primary} onPress={() => onCreated(pendingId!)}
                accessibilityRole="button" accessibilityLabel="Continue" accessibilityState={{disabled: false}}>
                <Text style={S.primaryText}>Continue</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={S.label}>Choose a username</Text>
              <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} onSubmitEditing={busy ? undefined : create} accessibilityLabel="Username" accessibilityHint="The name others see when you request or receive a payment" />
              {err ? <Text style={S.err}>{err}</Text> : null}
              <Pressable testID="btn-create" style={[S.primary, busy && S.dim]} disabled={busy} onPress={create}
                accessibilityRole="button" accessibilityLabel="Create wallet" accessibilityHint="Generate your on-device key and add demo funds" accessibilityState={{disabled: busy}}>
                <Text style={S.primaryText}>{busy ? 'Creating…' : 'Create wallet'}</Text>
              </Pressable>
              <Text style={S.dim2}>Creates your wallet and adds ∂100 in demo funds to get started.</Text>
              <Text style={S.dpayGlyphNote}><Text style={S.dpayGlyph}>∂</Text> is the demo-dollar symbol — play money, ∂1 = $1.</Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
