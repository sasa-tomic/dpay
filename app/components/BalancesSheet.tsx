import {View, Text, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {type CurrencyDescriptor, familyDisplay, assetTestKey, displayName, fmtCurrencyAmount} from '../config/catalog';
import {cmpRaw} from '../lib/amount';
import {useEscapeToClose} from '../hooks/useHotkeys';

// Balances sheet — the wallet's asset hub. Reached by tapping the header balance (the main screen
// shows ONLY the current currency's balance; this screen is the sole home for the full balance list
// + every top-up). Each catalog currency renders as one compact row: name, balance, and a top-up
// action (the DEMO faucet for currency 0; a chain-key deposit for assets with a minter_family; a
// BTC cash-out for a funded CkBtcUtxo balance). Tapping a row's name/balance selects that currency
// as the wallet's "current" currency (the header then reflects it); the action buttons top up
// WITHOUT changing the current currency. Rows stay independent — no cross-asset merge.
export function BalancesSheet({catalog, assetBalances, primaryBalance, online, currentCurrency, onSelect, onTopUp, topUpBusy, topUpErr, onAdd, onWithdraw, onClose}: {
  catalog: CurrencyDescriptor[];
  assetBalances: Record<number, string>;
  primaryBalance: string | null;
  online: boolean;
  currentCurrency: number;
  onSelect: (currency: number) => void;
  onTopUp: () => void;
  topUpBusy: boolean;
  topUpErr: string | null;
  onAdd: (currency: number) => void;
  onWithdraw: (currency: number) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <View style={S.sheetOverlay}>
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
          <Text style={S.dim2}>Tap a currency to show it on your home screen. Top up any of them below.</Text>
          {catalog.map(a => {
            const isPrimary = a.currency === 0;
            const key = isPrimary ? 'demo' : assetTestKey(a);
            const name = displayName(a);
            const assetBal = assetBalances[a.currency] ?? '0';
            // MC1 units 2-4: balance presence via `cmpRaw` (BigInt) — never `> 0` on a string.
            const funded = !isPrimary && cmpRaw(assetBal, '0') > 0;
            const balanceText = isPrimary
              ? (primaryBalance == null ? '—' : `${online ? '' : '~'}${fmtCurrencyAmount(catalog, a.currency, primaryBalance)}`)
              : fmtCurrencyAmount(catalog, a.currency, assetBal);
            const active = a.currency === currentCurrency;
            // MC1 unit 6 — FAIL-CLOSED: a ramp (Top Up / Cash out) exists ONLY for a KNOWN family
            // (CkBtcUtxo/CkEthErc20). familyDisplay returns null for an unknown family (e.g. CkSol) or
            // a no-minter ICRC currency → no ramp buttons render, and the subtitle is an explicit
            // "Unsupported asset" (honest, never a fake BTC label, never a crash via `!`). DEMO
            // (currency 0) is special-cased above (isPrimary) so it never reaches here.
            // MC1 unit 5: the per-currency `onramp`/`offramp` RampCapability is the authoritative
            // gate — AND-ed with the family gate so an `Unavailable` direction NEVER shows a button
            // (no-swap honesty; ckUSDC offramp is Unavailable per Fork-C/O3). This can only NARROW
            // the enabled set, never re-enable a disabled direction.
            const disp = familyDisplay(catalog, a.currency);
            const onrampable = disp !== null && a.onramp !== 'Unavailable';
            // Cash-out is offered for a funded asset whose family has a native offramp: ckBTC
            // (CkBtcUtxo → retrieve_btc) AND native ckETH (CkEthErc20 with token_contract == null →
            // withdraw_eth). The `token_contract == null` guard keeps ckUSDC (offramp Unavailable +
            // token_contract Some) fail-closed — an ERC-20 token never reaches the ETH offramp.
            const cashable =
              funded &&
              a.offramp !== 'Unavailable' &&
              (a.minter_family === 'CkBtcUtxo' ||
               (a.minter_family === 'CkEthErc20' && a.token_contract == null));
            // Subtitle is user-benefit, not network topology — drop the "Send X on Y" tautology (BTC
            // on Bitcoin, USDC on Ethereum) that names a network meaningless to a non-technical user.
            // BTC family -> "Bitcoin"; Ethereum USD stablecoins (USDC/USDT) -> "US dollar stablecoin";
            // any other onrampable asset -> its native asset name alone. DEMO (isPrimary) keeps its
            // exact "play money for testing" copy (unchanged — the audit praised it).
            const sub = isPrimary
              ? 'play money for testing'
              : onrampable && disp
                ? (a.minter_family === 'CkBtcUtxo'
                    ? 'Bitcoin'
                    : a.minter_family === 'CkEthErc20' && (a.backing_symbol === 'USDC' || a.backing_symbol === 'USDT')
                      ? 'US dollar stablecoin'
                      : disp.nativeAsset)
                : 'Unsupported asset';
            return (
              <View key={a.currency} testID={`asset-${key}`} style={S.assetCard}>
                <View style={S.assetRow}>
                  <Pressable
                    style={S.assetSelect}
                    onPress={() => onSelect(a.currency)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${name}`}
                    accessibilityHint="Show this asset's balance on your home screen"
                  >
                    <View style={[S.dot, {backgroundColor: active ? C.brand : C.line}]} />
                    <Text style={S.assetLabel}>{name}</Text>
                    <Text style={[S.assetAmt, !isPrimary && !funded && S.assetCardZero]}>{balanceText}</Text>
                  </Pressable>
                  {(isPrimary || onrampable || cashable) ? (
                    <View style={S.assetActions}>
                      {isPrimary ? (
                        <Pressable
                          testID="btn-topup"
                          style={[S.assetActionBtn, topUpBusy && S.dim]}
                          disabled={topUpBusy}
                          onPress={onTopUp}
                          accessibilityRole="button"
                          accessibilityLabel={`Top up ${name}`}
                          accessibilityHint="Add demo funds to this wallet"
                          accessibilityState={{disabled: topUpBusy}}
                        >
                          {topUpBusy
                            ? <ActivityIndicator size="small" color={C.brand} />
                            : <><Text style={S.assetActionPlus}>+</Text><Text style={S.assetActionText}>Top Up</Text></>}
                        </Pressable>
                      ) : null}
                      {onrampable && !isPrimary ? (
                        <Pressable
                          testID={`asset-add-${key}`}
                          style={S.assetActionBtn}
                          onPress={() => onAdd(a.currency)}
                          accessibilityRole="button"
                          accessibilityLabel={`Top up ${name}`}
                          accessibilityHint="Open the deposit address and instructions for this asset"
                        >
                          <Text style={S.assetActionPlus}>+</Text>
                          <Text style={S.assetActionText}>Top Up</Text>
                        </Pressable>
                      ) : null}
                      {cashable ? (
                        <Pressable
                          testID="btn-withdraw"
                          style={S.withdrawLink}
                          onPress={() => onWithdraw(a.currency)}
                          accessibilityRole="button"
                          accessibilityLabel={`Cash out ${name}`}
                          accessibilityHint="Send this asset to a native address"
                        >
                          <Text style={S.withdrawLinkText}>Cash out</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <Text style={S.assetSub}>{sub}</Text>
                {isPrimary && topUpErr ? <Text testID="topup-err" style={S.topUpErr}>{topUpErr}</Text> : null}
              </View>
            );
          })}
          {Platform.OS === 'web' ? <Text style={S.dim2}>Press Esc to close</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
