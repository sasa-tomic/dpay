import {Text, Pressable} from 'react-native';
import type {ReactNode} from 'react';
import {C} from '../config/palette';
import {S} from '../styles';
import {HotkeyHint} from './HotkeyHint';

export function Tab({label, active, onPress, hotkey, icon}: {label: string; active: boolean; onPress: () => void; hotkey?: string; icon?: (color: string) => ReactNode}) {
  return (
    <Pressable
      onPress={onPress}
      style={[S.tab, active && S.tabActive]}
      testID={`tab-${label.toLowerCase()}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled: false}}>
      {icon ? icon(active ? C.brandInk : C.sub) : null}
      <Text style={[S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}
