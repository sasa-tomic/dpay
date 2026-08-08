// RFC 4648 §5 base64url + UTF-8 byte codecs — the SINGLE source of truth for these primitives
// across the app. Hand-rolled (no Buffer/btoa/TextEncoder/Node dep) so the codec is byte-identical
// on RN/Hermes, jest/Node, and the e2e browser bundle.
//
// Consumers today:
//   • `solana/qr.ts` — the `solreq:`/`solpay:` URI codec (base64url of a UTF-8 JSON payload).
//   • `lib/deepLink.ts` — the `dpay:pay/<blob>` receipt-handback codec (base64url of a UTF-8 JSON
//     receipt object).
//
// Extracted from `solana/qr.ts` (2026-08-08) so the IC deeplink path does NOT re-implement base64url
// and does NOT couple to the SOL QR module. Both now import from here — one implementation, two
// call sites. The SOL jest suite (`solana-qr.test.ts`) still pins the byte-exact behavior unchanged.

const B64U_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64U_REV = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64U_CHARS.length; i++) m[B64U_CHARS.charCodeAt(i)] = i;
  return m;
})();

/** Encode bytes as unpadded RFC 4648 §5 base64url (`-`/`_`, no `=`). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64U_CHARS[b0 >> 2];
    out += B64U_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64U_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64U_CHARS[b2 & 0x3f];
  }
  return out;
}

/** Decode an (optionally padded) RFC 4648 §5 base64url string to bytes. Returns null on a malformed
 *  string (bad char / impossible trailing length). Tolerates a trailing `=` pad (stripped) so a
 *  canonical-with-pad emitter round-trips too. */
export function base64UrlToBytes(s: string): Uint8Array | null {
  // Accept the canonical unpadded form; tolerate padded (strip `=`) for robustness.
  const len = s.endsWith('=') ? s.replace(/=+$/, '').length : s.length;
  if (len === 0) return new Uint8Array(0);
  // Whole groups of 4 → 3 bytes; a trailing group of 2 → 1 byte, of 3 → 2 bytes.
  const full = Math.floor(len / 4);
  const rem = len % 4;
  if (rem === 1) return null; // impossible in valid base64
  const outLen = full * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  const out = new Uint8Array(outLen);
  let oi = 0;
  const decodeBlock = (c0: number, c1: number, c2: number, c3: number, bytesIn: number) => {
    const v0 = B64U_REV[c0];
    const v1 = B64U_REV[c1];
    const v2 = c2 >= 0 ? B64U_REV[c2] : -1;
    const v3 = c3 >= 0 ? B64U_REV[c3] : -1;
    if (v0 < 0 || v1 < 0 || (bytesIn >= 3 && v2 < 0) || (bytesIn >= 4 && v3 < 0)) return false;
    out[oi++] = (v0 << 2) | (v1 >> 4);
    if (bytesIn >= 3) out[oi++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    if (bytesIn >= 4) out[oi++] = ((v2 & 0x03) << 6) | v3;
    return true;
  };
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2), s.charCodeAt(i + 3), 4)) return null;
  }
  if (rem === 2) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), -1, -1, 2)) return null;
  } else if (rem === 3) {
    if (!decodeBlock(s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2), -1, 3)) return null;
  }
  return out;
}

/** UTF-8 encode a JS string to bytes (hand-rolled; no TextEncoder/Buffer dependency). */
export function utf8ToBytes(s: string): Uint8Array {
  let utf8 = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) utf8 += String.fromCharCode(c);
    else if (c < 0x800) utf8 += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else utf8 += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const out = new Uint8Array(utf8.length);
  for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i) & 0xff;
  return out;
}

/** UTF-8 decode bytes to a JS string (full RFC 3629; rejects overlong/surrogates/truncation). */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp: number;
    let extra: number;
    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if ((b & 0xe0) === 0xc0) {
      cp = b & 0x1f;
      extra = 1;
    } else if ((b & 0xf0) === 0xe0) {
      cp = b & 0x0f;
      extra = 2;
    } else if ((b & 0xf8) === 0xf0) {
      cp = b & 0x07;
      extra = 3;
    } else {
      throw new Error('invalid UTF-8 lead byte');
    }
    if (i + extra > bytes.length) throw new Error('truncated UTF-8 sequence');
    for (let k = 0; k < extra; k++) {
      const cb = bytes[i++];
      if ((cb & 0xc0) !== 0x80) throw new Error('invalid UTF-8 continuation byte');
      cp = (cp << 6) | (cb & 0x3f);
    }
    // Reject overlong encodings.
    const min = extra === 1 ? 0x80 : extra === 2 ? 0x800 : extra === 3 ? 0x10000 : 0;
    if (cp < min) throw new Error('overlong UTF-8 sequence');
    // Reject UTF-16 surrogate halves (invalid in UTF-8).
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error('surrogate in UTF-8');
    out += cp > 0xffff
      ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3f))
      : String.fromCharCode(cp);
  }
  return out;
}
