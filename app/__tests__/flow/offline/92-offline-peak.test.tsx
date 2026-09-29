/**
 * Flow 92 offline-peak — the jest twin of `e2e/tests/92-offline-peak.mjs` (batch-D gap fix: the
 * POSITIVE leg the first migration pass dropped).
 *
 * The FIRST truly-offline CONFIRMED payment earns the one-shot campaign peak ("Signal? Don't
 * need it."), which auto-settles (~2s) into the quiet `first-offline-stamp` remnant. The journey
 * stamp `firstOfflinePayment` IS the one-shot: persisted at confirmation time, so it survives a
 * remount (the app-kill semantics) and no later payment — offline OR online — ever re-earns it.
 * This file drives the REAL offline hand-off (flow 20's gateway-live/relay-dead pattern — see
 * handoff.test.tsx), reconciles to Paid WHILE THE RELAY IS STILL DEAD (the reconcile poll rides
 * the kept-alive IC gateway), and asserts the peak + its settled remnant + the persistence.
 *
 * Coverage split (fidelity mandate — no duplication):
 *  - the pure one-shot truth table (paths × journey states, idempotence) is `__tests__/peak.test.ts`;
 *  - the NFC-rail negative controls (success/pending/declined taps NEVER peak) live in
 *    `flow/nfc/tap-motion.test.tsx` — not repeated here;
 *  - the hand-off honesty core (the un-confirmed envelope view carries NEITHER the peak NOR the
 *    stamp) is flow 92's own assertion and opens leg 1 below.
 * Not ported (browser-only): the screenshot beats — pixel capture stays in the e2e visual tier.
 * (The 118px 'dpay' circle stamp inside the peak was dropped by founder directive 2026-08-24;
 * the pinned testIDs are unchanged.)
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {
  accountOf, armPayScan, assert, DpayCore, faucetAccount, generateKeypair, getBalance,
  goOffline, icpCatalog, onboardWallet, openBalances, selectCurrency, setRelay, type Mount,
} from '../harness/lib';

const g = globalThis as unknown as Record<string, unknown>;
const RELAY = () => process.env.DPAY_JEST_RELAY_URL ?? '';

/** Absence probe: a direct tree query — deterministic, no wait race (the e2e `absent` helper). */
function absent(m: Mount, testID: string): void {
  expect(m.driver.isPresent(testID)).toBe(false);
}

/** One offline hand-off payment: scan bob's request → auto-sign (one-press rule) → envelope
 *  bytes out (the QR payload is base64url(envelope) — the exact bytes the merchant app POSTs). */
async function offlineHandoff(m: Mount, bobPubHex: string, cents: string, nonceHex: string): Promise<Uint8Array> {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const requestQR = await DpayCore.encodeRequest(bobPubHex, cents, nonceHex, expiry, 0, 'bob', '');
  await armPayScan(m); // pay-intent gate (btn-new/reset disarmed)
  (g.__DPAY_TEST_SCAN as (v: string) => void)(requestQR);
  // The transient sign status can flash by unread on a fast host — the envelope QR is the assert.
  expect(await m.driver.waitForText('signed on this device ✓', {timeoutMs: 10_000})).toBe(true);
  const payload = g.__DPAY_QR_LAST as string;
  assert(typeof payload === 'string' && payload.length >= 64,
    `hand-off QR payload must be the base64url envelope (>=64 chars), got ${payload?.length}`);
  return new Uint8Array(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

/** "bob's phone": submit the envelope to the fake-IC gateway exactly as the merchant app would. */
async function submitEnvelope(envelope: Uint8Array, ledger: string): Promise<void> {
  const submitted = await fetch(`${RELAY()}/api/v2/canister/${ledger}/call`, {
    method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: envelope,
  });
  expect(submitted.status).toBe(202);
}

hermeticFlow();

hermeticDescribe('flow 92 — the one-shot offline peak: earned once, settled to the stamp, never again', () => {
  it('first offline payment peaks (relay still dead) + settles to the stamp; a second offline and an online payment stay quiet; the award survives a remount', async () => {
    // --- Payee bob (keypair only — this test is his phone). ------------------------------------
    const bob = await generateKeypair();
    await faucetAccount(bob.publicHex, 10_000);

    // Payer A: onboarded ONLINE on the DEMO practice rail (the currency-first rule: the wallet
    // opens on MAIN/VCHF which has no practice balance and would gate the pay tab), then truly
    // offline — relay dead, IC gateway alive (offline sign branch engages).
    const m = await onboardWallet('jest-peak-alice');
    const alice = (await accountOf(m))!;
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);

    // --- Leg 1: the FIRST offline payment earns the peak. --------------------------------------
    const envelope = await offlineHandoff(m, bob.publicHex, '2500', 'cd'.repeat(16));

    // HONESTY (the core), checked before the submit flips anything: the hand-off view is signed,
    // not settled — no campaign line, no peak, no stamp, anywhere.
    expect(m.driver.bodyText()).not.toContain("Don't need it");
    absent(m, 'offline-peak');
    absent(m, 'first-offline-stamp');

    const ledger = (await icpCatalog()).find((c) => c.currency === 0)?.ledger ?? '';
    await submitEnvelope(envelope, ledger);

    // THE PEAK mounts while the relay is still dead (the reconcile rides the kept-alive gateway):
    // Paid ✓ → the single-sourced campaign line → the wrapper testID (mounted-but-settled for the
    // card's lifetime — deterministic to catch after the ~2s moment).
    expect(await m.driver.waitForText('Paid', {timeoutMs: 12_000})).toBe(true);
    expect(await m.driver.waitForText("Signal? Don't need it.", {timeoutMs: 6000})).toBe(true);
    expect(m.driver.isPresent('offline-peak')).toBe(true);

    // Auto-settle (~2s real time): the remnant appears, read through its OWN node — readText
    // walks Text children (the source string); a page-wide wait would fight web's uppercase
    // textTransform, which is exactly what burned the 2026-09-01 e2e REDs. The moment microcopy
    // settles away with it.
    await m.driver.findByTestID('first-offline-stamp', {timeoutMs: 8000});
    expect(m.driver.readText('first-offline-stamp')).toContain('paid with no signal');
    expect(m.driver.bodyText()).not.toContain('No signal the whole time');

    // NOW come back online — deferred past the whole peak moment (the e2e's race-hardened order;
    // none of the waits above need the relay).
    await setRelay(m, RELAY());

    // The award is PERSISTED at confirmation time: the journey store carries the one-shot stamp.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
    const journey = JSON.parse((await AsyncStorage.getItem('dpay.journey.v1')) ?? '{}') as {stamps?: string[]};
    expect(journey.stamps ?? []).toContain('firstOfflinePayment');

    // --- Leg 2: a SECOND offline payment is quiet (one-shot, in-session). ----------------------
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);
    await submitEnvelope(await offlineHandoff(m, bob.publicHex, '2500', 'bb'.repeat(16)), ledger);
    await setRelay(m, RELAY());
    expect(await m.driver.waitForText('Paid', {timeoutMs: 12_000})).toBe(true);
    // No peak anywhere (neither the moment nor the remnant), no campaign line.
    absent(m, 'offline-peak');
    absent(m, 'first-offline-stamp');
    absent(m, 'paid-stamp');
    expect(m.driver.bodyText()).not.toContain("Don't need it");

    // --- Leg 3: the ONLINE paid path never peaks — and never earns. ----------------------------
    await m.driver.click('btn-new', {timeoutMs: 8000});
    await openBalances(m); // the practice balance reads on the accounts route
    expect(await m.driver.waitForText('∂50.00', {timeoutMs: 10_000})).toBe(true);
    await m.driver.click('tab-pay', {timeoutMs: 5000}); // the balance read left the app on accounts
    const expiry3 = Math.floor(Date.now() / 1000) + 600;
    const requestQR3 = await DpayCore.encodeRequest(bob.publicHex, '2500', 'cc'.repeat(16), expiry3, 0, 'bob', '');
    await armPayScan(m);
    (g.__DPAY_TEST_SCAN as (v: string) => void)(requestQR3);
    // Online auto-sign: decode → sign → submitTransfer → settled → Paid (no Approve press).
    expect(await m.driver.waitForText('Paid', {timeoutMs: 12_000})).toBe(true);
    absent(m, 'offline-peak');
    absent(m, 'paid-stamp');
    expect(m.driver.bodyText()).not.toContain("Don't need it");

    // Ledger truth after the three ∂25.00 pays (100 − 25 − 25 − 25) — the e2e twin's line.
    expect(await getBalance(alice.publicHex, 0)).toBe('2500');
    expect(await getBalance(bob.publicHex, 0)).toBe('17500');

    // --- Leg 4: the stamp SURVIVES a remount (app kill) — still not re-earnable. ---------------
    // Reload semantics: unmount + remount WITHOUT clearing AsyncStorage. The persisted journey
    // keeps firstOfflinePayment, so the next offline confirmation must stay quiet.
    await m.remount();
    await m.driver.findByTestID('tab-home', {timeoutMs: 10_000});
    await openBalances(m);
    await selectCurrency(m, 'demo');
    await goOffline(m, {keepGateway: true});
    expect(await m.driver.waitForText('approx.', {timeoutMs: 8000})).toBe(true);
    // ∂10.00: the remount's cached balance is the last known ∂25.00 — stay clear of the
    // exact-balance edge, which is flow 19's subject, not this one.
    await submitEnvelope(await offlineHandoff(m, bob.publicHex, '1000', 'dd'.repeat(16)), ledger);
    await setRelay(m, RELAY());
    expect(await m.driver.waitForText('Paid', {timeoutMs: 12_000})).toBe(true);
    absent(m, 'offline-peak');
    absent(m, 'first-offline-stamp');
    expect(m.driver.bodyText()).not.toContain("Don't need it");

    // Final ledger truth across the restart (∂10.00 hand-off).
    expect(await getBalance(alice.publicHex, 0)).toBe('1500');
    expect(await getBalance(bob.publicHex, 0)).toBe('18500');

    await m.unmount();
  }, 150_000);
});
