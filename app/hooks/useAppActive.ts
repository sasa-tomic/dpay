import {useEffect, useState} from 'react';
import {AppState, type AppStateStatus} from 'react-native';

/**
 * Is the app in front of the user right now?
 *
 * ONE code path for both surfaces: `AppState` is the platform API on Android and is implemented by
 * react-native-web over `document.visibilityState`, so the shipped APK and the web wallet answer
 * this question the same way and neither needs a branch.
 *
 * THE RULE IS DELIBERATELY ONE-SIDED: only an explicit 'background' or 'inactive' means "not in
 * front of the user". Anything else — including a platform that reports no state at all — counts
 * as active. A wallet that stopped reading balances because it could not tell whether it was on
 * screen would show a stale number and never say so; a wallet that keeps polling in that case is
 * merely back to the behaviour it had before this hook existed. The saving this delivers comes
 * from the states the platform DOES report, and those it reports plainly.
 *
 * `AppState.currentState` is read once at mount rather than tracked per render: the subscription
 * below is what keeps it current, and the initial read is only the seed. On the RN jest preset
 * `currentState` is `undefined` and `addEventListener` returns a subscription — both handled here
 * rather than in every caller.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => isActive(AppState.currentState));

  useEffect(() => {
    // Re-read on mount: the state can have changed between the initial render and the effect.
    setActive(isActive(AppState.currentState));
    const sub = AppState.addEventListener('change', (state) => setActive(isActive(state)));
    // react-native-web returns undefined when `document.visibilityState` is unavailable.
    return () => sub?.remove();
  }, []);

  return active;
}

/** Only the two states that positively mean "not in front of the user" stop anything. */
function isActive(state: AppStateStatus | undefined | null): boolean {
  return state !== 'background' && state !== 'inactive';
}
