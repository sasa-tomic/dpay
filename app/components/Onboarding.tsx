import {useState} from 'react';
import {KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StatusBar, Text, Pressable, TextInput, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S} from '../styles';
import {STORAGE_KEY, BALANCE_TIMEOUT_MS} from '../config/constants';
import {base, validateSeed} from '../lib/format';
import {hexToWords} from '../lib/bip39';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {fetchWithTimeout} from '../services/relay';
import {Logo, Wordmark} from './Logo';

export function Onboarding({relayUrl, onCreated}: {relayUrl: string; onCreated: (id: Identity) => void}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<Identity | null>(null);
  const [mode, setMode] = useState<'create' | 'restore'>('create');
  const [seed, setSeed] = useState('');
  // BIP-39 backup gate (create flow). `backupMnemonic` holds the 24 words to display when non-null;
  // the backup screen renders INSTEAD of the create/restore form until the user checks the
  // acknowledgement and taps Continue. `backupChecked` is a pure UX gate (not a security mechanism).
  const [backupMnemonic, setBackupMnemonic] = useState<string[] | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);

  // Generate a fresh on-device Ed25519 keypair, persist it, then SHOW THE BIP-39 BACKUP before entering
  // the wallet. The faucet fund is DEFERRED to `finishCreate` (run after the user acknowledges the
  // backup) so the wallet is never entered without the user having seen their 24 recovery words. The
  // mnemonic is derived ON-DEMAND from secretHex via `hexToWords` — no storage change.
  async function create() {
    const name = username.trim() || 'me';
    setBusy(true); setErr(null);
    try {
      const kp = await DpayCore.generateKeypair();
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username: name};
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      const words = hexToWords(kp.secretHex);
      setPendingId(id);
      setBackupMnemonic(words);
      setBusy(false);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  // Continue create AFTER the user acknowledges the backup: clear the backup screen, run the demo
  // faucet (best-effort — works when the ledger is reachable; bounded by a 4s timeout so a hanging/
  // dead relay can't stall onboarding — fail fast → $0, fund later), then enter the wallet. On faucet
  // failure, `pendingId` is already set so the existing faucet-failed screen renders with Continue.
  async function finishCreate() {
    if (!pendingId) return;
    const id = pendingId;
    setBackupMnemonic(null);
    setBackupChecked(false);
    setBusy(true);
    try {
      await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex})}, BALANCE_TIMEOUT_MS);
      onCreated(id);
    } catch (e) {
      console.warn('faucet fetch failed:', e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Restore a wallet from the 64-hex recovery seed (the value Backup reveals). Mirrors `create` but
  // derives the keypair from the entered seed via `keypairFromSecret` instead of generating a random
  // one, and skips the faucet — a restored wallet already has its on-chain funds. One seed recovers
  // BOTH rails: the IC Ed25519 key (this keypair) AND the Solana key (SLIP-10 derivation, see
  // app/solana/identity.ts).
  async function restore() {
    setErr(null);
    const e = validateSeed(seed);
    if (e) { setErr(e); return; }
    const s = seed.trim().toLowerCase();
    const name = username.trim() || 'me';
    setBusy(true);
    try {
      const kp = await DpayCore.keypairFromSecret(s);
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username: name};
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      onCreated(id);
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
          {backupMnemonic ? (
            <>
              <Text style={S.wordmarkBig}>Back up your wallet</Text>
              <Text style={S.warnNote}>Write down these 24 words and store them safely. They're the ONLY way to recover your wallet if you lose this device.</Text>
              <View testID="mnemonic-backup" style={{flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignSelf: 'stretch', marginTop: 4, marginBottom: 8}}>
                {backupMnemonic.map((w, i) => (
                  <View key={i} testID={`mnemonic-word-${i}`} style={{flexDirection: 'row', alignItems: 'baseline', backgroundColor: C.field, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, margin: 4, borderWidth: 1, borderColor: C.line2}}>
                    <Text style={{color: C.sub2, fontFamily: 'monospace', fontSize: 11, marginRight: 6}}>{i + 1}</Text>
                    <Text style={{color: C.ink, fontFamily: 'monospace', fontSize: 15}}>{w}</Text>
                  </View>
                ))}
              </View>
              <Pressable testID="mnemonic-backup-checkbox" style={{flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', marginTop: 4, marginBottom: 10, minHeight: 44}} onPress={() => setBackupChecked(!backupChecked)}
                accessibilityRole="checkbox" accessibilityLabel="I've written down all 24 words" accessibilityState={{checked: backupChecked}}>
                <View style={{width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: backupChecked ? C.brand : C.sub2, backgroundColor: backupChecked ? C.brand : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10}}>
                  {backupChecked ? <Text style={{color: C.brandInk, fontWeight: '800', fontSize: 14, lineHeight: 16}}>✓</Text> : null}
                </View>
                <Text style={{color: C.sub, fontSize: 15, flex: 1}}>I've written down all 24 words</Text>
              </Pressable>
              <Pressable testID="btn-mnemonic-continue" style={[S.primary, !backupChecked && S.dim]} disabled={!backupChecked} onPress={finishCreate}
                accessibilityRole="button" accessibilityLabel="Continue" accessibilityState={{disabled: !backupChecked}}>
                <Text style={S.primaryText}>Continue</Text>
              </Pressable>
            </>
          ) : pendingId ? (
            <>
              <Text testID="onboard-faucet-failed" style={S.warnNote}>Wallet created, but starter funds couldn't be added. The server may be offline — you can add funds later from Balances.</Text>
              <Pressable testID="btn-onboard-continue" style={S.primary} onPress={() => onCreated(pendingId!)}
                accessibilityRole="button" accessibilityLabel="Continue" accessibilityState={{disabled: false}}>
                <Text style={S.primaryText}>Continue</Text>
              </Pressable>
            </>
          ) : mode === 'restore' ? (
            <>
              <Text style={S.label}>Recovery seed</Text>
              <TextInput testID="restore-seed-input" style={S.seedInput} value={seed} onChangeText={setSeed} placeholder="64 hex characters" placeholderTextColor={C.sub2} autoCapitalize="none" autoCorrect={false} multiline accessibilityLabel="Recovery seed" accessibilityHint="The 64-hex seed shown by Backup that recovers your wallet" />
              <Text style={S.dim2}>One seed recovers both your IC and Solana funds.</Text>
              <Text style={S.label}>Choose a username</Text>
              <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder="e.g. Alice" placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} accessibilityLabel="Username" accessibilityHint="The name others see when you request or receive a payment" />
              {err ? <Text style={S.err}>{err}</Text> : null}
              <Pressable testID="btn-restore-confirm" style={[S.primary, (busy || seed.trim() === '') && S.dim]} disabled={busy || seed.trim() === ''} onPress={restore}
                accessibilityRole="button" accessibilityLabel="Restore wallet" accessibilityHint="Recover your wallet from the recovery seed" accessibilityState={{disabled: busy || seed.trim() === ''}}>
                <Text style={S.primaryText}>{busy ? 'Restoring…' : 'Restore wallet'}</Text>
              </Pressable>
              <Pressable testID="btn-restore-cancel" style={S.linkBtn} onPress={() => { setMode('create'); setSeed(''); setErr(null); }}
                accessibilityRole="button" accessibilityLabel="Cancel restore" accessibilityHint="Go back to creating a new wallet">
                <Text style={S.linkTextMuted}>Cancel</Text>
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
              {/* Restore entry — promoted (UX fix 2026-08-10) from a muted bottom link (S.linkBtn /
                  S.linkTextMuted) to S.secondaryBtn / S.secondaryBtnText, and repositioned to sit
                  IMMEDIATELY after Create. Create stays the filled-brand default (primary); Restore
                  is now equal visual weight (same 56pt, full-width, bordered) but distinct prominence
                  — a returning user sees recovery at true parity with Create. The expandable model +
                  ALL restore-mode testIDs (btn-restore, restore-seed-input, btn-restore-confirm,
                  btn-restore-cancel) are unchanged; only the entry button's style + position change. */}
              <Pressable testID="btn-restore" style={S.secondaryBtn} onPress={() => { setMode('restore'); setErr(null); }}
                accessibilityRole="button" accessibilityLabel="Restore wallet" accessibilityHint="Recover a wallet from your 64-hex recovery seed">
                <Text style={S.secondaryBtnText}>Restore wallet</Text>
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
