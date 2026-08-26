import {useEffect, useRef, useState} from 'react';
import {Animated, Easing, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, TextInput, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {STORAGE_KEY, BALANCE_TIMEOUT_MS} from '../config/constants';
import {base, validateSeed} from '../lib/format';
import {hexToWords, stringToWords, wordsToHex, validateMnemonic, wordsToString} from '../lib/bip39';
import {JOURNEY_STAMPS, hasStamp, loadJourney, awardStamp} from '../lib/journey';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {fetchWithTimeout} from '../services/relay';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {M} from '../i18n';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {Logo, WordmarkLink} from './Logo';
import {SeedWords} from './SeedWords';
import {IconCheck} from './icons';
import {Walkthrough} from './Walkthrough';
import {Rehearsal} from './Rehearsal';

export function Onboarding({relayUrl, onCreated}: {relayUrl: string; onCreated: (id: Identity) => void}) {
  // Trip Ready J1 — the first-run walkthrough gate. `walkthrough` is a tri-state:
  //   'checking' → the journey store hasn't loaded yet (render nothing; a flash of the create
  //                form before the walkthrough mounts would read as a glitch);
  //   true       → the walkthrough shows INSTEAD of the header+form (same SafeAreaView shell);
  //   false      → the create/restore screen, unchanged.
  // Done (Get started) OR Skip awards `walkthroughDone` — persisted, so the walkthrough never
  // shows again on relaunch (restore users see it too; it is educational, not a gate — they can
  // skip instantly). The gate reads the store once on mount; the award path is idempotent.
  const [walkthrough, setWalkthrough] = useState<'checking' | boolean>('checking');
  useEffect(() => {
    let alive = true;
    loadJourney().then(j => { if (alive) setWalkthrough(!hasStamp(j, JOURNEY_STAMPS.walkthroughDone)); }).catch(() => { if (alive) setWalkthrough(false); });
    return () => { alive = false; };
  }, []);

  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<Identity | null>(null);
  const [mode, setMode] = useState<'create' | 'restore'>('create');
  const [seed, setSeed] = useState('');
  // Restore input mode: mnemonic words (default — the human-friendly form Backup reveals) or hex
  // (the raw 64-char seed, kept as a fallback for users who copied it from an older backup). The
  // toggle switches the input; `restore()` branches on this to pick the right codec path.
  const [restoreMode, setRestoreMode] = useState<'mnemonic' | 'hex'>('mnemonic');
  const [mnemonicText, setMnemonicText] = useState('');
  // BIP-39 backup gate (create flow). `backupMnemonic` holds the 24 words to display when non-null;
  // the backup screen renders INSTEAD of the create/restore form until the user checks the
  // acknowledgement and taps Continue. `backupChecked` is a pure UX gate (not a security mechanism).
  const [backupMnemonic, setBackupMnemonic] = useState<string[] | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  // Own-seed (create flow): ALTERNATIVE to the fresh random key — a returning user can paste the
  // 24 words OR the 64-hex seed from an existing backup and create THIS device's wallet from it
  // (same faucet + backup gate as a plain create — distinct from mode='restore', which skips both).
  // `ownSeedOpen` toggles the input's visibility; empty input keeps the random-generate default.
  const [ownSeedOpen, setOwnSeedOpen] = useState(false);
  const [ownSeedText, setOwnSeedText] = useState('');
  // Copy feedback for the backup gate's "Copy words" button. Without it the only copy path was
  // mouse-selecting the numbered chips — which drags the position numbers into the selection
  // (the 2026-08-16 founder report). The button copies the PURE space-joined words.
  const {copied, copy: doCopy} = useCopyFeedback();

  // Trip Ready J2B — the create path's post-backup sequence, in-memory only (deliberately NO
  // persisted "must show" state: an app killed mid-sequence simply lands in the wallet next
  // launch — accepted by the spec). States:
  //   'recoverySaved' → the RECOVERY SAVED passport-stamp beat (~750ms, auto-advances; zero
  //                     extra mandatory taps — it plays while the faucet request is already
  //                     done); then the rehearsal.
  //   'rehearsal'     → the 3-beat payment rehearsal (Rehearsal.tsx); exits call onCreated.
  //   null            → no sequence (restore path + relaunch never enter it).
  // The flowUnderstood stamp is awarded by Rehearsal itself (on reaching beat 3); recoverySaved
  // is awarded here the moment the beat starts (the acknowledgment IS the save — the words were
  // written down at the gate; the beat only marks it).
  const [beat, setBeat] = useState<'recoverySaved' | 'rehearsal' | null>(null);
  const reducedMotion = useReducedMotion();

  // Generate a fresh on-device Ed25519 keypair, persist it, then SHOW THE BIP-39 BACKUP before entering
  // the wallet. The faucet fund is DEFERRED to `finishCreate` (run after the user acknowledges the
  // backup) so the wallet is never entered without the user having seen their 24 recovery words. The
  // mnemonic is derived ON-DEMAND from secretHex via `hexToWords` — no storage change.
  async function create() {
    const name = username.trim() || 'me';
    // Own-seed parse (auto-detected form): a bare 64-hex string is the raw seed; anything else is
    // treated as the mnemonic. Invalid input stays on the form with an error — never a silent
    // wrong-wallet. Empty input falls through to the fresh random generateKeypair default.
    let hex: string | undefined;
    const own = ownSeedText.trim();
    if (own !== '') {
      if (/^[0-9a-fA-F]{64}$/.test(own)) {
        hex = own.toLowerCase();
      } else {
        const words = stringToWords(own);
        if (!validateMnemonic(words)) {
          setErr(M.onboarding.errOwnSeed);
          return;
        }
        hex = wordsToHex(words);
      }
    }
    setBusy(true); setErr(null);
    try {
      const kp = hex ? await DpayCore.keypairFromSecret(hex) : await DpayCore.generateKeypair();
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
  //
  // Trip Ready J2B: on faucet success the create path now plays the in-memory beat sequence
  // (RECOVERY SAVED stamp → rehearsal → onCreated) instead of calling onCreated directly. The
  // faucet-failed path is UNCHANGED (btn-onboard-continue → onCreated — no beat, no rehearsal:
  // the moment reads as recovery-from-a-hiccup, not celebration).
  async function finishCreate() {
    if (!pendingId) return;
    const id = pendingId;
    setBackupMnemonic(null);
    setBackupChecked(false);
    setBusy(true);
    try {
      await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex})}, BALANCE_TIMEOUT_MS);
      void awardStamp(JOURNEY_STAMPS.recoverySaved);
      setBeat('recoverySaved');
    } catch (e) {
      console.warn('faucet fetch failed:', e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // The RECOVERY SAVED stamp choreography: a passport-stamp landing (tangerine ring, slight
  // overshoot, resting -3° tilt) that holds a beat then auto-advances to the rehearsal. Reduced
  // motion → simple fade, same timing. The alive-ref makes the unmount case safe.
  const beatAlive = useRef(true);
  useEffect(() => { beatAlive.current = true; return () => { beatAlive.current = false; }; }, []);
  const stampSc = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const stampOp = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (beat !== 'recoverySaved') return;
    if (!reducedMotion) {
      Animated.parallel([
        Animated.spring(stampSc, {toValue: 1, friction: 4.5, tension: 64, delay: 90, useNativeDriver: false}),
        Animated.timing(stampOp, {toValue: 1, duration: 180, delay: 90, easing: Easing.out(Easing.cubic), useNativeDriver: false}),
      ]).start();
    }
    const t = setTimeout(() => { if (beatAlive.current) setBeat('rehearsal'); }, 750);
    return () => { clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat]);

  // Restore a wallet from EITHER the 24-word BIP-39 mnemonic (default) OR the 64-hex recovery seed
  // (legacy/advanced fallback). Both paths converge on `keypairFromSecret(hex)` — the mnemonic is
  // just the human-readable serialization of the same 32-byte seed (see app/lib/bip39.ts). Mirrors
  // `create` but derives the keypair from the entered seed instead of generating a random one, and
  // skips the faucet — a restored wallet already has its on-chain funds. One seed recovers BOTH
  // rails: the IC Ed25519 key (this keypair) AND the Solana key (SLIP-10 derivation, see
  // app/solana/identity.ts).
  async function restore() {
    setErr(null);
    const name = username.trim() || 'me';
    let hex: string;
    if (restoreMode === 'mnemonic') {
      const words = stringToWords(mnemonicText);
      if (!validateMnemonic(words)) {
        setErr(M.onboarding.errWords);
        return;
      }
      hex = wordsToHex(words);
    } else {
      const e = validateSeed(seed);
      if (e) { setErr(e); return; }
      hex = seed.trim().toLowerCase();
    }
    setBusy(true);
    try {
      const kp = await DpayCore.keypairFromSecret(hex);
      const id: Identity = {secretHex: kp.secretHex, publicHex: kp.publicHex, username: name};
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      onCreated(id);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  return (
    <SafeAreaView style={S.root}>
      <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} translucent={false} />
      {/* Trip Ready J1 — the walkthrough renders in the SAME shell (SafeAreaView + StatusBar)
          instead of the header+form. Exit paths (Get started or Skip) award `walkthroughDone`
          and reveal the existing create/restore screen unchanged below. 'checking' renders
          nothing but the shell so the create form never flashes before the gate resolves. */}
      {walkthrough === 'checking' ? null : walkthrough ? (
        <Walkthrough
          onDone={() => { void awardStamp(JOURNEY_STAMPS.walkthroughDone).then(() => setWalkthrough(false)); }}
          onSkip={() => { void awardStamp(JOURNEY_STAMPS.walkthroughDone).then(() => setWalkthrough(false)); }}
        />
      ) : beat === 'rehearsal' ? (
        /* Trip Ready J3 — the payment rehearsal. Both exits enter the wallet (default Pay tab
           is exactly what "Try with demo funds" wants; Explore wallet is the same entry, the
           label difference is about intent, not destination). */
        <Rehearsal
          onTry={() => { if (pendingId) onCreated(pendingId); }}
          onSkip={() => { if (pendingId) onCreated(pendingId); }}
        />
      ) : beat === 'recoverySaved' ? (
        /* Trip Ready J2 — the RECOVERY SAVED beat (UX hardening 2026-08-23: was a tiny chip on
           ~96% blank porcelain — read as a crash flash; now a full-bleed INK moment, the ONE
           deliberate dark beat of onboarding). A porcelain passport stamp lands (overshoot,
           resting -6° tilt) under the line that makes the words matter, holds a beat, then
           auto-advances to the rehearsal. Zero extra mandatory taps. */
        <View testID="recovery-saved-stamp" style={S.inkBeat}>
          <Animated.View
            style={[S.inkStamp, {opacity: stampOp, transform: [{scale: stampSc}, {rotate: '-6deg'}]}]}>
            <IconCheck size={15} color={C.brand} />
            <Text style={S.inkStampText}>{M.onboarding.recoverySaved.stamp}</Text>
          </Animated.View>
          <Text style={S.inkBeatLine}>{M.onboarding.recoverySaved.line}</Text>
          <Text style={S.inkBeatSub}>{M.onboarding.recoverySaved.sub}</Text>
        </View>
      ) : (
      <KeyboardAvoidingView
        style={{flex: 1}}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 0}>
        <ScrollView style={{flex: 1}} contentContainerStyle={S.onboard} keyboardShouldPersistTaps="handled">
          <Logo size={104} />
          <WordmarkLink style={S.wordmarkBig} />
          <Text style={S.onboardSub}>{M.onboarding.tagline}</Text>
          <Text style={S.dim2}>{M.onboarding.custody}</Text>
          {backupMnemonic ? (
            <>
              <Text style={S.wordmarkBig}>{M.onboarding.backup.title}</Text>
              {/* Trip Ready J2 — the ownership ritual line. ABOVE the warning, in ink: the moment
                  reads as ownership first, risk second. The gate below stays EXACTLY as strong. */}
              <Text style={S.backupRitualNote}>{M.onboarding.backup.ritual}</Text>
              <Text style={S.warnNote}>{M.onboarding.backup.warning}</Text>
              <SeedWords words={backupMnemonic} testID="mnemonic-backup" />
              <Pressable testID="btn-mnemonic-copy" style={S.linkBtn} onPress={() => { if (backupMnemonic) void doCopy(wordsToString(backupMnemonic)); }}
                accessibilityRole="button"
                accessibilityLabel={copied === 'clipboard' ? M.onboarding.backup.wordsCopied : copied === 'shared' ? M.onboarding.backup.wordsShared : M.onboarding.backup.copyWords}
                accessibilityHint={M.onboarding.backup.copyWordsHint}
                accessibilityState={{disabled: false}}>
                <Text style={S.linkText}>{copied === 'clipboard' ? M.onboarding.backup.copiedCheck : copied === 'shared' ? M.onboarding.backup.sharedCheck : M.onboarding.backup.copyWords}</Text>
              </Pressable>
              <Pressable testID="mnemonic-backup-checkbox" style={{flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', marginTop: 4, marginBottom: 10, minHeight: 44}} onPress={() => setBackupChecked(!backupChecked)}
                accessibilityRole="checkbox" accessibilityLabel={M.onboarding.backup.ack} accessibilityState={{checked: backupChecked}}>
                <View style={{width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: backupChecked ? C.brand : C.sub2, backgroundColor: backupChecked ? C.brand : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10}}>
                  {/* P4 — the '✓' glyph Text became IconCheck (the box's checked state is also
                      conveyed by accessibilityState on the checkbox Pressable). */}
                  {backupChecked ? <IconCheck size={14} color={C.brandInk} /> : null}
                </View>
                <Text style={{color: C.sub, fontSize: 15, flex: 1}}>{M.onboarding.backup.ack}</Text>
              </Pressable>
              <Pressable testID="btn-mnemonic-continue" style={[S.primary, !backupChecked && S.disabledFlat]} disabled={!backupChecked} onPress={finishCreate}
                accessibilityRole="button" accessibilityLabel={M.onboarding.continue} accessibilityState={{disabled: !backupChecked}}>
                <Text style={S.primaryText}>{M.onboarding.continue}</Text>
              </Pressable>
            </>
          ) : pendingId ? (
            <>
              <Text testID="onboard-faucet-failed" style={S.warnNote}>{M.onboarding.faucetFailed}</Text>
              <Pressable testID="btn-onboard-continue" style={S.primary} onPress={() => onCreated(pendingId!)}
                accessibilityRole="button" accessibilityLabel={M.onboarding.continue} accessibilityState={{disabled: false}}>
                <Text style={S.primaryText}>{M.onboarding.continue}</Text>
              </Pressable>
            </>
          ) : mode === 'restore' ? (
            <>
              {restoreMode === 'mnemonic' ? (
                <>
                  <Text style={S.label}>{M.onboarding.restore.phraseLabel}</Text>
                  <TextInput testID="restore-mnemonic-input" style={S.seedInput} value={mnemonicText} onChangeText={setMnemonicText} placeholder={M.onboarding.restore.phrasePlaceholder} placeholderTextColor={C.sub2} autoCapitalize="none" autoCorrect={false} multiline accessibilityLabel={M.onboarding.restore.phraseLabel} accessibilityHint={M.onboarding.restore.phraseHint} />
                  <Text style={S.dim2}>{M.onboarding.restore.phraseNote}</Text>
                </>
              ) : (
                <>
                  <Text style={S.label}>{M.onboarding.restore.seedLabel}</Text>
                  <TextInput testID="restore-seed-input" style={S.seedInput} value={seed} onChangeText={setSeed} placeholder={M.onboarding.restore.seedPlaceholder} placeholderTextColor={C.sub2} autoCapitalize="none" autoCorrect={false} multiline accessibilityLabel={M.onboarding.restore.seedLabel} accessibilityHint={M.onboarding.restore.seedHint} />
                  <Text style={S.dim2}>{M.onboarding.restore.seedNote}</Text>
                </>
              )}
              <Pressable testID="btn-restore-mode-toggle" style={S.linkBtn} onPress={() => { setRestoreMode(restoreMode === 'mnemonic' ? 'hex' : 'mnemonic'); setErr(null); }}
                accessibilityRole="button" accessibilityLabel={restoreMode === 'mnemonic' ? M.onboarding.restore.enterHex : M.onboarding.restore.enterWords}>
                <Text style={S.linkText}>{restoreMode === 'mnemonic' ? M.onboarding.restore.enterHex : M.onboarding.restore.enterWords}</Text>
              </Pressable>
              <Text style={S.label}>{M.onboarding.usernameLabel}</Text>
              <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder={M.onboarding.usernamePlaceholder} placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} accessibilityLabel={M.onboarding.usernameA11y} accessibilityHint={M.onboarding.usernameHint} />
              {err ? <Text style={S.err}>{err}</Text> : null}
                  <Pressable testID="btn-restore-confirm" style={[S.primary, (busy || (restoreMode === 'mnemonic' ? mnemonicText : seed).trim() === '') && S.disabledFlat]} disabled={busy || (restoreMode === 'mnemonic' ? mnemonicText : seed).trim() === ''} onPress={restore}
                accessibilityRole="button" accessibilityLabel={M.onboarding.restore.action} accessibilityHint={restoreMode === 'mnemonic' ? M.onboarding.restore.hintMnemonic : M.onboarding.restore.hintHex} accessibilityState={{disabled: busy || (restoreMode === 'mnemonic' ? mnemonicText : seed).trim() === ''}}>
                <Text style={S.primaryText}>{busy ? M.onboarding.restore.busy : M.onboarding.restore.action}</Text>
              </Pressable>
              <Pressable testID="btn-restore-cancel" style={S.linkBtn} onPress={() => { setMode('create'); setSeed(''); setMnemonicText(''); setRestoreMode('mnemonic'); setErr(null); }}
                accessibilityRole="button" accessibilityLabel={M.onboarding.restore.cancelA11y} accessibilityHint={M.onboarding.restore.cancelHint}>
                <Text style={S.linkTextMuted}>{M.common.cancel}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={S.label}>{M.onboarding.usernameLabel}</Text>
              <TextInput testID="username-input" style={S.usernameInput} value={username} onChangeText={setUsername} placeholder={M.onboarding.usernamePlaceholder} placeholderTextColor={C.sub2} autoCapitalize="words" autoCorrect={false} onSubmitEditing={busy ? undefined : create} accessibilityLabel={M.onboarding.usernameA11y} accessibilityHint={M.onboarding.usernameHint} />
              {/* Own-seed alternative (2026-08-18): create from an EXISTING seed instead of the
                  generated random one. Collapsed by default so first-time users see the plain
                  create form; the link reveals the input. Same faucet + backup gate downstream. */}
              <Pressable testID="btn-own-seed-toggle" style={S.linkBtn} onPress={() => { setOwnSeedOpen(!ownSeedOpen); setErr(null); }}
                accessibilityRole="button"
                accessibilityLabel={ownSeedOpen ? M.onboarding.ownSeed.useRandom : M.onboarding.ownSeed.useOwn}
                accessibilityHint={M.onboarding.ownSeed.toggleHint}>
                <Text style={S.linkText}>{ownSeedOpen ? M.onboarding.ownSeed.useRandom : M.onboarding.ownSeed.useOwn}</Text>
              </Pressable>
              {ownSeedOpen ? (
                <>
                  <TextInput testID="own-seed-input" style={S.seedInput} value={ownSeedText} onChangeText={setOwnSeedText} placeholder={M.onboarding.ownSeed.placeholder} placeholderTextColor={C.sub2} autoCapitalize="none" autoCorrect={false} multiline accessibilityLabel={M.onboarding.ownSeed.a11y} accessibilityHint={M.onboarding.ownSeed.hint} />
                  <Text style={S.dim2}>{M.onboarding.ownSeed.note}</Text>
                </>
              ) : null}
              {err ? <Text style={S.err}>{err}</Text> : null}
              <Pressable testID="btn-create" style={[S.primary, busy && S.disabledFlat]} disabled={busy} onPress={create}
                accessibilityRole="button" accessibilityLabel={M.onboarding.create.action} accessibilityHint={M.onboarding.create.hint} accessibilityState={{disabled: busy}}>
                <Text style={S.primaryText}>{busy ? M.onboarding.create.busy : M.onboarding.create.action}</Text>
              </Pressable>
              {/* Restore entry — promoted (UX fix 2026-08-10) from a muted bottom link (S.linkBtn /
                  S.linkTextMuted) to S.secondaryBtn / S.secondaryBtnText, and repositioned to sit
                  IMMEDIATELY after Create. Create stays the filled-brand default (primary); Restore
                  is now equal visual weight (same 56pt, full-width, bordered) but distinct prominence
                  — a returning user sees recovery at true parity with Create. The expandable model +
                  ALL restore-mode testIDs (btn-restore, restore-seed-input, btn-restore-confirm,
                  btn-restore-cancel) are unchanged; only the entry button's style + position change. */}
              <Pressable testID="btn-restore" style={S.secondaryBtn} onPress={() => { setMode('restore'); setErr(null); }}
                accessibilityRole="button" accessibilityLabel={M.onboarding.restore.action} accessibilityHint={M.onboarding.restore.entryHint}>
                <Text style={S.secondaryBtnText}>{M.onboarding.restore.action}</Text>
              </Pressable>
              <Text style={S.dim2}>{M.onboarding.demoNote}</Text>
              <Text style={S.dpayGlyphNote}><Text style={S.dpayGlyph}>∂</Text>{M.onboarding.demoGlyphNote}</Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}
