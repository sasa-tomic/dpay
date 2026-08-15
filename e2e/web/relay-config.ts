// Web-only override of `app/relayConfig.ts` (which the native build pins to the prod URL). The
// e2e harness needs to point the REAL app at the local test relay (or a live one) without touching
// App.tsx, so `e2e/vite.config.js` aliases `./relayConfig` -> this file.
//
// Resolution order at app boot:
//   1. ?relay=<url>           — the harness passes this when it serves the page (per-run override)
//   2. window.__DPAY_RELAY    — a driver can flip the live target after load
//   3. mode default:
//        - the web-prod build (`vite build --mode web-prod`, served by the relay at /wallet):
//          SAME-ORIGIN (window.location.origin) — the wallet talks to the relay that served it.
//        - the e2e build: 'http://127.0.0.1:8787' — matches the relay spawner's bind when
//          DPAY_RELAY_ADDR is unset.
function readRelay(): string {
  if (typeof window !== 'undefined') {
    try {
      const r = new URLSearchParams(window.location.search).get('relay');
      if (r) return r;
    } catch { /* no query string */ }
    const w = (window as unknown as { __DPAY_RELAY?: unknown }).__DPAY_RELAY;
    if (typeof w === 'string' && w.length > 0) return w;
  }
  if (import.meta.env.MODE === 'web-prod') {
    // Same-origin: an absolute origin renders nicely in the app's settings UI and works anywhere;
    // the empty-string relative path would also work (app/services/relay.ts `base()` turns it into
    // a relative /api/v1 fetch), but the origin is friendlier to display and copy.
    if (typeof window !== 'undefined' && window.location && window.location.origin) {
      return window.location.origin;
    }
    return '';
  }
  return 'http://127.0.0.1:8787';
}

export const RELAY_DEFAULT: string = readRelay();
