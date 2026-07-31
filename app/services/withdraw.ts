import AsyncStorage from '@react-native-async-storage/async-storage';

// Saved last-used withdrawal destination, one per currency (Fork-B: NUTS-simple offramp — a returning
// user re-cashes-out without re-pasting their external address). Best-effort AsyncStorage; never blocks.
const withdrawAddrKey = (currency: number) => `dpay.withdraw.addr.${currency}`;
export async function loadSavedWithdrawAddr(currency: number): Promise<string | null> {
  try { return await AsyncStorage.getItem(withdrawAddrKey(currency)); } catch { return null; }
}
export async function saveWithdrawAddr(currency: number, addr: string): Promise<void> {
  try { await AsyncStorage.setItem(withdrawAddrKey(currency), addr); } catch { /* best-effort */ }
}
