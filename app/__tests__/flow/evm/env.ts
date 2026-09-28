/**
 * The EVM module environment for batch-D flow files. The EVM rail is VISIBILITY-gated on a
 * configured endpoint (`isEvmRailConfigured` — the rail does not render under jest until a seam
 * URL exists, D11), and `__DPAY_TEST_EVM_RPC_URL` is captured at `app/evm/endpoints.ts` MODULE
 * LOAD while every `../harness/lib` import pulls the whole app graph statically — so the override
 * must be set before the first lib require. `evmEnv()` does exactly that: it binds a :0 port
 * (nothing listens), points the seam there, declares the dead origin with the fail-closed fetch
 * recorder (the balance/gas polls refuse against it — honest offline rows), and requires lib
 * lazily. The anvil pipe URL is NOT wanted in jest (no chain); the node-anvil recipe owns that.
 */
import type {Mount} from '../harness/lib';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

let libRef: typeof import('../harness/lib') | null = null;

export async function evmEnv(): Promise<typeof import('../harness/lib')> {
  if (libRef == null) {
    const dead = await deadOrigin();
    g.__DPAY_TEST_EVM_RPC_URL = dead;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {allowRequestFailuresFrom} = require('../harness/setupFlow') as {allowRequestFailuresFrom: (u: string) => void};
    allowRequestFailuresFrom(dead);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    libRef = require('../harness/lib') as typeof import('../harness/lib');
  }
  return libRef;
}

export type {Mount};

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
