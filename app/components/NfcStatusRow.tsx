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
 * when it is not. ONE row for every state and every platform: web has no radio, so its not-ready
 * state renders the same honest treatment as a native phone without NFC hardware (reason
 * `unsupported`), NOT a scan title — the scan title duplicated the ModeToggle's own "Scan to pay"
 * segment on every send-capable surface (G1, 2026-09-28). The scan phase carries its own testID
 * (`pay-scan` / `sol-pay-scan` on the phase container, NOT on this row); the row's carrier is
 * `pay-nfc-row` / `sol-nfc-row`.
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
 * (`pay-nfc-row` / `sol-nfc-row`). The scan-surface carriers (`pay-scan` / `sol-pay-scan`) live on
 * the phase containers in PayMode/SolPayMode.
 *
 * The reason popup takes the 4-state `NfcStatus`, not a boolean: "off" (radio disabled — the user
 * can fix it), "unsupported" (no hardware — they cannot) and "unknown" (the probe failed) are three
 * different instructions, and collapsing them to `nfcReady: boolean` throws away the only
 * information that makes the message actionable.
 */
export function NfcStatusRow({nfcStatus, testID}: {nfcStatus: NfcStatus; testID: string}) {
  const [infoOpen, setInfoOpen] = useState(false);
  useEscapeToClose(() => setInfoOpen(false));
  const web = Platform.OS === 'web';
  const ready = nfcStatus === 'ready';
  // 'ready' can never reach the popup (it only opens from the not-ready branch); narrowing here
  // keeps `M.nfc.reason` total over the states it actually renders. On web the probe never runs
  // and the browser has no radio, so an 'unknown' there IS the hardware fact: it renders as
  // `unsupported` ("this device doesn't have NFC hardware"), never as a failed check.
  const reason: Exclude<NfcStatus, 'ready'> = ready
    ? 'unknown'
    : web && nfcStatus === 'unknown' ? 'unsupported' : nfcStatus;

  return (
    <>
      {ready ? (
        <View style={S.nfcStatusRow} testID={testID}>
          <NfcIcon color={C.brandText} size={34} />
          <Text style={S.nfcStatusLabel}>{M.pay.tapOrScanToPay}</Text>
        </View>
      ) : (
        <View style={S.nfcStatusRow} testID={testID}>
          <NfcIcon color={C.bad} size={34} off />
          <Pressable style={S.nfcInfoLink} onPress={() => setInfoOpen(true)} accessibilityRole="button" accessibilityLabel={M.pay.whyNfcUnavailable} accessibilityState={{disabled: false}}>
            <Text style={S.nfcInfoLinkText}>{M.pay.nfcNotAvailable}</Text>
            <IconInfo size={15} color={C.sub2}/>
          </Pressable>
        </View>
      )}

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
