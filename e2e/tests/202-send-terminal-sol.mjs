// Flow 202 — the send terminal, SOL rail (2026-09 stream D): the deadline seam + the stub flip.
//
// The SOL send ends on the same `SendTerminal` as the IC rail, but its honest unknown is
// RESOLVABLE: the kept signature can be re-read on-chain (read-only, never re-signs). This flow
// drives the whole story against the relay's test stub upstream (the REAL wire: app →
// POST /api/v1/solana/rpc → the test-helpers stub, flow 165's path) with two knobs:
//
//   • `__DPAY_TEST_SOL_SEND_TIMEOUT_MS` (the per-call seam in app/config/constants.ts) shortens
//     the sheet's whole-send deadline to 3 s, so the honest unknown arrives in seconds instead of
//     after a real minute.
//   • `POST /api/v1/test/solana-upstream/mode {confirmAfterHits: 1}` arms the stub's
//     getSignatureStatuses flip: one `[null]` answer, then `confirmed`. The send's confirm loop
//     burns the single null inside its 3 s deadline (its polls use `[[sig]]` params); the Check
//     status read uses `[[sig], {searchTransactionHistory: true}]` — different params, a fresh
//     proxy-cache key, a FRESH stub hit — so the flip fires exactly on the user's Check press.
//
// Legs: (A) submitting → unknown → the honest pending with NO resend control → Check status →
// the settled flip, same signature throughout; (B) the fee-only failure — re-armed with
// `{failAfterHits: 0}`, the next send's own confirm read reports the on-chain InstructionError,
// `sendSol` throws over an ACCEPTED broadcast, and the terminal splits it honestly: the form
// returns WITH the fee-only note and WITHOUT the nothing-was-sent line (money may have moved —
// the fee did).
//
// Selector contract: 52's (`sol-send-address-input`, `sol-send-amount-input`, `sol-send-review`,
// `btn-sol-send-confirm`) plus the terminal grammar — `sol-send-unknown-title`,
// `sol-send-unknown-note`, `sol-send-signature`, `sol-send-outcome`, `btn-sol-send-copy`,
// `btn-sol-send-check`, `btn-sol-send-receipt`, `btn-sol-send-done`, and the error phase's
// `sol-send-fee-note` / `sol-send-nothing-sent`.
import {
  setup, assert, onboardWallet, openBalances, selectCurrency, openPaySend,
} from '../harness/lib.mjs';

const DEST_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'; // valid base58 Solana address

export const meta = {
  id: '202',
  name: 'send-terminal-sol',
  journey: 'withdraw',
  covers: ['send-terminal', 'honest-unknown', 'check-status', 'sol-send-timeout-seam', 'solana-stub-flip', 'fee-only-failure', 'no-resend-invite'],
  verifies: 'The SOL send terminal: a fast deadline over an accepted broadcast lands on the honest unknown (signature kept, no resend control); Check status re-reads the chain read-only and flips the panel to settled on confirmed; a failed check stays honest; an on-chain InstructionError over an accepted broadcast returns to the form with the fee-only note and without the nothing-sent line.',
  timeoutMs: 150000,
};

/** Arm the stub upstream's getSignatureStatuses flip (relay test-helpers route). */
async function armMode(relayBaseURL, body) {
  const r = await fetch(`${relayBaseURL}/api/v1/test/solana-upstream/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(r.ok, `stub mode armed ${JSON.stringify(body)} (status ${r.status}): ${await r.text()}`);
}

const absent = async (driver, testID, timeoutMs = 1_000) =>
  (await driver.findByTestID(testID, { timeoutMs }).catch(() => null)) == null;

export async function run() {
  const start = Date.now();
  console.log('[202-send-terminal-sol] setup (solRpcUrl: relay — the derived production path)…');
  const env = await setup({ solRpcUrl: 'relay' });
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-send-term-sol');
    // The per-call deadline seam: every confirm press reads it fresh, so arming it here (after
    // the bundle evaluated, before the first press) is exactly the prod shape — only shorter.
    await driver.eval(() => { globalThis.__DPAY_TEST_SOL_SEND_TIMEOUT_MS = 3000; });

    // ── Leg A: submitting → unknown → Check status → settled ───────────────────────────────────
    await armMode(relayBaseURL, { confirmAfterHits: 1 });

    await openBalances(driver);
    await driver.waitForText('2 SOL', { timeoutMs: 15_000 }); // the stub's wallet answer, via the proxy
    await selectCurrency(driver, 'sol');
    await openPaySend(driver);
    await driver.findByTestID('sol-send-address-input', { timeoutMs: 5_000 });
    await driver.type('sol-send-address-input', DEST_ADDR, { timeoutMs: 4_000 });
    await driver.type('sol-send-amount-input', '0.5', { timeoutMs: 4_000 });
    await driver.findByTestID('sol-send-review', { timeoutMs: 4_000 });

    console.log('[202-send-terminal-sol] confirm → the 3 s deadline forces the honest unknown…');
    await driver.click('btn-sol-send-confirm', { timeoutMs: 5_000 });
    assert(await driver.waitForText('not confirmed yet', { timeoutMs: 25_000 }),
      'the deadline over the ACCEPTED broadcast lands on the honest unknown, never a failure');
    assert(await absent(driver, 'btn-sol-send-confirm'),
      'THE INVARIANT: the unknown terminal offers NO send control — no second deadline, no resend');
    assert(await absent(driver, 'sol-send-fee-note'), 'a pending send never claims a fee-only failure');
    assert(await absent(driver, 'sol-send-nothing-sent'), '…and never claims nothing was sent — it was accepted');
    const sig = (await driver.readText('sol-send-signature')).trim();
    assert(sig.length > 0, `the signature is kept and shown as the reference, got "${sig}"`);
    await driver.screenshot('202-send-terminal-unknown');

    console.log('[202-send-terminal-sol] Check status → the stub flips → settled…');
    await driver.click('btn-sol-send-check', { timeoutMs: 4_000 });
    assert(await driver.waitForText('Sent', { timeoutMs: 15_000 }),
      'the confirmed read flips the panel to the settled terminal');
    assert(await absent(driver, 'sol-send-unknown-title'), 'the pending headline is gone');
    assert(await absent(driver, 'btn-sol-send-check'), 'a settled send needs no re-read');
    const sigAfter = (await driver.readText('sol-send-signature')).trim();
    assert(sigAfter === sig, 'the SAME signature survives the flip — one payment, one reference');
    await driver.screenshot('202-send-terminal-settled');
    console.log('[202-send-terminal-sol] ✓ unknown → Check status → settled (signature kept)');

    // ── Leg B: the fee-only failure over an ACCEPTED broadcast ─────────────────────────────────
    console.log('[202-send-terminal-sol] leg B: failAfterHits: 0 → the send\'s own confirm reads the failure…');
    await driver.click('btn-sol-send-done', { timeoutMs: 4_000 });
    await armMode(relayBaseURL, { failAfterHits: 0 }); // replaces the mode; counter resets

    await driver.click('btn-pay-send', { timeoutMs: 5_000 });
    await driver.findByTestID('sol-send-address-input', { timeoutMs: 5_000 });
    await driver.type('sol-send-address-input', DEST_ADDR, { timeoutMs: 4_000 });
    await driver.type('sol-send-amount-input', '0.4', { timeoutMs: 4_000 });
    await driver.findByTestID('sol-send-review', { timeoutMs: 4_000 });
    await driver.click('btn-sol-send-confirm', { timeoutMs: 5_000 });

    // The first confirm poll answers the on-chain InstructionError: sendSol throws over the
    // ACCEPTED broadcast, and the terminal must name the fee-only truth — not pretend nothing
    // happened, and not claim the money is gone.
    assert(await driver.waitForText('only the network fee', { timeoutMs: 20_000 }),
      'the fee-only note renders over an accepted-then-failed broadcast');
    assert(await absent(driver, 'sol-send-nothing-sent'),
      'the nothing-sent line is ABSENT — the network ACCEPTED this transfer');
    assert(await absent(driver, 'sol-send-unknown-title'), 'a definitive failure is not a pending');
    assert((await driver.findByTestID('btn-sol-send-confirm', { timeoutMs: 4_000 })) != null,
      'the form returned — a NEW send is the user\'s own consent, never an automatic resend');
    await driver.screenshot('202-send-terminal-fee-note');
    console.log('[202-send-terminal-sol] ✓ fee-only failure: honest note, retry is explicit');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[202-send-terminal-sol] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[202-send-terminal-sol] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
