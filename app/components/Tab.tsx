import {Text, Pressable} from 'react-native';
import type {ReactNode} from 'react';
import {C} from '../config/palette';
import {S} from '../styles';
import {HotkeyHint} from './HotkeyHint';

// `testId` is an explicit ASCII selector, NEVER derived from `label`: the label is translated copy
// and a derived testID would silently rename every e2e selector the moment a locale lands.
export function Tab({testId, label, active, onPress, hotkey, icon}: {testId: string; label: string; active: boolean; onPress: () => void; hotkey?: string; icon?: (color: string) => ReactNode}) {
  return (
    <Pressable
      onPress={onPress}
      style={[S.tab, active && S.tabActive]}
      testID={testId}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: false}}>
      {icon ? icon(active ? C.brandInk : C.sub) : null}
      <Text style={[S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}
