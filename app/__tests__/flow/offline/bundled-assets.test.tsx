/**
 * Flow 100 offline-bundled-assets — the jest twin of `e2e/tests/100-offline-bundled-assets.mjs`
 * (batch D port). A dead-relay COLD START (no cached catalog, no balances) still renders the full
 * bundled catalog in the shared asset selector, including the two no-minter native rows with their
 * exact rail labels ("VCHF · Internet Computer" / "ICP · Internet Computer"), and still no ramp
 * actions anywhere in the sheet. Mirrors flow 37's dead-relay onboarding (capability discovery
 * fails closed → no speculative faucet request, wallet reaches $0 home).
 */
import {describe, it, expect} from '@jest/globals';
import {onboardSlowPath, openBalances, waitForWallet} from '../harness/lib';
import {mountApp} from '../harness/mount';

describe('flow 100 — a dead-relay cold start still renders the bundled native rows', () => {
  it('cold boot on a refused relay → bundled CHF + ICP rows offline, no ramp actions', async () => {
    // A port nothing listens on = a relay that refuses every request (flow 37 pattern).
    const deadRelay = await deadOrigin();
    // Declare it with the fail-closed recorder BEFORE any request exists (pre-mount, the teardown
    // hook reads the harness module's allow-set).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {allowRequestFailuresFrom} = require('../harness/setupFlow') as {allowRequestFailuresFrom: (u: string) => void};
    allowRequestFailuresFrom(deadRelay);

    const m = await mountApp({url: `/?relay=${encodeURIComponent(deadRelay)}`});
    try {
      // Manual onboarding (a dead relay advertises no faucet, so none is attempted — the wallet
      // proceeds straight through to the chooser at $0).
      await onboardSlowPath(m, 'jest-cold-assets');
      await waitForWallet(m, {timeoutMs: 8000});

      // Offline indicator (header shows "approx." when online === false).
      expect(await m.driver.waitForText('approx.', {timeoutMs: 6000})).toBe(true);

      // The bundled rows render offline: one row per currency, rail label = token · network.
      await openBalances(m);
      await m.driver.findByTestID('accounts-currency-CHF', {timeoutMs: 6000});
      expect(m.driver.readText('accounts-currency-CHF')).toContain('VCHF · Internet Computer');
      await m.driver.findByTestID('accounts-currency-ICP', {timeoutMs: 6000});
      expect(m.driver.readText('accounts-currency-ICP')).toContain('ICP · Internet Computer');
      expect(m.driver.bodyText()).toContain('Internet Computer');

      // No per-asset ramp actions offline — scoped to the ACCOUNTS LIST, the route the header chip
      // opens (it carries no Add money / Cash out of its own, so a hit can only come from a rail row).
      const sheetBody = m.driver.readText('accounts-list');
      expect(sheetBody).not.toContain('Add money');
      expect(sheetBody).not.toContain('Cash out');
    } finally {
      await m.unmount();
    }
  }, 90_000);
});

/** Bind :0 and close — a port nothing listens on. */
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
