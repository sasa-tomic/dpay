/**
 * Flow 20 offline-handoff — the jest twin of `e2e/tests/20-offline-handoff.mjs` (batch D port).
 * The payer's phone has NO network, yet pays: A approves bob's request while offline; the app
 * signs a REAL icrc1_transfer envelope (memo = request nonce) and shows it as a QR hand-off
 * (base64url envelope bytes). The test walks it to "bob's phone" (POSTs it to the fake-IC gateway
 * exactly as the merchant app would after scanning), then brings A back online — A's reconcile
 * poll (read_state, keyed by the request_id it signed) flips the screen to Paid. Bob's balance grows.
 *
 * Rail semantics: the offline branch never POSTs (nothing to dedup on A's side); the envelope QR
 * IS the payment; reconciliation is by request_id via read_state.
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {
  accountOf, armPayScan, assert, DpayCore, faucetAccount, generateKeypair, getBalance,
  goOffline, icpCatalog, onboardWallet, openBalances, setRelay,
} from '../harness/lib';

const g = globalThis as unknown as Record<string, unknown>;
const PAY_CENTS = '2500';

hermeticFlow();

hermeticDescribe('flow 20 — offline envelope hand-off + reconcile-by-request_id', () => {
  it('offline scan → signed envelope QR → counterparty submits → back online → Paid, balances move', async () => {
    // Payee bob (keypair only — the "merchant phone" is this test acting on his behalf).
    const bob = await generateKeypair();
    await faucetAccount(bob.publicHex, 10_000);

    // Payer A: onboarded while ONLINE, then offline with the gateway kept alive — this flow's
    // DESIGN requires a live IC gateway (the rail submits envelopes to /api/v2; offline here means
    // relay-dead-only, so the online flag flips and the offline sign branch engages).
    const m = await onboardWallet('jest-alice');
    const alice = await accountOf(m);
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    // bob's request QR (built wire-side — his "phone" is this test).
    const nonceHex = 'cd'.repeat(16);
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = await DpayCore.encodeRequest(bob.publicHex, PAY_CENTS, nonceHex, expiry, 0, 'bob', '');
    await armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(requestQR);

    // One-press: the scan AUTO-SIGNS while offline. The transient sign status may flash by unread
    // on a fast host, so the QR surface is the assert (the ∂25.00 rides the amountBig line).
    expect(await m.driver.waitForText('signed on this device ✓', {timeoutMs: 8000})).toBe(true);

    // The hand-off QR payload is base64url(envelope bytes) — the exact bytes the merchant app POSTs.
    const payload = g.__DPAY_QR_LAST as string;
    assert(typeof payload === 'string' && payload.length >= 64, `hand-off QR payload must be the base64url envelope (>=64 chars), got ${payload?.length}`);
    const envelopeBytes = new Uint8Array(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

    // "bob's phone" submits the envelope to the IC gateway.
    const catalog = await icpCatalog();
    const ledger = catalog.find((c) => c.currency === 0)?.ledger ?? '';
    const submitted = await fetch(`${process.env.DPAY_JEST_RELAY_URL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: envelopeBytes,
    });
    expect(submitted.status).toBe(202);

    // bob's ledger balance grew by the payment.
    expect(await getBalance(bob.publicHex, 0)).toBe('12500');

    // A comes back online → reconcile-by-request_id flips the screen to Paid.
    await setRelay(m, process.env.DPAY_JEST_RELAY_URL!);
    expect(await m.driver.waitForText('Paid', {timeoutMs: 12000})).toBe(true);
    expect(m.driver.bodyText()).toContain('∂25.00');

    // A's balance reflects the debit (100 − 25): the Paid card locks the pay surface, so release it.
    expect(await getBalance(alice!.publicHex, 0)).toBe('7500');
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await openBalances(m);
    expect(await m.driver.waitForText('∂75.00', {timeoutMs: 10000})).toBe(true);

    await m.unmount();
  }, 120_000);
});
