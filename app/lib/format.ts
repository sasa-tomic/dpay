// Formats an integer cent amount as the DEMO currency's amount string. The DEMO currency (currency
// 0) uses the '∂' prefix (partial-differential sign, chosen as a D-like glyph distinct from BTC's ₿);
// '$' is reserved for USDC. Despite the historical name `usd`, this formats DEMO amounts only; other
// currencies render via fmtAsset in their family unit.
//
// MC1 units 2-4: `c` is a raw-u64 decimal STRING (2-decimal DEMO cents), formatted via exact BigInt
// math PADDED to 2 fractional places (the currency-style fixed-width display the wallet asserts —
// `∂25.00`, never `∂25`). Never `Math.floor`/`parseFloat` (lossy above 2^53). The DEMO display stays
// fixed-width, so this is a separate UI concern (per amount.ts's module doc).
import {parseDecimalToUnits} from './amount';
export const usd = (c: string) => {
  const n = BigInt(c);
  return `∂${(n / 100n).toString()}.${(n % 100n).toString().padStart(2, '0')}`;
};
export const short = (h: string) => `${h.slice(0, 8)}…`;
// The MINT_ACCOUNT sentinel — 32 bytes of 0xFF, hex-encoded as 64 `f`s. The canister records faucet
// mints and withdrawals with this as the counterparty; we detect it and render a friendly label
// instead of leaking raw protocol data ("from ffffffff…") to end users (N4).
export const MINT_HEX = 'ff'.repeat(32);
export const isMintSentinel = (h: string) => h.toLowerCase() === MINT_HEX;
// Format a unix-seconds timestamp as a locale-friendly, relative-day label: "Today, 1:19 PM" /
// "Yesterday, 1:19 PM" / "Aug 4" / "Aug 4, 2025" (older rows). The durable history rows are sourced
// from the ledger (which settle on `ic time / 1e9`). The bare "13:19 GMT+2" form was a developer
// affordance (audit P2): most consumer wallets render locale-relative time, and a raw GMT offset
// means nothing to a non-technical user. No Intl API (trimmed on some RN builds) — the formatter
// uses Date math only (same-day / yesterday / same-year / older), so it is Hermes-safe.
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _isSameCalendarDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const fmtTime = (ts: number) => {
  // Non-finite guard: a row with a missing/garbage timestamp (or a unit regression — ICRC-3
  // nanoseconds instead of seconds) must render a stable placeholder, not leak
  // "undefined NaN, NaN" into the history list (2026-08-21 field bug).
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const hh12 = ((d.getHours() + 11) % 12) + 1; // 1..12
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() < 12 ? 'AM' : 'PM';
  const timeStr = `${hh12}:${mm} ${ampm}`;
  if (_isSameCalendarDay(d, now)) return `Today, ${timeStr}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (_isSameCalendarDay(d, yesterday)) return `Yesterday, ${timeStr}`;
  if (d.getFullYear() === now.getFullYear()) return `${_MONTHS[d.getMonth()]} ${d.getDate()}, ${timeStr}`;
  return `${_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
};
export const nowSecs = () => Math.floor(Date.now() / 1000);
// 128-bit payment nonce as lowercase hex. Uses the cryptographic RNG (`crypto.getRandomValues`,
// polyfilled by `react-native-get-random-values` on native, native on web/Node) — NOT `Math.random`,
// which is xorshift128+ on some engines and unsuitable for an idempotency key.
export function randNonceHex(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
// Decode a hex string to bytes. Tolerates a leading `0x` and mixed case; THROWS on an odd-length
// string (a malformed input is a programming error — debuggable, never a silent wrong-bytes result).
// Canonical single source shared by the receipt-claim builder (payments.ts) and the Solana key
// derivation (solana.ts / solana/identity.ts), where a malformed seed MUST crash loudly rather than
// silently derive a wrong key.
export function hexToBytes(hex: string): Uint8Array {
  const h = (hex || '').toLowerCase().replace(/^0x/, '');
  if (h.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}
// Encode bytes as canonical lowercase hex — the inverse of hexToBytes and the app-wide single
// source (services/icp.ts + services/rail.ts previously carried private copies).
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
export const base = (u: string) => u.replace(/\/$/, '');

// Validate a 64-hex recovery seed (the value Backup reveals). Returns null when valid, else a
// one-line error message. Trims + lowercases first so a pasted seed with stray whitespace or mixed
// case is accepted (the canonical form is lowercase, which keypairFromSecret expects). Shared by
// the Onboarding restore form + the Settings restore form — single source of truth for the rule
// "the seed is 64 chars from [0-9a-f]".
export function validateSeed(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) return 'Recovery seed must be 64 hex characters (0-9, a-f).';
  return null;
}

// Request QR = plain base64url of the 132-byte PaymentRequest (the payee's `to_name` + `memo` ride
// INSIDE the bytes now — wire-format v2; the old `<b64>|<name>` suffix is GONE). Returns the trimmed
// base64url string the app hands to DpayCore.decodeRequest. Defensively strips a stray `|…` suffix
// (a stale QR) so decodeRequest never sees it — but no name is carried there anymore.
export function parseRequestQR(raw: string): string {
  const t = raw.trim();
  const i = t.indexOf('|');
  return i < 0 ? t : t.slice(0, i);
}

// Format raw smallest-units (a decimal-digit STRING) as a decimal amount + unit suffix (e.g.
// "50000" sats → "0.00050000 BTC"). MC1 units 2-4: exact BigInt math PADDED to `decimals` places
// (the fixed-width display the wallet asserts — "0.00050000 BTC", never "0.0005 BTC"). This formatter
// keeps the asset's full precision (a UI concern separate from the parser, per amount.ts's module
// doc). Never `Math.floor`/`parseFloat` (lossy above 2^53).
export function fmtAsset(raw: string, decimals: number, unit: string, displayDecimals?: number): string {
  const n = BigInt(raw);
  if (n === 0n) return `0 ${unit}`; // a zero balance needs no precision padding ("0 BTC", not "0.00000000 BTC")
  const dd = displayDecimals != null && displayDecimals >= 0 && displayDecimals <= decimals ? displayDecimals : decimals;
  let scale = 1n;
  for (let i = 0; i < decimals; i++) scale *= 10n;
  const wholePart = n / scale;
  const fracPart = n % scale;
  if (dd === 0) return `${wholePart.toString()} ${unit}`;
  const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, dd).padEnd(dd, '0');
  return `${wholePart.toString()}.${fracStr} ${unit}`;
}
// Parse a user-entered amount (decimal string) into integer smallest-units at the given decimal
// count, as a decimal-digit STRING. Drives the merchant's currency-aware request encoder (ReceiveMode
// encodes the runtime currency id's raw units: 2 for DEMO, 8 for ckBTC, 6 for ckUSDC) and the
// withdrawal amount entry (WithdrawSheet/SolanaWithdrawSheet). MC1 units 2-4: delegates to the exact
// BigInt parser — a rejection → '0'; the caller gates on a non-zero result.
export function toUnits(s: string, decimals: number): string {
  const r = parseDecimalToUnits(s, decimals);
  return r.ok && r.raw !== '0' ? r.raw : '0';
}
