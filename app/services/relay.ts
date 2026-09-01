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
// polls. NOTE: the timer covers the fetch (headers) settle; the caller's subsequent body read
// (`r.json()`) happens after the timer is cleared — bodies are tiny JSON across every call site, so
// this is equivalent in practice to the inline pattern.
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS): Promise<Response> {
  const {signal, cancel} = composeTimeout(init?.signal, timeoutMs);
  try {
    return await fetch(url, {...init, signal});
  } finally {
    cancel();
  }
}

// PR26 — read a fetch Response's body as JSON, returning `{}` on any parse failure (a malformed
// body, an empty 5xx, a non-JSON body) instead of throwing. Relay bodies are best-effort: callers
// want `body.error` / payload fields if present and `{}` otherwise, never a throw that masks the
// real HTTP outcome.
export async function readJsonOrEmpty(r: Response): Promise<any> {
  return r.json().catch(() => {
    console.warn('readJsonOrEmpty: body parse failed');
    return {} as Record<string, unknown>;
  });
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

