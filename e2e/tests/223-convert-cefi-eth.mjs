// Flow 223 — the EVM-NATIVE CeFi destination (2026-09-27): ICP → native ETH on Ethereum
// mainnet through the adapter-owned SideShift row (sideshift-eth), the trip that funds the
// EVM rail from ICP holdings (then a staging Uniswap buy of ZCHF — out of scope here).
//
// What this flow pins, through the REAL app + the REAL relay partner-key proxy (the stub
// stands in for sideshift.ai, the flow-187 pattern):
//   1. THE GATE: the EVM rail is configured (the driver deletes the suite-default empty
//      EVM RPC override, the production derive path) — and ONLY then does the ETH target
//      carry the sideshift-eth row (the jest suite pins the rail-off absence).
//   2. THE SETTLE ADDRESS IS THE DEVICE'S OWN EVM IDENTITY: m/44'/60'/0'/0/0 over the
//      SAME seed the IC rail derives from, EIP-55-checksummed. The expected address is
//      computed INDEPENDENTLY by the harness's own SLIP-10 implementation
//      (harness/evm/evm-core.mjs — the module flow 218 pins against the official
//      vectors), never by the app under test.
//   3. THE PAYOUT RAIL IS NAMED: the sheet's settle-rail line says the payout is NATIVE
//      ETH on Ethereum mainnet (the ETH target also carries the IC ckETH pool row — same
//      currency, different settle rail).
//   4. THE ORDER LOCKS THE EVM FACTS: confirm creates exactly ONE venue order; the relay's
//      settle-address gate accepts the order ONLY because the device named settleLedger
//      (the EVM-native rail) — the legacy icp↔solana complement could never validate a
//      0x address. The record's dest provenance is the derived address and the settle
//      rail id; the deposit handoff shows the venue's own address verbatim.
//   5. COMPLETION: the venue's own settled figures land the record at done — amount +
//      payout address named. (Inbound native ETH has no ERC-20 Transfer log, so the EVM
//      chain-history surface intentionally never shows it; the record + the gas balance
//      the EVM surfaces read are the proof.)
// Store keys are v3 (`dpay.convert.v3.<pubkey>`).
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance,
  openBalances, openConvertFor,
  pickSwapTarget, openOtherVenues, typeConvertAmount,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {installSideShiftStub, setSideShiftStatus} from '../harness/sideshift.mjs';
import {deriveEvmKeypair, eip55} from '../harness/evm/evm-core.mjs';

const SEED_ICP = 2000000000; // 20 ICP
const AMOUNT_TEXT = '3';
// The relay stub's deterministic venue figures (src/app.rs sideshift_stub_*): a FIXED
// 0.0495 settle for any deposit, rate 0.02475; order id e2e-shift-9c1d; the deposit
// address a checksum-correct ICRC-1 account text. Typing 3 ICP keeps the order's echoed
// depositAmount QUOTE-DERIVED (the app's prepare red line refuses a mismatched order).
const DEPOSIT_ADDRESS = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const SHIFT_ID = 'e2e-shift-9c1d';
const SETTLE_HASH = 'eth-settle-hash-223';
const ETH_RAIL_ID = 'evm:native-eth'; // the relay adapter's twin (app/config/evmConvert.ts)

export const meta = {
  id: '223',
  name: 'convert-cefi-eth',
  journey: 'convert',
  covers: ['convert', 'cefi', 'sideshift', 'evm-native', 'evm-identity', 'eip55',
    'partner-key', 'relay-proxy', 'deposit-handoff', 'provider-status', 'order-first',
    'deposit-gate', 'v3-store', 'reload-recovery', 'no-re-sign', 'cross-rail'],
  verifies: 'The EVM-native CeFi destination converts ICP to NATIVE ETH on Ethereum mainnet through the adapter-owned SideShift row, gated on the EVM rail being configured: the settle address is the device\'s own EVM identity (m/44\'/60\'/0\'/0/0 over the wallet seed, EIP-55-checksummed — pinned against the harness\'s independent SLIP-10 implementation), the sheet names the payout rail (native ETH on Ethereum mainnet, distinct from the IC ckETH pool row), the ONE consent creates exactly one venue order whose settle address the relay validates against the named EVM-native settle rail, the record carries the settle-rail id + derived address as provenance, a reload resumes the payout watch without re-creating the order, and the venue\'s own settled figures complete it.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/sideshift-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** Re-enter the convert surface from the accounts route. */
async function reopenConvert(driver) {
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await openConvertFor(driver, 'icp', {timeoutMs: 8_000});
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

async function storeRecords(driver, publicHex) {
  return driver.eval((key) => {
    const raw = window.localStorage.getItem(key);
    return raw == null ? {} : JSON.parse(raw);
  }, `dpay.convert.v3.${publicHex}`);
}

export async function run() {
  const start = Date.now();
  console.log('[223-convert-cefi-eth] setup (own relay + shared web + browser, EVM rail on)…');
  // evmRpcUrl: 'derive' deletes the suite-default '' EVM RPC override — the app derives
  // the per-chain route from its relay list (the production path), which turns the EVM
  // rail gate ON. The relay answers the EVM balance polls with the honest 503
  // `evm-unconfigured` marker (no upstream in the offline loop) — the rail is configured,
  // just chainless here; the convert path itself needs no EVM RPC at all.
  const env = await setup({evmRpcUrl: 'derive'});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[223-convert-cefi-eth] onboarding + funding 20 ICP…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-convert-cefi-eth');
    const account = await accountOf(driver);
    const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fund.ok, `faucet ICP credit ok (status ${fund.status})`);

    // The settle address, derived INDEPENDENTLY of the app: the harness's own SLIP-10
    // secp256k1 implementation over the wallet's seed, in its EIP-55 form.
    const kp = deriveEvmKeypair(account.secretHex);
    const expectedAddress = eip55(kp.address.toLowerCase());
    assertEq(kp.address, expectedAddress, 'the harness derivation is already EIP-55-checksummed');

    // The STATUS half is page-scoped (quotes/orders ride the real relay route untouched).
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    // --- §1 the gated pick: the ETH target carries the sideshift-eth row, the payout rail
    // is named, and the settle address is the derived EVM identity.
    console.log('[223-convert-cefi-eth] the ETH target reveals the EVM-native venue row…');
    await openBalances(driver, {timeoutMs: 8_000});
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'ETH');
    // The pair also carries the direct IC ckETH pool row (the auto-pick holds it); the
    // EVM-native venue row waits behind the ONE Other-venues expander.
    await openOtherVenues(driver);
    await driver.findByTestID('convert-venue-sideshift-eth', {timeoutMs: 8_000});
    await driver.click('convert-venue-sideshift-eth', {timeoutMs: 5_000});
    await typeConvertAmount(driver, AMOUNT_TEXT);
    // The payout rail is NAMED before anything can be confirmed.
    await driver.findByTestID('convert-settle-rail', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('convert-settle-rail'), 'Ethereum',
      'the settle-rail line names Ethereum mainnet');
    await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
    const settle = await driver.readText('convert-settle-address');
    assertIncludes(settle, expectedAddress,
      `the payout address is the wallet's OWN derived EVM address (${expectedAddress.slice(0, 10)}…)`);
    assertEq(settle.trim(), expectedAddress, 'the settle address renders EXACTLY the checksummed derivation');
    await driver.waitForText('0.0495 ETH', {timeoutMs: 20_000});
    assertIncludes(await driver.readText('convert-quote-source'), 'SideShift',
      'the quote is attributed to SideShift');
    await driver.screenshot('223-eth-cefi-quote');

    // NOTHING is adopted before the consent: the store is still empty.
    let store = await storeRecords(driver, account.publicHex);
    assertEq(Object.keys(store).length, 0, 'no record exists before the consent (pre-broadcast invariant)');

    // --- §2 THE ONE CONSENT: order created through the relay; the deposit handoff renders
    // verbatim. The relay's settle-address gate only passes because the device named the
    // EVM-native settle rail — the legacy icp↔solana complement could not validate 0x.
    console.log('[223-convert-cefi-eth] the one consent press: order + deposit handoff…');
    const icpBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
    assertIncludes(await driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS,
      'the venue\'s deposit address renders VERBATIM');
    const handoff = await driver.readText('convert-awaiting-deposit');
    assertIncludes(handoff, AMOUNT_TEXT, 'the EXACT deposit amount renders');
    assertIncludes(handoff, 'holds', 'the handoff copy says the venue holds funds mid-trade');
    await driver.screenshot('223-eth-cefi-deposit');

    // The partner-key audit + the record's provenance.
    let hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'ZERO bare upstream calls — the relay attached the credential');
    assertEq(hits.shiftCalls, 1, 'exactly one venue order exists');
    assert(hits.quoteCalls >= 2, `quote surface used (review + confirm re-quote): ${hits.quoteCalls}`);
    store = await storeRecords(driver, account.publicHex);
    const rec = Object.values(store).find((r) => r != null && r.providerRef != null);
    assert(rec != null, 'the consented record persisted');
    assertEq(rec.step, 'awaiting_deposit', 'the record parks at the venue payout watch');
    assertEq(rec.venueId, 'sideshift-eth', 'the record names the adapter-owned venue');
    assertEq(rec.outLedger, ETH_RAIL_ID, 'the settle side is the EVM-native rail id');
    assertEq(rec.outSymbol, 'ETH', 'the payout symbol is ETH');
    assertEq(rec.outDecimals, 18, 'the payout decimals are the chain\'s own 18');
    assertEq(rec.destAddress, expectedAddress, 'the payout provenance is the derived EVM address');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 8)), icpBefore,
      'ICP ledger UNCHANGED — the deposit is the user\'s own off-app act, dpay signed nothing');

    // --- §3 reload: the payout watch resumes WITHOUT re-creating the order ------------------
    console.log('[223-convert-cefi-eth] reload: the watch resumes, the order is never re-created…');
    const shiftsBefore = (await relayHits(r2.baseURL)).shiftCalls;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'}); // page stubs die with the page
    await reopenConvert(driver);
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 45_000});
    assertEq((await relayHits(r2.baseURL)).shiftCalls, shiftsBefore,
      'the venue order was NEVER re-created across the reload');

    // --- §4 the venue settles: its own figures complete the record --------------------------
    console.log('[223-convert-cefi-eth] settled: the venue\'s own figures complete it…');
    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: SETTLE_HASH});
    await driver.findByTestID('convert-done', {timeoutMs: 45_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, '0.0495', 'done reports the VENUE\'s own settle amount');
    assertIncludes(done, 'ETH', 'done names the payout asset');
    assertIncludes(done, expectedAddress, 'done names the payout at the user\'s EVM address');
    await driver.screenshot('223-eth-cefi-done');

    console.log(`[223-convert-cefi-eth] PASS (${Date.now() - start}ms)`);
  } finally {
    // env.stop() first (flow-38 convention): closing the page quiesces the app's polls before
    // the relay dies (the teardown race flow-190 documents).
    await env.stop();
    await r2.stop();
  }
}
