import {useEffect} from 'react';

/**
 * Phase 5 — report a child engine's selection-lock state to the parent Wallet. While `locked` is true
 * the Wallet suppresses USER-initiated asset selection (the Balances button + the AssetPicker) so the
 * active Pay/Receive engine is not unmounted mid-flight — unmounting destroys the captured, immutable
 * request snapshot the review/sign path reads, losing the in-progress payment, and arms the wrong
 * protocol's NFC reader (invariant #11).
 *
 * Contract:
 *  - Reports the current `locked` value on every change (the effect re-runs when `locked` flips).
 *  - Resets to `false` on UNMOUNT. The only way a lock holder can leave without a sibling reporting is
 *    a tab switch (e.g. Pay → Ledger): PayMode unmounts mid-review and Ledger mounts with no lock
 *    reporter, so without this reset the Balances button would stay disabled forever. A freshly
 *    mounted engine always starts unlocked (PayMode 'scan' / SolPayMode 'setup'|'scan' / ReceiveMode
 *    no-reqQr / SolReceiveMode 'form'), so the lock naturally clears on any remount; the unmount reset
 *    is the belt-and-braces guarantee against a stuck lock on the Ledger tab.
 *
 * The parent's setter is a stable `useState` setter, so the unmount-reset effect (keyed on
 * `onLockChange`) runs once and cleans up exactly on unmount.
 */
export function useReportLock(onLockChange: ((locked: boolean) => void) | undefined, locked: boolean): void {
  useEffect(() => {
    onLockChange?.(locked);
  }, [locked, onLockChange]);
  useEffect(() => () => { onLockChange?.(false); }, [onLockChange]);
}
