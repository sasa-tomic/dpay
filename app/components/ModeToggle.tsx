import {View, Text, Pressable} from 'react-native';
import {S} from '../styles';

// A joined two-segment pill toggle rendered at the top of the Pay/Receive tab bodies. Selecting an
// on-chain Send/Receive surface (Send to address / My address) lives behind the second segment so the
// scan/request flows stay the default. Purely presentational; the owner owns the `value` + `onChange`.
export function ModeToggle({testID, left, right, value, onChange}: {
  testID: string;
  left: {label: string; value: string; testID: string};
  right: {label: string; value: string; testID: string};
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View testID={testID} style={S.railRow}>
      <Pressable
        testID={left.testID}
        style={[S.railPill, value === left.value && S.railPillActive]}
        onPress={() => onChange(left.value)}
        accessibilityRole="button"
        accessibilityLabel={left.label}
        accessibilityState={{disabled: false}}>
        <Text style={[S.railPillText, value === left.value && S.railPillTextActive]}>{left.label}</Text>
      </Pressable>
      <Pressable
        testID={right.testID}
        style={[S.railPill, value === right.value && S.railPillActive]}
        onPress={() => onChange(right.value)}
        accessibilityRole="button"
        accessibilityLabel={right.label}
        accessibilityState={{disabled: false}}>
        <Text style={[S.railPillText, value === right.value && S.railPillTextActive]}>{right.label}</Text>
      </Pressable>
    </View>
  );
}
