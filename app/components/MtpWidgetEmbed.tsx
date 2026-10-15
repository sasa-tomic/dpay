import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {WebView} from 'react-native-webview';
import {AppModal} from './AppModal';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {useEscapeToClose} from '../hooks/useHotkeys';

// MtpWidgetEmbed — the Mt Pelerin widget's IN-APP window (the founder directive: the
// integration must be seamless, 2026-10-15). A full-screen AppModal layer (the house host —
// web portal discipline in AppModal.tsx) hosting the venue's widget webview at the
// tokenized URL the relay answered (the `_ctkn` was injected SERVER-side; this component
// only ever sees the finished URL). The buy/cash-out sheets render it as a ROOT-LEVEL
// SIBLING of their own AppModal (never nested inside the sheet card — AppModal's web host
// is absolutely positioned against the nearest positioned ancestor, so nesting would clip
// the widget to the card).
//
// Escape (web) and Android hardware-back (AppModal's onRequestClose) both close; the parent
// sheet gates its own Esc handler while the embed is open (one Esc closes one thing).
export function MtpWidgetEmbed({url, onClose}: {
  /** The tokenized widget URL (relay-answered; validated by the service before it gets here). */
  url: string;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <AppModal onRequestClose={onClose}>
      <View testID="mtp-widget-embed" style={S.mtpEmbedRoot}>
        <View style={S.mtpEmbedHeader}>
          <Pressable
            testID="btn-mtp-embed-close"
            style={[S.ghostBtn, S.mtpEmbedHeaderBtn]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={M.deposit.mtp.embedClose}
            accessibilityState={{disabled: false}}>
            <Text style={S.ghostBtnText}>{M.deposit.mtp.embedClose}</Text>
          </Pressable>
        </View>
        <View style={S.mtpEmbedFrame}>
          <WebView
            source={{uri: url}}
            style={{flex: 1, backgroundColor: C.bg}}
            startInLoadingState
            renderLoading={() => (
              <View style={[S.mtpEmbedFrame, {alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg}]}>
                <ActivityIndicator size="small" color={C.brandInk} />
              </View>
            )}
          />
        </View>
      </View>
    </AppModal>
  );
}
