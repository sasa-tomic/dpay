import {Text, Pressable} from 'react-native';
import type {ReactNode} from 'react';
import {C} from '../config/palette';
import {S} from '../styles';
import {HotkeyHint} from './HotkeyHint';

// `testId` is an explicit ASCII selector, NEVER derived from `label`: the label is translated copy
// and a derived testID would silently rename every e2e selector the moment a locale lands.
// `variant='bottom'` (O4 S1) is the persistent bottom-nav form: icon over label, flex:1 so the
// three tabs split the bar equally, ≥44pt target. The web-only keycap badge renders only on the
// top variant — a HotkeyHint does not fit the stacked bottom chrome (the shortcuts themselves stay
// live in useHotkeys), so bottom call sites pass no `hotkey`.
export function Tab({testId, label, active, onPress, hotkey, icon, variant = 'top'}: {testId: string; label: string; active: boolean; onPress: () => void; hotkey?: string; icon?: (color: string) => ReactNode; variant?: 'top' | 'bottom'}) {
  const bottom = variant === 'bottom';
  return (
    <Pressable
      onPress={onPress}
      style={bottom ? [S.bottomTab, active && S.bottomTabActive] : [S.tab, active && S.tabActive]}
      testID={testId}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: false}}>
      {icon ? icon(active ? C.brandInk : C.sub) : null}
      <Text style={bottom ? [S.bottomTabText, active && S.bottomTabTextActive] : [S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey && !bottom ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}
