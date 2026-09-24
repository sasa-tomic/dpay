/* dpay web wallet — service worker (OPEN_ISSUES X10).
 *
 * TEMPLATE. `e2e/vite.config.js` (plugin `dpayWebProdAssets`, web-prod only) emits the built copy
 * to `dist-prod/sw.js` with the two placeholders below replaced; the relay serves it at `/sw.js`,
 * `no-cache`, so every navigation revalidates it. It is NOT part of the app bundle and imports
 * nothing — a worker that could break the wallet by breaking itself is not worth having.
 *
 * WHY IT EXISTS. The product's one-line claim is "your phone never needs a connection". Before
 * this, a reload of /wallet with the network down gave the browser's offline error page: the web
 * surface failed the headline claim. The shell + JS + wasm are now cached, so a cold reload boots.
 *
 * ============================ CACHING POLICY, PER REQUEST CLASS ============================
 * The rule behind every line: a LIVE FACT is never answered from cache. A cached balance rendered
 * as current would be a lie, and a stale one is indistinguishable from a fresh one on screen.
 *
 *  1. Cross-origin (any scheme/host that is not this relay) — NOT INTERCEPTED.
 *     The IC gateway (icp-api.io), the Solana RPC, a `?relay=<url>` override. Money moves here.
 *     The worker does not read, write, or observe these; offline they fail exactly as they do
 *     with no worker installed, and the app's own state machine reports that.
 *
 *  2. Same-origin `/api/**` — NOT INTERCEPTED. Balances, the currency catalog, capabilities,
 *     transactions, swap quotes, the checkout, and the `/api/v2` IC envelope gateway. Every one is a
 *     live fact or a value operation. Offline they fail, and failing is the honest answer: the
 *     wallet's `online` flag starts false and only flips on a successful read, so a cold cached
 *     boot shows the "approx." marker on the balance rather than a confident number.
 *
 *  3. Non-GET, or a request with a `Range` header — NOT INTERCEPTED. Nothing here is cacheable.
 *
 *  4. Navigations to this origin — NETWORK FIRST, cache only when the network fails.
 *     The freshest shell always wins when there is a network, so a deploy reaches the user on the
 *     very next navigation. With no network, the precached `/wallet` document is returned for any
 *     in-scope navigation (including `/wallet/pay/<recipient>?…`) — the URL is untouched, so the
 *     app still reads its own payment link off `location`. If the shell is not cached either, the
 *     network error propagates: the browser's offline page, not a half-app.
 *
 *  5. A same-origin path in THIS build's PRECACHE list — CACHE FIRST, never revalidated. That is
 *     every `/assets/**` file (the filenames are content hashes; the hash IS the version, which is
 *     why the relay already serves them `immutable`) plus the manifest and the icon, which are
 *     versioned by belonging to this worker's cache and are dropped with it. The list is the ONE
 *     definition of what this worker serves, so nothing is cached that it will not read and
 *     nothing is read that it did not cache. A miss can only mean the browser evicted the entry
 *     under storage pressure, and the request then takes the network like any other.
 *
 *  6. Everything else same-origin — NOT INTERCEPTED. The marketing site (`/`, `/privacy`,
 *     `/shots/*`, `/download/*`, `/dpay-core.wasm`, `/.well-known/*`) is not the wallet; and,
 *     deliberately, neither is a hashed asset from a NEWER build than this worker. After a deploy
 *     the fresh HTML asks for filenames this worker never precached, and they go straight to the
 *     origin — this worker never writes to its own cache at runtime, so a version's cache holds
 *     exactly one build and can never accumulate a half-and-half mixture.
 *
 * ================================== UPDATE SAFETY ==================================
 * VERSION is a hash over the CONTENT of every precached file, computed at build time. Any change
 * to the shell — a new bundle, a new font, a new icon — changes it, so `sw.js` changes byte-wise
 * and the browser installs a new worker. Nothing here is hand-maintained, so nothing can drift.
 *
 * There is deliberately NO `skipWaiting()` and NO `clients.claim()`. A new worker installs and
 * precaches in the background, then WAITS until every tab in scope is gone. The reason is
 * specific to this app: the bundle has real lazy chunks (`history-*.js`, `rpc-*.js`,
 * `walletconnect-*.js`), and the relay only serves the CURRENT build — so taking over a live page
 * and purging the old cache could leave an open wallet unable to load a chunk it is about to need,
 * from either cache or origin, mid-payment. Waiting removes that class entirely.
 *
 * First load after a deploy, exactly: the navigation is network-first, so the user gets the NEW
 * HTML and its new hashed assets immediately (fetched from the network, since they miss the old
 * cache) — nobody online is ever served a stale bundle. In parallel the new worker installs and
 * precaches. On the next full close-and-reopen it activates and deletes every other `dpay-shell-*`
 * cache in one step, so a version's HTML and its assets are always dropped together.
 */

const VERSION = '__DPAY_SW_VERSION__';
const CACHE = `dpay-shell-${VERSION}`;
/** Absolute, origin-relative paths. Emitted by the build from the real dist — never hand-edited. */
const PRECACHE = __DPAY_SW_PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(
        PRECACHE.map((p) =>
          // The shell HTML is the one entry read straight from the ORIGIN, so a stale
          // intermediary copy can never BECOME the offline shell. Every other entry goes through
          // the browser's HTTP cache, which is correct for both kinds here: the /assets/ files are
          // content-hashed and `immutable` (the page that triggered this install just downloaded
          // those exact bytes — forcing a reload would fetch the whole bundle a second time on
          // first visit), and the manifest + icon are `no-cache`, which revalidates rather than
          // reuses, so a changed one is still fetched.
          p === '/wallet' ? new Request(p, { cache: 'reload' }) : p,
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith('dpay-shell-') && k !== CACHE).map((k) => caches.delete(k)),
      ),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return; // class 3
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // class 1
  if (url.pathname.startsWith('/api/')) return;                 // class 2

  if (req.mode === 'navigate') {                                // class 4
    event.respondWith(
      fetch(req).catch(() =>
        caches.match('/wallet', { cacheName: CACHE }).then((hit) => {
          if (hit) return hit;
          // No network AND no cached shell: report the real failure instead of inventing a page.
          return Response.error();
        }),
      ),
    );
    return;
  }

  if (PRECACHE.includes(url.pathname)) {                        // class 5
    event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
  }
  // class 6: no respondWith → the browser's own network path.
});
