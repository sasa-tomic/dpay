// Formats an integer cent amount as the DEMO currency's amount string. The DEMO currency (currency
// 0) uses the ∂ prefix (partial-differential sign, chosen as a D-like glyph distinct from BTC's
// ₿); '$' is reserved for USDC. NOTE (2026-08-23): ∂ (U+2202) is NOT in Space Grotesk / IBM Plex
// Mono — it renders from the system font (that is FINE at text sizes; the founder prefers ∂; a
// 2026-08-23 Đ experiment was reverted). If ∂ ever renders as tofu on a device, bundle a glyph.
// Despite the historical name `usd`, this formats DEMO amounts only; other currencies render via
// fmtAsset in their family unit.
//
// MC1 units 2-4: `c` is a raw-u64 decimal STRING (2-decimal DEMO cents), formatted via exact BigInt
// math PADDED to 2 fractional places (the currency-style fixed-width display the wallet asserts —
// `∂25.00`, never `∂25`). Never `Math.floor`/`parseFloat` (lossy above 2^53). The DEMO display stays
// fixed-width, so this is a separate UI concern (per amount.ts's module doc).
import {parseDecimalToUnits, type AmountResult} from './amount';
import {M} from '../i18n';
import {
  canonicalizeDecimal, decimalSep, formatClock, formatMonthDay, formatMonthDayYear, groupDigits,
  placeCurrency,
} from '../i18n/intl';
export const usd = (c: string) => {
  const n = BigInt(c);
  const whole = groupDigits((n / 100n).toString());
  const frac = (n % 100n).toString().padStart(2, '0');
  return placeCurrency('∂', `${whole}${decimalSep()}${frac}`);
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
// means nothing to a non-technical user.
//
// The clock, the month name and the day/month ORDER all come from `Intl` (see i18n/intl.ts). The
// previous hand-rolled version pinned a 12-hour clock, English AM/PM, English month abbreviations
// and US month-before-day order, on the stated grounds that `Intl` is "trimmed on some RN builds".
// That belief was tested and is false for this app: the device gate (`DPAY_INTL_SELFCHECK`) proves
// Hermes ships real per-locale ICU data, and it printed a German device tag doing it. What IS
// absent from Hermes is `Intl.PluralRules`/`Intl.Locale`/`Intl.RelativeTimeFormat` — none of which
// are used here.
//
// The `, ` between date and time is punctuation that reads correctly in all four shipping locales.
// A locale that joins them differently (Japanese wants no comma) would need a catalog key; the
// relative-day words already have one because "Today" moves position, which a joiner does not.
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
  const timeStr = formatClock(d);
  if (_isSameCalendarDay(d, now)) return M.time.today(timeStr);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (_isSameCalendarDay(d, yesterday)) return M.time.yesterday(timeStr);
  if (d.getFullYear() === now.getFullYear()) return `${formatMonthDay(d)}, ${timeStr}`;
  return formatMonthDayYear(d);
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
  if (!/^[0-9a-f]{64}$/.test(t)) return M.errors.seedFormat;
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
  // The ticker rides as a suffix in every locale — "0.0005 BTC" is how crypto is written
  // everywhere, and it is a unit, not a currency symbol whose side the locale gets to choose.
  // Only the separators inside the number are the locale's business.
  const whole = groupDigits(wholePart.toString());
  if (dd === 0) return `${whole} ${unit}`;
  const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, dd).padEnd(dd, '0');
  return `${whole}${decimalSep()}${fracStr} ${unit}`;
}
// The COMPACT sibling of `fmtAsset` — the DEFAULT for every glanceable money surface (reviews, paid
// screens, Balances rows, the wallet header, Ledger history, receipts, fees, the NFC disclosure —
// founder rule 2026-09-13: everywhere the user just READS money shows the best-effort rounded
// amount). `fmtAsset` stays the EXACT formatter for the one thing that still needs its padded,
// full-precision string: a value that must round-trip through the amount parser (an input fill,
// e.g. SendSheet's Max). Two display contracts, one BigInt core.
//
// Three rules, in order of importance:
//   1. Trim trailing zeros down to `minFractionDigits` (the asset's `min_fraction_digits`, 0 when
//      unset). Lossless — it removes noise, never information: "1.50000000 VCHF" → "1.50 VCHF",
//      "1.500000000 SOL" → "1.5 SOL", "0.00050000 BTC" → "0.0005 BTC". A full-precision value is
//      left whole ("0.12345678 BTC"), because those digits are the user's money.
//   2. Truncate toward zero at `displayDecimals`, NEVER round — the wallet must not print a bigger
//      number than the user holds. Only ckETH (display 6 of 18 decimals) actually hits this today.
//   3. Say so when the cap hides value. Truncation that drops a nonzero digit is marked "≈"; a
//      holding smaller than the display resolution reads "< 0.000001 ETH". Before this, 500 Wei
//      rendered a flat "0.000000 ETH" — a nonzero balance shown as nothing.
//
// `sign` ('−'/'+', Ledger rows) is applied BY the formatter, not concatenated by the caller: the
// marker has to sit outside the signed number ("≈ −0.039922 ETH"), and a caller prepending its own
// sign would produce "−≈ 0.039922 ETH". The threshold form takes no sign at all — there is no
// number to sign, and "< −0.000001" bounds a negative instead of a magnitude, so direction stays
// with the Ledger row's arrow and colour.
export function fmtAssetCompact(
  raw: string, decimals: number, unit: string, displayDecimals?: number, minFractionDigits = 0,
  sign = '',
): string {
  const n = BigInt(raw);
  const dd = displayDecimals != null && displayDecimals >= 0 && displayDecimals <= decimals ? displayDecimals : decimals;
  const min = Math.max(0, Math.min(minFractionDigits, dd));
  let scale = 1n;
  for (let i = 0; i < decimals; i++) scale *= 10n;
  const whole = groupDigits((n / scale).toString());
  const fracAll = (n % scale).toString().padStart(decimals, '0');
  const kept = fracAll.slice(0, dd);
  // Below the display resolution: name the threshold rather than render a zero the user would read
  // as "empty". `n !== 0n` keeps a REAL zero on the normal path ("0 BTC" / "0.00 VCHF").
  if (n !== 0n && whole === '0' && !/[1-9]/.test(kept)) {
    const threshold = dd === 0 ? '1' : `0${decimalSep()}${'0'.repeat(dd - 1)}1`;
    return `< ${threshold} ${unit}`;
  }
  // Trailing-zero trim (rule 1). It only ever removes '0's, so it can never trigger rule 3.
  let frac = kept;
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  const num = frac.length === 0 ? whole : `${whole}${decimalSep()}${frac}`;
  // The ticker rides as a suffix in every locale, exactly as in `fmtAsset`.
  return `${/[1-9]/.test(fracAll.slice(dd)) ? '≈ ' : ''}${sign}${num} ${unit}`;
}

// Parse a user-entered amount (decimal string) into integer smallest-units at the given decimal
// count, as a decimal-digit STRING. Drives the merchant's currency-aware request encoder (ReceiveMode
// encodes the runtime currency id's raw units: 2 for DEMO, 8 for ckBTC, 6 for ckUSDC) and the
// withdrawal amount entry (WithdrawSheet/SolanaWithdrawSheet). MC1 units 2-4: delegates to the exact
// BigInt parser — a rejection → '0'; the caller gates on a non-zero result.
export function toUnits(s: string, decimals: number): string {
  const r = parseUserAmount(s, decimals);
  return r.ok && r.raw !== '0' ? r.raw : '0';
}

// The exact inverse of `toUnits` for link building: raw smallest-units → the shortest plain
// decimal string that re-parses to the same units ("2500000" @6dp → "2.5"). No grouping
// separators, no unit, no locale decimal comma — a payment link's `amount=` is a canonical
// machine decimal (the receiving side feeds it straight back into the amount parser).
export function rawToDecimal(raw: string, decimals: number): string {
  const n = BigInt(raw);
  if (n === 0n) return '0';
  let scale = 1n;
  for (let i = 0; i < decimals; i++) scale *= 10n;
  const whole = (n / scale).toString();
  const frac = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

/**
 * The ONE place a human-typed amount meets the parser: canonicalise what the keyboard produced,
 * then hand it to the exact BigInt parser. Every amount field routes through here (directly, or
 * via `toUnits` when the caller only wants the raw units), so the comma-decimal keyboards can
 * never again be handled in one field and forgotten in another.
 *
 * `parseDecimalToUnits` itself stays untouched on purpose — it is byte-pinned against
 * `dpay_core::parse_decimal_to_units` by the cross-validation flow, and its contract is a
 * CANONICAL decimal string. Locale input handling belongs at the UI boundary, not inside a
 * parity-checked parser.
 */
export function parseUserAmount(s: string, decimals: number): AmountResult {
  return parseDecimalToUnits(canonicalizeDecimal(s), decimals);
}
