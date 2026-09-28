/** Sets the SOL RPC override at module load — the app captures it once (config/constants.ts).
 *  Point the rail at the ONE test relay's real Solana JSON-RPC proxy (the production derivation:
 *  `${relayBase}/api/v1/solana/rpc`), whose test-helpers upstream stub answers deterministically.
 *  IMPORT THIS MODULE FIRST in a test file, before ../harness/mount.
 *
 * NOTE: with the override set, the SOL candidate list is a SINGLE candidate — the relay-derived
 * multi-home walk (solanaRpcUrls rank 3) is bypassed. Flow 165's walk leg needs the derivation,
 * which the flow tier cannot express (jest.setup's '' capture otherwise keeps the rail off) —
 * gap filed for the integrator. */
const relay = process.env.DPAY_JEST_RELAY_URL;
if (relay && relay.startsWith('http')) {
  (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL = `${relay}/api/v1/solana/rpc`;
}
