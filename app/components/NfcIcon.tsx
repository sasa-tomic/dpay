import Svg, {Path, Line} from 'react-native-svg';

// The contactless NFC radiowaves glyph (viewBox 0 0 48 48): radiating signal arcs on the right and a
// pointing wedge on the left — the "tap-to-pay" mark. Reproduced as a single filled path (the source
// carries no fill-rule, so nonzero is faithful and keeps the arcs distinct). Drawn single-color so the
// caller tints it green (NFC on) or red (NFC off). Pure SVG path — no font/emoji dependence — so it
// renders identically on device and in the react-native-web e2e gate.
const NFC_PATH =
  'M37 42c-.3 0-.7-.1-1-.3c-1-.5-1.3-1.8-.8-2.7c0-.1 3.7-6.8 3.7-15S35.3 9 35.3 9c-.5-1-.2-2.2.8-2.7s2.2-.2 2.7.8c.2.3 4.3 7.6 4.3 17s-4.1 16.7-4.3 17c-.4.5-1.1.9-1.8.9m-4.2-6.2c.1-.2 2.2-5 2.2-11.8s-2.1-11.6-2.2-11.8c-.4-1-1.6-1.5-2.6-1c-1 .4-1.5 1.6-1 2.6c0 0 1.8 4.3 1.8 10.2s-1.8 10.2-1.8 10.2c-.4 1 0 2.2 1 2.6c.3.1.5.2.8.2c.8 0 1.5-.4 1.8-1.2M23.3 33c.6-.1 1.1-.5 1.4-1c.1-.2 2.3-3.9 2.3-8s-2.2-7.9-2.3-8c-.6-1-1.8-1.3-2.7-.7c-1 .6-1.3 1.8-.7 2.7c0 0 1.7 3 1.7 6c0 1.3-.3 2.7-.7 3.7l-13-11.2c-.5-.4-1.2-.6-1.8-.4s-1.2.6-1.4 1.3c0 .1-1.1 3.1-1.1 6.6s1.1 6.5 1.1 6.7c.4 1 1.5 1.6 2.6 1.2c1-.4 1.6-1.5 1.2-2.6c0 0-.9-2.6-.9-5.3c0-.8.1-1.6.2-2.3l12.5 10.8c.4.3.8.5 1.3.5z';

export function NfcIcon({color, size = 28, off = false}: {color: string; size?: number; off?: boolean}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <Path d={NFC_PATH} fill={color} fillRule="nonzero" />
      {off ? <Line x1={5} y1={5} x2={43} y2={43} stroke={color} strokeWidth={3.5} strokeLinecap="round" /> : null}
    </Svg>
  );
}
