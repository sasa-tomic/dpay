/**
 * Flow 110 offline-send-gate — the jest twin of `e2e/tests/110-offline-send-gate.mjs`
 * (batch D port). The Pay tab's two halves have OPPOSITE connectivity truths: scan-to-pay is
 * dpay's offline signature rail (the MERCHANT submits), while an address send has no counterparty
 * — this phone submits it — so airplane mode genuinely blocks it. Offline, the send form is
 * REPLACED by an instruction naming the constraint and routing to Scan to pay (the rail that
 * works offline); back online the form returns — the gate is connectivity and nothing else.
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {relayBaseURL} from '../harness/relayClient';
import {it, expect} from '@jest/globals';
import {
  accountOf, assert, faucetAccount, goOffline, onboardWallet, openBalances, selectCurrency, setRelay,
} from '../harness/lib';

const CURRENCY = 7;       // VCHF — a send-capable direct-ICRC row
const SEED = 500_000_000; // 5.00000000 VCHF: funded, so the zero-balance fund-first gate cannot mask this one

hermeticFlow();

hermeticDescribe('flow 110 — offline, Send-to-address says so up front and points at Scan to pay', () => {
  it('online form → offline instruction (no fields) → primary lands on scan → online restores', async () => {
    const m = await onboardWallet('jest-offsend');
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex ?? '';
    assert(accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);

    // Funded, because the zero-balance fund-first gate ALSO replaces the send form: without funds
    // this flow would pass against the wrong panel and prove nothing about connectivity.
    const fund = await faucetAccount(accountHex, SEED, {currency: CURRENCY});
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    // Online baseline: the form renders.
    await openBalances(m);
    await selectCurrency(m, 'vchf');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('send-address-input', {timeoutMs: 10000});

    // Offline (dead relay + dead gateway): the form is REPLACED by the instruction.
    await goOffline(m);
    await m.driver.findByTestID('pay-send-offline', {timeoutMs: 15000});
    expect(m.driver.isPresent('send-address-input')).toBe(false);
    const panel = m.driver.readText('pay-send-offline');
    expect(panel).toContain('connection');
    expect(panel).toContain('Scan the merchant');

    // The primary is the way out, not decoration: it lands on the scan surface, whose pay-intent
    // gate (btn-start-scan) is the proof we are actually there.
    await m.driver.click('pay-send-offline-go', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-start-scan', {timeoutMs: 10000});

    // Back online: the gate is connectivity alone — the form returns.
    await setRelay(m, relayBaseURL());
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});
    await m.driver.findByTestID('send-address-input', {timeoutMs: 15000});
    expect(m.driver.isPresent('pay-send-offline')).toBe(false);

    await m.unmount();
  }, 120_000);
});
