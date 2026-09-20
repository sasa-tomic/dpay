// Flow 198 — the AGGREGATOR joins the CeFi surface: SOL → ICP through Trocador, driven
// from the SOL convert surface (registered 2026-09-20; the first venue whose EVERY method
// is key-gated — there is NO keyless status host, so the status poll rides the relay too).
//
// Flow 197 pins the SideShift mirror direction with a PAGE-side status stub (SideShift's
// status read is keyless device-direct). This flow pins what is DIFFERENT about an
// aggregator with no keyless surface, on the ICP↔SOL pair both cefi venues trade:
//
//   1. THE MERGED LANDING SPOT OFFERS A VENUE SUB-PICKER — sideshift and trocador land
//      on the same "ICP on Internet Computer" spot; the row names the SPOT, and the
//      convert-sol-dest-mechs picker (the IC surface's own pattern) chooses the SERVICE.
//      Registry order, never ranked, default first.
//   2. THE ENTIRE VENUE SURFACE IS RELAY-MEDIATED: rate, trade AND status carry the
//      relay-attached API-Key server-side (audited: zero bare upstream calls). The page
//      never talks to any venue origin — there is no page fetch stub at all.
//   3. THE KEY-GATED STATUS POLL DRIVES THE LIFECYCLE through the SAME relay route the
//      record's statusUrl names — including across a page reload.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, openBalances} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {deriveSolanaKeypair} from '../harness/jupiter.mjs';

const AMOUNT_TEXT = '2';
// The relay stub's deterministic venue figures (src/app.rs trocador_stub_*): the rate is a
// FIXED 0.0496 settle for any pair — rendered in ICP (the settle side, 8 decimals); the
// trade echoes the requested amount_from and names the venue's own deposit address.
const SETTLE_TEXT = '0.0496 ICP';
const DEPOSIT_ADDRESS = 'e2e-trocador-deposit-01';
const SETTLE_HASH = 'sol-settle-sig-198';
// The merged cefi group keeps the FIRST registry venue's id as its row testID.
const CEFI_ROW = 'convert-sol-dest-cefi-sideshift';
const TROCADOR_MECH = 'convert-sol-dest-mech-trocador';
const AMM_ROW = 'convert-sol-dest-sol-usdc';

export const meta = {
  id: '198',
  name: 'convert-sol-cefi-trocador',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:trocador', 'cefi', 'aggregator', 'same-surfaces',
    'deposit-handoff', 'derived-payout-address', 'order-locks-quote', 'reload-recovery', 'cross-rail'],
  verifies: 'With the trocador aggregator row registered (ICP<->SOL, same pair as sideshift) the SOL convert surface merges both venues under one ICP landing spot whose row names the spot and whose sub-picker chooses the service (registry order, never ranked, default first). Picking the Trocador mechanism quotes verbatim through the relay proxy (estimate, Trocador attribution), shows the user\'s OWN derived IC principal as the payout target BEFORE any order, and confirms to the venue\'s fixed-rate ORDER without broadcasting anything on the SOL rail. Every venue call — rate, trade AND the key-gated status read — rides the relay (zero bare upstream calls, the API-Key attaches server-side, the refund address rides every trade request), and the provider lifecycle awaiting_deposit → processing → done runs through the relay status route, surviving a page reload on the persisted record.',
  timeoutMs: 180000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/trocador-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

async function armStub(relayBaseURL, state) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/trocador-upstream/config`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`relay stub arm failed (${res.status})`);
}

/** Same SOL-rail balance simulator as flows 185/197 — the surface reads the wallet's SOL
 *  balance honestly; nothing is ever broadcast (the cefi deposit is a handoff). */
async function installSolRpcStub(driver) {
  await driver.eval(() => {
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      sendTransaction: () => { throw new Error('NO BROADCAST: the cefi deposit is a handoff, the app never sends'); },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getBlockHeight: () => 250000000,
      getTransaction: () => ({meta: {err: null}, slot: 250000000, blockTime: 1700000000}),
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });
}

/** Enter the native SOL convert surface from the accounts route (flow 185's entry). */
async function openSolConvert(driver) {
  await openBalances(driver);
  await driver.click('asset-sol-select', {timeoutMs: 8_000});
  await driver.waitForText('Convert', {timeoutMs: 6_000});
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await driver.click('btn-accounts-convert', {timeoutMs: 8_000});
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

export async function run() {
  const env = await setup({solStub: true});
  // OWN relay: the trocador stub is SERVER-side state on the relay this page dials, and
  // the setup relay is SHARED across lanes — two trocador flows running concurrently
  // would write into each other's stub (the flow-194/197 isolation rule).
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-sol-cefi-trocador');

    const id = await accountOf(driver);
    assert(id != null && typeof id.secretHex === 'string', 'onboarded identity carries the secret');
    const kp = deriveSolanaKeypair(id.secretHex);
    assert(kp.address.length >= 32, 'the wallet\'s SOL address derives from the same key (the refund provenance)');

    await installSolRpcStub(driver);
    // NO page fetch stub: unlike SideShift there is NO keyless venue origin to intercept —
    // every Trocador method rides the relay, and the audit below counts the key-bearing
    // calls server-side. Any surprise origin would be a bug this flow cannot silently pass.

    // --- §1 the merged landing spot: row names the spot, sub-picker names the services
    await openSolConvert(driver);
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for SOL');
    assert(await driver.findByTestID('convert-sol-dest', {timeoutMs: 5_000}) != null, 'the out-destination picker renders');
    assert(await driver.findByTestID(AMM_ROW, {timeoutMs: 3_000}) != null, 'the in-wallet USDC row is present (amm surface unchanged)');
    const cefiRow = await driver.findByTestID(CEFI_ROW, {timeoutMs: 3_000});
    assert(cefiRow != null, 'the merged cefi ICP row is present');
    const cefiRowText = await driver.readText(CEFI_ROW);
    assertIncludes(cefiRowText, 'ICP', 'the merged row names the landing asset');
    assert(!cefiRowText.includes('SideShift'), 'the merged row does NOT name one venue (two venues serve this spot)');
    assertIncludes(await driver.readText('convert-screen'), 'Convert SOL to USDC', 'the default pair is still the first amm group (no surprise preselection)');

    // --- §2 pick the cefi spot, then the Trocador SERVICE in the sub-picker
    await driver.click(CEFI_ROW, {timeoutMs: 3_000});
    assert(await driver.findByTestID('convert-sol-dest-mechs', {timeoutMs: 3_000}) != null, 'the venue sub-picker appears for the merged spot');
    assert(await driver.findByTestID('convert-sol-dest-mech-sideshift', {timeoutMs: 2_000}) != null, 'the registry-first venue is offered');
    await driver.click(TROCADOR_MECH, {timeoutMs: 3_000});
    assertIncludes(await driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
    await driver.type('convert-amount', AMOUNT_TEXT);
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-headline'), SETTLE_TEXT, 'receive estimate is the venue settle figure verbatim');
    assertIncludes(await driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
    assertIncludes(await driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
    const settle = await driver.readText('convert-settle-address');
    assert(settle != null && settle.length >= 20 && settle.includes('-'), `the payout target is the wallet's OWN derived IC principal (${settle.slice(0, 12)}…), shown before any order`);
    assert(await driver.findByTestID('convert-slippage', {timeoutMs: 1_000}).catch(() => null) == null,
      'no slippage axis — a fixed trade pins its amount at confirm (the cefi rule)');
    assert(await driver.findByTestID('convert-min-out', {timeoutMs: 1_000}).catch(() => null) == null,
      'no min-out line — no lock window is documented, so no floor is claimed');
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-counterparty'), 'Trocador', 'counterparty line names the venue');
    assertIncludes(await driver.readText('convert-counterparty'), 'automated exchange service', 'not a licensed provider');
    assertIncludes(await driver.readText('convert-counterparty'), 'Nothing is signed on this phone', 'the cefi signing sentence: the deposit is a handoff');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'trocador.app/terms', 'the venue disclosure is present');
    assert(await driver.findByTestID('convert-pool-principal', {timeoutMs: 1_000}).catch(() => null) == null,
      'no pool-principal line on cefi (the venue API base is not depositor-checkable)');
    await driver.screenshot('198-sol-cefi-trocador-checklist');

    // --- §3 confirm → the venue's ORDER; the handoff is the venue's own deposit address
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}) != null, 'the record lands at awaiting_deposit');
    assertIncludes(await driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue deposit address renders verbatim');
    const handoff = await driver.readText('convert-deposit-handoff');
    assertIncludes(handoff, '2 SOL', 'the exact deposit amount renders in the deposit asset');
    assertIncludes(handoff, 'exactly the deposit amount', 'the handoff says what to send');
    assertIncludes(handoff, 'not a party', 'dpay party-hood denied');
    assert(await driver.waitForText('Converted', {timeoutMs: 1_000}).catch(() => false) === false, 'nothing is "done" — the venue holds nothing yet');
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 0, 'NOTHING was ever broadcast on the SOL rail — the deposit is a handoff');
    await driver.screenshot('198-sol-cefi-trocador-awaiting-deposit');

    // --- §4 the partner-key audit: EVERY venue call rode the relay, key attached
    const hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'no bare (keyless) upstream call — the key attaches server-side on every hop');
    assertEq(hits.tradeCalls, 1, 'exactly one trade creation (the confirm)');
    assert(hits.rateCalls >= 2, `at least the review + confirm quotes rode the proxy (saw ${hits.rateCalls})`);
    assert(hits.keyCalls >= hits.rateCalls + hits.tradeCalls, 'every upstream call carried the API-Key');
    const tradeQuery = hits.lastTradeQuery ?? '';
    assertIncludes(tradeQuery, 'refund=', 'the trade request carried the refund address (the fund-loss guard)');
    assertIncludes(tradeQuery, 'min_kycrating=A', 'the non-KYC backends-only pin is relay-side');
    assertIncludes(tradeQuery, 'markup=0', 'the no-dpay-cut pin is relay-side');
    assertIncludes(tradeQuery, 'fixed=True', 'the trade is the venue\'s fixed-rate kind');

    // --- §5 the lifecycle THROUGH the key-gated relay status route
    await new Promise((r) => setTimeout(r, 2_500));
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 2_000}) != null, 'steady while the venue waits');
    const statusCallsBefore = (await relayHits(r2.baseURL)).statusCalls;
    assert(statusCallsBefore >= 1, 'the record already polls the relay status route');
    await armStub(r2.baseURL, {status: 'Processing'});
    assert(await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}) != null, 'the venue status drives processing (through the relay)');

    // --- §6 reload resume: the persisted record re-enters the provider panel, still relay-fed
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSolRpcStub(driver); // page stubs die with the page
    await openSolConvert(driver);
    assert(await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000}) != null, 'the record resumes from storage');
    const after = await relayHits(r2.baseURL);
    assertEq(after.tradeCalls, 1, 'the resume created NO second trade');
    assert(after.statusCalls > statusCallsBefore, 'the resumed record polls the relay status route');

    // --- §7 settle → done with the realized figures at the user's own address
    await armStub(r2.baseURL, {status: 'Completed', amount_to: '0.0496', hashout: SETTLE_HASH});
    assert(await driver.waitForText('Converted', {timeoutMs: 45_000}), 'the venue settle drives the record to done');
    const done = await driver.readText('convert-done');
    assertIncludes(done, SETTLE_TEXT, 'done reports the realized settle figure');
    assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
    assertIncludes(done, settle.slice(0, 12), 'the payout address IS the derived IC principal');
    await driver.screenshot('198-sol-cefi-trocador-done');

    console.log(`GREEN 198 — SOL→ICP via the trocador aggregator from the SOL surface: merged spot + venue sub-picker (no ranking), payout at the derived IC principal, EVERY venue call relay-borne with the key attached (0 bare calls, refund carried), fixed order locked the figures, lifecycle through the key-gated status route with reload resume`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 198:', e);
    process.exit(1);
  });
}
