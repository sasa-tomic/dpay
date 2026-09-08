import {base} from '../lib/format';
import {composeTimeout} from '../lib/timeout';
// --- ck-deposit (ckBTC-style top-up) response shapes -----------------------------------------
// MC1 units 2-4: protocol u64 amounts cross the JSON boundary as decimal-digit STRINGS.
export type DepositInfo = {min_confirmations: number; deposit_fee: string; deposit_min_amount: string | null};

// Safety-net default for every relay fetch — bounds a caller that omits its own signal so a hung
// relay can't produce an infinite spinner. Callers that pass their own (typically shorter-timeout)
// signal still abort at THEIR timeout: the two aborts race and the first wins (the caller's signal
// is forwarded into the internal controller via an `abort` listener). Composed manually with
// AbortController + setTimeout instead of AbortSignal.any/AbortSignal.timeout — those are ES2024 /
// ES2022 statics not present in this project's TS `lib` (which tops out at es2022) and not guaranteed
// on every RN/Hermes runtime the app targets, so the manual compose is the portable choice.
const DEFAULT_RELAY_TIMEOUT_MS = 10000;

// `fetch` + a caller-configurable timeout — the single source of truth for the inline
// `AbortController + setTimeout + fetch + clearTimeout` incantation previously duplicated across
// Wallet.tsx + the component sheets + catalog.ts. Composes an optional caller signal (first abort
// wins) and CLEARS the timer in `finally` so no lingering no-op abort fires after the fetch settles
// (matches the inline pattern's semantics byte-for-byte). `{...init, signal}` overrides any caller
// `init.signal` with the composed one (fetch rejects a double assignment; the caller's signal is
// already forwarded into the composed controller). Default timeout is the 10s relay backstop;
// callers pass a shorter named timeout (BALANCE_TIMEOUT_MS / FAUCET_TIMEOUT_MS etc.) to bound fast
// polls. NOTE: this timer covers the fetch (HEADERS) settle only — the abort signal is released
// once the Response object exists. The BODY read that follows is bounded separately, by
// [`readBodyWithin`] below, because a server that answers `200 OK` and then stops writing would
// otherwise hold the caller forever — exactly what this helper exists to prevent.
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS): Promise<Response> {
  const {signal, cancel} = composeTimeout(init?.signal, timeoutMs);
  try {
    return await fetch(url, {...init, signal});
  } finally {
    cancel();
  }
}

/** How long a body may take to finish arriving once its headers have. Every body this app reads is
 *  a few hundred bytes of JSON or CBOR, so this is a stall detector rather than a budget. */
export const BODY_READ_TIMEOUT_MS = 10000;

/**
 * Run a body read under its own bound and REJECT if it stalls — the second half of
 * `fetchWithTimeout`'s promise. It never substitutes a value; deciding what a missing body means is
 * the caller's job, and the caller is the only one that knows whether "no body" is survivable.
 * `what` is prefixed to the error so a stalled read names the URL and status it belonged to.
 */
export async function readBodyWithin<T>(read: () => Promise<T>, what: string, timeoutMs = BODY_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: the body did not finish arriving within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// PR26 — read a fetch Response's body as JSON, returning `{}` on any parse failure (a malformed
// body, an empty 5xx, a non-JSON body, a stalled read) instead of throwing. Relay bodies are
// best-effort: callers want `body.error` / payload fields if present and `{}` otherwise, never a
// throw that masks the real HTTP outcome. The line it leaves names the URL, the status and the
// cause — `'body parse failed'` on its own told a reader nothing about which of a dozen call sites
// had failed or why.
export async function readJsonOrEmpty(r: Response): Promise<any> {
  const where = `${r.url || 'the relay'} (HTTP ${r.status})`;
  try {
    return await readBodyWithin(() => r.json(), `readJsonOrEmpty: ${where}`);
  } catch (e) {
    console.warn(`readJsonOrEmpty: ${where} did not yield JSON — continuing with an empty body:`, e instanceof Error ? e.message : String(e));
    return {} as Record<string, unknown>;
  }
}

export type RelayCapabilities = {till: boolean; demoFaucet: boolean};

// What every caller starts from and what every failure path below falls back to: a relay that has
// told us nothing offers nothing. The ONE literal — a hand-written `{till: false, demoFaucet:
// false}` elsewhere is the same claim written twice.
export const NO_RELAY_CAPABILITIES: RelayCapabilities = {till: false, demoFaucet: false};

// Capability discovery is advisory and fail-closed. Older, unreachable, or malformed relays must
// never make the wallet advertise a cashier or demo-faucet action that can only end in an error.
// Failing closed QUIETLY is the bug: the wallet then hides the cashier and the top-up with nothing
// anywhere saying why, which is indistinguishable from a relay that really has neither. So every
// path out of here that isn't an answer leaves a line naming the URL asked and what came back.
export async function relayCapabilities(relayUrl: string): Promise<RelayCapabilities> {
  const url = `${base(relayUrl)}/api/v1/capabilities`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) {
      console.warn(`relayCapabilities: ${url} answered HTTP ${r.status} — assuming no till and no demo faucet`);
      return NO_RELAY_CAPABILITIES;
    }
    const j = await readJsonOrEmpty(r);
    if (typeof j?.till !== 'boolean' || typeof j?.demo_faucet !== 'boolean') {
      console.warn(`relayCapabilities: ${url} returned ${JSON.stringify(j)}, not the {till, demo_faucet} booleans — assuming no till and no demo faucet`);
      return NO_RELAY_CAPABILITIES;
    }
    return {till: j.till, demoFaucet: j.demo_faucet};
  } catch (e: unknown) {
    console.warn(`relayCapabilities: ${url} unreachable — assuming no till and no demo faucet:`, e instanceof Error ? e.message : String(e));
    return NO_RELAY_CAPABILITIES;
  }
}

// Relay deposit client — goes through `fetchWithTimeout` (AbortController optional, errors thrown
// to the caller) so an omitted-signal caller gets the backstop AND the backstop timer is cleared
// when the fetch settles. Composing the signal by hand here instead leaked the timer: the composed
// `cancel` was dropped on the floor, so every omitted-signal call left a live 10s timeout holding
// its AbortController closure until it fired a no-op abort.
export async function depositInfo(relayUrl: string, currency: number, signal?: AbortSignal): Promise<DepositInfo> {
  const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/deposit/info?currency=${currency}`, {signal});
  const j = await readJsonOrEmpty(r);
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `deposit/info ${r.status}`);
  return j as DepositInfo;
}
// ckERC-20 / native-ETH onramp params (helper contract, ERC-20 address) for a CkEthErc20-family
// currency. The app builds the user's Ethereum transaction(s) from these; the user signs in their
// own wallet (non-custodial). The deposit `principal` arg is the user's OWN IC principal (derived
// in-app via DpayCore.icpSelfPrincipal; ICRC-1 default subaccount) — the relay serves no principal.
// `kind` discriminates the deposit shape:
//  - "erc20": two txs (approve the ERC-20, then depositErc20); `erc20_address` is the token contract.
//  - "native_eth": ONE payable tx (depositEth) carrying the ETH `value`; `erc20_address` is null.
// Errors throw with the status (503 = no CkEthErc20 onramp for the currency / relay unreachable).
export type CkErc20OnrampParams = {helper_address: string; erc20_address: string | null; kind: 'erc20' | 'native_eth'};
export async function ckerc20OnrampParams(relayUrl: string, currency: number, signal?: AbortSignal): Promise<CkErc20OnrampParams> {
  const r = await fetchWithTimeout(`${base(relayUrl)}/api/v1/onramp/ckerc20?currency=${currency}`, {signal});
  const j = await readJsonOrEmpty(r);
  if (!r.ok) throw new Error(typeof j?.error === 'string' ? j.error : `onramp/ckerc20 ${r.status}`);
  return j as CkErc20OnrampParams;
}
