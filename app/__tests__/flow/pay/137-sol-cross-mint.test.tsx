/**
 * Flow 137 — the jest twin of `e2e/tests/137-sol-cross-mint-sign-gate.mjs` (the cross-mint sign
 * gate on the SOL rail).
 *
 * Leg 1 (THIS FILE'S FIRST TEST — the e2e twin's "fresh wallet, endpoint refusing from the first
 * poll" leg): the module registry IS the fresh page — the RPC override refuses every read from
 * boot, so the onboarding happens with the rail already down. The EURC solreq STILL SIGNS (a caveat
 * is not a block), and the caveat says what could not be checked — never "get online" (the device
 * is online; the RAIL refused us).
 *
 * Leg 2: with a working stub, a cross-mint solreq naming an ABSENT USDC account is refused at the
 * scan BY NAME with the practical next action — nothing signs. Its inverse: the funded EURC mint
 * signs right after, on the same remounted surface.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// The measured 2026-09-08 outage shape, armed FROM BOOT for leg 1: the endpoint ANSWERS and
// refuses this wallet (HTTP 429) — `dpayEndpointRefused` is the marker solana/errors.ts
// reads, separating "the rail refused us" from "nothing answered".
const refuse = (): never => {
  const e = new Error('solana rpc rate limit (HTTP 429): max usage reached') as Error & {dpayEndpointRefused?: boolean; status?: number};
  e.dpayEndpointRefused = true;
  e.status = 429;
  throw e;
};
G.__DPAY_TEST_SOLANA_RPC_STUB = {
  getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
  getMultipleAccounts: refuse,
  getAccountInfo: refuse,
  getBalance: refuse,
  getTokenAccountBalance: refuse,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {armPayScan, assertIncludes, onboardWallet, openBalances, selectSolRail} = lib;
const assert: typeof lib.assert = lib.assert;
const {scanSeam} = require('./local') as typeof import('./local');

const MERCHANT_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const DEST_ATA = '9AkkgHAxGYiX6RXhXbkVhFiyMAK81GYcj4zDtk9wbT4u'; // golden-vector ATA
const BH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u'; // blockhash-shaped base58 (jest golden)
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EURC_MINT = 'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'; // Circle EURC (6 dec)

/** Hand-build a `solreq:v2` in the codec's canonical field order (decode re-serializes and
 *  byte-compares: v,rid,net,bh,lvh,slot,iat,exp,to,amt,cur,mint,toAta,name,memo). */
function solreqUri(ridSeed: string, mint: string, cur: string): string {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const req = {
    v: 2, rid: ridSeed.repeat(16), net: 'mainnet-beta', bh: BH,
    lvh: 300_000_000, slot: 290_000_000, iat, exp: iat + 90,
    to: MERCHANT_ADDR, amt: '1500000', cur, mint, toAta: DEST_ATA,
    name: 'Cafe Sol', memo: '',
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');
}

hermeticDescribe('flow 137 leg 1 — endpoint refusing from boot: the solreq still signs, with the honest caveat', () => {
  it('a fresh wallet onboards with the rail down; the EURC request signs; the caveat names the unknown', async () => {
    // A truly fresh wallet (no persisted facts) with the endpoint ALREADY refusing: the module
    // registry above IS the fresh page load the e2e twin creates with clearStorage + navigate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {mountApp} = require('../harness/mount') as typeof import('../harness/mount');
    const m = await mountApp();
    await lib.onboardSlowPath(m, 'jest-cross-mint-down');
    // home=EUR puts a Solana-rail asset on Home (whose unreadable note this leg waits for).
    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-currency-EUR', {timeoutMs: 5000});
    await m.driver.click('btn-settings-close', {timeoutMs: 5000});
    await lib.waitForWallet(m, {timeoutMs: 10_000});
    // Wait until the rail has REPORTED the refusal — before that the mint is merely 'loading',
    // which is the OTHER unverified state and carries the other sentence.
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.waitForFunction(() => m.driver.isPresent('rail-unreadable-solana'),
      {timeoutMs: 15_000, label: 'the rail reported the refusal on Home'});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    let scanUp = await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000}).catch(() => null);
    if (!scanUp) {
      // With the rail unreadable the reconcile may land the Pay tab on the IC fallback — route to
      // the EURC rail explicitly; the scan surface is what the sign gate needs.
      await openBalances(m);
      await selectSolRail(m, 'sol-eurc', {timeoutMs: 5000});
      await m.driver.click('tab-pay', {timeoutMs: 5000});
      scanUp = await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000}).catch(() => null);
    }
    assert(scanUp !== null, 'the SOL scan surface mounts');
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(solreqUri('ef', EURC_MINT, 'EURC'));
    // It SIGNED — the non-negotiable: a caveat is not a block.
    await m.driver.findByTestID('sol-pay-qr', {timeoutMs: 10_000});
    const caveat = m.driver.readText('sol-pay-sign-caveat');
    assertIncludes(caveat, 'EURC', 'the caveat names the token whose account could not be checked');
    assertIncludes(caveat, 'can’t settle', 'and states what it costs if the account does not exist');
    assertIncludes(caveat, 'My address', 'and where the payer can check or create it');
    expect(caveat).not.toContain('Get online'); // the device is online; the RAIL is down

    await m.unmount();
  }, 240_000);
});

hermeticDescribe('flow 137 legs 2-3 — absent account refuses the sign; the funded mint signs on the same surface', () => {
  it('USDC against an absent account: named refusal, no signed QR; EURC: signed right after', async () => {
    const m = await onboardWallet('jest-cross-mint');

    // Working stub: every account exists — the Receive address sheet is 'ready' so the payer's
    // USDC ATA (derived locally by the app) can be READ from the UI.
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2000000', decimals: 6}}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getBalance: () => ({value: 5_000_000_000}),
      getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
    });
    await openBalances(m);
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const usdcAta = m.driver.readText('sol-receive-address');
    assert(usdcAta.length >= 40, `the Receive tab should show a derived USDC ATA, got: "${usdcAta}"`);

    // Mutable flip: every account still exists EXCEPT the payer's USDC ATA — EURC funded, USDC gone.
    G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
      getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, tokens: {[USDC_MINT]: null, [EURC_MINT]: {amount: '2000000', decimals: 6}}}),
      getAccountInfo: (params: unknown) => {
        const addr = String(Array.isArray(params) ? (params as unknown[])[0] : params);
        if (addr === usdcAta) return {value: null};
        return {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}};
      },
      getBalance: () => ({value: 5_000_000_000}),
      getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
    });

    // Back on the funded EURC rail — the scan surface is live again.
    await openBalances(m);
    await selectSolRail(m, 'sol-eurc', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 8000});

    // REFUSAL: a cross-mint solreq naming the absent USDC — refused at the scan, BY NAME, with the
    // practical next action; nothing signs and no signed QR ever appears.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(solreqUri('ab', USDC_MINT, 'USDC'));
    assert(await m.driver.waitForText('USDC account yet', {timeoutMs: 8000}), 'the refusal names the absent account');
    const refusal = m.driver.readText('sol-pay-err');
    assertIncludes(refusal, 'USDC', 'the refusal names the asset');
    assertIncludes(refusal, 'Receive', 'the refusal gives the next action (Receive ▸ create the account)');
    await m.driver.waitGone('sol-pay-qr', {timeoutMs: 2000}); // nothing was ever signed

    // FAIL-OPEN (the inverse leg): a solreq naming the FUNDED EURC signs right after, on the same
    // remounted surface — a fundable request-mint is never blocked by the gate.
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(solreqUri('cd', EURC_MINT, 'EURC'));
    await m.driver.findByTestID('sol-pay-qr', {timeoutMs: 10_000});
    assert(await m.driver.waitForText('Share signed code', {timeoutMs: 8000}), 'the fundable request-mint signed offline');

    await m.unmount();
  }, 240_000);
});
