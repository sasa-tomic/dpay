/**
 * Unit tests for the pure link codecs in `lib/deepLink.ts` — the wallet's ONE inbound/outbound URL
 * surface. Pure (no React/native deps beyond `Platform`, which the jest preset mocks) so the whole
 * grammar runs on the fast inner loop.
 *
 * Two codecs live there and they are deliberately different in kind:
 *   • the PAYMENT LINK `https://<origin>/wallet/pay/<recipient>?asset=…&amount=…` — human-readable,
 *     hand-authorable, shareable over chat, and (via Android App Links) openable straight into the
 *     app. This is the only URL format for "pay me".
 *   • the RECEIPT HAND-BACK `dpay:pay/<base64url(JSON)>` — machine state handed between two phones
 *     when NFC is unavailable, so it stays an opaque blob. Never human-facing.
 *
 * Money-critical invariants pinned here: a malformed payment link is REPORTED (never silently
 * treated as "no link"), a link never carries an expiry, `ref` is either absent or exactly the
 * 32-hex nonce, and label/memo carry the wire's own 32-byte cap so a link and a request QR render
 * one payee identically.
 */
import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import {Platform} from 'react-native';
import {
  PAY_LINK_PREFIX,
  PAY_LINK_TEXT_BYTES,
  clampLinkText,
  parsePayLink,
  parseTillCode,
  encodePayLink,
  readPayLink,
  shareOrigin,
  decodeDeeplink,
  decodeReceiptDeeplink,
  receiptShareBlob,
  shareReceipt,
  readPaymentDeeplink,
  parseRailProof,
  type PayLink,
} from '../lib/deepLink';

// A realistic canister-signed receipt object (the shape the relay's POST /api/v1/pay returns under
// `body.receipt`). Every protocol-u64 field is a decimal STRING (MC1 units 2-4 — lossy above 2^53).
const SAMPLE_RECEIPT = {
  nonce: 'aabbccdd11223344',
  from: '1b8a5ee7'.repeat(8),
  to: 'deadbeef'.repeat(8),
  amount: '2500',
  currency: 0,
  block_index: '123456',
  settle_ts: '1700000000',
  receipt_sig: 'ff'.repeat(64),
  pubkey: 'ee'.repeat(32),
};

// A realistic rail proof (the post-cutover dpay:pay/ payload — {ledger, block_index, request_id},
// derived by the payer's phone after read_state confirms its envelope settled).
const SAMPLE_PROOF = {
  ledger: 'w7x7r-c3z3l-…', // principal text (abridged in tests — the format gate doesn't check it)
  block_index: '123456',
  request_id: 'ab'.repeat(32), // 64-hex = the 32-byte request_id of the payer's envelope
};

// The ICP ledger principal — a real, CRC-valid principal, used as a link destination.
const PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const LINK = `https://dpay.kalaj.org${PAY_LINK_PREFIX}${PRINCIPAL}?asset=VCHF&network=internet-computer&amount=12.50`;

const origOS = Platform.OS;
afterEach(() => { Platform.OS = origOS; });

// --- payment link: parse ----------------------------------------------------------------------

describe('parsePayLink', () => {
  it('parses a full https link into recipient + asset + settlement chain + amount', () => {
    const out = parsePayLink(LINK);
    expect(out).toEqual({ok: true, link: {
      recipient: PRINCIPAL, asset: 'VCHF', network: 'internet-computer', amount: '12.50', label: '', memo: '', ref: null,
    }});
  });

  it('parses a path-only link (what the web wallet reads off its own location)', () => {
    const out = parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1`);
    expect(out?.ok).toBe(true);
    expect(out?.ok && out.link.asset).toBe('ICP');
  });

  it('carries the optional label, memo and ref', () => {
    const out = parsePayLink(
      `${PAY_LINK_PREFIX}${PRINCIPAL}?asset=USDC&network=solana&amount=4&label=Cafe%20Kalaj&memo=Table%207&ref=${'ab'.repeat(16)}`,
    );
    expect(out?.ok).toBe(true);
    if (!out?.ok) return;
    expect(out.link.label).toBe('Cafe Kalaj');
    expect(out.link.memo).toBe('Table 7');
    expect(out.link.ref).toBe('ab'.repeat(16));
  });

  it('requires the settlement chain — a token alone never names an asset', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=USDC&amount=1`)).toEqual({ok: false, err: 'network'});
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=USDC&network=&amount=1`)).toEqual({ok: false, err: 'network'});
  });

  it('normalises the chain spelling: case and spaces (one chain, one value)', () => {
    const spelled = (n: string) => {
      const out = parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=${n}&amount=1`);
      return out?.ok ? out.link.network : null;
    };
    expect(spelled('internet-computer')).toBe('internet-computer');
    expect(spelled('Internet-Computer')).toBe('internet-computer');
    expect(spelled('Internet%20Computer')).toBe('internet-computer');
    expect(spelled('SOLANA')).toBe('solana');
  });

  it('lower-cases a ref so the on-chain memo has one spelling', () => {
    const out = parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1&ref=${'AB'.repeat(16)}`);
    expect(out?.ok && out.link.ref).toBe('ab'.repeat(16));
  });

  it('accepts a base58 Solana recipient (the address is opaque to the grammar)', () => {
    const sol = '7NpxyoRDrTWQFHgqvNSuNjhx8ZKPvWLnbFCH8kJn8Chi';
    const out = parsePayLink(`${PAY_LINK_PREFIX}${sol}?asset=SOL&network=solana&amount=0.5`);
    expect(out?.ok && out.link.recipient).toBe(sol);
  });

  it('tolerates a trailing slash on the recipient', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}/?asset=ICP&network=internet-computer&amount=1`)).toEqual(
      parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1`),
    );
  });

  it('percent-decodes the recipient path segment', () => {
    const out = parsePayLink(`${PAY_LINK_PREFIX}${encodeURIComponent(PRINCIPAL)}?asset=ICP&network=internet-computer&amount=1`);
    expect(out?.ok && out.link.recipient).toBe(PRINCIPAL);
  });

  // --- "not a payment link at all" → null, so the caller falls through to its other handling ----

  it('null for the plain wallet URL', () => {
    expect(parsePayLink('https://dpay.kalaj.org/wallet')).toBeNull();
  });
  it('null for the receipt hand-back scheme (a different codec owns it)', () => {
    expect(parsePayLink('dpay:pay/abc')).toBeNull();
  });
  it('null for an unrelated path and for junk', () => {
    expect(parsePayLink('https://dpay.kalaj.org/privacy')).toBeNull();
    expect(parsePayLink('not a url')).toBeNull();
    expect(parsePayLink('')).toBeNull();
  });

  // --- "is a payment link but unusable" → a REASON, never a silent null ------------------------

  it('reports a missing recipient (a truncated link says so; it never reads as "no link")', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}?asset=ICP&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'recipient'});
    expect(parsePayLink(`${PAY_LINK_PREFIX}/?asset=ICP&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'recipient'});
  });
  it('reports a recipient with a nested path segment (never silently uses the first)', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}/extra?asset=ICP&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'recipient'});
  });
  it('reports a broken %-escape in the recipient (a corrupted link, not "no link")', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}%E0%A4%A?asset=ICP&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'recipient'});
  });
  it('reports an over-long recipient', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${'a'.repeat(129)}?asset=ICP&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'recipient'});
  });
  it('reports a missing or empty asset', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?network=internet-computer&amount=1`)).toEqual({ok: false, err: 'asset'});
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=&network=internet-computer&amount=1`)).toEqual({ok: false, err: 'asset'});
  });
  it('reports a missing or empty amount (an amount-less link is not payable)', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer`)).toEqual({ok: false, err: 'amount'});
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=`)).toEqual({ok: false, err: 'amount'});
  });
  it('reports a ref that is not the 32-hex nonce (wrong length, non-hex)', () => {
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1&ref=abc`)).toEqual({ok: false, err: 'ref'});
    expect(parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1&ref=${'zz'.repeat(16)}`)).toEqual({ok: false, err: 'ref'});
  });

  it('clamps an over-long label/memo instead of blocking the payment on a cosmetic field', () => {
    const long = 'x'.repeat(64);
    const out = parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1&label=${long}&memo=${long}`);
    expect(out?.ok).toBe(true);
    if (!out?.ok) return;
    expect(out.link.label).toBe('x'.repeat(PAY_LINK_TEXT_BYTES));
    expect(out.link.memo).toBe('x'.repeat(PAY_LINK_TEXT_BYTES));
  });

  it('does NOT accept an expiry — a shared link is durable by design', () => {
    const out = parsePayLink(`${PAY_LINK_PREFIX}${PRINCIPAL}?asset=ICP&network=internet-computer&amount=1&expiry=1`);
    expect(out?.ok).toBe(true);
    expect(Object.keys((out as {link: PayLink}).link)).not.toContain('expiry');
  });
});

// --- payment link: text clamp (wire parity) ---------------------------------------------------

describe('clampLinkText', () => {
  it('leaves a short string alone and caps at the wire byte limit', () => {
    expect(clampLinkText('Cafe Kalaj')).toBe('Cafe Kalaj');
    expect(clampLinkText('y'.repeat(40))).toBe('y'.repeat(PAY_LINK_TEXT_BYTES));
  });
  it('counts UTF-8 BYTES, not characters, and never splits a character', () => {
    // '☕' is 3 bytes: ten of them = 30 bytes (fits), eleven = 33 (the 11th is dropped whole).
    expect(clampLinkText('☕'.repeat(10))).toBe('☕'.repeat(10));
    expect(clampLinkText('☕'.repeat(11))).toBe('☕'.repeat(10));
    expect([...clampLinkText('☕'.repeat(11))].every(c => c === '☕')).toBe(true);
  });
  it('neutralises text a stranger wrote before the review screen renders it', () => {
    // A label is written by whoever wrote the link, and React Native `Text` renders newlines: a
    // label of blank lines pushes the destination account — the one checkable thing on the review —
    // off the visible screen. Bidi overrides can display a name reversed and zero-width padding
    // hides where it ends. Neither is a length problem, so the byte cap alone never caught them.
    // ONE rule for stranger-supplied display text: an OpenCryptoPay merchant name goes through this
    // same door (`lib/opencryptopay.ts`).
    expect(clampLinkText('Cafe\n\n\n\n\nKalaj')).toBe('Cafe Kalaj');
    expect(clampLinkText('Cafe\u202E\u200B\uFEFF Kalaj')).toBe('Cafe Kalaj');
    expect(clampLinkText('\u0000\u2028 \u200B')).toBe('');
    // ZWJ/ZWNJ are KEPT: they join rather than hide, and they are load-bearing in real names and
    // emoji sequences. Sanitising is not "strip anything unusual".
    expect(clampLinkText('می‌دان')).toBe('می‌دان');
  });
});

// --- payment link: encode + round-trip --------------------------------------------------------

describe('encodePayLink', () => {
  const FULL: PayLink = {
    recipient: PRINCIPAL, asset: 'VCHF', network: 'internet-computer', amount: '12.50',
    label: 'Cafe Kalaj', memo: 'Table 7', ref: 'ab'.repeat(16),
  };

  it('builds the documented shape: recipient in the path, everything else in the query', () => {
    const u = new URL(encodePayLink('https://dpay.kalaj.org', FULL));
    expect(u.pathname).toBe(`${PAY_LINK_PREFIX}${PRINCIPAL}`);
    expect(u.searchParams.get('asset')).toBe('VCHF');
    expect(u.searchParams.get('amount')).toBe('12.50');
    expect(u.searchParams.get('label')).toBe('Cafe Kalaj');
  });

  it('round-trips every field through parsePayLink', () => {
    const out = parsePayLink(encodePayLink('https://dpay.kalaj.org', FULL));
    expect(out).toEqual({ok: true, link: FULL});
  });

  it('omits empty optional fields rather than sending them blank — but never the chain', () => {
    const url = encodePayLink('https://dpay.kalaj.org', {...FULL, label: '', memo: '', ref: null});
    expect(url).not.toContain('label=');
    expect(url).not.toContain('memo=');
    expect(url).not.toContain('ref=');
    expect(url).toContain('network=internet-computer');
  });

  it('always normalises the chain it emits, whatever spelling it was handed', () => {
    const url = encodePayLink('https://dpay.kalaj.org', {...FULL, network: 'Internet Computer'});
    expect(new URL(url).searchParams.get('network')).toBe('internet-computer');
  });

  it('applies the same text cap on the way out (link and QR show one payee)', () => {
    const url = encodePayLink('https://dpay.kalaj.org', {...FULL, label: 'z'.repeat(50)});
    expect(new URL(url).searchParams.get('label')).toBe('z'.repeat(PAY_LINK_TEXT_BYTES));
  });

  it('round-trips a unicode label and a memo with reserved characters', () => {
    const tricky: PayLink = {...FULL, label: 'Café ☕', memo: 'a&b=c?d#e'};
    const out = parsePayLink(encodePayLink('https://dpay.kalaj.org', tricky));
    expect(out).toEqual({ok: true, link: tricky});
  });

  it('honours the origin it is given (a self-hosted wallet shares itself)', () => {
    expect(encodePayLink('http://127.0.0.1:8080', FULL).startsWith(`http://127.0.0.1:8080${PAY_LINK_PREFIX}`)).toBe(true);
  });
});

// --- share origin + the web location reader ---------------------------------------------------

describe('shareOrigin', () => {
  it('uses the page origin on web (a self-hosted wallet shares its own URL)', () => {
    Platform.OS = 'web';
    const w = globalThis as unknown as {location?: {origin?: string}};
    w.location = {origin: 'https://wallet.example'};
    try { expect(shareOrigin()).toBe('https://wallet.example'); } finally { delete w.location; }
  });
  it('falls back to the canonical wallet origin on native (no location to read)', () => {
    Platform.OS = 'android';
    expect(shareOrigin()).toBe('https://dpay.kalaj.org');
  });
});

describe('readPayLink', () => {
  beforeEach(() => { Platform.OS = 'web'; });
  const withLocation = (pathname: string, search: string, fn: () => void) => {
    const w = globalThis as unknown as {location?: {pathname?: string; search?: string}};
    w.location = {pathname, search};
    try { fn(); } finally { delete w.location; }
  };

  it('reads the link off the page location', () => {
    withLocation(`${PAY_LINK_PREFIX}${PRINCIPAL}`, '?asset=VCHF&network=internet-computer&amount=2', () => {
      const out = readPayLink();
      expect(out?.ok && out.link.recipient).toBe(PRINCIPAL);
      expect(out?.ok && out.link.amount).toBe('2');
    });
  });
  it('null on the plain wallet page', () => {
    withLocation('/wallet', '', () => { expect(readPayLink()).toBeNull(); });
  });
  it('surfaces a malformed link from the page URL (never silently "no link")', () => {
    withLocation(`${PAY_LINK_PREFIX}${PRINCIPAL}`, '?asset=VCHF&network=internet-computer', () => {
      expect(readPayLink()).toEqual({ok: false, err: 'amount'});
    });
  });
  it('null on native — the OS hands the app the link through Linking instead', () => {
    Platform.OS = 'android';
    withLocation(`${PAY_LINK_PREFIX}${PRINCIPAL}`, '?asset=VCHF&network=internet-computer&amount=2', () => {
      expect(readPayLink()).toBeNull();
    });
  });
});

// --- receipt hand-back codec (dpay:pay/<base64url(JSON)>) --------------------------------------

describe('decodeDeeplink (receipt hand-back scheme)', () => {
  it('parses dpay:pay/<blob> and preserves base64url - and _ characters', () => {
    expect(decodeDeeplink('dpay:pay/xyz')).toEqual({blob: 'xyz'});
    expect(decodeDeeplink('dpay:pay/Aa-_Bb-_')?.blob).toBe('Aa-_Bb-_');
  });
  it('null for a non-dpay string, an http URL, an empty blob, and the bare scheme', () => {
    expect(decodeDeeplink('not a dpay link')).toBeNull();
    expect(decodeDeeplink('https://dpay.kalaj.org/wallet?pay=abc')).toBeNull();
    expect(decodeDeeplink('dpay:pay/')).toBeNull();
    expect(decodeDeeplink('dpay:')).toBeNull();
    expect(decodeDeeplink('')).toBeNull();
  });
  it('null for a payment link (the two codecs never overlap)', () => {
    expect(decodeDeeplink(LINK)).toBeNull();
  });
  it('is case-sensitive on the scheme (DPAY: rejected)', () => {
    expect(decodeDeeplink('DPAY:pay/abc')).toBeNull();
  });
});

describe('shareReceipt', () => {
  it('on web, builds an openable /wallet?pay=<blob> URL the wallet reads back', () => {
    Platform.OS = 'web';
    const w = globalThis as unknown as {location?: {origin?: string}};
    w.location = {origin: 'https://dpay.kalaj.org'};
    try {
      const u = new URL(shareReceipt(SAMPLE_RECEIPT));
      expect(u.pathname).toBe('/wallet');
      expect(u.searchParams.get('pay')).toBe(receiptShareBlob(SAMPLE_RECEIPT));
      expect(decodeReceiptDeeplink(u.searchParams.get('pay')!)).toEqual(SAMPLE_RECEIPT);
    } finally { delete w.location; }
  });
  it('on native, keeps the dpay: URI the app owns, carrying the identical blob', () => {
    Platform.OS = 'android';
    const uri = shareReceipt(SAMPLE_RECEIPT);
    expect(uri).toBe(`dpay:pay/${receiptShareBlob(SAMPLE_RECEIPT)}`);
    expect(decodeReceiptDeeplink(decodeDeeplink(uri)!.blob)).toEqual(SAMPLE_RECEIPT);
  });
  it('the blob is base64url, never the raw receipt JSON', () => {
    Platform.OS = 'android';
    const uri = shareReceipt(SAMPLE_RECEIPT);
    expect(uri.slice('dpay:pay/'.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(uri).not.toContain('"amount"');
    expect(uri).not.toContain(SAMPLE_RECEIPT.from);
  });
});

describe('decodeReceiptDeeplink', () => {
  it('round-trips a full receipt object (every field preserved)', () => {
    expect(decodeReceiptDeeplink(receiptShareBlob(SAMPLE_RECEIPT))).toEqual(SAMPLE_RECEIPT);
  });
  it('preserves large decimal-string amounts (BigInt-safe, no Number coercion)', () => {
    const big = {...SAMPLE_RECEIPT, amount: '18446744073709551615'}; // u64 max
    const back = decodeReceiptDeeplink(receiptShareBlob(big));
    expect(back).toEqual(big);
    expect((back as typeof big).amount).toBe('18446744073709551615');
  });
  it('preserves unicode in string fields', () => {
    const r = {...SAMPLE_RECEIPT, memo: 'café ☕ ₿'};
    expect(decodeReceiptDeeplink(receiptShareBlob(r))).toEqual(r);
  });
  it('returns null on an empty string, on garbage, and on base64url that is not JSON', () => {
    expect(decodeReceiptDeeplink('')).toBeNull();
    expect(decodeReceiptDeeplink('@@@not-base64@@@')).toBeNull();
    expect(decodeReceiptDeeplink('abc')).toBeNull();
  });
});

// --- rail-proof FORMAT gate (parseRailProof — F2/F6, 2026-08-20) ------------------------------
// The dpay:pay/ blob is UNTRUSTED: parseRailProof is the pure format gate the merchant's screen
// applies BEFORE binding the proof to its open request. A non-null result means "well-formed,
// still unverified" — the settlement poll confirms on-chain. This is the forgery surface: a
// random-but-well-formed request_id must pass the FORMAT gate (that is correct — the point is
// that format alone can no longer flip the UI to Received; only read_state can).

describe('parseRailProof (format gate of the dpay:pay hand-back)', () => {
  it('accepts a well-formed proof and echoes request_id/block_index', () => {
    expect(parseRailProof(SAMPLE_PROOF)).toEqual({
      request_id: 'ab'.repeat(32),
      block_index: '123456',
      ledger: 'w7x7r-c3z3l-…',
    });
  });
  it('accepts a FORGED-but-well-formed proof (random rid) — format-valid ≠ verified', () => {
    const forged = {request_id: '00ff'.repeat(16), block_index: '0', ledger: 'x'};
    // The format gate passes it; the COMPONENT test (ReceiveMode) proves it can't flip the UI.
    expect(parseRailProof(forged)).not.toBeNull();
  });
  it('round-trips through the full codec: receiptShareBlob → decodeReceiptDeeplink → parseRailProof', () => {
    expect(parseRailProof(decodeReceiptDeeplink(receiptShareBlob(SAMPLE_PROOF)))).toEqual({
      request_id: SAMPLE_PROOF.request_id,
      block_index: SAMPLE_PROOF.block_index,
      ledger: SAMPLE_PROOF.ledger,
    });
  });
  it('null on null / non-object input', () => {
    expect(parseRailProof(null)).toBeNull();
  });
  it('null when request_id is not 64-hex (too short)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 'ab'.repeat(31)})).toBeNull();
  });
  it('null when request_id is not hex', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 'zz'.repeat(32)})).toBeNull();
  });
  it('null when request_id is not a string (a number is malformed)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, request_id: 123} as unknown as Record<string, unknown>)).toBeNull();
  });
  it('null when block_index is missing', () => {
    expect(parseRailProof({request_id: 'ab'.repeat(32)})).toBeNull();
  });
  it('null when block_index is not digits (hex/negative/float rejected)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '12ab'})).toBeNull();
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '-1'})).toBeNull();
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '1.5'})).toBeNull();
  });
  it('null when block_index is a number, not a decimal string', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: 42} as unknown as Record<string, unknown>)).toBeNull();
  });
  it('accepts block_index 0 (the ledger genesis edge — digits-only is the contract)', () => {
    expect(parseRailProof({...SAMPLE_PROOF, block_index: '0'})?.block_index).toBe('0');
  });
  it('ledger is optional (absent ledger still parses — the open request owns routing)', () => {
    const {ledger, ...noLedger} = SAMPLE_PROOF;
    void ledger;
    const out = parseRailProof(noLedger);
    expect(out?.request_id).toBe(SAMPLE_PROOF.request_id);
    expect(out?.ledger).toBeUndefined();
  });
});

// --- web ?pay= reader -------------------------------------------------------------------------

describe('readPaymentDeeplink (web ?pay= reader)', () => {
  beforeEach(() => { Platform.OS = 'web'; });
  const withSearch = (search: string, fn: () => void) => {
    const w = globalThis as unknown as {location?: {search?: string}};
    w.location = {search};
    try { fn(); } finally { delete w.location; }
  };
  it('reads a ?pay=<blob> param on web', () => {
    withSearch('?pay=eyJmb28iOiJiYXIifQ', () => { expect(readPaymentDeeplink()).toBe('eyJmb28iOiJiYXIifQ'); });
  });
  it('returns null when no ?pay= is present and for an empty ?pay=', () => {
    withSearch('?other=abc', () => { expect(readPaymentDeeplink()).toBeNull(); });
    withSearch('?pay=', () => { expect(readPaymentDeeplink()).toBeNull(); });
  });
  it('returns null on native (Platform.OS !== web)', () => {
    Platform.OS = 'ios';
    withSearch('?pay=abc', () => { expect(readPaymentDeeplink()).toBeNull(); });
  });
});

describe('parseTillCode', () => {
  // The till code is the OTHER https URL the relay mints: `{origin}/pl/?lightning=<LNURL…>`
  // (TILL_CODE_PATH in crates/dpay-relay/src/till.rs is the authority; deepLink.ts mirrors it).
  // parseTillCode only owns the PATH question — "is this the till-code door?" — and hands back the
  // ORIGINAL string; the OpenCryptoPay parser owns the payload grammar (including refusing a code
  // with no usable lightning param), and the caller routes it through the scan classifier.
  it('recognises a till code the relay mints and returns the original string', () => {
    const url = 'https://dpay.kalaj.org/pl/?lightning=LNURL1QPYSYMRXVSSP4';
    expect(parseTillCode(url)).toBe(url);
  });
  it('is host-liberal: a self-hosted relay mints the same artifact', () => {
    const url = 'https://relay.example.com/pl/?lightning=LNURL1QPYSY';
    expect(parseTillCode(url)).toBe(url);
  });
  it('accepts a path-only /pl/ (a relative URL is anchored like parsePayLink does)', () => {
    expect(parseTillCode('/pl/?lightning=LNURL1QPYSY')).toBe('/pl/?lightning=LNURL1QPYSY');
  });
  it('still recognises a /pl/ that carries no lightning param (the classifier refuses it honestly)', () => {
    expect(parseTillCode('https://dpay.kalaj.org/pl/')).toBe('https://dpay.kalaj.org/pl/');
  });
  it('null for the payment-link path (a different door owns it)', () => {
    expect(parseTillCode('https://dpay.kalaj.org/wallet/pay/abc?asset=ICP')).toBeNull();
  });
  it('null for deeper /pl/ paths and the bare host (only the exact till path is the door)', () => {
    expect(parseTillCode('https://dpay.kalaj.org/pl/x?lightning=LNURL1')).toBeNull();
    expect(parseTillCode('https://dpay.kalaj.org/pl')).toBeNull();
    expect(parseTillCode('https://dpay.kalaj.org/')).toBeNull();
  });
  it('null for non-URLs: a bare LNURL is NOT a till code (a different scan kind owns it)', () => {
    expect(parseTillCode('lnurl1qpysymrx')).toBeNull();
    expect(parseTillCode('lightning:lnurl1qpysymrx')).toBeNull();
    expect(parseTillCode('dpay:pay/abc')).toBeNull();
  });
  it('never throws: empty and junk input return null', () => {
    expect(parseTillCode('')).toBeNull();
    expect(parseTillCode('not a url')).toBeNull();
    expect(parseTillCode('::::')).toBeNull();
  });
});
