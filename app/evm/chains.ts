// The EVM chain + token registry — the extension point for the rail: a new ERC-20 is an entry
// here (plus a catalog row, owned by the catalog module). PURE module — records and a mutable
// dev-token hook, no fetch.
//
// MAINNET token addresses are pinned here because they are public, permanent facts. TESTNET /
// anvil mock token addresses are NOT baked into source: they are injected at runtime by the e2e
// driver via `setEvmDevToken()` (the EVM twin of the `__DPAY_TEST_SOLANA_RPC_URL` seam in
// config/constants.ts — a test/dev-only override read at the last responsible moment, empty in
// prod builds where nothing sets it).

export type EvmChainId = 42161 | 1 | 421614 | 31337;

export interface EvmChain {
  readonly id: EvmChainId;
  /** Human chain name (UI surfaces that name the network). */
  readonly name: string;
  /** Relay path that proxies this chain's JSON-RPC (the app never holds an RPC vendor URL). */
  readonly rpcViaRelay: string;
  /** Block explorer base URL for tx/address links; null on the dev chain (nothing to link to). */
  readonly explorer: string | null;
  /** Native asset ticker paying gas on this chain. */
  readonly nativeSymbol: string;
}

export const EVM_CHAINS: Record<EvmChainId, EvmChain> = {
  42161: {
    id: 42161,
    name: 'Arbitrum One',
    rpcViaRelay: '/api/v1/evm/rpc',
    explorer: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
  },
  1: {
    id: 1,
    name: 'Ethereum',
    rpcViaRelay: '/api/v1/evm/rpc',
    explorer: 'https://etherscan.io',
    nativeSymbol: 'ETH',
  },
  421614: {
    id: 421614,
    name: 'Arbitrum Sepolia',
    rpcViaRelay: '/api/v1/evm/rpc',
    explorer: 'https://sepolia.arbiscan.io',
    nativeSymbol: 'ETH',
  },
  31337: {
    id: 31337,
    name: 'dpay-anvil',
    rpcViaRelay: '/api/v1/evm/rpc',
    explorer: null,
    nativeSymbol: 'ETH',
  },
};

/** ZCHF (Frankencoin) deployments per chain. Absent key = no mainnet deployment there. */
export const ZCHF_TOKEN: Partial<Record<EvmChainId, string>> = {
  42161: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553',
  1: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
};

/** ZCHF (like every ERC-20 here) carries 18 decimals. Centralised so callers never hard-code it. */
export const ZCHF_DECIMALS = 18;

/** A dev/testnet token override: the chain whose mock token address to swap, and that address. */
export interface EvmTokenOverride {
  readonly chainId: EvmChainId;
  readonly address: string;
}

// Mutable ONLY through setEvmDevToken/clearEvmDevToken below. Module-level (not a globalThis
// global) because the only writer is the e2e driver in-process; nothing native crosses it.
let devTokenOverride: EvmTokenOverride | null = null;

/** Inject the dev/testnet mock token for `chainId` (e2e driver / dev builds only). Pure state —
 *  takes effect on the next `evmZchfToken()` read, no network, no notifications. */
export function setEvmDevToken(override: EvmTokenOverride): void {
  devTokenOverride = override;
}

/** Drop the dev-token override — back to the pinned mainnet registry. */
export function clearEvmDevToken(): void {
  devTokenOverride = null;
}

/** The dev override for a chain, if one is set. */
export function evmDevToken(chainId: EvmChainId): string | null {
  return devTokenOverride?.chainId === chainId ? devTokenOverride.address : null;
}

/** The ZCHF token address on `chainId`: the dev override wins, else the pinned mainnet address,
 *  else null (the caller hides the asset — a chain without ZCHF has nothing to list). */
export function evmZchfToken(chainId: EvmChainId): string | null {
  return evmDevToken(chainId) ?? ZCHF_TOKEN[chainId] ?? null;
}

// ---------------------------------------------------------------------------
// Base-unit conversion — exact BigInt, self-contained.
//
// lib/amount.ts's parseDecimalToUnits is NOT reused here on purpose: it is the parity-pinned
// mirror of the Rust core's u64 wire parser (raw amounts > u64::MAX are a protocol error on the
// IC rail), while ERC-20 amounts are uint256 and routinely exceed it. The two never meet — an
// EVM amount string is converted here, and only its raw string crosses to the wire — so the EVM
// rail carries its own exact conversion rather than importing the u64 bound.
// ---------------------------------------------------------------------------

/** "1.5" (18 decimals) → 1500000000000000000n. Exact BigInt; throws on a malformed or
 *  over-precise amount (a bad amount is a caller bug, not a silent 0). */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const t = amount.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) throw new Error(`not a decimal amount: "${amount}"`);
  const [whole, frac = ''] = t.split('.');
  if (frac.length > decimals) {
    throw new Error(`amount "${amount}" has more than ${decimals} decimals`);
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** 1500000000000000000n (18 decimals) → "1.5" — the shortest exact decimal string. */
export function fromBaseUnits(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new Error('raw amount must be non-negative');
  let scale = 1n;
  for (let i = 0; i < decimals; i++) scale *= 10n;
  const whole = raw / scale;
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac.length === 0 ? whole.toString() : `${whole}.${frac}`;
}
