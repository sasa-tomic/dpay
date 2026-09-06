/**
 * dpay icon system — lucide-style stroke icons on a 24×24 grid.
 * Design rules (2026-08-16 visual overhaul):
 *   - stroke-based, strokeWidth 2, round caps + joins — matches the landing's inline SVG language.
 *   - `fill="none"` everywhere except explicit filled shapes (none today).
 *   - one factory (`make`), every icon is (paths, circles, lines, rects) nodes only — no per-icon
 *     wrapper noise, no inline literal duplication.
 *   - props: {size = 24, color} — size drives BOTH width/height and stays a pure layout prop so
 *     jest/react-test-renderer never needs real rasterization.
 *   - Renders identically under react-native-web (e2e) and on device (react-native-svg is already
 *     a dependency via react-native-qrcode-svg — no new native deps).
 *
 * This file REPLACES the text-glyph icons ('⚙' '✕' '✓' '+' 'ⓘ' '▾' as iconography). Currency
 * SYMBOLS ($, ₿, Ξ, ◎, ∂) are NOT icons — they stay Text (see AssetGlyph for the monogram chips).
 */
import React from 'react';
import Svg, {Circle, Line, Path, Polyline, Rect} from 'react-native-svg';
import {C} from '../config/palette';

export type IconProps = {
  /** Rendered width/height in dp (default 24 = the design grid). */
  size?: number;
  /** Stroke color (default inherits — pass C.* palette tokens from callers). */
  color?: string;
};

type Node = React.ReactElement | null;

function make(
  nodes: (props: {size: number; color: string}) => Node[],
): React.FC<IconProps & {testID?: string}> {
  const Icon: React.FC<IconProps & {testID?: string}> = ({size = 24, color, testID}) => {
    const stroke = color ?? C.sub; // themed default (sub) — every current call site passes color explicitly
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" testID={testID}>
        {nodes({size, color: stroke}).map((n, i) =>
          n ? React.cloneElement(n as React.ReactElement<Record<string, unknown>>, {key: i}) : null,
        )}
      </Svg>
    );
  };
  return Icon;
}

// Primitives pre-bound to the icon stroke style. Each returns a closed element; the factory
// clones with a key. `stroke` is bound per-node because react-native-svg does not inherit
// `stroke` from <Svg> automatically.
function withStroke(color: string) {
  const p = (d: string) => <Path d={d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />;
  const c = (cx: number, cy: number, r: number) => <Circle cx={cx} cy={cy} r={r} stroke={color} strokeWidth={2} />;
  const l = (x1: number, y1: number, x2: number, y2: number) => <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} strokeLinecap="round" />;
  const r_ = (x: number, y: number, w: number, h: number, rx = 0) => <Rect x={x} y={y} width={w} height={h} rx={rx} stroke={color} strokeWidth={2} />;
  const pl = (points: string) => <Polyline points={points} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />;
  return {p, c, l, r: r_, pl};
}

export const IconSettings = make(({color}) => {
  const {p, c} = withStroke(color);
  return [
    p('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'),
    c(12, 12, 3),
  ];
});

export const IconClose = make(({color}) => {
  const {l} = withStroke(color);
  return [l(18, 6, 6, 18), l(6, 6, 18, 18)];
});

export const IconCheck = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M20 6 9 17l-5-5')];
});

export const IconChevronDown = make(({color}) => {
  const {p} = withStroke(color);
  return [p('m6 9 6 6 6-6')];
});

export const IconPlus = make(({color}) => {
  const {l} = withStroke(color);
  return [l(5, 12, 19, 12), l(12, 5, 12, 19)];
});

export const IconArrowUpRight = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M7 7h10v10'), p('M7 17 17 7')];
});

export const IconArrowDownLeft = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M17 7 7 17'), p('M17 17H7V7')];
});

export const IconQr = make(({color}) => {
  const {p, r} = withStroke(color);
  return [
    r(3, 3, 5, 5, 1),
    r(16, 3, 5, 5, 1),
    r(3, 16, 5, 5, 1),
    p('M21 16h-3a2 2 0 0 0-2 2v3'),
    p('M21 21v.01'),
    p('M12 7v3a2 2 0 0 1-2 2H7'),
    p('M3 12h.01'),
    p('M12 3h.01'),
    p('M12 16v.01'),
    p('M16 12h1'),
    p('M21 12v.01'),
    p('M12 21v-1'),
  ];
});

export const IconScan = make(({color}) => {
  const {p, l} = withStroke(color);
  return [
    p('M3 7V5a2 2 0 0 1 2-2h2'),
    p('M17 3h2a2 2 0 0 1 2 2v2'),
    p('M21 17v2a2 2 0 0 1-2 2h-2'),
    p('M7 21H5a2 2 0 0 1-2-2v-2'),
    l(7, 12, 17, 12),
  ];
});

export const IconShare = make(({color}) => {
  const {c, p} = withStroke(color);
  return [
    c(18, 5, 3),
    c(6, 12, 3),
    c(18, 19, 3),
    p('M8.59 13.51l6.83 3.98'),
    p('M15.41 6.51l-6.82 3.98'),
  ];
});

export const IconCopy = make(({color}) => {
  const {p, r} = withStroke(color);
  return [
    r(8, 8, 14, 14, 2),
    p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'),
  ];
});

export const IconRefresh = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
    p('M21 3v5h-5'),
    p('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
    p('M8 16H3v5'),
  ];
});

export const IconInfo = make(({color}) => {
  const {c, p} = withStroke(color);
  return [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')];
});

export const IconClock = make(({color}) => {
  const {c, pl} = withStroke(color);
  return [c(12, 12, 10), pl('12 6 12 12 16 14')];
});

export const IconWifiOff = make(({color}) => {
  const {p, l} = withStroke(color);
  return [
    p('M12 20h.01'),
    p('M5 12.859a10 10 0 0 1 5.17-2.69'),
    p('M19 12.859a10 10 0 0 1 2.35-1.76'),
    p('M2 8.82a15 15 0 0 1 4.17-2.65'),
    p('M14.98 8.77a15 15 0 0 1 5.02 2.71'), // approximate lucide arc
    p('M8.53 16.11a6 6 0 0 1 3.47-1.65'),
    p('M15.36 16.43a6 6 0 0 1-1.14.87'), // near arc
    l(2, 2, 22, 22),
  ];
});

export const IconAlert = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z'),
    p('M12 9v4'),
    p('M12 17h.01'),
  ];
});

export const IconExternalLink = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')];
});

// Wave 7 theme toggle (Light / Dark flip) — lucide `sun` and `moon`.
export const IconSun = make(({color}) => {
  const {c, l} = withStroke(color);
  return [
    c(12, 12, 4),
    l(12, 2, 12, 4),
    l(12, 20, 12, 22),
    l(4.93, 4.93, 6.34, 6.34),
    l(17.66, 17.66, 19.07, 19.07),
    l(2, 12, 4, 12),
    l(20, 12, 22, 12),
    l(4.93, 19.07, 6.34, 17.66),
    l(17.66, 6.34, 19.07, 4.93),
  ];
});

export const IconMoon = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')];
});

// Wave 8 theme "Auto" (follow system) — lucide `monitor`.
export const IconAuto = make(({color}) => {
  const {l, p} = withStroke(color);
  return [p('M4 5h16v11H4z'), l(8, 20, 16, 20), l(12, 16, 12, 20)];
});

// Trip Ready J5 — the quiet approval beat (awaitingApproval): a key, because the sign is YOURS
// (lucide `key-round`). No spin — approval is a held breath, not a spinner.
export const IconKey = make(({color}) => {
  const {c, p, l} = withStroke(color);
  return [
    p('M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z'),
    c(16.5, 7.5, .5),
    l(16.08, 7.92, 16.08, 7.92),
  ];
});

// O4 home tab — the house (lucide `home`): the balance-first home surface, one tap left of Pay.
export const IconHome = make(({color}) => {
  const {p, pl} = withStroke(color);
  return [
    p('m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
    pl('9 22 9 12 15 12 15 22'),
  ];
});

export const ICONS = {
  settings: IconSettings,
  close: IconClose,
  check: IconCheck,
  chevronDown: IconChevronDown,
  plus: IconPlus,
  arrowUpRight: IconArrowUpRight,
  arrowDownLeft: IconArrowDownLeft,
  qr: IconQr,
  scan: IconScan,
  share: IconShare,
  copy: IconCopy,
  refresh: IconRefresh,
  info: IconInfo,
  clock: IconClock,
  wifiOff: IconWifiOff,
  alert: IconAlert,
  externalLink: IconExternalLink,
  sun: IconSun,
  moon: IconMoon,
  auto: IconAuto,
  key: IconKey,
  home: IconHome,
} as const;

export type IconName = keyof typeof ICONS;
