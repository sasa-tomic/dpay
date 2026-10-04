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
 * This is the app root: it loads the persisted identity + relay address list, runs the on-device self-check,
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
import {STORAGE_KEY, THEME_STORAGE_KEY, LOCALE_STORAGE_KEY, HOME_CURRENCY_STORAGE_KEY, SOLANA_RPC_STORAGE_KEY, IC_GATEWAY_STORAGE_KEY, setRelayBaseForSolana, setSolanaRpcUrl, setIcGatewayUrl} from './config/constants';
import {EVM_RPC_STORAGE_KEY, setEvmRpcUrl, setRelayBaseForEvm} from './evm/endpoints';
import {loadPersistedRelayAddresses, parseRelayAddress, persistRelayAddresses, setRelayAddresses, splitRelayListParam} from './services/relayAddresses';
import {parseTheme, resolveTheme, themePersistValue, type ThemeOverride} from './config/theme';
import {parseHomeCurrency, type HomeCurrency} from './config/currency';
import {runSolSelfCheck} from './solana/selfcheck';
import {runIntlSelfCheck} from './i18n/selfcheck';
import {applyLocale} from './i18n';
import {type LocaleChoice, deviceLocaleTag, localePersistValue, parseLocale} from './i18n/locale';
import type {Identity} from './lib/types';
import {hasSeen, useJourney} from './lib/journey';
import {BUILD_COMMIT} from './lib/buildStamp';
import {fetchUpdate, updateAvailable} from './lib/updateCheck';
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
  // R1 — the operator's ordered relay address LIST (spec 2026-09-09 §"Direction 2"). `RELAY_DEFAULT`
  // may itself carry several comma-separated addresses (the `?relay=` harness override); the baked
  // default is the fallback when nothing is persisted. `relayUrl` below stays the RESOLVED ACTIVE
  // address (the list's first entry) and keeps flowing down to every hook exactly as before — the
  // list lives beside it, not instead of it. `?relay=` wins until something is persisted (the
  // harness runs fresh contexts; a persisted choice must survive a plain reload, which flow 12
  // pins). Entries stay verbatim (today's `?relay=` is accepted verbatim, trailing slash included);
  // only VALIDATED lists are installed into the walk module below.
  const [relayUrls, setRelayUrls] = useState<string[]>(() => splitRelayListParam(RELAY_DEFAULT));
  const relayUrl = relayUrls[0];
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

  // The in-app update check (founder 2026-10-04: the app tells the user there is a newer version,
  // and the download is 1-2 clicks). ONE fetch per launch, held as the ABSOLUTE download URL Home
  // renders a single 'Update' button for — null means silent: same build, no APK served, a
  // dev/test build (empty BUILD_COMMIT), or any fetch failure. lib/updateCheck owns the decision;
  // this effect only runs it once and composes the URL.
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);
  useEffect(() => {
    if (BUILD_COMMIT === '') return; // dev/test build: no identity, the check stays silent
    let alive = true;
    fetchUpdate(relayUrl).then((info) => {
      if (alive && info !== null && updateAvailable(info, BUILD_COMMIT) && info.apk !== null) {
        setUpdateUrl(`${relayUrl.replace(/\/+$/, '')}${info.apk.url}`);
      }
    }).catch(() => {}); // fetchUpdate already swallows; this guard keeps the promise chain honest
    return () => { alive = false; };
    // ONE fetch per launch, against the mount-time relay: a mid-session relay edit must never
    // turn the check into a poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Load identity + the persisted relay list + the persisted theme choice on mount. All live in
  // AsyncStorage; the relay list defaults to `relayConfig`'s value (the ?relay= override — possibly
  // a comma list — in the harness, or the codegen'd prod URL) and the theme to "follow the OS
  // scheme" when no persisted choice exists.
  useEffect(() => {
    // Wire the walk module BEFORE any component can fetch: with no persisted list the module
    // stays on the baked/`?relay=` default list (validated entries only — an invalid `?relay=`
    // entry degrades to "no operator list", i.e. the single-address behavior of every pre-R1
    // build, rather than throwing at boot).
    const initialValid = splitRelayListParam(RELAY_DEFAULT)
      .map((u) => parseRelayAddress(u))
      .filter((u): u is string => u != null);
    if (initialValid.length > 0) setRelayAddresses(initialValid);
    // R2, synchronously in the SAME tick: the SOL rail's default derives from this list, and
    // wiring it here (not in a separate effect) means no render ever sees the relay list move
    // while the Solana derivation still points at the old base — the first balance poll of the
    // first render reads the right home.
    if (initialValid.length > 0) { setRelayBaseForSolana(initialValid); setRelayBaseForEvm(initialValid); }
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      loadPersistedRelayAddresses(),
      AsyncStorage.getItem(THEME_STORAGE_KEY),
      AsyncStorage.getItem(LOCALE_STORAGE_KEY),
      AsyncStorage.getItem(HOME_CURRENCY_STORAGE_KEY),
      AsyncStorage.getItem(SOLANA_RPC_STORAGE_KEY),
      AsyncStorage.getItem(EVM_RPC_STORAGE_KEY),
      AsyncStorage.getItem(IC_GATEWAY_STORAGE_KEY),
    ])
      .then(([idV, relayListV, themeV, localeV, currencyV, solRpcV, evmRpcV, icGwV]) => {
        // The operator's Solana endpoint, applied BEFORE the wallet renders (the balance hooks read
        // it on their first poll). A stored value was validated when it was set, so a rejection here
        // means the store was corrupted: say so loudly and stay on the built-in default rather than
        // stranding the rail. See config/constants.ts#setSolanaRpcUrl for what is accepted.
        if (typeof solRpcV === 'string' && solRpcV.length > 0) {
          try {
            setSolanaRpcUrl(solRpcV);
          } catch (e: unknown) {
            console.log(`[dpay] stored Solana RPC endpoint rejected, using the built-in default: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // The operator's EVM endpoint override (D11), same pattern: applied BEFORE the wallet
        // renders so the rail-visibility gate and the first poll read the right endpoint.
        if (typeof evmRpcV === 'string' && evmRpcV.length > 0) {
          try {
            setEvmRpcUrl(evmRpcV);
          } catch (e: unknown) {
            console.log(`[dpay] stored EVM endpoint rejected, using the relay default: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // The operator's IC gateway override, same pattern (F2, 2026-09-12): applied before the
        // wallet renders so the first envelope submit targets the right boundary. It exists for
        // demos/testing against a local replica; a rejection here is the same corruption story.
        if (typeof icGwV === 'string' && icGwV.length > 0) {
          try {
            setIcGatewayUrl(icGwV);
          } catch (e: unknown) {
            console.log(`[dpay] stored IC gateway override rejected, using the default: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        setIdentity(idV ? JSON.parse(idV) : null);
        // R1: a non-empty persisted list (dpay.relays.v1, or the migrated legacy dpay.relay.v1)
        // replaces the default list — both the walk module and the UI state. An EMPTY result is
        // "no persisted choice", not "no relays": the defaults stay. R2: the Solana derivation
        // follows in the same tick, before the setRelayUrls re-render's child effects can poll.
        if (relayListV.length > 0) {
          setRelayAddresses(relayListV);
          setRelayBaseForSolana(relayListV);
          setRelayUrls(relayListV);
        }
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

  // R2 — the SOL rail's DEFAULT candidate list derives from the ACTIVE relay list (spec
  // 2026-09-09 §"Direction 1 — the proxy"): `setRelayBaseForSolana` is called SYNCHRONOUSLY at
  // every place a list is installed (the mount effect's initial wiring, the persisted-list
  // load above, and `persistRelayList` below) — one mechanism, no derived effect. A derived
  // `useEffect(() => setRelayBaseForSolana(relayUrl), [relayUrl])` was tried first and is
  // wrong on timing: child effects run BEFORE a parent's, so the first Solana poll after a
  // re-point would fire under the STALE base (module-load default) while the state update was
  // still queued. An operator's explicit Solana endpoint (Settings ▸ Advanced /
  // SOLANA_RPC_STORAGE_KEY) sits ABOVE the derivation and is untouched by this wiring.

  // Set the relay address list AND persist it (best-effort; a persist failure is logged, never
  // swallowed). This is the single mutator the Settings list editor binds to, so every edit
  // endures across reloads. R1: an EMPTY list is a value — it restores the addresses baked into
  // this build (same contract as the Solana RPC row's empty draft). `setRelayAddresses` re-validates
  // and throws; the Settings row parses first with the same validator, so a throw here means the
  // two validators diverged — it surfaces in the row rather than silently keeping half a list.
  const persistRelayList = useCallback((urls: string[]) => {
    const list = urls.length > 0 ? urls : splitRelayListParam(RELAY_DEFAULT);
    setRelayUrls(list);
    // Only a fully-valid list is installed into the walk (an urls argument from the Settings
    // parser is always valid — this re-validation is the same rule, one place deeper; a baked
    // default that somehow names garbage degrades to the pre-R1 single-address walk instead of
    // throwing in the Settings row).
    const valid = list.map((u) => parseRelayAddress(u)).filter((u): u is string => u != null);
    if (valid.length > 0) {
      setRelayAddresses(valid);
      // Same-tick Solana derivation re-point as the boot effect: the list editor is the one
      // surface where the relay list changes mid-session, and the very next balance poll must
      // walk the NEW homes.
      setRelayBaseForSolana(valid);
    }
    persistRelayAddresses(list).catch((e: unknown) => {
      console.log(`[dpay] failed to persist relay address list: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // The Solana endpoint's single mutator — the runtime twin of the relay list mutator above, and the reason the
  // Settings row exists at all: `setSolanaRpcUrl` has been the seam every Solana read goes through
  // since 2026-09-08, but nothing on a phone could reach it, so a dead provider key was a store
  // release rather than a settings edit.
  //
  // It THROWS on a refusal (not https, a devnet host, unparseable) and that throw is the product:
  // the caller is the Settings row, which renders the message verbatim. Persistence happens only
  // AFTER the value is accepted, so a refused edit can never be restored at the next boot. `''`
  // clears the stored choice and restores the endpoint baked into this build.
  const persistSolanaRpc = useCallback((url: string) => {
    setSolanaRpcUrl(url); // throws → the caller shows it; nothing is stored
    AsyncStorage.setItem(SOLANA_RPC_STORAGE_KEY, url.trim()).catch((e: unknown) => {
      console.log(`[dpay] failed to persist Solana RPC endpoint: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  // The IC gateway override's single mutator — the same shape as persistSolanaRpc (F2). THROWS on
  // a refusal (unparseable, plain http on a public host) and the Settings row renders the message;
  // persistence only after acceptance. `''` clears: icp-api.io again. This is the operator/demo
  // escape hatch — nothing in the normal user flow ever calls it.
  // The EVM endpoint override's single mutator (D11) — the persistSolanaRpc shape verbatim.
  const persistEvmRpc = useCallback((url: string) => {
    setEvmRpcUrl(url); // throws → the caller shows it; nothing is stored
    AsyncStorage.setItem(EVM_RPC_STORAGE_KEY, url.trim()).catch((e: unknown) => {
      console.log(`[dpay] failed to persist EVM endpoint: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, []);

  const persistIcGateway = useCallback((url: string) => {
    setIcGatewayUrl(url); // throws → the caller shows it; nothing is stored
    AsyncStorage.setItem(IC_GATEWAY_STORAGE_KEY, url.trim()).catch((e: unknown) => {
      console.log(`[dpay] failed to persist IC gateway override: ${e instanceof Error ? e.message : String(e)}`);
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
    return <View style={S.screenFrame}><SafeAreaView style={[S.root, S.centerAll]}><ActivityIndicator color={C.brandText} /></SafeAreaView></View>;
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
  return <View style={S.screenFrame}><Wallet identity={identity} relayUrls={relayUrls} setRelayUrls={persistRelayList} setSolanaRpc={persistSolanaRpc} setEvmRpc={persistEvmRpc} setIcGateway={persistIcGateway} onReset={onReset} onRestore={onRestore} resolvedTheme={themeOverride} themeChoice={themeChoice} onSetTheme={persistTheme} localeChoice={localeChoice} onSetLocale={persistLocale} homeCurrency={homeCurrency} onSetHomeCurrency={persistHomeCurrency} updateUrl={updateUrl} /></View>;
}
