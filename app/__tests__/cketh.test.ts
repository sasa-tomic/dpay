/**
 * Byte-exact golden test for the ckETH-minter ckERC-20 onramp calldata (C-MOCK linchpin).
 *
 * Every value below is pinned from AUTHORITATIVE sources — not invented:
 *   - principal→bytes32 goldens: DFINITY `ic` repo `tests/principal_to_bytes_test.js` (5 vectors).
 *   - depositErc20 full calldata: composed from the live `CkDeposit` ABI + 100 USDC + a golden
 *     principal, cross-checked during O6 mainnet verification (2026-07-31).
 *   - selectors: keccak256, cross-verified against the canonical `approve`=`0x095ea7b3`.
 *
 * If ANY of these asserts fails, the onramp would produce wrong calldata and the user's signed
 * transaction would not mint (or would miscredit). That is why this is a hard gate.
 */
import {describe, it, expect} from '@jest/globals';
import {
  principalToBytes32,
  encodeApprove,
  encodeDepositErc20,
  SELECTOR_APPROVE,
  SELECTOR_DEPOSIT_ERC20,
} from '../cketh';

// Live mainnet constants (verified 2026-07-31; helper addr is fetched at runtime in prod, but the
// ABI/encoding is fixed at deploy so these are correct pinning constants).
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const HELPER = '0x18901044688D3756C35Ed2b36D93e6a5B8e00E68';

describe('cketh calldata — function selectors (keccak256, cross-checked)', () => {
  it('approve(address,uint256) = 0x095ea7b3', () => {
    expect(SELECTOR_APPROVE).toBe('095ea7b3');
  });
  it('depositErc20(address,uint256,bytes32,bytes32) = 0xdb9751af', () => {
    expect(SELECTOR_DEPOSIT_ERC20).toBe('db9751af');
  });
});

describe('cketh calldata — principal → bytes32 (DFINITY golden vectors)', () => {
  // 5/5 verbatim from rs/ethereum/cketh/minter/tests/principal_to_bytes_test.js.
  it('k2t6j-...-6ae', () => {
    expect(principalToBytes32('k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae')).toBe(
      '1db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000',
    );
  });
  it('opspt-...-vqe', () => {
    expect(principalToBytes32('opspt-7okml-4664d-lqdny-uuuto-6nars-7am7t-jebvm-j3xj2-j4tdu-vqe')).toBe(
      '1dca62f9ef706b80db8a5293779a08cbe067e69206ac4eee9d27931d2b020000',
    );
  });
  it('ezu3d-...-rae', () => {
    expect(principalToBytes32('ezu3d-2mifu-k3bh4-oqhrj-mbrql-5p67r-pp6pr-dbfra-unkx5-sxdtv-rae')).toBe(
      '1d882d15b09f8e81e29606305f5fefc5eff3e2309620a3557ecae39d62020000',
    );
  });
  it('47gy6-...-sae', () => {
    expect(principalToBytes32('47gy6-2c22d-voqoy-eflbe-gwml3-zwe52-r6lx7-rexro-ebluo-2rqcd-sae')).toBe(
      '1d5ad0eae83b042ac243598bde6c4eea3e5dff125e2e2057476a3010e4020000',
    );
  });
  it('2chl6-4hpzw-vqaaa-aaaaa-c (system-ish, short principal)', () => {
    expect(principalToBytes32('2chl6-4hpzw-vqaaa-aaaaa-c')).toBe(
      '09efcdab00000000000100000000000000000000000000000000000000000000',
    );
  });
});

describe('cketh calldata — approve(spender, amount)', () => {
  it('approving the helper for 100 USDC (100_000000)', () => {
    // 0x095ea7b3 + addr32(helper) + u256(100_000000)
    expect(encodeApprove(HELPER, 100_000000n)).toBe(
      '0x095ea7b3' +
        '00000000000000000000000018901044688d3756c35ed2b36d93e6a5b8e00e68' +
        '0000000000000000000000000000000000000000000000000000000005f5e100',
    );
  });
});

describe('cketh calldata — depositErc20 full 132-byte golden (plan §9e)', () => {
  it('100 USDC, k2t6j principal, default subaccount', () => {
    const principalWord = principalToBytes32('k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae');
    const calldata = encodeDepositErc20(USDC, 100_000000n, principalWord);
    // selector + addr32(USDC) + u256(100_000000) + principalWord + 32-byte zero subaccount = 132 bytes
    expect(calldata).toBe(
      '0xdb9751af' +
        '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' +
        '0000000000000000000000000000000000000000000000000000000005f5e100' +
        '1db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000' +
        '0'.repeat(64), // default subaccount = 32 zero bytes
    );
    // 4 bytes selector + 4*32 bytes args = 132 bytes = 264 hex chars after 0x
    expect(calldata.length).toBe(2 + 4 * 2 + 4 * 64);
  });

  it('checksum-insensitive on the ERC-20 address', () => {
    const lower = encodeDepositErc20(USDC.toLowerCase(), 1n, principalToBytes32('2chl6-4hpzw-vqaaa-aaaaa-c'));
    const upper = encodeDepositErc20(USDC, 1n, principalToBytes32('2chl6-4hpzw-vqaaa-aaaaa-c'));
    expect(lower).toBe(upper);
  });

  it('rejects a negative amount', () => {
    expect(() => encodeDepositErc20(USDC, -1n, '0'.repeat(64))).toThrow();
  });
});
