import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-asset NAMED address book — the destinations the user has actually sent to, most-recently-used
// first, capped at MAX_SAVED_ADDRESSES. Replaces services/withdraw.ts's single last-used string: a
// returning user picks a saved, named destination from a short list instead of re-pasting (or
// MIS-pasting) an external address, which is the one irreversible mistake an on-chain withdraw
// screen can make.
//
// KEYED BY AN OPAQUE ASSET KEY, not a currency number. The caller passes `ic:<currency>` or
// `solana:SOL`, so the IC and SOL rails share ONE store behind ONE UI surface — the wallet's hard
// rule is that every currency is handled through the same flows, and a per-rail address store would
// be exactly the kind of divergence that rule forbids. This module never parses the key; it is an
// opaque namespace string.
//
// CLOCK-FREE BY CONTRACT: `lastUsedMs` is supplied by the CALLER as `nowMs` rather than read from
// `Date.now()` in here. Ordering and eviction are therefore pure functions of the arguments — the
// tests pin exact orderings without faking timers, and the module has no ambient dependency.
//
// A PURE AsyncStorage wrapper (no NativeModules surface), best-effort in the house style of
// services/withdraw.ts + services/ckerc20Persist.ts: every storage/parse failure is caught and
// logged with context via `console.warn` — never silently swallowed, and never thrown at the
// caller, so a storage glitch degrades to an empty book instead of crashing the withdraw screen.
// The ONE exception is a caller contract violation (see `rememberAddress`), which throws: that is a
// bug in the calling code, not a storage glitch, and it must not be written to disk only to be
// dropped again at the next read.

/**
 * One saved destination.
 *   - `address`: the destination, VERBATIM as the caller validated it (a BTC/ETH address, an ICRC-1
 *     principal, a Solana base58 pubkey). This module never validates or normalises it — it is the
 *     identity of the row, matched exactly.
 *   - `label`: the user-given name. May be `''` (an unlabelled address the user saved anyway).
 *   - `lastUsedMs`: the caller's `nowMs` at the last `rememberAddress`. The SOLE ordering key and
 *     the sole eviction key.
 */
export type SavedAddress = {
  address: string;
  label: string;
  lastUsedMs: number;
};

/** How many destinations one asset keeps. Beyond this the least-recently-used row is evicted. */
export const MAX_SAVED_ADDRESSES = 10;

/**
 * The storage key for one asset's book. `dpay.*` namespace like every sibling service; the `.v1`
 * suffix is a schema-version namespace so a future incompatible shape migrates without colliding
 * with stale keys (mirrors `solMerchantKey`).
 */
export function addressBookKey(assetKey: string): string {
  return `dpay.addrbook.v1.${assetKey}`;
}

const detail = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The ONE place MRU order and the cap are applied — both the read path (`loadAddressBook`, so a
 * hand-edited/over-long blob is normalised on the way in) and the write path (`persist`) run every
 * list through here. Sorting by `lastUsedMs` descending makes "evict the oldest" nothing more than
 * dropping the tail, so the two policies cannot drift apart.
 */
function mruCapped(entries: SavedAddress[]): SavedAddress[] {
  return [...entries]
    .sort((a, b) => b.lastUsedMs - a.lastUsedMs)
    .slice(0, MAX_SAVED_ADDRESSES);
}

/** Shape check for one stored row. Also guards `rememberAddress`'s arguments — one validator. */
function isSavedAddress(value: unknown): value is SavedAddress {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.address === 'string' &&
    e.address !== '' &&
    typeof e.label === 'string' &&
    typeof e.lastUsedMs === 'number' &&
    Number.isFinite(e.lastUsedMs)
  );
}

/**
 * Validate a parsed blob into a normalised book. A single corrupt row must NOT cost the user their
 * other nine saved addresses, so malformed entries are dropped INDIVIDUALLY (each one logged with
 * the offending value) rather than failing the whole list closed. A non-array value has no
 * salvageable rows at all → empty book.
 */
function hydrate(key: string, raw: unknown): SavedAddress[] {
  if (!Array.isArray(raw)) {
    console.warn(`address book ${key} load failed: stored value is ${typeof raw}, expected an array`);
    return [];
  }
  const entries: SavedAddress[] = [];
  for (const e of raw) {
    if (!isSavedAddress(e)) {
      console.warn(`address book ${key}: dropping malformed entry ${JSON.stringify(e)}`);
      continue;
    }
    entries.push({address: e.address, label: e.label, lastUsedMs: e.lastUsedMs});
  }
  return mruCapped(entries);
}

/**
 * Write a book and return exactly what was written (normalised through `mruCapped`). Best-effort: a
 * thrown AsyncStorage error is logged, never propagated — the returned list is still what the caller
 * should render, and the warn is the record that this write will not survive a restart.
 */
async function persist(assetKey: string, entries: SavedAddress[]): Promise<SavedAddress[]> {
  const key = addressBookKey(assetKey);
  const next = mruCapped(entries);
  try {
    await AsyncStorage.setItem(key, JSON.stringify(next));
  } catch (e) {
    console.warn(`address book ${key} save failed:`, detail(e));
  }
  return next;
}

/**
 * The saved destinations for one asset, MOST-RECENTLY-USED FIRST. Returns `[]` when the book was
 * never written (an empty book is the honest answer for a first-time user, not a failure, so that
 * path is silent); a storage error, malformed JSON, or a non-array value all log with context and
 * degrade to `[]`.
 */
export async function loadAddressBook(assetKey: string): Promise<SavedAddress[]> {
  const key = addressBookKey(assetKey);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (e) {
    console.warn(`address book ${key} load failed:`, detail(e));
    return [];
  }
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`address book ${key} load failed: malformed JSON —`, detail(e));
    return [];
  }
  return hydrate(key, parsed);
}

/**
 * Insert-or-update one destination and return the resulting book (MRU first). An address already in
 * the book is updated IN PLACE — no duplicate row — taking the new `label` and the new `nowMs`,
 * which moves it to the front. At MAX_SAVED_ADDRESSES the entry with the oldest `lastUsedMs` is
 * evicted.
 *
 * `nowMs` is the caller's clock reading; it becomes the row's `lastUsedMs` verbatim.
 *
 * THROWS on a caller contract violation (empty `address`, non-finite `nowMs`) — that is a bug in
 * the caller, and persisting such a row would silently lose it at the next read. Storage failures
 * never throw (see `persist`).
 */
export async function rememberAddress(
  assetKey: string,
  address: string,
  label: string,
  nowMs: number,
): Promise<SavedAddress[]> {
  const entry: SavedAddress = {address, label, lastUsedMs: nowMs};
  if (!isSavedAddress(entry)) {
    throw new Error(`rememberAddress(${assetKey}): invalid entry ${JSON.stringify(entry)}`);
  }
  const kept = (await loadAddressBook(assetKey)).filter(e => e.address !== address);
  return persist(assetKey, [...kept, entry]);
}

/**
 * Remove one destination (exact address match) and return the remaining book, still MRU first.
 * Removing an address that is not in the book is a caller/UI desync rather than a fatal error: it is
 * logged and the book is rewritten unchanged.
 */
export async function forgetAddress(assetKey: string, address: string): Promise<SavedAddress[]> {
  const current = await loadAddressBook(assetKey);
  const kept = current.filter(e => e.address !== address);
  if (kept.length === current.length) {
    console.warn(
      `address book ${addressBookKey(assetKey)}: no entry for ${address} — nothing removed`,
    );
  }
  return persist(assetKey, kept);
}
