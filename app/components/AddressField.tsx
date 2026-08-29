import {useCallback, useState} from 'react';
import {View, Text, Pressable, TextInput, Modal} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {QrScanner} from './QrScanner';
import {IconScan, IconClose} from './icons';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {SavedAddress} from '../services/addressBook';
import {M} from '../i18n';

/**
 * The ONE destination field for every send-to-address flow: type/paste, or scan a QR.
 *
 * Deliberately dumb about routing. It owns the input, the scanner modal, and the saved-address
 * chips; the OWNER supplies the `status` line (route disclosure or refusal) already resolved,
 * because deciding what a destination means requires the selected asset and the async core
 * validators — see `app/lib/destination.ts` and SendSheet.
 *
 * `QrScanner` fires onScan once per mount, so the modal mounts it fresh on open and unmounts on
 * close: one scan per opening, no re-arm state to get wrong.
 *
 * Scanned payloads are taken VERBATIM. Every IC wallet whose source was checked (Oisy, NNS dapp,
 * Plug, Stoic) puts a bare address string in its receive QR — no URI scheme, no amount params —
 * so there is nothing to strip and inventing a parser would only create a way to misread one.
 */
export function AddressField({
  value, onChange, status, saved, onPickSaved, onForgetSaved, testIDPrefix,
}: {
  value: string;
  onChange: (text: string) => void;
  /** The resolved route/refusal line, rendered under the input. null = nothing typed yet. */
  status: {text: string; tone: 'ok' | 'warn' | 'bad'} | null;
  saved: SavedAddress[];
  onPickSaved: (address: string) => void;
  onForgetSaved: (address: string) => void;
  testIDPrefix: string;
}) {
  const [scanOpen, setScanOpen] = useState(false);
  useEscapeToClose(() => setScanOpen(false));

  const onScanned = useCallback((raw: string) => {
    setScanOpen(false);
    onChange(raw.trim());
  }, [onChange]);

  return (
    <>
      <Text style={S.inputLabel}>{M.withdraw.send.destLabel}</Text>
      <View style={S.addrRow}>
        <TextInput
          testID={`${testIDPrefix}-address-input`}
          style={S.addrInput}
          value={value}
          onChangeText={onChange}
          placeholder={M.withdraw.send.destPlaceholder}
          placeholderTextColor={C.sub2}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Pressable
          testID={`${testIDPrefix}-scan`}
          style={S.addrScanBtn}
          onPress={() => setScanOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={M.withdraw.send.scanLabel}
          accessibilityState={{disabled: false}}>
          <IconScan size={20} color={C.brand} />
        </Pressable>
      </View>

      {/* The route disclosure / refusal. Always present once something is typed — the user learns
          which rail will move the money, and what it costs, BEFORE entering an amount. */}
      {status ? (
        <Text
          testID={`${testIDPrefix}-status`}
          style={status.tone === 'bad' ? S.err : status.tone === 'warn' ? S.warnNote : S.routeNote}>
          {status.text}
        </Text>
      ) : null}

      {/* Saved destinations — one tap to reuse, one to forget. Hidden entirely while the user is
          typing, so the list never competes with the field they are already using. */}
      {saved.length > 0 && value.trim().length === 0 ? (
        <View testID={`${testIDPrefix}-saved`} style={S.savedList}>
          <Text style={S.dim2}>{M.withdraw.send.savedTitle}</Text>
          {saved.map(entry => (
            <View key={entry.address} style={S.savedRow}>
              <Pressable
                testID={`${testIDPrefix}-saved-${entry.address.slice(0, 8)}`}
                style={S.savedAddrChip}
                onPress={() => onPickSaved(entry.address)}
                accessibilityRole="button"
                accessibilityLabel={entry.label || shortAddress(entry.address)}
                accessibilityState={{disabled: false}}>
                <Text style={S.savedAddrLabel}>{entry.label || M.withdraw.send.unnamed}</Text>
                <Text style={S.savedAddrText}>{shortAddress(entry.address)}</Text>
              </Pressable>
              <Pressable
                testID={`${testIDPrefix}-forget-${entry.address.slice(0, 8)}`}
                style={S.savedForget}
                onPress={() => onForgetSaved(entry.address)}
                accessibilityRole="button"
                accessibilityLabel={M.withdraw.send.forgetLabel(shortAddress(entry.address))}
                accessibilityState={{disabled: false}}>
                <IconClose size={14} color={C.sub2} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      <Modal visible={scanOpen} transparent animationType="fade" onRequestClose={() => setScanOpen(false)}>
        <View style={S.pickBackdrop}>
          <View style={S.pickCard}>
            <Text style={S.pickTitle}>{M.withdraw.send.scanTitle}</Text>
            {/* Mounted only while open — QrScanner fires once per mount, so closing and reopening
                gives a fresh scan without any re-arm bookkeeping. */}
            {scanOpen ? <QrScanner onScan={onScanned} /> : null}
            <Pressable
              testID={`${testIDPrefix}-scan-cancel`}
              style={S.nfcInfoClose}
              onPress={() => setScanOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={M.withdraw.send.scanCancel}
              accessibilityState={{disabled: false}}>
              <Text style={S.nfcInfoCloseText}>{M.withdraw.send.scanCancel}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Middle-elide a long address so both ends stay checkable — the ends are what a user compares
 *  against the source wallet, and they are what a truncation or a swapped address changes. */
export function shortAddress(a: string): string {
  return a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a;
}
