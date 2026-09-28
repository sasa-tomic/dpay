/** Enables the relay-DERIVED Solana path for this test FILE — the exact production derivation
 *  (the e2e twin's `setup({solRpcUrl: 'relay'})`). DELETING `__DPAY_TEST_SOLANA_RPC_URL` before
 *  config/constants.ts loads (its capture point) leaves the override UNSET, so the SOL candidate
 *  list falls through to rank 3: derived from the App-installed relay bases
 *  (`{relayBase}/api/v1/solana/rpc`), the real multi-home walk — no single-candidate override.
 *  IMPORT THIS MODULE FIRST in a test file, before ../harness/mount (whose App import loads
 *  constants.ts). Requests to the baked origin ride the harness fetch rewrite to the test relay.
 *
 *  This is what makes flow 165's WALK leg expressible: the derivation follows a mid-session
 *  relay-list re-point (App installs the list and the SOL bases in one tick), so a dead-first
 *  list is walked past exactly as in production. With a captured override the list is pinned to
 *  ONE candidate and the derivation is bypassed — the pre-M3 limitation. */
delete (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_SOLANA_RPC_URL;
