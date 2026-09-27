import React from 'react';

/**
 * Flow-tier recorder mock for `react-native-qrcode-svg` (flow-project moduleNameMapper only —
 * domain tests keep the real SVG renderer). Renders nothing and stashes the EXACT encoded value
 * on `globalThis.__DPAY_QR_LAST` on every render — the SAME seam name and semantics as the e2e
 * web shim (`e2e/web/qrcode.tsx`), so ported flows read the identical global they read in the
 * browser. Jest pins the QR VALUE (asserted field-for-field with the app's own codecs, a stronger
 * check than OCR of the pixels); pixel scannability (quiet zone, brand-mark occlusion, jsQR
 * round-trip — flow 78) stays the browser visual tier's job by design.
 */
export default function QRCodeSvgRecorder({value}: {value: string}) {
  (globalThis as unknown as Record<string, unknown>).__DPAY_QR_LAST = value;
  return null;
}
