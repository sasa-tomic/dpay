import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {currencyName, type HomeCurrency} from '../config/currency';
import {HistoryRow} from './HistoryRow';
import {IconArrowDownLeft, IconChevronDown, IconPlus, IconScan} from './icons';
import {RailUnreadableNote, railUnreadable} from './RailUnreadableNote';
import type {AssetId, Txn} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The HOME tab — the LANDING screen since 2026-09-08 (founder decision, recorded in
// docs/specs/2026-09-08-first-run-redesign.md §1 F2, repealing the standing "the scanner stays the
// landing screen" rule). It has to be worth landing on, so it is an overview: a headline, one
// affordance into the accounts, an action row, and the activity feed as the BODY of the screen.
//
// ── The two pieces of state this screen distinguishes, and why (X4) ─────────────────────────────
// HOME CURRENCY is the persisted setting the whole onboarding exists to establish (Settings can
// change it, nothing else can). It owns THIS HEADLINE — the number, its unit and its eyebrow — and
// it owns the wallet's DEFAULT account. That is the founder's own wording: the home currency "sets
// the default asset, the home screen's headline number, and the unit a price is read in".
// SELECTED ASSET is a transient working choice. It starts as the home currency's rail and only a
// deliberate account tap moves it; it drives Pay, Receive, Send, the deposit surfaces and the
// header chip — never this headline.
// Before the split, tapping any account row (or flipping a rail inside an unrelated Receive sheet)
// rewrote the Home headline, so a wallet set up in francs greeted its owner with "USDC·Sol
// balance / —". A setting that any stray tap overwrites is not a setting.
// The one action here that acts on an ACCOUNT is Add money, and it acts on the home rail — the
// account this screen is showing — so no button on Home can move money in or out of an account
// the screen is not naming. Pay and Receive are navigation: they open tabs, which work on the
// selected asset, and the header chip states which one that is on every screen.
//
// ── Scan is primary ─────────────────────────────────────────────────────────────────────────────
// Landing on Home costs the returning traveller one tap on the app's most frequent action; the UX
// swarm's dissenter named the mitigation that made him withdraw the objection, and this is it. The
// button lands the Pay tab in SCAN sub-mode specifically, so the camera is live in exactly one tap
// from a cold start whatever sub-mode the Pay tab was last left in.
//
// The accounts list is NOT here — it is the `accounts` route (AccountsTab), reachable from this
// screen's `btn-home-accounts`, from the header chip on every screen, from the `a` hotkey and from
// the passport. Reasons and the ordering policy live in that file; do not restate them here.
//
// The activity feed shows the newest ledger rows through the SAME HistoryRow the Transactions tab
// renders (own token units per row), capped at ACTIVITY_ROWS with a See-all link into the full
// tab — its own home-hist-* testIDs, never the Ledger's hist-* anchors.

/** How many ledger rows the Home feed shows. Five since 2026-09-08: with the accounts list gone,
 *  Activity is the body of the screen rather than a footer under it. */
export const ACTIVITY_ROWS = 5;

export function HomeTab({assets, homeCurrency, homeAsset, balances, catalog, online, history, onScan, onReceive, onDeposit, onOpenAccounts, onSeeAll, onOpenReceipt}: {
  assets: SelectableAsset[];
  homeCurrency: HomeCurrency;
  /** The home currency's preferred rail — the account this screen IS. Null only when the catalog
   *  carries no rail for the chosen currency, which is the one case the headline cannot state. */
  homeAsset: SelectableAsset | null;
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  catalog: CurrencyDescriptor[];
  online: boolean;
  history: Txn[];
  /** The demo faucet's last failure, if any. The faucet BUTTON lives on the practice row in the
   *  accounts route, but the `T` hotkey fires it from anywhere — so its failure has to be visible
   *  on the screen the user is actually looking at, or the hotkey fails silently. */
  onScan: () => void;
  onReceive: () => void;
  onDeposit: (id: AssetId) => void;
  onOpenAccounts: () => void;
  onSeeAll: () => void;
  /** Open a row's receipt — the SAME surface the Transactions tab opens (X6). Wallet owns it, so
   *  the overlay mounts at the app root instead of inside this feed's own box. */
  onOpenReceipt: (t: Txn) => void;
}) {
  // The headline names the CURRENCY and carries the home rail's own token unit — "Swiss francs ·
  // Main" over "12.40 VCHF". The currency is the LABEL, the token is the UNIT: VCHF is a third
  // party's franc-denominated token whose peg dpay does not verify, so "CHF 12.40" would be a
  // claim while this is a fact (config/currency.ts owns that rule).
  // Offline OUTRANKS the main label: a wallet that reads "Swiss francs · Main" over a stale figure
  // would be asserting a balance it cannot know. Flow 100 exists for exactly this.
  const eyebrowName = currencyName(homeCurrency);
  const eyebrow = online
    ? M.wallet.homeCurrency.mainLabel(eyebrowName)
    : M.wallet.balance.approx(eyebrowName);
  const homeBalance = homeAsset ? balances[homeAsset.id] : undefined;
  const amount = homeBalance?.displayText ?? '—';
  const rows = history.slice(0, ACTIVITY_ROWS);
  return (
    <View>
      {/* No hand-built accessible name here: the block is not interactive, so a screen reader
          reads the two lines it renders. The name it used to carry was a SECOND copy of the
          eyebrow sentence and had already drifted from it — it said "balance" where the screen
          says "· Main" and dropped the offline "~ approx." marker, announcing a confident figure
          the wallet cannot know. The eyebrow owns that sentence; the amount owns its unit. */}
      <View testID="home-headline" style={S.homeHeadline}>
        <Text testID="home-headline-label" style={S.homeEyebrow}>{eyebrow}</Text>
        <Text testID="home-headline-amount" style={S.homeAmount}>{amount}</Text>
      </View>
      {/* An UNREADABLE headline is not a dash. The accounts route has said so since flow 147; the
          landing screen — where the home rail's number is the largest thing on the phone — printed
          the same bare "—" a first poll in flight prints. Same fact, same renderer, same words. */}
      {homeAsset !== null && railUnreadable(homeBalance) ? <RailUnreadableNote asset={homeAsset} /> : null}
      <Pressable
        testID="btn-home-accounts"
        style={S.homeAccountsBtn}
        onPress={onOpenAccounts}
        accessibilityRole="button"
        accessibilityLabel={M.wallet.home.accounts.open(assets.length)}
        accessibilityHint={M.wallet.home.accounts.openHint}
        accessibilityState={{disabled: false}}>
        <Text style={S.homeAccountsBtnText}>{M.wallet.home.accounts.open(assets.length)}</Text>
        <IconChevronDown size={14} color={C.sub2} />
      </Pressable>
      <Pressable
        testID="btn-home-scan"
        style={S.homeScanBtn}
        onPress={onScan}
        accessibilityRole="button"
        accessibilityLabel={M.wallet.home.actions.scan}
        accessibilityHint={M.wallet.home.actions.scanHint}
        accessibilityState={{disabled: false}}>
        <IconScan size={22} color={C.brandInk} />
        <Text style={S.homeScanLabel}>{M.wallet.home.actions.scan}</Text>
      </Pressable>
      <View style={S.homeActionRow}>
        <Pressable testID="btn-home-receive" style={S.homeActionBtn} onPress={onReceive} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.receive} accessibilityHint={M.wallet.home.actions.receiveHint}>
          <IconArrowDownLeft size={22} color={C.brandText} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.receive}</Text>
        </Pressable>
        {/* Add money funds the account the headline is showing — the home currency's rail. It is
            disabled only when the catalog carries no rail for that currency, which is the same
            "there is nothing to act on" rule its sibling follows. */}
        <Pressable testID="btn-home-add-money" style={[S.homeActionBtn, homeAsset === null && S.disabledFlat]} onPress={() => homeAsset !== null && onDeposit(homeAsset.id)} disabled={homeAsset === null} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.addMoney} accessibilityHint={M.wallet.home.actions.addMoneyHint} accessibilityState={{disabled: homeAsset === null}}>
          <IconPlus size={22} color={C.brandText} />
          <Text style={[S.homeActionLabel, homeAsset === null && S.disabledText]}>{M.wallet.home.actions.addMoney}</Text>
        </Pressable>
      </View>
      <View style={S.homeActivity} testID="home-activity">
        <Text style={S.histTitle}>{M.wallet.home.activity.title}</Text>
        {rows.length === 0
          ? <Text style={S.dim2}>{M.wallet.home.activity.empty}</Text>
          : rows.map((t, i) => (
            <HistoryRow key={`${i}-${t.nonce}`} t={t} i={i} catalog={catalog} assets={assets} testPrefix="home-hist" onPress={onOpenReceipt} />
          ))}
        <Pressable testID="btn-home-activity-all" style={S.homeSeeAll} onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={M.wallet.home.activity.seeAll} accessibilityHint={M.wallet.home.activity.seeAllHint}>
          <Text style={S.linkText}>{M.wallet.home.activity.seeAll}</Text>
        </Pressable>
      </View>
    </View>
  );
}
