/**
 * Flow 172 — the jest twin of `e2e/tests/172-log-names-messages.mjs` (device-saved notes name the
 * transaction log, across every payment shape).
 *
 * (a) a paid request shows to_name + the human memo on the Home feed and the Ledger, and the receipt
 *     keeps Peer/Note beside the FULL principal and the hex reference; (b) a payee-side request
 *     shows the typed message but never invents a payer name; (c) a labelled Solana-Pay names the
 *     SOL row by the URI label, keyed by the send's own signature; (e) an OFFLINE solreq:v2 sign
 *     keys the note to the sign's own signature (extracted from the solpay:v2 the QR shows); (f) the
 *     NFC tap's radio twin does the same through the real SolNfcTap state machine; (d) an
 *     un-annotated transfer keeps principal + hex with NO Peer/Note lines.
 *
 * LOAD-ORDER CONTRACT: the RPC override is set before the harness require (see ./solrpc).
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {baseSolStub, enableSolRpcStub, installSolAccountsHelper} from './solrpc';

const G = globalThis as unknown as Record<string, unknown>;
enableSolRpcStub();
installSolAccountsHelper();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../harness/lib') as typeof import('../harness/lib');
const {
  accountOf, armPayScan, assertIncludes, armNfcCard, DpayCore, faucetAccount,
  generateKeypair, onboardWallet, openBalances, railPrincipalText, railTransfer, selectCurrency,
} = lib;
const assert: typeof lib.assert = lib.assert;
const {scanSeam} = require('./local') as typeof import('./local');

const SOL_MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const SOL_REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SPAY_LABEL = 'Coffee Bar';
const SPAY_MESSAGE = 'Order 42';
const REQ_MESSAGE = 'bike parts';
const SOL_REQ_NAME = 'Market Stall'; // ≤32 code units — the qr codec's MAX_NAME_LEN cap
const SOL_REQ_MEMO = 'Farm veg box';
const SOL_NFC_NAME = 'Bakery Van';
const SOL_NFC_MEMO = 'Sourdough';
const SOL_BH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN'; // flow-46/47 fixture blockhash
const SOL_LAMPORTS = '1000000'; // 0.001 SOL — matches the stub's fabricated getTransaction delta

// Minimal base58 encoder (avoids a bs58 dependency — flow-47 precedent).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

/** Extract the first 64-byte signature from a v2 solpay URI (compact-u16 || sig64 || msg). */
function extractSig(solpayUri: string): string {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {tx: string};
  const tx = Buffer.from(obj.tx, 'base64url');
  return bs58Encode(new Uint8Array(tx.slice(1, 65)));
}

function buildSolReqUri(rid: string, name: string, memo: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const obj = {
    v: 2, rid, net: 'mainnet-beta',
    bh: SOL_BH, lvh: 300_000_000, slot: 250_000_000,
    iat, exp: iat + 90,
    to: SOL_MERCHANT, amt: SOL_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name, memo,
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** The in-page SOL RPC stub with a HISTORY half: sendTransaction captures the echoed signature;
 *  getSignaturesForAddress answers only for the wallet (captured on first query); getTransaction
 *  fabricates the balance-delta detail the reader accepts (owner index 0 moves amount+fee). */
function installHistorySolStub(): void {
  G.__DPAY_LAST_SOL_SIG = null;
  G.__DPAY_SOL_OWNER = null;
  G.__DPAY_TEST_SOLANA_RPC_STUB = baseSolStub({
    getMultipleAccounts: (p: unknown) => (G.__DPAY_SOL_ACCOUNTS as (p: unknown, s: unknown) => unknown)(p, {lamports: 5_000_000_000, token: {amount: '2000000', decimals: 6}}),
    getGenesisHash: () => '4uhcVJyU9pJkvQyS29u4DelQEvShkTXUQHJypwSFVmFc',
    getLatestBlockhash: () => {
      G.__DPAY_TEST_SOL_BH = ((G.__DPAY_TEST_SOL_BH as number) ?? 0) + 1;
      return {context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 + (G.__DPAY_TEST_SOL_BH as number)}};
    },
    isBlockhashValid: () => ({context: {slot: 250000001}, value: true}),
    getBlockHeight: () => 250000001,
    getSignatureStatuses: () => ({context: {slot: 250000002}, value: [{confirmationStatus: 'confirmed'}]}),
    getBalance: () => ({value: 5_000_000_000}),
    getTokenAccountBalance: () => ({value: {amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2'}}),
    getAccountInfo: () => null,
    sendTransaction: () => {
      const sig = 'sig_' + Math.random().toString(36).slice(2, 12);
      G.__DPAY_LAST_SOL_SIG = sig;
      return sig;
    },
    getSignaturesForAddress: (p: unknown[]) => {
      const owner = p?.[0];
      if (owner && !G.__DPAY_SOL_OWNER) G.__DPAY_SOL_OWNER = owner; // first query = the wallet
      const sig = G.__DPAY_LAST_SOL_SIG;
      if (!sig || owner !== G.__DPAY_SOL_OWNER) return [];
      return [{signature: sig, slot: 900, blockTime: Math.floor(Date.now() / 1000), err: null}];
    },
    getTransaction: (p: unknown[]) => {
      const sig = p?.[0];
      const owner = G.__DPAY_SOL_OWNER;
      if (!sig || sig !== G.__DPAY_LAST_SOL_SIG || !owner) return null;
      const pre = 5_000_000_000, amount = 1_000_000, fee = 5_000;
      return {
        slot: 900, blockTime: Math.floor(Date.now() / 1000),
        meta: {err: null, fee, preBalances: [pre, 0], postBalances: [pre - amount - fee, amount],
          preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: []},
        transaction: {signatures: [sig as string], message: {
          accountKeys: [owner, SOL_MERCHANT],
          header: {numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1},
          instructions: [], recentBlockhash: '11111111111111111111111111111111'}},
      };
    },
  });
}

hermeticDescribe('flow 172 — device-saved notes name the transaction log, across every payment shape', () => {
  it('(a/b/c/e/f/d) named rows + receipts keep ledger truth checkable beside the notes', async () => {
    // NFC must read 'ready' BEFORE the Wallet mounts (read once at mount + on AppState changes).
    (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_NFC_STATUS = 'ready';
    const m = await onboardWallet('jest-lognames');
    const me = (await accountOf(m))!;
    installHistorySolStub();

    // Click the ledger row that names `needle` (row ordering across rails is not relied on).
    const clickRowWith = async (needle: string): Promise<void> => {
      for (let i = 0; i < 12; i++) {
        const id = `hist-row-${i}`;
        if (!m.driver.isPresent(id)) break;
        if (m.driver.readText(id).includes(needle)) {
          await m.driver.click(id, {timeoutMs: 5000});
          return;
        }
      }
      throw new Error(`no ledger row names "${needle}"`);
    };

    // ── (a) the payer pays a NAMED request with a human memo ────────────────────────────────────
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const nonceA = 'a7'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, '2500', nonceA, expiry, 0, 'Bob', 'coffee');
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    assert(await m.driver.waitForText('Paid', {timeoutMs: 10_000}), '(a) the named request auto-signs to Paid');

    // Home activity feed first — the same resolver feeds both lists.
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-activity', {timeoutMs: 5000});
    assert(await m.driver.waitForText('coffee', {timeoutMs: 12_000}), '(a) the Home feed shows the note message');
    const homeBody = m.driver.bodyText();
    assertIncludes(homeBody, 'to Bob', '(a) Home row shows the payee NAME');
    expect(homeBody).not.toContain(bobPrincipal);
    expect(homeBody).not.toContain(bob.publicHex);

    // Then the full ledger + the receipt.
    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    await m.driver.findByTestID('ledger-view', {timeoutMs: 5000});
    assert(await m.driver.waitForText('coffee', {timeoutMs: 12_000}), '(a) the ledger row shows the note message');
    const histBody = m.driver.bodyText();
    assertIncludes(histBody, 'to Bob', '(a) ledger row shows the payee NAME');
    expect(histBody).not.toContain(nonceA.slice(0, 8)); // the message replaced the hex nonce
    expect(histBody).not.toContain(bobPrincipal);

    await m.driver.click('hist-row-0', {timeoutMs: 5000});
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-peer'), 'Bob', '(a) receipt Peer is the saved name');
    assertIncludes(m.driver.readText('txn-receipt-note'), 'coffee', '(a) receipt Note is the saved message');
    assertIncludes(m.driver.readText('txn-receipt-account'), bobPrincipal, '(a) receipt account stays the FULL payee principal');
    assertIncludes(m.driver.readText('txn-receipt-ref'), nonceA, '(a) receipt reference stays the hex nonce');
    assertIncludes(m.driver.bodyText(), 'saved on this device', '(a) the annotated receipt foots honestly');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    // ── (b) the payee's own request: typed message, payer stays UNNAMED ──────────────────────────
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.type('amount-input', '18.00', {timeoutMs: 4000});
    await m.driver.type('memo-input', REQ_MESSAGE, {timeoutMs: 4000});
    await m.driver.click('btn-request', {timeoutMs: 4000});
    await m.driver.findByTestID('request-qr', {timeoutMs: 5000});
    const requestQRB = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    const nonceB = new URL(requestQRB, 'https://dpay.invalid').searchParams.get('ref') ?? '';

    const payer2 = await generateKeypair();
    const payer2Principal = await railPrincipalText(payer2.publicHex);
    const fund2 = await faucetAccount(payer2.publicHex, 10000);
    assert(fund2.ok, `(b) payer faucet should succeed, got ${fund2.status}`);
    const paid2 = await railTransfer(payer2.secretHex, me.publicHex, '1800', {memoHex: nonceB});
    expect(paid2.ok).toBe(true);

    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    assert(await m.driver.waitForText(REQ_MESSAGE, {timeoutMs: 15_000}), '(b) the incoming row shows the typed message');
    const histBodyB = m.driver.bodyText();
    assertIncludes(histBodyB, payer2Principal.slice(0, 8), '(b) the payer stays a short principal (payers are unnamed)');
    expect(histBodyB).not.toContain(payer2Principal);
    expect(histBodyB).not.toContain(payer2.publicHex);

    await clickRowWith(REQ_MESSAGE);
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    expect(m.driver.isPresent('txn-receipt-peer')).toBe(false); // NO Peer line — never invents a name
    assertIncludes(m.driver.readText('txn-receipt-note'), REQ_MESSAGE, '(b) receipt Note is the typed message');
    assertIncludes(m.driver.readText('txn-receipt-account'), payer2Principal, '(b) receipt account is the payer’s FULL principal');
    assertIncludes(m.driver.readText('txn-receipt-ref'), nonceB, '(b) receipt reference is the request nonce');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    // ── (c) Solana-Pay with label + message → the SOL row is named by its signature ───────────────
    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(`solana:${SOL_MERCHANT}?amount=0.001&reference=${SOL_REFERENCE}&label=${encodeURIComponent(SPAY_LABEL)}&message=${encodeURIComponent(SPAY_MESSAGE)}`);
    assert(await m.driver.waitForText(SPAY_LABEL, {timeoutMs: 8000}), '(c) the spay review shows the label');
    assert(await m.driver.waitForText(SPAY_MESSAGE, {timeoutMs: 5000}), '(c) the spay review shows the message');
    await lib.waitForEnabled(m, 'btn-approve');
    await m.driver.click('btn-approve', {timeoutMs: 5000});
    assert(await m.driver.waitForText('sig_', {timeoutMs: 15_000}), '(c) the spay completes with a signature');
    await m.driver.click('btn-sol-pay-done', {timeoutMs: 5000});

    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    assert(await m.driver.waitForText(SPAY_MESSAGE, {timeoutMs: 15_000}), '(c) the SOL history row shows the message');
    const histBodyC = m.driver.bodyText();
    assertIncludes(histBodyC, `to ${SPAY_LABEL}`, '(c) the SOL row is named by the URI label');
    expect(histBodyC).not.toContain(SOL_MERCHANT);

    await clickRowWith(SPAY_MESSAGE);
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-peer'), SPAY_LABEL, '(c) receipt Peer is the spay label');
    assertIncludes(m.driver.readText('txn-receipt-note'), SPAY_MESSAGE, '(c) receipt Note is the spay message');
    assertIncludes(m.driver.readText('txn-receipt-account'), SOL_MERCHANT, '(c) receipt account is the FULL merchant pubkey');
    assertIncludes(m.driver.bodyText(), 'saved on this device', '(c) the annotated receipt foots honestly');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    // ── (e) OFFLINE solreq:v2 merchant QR: the note is keyed by the SIGN's own signature ──────────
    const ridE = 'e'.repeat(32);
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 5000});
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(buildSolReqUri(ridE, SOL_REQ_NAME, SOL_REQ_MEMO));
    await m.driver.findByTestID('sol-pay-qr', {timeoutMs: 8000});
    assert(await m.driver.waitForText(SOL_REQ_NAME, {timeoutMs: 5000}), '(e) the signed QR shows the claimed merchant name');
    const solpayUriE = (globalThis as unknown as Record<string, string>).__DPAY_QR_LAST as string;
    assert(solpayUriE.startsWith('solpay:v2?'), '(e) the offline sign renders a solpay:v2 QR');
    const sigE = extractSig(solpayUriE);
    await m.driver.click('btn-sol-pay-handed', {timeoutMs: 5000});
    await m.driver.click('btn-sol-pay-done', {timeoutMs: 5000});

    G.__DPAY_LAST_SOL_SIG = sigE; // the merchant broadcast exactly this
    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    assert(await m.driver.waitForText(SOL_REQ_MEMO, {timeoutMs: 15_000}), '(e) the offline SOL row shows the memo');
    const histBodyE = m.driver.bodyText();
    assertIncludes(histBodyE, `to ${SOL_REQ_NAME}`, '(e) the offline SOL row is named by the sign-time note');
    expect(histBodyE).not.toContain(SOL_MERCHANT);
    await clickRowWith(SOL_REQ_MEMO);
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-peer'), SOL_REQ_NAME, '(e) receipt Peer is the solreq claimed name');
    assertIncludes(m.driver.readText('txn-receipt-note'), SOL_REQ_MEMO, '(e) receipt Note is the solreq memo');
    // (The twin asserts no account here: the offline payment has no ledger fact until broadcast.)
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    // ── (f) the NFC card: the same sign-time note through the tap's radio twin ────────────────────
    const ridF = 'f'.repeat(32);
    await m.driver.click('tab-pay', {timeoutMs: 4000});
    await armPayScan(m); // the card only mounts armed
    const dispatch = async (event: Record<string, unknown>): Promise<void> => {
      await armNfcCard(m, 'sol', {timeoutMs: 10_000});
      const session = (globalThis as unknown as {__DPAY_TEST_SOL_NFC_SESSION: (e: Record<string, unknown>) => void}).__DPAY_TEST_SOL_NFC_SESSION;
      session(event);
    };
    await dispatch({type: 'request', role: 'card', solreqUri: buildSolReqUri(ridF, SOL_NFC_NAME, SOL_NFC_MEMO)});
    assert(await m.driver.waitForText('Communicating', {timeoutMs: 8000}), '(f) the tap request auto-signs → exchanging');
    const solpayUriF = (globalThis as unknown as Record<string, string>).__DPAY_SOL_NFC_LAST as string;
    assert(solpayUriF.startsWith('solpay:v2?'), '(f) the tap auto-sign produces a solpay:v2 URI');
    const sigF = extractSig(solpayUriF);
    await dispatch({type: 'receipt', role: 'card', status: 0, rid: ridF, sig: sigF});
    assert(await m.driver.waitForText('Sent', {timeoutMs: 6000}), '(f) the settled receipt lands the honest pending');
    await m.driver.click('btn-sol-pay-done', {timeoutMs: 5000});

    G.__DPAY_LAST_SOL_SIG = sigF; // the merchant broadcast it
    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    assert(await m.driver.waitForText(SOL_NFC_MEMO, {timeoutMs: 15_000}), '(f) the NFC-paid SOL row shows the memo');
    const histBodyF = m.driver.bodyText();
    assertIncludes(histBodyF, `to ${SOL_NFC_NAME}`, '(f) the NFC-paid SOL row is named by the sign-time note');
    await clickRowWith(SOL_NFC_MEMO);
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('txn-receipt-peer'), SOL_NFC_NAME, '(f) receipt Peer is the claimed name');
    assertIncludes(m.driver.readText('txn-receipt-note'), SOL_NFC_MEMO, '(f) receipt Note is the tap request’s memo');
    assertIncludes(m.driver.readText('txn-receipt-account'), SOL_MERCHANT, '(f) receipt account is the FULL merchant pubkey');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    // ── (d) a plain un-annotated transfer stays EXACTLY as the ledger said it ─────────────────────
    const payer4 = await generateKeypair();
    const payer4Principal = await railPrincipalText(payer4.publicHex);
    const fund4 = await faucetAccount(payer4.publicHex, 10000);
    assert(fund4.ok, `(d) payer faucet should succeed, got ${fund4.status}`);
    const nonceD = 'd3'.repeat(16);
    const paid4 = await railTransfer(payer4.secretHex, me.publicHex, '700', {memoHex: nonceD});
    expect(paid4.ok).toBe(true);

    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    assert(await m.driver.waitForText('∂7.00', {timeoutMs: 15_000}), '(d) the plain transfer lands in the ledger');
    const histBodyD = m.driver.bodyText();
    assertIncludes(histBodyD, payer4Principal.slice(0, 8), '(d) the un-annotated row keeps the short principal');
    assertIncludes(histBodyD, nonceD.slice(0, 8), '(d) the row keeps the hex nonce prefix (reconciliation key)');

    await clickRowWith(nonceD.slice(0, 8));
    await m.driver.findByTestID('txn-receipt', {timeoutMs: 5000});
    expect(m.driver.isPresent('txn-receipt-peer')).toBe(false); // NO Peer line
    expect(m.driver.isPresent('txn-receipt-note')).toBe(false); // NO Note line
    assertIncludes(m.driver.readText('txn-receipt-account'), payer4Principal, '(d) receipt account is the FULL payer principal');
    assertIncludes(m.driver.readText('txn-receipt-ref'), nonceD, '(d) receipt reference is the hex nonce');
    assertIncludes(m.driver.bodyText(), 'Read from the ledger', '(d) the plain receipt keeps the plain footer');
    await m.driver.click('btn-txn-receipt-close', {timeoutMs: 4000});
    await m.driver.waitGone('txn-receipt', {timeoutMs: 4000});

    await m.unmount();
  }, 300_000);
});
