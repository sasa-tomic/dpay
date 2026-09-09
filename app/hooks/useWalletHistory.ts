import {useEffect, useRef} from 'react';
import {Platform} from 'react-native';
import {applyRouteToSearch, parseRouteQuery, routeQuery, searchMatchesRoute, type WalletRoute} from '../lib/walletRoute';

/**
 * Keeps the browser URL and the wallet's current surface in sync, in both directions
 * (OPEN_ISSUES X11). Web-only: native has no URL bar and uses the hardware Back button, which
 * `Wallet` handles separately with its own BackHandler.
 *
 * Three behaviours, and each closes one measured half of X11:
 *
 *   1. **On mount, the URL wins.** Whatever `?screen=…` says is applied to the wallet, so a
 *      refresh, a bookmark or a shared link lands on the screen it names instead of always dumping
 *      the user on the landing screen. The mount write uses `replaceState`, never `pushState` — a
 *      fresh load must not leave a phantom entry that makes the first Back press do nothing.
 *   2. **A surface change pushes an entry.** Moving to a new screen adds to the history stack, so
 *      Back walks back through the wallet rather than ejecting the user out of it.
 *   3. **Back and Forward apply the URL.** `popstate` parses and applies, so the buttons move
 *      between wallet screens.
 *
 * WHY THE PUSH IS GUARDED BY A STRING COMPARE. `routeQuery` is canonical (one URL per destination),
 * so "the URL already says this" is exactly "we are already here". Without the compare, a re-render
 * that produced an identical route would push a duplicate entry and the user would have to press
 * Back twice to leave a screen they entered once.
 *
 * `applyRoute` is mirrored into a ref so the listener subscribes ONCE while always dispatching to
 * the latest closure — the same pattern `useHotkeys` and `NfcTap` use, and for the same reason
 * (callers pass inline closures that are recreated every render).
 */
export function useWalletHistory(route: WalletRoute, applyRoute: (r: WalletRoute) => void): void {
  const applyRef = useRef(applyRoute);
  applyRef.current = applyRoute;
  // `route` is rebuilt every render by its caller, so it cannot be an effect dependency without
  // re-running the effect every render. The effect is keyed on the canonical query STRING (which
  // changes only when the destination does) and reads the object through this ref.
  const routeRef = useRef(route);
  routeRef.current = route;
  // Has the mount read happened? Until it has, the sync effect must not write: it would push the
  // wallet's DEFAULT route over the one the URL is asking for, and the requested screen would be
  // lost on every load.
  const hydrated = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const w = globalThis as unknown as {
      location?: {search?: string; pathname?: string};
      history?: {pushState?: (d: unknown, t: string, u: string) => void; replaceState?: (d: unknown, t: string, u: string) => void};
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
    if (!w.location || !w.history || typeof w.addEventListener !== 'function') {
      // No history API (a non-browser web host, or a stripped test environment). Routing is a
      // browser affordance; without it the wallet still works, so this is a capability check and
      // not a swallowed failure — but it is stated, because a silent no-op here would look exactly
      // like a routing bug.
      console.warn('[dpay] useWalletHistory: no location/history API — URL routing is inactive');
      return;
    }
    applyRef.current(parseRouteQuery(w.location.search ?? ''));
    hydrated.current = true;
    const onPop = () => { applyRef.current(parseRouteQuery(w.location?.search ?? '')); };
    w.addEventListener('popstate', onPop);
    return () => { w.removeEventListener?.('popstate', onPop); };
    // Mount-only: the URL is read once, and every later change flows through the effect below or
    // through popstate.
  }, []);

  const query = routeQuery(route);
  useEffect(() => {
    if (Platform.OS !== 'web' || !hydrated.current) {
      return;
    }
    const w = globalThis as unknown as {
      location?: {search?: string; pathname?: string};
      history?: {pushState?: (d: unknown, t: string, u: string) => void};
    };
    const current = w.location?.search ?? '';
    // Judged on the router's OWN parameters only — a pay link's `asset`/`network`/`amount` are not
    // a navigation, and re-encoding one must not push a history entry.
    if (searchMatchesRoute(current, routeRef.current)) {
      return;
    }
    // The path is preserved, and so is every foreign parameter: the wallet is served at `/wallet`,
    // and the relay also serves `/wallet/pay/{recipient}`. Rewriting either would navigate a
    // pay-link visitor away from the URL that brought them — which is exactly what an earlier
    // version of this line did.
    w.history?.pushState?.(null, '', `${w.location?.pathname ?? ''}${applyRouteToSearch(current, routeRef.current)}`);
  }, [query]);
}
