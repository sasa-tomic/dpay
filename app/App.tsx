/**
 * dpay — peer-to-peer wallet. Each phone has its OWN on-device key (generated once, persisted) and a
 * username. Two modes:
 *   • Pay     — scan someone's request QR → "Pay $X to <name>" → Approve → sign offline in the Rust
 *               core; if online, submit directly; else show a signed QR for the receiver to scan.
 *   • Receive — enter an amount → show a request QR (carries your account + name); the payer scans
 *               it; you either see it settle (payer paid directly) or scan the payer's signed QR.
 *
 * Money/protocol calls go through DpayCore → UniFFI → libdpay_ffi.so (the shared dpay-core). The
 * request QR is `<base64url request>|<username>`: the request is the signed, money-critical payload;
 * the username is unsigned display metadata (the account is the source of truth).
 *
 * This is the app root: it loads the persisted identity + relay URL, runs the on-device self-check,
 * and is THE first-run router. Everything else — the palette, format helpers, constants, hooks,
 * services, styles, and all presentational components — lives under
 * `./{config,lib,hooks,services,styles.ts,components}`. See `2026-07-31-app-split-plan.md`.
 *
 * THE FIRST-RUN ROUTER (spec docs/specs/2026-09-08-first-run-redesign.md §7.1). Three lines, over
 * PERSISTED facts only:
 *
 *     identity === null                       → Onboarding   (tour + create + backup)
 *     !hasSeen(journey, FIRST_RUN_PRACTICE)   → Practice     (one real ∂1.00 practice payment)
 *     otherwise                               → Wallet       (which still gates on homeCurrency)
 *
 * It replaced two half-routers — an in-memory beat machine inside Onboarding and a persisted gate
 * inside Wallet — and that split was not cosmetic: it is why an app killed between the identity
 * being written and the backup being acknowledged used to skip the 24 words FOREVER. A wallet is
 * PENDING until its words are acknowledged now (`PENDING_IDENTITY_STORAGE_KEY`), so line one of
 * this router is also the backup gate, and it cannot be got past by dying at the right moment.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {SafeAreaView, ActivityIndicator, View, useColorScheme} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_DEFAULT} from './relayConfig';
import {C, DARK, LIGHT} from './config/palette';
import {STORAGE_KEY, RELAY_STORAGE_KEY, THEME_STORAGE_KEY, LOCALE_STORAGE_KEY, HOME_CURRENCY_STORAGE_KEY} from './config/constants';
import {parseTheme, resolveTheme, themePersistValue, type ThemeOverride} from './config/theme';
import {parseHomeCurrency, type HomeCurrency} from './config/currency';
import {runSolSelfCheck} from './solana/selfcheck';
import {runIntlSelfCheck} from './i18n/selfcheck';
import {applyLocale} from './i18n';
import {type LocaleChoice, deviceLocaleTag, localePersistValue, parseLocale} from './i18n/locale';
import type {Identity} from './lib/types';
import {hasSeen, useJourney} from './lib/journey';
import {DpayCore} from './services/native';
import {installLogSink} from './services/log';
import {S, applyPalette} from './styles';
import {Onboarding} from './components/Onboarding';
import {Practice, FIRST_RUN_PRACTICE} from './components/Practice';
import {Wallet} from './components/Wallet';

// Mirror warnings + errors into an on-device FILE before anything else can log. At module scope on
// purpose: a payment made half an hour from any computer must have left a record that survives the
// walk home, and logcat — an in-memory rolling buffer readable only over a cable — does not. See
// `services/log.ts` for what it does and does not capture.
installLogSink();

export default function App() {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined); // undefined = loading
  const [relayUrl, setRelayUrl] = useState(RELAY_DEFAULT);
  // Wave 8 two-tier theme: `null` = Auto (follow the OS scheme live — the styles.ts module-load
  // probe keeps first paint correct in the meantime); an explicit choice pins the palette and
  // wins from then on. The header flip pins Light/Dark; Settings offers the full 3-way choice.
  const [themeChoice, setThemeChoice] = useState<ThemeOverride | null>(null);

  // Language, on the same two-tier model as the theme: `null` = Auto (follow the device locale);
  // an explicit choice pins the catalog and wins from then on.
  const [localeChoice, setLocaleChoice] = useState<LocaleChoice>(null);

  // The home currency. `null` is NOT a default — it means the user has not chosen yet, and the
  // Wallet renders the chooser instead of the wallet until they do. `undefined` would be a third
  // state with no extra meaning here: the mount read below always resolves it to a value or null.
  const [homeCurrency, setHomeCurrency] = useState<HomeCurrency | null>(null);

  // The journey store, live: the router's second line reads a `seen` marker off it, and `see`
  // is the optimistic setter that makes the route flip on the tap rather than on the AsyncStorage
  // write (which this store treats as best-effort — a failed write must never strand a user on a
  // one-time setup screen). `loaded` gates the first paint so the wallet never flashes in front of
  // a first-run surface that is about to replace it.
  const {journey, see: markJourneySeen, loaded: journeyLoaded} = useJourney();

  // Wave-4 dual theme + Wave-7 manual override: resolve stored choice + OS scheme → the palette.
  // styles.ts already resolved the OS theme at module load (synchronous Appearance probe → first
  // paint is correct, no light-flash); this keeps the live palette in sync when the scheme CHANGES
  // at runtime (Android dark-mode toggle, browser devtools emulation — RNW's useColorScheme is
  // matchMedia-backed) while no choice is stored, or when the user toggles the override. Calling
  // applyPalette in the render body (not an effect) means the palette is applied BEFORE this
  // render's children read S/C — no stale frame. It is idempotent and guarded, so the per-render
  // call is a no-op after the first. useColorScheme() re-renders App on change; nothing below is
  // memoized, so the whole tree re-reads S/C (verified: no React.memo in the app tree).
  const scheme = useColorScheme();
  const themeOverride = resolveTheme(themeChoice, scheme);
  applyPalette(themeOverride === 'dark' ? DARK : LIGHT);

  // The same idiom, one layer over: resolve the catalog + number/date conventions and install them
  // in the render body, so children read the right language on THIS render rather than the next.
  // The device tag is read once — Android restarts the activity when the system language changes,
  // so re-probing every render would buy nothing.
  const deviceTag = useMemo(() => deviceLocaleTag(), []);
  const activeLocale = applyLocale(localeChoice, deviceTag);

  // Load identity + the persisted relay URL + the persisted theme choice on mount. All live in
  // AsyncStorage; the relay URL defaults to `relayConfig`'s value (the ?relay= override in the
  // harness, or the codegen'd prod URL) and the theme to "follow the OS scheme" when no persisted
  // choice exists.
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(RELAY_STORAGE_KEY),
      AsyncStorage.getItem(THEME_STORAGE_KEY),
      AsyncStorage.getItem(LOCALE_STORAGE_KEY),
      AsyncStorage.getItem(HOME_CURRENCY_STORAGE_KEY),
    ])
      .then(([idV, relayV, themeV, localeV, currencyV]) => {
        setIdentity(idV ? JSON.parse(idV) : null);
        if (typeof relayV === 'string' && relayV.length > 0) setRelayUrl(relayV);
        setThemeChoice(parseTheme(themeV)); // null (incl. legacy 'auto') → keep following the OS scheme
        setLocaleChoice(parseLocale(localeV)); // null (incl. 'system' or a dropped locale) → follow the device
        setHomeCurrency(parseHomeCurrency(currencyV)); // null → not chosen yet → the Wallet asks
      })
      .catch((e: unknown) => {
        // No silent errors: log with context, then fall back to a safe empty identity.
        console.log(`[dpay] failed to load identity/relay/theme/locale/currency: ${e instanceof Error ? e.message : String(e)}`);
        setIdentity(null);
      });
  }, []);

  // Set the relay URL AND persist it (best-effort; a persist failure is logged, never swallowed).
  // This is the single mutator SettingsSheet's input binds to, so every edit endures across reloads.
  const persistRelay = useCallback((url: string) => {
    setRelayUrl(url);
    AsyncStorage.setItem(RELAY_STORAGE_KEY, url).catch((e: unknown) => {
      console.log(`[dpay] failed to persist relay URL: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // Wave 8: set the theme choice AND persist it — same best-effort pattern as persistRelay.
  // The single mutator both controls drive (header flip → explicit choice; Settings segment →
  // choice or null=Auto). Auto persists as 'system'.
  const persistTheme = useCallback((t: ThemeOverride | null) => {
    setThemeChoice(t);
    AsyncStorage.setItem(THEME_STORAGE_KEY, themePersistValue(t)).catch((e: unknown) => {
      console.log(`[dpay] failed to persist theme override: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // Set the language choice AND persist it — same best-effort pattern. Auto persists as 'system'.
  const persistLocale = useCallback((l: LocaleChoice) => {
    setLocaleChoice(l);
    AsyncStorage.setItem(LOCALE_STORAGE_KEY, localePersistValue(l)).catch((e: unknown) => {
      console.log(`[dpay] failed to persist language choice: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // Set the home currency AND persist it — same best-effort pattern as the others. Driven by the
  // first-run chooser and by the Settings control; both go through this one mutator.
  const persistHomeCurrency = useCallback((c: HomeCurrency) => {
    setHomeCurrency(c);
    AsyncStorage.setItem(HOME_CURRENCY_STORAGE_KEY, c).catch((e: unknown) => {
      console.log(`[dpay] failed to persist home currency: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // On-device self-check → logcat (proves the running app calls dpay-core), independent of identity.
  // 2026-08-19 IC-rail cutover: the old wire sign/verify round-trip retired with the facade rail; the
  // check now proves the USER-PRINCIPAL RAIL surface end to end — self-principal derivation,
  // transfer-arg build, envelope signing, and request_id round-trip (envelope → rid must equal the
  // signer's rid). The device gate greps for `DPAY_SELFCHECK PASS`.
  useEffect(() => {
    (async () => {
      try {
        const kp = await DpayCore.generateKeypair();
        const principal = await DpayCore.icpSelfPrincipal(kp.secretHex);
        const payee = await DpayCore.icpPrincipalFromPubkey(kp.publicHex);
        const arg = await DpayCore.icpTransferArg(payee, '', '', '1', '', '');
        const signed = await DpayCore.icpSignUpdate(kp.secretHex, 'mxzaz-hqaaa-aaaar-qaada-cai', 'icrc1_transfer', arg, '1800000000000000000');
        const rid = await DpayCore.icpEnvelopeRequestId(signed.envelopeHex);
        const ok = principal.length > 40 && payee.length > 40 && rid === signed.requestIdHex && signed.envelopeHex.length > 700;
        console.log(`DPAY_SELFCHECK ${ok ? 'PASS' : 'FAIL'}`);
      } catch (e: unknown) { console.log(`DPAY_SELFCHECK FAIL ${e instanceof Error ? e.message : String(e)}`); }
    })();
  }, []);

  // On-device SOL v2 self-check → logcat. Proves the full recent-blockhash v2 code path (SLIP-10
  // derivation + bs58/noble ed25519 + sha256 memo + canonical SOL/USDC message assembly + strict
  // verify + signature extraction) runs on the real device (Hermes) — the native-module/polyfill
  // blind spot — independent of the FFI and of any network. The device gate greps for
  // `DPAY_SOL_SELFCHECK PASS`. Fixtures match the jest goldens (app/__tests__/solana-tx.test.ts).
  useEffect(() => {
    const r = runSolSelfCheck();
    console.log(`DPAY_SOL_SELFCHECK ${r.ok ? 'PASS' : `FAIL ${r.reason}`}`);
  }, []);

  // On-device Intl self-check → logcat. Proves the JS engine that SHIPS carries the Intl surface
  // the money formatter is built on (NumberFormat.formatToParts for separators, DateTimeFormat for
  // the clock) with real per-locale ICU data. Hermes builds Intl optionally and the headless
  // browser the e2e suite drives always has it, so this blind spot is only observable on a device.
  // The device gate greps for `DPAY_INTL_SELFCHECK PASS`; see i18n/selfcheck.ts for what is
  // deliberately NOT asserted (exact glyphs) and what is absent from Hermes (PluralRules, Locale).
  useEffect(() => {
    const r = runIntlSelfCheck();
    console.log(`DPAY_INTL_SELFCHECK ${r.ok ? `PASS locale=${r.deviceLocale} catalog=${activeLocale}` : `FAIL ${r.reason}`}`);
  }, [activeLocale]);

  const onReset = useCallback(async () => { await AsyncStorage.removeItem(STORAGE_KEY); setIdentity(null); }, []);

  // Replace the current identity with a restored one (Settings → Restore). Symmetric with `onReset`
  // (which removes): this WRITES + setIdentity. App.tsx remains the sole owner of AsyncStorage
  // writes; SettingsSheet does the FFI key-derivation + Identity build inline (mirrors Onboarding's
  // restore) and hands the built identity here for persistence + state replacement. Restore
  // REPLACES identity directly (no wipe) — the old wallet stays recoverable via its own seed.
  const onRestore = useCallback(async (id: Identity) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(id));
    setIdentity(id);
  }, []);

  // A RESTORED wallet skips practice: it already has funds and it already has its words, and the
  // person holding it has just proved they can do both. Onboarding persists the identity and hands
  // it here; the marker is set FIRST so the router never renders a practice screen for one frame
  // on its way to the wallet.
  const onRestored = useCallback((id: Identity) => {
    markJourneySeen(FIRST_RUN_PRACTICE);
    setIdentity(id);
  }, [markJourneySeen]);

  // M5: wrap every root in `screenFrame` so the capped (`maxWidth:480`) app column centers on a
  // wide desktop viewport, with the bg filling the honest side margins. At <=480px it is inert.
  if (identity === undefined || !journeyLoaded) {
    return <View style={S.screenFrame}><SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brand} /></SafeAreaView></View>;
  }
  if (identity === null) {
    return <View style={S.screenFrame}><Onboarding relayUrl={relayUrl} onCreated={setIdentity} onRestored={onRestored} /></View>;
  }
  if (!hasSeen(journey, FIRST_RUN_PRACTICE)) {
    // The app has already given before it asks: the faucet credit landed on create, and this is
    // the first thing the app DOES for the user rather than asks of them. It is skippable, and
    // every one of its outcomes — including the ones that are not a success — leaves through the
    // same marker, so first run is never blocked by it.
    return <View style={S.screenFrame}><Practice identity={identity} relayUrl={relayUrl} onDone={() => markJourneySeen(FIRST_RUN_PRACTICE)} /></View>;
  }
  return <View style={S.screenFrame}><Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={persistRelay} onReset={onReset} onRestore={onRestore} resolvedTheme={themeOverride} themeChoice={themeChoice} onSetTheme={persistTheme} localeChoice={localeChoice} onSetLocale={persistLocale} homeCurrency={homeCurrency} onSetHomeCurrency={persistHomeCurrency} /></View>;
}
