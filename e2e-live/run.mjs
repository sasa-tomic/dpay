#!/usr/bin/env node
// e2e-live runner — drives the testnet-wiring flow against a STAGING relay (DPAY_E2E_BASE).
//
// Distinct from e2e/run.mjs (the offline suite against a FakeLedger relay): this runner targets a
// LIVE staging relay pointed at a deployed staging facade. It is OPT-IN only — never part of
// `just verify`/`just check`. Requires:
//   * DPAY_E2E_BASE=<staging relay URL> (e.g. https://staging.dpay.kalaj.org)
//   * The staging facade deployed (scripts/dfx-deploy-ic-staging.sh, mainnet mode)
//   * A staging relay running + pointed at the staging facade (DPAY_CANISTER_ID=<staging facade id>)
//
// Usage: DPAY_E2E_BASE=<url> node e2e-live/run.mjs
//   or:  just e2e-live-testnet   (sets DPAY_E2E_MODE=live + checks DPAY_E2E_BASE)
//
// Reuses the existing e2e/harness/ Driver + setup() (mode-gated via DPAY_E2E_MODE=live). The harness
// builds + serves the web app locally and points it at the staging relay via ?relay=<base>.
import { stopSession } from '../e2e/harness/lib.mjs';

// The flow to run: DPAY_E2E_LIVE_FLOW=<file under tests/> (default: the testnet-wiring proof).
const FLOW = new URL(`./tests/${process.env.DPAY_E2E_LIVE_FLOW || '01-testnet-wiring.mjs'}`, import.meta.url);

async function main() {
  if (!process.env.DPAY_E2E_BASE) {
    console.error('DPAY_E2E_BASE is required — the staging relay URL (e.g. https://staging.dpay.kalaj.org)');
    console.error('The staging facade must be deployed (scripts/dfx-deploy-ic-staging.sh) + a staging relay');
    console.error('running + pointed at it (DPAY_CANISTER_ID=<staging facade id>).');
    process.exit(2);
  }
  // The harness reads DPAY_E2E_MODE + DPAY_E2E_BASE; set mode=live explicitly (the default is local).
  process.env.DPAY_E2E_MODE = 'live';

  const mod = await import(FLOW.href);
  try {
    await mod.run();
  } finally {
    await stopSession();
  }
}

main().catch((e) => {
  console.error(`\n[e2e-live] RED: ${e.stack || e.message || e}\n`);
  process.exit(1);
});
