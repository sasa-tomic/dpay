/**
 * Flow 174 ic-gateway-override — the jest twin of `e2e/tests/174-ic-gateway-override.mjs`.
 *
 * The IC-gateway precedence: the OPERATOR override outranks the seam, and CLEARING it composes
 * back to the seam (never replaces the underlying rail). With no override, the Settings field
 * mirrors the seam base (the harness's fake-IC gateway — here `__DPAY_TEST_IC_GATEWAY`, the one
 * test relay). A local http override is accepted verbatim, persists across a Settings round-trip,
 * and EMPTY IS A VALUE (restores the seam base). A payment settles through the seam before and
 * after; with the dead override live, the envelope POST dies AT the override's /api/v2 route
 * (connection-class) while the seam gateway underneath stays alive — nothing settles.
 */
import {describe, it, expect} from '@jest/globals';
import {
  armPayScan, assertIncludes, DpayCore, generateKeypair, getBalance, onboardWallet,
} from '../harness/lib';
import {scaled as budgetScaled} from '../harness/budget';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

const flow = hermeticFlow();

const g = globalThis as unknown as Record<string, unknown> & {__DPAY_TEST_SCAN?: (qr: string) => void};
const PAY_CENTS = 2500;

function randNonceHex(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function scanPay(m: Awaited<ReturnType<typeof onboardWallet>>, payeeHex: string): Promise<string> {
  const nonce = randNonceHex();
  const qr = await DpayCore.encodeRequest(payeeHex, String(PAY_CENTS), nonce, Math.floor(Date.now() / 1000) + 600, 0, 'Payee', '');
  await armPayScan(m);
  g.__DPAY_TEST_SCAN!(qr);
  return nonce;
}

async function deadOrigin(): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('node:net') as typeof import('node:net');
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as {port: number}).port;
      srv.close(() => resolve(p));
    });
  });
  return `http://127.0.0.1:${port}`;
}

hermeticDescribe('flow 174 — ic-gateway-override', () => {
  it('the field mirrors the seam; a local http override applies verbatim and persists; empty restores; payments compose back; the dead override outranks', async () => {
    const m = await onboardWallet('e2e-icgw');
    const seamBase = flow.relay.baseURL; // the seam base IS the file's private relay
    const dead = await deadOrigin();

    // ── Phase 1: the seam baseline — a scan-pay settles through the fake gateway ─────────────
    const bob = await generateKeypair();
    await m.driver.click('btn-new', {timeoutMs: 5000}).catch(() => {});
    await scanPay(m, bob.publicHex);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);
    expect(await getBalance(bob.publicHex, 0)).toBe(String(PAY_CENTS));

    // ── Phase 2: the override round-trip ─────────────────────────────────────────────────────
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    // With NO operator override set, the field mirrors the RESOLVED rail base (the seam).
    const seeded = m.driver.readInputValue('settings-ic-gateway');
    expect(seeded).toBe(seamBase);
    expect(seeded).not.toBe(dead);
    await m.driver.type('settings-ic-gateway', dead, {timeoutMs: 4000});
    await m.driver.click('btn-ic-gateway-apply', {timeoutMs: 4000});
    expect(m.driver.readInputValue('settings-ic-gateway')).toBe(dead);
    expect(m.driver.isPresent('settings-ic-gateway-err')).toBe(false); // local http is accepted
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // The clear: EMPTY IS A VALUE — but the override survives one settings round-trip first.
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    expect(m.driver.readInputValue('settings-ic-gateway')).toBe(dead);
    await m.driver.type('settings-ic-gateway', '', {timeoutMs: 4000});
    await m.driver.click('btn-ic-gateway-apply', {timeoutMs: 4000});
    expect(m.driver.readInputValue('settings-ic-gateway')).toBe(seamBase);
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    // ── Phase 3: compose-back — the seam settles a payment again ─────────────────────────────
    const carol = await generateKeypair();
    await m.driver.click('btn-new', {timeoutMs: 5000});
    await scanPay(m, carol.publicHex);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 10_000})).toBe(true);
    expect(await getBalance(carol.publicHex, 0)).toBe(String(PAY_CENTS));

    // ── Phase 4: operator outranks the seam — the dead override, a payment that MUST die there ─
    m.driver.collectFetchFailures();
    m.driver.allowRequestFailuresFrom(dead);
    await m.driver.click('btn-settings', {timeoutMs: 6000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 4000});
    await m.driver.type('settings-ic-gateway', dead, {timeoutMs: 4000});
    await m.driver.click('btn-ic-gateway-apply', {timeoutMs: 4000});
    expect(m.driver.readInputValue('settings-ic-gateway')).toBe(dead);
    await m.driver.click('btn-settings-close', {timeoutMs: 4000});

    const dave = await generateKeypair();
    await m.driver.click('btn-new', {timeoutMs: 5000});
    await scanPay(m, dave.publicHex);
    let deadHit: {url: string; error?: string} | null = null;
    for (let i = 0; i < 300 && deadHit === null; i++) {
      m.driver.collectFetchFailures();
      deadHit = m.driver.fetchFailures.find((f) => f.url.startsWith(`${dead}/api/v2/canister/`)) ?? null;
      if (deadHit === null) await new Promise((r) => setTimeout(r, budgetScaled(50)));
    }
    expect(deadHit).not.toBeNull();
    assertIncludes(deadHit!.url, '/api/v2/canister/', 'the refused request is an /api/v2 envelope POST');
    expect(/CONNECTION|NETWORK|REFUSED|FAILED|ABORTED/i.test(deadHit!.error ?? '')).toBe(true);
    // Nothing may settle while the rail points at the dead override.
    await new Promise((r) => setTimeout(r, 2000));
    expect(Number(await getBalance(dave.publicHex, 0))).toBe(0);

    await m.unmount();
  }, 180_000);
});
