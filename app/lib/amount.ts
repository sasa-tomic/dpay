// Exact decimal <-> raw-u64 amount parser — TS BigInt mirror of `dpay_core::parse_decimal_to_units`
// / `format_units_to_decimal`. MC1 unit 1.
//
// The canonical parser lives in the Rust core; this module is its parity-pinned I/O-boundary mirror
// for the JS side (the same role the `e2e/web/dpay-core.ts` ed25519 signing shim plays for sigs). It
// is NOT a mock — it IS the parser logic for JS, and the e2e cross-val (`e2e/tests/00-cross-val.mjs`)
// + the jest suite (`app/__tests__/amount.test.ts`) pin it byte-for-byte against the Rust core.
//
// WHY: protocol amounts are exact `u64` in every wire struct (`Authorization.amount`,
// `PaymentRequest.amount`, `WithdrawAuth.amount`, `ReceiptClaim.amount`). The OLD app path rounded
// them through JS `number` / Kotlin `Double` — lossy above 2^53 (e.g. `0.009007199254740993 * 1e18`
// ≠ 9007199254740993 via `Number`). This module retires that loss surface: raw u64 values are carried
// as DECIMAL-DIGIT STRINGS (never `number`), and ALL math uses JS `BigInt` (see `pow10` below).
// There is no `parseFloat` / `Number()` on a raw amount anywhere in this module.
//
// Acceptance/rejection policy mirrors the Rust parser EXACTLY (same precedence, same codes):
//   1. Surrounding whitespace is trimmed.
//   2. Empty (after trim) → `err: "empty"`.
//   3. A leading `-` → `err: "negative"` (regardless of what follows; checked before shape).
//   4. Must match `^(\d+\.?\d*|\.\d+)$` (a `.`-only / multi-dot input is `"not_a_number"`); a
//      leading `.` (`.5`) and trailing `.` (`5.`) ARE accepted (calculator-style); a leading `+` is NOT.
//   5. Fractional digits beyond `decimals` → `"too_many_decimals"`.
//   6. `decimals > MAX_DECIMALS`, or the scaled value > u64::MAX → `"overflow"`.

/** Maximum decimal precision (mirrors `dpay_core::MAX_DECIMALS`). A u64 holds ≤ 18 decimals. */
export const MAX_DECIMALS = 18;

/** u64::MAX as a BigInt, for the overflow bound. */
const U64_MAX: bigint = (1n << 64n) - 1n;

/**
 * 10^n as a BigInt. We use a multiply loop (not the `**` operator) because Babel's
 * `@babel/plugin-transform-exponentiation-operator` (pulled in by `@babel/preset-env` under the
 * RN 0.86 jest-preset) rewrites `a ** b` to `Math.pow(a, b)` for older-engine compatibility, and
 * `Math.pow` requires `number` operands — it throws `TypeError: Cannot convert a BigInt value to a
 * number` for BigInt operands. The runtime engines we ship (Hermes, modern V8) all support BigInt
 * `**` natively, but the transpiler can't see operand types, so we sidestep the operator entirely.
 * Mirrors `10n ** BigInt(n)` for `n in 0..=MAX_DECIMALS` exactly.
 */
function pow10(exp: number): bigint {
  let r = 1n;
  for (let i = 0; i < exp; i++) r *= 10n;
  return r;
}

/**
 * A typed parse result. `ok: true` carries the raw u64 as a decimal-digit STRING (never a `number` —
 * a raw > 2^53 would lose precision). `ok: false` carries a debuggable `err` code matching the Rust
 * `AmountError` variants (`empty`/`not_a_number`/`negative`/`too_many_decimals`/`overflow`).
 */
export type AmountResult =
  | { ok: true; raw: string }
  | { ok: false; err: string };

// `^(\d+\.?\d*|\.\d+)$` — accepts a leading-dot (`.5` → 0.5) and trailing-dot (`5.` → 5.0) so the
// amount input behaves like a calculator; requires at least one digit somewhere (a bare `.` is
// `not_a_number`). A leading `+` is NOT accepted.
const RE_NUMERIC = /^(\d+\.?\d*|\.\d+)$/;
// A valid raw input is a non-empty run of decimal digits (no sign, no dot, no exponent).
const RE_RAW_DIGITS = /^\d+$/;

/**
 * Parse a human decimal string into raw u64 units (returned as a decimal-digit string) at `decimals`
 * precision. Exact — uses `BigInt` throughout, never `number`/`parseFloat`. See the module doc for
 * the acceptance/rejection policy (mirrors `dpay_core::parse_decimal_to_units`).
 *
 * `decimals` must be an integer in `0..=MAX_DECIMALS` (18); a larger/non-integer value yields
 * `err: "overflow"` (the precision is unsupported in the u64 value space, matching the Rust bound).
 */
export function parseDecimalToUnits(human: string, decimals: number): AmountResult {
  if (typeof human !== 'string') {
    return { ok: false, err: 'not_a_number' };
  }
  const s = human.trim();
  if (s.length === 0) {
    return { ok: false, err: 'empty' };
  }
  // A leading `-` is always Negative, regardless of what follows (mirrors Rust: checked before shape).
  if (s.startsWith('-')) {
    return { ok: false, err: 'negative' };
  }
  if (!RE_NUMERIC.test(s)) {
    return { ok: false, err: 'not_a_number' };
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    return { ok: false, err: 'overflow' };
  }
  const d = decimals;
  const dot = s.indexOf('.');
  const wholeStr = dot < 0 ? s : s.slice(0, dot);
  const fracStr = dot < 0 ? '' : s.slice(dot + 1);
  if (fracStr.length > d) {
    return { ok: false, err: 'too_many_decimals' };
  }
  // BigInt math (exact). `pow10(d)` is well-defined for d ≤ 18 (mirrors Rust's u128 scale).
  const scale = pow10(d);
  const whole = wholeStr.length === 0 ? 0n : BigInt(wholeStr);
  let frac = 0n;
  if (fracStr.length > 0) {
    // Pad the fractional digits to `decimals` places (left-shift by the missing trailing zeros).
    frac = BigInt(fracStr) * pow10(d - fracStr.length);
  }
  const total = whole * scale + frac;
  if (total > U64_MAX) {
    return { ok: false, err: 'overflow' };
  }
  return { ok: true, raw: total.toString(10) };
}

/**
 * Compare two raw u64 amounts (decimal-digit strings) using `BigInt` — NEVER lexicographic string
 * compare (which would wrongly rank `"9" > "10"`). Returns -1 / 0 / 1. Throws `TypeError` on a
 * non-digit input (debuggable; both inputs must be valid raw-amount strings).
 */
export function cmpRaw(a: string, b: string): -1 | 0 | 1 {
  if (typeof a !== 'string' || !RE_RAW_DIGITS.test(a)) {
    throw new TypeError(`cmpRaw: a must be a decimal-digit string, got ${JSON.stringify(a)}`);
  }
  if (typeof b !== 'string' || !RE_RAW_DIGITS.test(b)) {
    throw new TypeError(`cmpRaw: b must be a decimal-digit string, got ${JSON.stringify(b)}`);
  }
  const ba = BigInt(a);
  const bb = BigInt(b);
  return ba < bb ? -1 : ba > bb ? 1 : 0;
}

/**
 * Apply the per-currency offline deduction to a polled balance (MC5 — currency-keyed). The map is
 * DERIVED (Wallet sums the pending-outbox records' gross per currency — see `pendingPays.ts`), so
 * the payer's displayed balance honestly reflects in-flight offline payments BEFORE the next online
 * poll reconciles. This helper is the pure display-side read of that derived map.
 *
 * - `balance == null` ⇒ `null` (an unknown balance stays unknown — never fabricate a number).
 * - `offlineMap[currency]` missing ⇒ `balance` unchanged (no deduction recorded for this asset).
 * - Otherwise subtracts the map entry from the balance using BigInt, **clamped at 0** by `cmpRaw`
 *   so a wayward refund that over-subtracts never renders a negative raw string.
 *
 * MC5 KEY INVARIANT: the map is KEYED BY CURRENCY — a currency-1 (ckBTC) offline spend MUST NOT
 * reduce the DEMO (currency-0) ∂ balance. The lookup is `offlineMap[currency]`, so cross-currency
 * isolation is structural. Mirrors the canister's per-currency ledger segregation (dpay never
 * swaps): each asset's display lives independently. Used by Wallet for both the DEMO header
 * (`currency=0`) and every per-asset card / balance gate (`currency=1..N`).
 *
 * `balance` MUST be a non-empty decimal-digit string when non-null; `offlineMap` values MUST be
 * decimal-digit strings (the reducer's BigInt arithmetic enforces this on the write side; this read
 * uses `cmpRaw` which `TypeError`s on bad input — debuggable, never silent NaN).
 */
export function applyOffline(
  balance: string | null,
  offlineMap: Record<number, string>,
  currency: number,
): string | null {
  if (balance == null) return null;
  const spent = offlineMap[currency];
  if (spent == null) return balance;
  // cmpRaw-guarded: never go below 0. The reducer clamps too, but a refund edge case can leave the
  // entry above the balance transiently — clamp here as well so the display is always whole.
  return cmpRaw(balance, spent) >= 0 ? (BigInt(balance) - BigInt(spent)).toString() : '0';
}

/** `nettedWireRaw`'s result: the wire the request should carry, or the one way it cannot have one. */
export type NettedWire =
  | {ok: true; wireRaw: string}
  | {ok: false; err: 'fee_covers_price'};

/**
 * The payee-quoted WIRE amount under the exact-price rule (founder rule 2026-09-12: if something
 * costs $1, the customer pays exactly $1 — the merchant pays the fees). The dpay checkout nets the
 * same way at quote time (`checkout_raw_units`, crates/dpay-relay/src/checkout.rs); this is the p2p
 * request's half of the same rule. A wire for the full typed price would arrive as price−fee (the
 * ledger takes its per-transfer fee out of what lands), silently re-billing the difference to the
 * payee — so the payee quotes the NETTED amount instead and the payer pays the wire verbatim,
 * which the payer's own review reconciles by adding the live fee back on top: the customer's
 * account moves by exactly the price.
 *
 *   fee == null  → wire = price verbatim. The fee is unknowable (DEMO play money, or a ledger the
 *                  catalog states no fee for AND the live query could not reach); the payer then
 *                  pays price+fee, honestly displayed — the same exposure the checkout ships with its
 *                  const. No number is ever guessed.
 *   fee ≥ price  → REFUSED (`err: 'fee_covers_price'`). The caller must refuse the request BEFORE
 *                  any wire is built — a zero/negative-unit wire is money nonsense — with a
 *                  localized message naming the fee.
 *   fee < price  → wire = price − fee (exact BigInt; the one number the link, the NFC wire and
 *                  every confirm consumer carry).
 *
 * Pure + total. `priceRaw` MUST be a non-empty decimal-digit string and a non-null `feeRaw` must
 * be one too — anything else `TypeError`s like `cmpRaw` (debuggable, never silent NaN). A zero
 * price is the caller's gate, not this function's (`ReceiveMode.makeRequest` refuses it first).
 */
export function nettedWireRaw(priceRaw: string, feeRaw: string | null): NettedWire {
  if (feeRaw == null) return {ok: true, wireRaw: priceRaw};
  if (!RE_RAW_DIGITS.test(priceRaw)) {
    throw new TypeError(`nettedWireRaw: priceRaw must be a decimal-digit string, got ${JSON.stringify(priceRaw)}`);
  }
  if (!RE_RAW_DIGITS.test(feeRaw)) {
    throw new TypeError(`nettedWireRaw: feeRaw must be a decimal-digit string, got ${JSON.stringify(feeRaw)}`);
  }
  const price = BigInt(priceRaw);
  const fee = BigInt(feeRaw);
  if (fee >= price) return {ok: false, err: 'fee_covers_price'};
  return {ok: true, wireRaw: (price - fee).toString()};
}

// ── Exact decimal-string ordering (2026-10-01 audit F11) ────────────────────────────────────────
//
// Money figures that arrive as decimal strings ("12.3456", `rawToDecimal`'s shape) were ranked
// through `Number(a) - Number(b)` — a float compare that misranks beyond 2^53 and at sub-f64
// precision differences. Both figures always describe the SAME unit (one target asset), so the
// exact order is a pure string→BigInt exercise: scale both fractions to the wider one, compare.

/** A canonical non-negative decimal string: optional integer part, optional fraction, no sign,
 *  no exponent ("0", "12", "12.3", "0.0000001"). `rawToDecimal`'s output shape, plus the looser
 *  spellings ("4.5400", ".5") a caller may hand over. */
const RE_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/** Parse a canonical decimal string into {whole, frac} digit strings ('' fraction allowed). */
function decimalParts(v: string): {whole: string; frac: string} {
  if (!RE_DECIMAL.test(v)) {
    throw new TypeError(`cmpDecimalExact: not a decimal string: ${JSON.stringify(v)}`);
  }
  const [whole, frac = ''] = v.split('.');
  return {whole: whole === '' || whole === undefined ? '0' : whole, frac};
}

/** Exact order of two decimal strings denoting the same unit: -1 | 0 | 1. Throws TypeError on a
 *  non-decimal input — a broken figure never silently ranks. */
export function cmpDecimalExact(a: string, b: string): number {
  const pa = decimalParts(a);
  const pb = decimalParts(b);
  const wa = BigInt(pa.whole === '' ? '0' : pa.whole);
  const wb = BigInt(pb.whole === '' ? '0' : pb.whole);
  if (wa !== wb) return wa < wb ? -1 : 1;
  const width = Math.max(pa.frac.length, pb.frac.length);
  // padEnd, never parseFloat: the fraction compares digit-exactly at full width.
  const fa = BigInt((pa.frac.padEnd(width, '0') || '0'));
  const fb = BigInt((pb.frac.padEnd(width, '0') || '0'));
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** True iff a canonical decimal string denotes a value > 0 — the exact positivity gate the
 *  float-based `Number(v) > 0` used to approximate. Same input contract as `cmpDecimalExact`. */
export function decimalIsPositive(v: string): boolean {
  const {whole, frac} = decimalParts(v);
  return BigInt(whole) > 0n || BigInt(frac.padEnd(1, '0') || '0') > 0n;
}

/** S2's confirm-lock rule (spec 2026-10-04 §2), on RAW integer strings: the quoted figure the
 *  user confirmed is the lock; a fresh re-quote within 5% of it is market noise the confirm
 *  absorbs silently, beyond 5% the move is material and the button re-arms once. Exact over
 *  BigInt - a float ratio misjudges at sub-f64 precision differences, and this gates money.
 *  Non-numeric input falls back to inequality (fail loud, never silently absorb). */
export function quoteMovedMaterially(oldRaw: string, newRaw: string): boolean {
  if (!/^\d+$/.test(oldRaw) || !/^\d+$/.test(newRaw)) return oldRaw !== newRaw;
  const o = BigInt(oldRaw);
  const n = BigInt(newRaw);
  if (o === n) return false;
  if (o === 0n) return true;
  const d = o > n ? o - n : n - o;
  return d * 20n > o;
}
