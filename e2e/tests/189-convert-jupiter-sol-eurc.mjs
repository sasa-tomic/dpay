// Flow 189 — the out-destination picker: SOL → EURC(Solana) through the `jupiter-eurc` venue,
// end to end, offline (spec 2026-09-16 §2 decision 5).
//
// `jupiter-eurc` (registry row kind solana_amm, pair = wrapped-SOL + EURC mints) made SOL hold
// TWO out options — but the surface's first-match venue derivation could only ever reach the
// first one, silently making EURC unreachable. What must be true now that the picker exists:
//
//   1. BOTH DESTINATIONS ARE VISIBLE AND THE DEFAULT IS UNCHANGED. The SOL surface renders one
//      row per registered venue (registry order — `jupiter` first, `jupiter-eurc` second), the
//      FIRST venue (USDC) is preselected and the heading names SOL→USDC before any pick — the
//      exact behavior flow 185 pinned on the one-venue surface.
//   2. THE PICK RE-TARGETS THE PAIR. Selecting the EURC row flips the heading to SOL→EURC and
//      every quote GET afterwards asks for the EURC mint from the `jupiter-eurc` venue's pair.
//   3. THE QUOTE IS STILL JUPITER'S OWN, VERBATIM, THROUGH THE WALLET'S RELAY — the same
//      rules flow 185 holds for USDC: receive estimate = outAmount, minimum =
//      otherAmountThreshold, impact = the published figure, attribution + clock, https
//      endpoint shown.
//   4. WHAT MOVES IS THE VENUE'S OWN TRANSACTION, SIGNED BY THE DEVICE — the beneficiary red
//      line now checked against the user's own EURC ATA, exactly one broadcast, the SOL rail's
//      own RPC path, and the done panel reports the REALIZED on-chain EURC credit.
//
// Offline stand-ins are flow 185's exact seams: the relay's Jupiter test-stub upstream
// (harness/jupiter.mjs configures it — the dials go through dpay's relay proxy) and the
// __DPAY_TEST_SOLANA_RPC_STUB, with
// the getTransaction detail carrying the EURC mint row (the realized-payout oracle matches the
// record's own out mint).
import {setup, assert, assertEq, assertIncludes, onboardWallet, openBalances, accountOf, openConvertFor, pickSwapTarget} from '../harness/lib.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, EURC_MINT, WRAPPED_SOL_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {startRelay} from '../harness/relay.mjs';

/** 1 SOL in, Jupiter's own 84.12 EURC out, floor 83 — the deterministic quote digits. */
const IN_LAMPORTS = '1000000000';
const OUT_EURC = '84120000';
const FLOOR_EURC = '83000000';

export const meta = {
  id: '189',
  name: 'convert-jupiter-sol-eurc',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:jupiter-eurc', 'out-destination', 'quote-verbatim', 'relay-proxy',
    'beneficiary-check', 'execution', 'fees-honest', 'one-broadcast'],
  verifies: 'With two Jupiter venues registered (jupiter, jupiter-eurc) the SOL convert surface renders an out-destination picker with one row per venue in registry order, the FIRST (USDC) preselected — the one-venue behavior unchanged — and picking the EURC row re-targets the pair: every quote GET asks wrapped-SOL → EURC on the jupiter-eurc venue. The EURC quote rides dpay\'s relay Jupiter proxy and is verbatim (estimate, floor, impact, attribution, https endpoint), confirm re-quotes, POSTs the verbatim quoteResponse, verifies the venue-built legacy tx against the user\'s own EURC ATA, signs on device, broadcasts exactly one transaction, and the done panel reports the REALIZED on-chain EURC credit with the payout record signature.',
  timeoutMs: 120000,
};

/** Same simulator as flow 185 (the seam every SOL flow uses) — see that file for the why. */
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
  // into each other's stub (observed 2026-09-17: this flow's stub read carried another flow's
  // swap POST, a different wallet's key, 15s apart). An own relay isolates config + records.
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-jupiter-sol-eurc');

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
      quote: {outAmount: OUT_EURC, otherAmountThreshold: FLOOR_EURC, priceImpact: '0.003'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });

    // §1 — the target list carries every reachable CURRENCY; the standing target is the
    // registry-row-0 venue's other side (USD — exactly flow 185's pair).
    await openConvertFor(driver, 'sol');
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for SOL');
    await pickSwapTarget(driver, 'EUR');
    assertIncludes(await driver.readText('convert-screen'), 'Convert SOL → EUR', 'the heading names the picked pair');

    // §2 — Jupiter's own digits for the EUR pair, verbatim through the relay proxy.

    // §3 — Jupiter's own digits for the EURC pair, verbatim through the relay proxy.
    await driver.type('convert-amount', '1');
    assert(await driver.findByTestID('convert-quote-source', {timeoutMs: 10_000}) != null, 'a quote arrived (through the relay proxy)');
    assertIncludes(await driver.readText('convert-quote-source'), 'Jupiter', 'attribution names the venue');
    assertIncludes(await driver.readText('convert-quote-source'), 'fetched', 'attribution carries the read instant');
    assertIncludes(await driver.readText('convert-headline'), '84.12 EURC', 'receive estimate is outAmount verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '83 EURC', 'minimum is otherAmountThreshold verbatim');
    assertIncludes(await driver.readText('convert-min-out'), '1% slippage', 'slippage choice shown (default 1%)');
    // The census folds behind the ONE Details control (10x-verbosity pass 2026-09-16); the
    // fee-note + dpay lines are gone; the headline IS the end state.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('convert-rate'), '84.12', 'rate is the only derived figure (BigInt, cross-decimal 9→6)');
    assertIncludes(await driver.readText('convert-pool-principal'), 'https://lite-api.jup.ag', 'the venue https endpoint is shown');
    assertIncludes(await driver.readText('convert-counterparty'), 'Jupiter', 'counterparty line names the venue');
    assertIncludes(await driver.readText('convert-counterparty'), 'nobody else signs', 'the Solana signing sentence is present');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'autonomous on-chain aggregator', 'byKey.jupiter disclosure (shared key with the USDC venue)');
    assertIncludes(await driver.readText('convert-venue-disclosure'), 'not a party', 'dpay party-hood denied');
    assertIncludes(await driver.readText('convert-sol-impact'), '0.003', 'price impact is Jupiter\'s own figure, unmodified');
    assert(await driver.findByTestID('convert-sol-fees-note', {timeoutMs: 1_000}).catch(() => null) == null,
      'the route-fee note is gone (verbosity pass 2026-09-16)');
    assert(await driver.findByTestID('convert-dpay-fee', {timeoutMs: 1_000}).catch(() => null) == null,
      'the dpay paid-nothing line is gone (verbosity pass 2026-09-16)');
    assert(await driver.findByTestID('convert-net', {timeoutMs: 1_000}).catch(() => null) == null,
      'the net end-state line is gone (verbosity pass 2026-09-16): the headline IS the end state');
    assertIncludes(await driver.readText('convert-balance'), '5 SOL', 'balance line is the SOL rail balance');
    await driver.screenshot('189-convert-sol-eurc-checklist');

    // §4 — confirm: re-quote, verbatim quoteResponse POST, EURC-ATA beneficiary check, one broadcast.
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.waitForText('Converted', {timeoutMs: 60_000}), 'the convert completes (swap → settle → done)');

    // §5 — the done panel reports the REALIZED on-chain EURC credit, payout by signature.
    const done = await driver.readText('convert-done');
    assertIncludes(done, '84.12 EURC', 'done reports the realized token credit');
    assertIncludes(done, 'Payout record:', 'done names the payout record');
    await driver.screenshot('189-convert-sol-eurc-done');

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
    assertEq(jup.lastQuoteResponse.outputMint, EURC_MINT, 'POST body carried the VERBATIM quote (EURC output mint)');
    assertEq(jup.lastQuoteResponse.outAmount, OUT_EURC, 'POST body carried the VERBATIM quote (outAmount)');
    assertEq(jup.lastQuoteResponse.platformFee, null, 'POST body carried the VERBATIM quote (platformFee null)');
    assert(jup.quoteCalls.length >= 1, 'at least one quote GET (per-keystroke)');
    for (const q of jup.quoteCalls) {
      assertEq(q.inputMint, WRAPPED_SOL_MINT, 'quote GET asked for the wrapped-SOL mint');
      assertEq(q.outputMint, EURC_MINT, 'quote GET asked for the PICKED pair\'s EURC mint');
      assertEq(q.amount, IN_LAMPORTS, 'quote GET carried the raw lamport amount');
      assertEq(q.slippageBps, '100', 'quote GET carried the chosen slippage');
    }

    console.log(`GREEN 189 — SOL→EURC(Solana) via jupiter-eurc through the out-destination picker: default unchanged, pick re-targets the pair, quote verbatim, device-signed venue tx, one broadcast, realized credit 84.12 EURC (sig ${sent[0].signature.slice(0, 12)}…)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 189:', e);
    process.exit(1);
  });
}
