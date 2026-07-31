export const usd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
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
// request QR = "<base64url request>|<username>"; base64url has no '|', so split on the first one.
export function parseRequestQR(raw: string): {reqB64: string; name: string} {
  const t = raw.trim(); const i = t.indexOf('|');
  return i < 0 ? {reqB64: t, name: ''} : {reqB64: t.slice(0, i), name: t.slice(i + 1)};
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
