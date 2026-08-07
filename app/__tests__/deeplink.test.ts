/**
 * Unit tests for the pure `dpay:` deeplink codec (item 6). A merchant's request QR carries a raw
 * base64url blob; the deeplink wraps it as `dpay:req/<blob>` so it can be shared over a messaging
 * app + opened on the payer's phone. The codec is pure (no React/native deps beyond the file's
 * existing `Platform` import, which the jest preset mocks) so it runs on the fast inner loop.
 *
 * The blob is the EXACT base64url the QR already carries — no new wire format. Version lives inside
 * the blob. Slash-not-query so URL libs don't mangle `+`/`%`.
 */
import {describe, it, expect} from '@jest/globals';
import {encodeDeeplink, decodeDeeplink} from '../lib/deepLink';

describe('encodeDeeplink', () => {
  it('wraps a req blob in dpay:req/', () => {
    expect(encodeDeeplink('req', 'abc')).toBe('dpay:req/abc');
  });
  it('wraps a pay blob in dpay:pay/', () => {
    expect(encodeDeeplink('pay', 'xyz')).toBe('dpay:pay/xyz');
  });
});

describe('decodeDeeplink', () => {
  it('parses dpay:req/<blob>', () => {
    expect(decodeDeeplink('dpay:req/abc')).toEqual({kind: 'req', blob: 'abc'});
  });
  it('parses dpay:pay/<blob>', () => {
    expect(decodeDeeplink('dpay:pay/xyz')).toEqual({kind: 'pay', blob: 'xyz'});
  });

  it('round-trips a req blob', () => {
    const blob = 'aB3-_xY9'; // base64url chars incl - and _
    expect(decodeDeeplink(encodeDeeplink('req', blob))).toEqual({kind: 'req', blob});
  });
  it('round-trips a pay blob (codec symmetric)', () => {
    const blob = 'Zm9vYmFy'; // "foobar" base64url
    expect(decodeDeeplink(encodeDeeplink('pay', blob))).toEqual({kind: 'pay', blob});
  });

  it('preserves base64url - and _ characters in the blob (no mangling)', () => {
    const blob = 'Aa-_Bb-_Cc-_Dd-_';
    expect(decodeDeeplink(`dpay:req/${blob}`)?.blob).toBe(blob);
  });

  it('null for a non-dpay string', () => {
    expect(decodeDeeplink('not a dpay link')).toBeNull();
  });
  it('null for an http URL (the web ?req= path is handled separately, not by the codec)', () => {
    expect(decodeDeeplink('https://dpay.kalaj.org/?req=abc')).toBeNull();
  });
  it('null for an empty blob', () => {
    expect(decodeDeeplink('dpay:req/')).toBeNull();
  });
  it('null for an unknown kind', () => {
    expect(decodeDeeplink('dpay:foo/abc')).toBeNull();
  });
  it('null for a missing slash', () => {
    expect(decodeDeeplink('dpay:req')).toBeNull();
  });
  it('null for an empty kind (leading slash)', () => {
    expect(decodeDeeplink('dpay:/abc')).toBeNull();
  });
  it('null for an empty string', () => {
    expect(decodeDeeplink('')).toBeNull();
  });
  it('null for just the scheme', () => {
    expect(decodeDeeplink('dpay:')).toBeNull();
  });
  it('is case-sensitive on the scheme (DPAY: rejected)', () => {
    expect(decodeDeeplink('DPAY:req/abc')).toBeNull();
  });
});
