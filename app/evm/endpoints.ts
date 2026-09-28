// The EVM JSON-RPC endpoint machinery — the `solanaRpcUrls()` machinery in config/constants.ts,
// mirrored module-for-module but PURE and EVM-scoped (this file imports nothing).
//
// Why a separate module and not constants.ts: the EVM endpoint is PER CHAIN (one JSON-RPC
// upstream serves ONE chain — spec 2026-09-26 D12), so the resolver takes a chainId, and the
// derivation composes the relay's chain-multiplexed route per call. It stays a pure module so
// the seam `app/evm.ts` can statically import it (the empty-URL gate must run BEFORE the network
// module is ever imported — the offline inner loop never loads it).
//
// The precedence, top wins (the `solanaRpcUrls` pattern verbatim):
//   1. the OPERATOR override — `setEvmRpcUrl`, persisted under EVM_RPC_STORAGE_KEY
//      (Settings ▸ Advanced, next wave), read at boot. PER DEVICE, not per chain (D11): the
//      operator chose ONE endpoint and removed dpay's relay from the path entirely — a single
//      candidate for every chain, nothing to walk. `''` CLEARS it (follow the relay again,
//      never an offline switch). The wrong-chain guard (D10/D12) is what keeps a one-chain
//      override honest on a multi-chain wallet: asking it for a chain it does not serve refuses
//      loudly instead of answering from the wrong ledger.
//   2. the TEST override — `__DPAY_TEST_EVM_RPC_URL` captured at module load exactly as the SOL
//      test override is (jest.setup.js sets `''` — the rail is OFF for the offline inner loop;
//      the e2e driver injects `''` or the harness relay's pipe URL, or DELETES it for the
//      relay-derived path). Single candidate; the offline loop's isolation contract.
//   3. the relay-derived list — every active relay base + the route: chain 1 uses the BARE
//      `POST /api/v1/evm/rpc` (which IS chain 1 per D12, so the relay's default-upstream env
//      `DPAY_EVM_RPC_URL` serves it); every other chain uses the per-chain suffix
//      `POST /api/v1/evm/rpc/{chainId}` → upstream `DPAY_EVM_RPC_URL_<CHAINID>`.

/** The relay route every EVM JSON-RPC call is proxied through when no operator override is set.
 *  The fixed contract the relay serves (crates/dpay-relay/src/evm.rs); chain 1 is the bare
 *  route, every other chain appends `/{chainId}`. Exported for the config pins in the tests. */
export const EVM_RPC_PROXY_PATH = '/api/v1/evm/rpc';

/** Where the operator's chosen endpoint persists. Same AsyncStorage pattern as identity/relay
 *  and the SOL rail's `dpay.solanaRpc.v1`. */
export const EVM_RPC_STORAGE_KEY = 'dpay.evmRpc.v1';

/** How long the send path may wait for the network module to load (the seam's
 *  `loadEvmRpcForSend` races the dynamic import against this). The SOL value's rationale
 *  carries verbatim: the network module is a lazy chunk in the served web build, a module load
 *  carries no abort signal, and a stalled chunk must fail into honest, actionable copy instead
 *  of hanging a send for the caller's whole deadline. */
export const EVM_RPC_IMPORT_DEADLINE_MS = 10000;

const TEST_OVERRIDE: string | undefined =
  (globalThis as unknown as {__DPAY_TEST_EVM_RPC_URL?: string}).__DPAY_TEST_EVM_RPC_URL;

// null = no operator choice — the test override / relay-derived default resolves the endpoint.
let operatorEvmRpc: string | null = null;

// The relay bases the default derivation derives from, in walk order. WALLET_ORIGIN is the
// PRE-WIRING fallback only: App.tsx calls `setRelayBaseForEvm` with the live relay list (the
// R1 list) at mount and on every change — the `setRelayBaseForSolana` wiring, EVM twin, next
// wave. Before that wiring the list is the same default the shipped relay list resolves to.
let relayBasesForEvm: string[] = ['https://dpay.kalaj.org'];

/** Normalize one relay base: trimmed, trailing `/`s stripped. */
function normalizedBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/**
 * The CANDIDATE LIST for `chainId`'s JSON-RPC calls, in order. A function, not a constant,
 * because every input changes after module load (the operator's choice from storage or
 * Settings, the relay bases from the App-installed list). Call it per use.
 */
export function evmRpcUrls(chainId: number): string[] {
  if (operatorEvmRpc !== null) return [operatorEvmRpc];
  if (TEST_OVERRIDE !== undefined) return [TEST_OVERRIDE];
  return relayBasesForEvm.map((base) =>
    chainId === 1 ? `${base}${EVM_RPC_PROXY_PATH}` : `${base}${EVM_RPC_PROXY_PATH}/${chainId}`,
  );
}

/** The endpoint for `chainId` RIGHT NOW: the HEAD of the candidate list — the one availability
 *  checks read. The walk itself lives in `evm/rpc.ts` over `evmRpcUrls(chainId)`. */
export function evmRpcUrl(chainId: number): string {
  return evmRpcUrls(chainId)[0] ?? '';
}

/** Re-point the DERIVED default list at the ACTIVE relay bases (the `setRelayBaseForSolana`
 *  mirror). Accepts one base or the whole list; empty/duplicate entries are dropped, trailing
 *  slashes stripped. An operator's explicit endpoint always wins over this. */
export function setRelayBaseForEvm(base: string | readonly string[]): void {
  const input = typeof base === 'string' ? [base] : base;
  const bases: string[] = [];
  for (const entry of input) {
    const trimmed = normalizedBase(entry);
    if (trimmed === '' || bases.includes(trimmed)) continue;
    bases.push(trimmed);
  }
  if (bases.length === 0) return;
  relayBasesForEvm = bases;
}

/** Is this host loopback or RFC1918 private space? Plain-http endpoints are accepted ONLY for
 *  these — the local-anvil/e2e case (`http://127.0.0.1:8545`). A PUBLIC host must be https:
 *  an endpoint on the value path can lie about a balance or a chain id, and plain http can be
 *  read and rewritten in transit. (The IC gateway override's rule, `setIcGatewayUrl`.) */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Point this device at a different EVM endpoint (ALL chains — the override is per device).
 * `''` clears the choice: the wallet follows the relay-derived default again.
 *
 * THROWS, with an actionable message, on anything it will not accept: a non-URL, or a non-https
 * URL on a PUBLIC host (plain http is accepted for loopback/RFC1918 — the local-anvil demo
 * case, where the transit concern does not apply). No cluster-shape refusal: EVM has no
 * genesis-hash analog to check here; the wrong-chain guard (`eth_chainId`, D10/D12) is the
 * fail-closed check, run against the live endpoint before anything is spent.
 */
export function setEvmRpcUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    operatorEvmRpc = null;
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: "${trimmed}". Paste the full endpoint, including https://`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) {
    throw new Error(
      `The EVM endpoint must start with https:// (got "${parsed.protocol}//"). Plain http is ` +
        `accepted only for local addresses, e.g. a local anvil at http://127.0.0.1:8545`,
    );
  }
  operatorEvmRpc = trimmed;
}
