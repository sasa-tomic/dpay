// ux-capture-convert-rails.mjs — FREE-DRIVE pixel capture for the two newest Convert surfaces
// (cross-rail Routes B/C, flow-186 machinery; CeFi SideShift, flow-187 machinery). The flows
// assert logic and drop light-en screenshots along the way; this script exists for the UX pass:
// it drives the SAME real app through every state the flows skip — the destination picker with
// ALL five rows, the DECLINE dead-end, DARK mode, and es/fr/de — and screenshots each one for
// zai-vision review. No assertions beyond sanity waits: a capture that fails loudly on a missing
// testID is the signal, not a red test.
//
// Phases (DPAY_UX_PHASES, default 'a,b,c,d,e'):
//   a — LIGHT en, cross-rail Route C: picker → census → handoff → DECLINED → (new order) →
//       crossing → sol_ready → done.
//   b — DARK en, CeFi SideShift: picker → checklist → deposit handoff → processing → done →
//       expired → refunded.
//   c/d/e — es-ES / fr-FR / de-DE light, CeFi lite: picker → checklist → deposit → expired.
//
// Run: node e2e/ux-capture-convert-rails.mjs   (shots land in shots/ux-convert-<phase>-*.png)
import {setup, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';
import {
  deriveSolanaKeypair, deriveAta, buildJupiterSwapTx, solConvertTxDetail,
  configureJupiterStub, USDC_MINT,
} from './harness/jupiter.mjs';
import {bs58Encode} from './harness/soltx.mjs';
import {installCctpStub, cctpFeeExpectations, FORWARD_TX_HASH} from './harness/cctp.mjs';
import {installSideShiftStub, setSideShiftStatus} from './harness/sideshift.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai';
const ROUTE_C_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter';
const CEFI_ROW = 'convert-dest-cefi-sideshift';
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase();
const BURN_HASH = '0x' + '1b'.repeat(32);
const SEED_ICP = 2000000000; // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const AMOUNT_IN_ICP = 500000000n; // 5 ICP
const SOL_OUT = '260000000';

const PHASES = (process.env.DPAY_UX_PHASES ?? 'a,b,c,d,e').split(',');

async function relayQuote(relayBaseURL, pool, tokenIn, tokenOut, amountIn) {
  const res = await fetch(`${relayBaseURL}/api/v1/swap_quote?pool=${pool}&token_in=${tokenIn}&token_out=${tokenOut}&amount_in=${amountIn}`);
  if (!res.ok) throw new Error(`relay oracle quote failed (${res.status})`);
  return res.json();
}

// --- the two flow-186-local stubs, copied verbatim (they live inside the flow file) -------------

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

async function installEvmSignSeam(driver, cfg) {
  await driver.eval((c) => {
    globalThis.__E2E_EVM_SIGNS = [];
    globalThis.__DPAY_TEST_EVM_SIGN = async (txs) => {
      globalThis.__E2E_EVM_SIGNS.push(txs);
      return c.burnHash;
    };
  }, {burnHash: cfg.burnHash});
}

// --- shared walking helpers ----------------------------------------------------------------------

async function openConvertIcp(driver) {
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver);
  for (let i = 0; i < 3; i++) {
    try {
      await driver.click('btn-accounts-convert', {timeoutMs: 8_000});
      return;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function reopenConvert(driver) {
  await openConvertIcp(driver);
}

async function boot(env, r2, {tag, dark = false, locale} = {}) {
  const {driver, webBaseURL} = env;
  const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
  await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await onboardWallet(driver, `e2e-ux-${tag}`);
  const account = await accountOf(driver);
  const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
  if (!fundIcp.ok) throw new Error(`faucet ICP failed (${fundIcp.status})`);
  return {driver, webBaseURL, page, account};
}

// --- phase a: light en, the cross-rail walk incl. the DECLINE dead-end ----------------------------

async function phaseA() {
  console.log('[ux-a] light en — cross-rail Route C walk…');
  const env = await setup({solStub: true});
  const r2 = await startRelay();
  try {
    const {driver, page, account} = await boot(env, r2, {tag: 'crossrail-a'});
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    if (!fundEth.ok) throw new Error('faucet ckETH failed');

    const kp = deriveSolanaKeypair(account.secretHex);
    const ataB58 = bs58Encode(deriveAta(kp.address, USDC_MINT));
    const txBytes = buildJupiterSwapTx({userPublicKey: kp.address, userAta: ataB58});

    const oracle0 = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
    let gross = BigInt(oracle0.amount_out);
    let minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
    let fees = cctpFeeExpectations(minOut);
    const mintCredit = fees.mintFloor;

    const tokenDetail = solConvertTxDetail({userPublicKey: kp.address, userAta: ataB58, outAmount: Number(mintCredit)});
    const nativeDetail = {
      transaction: {signatures: ['sol-swap'], message: {accountKeys: [kp.address]}},
      meta: {preBalances: [1000000000], postBalances: [1000000000 + Number(SOL_OUT)], preTokenBalances: [], postTokenBalances: []},
      slot: 250000001, blockTime: null, version: 'legacy',
    };
    const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
    const installAll = async () => {
      await installSolRpcStub(driver, {forwardTxHash: FORWARD_TX_HASH, tokenDetail, nativeDetail});
      // The relay's Jupiter test-stub upstream (the dials go through the relay proxy; the
      // config POST is idempotent, so re-running installAll across page reloads is harmless).
      await configureJupiterStub(r2.baseURL, {
        quote: {outAmount: SOL_OUT, otherAmountThreshold: '257000000', priceImpact: '0.001'},
        userPublicKey: kp.address,
        txBytes,
        lastValidBlockHeight: 300000000,
      });
      await installCctpStub(driver, {passOrigins, forwardTxHash: FORWARD_TX_HASH});
    };
    await installAll();

    // The picker with ALL five destination rows (direct + A + B + C + cefi).
    await openConvertIcp(driver);
    await driver.type('convert-amount', '5');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.screenshot('ux-convert-a-picker');

    // Route C: census (external gas + Circle fee + mint floor), then confirm through.
    await driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    await driver.screenshot('ux-convert-a-census');
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
      const re = await relayQuote(r2.baseURL, CKUSDC_POOL, ICP_LEDGER, CKUSDC_LEDGER, AMOUNT_IN_ICP);
      gross = BigInt(re.amount_out);
      minOut = (gross / 10000n) * 9900n + ((gross % 10000n) * 9900n) / 10000n;
      fees = cctpFeeExpectations(minOut);
    }

    // Handoff, then the DECLINE dead-end (funds sit as USDC at the user's own ETH address).
    await driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000});
    await driver.waitForText('Step 1', {timeoutMs: 10_000});
    await driver.screenshot('ux-convert-a-handoff');
    await driver.click('btn-crossrail-decline', {timeoutMs: 5_000});
    await driver.findByTestID('convert-failed-leg', {timeoutMs: 10_000});
    await driver.screenshot('ux-convert-a-declined');

    // A second order, driven all the way: handoff → crossing → sol_ready → done.
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await reopenConvert(driver);
    await driver.type('convert-amount', '5');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
    await driver.type('convert-dest-address', DEST);
    await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
    for (let round = 0; round < 5; round++) {
      await driver.click('btn-convert-confirm');
      const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
      if (changed == null) break;
    }
    await driver.waitForText('is at your Ethereum address', {timeoutMs: 60_000});
    await driver.waitForText('Step 1', {timeoutMs: 10_000});

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
    await driver.screenshot('ux-convert-a-crossing');

    // Page-scoped stubs survive here (no reload in this walk) — just flip the message state.
    const setCctpComplete = async () => {
      const {setCctpMessageState} = await import('./harness/cctp.mjs');
      await setCctpMessageState(driver, 'complete');
    };
    await setCctpComplete();
    await driver.findByTestID('crossrail-sol-ready', {timeoutMs: 30_000});
    await driver.screenshot('ux-convert-a-solready');
    await driver.click('btn-crossrail-sol-confirm', {timeoutMs: 5_000});
    await driver.waitForText('verified on-chain', {timeoutMs: 60_000});
    await driver.screenshot('ux-convert-a-done');
    console.log('[ux-a] done — 8 shots');
  } finally {
    await env.stop();
    await r2.stop();
  }
}

// --- phase b: dark en, the CeFi walk ---------------------------------------------------------------

async function phaseB() {
  console.log('[ux-b] dark en — CeFi SideShift walk…');
  const env = await setup({dark: true});
  const r2 = await startRelay();
  try {
    const {driver, account} = await boot(env, r2, {tag: 'cefi-b'});
    const kp = deriveSolanaKeypair(account.secretHex);
    const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    await openConvertIcp(driver);
    await driver.type('convert-amount', '3');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.screenshot('ux-convert-b-picker');
    await driver.click(CEFI_ROW, {timeoutMs: 5_000});
    await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
    await driver.waitForText('SideShift', {timeoutMs: 8_000});
    await driver.screenshot('ux-convert-b-checklist');

    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 8_000});
    await driver.screenshot('ux-convert-b-deposit');

    await setSideShiftStatus(driver, 'multiple');
    await driver.findByTestID('convert-provider-processing', {timeoutMs: 45_000});
    await driver.screenshot('ux-convert-b-processing');

    await setSideShiftStatus(driver, 'settled', {settleAmount: '0.0495', settleHash: 'sol-settle-sig-ux'});
    await driver.findByTestID('convert-done', {timeoutMs: 45_000});
    await driver.screenshot('ux-convert-b-done');

    // Expired dead-end (waiting at birth, dead word only once the handoff is up).
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await setSideShiftStatus(driver, 'waiting');
    await reopenConvert(driver);
    await driver.type('convert-amount', '3');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.click(CEFI_ROW, {timeoutMs: 5_000});
    await driver.waitForText('SideShift', {timeoutMs: 8_000});
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 30_000});
    await setSideShiftStatus(driver, 'expired');
    await driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
    await driver.screenshot('ux-convert-b-expired');

    // Refunded dead-end.
    await driver.click('btn-convert-back', {timeoutMs: 5_000});
    await setSideShiftStatus(driver, 'waiting');
    await reopenConvert(driver);
    await driver.type('convert-amount', '3');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.click(CEFI_ROW, {timeoutMs: 5_000});
    await driver.waitForText('SideShift', {timeoutMs: 8_000});
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 30_000});
    await setSideShiftStatus(driver, 'refunded');
    await driver.findByTestID('convert-provider-refunded', {timeoutMs: 45_000});
    await driver.screenshot('ux-convert-b-refunded');
    console.log('[ux-b] done — 7 shots');
  } finally {
    await env.stop();
    await r2.stop();
  }
}

// --- phases c/d/e: locale variants, the CeFi lite (picker / checklist / deposit / expired) ---------

async function phaseLocale(code, localeTag) {
  console.log(`[ux-${code}] ${localeTag} light — CeFi lite…`);
  // Onboarding placeholders are localized, so the wallet is created under en-US and the locale
  // is emulated + reloaded AFTER it exists (the multihop script's proven pattern).
  const env = await setup();
  const r2 = await startRelay();
  try {
    const {driver, webBaseURL, account} = await boot(env, r2, {tag: `cefi-${code}`});
    await driver.cdp.send('Emulation.setLocaleOverride', {locale: localeTag}); // reuses the create-time session
    await driver.navigate(webBaseURL, `/wallet?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    await driver.findByTestID('tab-home', {timeoutMs: 10_000});
    console.log(`[ux-${code}] locale switched to ${localeTag} and reloaded`);
    const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

    await openConvertIcp(driver);
    await driver.type('convert-amount', '3');
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    await driver.screenshot(`ux-convert-${code}-picker`);
    await driver.click(CEFI_ROW, {timeoutMs: 5_000});
    await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
    await driver.waitForText('SideShift', {timeoutMs: 8_000});
    await driver.screenshot(`ux-convert-${code}-checklist`);

    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    await driver.findByTestID('convert-deposit-address', {timeoutMs: 30_000});
    await driver.screenshot(`ux-convert-${code}-deposit`);

    await setSideShiftStatus(driver, 'expired');
    await driver.findByTestID('convert-quote-expired', {timeoutMs: 45_000});
    await driver.screenshot(`ux-convert-${code}-expired`);
    console.log(`[ux-${code}] done — 4 shots`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

const RUNNERS = {
  a: phaseA,
  b: phaseB,
  c: () => phaseLocale('c', 'es-ES'),
  d: () => phaseLocale('d', 'fr-FR'),
  e: () => phaseLocale('e', 'de-DE'),
};

for (const p of PHASES) {
  const runner = RUNNERS[p];
  if (runner == null) throw new Error(`unknown phase ${p}`);
  await runner();
}
console.log(`[ux] all phases complete: ${PHASES.join(',')}`);
