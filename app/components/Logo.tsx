import {Text} from 'react-native';
import Svg, {Defs, LinearGradient, Stop, Rect, Path} from 'react-native-svg';
import {C} from '../config/palette';
import {S} from '../styles';

// The 2026-08-17 "Traveler Paper" mark: a vivid tangerine rounded tile (top-light gradient —
// sun-lit, matching the light theme) carrying a porcelain "d". Same d geometry family as before
// (bowl LEFT, ascender stem RIGHT, 1024 viewBox) so it stays recognizably dpay, recolored +
// re-lit for the new identity. This one geometry drives the in-app emblem AND the Android
// adaptive launcher (res/drawable vectors mirror these paths + colors).

// Porcelain "d": stem + bowl, filled with the page color so it knocks out of the tangerine tile.
const D_PATH = 'M622 276a52 52 0 0 1 52 52v348a52 52 0 0 1-52 52 52 52 0 0 1-52-52V328a52 52 0 0 1 52-52zM508 396a176 176 0 1 0 .1 0zM508 498a74 74 0 1 1-.1 0z';

export function Logo({size = 96}: {size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id="dptile" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FF6A2B" />
          <Stop offset="1" stopColor={C.brand} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#dptile)" />
      <Path d={D_PATH} fill="#FDFCF9" />
    </Svg>
  );
}

export function Wordmark({style}: {style?: object}) {
  return (
    <Text style={[S.wordmark, style]}>
      d<Text style={S.wordmarkPay}>pay</Text>
    </Text>
  );
}
