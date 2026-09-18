import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {currencyName, type HomeCurrency} from '../config/currency';
import {HistoryRow} from './HistoryRow';
import type {TxAnnotation} from '../services/txNotes';
import {HotkeyHint} from './HotkeyHint';
import {IconArrowDownLeft, IconChevronDown, IconPlus, IconScan} from './icons';
import {RailUnreadableNote, railUnreadable} from './RailUnreadableNote';
import type {AssetId, Txn} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The HOME tab — the LANDING screen since 2026-09-08 (founder decision, recorded in
// docs/specs/2026-09-08-first-run-redesign.md §1 F2, repealing the standing "the scanner stays the
// landing screen" rule). It has to be worth landing on, so it is an overview: a headline, an
// action row, and the activity feed as the BODY of the screen.
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
// ── The action row is three EQUAL cards (2026-09-14) ────────────────────────────────────────────
// The founder killed the oversized "Scan to pay" button: the label lied (the screen behind it taps
// and beams as well as scans), and a full-width brand button over two small cards said "the other
// two barely matter". The row is now three equal cards — Pay, Receive, Add money — because a
// payments app's landing screen still needs its most frequent action visible at a glance, and
// because each card states a relation the bottom tab bar cannot: Pay pins the SCAN sub-mode (the
// camera is live in exactly one tap whatever sub-mode the Pay tab was last left in), and Add money
// funds the home rail the headline above it names. The redundancy with the tab bar is the price of
// that, and it is paid once, in small cards.
//
// The accounts list is NOT here — it is the `accounts` route (AccountsTab), reachable by tapping
// this screen's headline (the balance IS the affordance since 2026-09-14: the founder's "if the
// user clicks on the balance, they should be taken to the accounts and balances"), from the header
// chip on every other screen, from the `a` hotkey and from the passport. Reasons and the ordering
// policy live in that file; do not restate them here.
//
// The activity feed shows the newest ledger rows through the SAME HistoryRow the Transactions tab
// renders (own token units per row), capped at ACTIVITY_ROWS with a See-all link into the full
// tab — its own home-hist-* testIDs, never the Ledger's hist-* anchors.

/** How many ledger rows the Home feed shows. Five since 2026-09-08: with the accounts list gone,
 *  Activity is the body of the screen rather than a footer under it. */
export const ACTIVITY_ROWS = 5;

export function HomeTab({assets, homeCurrency, homeAsset, balances, catalog, online, history, noteFor, onPay, onReceive, onDeposit, onOpenAccounts, onSeeAll, onOpenReceipt, onOpenSettings}: {
  assets: SelectableAsset[];
  homeCurrency: HomeCurrency;
  /** The home currency's preferred rail — the account this screen IS. Null only when the catalog
   *  carries no rail for the chosen currency, which is the one case the headline cannot state. */
  homeAsset: SelectableAsset | null;
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  catalog: CurrencyDescriptor[];
  online: boolean;
  history: Txn[];
  /** Resolve a row's device-saved annotation (txNotes name/message + saved-address label) — the
   *  same resolver the Transactions tab uses, so the feed never disagrees with the full list.
   *  Optional: without it rows render exactly as the ledger said them. */
  noteFor?: (t: Txn) => TxAnnotation | undefined;
  /** The demo faucet's last failure, if any. The faucet BUTTON lives on the practice row in the
   *  accounts route, but the `T` hotkey fires it from anywhere — so its failure has to be visible
   *  on the screen the user is actually looking at, or the hotkey fails silently. */
  onPay: () => void;
  onReceive: () => void;
  onDeposit: (id: AssetId) => void;
  onOpenAccounts: () => void;
  onSeeAll: () => void;
  /** Open a row's receipt — the SAME surface the Transactions tab opens (X6). Wallet owns it, so
   *  the overlay mounts at the app root instead of inside this feed's own box. */
  onOpenReceipt: (t: Txn) => void;
  /** Opens Settings — the unreachable rail note's Settings ▸ Advanced escape (founder UX
   *  directive). Optional: without it the note renders as the plain fact it always was. */
  onOpenSettings?: () => void;
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
      {/* The headline block IS the accounts affordance (2026-09-14) — the founder's directive that
          tapping the balance opens the accounts. As an interactive element it now needs a
          hand-built accessible name, and that name states the ACTION ("Open accounts"), never a
          second copy of the eyebrow sentence: the pre-2026-09-14 name had already drifted from the
          text it paraphrased (it said "balance" where the screen says "· Main" and dropped the
          offline "~ approx." marker). The visible lines still own what they say; the label owns
          what the tap does. The `a` shortcut's badge rides the eyebrow row — the badge belongs on
          the affordance Home does have, otherwise the shortcut is undiscoverable here. */}
      <Pressable
        testID="btn-home-accounts"
        style={S.homeHeadline}
        onPress={onOpenAccounts}
        accessibilityRole="button"
        accessibilityLabel={M.wallet.home.accounts.openLabel}
        accessibilityState={{disabled: false}}>
        <View testID="home-headline" style={S.homeEyebrowRow}>
          <Text testID="home-headline-label" style={S.homeEyebrow}>{eyebrow}</Text>
          <HotkeyHint k="A" />
        </View>
        <View style={S.homeAmountRow}>
          {/* Single-line clamp: at Android fontScale 1.3 the 16-char offline form (~437px) would
              wrap and break the header hierarchy; at normal scale the amount always fits one line.
              flexShrink lets it yield to the chevron instead of overflowing the row. */}
          <Text testID="home-headline-amount" style={S.homeAmount} numberOfLines={1}>{amount}</Text>
          {/* A `⌄` beside a balance means "opens the account list" in every wallet (X7's grammar);
              without it the big number reads as a label, not a control. */}
          <IconChevronDown size={20} color={C.sub2} />
        </View>
      </Pressable>
      {/* An UNREADABLE headline is not a dash. The accounts route has said so since flow 147; the
          landing screen — where the home rail's number is the largest thing on the phone — printed
          the same bare "—" a first poll in flight prints. Same fact, same renderer, same words. It
          sits OUTSIDE the tappable headline: it carries its own Settings escape, and one Pressable
          must never nest another. */}
      {homeAsset !== null && railUnreadable(homeBalance) ? <RailUnreadableNote asset={homeAsset} failure={homeBalance?.failure} onOpenSettings={onOpenSettings} /> : null}
      <View style={S.homeActionRow}>
        {/* Pay — honestly named: the screen behind it scans, taps and beams. It pins the SCAN
            sub-mode so the camera is live in one tap whatever the Pay tab was last left on. */}
        <Pressable testID="btn-home-pay" style={S.homeActionBtn} onPress={onPay} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.pay} accessibilityHint={M.wallet.home.actions.payHint} accessibilityState={{disabled: false}}>
          <IconScan size={22} color={C.brandText} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.pay}</Text>
        </Pressable>
        <Pressable testID="btn-home-receive" style={S.homeActionBtn} onPress={onReceive} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.receive} accessibilityHint={M.wallet.home.actions.receiveHint} accessibilityState={{disabled: false}}>
          <IconArrowDownLeft size={22} color={C.brandText} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.receive}</Text>
        </Pressable>
        {/* Add money funds the account the headline is showing — the home currency's rail. It is
            disabled only when the catalog carries no rail for that currency, which is the same
            "there is nothing to act on" rule its sibling follows. */}
        <Pressable testID="btn-home-add-money" style={[S.homeActionBtn, homeAsset === null && S.disabledFlat]} onPress={() => homeAsset !== null && onDeposit(homeAsset.id)} disabled={homeAsset === null} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.addMoney} accessibilityState={{disabled: homeAsset === null}}>
          <IconPlus size={22} color={C.brandText} />
          <Text style={[S.homeActionLabel, homeAsset === null && S.disabledText]}>{M.wallet.home.actions.addMoney}</Text>
        </Pressable>
      </View>
      <View style={S.homeActivity} testID="home-activity">
        <Text style={S.histTitle}>{M.wallet.home.activity.title}</Text>
        {rows.map((t, i) => (
          <HistoryRow key={`${i}-${t.nonce}`} t={t} i={i} catalog={catalog} assets={assets} testPrefix="home-hist" note={noteFor?.(t)} onPress={onOpenReceipt} />
        ))}
        <Pressable testID="btn-home-activity-all" style={S.homeSeeAll} onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={M.wallet.home.activity.seeAll}>
          <Text style={S.linkText}>{M.wallet.home.activity.seeAll}</Text>
        </Pressable>
      </View>
    </View>
  );
}
