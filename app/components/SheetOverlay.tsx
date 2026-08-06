import {useRef, type ReactNode} from 'react';
import {View} from 'react-native';
import {S} from '../styles';
import {useFocusTrap} from '../hooks/useHotkeys';

/**
 * Full-screen sheet overlay wrapper — the single entry point for the focus trap. Every sheet that
 * covers the wallet (`<View style={S.sheetOverlay}>`) should use this instead so keyboard focus
 * enters the sheet on mount (instead of staying on the hidden wallet behind the opaque overlay) and
 * Tab wraps within the sheet's focusable descendants. On native the hook is a no-op (Android uses
 * touch + the hardware Back button). Carries `role="dialog"` so screen readers announce
 * a modal context.
 */
export function SheetOverlay({children}: {children: ReactNode}) {
  const ref = useRef<View>(null);
  useFocusTrap(ref);
  return <View ref={ref} style={S.sheetOverlay} role="dialog">{children}</View>;
}
