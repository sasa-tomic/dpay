import {View, Text, Pressable, ActivityIndicator} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {NfcIcon} from './NfcIcon';
import {IconCheck, IconClose} from './icons';
import {TapBreathRing, TapProgressLine, TapKeyBeat, TapPendingStill, TapShakeSettle} from './tapMotion';
import {OfflinePeak} from './OfflinePeak';
import type {NfcTapPhase} from '../hooks/useNfcTapState';
import {M} from '../i18n';

// Phase → status-view PRESENTATION (mirrors ui/src/NfcSession.jsx). `spin` renders a spinner;
// `icon` renders the NFC contactless mark (the listening/"armed" state) or the P3 SVG outcome
// marks (check = success, close = declined, key = awaitingApproval — the quiet YOUR-key beat, J5:
// no spinny anxiety) in place of a text glyph; `glyph` remains for the textual '?' (pending) and
// '!' (error) marks.
//
// The matching TITLE + SUB live in the message catalog (`M.nfc.phase`) — presentation is
// locale-invariant, copy is not. Typing this as a total Record over NfcTapPhase (it was
// `Record<string, …>`) makes every phase provably present, so the old `?? TAP_PHASES.listening`
// fallback is gone: an unknown phase is now a compile error rather than a silent wrong badge.
const TAP_PHASES: Record<NfcTapPhase, {tone: string; glyph?: string; spin?: boolean; icon?: 'nfc' | 'check' | 'close' | 'key'}> = {
  listening: {tone: C.brand, icon: 'nfc'},
  linking: {tone: C.brand, spin: true},
  exchanging: {tone: C.brand, spin: true},
  // The one-press rule removed the card-side review park (auto-sign fires on request arrival), so
  // 'awaitingApproval' is READER-ONLY now — role-aware: the merchant waits on the payer's sign.
  awaitingApproval: {tone: C.brand, icon: 'key'},
  settling: {tone: C.brand, spin: true},
  success: {tone: C.ok, icon: 'check'},
  declined: {tone: C.sub, icon: 'close'},
  pending: {tone: C.warn, glyph: '?'},
  error: {tone: C.bad, glyph: '!'},
};

// Trip Ready J5 — the itinerary-line progression: which segment the active phase has reached
// (linking lights the link; exchanging promotes to 2 as the wire flows; settling lights the
// settlement hop). awaitingApproval (reader-only) holds at 2 while the key beat breathes.
const LINE_LIT: Partial<Record<NfcTapPhase, 1 | 2 | 3>> = {linking: 1, exchanging: 2, awaitingApproval: 2, settling: 3};

/** Pure title/sub computation for the NFC tap status view (extracted for unit testing). */
export function computeTapStatus(
  phase: NfcTapPhase,
  reason: string | null,
  role: 'card' | 'reader',
  formattedAmt: string | null,
  networkLabel?: string | null,
): {title: string; sub: string; terminal: boolean} {
  const c = M.nfc.phase[phase];
  const terminal = phase === 'success' || phase === 'declined' || phase === 'error' || phase === 'pending';
  // awaitingApproval (reader "waiting for the payer") shows its own copy even with an amount known.
  const active = phase === 'exchanging' || phase === 'settling';
  const title = phase === 'success'
    ? (role === 'card' ? M.nfc.paidAmount(formattedAmt ?? '') : M.nfc.receivedAmount(formattedAmt ?? ''))
    : c.title;
  const sub = (phase === 'error' || phase === 'declined' || phase === 'pending') && reason ? reason
    : phase === 'success' ? M.nfc.settled
    : active && formattedAmt != null
      // Card side shows the honest asset + network ("Paying 0.00050000 BTC on Bitcoin"); the network
      // is null only for DEMO (internal) / SOL → no "on …" suffix. Reader side mirrors without it.
      ? (role === 'card' ? M.nfc.paying(formattedAmt, networkLabel ?? null) : M.nfc.collecting(formattedAmt, networkLabel ?? null))
    : c.sub;
  return {title, sub, terminal};
}

/**
 * The terminal NFC tap status view shared by the IC (`NfcTap`) and SOL (`SolNfcTap`) adapters.
 * Renders the badge (NFC mark / spinner / key / glyph), the live title + sub line (the card's
 * exchanging/settling subs carry the read-only amount — "Paying 0.00050000 BTC on Bitcoin"), the
 * Cancel/Done button, and the J5 motion system (one honest beat per phase, in the
 * passport-stamp language — see tapMotion.tsx). `testID` is the ONLY per-rail difference
 * (`nfc-status` vs `sol-nfc-status`) — the e2e flows match it, so each adapter passes its own.
 *
 * One-press rule (founder directive 2026-08-24): there is no review card anymore — the "Pay Now"
 * gate armed the tap, the request auto-signs on arrival, and the money moves over the channel.
 *
 * Motion is keyed on PHASE TRANSITIONS (the beat elements carry `key={phase}` / conditional
 * mounts), never render count: Wallet's live balance polls re-render this view without
 * re-triggering anything. Titles/subs/testIDs below are e2e textContent contracts — byte-stable.
 */
export function NfcTapView({phase, reason, role, testID, formattedAmt, networkLabel, onClose, offlinePeak}: {
  phase: NfcTapPhase;
  reason: string | null;
  role: 'card' | 'reader';
  testID: string;
  formattedAmt: string | null;
  networkLabel?: string | null;
  onClose: () => void;
  /** Trip Ready J5 — mount the one-shot offline peak moment above the success phase (the caller
   *  gates this on the truthful merchant-settled-while-offline story + the journey one-shot). */
  offlinePeak?: boolean;
}) {
  const m = TAP_PHASES[phase];
  const {title, sub, terminal} = computeTapStatus(phase, reason, role, formattedAmt, networkLabel);
  const lit = LINE_LIT[phase];

  const badge = (
    <View style={[S.nfcBadge, {borderColor: m.tone}]}>
      {m.icon === 'nfc' ? <NfcIcon color={m.tone} size={64} />
        : m.icon === 'check' ? <IconCheck size={48} color={m.tone} />
        : m.icon === 'close' ? <IconClose size={48} color={m.tone} />
        : m.icon === 'key' ? <TapKeyBeat size={44} tone={m.tone} />
        : m.spin ? <ActivityIndicator size="large" color={m.tone} /> : <Text style={[S.nfcGlyph, {color: m.tone}]}>{m.glyph}</Text>}
    </View>
  );
  return (
    <View style={S.center} testID={testID}>
      {phase === 'success' && offlinePeak ? <OfflinePeak /> : null}
      {phase === 'listening' ? <TapBreathRing tone={m.tone} /> : null}
      {phase === 'declined' || phase === 'error' ? <TapShakeSettle testID="tap-shake">{badge}</TapShakeSettle> : badge}
      {lit ? <TapProgressLine key={phase} litSegments={lit} /> : null}
      <Text style={S.nfcTitle}>{title}</Text>
      {sub ? <Text style={S.nfcSub}>{sub}</Text> : null}
      {phase === 'pending' ? <TapPendingStill /> : null}
      {phase === 'exchanging' && role === 'card' ? <Text style={S.dim2}>{M.nfc.holdToSend}</Text> : null}
      <Pressable style={S.ghostBtn} accessibilityRole="button" accessibilityLabel={terminal ? M.common.done : M.common.cancel} accessibilityState={{disabled: false}} onPress={onClose}>{terminal ? <IconCheck size={16} color={C.sub}/> : <IconClose size={16} color={C.sub}/>}<Text style={S.ghostBtnText}>{terminal ? M.common.done : M.common.cancel}</Text></Pressable>
    </View>
  );
}
