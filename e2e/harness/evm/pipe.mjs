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
    relay = await startRelay({env: {DPAY_EVM_RPC_URL: anvil.rpcUrl}});
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
