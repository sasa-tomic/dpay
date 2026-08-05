// e2e-live Tier 1 — testnet chain-key wiring proof (OPEN_ISSUES #1/#2/#8).
//
// Drives the REAL staging facade + REAL IC testnet chain-key canisters through the app + direct
// relay calls. This is a LIVE flow — it hits mainnet (the staging facade + DFINITY's free testnet
// chain-key tokens). It is OUTSIDE `just verify`/`just check` by design: it needs a staging relay
// (DPAY_E2E_BASE) pointed at a deployed staging facade (scripts/dfx-deploy-ic-staging.sh). Run via
// `just e2e-live-testnet` (which sets DPAY_E2E_MODE=live + requires DPAY_E2E_BASE).
//
// What it proves (the FREE testnet path that closes issues #1/#2/#8):
//   1. Onboard against the staging relay (DEMO faucet mints ∂100 on staging — staging-owned DUSD).
//   2. The Balances sheet shows the 3 testnet asset cards (ckTESTBTC / ckSepoliaUSDC / ckSepoliaETH).
//   3. ckTESTBTC deposit_address is a REAL Testnet4 address (not the FakeLedger `bc1qdpay…` stub).
//   4. Relay /deposit/info?currency=3 returns the REAL ckBTC Testnet minter's config (min_confirmations
//      ==4, deposit_min_amount >=300 sats).
//   5. Relay /deposit/refresh/<pubkey>?currency=3 returns 200 + minted_total==0 + empty pending (no
//      deposit yet — the honest "nothing to credit" state).
//   6. Relay /onramp/ckerc20?currency=4 returns the SEPOLIA CkDeposit helper + the real Sepolia USDC
//      ERC-20 contract (the chain-aware helper fix from this change).
//
// ~30s, no real funds spent (IC testnet tokens are free). The assertion values are pinned to the
// staging facade's registered metadata (scripts/dfx-deploy-ic-staging.sh) + the chain-id gate
// (crates/dpay-relay/src/ledger.rs). A mismatch means either the staging facade is misconfigured OR
// the relay helper-address fix regressed.
import { setup, assert, assertIncludes, onboardWallet, openBalances, accountOf } from '../../e2e/harness/lib.mjs';

export const meta = {
  id: '01',
  name: 'testnet-wiring',
  journey: 'live',
  covers: ['live', 'testnet', 'ckbtc-testnet', 'cksepolia-usdc', 'deposit-address', 'onramp', 'chain-aware-helper'],
  verifies: 'Staging facade: 3 testnet asset cards render; ckTESTBTC deposit is a real Testnet4 address; relay deposit/onramp endpoints return the real testnet minter config + Sepolia ckERC20 helper.',
  timeoutMs: 30_000,
};

// Staging currency IDs (from scripts/dfx-deploy-ic-staging.sh — the staging facade's register_currency
// calls). DEMO=0, ckBTC Testnet=3, ckSepoliaUSDC=4, ckSepoliaETH=5.
const CKBTC_TESTNET = 3;
const CKSEPOLIA_USDC = 4;

export async function run() {
  const start = Date.now();
  console.log('[01-testnet-wiring] setup (staging relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    // 1. Onboard against the STAGING relay. The DEMO faucet mints ∂100 from the staging-owned DUSD
    //    ledger (NOT prod td2nx — the staging facade owns its own DUSD ledger so it can mint).
    console.log('[01-testnet-wiring] onboarding (staging DEMO faucet)…');
    await onboardWallet(driver, 'testnet-e2e', { timeoutMs: 20_000 });
    const identity = await accountOf(driver);
    assert(identity && typeof identity.publicHex === 'string', 'onboard should persist an identity with publicHex');
    console.log(`[01-testnet-wiring] ✓ onboarded (pubkey ${identity.publicHex.slice(0, 8)}…)`);

    // 2. Open Balances + assert the 3 testnet asset cards are present. The staging facade's catalog
    //    (currencies()) carries ckBTC Testnet (CkBtcUtxo) + ckSepoliaUSDC + ckSepoliaETH (CkEthErc20).
    //    testID = asset-<assetTestKey(descriptor)> (see app/config/catalog.ts:assetTestKey).
    console.log('[01-testnet-wiring] opening Balances + asserting testnet asset cards…');
    await openBalances(driver, { timeoutMs: 10_000 });
    const body = await driver.bodyText();
    // ckBTC Testnet → assetTestKey returns 'ckbtc' (CkBtcUtxo family).
    await driver.findByTestID('asset-ckbtc', { timeoutMs: 8_000 });
    // ckSepoliaUSDC + ckSepoliaETH → assetTestKey returns the lowercased wrapper_name.
    await driver.findByTestID('asset-cksepoliausdc', { timeoutMs: 4_000 });
    await driver.findByTestID('asset-cksepoliaeth', { timeoutMs: 4_000 });
    assertIncludes(body, 'BTC', 'Balances should show the BTC asset name');
    console.log('[01-testnet-wiring] ✓ 3 testnet asset cards present (ckTESTBTC / ckSepoliaUSDC / ckSepoliaETH)');

    // 3. Open the ckBTC Testnet deposit sheet + assert a REAL Testnet4 address (not the FakeLedger stub).
    //    The staging facade proxies to the real ckBTC Testnet minter (get_btc_address), which derives a
    //    per-principal Testnet4 address via threshold signatures. The FakeLedger stub is `bc1qdpay…`.
    console.log('[01-testnet-wiring] opening ckTESTBTC deposit + asserting real Testnet4 address…');
    await driver.click('asset-add-ckbtc', { timeoutMs: 5_000 });
    await driver.findByTestID('deposit-address', { timeoutMs: 15_000 });
    const address = await driver.readText('deposit-address');
    // A real bech32 Testnet4 address: starts bc1, 20+ data chars, bech32 charset. NOT the FakeLedger
    // `bc1qdpay` stub (which is the offline/demo marker).
    assert(/^bc1[a-z0-9]{20,}$/.test(address),
      `ckTESTBTC deposit address should be a real bech32 Testnet4 address (bc1…), got "${address}"`);
    assert(!address.startsWith('bc1qdpay'),
      `ckTESTBTC deposit address must NOT be the FakeLedger stub "bc1qdpay…" (expected a real Testnet4 address), got "${address}"`);
    console.log(`[01-testnet-wiring] ✓ real Testnet4 address: ${address}`);

    // 4. Direct relay GET /deposit/info?currency=3 — the REAL ckBTC Testnet minter's deposit config.
    //    min_confirmations for ckBTC Testnet (Testnet4) is 4; deposit_min_amount is 300 sats (the
    //    minter's minimum). These come from the live minter, not FakeLedger's permissive (1/0/0).
    console.log('[01-testnet-wiring] relay GET /deposit/info?currency=3 (ckBTC Testnet)…');
    const infoResp = await fetch(`${relayBaseURL}/api/v1/deposit/info?currency=${CKBTC_TESTNET}`);
    assert(infoResp.ok, `deposit/info should be 200, got ${infoResp.status}`);
    const info = await infoResp.json();
    assert(info.min_confirmations === 4,
      `ckBTC Testnet min_confirmations should be 4 (Testnet4), got ${info.min_confirmations}`);
    assert(typeof info.deposit_min_amount === 'string' || typeof info.deposit_min_amount === 'number',
      `deposit_min_amount should be present, got ${JSON.stringify(info.deposit_min_amount)}`);
    const minAmt = typeof info.deposit_min_amount === 'string'
      ? BigInt(info.deposit_min_amount)
      : BigInt(info.deposit_min_amount);
    assert(minAmt >= 300n, `ckBTC Testnet deposit_min_amount should be >=300 sats, got ${minAmt}`);
    console.log(`[01-testnet-wiring] ✓ deposit/info: min_confirmations=${info.min_confirmations}, deposit_min_amount>=300`);

    // 5. Direct relay POST /deposit/refresh/<pubkey>?currency=3 — no deposit yet, so the honest "nothing
    //    to credit" state: 200 + minted_total==0 + empty pending. Proves the relay→facade→minter round
    //    trip is wired (the minter returns its update_balance response, not an error).
    console.log('[01-testnet-wiring] relay POST /deposit/refresh (no deposit yet → minted_total==0)…');
    const refreshResp = await fetch(
      `${relayBaseURL}/api/v1/deposit/refresh/${identity.publicHex}?currency=${CKBTC_TESTNET}`,
      { method: 'POST' },
    );
    assert(refreshResp.ok, `deposit/refresh should be 200, got ${refreshResp.status}`);
    const refresh = await refreshResp.json();
    assert(refresh.minted_total === '0' || refresh.minted_total === 0,
      `minted_total should be 0 (no deposit yet), got ${JSON.stringify(refresh.minted_total)}`);
    assert(Array.isArray(refresh.pending) && refresh.pending.length === 0,
      `pending should be empty (no deposit yet), got ${JSON.stringify(refresh.pending)}`);
    console.log('[01-testnet-wiring] ✓ deposit/refresh: minted_total==0, pending empty');

    // 6. Direct relay GET /onramp/ckerc20?currency=4 — the chain-aware helper fix (Sepolia). The staging
    //    facade's ckSepoliaUSDC has chain_id=11155111 → the relay's ckerc20_onramp_from_descriptor
    //    selects the SEPOLIA CkDeposit helper (not mainnet). The erc20_address is the real Sepolia USDC.
    console.log('[01-testnet-wiring] relay GET /onramp/ckerc20?currency=4 (ckSepoliaUSDC, Sepolia helper)…');
    const onrampResp = await fetch(`${relayBaseURL}/api/v1/onramp/ckerc20?currency=${CKSEPOLIA_USDC}`);
    assert(onrampResp.ok, `onramp/ckerc20 should be 200, got ${onrampResp.status}`);
    const onramp = await onrampResp.json();
    assert(onramp.helper_address === '0x2D39863d30716aaf2B7fFFd85Dd03Dda2BFC2E38',
      `ckSepoliaUSDC helper_address should be the SEPOLIA CkDeposit helper, got "${onramp.helper_address}"`);
    assert(onramp.erc20_address === '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      `ckSepoliaUSDC erc20_address should be the real Sepolia USDC contract, got "${onramp.erc20_address}"`);
    console.log('[01-testnet-wiring] ✓ onramp/ckerc20: Sepolia helper + Sepolia USDC contract');

    await driver.screenshot('01-testnet-wiring');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[01-testnet-wiring] GREEN in ${elapsed}s — staging testnet wiring proven end-to-end`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => {
    console.error(`\n[01-testnet-wiring] RED: ${e.stack || e.message || e}\n`);
    process.exit(1);
  });
}
