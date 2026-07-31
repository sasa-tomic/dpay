import {Text} from 'react-native';
import Svg, {Defs, RadialGradient, Stop, Rect, Path} from 'react-native-svg';
import {S} from '../styles';

// The mint-green geometric "d" used by both the app icon and the in-app emblem. Bowl LEFT, ascender
// stem RIGHT (1024 viewBox, matches the adaptive-icon foreground).
const D_PATH = 'M622 276a52 52 0 0 1 52 52v348a52 52 0 0 1-52 52 52 52 0 0 1-52-52V328a52 52 0 0 1 52-52zM508 396a176 176 0 1 0 .1 0zM508 498a74 74 0 1 1-.1 0z';

export function Logo({size = 96}: {size?: number}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <RadialGradient id="dpbg" cx="0.5" cy="0.34" r="0.82">
          <Stop offset="0" stopColor="#15191f" />
          <Stop offset="1" stopColor="#0a0c11" />
        </RadialGradient>
        <RadialGradient id="dphalo" cx="0.5" cy="0.4" r="0.5">
          <Stop offset="0" stopColor="#3ee0ac" stopOpacity="0.32" />
          <Stop offset="1" stopColor="#3ee0ac" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#dpbg)" />
      <Rect x="0" y="0" width="1024" height="1024" rx="228" fill="url(#dphalo)" />
      <Path d={D_PATH} fill="#3ee0ac" />
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
