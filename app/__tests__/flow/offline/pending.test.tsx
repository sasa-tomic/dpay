/**
 * Flows 179, 180, 181, 182 — the jest twins of the offline-pending family
 * (`e2e/tests/179-offline-nfc-pending.mjs`, `180-offline-qr-pending.mjs`,
 * `181-offline-restart-cached.mjs`, `182-offline-reconcile.mjs`; batch D port).
 *
 * An offline payment must still show locally, honestly: a pending row headlining the GROSS
 * (wire + fee — the account moves both, founder 2026-09-14), the balance deducted by that gross,
 * no other asset touched. 179 pins the NFC tap's unconfirmed terminal (the record SURVIVES the
 * honest error terminal); 180 the QR hand-off twin (scan → auto-sign → "Paid" press keeps it);
 * 181 the RESTART (cached real balance, approx-marked per the staleness rule, pending row
 * survives); 182 the RECONCILE (authoritative poll replaces the optimistic deduction, the
 * merchant settles the same memo, the settled row retires the pending row with no duplicate).
 */
import {describe, it, expect, afterEach} from '@jest/globals';
import {
  accountOf, armNfcCard, armPayScan, assert, assertEq, DpayCore, faucetAccount,
  generateKeypair, getBalance, goOffline, onboardWallet, openBalances, railTransfer,
  selectCurrency, setRelay, waitForWallet, type Mount,
} from '../harness/lib';
import {clickByAria, type NfcEvent} from '../nfc/h';

const g = globalThis as unknown as Record<string, unknown>;

const CURRENCY = 8;      // ICP — a real ledger with a real catalog fee, so GROSS ≠ WIRE here
const SEED = 210000001;  // 2.10000001 ICP
const PAY = 100000001;   // the PRICE (wire + fee)
const FEE = 10000;       // ICP catalog fee — knowable OFFLINE via the ledger-fee fallback
const WIRE = PAY - FEE;  // 99990001 — what the request carries and the rail moves

// The e2e gives every flow a fresh page; jest's file-level globalThis persists across tests, so
// the seams the offline tests flip must be restored or the next test inherits a dead IC gateway
// (the hand-off sign refuses to stamp against an unreachable clock) or shrunk staleness ticks.
const RELAY_URL = () => process.env.DPAY_JEST_RELAY_URL ?? '';
afterEach(() => {
  g.__DPAY_TEST_IC_GATEWAY = RELAY_URL();
  delete g.__DPAY_TEST_BALANCE_STALE_MS;
  delete g.__DPAY_TEST_BALANCE_TICK_MS;
});

/** The shared prelude: funded ICP wallet, ICP selected, header carries the balance. */
async function fundedIcpWallet(name: string): Promise<{m: Mount; payer: {secretHex: string; publicHex: string; username: string}}> {
  const m = await onboardWallet(name);
  const payer = (await accountOf(m))!;
  const fund = await faucetAccount(payer.publicHex, SEED, {currency: CURRENCY});
  assert(fund.ok, `faucet funding must succeed, got ${fund.status}`);
  await openBalances(m);
  await selectCurrency(m, 'icp');
  expect(await m.driver.waitForText('2.10000001 ICP', {timeoutMs: 10000})).toBe(true);
  return {m, payer};
}

/** The offline QR hand-off (flows 180/181/182's shared leg): offline scan → auto-sign → Paid press. */
async function offlineQrHandoff(m: Mount, merchantPubHex: string): Promise<void> {
  const nonceHex = 'ab'.repeat(16);
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const requestQR = await DpayCore.encodeRequest(merchantPubHex, String(WIRE), nonceHex, expiry, CURRENCY, 'Café Sunrise', '');
  await armPayScan(m);
  (g.__DPAY_TEST_SCAN as (v: string) => void)(requestQR);
  // Offline: no submit happens — the app shows the envelope QR + the honest confirm row.
  await m.driver.findByTestID('btn-paid', {timeoutMs: 6000});
  expect(await m.driver.waitForText('1.00000001 ICP', {timeoutMs: 4000})).toBe(true);
  // The hand-off press: "I showed the merchant my envelope" — payment assumed done.
  await m.driver.click('btn-paid', {timeoutMs: 4000});
  await m.driver.findByTestID('btn-new', {timeoutMs: 5000});
  await m.driver.click('btn-new', {timeoutMs: 4000});
}

/** The history surface readiness anchor (the flow-steps openHistory twin). */
async function openHistory(m: Mount): Promise<void> {
  await m.driver.click('tab-transactions', {timeoutMs: 5000});
  expect(await m.driver.waitForText('Recent', {timeoutMs: 8000})).toBe(true);
}

describe('flow 179 — an unconfirmed offline NFC tap renders the pending gross and deducts it', () => {
  it('tap → auto-sign → error terminal → pending row (gross) on Home + Ledger, ICP deducted, DEMO untouched', async () => {
    g.__DPAY_TEST_NFC_STATUS = 'ready';
    const {m} = await fundedIcpWallet('jest-offline-nfc');
    const merchant = await generateKeypair(); // only the recipient pubkey is needed offline

    await goOffline(m);
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    // The tap: request → auto-sign → unconfirmed.
    const dispatch = async (event: NfcEvent): Promise<void> => {
      await armNfcCard(m, 'ic');
      (g.__DPAY_TEST_NFC_SESSION as (e: NfcEvent) => void)(event);
    };
    await dispatch({type: 'phase', role: 'card', phase: 'linking'});
    await m.driver.findByTestID('nfc-status', {timeoutMs: 5000});
    const nonceHex = 'cd'.repeat(16);
    await dispatch({
      type: 'request', role: 'card',
      toHex: merchant.publicHex, amount: String(WIRE), nonceHex,
      expiry: Math.floor(Date.now() / 1000) + 240, currency: CURRENCY,
    });
    expect(await m.driver.waitForText('Communicating', {timeoutMs: 6000})).toBe(true);
    // The status line rides the GROSS once the fee fallback answered (offline → catalog fee).
    expect(await m.driver.waitForText('Paying 1.00000001 ICP', {timeoutMs: 4000})).toBe(true);

    // Unknown outcome: the transport dies. The record must SURVIVE this terminal.
    await dispatch({type: 'error', role: 'card', reason: 'jest: unconfirmed tap'});
    expect(await m.driver.waitForText('Tap failed', {timeoutMs: 5000})).toBe(true);
    expect(await clickByAria(m, 'Done')).toBe('Done');
    await m.driver.waitGone('nfc-status', {timeoutMs: 5000});

    // The local ledger: pending row + gross deduction, nothing else moved.
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 6000});
    expect(m.driver.bodyText()).toContain('\u22121.00000001 ICP');

    await openHistory(m);
    await m.driver.findByTestID('hist-pending-0', {timeoutMs: 5000});
    const ledger = m.driver.bodyText();
    expect(ledger).toContain('\u22121.00000001 ICP');
    expect(ledger).toContain('\u2212 0.0001 ICP fees');

    // Balance deducted by the GROSS (2.10000001 − 1.00000001 = 1.10); DEMO untouched.
    await openBalances(m);
    expect(await m.driver.waitForText('1.1 ICP', {timeoutMs: 6000})).toBe(true);
    expect(m.driver.bodyText()).toContain('\u2202100.00');

    await m.unmount();
  }, 150_000);
});

describe('flow 180 — the offline QR hand-off renders the payment exactly like the tap does', () => {
  it('offline scan → signed envelope QR → Paid press → pending row (gross + merchant name), balance deducted', async () => {
    console.log('PROBE gw seam =', JSON.stringify(g.__DPAY_TEST_IC_GATEWAY), 'relay env =', process.env.DPAY_JEST_RELAY_URL);
    const {m} = await fundedIcpWallet('jest-offline-qr');
    const merchant = await generateKeypair();

    // keepGateway (the flow-20 premise): the relay dies while the IC gateway stays alive so the
    // camera sign path stamps its value envelope from the certified IC clock.
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    await offlineQrHandoff(m, merchant.publicHex);

    // The local ledger: pending row + gross deduction.
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 6000});
    const home = m.driver.bodyText();
    expect(home).toContain('\u22121.00000001 ICP');
    expect(home).toContain('Café Sunrise');

    await openHistory(m);
    await m.driver.findByTestID('hist-pending-0', {timeoutMs: 5000});
    expect(m.driver.bodyText()).toContain('\u22121.00000001 ICP');

    await openBalances(m);
    expect(await m.driver.waitForText('1.1 ICP', {timeoutMs: 6000})).toBe(true);

    await m.unmount();
  }, 150_000);
});

describe('flow 181 — the restarted offline wallet shows its cached real balance (approx-marked)', () => {
  it('offline hand-off → plain figure while fresh → marked once stale → restart hydrates cache + pending row', async () => {
    const {m} = await fundedIcpWallet('jest-offline-restart');
    const merchant = await generateKeypair();

    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    // An offline hand-off first, so the restart must ALSO carry the pending row.
    await offlineQrHandoff(m, merchant.publicHex);
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 6000});

    // Edge 1: freshly offline ⇒ the figure is plain (the founder >1 min rule withholds the marker).
    await openBalances(m);
    await m.driver.findByTestID('accounts-currency-ICP', {timeoutMs: 6000});
    let sheet = m.driver.bodyText();
    expect(sheet).toContain('1.1 ICP');
    expect(sheet).not.toContain('~1.1 ICP');

    // Edge 2: shrink the Wallet staleness SEAM (per-call reads) — the marker lands at the first
    // tick after the 3 s bound (the mount-armed tick can lag one prod cadence; budget covers it).
    g.__DPAY_TEST_BALANCE_STALE_MS = 3000;
    g.__DPAY_TEST_BALANCE_TICK_MS = 250;
    expect(await m.driver.waitForText('~1.1 ICP', {timeoutMs: 35000})).toBe(true);

    // The restart: remount WITHOUT clearing storage — the persisted retarget boots against the
    // STILL-DEAD relay; the seams survive (same globalThis) and the cache's own timestamp is past
    // the bound, so the figure is marked from the first render.
    await m.remount();
    await waitForWallet(m);
    await openBalances(m);
    expect(await m.driver.waitForText('~1.1 ICP', {timeoutMs: 15000})).toBe(true);
    const body = m.driver.bodyText();
    expect(body).not.toContain('2.10000001 ICP'); // the pre-hand-off figure must not resurface

    // The pending row survived the restart (persisted outbox, not session state).
    await m.driver.click('tab-home', {timeoutMs: 6000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 8000});
    expect(m.driver.bodyText()).toContain('\u22121.00000001 ICP');

    await m.unmount();
  }, 180_000);
});

describe('flow 182 — back online, the pending payment reconciles into a settled history row', () => {
  it('authoritative poll replaces the deduction → merchant settles the memo → pending retires, exactly one row', async () => {
    const {m, payer} = await fundedIcpWallet('jest-offline-reconcile');
    const merchant = await generateKeypair();

    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    const nonceHex = 'ab'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(merchant.publicHex, String(WIRE), nonceHex, expiry, CURRENCY, 'Café Sunrise', '');
    await armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(requestQR);
    await m.driver.findByTestID('btn-paid', {timeoutMs: 6000});
    await m.driver.click('btn-paid', {timeoutMs: 4000});
    await m.driver.findByTestID('btn-new', {timeoutMs: 5000});
    await m.driver.click('btn-new', {timeoutMs: 4000});
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 6000});
    await openBalances(m);
    expect(m.driver.bodyText()).toContain('1.1 ICP');

    // Back online, merchant has NOT settled: the authoritative balance wins.
    await setRelay(m, process.env.DPAY_JEST_RELAY_URL!);
    expect(await m.driver.waitForText('2.10000001 ICP', {timeoutMs: 15000})).toBe(true);
    await m.driver.click('tab-home', {timeoutMs: 4000});
    await m.driver.findByTestID('home-hist-pending-0', {timeoutMs: 6000}); // the pending ROW stays
    expect(m.driver.bodyText()).not.toContain('~1.1 ICP');

    // The merchant's phone settles the handed-off envelope (same wire, same memo nonce).
    const settle = await railTransfer(payer.secretHex, merchant.publicHex, WIRE, {currency: CURRENCY, memoHex: nonceHex});
    assert(settle.ok, `the merchant-side settle must be accepted, got ${settle.status}`);

    // The reconciliation: settled row lands, pending row retires, balance settles once.
    await openBalances(m);
    expect(await m.driver.waitForText('1.1 ICP', {timeoutMs: 20000})).toBe(true);
    await openHistory(m);
    await m.driver.waitGone('hist-pending-0', {timeoutMs: 15000});
    const ledger = m.driver.bodyText();
    expect(ledger).toContain('\u22121.00000001 ICP');
    expect(ledger).toContain('\u2212 0.0001 ICP fees');
    expect(ledger).toContain('Café Sunrise');
    // Exactly ONE row for this payment — the pending projection and the settled row never coexist.
    assertEq((ledger.match(/\u22121\.00000001 ICP/g) ?? []).length, 1, 'exactly one row headlines this payment');

    // The rail truth agrees: the account moved the gross, exactly once.
    assertEq(String(await getBalance(payer.publicHex, CURRENCY)), String(SEED - PAY), 'the rail balance equals funded − gross');

    await m.unmount();
  }, 180_000);
});
