// Flow 195 — the CROSS-RAIL single intent to a REGISTERED SPL TOKEN: ICP → EURC via USDC
// (Route C generalized, 2026-09-19). Mirrors 186 leg-for-leg with the final Jupiter leg
// swapped for the jupiter-usdc-eurc venue: FIVE device-signed IC legs (Route A verbatim —
// approve, swap, approve burn, approve gas, withdraw_erc20 landing USDC at the user's own
// Ethereum address), the CCTP V2 crossing (dpay builds the calldata, the USER's own EVM
// wallet signs), then the rail-local Jupiter leg USDC(SOL) → EURC (device-signed, the SAME
// wave-3a machinery — the out mint is the record's own frozen EURC mint). What must be
// true — all asserted here:
//
//   1. THE EURC ROUTE IS AN EXPLICIT OPT-IN BESIDE THE ORIGINAL. The picker offers the
//      direct pair, Route A, Route B, the Route C SOL row AND the Route C EURC row
//      (registry order); picking the EURC route reveals the destination input with the
//      signer warning — the SAME surface the SOL route renders through.
//   2. THE FEE CENSUS IS HONEST AND UNCHANGED. The EVM gas is the user's wallet's own
//      ETH; Circle's bridge fee is Circle's own published number; the mint floor names
//      what survives the fee — all in the HOP asset (USDC), identical to 186.
//   3. THE HANDOFF NEVER TOUCHES KEYS — byte-identical CCTP chain to 186 (the EURC leg
//      is downstream of the mint; the burn calldata cannot tell the destinations apart).
//   4. THE MINT WATCH IS HONEST, NEVER A FALSE FAILURE (the 186 stall contract, replayed).
//   5. RELOAD RESUMES FROM THE MINT WATCH — the IC legs are never re-signed (ledger truth:
//      ICP/ckETH unchanged across the reload) and the record picks up at crossing.
//   6. THE FINAL LEG IS THE WAVE-3A JUPITER PATH VERBATIM, IN THE OUT MINT'S UNITS — a
//      fresh quote on the VERIFIED mint credit keyed USDC→EURC, the destination ATA
//      OWNER is the device's own address, one broadcast, and the done panel reports the
//      realized EURC token credit at the user's Solana address (NEVER a lamports read —
//      that would be a unit bug). The floor line and confirm button name EURC through
//      the SAME copy surfaces SOL flows through — a "EURC EURC" double-unit is a bug.
//
// Offline stand-ins: the private relay's fake-IC (the 184 pattern), the in-page Circle
// stub (harness/cctp.mjs — live fee body + scripted message states keyed by burn tx hash),
// the relay's Jupiter test-stub upstream (harness/jupiter.mjs configures it with a
// USDC→EURC quote and a venue tx paying out at the user's EURC ATA), and the SOL RPC stub
// (the 185 seam — getTransaction is KEYED: Circle's forward tx → the USDC mint credit at
// the USDC ATA; the swap signature → the EURC token credit at the EURC ATA).
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency, openConvertFor,
  pickSwapTarget,
  pickSwapVenue,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, USDC_MINT, EURC_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {installCctpStub, cctpStubState, setCctpMessageState, cctpFeeExpectations, FORWARD_TX_HASH} from '../harness/cctp.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const ROUTE_C_SOL_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
const ROUTE_C_EURC_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc';
const ROUTE_C_EURC_MECH = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter-usdc-eurc';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
const BURN_HASH = '0x' + '2c'.repeat(32);

const SEED_ICP = 2000000000; // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const AMOUNT_IN_ICP = 500000000n; // 5 ICP
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;

/** Jupiter's own digits for the final leg: ~187.7 USDC → 10.3 EURC, floor 10.2 (6 decimals). */
const EURC_OUT = '10300000';
const EURC_FLOOR = '10200000';

export const meta = {
  id: '195',
  name: 'convert-crossrail-icp-eurc',
  journey: 'convert',
  covers: ['convert', 'multihop', 'route-c', 'cross-rail', 'cctp', 'circle', 'handoff',
    'external-signature', 'mint-watch', 'jupiter', 'eurc', 'solana-rail', 'reload-recovery',
    'fee-census', 'per-leg-status', 'dead-end-honesty'],
  verifies: 'Route C generalizes to a registered USDC-pair SPL token — one intent ICP→EURC: the EURC route composes beside the SOL one in registry order with the same signer warning, the census names the external ETH gas and Circle\'s own fee with the mint floor (USDC-denominated), the five IC legs execute device-signed, the CCTP burn is wallet-signed via the handoff (no dpay keys), a stalled attestation parks and never fails falsely, a reload resumes from the mint watch without re-signing the IC legs, and the final Jupiter leg quotes USDC→EURC on the verified credit, pins the device\'s own EURC ATA as the beneficiary, and lands realized EURC at the user\'s Solana address — same surfaces, same copy, EURC units.',
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

/** The SOL RPC simulator (the 185 seam). getTransaction is KEYED by which credit is being
 *  read: Circle's forward tx hash → the USDC mint credit at the USDC ATA (the mint-watch
 *  corroboration); any other signature → the EURC token credit of the final swap. */
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
      getSignaturesForAddress: () => [],
      getBlockHeight: () => 250000000,
      getTransaction: (params) => {
        const sig = Array.isArray(params) ? params[0] : null;
        if (sig === c.forwardTxHash) return c.tokenDetail; // Circle's destination mint (USDC at the ATA)
        return c.eurcDetail; // the final swap's realized EURC credit
      },
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  }, {forwardTxHash: cfg.forwardTxHash, tokenDetail: cfg.tokenDetail, eurcDetail: cfg.eurcDetail});
}

/** The user's EVM wallet double: records WHAT dpay asked the wallet to sign, returns the
 *  burn tx hash (the gesture). dpay never sees a key — the seam only echoes a hash. */
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
  console.log('[195-crossrail-eurc] setup (own relay + shared web + browser)…');
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[195-crossrail-eurc] onboarding + funding ICP and ckETH-for-gas…');
    await onboardWallet(driver, 'e2e-crossrail-icp-eurc');
    const account = await accountOf(driver);
    const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fundIcp.ok, `faucet ICP credit ok (status ${fundIcp.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    // Prebuild the deterministic venue + mint fixtures for THIS wallet. The final leg pays
    // out at the USER'S OWN EURC ATA — the tx fixture carries it, the app's beneficiary
    // check re-derives it from the device seed and refuses anything else.
    const kp = deriveSolanaKeypair(account.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const eurcAtaB58 = bs58Encode(deriveAta(kp.address, EURC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: eurcAtaB58});

    // The census oracle BEFORE anything renders: the app's own fee math runs on the stub's
    // LIVE fee body, so the expected digits derive from the relay's own quote.
    const oracle0 = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
    let gross = BigInt(oracle0.amount_out);
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% floor
    let fees = cctpFeeExpectations(minOut);
    const mintCredit = fees.mintFloor; // what Circle's destination mint lands (≤ burn − fees)

    const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(mintCredit)});
    const eurcDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: eurcAtaB58, outAmount: Number(EURC_OUT), mint: EURC_MINT, decimals: 6});
    // The in-page stubs wrap window.fetch fail-closed — and since the Jupiter dials moved
    // THROUGH the relay, lite-api.jup.ag is NOT a passed origin anymore: a device-direct
    // regression would hit the fail-closed guard loudly. The relay's Jupiter stub is
    // configured ONCE on r2 (the relay this page dials) — server-side state, it survives
    // the §5 reload.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, eurcDetail});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: EURC_OUT, otherAmountThreshold: EURC_FLOOR, priceImpact: '0.001'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});

    // --- §1 the composed destination is an explicit opt-in — BOTH Route C rows, registry order
    await openConvertFor(driver, 'icp');
    // The EUR target needs the EURC(Solana) rail in the wallet's asset list — the RPC stub's
    // first answers must land before the currency list offers EUR.
    await new Promise((r) => setTimeout(r, 2_500));
    await driver.screenshot('195-probe-entry');
    const ids = await driver.eval(() => Array.from(document.querySelectorAll('[data-testid]')).map(n => n.getAttribute('data-testid')).filter(t => t.startsWith('convert-')));
    console.log('PROBE-SURFACE ' + JSON.stringify([...new Set(ids)]));
    await pickSwapTarget(driver, 'EUR');
    await driver.type('convert-amount', '5');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});

    // The original Route C SOL row lives on the SOL target; the EUR target carries the
    // generalization beside its own CeFi venue (each mechanism IS a row now).
    await pickSwapTarget(driver, 'SOL');
    assert(await driver.findByTestID(ROUTE_C_SOL_ROW, {timeoutMs: 3_000}) != null, 'the original Route C SOL row is still offered');
    await pickSwapTarget(driver, 'EUR');
    assert(await driver.findByTestID(ROUTE_C_EURC_ROW, {timeoutMs: 3_000}) != null, 'the Route C EURC row is offered beside the CeFi venue (the generalization)');
    await driver.click(ROUTE_C_EURC_ROW);
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-dest-cross-note'), 'also the wallet that signs',
      'the destination input warns that this address also SIGNS the crossing — the SAME surface the SOL route renders');
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset (USDC — identical census to the SOL route)');

    // --- §2 the cross-rail fee census: external gas named, Circle's own number, mint floor.
    // The census folds behind the ONE Details control — open it; the route-min floor + the
    // cross-note warning stay on the main surface.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas (the user\'s own wallet)');
    assertIncludes(await driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line (app math on the live body)');
    assertIncludes(await driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
    assertIncludes(await driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the minter gas line is unchanged from Route A');

    // Confirm (quote-changed interrupt → re-review, same as 184/186).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[195-crossrail-eurc] quote moved (round ${round + 1}) — re-reviewing`);
      const re = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
      gross = BigInt(re.amount_out);
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      fees = cctpFeeExpectations(minOut);
    }

    // --- §3 the handoff: five device-signed IC legs land, then dpay renders the EXACT txs.
    // The CCTP chain is byte-identical to the SOL route — the EURC leg is downstream of
    // the mint, so the burn calldata cannot tell the destinations apart.
    await driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000});
    await driver.waitForText('Step 1', {timeoutMs: 10_000});

    assert(await driver.findByTestID('crossrail-handoff', {timeoutMs: 3_000}) != null, 'the handoff panel renders');
    const handoff = await driver.readText('crossrail-handoff');
    assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
    assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
    const approveData = await driver.readText('crossrail-approve-calldata');
    const burnData = await driver.readText('crossrail-burn-calldata');
    assertIncludes(approveData.slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
    assertIncludes(burnData.slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook (the live-verified selector)');
    assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too (re-fetched live)');
    await driver.screenshot('195-crossrail-eurc-handoff');

    // The wallet double signs, the app attaches the reported hash (the 186 gesture).
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
    await driver.findByTestID('crossrail-crossing', {timeoutMs: 10_000});

    // --- §4 the mint watch: parked pending with Circle's link — never a false failure
    const crossing = await driver.readText('crossrail-crossing');
    assertIncludes(crossing, 'Crossing to Solana', 'the crossing panel titles the wait');
    assertIncludes(crossing, BURN_HASH, 'the burn tx hash is visible and copyable');
    assertIncludes(await driver.readText('crossrail-still'), 'not failed', 'the not-failed line is explicit while attestation is unfinished');
    const sig = await driver.eval(() => globalThis.__E2E_EVM_SIGNS);
    assertEq(sig.length, 1, 'exactly ONE wallet signing gesture');
    assertIncludes(sig[0].burnCalldata.slice(0, 10), '0x779b432d', 'what dpay asked the wallet to sign IS the burn calldata');
    assertEq(sig[0].amountSubunits, minOut.toString(), 'the crossed amount is the swap\'s 1% floor');
    // The STALL: state still pending — the record must stay parked, not failed. Wait until
    // the mint watch has polled AGAIN, then assert the crossing is still the mounted panel.
    const pollsAtStall = await driver.eval(() => globalThis.__E2E_CCTP.messageCalls.length);
    await driver.waitForFunction(
      (n) => globalThis.__E2E_CCTP && globalThis.__E2E_CCTP.messageCalls.length > n,
      {timeoutMs: 15_000, label: 'the mint watch polls again while parked', args: [pollsAtStall]},
    );
    assert(await driver.findByTestID('crossrail-crossing', {timeoutMs: 1_000}) != null, 'a stalled attestation stays parked at crossing (honest pending)');
    const cctpBeforeReload = await cctpStubState(driver);

    // --- §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed
    const icpBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const ethBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    // The window-scoped stubs died with the page — reinstall them (state still pending).
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, eurcDetail});
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver); // back to the accounts route — the convert entry lives there
    // §5's reload re-enters on the LIVE crossrail record — the record view IS the screen; no
    // form walk (the pick gestures are form-only).
    await openConvertFor(driver, 'icp', {timeoutMs: 8_000});
    await driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
    // One CDP round trip for all six leg states; the reads land in-page, asserts stay in Node.
    const legsAfterReload = await driver.eval(() =>
      Array.from({length: 6}, (_, i) => {
        const el = document.querySelector(`[data-testid="convert-leg-${i}-state"]`);
        if (!el) throw new Error(`convert-leg-${i}-state missing`);
        return el.textContent || '';
      }),
    );
    for (let i = 0; i < 5; i++) {
      assertIncludes(legsAfterReload[i], 'Confirmed', `after reload IC leg ${i} reads Confirmed (resumed, not re-signed)`);
    }
    assertIncludes(legsAfterReload[5], 'Sent', 'the cctp_burn leg reads Sent (hash known, mint watched)');
    const icpAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const ethAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    assertEq(icpAfter, icpBefore, 'ICP ledger UNCHANGED across the reload — the IC legs were never re-signed');
    assertEq(ethAfter, ethBefore, 'ckETH ledger UNCHANGED across the reload');

    // --- §6 the mint lands: Circle reports complete, dpay CORROBORATES the USDC at the
    // ATA, then the EURC leg offers on a FRESH quote — same surfaces as the SOL route.
    await setCctpMessageState(driver, 'complete');
    await driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
    const ready = await driver.readText('crossrail-sol-ready');
    assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders (corroborated on-chain at the ATA)');
    assertIncludes(ready, ataB58, 'the USDC location is named: the user\'s own ATA');
    assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
    assertIncludes(await driver.readText('crossrail-sol-out'), fmt(EURC_OUT, 6), 'the fresh Jupiter estimate renders in EURC units (EURC now, not USDC/SOL)');
    assertIncludes(ready, `${fmt(EURC_FLOOR, 6)} EURC`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold, named EURC');
    assert(!ready.includes('EURC EURC'), 'no double-unit on the EURC floor line (the copy owns the unit — the 186 latent bug stays dead)');
    assertIncludes(await driver.readText('btn-crossrail-sol-confirm'), 'Swap to EURC', 'the confirm button names the destination token through the SAME copy slot SOL uses');
    await driver.screenshot('195-crossrail-eurc-sol-ready');

    await driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
    await driver.waitForText('verified on-chain', {timeoutMs: 60_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt(EURC_OUT, 6)} EURC`, 'done reports the REALIZED EURC credit, at the user\'s Solana address');
    assert(!done.includes('EURC EURC'), 'no double-unit on the done panel either');
    assertIncludes(done, kp.address, 'the Solana address is named');
    const finalLegs = await driver.eval(() =>
      Array.from({length: 7}, (_, i) => {
        const el = document.querySelector(`[data-testid="convert-leg-${i}-state"]`);
        if (!el) throw new Error(`convert-leg-${i}-state missing`);
        return el.textContent || '';
      }),
    );
    for (let i = 0; i < 7; i++) {
      assertIncludes(finalLegs[i], 'Confirmed', `final leg ${i} of 7 reads Confirmed`);
    }
    await driver.screenshot('195-crossrail-eurc-done');

    // --- stub audits + ledger truth
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 1, 'exactly ONE Solana transaction was ever broadcast');
    assertIncludes(done, sent[0].signature, 'the payout record IS the broadcast signature');
    const jup = await jupiterStubState(r2.baseURL);
    assert(jup != null, 'jupiter stub state present');
    assertEq(jup.unexpected.length, 0, 'jupiter stub saw no unexpected upstream requests');
    assert(jup.userMismatch == null, 'the swap POST carried THIS wallet\'s SOL address');
    assertEq(jup.swapCalls.length, 1, `exactly one swap POST (saw: ${JSON.stringify(jup.swapCalls)})`);
    const eurcLegQuotes = jup.quoteCalls.filter((q) => q.inputMint === USDC_MINT && q.outputMint === EURC_MINT);
    assert(eurcLegQuotes.length >= 1, 'the final leg quoted USDC→EURC (fresh, on the verified credit)');
    assertEq(eurcLegQuotes[0].amount, mintCredit.toString(), 'the final quote was for the VERIFIED mint amount');
    const cctp = await cctpStubState(driver);
    assertEq(cctp.unexpected.length, 0, `cctp stub saw no unexpected origins (${cctp.unexpected.join(', ')})`);
    assert(cctpBeforeReload.feesCalls + cctp.feesCalls >= 2, 'the fee census was fetched (form + prepare/handoff — pre- and post-reload epochs summed)');
    const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctp.messageCalls];
    assert(allMessageCalls.length >= 2, 'the mint watch polled by burn tx hash');
    for (const m of allMessageCalls) {
      assertEq(m.hash, BURN_HASH, 'every status poll was keyed by the burn tx hash');
    }
    // Ledger truth keys on the CONFIRM-TIME oracle (the last quote the app acted on),
    // never a fresh end-of-run quote: the FakeLedger pool can drift between.
    assertEq(icpAfter, BigInt(SEED_ICP) - AMOUNT_IN_ICP - 2n * ICP_FEE, 'ICP ledger: amount + two fees (unchanged by the crossing — off-IC)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 2)), gross - minOut - CKUSDC_FEE,
      'ckUSDC ledger: gross − burned(minOut) − approve fee (surplus stays in-wallet, Route A semantics)');
    assertEq(ethAfter, BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE, 'ckETH ledger: the minter\'s gas burn + its approve fee');

    console.log(`GREEN 195 — ICP→EURC cross-rail: 5 IC legs + wallet-signed CCTP burn + attestation watch + reload resume + USDC→EURC Jupiter leg; ${fmt(EURC_OUT, 6)} EURC at ${kp.address.slice(0, 8)}… (sig ${sent[0].signature.slice(0, 12)}…) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 195:', e);
    process.exit(1);
  });
}
