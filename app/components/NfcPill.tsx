import {Text, View} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import type {NfcStatus} from '../lib/types';

// Truthful NFC radio-status chip. Reports the device adapter state only (on / off / absent) — the
// tap-to-pay HCE transport is a separate, device-gated feature and QR always works. 'unknown'
// (probe failed or the native method is absent) renders nothing rather than a misleading claim.
const NFC_PILL: Record<NfcStatus, {dot: string; label: string} | null> = {
  ready: {dot: C.ok, label: 'NFC on'},
  off: {dot: C.warn, label: 'NFC off'},
  unsupported: {dot: C.sub2, label: 'No NFC'},
  unknown: null,
};

export function NfcPill({status}: {status: NfcStatus}) {
  const s = NFC_PILL[status];
  if (!s) return null;
  return (
    <View style={S.nfcPill} testID={`nfc-${status}`}>
      <View style={[S.dot, {backgroundColor: s.dot}]} />
      <Text style={S.nfcLabel}>{s.label}</Text>
    </View>
  );
}
