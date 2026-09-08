// Service-worker registration for the SHIPPED web wallet (OPEN_ISSUES X10).
//
// Referenced ONLY by `wallet.html` — the page the relay serves at /wallet. The e2e harness's
// `index.html` deliberately does not load it: a worker that intercepts a flow's very first
// navigation but not the ones before it would make the suite's timing nondeterministic, and the
// dev dist ships nowhere. One entry point per build, no mode flag to get wrong.
//
// The worker itself, and the whole caching policy, live in `e2e/web/sw.js`. Registration is at
// `/sw.js` (root scope) because the app spans two path prefixes the worker must see: `/wallet`
// (+ `/wallet/pay/<recipient>`) and `/assets/`.
//
// Registered on `load` so precaching the shell never competes with the first paint of the very
// page that is installing it. There is no capability guard: this page is only ever served over
// https or from 127.0.0.1, both secure contexts, so `navigator.serviceWorker` is always there.
// (The build merges this module into the app chunk — it is a separate <script> in the SOURCE
// html, which is what keeps it out of the e2e build; it is not a separate chunk at runtime. The
// call sits inside a `load` listener, so a throw here reports itself and ends there.)
window.addEventListener('load', () => {
  navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
    // A failed registration means the wallet WILL NOT open offline. It must never pass silently.
    console.error('dpay: service worker registration failed — /wallet will not open offline:', err);
  });
});
