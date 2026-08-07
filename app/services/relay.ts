import {base} from '../lib/format';
import {composeTimeout} from '../lib/timeout';
import {classifyPayHttp, type SettleOutcome} from '../payments';

// --- ck-deposit (ckBTC-style top-up) response shapes -----------------------------------------
// MC1 units 2-4: protocol u64 amounts cross the JSON boundary as decimal-digit STRINGS.
export type DepositInfo = {min_confirmations: number; deposit_fee: string; deposit_min_amount: string | null};
export type MintedUtxo = {block_index: string; amount: string};
export type PendingUtxo = {value: string; confirmations: number};
export type DepositRefresh = {minted_total: string; minted: MintedUtxo[]; pending: PendingUtxo[]; required_confirmations: number};

// Safety-net default for every relay fetch — bounds a caller that omits its own signal so a hung
// relay can't produce an infinite spinner. Callers that pass their own (typically shorter-timeout)
// signal still abort at THEIR timeout: the two aborts race and the first wins (the caller's signal
// is forwarded into the internal controller via an `abort` listener). Composed manually with
// AbortController + setTimeout instead of AbortSignal.any/AbortSignal.timeout — those are ES2024 /
// ES2022 statics not present in this project's TS `lib` (which tops out at es2022) and not guaranteed
// on every RN/Hermes runtime the app targets, so the manual compose is the portable choice.
const DEFAULT_RELAY_TIMEOUT_MS = 10000;

/** Signal-only view of the shared `composeTimeout` with the relay default backstop (10s). When the
 *  caller passes a signal that signal is returned AS-IS (caller owns the deadline — see
 *  `lib/timeout.ts`); when the caller omits it the backstop arms. */
function withDefaultTimeout(callerSignal?: AbortSignal, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS): AbortSignal {
  return composeTimeout(callerSignal, timeoutMs).signal;
}

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
// body, an empty 5xx, a non-JSON 422) instead of throwing. The relay's /pay and /withdraw bodies
// are best-effort: callers want `body.receipt` / `body.error` if present and `{}` otherwise, never
// a throw that masks the real HTTP outcome. Replaces the inline `r.json().catch(() => ({} as any))`
// repeated across the pay/reconcile/withdraw paths.
export async function readJsonOrEmpty(r: Response): Promise<any> {
  return r.json().catch(() => {
    console.warn('readJsonOrEmpty: body parse failed');
    return {} as Record<string, unknown>;
  });
}

// PR25 — the shared `/pay` fetch+parse+classify helper. Three call sites (PayMode.approve,
// ReceiveMode.onSignedQr, NfcTap.postPay) each used to duplicate the same pattern: POST /pay with
// the caller's timeout-bound signal → parse the body JSON-or-empty → classifyPayHttp on the
// `{ok,status}` (or `null` if fetch threw). The helper keeps the existing error handling: a fetch
// throw (network/timeout/abort) returns outcome='unknown' + empty body — the caller still does its
// own isNonceReused / verifyOutcomeReceipt / reconciliation on the returned body.
export async function payAndClassify(relayUrl: string, code: string, signal?: AbortSignal): Promise<{outcome: SettleOutcome; body: any}> {
  try {
    const r = await fetch(`${base(relayUrl)}/api/v1/pay`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({qr: code}), signal: withDefaultTimeout(signal)});
    const body = await readJsonOrEmpty(r);
    return {outcome: classifyPayHttp({ok: r.ok, status: r.status}), body};
  } catch (e) {
    console.warn('payAndClassify fetch threw:', e);
    return {outcome: classifyPayHttp(null), body: {} as Record<string, unknown>};
  }
}

// Relay deposit client — same fetch style as the inline balance/faucet/pay calls (AbortController
// optional, errors thrown to the caller). Co-located here to match the existing pattern. The default
// timeout above is a backstop only — every existing caller passes its own shorter-timeout signal.
export async function depositInfo(relayUrl: string, currency: number, signal?: AbortSignal): Promise<DepositInfo> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/info?currency=${currency}`, {signal: withDefaultTimeout(signal)});
  if (!r.ok) throw new Error(`deposit/info ${r.status}`);
  return r.json();
}
export async function depositAddress(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/address/${accountHex}?currency=${currency}`, {signal: withDefaultTimeout(signal)});
  if (!r.ok) throw new Error(`deposit/address ${r.status}`);
  const j = await r.json();
  return j.address as string;
}
export async function depositRefresh(relayUrl: string, accountHex: string, currency: number, signal?: AbortSignal): Promise<DepositRefresh> {
  const r = await fetch(`${base(relayUrl)}/api/v1/deposit/refresh/${accountHex}?currency=${currency}`, {method: 'POST', signal: withDefaultTimeout(signal)});
  if (!r.ok) throw new Error(`deposit/refresh ${r.status}`);
  return r.json();
}

// ckERC-20 / native-ETH onramp params (helper contract, ERC-20 address, facade principal) for a
// CkEthErc20-family currency. The app builds the user's Ethereum transaction(s) from these; the user
// signs in their own wallet (non-custodial). `kind` discriminates the deposit shape:
//  - "erc20": two txs (approve the ERC-20, then depositErc20); `erc20_address` is the token contract.
//  - "native_eth": ONE payable tx (depositEth) carrying the ETH `value`; `erc20_address` is null.
// Errors throw with the status (503 = no CkEthErc20 onramp for the currency / relay unreachable).
export type CkErc20OnrampParams = {helper_address: string; erc20_address: string | null; facade_principal: string; kind: 'erc20' | 'native_eth'};
export async function ckerc20OnrampParams(relayUrl: string, currency: number, signal?: AbortSignal): Promise<CkErc20OnrampParams> {
  const r = await fetch(`${base(relayUrl)}/api/v1/onramp/ckerc20?currency=${currency}`, {signal: withDefaultTimeout(signal)});
  if (!r.ok) throw new Error(`onramp/ckerc20 ${r.status}`);
  return r.json();
}

// Withdraw a ckBTC balance to a native BTC address. The app signs the WithdrawAuth on-device (the
// sig is the non-custodial gate); the relay forwards to the facade's `withdraw`. Returns the burn
// receipt (block_index). Errors throw with the status so the sheet can surface a decline vs offline.
// MC1 units 2-4: amount/block_index cross the JSON boundary as decimal-digit STRINGS (raw u64).
export type WithdrawReceipt = {from: string; destination: string; amount: string; nonce: string; currency: number; block_index: string};

export async function withdrawFunds(relayUrl: string, accountHex: string, btcAddress: string, amountSats: string, nonceHex: string, expiry: number, currency: number, sigHex: string, signal?: AbortSignal): Promise<WithdrawReceipt> {
  const r = await fetch(`${base(relayUrl)}/api/v1/withdraw`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({from: accountHex, destination: btcAddress, amount: amountSats, nonce: nonceHex, expiry, currency, sig: sigHex}),
    signal: withDefaultTimeout(signal),
  });
  const j = await readJsonOrEmpty(r);
  if (r.ok && j?.receipt) {
    return j.receipt as WithdrawReceipt;
  }
  // A 422 carries a policy error (bad sig / expired / below min / insufficient / nonce reused); a
  // 503 is a transient ledger hiccup. Surface the body's error string so the sheet can show WHY.
  throw new Error(typeof j?.error === 'string' ? j.error : `withdraw ${r.status}`);
}
