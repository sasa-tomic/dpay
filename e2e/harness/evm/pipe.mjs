// e2e/harness/evm/pipe.mjs — one-call staging for the EVM flow proofs: a scratch anvil + the
// REAL harness relay (dpay-relay, test-helpers) with its EVM upstream pointed at that anvil —
// the flow-165 discipline, D26: the flows exercise the relay PIPE, never a direct anvil dial.
// The upstream env is set HERE, explicitly, so a shell-exported DPAY_EVM_RPC_URL can never leak
// into the relay (the DPAY_SOLANA_RPC_URL pattern in relay.mjs).
import {startRelay, pickFreePort} from '../relay.mjs';
import {stageAnvil} from './anvil.mjs';
import {sha256} from '@noble/hashes/sha2';

/** A deterministic, VALUELESS dev seed for a named role (payer/merchant/device/…). The address
 * is stable across runs and machines, which is what makes the staged balances assertable. */
export function devSeed(role) {
  return Buffer.from(sha256(Buffer.from(`dpay evm ${role} seed — valueless, offline only`, 'utf8'))).toString('hex');
}

/**
 * Stage anvil + relay-pipe. `recipients` passes straight through to stageAnvil
 * (`{seed|privHex|address, zchfRaw?, ethWei?}` each). Returns
 * `{anvil, relay, pipe, stop}` where `pipe` is the relay's /api/v1/evm/rpc URL.
 */
export async function stagePipe({recipients = [], blockTime} = {}) {
  const anvilPort = await pickFreePort();
  const anvil = await stageAnvil({port: anvilPort, recipients, blockTime});
  let relay = null;
  try {
    relay = await startRelay({env: {
      // The bare /api/v1/evm/rpc route (== chain 1 per D12) fronts the anvil too — the flows
      // dial the bare pipe directly (their own evm-core, no suffix).
      DPAY_EVM_RPC_URL: anvil.rpcUrl,
      // D12: the PER-CHAIN route the app's seam derives (`<relay>/api/v1/evm/rpc/31337`) —
      // without it every suffixed call answers 503 evm-unconfigured and the app-side flows
      // cannot ride the pipe.
      DPAY_EVM_RPC_URL_31337: anvil.rpcUrl,
      // D3: the env-gated dev catalog row — the relay serves an `{evm, "Anvil", testnet}`
      // section with the mock ZCHF at this address, so the app's catalog carries the Anvil
      // ZCHF row the flows assert on.
      DPAY_EVM_ANVIL_TOKEN: anvil.tokenAddress,
    }});
  } catch (e) {
    await anvil.stop();
    throw e;
  }
  const pipe = `${relay.baseURL}/api/v1/evm/rpc`;
  const stop = async () => {
    try { await relay?.stop(); } catch {}
    try { await anvil.stop(); } catch {}
  };
  return {anvil, relay, pipe, stop};
}
