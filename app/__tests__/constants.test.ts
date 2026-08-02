/**
 * MC8 U6.1 — the `WALLETCONNECT_PROJECT_ID` seam.
 *
 * Mirrors `EXPECTED_RECEIPT_PUBKEY` exactly: a module-load const read from
 * `__DPAY_TEST_WALLETCONNECT_PROJECT_ID` (empty default = WalletConnect disabled = today's
 * behavior). The constant is captured at module-load time, so each case re-evaluates
 * `config/constants.ts` inside `jest.isolateModules` with the desired global set — the same
 * pattern `receipt.test.ts` uses for `EXPECTED_RECEIPT_PUBKEY`.
 */
import {describe, test, expect, jest} from '@jest/globals';

/** Re-evaluate `config/constants.ts` so a test-set global is captured fresh. */
function loadConstants(): typeof import('../config/constants') {
  let constants: typeof import('../config/constants') | undefined;
  jest.isolateModules(() => {
    constants = require('../config/constants');
  });
  return constants!;
}

describe('WALLETCONNECT_PROJECT_ID seam (MC8 U6.1)', () => {
  test('defaults to empty string (WalletConnect disabled by default = today behavior)', () => {
    delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    const {WALLETCONNECT_PROJECT_ID} = loadConstants();
    expect(WALLETCONNECT_PROJECT_ID).toBe('');
  });

  test('honors the __DPAY_TEST_WALLETCONNECT_PROJECT_ID override (mirrors EXPECTED_RECEIPT_PUBKEY)', () => {
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID =
      'test-project-id';
    try {
      const {WALLETCONNECT_PROJECT_ID} = loadConstants();
      expect(WALLETCONNECT_PROJECT_ID).toBe('test-project-id');
    } finally {
      delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    }
  });
});
