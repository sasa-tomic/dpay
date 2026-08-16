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

export type IconProps = {
  /** Rendered width/height in dp (default 24 = the design grid). */
  size?: number;
  /** Stroke color (default inherits — pass C.* palette tokens from callers). */
  color?: string;
};

type Node = React.ReactElement | null;

/** Shared chrome: 24×24 viewBox, stroke 2, round caps/joins, no fill. */
function make(
  nodes: (props: {size: number; color: string}) => Node[],
): React.FC<IconProps & {testID?: string}> {
  const Icon: React.FC<IconProps & {testID?: string}> = ({size = 24, color, testID}) => {
    const stroke = color ?? '#9aa4b0';
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

/** Gear (settings). */
export const IconSettings = make(({color}) => {
  const {p, c} = withStroke(color);
  return [
    p('M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'),
    c(12, 12, 3),
  ];
});

/** Close / dismiss (✕ replacement). */
export const IconClose = make(({color}) => {
  const {l} = withStroke(color);
  return [l(18, 6, 6, 18), l(6, 6, 18, 18)];
});

/** Checkmark (✓ replacement). */
export const IconCheck = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M20 6 9 17l-5-5')];
});

/** Caret down (▾ replacement — pickers, expandable rows). */
export const IconChevronDown = make(({color}) => {
  const {p} = withStroke(color);
  return [p('m6 9 6 6 6-6')];
});

/** Caret right — forward affordance (balance card → Balances). */
export const IconChevronRight = make(({color}) => {
  const {p} = withStroke(color);
  return [p('m9 18 6-6-6-6')];
});

/** Caret left — back affordance. */
export const IconChevronLeft = make(({color}) => {
  const {p} = withStroke(color);
  return [p('m15 18-6-6 6-6')];
});

/** Plus — add/deposit actions ('+' glyph replacement). */
export const IconPlus = make(({color}) => {
  const {l} = withStroke(color);
  return [l(5, 12, 19, 12), l(12, 5, 12, 19)];
});

/** Send (paper plane) — Send-to-address mode + share/request-link semantics. */
export const IconSend = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z'),
    p('m21.854 2.147-10.94 10.939'),
  ];
});

/** Arrow up-right — send/pay direction. */
export const IconArrowUpRight = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M7 7h10v10'), p('M7 17 17 7')];
});

/** Arrow down-left — receive direction. */
export const IconArrowDownLeft = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M17 7 7 17'), p('M17 17H7V7')];
});

/** QR code — scan-to-pay affordance. */
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

/** Scan corners — the camera/scanner frame. */
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

/** Camera — camera permission / enable affordance. */
export const IconCamera = make(({color}) => {
  const {p, c} = withStroke(color);
  return [
    p('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z'),
    c(12, 13, 3),
  ];
});

/** Share — OS share sheet. */
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

/** Copy — copy-to-clipboard. */
export const IconCopy = make(({color}) => {
  const {p, r} = withStroke(color);
  return [
    r(8, 8, 14, 14, 2),
    p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'),
  ];
});

/** Refresh — re-check / retry / re-poll. */
export const IconRefresh = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
    p('M21 3v5h-5'),
    p('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
    p('M8 16H3v5'),
  ];
});

/** Info ('ⓘ' replacement). */
export const IconInfo = make(({color}) => {
  const {c, p} = withStroke(color);
  return [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')];
});

/** Clock — expiry / validity windows. */
export const IconClock = make(({color}) => {
  const {c, pl} = withStroke(color);
  return [c(12, 12, 10), pl('12 6 12 12 16 14')];
});

/** Wifi off — offline status (matches landing's offline badge language). */
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

/** Warning triangle. */
export const IconAlert = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z'),
    p('M12 9v4'),
    p('M12 17h.01'),
  ];
});

/** Success circle. */
export const IconCheckCircle = make(({color}) => {
  const {c, p} = withStroke(color);
  return [c(12, 12, 10), p('m9 12 2 2 4-4')];
});

/** Failure circle. */
export const IconXCircle = make(({color}) => {
  const {c, p} = withStroke(color);
  return [c(12, 12, 10), p('m15 9-6 6'), p('m9 9 6 6')];
});

/** Eye — reveal (seed phrase). */
export const IconEye = make(({color}) => {
  const {c, p} = withStroke(color);
  return [
    p('M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'),
    c(12, 12, 3),
  ];
});

/** Eye off — conceal (seed phrase). */
export const IconEyeOff = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'),
    p('M14.084 14.158a3 3 0 0 1-4.242-4.242'),
    p('M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'),
    p('m2 2 20 20'),
  ];
});

/** Shield — non-custodial / security messaging. */
export const IconShield = make(({color}) => {
  const {p} = withStroke(color);
  return [
    p('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z'),
  ];
});

/** Lock — keyholder / custody language. */
export const IconLock = make(({color}) => {
  const {r, p} = withStroke(color);
  return [r(3, 11, 18, 11, 2), p('M7 11V7a5 5 0 0 1 10 0v4')];
});

/** External link — opens outside the app. */
export const IconExternalLink = make(({color}) => {
  const {p} = withStroke(color);
  return [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')];
});

/** Wallet — balance surfaces. */
export const IconWallet = make(({color}) => {
  const {p, r} = withStroke(color);
  return [
    p('M21 12V7H5a2 2 0 0 1 0-4h14v4'),
    p('M3 5v14a2 2 0 0 0 2 2h16v-5'),
    r(15, 12, 6, 4, 0.5),
    p('M18 14h.01'),
  ];
});

/** All icons in one registry — used by the jest smoke test to keep every icon render-covered. */
export const ICONS = {
  settings: IconSettings,
  close: IconClose,
  check: IconCheck,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  chevronLeft: IconChevronLeft,
  plus: IconPlus,
  send: IconSend,
  arrowUpRight: IconArrowUpRight,
  arrowDownLeft: IconArrowDownLeft,
  qr: IconQr,
  scan: IconScan,
  camera: IconCamera,
  share: IconShare,
  copy: IconCopy,
  refresh: IconRefresh,
  info: IconInfo,
  clock: IconClock,
  wifiOff: IconWifiOff,
  alert: IconAlert,
  checkCircle: IconCheckCircle,
  xCircle: IconXCircle,
  eye: IconEye,
  eyeOff: IconEyeOff,
  shield: IconShield,
  lock: IconLock,
  externalLink: IconExternalLink,
  wallet: IconWallet,
} as const;

export type IconName = keyof typeof ICONS;
