import {Text, View, Platform, useWindowDimensions} from 'react-native';
import {S} from '../styles';

/**
 * Tiny keyboard-key badge shown next to a shortcut target (web only — native has no keyboard, so the
 * hints would be noise there). Always-visible-but-subtle: a small rounded square with the key's
 * letter in a muted tone (`C.sub` via `S.kbdHintText`) so it reads as a hint, not chrome.
 * `tone='onBrand'` flips to a white-on-tangerine variant for badges that sit on the filled brand
 * surface (active tab). The pattern (a letter in a box) stays recognisable across targets, so a
 * user who learns one shortcut infers the rest.
 *
 * Also hidden on NARROW web viewports (<700px): keyboard hints are meaningless on touch (mobile
 * browsers / narrow desktop windows), and each badge's 24px footprint is what made the tab row
 * overflow a 390px phone screen. `useWindowDimensions` is an RN core hook — no new dependency.
 */
export function HotkeyHint({k, tone = 'muted'}: {k: string; tone?: 'muted' | 'onBrand'}) {
  const {width} = useWindowDimensions();
  if (Platform.OS !== 'web' || width < 700) {
    return null;
  }
  const onBrand = tone === 'onBrand';
  return (
    <View style={[S.kbdHint, onBrand && S.kbdHintOnBrand]}>
      <Text style={[S.kbdHintText, onBrand && S.kbdHintTextOnBrand]}>{k}</Text>
    </View>
  );
}
