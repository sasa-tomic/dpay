// THE smoke-tier manifest — the ONLY admission path into `just smoke` (founder decision: smoke
// must stay SUPER QUICK forever, so nothing auto-joins). A file not listed here is not in smoke,
// no matter where it lives or what it is named.
//
// Admission criteria (ALL of them — enforced by `smokeManifest.test.ts` (static drift) +
// `budget-setup.js` (per-test wall) + the `timeout 20s` on the recipe (suite total)):
//   1. Pure node. No <App/> mount, no `flow/` import, no spawned process, no loopback HTTP,
//      no anvil, no chrome, no filesystem writes outside app/.dev/.
//   2. Zero network: the real `fetch` must never be reachable at test time (mocked call-shape
//      pins are fine).
//   3. Deterministic: no wall-clock/random dependence; fake timers allowed.
//   4. Per-test wall budget <= 250 ms (measured with hrtime; over budget = RED, never a raise).
//   5. Scope: money-defining invariants and rail-critical paths ONLY (wire bytes, key derivation,
//      gas-gate ordering, permit/claim semantics, catalog parse/drift, amount parsing, settlement
//      state machines, transport pins that keep bytes off dpay origins).
//
// To add a test: add ONE line here and meet every criterion. The fix for a test that outgrows the
// budget is to move/split the file OUT of the manifest — never to raise the budget.
//
// Pruned from the spec's v1 roster during M1 bring-up: `sol-request-netting.test.tsx` — measured
// 10.8 s of suite wall (it imports the REAL solana signing stack and renders a component), which
// blew the 12 s total budget on its own and violates criterion 1 (not pure node — a screen
// mount). Its netting invariants stay pinned in the domain tier; a pure extract of the netting
// math may re-enter smoke only if it lands under the budgets.

export const SMOKE_FILES: readonly string[] = [
  // amount parsing/netting/display
  'amount.test.ts',
  'ledgerFees.test.ts',
  // wire-byte pins + codecs
  'base64.test.ts',
  'checkoutWire.test.ts',
  'swapCodecCore.test.ts',
  'solana-pay-uri.test.ts',
  // catalog parse + drift
  'constants.test.ts',
  'catalog.test.ts',
  'evm-catalog.test.ts',
  'evm-chains.test.ts',
  'swapTargets.test.ts',
  'venueInvariants.test.ts',
  // key derivation vectors
  'bip39.test.ts',
  'evm-identity.test.ts',
  'eip55.test.ts',
  // transaction encoding + permit/claim semantics
  'evm-rlp.test.ts',
  'evm-abi.test.ts',
  'evm-permit.test.ts',
  // wallet identity
  'wallet.test.ts',
  // settlement state machines (pure)
  'solana-settle-verify.test.ts',
  'pendingPays.test.ts',
  'solana-account-decode.test.ts',
  // the record-lifecycle cefi-deposit once-only gate (2026-10-02 P0)
  'cefiDepositGate.test.ts',
  // destination validation + transport pins that keep bytes off dpay origins
  'destination.test.ts',
  'icpBoundary.test.ts',
];
