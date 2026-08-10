// RFC 4648 base64 codecs — the SINGLE implementation shared by the standard-alphabet (padded,
// `+/`) and the URL-safe-alphabet (unpadded, `-_`) consumers. Hand-rolled (no Buffer/btoa/atob
// dependency) so the codec is byte-identical on RN/Hermes, jest/Node, and the e2e browser bundle.
//
// The two prior hand-rolled copies (`solana/rpc.ts` standard + `lib/base64url.ts` url-safe) were
// byte-identical except alphabet + padding; both are now thin wrappers over this core.
//
// Consumers:
//   • `lib/base64url.ts` — `bytesToBase64Url`/`base64UrlToBytes` (URL alphabet, unpadded, null-on-malformed).
//   • `solana/rpc.ts` — `bytesToBase64`/`base64ToBytes` (standard alphabet, padded, throws-on-malformed).

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function makeReverseMap(alphabet: string): Int8Array {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) m[alphabet.charCodeAt(i)] = i;
  return m;
}

const STD_REV = makeReverseMap(STD_ALPHABET);
const URL_REV = makeReverseMap(URL_ALPHABET);

/** Encode bytes as RFC 4648 base64 over the given alphabet. `padded` adds `=` to the canonical length. */
function encode(bytes: Uint8Array, alphabet: string, padded: boolean): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)];
    else if (padded) out += '=';
    if (i + 2 < bytes.length) out += alphabet[b2 & 0x3f];
    else if (padded) out += '=';
  }
  return out;
}

/** Decode an RFC 4648 base64 string over the given reverse map. Strips trailing `=` and whitespace.
 *  Returns null on a malformed string (bad char / impossible trailing length). */
function decode(s: string, rev: Int8Array): Uint8Array | null {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '');
  const len = clean.length;
  if (len === 0) return new Uint8Array(0);
  const full = Math.floor(len / 4);
  const rem = len % 4;
  if (rem === 1) return null;
  const outLen = full * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let oi = 0;
  const decodeBlock = (c0: number, c1: number, c2: number, c3: number, bytesIn: number) => {
    const v0 = rev[c0];
    const v1 = rev[c1];
    const v2 = c2 >= 0 ? rev[c2] : -1;
    const v3 = c3 >= 0 ? rev[c3] : -1;
    if (v0 < 0 || v1 < 0 || (bytesIn >= 3 && v2 < 0) || (bytesIn >= 4 && v3 < 0)) return false;
    out[oi++] = (v0 << 2) | (v1 >> 4);
    if (bytesIn >= 3) out[oi++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    if (bytesIn >= 4) out[oi++] = ((v2 & 0x03) << 6) | v3;
    return true;
  };
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    if (!decodeBlock(clean.charCodeAt(i), clean.charCodeAt(i + 1), clean.charCodeAt(i + 2), clean.charCodeAt(i + 3), 4)) return null;
  }
  if (rem === 2) {
    if (!decodeBlock(clean.charCodeAt(i), clean.charCodeAt(i + 1), -1, -1, 2)) return null;
  } else if (rem === 3) {
    if (!decodeBlock(clean.charCodeAt(i), clean.charCodeAt(i + 1), clean.charCodeAt(i + 2), -1, 3)) return null;
  }
  return out;
}

// --- standard alphabet (padded, throws-on-malformed — the Solana RPC contract) ----------------

export function bytesToBase64(bytes: Uint8Array): string {
  return encode(bytes, STD_ALPHABET, true);
}

export function base64ToBytes(s: string): Uint8Array {
  const r = decode(s, STD_REV);
  if (r === null) throw new Error('solana rpc: malformed base64');
  return r;
}

// --- URL-safe alphabet (unpadded, null-on-malformed — the dpay deeplink/QR contract) -----------

export function bytesToBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_ALPHABET, false);
}

export function base64UrlToBytes(s: string): Uint8Array | null {
  return decode(s, URL_REV);
}
