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
 * and routes between Onboarding (no key yet) and Wallet (the container). Everything else — the
 * palette, format helpers, constants, hooks, services, styles, and all presentational components —
 * lives under `./{config,lib,hooks,services,styles.ts,components}`. See `2026-07-31-app-split-plan.md`.
 */
import {useCallback, useEffect, useState} from 'react';
import {SafeAreaView, ActivityIndicator, View, useColorScheme} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_DEFAULT} from './relayConfig';
import {C, DARK, LIGHT} from './config/palette';
import {STORAGE_KEY, RELAY_STORAGE_KEY, THEME_STORAGE_KEY} from './config/constants';
import {parseTheme, resolveTheme, type ThemeOverride} from './config/theme';
import {runSolSelfCheck} from './solana/selfcheck';
import type {Identity} from './lib/types';
import {DpayCore} from './services/native';
import {S, applyPalette} from './styles';
import {Onboarding} from './components/Onboarding';
import {Wallet} from './components/Wallet';

export default function App() {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined); // undefined = loading
  const [relayUrl, setRelayUrl] = useState(RELAY_DEFAULT);
  // Wave 7 manual theme override ('auto' = follow the OS scheme, the Wave-4 default). 'auto' until
  // the persisted choice hydrates (below) — the module-load probe in styles.ts keeps first paint
  // correct in the meantime; once hydrated the override wins via the resolved palette below.
  const [themeOverride, setThemeOverride] = useState<ThemeOverride>('auto');

  // Wave-4 dual theme + Wave-7 manual override: resolve override + OS scheme → the palette.
  // styles.ts already resolved the OS theme at module load (synchronous Appearance probe → first
  // paint is correct, no light-flash); this keeps the live palette in sync when the scheme CHANGES
  // at runtime (Android dark-mode toggle, browser devtools emulation — RNW's useColorScheme is
  // matchMedia-backed) or when the user cycles the override. Calling applyPalette in the render
  // body (not an effect) means the palette is applied BEFORE this render's children read S/C — no
  // stale frame. It is idempotent and guarded, so the per-render call is a no-op after the first.
  // useColorScheme() re-renders App on change; nothing below is memoized, so the whole tree
  // re-reads S/C (verified: no React.memo in the app tree).
  const scheme = useColorScheme();
  applyPalette(resolveTheme(themeOverride, scheme) === 'dark' ? DARK : LIGHT);

  // Load identity + the persisted relay URL + the persisted theme override on mount. All live in
  // AsyncStorage; the relay URL defaults to `relayConfig`'s value (the ?relay= override in the
  // harness, or the codegen'd prod URL) and the theme to 'auto' when no persisted choice exists.
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(RELAY_STORAGE_KEY),
      AsyncStorage.getItem(THEME_STORAGE_KEY),
    ])
      .then(([idV, relayV, themeV]) => {
        setIdentity(idV ? JSON.parse(idV) : null);
        if (typeof relayV === 'string' && relayV.length > 0) setRelayUrl(relayV);
        const t = parseTheme(themeV);
        if (t !== 'auto') setThemeOverride(t);
      })
      .catch((e: unknown) => {
        // No silent errors: log with context, then fall back to a safe empty identity.
        console.log(`[dpay] failed to load identity/relay/theme: ${e instanceof Error ? e.message : String(e)}`);
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

  // Wave 7: set the theme override AND persist it — same best-effort pattern as persistRelay. The
  // single mutator both toggle controls (wallet header + Settings) cycle through.
  const persistTheme = useCallback((t: ThemeOverride) => {
    setThemeOverride(t);
    AsyncStorage.setItem(THEME_STORAGE_KEY, t).catch((e: unknown) => {
      console.log(`[dpay] failed to persist theme override: ${e instanceof Error ? e.message : String(e)}`);
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

  // M5: wrap every root in `screenFrame` so the capped (`maxWidth:480`) app column centers on a
  // wide desktop viewport, with the bg filling the honest side margins. At <=480px it is inert.
  if (identity === undefined) {
    return <View style={S.screenFrame}><SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brand} /></SafeAreaView></View>;
  }
  if (identity === null) {
    return <View style={S.screenFrame}><Onboarding relayUrl={relayUrl} onCreated={setIdentity} /></View>;
  }
  return <View style={S.screenFrame}><Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={persistRelay} onReset={onReset} onRestore={onRestore} themeOverride={themeOverride} onCycleTheme={persistTheme} /></View>;
}
