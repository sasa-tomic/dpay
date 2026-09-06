import AsyncStorage from '@react-native-async-storage/async-storage';

// OPEN_ISSUES 6(a) — persist the per-mint last-known token-account state (absent | balance).
//
// The solreq auto-sign paths (QR scan + NFC card) sign PURE, against an ASSUMED source ATA
// (deriveAta(payer, mint) — app/solana/spl.ts). If that ATA does not exist, the offline sign
// still succeeds and the merchant's broadcast is REJECTED — a dead QR the payer cannot know
// about. The per-request-mint sign gate (solSplSignGate, app/config/assets.ts) refuses BEFORE
// signing when the mint's ATA is KNOWN absent — but the hook's states are in-memory only, and an
// OFFLINE restart starts every mint at 'loading' (fail-open). Closing that hole needs the
// last-known fact to survive restart:
//   - 'absent'  is sticky: ONLY THE OWNER CAN CLOSE AN ATA (close_authority defaults to the
//     owner; Solana program rules) and dpay never builds a close instruction (app/solana/ has
//     no close path) — a mint once observed absent stays absent until this wallet creates the
//     account (which flips it to 'balance', also a fact).
//   - 'balance' (ANY amount, including '0') proves the ATA existed at poll time — same
//     only-owner-can-close stickiness applies.
//   - 'error' / 'unavailable' are NOT facts (an RPC failure observes nothing) and are never
//     stored.
//
// This module is a PURE AsyncStorage wrapper (mirrors services/ckerc20Persist.ts style):
// best-effort, never throws at the caller, `dpay.*` namespace with a `.v1` schema suffix, and a
// pure hydrate function so the shape check is unit-testable without React.

const KEY = 'dpay.sol.tokenState.v1';

/** One persisted per-mint fact. `status` is the FACT kind only — degraded poll results
 *  ('error'/'unavailable'/'loading') are never persisted, so they cannot appear here. */
export type SolTokenStateFact = {
  status: 'absent' | 'balance';
  amount: string | null;
  decimals: number | null;
  at: number;
};

export type SolTokenStateStore = Record<string, SolTokenStateFact>;

// Module-level cache: the store is read once per process (loadSolTokenState memoizes), and every
// record merges into the cache before the (occasional) AsyncStorage write — so per-poll reads
// never touch storage, and a write only happens when a NEW or CHANGED fact lands (the balance
// poll fires every 2.5s; an unchanged fact must not be a write).
let _cache: SolTokenStateStore | null = null;
let _loadP: Promise<SolTokenStateStore> | null = null;

/**
 * Pure shape validator: `JSON.parse` output → a well-formed store, or null. A malformed mint
 * entry is dropped (not fatal); a non-object is null. Extracted pure so tests cover the guard
 * without a React tree, mirroring `hydrateWatch`.
 */
export function hydrateStore(v: unknown): SolTokenStateStore | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: SolTokenStateStore = {};
  const s = v as Record<string, unknown>;
  for (const mint of Object.keys(s)) {
    if (typeof mint !== 'string' || mint.length === 0) continue;
    const f = s[mint] as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') continue;
    if (f.status !== 'absent' && f.status !== 'balance') continue;
    if (f.amount !== null && typeof f.amount !== 'string') continue;
    if (f.decimals !== null && typeof f.decimals !== 'number') continue;
    if (typeof f.at !== 'number' || !Number.isFinite(f.at)) continue;
    out[mint] = {status: f.status, amount: f.amount as string | null, decimals: f.decimals as number | null, at: f.at};
  }
  return out;
}

/**
 * Load the persisted store (memoized after the first call — the cache then serves every later
 * read). Returns {} when nothing valid is stored. NEVER throws — a storage glitch reads as
 * "no facts" so the caller degrades to today's live-poll-only behavior.
 */
export function loadSolTokenState(): Promise<SolTokenStateStore> {
  if (_cache) return Promise.resolve(_cache);
  if (_loadP) return _loadP;
  _loadP = (async () => {
    let raw: string | null = null;
    try {
      raw = await AsyncStorage.getItem(KEY);
    } catch (e) {
      console.warn('sol tokenState persist failed:', e instanceof Error ? e.message : String(e));
      return {};
    }
    if (raw == null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('sol tokenState persist failed:', e instanceof Error ? e.message : String(e));
      return {}; // malformed JSON — swallow, never throw
    }
    const store = hydrateStore(parsed) ?? {};
    _cache = store;
    return store;
  })();
  return _loadP;
}

/**
 * Record one confirmed per-mint fact ('absent' | 'balance' only — the hook never calls this with
 * a degraded result). Merges into the cached store and writes storage ONLY when the fact is new
 * or changed (status/amount/decimals; `at` refreshes with the write). Best-effort: a thrown
 * AsyncStorage error swallows — a missed persist just means a later restart re-learns the fact
 * from the next successful poll.
 */
export async function recordSolTokenFact(mint: string, fact: SolTokenStateFact): Promise<void> {
  if (typeof mint !== 'string' || mint.length === 0) return;
  const store = await loadSolTokenState();
  const prev = store[mint];
  if (
    prev &&
    prev.status === fact.status &&
    prev.amount === fact.amount &&
    prev.decimals === fact.decimals
  ) {
    return; // unchanged fact — no write
  }
  const next = {...store, [mint]: fact};
  _cache = next;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('sol tokenState persist failed:', e instanceof Error ? e.message : String(e));
    /* best-effort — the in-memory cache still serves this session */
  }
}

/** Test/reset hook: drop the in-process cache so a fresh `loadSolTokenState` re-reads storage. */
export function resetSolTokenStateCache(): void {
  _cache = null;
  _loadP = null;
}
