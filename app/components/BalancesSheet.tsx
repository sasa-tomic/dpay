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
// The SOL row mirrors every other asset: Receive + Send only. The two heavier offline-pay flows
// (SolPayMode / SolReceiveMode) live as secondary actions INSIDE the SOL send/receive sheets, not
// here — keeping the row uncluttered and the offline flows reachable where they're contextually
// expected (no functionality lost, no dead code).
export function BalancesSheet({catalog, assetBalances, primaryBalance, online, currentCurrency, onSelect, onTopUp, topUpBusy, topUpErr, onAdd, onWithdraw, showTestnet, onToggleTestnet, solAddress, solBalance, onSolReceive, onSolSend, onClose}: {
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
  showTestnet: boolean;
  onToggleTestnet: () => void;
  // Native SOL rail — a SEPARATE concern from the catalog loop (a device-derived key, not a relay-
  // mediated ICRC asset). `solAddress` is null only before the key is derived; `solBalance` is null
  // when offline / not yet polled (the card renders `—`). Receive is always shown when the card
  // renders; Send is gated on a positive balance. Both are null when no address.
  solAddress?: string | null;
  solBalance?: string | null;
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
          <Text style={S.dim2}>Tap a currency to show it on your home screen. Receive or send any of them below.</Text>
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
            // (CkBtcUtxo → retrieve_btc) AND any CkEthErc20 asset whose `offramp` is enabled — native
            // ckETH (token_contract == null → withdraw_eth, single-ledger) AND ckERC20 tokens
            // (token_contract Some → withdraw_erc20, dual-ledger; the user must hold ckETH for gas).
            // The per-currency `offramp` RampCapability stays the authoritative no-swap gate (an
            // `Unavailable` direction NEVER shows the button — e.g. ckUSDT/ckDAI until their offramp
            // is wired). The `gas_ledger` field carries the ckETH gas principal for the dual-ledger
            // path; the app surfaces an honest "You need ckETH for gas" note in the WithdrawSheet.
            const cashable =
              funded &&
              a.offramp !== 'Unavailable' &&
              (a.minter_family === 'CkBtcUtxo' ||
               a.minter_family === 'CkEthErc20');
            // Subtitle is user-benefit, not network topology — drop the "Send X on Y" tautology (BTC
            // on Bitcoin, USDC on Ethereum) that names a network meaningless to a non-technical user.
            // BTC family -> "Bitcoin"; Ethereum USD stablecoins (USDC/USDT) -> "US dollar stablecoin";
            // any other onrampable asset -> its native asset name alone. A TESTNET currency shows its
            // actual `network` ("Bitcoin Testnet" / "Sepolia") so the testnet status is unmistakable.
            // DEMO (isPrimary) keeps its exact "play money for testing" copy (unchanged — the audit
            // praised it).
            const sub = isPrimary
              ? 'play money for testing'
              : testnet
                ? (a.network ?? 'testnet')
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
                          accessibilityLabel={`Receive ${name}`}
                          accessibilityHint="Add demo funds to this wallet"
                          accessibilityState={{disabled: topUpBusy}}
                        >
                          {topUpBusy
                            ? <ActivityIndicator size="small" color={C.brand} />
                            : <><Text style={S.assetActionPlus}>+</Text><Text style={S.assetActionText}>Receive</Text></>}
                        </Pressable>
                      ) : null}
                      {onrampable && !isPrimary ? (
                        <Pressable
                          testID={`asset-add-${key}`}
                          style={S.assetActionBtn}
                          onPress={() => onAdd(a.currency)}
                          accessibilityRole="button"
                          accessibilityLabel={`Receive ${name}`}
                          accessibilityHint="Open the deposit address and instructions for this asset"
                        >
                          <Text style={S.assetActionPlus}>+</Text>
                          <Text style={S.assetActionText}>Receive</Text>
                        </Pressable>
                      ) : null}
                      {cashable ? (
                        <Pressable
                          testID="btn-withdraw"
                          style={S.withdrawLink}
                          onPress={() => onWithdraw(a.currency)}
                          accessibilityRole="button"
                          accessibilityLabel={`Send ${name}`}
                          accessibilityHint="Send this asset to a native address"
                        >
                          <Text style={S.withdrawLinkText}>Send</Text>
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
          {solAddress ? (
            <View testID="asset-sol" style={S.assetCard}>
              <View style={S.assetRow}>
                <View style={S.assetSelect}>
                  <View style={[S.dot, {backgroundColor: C.brand}]} />
                  <Text style={S.assetLabel}>SOL</Text>
                  <Text style={[S.assetAmt, (solBalance == null || cmpRaw(solBalance, '0') === 0) && S.assetCardZero]}>
                    {solBalance == null ? '—' : fmtAsset(solBalance, SOL_DECIMALS, SOL_UNIT)}
                  </Text>
                </View>
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
