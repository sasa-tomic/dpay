import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {chipLabel, type SelectableAsset} from '../config/assets';
import {currencyName, currencyOfAsset, preferredRail, railLineLabel, type HomeCurrency} from '../config/currency';
import {CurrencyRow} from './CurrencyRow';
import {HistoryRow} from './HistoryRow';
import {HotkeyHint} from './HotkeyHint';
import {IconArrowDownLeft, IconPlus, IconQr, IconSwap} from './icons';
import {RailLiquidityNote} from './RailLiquidityNote';
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
// The action row is four uniform buttons, capability-dispatched: Pay/Receive switch modes (the
// same surfaces every asset pays through); Add money fires the DEMO faucet when the demo asset is
// selected (the Balances row's topUp machinery + fail-closed copy) and otherwise lands the existing
// deposit surface for the selected asset; Convert opens the delegated-conversion surface for EVERY
// asset alike (uniform-IA hard rule) — the venue check happens INSIDE that surface, so a venue-less
// asset gets the same entry point and fails closed with honest copy there, never a hidden button.
// No per-asset special cases beyond that capability split.
//
// The accounts list (O4 S3) is the retired Balances sheet's body moved WHOLESALE — every row
// testID, the MAIN/sibling-rail badges, the DEMO faucet button, and the testnet toggle — rendered
// inline instead of behind a modal. Same contract: one row per rail (never summed, never
// reordered), `onSelect` is the ONE selection callback, and selection is Wallet's to gate (the
// lock check happens in the handler Wallet passes — a suppressed row-select is a no-op).
//
// The activity feed shows the newest ledger rows through the SAME HistoryRow the Transactions tab
// renders (own token units per row), capped at 3 with a See-all link into the full tab — its own
// home-hist-* testIDs, never the Ledger's hist-* anchors.
export function HomeTab({assets, selectedAsset, selectedId, balances, catalog, homeCurrency, homeAsset, online, history, topUpBusy, topUpErr, hasTestnet, showTestnet, onToggleTestnet, onPay, onReceive, onDeposit, onTopUp, onConvert, onSelect, onSeeAll}: {
  assets: SelectableAsset[];
  selectedAsset: SelectableAsset | null;
  selectedId: AssetId | null;
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  catalog: CurrencyDescriptor[];
  homeCurrency: HomeCurrency;
  homeAsset: SelectableAsset | null;
  online: boolean;
  history: Txn[];
  topUpBusy: boolean;
  topUpErr: string | null;
  hasTestnet: boolean;
  showTestnet: boolean;
  onToggleTestnet: () => void;
  onPay: () => void;
  onReceive: () => void;
  onDeposit: (id: AssetId) => void;
  onTopUp: () => void;
  onConvert: () => void;
  onSelect: (id: AssetId) => void;
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
  // The home currency's rail group, marked — never summed and never reordered: each rail keeps its
  // own row and balance (the founder's honesty rule: same-currency rails on different chains must
  // never read as one balance). The preferred rail (mainId) carries the MAIN badge; every OTHER
  // rail of the group carries a badge NAMING that rail (railLineLabel — "USDC · Solana") so a
  // sibling row says which rail it is instead of wearing a second MAIN or vanishing into a group
  // total.
  const mainId = preferredRail(homeCurrency, assets)?.id ?? null;
  // The testnet toggle renders only when there's at least one testnet currency to reveal OR
  // testnet rows are currently shown. `hasTestnet` is computed upstream from the FULL catalog
  // (the assets list is already filtered, so it cannot answer this on its own).
  const showToggle = hasTestnet || showTestnet;
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
        {/* Convert — the uniform fourth action. Enabled for EVERY selected asset (venue-less assets
            fail closed inside the Convert surface with honest copy); only the no-selection state
            disables it, exactly like its siblings. */}
        <Pressable testID="btn-home-convert" style={S.homeActionBtn} onPress={onConvert} disabled={selectedAsset === null} accessibilityRole="button" accessibilityLabel={M.convert.actionConvert} accessibilityHint={M.convert.actionConvert}>
          <IconSwap size={22} color={C.brand} />
          <Text style={S.homeActionLabel}>{M.convert.actionConvert}</Text>
        </Pressable>
      </View>
      {isDemo && topUpErr ? <Text testID="home-faucet-err" style={S.homeFaucetErr}>{topUpErr}</Text> : null}
      <View style={S.homeAccounts} testID="home-accounts">
        <Text style={S.histTitle}>{M.wallet.home.accounts.title}</Text>
        <Text style={S.dim2}>{M.wallet.home.accounts.intro}</Text>
        {assets.map(asset => {
          // The pre-resolved balance view for this row. The displayText is the fully-formatted
          // amount; `status !== 'ok'` is the unified dim rule (zero/absent/unavailable/error/
          // loading all dim — only a confirmed non-zero balance reads at full color).
          const view = balances[asset.id];
          const rowIsDemo = asset.protocol === 'ic' && asset.currency === 0;
          // The DEMO faucet button — the ONLY per-row action left (every on-chain send/receive
          // lives in the Pay/Receive tabs). Passed via `actions` so tapping it doesn't fire select.
          // D5b: carries the T HotkeyHint (the web keyboard top-up) so the shortcut is
          // discoverable — same badge pattern as the tab bar / header A badge.
          const faucet = rowIsDemo ? (
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
          const errLine = rowIsDemo && topUpErr
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
              {/* The rail-health footer — ONE shared slot under the badge stack, rendered by the
                  same component everywhere so the thin-liability statement (VEUR) reads with one
                  voice. Warn tone: only THIN rails carry it; deep/untiered rows render nothing
                  (no badge colours change — the note is text, not chrome). */}
              <RailLiquidityNote asset={asset} tone="warn" />
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
      </View>
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
