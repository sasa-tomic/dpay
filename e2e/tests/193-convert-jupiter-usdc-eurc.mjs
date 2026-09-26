// Flow 193 — EUR↔USD on the Solana rail: USDC → EURC(Solana) through the `jupiter-usdc-eurc`
// venue, end to end, offline (registered 2026-09-19; founder mandate that EUR↔USD exists).
//
// `jupiter-usdc-eurc` (registry row kind solana_amm, pair = USDC + EURC mints, UNORDERED) made
// USDC and EURC TWO-out-option mints — the picker (spec 2026-09-16 §2 decision 5, flow 189's
// surface) must already serve them with zero new UX code. What must be true now:
//
//   1. BOTH DESTINATIONS ARE VISIBLE AND THE DEFAULT IS UNCHANGED. The USDC surface renders one
//      row per registered venue (registry order — the SOL-pair `jupiter` row first, the FX row
//      second), the FIRST (SOL) is preselected and the heading names USDC→SOL before any pick.
//   2. THE PICK RE-TARGETS THE PAIR. Selecting the EURC row flips the heading to USDC→EURC and
//      every quote GET afterwards asks USDC-mint → EURC-mint — the FX venue's own pair.
//   3. THE QUOTE IS JUPITER'S OWN, VERBATIM, THROUGH THE WALLET'S RELAY — estimate = outAmount,
//      minimum = otherAmountThreshold, impact = the published figure, attribution + clock,
//      https endpoint shown. The stub digits mirror the live 2026-09-19 measurement shape
//      (10 USDC → 8.698735 EURC on a DefiTuna pool, priceImpactPct 0.000002).
//   4. WHAT MOVES IS THE VENUE'S OWN TRANSACTION, SIGNED BY THE DEVICE — the beneficiary red
//      line checked against the user's own EURC ATA, exactly one broadcast, the SOL rail's
//      own RPC path, and the done panel reports the REALIZED on-chain EURC credit.
//
// Offline stand-ins are flow 189's exact seams: the relay's Jupiter test-stub upstream
// (harness/jupiter.mjs configures it — the dials go through dpay's relay proxy) and the
// __DPAY_TEST_SOLANA_RPC_STUB, with the getTransaction detail carrying the EURC mint row
// (the realized-payout oracle matches the record's own out mint).
import {setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, accountOf, openConvertFor,
  typeConvertAmount,
} from '../harness/lib.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, EURC_MINT, USDC_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {startRelay} from '../harness/relay.mjs';

/** 1 USDC in, Jupiter's own 0.87 EURC out, floor 0.855 — the deterministic quote digits. */
const IN_MICRO = '1000000';
const OUT_EURC = '870000';
const FLOOR_EURC = '855000';

export const meta = {
  id: '193',
  name: 'convert-jupiter-usdc-eurc',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:jupiter-usdc-eurc', 'out-destination', 'quote-verbatim', 'relay-proxy',
    'beneficiary-check', 'execution', 'fees-honest', 'one-broadcast'],
  verifies: 'With the rail-local USDC ↔ EURC Jupiter venue registered (jupiter-usdc-eurc, 2026-09-19) the USDC convert surface renders an out-destination picker with one row per venue in registry order, the FIRST (SOL) preselected — the one-venue behavior unchanged — and picking the EURC row re-targets the pair: every quote GET asks the USDC mint → the EURC mint on the FX venue. The EURC quote rides dpay\'s relay Jupiter proxy and is verbatim (estimate, floor, impact, attribution, https endpoint), confirm re-quotes, POSTs the verbatim quoteResponse, verifies the venue-built legacy tx against the user\'s own EURC ATA, signs on device, broadcasts exactly one transaction, and the done panel reports the REALIZED on-chain EURC credit with the payout record signature.',
  timeoutMs: 120000,
};

/** Same simulator as flow 189 (the seam every SOL flow uses) — see that file for the why. */
async function installSolRpcStub(driver, cfg) {
  await driver.eval((c) => {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const b58 = (bytes) => {
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let s = '';
      while (n > 0n) {
        s = B58[Number(n % 58n)] + s;
        n /= 58n;
      }
      for (const b of bytes) {
        if (b !== 0) break;
        s = '1' + s;
      }
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
      getBlockHeight: () => 250000000,
      getTransaction: () => c.rpcDetail,
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  }, {rpcDetail: cfg.rpcDetail});
}

export async function run() {
  const env = await setup({solStub: true});
  // OWN relay: the Jupiter stub is SERVER-side state on the relay this page dials, and the
  // setup relay is SHARED across lanes — two convert flows running concurrently would write
  // into each other's stub (observed 2026-09-17 on flow 189). An own relay isolates config.
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-jupiter-usdc-eurc');

    // Prebuild the venue's deterministic reply for THIS wallet, EURC side: the tx's SPL
    // destination is the user's own EURC ATA and the realized-payout oracle is the EURC row.
    const id = await accountOf(driver);
    assert(id != null && typeof id.secretHex === 'string', 'onboarded identity carries the secret (mirrors derive from it)');
    const kp = deriveSolanaKeypair(id.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, EURC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});
    const rpcDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(OUT_EURC), mint: EURC_MINT});

    await installSolRpcStub(driver, {rpcDetail});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.000002'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });

    // §1 — the target list carries every reachable CURRENCY; the standing target is
    // stable-first (USD → EUR through the FX venue — the 2026-09-25 founder rule).
    await openConvertFor(driver, 'sol-usdc');
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for USDC(Solana)');
    assertIncludes(await driver.readText('convert-screen'), 'Convert USD → EUR', 'the standing pair is USD→EUR (stable-first)');

    // §2 — Jupiter's own digits for the standing FX pair, verbatim through the relay proxy.
    await typeConvertAmount(driver, '1');
    assert(await driver.findByTestID('convert-quote-source', {timeoutMs: 10_000}) != null, 'a quote arrived (through the relay proxy)');
    assertIncludes(await driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
    assertIncludes(await driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
    assertIncludes(await driver.readText('convert-headline'), '0.87 EURC', 'receive estimate is outAmount verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '0.855 EURC', 'minimum is otherAmountThreshold verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');
    // The census folds behind the ONE Details control (10x-verbosity pass 2026-09-16); the
    // fee-note + dpay lines are gone; the headline IS the end state.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-rate'), '0.87', 'rate is the only derived figure (BigInt, 6→6 decimals)');
    assertIncludes(await driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
    assertIncludes(await driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
    assertIncludes(await driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'autonomous on-chain aggregator', 'byKey.jupiter disclosure (shared key with the sibling venues)');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'not a party', 'dpay party-hood denied');
    assertIncludes(await driver.readText('convert-sol-impact'), '0.000002', 'price impact is Jupiter\'s own figure, unmodified');
    assert(await driver.findByTestID('convert-sol-fees-note', {timeoutMs: 1_000}).catch(() => null) == null,
      'the route-fee note is gone (verbosity pass 2026-09-16)');
    assert(await driver.findByTestID('convert-dpay-fee', {timeoutMs: 1_000}).catch(() => null) == null,
      'the dpay paid-nothing line is gone (verbosity pass 2026-09-16)');
    assert(await driver.findByTestID('convert-net', {timeoutMs: 1_000}).catch(() => null) == null,
      'the net end-state line is gone (verbosity pass 2026-09-16): the headline IS the end state');
    // Fork #4: the balance line renders the CURRENCY-unit summed figure — for the USD wallet
    // holding only the Solana USDC rail, that is $2.50.
    assertIncludes(await driver.readText('convert-balance'), '$2.50', 'balance line is the currency-unit figure (USD, summed across the rails)');
    await driver.screenshot('193-convert-usdc-eurc-checklist');

    // §4 — confirm: re-quote, verbatim quoteResponse POST, EURC-ATA beneficiary check, one broadcast.
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.waitForText('Converted', {timeoutMs: 60_000}), 'the convert completes (swap → settle → done)');

    // §5 — the done panel reports the REALIZED on-chain EURC credit, payout by signature.
    const done = await driver.readText('convert-done');
    assertIncludes(done, '0.87 EURC', 'done reports the realized token credit');
    assertIncludes(done, 'Payout record:', 'done names the payout record');
    await driver.screenshot('193-convert-usdc-eurc-done');

    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 1, 'exactly ONE Solana transaction was ever broadcast');
    assert(sent[0].signature.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sent[0].signature), 'the broadcast signature is the device-signed tx signature (base58)');
    assertIncludes(done, sent[0].signature, 'the payout record IS that signature');

    const jup = await jupiterStubState(r2.baseURL);
    assert(jup != null, 'jupiter stub state present');
    assertEq(jup.unexpected.length, 0, 'no unexpected upstream requests recorded');
    assert(jup.userMismatch == null, 'the swap POST carried THIS wallet\'s SOL address');
    assertEq(jup.swapCalls.length, 1, `exactly one swap POST (saw: ${JSON.stringify(jup.swapCalls)})`);
    assertEq(jup.swapCalls[0].asLegacyTransaction, true, 'the app asked for the verifiable legacy shape');
    assertEq(jup.swapCalls[0].wrapAndUnwrapSol, true, 'wrap/unwrap requested (the venue\'s native-SOL handling, uniform across pairs)');
    assertEq(jup.lastQuoteResponse.inAmount, IN_MICRO, 'POST body carried the VERBATIM quote (inAmount)');
    assertEq(jup.lastQuoteResponse.inputMint, USDC_MINT, 'POST body carried the VERBATIM quote (USDC input mint)');
    assertEq(jup.lastQuoteResponse.outputMint, EURC_MINT, 'POST body carried the VERBATIM quote (EURC output mint)');
    assertEq(jup.lastQuoteResponse.outAmount, OUT_EURC, 'POST body carried the VERBATIM quote (outAmount)');
    assertEq(jup.lastQuoteResponse.platformFee, null, 'POST body carried the VERBATIM quote (platformFee null)');
    assert(jup.quoteCalls.length >= 1, 'at least one quote GET (per-keystroke)');
    // The sheet's Max prefill legitimately quotes the full balance first (brief 5.2).
    const prefillMicro = '2500000';
    const postPrefill = [...jup.quoteCalls];
    while (postPrefill.length > 0 && postPrefill[0].amount === prefillMicro) postPrefill.shift();
    for (const q of postPrefill) {
      assertEq(q.inputMint, USDC_MINT, 'quote GET asked for the USDC mint (the FX venue\'s own in-side)');
      assertEq(q.outputMint, EURC_MINT, 'quote GET asked for the PICKED pair\'s EURC mint');
      assertEq(q.amount, IN_MICRO, 'quote GET carried the raw 6-decimal amount');
      assertEq(q.slippageBps, '100', 'quote GET carried the chosen slippage');
    }
    assertEq(postPrefill[postPrefill.length - 1].amount, IN_MICRO, 'the LAST quote GET is the typed amount');

    console.log(`GREEN 193 — USDC→EURC(Solana) via jupiter-usdc-eurc through the out-destination picker: default unchanged, pick re-targets the FX pair, quote verbatim, device-signed venue tx, one broadcast, realized credit 0.87 EURC (sig ${sent[0].signature.slice(0, 12)}…)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 193:', e);
    process.exit(1);
  });
}
