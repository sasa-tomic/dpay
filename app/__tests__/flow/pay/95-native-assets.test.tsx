/**
 * Flows 95 + 96 — the jest twins of `e2e/tests/95-vchf-pay.mjs` and `e2e/tests/96-icp-pay.mjs`
 * (the native no-minter rows through the payer side of the shared IC rail).
 *
 * Both flows: the row in the shared selector with the exact unit · network and NO ramp actions;
 * the unfunded selection parked on the fund panel with the real receive-first instruction whose
 * primary opens THIS wallet's ICRC-1 address; then a netted price (wire = price − fee, founder
 * rule) paid with the ledger target asserted per canister call, exact settlement + sibling
 * isolation (full 0..8 snapshot), and the Ledger headline at the GROSS with the fee only as the
 * annotation line. 95 enters through the deeplink review (explicit Approve); 96 through the camera
 * scan (one-press auto-sign).
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, armPayScan, assert, assertEq, assertIncludes, DpayCore, faucetAccount, generateKeypair,
  getBalance, onboardWallet, openBalances, railPrincipalText, selectCurrency,
} from '../harness/lib';
import {mountApp} from '../harness/mount';
import {scanSeam} from './local';

const VCHF = {currency: 7, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', unit: 'VCHF', key: 'vchf', chip: 'CHF', chipFigure: '2.10 Fr', chipAfter: '1.10 Fr', rowAfter: '1.10 Fr'};
const ICP = {currency: 8, ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai', unit: 'ICP', key: 'icp', chip: 'ICP', chipFigure: '2.1 ICP', chipAfter: '1.1 ICP', rowAfter: '1.1 ICP'};
const SEED = '210000001'; // 2.10000001 — covers the price
const PAY = '100000001'; // 1.00000001 — the PRICE the customer pays, exactly (8-dec odd tail)
// The catalog fee (10000 raw) is netted out of the quoted wire: PAY − WIRE is the fee.
const WIRE = '99990001'; // price − fee — what the payee's link/request carries

type Recorder = {calls: () => string[], restore: () => void};
/** Records every /api/v2/canister/ URL the app fetches (installed over the harness's rewriter). */
function recordCanisterCalls(): Recorder {
  const urls: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.includes('/api/v2/canister/')) urls.push(u);
    } catch { /* never break the app on a recorder fault */ }
    return prev(input, init);
  }) as typeof fetch;
  return {calls: () => urls, restore: () => { globalThis.fetch = prev; }};
}

async function snapBalances(accountHex: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let c = 0; c <= 8; c++) {
    out[String(c)] = await getBalance(accountHex, c).catch(() => '0');
  }
  return out;
}

/** The shared selector + fund-panel legs (identical in 95 and 96, per-asset). */
async function selectorAndFundPanel(m: Awaited<ReturnType<typeof onboardWallet>>, asset: typeof VCHF, accountHex: string) {
  await openBalances(m);
  assertIncludes(m.driver.readText(`accounts-currency-${asset.chip}`), `${asset.unit} · Internet Computer`, `${asset.unit} row unit · network`);
  const sheetBody = m.driver.bodyText();
  expect(sheetBody).not.toContain('Add money');
  expect(sheetBody).not.toContain('Cash out');
  // RTR forwards a button's testID to wrapper nodes — count the PRESSABLE ones (the e2e counted
  // DOM [data-testid] elements): exactly one top-up button, DEMO's faucet (VCHF/ICP have none).
  const topups = m.driver.findAllByTestID('btn-topup').filter((n) => typeof n.props.onPress === 'function');
  expect(topups).toHaveLength(1);

  await selectCurrency(m, asset.key);
  assertEq(m.driver.readText('active-asset-label'), `Balance ${asset.chip}`, 'chip after the row select (main currency)');
  await m.driver.click('tab-pay', {timeoutMs: 4000});
  await m.driver.findByTestID('pay-fund', {timeoutMs: 6000});
  const fundBody = m.driver.bodyText();
  assertIncludes(fundBody, `No ${asset.unit} available`, 'fund panel names the asset');
  assertIncludes(fundBody, `receive ${asset.unit} at your address`, 'fund panel gives the practical receive-first instruction');
  await m.driver.click('pay-fund-go', {timeoutMs: 5000});
  await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
  assertEq(m.driver.readText('deposit-address').trim(), await railPrincipalText(accountHex), 'the shown address is this wallet’s own ICRC-1 principal');
  assertIncludes(m.driver.bodyText(), 'No memo or reference needed', 'receive surface carries practical instructions');
  await m.driver.click('tab-pay', {timeoutMs: 4000});
}

describe('flow 95 — VCHF pay (deeplink entry, explicit approve, exact ledger target)', () => {
  it('netted-price link reviews at the typed price, signs only the VCHF ledger, settles exactly', async () => {
    const m = await onboardWallet('jest-vchf-payer');
    const account = (await accountOf(m))!.publicHex;
    await selectorAndFundPanel(m, VCHF, account);

    // Seed; the header figure is the CURRENCY-unit sum (compact 2-dec stables).
    const fund = await faucetAccount(account, Number(SEED), {currency: VCHF.currency});
    assert(fund.ok, `faucet credit ok (${fund.status})`);
    assert(await m.driver.waitForText(VCHF.chipFigure, {timeoutMs: 10_000}), 'the seed surfaced in-app');

    const bob = await generateKeypair();
    const aliceBefore = await snapBalances(account);
    const bobBefore = await snapBalances(bob.publicHex);
    assertEq(aliceBefore[String(VCHF.currency)], SEED, 'payer VCHF after faucet (raw)');
    assertEq(aliceBefore['0'], '10000', 'payer DEMO untouched by the VCHF faucet');

    // The link names VCHF/IC with the NETTED wire amount; the cold-load carries the review card.
    await m.unmount();
    const nonce = 'ba'.repeat(16);
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const m2 = await mountApp({url: `/wallet/pay/${bobPrincipal}?asset=VCHF&network=internet-computer&amount=0.99990001&label=Bob&ref=${nonce}`});
    await m2.driver.findByTestID('pay-amount', {timeoutMs: 8000});
    await m2.driver.waitForText('Pay 1.00000001 VCHF', {timeoutMs: 6000});
    assertIncludes(m2.driver.readText('pay-amount'), 'Pay 1.00000001 VCHF', 'review shows the total debit (netted wire + fee = the typed price)');
    assertEq(m2.driver.readText('review-payee'), bobPrincipal, 'review shows the full destination account');
    assertIncludes(m2.driver.bodyText(), 'Bob', 'review shows the label the link carried');
    expect(m2.driver.bodyText()).not.toMatch(/\bPaid\b/);

    const rec = recordCanisterCalls();
    await m2.driver.click('btn-approve', {timeoutMs: 5000});
    assert(await m2.driver.waitForText('Paid', {timeoutMs: 12_000}), 'the explicit Approve settles');
    assertIncludes(m2.driver.bodyText(), '1.00000001 VCHF', 'paid screen shows the total debited');
    rec.restore();

    // Every canister call targets VCHF's exact ledger.
    const calls = rec.calls().filter((u) => u.endsWith('/call'));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const prefix = `${process.env.DPAY_JEST_RELAY_URL}/api/v2/canister/`;
    for (const u of calls) {
      expect(u.startsWith(prefix)).toBe(true);
      expect(u.slice(prefix.length).replace(/\/call$/, '')).toBe(VCHF.ledger);
    }

    // Exact settlement + sibling isolation.
    const aliceAfter = await snapBalances(account);
    const bobAfter = await snapBalances(bob.publicHex);
    assertEq(bobAfter[String(VCHF.currency)], WIRE, 'payee credited the netted wire');
    assertEq(aliceAfter[String(VCHF.currency)], (BigInt(SEED) - BigInt(PAY)).toString(), 'payer debited exactly the price');
    for (const c of Object.keys(aliceBefore)) {
      if (c !== String(VCHF.currency)) assertEq(aliceAfter[c], aliceBefore[c], `payer sibling currency ${c} unchanged`);
    }
    for (const c of Object.keys(bobBefore)) {
      if (c !== String(VCHF.currency)) assertEq(bobAfter[c], bobBefore[c], `payee sibling currency ${c} unchanged`);
    }

    // In-app refresh + the accounts row, then the Ledger outgoing row (gross headline).
    assert(await m2.driver.waitForText(VCHF.chipAfter, {timeoutMs: 10_000}), 'the header refreshed by the exact price');
    await m2.driver.click('btn-new', {timeoutMs: 5000});
    await openBalances(m2);
    assertIncludes(m2.driver.readText('accounts-currency-CHF'), VCHF.rowAfter, 'the CHF row refreshed');
    assertIncludes(m2.driver.readText('asset-demo'), '∂100.00', 'DEMO row unchanged');
    await m2.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m2.driver.waitForText('to Bob', {timeoutMs: 10_000}), 'ledger row names the payee via the link-label annotation');
    const body = m2.driver.bodyText();
    assertIncludes(body, '\u22121.00000001 VCHF', 'the row headlines the GROSS (the typed price)');
    assertIncludes(body, '\u2212 0.0001 VCHF fees', 'the fee rides only as the annotation line');
    expect(body).not.toContain(bobPrincipal);
    expect(body).not.toContain(bob.publicHex);

    await m2.unmount();
  }, 180_000);
});

describe('flow 96 — ICP pay (camera-scan entry, one-press auto-sign)', () => {
  it('a scanned netted request signs only the ICP ledger and settles exactly', async () => {
    const m = await onboardWallet('jest-icp-payer');
    const account = (await accountOf(m))!.publicHex;
    await selectorAndFundPanel(m, ICP, account);

    const fund = await faucetAccount(account, Number(SEED), {currency: ICP.currency});
    assert(fund.ok, `faucet credit ok (${fund.status})`);
    // ICP is its own currency and renders at FULL 8-dec precision (2.10000001 ICP).
    await m.driver.waitForFunction(() => /2\.1(0)?(0000001)? ICP/.test(m.driver.bodyText()),
      {timeoutMs: 10_000, label: 'the seed surfaced in-app'});

    const bob = await generateKeypair();
    const aliceBefore = await snapBalances(account);
    const bobBefore = await snapBalances(bob.publicHex);

    // The merchant's request carries the NETTED wire (what a dpay payee quotes).
    const nonce = 'cb'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, WIRE, nonce, expiry, ICP.currency, 'Bob', '');
    const decoded = await DpayCore.decodeRequest(requestQR);
    assertEq(decoded.currency, ICP.currency, 'request QR carries the ICP currency id');
    assertEq(decoded.amount, WIRE, 'request QR carries the netted wire in exact raw units');

    const rec = recordCanisterCalls();
    await armPayScan(m);
    await m.driver.settleFrames(1);
    scanSeam()(requestQR);
    assert(await m.driver.waitForText('Paid', {timeoutMs: 12_000}), 'the camera path auto-signs');
    // The total (wire + fee) needs the async icrc1_fee round trip — WAIT for it.
    assert(await m.driver.waitForText('1.00000001 ICP', {timeoutMs: 15_000}), 'paid screen shows the total debited');
    rec.restore();

    const calls = rec.calls().filter((u) => u.endsWith('/call'));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const prefix = `${process.env.DPAY_JEST_RELAY_URL}/api/v2/canister/`;
    for (const u of calls) {
      expect(u.startsWith(prefix)).toBe(true);
      expect(u.slice(prefix.length).replace(/\/call$/, '')).toBe(ICP.ledger);
    }

    const aliceAfter = await snapBalances(account);
    const bobAfter = await snapBalances(bob.publicHex);
    assertEq(bobAfter[String(ICP.currency)], WIRE, 'payee credited the netted wire');
    assertEq(aliceAfter[String(ICP.currency)], (BigInt(SEED) - BigInt(PAY)).toString(), 'payer debited exactly the price');
    for (const c of Object.keys(aliceBefore)) {
      if (c !== String(ICP.currency)) assertEq(aliceAfter[c], aliceBefore[c], `payer sibling currency ${c} unchanged`);
    }
    for (const c of Object.keys(bobBefore)) {
      if (c !== String(ICP.currency)) assertEq(bobAfter[c], bobBefore[c], `payee sibling currency ${c} unchanged`);
    }

    await m.driver.waitForFunction(() => /1\.1(0)?(0000001)? ICP/.test(m.driver.bodyText()),
      {timeoutMs: 10_000, label: 'the header refreshed by the exact price'});
    await m.driver.click('btn-new', {timeoutMs: 5000});
    await openBalances(m);
    await m.driver.waitForFunction(() => /1\.1(0)?(0000001)? ICP/.test(m.driver.readText('accounts-currency-ICP')),
      {timeoutMs: 10_000, label: 'the ICP row refreshed'});
    assertIncludes(m.driver.readText('asset-demo'), '∂100.00', 'DEMO row unchanged');
    await m.driver.click('tab-transactions', {timeoutMs: 5000});
    assert(await m.driver.waitForText('to Bob', {timeoutMs: 10_000}), 'ledger row names the payee via the request annotation');
    const body = m.driver.bodyText();
    assertIncludes(body, '\u22121.00000001 ICP', 'the row headlines the GROSS');
    assertIncludes(body, '\u2212 0.0001 ICP fees', 'the fee rides only as the annotation line');
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    expect(body).not.toContain(bobPrincipal);
    expect(body).not.toContain(bob.publicHex);

    await m.unmount();
  }, 180_000);
});
