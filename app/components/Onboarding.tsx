import {useState} from 'react';
import {SafeAreaView, StatusBar, View, Text, Pressable, TextInput} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {STORAGE_KEY} from '../config/constants';
import {base} from '../lib/format';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {Logo, Wordmark} from './Logo';

export function Onboarding({relayUrl, onCreated}: {relayUrl: string; onCreated: (id: Identity) => void}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
        try {
          await fetch(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex}), signal: ctrl.signal});
        } finally { clearTimeout(t); }
      } catch { /* offline/timeout: created with $0, can be funded later */ }
      onCreated(id);
    } catch (e: any) { setErr(String(e?.message ?? e)); setBusy(false); }
  }

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={S.onboard}>
        <Logo size={104} />
        <Wordmark style={S.wordmarkBig} />
        <Text style={S.onboardSub}>Tap or scan to pay — online or offline.</Text>
        <Text style={S.label}>Choose a username</Text>
        <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} onSubmitEditing={busy ? undefined : create} />
        {err ? <Text style={S.err}>{err}</Text> : null}
        <Pressable testID="btn-create" style={[S.primary, busy && S.dim]} disabled={busy} onPress={create}>
          <Text style={S.primaryText}>{busy ? 'Creating…' : 'Create & fund wallet'}</Text>
        </Pressable>
        <Text style={S.dim2}>Generates a key on this device and adds demo $100 to start.</Text>
      </View>
    </SafeAreaView>
  );
}
