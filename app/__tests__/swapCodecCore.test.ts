/**
 * The delegated-conversion codec surface, driven through the REAL compiled core.
 *
 * `DpayCore.icpDepositAndSwapArg` / `icpSwapMinOut` / `icpDecodeSwapResult` are the three calls the
 * Convert flow makes: the arg the user's key signs, the slippage floor signed into it, and the
 * pool's own verdict on whether the money moved. The staged `dpay-core.wasm` is injected through
 * the shim's `__DPAY_WASM_BYTES` seam, so these run the same `dpay_icp::icrc` code the Android
 * UniFFI binding, the relay, and the canister run — not a JS re-reading of the wire.
 *
 * Expected bytes come from the committed Rust goldens (`crates/dpay-icp/tests/goldens.rs`), parsed
 * at test time and never restated here: one golden, two readers, no way to drift by editing one.
 */
import {describe, test, expect, beforeAll, jest} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(__dirname, '..', '..');
const GOLDENS_RS = readFileSync(join(ROOT, 'crates', 'dpay-icp', 'tests', 'goldens.rs'), 'utf8');

/** Pull one `const NAME: &str = "hex";` out of the committed golden file. */
function goldenHex(name: string): string {
  const m = GOLDENS_RS.match(new RegExp(`const ${name}: &str = "([0-9a-f]+)";`));
  if (m == null) throw new Error(`golden ${name} not found in goldens.rs`);
  return m[1];
}

/** Structural view of the three exports under test (the shim targets the browser build, so it is
 *  `require`d rather than statically imported — the tillOpenSignature.test.ts seam). */
interface SwapCore {
  icpDepositAndSwapArg(
    amountIn: string, amountOutMinimum: string, tokenInFee: string, tokenOutFee: string, zeroForOne: boolean,
  ): Promise<string>;
  icpSwapMinOut(quotedOut: string, slippageBps: number): Promise<string>;
  icpDecodeSwapResult(argHex: string): Promise<{
    ok: boolean; amountOutGross?: string; errVariant?: string; errDetail?: string;
  }>;
}

beforeAll(() => {
  (globalThis as unknown as {__DPAY_WASM_BYTES: Uint8Array}).__DPAY_WASM_BYTES = new Uint8Array(
    readFileSync(join(ROOT, 'crates', 'dpay-relay', 'assets', 'dpay-core.wasm')),
  );
});

/** Load the shim fresh (its wasm instance is module-level state). */
async function withCore(fn: (core: SwapCore) => Promise<void>): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    const {DpayCore} = require('../../e2e/web/dpay-core-wasm');
    await fn(DpayCore as SwapCore);
  });
}

describe('icpDepositAndSwapArg — the pool arg the user signs', () => {
  test('reproduces every committed golden byte-for-byte', async () => {
    await withCore(async core => {
      expect(await core.icpDepositAndSwapArg('102000000', '1800000', '10000', '10000', true))
        .toBe(goldenHex('G_SWAP_FLOAT_OP'));
      expect(await core.icpDepositAndSwapArg('0', '0', '0', '123456789012345678901234567890', false))
        .toBe(goldenHex('G_SWAP_ZEROES_129BIT_FEE'));
      expect(await core.icpDepositAndSwapArg((2n ** 128n - 1n).toString(), '1', '1', '2', true))
        .toBe(goldenHex('G_SWAP_U128_MAX'));
    });
  });

  test('the direction flag is signed, not implied — zeroForOne changes the bytes', async () => {
    await withCore(async core => {
      const zeroToOne = await core.icpDepositAndSwapArg('102000000', '1800000', '10000', '10000', true);
      const oneToZero = await core.icpDepositAndSwapArg('102000000', '1800000', '10000', '10000', false);
      expect(oneToZero).not.toBe(zeroToOne);
    });
  });

  test('refuses anything that is not a decimal u128 — never a silently-wrong arg', async () => {
    await withCore(async core => {
      for (const bad of ['1.5', '-1', '', ' 1', 'abc', (2n ** 128n).toString()]) {
        await expect(core.icpDepositAndSwapArg(bad, '0', '0', '0', false)).rejects.toThrow();
        await expect(core.icpDepositAndSwapArg('0', bad, '0', '0', false)).rejects.toThrow();
        await expect(core.icpDepositAndSwapArg('0', '0', bad, '0', false)).rejects.toThrow();
        await expect(core.icpDepositAndSwapArg('0', '0', '0', bad, false)).rejects.toThrow();
      }
    });
  });
});

describe('icpSwapMinOut — the slippage floor', () => {
  test('exact floor, saturation, and a zero quote', async () => {
    await withCore(async core => {
      await expect(core.icpSwapMinOut('2000000', 300)).resolves.toBe('1940000');
      // Remainder-heavy: units=1 rem=9999, k=5000 → 5000 + floor(9999*5000/10000) = 9999.
      await expect(core.icpSwapMinOut('19999', 5000)).resolves.toBe('9999');
      await expect(core.icpSwapMinOut('2000000', 10000)).resolves.toBe('0');
      await expect(core.icpSwapMinOut('2000000', 65535)).resolves.toBe('0');
      // A zero floor is a real answer and must not read as the wasm BAD_LEN status code.
      await expect(core.icpSwapMinOut('0', 0)).resolves.toBe('0');
    });
  });

  test('0 bps is the identity at the u128 ceiling (no overflow-to-0)', async () => {
    await withCore(async core => {
      const max = (2n ** 128n - 1n).toString();
      await expect(core.icpSwapMinOut(max, 0)).resolves.toBe(max);
      await expect(core.icpSwapMinOut(max, 10000)).resolves.toBe('0');
    });
  });

  test('a FRACTIONAL slippage is refused, never truncated to zero tolerance', async () => {
    await withCore(async core => {
      // 0.5 bps used to reach the core as 0 (Kotlin `.toInt()`; a raw wasm i32 param ToInt32s the
      // same way) — silently turning slippage protection OFF on a money screen. It must throw, and
      // the message must name the value the user set.
      await expect(core.icpSwapMinOut('2000000', 0.5)).rejects.toThrow('0.5');
      await expect(core.icpSwapMinOut('2000000', 99.9)).rejects.toThrow('99.9');
      await expect(core.icpSwapMinOut('2000000', NaN)).rejects.toThrow();
      await expect(core.icpSwapMinOut('2000000', Infinity)).rejects.toThrow();
    });
  });

  test('rejects an out-of-u16 bps and a non-decimal quote', async () => {
    await withCore(async core => {
      await expect(core.icpSwapMinOut('100', -1)).rejects.toThrow();
      await expect(core.icpSwapMinOut('100', 65536)).rejects.toThrow();
      await expect(core.icpSwapMinOut('abc', 0)).rejects.toThrow();
      await expect(core.icpSwapMinOut('1.5', 0)).rejects.toThrow();
      await expect(core.icpSwapMinOut('', 0)).rejects.toThrow();
    });
  });
});

describe('icpDecodeSwapResult — the pool’s own verdict', () => {
  test('#ok carries the venue’s GROSS amount out', async () => {
    await withCore(async core => {
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_OK')))
        .resolves.toEqual({ok: true, amountOutGross: '99600000'});
    });
  });

  test('every #err arm keeps its own tag and the venue’s own words', async () => {
    await withCore(async core => {
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_ERR_COMMON')))
        .resolves.toEqual({ok: false, errVariant: 'CommonError', errDetail: ''});
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_ERR_INSUFFICIENT')))
        .resolves.toEqual({ok: false, errVariant: 'InsufficientFunds', errDetail: ''});
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_ERR_INTERNAL')))
        .resolves.toEqual({ok: false, errVariant: 'InternalError', errDetail: 'amountOutMinimum not met'});
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_ERR_UNSUPPORTED')))
        .resolves.toEqual({ok: false, errVariant: 'UnsupportedToken', errDetail: 'zzz-cai'});
    });
  });

  test('a reply that is not the pool’s Result throws — never a fabricated outcome', async () => {
    await withCore(async core => {
      await expect(core.icpDecodeSwapResult('deadbeef')).rejects.toThrow();
      await expect(core.icpDecodeSwapResult(goldenHex('G_SWAP_RESULT_OK').slice(0, -2))).rejects.toThrow();
      await expect(core.icpDecodeSwapResult('')).rejects.toThrow();
    });
  });
});
