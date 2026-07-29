// Web-only override of `app/relayConfig.ts` (which the prod build codegens to a fixed URL). The
// e2e harness needs to point the REAL app at the local test relay (or a live one) without touching
// App.tsx, so `e2e/vite.config.js` aliases `./relayConfig` -> this file.
//
// Resolution order at app boot:
//   1. ?relay=<url>           — the harness passes this when it serves the page (per-run override)
//   2. window.__DPAY_RELAY    — a driver can flip the live target after load
//   3. 'http://127.0.0.1:8787' — local default; matches the relay spawner's bind when DPAY_RELAY_ADDR
//                                is unset. Production web builds replace this file with the real URL.

function readRelay(): string {
  if (typeof window !== 'undefined') {
    try {
      const r = new URLSearchParams(window.location.search).get('relay');
      if (r) return r;
    } catch { /* no query string */ }
    const w = (window as unknown as { __DPAY_RELAY?: unknown }).__DPAY_RELAY;
    if (typeof w === 'string' && w.length > 0) return w;
  }
  return 'http://127.0.0.1:8787';
}

export const RELAY_DEFAULT: string = readRelay();
