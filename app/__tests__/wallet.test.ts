import { describe, test, expect, jest } from '@jest/globals';
import {
  connectWallet, sendTransaction, getChainId, waitForReceipt,
  ReceiptReverted, TransactionHashMissing, getEthereumProvider, resolveOnrampProvider, pairOnrampWallet,
  openWalletApp,
  type Eip1193Provider,
} from '../wallet';

// MC8 U6.2 — sentinel mock for the WalletConnect source. `resolveOnrampProvider()` is WEB-FIRST: it
// returns `window.ethereum` before ever reaching the WC branch, so this rejecting sentinel PROVES
// the web-first path never touches WalletConnect (a call would reject and fail the test). The
// native-delegation tests re-wire this to resolve a fake inside their `jest.isolateModules` block.
// `pairOnrampWallet` is also wired here as a rejecting sentinel for the same reason.
jest.mock('../walletconnect', () => ({
  getWalletConnectProvider: jest.fn(() =>
    Promise.reject(new Error('WalletConnect must not be reached on the web-first path')),
  ),
  pairWalletConnect: jest.fn(() =>
    Promise.reject(new Error('pairWalletConnect must not be reached on the web-first path')),
  ),
  openWalletApp: jest.fn(() =>
    Promise.reject(new Error('openWalletApp must not be reached on the web-first path')),
  ),
}));

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

  // An ACCEPTED send that answers without a hash is not a failed send — the wallet may have
  // broadcast it and only the id is lost. Typed so the caller can say that instead of "not sent",
  // which would invite depositing the same money twice. The value that came back is named, because
  // an empty string and a null are different wallet bugs.
  test('an accepted send with no hash throws TransactionHashMissing, naming what came back', async () => {
    const p = mockProvider({ sendResult: '' });
    try {
      await sendTransaction(p, '0xfrom', { to: '0xto', data: '0x' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TransactionHashMissing);
      expect((e as TransactionHashMissing).received).toBe('""');
    }
  });

  test('propagates wallet rejection, and it is NOT a TransactionHashMissing', async () => {
    const p = mockProvider({ rejectSend: 'user rejected' });
    // The caller branches on the type; a decline and a lost hash must never collapse into one.
    await expect(sendTransaction(p, '0xfrom', { to: '0xto', data: '0x' })).rejects.toThrow('user rejected');
    await expect(sendTransaction(p, '0xfrom', { to: '0xto', data: '0x' })).rejects.not.toBeInstanceOf(
      TransactionHashMissing,
    );
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

  // The OTHER encoding. WalletConnect answers eth_chainId locally as a plain NUMBER (the SDK
  // evidence is quoted at getChainId); every mock here — and in the deposit-sheet suite — spoke the
  // injected-wallet dialect ('0x1'), which is exactly how a hex-ONLY parse shipped and then threw
  // on every single WalletConnect connect, wedging the sheet on its Connect button.
  test('parses a plain number 11155111 → 11155111 (the WalletConnect encoding, Sepolia)', async () => {
    expect(await getChainId(chainIdProvider(11155111))).toBe(11155111);
  });

  test('rejects a fractional number, naming the value received', async () => {
    await expect(getChainId(chainIdProvider(1.5))).rejects.toThrow('1.5');
  });

  test('rejects a negative number', async () => {
    await expect(getChainId(chainIdProvider(-1))).rejects.toThrow();
  });

  test('rejects NaN and names it readably (JSON would render it as "null")', async () => {
    await expect(getChainId(chainIdProvider(Number.NaN))).rejects.toThrow('NaN');
  });

  test('rejects an integer beyond the safe range (parsed back it would be a different chain)', async () => {
    await expect(getChainId(chainIdProvider(Number.MAX_SAFE_INTEGER + 1))).rejects.toThrow();
  });
});

// --- the WalletConnect transport's LOCALLY-answered methods -----------------------------------
// Over WalletConnect the eip155 provider answers eth_requestAccounts / eth_accounts / eth_chainId
// ITSELF, from the settled session and from what dpay requested at init — no wallet round-trip (the
// SDK evidence is quoted at getChainId in wallet.ts). This models that dialect so the connect
// sequence the deposit sheet runs is exercised against BOTH transports, not just the injected one.
describe('the connect sequence over a WalletConnect-dialect provider', () => {
  function walletConnectProvider(chainId: number, accounts: string[]): Eip1193Provider {
    return {
      request: async ({ method }) => {
        // Answered from the settled session — the wallet is never prompted.
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts;
        // A plain NUMBER, not a hex string.
        if (method === 'eth_chainId') return parseInt(String(chainId), 10);
        throw new Error(`unexpected method ${method}`);
      },
    };
  }

  test('connectWallet then getChainId both succeed (the deposit sheet aborted here before)', async () => {
    const p = walletConnectProvider(1, ['0xb0bfeed', '0xsecond']);
    expect(await connectWallet(p)).toBe('0xb0bfeed');
    expect(await getChainId(p)).toBe(1);
  });
});

// --- MC8 U4 — wait for ETH receipts/reverts ---------------------------------------------------
// The bug: sendTransaction returned the tx hash on eth_sendTransaction accept (NOT mined), and the
// sheet unconditionally setPhase('watching') → a REVERTED approve/deposit lied as "will appear in
// ~20 min" (never credits). waitForReceipt polls eth_getTransactionReceipt until mined; a 0x0 status
// throws a typed ReceiptReverted (caller surfaces an honest error) and a no-receipt timeout throws a
// plain Error the caller treats SOFT — keeps watching. This pins that one-typed-error contract.
describe('waitForReceipt', () => {
  // A provider whose eth_getTransactionReceipt responses are driven by a per-call function (so a test
  // can return null for N polls then a receipt, or always null to drive the timeout).
  function receiptProvider(getReceipt: (call: number) => unknown): Eip1193Provider {
    let calls = 0;
    return {
      request: async ({ method }) => {
        if (method === 'eth_getTransactionReceipt') {
          const r = getReceipt(calls);
          calls++;
          return r;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
  }

  test('a mined receipt (status 0x1) → {status:1}', async () => {
    const p = receiptProvider(() => ({ status: '0x1', gasUsed: '0x5208' }));
    const r = await waitForReceipt(p, '0xhash', { timeoutMs: 1000, pollMs: 5 });
    expect(r.status).toBe(1);
    expect(r.gasUsed).toBe('0x5208');
  });

  test('returns {status:1} after a few null polls (mined on the Nth)', async () => {
    const p = receiptProvider((n) => (n < 3 ? null : { status: '0x1' }));
    const r = await waitForReceipt(p, '0xhash', { timeoutMs: 5000, pollMs: 5 });
    expect(r.status).toBe(1);
  });

  test('a reverted receipt (status 0x0) → throws ReceiptReverted', async () => {
    const p = receiptProvider(() => ({ status: '0x0' }));
    await expect(waitForReceipt(p, '0xhash', { timeoutMs: 1000, pollMs: 5 })).rejects.toBeInstanceOf(
      ReceiptReverted,
    );
  });

  // A timeout stays a PLAIN Error: the caller's only receipt branch is "reverted vs not", because a
  // timed-out poll and a poll whose RPC read threw leave it in the identical position. What must
  // hold is that a timeout does not answer that branch — and that it still names itself.
  test('no receipt for the full timeout → throws a plain Error naming the timeout, NOT a ReceiptReverted', async () => {
    const p = receiptProvider(() => null);
    try {
      await waitForReceipt(p, '0xhash', { timeoutMs: 60, pollMs: 10 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(ReceiptReverted);
      expect((e as Error).message).toContain('0xhash');
      expect((e as Error).message).toContain('not mined within the timeout');
    }
  });

  test('the reverted error carries the hash', async () => {
    const p = receiptProvider(() => ({ status: '0x0' }));
    try {
      await waitForReceipt(p, '0xdeadbeef', { timeoutMs: 200, pollMs: 5 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ReceiptReverted);
      expect((e as ReceiptReverted).hash).toBe('0xdeadbeef');
    }
  });
});

// --- MC8 U6.2 — resolveOnrampProvider (web-first source picker) --------------------------------
// The resolver picks the EIP-1193 provider SOURCE: window.ethereum first (the browser path + the
// e2e mock provider flow 16 installs), else WalletConnect on native when configured. The web-first
// ordering is load-bearing — it GUARANTEES flow 16 + the web browser path return window.ethereum
// unchanged and never reach WalletConnect, so the offline inner loop stays free of WC execution.
describe('resolveOnrampProvider', () => {
  test('web-first: returns window.ethereum when present and NEVER reaches WalletConnect', async () => {
    const fake = {request: async () => []};
    (globalThis as {ethereum?: unknown}).ethereum = fake;
    try {
      const result = await resolveOnrampProvider();
      expect(result).toBe(fake);
      // The rejecting sentinel mock would fail the test if the WC branch were ever reached.
      const wc = require('../walletconnect');
      expect(wc.getWalletConnectProvider).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as {ethereum?: unknown}).ethereum;
    }
  });

  test('returns null when no web provider and WalletConnect disabled (empty projectId)', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    // MC8 U6 capstone: constants.ts now defaults to the REAL project id, so SET '' to disable WC
    // (deleting would fall through to the real id). jest.setup.js does this globally; this is the
    // per-test explicit pin.
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    // The top-level wallet.ts import captured projectId='' (jest.setup.js global) → the WC branch's
    // `&& WALLETCONNECT_PROJECT_ID` short-circuits → null (no onramp source).
    const result = await resolveOnrampProvider();
    expect(result).toBeNull();
  });

  test('native + projectId set → delegates to the WalletConnect source', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    const FAKE = {request: async () => '0x1'} as unknown as Eip1193Provider;
    // Reload wallet.ts with a non-empty projectId (captured at module-load), and re-wire the WC
    // mock to resolve the fake. resolveOnrampProvider is FIRED inside isolateModules so the dynamic
    // `import('./walletconnect')` resolves against the isolated registry (the require runs
    // synchronously up to the first await), then awaited outside.
    let pending!: Promise<Eip1193Provider | null>;
    jest.isolateModules(() => {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID =
        'test-project-id';
      require('../walletconnect').getWalletConnectProvider = jest.fn(async () => FAKE);
      pending = require('../wallet').resolveOnrampProvider();
    });
    try {
      const result = await pending;
      expect(result).toBe(FAKE);
    } finally {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    }
  });
});

// --- MC8 U6 capstone — pairOnrampWallet (dynamic-import boundary for pairing) ----------------
// `pairOnrampWallet(onUri)` is the ISOLATION-BOUNDARY wrapper around `pairWalletConnect` (the sheet
// imports ONLY from wallet.ts, never statically from walletconnect.ts). Web-first / disabled → false
// (no dynamic import); native + configured → delegates to the dynamically-imported pairWalletConnect.
// The rejecting sentinel mock (top of file) PROVES the web path never reaches pairWalletConnect.
describe('pairOnrampWallet', () => {
  test('web-first: returns false and NEVER reaches WalletConnect (no window.ethereum needed)', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    const result = await pairOnrampWallet(jest.fn());
    expect(result).toBe(false);
    // The rejecting sentinel mock would fail the test if the WC branch were ever reached.
    const wc = require('../walletconnect');
    expect(wc.pairWalletConnect).not.toHaveBeenCalled();
  });

  test('disabled (empty projectId) → returns false and never reaches WalletConnect', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    const result = await pairOnrampWallet(jest.fn());
    expect(result).toBe(false);
  });

  test('native + projectId set → delegates to pairWalletConnect and returns true', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    const onUriStub = jest.fn();
    let pending!: Promise<boolean>;
    jest.isolateModules(() => {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID =
        'test-project-id';
      // Re-wire the WC mock to resolve (the sentinel rejects); the delegation path must call it.
      require('../walletconnect').pairWalletConnect = jest.fn(async () => undefined);
      pending = require('../wallet').pairOnrampWallet(onUriStub);
    });
    try {
      const result = await pending;
      expect(result).toBe(true);
      const wc = require('../walletconnect');
      // OPEN_ISSUES #1/#2: pairOnrampWallet threads chainId (default 1 = mainnet) into pairWalletConnect.
      expect(wc.pairWalletConnect).toHaveBeenCalledWith(onUriStub, 1);
    } finally {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    }
  });
});

// --- openWalletApp (dynamic-import boundary for same-device pairing) -------------------------
// `openWalletApp(uri)` mirrors pairOnrampWallet's isolation boundary: web-first / disabled → false
// (no dynamic import); native + configured → delegates to walletconnect.ts's openWalletApp.
describe('openWalletApp', () => {
  test('web-first: returns false and NEVER reaches WalletConnect', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    const result = await openWalletApp('wc:test');
    expect(result).toBe(false);
    const wc = require('../walletconnect');
    expect(wc.openWalletApp).not.toHaveBeenCalled();
  });

  test('disabled (empty projectId) → returns false and never reaches WalletConnect', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    const result = await openWalletApp('wc:test');
    expect(result).toBe(false);
  });

  test('native + projectId set → delegates to walletconnect openWalletApp', async () => {
    delete (globalThis as {ethereum?: unknown}).ethereum;
    let pending!: Promise<boolean>;
    jest.isolateModules(() => {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID =
        'test-project-id';
      require('../walletconnect').openWalletApp = jest.fn(async () => true);
      pending = require('../wallet').openWalletApp('wc:delegate');
    });
    try {
      const result = await pending;
      expect(result).toBe(true);
      const wc = require('../walletconnect');
      expect(wc.openWalletApp).toHaveBeenCalledWith('wc:delegate');
    } finally {
      (globalThis as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID = '';
    }
  });
});
