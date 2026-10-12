import {Pressable, Text, View} from 'react-native';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {IconExternalLink, IconPlus} from './icons';
import {useEscapeToClose} from '../hooks/useHotkeys';

// The Add-funds choice (plan R1 step 3, §8 item 1 recommendation): ONE action row, and the Add
// funds press opens THIS deposit-vs-buy choice instead of routing straight to the deposit surface.
// The buy side names its provider (Mt Pelerin) the way every ramp disclosure must - no "best", no
// highlight, the deposit row stays the plain first word. Mounted at the WALLET ROOT beside the
// other overlays (the HomeMenu discipline: a popup inside Home's own box would clip to it and
// leave the bottom nav live beneath a "modal").
//
// Shape = HomeMenu verbatim: S.pickBackdrop + S.pickCard, backdrop tap dismisses, Escape closes
// (web), Android hardware Back through AppModal's onRequestClose.

export function AddFundsMenu({onDeposit, onBuy, onClose}: {
  /** The plain deposit route - the account the Home headline names. */
  onDeposit: () => void;
  /** The Mt Pelerin buy route for the same account. */
  onBuy: () => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <Pressable style={S.pickBackdrop} onPress={onClose}>
      <View testID="home-add-funds-menu" style={S.pickCard} onStartShouldSetResponder={() => true}>
        <Text style={S.pickTitle}>{M.wallet.home.actions.addFunds}</Text>
        <Pressable
          testID="btn-add-funds-deposit"
          style={S.homeMenuRow}
          onPress={onDeposit}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.mtp.chooserDeposit}
          accessibilityState={{disabled: false}}>
          <IconPlus size={18} color={C.ink} />
          <Text style={S.homeMenuRowText}>{M.deposit.mtp.chooserDeposit}</Text>
        </Pressable>
        <Pressable
          testID="btn-add-funds-buy"
          style={S.homeMenuRow}
          onPress={onBuy}
          accessibilityRole="button"
          accessibilityLabel={M.deposit.mtp.entryLabel}
          accessibilityState={{disabled: false}}>
          <IconExternalLink size={18} color={C.ink} />
          <Text style={S.homeMenuRowText}>{M.deposit.mtp.entryLabel}</Text>
        </Pressable>
        <Pressable
          testID="btn-add-funds-close"
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
