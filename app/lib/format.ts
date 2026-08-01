// Formats an integer cent amount as the DEMO currency's amount string. The DEMO currency (currency
// 0) uses the 'Đ' prefix (D-with-stroke); '$' is reserved for USDC. Despite the historical name
// `usd`, this formats DEMO amounts only; other currencies render via fmtAsset in their family unit.
export const usd = (c: number) => `Đ${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
export const short = (h: string) => `${h.slice(0, 8)}…`;
// The MINT_ACCOUNT sentinel — 32 bytes of 0xFF, hex-encoded as 64 `f`s. The canister records faucet
// mints and withdrawals with this as the counterparty; we detect it and render a friendly label
// instead of leaking raw protocol data ("from ffffffff…") to end users (N4).
export const MINT_HEX = 'ff'.repeat(32);
export const isMintSentinel = (h: string) => h.toLowerCase() === MINT_HEX;
// Format a unix-seconds timestamp as HH:MM (24h, local) — the durable history rows are sourced from
// the ledger (which settle on `ic time / 1e9`).
export const fmtTime = (ts: number) => { const d = new Date(ts * 1000); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const nowSecs = () => Math.floor(Date.now() / 1000);
export function randNonceHex(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
}
export function toCents(s: string): number { const n = Math.round(parseFloat(s || '0') * 100); return Number.isFinite(n) && n > 0 ? n : 0; }
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

// Format raw smallest-units as a decimal amount + unit suffix (e.g. sats → "0.00012345 BTC").
// Generalizes the old btc() so any family's amounts render from its config — no per-asset literals.
export function fmtAsset(raw: number, decimals: number, unit: string): string {
  const n = Math.max(0, Math.floor(raw));
  const div = 10 ** decimals;
  return `${Math.floor(n / div)}.${String(n % div).padStart(decimals, '0')} ${unit}`;
}
// Parse a user-entered BTC amount (decimal string) into integer satoshis. Mirrors `toCents` for `$`.
// NaN/negative → 0; the sheet gates the review on > 0 + >= the min withdrawal floor.
export function toSats(s: string): number { const n = Math.round(parseFloat(s || '0') * 1e8); return Number.isFinite(n) && n > 0 ? n : 0; }
// Parse a user-entered amount (decimal string) into integer smallest-units at the given decimal
// count. Generalizes `toCents` (decimals=2) + `toSats` (decimals=8) to arbitrary assets. Drives the
// merchant's currency-aware request encoder (ReceiveMode encodes the runtime currency id's raw
// units: 2 for DEMO, 8 for ckBTC, 6 for ckUSDC). NaN/negative → 0; the caller gates on > 0.
export function toUnits(s: string, decimals: number): number { const n = Math.round(parseFloat(s || '0') * 10 ** decimals); return Number.isFinite(n) && n > 0 ? n : 0; }
