// RFC 4648 §5 base64url + UTF-8 byte codecs. The base64url encode/decode primitives are re-exported
// from `lib/base64.ts` (the SINGLE implementation shared with the standard-alphabet codec in
// `solana/rpc.ts` — unified 2026-08-10). The UTF-8 helpers (`utf8ToBytes`/`bytesToUtf8`) stay here:
// they are not duplicated anywhere, so the base64 core has no UTF-8 surface.
//
// Hand-rolled (no Buffer/btoa/TextEncoder/Node dep) so the codec is byte-identical on RN/Hermes,
// jest/Node, and the e2e browser bundle.
//
// Consumers today:
//   • `solana/qr.ts` — the `solreq:`/`solpay:` URI codec (base64url of a UTF-8 JSON payload).
//   • `lib/deepLink.ts` — the `dpay:pay/<blob>` receipt-handback codec (base64url of a UTF-8 JSON
//     receipt object).

export {bytesToBase64Url, base64UrlToBytes} from './base64';

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
