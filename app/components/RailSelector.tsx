import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';

/**
 * RailSelector — a segmented `[ IC | SOL ]` pill toggle at the top of the Pay/Receive tab bodies.
 *
 * SOL is a first-class asset: the user pre-selects the rail (IC vs SOL) BEFORE a tap or scan. This
 * is NOT auto-detection — IC and SOL use SEPARATE NFC HCE services (DpayNfc AID `…01` vs DpaySolNfc
 * AID `…02`) that must be armed BEFORE a tap, because the card protocol (AID selection) is committed
 * before the reader sends its first APDU. So the user MUST choose the rail up front; auto-detect is
 * impossible. This is the one place in the app where the user picks the settlement rail explicitly.
 *
 * When SOL is unavailable (no device-derived Solana address — e.g. a key-derivation failure), this
 * renders `null` so the IC-only path stays uncluttered (no empty selector on a wallet that can't do
 * SOL). Reuses the `tab`/`tabActive` visual language (rounded pills, brand fill on the active side).
 */
export function RailSelector({current, onSelect, solAvailable}: {current: 'ic' | 'sol'; onSelect: (r: 'ic' | 'sol') => void; solAvailable: boolean}) {
  if (!solAvailable) return null;
  return (
    <View style={S.railRow}>
      <Pressable
        testID="rail-ic"
        style={[S.railPill, current === 'ic' && S.railPillActive]}
        onPress={() => onSelect('ic')}
        accessibilityRole="button"
        accessibilityLabel="Internet Computer rail"
        accessibilityHint="Switch to the IC settlement rail for this tab"
        accessibilityState={{selected: current === 'ic', disabled: false}}>
        <Text style={[S.railPillText, current === 'ic' && S.railPillTextActive]}>IC</Text>
      </Pressable>
      <Pressable
        testID="rail-sol"
        style={[S.railPill, current === 'sol' && S.railPillActive]}
        onPress={() => onSelect('sol')}
        accessibilityRole="button"
        accessibilityLabel="Solana rail"
        accessibilityHint="Switch to the Solana settlement rail for this tab"
        accessibilityState={{selected: current === 'sol', disabled: false}}>
        <Text style={[S.railPillText, current === 'sol' && S.railPillTextActive]}>SOL</Text>
      </Pressable>
    </View>
  );
}
