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
import {SafeAreaView, ActivityIndicator, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_DEFAULT} from './relayConfig';
import {C} from './config/palette';
import {STORAGE_KEY, RELAY_STORAGE_KEY} from './config/constants';
import {randNonceHex} from './lib/format';
import type {Identity} from './lib/types';
import {DpayCore} from './services/native';
import {S} from './styles';
import {Onboarding} from './components/Onboarding';
import {Wallet} from './components/Wallet';

export default function App() {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined); // undefined = loading
  const [relayUrl, setRelayUrl] = useState(RELAY_DEFAULT);

  // Load identity + the persisted relay URL on mount. Both live in AsyncStorage; the relay URL
  // defaults to `relayConfig`'s value (the ?relay= override in the harness, or the codegen'd prod
  // URL) when no persisted choice exists yet.
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(RELAY_STORAGE_KEY),
    ])
      .then(([idV, relayV]) => {
        setIdentity(idV ? JSON.parse(idV) : null);
        if (typeof relayV === 'string' && relayV.length > 0) setRelayUrl(relayV);
      })
      .catch((e: any) => {
        // No silent errors: log with context, then fall back to a safe empty identity.
        console.log(`[dpay] failed to load identity/relay: ${e?.message ?? e}`);
        setIdentity(null);
      });
  }, []);

  // Set the relay URL AND persist it (best-effort; a persist failure is logged, never swallowed).
  // This is the single mutator SettingsSheet's input binds to, so every edit endures across reloads.
  const persistRelay = useCallback((url: string) => {
    setRelayUrl(url);
    AsyncStorage.setItem(RELAY_STORAGE_KEY, url).catch((e: any) => {
      console.log(`[dpay] failed to persist relay URL: ${e?.message ?? e}`);
    });
  }, []);

  // On-device self-check → logcat (proves the running app calls dpay-core), independent of identity.
  useEffect(() => {
    (async () => {
      try {
        const kp = await DpayCore.generateKeypair();
        const wire = await DpayCore.signAuthorization(kp.secretHex, kp.publicHex, 1, randNonceHex(), 4102444800, 0, '', '', '');
        // wire is the 292-byte authorization as lowercase hex (WIRE_LEN × 2). The length check guards
        // against truncation; verifyWire guards the signature round-trip. Both must hold.
        console.log(`DPAY_SELFCHECK ${(await DpayCore.verifyWire(wire)) && wire.length === 584 ? 'PASS' : 'FAIL'}`);
      } catch (e: any) { console.log(`DPAY_SELFCHECK FAIL ${String(e?.message ?? e)}`); }
    })();
  }, []);

  const onReset = useCallback(async () => { await AsyncStorage.removeItem(STORAGE_KEY); setIdentity(null); }, []);

  // M5: wrap every root in `screenFrame` so the capped (`maxWidth:480`) app column centers on a
  // wide desktop viewport, with the bg filling the honest side margins. At <=480px it is inert.
  if (identity === undefined) {
    return <View style={S.screenFrame}><SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brand} /></SafeAreaView></View>;
  }
  if (identity === null) {
    return <View style={S.screenFrame}><Onboarding relayUrl={relayUrl} onCreated={setIdentity} /></View>;
  }
  return <View style={S.screenFrame}><Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={persistRelay} onReset={onReset} /></View>;
}
