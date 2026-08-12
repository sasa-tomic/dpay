import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';
import {CurrencyRow} from './CurrencyRow';
import {type SelectableAsset} from '../config/assets';
import {type BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

// Balances sheet — the wallet's asset hub. Reached by tapping the header balance (the main screen
// shows ONLY the selected asset's balance; this screen is the sole home for the full balance list
// + every top-up). The sheet is a PURE renderer over the Wallet-owned selection contract:
//   • `assets`           — the complete visible list (built once by `buildSelectableAssets` upstream).
//   • `balances`         — the per-asset `Record<AssetId, BalanceView>` (built by `buildAssetBalances`).
//   • `selectedId`       — the ONE Wallet-owned selection id.
//   • `onSelect(id)`     — the ONE selection callback (IC, SOL, and Solana USDC all share it).
// Tapping any row calls `onSelect(asset.id)` — there is no `onSelectSol`, no rail prop, no binary
// SOL/USDC toggle. The DEMO row keeps its faucet button via the `actions` slot (the only per-row
// action left — every on-chain send/receive lives in the Pay/Receive tab sub-modes, uniform across
// every asset). The amount text + the zero/dim flag come from `balances[id]`.
//
// TESTNET currencies (network "Bitcoin Testnet"/"Sepolia") are HIDDEN by default upstream (the
// list builder IS the filter); `hasTestnet` tells this sheet whether the catalog carries any (so the
// toggle can offer revealing them). The toggle only renders when there's something to reveal OR
// testnet rows are currently shown.
//
// Phase 4: the ReceiveMode + SolReceiveMode pickers now consume the SAME `SelectableAsset` contract
// as this sheet (via the unified `AssetPicker`). Both selectors share the selection TRUTH (one
// `selectedAssetId`) AND the row model — there is no second list builder.
export function BalancesSheet({assets, balances, selectedId, onSelect, hasTestnet, onTopUp, topUpBusy, topUpErr, showTestnet, onToggleTestnet, onClose}: {
  assets: SelectableAsset[];
  balances: Record<AssetId, BalanceView>;
  selectedId: AssetId | null;
  onSelect: (id: AssetId) => void;
  hasTestnet: boolean;
  onTopUp: () => void;
  topUpBusy: boolean;
  topUpErr: string | null;
  showTestnet: boolean;
  onToggleTestnet: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  // The toggle renders only when there's at least one testnet currency to reveal OR testnet rows
  // are currently shown (so the user can hide them again). `hasTestnet` is computed upstream from
  // the FULL catalog (the assets list is already filtered, so it cannot answer this on its own).
  const showToggle = hasTestnet || showTestnet;
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
          {assets.map(asset => {
            // The pre-resolved balance view for this row. The displayText is the fully-formatted
            // amount; `status !== 'ok'` is the unified dim rule (zero/absent/unavailable/error/
            // loading all dim — only a confirmed non-zero balance reads at full color).
            const view = balances[asset.id];
            const isDemo = asset.protocol === 'ic' && asset.currency === 0;
            // The DEMO faucet button — the ONLY per-row action left (every on-chain send/receive
            // moved to the Pay/Receive tabs). Passed via `actions` so tapping it doesn't fire select.
            const faucet = isDemo ? (
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
            const errLine = isDemo && topUpErr
              ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text>
              : null;
            return (
              <CurrencyRow
                key={asset.testKey}
                testId={`asset-${asset.testKey}`}
                name={asset.symbol}
                subtitle={asset.networkLabel}
                amount={view?.displayText}
                active={asset.id === selectedId}
                zero={view ? view.status !== 'ok' : true}
                onPress={() => onSelect(asset.id)}
                accessibilityLabel={`Select ${asset.symbol}`}
                accessibilityHint={asset.protocol === 'solana'
                  ? `Show ${asset.symbol} on your home screen and use the Solana rail for Pay/Receive`
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
