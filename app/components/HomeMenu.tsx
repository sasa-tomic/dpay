import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {IconClock, IconClose} from './icons';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {currencyName, type HomeCurrency, type RemoveRefusal} from '../config/currency';
import type {BalanceView} from '../lib/assetBalances';

// The HOME overflow menu (the sketch's [...], 2026-09-24) — Transaction list and Remove, the two
// entries the founder named, mounted at the WALLET ROOT because a sheet inside Home's own box
// would clip to it (the X6 receipt precedent).
//
// The card reuses the pay-link refusal's popup shape (S.pickBackdrop + S.pickCard) — a short
// centered card that reads as a popup on BOTH platforms, backdrop tap dismisses, Escape closes
// (web), Android hardware Back closes it through AppModal's onRequestClose.
//
// REMOVE carries the guard's refusals inline (founder rule 2026-08-29: every refusal states the
// practical next step): a nonzero balance names the amount that must move first, an unreadable
// balance asks for a reconnect, and the last visible currency explains that the wallet stays
// "in" one. Practice money is not part of this mechanism — it never renders as a currency row,
// so it can never be removed here.

export function HomeMenu({currency, balance, refusal, onLedger, onRemove, onClose}: {
  /** The currency the menu acts on — the MAIN currency (the one Home headlines). */
  currency: HomeCurrency;
  /** The currency's summed balance — the nonzero refusal names it. */
  balance: BalanceView | null;
  /** Why the last Remove press was refused, or null (fresh menu, or the press succeeded). */
  refusal: RemoveRefusal | null;
  onLedger: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const refusalText = refusal === 'nonzero'
    ? M.wallet.home.removeRefusal.nonzero(balance?.displayText ?? '—')
    : refusal === 'unreadable'
      ? M.wallet.home.removeRefusal.unreadable
      : refusal === 'last'
        ? M.wallet.home.removeRefusal.last
        : null;
  return (
    <Pressable style={S.pickBackdrop} onPress={onClose}>
      <View testID="home-menu" style={S.pickCard} onStartShouldSetResponder={() => true}>
        <Text style={S.pickTitle}>{M.wallet.home.actions.more}</Text>
        {/* The currency this menu acts on — the one Home headlines. A menu that offers "Remove"
            without naming its object invites a tap the user cannot un-see. */}
        <Text testID="home-menu-currency" style={S.homeMenuCurrency}>{currencyName(currency)}</Text>
        {/* Transaction list — the ledger tab, by its user-facing name. */}
        <Pressable
          testID="btn-home-menu-ledger"
          style={S.homeMenuRow}
          onPress={onLedger}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.home.menu.ledger}
          accessibilityState={{disabled: false}}
        >
          <IconClock size={18} color={C.ink} />
          <Text style={S.homeMenuRowText}>{M.wallet.home.menu.ledger}</Text>
        </Pressable>
        <View>
          {/* Remove — hide this currency from the wallet's list (device-local, re-addable from
              Add new currency). The guard lives in Wallet; a refusal renders HERE, under the
              entry that caused it, with the practical next step. */}
          <Pressable
            testID="btn-home-menu-remove"
            style={S.homeMenuRow}
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel={`${M.wallet.home.menu.remove} ${currencyName(currency)}`}
            accessibilityState={{disabled: false}}
          >
            <IconClose size={18} color={C.ink} />
            <Text style={S.homeMenuRowText}>{M.wallet.home.menu.remove}</Text>
          </Pressable>
          {refusalText != null ? (
            <Text testID="home-menu-remove-refusal" style={S.warnNote}>{refusalText}</Text>
          ) : null}
        </View>
        {/* The explicit close affordance — the menu is small, and a tap target that says so beats
            guessing that the backdrop dismisses (it does, and this button says it too). */}
        <Pressable
          testID="btn-home-menu-close"
          style={S.nfcInfoClose}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={M.wallet.home.menu.close}
          accessibilityState={{disabled: false}}>
          <Text style={S.nfcInfoCloseText}>{M.wallet.home.menu.close}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}
