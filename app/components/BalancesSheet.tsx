import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {type CurrencyDescriptor, isTestnetCurrency} from '../config/catalog';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';
import {CurrencyRow} from './CurrencyRow';
import {buildCurrencyList} from '../lib/assetList';

// Balances sheet — the wallet's asset hub. Reached by tapping the header balance (the main screen
// shows ONLY the current currency's balance; this screen is the sole home for the full balance list
// + every top-up). Each catalog currency + the synthetic SOL row renders as ONE shared CurrencyRow
// (variant='card') driven by buildCurrencyList — the SAME component the ReceiveMode picker consumes
// (variant='plain'), so the two selectors share one visual language (Issues #2 + #3). Tapping a row
// selects that currency as the wallet's "current" currency; the DEMO row keeps its faucet button via
// the `actions` slot. On-chain Send/Receive lives in the Pay/Receive tab sub-modes (uniform across
// every asset).
//
// TESTNET currencies (network "Bitcoin Testnet"/"Sepolia") are HIDDEN by default and labelled
// "<symbol> testnet" (not the indistinguishable mainnet duplicate). `showTestnet` reveals them; the
// toggle only renders when there's something to reveal (or they're already shown) so a catalog with
// no testnet currencies (the e2e FakeLedger, a mainnet-only deploy) shows no no-op toggle.
export function BalancesSheet({catalog, assetBalances, primaryBalance, online, currentCurrency, onSelect, onTopUp, topUpBusy, topUpErr, showTestnet, onToggleTestnet, solAddress, solBalance, activeSol, onSelectSol, onClose}: {
  catalog: CurrencyDescriptor[];
  assetBalances: Record<number, string>;
  primaryBalance: string | null;
  online: boolean;
  currentCurrency: number;
  onSelect: (currency: number) => void;
  onTopUp: () => void;
  topUpBusy: boolean;
  topUpErr: string | null;
  showTestnet: boolean;
  onToggleTestnet: () => void;
  // Native SOL rail — a SEPARATE concern from the catalog loop (a device-derived key, not a relay-
  // mediated ICRC asset). `solAddress` is null only before the key is derived; `solBalance` is null
  // when offline / not yet polled (the card renders `—`). Tapping the SOL row selects it as the
  // active asset (the header + Pay/Receive tabs follow) — the rail is inferred from the asset, no
  // separate toggle. On-chain Send/Receive lives in the Pay/Receive tab sub-modes (uniform with IC).
  // All null when no address.
  solAddress?: string | null;
  solBalance?: string | null;
  activeSol?: boolean;
  onSelectSol?: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  // The toggle renders only when there's at least one testnet currency to reveal OR testnet rows
  // are currently shown (so the user can hide them again). A catalog with no testnet currencies
  // shows no toggle (no no-op affordance).
  const hasTestnet = catalog.some(isTestnetCurrency);
  const showToggle = hasTestnet || showTestnet;
  // The unified currency list — IC catalog entries + the synthetic SOL entry (when solAddress is
  // non-null). Subtitles, names, amounts, and the active/zero flags are computed ONCE here so both
  // this sheet and the ReceiveMode picker render byte-identical labels.
  const items = buildCurrencyList({catalog, assetBalances, primaryBalance, online, showTestnet, currentCurrency, activeSol: !!activeSol, solAddress: solAddress ?? null, solBalance: solBalance ?? null});
  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>Balances</Text>
          <Pressable
            testID="btn-balances-close"
            style={S.sheetClose}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close balances"
          >
            <Text style={S.sheetCloseX}>✕</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          <Text style={S.dim2}>Tap a currency to show it on your home screen. Receive or send it from the Receive and Pay tabs.</Text>
          {items.map(item => {
            // The DEMO faucet button — the ONLY per-row action left (every on-chain send/receive
            // moved to the Pay/Receive tabs). Passed via `actions` so tapping it doesn't fire select.
            const faucet = item.kind === 'ic' && item.desc.currency === 0 ? (
              <Pressable
                testID="btn-topup"
                style={[S.assetActionBtn, topUpBusy && S.dim]}
                disabled={topUpBusy}
                onPress={onTopUp}
                accessibilityRole="button"
                accessibilityLabel={`Get demo funds`}
                accessibilityHint="Add ∂100 of demo money to this wallet"
                accessibilityState={{disabled: topUpBusy}}
              >
                {topUpBusy
                  ? <ActivityIndicator size="small" color={C.brand} />
                  : <><Text style={S.assetActionPlus}>+</Text><Text style={S.assetActionText}>Demo funds</Text></>}
              </Pressable>
            ) : null;
            // The DEMO row's topUpErr line — rendered below the subtitle via `children`.
            const errLine = item.kind === 'ic' && item.desc.currency === 0 && topUpErr
              ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text>
              : null;
            return (
              <CurrencyRow
                key={item.key}
                testId={`asset-${item.key}`}
                name={item.name}
                subtitle={item.subtitle}
                amount={item.amountText ?? undefined}
                active={item.active}
                zero={item.zero}
                onPress={() => {
                  if (item.kind === 'sol') onSelectSol?.();
                  else onSelect(item.desc.currency);
                }}
                accessibilityLabel={item.kind === 'sol' ? 'Select SOL' : `Select ${item.name}`}
                accessibilityHint={item.kind === 'sol'
                  ? 'Show SOL on your home screen and use the Solana rail for Pay/Receive'
                  : 'Show this asset\'s balance on your home screen'}
                variant="card"
                actions={faucet}
              >
                {errLine}
              </CurrencyRow>
            );
          })}
          {showToggle ? (
            <Pressable
              testID="btn-toggle-testnet"
              style={S.testnetToggle}
              onPress={onToggleTestnet}
              accessibilityRole="button"
              accessibilityLabel={showTestnet ? 'Hide testnet assets' : 'Show testnet assets'}
              accessibilityHint={showTestnet ? 'Hide testnet currencies from this list' : 'Reveal testnet currencies in this list'}
              accessibilityState={{disabled: false}}>
              <Text style={S.testnetToggleText}>{showTestnet ? 'Hide testnet assets' : 'Show testnet assets'}</Text>
            </Pressable>
          ) : null}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SheetOverlay>
  );
}
