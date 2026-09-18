import {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, TextInput, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {C} from '../config/palette';
import {S, isDark, inverseC} from '../styles';
import {STORAGE_KEY, PENDING_IDENTITY_STORAGE_KEY, BALANCE_TIMEOUT_MS} from '../config/constants';
import {base, validateSeed} from '../lib/format';
import {hexToWords, stringToWords, wordsToHex, validateMnemonic, wordsToString} from '../lib/bip39';
import {JOURNEY_STAMPS, hasStamp, loadJourney, awardStamp} from '../lib/journey';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {fetchWithTimeout, relayCapabilities, type RelayCapabilities} from '../services/relay';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {M} from '../i18n';
import {useReducedMotion} from '../hooks/useReducedMotion';
import {Logo, WordmarkLink} from './Logo';
import {SeedWords} from './SeedWords';
import {IconCheck} from './icons';
import {Walkthrough} from './Walkthrough';

export function Onboarding({relayUrl, onCreated, onRestored}: {relayUrl: string; onCreated: (id: Identity) => void; onRestored: (id: Identity) => void}) {
  // Trip Ready J1 — the first-run walkthrough gate. `walkthrough` is a tri-state:
  //   'checking' → the journey store hasn't loaded yet (render nothing; a flash of the create
  //                form before the walkthrough mounts would read as a glitch);
  //   true       → the walkthrough shows INSTEAD of the header+form (same SafeAreaView shell);
  //   false      → the create/restore screen, unchanged.
  // Done (Get started) OR Skip awards `walkthroughDone` — persisted, so the walkthrough never
  // shows again on relaunch (restore users see it too; it is educational, not a gate — they can
  // skip instantly). The gate reads the store once on mount; the award path is idempotent.
  //
  // The SAME mount read resumes an interrupted create. A wallet whose 24 words have not been
  // acknowledged lives under PENDING_IDENTITY_STORAGE_KEY, not under the app's identity key, so a
  // phone killed with the words on screen comes back here and gets the SAME words again (they are
  // derived from the seed) instead of skipping the backup forever. One read, both facts, so the
  // shell never flashes one answer before the other lands.
  const [walkthrough, setWalkthrough] = useState<'checking' | boolean>('checking');

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

  useEffect(() => {
    let alive = true;
    Promise.all([loadJourney(), AsyncStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)])
      .then(([j, pendingRaw]) => {
        if (!alive) return;
        setWalkthrough(!hasStamp(j, JOURNEY_STAMPS.walkthroughDone));
        if (pendingRaw === null) return;
        const pending = JSON.parse(pendingRaw) as Identity;
        setPendingId(pending);
        setUsername(pending.username);
        setBackupMnemonic(hexToWords(pending.secretHex));
      })
      .catch((e: unknown) => {
        // No silent errors: a corrupt pending record is the one case where a user could be left
        // holding words for a wallet that will never exist, so it is named in the log and the
        // screen falls back to a clean create rather than a half-resumed one.
        console.warn(`onboarding: could not read the first-run state: ${e instanceof Error ? e.message : String(e)}`);
        if (alive) setWalkthrough(false);
      });
    return () => { alive = false; };
  }, []);


  // Trip Ready J2B — the RECOVERY SAVED passport-stamp beat (~750 ms, auto-advances; zero extra
  // mandatory taps — it plays while the faucet request is already done), then this screen is over
  // and `onCreated` hands the wallet to the app's first-run router (App.tsx), which decides what
  // comes next. In-memory only: the beat is a moment, not a gate, and an app killed during it
  // simply lands wherever the router says on the next launch.
  //
  // `recoverySaved` is awarded when the beat starts — the acknowledgment IS the save (the words
  // were written down at the gate; the beat only marks it). The `flowUnderstood` stamp is NOT this
  // screen's business any more: it is awarded by the practice payment actually settling.
  const [recoveryBeat, setRecoveryBeat] = useState(false);
  const reducedMotion = useReducedMotion();
  // The relay capability probe, held as the PROMISE and not as its answer. `finishCreate` runs the
  // instant the user taps Continue on the backup screen, which is routinely BEFORE a slow relay has
  // answered — sampling a boolean that still said "no" created the wallet unfunded against a
  // perfectly healthy relay, with nothing on screen or in the log to say so. Awaiting the promise
  // is what makes the answer honest instead of merely early; nothing renders off it, so it is a ref.
  const demoFaucetProbe = useRef<Promise<RelayCapabilities> | null>(null);
  useEffect(() => { demoFaucetProbe.current = relayCapabilities(relayUrl); }, [relayUrl]);

  // Generate a fresh on-device Ed25519 keypair, park it as PENDING, then SHOW THE BIP-39 BACKUP
  // before it becomes the app's identity. The faucet fund is DEFERRED to `finishCreate` (run after
  // the user acknowledges the backup) so the wallet is never entered without the user having seen
  // their 24 recovery words. The mnemonic is derived ON-DEMAND from secretHex via `hexToWords`.
  //
  // PENDING, not the identity, is the whole point: the key is written to a key nothing else reads,
  // so a phone killed with the words on screen has no wallet to skip the backup for. `finishCreate`
  // is the only promotion.
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
      await AsyncStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, JSON.stringify(id));
      const words = hexToWords(kp.secretHex);
      setPendingId(id);
      setBackupMnemonic(words);
      setBusy(false);
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }

  // Continue create AFTER the user acknowledges the backup. DEMO credit is best-effort and only
  // requested when the relay explicitly advertises a faucet. Wallet creation never depends on
  // funding, and a relay without a faucet must not produce a scary failure screen.
  async function finishCreate() {
    if (!pendingId || busy) return;
    const id = pendingId;
    setBusy(true);
    setErr(null);
    // The promotion: THIS is the moment the generated key becomes the wallet's identity, because
    // this is the moment its owner has said they can get it back. A failed write leaves the words
    // on screen with the reason under them — never a wallet the user was told about but does not
    // have, and never a silent swallow.
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
      await AsyncStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY);
    } catch (e: unknown) {
      console.warn(`onboarding: could not save the new wallet: ${e instanceof Error ? e.message : String(e)}`);
      setErr(M.onboarding.errSaveWallet);
      setBusy(false);
      return;
    }
    setBackupMnemonic(null);
    setBackupChecked(false);
    const probe = demoFaucetProbe.current;
    if (probe === null) {
      // Not reachable through the UI — the mount effect starts the probe before any tap can get
      // here — but "the wallet was created unfunded and said nothing" is the exact failure this
      // path exists to prevent, so it is logged rather than assumed away.
      console.warn('onboarding: no relay capability probe was started — creating the wallet without asking for demo funds');
    } else if ((await probe).demoFaucet) {
      try {
        const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/faucet`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({account: id.publicHex})}, BALANCE_TIMEOUT_MS);
        if (!r.ok) console.warn(`faucet request failed: ${r.status}`);
      } catch (e) {
        console.warn('faucet fetch failed:', e instanceof Error ? e.message : String(e));
      }
    }
    void awardStamp(JOURNEY_STAMPS.recoverySaved);
    setBusy(false);
    setRecoveryBeat(true);
  }

  // The RECOVERY SAVED stamp choreography: a passport-stamp landing (tangerine ring, slight
  // overshoot, resting -3° tilt) that holds a beat then hands the wallet to the app's first-run
  // router. Reduced motion → simple fade, same timing. The alive-ref makes the unmount case safe.
  const beatAlive = useRef(true);
  useEffect(() => { beatAlive.current = true; return () => { beatAlive.current = false; }; }, []);
  const stampSc = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const stampOp = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (!recoveryBeat || pendingId === null) return;
    const id = pendingId;
    if (!reducedMotion) {
      Animated.parallel([
        Animated.spring(stampSc, {toValue: 1, friction: 4.5, tension: 64, delay: 90, useNativeDriver: false}),
        Animated.timing(stampOp, {toValue: 1, duration: 180, delay: 90, easing: Easing.out(Easing.cubic), useNativeDriver: false}),
      ]).start();
    }
    const t = setTimeout(() => { if (beatAlive.current) onCreated(id); }, 750);
    return () => { clearTimeout(t); };
    // `reducedMotion`, `stampSc` and `stampOp` are deliberately absent: the two Animated values are
    // refs (one identity for this mount) and the motion preference is read once, when the beat
    // starts — re-running this effect would replay the stamp mid-landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryBeat, pendingId, onCreated]);

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
      onRestored(id);
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
      ) : recoveryBeat ? (
        /* Trip Ready J2 — the RECOVERY SAVED beat (UX hardening 2026-08-23: was a tiny chip on
           ~96% blank porcelain — read as a crash flash; now a full-bleed INK moment, the ONE
           deliberate dark beat of onboarding). A porcelain passport stamp lands (overshoot,
           resting -6° tilt) under the line that makes the words matter, holds a beat, then hands
           over to the first-run router. Zero extra mandatory taps. */
        <View testID="recovery-saved-stamp" style={S.inkBeat}>
          <Animated.View
            style={[S.inkStamp, {opacity: stampOp, transform: [{scale: stampSc}, {rotate: '-6deg'}]}]}>
            <IconCheck size={15} color={inverseC().brandText} />
            <Text style={S.inkStampText}>{M.onboarding.recoverySaved.stamp}</Text>
          </Animated.View>
          <Text style={S.inkBeatLine}>{M.onboarding.recoverySaved.line}</Text>
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
              {/* The save can fail, and when it does the words on screen are for a wallet that
                  does not exist yet — so the reason renders here, above the button that will try
                  again, rather than being swallowed into a screen that simply does nothing. */}
              {err ? <Text testID="backup-err" style={S.err}>{err}</Text> : null}
              <Pressable testID="btn-mnemonic-continue" style={[S.primary, (!backupChecked || busy) && S.disabledFlat]} disabled={!backupChecked || busy} onPress={finishCreate}
                accessibilityRole="button" accessibilityLabel={M.onboarding.continue} accessibilityState={{disabled: !backupChecked || busy}}>
                <Text style={[S.primaryText, (!backupChecked || busy) && S.disabledText]}>{M.onboarding.continue}</Text>
              </Pressable>
            </>
          ) : pendingId && busy ? (
            /* The tail of the create sequence: the capability probe is awaited here and, when the
               relay has a faucet, the demo-funds request goes out. Short, but not instant — a slow
               relay is exactly when it isn't — and the logo-and-tagline-only screen this replaces
               read as a hang at the one moment the user has just been told to trust the app. */
            <View testID="onboard-finishing" style={S.center}>
              <ActivityIndicator size="large" color={C.brandText} />
              <Text style={S.dim2}>{M.onboarding.create.busy}</Text>
            </View>
          ) : mode === 'restore' ? (
            <>
              {restoreMode === 'mnemonic' ? (
                <>
                  <Text style={S.label}>{M.onboarding.restore.phraseLabel}</Text>
                  <TextInput testID="restore-mnemonic-input" style={S.seedInput} value={mnemonicText} onChangeText={setMnemonicText} placeholder={M.onboarding.restore.phrasePlaceholder} placeholderTextColor={C.sub2} autoCapitalize="none" autoCorrect={false} multiline accessibilityLabel={M.onboarding.restore.phraseLabel} />
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
                accessibilityRole="button" accessibilityLabel={M.onboarding.restore.action} accessibilityState={{disabled: busy || (restoreMode === 'mnemonic' ? mnemonicText : seed).trim() === ''}}>
                <Text style={[S.primaryText, (busy || (restoreMode === 'mnemonic' ? mnemonicText : seed).trim() === '') && S.disabledText]}>{busy ? M.onboarding.restore.busy : M.onboarding.restore.action}</Text>
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
                accessibilityRole="button" accessibilityLabel={M.onboarding.create.action} accessibilityState={{disabled: busy}}>
                <Text style={[S.primaryText, busy && S.disabledText]}>{busy ? M.onboarding.create.busy : M.onboarding.create.action}</Text>
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
