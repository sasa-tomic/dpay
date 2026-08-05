// Formats an integer cent amount as the DEMO currency's amount string. The DEMO currency (currency
// 0) uses the '∂' prefix (partial-differential sign, chosen as a D-like glyph distinct from BTC's ₿);
// '$' is reserved for USDC. Despite the historical name `usd`, this formats DEMO amounts only; other
// currencies render via fmtAsset in their family unit.
//
// MC1 units 2-4: `c` is a raw-u64 decimal STRING (2-decimal DEMO cents), formatted via exact BigInt
// math PADDED to 2 fractional places (the currency-style fixed-width display the wallet asserts —
// `∂25.00`, never `∂25`). Never `Math.floor`/`parseFloat` (lossy above 2^53). The zero-trimming
// primitive `formatUnitsToDecimal` is the parser's *inverse* (used for readable BTC like "8.4"); the
// DEMO display stays fixed-width, so this is a separate UI concern (per amount.ts's module doc).
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
  const d = new Date(ts * 1000);
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
// Parse a user-entered DEMO amount (decimal string) into raw cents as a decimal-digit STRING. MC1
// units 2-4: delegates to the exact BigInt parser (`parseDecimalToUnits`) — never `parseFloat`
// (lossy above 2^53). Returns '0' on a rejection (empty/non-numeric/negative/overflow); the caller
// gates the review on a non-zero result.
export function toCents(s: string): string {
  const r = parseDecimalToUnits(s, 2);
  return r.ok && r.raw !== '0' ? r.raw : '0';
}
export const base = (u: string) => u.replace(/\/$/, '');

// Request QR = plain base64url of the 132-byte PaymentRequest (the payee's `to_name` + `memo` ride
// INSIDE the bytes now — wire-format v2; the old `<b64>|<name>` suffix is GONE). Returns the trimmed
// base64url string the app hands to DpayCore.decodeRequest. Defensively strips a stray `|…` suffix
// (a stale QR) so decodeRequest never sees it — but no name is carried there anymore.
export function parseRequestQR(raw: string): string {
  const t = raw.trim();
  const i = t.indexOf('|');
  return i < 0 ? t : t.slice(0, i);
}

// Display name + memo codec — mirrors `dpay_core::pad_name` + the canister's lossy NUL-trim. Fixed
// 32-byte fields: UTF-8, trailing-NUL padded, truncated to 32 bytes; empty = all zeros. These are
// the hex-string variants (the byte-array equivalents live in the DpayCore shim + e2e harness; the
// app itself passes plain name STRINGS to DpayCore, which packs the bytes). Used by the jest tests
// + available wherever hex name/memo fields appear. Decode is lossy + NUL-trimmed, never throws.
const NAME_LEN = 32;
export function padName32(s: string): string {
  let utf8 = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) utf8 += String.fromCharCode(c);
    else if (c < 0x800) { utf8 += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else { utf8 += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  const bytes: number[] = [];
  for (let i = 0; i < utf8.length && bytes.length < NAME_LEN; i++) bytes.push(utf8.charCodeAt(i) & 0xff);
  while (bytes.length < NAME_LEN) bytes.push(0);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function trimName32(hexStr: string): string {
  const clean = hexStr.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i + 1 < clean.length && bytes.length < NAME_LEN; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  let out = '';
  for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(out)); } catch { return out; }
}

// Format raw smallest-units (a decimal-digit STRING) as a decimal amount + unit suffix (e.g.
// "50000" sats → "0.00050000 BTC"). MC1 units 2-4: exact BigInt math PADDED to `decimals` places
// (the fixed-width display the wallet asserts — "0.00050000 BTC", never "0.0005 BTC"). The
// zero-trimming primitive `formatUnitsToDecimal` is the parser's inverse (readable high-precision
// display); this formatter keeps the asset's full precision, so it is a separate UI concern (per
// amount.ts's module doc). Never `Math.floor`/`parseFloat` (lossy above 2^53).
export function fmtAsset(raw: string, decimals: number, unit: string): string {
  const n = BigInt(raw);
  if (n === 0n) return `0 ${unit}`; // a zero balance needs no precision padding ("0 BTC", not "0.00000000 BTC")
  // `pow10` (multiplication loop) instead of `10n ** BigInt(d)` — see amount.ts; Babel's
  // exponentiation-operator transform rewrites `**` to `Math.pow` which throws on BigInt operands.
  let scale = 1n;
  for (let i = 0; i < decimals; i++) scale *= 10n;
  return `${(n / scale).toString()}.${(n % scale).toString().padStart(decimals, '0')} ${unit}`;
}
// Parse a user-entered BTC amount (decimal string) into integer satoshis as a decimal-digit STRING.
// Mirrors `toCents` for `$`. MC1 units 2-4: delegates to the exact BigInt parser — NaN/negative →
// '0'; the sheet gates the review on a non-zero + >= the min withdrawal floor via `cmpRaw`.
export function toSats(s: string): string {
  const r = parseDecimalToUnits(s, 8);
  return r.ok && r.raw !== '0' ? r.raw : '0';
}
// Parse a user-entered amount (decimal string) into integer smallest-units at the given decimal
// count, as a decimal-digit STRING. Generalizes `toCents` (decimals=2) + `toSats` (decimals=8) to
// arbitrary assets. Drives the merchant's currency-aware request encoder (ReceiveMode encodes the
// runtime currency id's raw units: 2 for DEMO, 8 for ckBTC, 6 for ckUSDC). MC1 units 2-4: delegates
// to the exact BigInt parser — a rejection → '0'; the caller gates on a non-zero result.
export function toUnits(s: string, decimals: number): string {
  const r = parseDecimalToUnits(s, decimals);
  return r.ok && r.raw !== '0' ? r.raw : '0';
}
