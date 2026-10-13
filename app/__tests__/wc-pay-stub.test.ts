/**
 * The `@walletconnect/pay` Metro-stub boot guard (the fundamental Hermes fix, round 2).
 *
 * Metro resolves `@walletconnect/pay` to `shims/walletconnect-pay.js` (see metro.config.js
 * resolver alias 2). The real dist crashes Hermes at module scope (option-requiring TextDecoder
 * construction, then a bare decode) — with the stub, that dist never ships or evaluates.
 * walletkit references the pay module exactly once (`S.isAvailable() && (this.pay = new S(...))`),
 * so `isAvailable(): false` makes walletkit skip the pay branch and everything dpay uses works.
 *
 * This test pins the stub's contract; it cannot prove what Metro resolves (jest already maps
 * `@walletconnect/.*` to its own stubs) — the metro.config.js alias and the device boot are the
 * other two legs. import the stub BY PATH, mirroring what Metro hands walletkit.
 */
import {afterEach, describe, expect, it, jest} from '@jest/globals';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import stub from '../shims/walletconnect-pay.js';

const RealDecoderAtLoad = globalThis.TextDecoder;

afterEach(() => {
  (globalThis as {TextDecoder?: unknown}).TextDecoder = RealDecoderAtLoad;
});

describe('the walletconnect-pay stub — the WalletConnect boot guard', () => {
  it('answers isAvailable() false, so walletkit skips its pay branch', () => {
    expect(typeof stub.WalletConnectPay).toBe('function');
    expect(stub.WalletConnectPay.isAvailable()).toBe(false);
  });

  it('refuses construction with a clear message (unreachable while isAvailable gates it)', () => {
    expect(() => new stub.WalletConnectPay()).toThrow(/stub/);
  });

  it('stays constructible and usable even under a Hermes-shaped TextDecoder', () => {
    // The stub itself must never touch TextDecoder (that is the defect it removes): simulate the
    // hostile global and evaluate the module surface again.
    class HermesShaped {
      constructor(_label?: string, _options?: {fatal?: boolean; ignoreBOM?: boolean}) {
        if (_options !== undefined) {
          throw new TypeError("Failed to construct 'TextDecoder': the 'fatal' option is unsupported.");
        }
      }
      decode() {
        throw new TypeError("Cannot read property 'buffer' of undefined");
      }
    }
    (globalThis as {TextDecoder?: unknown}).TextDecoder = HermesShaped;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reloaded = require('../shims/walletconnect-pay.js');
    expect(reloaded.WalletConnectPay.isAvailable()).toBe(false);
  });
});
