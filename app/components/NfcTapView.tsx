import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {NfcIcon} from './NfcIcon';
import {IconCheck, IconClose} from './icons';
import type {NfcTapPhase} from '../hooks/useNfcTapState';

// Phase → status-view presentation (mirrors ui/src/NfcSession.jsx). `spin` renders a spinner; `icon`
// renders the NFC contactless mark (the listening/"armed" state) or the P3 SVG outcome marks
// (check = success, close = declined) in place of a text glyph; `glyph` remains for the textual
// '?' (pending) and '!' (error) marks.
const TAP_PHASES: Record<string, {tone: string; glyph?: string; spin?: boolean; icon?: 'nfc' | 'check' | 'close'; title: string; sub: string}> = {
  listening: {tone: C.brand, icon: 'nfc', title: 'Hold near the other phone', sub: 'dpay is listening for a tap'},
  linking: {tone: C.brand, spin: true, title: 'Connecting…', sub: 'Linking the two phones'},
  exchanging: {tone: C.brand, spin: true, title: 'Communicating…', sub: 'Keep the phones together'},
  awaitingApproval: {tone: C.brand, spin: true, title: 'Authorizing…', sub: 'Signing on the payer’s phone'},
  settling: {tone: C.brand, spin: true, title: 'Confirming…', sub: 'Keep the phones together while the merchant settles'},
  success: {tone: C.ok, icon: 'check', title: 'Done ✓', sub: ''},
  declined: {tone: C.sub, icon: 'close', title: 'Declined', sub: 'The payment was declined'},
  pending: {tone: C.warn, glyph: '?', title: 'Not confirmed', sub: 'Couldn’t reach the ledger'},
  error: {tone: C.bad, glyph: '!', title: 'Tap failed', sub: 'Move the phones together and try again'},
};

/** Pure title/sub computation for the NFC tap status view (extracted for unit testing). */
export function computeTapStatus(
  phase: NfcTapPhase,
  reason: string | null,
  role: 'card' | 'reader',
  formattedAmt: string | null,
  networkLabel?: string | null,
): {title: string; sub: string; terminal: boolean} {
  const m = TAP_PHASES[phase] ?? TAP_PHASES.listening;
  const terminal = phase === 'success' || phase === 'declined' || phase === 'error' || phase === 'pending';
  const active = phase === 'exchanging' || phase === 'settling' || phase === 'awaitingApproval';
  const title = phase === 'success'
    ? `${role === 'card' ? 'Paid' : 'Received'} ✓ ${formattedAmt ?? ''}`.trim()
    : m.title;
  const sub = (phase === 'error' || phase === 'declined' || phase === 'pending') && reason ? reason
    : phase === 'success' ? 'The payment settled'
    : active && formattedAmt != null
      // Card side shows the honest asset + network ("Paying 0.00050000 BTC on Bitcoin"); the network
      // is null only for DEMO (internal) / SOL → no "on …" suffix. Reader side mirrors without it.
      ? `${role === 'card' ? 'Paying' : 'Collecting'} ${formattedAmt}${networkLabel ? ` on ${networkLabel}` : ''}`
    : m.sub;
  return {title, sub, terminal};
}

/**
 * The terminal NFC tap status view shared by the IC (`NfcTap`) and SOL (`SolNfcTap`) adapters.
 * Renders the badge (NFC mark / spinner / glyph), the live title + sub line, and the Cancel/Done
 * button. `testID` is the ONLY per-rail difference (`nfc-status` vs `sol-nfc-status`) — the e2e
 * flows match it, so each adapter passes its own.
 */
export function NfcTapView({phase, reason, role, testID, formattedAmt, networkLabel, onClose}: {
  phase: NfcTapPhase;
  reason: string | null;
  role: 'card' | 'reader';
  testID: string;
  formattedAmt: string | null;
  networkLabel?: string | null;
  onClose: () => void;
}) {
  const m = TAP_PHASES[phase] ?? TAP_PHASES.listening;
  const {title, sub, terminal} = computeTapStatus(phase, reason, role, formattedAmt, networkLabel);
  return (
    <View style={S.center} testID={testID}>
      <View style={[S.nfcBadge, {borderColor: m.tone}]}>
        {m.icon === 'nfc' ? <NfcIcon color={m.tone} size={64} />
          : m.icon === 'check' ? <IconCheck size={48} color={m.tone} />
          : m.icon === 'close' ? <IconClose size={48} color={m.tone} />
          : m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
      </View>
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      <Pressable style={S.ghostBtn} accessibilityRole="button" accessibilityLabel={terminal ? 'Done' : 'Cancel'} accessibilityState={{disabled: false}} onPress={onClose}>{terminal ? <IconCheck size={16} color={C.sub}/> : <IconClose size={16} color={C.sub}/>}<Text style={S.ghostBtnText}>{terminal ? 'Done' : 'Cancel'}</Text></Pressable>
    </View>
  );
}
