import {Platform} from 'react-native';

/**
 * Web-only deep link: `?screen=deposit` auto-opens the deposit sheet on load (so the page is
 * bookmarkable/shareable to top-up, and the e2e harness can deep-link straight in). Harmless on
 * native — there's no URL bar, and Platform.OS !== 'web' short-circuits before reading location.
 */
export function readDepositDeepLink(): boolean {
  if (Platform.OS !== 'web') {
    return false;
  }
  const w = globalThis as unknown as {location?: {search?: string}};
  if (!w.location) {
    return false;
  }
  try {
    return new URLSearchParams(w.location.search ?? '').get('screen') === 'deposit';
  } catch {
    return false;
  }
}
