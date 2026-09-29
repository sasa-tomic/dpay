/**
 * Flows 97 + 98 — the jest twins of `e2e/tests/97-vchf-merchant-reconcile.mjs` and
 * `e2e/tests/98-icp-merchant-reconcile.mjs` (the native rows through the MERCHANT side).
 *
 * The merchant creates an 8-decimal request in-app (headline = the typed price, fee line = the
 * netted wire; the link carries the netted amount and the NFC reader arms with the byte-exact
 * wire). A WRONG-memo wire transfer settles on the rail but must NOT flip the request — the
 * confirm poll exhausts and says so. The EXACT-memo transfer flips "Received <typed price>".
 * Each leg debits the payer exactly the price; the merchant nets BOTH wires; the Ledger headlines
 * the gross on the memo-matched row and keeps the bare wire on the unmatched row.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assert, assertEq, assertIncludes, DpayCore, faucetAccount, generateKeypair,
  getBalance, icpCatalog, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {openPayerScan, parsePayLink, pollReaderRequestHex, hexToB64url, scanSeam, signIcrc1Envelope} from './local';

const VCHF = {currency: 7, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', unit: 'VCHF', key: 'vchf'};
const ICP = {currency: 8, ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', unit: 'ICP', key: 'icp'};
const PAYER_SEED = '300000000'; // 3.00000000 — covers two price legs (wire + fee each)
const PAY = '100000001'; // the price per leg, exactly
const WIRE = '99990001'; // price − fee — the netted wire each leg moves

async function merchantReconcileLeg(asset: typeof VCHF): Promise<void> {
  // --- Harness payer (funded on the asset only) + relay catalog truth -------------------------
  const payer = await generateKeypair();
  const seeded = await faucetAccount(payer.publicHex, Number(PAYER_SEED), {currency: asset.currency});
  assert(seeded.ok, `payer faucet credit ok (${seeded.status})`);

  const catalog = await icpCatalog();
  const desc = catalog.find((c) => c.currency === asset.currency);
  assert(desc !== undefined, 'relay catalog serves the row');
  assertEq(desc.ledger, asset.ledger, 'relay ledger principal');
  assertEq(String(desc.fee), '10000', 'relay fee');

  // --- Merchant creates the 8-decimal request in the app ---------------------------------------
  // Radio ready before the mount so the request ALSO builds the NFC wire (the reader stash is a
  // per-file global in jest — clear it so a sibling leg's wire can't leak in).
  const g = globalThis as unknown as Record<string, unknown>;
  g.__DPAY_TEST_NFC_STATUS = 'ready';
  delete g.__DPAY_TEST_NFC_READER_REQUEST;
  const m = await onboardWallet(`jest-${asset.key}-merchant`);
  const merchant = (await accountOf(m))!.publicHex;
  await openBalances(m);
  await selectCurrency(m, asset.key);

  await m.driver.click('tab-receive', {timeoutMs: 4000});
  await m.driver.type('amount-input', '1.00000001', {timeoutMs: 4000});
  await m.driver.click('btn-request', {timeoutMs: 4000});
  await m.driver.findByTestID('request-qr', {timeoutMs: 6000});
  assertIncludes(m.driver.bodyText(), `1.00000001 ${asset.unit}`, 'request screen headlines the typed price');
  assertIncludes(m.driver.bodyText(), `you receive 0.99990001 ${asset.unit}`, 'request screen fee line names the netted wire');
  const link = parsePayLink(g.__DPAY_QR_LAST as string);
  assert(link !== null, 'request QR parses as the payment link');
  assertEq(link.asset, asset.unit, 'link names the requested asset');
  assertEq(link.network, 'internet-computer', 'link names the settlement network');
  assertEq(link.amount, '0.99990001', 'link carries the netted 8-decimal wire (price − fee)');
  assertEq(link.recipient, await railPrincipalText(merchant), 'link payee = merchant principal');
  expect(link.ref ?? '').toMatch(/^[0-9a-f]{32}$/);
  const nonceHex = link.ref!;

  const req = await DpayCore.decodeRequest(hexToB64url(await pollReaderRequestHex()));
  assertEq(req.currency, asset.currency, 'encoded wire currency id');
  assertEq(req.amount, WIRE, 'encoded wire exact raw units = the netted wire');
  assertEq(req.toHex, merchant, 'encoded wire payee = merchant account');

  const merchantBefore: Record<string, string> = {};
  for (let c = 0; c <= 8; c++) merchantBefore[String(c)] = await getBalance(merchant, c).catch(() => '0');
  assertEq(merchantBefore[String(asset.currency)], '0', `merchant starts at 0 ${asset.unit}`);

  // --- WRONG-memo leg: settles on the rail, must NOT flip the request ---------------------------
  const wrongEnvelope = await signIcrc1Envelope(payer.secretHex, merchant, WIRE, {memoHex: 'dd'.repeat(16), currency: asset.currency});
  await openPayerScan(m);
  scanSeam()(Buffer.from(wrongEnvelope.envelopeHex.match(/../g)!.map((h) => parseInt(h, 16))).toString('base64url'));

  // The confirm poll must exhaust and surface its err — the request stays open, NO Received.
  assert(await m.driver.waitForText('confirm this payment yet', {timeoutMs: 20_000}),
    'wrong-memo leg surfaces the could-not-confirm error');
  expect(m.driver.bodyText()).not.toContain('Received');
  expect(m.driver.isPresent('request-qr')).toBe(true);
  // The rail settled anyway — the memo is what binds the CONFIRMATION, not the credit.
  assertEq(await getBalance(merchant, asset.currency), WIRE, 'rail credited the wrong-memo wire (UI must not confirm)');

  // --- EXACT-memo leg: flips the open request to Received ---------------------------------------
  const rightEnvelope = await signIcrc1Envelope(payer.secretHex, merchant, WIRE, {memoHex: nonceHex, currency: asset.currency});
  await openPayerScan(m);
  scanSeam()(Buffer.from(rightEnvelope.envelopeHex.match(/../g)!.map((h) => parseInt(h, 16))).toString('base64url'));
  assert(await m.driver.waitForText(`Received 1.00000001 ${asset.unit}`, {timeoutMs: 20_000}),
    'the exact-memo leg flips the open request to Received');

  // --- Balances: exact credits/debits, sibling isolation ----------------------------------------
  assertEq(await getBalance(merchant, asset.currency), (BigInt(WIRE) * 2n).toString(),
    'merchant credited BOTH wire transfers (the fee is the merchant’s cost)');
  assertEq(await getBalance(payer.publicHex, asset.currency), (BigInt(PAYER_SEED) - 2n * BigInt(PAY)).toString(),
    'payer debited 2 × exactly the price');
  for (let c = 0; c <= 8; c++) {
    if (c !== asset.currency) {
      assertEq(await getBalance(merchant, c).catch(() => '0'), merchantBefore[String(c)], `merchant sibling currency ${c} unchanged`);
    }
  }

  // --- Merchant Ledger: incoming row with exact units + payer counterparty -----------------------
  await m.driver.click('tab-transactions', {timeoutMs: 5000});
  const shortPayer = (await railPrincipalText(payer.publicHex)).slice(0, 8);
  assert(await m.driver.waitForText(shortPayer, {timeoutMs: 10_000}),
    `merchant history row names the payer (short principal ${shortPayer})`);
  const histBody = m.driver.bodyText();
  assertIncludes(histBody, `+1.00000001 ${asset.unit}`, 'memo-matched row headlines the GROSS (the typed price)');
  assertIncludes(histBody, `\u2212 0.0001 ${asset.unit} fees`, 'memo-matched row carries the fee as its annotation line');
  assertIncludes(histBody, `+0.99990001 ${asset.unit}`, 'wrong-memo row keeps the bare received wire');
  expect(histBody).not.toContain(payer.publicHex);

  await m.unmount();
}

hermeticDescribe('flow 97 — VCHF merchant reconcile (wrong memo refuses, exact memo confirms)', () => {
  it('the memo — not the credit — binds the confirmation, with exact 8-decimal money', async () => {
    await merchantReconcileLeg(VCHF);
  }, 180_000);
});

hermeticDescribe('flow 98 — ICP merchant reconcile (the ICP twin)', () => {
  it('same contract on currency 8', async () => {
    await merchantReconcileLeg(ICP);
  }, 180_000);
});
