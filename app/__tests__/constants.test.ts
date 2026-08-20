/**
 * MC8 U6.1 / U6 capstone — the `WALLETCONNECT_PROJECT_ID` seam.
 *
 * A module-load const read from `__DPAY_TEST_WALLETCONNECT_PROJECT_ID` (the production id is the
 * default; setting the override to '' DISABLES WalletConnect for the offline inner loop). The
 * constant is captured at module-load time, so each case re-evaluates `config/constants.ts` inside
 * `jest.isolateModules` with the desired global set.
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

// The production project id baked in constants.ts (MC8 U6 capstone — safe now that showQrModal:false
// makes the @reown/appkit modal path runtime-unreachable). The override seam disables it for tests.
const PROD_PROJECT_ID = '648afbc757419fa381f77ba0c900bc85';

describe('WALLETCONNECT_PROJECT_ID seam (MC8 U6.1 + U6 capstone)', () => {
  test('defaults to the production project id (showQrModal:false makes the appkit modal unreachable)', () => {
    delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    const {WALLETCONNECT_PROJECT_ID} = loadConstants();
    expect(WALLETCONNECT_PROJECT_ID).toBe(PROD_PROJECT_ID);
  });

  test('override = "" DISABLES WalletConnect (the offline inner-loop / jest.setup.js path)', () => {
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    try {
      const {WALLETCONNECT_PROJECT_ID} = loadConstants();
      expect(WALLETCONNECT_PROJECT_ID).toBe('');
    } finally {
      delete (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID;
    }
  });

  test('honors the __DPAY_TEST_WALLETCONNECT_PROJECT_ID override (module-load const capture)', () => {
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

describe('EXPIRY_WINDOW (U-F3 — payer-onboarding TTL)', () => {
  test('the IC-rail request TTL is 15 min: a payer who onboards from a shared link lands on a live request', () => {
    const {EXPIRY_WINDOW} = loadConstants();
    expect(EXPIRY_WINDOW).toBe(900);
  });
});
