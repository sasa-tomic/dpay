/**
 * `DpayCore.icpDepositAndSwapArg` / `DpayCore.icpSwapMinOut` — the delegated-conversion PoC's two
 * app→core calls, on the web/jest build through the PURE-JS TWIN in e2e/web/dpay-core-wasm.ts.
 *
 * dpay-wasm does not re-export these (A1 landed them in dpay-ffi + Kotlin only), so the twin is the
 * web wallet's only encoder — and a twin that drifts from the compiled core signs a pool arg the
 * chain would reject with real money behind it. This suite pins the twin byte-for-byte to the SAME
 * goldens the Rust core is pinned to: the committed `crates/dpay-icp/tests/goldens.rs` is parsed at
 * test time (never restated here), so if either side ever changes without the other, THIS test is
 * the alarm — not a user's phone. The min-out arithmetic is pinned to the same cases as the FFI
 * unit tests in crates/dpay-ffi/src/icp.rs (exact floor, saturation, zero, reject table).
 */
import {describe, test, expect, beforeAll} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(__dirname, '..', '..');

const GOLDENS_RS = readFileSync(
  join(ROOT, 'crates', 'dpay-icp', 'tests', 'goldens.rs'),
  'utf8',
);

/** Pull one `const NAME: &str = "hex";` out of the committed golden file — single source of truth. */
function goldenHex(name: string): string {
  const m = GOLDENS_RS.match(new RegExp(`const ${name}: &str = "([0-9a-f]+)";`));
  if (m == null) throw new Error(`golden ${name} not found in goldens.rs`);
  return m[1];
}

// Structural twin of the two fns this suite exercises. Loaded via `require` (the
// tillOpenSignature.test.ts seam): the shim targets the browser/vite build (WebAssembly, window)
// and must not be dragged into the app's `tsc --noEmit` project by a static import.
interface TwinCore {
  icpDepositAndSwapArg(
    amountIn: string, amountOutMinimum: string, tokenInFee: string, tokenOutFee: string, zeroForOne: boolean,
  ): Promise<string>;
  icpSwapMinOut(quotedOut: string, slippageBps: number): Promise<string>;
}
let DpayCore: TwinCore;

beforeAll(() => {
  // The twin fns are pure TS (no wasm export needed), but importing the shim still wires the
  // loader — the staged wasm bytes seam keeps that inert under jest (precedent: the twin-free
  // sections of dpay-core-wasm-timeout.test.ts).
  ({DpayCore} = require('../../e2e/web/dpay-core-wasm'));
});

describe('icpDepositAndSwapArg twin — byte-pinned to the Rust goldens', () => {
  test('float-op shape (102000000 in, 1800000 min-out, 10000/10000 fees, zeroForOne)', async () => {
    const hex = await DpayCore.icpDepositAndSwapArg('102000000', '1800000', '10000', '10000', true);
    expect(hex).toBe(goldenHex('G_SWAP_FLOAT_OP'));
  });

  test('zeroes + 87-bit fee', async () => {
    const hex = await DpayCore.icpDepositAndSwapArg('0', '0', '0', '123456789012345678901234567890', false);
    expect(hex).toBe(goldenHex('G_SWAP_ZEROES_129BIT_FEE'));
  });

  test('u128::MAX amountIn', async () => {
    const max = (2n ** 128n - 1n).toString();
    const hex = await DpayCore.icpDepositAndSwapArg(max, '1', '1', '2', true);
    expect(hex).toBe(goldenHex('G_SWAP_U128_MAX'));
  });

  test('rejects the same inputs the core rejects (signs, decimals, overflow)', async () => {
    await expect(DpayCore.icpDepositAndSwapArg('1.5', '0', '0', '0', false)).rejects.toThrow();
    await expect(DpayCore.icpDepositAndSwapArg('-1', '0', '0', '0', false)).rejects.toThrow();
    await expect(DpayCore.icpDepositAndSwapArg((2n ** 128n).toString(), '0', '0', '0', false)).rejects.toThrow();
    await expect(DpayCore.icpDepositAndSwapArg('', '0', '0', '0', false)).rejects.toThrow();
  });
});

describe('icpSwapMinOut twin — same arithmetic as icp_swap_min_out (crates/dpay-ffi/src/icp.rs)', () => {
  test('exact floor with remainder (2000000 @ 300 bps → 1940000)', async () => {
    await expect(DpayCore.icpSwapMinOut('2000000', 300)).resolves.toBe('1940000');
  });

  test('full saturation at bps >= 10000', async () => {
    await expect(DpayCore.icpSwapMinOut('2000000', 10000)).resolves.toBe('0');
    await expect(DpayCore.icpSwapMinOut('2000000', 65535)).resolves.toBe('0');
  });

  test('zero quote stays zero', async () => {
    await expect(DpayCore.icpSwapMinOut('0', 0)).resolves.toBe('0');
  });

  test('remainder-heavy floor: 19999 @ 5000 bps → 9999 (not 9999.5 rounded up)', async () => {
    // units=1 rem=9999, k=5000: 1*5000 + 9999*5000/10000 = 5000 + 4999 (floor) = 9999
    await expect(DpayCore.icpSwapMinOut('19999', 5000)).resolves.toBe('9999');
  });

  test('rejects non-canonical or out-of-u16 bps', async () => {
    await expect(DpayCore.icpSwapMinOut('abc', 0)).rejects.toThrow();
    await expect(DpayCore.icpSwapMinOut('1.5', 0)).rejects.toThrow();
    await expect(DpayCore.icpSwapMinOut('100', -1)).rejects.toThrow();
    await expect(DpayCore.icpSwapMinOut('100', 65536)).rejects.toThrow();
    await expect(DpayCore.icpSwapMinOut('100', 0.5)).rejects.toThrow();
  });
});
