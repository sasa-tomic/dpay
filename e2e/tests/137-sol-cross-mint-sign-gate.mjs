// Flow 137 — per-request-mint absent-ATA gate on the solreq auto-sign path (OPEN_ISSUES 6(a)).
//
// A solreq names its OWN mint, which need not be the wallet's selected asset: signing is PURE
// against an ASSUMED source ATA, so a cross-mint request naming a funded-but-absent SPL mint
// would produce a doomed offline sign (the merchant's broadcast gets REJECTED = dead QR). This
// flow pins both halves of the gate:
//   • refusal — the wallet holds EURC (funded, selected) but has NO USDC account: a USDC solreq
//     is refused at the scan BY NAME (asset + next action), nothing signs, no signed QR appears;
//   • fail-open — an EURC solreq (request-mint state 'balance') signs right after on the SAME
//     surface: unconfirmed-or-fundable mints never block the offline-first rail;
//   • fail-open WITH A CAVEAT (2026-09-08, M1) — a wallet that has NEVER been able to read the mint
//     because the endpoint is refusing it signs anyway (an offline payer must keep the ability to
//     sign a payment that would settle) and SAYS SO on the hand-off screen: it names the token,
//     states that the payment cannot settle if the account does not exist, and — because the device
//     is online and the RAIL is what is down — does not tell the payer to go and find signal.
import {
  setup, assert, assertIncludes, waitForEnabled, skipWalkthroughIfPresent, skipPracticeIfPresent,
  armPayScan, openBalances,
 waitForWallet} from '../harness/lib.mjs';

export const meta = {
  id: '137',
  name: 'sol-cross-mint-sign-gate',
  journey: 'pay',
  covers: ['solreq', 'cross-mint', 'absent-ata', 'refusal', 'fail-open', 'offline-sign', 'rpc-error', 'honest-copy'],
  verifies: 'OPEN_ISSUES 6(a): a solreq naming a KNOWN-absent mint (per-mint state from the balance rail, persisted across restarts) is refused at the scan by name before any sign; a fundable request-mint still signs; and a request-mint the endpoint has REFUSED to answer for signs too, carrying a caveat on the hand-off screen that names the token, states the payment cannot settle without the account, and never tells an already-online payer to find signal.',
  timeoutMs: 90000,
};

const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Circle USDC on mainnet (6 dec)
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'; // Circle EURC on mainnet (6 dec)
const BH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u'; // blockhash-shaped base58 (jest golden)
const DEST_ATA = '9AkkgHAxGYiX6RXhXbkVhFiyMAK81GYcj4zDtk9wbT4u'; // golden-vector ATA — any valid pubkey works as destination

/** Hand-build a `solreq:v2` in the codec's canonical field order (decode re-serializes and
 *  byte-compares, so the order here must be exactly v,rid,net,bh,lvh,slot,iat,exp,to,amt,cur,
 *  mint,toAta,name,memo — compact JSON, unpadded base64url). */
function solreqUri(ridSeed, mint, cur) {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const req = {
    v: 2, rid: ridSeed.repeat(16), net: 'mainnet-beta', bh: BH,
    lvh: 300_000_000, slot: 290_000_000, iat, exp: iat + 90,
    to: MERCHANT, amt: '1500000', cur, mint, toAta: DEST_ATA,
    name: 'Cafe Sol', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');
}

export async function run() {
  const start = Date.now();
  console.log('[137-sol-cross-mint-sign-gate] setup (relay + web + browser + sol stub)…');
  const env = await setup({ lazyBoot: false, solStub: true });
  try {
    const {driver} = env;

    // Onboard with home=EUR — the wallet lands on the EURC rail (funded by the stub below).
    console.log('[137-sol-cross-mint-sign-gate] onboarding with home=EUR…');
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-cross-mint', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-EUR');
    await driver.click('btn-home-currency-continue');
    await waitForWallet(driver, {timeoutMs: 10_000});

    // Stub v1 (same seam as flow 132): every account exists — the Receive tab's address sheet is
    // 'ready' so the payer's USDC ATA (derived locally by the app) can be READ from the UI.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        // The balance poll: ONE getMultipleAccounts per tick for wallet+rails (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2000000', decimals: 6}}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
      };
    });
    console.log('[137-sol-cross-mint-sign-gate] reading the payer USDC ATA from Receive…');
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select');
    await driver.click('tab-receive');
    await driver.click('btn-receive-address');
    await driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const usdcAta = await driver.readText('sol-receive-address');
    assert(usdcAta.length >= 40, `the Receive tab should show a derived USDC ATA, got: "${usdcAta}"`);
    console.log(`[137-sol-cross-mint-sign-gate] payer USDC ATA: ${usdcAta}`);

    // Stub v2 (mutable flip, flow 76 pattern): every account still exists EXCEPT the payer's USDC
    // ATA — so the rail confirms EURC funded (2.00, 6 dec) while USDC has NO account.
    await driver.eval((cfg) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
        // The balance poll, per MINT: EURC funded, USDC's token account absent — the one difference
        // this flow turns on (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {
          lamports: 5000000000,
          token: {amount: '2000000', decimals: 6},
          tokens: {[cfg.usdcMint]: null},
        }),
        getAccountInfo: (params) => (params[0] === cfg.usdcAta
          ? {value: null}
          : {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getBalance: () => ({value: 5000000000}),
        getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
      };
    }, {usdcAta, usdcMint: USDC_MINT});

    // Deterministic absent-proof: with USDC selected, the Pay tab's gate must replace the scanner
    // with the ATA-setup card — i.e. the rail has CONFIRMED the USDC account absent.
    await driver.click('tab-pay');
    await driver.findByTestID('sol-pay-ata-instructions', {timeoutMs: 15_000});
    console.log('[137-sol-cross-mint-sign-gate] ✓ USDC confirmed absent (ATA card on the Pay tab)');

    // Back on the funded EURC rail — the scan surface is live again.
    await openBalances(driver);
    await driver.click('asset-sol-eurc-select');
    await driver.click('tab-pay');
    await driver.findByTestID('sol-pay-scan', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});

    // 1. REFUSAL: a cross-mint solreq naming the absent USDC — refused at the scan, BY NAME,
    //    with the practical next action; nothing signs and no signed QR ever appears.
    console.log('[137-sol-cross-mint-sign-gate] scanning a USDC solreq against the absent USDC account…');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solreqUri('ab', USDC_MINT, 'USDC'));
    await driver.waitForText('USDC account yet', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    const refusal = await driver.readText('sol-pay-err');
    assertIncludes(refusal, 'USDC', 'the refusal must name the asset');
    assertIncludes(refusal, 'Receive', 'the refusal must give the next action (Receive ▸ create the account)');
    await driver.waitGone('sol-pay-qr', {timeoutMs: 2_000}); // nothing was ever signed
    await driver.screenshot('137-cross-mint-refusal');
    console.log('[137-sol-cross-mint-sign-gate] ✓ named refusal — no sign, no signed QR');

    // 2. FAIL-OPEN (the inverse leg): a solreq naming the FUNDED EURC signs right after, on the
    //    same remounted surface — a fundable request-mint is never blocked by the gate.
    console.log('[137-sol-cross-mint-sign-gate] scanning an EURC solreq (request-mint funded)…');
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solreqUri('cd', EURC_MINT, 'EURC'));
    await driver.findByTestID('sol-pay-qr', {timeoutMs: 10_000});
    await driver.waitForText('Share signed code', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.screenshot('137-cross-mint-signed');
    console.log('[137-sol-cross-mint-sign-gate] ✓ fundable request-mint signed offline (signed QR shown)');

    // 3. FAIL-OPEN WITH A CAVEAT: the same signature, made with NO fact about the request's mint
    //    because the endpoint refused every read. A fresh wallet is the only honest way to reach
    //    this state — a mint observed once STAYS observed (the persisted-fact store), and a fact
    //    outranks whatever the endpoint is doing now, which is itself part of the gate's contract.
    console.log('[137-sol-cross-mint-sign-gate] fresh wallet, endpoint refusing from the first poll…');
    await driver.clearStorage();
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(env.relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    await driver.eval(() => {
      // The measured 2026-09-08 outage: the endpoint ANSWERS and refuses this wallet (HTTP 429).
      // Reads throw; the blockhash/broadcast half stays alive so the failure is scoped to the READ.
      // `dpayEndpointRefused` is the marker `solana/errors.ts#isEndpointRefusal` reads, and it is
      // what separates "the rail refused us" from "nothing answered" — the whole difference between
      // the two caveats. A plain Error here would exercise the wrong one.
      const refuse = () => {
        const e = new Error('solana rpc rate limit (HTTP 429): max usage reached');
        e.dpayEndpointRefused = true;
        e.status = 429;
        throw e;
      };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMultipleAccounts: refuse,
        getAccountInfo: refuse,
        getBalance: refuse,
        getTokenAccountBalance: refuse,
      };
    });
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-cross-mint-down', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await waitForEnabled(driver, 'btn-mnemonic-continue');
    await driver.click('btn-mnemonic-continue');
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title');
    await driver.click('home-currency-EUR');
    await driver.click('btn-home-currency-continue');
    await waitForWallet(driver, {timeoutMs: 10_000});
    // Wait until the rail has actually REPORTED the refusal — before that the mint is merely
    // 'loading', which is the OTHER unverified state and carries the other sentence.
    await driver.click('tab-home');
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="rail-unreadable-solana"]') != null,
      {timeoutMs: 15_000},
    );
    await driver.click('tab-pay');
    await driver.findByTestID('sol-pay-scan', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await armPayScan(driver);
    await driver.eval((qr) => window.__DPAY_TEST_SCAN(qr), solreqUri('ef', EURC_MINT, 'EURC'));
    // It SIGNED — the hand-off QR is there. That is the non-negotiable: a caveat is not a block.
    await driver.findByTestID('sol-pay-qr', {timeoutMs: 10_000});
    const caveat = await driver.readText('sol-pay-sign-caveat');
    assertIncludes(caveat, 'EURC', 'the caveat must name the token whose account could not be checked');
    assertIncludes(caveat, 'can’t settle', 'and state what it costs if the account does not exist');
    assertIncludes(caveat, 'My address', 'and where the payer can check or create it');
    assert(!caveat.includes('Get online'),
      'the device IS online and the RAIL is down — telling this payer to get online would be a lie');
    await driver.screenshot('137-cross-mint-rail-down-caveat');
    console.log('[137-sol-cross-mint-sign-gate] ✓ signed anyway, and said what it could not check');

    console.log(`[137-sol-cross-mint-sign-gate] GREEN in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[137-sol-cross-mint-sign-gate] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
