import {Pressable, Text, View} from 'react-native';
import {AppModal} from './AppModal';
import {S} from '../styles';
import {M} from '../i18n';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {wcChainName} from './WcRequestSheet';
import type {WcSession} from '../walletkit';

// WcEntrySheet - the WalletConnect entry + management surface (the founder directive 2026-10-15:
// WalletConnect "needs more than opening wc: - QR, likely instructions, some UI changes"). One
// root-mounted card serving both jobs:
//
//   • ENTRY: four instruction lines (what pairing does, how the user gets a dApp's QR, the
//     never-auto-approve honesty line, the disconnect fact) and ONE primary action that closes
//     over the pay tab's already-live camera - the scan itself is the same classifier path a
//     scanned `wc:` QR always took (lib/scan.ts → Wallet.pairWc).
//   • MANAGEMENT: below the action, when `discover()` returns settled sessions, one row per
//     connected dApp (name + chains + Disconnect). The empty state is deliberately NOTHING: the
//     instruction block above IS the empty state (the copy law - no empty-section chrome).
//
// SEAM: TYPE-only import of WcSession (erased); the session rows arrive mapped by
// `connectedAppOf`, the disconnect/search functions are handed in by the Wallet (the
// WcRequestSheet seam law - this module never imports `@reown/*`/`@walletconnect/*`).
// MOUNT POINT: the Wallet ROOT, beside WcRequestSheet (the HistoryRow.tsx mount law - an
// AppModal inside a tab's box would clip to it).

/** One connected dApp as the sheet shows it: the session topic (the disconnect handle), the
 *  dApp's own metadata name/url, and the CAIP-2 chains the session spans. */
export interface WcConnectedApp {
  readonly topic: string;
  readonly name: string;
  readonly url: string;
  readonly chains: readonly string[];
}

/** Map one settled session to its row (pure; exported so the suite pins the extraction). */
export function connectedAppOf(session: WcSession): WcConnectedApp {
  const md = (session.peer as {metadata?: {name?: unknown; url?: unknown}} | undefined)?.metadata;
  const chains = Object.values(session.namespaces ?? {}).flatMap((n) =>
    Array.isArray(n?.chains) ? (n.chains as unknown[]).filter((c): c is string => typeof c === 'string') : [],
  );
  return {
    topic: session.topic,
    name: typeof md?.name === 'string' ? md.name : '',
    url: typeof md?.url === 'string' ? md.url : '',
    chains,
  };
}

export function WcEntrySheet({sessions, busyTopic, failed, onScan, onDisconnect, onClose}: {
  /** The live sessions (`walletkit.discover()` mapped through `connectedAppOf`), null while
   *  loading. Empty = no section at all (the instructions above are the empty state). */
  sessions: readonly WcConnectedApp[] | null;
  /** The topic whose disconnect is in flight; its row's button is busy, the rest stay live. */
  busyTopic: string | null;
  /** The last disconnect threw: the one-line error under the list, retry one tap away. */
  failed: boolean;
  /** The sheet's primary action: close it - the pay tab's camera is already live beneath. */
  onScan: () => void;
  onDisconnect: (topic: string) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  return (
    <AppModal onRequestClose={onClose}>
      {/* The centered-card idiom (the pay-link refusal / HomeMenu shape): backdrop dismisses, the
          card swallows the press. Nothing is pending here, so dismissal is always safe. */}
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        <View testID="wc-entry-sheet" style={S.pickCard} onStartShouldSetResponder={() => true}>
          <Text style={S.pickTitle}>{M.pay.wc.connectEntry}</Text>
          <Text style={S.receiptNote}>{M.pay.wc.entryWhat}</Text>
          <Text style={S.receiptNote}>{M.pay.wc.entryHow}</Text>
          <Text style={S.receiptNote}>{M.pay.wc.entryHonest}</Text>
          <Text style={S.receiptNote}>{M.pay.wc.entryDisconnect}</Text>
          <Pressable
            testID="btn-wc-entry-scan"
            style={S.primaryWide}
            onPress={onScan}
            accessibilityRole="button"
            accessibilityLabel={M.pay.wc.entryScan}
            accessibilityState={{disabled: false}}>
            <Text style={S.primaryText}>{M.pay.wc.entryScan}</Text>
          </Pressable>
          {sessions != null && sessions.length > 0 ? (
            <View>
              <Text style={[S.pickTitle, {marginTop: 12}]}>{M.pay.wc.sessionsTitle}</Text>
              {sessions.map((s) => (
                <View key={s.topic} testID={`wc-session-${s.topic}`} style={S.homeMenuRow}>
                  <View style={{flex: 1}}>
                    <Text style={S.homeMenuRowText} numberOfLines={1}>{s.name !== '' ? s.name : s.url}</Text>
                    {s.chains.length > 0 ? <Text style={S.dim2}>{s.chains.map(wcChainName).join(', ')}</Text> : null}
                  </View>
                  <Pressable
                    testID={`btn-wc-disconnect-${s.topic}`}
                    style={S.smallBtn}
                    disabled={busyTopic === s.topic}
                    onPress={() => onDisconnect(s.topic)}
                    accessibilityRole="button"
                    accessibilityLabel={M.pay.wc.disconnect}
                    accessibilityState={{disabled: busyTopic === s.topic}}>
                    <Text style={S.smallBtnText}>{M.pay.wc.disconnect}</Text>
                  </Pressable>
                </View>
              ))}
              {failed ? <Text testID="wc-disconnect-failed" style={S.err}>{M.pay.wc.disconnectFailed}</Text> : null}
            </View>
          ) : null}
        </View>
      </Pressable>
    </AppModal>
  );
}
