import {Text} from 'react-native';
import Svg, {Defs, LinearGradient, Stop, Rect, Path} from 'react-native-svg';
import {C} from '../config/palette';
import {S} from '../styles';

// The 2026-08-17 "∂ifferent Pay" mark: the same tangerine tile as the Traveler Paper identity,
// now carrying the porcelain ∂ (U+2202) — the brand glyph AND the app's demo-dollar symbol
// (onboarding: "∂1 = $1"). Glyph outline extracted from DejaVu Sans Bold (public-domain shapes),
// re-fit to the tile (height 500/1024, optical center 526/1024) — the same slot the old "d" held,
// so the mark stays recognizably the same product, one glyph swapped. This one geometry drives
// the in-app emblem AND the Android adaptive launcher (res/drawable vectors mirror these paths
// + colors, scaled 1024→108).

// Porcelain ∂: outer contour + bowl counter (even-odd fill knocks the counter out).
const D_PATH = 'M422.46 366.78V288.77Q474.23 276 511.82 276Q619.27 276 667.14 368.55Q688.42 409.69 688.42 474.58Q688.42 514.65 678.49 561.11Q653.67 677.06 586.65 732.74Q534.52 776 476.72 776Q416.43 776 379.55 743.73Q335.58 704.72 335.58 639.48Q335.58 567.13 374.94 510.4Q413.24 454.72 488.42 454.72Q527.43 454.72 564.3 479.19Q578.13 488.41 597.99 517.49Q601.18 494.44 601.18 468.55Q601.18 429.19 589.84 408.62Q556.15 347.99 496.93 347.99Q467.5 347.99 422.46 366.78ZM423.17 648.34Q423.17 674.23 437.35 690.18Q451.89 706.5 477.07 706.5Q497.64 706.5 515.72 693.73Q538.06 678.13 555.44 649.4Q568.91 627.06 576.72 601.18Q547.99 539.83 499.06 539.83Q452.96 539.83 434.87 589.48Q423.17 621.04 423.17 648.34Z';

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
      <Path d={D_PATH} fill="#FDFCF9" fillRule="evenodd" />
    </Svg>
  );
}

// ∂pay — spoken "dee-pay". The ∂ is the brand glyph (Space Grotesk has no U+2202, so it renders
// from the system font — same as every other ∂ already in the app, e.g. the demo-dollar symbol).
export function Wordmark({style}: {style?: object}) {
  return (
    <Text style={[S.wordmark, style]}>
      ∂<Text style={S.wordmarkPay}>pay</Text>
    </Text>
  );
}
