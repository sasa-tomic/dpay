/**
 * R1 — the operator's ordered relay address list (spec 2026-09-09 §"Direction 2 — several relays").
 *
 * This is NOT a fallback: it is ONE relay client implementation reachable at more than one
 * address. The wallet tries the addresses IN ORDER (first = preferred); a transport failure or a
 * 5xx moves to the next address; a 4xx is an answer and never moves (the relay heard us and
 * refused — asking a replica would be asking a different question). The ordered-selection walk
 * itself lives in `services/relay.ts` (`relayFetch`); this module owns everything AROUND the walk:
 *
 *   • parsing/validation — one address per line in Settings, comma-separated in the `?relay=`
 *     deep-link override, both validated by the same rule (`parseRelayAddress`);
 *   • persistence — `dpay.relays.v1`, a JSON array, with the legacy single-URL `dpay.relay.v1`
 *     migrating to a one-entry list at load (an operator with one relay must see no behavior
 *     change, including across the upgrade);
 *   • the live module state the walk reads, plus a revision counter so the walk's per-session
 *     build caches (`services/relay.ts`) know the list changed under them.
 *
 * One entry remains a valid list. An empty or unreachable list never blocks the app: the IC rail
 * submits app-signed envelopes straight to the boundary nodes and the SOL rail talks to its own
 * RPC — only catalog/balances/history reads go quiet (the offline paths those hooks already have).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {RELAY_LIST_STORAGE_KEY, RELAY_STORAGE_KEY} from '../config/constants';
import {base} from '../lib/format';

/**
 * Validate + normalize ONE relay address. Accepted: a full http:// or https:// URL, any host,
 * optionally a path prefix; trailing slashes are stripped (the walk composes `${addr}${path}`),
 * and so are EMPTY trailing `?`/`#` markers — a dangling `?`/`#` does NOT normalize away in
 * `new URL()` (the parsed search/hash read empty, but the serialized output KEEPS the marker), so
 * they are stripped here; the remnant would otherwise ride along onto every request and 404 it
 * exactly like a substantive one. http stays accepted (not https-only like the Solana RPC row):
 * an operator's relay on a LAN is a first-class supported setup — Settings' own placeholder is
 * `http://<ip>:8787`. A SUBSTANTIVE query string, fragment, or userinfo component is REFUSED: the
 * walk composes `${addr}${path}`, so a query or fragment would ride along onto every request and
 * 404 it (and a 404 is an answer — the walk never fails over on it, so every call dies the same
 * quiet death), and userinfo would be persisted in plaintext and sent as basic auth on every
 * request. Returns the normalized address, or null (callers compose their own refusal text —
 * Settings names the line).
 */
export function parseRelayAddress(u: string): string | null {
  const trimmed = u.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  // The guards above pass a bare trailing `?`/`#` (parsed search/hash read empty), but the
  // serializer KEEPS the dangling marker — strip it before `base`'s trailing-slash strip, or the
  // accepted address composes `…/#/api/v1/…` and every request 404s.
  return base(parsed.toString().replace(/[?#]+$/, ''));
}

/**
 * The Settings editor's draft text: one address per line, first line = preferred. Whitespace-only
 * lines are skipped. Returns either the normalized list (possibly EMPTY — empty is a value, it
 * restores the addresses baked into the build, exactly like the Solana RPC row's empty draft) or
 * the first invalid line's refusal, naming the line number so the user can find it in their own
 * textarea.
 */
export function parseRelayListText(text: string): {urls: string[]} | {err: string} {
  const lines = text.split('\n');
  const urls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    const parsed = parseRelayAddress(raw);
    if (parsed == null) {
      return {err: `Line ${i + 1}: "${raw}" is not a full http:// or https:// server address. Paste one address per line, e.g. https://relay.example.com`};
    }
    urls.push(parsed);
  }
  return {urls};
}

/**
 * The `?relay=` deep-link override: a COMMA-separated list (the e2e harness passes it URL-encoded;
 * a comma survives encodeURIComponent as %2C and URLSearchParams decodes it back). Defines the
 * wire format documented in `relayConfig`/`e2e/web/relay-config.ts`: one address or several, in
 * priority order, exact list (not a merge). Entries are kept verbatim apart from trimming — the
 * harness controls this input, and today's single-address override is accepted verbatim (trailing
 * slash included), so the multi-address form must not start silently rewriting it either.
 */
export function splitRelayListParam(param: string): string[] {
  return param
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Live list state ──────────────────────────────────────────────────────────────────────────
// The walk (`relayFetch`) reads this per call. Empty (the pre-App-wiring default) means "no
// operator list" and the walk degrades to the caller's single address — which is what every jest
// suite that never wires App.tsx expects, and what the first frames of a real boot do before the
// mount effect lands.
let addresses: string[] = [];
// Bumped on every accepted `setRelayAddresses`. `relayFetch` compares it against the revision it
// cached its build fingerprints under; a change means the operator re-pointed the wallet, and the
// per-session fingerprint/drift caches must not outlive the list they were gathered for.
let revision = 0;

/**
 * Install the operator's ordered list. THROWS (English, actionable — the Settings row renders it
 * verbatim, same contract as `setSolanaRpcUrl`) on any invalid entry. Never stores a partial list.
 */
export function setRelayAddresses(urls: string[]): void {
  const parsed: string[] = [];
  for (const u of urls) {
    const a = parseRelayAddress(u);
    if (a == null) {
      throw new Error(`"${u}" is not a full http:// or https:// server address.`);
    }
    parsed.push(a);
  }
  addresses = parsed;
  revision++;
}

/** The live ordered list (read per call; never capture at module scope). */
export function relayAddresses(): readonly string[] {
  return addresses;
}

/** Monotonic counter of accepted `setRelayAddresses` calls (see above for who reads it). */
export function relayAddressesRevision(): number {
  return revision;
}

/** Re-point the list at ITSELF: bump the revision without changing a single address. The one
 *  caller is Settings' drift recovery — re-applying a CLEAN draft while build drift is latched
 *  must stale the walk's per-session fingerprint caches and the sticky drift (both keyed to the
 *  revision in `services/relay.ts`), so every replica is re-probed on the next call. This is the
 *  in-app action for "my replica was redeployed at the SAME URL" — the drift message's own advice
 *  — which otherwise has no gesture: the draft is clean, so nothing about the list changes. */
export function reprobeRelayAddresses(): void {
  revision++;
}

/** Test seam: back to the empty pre-wiring state. */
export function resetRelayAddressesForTest(): void {
  addresses = [];
  revision++;
}

// ── Persistence ──────────────────────────────────────────────────────────────────────────────
/**
 * The persisted list at boot: `dpay.relays.v1` (JSON array) if present and well-formed; else the
 * LEGACY `dpay.relay.v1` single string as a one-entry list (the migration — an upgrading operator
 * keeps their relay, nothing is lost, nothing writes the legacy key afterwards); else [] (the
 * caller falls back to the addresses baked into the build). A corrupt or partially-invalid store
 * is DISCARDED loudly rather than half-applied: a stored list that names unreachable junk must
 * fail as "no persisted choice" (→ baked default), never as "half the junk".
 */
export async function loadPersistedRelayAddresses(): Promise<string[]> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(RELAY_LIST_STORAGE_KEY);
  } catch (e: unknown) {
    console.log(`[dpay] failed to read the persisted relay list: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j)) {
        // An EMPTY array is the deliberate-empty case, not corruption: an operator who cleared the
        // Settings field chose "restore the addresses baked into the build", that choice was
        // persisted, and loading it must restore the default WITHOUT a warn — the same load is
        // silent for a null/absent key. Everything else that fails validation below is junk and
        // says so.
        if (j.length === 0) return [];
        if (j.every((u): u is string => typeof u === 'string')) {
          const parsed = j.map(parseRelayAddress);
          if (parsed.every((u): u is string => u != null)) return parsed;
        }
      }
      console.log(`[dpay] persisted relay list is not a valid address list — using the built-in default: ${raw}`);
    } catch (e: unknown) {
      console.log(`[dpay] persisted relay list is not JSON — using the built-in default: ${e instanceof Error ? e.message : String(e)}`);
    }
    return [];
  }
  // Legacy single-URL key (pre-R1): one entry, same validation.
  let legacy: string | null = null;
  try {
    legacy = await AsyncStorage.getItem(RELAY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (typeof legacy === 'string' && legacy.length > 0) {
    const parsed = parseRelayAddress(legacy);
    if (parsed != null) return [parsed];
    console.log(`[dpay] persisted relay URL is not a valid address — using the built-in default: ${legacy}`);
  }
  return [];
}

/** Persist the ordered list (JSON array). Best-effort: the caller logs a refusal. */
export function persistRelayAddresses(urls: string[]): Promise<void> {
  return AsyncStorage.setItem(RELAY_LIST_STORAGE_KEY, JSON.stringify(urls));
}
