import Svg, {Path} from 'react-native-svg';

// A compact contactless mark: three concentric arcs opening to the upper-right — the universal
// "tap" waves — drawn as a single-color stroke so the caller tints it green (ready) or red
// (unavailable). Pure SVG paths — no font/emoji dependence — so it renders identically on device
// and in the react-native-web gate.
export function NfcIcon({color, size = 28}: {color: string; size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28" fill="none">
      {/* contactless waves — three nested arcs (inner → outer) bulging upper-right, sharing the
          lower-left focal point. */}
      <Path d="M5 16 A7 7 0 0 1 12 23" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      <Path d="M5 10 A13 13 0 0 1 18 23" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      <Path d="M5 4 A19 19 0 0 1 24 23" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}
