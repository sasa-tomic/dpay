import {ActivityIndicator, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S, isDark} from '../styles';
import {M} from '../i18n';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';
import {CurrencyRow} from './CurrencyRow';
import {HotkeyHint} from './HotkeyHint';
import {IconClose, IconPlus} from './icons';
import {type SelectableAsset} from '../config/assets';
import {type HomeCurrency, currencyOfAsset, preferredRail, railLineLabel} from '../config/currency';
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
export function BalancesSheet({assets, balances, selectedId, homeCurrency, onSelect, hasTestnet, onTopUp, topUpBusy, topUpErr, showTestnet, onToggleTestnet, onClose}: {
  assets: SelectableAsset[];
  balances: Record<AssetId, BalanceView>;
  selectedId: AssetId | null;
  /** The currency the wallet is "in" — its rail carries the MAIN badge. */
  homeCurrency: HomeCurrency;
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
  // The home currency's rail group, marked — never summed and never reordered: each rail keeps its
  // own row and balance (the founder's honesty rule: same-currency rails on different chains must
  // never read as one balance), and the list's order is the catalog's, which several flows read
  // positionally, so the badges carry the meaning instead. The preferred rail (mainId) carries the
  // MAIN badge; every OTHER rail of the group carries a badge NAMING that rail (the S1 rail-line
  // vocabulary — "USDC · Solana" — so a sibling row says which rail it is instead of wearing a
  // second MAIN or vanishing into a group total).
  const mainId = preferredRail(homeCurrency, assets)?.id ?? null;
  return (
    <SheetOverlay>
      <SafeAreaView style={S.sheet}>
        <StatusBar barStyle={isDark() ? 'light-content' : 'dark-content'} backgroundColor={C.bg} />
        <View style={S.sheetHead}>
          <Text style={S.sheetTitle}>{M.wallet.balances.title}</Text>
          <Pressable
            testID="btn-balances-close"
            style={S.sheetClose}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={M.wallet.balances.close}
          >
            <IconClose size={18} color={C.sub} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={S.sheetCenter} keyboardShouldPersistTaps="handled">
          {/* UX hardening round 4 (2026-08-23): the Trip Readiness passport card is GONE from
              Balances — the same 4 stamps rendered on three surfaces (home strip, this card,
              Settings archive) was founder-flagged redundancy ("widgets that don't serve any
              purpose") and it pushed the asset list (this sheet's ONE job) below the fold.
              Readiness now lives in exactly two surfaces: the home TripStrip (live entry,
              taps into the archive) and the Settings/strip archive (the permanent record). */}
          <Text style={S.dim2}>{M.wallet.balances.intro}</Text>
          {assets.map(asset => {
            // The pre-resolved balance view for this row. The displayText is the fully-formatted
            // amount; `status !== 'ok'` is the unified dim rule (zero/absent/unavailable/error/
            // loading all dim — only a confirmed non-zero balance reads at full color).
            const view = balances[asset.id];
            const isDemo = asset.protocol === 'ic' && asset.currency === 0;
            // The DEMO faucet button — the ONLY per-row action left (every on-chain send/receive
            // moved to the Pay/Receive tabs). Passed via `actions` so tapping it doesn't fire select.
            // D5b: carries the T HotkeyHint (the web keyboard top-up) so the shortcut is
            // discoverable — same badge pattern as the tab bar / header A badge.
            const faucet = isDemo ? (
              <Pressable
                testID="btn-topup"
                style={[S.assetActionBtn, topUpBusy && S.dim]}
                disabled={topUpBusy}
                onPress={onTopUp}
                accessibilityRole="button"
                accessibilityLabel={M.wallet.balances.demoFundsLabel}
                accessibilityHint={M.wallet.balances.demoFundsHint}
                accessibilityState={{disabled: topUpBusy}}
              >
                {topUpBusy
                  ? <ActivityIndicator size="small" color={C.brand} />
                  : <><IconPlus size={16} color={C.brand} /><Text style={S.assetActionText}>{M.wallet.balances.demoFunds}</Text><HotkeyHint k="T" /></>}
              </Pressable>
            ) : null;
            // The DEMO row's topUpErr line — rendered below the subtitle via `children`.
            const errLine = isDemo && topUpErr
              ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text>
              : null;
            // 'Needs setup' badge — Solana USDC with a KNOWN-absent token account ('absent' is a
            // USDC-only status: no ATA on chain). One tap on the row selects it, and every USDC
            // surface then offers the one-tap account create. Known-absent only: loading/error/
            // unavailable never claim setup is needed (offline-first honesty rule).
            const setupBadge = view?.status === 'absent'
              ? <Text testID="asset-sol-usdc-badge" style={S.assetBadge}>{M.wallet.balances.needsSetup}</Text>
              : null;
            // The MAIN badge — the account the wallet opens with, and the one a payment defaults to.
            const mainBadge = asset.id === mainId
              ? <Text testID={`asset-${asset.testKey}-main`} style={S.assetBadgeMain}>{M.wallet.homeCurrency.mainBadge}</Text>
              : null;
            // The sibling-rail badge — a rail of the home currency's group that is NOT the preferred
            // one. Its text NAMES the rail (railLineLabel: ledger token · settlement chain), never
            // "MAIN", so the two USD rows read as two named rails of one currency, each with its own
            // balance — the opposite of a merged group total.
            const railBadge = asset.id !== mainId && currencyOfAsset(asset) === homeCurrency
              ? <Text testID={`asset-${asset.testKey}-rail`} style={S.assetBadge}>{railLineLabel(asset)}</Text>
              : null;
            return (
              <CurrencyRow
                key={asset.testKey}
                testId={`asset-${asset.testKey}`}
                asset={asset}
                amount={view?.displayText}
                active={asset.id === selectedId}
                zero={view ? view.status !== 'ok' : true}
                onPress={() => onSelect(asset.id)}
                accessibilityLabel={M.wallet.balances.select(asset.symbol)}
                accessibilityHint={asset.protocol === 'solana'
                  ? M.wallet.balances.selectSolanaHint(asset.symbol)
                  : M.wallet.balances.selectHint}
                variant="card"
                actions={faucet}
              >
                {errLine}
                {mainBadge}
                {railBadge}
                {setupBadge}
              </CurrencyRow>
            );
          })}
          {showToggle ? (
            <Pressable
              testID="btn-toggle-testnet"
              style={S.testnetToggle}
              onPress={onToggleTestnet}
              accessibilityRole="button"
              accessibilityLabel={showTestnet ? M.wallet.balances.hideTestnet : M.wallet.balances.showTestnet}
              accessibilityHint={showTestnet ? M.wallet.balances.hideTestnetHint : M.wallet.balances.showTestnetHint}
              accessibilityState={{disabled: false}}>
              <Text style={S.testnetToggleText}>{showTestnet ? M.wallet.balances.hideTestnet : M.wallet.balances.showTestnet}</Text>
            </Pressable>
          ) : null}
          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.wallet.balances.escToClose}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </SheetOverlay>
  );
}
