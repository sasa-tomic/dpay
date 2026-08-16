// react-native-vision-camera shim with a REAL camera for the PROD web build (/wallet).
//
// Mirrors the export surface of `e2e/web/camera.ts` (the inject-only shim the e2e harness uses):
// `Camera`, `useCameraDevice`, `useCameraPermission`, `useCodeScanner` — the app's <QrScanner>
// runs verbatim against either. This variant drives the actual browser camera:
//
//   - getUserMedia({video: {facingMode: 'environment'}}) for the stream
//   - jsQR (the VENDORED e2e/web/vendor/jsQR.js — the old /merchant terminal's copy, recovered
//     from git history after the 2026-08-16 merge deleted the runtime /jsqr.js route) imported
//     STATICALLY so the decoder is inside the hashed wallet bundle — no runtime route, no 404,
//     no CSP dependence. This fixes the 2026-08-16 "scanning does not work on /wallet" regression
//     (the shim silently loaded /jsqr.js which the relay no longer serves).
//   - a requestAnimationFrame video→canvas→jsQR loop feeding onCodeScanned([{value}])
//
// FOUNDER RULE — the camera starts ONLY on the explicit "Allow camera scan" click. <QrScanner>
// auto-calls requestPermission() in a mount effect; that auto call has NO user gesture, so it
// resolves false WITHOUT touching getUserMedia (no prompt, no stream). Only a call made in the
// shadow of a real gesture (pointerdown/keydown, or navigator.userActivation.isActive) opens the
// camera. The stream lives only while <Camera> is mounted (it is stopped on unmount); re-entering
// the scan screen re-acquires it silently since permission is already granted.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { StyleSheet } from 'react-native';
// The vendored UMD bundle (module.exports = jsQR factory) — vite's CJS interop gives the default
// export. Self-contained: the decoder ships inside the wallet's hashed assets.
import jsQR from './vendor/jsQR.js';

// --- permission store (shared across every hook instance) ----------------------------------------
let permGranted = false;
const permSubs = new Set<() => void>();
function setPerm(v: boolean) {
  if (permGranted === v) return;
  permGranted = v;
  for (const s of permSubs) s();
}
function usePermGranted(): boolean {
  const [granted, setGranted] = useState(permGranted);
  useEffect(() => {
    const s = () => setGranted(permGranted);
    permSubs.add(s);
    return () => { permSubs.delete(s); };
  }, []);
  return granted;
}

// --- gesture detection (the founder rule's enforcement point) ------------------------------------
let lastGestureAt = 0;
if (typeof window !== 'undefined') {
  const mark = () => { lastGestureAt = Date.now(); };
  window.addEventListener('pointerdown', mark, true);
  window.addEventListener('keydown', mark, true);
}
function userGestureActive(): boolean {
  const ua = (navigator as unknown as { userActivation?: { isActive?: () => boolean } }).userActivation;
  if (ua && typeof ua.isActive === 'function') {
    try { if (ua.isActive()) return true; } catch { /* fall through to the timestamp */ }
  }
  return Date.now() - lastGestureAt < 5000; // click-handler code paths run well within this
}

// --- stream management (one live stream max; dropped on Camera unmount) --------------------------
let gumPromise: Promise<MediaStream> | null = null;
function getStream(): Promise<MediaStream> {
  if (!gumPromise) {
    gumPromise = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .catch((e: unknown) => { gumPromise = null; throw e; });
  }
  return gumPromise;
}
function releaseStream() {
  if (!gumPromise) return;
  gumPromise.then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
  gumPromise = null;
}

// --- jsQR (statically imported from vendor/jsQR.js — see header) ---------------------------------
type JsQr = typeof jsQR;

// --- exported hooks (same shapes the app already consumes) ---------------------------------------
export function useCameraPermission() {
  const granted = usePermGranted();
  return {
    hasPermission: granted,
    requestPermission: async (): Promise<boolean> => {
      // The mount-effect auto-call lands here WITHOUT a gesture → resolve false, never prompt,
      // never start a stream. The "Allow camera scan" button's call lands right after a click.
      if (!userGestureActive()) return false;
      try {
        await getStream();
        setPerm(true);
        return true;
      } catch {
        return false; // denied / no camera: placeholder + button stay up
      }
    },
  };
}

export function useCameraDevice(_position?: string) {
  const granted = usePermGranted();
  // Stable identity while granted (a fresh object per toggle would remount <Camera> every notify).
  return useMemo(
    () => granted ? { id: 'web-back', devices: ['back'], position: 'back', name: 'Web back camera', hasFlash: false, formats: [] } : undefined,
    [granted],
  );
}

export function useCodeScanner(opts: { codeTypes: string[]; onCodeScanned: (codes: { value?: string }[]) => void }) {
  // Pass-through: <Camera> reads the options directly (kept for surface parity with the inject shim).
  return { codeScannerOptions: opts };
}

export function Camera(props: {
  style?: unknown;
  device?: { id: string } | undefined;
  isActive?: boolean;
  codeScanner?: { codeTypes: string[]; onCodeScanned: (codes: { value?: string }[]) => void } | { codeScannerOptions: { codeTypes: string[]; onCodeScanned: (codes: { value?: string }[]) => void } };
  enabled?: boolean;
}) {
  // Accept BOTH shapes: the upstream react-native-vision-camera scanner object ({codeTypes,
  // onCodeScanned} directly) and the inject-shim's {codeScannerOptions: {...}} wrapper. The app's
  // <QrScanner> passes whatever useCodeScanner returned; the two web shims historically disagreed
  // (the inject shim wraps, upstream doesn't) — unwrapping here keeps <QrScanner> verbatim on both.
  const raw = props.codeScanner as { codeScannerOptions?: { onCodeScanned: (codes: { value?: string }[]) => void } } | undefined;
  const codeScanner = raw && raw.codeScannerOptions ? raw.codeScannerOptions : props.codeScanner as { onCodeScanned: (codes: { value?: string }[]) => void } | undefined;
  const { style, device } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(props.isActive !== false);
  activeRef.current = props.isActive !== false;
  const scanRef = useRef(codeScanner);
  scanRef.current = codeScanner;
  // Per-mount dedupe: fire onCodeScanned for each NEW value; re-presenting the same QR within one
  // scan session is suppressed (QrScanner's own fired-ref handles the once-per-mount contract).
  const lastValue = useRef<string | null>(null);
  // Alternating frame counter for the mirrored-frame retry (see the decode step).
  const frameFlip = useRef(0);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    const canvas = document.createElement('canvas');
    (async () => {
      const jsqr: JsQr | null = jsQR;
      try {
        stream = await getStream();
      } catch {
        return; // permission revoked mid-session; the placeholder branch takes over on re-render
      }
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      const v = videoRef.current;
      if (!v) return;
      v.srcObject = stream;
      v.muted = true; // muted + playsinline: the autoplay-policy-friendly path
      try { await v.play(); } catch { /* some browsers resolve play later; the rAF loop tolerates it */ }
      const step = () => {
        if (cancelled) return;
        if (activeRef.current && jsqr && v.videoWidth > 0 && scanRef.current) {
          const w = v.videoWidth;
          const h = v.videoHeight;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(v, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            try {
              let code = jsqr!(img.data, w, h, { inversionAttempts: 'dontInvert' });
              // Some webcam drivers deliver horizontally-mirrored tracks (a QR is chiral — a
              // mirrored frame is undecodable as-is, and the preview looks flipped). Rather than
              // guess the polarity per device, decode BOTH: every other failing frame re-draws
              // the video mirrored and tries again. Half-frames keeps the added cost bounded.
              if (!code && (frameFlip.current++ & 1) === 1) {
                ctx.save();
                ctx.scale(-1, 1);
                ctx.drawImage(v, -w, 0, w, h);
                ctx.restore();
                const mimg = ctx.getImageData(0, 0, w, h);
                code = jsqr!(mimg.data, w, h, { inversionAttempts: 'dontInvert' });
              }
              if (code && typeof code.data === 'string' && code.data.length > 0 && code.data !== lastValue.current) {
                lastValue.current = code.data;
                try { scanRef.current!.onCodeScanned([{ value: code.data }]); } catch { /* app-side */ }
              }
            } catch { /* a bad frame must not kill the loop */ }
          }
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      releaseStream(); // the stream lives only while a <Camera> is mounted
    };
  }, [device ? device.id : null]);

  if (!device) return null;
  // RN styles (compiled by RNW) → plain CSS via StyleSheet.flatten; the video fills the box.
  const css = (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      playsInline
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', ...css } as CSSProperties}
    />
  );
}

export default Camera;
