// The wallet's surfaces, expressed as a URL and read back from one (OPEN_ISSUES X11).
//
// THE DEFECT THIS CLOSES. Every tab and every sheet was `/wallet`. So the browser's Back button
// left the wallet entirely rather than moving inside it, no tab could be linked or bookmarked, and
// a refresh always dumped the user on the landing screen no matter where they were. On a web wallet
// that is not a polish item: Back is the most-pressed control a browser has.
//
// WHY A QUERY PARAMETER AND NOT A PATH. `?screen=…` is already this app's deep-link vocabulary —
// `readDepositDeepLink` (in `deepLink.ts`) has shipped `?screen=deposit` for as long as the web
// wallet has existed. Extending that vocabulary keeps ONE scheme; adding `/wallet/pay` style paths
// would mean a second one, and would need matching relay routes for every surface (the relay serves
// `/wallet` and `/wallet/pay/{recipient}` — a path scheme would collide with the pay-link route).
// A query keeps every wallet URL served by the existing `/wallet` handler, so a refresh on any
// screen works with no relay change at all.
//
// THIS MODULE IS PURE. It maps a route to a query string and back, and does nothing else — no
// history calls, no state, no platform access. `hooks/useWalletHistory.ts` owns the browser wiring.
// Keeping the mapping pure is what makes "does Back land where the user expects" a unit test rather
// than a screenshot.

/** The wallet's linkable surfaces. Four are tabs; the rest are routes (entered from a control,
 *  left by Back). `transactions` is spelled the way the tab is LABELLED, not the way the mode is
 *  named internally ('ledger') — a URL is user-facing text. `Wallet` owns that one-word
 *  translation. */
export type WalletScreen = 'home' | 'pay' | 'receive' | 'transactions' | 'accounts' | 'convert' | 'addresses' | 'add-currency';

/** Every screen, in tab order. Exported so a test can assert the mapping is total rather than
 *  spot-checking whichever screens someone remembered. */
export const ALL_SCREENS: readonly WalletScreen[] = ['home', 'pay', 'receive', 'transactions', 'accounts', 'convert', 'addresses', 'add-currency'];

/** The non-default within-tab sub-modes. These are destinations, not view state: a user who follows
 *  a link to "Send to address" must arrive at that form, not at the scanner with a toggle to press.
 *  The DEFAULT sub-mode of each tab ('scan' on Pay, 'request' on Receive) is deliberately absent
 *  from the URL — see `routeQuery`. */
export type WalletSubMode = 'send' | 'address';

/** Which screen each sub-mode belongs to. A sub-mode outside its screen is meaningless, and
 *  carrying it anyway would produce a half-applied state that no gesture in the app can reach. */
const SUB_MODE_SCREEN: Readonly<Record<WalletSubMode, WalletScreen>> = {send: 'pay', address: 'receive'};

export type WalletRoute = {
  screen: WalletScreen;
  /** Absent means the screen's own default sub-mode. */
  sub?: WalletSubMode;
  /** The Settings sheet, in the route so browser Back CLOSES it instead of navigating out from
   *  under it — the same rule Android's hardware Back already follows (`Wallet`'s BackHandler
   *  closes the sheet before it leaves the screen). Without this, Back over an open Settings sheet
   *  changed the URL while the sheet stayed on screen, which is the measured X11 symptom. */
  settings?: boolean;
};

/**
 * The wallet's surfaces as `Wallet` names them internally. Declared HERE rather than inside
 * `Wallet` so the mode↔screen translation below has one home and can be unit-tested: the two
 * vocabularies differ in exactly one word, and that is precisely the kind of difference that rots
 * when it lives in two files.
 *
 * Four are TABS (home/pay/receive/ledger — the bottom bar switches between them and each is a
 * destination); three are ROUTES (accounts/convert/addresses — entered from a control, left by
 * Back, never a bottom-bar destination). The URL does not distinguish the two, because to a user
 * bookmarking one they are all just places.
 */
export type WalletMode = 'pay' | 'receive' | 'ledger' | 'home' | 'accounts' | 'convert' | 'addresses' | 'add-currency';

/** The one word the two vocabularies disagree on: the tab is LABELLED "Transactions" and the mode
 *  is named `ledger`. A URL is user-facing text, so it uses the label. */
const MODE_TO_SCREEN: Readonly<Record<WalletMode, WalletScreen>> = {
  home: 'home', pay: 'pay', receive: 'receive', ledger: 'transactions', accounts: 'accounts', convert: 'convert', addresses: 'addresses', 'add-currency': 'add-currency',
};

export function screenForMode(mode: WalletMode): WalletScreen {
  return MODE_TO_SCREEN[mode];
}

export function modeForScreen(screen: WalletScreen): WalletMode {
  const found = (Object.keys(MODE_TO_SCREEN) as WalletMode[]).find(m => MODE_TO_SCREEN[m] === screen);
  if (found === undefined) {
    // Unreachable while the record above is total over WalletScreen — which the round-trip test
    // pins. Stated rather than assumed, because a silent `?? 'home'` would hide a future screen
    // that someone added to one vocabulary and not the other.
    throw new Error(`walletRoute: no mode for screen "${screen}" - the mode↔screen map is not total`);
  }
  return found;
}

/** The value `readDepositDeepLink` owns. Recognised here ONLY so it is not mistaken for a typo and
 *  warned about — it is a shipped deep link with its own meaning, parsed by its own function. */
const DEPOSIT_DEEP_LINK = 'deposit';

/** The only value that opens Settings. A canonical spelling means one URL per state, so a Back
 *  comparison between an identical route built two ways cannot disagree. */
const SETTINGS_ON = '1';

/**
 * The canonical query string for a route — including the leading `?`, or `''` for home.
 *
 * Canonical matters more than it looks: `useWalletHistory` compares the URL it would write against
 * the one already there to decide whether to push a history entry. Two spellings of one place would
 * push a duplicate entry, and the user would have to press Back twice to leave a screen they
 * entered once.
 */
export function routeQuery(route: WalletRoute): string {
  const parts: string[] = [];
  if (route.screen !== 'home') {
    parts.push(`screen=${route.screen}`);
  }
  // Only a NON-default sub-mode is written, and only on the screen it belongs to.
  if (route.sub !== undefined && SUB_MODE_SCREEN[route.sub] === route.screen) {
    parts.push(`m=${route.sub}`);
  }
  if (route.settings === true) {
    parts.push(`settings=${SETTINGS_ON}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/** The query parameters this module owns. Everything else in a URL belongs to another parser and
 *  must survive a navigation untouched — see `applyRouteToSearch`. */
const ROUTER_KEYS = ['screen', 'm', 'settings'] as const;

/** Is this the surface the wallet opens on, with nothing else asserted? Used to decide whether the
 *  router has anything to say about a URL that another parser is still holding. */
function isDefaultRoute(route: WalletRoute): boolean {
  return route.screen === 'home' && route.sub === undefined && route.settings !== true;
}

/**
 * Does `search` ALREADY express `route`, judged only on the parameters this module owns?
 *
 * This is the guard `useWalletHistory` writes through, and judging it on the router's own keys —
 * rather than on the whole string — matters for two reasons. It stops a re-serialisation
 * difference (`http://x` vs `http%3A%2F%2Fx` in somebody else's parameter) from looking like a
 * navigation and pushing a spurious history entry. And it means a URL carrying a pay link is left
 * byte-identical while the user moves around inside the wallet.
 */
export function searchMatchesRoute(search: string, route: WalletRoute): boolean {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  // A live `screen=deposit` deep link is NOT the router's to overwrite while the wallet is still
  // on its default surface: `readDepositDeepLink` consumes that value asynchronously (its effect
  // waits for the catalog), so writing over it here is a race the router would usually win and the
  // user would always lose — the deep link would silently stop working.
  if (q.get('screen') === DEPOSIT_DEEP_LINK && isDefaultRoute(route)) {
    return true;
  }
  const canonical = new URLSearchParams(routeQuery(route).replace(/^\?/, ''));
  return ROUTER_KEYS.every(k => (q.get(k) ?? '') === (canonical.get(k) ?? ''));
}

/**
 * `search` rewritten to express `route`, PRESERVING every parameter the router does not own.
 *
 * The bug this exists to prevent, because it was written the naive way first and taken down two
 * e2e flows: the wallet is reached at `/wallet/pay/{recipient}?asset=…&network=…&amount=…`, and a
 * router that replaced the whole query string on its first render deleted the payment link that
 * brought the user there, before the parser that reads it had run.
 */
export function applyRouteToSearch(search: string, route: WalletRoute): string {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const k of ROUTER_KEYS) {
    q.delete(k);
  }
  const canonical = new URLSearchParams(routeQuery(route).replace(/^\?/, ''));
  for (const k of ROUTER_KEYS) {
    const v = canonical.get(k);
    if (v !== null) {
      q.set(k, v);
    }
  }
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * Read a route out of a `location.search` string.
 *
 * NEVER THROWS. This input arrives from a URL bar, a bookmark, a QR code or a shared message, so a
 * typo must not white-screen a wallet. Anything unrecognised resolves to home — but it resolves
 * LOUDLY: an unknown screen name warns, because silently landing someone on the wrong surface is
 * how a "the link doesn't work" report becomes unreproducible. Values this app's OTHER parsers own
 * (`screen=deposit`, `?pay=…`) resolve to home SILENTLY — they are not typos, they are simply not
 * wallet screens.
 */
export function parseRouteQuery(search: string): WalletRoute {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const rawScreen = q.get('screen');
  const route: WalletRoute = {screen: 'home'};

  if (rawScreen !== null && rawScreen !== DEPOSIT_DEEP_LINK) {
    const match = ALL_SCREENS.find(s => s === rawScreen);
    if (match === undefined) {
      console.warn(`[dpay] walletRoute: unknown screen "${rawScreen}" in "${search}" - showing home instead`);
    } else {
      route.screen = match;
    }
  }

  const rawSub = q.get('m');
  if (rawSub !== null) {
    const sub = (Object.keys(SUB_MODE_SCREEN) as WalletSubMode[]).find(s => s === rawSub);
    if (sub === undefined) {
      console.warn(`[dpay] walletRoute: unknown sub-mode "${rawSub}" in "${search}" - showing the screen's default`);
    } else if (SUB_MODE_SCREEN[sub] !== route.screen) {
      console.warn(`[dpay] walletRoute: sub-mode "${sub}" does not belong to screen "${route.screen}" - dropping it`);
    } else {
      route.sub = sub;
    }
  }

  if (q.get('settings') === SETTINGS_ON) {
    route.settings = true;
  }
  return route;
}
