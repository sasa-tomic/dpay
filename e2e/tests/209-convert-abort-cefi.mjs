// Flow 209 — the Stop on the LATER legs (2026-09-24): three abort surfaces in one flow,
// each with the honest story of what a stop can and cannot undo.
//
//   B. CROSSING STOP. The burn is OUT — Circle may still complete the mint, so the flavor
//      is watching and the card never claims nothing moved: the USDC lands at the user's
//      OWN Solana ATA either way. The Circle watch stops on the abort.
//   C. SOL_READY STOP. The final Jupiter leg was UNSIGNED — genuinely clean; the card
//      names where the USDC sits (the ATA) and the exit.
//   A. PROVIDER STOP (awaiting_deposit). Confirm created the venue order — the ONE
//      pre-broadcast side effect — so the aborted card carries BOTH truths: a deposit never
//      sent means the order dies unfunded at the venue; a deposit already sent means the
//      trade may still settle. The card renders the venue's shift id (the copy points at
//      it). Reload: the record STAYS aborted in the store and the stub's status counter
//      proves the poll loop never runs again. Nothing was ever signed — ICP unchanged.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount,
  getBalance, openBalances, selectCurrency,
  openConvertFor,
  pickSwapTarget,
  pickSwapVenue,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, USDC_MINT,
} from '../harness/jupiter.mjs';
import {bs58Encode} from '../harness/soltx.mjs';
import {installCctpStub, setCctpMessageState, cctpStubState, FORWARD_TX_HASH} from '../harness/cctp.mjs';
import {installSideShiftStub, sideShiftStubState} from '../harness/sideshift.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
const ROUTE_C_MECH = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
const CEFI_MECH = 'convert-venue-sideshift';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
const BURN_HASH = '0x' + '3c'.repeat(32);
const SHIFT_ID = 'e2e-shift-9c1d';
const SEED_ICP = 2000000000; // 20 ICP — two 5-ICP route runs + fees, and the CeFi order moves nothing
const SEED_ETH = 400000000000000; // 0.0004 ckETH for the two runs' gas

export const meta = {
  id: '209',
  name: 'convert-abort-cefi',
  journey: 'convert',
  covers: ['convert', 'cefi', 'abort', 'provider-stop', 'crossing-stop', 'sol-ready-stop',
    'pre-broadcast', 'unfunded-order-truth', 'watching-flavor', 'clean-flavor', 'no-resurrection'],
  verifies: 'the Stop on the later conversion legs: a crossing stop keeps the honest watching story (Circle may still mint, the ATA is named) and stops the Circle watch; a sol_ready stop is clean (the final leg was unsigned) and names where the USDC sits; a CeFi awaiting_deposit stop freezes the record aborted with the two-sided unfunded/deposit-sent truth and the venue shift id, survives a reload without ever polling again (stub counter frozen) or re-creating the order, and the ICP ledger is unchanged.',
  timeoutMs: 300000,
};

/** The SOL RPC simulator (the 185/186 seam), keyed for the mint-watch corroboration. */
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
        if (sig === c.forwardTxHash) return c.tokenDetail;
        return c.nativeDetail;
      },
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  }, {forwardTxHash: cfg.forwardTxHash, tokenDetail: cfg.tokenDetail, nativeDetail: cfg.nativeDetail});
}

/** The SOL RPC simulator installed at DOCUMENT START — for the §A reload (the app captures
 *  the stub at module load, so a post-load install would leave the seam fetching the void). */
async function installSolRpcStubAtDocumentStart(driver, cfg) {
  await driver.addInitScript((c) => {
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
          if (sig === c.forwardTxHash) return c.tokenDetail;
          return c.nativeDetail;
        },
        getBalance: () => ({value: 5000000000}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
      };
    }, {forwardTxHash: cfg.forwardTxHash, tokenDetail: cfg.tokenDetail, nativeDetail: cfg.nativeDetail});
}

/** The user's EVM wallet double: records the gesture, returns the burn hash. */
async function installEvmSignSeam(driver, cfg) {
  await driver.eval((c) => {
    globalThis.__E2E_EVM_SIGNS = [];
    globalThis.__DPAY_TEST_EVM_SIGN = async (txs) => {
      globalThis.__E2E_EVM_SIGNS.push(txs);
      return c.burnHash;
    };
  }, {burnHash: cfg.burnHash});
}

/** Confirm a Route C intent through the quote-changed interrupt (the 184/186 pattern). */
async function confirmRouteC(driver, amountText) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await driver.type('convert-amount', amountText).catch(() => undefined);
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
    await driver.click(ROUTE_C_MECH, {timeoutMs: 5_000});
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 20_000});
    await driver.click('btn-convert-confirm');
    const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
    if (changed == null) return;
    console.log(`[209-abort-cefi] quote moved (round ${attempt + 1}) — re-reviewing`);
    await driver.click('btn-convert-back', {timeoutMs: 5_000}).catch(() => undefined);
  }
  throw new Error('quote never settled after 3 re-review rounds');
}

/** One Route C run up to a LIVE crossing. Assumes the Convert surface is open (a fresh
 *  reopenConvert, or an aborted card the caller has already backed out of). */
async function attachBurnAndGetCrossing(driver, amountText) {
  await confirmRouteC(driver, amountText);
  await driver.findByTestID('crossrail-handoff', {timeoutMs: 90_000});
  await driver.waitForText('Step 1', {timeoutMs: 15_000});
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
  await driver.findByTestID('crossrail-crossing', {timeoutMs: 20_000});
}

/** Re-enter the convert surface from the accounts route. */
async function reopenConvert(driver) {
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await openConvertFor(driver, 'icp', {timeoutMs: 8_000});
      await pickSwapTarget(driver, 'SOL');
      await pickSwapVenue(driver, 'multihop:icpswap-ckusdc:2:cctp:jupiter');
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

export async function run() {
  const start = Date.now();
  console.log('[209-abort-cefi] setup (own relay + shared web + browser)…');
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL} = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;

    console.log('[209-abort-cefi] onboarding + funding ICP and ckETH-for-gas…');
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-abort-cefi');
    const account = await accountOf(driver);
    const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
    assert(fundIcp.ok, `faucet ICP credit ok (status ${fundIcp.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    const kp = deriveSolanaKeypair(account.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});
    const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: 2400000});
    const nativeDetail = {
      transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
      meta: {preBalances: [1000000000], postBalances: [1000000000], preTokenBalances: [], postTokenBalances: []},
      slot: 250000001, blockTime: null, version: 'legacy',
    };
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
    await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});
    await configureJupiterStub(r2.baseURL, {
      quote: {outAmount: '260000000', otherAmountThreshold: '257000000', priceImpact: '0.001'},
      userPublicKey: kp.address,
      txBytes,
      lastValidBlockHeight: 300000000,
    });

    // --- §B the CROSSING STOP: the burn is out — watching, never "nothing moved"
    console.log('[209-abort-cefi] §B crossing stop…');
    await installEvmSignSeam(driver, {burnHash: BURN_HASH});
    await reopenConvert(driver);
    await attachBurnAndGetCrossing(driver, '5');
    // The Circle watch is live before the stop: wait for one mint-watch poll.
    await driver.waitForFunction(
      () => globalThis.__E2E_CCTP && globalThis.__E2E_CCTP.messageCalls.length > 0,
      {timeoutMs: 15_000, label: 'the mint watch polls Circle at least once'},
    );
    assert(await driver.findByTestID('btn-convert-stop', {timeoutMs: 4_000}) != null,
      'the Stop is offered on crossing');
    assertIncludes(await driver.readText('btn-convert-stop'), 'Stop watching',
      'the crossing stop is honestly labeled watching (the burn is out)');
    await driver.click('btn-convert-stop', {timeoutMs: 5_000});
    await driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
    const crossingAborted = await driver.readText('convert-aborted');
    assertIncludes(crossingAborted, 'may still complete the mint',
      'the crossing aborted card never claims nothing moved (the mint may still land)');
    assertIncludes(crossingAborted, ataB58, 'the card names where the funds land: the user\'s OWN ATA');
    const pollsAtAbort = await cctpStubState(driver);
    await new Promise((r) => setTimeout(r, 2_500)); // several re-arm windows
    const pollsAfterAbort = await cctpStubState(driver);
    assertEq(pollsAfterAbort.messageCalls.length - pollsAtAbort.messageCalls.length, 0,
      'the Circle watch stops on the abort — no further status polls');
    await driver.screenshot('209-crossing-aborted');
    console.log('[209-abort-cefi] §B GREEN');

    // --- §C the SOL_READY STOP: the final leg was never signed — clean
    console.log('[209-abort-cefi] §C sol_ready stop…');
    await driver.click('btn-convert-back', {timeoutMs: 8_000});
    await reopenConvert(driver);
    await attachBurnAndGetCrossing(driver, '5');
    await setCctpMessageState(driver, 'complete');
    await driver.findByTestID('crossrail-sol-ready', {timeoutMs: 40_000});
    assert(await driver.findByTestID('btn-convert-stop', {timeoutMs: 4_000}) != null,
      'the Stop is offered on sol_ready');
    await driver.click('btn-convert-stop', {timeoutMs: 5_000});
    await driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
    const readyAborted = await driver.readText('convert-aborted');
    assertIncludes(readyAborted, 'Nothing was signed', 'the sol_ready stop is honestly CLEAN');
    assertIncludes(readyAborted, 'final swap never ran', 'the card names what was skipped: the unsigned final leg');
    assertIncludes(readyAborted, ataB58, 'the card names where the USDC sits (the user\'s ATA)');
    assertEq(await driver.eval(() => globalThis.__E2E_SOL_SENT.length), 0,
      'no Solana transaction was ever broadcast — the stop cost nothing');
    await driver.screenshot('209-sol-ready-aborted');
    console.log('[209-abort-cefi] §C GREEN');

    // --- §A the PROVIDER STOP: awaiting_deposit → aborted, honest about the venue order
    console.log('[209-abort-cefi] §A provider stop on awaiting_deposit…');
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});
    await reopenConvert(driver);
    const icpBeforeCefi = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    await driver.type('convert-amount', '3');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
    await driver.click(CEFI_MECH, {timeoutMs: 5_000});
    await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
    // The watch is live before the stop: wait for the first status poll.
    await driver.waitForFunction(
      () => globalThis.__E2E_SIDESHIFT && globalThis.__E2E_SIDESHIFT.statusCalls.length > 0,
      {timeoutMs: 15_000, label: 'the provider watch polls the venue at least once'},
    );
    assert(await driver.findByTestID('btn-convert-stop', {timeoutMs: 4_000}) != null,
      'the Stop is offered on awaiting_deposit');
    await driver.click('btn-convert-stop', {timeoutMs: 5_000});
    await driver.findByTestID('convert-aborted', {timeoutMs: 15_000});
    const providerAborted = await driver.readText('convert-aborted');
    assertIncludes(providerAborted, 'never sent the deposit',
      'the aborted card carries the unfunded-order truth (nothing can move)');
    assertIncludes(providerAborted, 'may still settle',
      'the aborted card carries the deposit-already-sent truth (the trade may still settle)');
    assertIncludes(providerAborted, SHIFT_ID, 'the venue shift id renders (the copy points at it)');
    assert(await driver.findByTestID('btn-convert-stop', {timeoutMs: 1_000}).catch(() => null) == null,
      'no Stop remains on the terminal aborted card');
    await driver.screenshot('209-provider-aborted');
    const icpAfterConfirm = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    assertEq(icpAfterConfirm, icpBeforeCefi, 'ICP ledger UNCHANGED by the CeFi confirm — it signed nothing');

    // Reload: the record STAYS aborted, the watch never comes back, the order is not re-created.
    // The SOL stub rides an init script so the reloaded page boots healthy.
    await installSolRpcStubAtDocumentStart(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});
    const storeAfterReload = await driver.eval(() => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('dpay.convert.v2')) out.push(localStorage.getItem(k) ?? '');
      }
      return out.join('|');
    });
    assert(storeAfterReload.includes('"step":"aborted"'), 'the records are STILL aborted in the persisted store after reload');
    const pollsAtReload = (await sideShiftStubState(driver)).statusCalls.length;
    await new Promise((r) => setTimeout(r, 4_000)); // several engine cadences
    assertEq((await sideShiftStubState(driver)).statusCalls.length, pollsAtReload,
      'the stub counter is FROZEN — no status call ever again for the aborted record');
    const hitsA = await fetch(`${r2.baseURL}/api/v1/test/sideshift-upstream/hits`).then((r) => r.json());
    assertEq(hitsA.shiftCalls, 1, 'exactly ONE venue order was ever created (never re-created across the reload)');
    console.log('[209-abort-cefi] §A GREEN');

    const icpEnd = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    assert(icpEnd < BigInt(SEED_ICP), 'the two route runs moved ICP exactly as signed (the CeFi order never did)');
    console.log(`GREEN 209 — the three stops: crossing (watching, ATA named), sol_ready (clean, USDC located), provider (order truth + frozen watch, still aborted after reload) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 209:', e);
    process.exit(1);
  });
}
