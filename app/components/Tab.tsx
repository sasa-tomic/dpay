import {Text, Pressable, View} from 'react-native';
import type {ReactNode} from 'react';
import {C} from '../config/palette';
import {S} from '../styles';
import {HotkeyHint} from './HotkeyHint';

// `testId` is an explicit ASCII selector, NEVER derived from `label`: the label is translated copy
// and a derived testID would silently rename every e2e selector the moment a locale lands.
// `variant='bottom'` (O4 S1) is the persistent bottom-nav form: icon over label, flex:1 so the
// tabs split the bar equally, ≥44pt target. CALIBER: the active state is a 16×2 brand indicator
// bar over the icon (S.bottomTabIndicator) + ink label - no filled pill. The 2px off-spacer keeps
// both states the same height, so toggling shifts nothing. The bar is decorative geometry; the
// Pressable carries the accessibility state, so the View needs no a11y props. The web-only keycap
// badge renders only on the top variant (a HotkeyHint does not fit the stacked bottom chrome; the
// shortcuts themselves stay live in useHotkeys), so bottom call sites pass no `hotkey`.
export function Tab({testId, label, active, onPress, hotkey, icon, variant = 'top'}: {testId: string; label: string; active: boolean; onPress: () => void; hotkey?: string; icon?: (color: string) => ReactNode; variant?: 'top' | 'bottom'}) {
  const bottom = variant === 'bottom';
  return (
    <Pressable
      onPress={onPress}
      style={bottom ? S.bottomTab : [S.tab, active && S.tabActive]}
      testID={testId}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: false}}>
      {bottom ? <View style={active ? S.bottomTabIndicator : S.bottomTabIndicatorOff} /> : null}
      {icon ? icon(bottom ? (active ? C.brandText : C.sub) : active ? C.brandInk : C.sub) : null}
      <Text style={bottom ? [S.bottomTabText, active && S.bottomTabTextActive] : [S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey && !bottom ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}
