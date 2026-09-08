import {useEffect, useMemo, useState} from 'react';
import {Linking, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, TextInput, View} from 'react-native';
import {C} from '../config/palette';
import {PRIVACY_URL, solanaRpcUrl} from '../config/constants';
import {S, isDark} from '../styles';
import {validateSeed} from '../lib/format';
import {hexToWords, stringToWords, wordsToHex, wordsToString, validateMnemonic} from '../lib/bip39';
import type {Identity} from '../lib/types';
import {DpayCore} from '../services/native';
import {useHotkeys} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {SheetOverlay} from './SheetOverlay';
import {AppModal} from './AppModal';
import {SeedWords} from './SeedWords';
import {IconAuto, IconCheck, IconChevronDown, IconClose, IconExternalLink, IconInfo, IconMoon, IconSun} from './icons';
import {Walkthrough} from './Walkthrough';
import {PassportArchive} from './TripPassport';
import {computeReadiness, type ReadinessKey} from '../lib/readiness';
import {JOURNEY_STAMPS, awardStamp, useJourney} from '../lib/journey';
import {choiceLabel, type ThemeOverride} from '../config/theme';
import {LOCALES, LOCALE_ENDONYM, type LocaleChoice} from '../i18n/locale';
import {type HomeCurrency, currencyName, offerableCurrencies, railsLabel} from '../config/currency';
import type {SelectableAsset} from '../config/assets';
import {M} from '../i18n';

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
export function SettingsSheet({relayUrl, setRelayUrl, setSolanaRpc, onSolanaRpcApplied, onClose, onReset, onRestore, secretHex, username, themeChoice, onSetTheme, localeChoice, onSetLocale, homeCurrency, onSetHomeCurrency, assets, openBackup, onOpenStep}: {
  relayUrl: string;
  setRelayUrl: (s: string) => void;
  // Apply + persist the Solana endpoint (App.tsx `persistSolanaRpc`). Unlike `setRelayUrl` this one
  // THROWS on a refusal — plain http, a devnet host, an unparseable string — and the message is
  // written for the user, so the row below renders it verbatim rather than swallowing it.
  setSolanaRpc: (s: string) => void;
  // Fired after an ACCEPTED endpoint change so the SOL rail re-reads at once instead of at its idle
  // cadence. The relay row gets this for free (its URL is a poll dependency); the Solana endpoint
  // is read per-request, so an operator who has just fixed a dead key would otherwise stare at the
  // same dashes for half a minute and conclude the fix did not work.
  onSolanaRpcApplied: () => void;
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
  // Wave 8 theme — the stored CHOICE (null = Auto/follow the OS scheme) + the single mutator.
  // The header offers the quick Light↔Dark flip; this sheet's segmented control is the full
  // three-way choice (Light / Dark / Auto). App.tsx owns the state + AsyncStorage persistence.
  themeChoice: ThemeOverride | null;
  onSetTheme: (t: ThemeOverride | null) => void;
  // The stored language CHOICE (null = Auto/follow the device locale) + its single mutator.
  localeChoice: LocaleChoice;
  onSetLocale: (l: LocaleChoice) => void;
  // The HOME CURRENCY — the one currency the wallet is "in" — plus its single mutator. Unlike the
  // theme and the language there is no Auto: by the time this sheet can be opened a currency has
  // been chosen, so the control is a straight choice among the currencies the catalog can realise.
  // `assets` is the wallet's visible list, and is what decides which currencies are offerable at
  // all — the same list the first-run chooser reads, so the two can never disagree.
  homeCurrency: HomeCurrency;
  onSetHomeCurrency: (c: HomeCurrency) => void;
  assets: SelectableAsset[];
  // Passport deep-link (founder ask 2026-08-24): auto-open the backup reveal ONCE on mount —
  // the unfilled "BACKED UP" stamp's destination (Wallet sets it when routing from the
  // passport). A manual gear-open (absent/false) keeps the normal two-step confirm gate.
  openBackup?: boolean;
  // Passport deep-link: hand a wallet-home step key (fundsReady → Balances, paymentTested →
  // Pay) up to Wallet's routing map after this sheet closes itself. Optional — Settings-hosted
  // archive instances without it fall back to closing both surfaces.
  onOpenStep?: (key: ReadinessKey) => void;
}) {
  // Esc closes the sheet — EXCEPT while the "How dpay works" replay Modal is open, when the
  // Modal's own Walkthrough escape handler owns the key (otherwise one Esc would close both).
  const [howItWorks, setHowItWorks] = useState(false);
  // Trip Ready J5b — the read-only passport archive modal (the permanent home after the
  // Balances card collapses). Joins the howItWorks escape gate: while open, the Modal's own
  // escape owns the key (one Esc closes one thing).
  const [tripReadyOpen, setTripReadyOpen] = useState(false);
  // Live n/4 for the Trip readiness row (same source as the strip + archive — no second truth).
  const {journey} = useJourney();
  const tripReadiness = useMemo(() => computeReadiness(journey), [journey]);
  // The active currency's whole group on one line ("ckUSDC · Internet Computer, USDC · Solana") —
  // the group shape the first-run chooser shows per rail, so "Main currency: USD" never reads as
  // ONE token. Preferred rail first; null only if the catalog dropped every rail of the currency.
  const mainCurrencyGroup = railsLabel(homeCurrency, assets);
  useHotkeys({escape: onClose}, {enabled: !howItWorks && !tripReadyOpen});
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
  // seed-input form; `restoreSeed` holds the user-entered seed (24 BIP-39 words OR 64-hex —
  // auto-detected, since Backup reveals words by default and hex only behind a toggle, so a user
  // who backed up the default way could not previously restore from Settings at all);
  // `restoreBusy` gates the confirm button during the keypairFromSecret FFI call; `restoreErr`
  // surfaces a validation/derivation failure (bad seed shape, FFI throw). On a successful confirm
  // the parent replaces the identity and this sheet unmounts (App.tsx setIdentity → wallet
  // re-mounts under the new key).
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

  // Passport deep-link: fires the same state btn-backup-confirm sets (the reveal itself — a
  // deliberate stamp tap is not the accidental shoulder-surf the two-step gate guards against).
  useEffect(() => { if (openBackup) setBackupRevealed(true); }, [openBackup]);

  const relayClean = draftRelay.trim();
  const relayDirty = relayClean.length > 0 && relayClean !== lastApplied.trim();
  const applyRelay = () => { if (relayDirty) { setRelayUrl(draftRelay); setLastApplied(draftRelay.trim()); } };

  // The Solana endpoint row — the relay row's twin, with two deliberate differences.
  //
  //   • EMPTY IS A VALUE. `setSolanaRpcUrl('')` restores the endpoint baked into this build, so
  //     clearing the field is the way back and must therefore be applicable. (The relay row refuses
  //     an empty draft because a relay URL has no such fallback — there is nothing to fall back to.)
  //     After an apply the field is re-seeded from `solanaRpcUrl()`, so clearing it shows the user
  //     exactly which endpoint "empty" means.
  //   • APPLYING CAN FAIL. `setSolanaRpc` throws an actionable refusal; it is caught here and shown
  //     next to the input, and nothing is persisted on that path.
  const [draftSolRpc, setDraftSolRpc] = useState(solanaRpcUrl);
  const [appliedSolRpc, setAppliedSolRpc] = useState(solanaRpcUrl);
  const [solRpcErr, setSolRpcErr] = useState<string | null>(null);
  const solRpcDirty = draftSolRpc.trim() !== appliedSolRpc.trim();
  const applySolRpc = () => {
    if (!solRpcDirty) return;
    try {
      setSolanaRpc(draftSolRpc);
      setSolRpcErr(null);
      // Re-seed from the RESOLVED endpoint, not from the draft: an empty draft resolves to the
      // baked default, and showing that is how the user learns what clearing the field did.
      const active = solanaRpcUrl();
      setDraftSolRpc(active);
      setAppliedSolRpc(active);
      onSolanaRpcApplied();
    } catch (e: unknown) {
      setSolRpcErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Copy the seed via the shared clipboard-feedback hook (real clipboard on web, Share on native;
  // surfaces the "Copied ✓"/"Shared ✓" confirmation for 1500ms). BOTH copy actions award
  // `recoverySaved` (founder rule 2026-08-23: trip-prep checks auto-detect — copying the backup
  // IS backing up, whether it happens here or in Onboarding; the journey store is idempotent).
  const copySeed = () => { void doCopy(secretHex); void awardStamp(JOURNEY_STAMPS.recoverySaved); };

  // The 24 BIP-39 words for the mnemonic backup view. The 32-byte seed never changes for a given
  // identity, so this memoizes on `secretHex` (a prop) — one synchronous SHA-256 per identity, not
  // per render. Cheap enough to compute inline, but memoizing avoids a redundant encode on every
  // `copied`/format-toggle re-render.
  const mnemonicWords = useMemo(() => hexToWords(secretHex), [secretHex]);
  const mnemonicString = useMemo(() => wordsToString(mnemonicWords), [mnemonicWords]);
  const copyMnemonic = () => { void doCopy(mnemonicString); void awardStamp(JOURNEY_STAMPS.recoverySaved); };

  // Validate + derive + replace the identity from a pasted seed — 24 BIP-39 words (the default
  // Backup form) or 64-hex (the "Show as hex" form), auto-detected by shape. Mirrors
  // Onboarding.restore's dual-path convergence: words → validateMnemonic → wordsToHex; hex →
  // validateSeed. Then keypairFromSecret → build Identity (username preserved) → hand to onRestore
  // (App.tsx persists + setIdentity → wallet re-renders under the new key). On success we ALSO
  // dismiss the sheet: a Wallet re-render (not unmount) follows a non-null identity replace, so
  // without `onClose` the Settings sheet would stay open over the now-replaced wallet. Closing it
  // lands the user back at the wallet view (the natural "I just restored → show me my wallet"
  // expectation), and is symmetric with Reset (which makes the whole Wallet unmount). The form's
  // busy/error state stays co-located with the input (same idiom as Onboarding restore).
  function parseRestoreSeed(text: string): {hex: string} | {err: string} {
    const trimmed = text.trim();
    if (trimmed === '') return {err: M.settings.restore.errEmpty};
    // Hex shape: 64 chars, all hex digits. Everything else is treated as a word phrase.
    if (/^[0-9a-fA-F]{64}$/.test(trimmed.replace(/\s+/g, ''))) {
      const e = validateSeed(trimmed);
      if (e) return {err: e};
      return {hex: trimmed.toLowerCase()};
    }
    const words = stringToWords(trimmed);
    if (!validateMnemonic(words)) {
      return {err: M.settings.restore.errWords};
    }
    return {hex: wordsToHex(words)};
  }
  async function doRestore() {
    if (restoreBusy) return;
    const parsed = parseRestoreSeed(restoreSeed);
    if ('err' in parsed) { setRestoreErr(parsed.err); return; }
    const seed = parsed.hex;
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

  // Passport deep-links (founder ask 2026-08-24): an unfilled stamp tap routes to the surface
  // where that step completes. Steps that LIVE in Settings route locally (backup reveal,
  // walkthrough replay); the wallet-home steps (funds, first payment) close this sheet and
  // hand the key to Wallet's map via onOpenStep (or just close if no callback was threaded).
  // The archive always closes first.
  const goToPassportStep = (key: ReadinessKey) => {
    setTripReadyOpen(false);
    if (key === 'recoverySaved') { setBackupRevealed(true); return; }
    if (key === 'flowUnderstood') { setHowItWorks(true); return; }
    onClose();
    if (onOpenStep) onOpenStep(key);
  };

  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{M.settings.title}</Text>
          <Pressable testID="btn-settings-close" style={S.sheetClose} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.settings.close} accessibilityState={{disabled: false}}><IconClose size={18} color={C.sub} /></Pressable>
        </View>

        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          {/* Backup — reveal the IC seed (which ALSO derives the Solana key) behind a two-step confirm
              gate. Pure display + copy; the seed already lives in AsyncStorage. The warning names the
              BOTH-rails consequence so the user stores it before any shoulder-surf risk. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.backup.label}</Text>
            {backupRevealed ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>{M.settings.backup.warning}</Text>
                {seedFormat === 'mnemonic' ? (
                  <>
                    <SeedWords words={mnemonicWords} testID="mnemonic-words" />
                    <Pressable
                      testID="btn-copy-mnemonic"
                      style={[S.primaryWide, {marginTop: 16}]}
                      onPress={copyMnemonic}
                      accessibilityRole="button"
                      accessibilityLabel={copied === 'clipboard' ? M.settings.backup.wordsCopied : copied === 'shared' ? M.settings.backup.wordsShared : M.settings.backup.copyWords}
                      accessibilityHint={M.settings.backup.copyWordsHint}
                      accessibilityState={{disabled: false}}>
                      <Text style={S.primaryText}>{copied === 'clipboard' ? M.settings.backup.copiedCheck : copied === 'shared' ? M.settings.backup.sharedCheck : M.settings.backup.copyWords}</Text>
                    </Pressable>
                    <Pressable
                      testID="btn-backup-show-hex"
                      style={S.linkBtn}
                      onPress={() => setSeedFormat('hex')}
                      accessibilityRole="button"
                      accessibilityLabel={M.settings.backup.showAsHexA11y}
                      accessibilityHint={M.settings.backup.showAsHexHint}
                      accessibilityState={{disabled: false}}>
                      <Text style={S.linkTextMuted}>{M.settings.backup.showAsHex}</Text>
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
                      accessibilityLabel={copied === 'clipboard' ? M.settings.backup.seedCopied : copied === 'shared' ? M.settings.backup.seedShared : M.settings.backup.copySeed}
                      accessibilityHint={M.settings.backup.copySeedHint}
                      accessibilityState={{disabled: false}}>
                      <Text style={S.primaryText}>{copied === 'clipboard' ? M.settings.backup.copiedCheck : copied === 'shared' ? M.settings.backup.sharedCheck : M.settings.backup.copySeed}</Text>
                    </Pressable>
                    <Pressable
                      testID="btn-backup-show-hex"
                      style={S.linkBtn}
                      onPress={() => setSeedFormat('mnemonic')}
                      accessibilityRole="button"
                      accessibilityLabel={M.settings.backup.showAsWordsA11y}
                      accessibilityHint={M.settings.backup.showAsWordsHint}
                      accessibilityState={{disabled: false}}>
                      <Text style={S.linkTextMuted}>{M.settings.backup.showAsWords}</Text>
                    </Pressable>
                  </>
                )}
                <Pressable
                  testID="btn-backup-hide"
                  style={S.linkBtn}
                  onPress={() => { setBackupRevealed(false); setConfirmBackup(false); setSeedFormat('mnemonic'); clearCopied(); }}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.backup.hideA11y}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>{M.settings.backup.hide}</Text>
                </Pressable>
              </View>
            ) : confirmBackup ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>{M.settings.backup.warning}</Text>
                <Pressable
                  testID="btn-backup-confirm"
                  style={[S.primaryWide, {marginTop: 16}]}
                  onPress={() => setBackupRevealed(true)}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.backup.revealA11y}
                  accessibilityHint={M.settings.backup.revealHint}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.primaryText}>{M.settings.backup.reveal}</Text>
                </Pressable>
                <Pressable
                  testID="btn-backup-cancel"
                  style={S.linkBtn}
                  onPress={() => setConfirmBackup(false)}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.backup.cancelA11y}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>{M.common.cancel}</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                testID="btn-backup"
                style={S.backupEntryBtn}
                onPress={() => setConfirmBackup(true)}
                accessibilityRole="button"
                accessibilityLabel={M.settings.backup.action}
                accessibilityHint={M.settings.backup.entryHint}
                accessibilityState={{disabled: false}}>
                <Text style={S.backupEntryText}>{M.settings.backup.entry}</Text>
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
            <Text style={S.inputLabel}>{M.settings.restore.label}</Text>
            {confirmRestore ? (
              <View style={S.backupConfirmBox}>
                <Text style={S.warnNote}>{M.settings.restore.warning}</Text>
                <TextInput
                  testID="settings-restore-seed-input"
                  style={S.seedInput}
                  value={restoreSeed}
                  onChangeText={setRestoreSeed}
                  placeholder={M.settings.restore.seedPlaceholder}
                  placeholderTextColor={C.sub2}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  accessibilityLabel={M.settings.restore.seedA11y}
                  accessibilityHint={M.settings.restore.seedHint}
                />
                {restoreErr ? <Text style={S.err}>{restoreErr}</Text> : null}
                <Pressable
                  testID="btn-settings-restore-confirm"
                  style={[S.primary, (restoreBusy || restoreSeed.trim() === '') && S.disabledFlat]}
                  disabled={restoreBusy || restoreSeed.trim() === ''}
                  onPress={doRestore}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.restore.action}
                  accessibilityHint={M.settings.restore.actionHint}
                  accessibilityState={{disabled: restoreBusy || restoreSeed.trim() === ''}}>
                  <Text style={[S.primaryText, (restoreBusy || restoreSeed.trim() === '') && S.disabledText]}>{restoreBusy ? M.settings.restore.busy : M.settings.restore.action}</Text>
                </Pressable>
                <Pressable
                  testID="btn-settings-restore-cancel"
                  style={S.linkBtn}
                  onPress={() => { setConfirmRestore(false); setRestoreSeed(''); setRestoreErr(null); }}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.restore.cancelA11y}
                  accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>{M.common.cancel}</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                testID="btn-settings-restore"
                style={S.secondaryBtn}
                onPress={() => { setConfirmRestore(true); setRestoreErr(null); }}
                accessibilityRole="button"
                accessibilityLabel={M.settings.restore.action}
                accessibilityHint={M.settings.restore.entryHint}
                accessibilityState={{disabled: false}}>
                <Text style={S.secondaryBtnText}>{M.settings.restore.entry}</Text>
              </Pressable>
            )}
          </View>

          {/* Reset — the destructive action goes LAST in the wallet-management group (Backup → Restore
              → Reset), so a user scanning top-down encounters the protective actions first. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.reset.label}</Text>
            {confirmReset ? (
              <View style={S.resetConfirmBox}>
                <Text style={S.warnNote}>{M.settings.reset.warning}</Text>
                <Pressable testID="btn-reset-confirm" style={[S.primaryWide, {backgroundColor: C.bad, marginTop: 16}]} onPress={onReset} accessibilityRole="button" accessibilityLabel={M.settings.reset.confirm} accessibilityHint={M.settings.reset.confirmHint} accessibilityState={{disabled: false}}>
                  <Text style={S.primaryText}>{M.settings.reset.confirm}</Text>
                </Pressable>
                <Pressable testID="btn-reset-cancel" style={S.linkBtn} onPress={() => setConfirmReset(false)} accessibilityRole="button" accessibilityLabel={M.settings.reset.cancelA11y} accessibilityState={{disabled: false}}>
                  <Text style={S.linkTextMuted}>{M.common.cancel}</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable testID="btn-reset" style={S.resetEntryBtn} onPress={() => setConfirmReset(true)} accessibilityRole="button" accessibilityLabel={M.settings.reset.action} accessibilityHint={M.settings.reset.entryHint} accessibilityState={{disabled: false}}>
                <Text style={S.resetEntryText}>{M.settings.reset.entry}</Text>
              </Pressable>
            )}
          </View>

          {/* Trip Ready J1 + J5b — LEARN (UX hardening 2026-08-23: moved ABOVE About — at 390×844
              both rows sat below the fold, which is exactly how the new surfaces went "missing").
              "How dpay works" replays the walkthrough — educational ONLY, it never awards or
              changes journey stamps (replay mode passes just onClose; no Skip, a top-left close
              affordance instead). The MODEL story lives here; the About section keeps the custody
              statement — no duplication. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.learn.label}</Text>
            {/* Trip readiness FIRST inside LEARN (UX 2026-08-23): the passport is the persistent
                object; the walkthrough replay is secondary. The live n/4 counter turns a dead
                label into a status row — the answer to "what is this / where am I" without
                opening it (computeReadiness is the single source, same as the strip/archive). */}
            <Pressable
              testID="btn-trip-readiness"
              style={S.linkBtn}
              onPress={() => setTripReadyOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={M.education.passport.title}
              accessibilityHint={M.settings.learn.passportHint}
              accessibilityState={{disabled: false}}>
              <View style={S.linkRow}>
                <IconCheck size={16} color={C.sub} />
                <Text style={S.linkText}>{M.education.passport.title}</Text>
                <Text testID="trip-readiness-count" style={[S.passportHintTag, {marginLeft: 'auto'}]}>{M.settings.learn.passportCount(tripReadiness.filled.length)}</Text>
              </View>
            </Pressable>
            <Pressable
              testID="btn-how-it-works"
              style={S.linkBtn}
              onPress={() => setHowItWorks(true)}
              accessibilityRole="button"
              accessibilityLabel={M.education.howItWorksTitle}
              accessibilityHint={M.settings.learn.howItWorksHint}
              accessibilityState={{disabled: false}}>
              <View style={S.linkRow}>
                <IconInfo size={16} color={C.sub} />
                <Text style={S.linkText}>{M.education.howItWorksTitle}</Text>
              </View>
            </Pressable>
          </View>

          {/* Wave 8 — Theme: the full three-way choice as a segmented control (the header keeps
              the quick Light↔Dark flip; Auto here returns control to the OS/browser scheme —
              the explicit way back after any pinned choice, on web AND native).
              ABOVE About (founder rule 2026-08-24): the theme choice is a frequent preference,
              About is the on-demand custody statement. */}
          {/* Main currency — the money preference, so it sits ABOVE the presentation ones
              (theme/language). Only currencies the catalog can actually realise are offered, which
              is why the list is derived from `assets` rather than from the HomeCurrency union: a
              row the user could pick and then not hold is a dead end. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.wallet.homeCurrency.settingsTitle}</Text>
            <View style={S.railRow} role="radiogroup" accessibilityLabel={M.wallet.homeCurrency.settingsTitle}>
              {offerableCurrencies(assets).map(choice => {
                const active = homeCurrency === choice;
                return (
                  <Pressable
                    key={choice}
                    testID={`btn-currency-${choice}`}
                    style={[S.railPill, active && S.railPillActive]}
                    onPress={() => onSetHomeCurrency(choice)}
                    accessibilityRole="radio"
                    accessibilityLabel={M.wallet.homeCurrency.a11y(currencyName(choice))}
                    accessibilityState={{checked: active, disabled: false}}
                  >
                    <Text style={active ? S.railPillTextActive : S.railPillText}>{choice}</Text>
                  </Pressable>
                );
              })}
            </View>
            {mainCurrencyGroup != null ? <Text style={S.dim2}>{mainCurrencyGroup}</Text> : null}
            <Text style={S.dim2}>{M.wallet.homeCurrency.settingsHint}</Text>
          </View>

          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.theme.label}</Text>
            <View style={S.railRow} role="radiogroup" accessibilityLabel={M.settings.theme.label}>
              {([null, 'light', 'dark'] as const).map((choice) => {
                const active = themeChoice === choice;
                const label = choiceLabel(choice);
                return (
                  <Pressable
                    key={label}
                    testID={choice === null ? 'btn-theme-auto' : `btn-theme-${choice}`}
                    style={[S.railPill, active && S.railPillActive]}
                    onPress={() => onSetTheme(choice)}
                    accessibilityRole="radio"
                    accessibilityLabel={M.settings.theme.choice(label)}
                    accessibilityState={{checked: active, disabled: false}}
                  >
                    <View style={S.linkRow}>
                      {choice === 'light' ? <IconSun size={14} color={C.sub} /> : choice === 'dark' ? <IconMoon size={14} color={C.sub} /> : <IconAuto size={14} color={C.sub} />}
                      <Text style={active ? S.railPillTextActive : S.railPillText}>{label}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Language, directly under Theme — the other "how the app presents itself" preference.
              Every option names itself in its OWN language: a user who cannot read the current UI
              language must still be able to find their way out, which "German/French/Spanish"
              rendered in Spanish would not allow. Auto follows the device and is the way back. */}
          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.language.label}</Text>
            <View style={S.railRow} role="radiogroup" accessibilityLabel={M.settings.language.label}>
              {([null, ...LOCALES] as const).map((choice) => {
                const active = localeChoice === choice;
                const label = choice === null ? M.settings.language.auto : LOCALE_ENDONYM[choice];
                return (
                  <Pressable
                    key={choice ?? 'auto'}
                    testID={choice === null ? 'btn-lang-auto' : `btn-lang-${choice}`}
                    style={[S.railPill, active && S.railPillActive]}
                    onPress={() => onSetLocale(choice)}
                    accessibilityRole="radio"
                    accessibilityLabel={M.settings.language.choice(label)}
                    accessibilityState={{checked: active, disabled: false}}
                  >
                    <Text style={active ? S.railPillTextActive : S.railPillText}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Advanced: Server (the relay URL) — disclosure COLLAPSES by default so a curious
              consumer doesn't see the relay URL input + a one-paste-away brick on first open.
              The header is the toggle; testID `btn-advanced-toggle` is the expansion step the e2e
              flows add before reading `settings-relay`. Expanding is one tap — keep it cheap.
              RIGHT BELOW Theme (founder rule 2026-08-24) — the two settings blocks stay together,
              About (the on-demand custody statement) closes the page. */}
          <View style={S.settingsSection}>
            <Pressable
              testID="btn-advanced-toggle"
              style={S.advancedToggle}
              onPress={() => setAdvancedOpen(o => !o)}
              accessibilityRole="button"
              accessibilityLabel={advancedOpen ? M.settings.advanced.hide : M.settings.advanced.show}
              accessibilityHint={M.settings.advanced.hint}
              accessibilityState={{disabled: false, expanded: advancedOpen}}>
              <Text style={S.advancedLabel}>{M.settings.advanced.label}</Text>
              {/* P4 — the '▾'/'▸' caret glyph became IconChevronDown; collapsed applies the −90°
                  rotation so it points right (the toggle's accessibilityState carries expansion). */}
              <View style={advancedOpen ? undefined : S.advancedCaretClosed}>
                <IconChevronDown size={14} color={C.sub2} />
              </View>
            </Pressable>
            {advancedOpen ? (
              <View>
                <Text style={S.dim2}>{M.settings.advanced.serverNote}</Text>
                <Text style={S.inputLabel}>{M.settings.advanced.serverLabel}</Text>
                <TextInput
                  testID="settings-relay"
                  style={S.relayInput}
                  value={draftRelay}
                  onChangeText={setDraftRelay}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={M.settings.advanced.serverPlaceholder}
                  placeholderTextColor={C.sub2}
                  accessibilityLabel={M.settings.advanced.serverLabel}
                  accessibilityHint={M.settings.advanced.serverHint}
                />
                <Pressable
                  testID="btn-relay-apply"
                  style={[S.applyBtn, !relayDirty && S.disabledFlat]}
                  disabled={!relayDirty}
                  onPress={applyRelay}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.advanced.applyA11y}
                  accessibilityHint={M.settings.advanced.applyHint}
                  accessibilityState={{disabled: !relayDirty}}>
                  <Text style={[S.applyBtnText, !relayDirty && S.disabledText]}>{M.settings.advanced.apply}</Text>
                </Pressable>
                {/* The Solana endpoint — the same draft/Apply shape, one section down. It was
                    configurable in code and read from storage at boot since 2026-09-08 but
                    reachable from no screen, so on a phone a dead provider key was a store
                    release. A refusal (plain http, a devnet host) renders under the field. */}
                <Text style={S.dim2}>{M.settings.advanced.solanaNote}</Text>
                <Text style={S.inputLabel}>{M.settings.advanced.solanaLabel}</Text>
                <TextInput
                  testID="settings-sol-rpc"
                  style={S.relayInput}
                  value={draftSolRpc}
                  onChangeText={(t) => { setDraftSolRpc(t); setSolRpcErr(null); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={M.settings.advanced.solanaPlaceholder}
                  placeholderTextColor={C.sub2}
                  accessibilityLabel={M.settings.advanced.solanaLabel}
                  accessibilityHint={M.settings.advanced.solanaHint}
                />
                {solRpcErr ? <Text testID="settings-sol-rpc-err" style={S.err}>{solRpcErr}</Text> : null}
                <Pressable
                  testID="btn-sol-rpc-apply"
                  style={[S.applyBtn, !solRpcDirty && S.disabledFlat]}
                  disabled={!solRpcDirty}
                  onPress={applySolRpc}
                  accessibilityRole="button"
                  accessibilityLabel={M.settings.advanced.solanaApplyA11y}
                  accessibilityHint={M.settings.advanced.solanaApplyHint}
                  accessibilityState={{disabled: !solRpcDirty}}>
                  <Text style={[S.applyBtnText, !solRpcDirty && S.disabledText]}>{M.settings.advanced.apply}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>

          <View style={S.settingsSection}>
            <Text style={S.inputLabel}>{M.settings.about.label}</Text>
            {/* Non-custodial statement (2026-08-22): plain words for the custody model — dpay
                cannot move, freeze, or recover funds, and there is no dpay account. Settings is
                the on-demand surface: nobody has to read this unless they go looking. */}
            <Text style={S.dim2} testID="about-custody">{M.settings.about.custody}</Text>
            <Pressable
              testID="privacy-policy"
              style={S.linkBtn}
              onPress={() => Linking.openURL(PRIVACY_URL)}
              accessibilityRole="link"
              accessibilityLabel={M.settings.about.privacy}>
              {/* P4 — external-link glyph signals the link opens outside the app (IconExternalLink
                  renders no textContent, so the census/asserted label is untouched). */}
              <View style={S.linkRow}>
                <IconExternalLink size={12} color={C.sub2} />
                <Text style={S.linkTextMuted}>{M.settings.about.privacy}</Text>
              </View>
            </Pressable>
          </View>

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.settings.escToClose}</Text> : null}
        </ScrollView>
      </SafeAreaView>

      {/* The replay — the SAME Walkthrough the first-run gate shows, in replay mode: onClose only
          (btn-walkthrough-close top-left, no Skip). "Get started" on the final scene ALSO closes
          (onDone wired to the same exit). Hosted by AppModal: on web a SheetOverlay INSIDE the app
          column (a RN <Modal> portals to the document root and escapes the 480px frame on wide
          viewports — the "outside the app screen" bug); on native the platform Modal. Full
          mount/unmount discipline is unchanged (never visible=false + animate-out — RN-web keeps
          the hidden children in the DOM when the animationend never fires, e.g. under the e2e
          harness's animation-freeze CSS). */}
      {howItWorks ? (
        <AppModal onRequestClose={() => setHowItWorks(false)}>
          <Walkthrough
            onClose={() => setHowItWorks(false)}
            onDone={() => setHowItWorks(false)}
          />
        </AppModal>
      ) : null}

      {/* Trip Ready J5b — the passport archive: same AppModal host + full-mount/unmount discipline
          as the walkthrough replay above. Renders the SAME TripPassport component in read-only
          archive mode (no capstone, no Done — complete shows the TRIP READY mark statically). */}
      {tripReadyOpen ? (
        <AppModal onRequestClose={() => setTripReadyOpen(false)}>
          <PassportArchive onClose={() => setTripReadyOpen(false)} onStep={goToPassportStep} />
        </AppModal>
      ) : null}
    </SheetOverlay>
  );
}
