import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {DEMO_ASSET_ID, linkNetworkOf, type SelectableAsset} from '../config/assets';
import {
  currencyName, currencyRails, preferredRail, railsLabel,
  type HomeCurrency,
} from '../config/currency';
import {AssetGlyph} from './AssetGlyph';
import {CurrencyRow} from './CurrencyRow';
import {HotkeyHint} from './HotkeyHint';
import {IconChevronLeft, IconPlus, IconSwap} from './icons';
import {RailLiquidityNote} from './RailLiquidityNote';
import {RailUnreadableNote, railUnreadable} from './RailUnreadableNote';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The CURRENCY LIST route (2026-09-24 redesign) — one row per VISIBLE currency, the wallet's
// answer to "what am I in". It evolves the 2026-09-08 accounts route, which listed one row per
// RAIL; the founder's currency-first directive folds those rails into their currency: a
// multi-rail currency shows ONE summed currency-unit balance (fork #2, computed by
// `buildCurrencyBalances`) and dpay picks the rail (the 2026-09-04 objective-2 model), so the
// per-rail rows and their switch affordance are gone — routing between rails of one currency was
// the wallet's job all along, never the user's.
//
// The gestures, and they are deliberate (the spec supersedes the X4 tap-protection rule):
//   • tapping a currency row SETS IT AS MAIN and returns Home — selection is the point;
//   • the row's Convert button opens the swap surface with that currency as the source —
//     Convert is a first-class action of EVERY currency, on every row (founder sketch);
//   • [Add new currency] opens the add-currency route, where hidden currencies come back.
//
// What is kept from the accounts route, byte-stable where the subject survives:
//   • zero-balance currencies stay visible (the asset-first rule, now per currency);
//   • the practice rail stays LAST under a divider that says in a whole sentence what it is —
//     practice money is not a currency and never enters the list (anti-scam rule R3);
//   • the testnet toggle (flow 54's reveal/hide walk);
//   • an outage belongs to a NETWORK and is stated once, above the first row it affects (X9) —
//     now per network across the currency rows' rails.
export function AccountsTab({
  assets, balances, currencyBalances, homeCurrency, visibleCurrencies, selectedId,
  demoFaucetAvailable, topUpBusy, hasTestnet, showTestnet, onToggleTestnet,
  onBack, onOpenCurrency, onConvertCurrency, onOpenAddCurrency, onSelect, onTopUp, onOpenSettings,
}: {
  assets: SelectableAsset[];
  /** The per-rail balance views — the outage banner's and the setup badge's facts. */
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  /** The per-currency SUMMED views (Wallet's buildCurrencyBalances map) — the row amounts. */
  currencyBalances: Readonly<Partial<Record<HomeCurrency, BalanceView>>>;
  homeCurrency: HomeCurrency;
  /** The visible currencies, in list order: stables, then Other (offerable minus hidden). */
  visibleCurrencies: HomeCurrency[];
  /** The working-asset selection — only the practice row still reflects it (practice is never
   *  main, so its select is the one per-asset gesture on this surface). */
  selectedId: AssetId | null;
  demoFaucetAvailable: boolean;
  topUpBusy: boolean;
  hasTestnet: boolean;
  showTestnet: boolean;
  onToggleTestnet: () => void;
  onBack: () => void;
  /** Row tap — set this currency as MAIN and go Home (the deliberate gesture). */
  onOpenCurrency: (c: HomeCurrency) => void;
  /** The row's Convert — open the swap surface with this currency as the source. */
  onConvertCurrency: (c: HomeCurrency) => void;
  /** [Add new currency] — the add-currency route. */
  onOpenAddCurrency: () => void;
  /** The practice row's select — the ONE per-asset gesture left here (practice is never main). */
  onSelect: (id: AssetId) => void;
  onTopUp: () => void;
  /** Opens Settings — the unreachable rail note's Settings ▸ Advanced escape (founder UX
   *  directive). Optional: without it the note renders as the plain fact it always was. */
  onOpenSettings?: () => void;
}) {
  // The testnet toggle renders only when there's at least one testnet currency to reveal OR
  // testnet rows are currently shown. `hasTestnet` is computed upstream from the FULL catalog.
  const showToggle = hasTestnet || showTestnet;
  // X9 — an outage belongs to a NETWORK, not to each row. Stated once, above the first currency
  // row with an unreadable rail on that network. The network is the SETTLEMENT chain
  // (`linkNetworkOf`), never the catalog `network` a chain-key row is backed BY.
  const bannered = new Set<string>();
  const demo = assets.find(a => a.id === DEMO_ASSET_ID) ?? null;
  const demoView = balances[DEMO_ASSET_ID];
  return (
    <View style={S.accountsWrap}>
      <View style={S.accountsHeader}>
        <Pressable
          testID="btn-accounts-back"
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.accounts.back}
          accessibilityState={{disabled: false}}>
          <IconChevronLeft size={26} color={C.ink} />
        </Pressable>
        <Text style={S.routeHeaderTitle}>{M.wallet.accounts.title}</Text>
        <View style={S.routeHeaderSpacer} />
      </View>
      <Text style={S.dim2}>{M.wallet.accounts.intro}</Text>
      <View style={S.accountsList} testID="accounts-list">
        {visibleCurrencies.map(currency => {
          // A visible currency always has a rail (the list is derived from the offerable set);
          // the null branch is the fail-closed shape, never a rendered row.
          const rail = preferredRail(currency, assets);
          if (rail == null) return null;
          const view = currencyBalances[currency];
          const isMain = currency === homeCurrency;
          // 'Needs setup' — the preferred rail has a KNOWN-absent token account (Solana USDC's
          // missing ATA): one tap on the row makes this the main currency, whose surfaces then
          // offer the one-tap account create. Known-absent only (offline-first honesty rule).
          const railView = balances[rail.id];
          const setupBadge = railView?.status === 'absent'
            ? <Text testID={`currency-${currency}-setup`} style={S.assetBadge}>{M.wallet.balances.needsSetup}</Text>
            : null;
          // The MAIN badge — the currency the wallet opens on, and the one Home headlines.
          const mainBadge = isMain
            ? <Text testID={`currency-${currency}-main`} style={S.assetBadgeMain}>{M.wallet.homeCurrency.mainBadge}</Text>
            : null;
          // The row: the whole left block is the set-main hit target; the Convert button is a
          // row SIBLING (never nested — RN-web renders Pressables as <button>, and a button
          // cannot contain a button). `aria-selected` marks the main currency, the one state
          // this list can be "in".
          const row = (
            <View key={currency} testID={`accounts-currency-${currency}`} style={S.assetCard} aria-selected={isMain}>
              <View style={S.assetRow}>
                <Pressable
                  testID={`btn-accounts-currency-${currency}`}
                  style={S.assetSelectBlock}
                  onPress={() => onOpenCurrency(currency)}
                  accessibilityRole="button"
                  accessibilityLabel={M.wallet.balances.select(currencyName(currency))}
                  accessibilityHint={M.wallet.accounts.setMainHint}
                  accessibilityState={{disabled: false}}
                >
                  <View style={S.assetSelect}>
                    <AssetGlyph asset={rail} />
                    <View style={S.pickTextCol}>
                      <View style={S.assetTitleRow}>
                        <Text style={S.assetLabel}>{currencyName(currency)}</Text>
                        <Text style={[S.assetAmt, view != null && view.status !== 'ok' && S.assetCardZero]}>{view?.displayText ?? '—'}</Text>
                      </View>
                      <View style={S.assetTitleRow}>
                        {mainBadge}
                        {setupBadge}
                      </View>
                      <Text style={S.assetSub}>{railsLabel(currency, assets) ?? ''}</Text>
                      {/* The rail-health footer on the preferred rail — the same renderer the
                          per-rail list used, so a thin rail says the same 2–3 words here. */}
                      <RailLiquidityNote asset={rail} tone="warn" />
                    </View>
                  </View>
                </Pressable>
                <View style={S.assetActions}>
                  {/* Convert on EVERY row — the founder sketch's per-currency action. The venue
                      check happens INSIDE the convert surface, never here. */}
                  <Pressable
                    testID={`btn-accounts-convert-${currency}`}
                    style={S.assetActionBtn}
                    onPress={() => onConvertCurrency(currency)}
                    accessibilityRole="button"
                    accessibilityLabel={M.convert.actionConvert}
                    accessibilityHint={M.wallet.accounts.convertHint}
                    accessibilityState={{disabled: false}}
                  >
                    <IconSwap size={16} color={C.brandText} />
                    <Text style={S.assetActionText}>{M.convert.actionConvert}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
          // The outage banner sits IMMEDIATELY above the first affected row of its network, so
          // the sentence and the rows it describes cannot be separated by a scroll. First
          // unreadable rail on a network not yet bannered wins; the note names that rail.
          const unreadableRail = currencyRails(currency, assets)
            .find(r => railUnreadable(balances[r.id]) && !bannered.has(linkNetworkOf(r)));
          if (unreadableRail != null) bannered.add(linkNetworkOf(unreadableRail));
          const outage = unreadableRail != null
            ? <RailUnreadableNote asset={unreadableRail} failure={balances[unreadableRail.id]?.failure ?? null} onOpenSettings={onOpenSettings} />
            : null;
          return outage ? (
            <View key={currency}>
              {outage}
              {row}
            </View>
          ) : row;
        })}
        {/* The practice divider sits IMMEDIATELY above the practice row, so the sentence and the
            thing it describes cannot be separated by a scroll (anti-scam rule R3). Practice is
            not a currency: it renders after the list, never in it. */}
        {demo != null ? (
          <View>
            <Text testID="accounts-practice-note" style={S.accountsPractice}>{M.wallet.accounts.practice}</Text>
            <CurrencyRow
              testId="asset-demo"
              asset={demo}
              amount={demoView?.displayText}
              active={selectedId === DEMO_ASSET_ID}
              zero={demoView ? demoView.status !== 'ok' : true}
              onPress={() => onSelect(DEMO_ASSET_ID)}
              accessibilityLabel={M.wallet.balances.select('DEMO')}
              accessibilityHint={M.wallet.balances.selectHint}
              variant="card"
              actions={demoFaucetAvailable ? (
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
                    ? <ActivityIndicator size="small" color={C.brandText} />
                    : <><IconPlus size={16} color={C.brandText} /><Text style={S.assetActionText}>{M.wallet.balances.demoFunds}</Text><HotkeyHint k="T" /></>}
                </Pressable>
              ) : null}
            />
          </View>
        ) : null}
        {/* The testnet rows, behind their existing toggle (the spec keeps the toggle): these are
            per-RAIL rows — a testnet row is a catalog curiosity, not a wallet currency — with the
            same select gesture the route has always carried. */}
        {showTestnet ? assets.filter(a => a.symbol.endsWith(' testnet')).map(a => (
          <CurrencyRow
            key={a.id}
            testId={`asset-${a.testKey}`}
            asset={a}
            amount={balances[a.id]?.displayText}
            active={selectedId === a.id}
            zero={balances[a.id] ? balances[a.id]!.status !== 'ok' : true}
            onPress={() => onSelect(a.id)}
            accessibilityLabel={M.wallet.balances.select(a.symbol)}
            accessibilityHint={M.wallet.balances.selectHint}
            variant="card"
          />
        )) : null}
        <Pressable
          testID="btn-accounts-add-currency"
          style={[S.assetActionBtn, S.accountsAddCurrency]}
          onPress={onOpenAddCurrency}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.accounts.addCurrency}
          accessibilityState={{disabled: false}}
        >
          <IconPlus size={16} color={C.brandText} />
          <Text style={S.assetActionText}>{M.wallet.accounts.addCurrency}</Text>
        </Pressable>
        {showToggle ? (
          <Pressable
            testID="btn-toggle-testnet"
            style={S.testnetToggle}
            onPress={onToggleTestnet}
            accessibilityRole="button"
            accessibilityLabel={showTestnet ? M.wallet.balances.hideTestnet : M.wallet.balances.showTestnet}
            accessibilityState={{disabled: false}}>
            <Text style={S.testnetToggleText}>{showTestnet ? M.wallet.balances.hideTestnet : M.wallet.balances.showTestnet}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
