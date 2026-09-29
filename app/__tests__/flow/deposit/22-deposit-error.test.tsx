/**
 * Flow 22 deposit-error — the jest twin of `e2e/tests/22-deposit-error.mjs`.
 *
 * IC gateway unreachable when the deposit sheet opens → an honest, plain-language error + a retry
 * hint — no spinner-forever, no crash, no fake address. The gateway seam (__DPAY_TEST_IC_GATEWAY)
 * is retargeted mid-session at a genuinely-dead port (bound + closed), so the signed
 * get_btc_address update dies at ECONNREFUSED — the REAL "network down" failure mode. The relay
 * dies with it (the supplementary depositInfo fetch), and the wallet surface must stay intact.
 */
import {it, expect} from '@jest/globals';
import {
  assert, assertIncludes, goOffline, onboardWallet, openBalances, openReceiveAddress,
  selectCurrency, waitForWallet,
} from '../harness/lib';
import {allowRequestFailuresFrom} from '../harness/setupFlow';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow();

hermeticDescribe('flow 22 — deposit error: dead gateway → honest error, no stuck loading', () => {
  it('the deposit sheet fails fast with plain language and stays out of the loading state', async () => {
    // Onboard online (∂100 funded — proves the wallet works before we break the network).
    const m = await onboardWallet('jest-deposit-err');

    // Kill the IC gateway transport (the deposit ADDRESS critical path): retarget the seam at a
    // genuinely-dead port → ECONNREFUSED. Declared dead up front (the fail-closed teardown rule).
    const deadGateway = await deadOrigin();
    allowRequestFailuresFrom(deadGateway);
    (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY = deadGateway;

    // Also kill the relay (the supplementary depositInfo fetch degrades to "none"/"no minimum",
    // and the wallet surface must stay intact offline).
    await goOffline(m);

    // Balances → select ckBTC → Receive → "My address". The DepositSheet mounts against the dead
    // gateway; the failure surfaces in the inline deposit body.
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    await openReceiveAddress(m);

    // The sheet's query fails fast → the error state renders. H5: plain-language transient copy
    // (dead gateway = ECONNREFUSED → transient), with a plain retry hint and NO dev jargon.
    const errShown = await m.driver.waitForText("Couldn't load your deposit address", {timeoutMs: 10_000});
    const body = m.driver.bodyText();
    assert(errShown, `the deposit sheet should show the plain-language transient error. body excerpt:\n${body.slice(0, 600)}`);
    expect(/relay/i.test(body)).toBe(false);
    assertIncludes(body, 'Check your connection and try again', 'transient error carries a plain retry hint (H5)');

    // Terminal error, not stuck loading: no address/status UI ever rendered.
    expect(m.driver.isPresent('deposit-status')).toBe(false);
    expect(m.driver.isPresent('deposit-address')).toBe(false);

    // The wallet surface is still intact (no crash/blank).
    await waitForWallet(m, {timeoutMs: 4_000});

    await m.unmount();
  }, 90_000);
});

/** Bind :0, close — a port nothing listens on (the REAL unreachable-gateway failure mode). */
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
