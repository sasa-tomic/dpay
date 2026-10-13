import {afterEach, describe, expect, it} from '@jest/globals';
import {
  installTextDecoderOptionsShim,
  wrapRestrictedTextDecoder,
} from '../evm/textDecoderHermes';

/** The boot guard for the WalletConnect import chain: `@walletconnect/pay` constructs
 *  `new TextDecoder('utf-8', {ignoreBOM: true, fatal: true})` at MODULE SCOPE and Hermes
 *  rejects the `fatal` option, so a missing shim means the app dies at start before any UI.
 *  These tests pin the wrapper's semantics and the installer's feature detection. */

// Simulates Hermes's TextDecoder: the label is fine, the options object throws.
// Captures the REAL decoder NOW (module load) — at call time globalThis.TextDecoder may
// already be the installed wrapper, and delegating through the global would recurse.
const RealDecoderAtLoad = globalThis.TextDecoder;

class RestrictedTextDecoder {
  constructor(label?: string, options?: {fatal?: boolean; ignoreBOM?: boolean}) {
    if (options !== undefined && ('fatal' in options || 'ignoreBOM' in options)) {
      throw new TypeError("Failed to construct 'TextDecoder': the 'fatal' option is unsupported.");
    }
    void label;
  }

  decode(input?: Uint8Array): string {
    return input == null ? '' : new RealDecoderAtLoad('utf-8').decode(input);
  }
}

describe('textDecoderHermes — the WalletConnect boot guard', () => {
  const realDecoder = globalThis.TextDecoder;

  afterEach(() => {
    (globalThis as unknown as {TextDecoder: unknown}).TextDecoder = realDecoder;
  });

  it('is a no-op where the native decoder already accepts options (Node, browser, the polyfill)', () => {
    expect(typeof realDecoder).toBe('function');
    expect(installTextDecoderOptionsShim()).toBe('not-needed');
    expect(globalThis.TextDecoder).toBe(realDecoder);
  });

  it('the wrapper drops fatal/ignoreBOM, keeps the label, and still decodes utf-8', () => {
    const Wrapped = wrapRestrictedTextDecoder(RestrictedTextDecoder as never);
    // The exact construction the pay module performs at import time.
    const d = new Wrapped('utf-8', {fatal: true, ignoreBOM: true});
    expect(d.encoding).toBe('utf-8');
    expect(d.fatal).toBe(false);
    expect(d.ignoreBOM).toBe(false);
    expect(d.decode()).toBe('');
    expect(d.decode(new TextEncoder().encode('hello'))).toBe('hello');
    expect(d.decode(new TextEncoder().encode('héllo → €'))).toBe('héllo → €');
    // A label other than utf-8 still constructs (the wrapper forwards it untouched).
    expect(() => new Wrapped('windows-1252')).not.toThrow();
  });

  it('installing under a restricted native swaps the global and defuses the pay-module pattern', () => {
    (globalThis as unknown as {TextDecoder: unknown}).TextDecoder = RestrictedTextDecoder;
    expect(installTextDecoderOptionsShim()).toBe('wrapped');
    const Installed = globalThis.TextDecoder as new (
      label?: string,
      options?: {fatal?: boolean; ignoreBOM?: boolean},
    ) => {decode(input?: Uint8Array): string};
    expect(() => {
      new Installed('utf-8', {ignoreBOM: true, fatal: true}).decode();
    }).not.toThrow();
    expect(new Installed().decode(new TextEncoder().encode('hi'))).toBe('hi');
  });

  it('reports absent when there is no TextDecoder at all', () => {
    (globalThis as unknown as {TextDecoder: unknown}).TextDecoder = undefined;
    expect(installTextDecoderOptionsShim()).toBe('absent');
  });
});
