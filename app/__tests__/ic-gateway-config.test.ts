/**
 * The IC gateway slot (`config/constants.ts`) — F2: the operator override for the IC /api/v2 base.
 *
 * WHY THE OVERRIDE EXISTS. Until 2026-09-12 the app's IC gateway was hardwired to icp-api.io; the
 * only redirect was the e2e-only `__DPAY_TEST_IC_GATEWAY` seam, so a phone could not target a
 * local replica even when the demo relay's catalog already pointed at it (OPEN_ISSUES demo
 * bullet, F2 — the measured `just demo` break of 2026-09-07). This slot is the twin of the Solana
 * endpoint override (R2, 2026-09-10) with ONE deliberate simplification: the Solana default is an
 * ordered walk derived from the relay list, while the IC gateway is a SINGLE base — if the
 * operator sets it, that URL IS the /api/v2 base.
 *
 * Precedence: operator #1 → `__DPAY_TEST_IC_GATEWAY` #2 → 'https://icp-api.io'. The seam keeps
 * working (compose, don't replace) but a demo drive owns the machine, so the operator wins.
 * Validation mirrors the SOL twin's https-for-public-hosts rule with the one extension its own
 * purpose needs: plain http is accepted for LOCAL addresses only (the emulator→host loopback
 * `http://10.0.2.2:4943` is the demo's actual shape).
 */
import {beforeEach, describe, expect, jest, test, afterEach} from '@jest/globals';

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
import {IC_GATEWAY_DEFAULT, IC_GATEWAY_STORAGE_KEY, icGatewayUrl, setIcGatewayUrl} from '../config/constants';
import {icSubmit} from '../services/icp';

const G = globalThis as unknown as {__DPAY_TEST_IC_GATEWAY?: string};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchWithTimeout).mockResolvedValue({ok: true, status: 202} as never);
});

afterEach(() => {
  setIcGatewayUrl(''); // back to the default — this module state is global
  delete G.__DPAY_TEST_IC_GATEWAY;
});

describe('icGatewayUrl — precedence: operator #1, seam #2, default #3', () => {
  test('the default is the IC boundary, not any dpay origin', () => {
    expect(IC_GATEWAY_DEFAULT).toBe('https://icp-api.io');
    expect(IC_GATEWAY_DEFAULT).not.toMatch(/kalaj|dpay|relay/i);
    expect(icGatewayUrl()).toBe('https://icp-api.io');
  });

  test('the seam redirects the base — read PER CALL, so a mid-session flip is honored at once', () => {
    G.__DPAY_TEST_IC_GATEWAY = 'https://ic-boundary.test';
    expect(icGatewayUrl()).toBe('https://ic-boundary.test');
    delete G.__DPAY_TEST_IC_GATEWAY;
    expect(icGatewayUrl()).toBe('https://icp-api.io');
  });

  test('the operator override wins over the seam — and clearing it leaves the seam standing (compose, don’t replace)', () => {
    G.__DPAY_TEST_IC_GATEWAY = 'https://ic-boundary.test';
    setIcGatewayUrl('http://10.0.2.2:4943');
    expect(icGatewayUrl()).toBe('http://10.0.2.2:4943');
    setIcGatewayUrl(''); // '' clears the OPERATOR slot only — the e2e seam is untouched
    expect(icGatewayUrl()).toBe('https://ic-boundary.test');
  });

  test('the stored value is trimmed and trailing slashes are stripped — one clean base', () => {
    setIcGatewayUrl('   http://10.0.2.2:4943/   ');
    expect(icGatewayUrl()).toBe('http://10.0.2.2:4943');
    setIcGatewayUrl('https://gateway.example///');
    expect(icGatewayUrl()).toBe('https://gateway.example');
  });

  test('the AsyncStorage contract is pinned — the boot read and the Settings write share this key', () => {
    expect(IC_GATEWAY_STORAGE_KEY).toBe('dpay.icpGateway.v1');
  });
});

describe('setIcGatewayUrl — validation (https for public hosts; plain http only for local)', () => {
  test('an https URL is accepted anywhere', () => {
    setIcGatewayUrl('https://gateway.example');
    expect(icGatewayUrl()).toBe('https://gateway.example');
  });

  test('plain http on a PUBLIC host is refused, naming the rule — a rewriteable transport lies about balances', () => {
    expect(() => setIcGatewayUrl('http://icp-api.example')).toThrow(/https:\/\//);
    expect(() => setIcGatewayUrl('http://172.32.0.1:4943')).toThrow(/https:\/\//); // outside 172.16–31
    // A refusal changes nothing: the previous base still stands.
    expect(icGatewayUrl()).toBe('https://icp-api.io');
  });

  test('plain http on a LOCAL host is accepted — the emulator→host loopback is the demo’s actual shape', () => {
    for (const local of ['http://localhost:4943', 'http://127.0.0.1:4943', 'http://10.0.2.2:4943', 'http://192.168.1.10:8080', 'http://172.16.0.5', 'http://172.31.255.1', 'http://[::1]:4943', 'http://replica.localhost:4943']) {
      setIcGatewayUrl(local);
      expect(icGatewayUrl()).toBe(local);
      setIcGatewayUrl('');
    }
  });

  test('a value that is not a URL is refused with an instruction, not a stack trace', () => {
    expect(() => setIcGatewayUrl('10.0.2.2:4943')).toThrow(/Not a valid URL/);
    expect(icGatewayUrl()).toBe('https://icp-api.io');
  });
});

describe('the SEAM — one source of truth, proven by where the POST goes', () => {
  test('submissions go to the OPERATOR base, not the default the module booted with', async () => {
    setIcGatewayUrl('http://10.0.2.2:4943');
    const outcome = await icSubmit('rrkah-fqaaa-aaaaa-aaaaq-cai', 'call', '00ff', 1_000);
    expect(outcome).toEqual({kind: 'accepted'});
    const url = jest.mocked(fetchWithTimeout).mock.calls[0]![0] as string;
    expect(url.startsWith('http://10.0.2.2:4943/api/v2/canister/')).toBe(true);
    expect(url).not.toContain('icp-api.io');
  });
});
