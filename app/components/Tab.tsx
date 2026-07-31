import {Text, Pressable} from 'react-native';
import {S} from '../styles';
import {HotkeyHint} from './HotkeyHint';

export function Tab({label, active, onPress, hotkey}: {label: string; active: boolean; onPress: () => void; hotkey?: string}) {
  return (
    <Pressable onPress={onPress} style={[S.tab, active && S.tabActive]} testID={`tab-${label.toLowerCase()}`}>
      <Text style={[S.tabText, active && S.tabTextActive]}>{label}</Text>
      {hotkey ? <HotkeyHint k={hotkey} tone={active ? 'onBrand' : 'muted'} /> : null}
    </Pressable>
  );
}
