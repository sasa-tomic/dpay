/**
 * The LNURL (LUD-01) bech32 fixture builder — the jest port of `e2e/harness/lnurl.mjs` (verbatim
 * BIP-173; ~40 lines). A FIXTURE builder, not a second copy of a production rule: the relay's own
 * encoder (`lnurl_of`, crates/dpay-relay/src/checkout.rs) mints codes for dpay's origin only, and
 * flows 36/111/112 need codes for a FOREIGN provider (api.dfx.swiss) the relay would never serve.
 * The round trip is verified where it matters — flow 111 feeds the output through the REAL app, so
 * a wrong encoder fails that flow loudly; the RELAY's encoder is pinned separately
 * (`app/__tests__/checkoutWire.test.ts` reads it through the wallet's own decoder).
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HRP = 'lnurl';

/** BIP-173 polymod over the hrp-expanded values + data. Stays inside 30 bits. */
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk;
}

/** BIP-173 hrp expansion: high bits, separator, low bits. */
function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** 8-bit → 5-bit regrouping, zero-padding the final partial group. */
function toWords(bytes: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/** Encode `url` as a lowercase LUD-01 `lnurl1…` string with a valid bech32 checksum. */
export function encodeLnurl(url: string): string {
  const words = toWords(new TextEncoder().encode(url));
  const values = [...hrpExpand(HRP), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${HRP}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

/** Replace ONE data symbol with a different legal bech32 symbol: the checksum no longer verifies
 *  (exactly the case the checksum exists to catch), while the string stays recognisably an LNURL. */
export function damageLnurl(lnurl: string): string {
  const at = HRP.length + 4; // a data symbol, comfortably past the `lnurl1` separator
  if (lnurl.length <= at) throw new Error(`damageLnurl: "${lnurl}" is too short to damage`);
  const swapped = lnurl[at] === 'q' ? 'p' : 'q';
  return lnurl.slice(0, at) + swapped + lnurl.slice(at + 1);
}
