// Flow 186 — the CROSS-RAIL single intent: ICP → SOL via USDC (Route C, 2026-09-16).
//
// One user intent, three worlds: FIVE device-signed IC legs (Route A verbatim — approve, swap,
// approve burn, approve gas, withdraw_erc20 landing USDC at the user's own Ethereum address),
// then the CCTP V2 crossing (dpay builds the calldata, the USER's own EVM wallet signs — the
// handoff surface), then the rail-local Jupiter leg (USDC(SOL) → SOL, device-signed, wave-3a
// verbatim). What must be true — all asserted here:
//
//   1. THE ROUTE IS AN EXPLICIT OPT-IN. The picker offers the direct pair plus all three
//      composed routes (A burn-withdraw, B +CCTP, C +CCTP+Jupiter); the "one route" honesty
//      line is HIDDEN (three routes exist — it would lie); picking C reveals the destination
//      input with the signer warning (the Ethereum address is also the crossing signer).
//   2. THE FEE CENSUS IS HONEST ABOUT WHO PAYS WHAT. The EVM gas is named as the user's
//      wallet's own ETH (dpay can neither pay nor quote it); Circle's bridge fee is Circle's
//      own published number (the stub serves the LIVE fee body, the app's own math derives
//      the census digits); the mint floor names what survives the fee.
//   3. THE HANDOFF NEVER TOUCHES KEYS. dpay renders the two exact transactions (approve →
//      TokenMessenger, burn → depositForBurnWithHook with the device-derived ATA as mint
//      recipient); the wallet double (__DPAY_TEST_EVM_SIGN) records WHAT dpay asked the
//      wallet to sign and returns the burn hash; nothing on dpay's side signed anything.
//   4. THE MINT WATCH IS HONEST, NEVER A FALSE FAILURE. A stalled attestation PARKS the
//      record at crossing with Circle's own status link and the not-failed line; it never
//      flips to failed while the burn is simply not attested yet.
//   5. RELOAD RESUMES FROM THE MINT WATCH — the IC legs are never re-signed (ledger truth:
//      ICP/ckETH unchanged across the reload) and the record picks up at crossing.
//   6. THE FINAL LEG IS THE WAVE-3A JUPITER PATH VERBATIM — fresh quote on the VERIFIED mint
//      credit, venue-built legacy tx, device signature, one broadcast, realized SOL credit in
//      the done panel at the user's Solana address.
//
// Offline stand-ins: the private relay's fake-IC (the 184 pattern — it simulates the pool swap
// and withdraw_erc20), the in-page Circle stub (harness/cctp.mjs — live fee body + scripted
// message states keyed by burn tx hash), the relay's Jupiter test-stub upstream
// (harness/jupiter.mjs configures it — the dials go through dpay's relay proxy) and the SOL
// RPC stub (the 185 seam, extended with a getTransaction keyed by which credit is being read:
// Circle's forward tx → USDC token credit at the ATA; the swap signature → native SOL credit).
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, jupiterStubState, USDC_MINT, WRAPPED_SOL_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {installCctpStub, cctpStubState, setCctpMessageState, cctpFeeExpectations, FORWARD_TX_HASH} from '../harness/cctp.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const ROUTE_C_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
const BURN_HASH = '0x' + '1b'.repeat(32);

const SEED_ICP = 2000000000; // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const AMOUNT_IN_ICP = 500000000n; // 5 ICP
const ICP_FEE = 10000n;
const CKUSDC_FEE = 10000n;
const CKETH_FEE = 2000000000000n;
const GAS_WEI = 78000000000000n;

/** Jupiter's own digits for the final leg: 187-ish USDC → 0.26 SOL, floor 0.257. */
const SOL_OUT = '260000000';
const SOL_FLOOR = '257000000';

export const meta = {
  id: '186',
  name: 'convert-crossrail-icp-sol',
  journey: 'convert',
  covers: ['convert', 'multihop', 'route-c', 'cross-rail', 'cctp', 'circle', 'handoff',
    'external-signature', 'mint-watch', 'jupiter', 'solana-rail', 'reload-recovery',
    'fee-census', 'per-leg-status', 'dead-end-honesty'],
  verifies: 'Route C converts ICP to SOL via USDC as one cross-rail intent: the composed route is an explicit pick beside the direct pair with the signer warning on the destination, the census names the external ETH gas and Circle\'s own fee with the mint floor, the five IC legs execute device-signed, the CCTP burn is built by dpay and signed by the user\'s own wallet (handoff, no dpay keys), a stalled attestation parks with Circle\'s link and never fails falsely, a reload resumes from the mint watch without re-signing the IC legs, and the final Jupiter leg lands realized SOL at the user\'s Solana address.',
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
 *  read: Circle's forward tx hash → the USDC mint credit at the ATA (the mint-watch
 *  corroboration); any other signature → the native SOL credit of the final swap. */
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
        return c.nativeDetail; // the final swap's realized SOL credit
      },
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  }, {forwardTxHash: cfg.forwardTxHash, tokenDetail: cfg.tokenDetail, nativeDetail: cfg.nativeDetail});
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
  console.log('[186-crossrail] setup (own relay + shared web + browser)…');
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});

    console.log('[186-crossrail] onboarding + funding ICP and ckETH-for-gas…');
    await onboardWallet(driver, 'e2e-crossrail-icp-sol');
    const account = await accountOf(driver);
    const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fundIcp.ok, `faucet ICP credit ok (status ${fundIcp.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    // Prebuild the deterministic venue + mint fixtures for THIS wallet.
    const kp = deriveSolanaKeypair(account.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});

    // The census oracle BEFORE anything renders: the app's own fee math runs on the stub's
    // LIVE fee body, so the expected digits derive from the relay's own quote.
    const oracle0 = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
    let gross = BigInt(oracle0.amount_out);
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n; // 1% floor
    let fees = cctpFeeExpectations(minOut);
    const mintCredit = fees.mintFloor; // what Circle's destination mint lands (≤ burn − fees)

    const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(mintCredit)});
    const nativeDetail = {
      // accountKeys[0] is the fee payer — getSolNativeCredit reads its lamports delta, so the
      // fixture must carry the message keys, not just balances.
      transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
      meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
      slot: 250000001, blockTime: null, version: 'legacy',
    };
    // The in-page stubs wrap window.fetch fail-closed (unknown origin → unexpected+throw) — and
    // since the Jupiter dials moved THROUGH the relay (2026-09-16), lite-api.jup.ag is NOT a
    // passed origin anymore: a device-direct regression would hit the fail-closed guard loudly
    // instead of the real internet. The relay's Jupiter stub is configured ONCE on r2 (the
    // relay this page dials) — it is server-side state, it survives the §5 reload.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: SOL_OUT, otherAmountThreshold: SOL_FLOOR, priceImpact: '0.001'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});

    // --- §1 the composed destination is an explicit opt-in (three routes now — no "one route" lie)
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
    await driver.type('convert-amount', '5');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});

    assert(await driver.findByTestID(ROUTE_C_ROW, {timeoutMs: 3_000}) != null, 'the Route C row is offered beside the direct pair');
    assert(await driver.isPresent('convert-route-note') === false, 'the one-route honesty line is HIDDEN (three routes exist)');
    await driver.click(ROUTE_C_ROW);
    // D2 merge (2026-09-18): the SOL destination group now carries TWO mechanisms (the
    // Route C cross-rail + the SideShift cefi venue). A group with NO direct mechanism
    // waits for an explicit pick — nothing is preselected — so select the route mech;
    // only then does the destination address input appear.
    await driver.click('convert-dest-mech-multihop:icpswap-ckusdc:2:cctp:jupiter', {timeoutMs: 4_000});
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-dest-cross-note'), 'also the wallet that signs',
      'the destination input warns that this address also SIGNS the crossing');
    assertIncludes(await driver.readText('convert-route-min'), `${fmt(minOut, 6)} USDC`, 'the route floor is the burn amount, in the HOP asset (USDC — not the SOL destination)');

    // --- §2 the cross-rail fee census: external gas named, Circle's own number, mint floor.
    // The census folds behind the ONE Details control (10x-verbosity pass 2026-09-16) —
    // open it; the route-min floor + the cross-note warning stay on the main surface.
    await driver.click('convert-details', {timeoutMs: 5_000});
    assertIncludes(await driver.readText('crossrail-external-gas'), 'your wallet', 'the census names WHO pays the EVM gas (the user\'s own wallet)');
    assertIncludes(await driver.readText('crossrail-circle-fee'), `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s published fee renders as its own census line (app math on the live body)');
    assertIncludes(await driver.readText('crossrail-mint-floor'), `${fmt(fees.mintFloor, 6)} USDC`, 'the mint floor names what survives the fee');
    assertIncludes(await driver.readText('convert-gas-note'), `${fmt(GAS_WEI, 18)} ETH`, 'the minter gas line is unchanged from Route A');

    // Confirm (quote-changed interrupt → re-review, same as 184).
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      console.log(`[186-crossrail] quote moved (round ${round + 1}) — re-reviewing`);
      const re = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
      gross = BigInt(re.amount_out);
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      fees = cctpFeeExpectations(minOut);
    }

    // --- §3 the handoff: five device-signed IC legs land, then dpay renders the EXACT txs
    await driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000});
    // The panel mounts fresh at the step change (its effects — amount, calldata, fee — land
    // async); wait for the STEP CONTENT, not just the heading, before reading the body.
    await driver.waitForText('Step 1', {timeoutMs: 10_000});

    assert(await driver.findByTestID('crossrail-handoff', {timeoutMs: 3_000}) != null, 'the handoff panel renders');
    const handoff = await driver.readText('crossrail-handoff');
    assertIncludes(handoff, `${fmt(minOut, 6)} USDC`, 'the intro names the crossed amount (the burn floor)');
    assertIncludes(handoff, 'Nothing is signed on dpay', 'the what-signing line says dpay signs nothing');
    const approveData = await driver.readText('crossrail-approve-calldata');
    const burnData = await driver.readText('crossrail-burn-calldata');
    assertIncludes(approveData.slice(0, 10), '0x095ea7b3', 'tx 1 is a plain ERC-20 approve');
    assertIncludes(burnData.slice(0, 10), '0x779b432d', 'tx 2 is depositForBurnWithHook (the live-verified selector)');
    assertIncludes(handoff, 'seconds to a few minutes', 'the timing note sets the honest expectation');
    assertIncludes(handoff, `${fmt(fees.maxFee, 6)} USDC`, 'Circle\'s fee line renders in the handoff too (re-fetched live)');
    await driver.screenshot('186-crossrail-handoff');

    // The wallet double signs, the app attaches the reported hash. The paste gesture IS the
    // typed hash (the button gates on non-empty input); the seam then audits WHAT dpay asked
    // the wallet to sign and returns the same hash. (Retry: the handoff panel's own effects
    // can re-render between find and tap.)
    await installEvmSignSeam(driver, {burnHash: BURN_HASH});
    // A short typed gesture enables the button (the field only gates on non-empty input);
    // the wallet double then supplies the REAL burn hash — 66 keystrokes of churn would
    // straddle find→tap with re-renders (the "Node is detached" failure mode).
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
    assert(await driver.findByTestID('btn-crossrail-view-circle', {timeoutMs: 2_000}) != null, 'Circle\'s own status link is offered (the actionable exit)');
    assert(await driver.findByTestID('btn-crossrail-view-burn', {timeoutMs: 2_000}) != null, 'the burn tx link is offered');
    const sig = await driver.eval(() => globalThis.__E2E_EVM_SIGNS);
    assertEq(sig.length, 1, 'exactly ONE wallet signing gesture');
    assertIncludes(sig[0].burnCalldata.slice(0, 10), '0x779b432d', 'what dpay asked the wallet to sign IS the burn calldata');
    assertIncludes(sig[0].approveCalldata.slice(0, 10), '0x095ea7b3', '…and the approve calldata');
    assertIncludes(sig[0].burnTo.toLowerCase(), '28b5a0e9c621a5badaa536219b3a228c8168cf5d', 'the burn targets Circle\'s TokenMessengerV2');
    assertIncludes(sig[0].approveTo.toLowerCase(), 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'the approve targets canonical USDC');
    assertEq(sig[0].amountSubunits, minOut.toString(), 'the crossed amount is the swap\'s 1% floor');
    await driver.screenshot('186-crossrail-crossing');

    // The STALL: state still pending — the record must stay parked, not failed. Deterministic
    // stand-in for a blind sleep: wait until the mint watch has polled AGAIN (the stub's
    // message census grows past its current size — one full poll cycle has then elapsed, at
    // whatever speed this machine runs), THEN assert the crossing is still the mounted panel.
    const pollsAtStall = await driver.eval(() => globalThis.__E2E_CCTP.messageCalls.length);
    await driver.waitForFunction(
      (n) => globalThis.__E2E_CCTP && globalThis.__E2E_CCTP.messageCalls.length > n,
      {timeoutMs: 15_000, label: 'the mint watch polls again while parked', args: [pollsAtStall]},
    );
    assert(await driver.findByTestID('crossrail-crossing', {timeoutMs: 1_000}) != null, 'a stalled attestation stays parked at crossing (honest pending)');
    // The census evidence lives in the page's stub — the reload about to happen resets it, so
    // capture the pre-reload counters now and audit ACROSS the two epochs at the end.
    const cctpBeforeReload = await cctpStubState(driver);

    // --- §5 reload: the engine resumes from the MINT WATCH; the IC legs are never re-signed
    const icpBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    const ethBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    // The window-scoped stubs died with the page — reinstall them (state still pending). The
    // Jupiter stub needs no reinstall: it is the relay's server-side test stub.
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    // The returning wallet mounts under continuous polls — give the convert entry a couple of
    // tries (a re-render can detach the node mid-gesture).
    await openBalances(driver); // back to the accounts route — the convert entry lives there, not on the asset view
    let opened = false;
    for (let i = 0; i < 3 && !opened; i++) {
      try {
        await driver.click('btn-accounts-convert', {timeoutMs: 8_000});
        opened = true;
      } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
    }
    await driver.findByTestID('crossrail-crossing', {timeoutMs: 15_000});
    // One CDP round trip for all six leg states (a per-leg readText is its own eval — pure
    // latency ×6); the reads land in-page and the asserts stay in Node.
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

    // --- §6 the mint lands: Circle reports complete, dpay CORROBORATES at the ATA, then SOL
    await setCctpMessageState(driver, 'complete');
    await driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
    const ready = await driver.readText('crossrail-sol-ready');
    assertIncludes(ready, `${fmt(mintCredit, 6)} USDC`, 'the verified mint credit renders (corroborated on-chain at the ATA)');
    assertIncludes(ready, ataB58, 'the USDC location is named: the user\'s own ATA');
    assertIncludes(ready, 'it is yours either way', 'keeping the USDC is offered as an equal exit');
    assertIncludes(await driver.readText('crossrail-sol-out'), fmt(SOL_OUT, 9), 'the fresh Jupiter estimate renders (SOL now, not USDC)');
    assertIncludes(ready, `${fmt(SOL_FLOOR, 9)} SOL`, 'the final leg\'s floor is Jupiter\'s own otherAmountThreshold');
    await driver.screenshot('186-crossrail-sol-ready');

    await driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
    await driver.waitForText('verified on-chain', {timeoutMs: 60_000});
    const done = await driver.readText('convert-done');
    assertIncludes(done, `${fmt(SOL_OUT, 9)} SOL`, 'done reports the REALIZED native credit, at the user\'s Solana address');
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
    await driver.screenshot('186-crossrail-done');

    // --- stub audits + ledger truth
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 1, 'exactly ONE Solana transaction was ever broadcast');
    assertIncludes(done, sent[0].signature, 'the payout record IS the broadcast signature');
    const jup = await jupiterStubState(r2.baseURL);
    assert(jup != null, 'jupiter stub state present');
    assertEq(jup.unexpected.length, 0, 'jupiter stub saw no unexpected upstream requests');
    assert(jup.userMismatch == null, 'the swap POST carried THIS wallet\'s SOL address');
    assertEq(jup.swapCalls.length, 1, `exactly one swap POST (saw: ${JSON.stringify(jup.swapCalls)})`);
    const finalLegQuotes = jup.quoteCalls.filter((q) => q.inputMint === USDC_MINT && q.outputMint === WRAPPED_SOL_MINT);
    assert(finalLegQuotes.length >= 1, 'the final leg quoted USDC→wrapped-SOL (fresh, on the verified credit)');
    assertEq(finalLegQuotes[0].amount, mintCredit.toString(), 'the final quote was for the VERIFIED mint amount');
    const cctp = await cctpStubState(driver);
    assertEq(cctp.unexpected.length, 0, `cctp stub saw no unexpected origins (${cctp.unexpected.join(', ')})`);
    assert(cctpBeforeReload.feesCalls + cctp.feesCalls >= 2, 'the fee census was fetched (form + prepare/handoff — pre- and post-reload epochs summed)');
    const allMessageCalls = [...cctpBeforeReload.messageCalls, ...cctp.messageCalls];
    assert(allMessageCalls.length >= 2, 'the mint watch polled by burn tx hash');
    for (const m of allMessageCalls) {
      assertEq(m.hash, BURN_HASH, 'every status poll was keyed by the burn tx hash');
    }
    // Ledger truth keys on the CONFIRM-TIME oracle (the last quote the app acted on — `gross` from
    // the confirm loop), never a fresh end-of-run quote: the FakeLedger pool can drift between.
    assertEq(icpAfter, BigInt(SEED_ICP) - AMOUNT_IN_ICP - 2n * ICP_FEE, 'ICP ledger: amount + two fees (unchanged by the crossing — off-IC)');
    assertEq(BigInt(await getBalance(r2.baseURL, account.publicHex, 2)), gross - minOut - CKUSDC_FEE,
      'ckUSDC ledger: gross − burned(minOut) − approve fee (surplus stays in-wallet, Route A semantics)');
    assertEq(ethAfter, BigInt(SEED_ETH) - GAS_WEI - CKETH_FEE, 'ckETH ledger: the minter\'s gas burn + its approve fee');

    console.log(`GREEN 186 — ICP→SOL cross-rail: 5 IC legs + wallet-signed CCTP burn + attestation watch + reload resume + Jupiter leg; ${fmt(SOL_OUT, 9)} SOL at ${kp.address.slice(0, 8)}… (sig ${sent[0].signature.slice(0, 12)}…) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 186:', e);
    process.exit(1);
  });
}
