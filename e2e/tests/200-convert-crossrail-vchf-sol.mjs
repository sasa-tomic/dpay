// Flow 200 — VCHF → SOL via USDC (Route C), the founder's exact report (2026-09-22): the
// VENUE-ATTRIBUTION fix. The money path was already correct — what the founder could not see
// was WHO does what: no venue name anywhere pre-sign, and "you'll get N USDC" for a SOL
// conversion (the headline describes the USDC hop). What must be true — all asserted here:
//
//   1. THE DESTINATION ROW NAMES THE FINAL LEG'S VENUE BEFORE ANYTHING IS QUOTED. The
//      Route C picker row itself reads "… · final step via Jupiter" (registry display name,
//      never a literal) — the venue chain is visible at the picker, not after confirm.
//   2. THE REVIEW CENSUS NAMES THE FULL CHAIN + THE DESTINATION'S OWN FIGURE. One Details
//      line spells "Route: ICPSwap → Circle CCTP → Jupiter"; a fail-soft review-time
//      Jupiter estimate on the mint floor renders "≈ 0.26 SOL at your Solana address" —
//      the destination asset named beside the hop numbers. Absent estimate = absent line,
//      never an error, never a gate.
//   3. THE USDC FLOOR READS AS THE MID-STOP. The census + handoff floor line says the USDC
//      "crosses to your Solana address — the final step swaps it on for your destination"
//      (Route B keeps the arrives-here phrasing — its USDC IS the outcome).
//   4. THE DONE RECEIPT ATTRIBUTES THE CONVERSION. "Converted via ICPSwap, Circle and
//      Jupiter." under the realized SOL figure — the record's own frozen venue ids.
//
// The drive is the 186 cross-rail machine on the VCHF pair (venue icpswap-vchf-ckusdc, the
// founder's actual asset): five device-signed IC legs → wallet-signed CCTP burn → mint
// watch → the rail-local Jupiter leg. Offline stand-ins identical to 186: the private
// relay's fake-IC, the in-page Circle stub, the relay's Jupiter test-stub, the SOL RPC stub.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency, openConvertFor,
  pickSwapTarget,
  typeConvertAmount, openOtherVenues, pickSwapVenue,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, USDC_MINT, WRAPPED_SOL_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {installCctpStub, cctpStubState, setCctpMessageState, cctpFeeExpectations, FORWARD_TX_HASH} from '../harness/cctp.mjs';

const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const VCHF_USDC_POOL = 'hx7nb-diaaa-aaaar-qbxsa-cai'; // venue icpswap-vchf-ckusdc's OWN pool
const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-vchf-ckusdc:2:cctp:jupiter';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
const BURN_HASH = '0x' + 'c7'.repeat(32);

const SEED_VCHF = 50000000000; // 500 VCHF (8 decimals)
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const AMOUNT_IN_VCHF = 1000000000n; // 10 VCHF
const VCHF_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;

/** Jupiter's own digits for the final leg (and, byte-identical, for the review estimate):
 *  the floor-sized USDC → 0.26 SOL, floor 0.257. */
const SOL_OUT = '260000000';
const SOL_FLOOR = '257000000';

export const meta = {
  id: '200',
  name: 'convert-crossrail-vchf-sol',
  journey: 'convert',
  covers: ['convert', 'crossrail', 'vchf', 'sol', 'venue-attribution'],
  verifies: 'VCHF converts to SOL via USDC (Route C) with the whole venue chain named BEFORE anything signs: the destination row itself reads "final step via Jupiter", the review census spells "Route: ICPSwap → Circle CCTP → Jupiter" and renders a fail-soft Jupiter estimate for what the USDC mint floor lands as at the Solana address, the floor line reads USDC as the mid-stop (the final step swaps it onward), the handoff keeps the mid-stop phrasing, and the done receipt attributes the conversion — "via ICPSwap, Circle and Jupiter" — beside the realized SOL figure.',
  timeoutMs: 180000,
};

async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function fmt(raw, decimals) {
  const n = BigInt(raw);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const d = BigInt(decimals);
  const frac = (abs % 10n ** d).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${abs / 10n ** d}${frac ? '.' + frac : ''}`;
}

/** The SOL RPC simulator (the 185/186 seam, verbatim-shape): Circle's forward tx → the USDC
 *  mint credit at the ATA; any other signature → the native SOL credit of the final swap. */
async function installSolRpcStub(driver, cfg) {
  await driver.eval((c) => {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const b58 = (bytes) => {
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let s = '';
      while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
      for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
      return s;
    };
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      sendTransaction: (params) => {
        const raw = Array.isArray(params) ? params[0] : null;
        const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
        const sig = b58(bytes.slice(1, 65));
        globalThis.__E2E_SOL_SENT.push({signature: sig, raw});
        return sig;
      },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getSignaturesForAddress: () => [],
      getBlockHeight: () => 250000000,
      getTransaction: (params) => {
        const sig = Array.isArray(params) ? params[0] : null;
        if (sig === c.forwardTxHash) return c.tokenDetail; // Circle's destination mint (USDC at the ATA)
        return c.nativeDetail; // the final swap's realized SOL credit
      },
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  }, {forwardTxHash: cfg.forwardTxHash, tokenDetail: cfg.tokenDetail, nativeDetail: cfg.nativeDetail});
}

/** The user's EVM wallet double: records WHAT dpay asked the wallet to sign, returns the
 *  burn tx hash (the gesture). dpay never sees a key. */
async function installEvmSignSeam(driver, cfg) {
  await driver.eval((c) => {
    globalThis.__E2E_EVM_SIGNS = [];
    globalThis.__DPAY_TEST_EVM_SIGN = async (txs) => {
      globalThis.__E2E_EVM_SIGNS.push(txs);
      return c.burnHash;
    };
  }, {burnHash: cfg.burnHash});
}

export async function run() {
  const start = Date.now();
  console.log('[200-crossrail-vchf-sol] setup (own relay + shared web + browser)…');
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[200-crossrail-vchf-sol] onboarding + funding VCHF and ckETH-for-gas…');
    await onboardWallet(driver, 'e2e-crossrail-vchf-sol');
    const account = await accountOf(driver);
    const fundVchf = await faucetAccount(r2.baseURL, account.publicHex, SEED_VCHF, {currency: 7});
    assert(fundVchf.ok, `faucet VCHF credit ok (status ${fundVchf.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    // Prebuild the deterministic venue + mint fixtures for THIS wallet.
    const kp = deriveSolanaKeypair(account.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});

    // The census oracle BEFORE anything renders: the app's own fee math runs on the stub's
    // LIVE fee body, so the expected digits derive from the relay's own quote.
    const oracle0 = await relayQuote(r2.baseURL, VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_VCHF);
    let gross = BigInt(oracle0.amount_out);
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% floor
    let fees = cctpFeeExpectations(minOut);
    const mintCredit = fees.mintFloor; // what Circle's destination mint lands (≤ burn − fees)

    const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(mintCredit)});
    const nativeDetail = {
      transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
      meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
      slot: 250000001, blockTime: null, version: 'legacy',
    };
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: SOL_OUT, otherAmountThreshold: SOL_FLOOR, priceImpact: '0.001'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});

    // --- §1 the composed route: VCHF→SOL now carries DEVICE-SIGNABLE composed rows beside the
    // CCTP route (the engine's composed kind: ICP→SOL through SideShift/Trocador), so the
    // external-signature crossrail is an EXPLICIT opt-in (brief 5.4.1: it never auto-picks
    // while a device-signable path exists). Pick it from the ONE Other-venues expander; the
    // destination address input then renders (the cross-rail consent surface).
    await openConvertFor(driver, 'vchf');
    await pickSwapTarget(driver, 'SOL');
    await typeConvertAmount(driver, '10');
    await pickSwapVenue(driver, 'multihop:icpswap-vchf-ckusdc:2:cctp:jupiter', {timeoutMs: 10_000});
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    // The destination address input appears directly (the route self-resolves); the census
    // below names the final leg's venue before any confirm.
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset (USDC — not the SOL destination)');

    // --- §2 the review census: the full venue chain + the destination's own estimate
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-route-venues'), 'Route: ICPSwap → Circle CCTP → Jupiter',
      'the census names the FULL venue chain in one line (registry names, Circle as the crossing)');
    assertIncludes(await driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line');
    const floorLine = await driver.readText('crossrail-mint-floor');
    assertIncludes(floorLine, `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee, in the HOP asset');
    assertIncludes(floorLine, 'crosses to your Solana address', 'the floor line reads USDC as the MID-STOP, not the outcome');
    assertIncludes(floorLine, 'final step swaps it on', 'the floor line names the onward swap');
    // The destination's own figure: a fail-soft review-time Jupiter quote for the floor.
    await driver.findByTestID('crossrail-dest-estimate', {timeoutMs: 10_000});
    const estimateLine = await driver.readText('crossrail-dest-estimate');
    assertIncludes(estimateLine, '≈', 'the estimate is labeled an ESTIMATE, never a promise');
    assertIncludes(estimateLine, `${fmt(SOL_OUT, 9)} SOL`, 'the estimate names the DESTINATION asset and figure (SOL beside the USDC hop numbers)');
    assertIncludes(estimateLine, 'Jupiter', 'the estimate names the venue that will produce the fresh final quote');
    await driver.screenshot('200-crossrail-vchf-sol-review');

    // Confirm (quote-changed interrupt → re-review, same as 186).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-moved-note', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[200-crossrail-vchf-sol] quote moved (round ${round + 1}) — re-reviewing`);
      const re = await relayQuote(r2.baseURL, VCHF_USDC_POOL, VCHF_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_VCHF);
      gross = BigInt(re.amount_out);
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      fees = cctpFeeExpectations(minOut);
    }

    // --- §3 the handoff keeps the mid-stop phrasing (the same key, Route C branch)
    await driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000});
    await driver.waitForText('Step 1', {timeoutMs: 10_000});
    const handoff = await driver.readText('crossrail-handoff');
    assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
    assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too (re-fetched live)');
    assertIncludes(handoff, `${fmt(fees.mintFloor, 6)} USDC`, 'the handoff floor line carries the hop-asset figure');
    assertIncludes(handoff, 'crosses to your Solana address', 'the handoff floor line reads USDC as the MID-STOP (Route C branch)');
    await driver.screenshot('200-crossrail-vchf-sol-handoff');

    // The wallet double signs, the app attaches the reported hash.
    await installEvmSignSeam(driver, {burnHash: BURN_HASH});
    await driver.type('crossrail-burn-tx', 'signed');
    for (let i = 0; i < 3; i++) {
      try {
        await driver.click('btn-crossrail-attach', {timeoutMs: 5_000});
        break;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
    await driver.screenshot('200-crossrail-vchf-sol-crossing');

    // --- §4 the mint lands: corroborated at the ATA, then the final leg's offer
    await setCctpMessageState(driver, 'complete');
    await driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
    const ready = await driver.readText('crossrail-sol-ready');
    assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders (corroborated on-chain at the ATA)');
    assertIncludes(await driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the final leg\'s fresh Jupiter estimate renders in SOL');
    await driver.screenshot('200-crossrail-vchf-sol-sol-ready');

    await driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
    await driver.waitForText('verified on-chain', {timeoutMs: 60_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit at the user\'s Solana address');
    assertIncludes(done, kp.address, 'the Solana address is named');
    assertIncludes(await driver.readText('crossrail-done-via'), 'ICPSwap, Circle and Jupiter',
      'the done receipt attributes the conversion to all three (the record\'s own frozen venue ids)');
    await driver.screenshot('200-crossrail-vchf-sol-done');

    // --- stub audits + ledger truth
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 1, 'exactly ONE Solana transaction was ever broadcast');
    assertIncludes(done, sent[0].signature, 'the payout record IS the broadcast signature');
    const jup = await jupiterStubState(r2.baseURL);
    assert(jup != null, 'jupiter stub state present');
    assertEq(jup.unexpected.length, 0, 'jupiter stub saw no unexpected upstream requests');
    assert(jup.userMismatch == null, 'the swap POST carried THIS wallet\'s SOL address');
    assertEq(jup.swapCalls.length, 1, `exactly one swap POST (saw: ${JSON.stringify(jup.swapCalls)})`);
    // The REVIEW estimate + the final leg both quoted USDC→wrapped-SOL through the relay.
    // (The confirm loop may move the floor: every review re-key re-fetches the estimate, so
    // assert SOME floor-sized quote rather than the first one's position.)
    const usdcSolQuotes = jup.quoteCalls.filter((q) => q.inputMint === USDC_MINT && q.outputMint === WRAPPED_SOL_MINT);
    assert(usdcSolQuotes.length >= 2, `the review estimate AND the final leg quoted USDC→wrapped-SOL (saw ${usdcSolQuotes.length})`);
    assert(usdcSolQuotes.some((q) => q.amount === fees.mintFloor.toString()),
      'a floor-sized quote was served (the review estimate / final leg — sized on the floor, never a guess)');
    const cctp = await cctpStubState(driver);
    assertEq(cctp.unexpected.length, 0, `cctp stub saw no unexpected origins (${cctp.unexpected.join(', ')})`);
    assert(cctp.feesCalls >= 2, 'the fee census was fetched more than once (form review + confirm-time prepare)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 7)), BigInt(SEED_VCHF) - AMOUNT_IN_VCHF - 2n * VCHF_FEE,
      'VCHF ledger: amount + two fees (unchanged by the crossing — off-IC)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 2)), gross - minOut - CKUSDC_FEE,
      'ckUSDC ledger: gross − burned(minOut) − approve fee (surplus stays in-wallet, Route A semantics)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 6)), BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE,
      'ckETH ledger: the minter\'s gas burn + its approve fee');

    console.log(`GREEN 200 — VCHF→SOL cross-rail venue attribution: row + census + estimate name the chain, floor reads mid-stop, receipt says "via ICPSwap, Circle and Jupiter"; ${fmt(SOL_OUT, 9)} SOL at ${kp.address.slice(0, 8)}… in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 200:', e);
    process.exit(1);
  });
}
