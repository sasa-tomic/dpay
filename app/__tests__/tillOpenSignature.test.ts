/**
 * `DpayCore.tillOpenSignature` — the merchant's proof that the OpenCryptoPay till account they are
 * ringing up a charge on is one they can spend from.
 *
 * Driven through the REAL compiled core: the staged `dpay-core.wasm` is injected via the shim's
 * `__DPAY_WASM_BYTES` seam, so this exercises the same bytes the web wallet loads and the same
 * `dpay_core::TillOpen` encoding the relay verifies with `validate_till_open`. The expected values
 * come from the committed golden (`dfx/till_open_signing.json`, emitted from Rust by
 * `just wire-layout`) — never restated here, so this suite cannot drift from the encoding.
 *
 * Why a signature is required at all: without it `POST /api/v1/till` accepts any 32-byte hex as the
 * destination key, and a probe opened a live production charge with `deadbeef…deadbeef` on
 * 2026-09-03 — a key nobody holds.
 */
import {describe, test, expect, beforeAll, jest} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(__dirname, '..', '..');
const GOLDEN = JSON.parse(
  readFileSync(join(ROOT, 'dfx', 'till_open_signing.json'), 'utf8'),
) as {
  max_skew_secs: number;
  golden: {
    secret_hex: string;
    merchant_pubkey_hex: string;
    cents: number;
    nonce_hex: string;
    issued_at: number;
    merchant_name: string;
    sig_hex: string;
  };
};
const G = GOLDEN.golden;

beforeAll(() => {
  // The shim fetches its wasm by URL in a browser; the seam lets a Node consumer inject the staged
  // artifact instead — the very bytes `just wasm` commits and the relay serves.
  (globalThis as unknown as {__DPAY_WASM_BYTES: Uint8Array}).__DPAY_WASM_BYTES = new Uint8Array(
    readFileSync(join(ROOT, 'crates', 'dpay-relay', 'assets', 'dpay-core.wasm')),
  );
});

/** Load the shim fresh (its wasm instance is module-level state). */
async function withCore(fn: (core: {
  tillOpenSignature(secretHex: string, cents: string, nonceHex: string, issuedAt: number, merchantName: string): Promise<string>;
  keypairFromSecret(secretHex: string): Promise<{secretHex: string; publicHex: string}>;
}) => Promise<void>): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    const {DpayCore} = require('../../e2e/web/dpay-core-wasm');
    await fn(DpayCore);
  });
}

describe('DpayCore.tillOpenSignature', () => {
  test('reproduces the committed golden signature byte-for-byte', async () => {
    await withCore(async core => {
      const sig = await core.tillOpenSignature(
        G.secret_hex, String(G.cents), G.nonce_hex, G.issued_at, G.merchant_name,
      );
      expect(sig).toBe(G.sig_hex);
      // The signature covers the seed's OWN public key — the app never passes one in, so it cannot
      // sign a ring-up for an account it does not hold the key to.
      expect((await core.keypairFromSecret(G.secret_hex)).publicHex).toBe(G.merchant_pubkey_hex);
    });
  });

  test('binds the price, the nonce, the timestamp and the claimed merchant name', async () => {
    await withCore(async core => {
      const sign = (cents: number, nonceHex: string, issuedAt: number, name: string) =>
        core.tillOpenSignature(G.secret_hex, String(cents), nonceHex, issuedAt, name);
      // Ed25519 is deterministic, so a differing signature proves the field entered the signed bytes.
      expect(await sign(G.cents + 1, G.nonce_hex, G.issued_at, G.merchant_name)).not.toBe(G.sig_hex);
      expect(await sign(G.cents, 'ff'.repeat(16), G.issued_at, G.merchant_name)).not.toBe(G.sig_hex);
      expect(await sign(G.cents, G.nonce_hex, G.issued_at + 1, G.merchant_name)).not.toBe(G.sig_hex);
      // The CLAIMED name is what every paying wallet renders as `displayName`, so it is signed too.
      expect(await sign(G.cents, G.nonce_hex, G.issued_at, 'Migros')).not.toBe(G.sig_hex);
      // …and signing the same inputs twice is stable (no RNG anywhere on this path).
      expect(await sign(G.cents, G.nonce_hex, G.issued_at, G.merchant_name)).toBe(G.sig_hex);
    });
  });

  test('refuses a malformed seed or nonce instead of signing something wrong', async () => {
    await withCore(async core => {
      await expect(
        core.tillOpenSignature('11'.repeat(31), String(G.cents), G.nonce_hex, G.issued_at, ''),
      ).rejects.toThrow('Length');
      await expect(
        core.tillOpenSignature(G.secret_hex, String(G.cents), 'ab'.repeat(15), G.issued_at, ''),
      ).rejects.toThrow('nonce length: 15');
      await expect(
        core.tillOpenSignature(G.secret_hex, String(G.cents), 'nothex!!', G.issued_at, ''),
      ).rejects.toThrow('Length');
    });
  });

  test('carries a raw-u64 price and timestamp past the 2^53 exact-integer limit', async () => {
    await withCore(async core => {
      // `cents` crosses as a decimal STRING for exactly this reason (MC1). Above 2^53 a `number`
      // would round, and a rounded price signs a charge nobody asked for.
      const huge = '18446744073709551615';
      const sig = await core.tillOpenSignature(G.secret_hex, huge, G.nonce_hex, G.issued_at, '');
      const off = await core.tillOpenSignature(G.secret_hex, '18446744073709551614', G.nonce_hex, G.issued_at, '');
      expect(sig).toHaveLength(128);
      expect(sig).not.toBe(off);
    });
  });
});
