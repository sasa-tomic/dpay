import { describe, test, expect } from '@jest/globals';
import { connectWallet, sendTransaction, getChainId, getEthereumProvider, type Eip1193Provider } from '../wallet';

// A minimal recording Eip1193 provider — same surface the e2e harness mock uses.
function mockProvider(opts: {
  accounts?: string[];
  onSend?: (params: unknown) => void;
  sendResult?: string;
  rejectSend?: string;
}): Eip1193Provider & { calls: { method: string; params?: unknown }[] } {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    calls,
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts') {
        if (opts.rejectSend) throw new Error(opts.rejectSend);
        return opts.accounts ?? [];
      }
      if (method === 'eth_sendTransaction') {
        if (opts.rejectSend) throw new Error(opts.rejectSend);
        const p = (params as unknown[])[0];
        opts.onSend?.(p);
        return opts.sendResult ?? '0xdeadbeef';
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('connectWallet', () => {
  test('eth_requestAccounts returns the first account', async () => {
    const p = mockProvider({ accounts: ['0xabc', '0xdef'] });
    const addr = await connectWallet(p);
    expect(addr).toBe('0xabc');
    expect(p.calls).toEqual([{ method: 'eth_requestAccounts', params: [] }]);
  });

  test('throws when no account is returned', async () => {
    const p = mockProvider({ accounts: [] });
    await expect(connectWallet(p)).rejects.toThrow('no account returned');
  });
});

describe('sendTransaction', () => {
  test('eth_sendTransaction passes from/to/data/value(hex) and returns the hash', async () => {
    let captured: any = null;
    const p = mockProvider({ onSend: (x) => (captured = x), sendResult: '0xhash123' });
    const hash = await sendTransaction(p, '0xfrom', {
      to: '0xhelper',
      data: '0xdb9751af00',
      value: 0n,
    });
    expect(hash).toBe('0xhash123');
    // EIP-1193 shape: one param object with from/to/data/value.
    expect(captured).toEqual({ from: '0xfrom', to: '0xhelper', data: '0xdb9751af00', value: '0x0' });
    expect(p.calls[0]).toEqual({ method: 'eth_sendTransaction', params: [captured] });
  });

  test('a non-zero value encodes as hex', async () => {
    let captured: any = null;
    const p = mockProvider({ onSend: (x) => (captured = x) });
    await sendTransaction(p, '0xfrom', { to: '0xto', data: '0x', value: 1000000n });
    expect(captured.value).toBe('0xf4240'); // 1_000_000 in hex
  });

  test('throws if the wallet returns no hash', async () => {
    const p = mockProvider({ sendResult: '' });
    await expect(sendTransaction(p, '0xfrom', { to: '0xto', data: '0x' })).rejects.toThrow(
      'did not return a transaction hash',
    );
  });

  test('propagates wallet rejection', async () => {
    const p = mockProvider({ rejectSend: 'user rejected' });
    await expect(sendTransaction(p, '0xfrom', { to: '0xto', data: '0x' })).rejects.toThrow('user rejected');
  });
});

describe('getEthereumProvider', () => {
  test('returns null when no window.ethereum is present', () => {
    // The jest env has no window.ethereum by default.
    expect(getEthereumProvider()).toBeNull();
  });

  test('returns the provider when window.ethereum is set', () => {
    const fake = { request: async () => [] };
    (globalThis as { ethereum?: unknown }).ethereum = fake;
    try {
      expect(getEthereumProvider()).toBe(fake);
    } finally {
      delete (globalThis as { ethereum?: unknown }).ethereum;
    }
  });

  test('picks the first of window.ethereum.providers when multiple', () => {
    const a = { request: async () => [] };
    const b = { request: async () => [] };
    (globalThis as { ethereum?: unknown }).ethereum = { request: async () => [], providers: [a, b] };
    try {
      expect(getEthereumProvider()).toBe(a);
    } finally {
      delete (globalThis as { ethereum?: unknown }).ethereum;
    }
  });
});

// --- MC8 U3 — chain-ID enforcement at connect -------------------------------------------------
// The bug: connectWallet only called eth_requestAccounts; the sheet did no eth_chainId check, so a
// wrong-network MetaMask silently broadcast calldata to the wrong chain. getChainId parses the hex
// chain id the wallet reports so the sheet can compare it to the catalog's per-currency chain_id
// (ckUSDC = 1 = Ethereum mainnet) and abort the connect on a mismatch.
describe('getChainId', () => {
  function chainIdProvider(chainId: unknown): Eip1193Provider {
    return {
      request: async ({ method }) => {
        if (method === 'eth_chainId') return chainId;
        throw new Error(`unexpected method ${method}`);
      },
    };
  }

  test('parses "0x1" → 1 (Ethereum mainnet)', async () => {
    expect(await getChainId(chainIdProvider('0x1'))).toBe(1);
  });

  test('parses "0x89" → 137 (Polygon)', async () => {
    expect(await getChainId(chainIdProvider('0x89'))).toBe(137);
  });

  test('parses "0xa" → 10 (Optimism)', async () => {
    expect(await getChainId(chainIdProvider('0xa'))).toBe(10);
  });

  test('parses "0x0" → 0', async () => {
    expect(await getChainId(chainIdProvider('0x0'))).toBe(0);
  });

  test('rejects a non-hex string', async () => {
    await expect(getChainId(chainIdProvider('0xnothex'))).rejects.toThrow();
  });

  test('rejects a missing 0x prefix', async () => {
    await expect(getChainId(chainIdProvider('1'))).rejects.toThrow();
  });

  test('rejects a non-string result (null)', async () => {
    await expect(getChainId(chainIdProvider(null))).rejects.toThrow();
  });

  test('rejects an empty string', async () => {
    await expect(getChainId(chainIdProvider(''))).rejects.toThrow();
  });
});
