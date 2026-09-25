// Flow 169 — V6 app-level resume: a pending conversion SURVIVES an app reload and the ENGINE
// (mounted from Wallet on load, no Convert screen open anywhere) drives it to done.
//
// This is the multi-venue-readiness V6 recovery pin, in three observable moves:
//   * the record persists under the IDENTITY-SCOPED key `dpay.convert.v2.<publicHex>` — read
//     straight from localStorage (RN-web AsyncStorage maps 1:1), proving the store scope too;
//   * after `navigate('/')` (the full reload — same browser context, identity + record persist),
//     the venue queue is drained (`settle_pending`) and the record reaches `done` with an `outTx`
//     WITHOUT the Convert screen ever being opened — only the resume engine writes that
//     transition, so the localStorage poll is a direct observation of unmounted driving;
//   * the balance corroborates: VCHF credited exactly the gross the venue held.
//
// Red lines pinned on the way: nothing is re-signed across the reload (the record's legs are
// byte-frozen; recovery = re-watching, never re-building), and the terminal record is NOT
// resurrected onto the screen afterwards — opening Convert shows the form; the balance and the
// history tell the outcome (the pick rule: live or unacknowledged-stuck only).
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency, openConvertFor,
} from '../harness/lib.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const POOL = '65mrh-fqaaa-aaaar-qapoa-cai';
const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
const AMOUNT_IN = 100000000n; // 1 ICP

async function swapPoolKnob(relayBaseURL, body) {
  const r = await fetch(`${relayBaseURL}/api/v1/test/swap_pool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`swap_pool knob ${r.status}: ${await r.text()}`);
}

async function relayQuoteOut(relayBaseURL) {
  const u = `${relayBaseURL}/api/v1/swap_quote?pool=${POOL}&token_in=${ICP_LEDGER}&token_out=${VCHF_LEDGER}&amount_in=${AMOUNT_IN}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`swap_quote ${r.status}: ${await r.text()}`);
  return BigInt((await r.json()).amount_out);
}

export const meta = {
  id: '169',
  name: 'convert-resume-reload',
  journey: 'convert',
  covers: ['convert', 'icp', 'vchf', 'pending-withdrawal', 'reload', 'identity-scoped-store', 'resume-engine', 'unmounted-driving', 'no-resubmit', 'resolution'],
  verifies: 'A conversion parked on pending_withdrawal survives a full app reload under the identity-scoped store key, and the wallet-load resume engine (no Convert screen open) drives it to done when the venue settles — nothing re-signed, outTx recorded, VCHF credited exactly; a terminal record is not resurrected onto the reopened screen.',
  timeoutMs: 120000, // onboard + pending park + reload + engine re-arm/probe cycles (seam-shrunk cadences)
};

export async function run() {
  const start = Date.now();
  console.log('[169-convert-resume-reload] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {relayBaseURL, webBaseURL, driver} = env;

    console.log('[169-convert-resume-reload] onboarding + funding 3 ICP…');
    await onboardWallet(driver, 'e2e-convert-resume');
    const account = await accountOf(driver);
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, {currency: 8});
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openConvertFor(driver, 'icp');
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', {timeoutMs: 10_000});

    // Park the conversion on the honest pending (venue holds the output).
    console.log('[169-convert-resume-reload] arming fail_withdrawal and confirming…');
    await swapPoolKnob(relayBaseURL, {pool: POOL, fail_withdrawal: true});
    const executedGross = await relayQuoteOut(relayBaseURL);
    let pending = null;
    for (let round = 0; round < 5 && pending == null; round++) {
      await driver.click('btn-convert-confirm', {timeoutMs: 6_000});
      pending = await driver.findByTestID('convert-pending', {timeoutMs: 20_000}).catch(() => null);
      if (pending == null) {
        const changed = await driver.readText('convert-quote-changed').catch(() => null);
        if (changed == null) break; // no panel and no interrupt — surface the failure below
        console.log('[169-convert-resume-reload] pool drifted → re-confirmed at the fresh quote');
      }
    }
    assert(pending != null, 'pending_withdrawal panel renders before the reload');

    // The record persists under the IDENTITY-SCOPED key (V6): read it straight from localStorage.
    const scopedKey = `dpay.convert.v2.${account.publicHex}`;
    const parked = await driver.eval((k) => {
      const raw = window.localStorage.getItem(k);
      if (raw == null) return null;
      const all = JSON.parse(raw);
      const rec = Object.values(all)[0];
      return rec == null ? null : {step: rec.step, legs: Array.isArray(rec.legs) ? rec.legs.length : 0};
    }, scopedKey);
    assert(parked != null, `record persisted under the scoped key ${scopedKey}`);
    assert(parked.step === 'pending_withdrawal', `parked record step is pending_withdrawal (saw ${parked?.step})`);
    assertEq(parked.legs, 2, 'the signed legs are frozen in the record (nothing to re-build)');

    // --- the full reload: same browser context, so identity AND the scoped store survive ---------
    // The relay rides the same `?relay=` param every harness navigation uses (environment
    // wiring, not the behavior under test) — the harness relay's port is random per run.
    console.log('[169-convert-resume-reload] reloading the app (engine must start from Wallet load)…');
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    // Wallet (not onboarding — identity persisted) mounts the engine on load. The Convert screen
    // is NEVER opened from here on: the only writer that can move the parked record is the engine.

    console.log('[169-convert-resume-reload] draining the venue queue (settle_pending)…');
    await swapPoolKnob(relayBaseURL, {pool: POOL, fail_withdrawal: false, settle_pending: true});

    // Poll the scoped store until the ENGINE alone has driven it to done. The engine's cadence
    // under the harness seam (__DPAY_TEST_CONVERT_ENGINE): ledger re-arm every 500 ms + a settle
    // watch of 10 probes × 100 ms — so done lands within ~2 s; the deadline leaves contention headroom.
    let resolved = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && resolved == null) {
      resolved = await driver.eval((k) => {
        const raw = window.localStorage.getItem(k);
        if (raw == null) return null;
        const rec = Object.values(JSON.parse(raw))[0];
        return rec == null ? null : {step: rec.step, outTx: rec.outTx ?? null, outAmountNet: rec.outAmountNet ?? null};
      }, scopedKey);
      if (resolved?.step !== 'done') resolved = null;
      if (resolved == null) await new Promise((r) => setTimeout(r, 250));
    }
    assert(resolved != null, 'the unmounted engine drove the reloaded record to done (wallet-load resume)');
    assert(resolved.outTx != null, 'done carries the payout row identity (outTx, the ledger block index)');

    // Balance corroborates: the venue's held output was credited exactly once, the full gross.
    assertEq(BigInt(await getBalance(relayBaseURL, account.publicHex, 7)), executedGross, 'VCHF credited the full gross out after the unmounted resume');

    // A terminal record is NOT resurrected: opening Convert shows the form, not a done panel.
    await openConvertFor(driver, 'icp');
    await driver.type('convert-amount', '1'); // fresh mount: the quote (and headline) need the amount
    await driver.findByTestID('convert-headline', {timeoutMs: 10_000});
    const doneGone = await driver.findByTestID('convert-done', {timeoutMs: 3_000}).catch(() => null);
    assert(doneGone == null, 'the done record is not resurrected onto the reopened screen (the balance tells the outcome)');
    const bodyAll = await driver.bodyText();
    assertIncludes(bodyAll, 'ICP', 'the convert form renders for the next conversion');

    console.log(`[169-convert-resume-reload] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('169-convert-resume-reload RED:', e.stack || e.message || e);
  });
}
