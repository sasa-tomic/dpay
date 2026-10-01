import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {type HomeCurrency} from '../config/currency';
import {HistoryRow} from './HistoryRow';
import {AtaSetupCard, type AtaSetupViewModel} from './AtaSetupCard';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import type {TxAnnotation} from '../services/txNotes';
import {HotkeyHint} from './HotkeyHint';
import {IconArrowUpRight, IconChevronDown, IconMore, IconPlus, IconSwap} from './icons';
import {RailUnreadableNote, railUnreadable} from './RailUnreadableNote';
import type {AssetId, Txn} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

// The HOME tab — the LANDING screen, currency-first (2026-09-24 redesign).
//
// ── The headline ────────────────────────────────────────────────────────────────────────────────
// The founder's sketch, verbatim: the eyebrow names the MAIN currency as its short code
// ("Balance CHF") and the large number is that currency's SUMMED balance in the CURRENCY unit
// ("4.54 Fr") — fork #2 (one summed figure across the rails) + fork #4 (currency unit, not token
// unit). Offline outranks everything: the best-known figure renders with the approximation marker,
// the same rule every balance surface follows.
//
// ── The action row (fork #1) ────────────────────────────────────────────────────────────────────
// Add funds / Convert / Withdraw funds / [...]. Pay and Receive stay EXACTLY where they were —
// bottom tabs, one tap from anywhere — so the row is money in, money out, and money across:
//   • Add funds = on-ramp (the funding surface for the main rail; partner off/on-ramps land here
//     as the catalog's ramp capabilities grow — no new claims in the copy);
//   • Convert = swap (the delegated-conversion engine, main currency as the source);
//   • Withdraw funds = off-ramp (the existing withdraw surface for the main rail);
//   • [...] = the overflow menu (Transaction list, Remove) — Wallet owns the sheet, the same
//     root-level overlay discipline as the receipt (X6).
//
// The currency list is NOT here — it is the accounts route, and the headline block itself is the
// affordance that opens it (2026-09-14, kept byte-stable: `btn-home-accounts`).
//
// The activity feed shows the newest ledger rows through the SAME HistoryRow the Transactions tab
// renders (own token units per row — history keeps token units under fork #4), capped at
// ACTIVITY_ROWS with a See-all link into the full tab.

/** How many ledger rows the Home feed shows. Five since 2026-09-08. */
export const ACTIVITY_ROWS = 5;

export function HomeTab({assets, homeCurrency, homeAsset, balances, currencyBalances, catalog, online, history, noteFor, onDeposit, onConvert, onWithdraw, onOpenMenu, onOpenAccounts, onSeeAll, onOpenReceipt, onOpenSettings, ataSetup, onAtaSetupStart, onAtaSetupConfirm, onAtaSetupCancel, onAtaSetupShowSol}: {
  assets: SelectableAsset[];
  homeCurrency: HomeCurrency;
  /** The main currency's preferred rail — the account this screen funds. Null only when the
   *  catalog carries no rail for the chosen currency. */
  homeAsset: SelectableAsset | null;
  /** The per-rail views — the unreadable-rail note's facts. */
  balances: Readonly<Partial<Record<AssetId, BalanceView>>>;
  /** The per-currency SUMMED views (fork #2) — the headline number's source. */
  currencyBalances: Readonly<Partial<Record<HomeCurrency, BalanceView>>>;
  catalog: CurrencyDescriptor[];
  online: boolean;
  history: Txn[];
  /** Resolve a row's device-saved annotation — the same resolver the Transactions tab uses. */
  noteFor?: (t: Txn) => TxAnnotation | undefined;
  /** Add funds — the funding surface for the main rail (the account the headline names). */
  onDeposit: (id: AssetId) => void;
  /** Convert — the swap surface, main currency as the source. */
  onConvert: () => void;
  /** Withdraw funds — the off-ramp surface for the main rail. */
  onWithdraw: () => void;
  /** [...] — opens the overflow menu (Wallet owns the sheet, at the app root). */
  onOpenMenu: () => void;
  onOpenAccounts: () => void;
  onSeeAll: () => void;
  /** Open a row's receipt — the SAME surface the Transactions tab opens (X6). */
  onOpenReceipt: (t: Txn) => void;
  /** Opens Settings — the unreachable rail note's Settings ▸ Advanced escape. */
  onOpenSettings?: () => void;
  /** The per-currency token-account setup (2026-10-01). Wallet passes it ONLY when THIS
   *  currency's SPL accounts are KNOWN absent - the card lives in the currency's own view,
   *  never as a wallet-level banner. Optional: absent = this currency needs no setup. */
  ataSetup?: AtaSetupViewModel;
  /** ONE press on the card's button: create when SOL covers; size the funding swap (the card
   *  then confirms); refused plans never reach a button at all. */
  onAtaSetupStart?: () => void;
  onAtaSetupConfirm?: () => void;
  onAtaSetupCancel?: () => void;
  onAtaSetupShowSol?: () => void;
}) {
  // The eyebrow is the sketch's "Balance CHF" — the SHORT code, the unit a price is read in.
  // Offline OUTRANKS it: the marker moves onto the whole line, and nothing is asserted that the
  // wallet cannot know. Flow 100 exists for exactly this.
  const eyebrow = online
    ? M.wallet.home.balanceEyebrow(homeCurrency)
    : M.wallet.balance.approx(M.wallet.home.balanceEyebrow(homeCurrency));
  const summary = currencyBalances[homeCurrency];
  const amount = summary?.displayText ?? '—';
  // The rail-level fact for the note: an unreadable RAIL names its network once (M2), even when
  // the summed figure still renders from another rail. No rail — nothing to name.
  const homeBalance = homeAsset ? balances[homeAsset.id] : undefined;
  const rows = history.slice(0, ACTIVITY_ROWS);
  // The three money actions act on the MAIN RAIL — the account the headline names. No rail, no
  // action: disabled with the same dim rule its siblings render by. CALIBER: the four actions
  // are cells of ONE panel (S.homeActionRow) — a disabled cell dims its icon+label in place
  // (sub2 ink), it does not grow a second box inside the panel.
  const noRail = homeAsset === null;
  const actionIcon = noRail ? C.sub2 : C.brandText;
  // The refuse panel's copy affordance: the device's SOL receive address, copied in place.
  const {copied, copy} = useCopyFeedback();
  return (
    <View>
      {/* The headline block IS the accounts affordance (kept from 2026-09-14) — tapping the
          balance opens the currency list. Its accessible name states the ACTION ("Open accounts"),
          never a second copy of the eyebrow sentence. The `a` shortcut's badge rides the eyebrow
          row, the affordance Home does have. Left-aligned on the gutter: one alignment axis for
          the whole surface (typeui ui-principles §16). */}
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
          {/* Single-line clamp: at Android fontScale 1.3 the longest form must still hold one
              line; flexShrink lets it yield to the chevron instead of overflowing the row. */}
          <Text testID="home-headline-amount" style={S.homeAmount} numberOfLines={1}>{amount}</Text>
          {/* A `⌄` beside a balance means "opens the currency list" in every wallet; without it
              the big number reads as a label, not a control. */}
          <IconChevronDown size={20} color={C.sub2} />
        </View>
      </Pressable>
      {/* An UNREADABLE rail is not a dash, and not a full story either: the note names the network
          that is not answering, once, with its Settings escape. It sits OUTSIDE the tappable
          headline — one Pressable must never nest another. */}
      {homeAsset !== null && railUnreadable(homeBalance) ? <RailUnreadableNote asset={homeAsset} failure={homeBalance?.failure} onOpenSettings={onOpenSettings} /> : null}
      {/* The per-currency setup state (2026-10-01 founder directive): the ONE setup affordance
          lives HERE, in the currency's own view, shown only when this currency's SPL accounts
          are absent (Wallet passes the view model only then). The wallet-level banner above the
          Konten list is gone; the row badge stays passive text. One currency, one card, ONE
          action. The card renders expanded (the user tapped INTO this currency deliberately) and
          states the required minimum up front (`minLine`) before anything is initiated. */}
      {ataSetup != null && ataSetup.targets.length > 0 ? (
        <AtaSetupCard
          targets={ataSetup.targets}
          kind={ataSetup.kind}
          costLine={ataSetup.costLine}
          minLine={ataSetup.minLine}
          fundFromLine={ataSetup.fundFromLine}
          confirming={ataSetup.confirming}
          confirmLine={ataSetup.confirmLine}
          busy={ataSetup.busy}
          busyLine={ataSetup.busyLine}
          err={ataSetup.err}
          solAddress={ataSetup.solAddress}
          solCopied={copied != null}
          onStart={onAtaSetupStart}
          onConfirm={onAtaSetupConfirm}
          onCancel={onAtaSetupCancel}
          onCopySolAddress={ataSetup.solAddress != null ? () => { void copy(ataSetup.solAddress!); } : undefined}
          onShowSolAddress={onAtaSetupShowSol}
          testIDPrefix={`ata-setup-${homeCurrency}`}
        />
      ) : null}
      {/* ONE divided panel (CALIBER): the four actions are cells of a single hairline-bordered
          container — not four floating cards. Cells 2..4 carry the divider; the container clips,
          so no cell carries a radius of its own. */}
      <View style={S.homeActionRow}>
        {/* Add funds — on-ramp for the account the headline is showing. */}
        <Pressable testID="btn-home-add-funds" style={S.homeActionBtn} onPress={() => homeAsset !== null && onDeposit(homeAsset.id)} disabled={noRail} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.addFunds} accessibilityState={{disabled: noRail}}>
          <IconPlus size={20} color={actionIcon} />
          <Text style={[S.homeActionLabel, noRail && S.disabledText]}>{M.wallet.home.actions.addFunds}</Text>
        </Pressable>
        {/* Convert — the swap surface, this currency as the source. */}
        <Pressable testID="btn-home-convert" style={[S.homeActionBtn, S.homeActionCell]} onPress={onConvert} disabled={noRail} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.convert} accessibilityState={{disabled: noRail}}>
          <IconSwap size={20} color={actionIcon} />
          <Text style={[S.homeActionLabel, noRail && S.disabledText]}>{M.wallet.home.actions.convert}</Text>
        </Pressable>
        {/* Withdraw funds — off-ramp for the main rail. */}
        <Pressable testID="btn-home-withdraw" style={[S.homeActionBtn, S.homeActionCell]} onPress={onWithdraw} disabled={noRail} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.withdraw} accessibilityState={{disabled: noRail}}>
          <IconArrowUpRight size={20} color={actionIcon} />
          <Text style={[S.homeActionLabel, noRail && S.disabledText]}>{M.wallet.home.actions.withdraw}</Text>
        </Pressable>
        {/* [...] — the overflow menu (Transaction list, Remove). */}
        <Pressable testID="btn-home-more" style={[S.homeActionBtn, S.homeActionCell]} onPress={onOpenMenu} accessibilityRole="button" accessibilityLabel={M.wallet.home.actions.more} accessibilityState={{disabled: false}}>
          <IconMore size={20} color={C.brandText} />
          <Text style={S.homeActionLabel}>{M.wallet.home.actions.more}</Text>
        </Pressable>
      </View>
      <View style={S.homeActivity} testID="home-activity">
        {/* Section header row: the label and its action share one row and one baseline — the
            "See all" link belongs to the section, not to a dead centered row under the list. */}
        <View style={S.homeSectionHead}>
          <Text style={S.histTitle}>{M.wallet.home.activity.title}</Text>
          <Pressable testID="btn-home-activity-all" style={S.homeSeeAll} onPress={onSeeAll} accessibilityRole="button" accessibilityLabel={M.wallet.home.activity.seeAll}>
            <Text style={S.homeSeeAllText}>{M.wallet.home.activity.seeAll}</Text>
          </Pressable>
        </View>
        {rows.map((t, i) => (
          <HistoryRow key={`${i}-${t.nonce}`} t={t} i={i} catalog={catalog} assets={assets} testPrefix="home-hist" note={noteFor?.(t)} onPress={onOpenReceipt} />
        ))}
      </View>
    </View>
  );
}
