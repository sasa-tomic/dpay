import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {type CurrencyDescriptor, familyDisplay, assetTestKey, displayName, fmtCurrencyAmount, isTestnetCurrency, testnetDisplayName} from '../config/catalog';
import {cmpRaw} from '../lib/amount';
import {fmtAsset} from '../lib/format';
import {SOL_DECIMALS, SOL_UNIT} from '../solana/identity';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {SheetOverlay} from './SheetOverlay';

// Balances sheet — the wallet's asset hub. Reached by tapping the header balance (the main screen
// shows ONLY the current currency's balance; this screen is the sole home for the full balance list
// + every top-up). Each catalog currency renders as one compact row: name, balance, and a top-up
// action (the DEMO faucet for currency 0; a chain-key deposit for assets with a minter_family; a
// BTC cash-out for a funded CkBtcUtxo balance). Tapping a row's name/balance selects that currency
// as the wallet's "current" currency (the header then reflects it); the action buttons top up
// WITHOUT changing the current currency. Rows stay independent — no cross-asset merge.
//
// TESTNET currencies (network "Bitcoin Testnet"/"Sepolia") are HIDDEN by default and labelled
// "<symbol> testnet" (not the indistinguishable mainnet duplicate). `showTestnet` reveals them; the
// toggle only renders when there's something to reveal (or they're already shown) so a catalog with
// no testnet currencies (the e2e FakeLedger, a mainnet-only deploy) shows no no-op toggle.
//
// The SOL row is now a first-class selectable asset (like every IC row): tapping its name/balance
// selects SOL as the active asset — the header shows the SOL balance and the Pay/Receive tabs auto-
// use the SOL NFC rail. No separate chain toggle; the asset implies the rail. Receive + Send remain
// as secondary actions for the online deposit/send flows.
export function BalancesSheet({catalog, assetBalances, primaryBalance, online, currentCurrency, onSelect, onTopUp, topUpBusy, topUpErr, showTestnet, onToggleTestnet, solAddress, solBalance, activeSol, onSelectSol, onSolReceive, onSolSend, onClose}: {
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
  // separate toggle. Receive + Send are the secondary online deposit/send actions. All null when no
  // address.
  solAddress?: string | null;
  solBalance?: string | null;
  activeSol?: boolean;
  onSelectSol?: () => void;
  onSolReceive?: () => void;
  onSolSend?: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  // Hide testnet currencies unless the user has opted in. Filtered ONCE so the key/name/subtitle
  // logic below operates on the visible set. A hidden testnet asset still exists in the catalog
  // (polling/balances unaffected) — it just isn't rendered.
  const visibleCatalog = showTestnet ? catalog : catalog.filter(a => !isTestnetCurrency(a));
  // The toggle renders only when there's at least one testnet currency to reveal OR testnet rows
  // are currently shown (so the user can hide them again). A catalog with no testnet currencies
  // shows no toggle (no no-op affordance).
  const hasTestnet = catalog.some(isTestnetCurrency);
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
          {visibleCatalog.map(a => {
            const isPrimary = a.currency === 0;
            const testnet = !isPrimary && isTestnetCurrency(a);
            const key = isPrimary ? 'demo' : assetTestKey(a);
            // A testnet currency shows its testnet display name ("BTC testnet") instead of the bare
            // backing_symbol ("BTC") so it never reads as a duplicate of its mainnet sibling.
            const name = isPrimary ? 'DEMO' : (testnet ? testnetDisplayName(a) : displayName(a));
            const assetBal = assetBalances[a.currency] ?? '0';
            // MC1 units 2-4: balance presence via `cmpRaw` (BigInt) — never `> 0` on a string.
            const funded = !isPrimary && cmpRaw(assetBal, '0') > 0;
            const balanceText = isPrimary
              ? (primaryBalance == null ? '—' : `${online ? '' : '~'}${fmtCurrencyAmount(catalog, a.currency, primaryBalance)}`)
              : fmtCurrencyAmount(catalog, a.currency, assetBal);
            const active = a.currency === currentCurrency;
            // Subtitle is user-benefit, not network topology. BTC family -> "Bitcoin"; Ethereum USD
            // stablecoins (USDC/USDT) -> "US dollar stablecoin"; any other onrampable asset -> its
            // SETTLEMENT NETWORK name. A TESTNET currency shows its actual `network` so the testnet
            // status is unmistakable. DEMO keeps its "play money for testing" copy.
            const sub = isPrimary
              ? 'play money for testing'
              : testnet
                ? (a.network ?? 'testnet')
                : ((a.minter_family === 'CkBtcUtxo'
                    ? 'Bitcoin'
                    : a.minter_family === 'CkEthErc20' && (a.backing_symbol === 'USDC' || a.backing_symbol === 'USDT')
                      ? 'US dollar stablecoin'
                      : (familyDisplay(catalog, a.currency)?.networkLabel ?? 'Unsupported asset')));
            if (isPrimary) {
              // DEMO keeps a two-part row: the select area + the faucet top-up button (a sibling, so
              // tapping top-up doesn't also fire select). Every on-chain send/receive moved to the
              // Pay/Receive tabs, so DEMO is the only row that still carries an inline action.
              return (
                <View key={a.currency} testID={`asset-${key}`} style={[S.assetCard, active && S.assetCardActive]}>
                  <View style={S.assetRow}>
                    <Pressable
                      testID={`asset-${key}-select`}
                      style={S.assetSelect}
                      onPress={() => onSelect(a.currency)}
                      accessibilityRole="button"
                      accessibilityLabel={`Select ${name}`}
                      accessibilityHint="Show this asset's balance on your home screen"
                    >
                      <View style={[S.dot, {backgroundColor: active ? C.brand : C.line}]} />
                      <Text style={S.assetLabel}>{name}</Text>
                      <Text style={S.assetAmt}>{balanceText}</Text>
                    </Pressable>
                    <View style={S.assetActions}>
                      <Pressable
                        testID="btn-topup"
                        style={[S.assetActionBtn, topUpBusy && S.dim]}
                        disabled={topUpBusy}
                        onPress={onTopUp}
                        accessibilityRole="button"
                        accessibilityLabel={`Receive ${name}`}
                        accessibilityHint="Add demo funds to this wallet"
                        accessibilityState={{disabled: topUpBusy}}
                      >
                        {topUpBusy
                          ? <ActivityIndicator size="small" color={C.brand} />
                          : <><Text style={S.assetActionPlus}>+</Text><Text style={S.assetActionText}>Receive</Text></>}
                      </Pressable>
                    </View>
                  </View>
                  <Text style={S.assetSub}>{sub}</Text>
                  {topUpErr ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text> : null}
                </View>
              );
            }
            // Non-DEMO IC row: the ENTIRE card is one select Pressable (no per-row action buttons —
            // on-chain Send/Receive now lives in the Pay/Receive tabs). The container View keeps the
            // `asset-<key>` testID (read by flows that assert the row's textContent); the inner
            // Pressable carries `asset-<key>-select` (the clickable whole-row select).
            return (
              <View key={a.currency} testID={`asset-${key}`} style={[S.assetCard, active && S.assetCardActive]}>
                <Pressable
                  testID={`asset-${key}-select`}
                  style={S.assetRow}
                  onPress={() => onSelect(a.currency)}
                  accessibilityRole="button"
                  accessibilityLabel={`Select ${name}`}
                  accessibilityHint="Show this asset's balance on your home screen"
                >
                  <View style={S.assetSelect}>
                    <View style={[S.dot, {backgroundColor: active ? C.brand : C.line}]} />
                    <Text style={S.assetLabel}>{name}</Text>
                    <Text style={[S.assetAmt, !funded && S.assetCardZero]}>{balanceText}</Text>
                  </View>
                </Pressable>
                <Text style={S.assetSub}>{sub}</Text>
              </View>
            );
          })}
          {solAddress ? (
            <View testID="asset-sol" style={[S.assetCard, activeSol && S.assetCardActive]}>
              <View style={S.assetRow}>
                <Pressable
                  testID="asset-sol-select"
                  style={S.assetSelect}
                  onPress={() => onSelectSol?.()}
                  accessibilityRole="button"
                  accessibilityLabel="Select SOL"
                  accessibilityHint="Show SOL on your home screen and use the Solana rail for Pay/Receive"
                >
                  <View style={[S.dot, {backgroundColor: activeSol ? C.brand : C.line}]} />
                  <Text style={S.assetLabel}>SOL</Text>
                  <Text style={[S.assetAmt, (solBalance == null || cmpRaw(solBalance, '0') === 0) && S.assetCardZero]}>
                    {solBalance == null ? '—' : fmtAsset(solBalance, SOL_DECIMALS, SOL_UNIT)}
                  </Text>
                </Pressable>
                {onSolReceive || onSolSend ? (
                  <View style={S.assetActions}>
                    {onSolReceive ? (
                      <Pressable
                        testID="btn-sol-receive"
                        style={S.assetActionBtn}
                        onPress={onSolReceive}
                        accessibilityRole="button"
                        accessibilityLabel="Receive SOL"
                        accessibilityHint="Show your Solana deposit address">
                        <Text style={S.assetActionPlus}>+</Text><Text style={S.assetActionText}>Receive</Text>
                      </Pressable>
                    ) : null}
                    {onSolSend && solBalance != null && cmpRaw(solBalance, '0') > 0 ? (
                      <Pressable
                        testID="btn-sol-send"
                        style={S.withdrawLink}
                        onPress={onSolSend}
                        accessibilityRole="button"
                        accessibilityLabel="Send SOL"
                        accessibilityHint="Send SOL to a native Solana address">
                        <Text style={S.withdrawLinkText}>Send</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <Text style={S.assetSub}>Solana · self-custody</Text>
            </View>
          ) : null}
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
