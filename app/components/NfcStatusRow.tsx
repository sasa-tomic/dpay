import {useState} from 'react';
import {View, Text, Pressable, Modal, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {NfcIcon} from './NfcIcon';
import {IconInfo} from './icons';
import {useEscapeToClose} from '../hooks/useHotkeys';
import type {NfcStatus} from '../lib/types';
import {M} from '../i18n';

/**
 * The NFC availability row — green "tap or scan" when the radio is ready, red with a tappable reason
 * when it is not, and a plain scan label on web where there is no radio at all.
 *
 * ONE implementation for BOTH rails and BOTH SIDES OF THE COUNTER. It lived inline in `PayMode` (the
 * IC rail) while `SolPayMode` had nothing: the SOL payer got no indication of whether tapping would
 * work, and no explanation when it would not — the founder's "useful practical instructions on every
 * step, especially the error path" rule applied unevenly across two screens that do the same job.
 * The Receive screens (2026-09-04) took the same fix from the other direction: they were passed a
 * boolean, so a merchant whose radio was off saw a line that named neither the problem nor the fix.
 * The row says the same thing on every surface because it is the same device fact.
 *
 * `testID` is a parameter because the two rails' scan surfaces are already distinguished by it
 * (`pay-scan` / `sol-pay-scan`) and a large number of e2e flows select on those exact strings.
 *
 * The reason popup takes the 4-state `NfcStatus`, not a boolean: "off" (radio disabled — the user
 * can fix it), "unsupported" (no hardware — they cannot) and "unknown" (the probe failed) are three
 * different instructions, and collapsing them to `nfcReady: boolean` throws away the only
 * information that makes the message actionable.
 */
export function NfcStatusRow({nfcStatus, testID}: {nfcStatus: NfcStatus; testID: string}) {
  const [infoOpen, setInfoOpen] = useState(false);
  useEscapeToClose(() => setInfoOpen(false));
  const ready = nfcStatus === 'ready';
  // 'ready' can never reach the popup (it only opens from the not-ready branch); narrowing here
  // keeps `M.nfc.reason` total over the states it actually renders.
  const reason: Exclude<NfcStatus, 'ready'> = nfcStatus === 'ready' ? 'unknown' : nfcStatus;

  return (
    <>
      {Platform.OS !== 'web' && ready ? (
        <View style={S.nfcStatusRow} testID={testID}>
          <NfcIcon color={C.brand} size={34} />
          <Text style={S.nfcStatusLabel}>{M.pay.tapOrScanToPay}</Text>
        </View>
      ) : Platform.OS !== 'web' ? (
        <View style={S.nfcStatusRow} testID={testID}>
          <NfcIcon color={C.bad} size={34} off />
          <Pressable style={S.nfcInfoLink} onPress={() => setInfoOpen(true)} accessibilityRole="button" accessibilityLabel={M.pay.whyNfcUnavailable} accessibilityState={{disabled: false}}>
            <Text style={S.nfcInfoLinkText}>{M.pay.nfcNotAvailable}</Text>
            <IconInfo size={15} color={C.sub2}/>
          </Pressable>
        </View>
      ) : (
        <Text style={[S.nfcStatusLabel, {paddingTop: 16}]} testID={testID}>{M.pay.scanToPay}</Text>
      )}
      {Platform.OS !== 'web' && !ready ? <Text style={S.dim2}>{M.pay.scanQrToPay}</Text> : null}

      <Modal visible={infoOpen} transparent animationType="fade" onRequestClose={() => setInfoOpen(false)}>
        <Pressable style={S.pickBackdrop} onPress={() => setInfoOpen(false)}>
          <View style={S.pickCard} onStartShouldSetResponder={() => true}>
            <Text style={S.pickTitle}>{M.pay.nfcUnavailableTitle}</Text>
            <Text style={S.nfcInfoBody}>{M.nfc.reason[reason]}</Text>
            <Pressable style={S.nfcInfoClose} onPress={() => setInfoOpen(false)} accessibilityRole="button" accessibilityLabel={M.pay.close} accessibilityState={{disabled: false}}>
              <Text style={S.nfcInfoCloseText}>{M.pay.close}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
