/**
 * INV-9 (multi-venue readiness V9) — the transport half: no value-bearing submission ever
 * traverses a dpay-hosted origin. `services/icp.ts` `postEnvelope` is the ONLY submit transport
 * in the app (the rail and both convert legs go through it), and it derives its origin from the
 * IC boundary base — `IC_GATEWAY_DEFAULT` or the `__DPAY_TEST_IC_GATEWAY` seam — never from a
 * relay URL. The executor half (which canister each convert leg targets) is pinned in
 * `venueInvariants.test.ts`; this file pins where the bytes actually go.
 */
import {beforeEach, describe, expect, jest, test} from '@jest/globals';

jest.mock('../services/relay', () => ({relayFetch: jest.fn(), fetchWithTimeout: jest.fn()}));
jest.mock('../services/native', () => ({
  DpayCore: {
    icpSwapMinOut: jest.fn(),
    icpApproveArg: jest.fn(),
    icpDepositAndSwapArg: jest.fn(),
    icpSignUpdate: jest.fn(),
    icpPrincipalFromPubkey: jest.fn(),
  },
}));

import {fetchWithTimeout} from '../services/relay';
import {IC_GATEWAY_DEFAULT, icSubmit} from '../services/icp';
import {BUNDLED_VENUES, DPAY_CANISTER_PRINCIPALS} from '../config/venues';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

const BUNDLED = icpCatalogOf(BUNDLED_NETWORKS);
const ICP_LEDGER = BUNDLED.find(c => c.currency === 8)!.ledger;
const VCHF_LEDGER = BUNDLED.find(c => c.currency === 7)!.ledger;
const POOL_A = BUNDLED_VENUES.find(v => v.kind === 'ic_amm' && !v.testnet)!.endpoint;
const POOL_B = '6st72-zyqce-jbgfa-vcylr-qgi2d-mob2h-q7'; // fixture B, as the offline relay serves it

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchWithTimeout).mockResolvedValue({ok: true, status: 202} as never);
});

describe('the IC gateway default is the IC boundary, not any dpay origin', () => {
  test('IC_GATEWAY_DEFAULT is icp-api.io — no dpay/relay host anywhere in it', () => {
    expect(IC_GATEWAY_DEFAULT).toBe('https://icp-api.io');
    expect(IC_GATEWAY_DEFAULT).not.toMatch(/kalaj|dpay|relay/i);
  });
});

describe('icSubmit posts every canister call to <IC boundary>/api/v2/canister/<canister>/<kind>', () => {
  // Every canister a conversion or payment leg could name: the traded ledgers, every registered
  // pool, the offline fixture pool, and (as the control) even the dpay principals — the
  // TRANSPORT is principal-agnostic by design; refusing those targets is INV-1's job, done at
  // the signing boundary before anything reaches here.
  const TARGETS = [ICP_LEDGER, VCHF_LEDGER, POOL_A, POOL_B, ...DPAY_CANISTER_PRINCIPALS];

  test.each(TARGETS)('%s', async canister => {
    (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY = 'https://ic-boundary.test';
    try {
      const outcome = await icSubmit(canister, 'call', '00ff', 1_000);
      expect(outcome).toEqual({kind: 'accepted'});
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      const url = jest.mocked(fetchWithTimeout).mock.calls[0]![0] as string;
      expect(url).toBe(`https://ic-boundary.test/api/v2/canister/${canister}/call`);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_IC_GATEWAY;
    }
  });

  test('without the seam the same derivation lands on the production boundary', async () => {
    await icSubmit(POOL_A, 'call', '00ff', 1_000);
    const url = jest.mocked(fetchWithTimeout).mock.calls[0]![0] as string;
    expect(url.startsWith(`${IC_GATEWAY_DEFAULT}/api/v2/canister/`)).toBe(true);
    expect(url.endsWith('/call')).toBe(true);
  });
});
