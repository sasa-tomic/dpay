import {Platform, Share} from 'react-native';

/**
 * Copy `text` to the system clipboard when available; otherwise fall back to the platform share
 * sheet (`Share.share` on Android opens a sheet that includes "Copy"; web's `navigator.clipboard`
 * is the real clipboard). Returns the path taken so the UI can say "Copied ✓" vs "Shared ✓".
 * Every fallible op is caught + logged with context (no silent errors); a failure degrades to the
 * Share fallback rather than throwing.
 */
export async function copyToClipboard(text: string): Promise<'clipboard' | 'shared'> {
  // Web: prefer the real clipboard API (works in react-native-web + the e2e browser harness).
  if (Platform.OS === 'web') {
    try {
      const clip = (globalThis as {navigator?: {clipboard?: {writeText?: (t: string) => Promise<void>}}}).navigator?.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        await clip.writeText(text);
        return 'clipboard';
      }
    } catch (e) {
      console.warn('[dpay] clipboard write failed, falling back to Share:', String(e));
    }
  }
  // Native (or web without a clipboard API): Share sheet. On Android this reliably exposes "Copy".
  try {
    await Share.share({message: text});
  } catch (e) {
    // Even Share failing must not break the sheet — log with context and report the best outcome.
    console.warn('[dpay] Share.share failed during copy:', String(e));
  }
  return 'shared';
}
