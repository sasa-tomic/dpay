/**
 * walletRoute — the wallet's surfaces expressed as a URL, and read back from one (OPEN_ISSUES X11).
 *
 * The defect this closes: every tab and sheet was `/wallet`, so browser Back ejected the user out
 * of the wallet entirely, no tab was linkable, and a refresh always dumped you on the landing
 * screen. The fix is a pure mapping tested here, plus the history wiring in `useWalletHistory`.
 *
 * What is asserted:
 *   - every screen round-trips (build → parse → identical route). A screen that cannot round-trip
 *     is a screen the Back button would land on wrongly.
 *   - `home` is the CANONICAL EMPTY query: `/wallet` and `/wallet?screen=home` are the same place,
 *     and the one we write is the short one.
 *   - sub-modes ride the route (`pay/send`, `receive/address`) — they are distinct destinations,
 *     not view state, because a user who lands on "Send to address" from a link must get that form.
 *   - a sub-mode that does not belong to its screen is DROPPED, not carried: `?screen=home&m=send`
 *     is nonsense and must resolve to plain home rather than a half-applied state.
 *   - Settings is part of the route, so Back closes it (matching the Android hardware-back rule).
 *   - unknown/absent/garbage input resolves to home AND warns — never throws, because this string
 *     comes from a URL bar and a user typo must not white-screen a wallet.
 *   - the legacy-vocabulary guard: `screen=deposit` is an EXISTING deep link with its own meaning
 *     (auto-open the deposit sheet, `readDepositDeepLink`). It must not be swallowed as a wallet
 *     screen, or that deep link silently changes behaviour.
 */
import {describe, test, expect, jest, afterEach} from '@jest/globals';
import {
  parseRouteQuery, routeQuery, screenForMode, modeForScreen, ALL_SCREENS,
  applyRouteToSearch, searchMatchesRoute,
  type WalletRoute, type WalletMode,
} from '../lib/walletRoute';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('routeQuery', () => {
  test('home is the empty query — /wallet and /wallet?screen=home are one place', () => {
    expect(routeQuery({screen: 'home'})).toBe('');
  });

  test('every non-home screen names itself', () => {
    expect(routeQuery({screen: 'pay'})).toBe('?screen=pay');
    expect(routeQuery({screen: 'receive'})).toBe('?screen=receive');
    expect(routeQuery({screen: 'transactions'})).toBe('?screen=transactions');
    expect(routeQuery({screen: 'accounts'})).toBe('?screen=accounts');
    expect(routeQuery({screen: 'convert'})).toBe('?screen=convert');
  });

  test('a sub-mode is carried only where it exists', () => {
    expect(routeQuery({screen: 'pay', sub: 'send'})).toBe('?screen=pay&m=send');
    expect(routeQuery({screen: 'receive', sub: 'address'})).toBe('?screen=receive&m=address');
  });

  test('a sub-mode on the wrong screen is not written', () => {
    // The default sub-modes ('scan' on Pay, 'request' on Receive) are not expressible as a
    // `WalletSubMode` at all — the type only names the non-default ones, so "the default is
    // omitted" is enforced by the compiler rather than here. What IS expressible, and therefore
    // needs pinning, is a valid sub-mode paired with the screen it does not belong to: writing it
    // would produce a URL that parses back to something else, breaking the canonical-form
    // guarantee `useWalletHistory` compares against.
    expect(routeQuery({screen: 'receive', sub: 'send'})).toBe('?screen=receive');
    expect(routeQuery({screen: 'home', sub: 'address'})).toBe('');
  });

  test('settings rides on top of whatever screen is under it', () => {
    expect(routeQuery({screen: 'home', settings: true})).toBe('?settings=1');
    expect(routeQuery({screen: 'pay', sub: 'send', settings: true})).toBe('?screen=pay&m=send&settings=1');
  });
});

describe('parseRouteQuery', () => {
  test('every screen round-trips through its own query', () => {
    for (const screen of ALL_SCREENS) {
      expect(parseRouteQuery(routeQuery({screen}))).toEqual({screen});
    }
  });

  test('sub-modes round-trip', () => {
    const cases: WalletRoute[] = [
      {screen: 'pay', sub: 'send'},
      {screen: 'receive', sub: 'address'},
    ];
    for (const r of cases) {
      expect(parseRouteQuery(routeQuery(r))).toEqual(r);
    }
  });

  test('settings round-trips over a sub-moded screen', () => {
    const r: WalletRoute = {screen: 'pay', sub: 'send', settings: true};
    expect(parseRouteQuery(routeQuery(r))).toEqual(r);
  });

  test('an empty query is home', () => {
    expect(parseRouteQuery('')).toEqual({screen: 'home'});
    expect(parseRouteQuery('?')).toEqual({screen: 'home'});
  });

  test('a sub-mode on the wrong screen is dropped, not half-applied', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRouteQuery('?screen=home&m=send')).toEqual({screen: 'home'});
    expect(parseRouteQuery('?screen=pay&m=address')).toEqual({screen: 'pay'});
    expect(warn).toHaveBeenCalled();
  });

  test('an unknown screen resolves to home and WARNS — a URL typo must not white-screen a wallet', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRouteQuery('?screen=nonsense')).toEqual({screen: 'home'});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('nonsense');
  });

  test('screen=deposit keeps its EXISTING deep-link meaning and is not a wallet screen', () => {
    // `readDepositDeepLink` owns this value. Resolving it to a wallet screen here would silently
    // repurpose a shipped deep link; resolving it to home (with a warning) would be wrong too, so
    // it is recognised and passed through as "not a route".
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRouteQuery('?screen=deposit')).toEqual({screen: 'home'});
    expect(warn).not.toHaveBeenCalled();
  });

  test('unrelated query parameters are ignored, not treated as garbage', () => {
    // A pay link carries `?pay=…`; the OCP flows carry their own. Landing on such a URL is home,
    // silently — those parsers own those parameters.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRouteQuery('?pay=abc123')).toEqual({screen: 'home'});
    expect(warn).not.toHaveBeenCalled();
  });

  test('settings alone, with no screen, is home with settings open', () => {
    expect(parseRouteQuery('?settings=1')).toEqual({screen: 'home', settings: true});
  });

  test('settings=0 is not settings — only the canonical value opens it', () => {
    expect(parseRouteQuery('?settings=0')).toEqual({screen: 'home'});
  });
});

describe('foreign query parameters survive navigation', () => {
  // THE REGRESSION THIS PINS. The first version of the router replaced the whole query string on
  // its first render. The wallet is reached at `/wallet/pay/{recipient}?asset=…&network=…&amount=…`
  // and `?screen=deposit`, both parsed by OTHER functions in effects that run later — so the
  // router deleted the link that brought the user there before anything had read it. Two e2e flows
  // (03-deposit-address, 103-pay-link-refused) hung on exactly this.
  const PAY_LINK = '?asset=ckUSDC&network=solana&amount=1&relay=http%3A%2F%2F127.0.0.1%3A46519';

  test('a pay link is untouched while the user moves around inside the wallet', () => {
    const out = applyRouteToSearch(PAY_LINK, {screen: 'receive', sub: 'address'});
    const q = new URLSearchParams(out.slice(1));
    expect(q.get('asset')).toBe('ckUSDC');
    expect(q.get('network')).toBe('solana');
    expect(q.get('amount')).toBe('1');
    expect(q.get('relay')).toBe('http://127.0.0.1:46519');
    expect(q.get('screen')).toBe('receive');
    expect(q.get('m')).toBe('address');
  });

  test('the router does not consider a foreign parameter a navigation', () => {
    // If this returned false the hook would push a history entry — and rewrite the URL — on the
    // very first render of a pay link, for no reason a user could observe.
    expect(searchMatchesRoute(PAY_LINK, {screen: 'home'})).toBe(true);
  });

  test('a live screen=deposit deep link is not overwritten while the wallet is on its default surface', () => {
    // `readDepositDeepLink` consumes this value from an effect that waits for the catalog. The
    // router must lose that race deliberately.
    expect(searchMatchesRoute('?screen=deposit', {screen: 'home'})).toBe(true);
  });

  test('but once the user navigates, the router does own `screen`', () => {
    expect(searchMatchesRoute('?screen=deposit', {screen: 'pay'})).toBe(false);
    expect(applyRouteToSearch('?screen=deposit', {screen: 'pay'})).toBe('?screen=pay');
  });

  test('leaving a sub-moded screen clears the sub-mode rather than stranding it', () => {
    expect(applyRouteToSearch('?screen=pay&m=send', {screen: 'home'})).toBe('');
    expect(applyRouteToSearch('?screen=pay&m=send&settings=1', {screen: 'receive'})).toBe('?screen=receive');
  });
});

describe('mode ↔ screen', () => {
  const ALL_MODES: WalletMode[] = ['home', 'pay', 'receive', 'ledger', 'accounts', 'convert'];

  test('the map is TOTAL in both directions — every mode has a screen and every screen a mode', () => {
    // This is the assertion that makes `modeForScreen`'s throw unreachable. A screen added to one
    // vocabulary and not the other fails here rather than at runtime in front of a user.
    for (const mode of ALL_MODES) {
      expect(modeForScreen(screenForMode(mode))).toBe(mode);
    }
    for (const screen of ALL_SCREENS) {
      expect(screenForMode(modeForScreen(screen))).toBe(screen);
    }
  });

  test('the internal name `ledger` is spelled `transactions` in a URL, matching the tab label', () => {
    expect(screenForMode('ledger')).toBe('transactions');
    expect(modeForScreen('transactions')).toBe('ledger');
  });
});
