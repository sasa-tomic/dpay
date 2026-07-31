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
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  SafeAreaView, ScrollView, StatusBar, View, Text, Pressable, TextInput, StyleSheet, NativeModules,
  Share, AppState, ActivityIndicator, NativeEventEmitter, Platform,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Svg, {Defs, RadialGradient, Stop, Rect, Path} from 'react-native-svg';
import {Camera, useCameraDevice, useCameraPermission, useCodeScanner} from 'react-native-vision-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_DEFAULT} from './relayConfig';
import {
  classifyPayHttp, receiptCodeFor, decidePayerReceipt, rejectionMessage, isNonceReused,
  type SettleOutcome,
} from './payments';
import {encodeApprove, encodeDepositErc20, principalToBytes32} from './cketh';
import {getEthereumProvider, connectWallet, sendTransaction} from './wallet';
import {C} from './config/palette';
import type {
  DpayNfcApi, NfcEvent, NfcPhaseName, Req, Identity, Txn, TransactionsRow, DpayCoreApi, NfcStatus,
} from './lib/types';
import {
  usd, short, MINT_HEX, isMintSentinel, fmtTime, nowSecs, randNonceHex, toCents, toSats, base,
  parseRequestQR, fmtAsset,
} from './lib/format';
import {
  EXPIRY_WINDOW, DIRECT_PAY_TIMEOUT_MS, NFC_PAY_TIMEOUT_MS, RECONCILE_ATTEMPTS, RECONCILE_INTERVAL_MS,
  RECEIPT_WAIT_MS, STORAGE_KEY, RELAY_STORAGE_KEY, POLL, WITHDRAW_TIMEOUT_MS, WITHDRAW_EXPIRY_WINDOW,
} from './config/constants';
import {
  type MinterFamily, type CurrencyDescriptor, type FamilyDisplay, CATALOG_CACHE_KEY, BUNDLED_CATALOG,
  fetchCurrencies, familyDisplay, assetTestKey,
} from './config/catalog';
import {S} from './styles';
import {useHotkeys, useEscapeToClose} from './hooks/useHotkeys';
import {copyToClipboard, readFromClipboard} from './hooks/clipboard';
import {readDepositDeepLink} from './hooks/useDeepLink';
import {DpayCore, DpayNfc} from './services/native';
import {verifyOutcomeReceipt} from './services/receipt';
import {
  type DepositInfo, type DepositRefresh, type CkErc20OnrampParams, type WithdrawReceipt,
  depositInfo, depositAddress, depositRefresh, ckerc20OnrampParams, withdrawFunds,
} from './services/relay';
import {loadSavedWithdrawAddr, saveWithdrawAddr} from './services/withdraw';
import {Logo, Wordmark} from './components/Logo';
import {HotkeyHint} from './components/HotkeyHint';
import {NfcPill} from './components/NfcPill';
import {Tab} from './components/Tab';
import {QrScanner} from './components/QrScanner';
import {NfcTap} from './components/NfcTap';
import {PayMode} from './components/PayMode';
import {ReceiveMode} from './components/ReceiveMode';
import {SettingsSheet} from './components/SettingsSheet';
import {AssetPickerSheet} from './components/AssetPickerSheet';
import {DepositSheet} from './components/DepositSheet';
import {WithdrawSheet} from './components/WithdrawSheet';
import {CkErc20DepositSheet} from './components/CkErc20DepositSheet';
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
        const wire = await DpayCore.signAuthorization(kp.secretHex, kp.publicHex, 1, randNonceHex(), 4102444800, 0);
        console.log(`DPAY_SELFCHECK ${(await DpayCore.verifyWire(wire)) && wire.length === 392 ? 'PASS' : 'FAIL'}`);
      } catch (e: any) { console.log(`DPAY_SELFCHECK FAIL ${String(e?.message ?? e)}`); }
    })();
  }, []);

  const onReset = useCallback(async () => { await AsyncStorage.removeItem(STORAGE_KEY); setIdentity(null); }, []);

  if (identity === undefined) {
    return <SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brand} /></SafeAreaView>;
  }
  if (identity === null) {
    return <Onboarding relayUrl={relayUrl} onCreated={setIdentity} />;
  }
  return <Wallet identity={identity} relayUrl={relayUrl} setRelayUrl={persistRelay} onReset={onReset} />;
}
