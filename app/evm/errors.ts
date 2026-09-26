// EVM RPC error shapes + classification. PURE (no fetch, no react-native, no globals) so the
// offline seam branches on them without importing the network module — the `solana/errors.ts`
// precedent, module for module.
//
// Two DIFFERENT failures ride the relay pipe and must never be collapsed (spec 2026-09-26 D10,
// mirroring the SOL rail's taxonomy):
//   • EvmEndpointRefused — the endpoint ANSWERED and did not serve us (HTTP status or a JSON-RPC
//     `error` object). This device is online and the RAIL is what refused.
//   • EvmRelayPathDown   — the RELAY answered HTTP but its EVM leg is dead: every candidate came
//     back with the relay's own `dpayRelayError` marker (`evm-unconfigured` when the relay's
//     deploy is missing `DPAY_EVM_RPC_URL[_<CHAINID>]`, `evm-upstream-unreachable` when the
//     upstream transport died — crates/dpay-relay/src/evm.rs "Failure semantics"). The phone is
//     ONLINE (a dpay relay answered), so this is transport-class 'unreachable', never 'refused'.
// Both classes are thrown inside the dynamically-imported network module and caught in the seam
// that imports it statically — two module instances mean `instanceof` silently answers false —
// so every carries a brand FIELD and the classifier reads the field, never the class.

/** Why a read produced no fact — the same taxonomy the SOL seam established (R3): 'refused'
 *  (the endpoint ANSWERED and did not serve us), 'offline' (nothing answered anywhere — the
 *  payer's normal, designed state), 'unreachable' (nothing answered on the rail's path while
 *  the phone IS online — including the relay's own dead-leg marker), 'unreadable' (the
 *  endpoint answered with bytes that cannot be trusted). Lives in this PURE module so the seam
 *  and the hooks can name it without importing the network module. */
export type EvmReadFailure = 'refused' | 'offline' | 'unreachable' | 'unreadable';

/** The endpoint ANSWERED, and the answer was not the data. */
export class EvmEndpointRefused extends Error {
  /** The HTTP status when the refusal was one; null for a JSON-RPC-level error. */
  readonly status: number | null;
  /** The BRAND — see `isEvmEndpointRefusal`; a field cannot be duplicated apart across the two
   *  module instances the way a class object can. */
  readonly dpayEndpointRefused = true;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'EvmEndpointRefused';
    this.status = status;
  }
}

/** Did the ENDPOINT answer and refuse us (vs nothing answering at all)? The one supported test —
 *  the brand field, never `instanceof`, never message text. */
export function isEvmEndpointRefusal(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayEndpointRefused?: unknown}).dpayEndpointRefused === true;
}

/** The RELAY answered, but its EVM leg is dead. Thrown by the candidate walk in `evm/rpc.ts` at
 *  exhaustion when at least one candidate produced the `dpayRelayError` marker (marker beats a
 *  relayed upstream status — one dead relay leg says more about the path than a provider 5xx
 *  says about the provider). Maps straight to 'unreachable' in the seam's classification: the
 *  relay answered HTTP, which already proves the phone is online, so a connectivity probe would
 *  only re-confirm what this error proves. */
export class EvmRelayPathDown extends Error {
  /** The BRAND — see `isEvmRelayPathDown`. */
  readonly dpayRelayPathDown = true;
  /** The marker code the relay sent (`evm-unconfigured` | `evm-upstream-unreachable`) — carried
   *  for logs/diagnosis; the copy keys off the class, not the code. */
  readonly relayErrorCode: string;
  constructor(message: string, relayErrorCode: string) {
    super(message);
    this.name = 'EvmRelayPathDown';
    this.relayErrorCode = relayErrorCode;
  }
}

/** Was this failure the relay's EVM leg being down? The one supported test — the brand field. */
export function isEvmRelayPathDown(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayRelayPathDown?: unknown}).dpayRelayPathDown === true;
}

/** The endpoint refused with HTTP 429, or a previous 429's cooldown has not elapsed. A cooldown
 *  refusal is still a refusal BY THE ENDPOINT, which is why it extends `EvmEndpointRefused`. */
export class EvmRateLimited extends EvmEndpointRefused {
  readonly retryAfterMs: number;
  constructor(url: string, retryAfterMs: number) {
    super(
      `evm rpc rate limit (HTTP 429) at ${url} — the endpoint is refusing requests from this ` +
        `wallet; not sending again for ${Math.round(retryAfterMs / 1000)}s`,
      429,
    );
    this.name = 'EvmRateLimited';
    this.retryAfterMs = retryAfterMs;
  }
}

// ── The wrong-chain guard (D10/D12) ────────────────────────────────────────────────────────────
// ONE JSON-RPC upstream serves ONE chain. A 31337 envelope answered by a chain-1 node is not a
// degraded mode, it is a different (and money-dangerous) answer — so before the FIRST spend
// against an endpoint the wallet asks it `eth_chainId` and refuses a mismatch LOUDLY, naming
// both chains. Branded so the send sheet can render the honest "this endpoint serves the wrong
// chain" copy instead of a generic failure.

export class EvmWrongChainError extends Error {
  /** The BRAND — see `isEvmWrongChainError`. */
  readonly dpayEvmWrongChain = true;
  /** ALSO an endpoint refusal in the taxonomy sense: the endpoint answered and did not serve
   *  this request. Carrying both fields lets the seam's classifier map it to 'refused' through
   *  the ONE refusal test, while the wrong-chain brand keys the specific copy. */
  readonly dpayEndpointRefused = true;
  readonly expectedChainId: number;
  readonly actualChainId: number;
  constructor(expectedChainId: number, actualChainId: number) {
    super(
      `EVM wrong-chain guard: the configured endpoint serves chain ${actualChainId}, but this ` +
        `wallet asked for chain ${expectedChainId}. One RPC endpoint serves ONE chain — pointing ` +
        `this asset at it would read balances from, and broadcast to, the wrong network. ` +
        `Refused before any request was sent.`,
    );
    this.name = 'EvmWrongChainError';
    this.expectedChainId = expectedChainId;
    this.actualChainId = actualChainId;
  }
}

export function isEvmWrongChainError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayEvmWrongChain?: unknown}).dpayEvmWrongChain === true;
}

// ── The gas honesty gate (D15.3) ───────────────────────────────────────────────────────────────
// The wallet is its own gas source and dpay never pays or quotes gas: before signing, the send
// path reads the payer's native balance and refuses when it cannot cover the ESTIMATED max fee.
// The refusal carries the numbers so the UI can render the instructive copy (fee named, the
// payer's own 0x address to receive gas at) — every error path instructs; never a bare refusal.

export class EvmGasGateError extends Error {
  /** The BRAND — see `isEvmGasGateError`. */
  readonly dpayEvmGasGate = true;
  /** Estimated worst-case fee in wei (maxFeePerGas × gasUnits). */
  readonly requiredWei: string;
  /** The payer's measured native balance in wei. */
  readonly gasBalanceWei: string;
  readonly chainId: number;
  /** The chain's proper noun ('Arbitrum One' — from the chains registry). */
  readonly chainName: string;
  /** The native coin ticker ('ETH'). */
  readonly nativeSymbol: string;
  /** The payer's own address — where the gas has to arrive. */
  readonly address: string;
  constructor(fields: {
    requiredWei: string; gasBalanceWei: string; chainId: number; chainName: string;
    nativeSymbol: string; address: string;
  }) {
    super(
      `Not enough ${fields.nativeSymbol} on ${fields.chainName} for the network fee: this send ` +
        `needs about ${fields.requiredWei} wei and the address ${fields.address} holds ` +
        `${fields.gasBalanceWei} wei. Receive ${fields.nativeSymbol} at that address and the ` +
        `tokens are ready to spend the moment the gas is there.`,
    );
    this.name = 'EvmGasGateError';
    this.requiredWei = fields.requiredWei;
    this.gasBalanceWei = fields.gasBalanceWei;
    this.chainId = fields.chainId;
    this.chainName = fields.chainName;
    this.nativeSymbol = fields.nativeSymbol;
    this.address = fields.address;
  }
}

export function isEvmGasGateError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as {dpayEvmGasGate?: unknown}).dpayEvmGasGate === true;
}
