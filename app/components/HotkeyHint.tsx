import {Text, View, Platform} from 'react-native';
import {S} from '../styles';

/**
 * Tiny keyboard-key badge shown next to a shortcut target (web only — native has no keyboard, so the
 * hints would be noise there). Always-visible-but-subtle: a small rounded square with the key's
 * letter in the palette's muted tone (`C.sub2`) so it reads as a hint, not chrome. `tone='onBrand'`
 * flips to a dark-on-brand variant for badges that sit on the green brand background (active tab,
 * the Add-money button). The pattern (a letter in a box) stays recognisable across targets, so a
 * user who learns one shortcut infers the rest.
 */
export function HotkeyHint({k, tone = 'muted'}: {k: string; tone?: 'muted' | 'onBrand'}) {
  if (Platform.OS !== 'web') {
    return null;
  }
  const onBrand = tone === 'onBrand';
  return (
    <View style={[S.kbdHint, onBrand && S.kbdHintOnBrand]}>
      <Text style={[S.kbdHintText, onBrand && S.kbdHintTextOnBrand]}>{k}</Text>
    </View>
  );
}
