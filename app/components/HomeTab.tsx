import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {chipLabel, type SelectableAsset} from '../config/assets';
import {currencyName, currencyOfAsset, type HomeCurrency} from '../config/currency';
import {HistoryRow} from './HistoryRow';
import {IconArrowDownLeft, IconPlus, IconQr} from './icons';
import type {AssetId, Txn} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The balance-first HOME tab (O4) — the fourth bottom tab, one tap left of Pay. The scanner stays
// the landing screen; this surface is where the wallet's money story is told at a glance.
//
// The headline mirrors the header's eyebrow rules EXACTLY, from the same inputs: the home rail
// names the CURRENCY ("Swiss francs · Main"), any other selection names the ASSET ("DEMO balance"),
// and the offline approximation marker OUTRANKS both — a wallet must never assert a main-currency
// reading over a figure it cannot know. The amount is always the SELECTED asset's OWN balance in
// its own token unit (the header's displayText) — never an FX conversion, never a portfolio sum.
//
// The action row is three uniform buttons, capability-dispatched: Pay/Receive switch modes (the
// same surfaces every asset pays through); Add money fires the DEMO faucet when the demo asset is
// selected (the Balances row's topUp machinery + fail-closed copy) and otherwise lands the existing
// deposit surface for the selected asset. No per-asset special cases beyond that capability split.
//
// The activity feed shows the newest ledger rows through the SAME HistoryRow the Transactions tab
// renders (own token units per row), capped at 3 with a See-all link into the full tab — its own
// home-hist-* testIDs, never the Ledger's hist-* anchors.
export function HomeTab({assets, selectedAsset, balances, catalog, homeCurrency, homeAsset, online, history, topUpBusy, topUpErr, onPay, onReceive, onDeposit, onTopUp, onSeeAll}: {
  assets: SelectableAsset[];
  selectedAsset: SelectableAsset | null;
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  catalog: CurrencyDescriptor[];
  homeCurrency: HomeCurrency;
  homeAsset: SelectableAsset | null;
  online: boolean;
  history: Txn[];
  topUpBusy: boolean;
  topUpErr: string | null;
  onPay: () => void;
  onReceive: () => void;
  onDeposit: (id: AssetId) => void;
  onTopUp: () => void;
  onSeeAll: () => void;
}) {
  // The SAME name the header puts in its eyebrow: the home-currency name only when the selection
  // IS the home rail, otherwise the collision-qualified chip label. 'DEMO' is the header's
  // pre-catalog fallback name, kept identical here.
  const activeAssetName = selectedAsset ? chipLabel(selectedAsset, assets) : 'DEMO';
  const selectedIsHome = selectedAsset !== null && currencyOfAsset(selectedAsset) === homeCurrency && selectedAsset.id === homeAsset?.id;
  const eyebrowName = selectedIsHome ? currencyName(homeCurrency) : activeAssetName;
  const eyebrow = !online
    ? M.wallet.balance.approx(eyebrowName)
    : selectedIsHome
      ? M.wallet.homeCurrency.mainLabel(eyebrowName)
      : M.wallet.balance.of(eyebrowName);
  const amount = selectedAsset ? (balances[selectedAsset.id]?.displayText ?? '—') : '—';
  // The SAME DEMO capability test the Balances row uses (ic + currency 0), not a name match.
  const isDemo = selectedAsset !== null && selectedAsset.protocol === 'ic' && selectedAsset.currency === 0;
  const addMoneyLabel = isDemo ? M.wallet.balances.demoFundsLabel : M.wallet.home.actions.addMoney;
  const addMoneyHint = isDemo ? M.wallet.balances.demoFundsHint : M.wallet.home.actions.addMoneyHint;
  const rows = history.slice(0, 3);
  return (
    <View>
      <View style={S.homeHeadline} accessibilityLabel={M.wallet.home.headlineA11y(amount, eyebrowName)}>
        <Text testID="home-headline-label" style={S.homeEyebrow}>{eyebrow}</Text>
        <Text testID="home-headline-amount" style={S.homeAmount}>{amount}</Text>
      </View>
      <View style={S.homeActionRow}>
        <Pressable testID="btn-home-pay" style={S.homeActionBtn} onPress={onPay} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.pay} accessibilityHint={M.wallet.home.actions.payHint}>
          <IconQr size={22} color={C.brand} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.pay}</Text>
        </Pressable>
        <Pressable testID="btn-home-receive" style={S.homeActionBtn} onPress={onReceive} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.receive} accessibilityHint={M.wallet.home.actions.receiveHint}>
          <IconArrowDownLeft size={22} color={C.brand} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.receive}</Text>
        </Pressable>
        <Pressable testID="btn-home-add-money" style={[S.homeActionBtn, topUpBusy && S.dim]} onPress={() => (isDemo ? onTopUp() : selectedAsset !== null && onDeposit(selectedAsset.id))} disabled={topUpBusy || selectedAsset === null} accessibilityRole="button" accessibilityLabel={addMoneyLabel} accessibilityHint={addMoneyHint}>
          <IconPlus size={22} color={C.brand} />
          <Text style={S.homeActionLabel}>{addMoneyLabel}</Text>
        </Pressable>
      </View>
      {isDemo && topUpErr ? <Text testID="home-faucet-err" style={S.homeFaucetErr}>{topUpErr}</Text> : null}
      <View style={S.homeActivity} testID="home-activity">
        <Text style={S.histTitle}>{M.wallet.home.activity.title}</Text>
        {rows.length === 0
          ? <Text style={S.dim2}>{M.wallet.home.activity.empty}</Text>
          : rows.map((t, i) => (
            <HistoryRow key={`${i}-${t.nonce}`} t={t} i={i} catalog={catalog} assets={assets} testPrefix="home-hist" />
          ))}
        <Pressable testID="btn-home-activity-all" style={S.homeSeeAll} onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={M.wallet.home.activity.seeAll} accessibilityHint={M.wallet.home.activity.seeAllHint}>
          <Text style={S.linkText}>{M.wallet.home.activity.seeAll}</Text>
        </Pressable>
      </View>
    </View>
  );
}
