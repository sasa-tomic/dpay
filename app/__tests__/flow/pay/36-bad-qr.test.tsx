/**
 * Flow 36 — the jest twin of `e2e/tests/36-bad-qr.mjs` (malformed codes surface honest errors, and
 * the failure is TRANSIENT — the scanner genuinely re-arms for the next code).
 *
 * Three unpayable codes in a row, in an order where every expected message differs from the
 * previous one (a swallowed payload would leave the previous refusal on screen):
 *   1. non-base64 garbage → "This isn't a dpay payment code";
 *   2. a DAMAGED OpenCryptoPay checkout code (bech32 checksum no longer verifies) → "This code is
 *      damaged…";
 *   3. valid base64, wrong length → back to "This isn't a dpay payment code".
 * After every refusal the <QrScanner> MOUNT counter advances (the remount is proven, not assumed);
 * the sign screen never mounts; and exactly one scan listener remains at the end.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {armPayScan, assert, onboardWallet} from '../harness/lib';
import {deadline as budgetDeadline} from '../harness/budget';
import {scanSeam} from './local';
import {damageLnurl, encodeLnurl} from './lnurl';

const NOT_A_PAYMENT_CODE = "isn't a dpay payment code";
const DAMAGED_CODE = 'This code is damaged';
// A real OpenCryptoPay checkout code with ONE data symbol corrupted: still an lnurl1… string, but
// the checksum no longer verifies (bech32 detects every single-symbol substitution).
const DAMAGED_CHECKOUT = damageLnurl(encodeLnurl('https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e'));

const PAYLOADS = [
  {label: 'non-base64 garbage', payload: 'this is definitely not a valid request QR!!!', expect: NOT_A_PAYMENT_CODE},
  {label: 'damaged checkout code', payload: DAMAGED_CHECKOUT, expect: DAMAGED_CODE},
  {label: 'valid base64, wrong length', payload: 'AAAA', expect: NOT_A_PAYMENT_CODE},
];

const g = globalThis as unknown as Record<string, unknown>;
const scanGen = (): number => {
  const f = g.__DPAY_TEST_SCAN_GEN as (() => number) | undefined;
  return typeof f === 'function' ? f() : -1;
};

hermeticDescribe('flow 36 — bad QR: honest errors, no review mount, the scanner genuinely re-arms', () => {
  it('three codes each surface their OWN refusal and the mount counter advances every time', async () => {
    const m = await onboardWallet('jest-badqr');
    let previous: string | null = null;

    for (const {label, payload, expect: expected} of PAYLOADS) {
      await armPayScan(m);
      const gen = scanGen();
      assert(gen > 0, 'the camera seam must expose a mount counter');
      scanSeam()(payload);

      assert(await m.driver.waitForText(expected, {timeoutMs: 5000}),
        `${label} should surface "${expected}"`);
      // The message CHANGED — what makes the leg non-vacuous.
      if (previous !== null && previous !== expected) {
        expect(m.driver.bodyText()).not.toContain(previous);
      }
      // The sign screen MUST NOT mount — nothing auto-signs a nonsensical request.
      expect(m.driver.isPresent('pay-amount')).toBe(false);
      // The refusal re-arms the camera: a NEW QrScanner mount, so the next code is READ.
      // Positive transition (remount after the refusal) — budget-scaled ceiling.
      const deadline = budgetDeadline(5000);
      let next = gen;
      while (Date.now() < deadline && next <= gen) {
        await new Promise((r) => setTimeout(r, 25));
        next = scanGen();
      }
      assert(next > gen, `after refusing the ${label} the scanner never remounted (stuck at ${gen})`);
      previous = expected;
    }

    // The surface is still alive after the errors: exactly one listener — no leak, no teardown.
    const count = g.__DPAY_TEST_SCAN_COUNT as () => number;
    expect(count()).toBe(1);

    await m.unmount();
  }, 120_000);
});
