// LNURL (LUD-01) bech32 ENCODER — the harness half of the OpenCryptoPay till codes.
//
// A FIXTURE BUILDER, not a second copy of a production rule, and the distinction survived the
// relay learning to encode: `lnurl_of` (`crates/dpay-relay/src/till.rs`) mints the code for a
// charge on dpay's OWN origin, which is the only origin it can ever speak for. What these flows
// need is a code for `api.dfx.swiss` — a FOREIGN provider our relay would never serve and whose
// codes it therefore cannot produce. Hand-transcribing one would pin a magic constant nobody can
// re-derive, so this is the encoder: 40 lines of BIP-173, the mirror of the decoder the app ships
// (`decodeLnurl`, `app/lib/opencryptopay.ts`).
//
// It is deliberately NOT a second copy of the decoder either: the flows never decode. The round
// trip is verified where it matters — flow 111 feeds the output through the REAL app, so a wrong
// encoder fails that flow loudly instead of quietly agreeing with itself. The RELAY's encoder is
// pinned separately and against outside evidence: a code decoded from a real DFX till's QR
// (`crates/dpay-relay/src/till.rs`), and the wallet's own decoder reading the relay's real output
// (`app/__tests__/tillWire.test.ts`).
//
// A corroborating check on the construction: the findings doc records the live example QR as 94
// characters for the 51-character URL `https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e`, and
// `6 (hrp+separator) + ceil(51*8/5) (data) + 6 (checksum)` = 94 exactly.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HRP = 'lnurl';

/** BIP-173 polymod over the hrp-expanded values + data. Stays inside 30 bits, so JS's signed
 *  bitwise ops are exact. */
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATORS[i];
  }
  return chk;
}

/** BIP-173 hrp expansion: high bits, separator, low bits. */
function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/** 8-bit → 5-bit regrouping, zero-padding the final partial group (what the decoder's
 *  "fewer than 5 trailing bits, all zero" rule requires). */
function toWords(bytes) {
  let acc = 0;
  let bits = 0;
  const out = [];
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
export function encodeLnurl(url) {
  const words = toWords(new TextEncoder().encode(url));
  const values = [...hrpExpand(HRP), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${HRP}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

/**
 * Return `lnurl` with ONE data symbol replaced by a different valid bech32 symbol — a scuffed or
 * misread QR. The charset stays legal (so the string is still recognisably an LNURL rather than
 * garbage) while the checksum no longer verifies, which is exactly the case the checksum exists to
 * catch: bech32's BCH code detects every single-symbol substitution, so a damaged code can never
 * silently resolve to a different host.
 */
export function damageLnurl(lnurl) {
  const at = HRP.length + 4; // a data symbol, comfortably past the `lnurl1` separator
  if (lnurl.length <= at) throw new Error(`damageLnurl: "${lnurl}" is too short to damage`);
  const swapped = lnurl[at] === 'q' ? 'p' : 'q';
  return lnurl.slice(0, at) + swapped + lnurl.slice(at + 1);
}
