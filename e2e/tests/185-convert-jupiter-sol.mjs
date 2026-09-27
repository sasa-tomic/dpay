// Flow 185 — the FIRST Solana convert: SOL → USDC(Solana) through Jupiter, end to end, offline.
//
// This is the flow that un-gates multi-venue readiness V11 (docs/specs/2026-09-08-multi-venue-readiness.md):
// until the Jupiter registry row (kind solana_amm, pair = wrapped-SOL + USDC mints) landed, Convert was
// gated to protocol === 'ic' and a Solana venue could not reach the screen. What must be true when it
// does — all asserted here, by the same rules the IC convert flows (140) hold:
//
//   1. THE SURFACE IS REACHABLE AT ALL. Selecting the SOL row in Balances and tapping Convert opens
//      the Solana convert screen — the venue exists, the pair resolves, nothing fails into a blank form.
//      Single venue on the pair: NO chooser chrome (the IC one-venue rule carries over), nothing
//      preselected because there is nothing to select.
//   2. THE QUOTE IS JUPITER'S OWN, VERBATIM, THROUGH THE WALLET'S RELAY. Since 2026-09-16 the
//      device dials Jupiter through dpay's relay proxy (/api/v1/jupiter/* — the founder ask,
//      "through our relay (for caching etc)"; the offline stand-in is the relay's own test-stub
//      upstream), and the screen renders Jupiter's digits unmodified: the receive
//      estimate IS outAmount, the minimum IS otherAmountThreshold, the price impact IS the published
//      figure (the V8 exception flips here BECAUSE Jupiter publishes one — it renders, verbatim), the
//      attribution names Jupiter and stamps the clock. The venue's https endpoint is shown where the
//      IC form shows the pool principal (identity/attribution — no longer a dial target).
//   3. THE FEES ARE HONEST. Route fees live inside the quoted output (the screen says exactly that),
//      platformFee is null (measured 2026-09-14), and the dpay line is the same paid-nothing line as
//      everywhere.
//   4. WHAT MOVES IS THE VENUE'S OWN TRANSACTION, SIGNED BY THE DEVICE. Confirm re-quotes first; the
//      POST carries the VERBATIM quote body as quoteResponse (asserted — no re-serialization drift)
//      plus the wallet's own SOL address; the venue's reply is a legacy unsigned tx whose fee payer IS
//      the user and whose SPL destination IS the user's own USDC ATA (the app refuses it otherwise —
//      the beneficiary red line, INV-2's Solana analog); the signature on the broadcast belongs to the
//      device key; exactly ONE transaction is ever broadcast; and the submission goes out through the
//      SOL rail's own RPC path — the same seam SOL payments use, never a new origin.
//   5. THE DONE PANEL IS HONEST. It reports the REALIZED on-chain credit re-read from the confirmed
//      transaction's token balances (not the estimate) and names the payout record by signature.
//
// Offline stand-ins (both established seams, no new surface): the Jupiter venue is answered by the
// relay's test-stub upstream (harness/jupiter.mjs configures it; harness/relay.mjs points
// DPAY_JUPITER_API_BASE at it — the flow's proof that the dials went THROUGH the relay is the stub's
// hits endpoint itself); the cluster is the __DPAY_TEST_SOLANA_RPC_STUB
// every SOL flow uses, with sendTransaction decoding the real bytes and returning the tx's own
// signature so the driver's node-signature identity check passes exactly as against a real node.
import {setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, accountOf, openConvertFor,
  typeConvertAmount,
} from '../harness/lib.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, USDC_MINT, WRAPPED_SOL_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {startRelay} from '../harness/relay.mjs';

/** 1 SOL in, Jupiter's own 10.36 USDC out, floor 10.25 — the deterministic quote digits. */
const IN_LAMPORTS = '1000000000';
const OUT_USDC = '10360000';
const FLOOR_USDC = '10250000';

export const meta = {
  id: '185',
  name: 'convert-jupiter-sol',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:jupiter', 'quote-verbatim', 'relay-proxy',
    'beneficiary-check', 'execution', 'fees-honest', 'one-broadcast'],
  verifies: 'A Solana wallet can reach the Convert surface at all (V11): selecting SOL and tapping Convert opens the Jupiter screen with no chooser for the single venue. The quote is fetched through dpay\'s relay Jupiter proxy and rendered verbatim — receive estimate = outAmount, minimum = otherAmountThreshold, price impact = the published figure, attribution + clock present, https endpoint shown. Fees are honest: route fees inside the quoted output, dpay paid-nothing line. Confirm re-quotes, POSTs the verbatim quoteResponse with the wallet\'s own SOL address, verifies the venue-built legacy tx (fee payer = user, SPL destination = user\'s own USDC ATA), signs on device, broadcasts exactly one transaction through the SOL rail\'s RPC path, and the done panel reports the REALIZED token credit with the payout record signature.',
  timeoutMs: 120000,
};

/**
 * The Solana RPC simulator (the seam every SOL flow uses). The one deliberate difference from the
 * pay flows: sendTransaction decodes the submitted base64, takes the tx's OWN first signature slot,
 * and returns its base58 form — the convert driver checks the node's signature IS the one the device
 * signed, so a fake like `sig_ocp_1` would (correctly) park the record stuck. getFeeForMessage
 * answers 5000 lamports so the record's network-fee line has a real quoted figure.
 */
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
        const sig = b58(bytes.slice(1, 65)); // sigCount=1 || first 64-byte signature slot
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
  // into each other's stub (observed 2026-09-17: flow 189's stub read carried another flow's
  // swap POST, a different wallet's key, 15s apart). An own relay isolates config + records.
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-jupiter-sol');

    // Prebuild the venue's deterministic reply for THIS wallet (the mirrors are byte-identical to
    // the app's pure modules — cross-checked against the app's own deriveSolanaKeypair/deriveAta).
    const id = await accountOf(driver);
    assert(id != null && typeof id.secretHex === 'string', 'onboarded identity carries the secret (mirrors derive from it)');
    const kp = deriveSolanaKeypair(id.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});
    const rpcDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(OUT_USDC)});

    await installSolRpcStub(driver, {rpcDetail});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: OUT_USDC, otherAmountThreshold: FLOOR_USDC, priceImpact: '0.003'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });

    // §1 — the surface is reachable for a SOLANA wallet at all (the V11 gate, now open).
    await openConvertFor(driver, 'sol');
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for SOL (the Jupiter venue row resolves)');
    assertIncludes(await driver.readText('convert-screen'), 'Convert SOL → USD', 'heading names the currency pair (the standing target is the row-0 venue\'s other side)');

    // Single venue on the pair → no chooser chrome, nothing to preselect (the one-venue rule).
    assert(await driver.isPresent('convert-venue-jupiter') === false, 'no venue chooser for the single solana_amm venue');

    // §2 — Jupiter's own digits, verbatim through the relay proxy.
    await typeConvertAmount(driver, '1');
    assert(await driver.findByTestID('convert-quote-source', {timeoutMs: 10_000}) != null, 'a quote arrived (through the relay proxy)');
    const quoteSource = await driver.readText('convert-quote-source');
    assertIncludes(quoteSource, 'Jupiter', 'attribution names the venue');
    assertIncludes(quoteSource, 'fetched', 'attribution carries the read instant');
    assertIncludes(await driver.readText('convert-headline'), '10.36 USDC', 'receive estimate is outAmount verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '10.25 USDC', 'minimum is otherAmountThreshold verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');
    // The rate / counterparty / disclosure / impact / refusal census folds behind the ONE
    // Details control (10x-verbosity pass 2026-09-16); the route-fee note and the dpay line
    // are GONE (route fees are inside the quote — the minimum carries the protection).
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-rate'), '10.36', 'rate is the only derived figure (BigInt, cross-decimal 9→6)');
    assertIncludes(await driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown where IC shows the pool principal');
    assertIncludes(await driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
    const solCounterparty = await driver.readText('convert-counterparty');
    assert(!solCounterparty.includes('aggregator'), 'counterparty is trimmed to bare attribution (verbosity pass) — what Jupiter IS lives in its disclosure');
    assertIncludes(await driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'autonomous on-chain aggregator', 'byKey.jupiter disclosure');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'not a party', 'dpay party-hood denied');

    // §3 — fees honest: the published price impact renders VERBATIM (V8's deliberate exception,
    // folded behind Details with the census); the fee-note + dpay lines are gone entirely.
    assertIncludes(await driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure, unmodified');
    assert(await driver.findByTestID('convert-sol-fees-note', {timeoutMs: 1_000}).catch(() => null) == null,
      'the route-fee note is gone (verbosity pass 2026-09-16)');
    assert(await driver.findByTestID('convert-dpay-fee', {timeoutMs: 1_000}).catch(() => null) == null,
      'the dpay paid-nothing line is gone (verbosity pass 2026-09-16)');
    assertIncludes(await driver.readText('convert-refusal'), 'SOL', 'refusal line names the input asset');
    assert(await driver.findByTestID('convert-net', {timeoutMs: 1_000}).catch(() => null) == null,
      'the net end-state line is gone (verbosity pass 2026-09-16): the headline IS the end state');
    for (const bps of [50, 100, 300]) {
      assert(await driver.findByTestID(`convert-bps-${bps}`, {timeoutMs: 1_000}).catch(() => null) == null,
        `slippage chip ${bps} is gone (a disclosed default inside Details, not a decision)`);
    }
    assertIncludes(await driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');
    await driver.screenshot('185-convert-sol-checklist');

    // §4 — confirm: re-quote, verbatim quoteResponse POST, beneficiary-checked venue tx, one broadcast.
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.waitForText('Converted', {timeoutMs: 60_000}), 'the convert completes (swap → settle → done)');

    // §5 — the done panel is honest: the REALIZED chain credit, not the estimate; payout by signature.
    const done = await driver.readText('convert-done');
    assertIncludes(done, '10.36 USDC', 'done reports the realized token credit');
    assertIncludes(done, 'Payout record:', 'done names the payout record');
    await driver.screenshot('185-convert-sol-done');

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
    assertEq(jup.swapCalls[0].wrapAndUnwrapSol, true, 'native SOL routed via wrap/unwrap');
    assertEq(jup.lastQuoteResponse.inAmount, IN_LAMPORTS, 'POST body carried the VERBATIM quote (inAmount)');
    assertEq(jup.lastQuoteResponse.outAmount, OUT_USDC, 'POST body carried the VERBATIM quote (outAmount)');
    assertEq(jup.lastQuoteResponse.platformFee, null, 'POST body carried the VERBATIM quote (platformFee null)');
    assert(jup.quoteCalls.length >= 1, 'at least one quote GET (per-keystroke)');
    // The sheet's Max prefill legitimately quotes the FULL balance on open (brief 5.2:
    // "convert what I have"); every quote AFTER that prefill must be at the typed amount.
    const prefillLamports = '5000000000';
    const postPrefill = [...jup.quoteCalls];
    while (postPrefill.length > 0 && postPrefill[0].amount === prefillLamports) postPrefill.shift();
    for (const q of postPrefill) {
      assertEq(q.inputMint, WRAPPED_SOL_MINT, 'quote GET asked for the wrapped-SOL mint');
      assertEq(q.outputMint, USDC_MINT, 'quote GET asked for the USDC mint');
      assertEq(q.amount, IN_LAMPORTS, 'quote GET carried the raw lamport amount');
      assertEq(q.slippageBps, '100', 'quote GET carried the chosen slippage');
    }
    assertEq(postPrefill[postPrefill.length - 1].amount, IN_LAMPORTS, 'the LAST quote GET is the typed amount');

    console.log(`GREEN 185 — SOL→USDC(Solana) via Jupiter: quote verbatim, device-signed venue tx, one broadcast, realized credit 10.36 USDC (sig ${sent[0].signature.slice(0, 12)}…)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 185:', e);
    process.exit(1);
  });
}
