import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {DEMO_ASSET_ID, type SelectableAsset} from '../config/assets';
import {
  chooseRail, currencyName, currencyOfAsset, currencyRails, groupAccountsByCurrency, preferredRail,
  railLineLabel, type HomeCurrency,
} from '../config/currency';
import {linkNetworkOf} from '../config/assets';
import {CurrencyRow} from './CurrencyRow';
import {HotkeyHint} from './HotkeyHint';
import {IconChevronLeft, IconPlus, IconSwap} from './icons';
import {RailLiquidityNote} from './RailLiquidityNote';
import {RailUnreadableNote, railUnreadable} from './RailUnreadableNote';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The ACCOUNTS route (2026-09-08) — every account this wallet can hold, one row per rail.
//
// It is a ROUTE, not a tab and not a modal: it is entered from the header balance chip (on every
// screen, including the Pay scanner), from tapping the HOME HEADLINE (the balance itself, since
// 2026-09-14 — `btn-home-accounts` rides the headline block), from the
// `a` hotkey, and from the passport's FUNDS LOADED step; it is left by its own Back control or by
// the hardware back button, which return the user to the surface they came from. The list itself
// is the retired Balances sheet's body, moved here VERBATIM from the Home tab (O4 S3 → this):
// every row testID is byte-stable, only the container name changed (`home-accounts` →
// `accounts-list`, because the old name would now be a lie).
//
// WHY IT LEFT HOME: the list was ~80% of the Home surface — measured 1308/1652 px, nine of ten
// rows zero on a new wallet (X2). A screen that is mostly empty money rows reads as a demand.
// `CLAUDE.md`'s asset-first rule is untouched: every enabled asset, including every zero-balance
// row, is still visible and never hidden behind a positive-balance condition — it is one gesture
// away from every screen instead of zero gestures from one.
//
// ORDER (X22). DEMO used to sit first carrying the largest number on screen (∂100.00, above BTC
// and USDC) — play money presented as the user's biggest holding. The order is now:
//   1. the home currency's rails, preferred rail first (the account the wallet is "in");
//   2. every other real account that HOLDS something;
//   3. every other real account that does not;
//   4. the practice rail, under a divider that says in a whole sentence what it is.
// Buckets 2 and 3 keep catalog order internally. They are deliberately NOT sorted by amount:
// ranking 0.0005 BTC against 100 USDC is an FX comparison, and dpay does not quote FX (no-swap
// non-negotiable). "Holds something" is a boolean fact about one asset; a magnitude ordering
// across unlike assets would be a claim.
//
// SECTIONS (multi-currency build-out, 2026-09): the ordered list above is then partitioned by the
// currency each account settles — `groupAccountsByCurrency` (config/currency.ts), presentation
// only over `orderAccounts`' order. Each section is headed by the CURRENCY'S NAME ("Main · Swiss
// francs", "US dollars", "Other assets"): the header is a label, never a total — the rows keep
// their own units and nothing is summed. A multi-rail currency section carries ONE switch
// affordance (below), because moving between rails of one currency is routing, not exchange.
export function AccountsTab({
  assets, selectedId, balances, homeCurrency, demoFaucetAvailable, topUpBusy,
  hasTestnet, showTestnet, onToggleTestnet, onBack, onSelect, onSwitchRail, onTopUp, onConvert, onOpenSettings,
}: {
  assets: SelectableAsset[];
  selectedId: AssetId | null;
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  homeCurrency: HomeCurrency;
  demoFaucetAvailable: boolean;
  topUpBusy: boolean;
  hasTestnet: boolean;
  showTestnet: boolean;
  onToggleTestnet: () => void;
  onBack: () => void;
  onSelect: (id: AssetId) => void;
  /** The currency-level rail switch (Wallet's `payRailSwitch` — the SAME lock-gated gesture the
   *  Pay fund gates use). Absent while the selection is LOCKED, so the affordance disappears
   *  instead of appearing dead — the same contract `FundedSiblingRail` renders by. */
  onSwitchRail?: (id: AssetId) => void;
  onTopUp: () => void;
  onConvert: () => void;
  /** Opens Settings — the unreachable rail note's Settings ▸ Advanced escape (founder UX
   *  directive). Optional: without it the note renders as the plain fact it always was. */
  onOpenSettings?: () => void;
}) {
  // The home currency's rail group, marked — never summed and never reordered within itself: each
  // rail keeps its own row and balance (the founder's honesty rule: same-currency rails on
  // different chains must never read as one balance). The preferred rail (mainId) carries the MAIN
  // badge; every OTHER rail of the group carries a badge NAMING that rail (railLineLabel —
  // "USDC · Solana") so a sibling row says which rail it is instead of wearing a second MAIN.
  const mainId = preferredRail(homeCurrency, assets)?.id ?? null;
  const ordered = orderAccounts(assets, balances, homeCurrency);
  // The currency sections over that order (module header): home first, then every other offered
  // currency, then the non-currency tail. Presentation only — the row order inside a section is
  // exactly `ordered`'s.
  const sections = groupAccountsByCurrency(ordered, homeCurrency);
  // The testnet toggle renders only when there's at least one testnet currency to reveal OR
  // testnet rows are currently shown. `hasTestnet` is computed upstream from the FULL catalog
  // (the assets list is already filtered, so it cannot answer this on its own).
  const showToggle = hasTestnet || showTestnet;
  // X9 — an outage belongs to a NETWORK, not to each account on it. When an endpoint refuses (the
  // measured case: the baked Helius key answering HTTP 429) every account on that network flips to
  // 'error' in the same poll, and this list used to print the identical ~48-word paragraph on all
  // three Solana rows — ~120 words of alarm text for ONE fact. The banner is now emitted once, and
  // it is emitted immediately ABOVE the first affected row of that network so the sentence and the
  // rows it describes cannot be separated by a scroll (the same rule the practice divider follows).
  //
  // The network is the SETTLEMENT chain (`linkNetworkOf`), never the asset's catalog `network` —
  // that field names the chain a chain-key asset is BACKED by, so an IC relay outage read off it
  // would have claimed "The Bitcoin network is not answering" on the ckBTC row.
  const bannered = new Set<string>();
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
        {sections.map(section => {
          // The section header NAMES the currency — the label is the currency, the token is the
          // unit (config/currency.ts rule 2). It is never a total: no number is rendered here.
          const isHome = section.currency === homeCurrency;
          const slug = section.currency === null ? 'other' : section.currency.toLowerCase();
          const header = (
            <View key={`group-${slug}`} style={S.accountsGroupHead}>
              <Text testID={`accounts-group-${slug}`} style={S.accountsGroupLabel}>
                {section.currency === null
                  ? M.wallet.accounts.groupOther
                  : isHome
                  ? M.wallet.accounts.groupHome(currencyName(section.currency))
                  : currencyName(section.currency)}
              </Text>
              {/* The currency-level rail switch (E2): ONE affordance per MULTI-RAIL currency
                  section, resolving `chooseRail` to the funded — else preferred — rail of THIS
                  currency. Routing between rails of one currency, never an exchange, never a
                  home-currency change (Settings owns that). A single-rail section gets none (its
                  row is the only rail — selecting the row IS the switch), and it hides when the
                  resolved rail is already the selected row (a control that would re-select the
                  same account is not a control) or while the selection is LOCKED (onSwitchRail is
                  then undefined — the same contract the Pay fund gates' sibling pointer renders
                  by, flow 71). */}
              {section.currency !== null && currencyRails(section.currency, assets).length > 1 && onSwitchRail != null
                ? (() => {
                    const choice = chooseRail(section.currency, assets, balances);
                    if (choice == null || choice.rail.id === selectedId) return null;
                    return (
                      <Pressable
                        testID={`btn-accounts-rail-${slug}`}
                        style={S.linkBtn}
                        onPress={() => onSwitchRail(choice.rail.id)}
                        accessibilityRole="button"
                        accessibilityLabel={M.wallet.accounts.switchRail(railLineLabel(choice.rail))}
                        accessibilityState={{disabled: false}}>
                        <Text style={S.linkText}>{M.wallet.accounts.switchRail(railLineLabel(choice.rail))}</Text>
                      </Pressable>
                    );
                  })()
                : null}
            </View>
          );
          return (
            <View key={`section-${slug}`}>
              {header}
              {section.assets.map(asset => {
                // The pre-resolved balance view for this row. The displayText is the fully-formatted
                // amount; `status !== 'ok'` is the unified dim rule (zero/absent/unavailable/error/
                // loading all dim — only a confirmed non-zero balance reads at full color).
                const view = balances[asset.id];
                const rowIsDemo = asset.id === DEMO_ASSET_ID;
                const isSelected = asset.id === selectedId;
                // Convert — the per-asset delegated-conversion entry, on the SELECTED row only. It left
                // the Home action row (X15): it is honest-but-inert for most accounts, and a top-level
                // slot on the landing screen is not what an action that mostly explains itself earns.
                // Rendering it per-row-when-selected is uniform (every asset reaches it by the SAME
                // gesture — select the row, tap Convert) without minting eight inert buttons. The venue
                // check still happens INSIDE the Convert surface, never here.
                const convert = isSelected ? (
                  <Pressable
                    testID="btn-accounts-convert"
                    style={S.assetActionBtn}
                    onPress={onConvert}
                    accessibilityRole="button"
                    accessibilityLabel={M.convert.actionConvert}
                    accessibilityHint={M.wallet.accounts.convertHint}
                    accessibilityState={{disabled: false}}
                  >
                    <IconSwap size={16} color={C.brandText} />
                    <Text style={S.assetActionText}>{M.convert.actionConvert}</Text>
                  </Pressable>
                ) : null;
                // The DEMO faucet button — the practice rail's own top-up. Passed via `actions` so
                // tapping it doesn't fire select. D5b: carries the T HotkeyHint (the web keyboard
                // top-up) so the shortcut is discoverable — same badge pattern as the tab bar.
                const faucet = rowIsDemo && demoFaucetAvailable ? (
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
                ) : null;
                // 'Needs setup' badge — Solana USDC with a KNOWN-absent token account ('absent' is a
                // USDC-only status: no ATA on chain). One tap on the row selects it, and every USDC
                // surface then offers the one-tap account create. Known-absent only: loading/error/
                // unavailable never claim setup is needed (offline-first honesty rule).
                const setupBadge = view?.status === 'absent'
                  ? <Text testID="asset-sol-usdc-badge" style={S.assetBadge}>{M.wallet.balances.needsSetup}</Text>
                  : null;
                // A balance the wallet could not READ ('error': the chain's endpoint refused or failed).
                // It rendered the same bare "—" as a first poll still in flight, which told the user
                // nothing about which of the two it was. The network-level banner (built below, above
                // this row) says what happened, that nothing moved, that the other accounts still work,
                // and that the retry is automatic — no button is promised because none would help.
                // Status-driven, never rail-specific: any rail that reports 'error' gets the same line,
                // once, for its network.
                const netSlug = linkNetworkOf(asset);
                const outage = railUnreadable(view) && !bannered.has(netSlug);
                if (outage) bannered.add(netSlug);
                const banner = outage ? <RailUnreadableNote key={`outage-${netSlug}`} asset={asset} failure={view?.failure ?? null} onOpenSettings={onOpenSettings} /> : null;
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
                const row = (
                  <CurrencyRow
                    key={asset.testKey}
                    testId={`asset-${asset.testKey}`}
                    asset={asset}
                    amount={view?.displayText}
                    active={isSelected}
                    zero={view ? view.status !== 'ok' : true}
                    onPress={() => onSelect(asset.id)}
                    accessibilityLabel={M.wallet.balances.select(asset.symbol)}
                    accessibilityHint={asset.protocol === 'solana'
                      ? M.wallet.balances.selectSolanaHint(asset.symbol)
                      : M.wallet.balances.selectHint}
                    variant="card"
                    actions={convert || faucet ? <>{convert}{faucet}</> : null}
                  >
                    {mainBadge}
                    {railBadge}
                    {setupBadge}
                    {/* The rail-health footer — ONE shared slot under the badge stack, rendered by the
                        same component everywhere so a thin rail's statement reads with one
                        voice. Warn tone: only THIN rails carry it; deep/untiered rows render nothing
                        (no badge colours change — the note is text, not chrome). */}
                    <RailLiquidityNote asset={asset} tone="warn" />
                  </CurrencyRow>
                );
                // The practice divider sits IMMEDIATELY above the practice row, so the sentence and the
                // thing it describes cannot be separated by a scroll (anti-scam rule R3). The outage
                // banner sits in the same position, above the first row of the network it is about.
                return rowIsDemo || banner
                  ? (
                    <View key={asset.testKey}>
                      {banner}
                      {rowIsDemo ? <Text testID="accounts-practice-note" style={S.accountsPractice}>{M.wallet.accounts.practice}</Text> : null}
                      {row}
                    </View>
                  )
                  : row;
              })}
            </View>
          );
        })}
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

/**
 * X22 — the account order. PURE and exported so it is testable without a renderer: the whole point
 * of this function is that it is a stated policy rather than whatever order the catalog happened
 * to have. See the module header for the four buckets and for why "holds something" is a boolean
 * and never a magnitude comparison.
 *
 * Every input asset appears exactly once in the output: the buckets partition the list.
 */
export function orderAccounts(
  assets: SelectableAsset[],
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>,
  homeCurrency: HomeCurrency,
): SelectableAsset[] {
  const homeRails = preferredRail(homeCurrency, assets) === null
    ? []
    : assets.filter(a => currencyOfAsset(a) === homeCurrency);
  // Preferred rail first inside the home group; the rest keep catalog order.
  const mainId = preferredRail(homeCurrency, assets)?.id ?? null;
  const home = [...homeRails].sort((a, b) => (a.id === mainId ? -1 : 0) - (b.id === mainId ? -1 : 0));
  const rest = assets.filter(a => !homeRails.includes(a) && a.id !== DEMO_ASSET_ID);
  const holds = (a: SelectableAsset) => balances[a.id]?.status === 'ok';
  const practice = assets.filter(a => a.id === DEMO_ASSET_ID);
  return [...home, ...rest.filter(holds), ...rest.filter(a => !holds(a)), ...practice];
}
