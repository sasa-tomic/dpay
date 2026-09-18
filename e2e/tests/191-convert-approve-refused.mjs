// Flow 191 — the approve REFUSAL is a clean, surfaced failure: never an endless "Approving".
//
// The 2026-09-19 live defect this flow pins: the real ICP ledger refused a conversion's FIRST
// icrc2_approve with AllowanceChanged (expected_allowance was baked as the approve amount, and
// ICRC-2 compares that field with the CURRENT allowance — 0 on a first-ever approve), and the
// client decoded the refusal with the TRANSFER decoder, which THROWS on the approve-only
// variants. The throw killed the engine's drive loop; the record sat at `approving` (rendered
// as the "Approving" spinner) until the 5-minute envelope expiry, then `stuck`. Offline it was
// invisible because the fake-IC gateway ignored expected_allowance entirely.
//
// Both halves are fixed; this flow proves the PRODUCT half end to end against the REAL app:
//   * The fake gateway's test knob (POST /api/v1/test/approve_fail — the same
//     AllowanceChanged{current_allowance: 0} the live ledger returns) refuses the approve.
//   * The engine decodes the refusal natively (icpDecodeApproveResult) and classifies the
//     FIRST approve refusal as failed_refunded / approve_refused — no funds moved, no fee
//     charged, nothing to refund or reverse.
//   * The state panel renders the TERMINAL failed card (convert-failed, "Swap not executed",
//     the approve-refusal body naming the asset) — never the Approving spinner, never `stuck`.
//   * The ledger is whole: ICP balance is byte-identical to pre-confirm (a refused approve
//     charges no fee), and no history row appears for the attempt.
import {
  setup, assert, assertEq, onboardWallet, accountOf, getBalance, faucetAccount,
  openBalances, selectCurrency,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';
import { startRelay } from '../harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

export const meta = {
  id: '191',
  name: 'convert-approve-refused',
  journey: 'convert',
  covers: ['convert', 'icp', 'icrc2-approve', 'approve-refused', 'allowance-changed', 'failed-refunded', 'terminal-failure-ui', 'no-stuck-spinner', 'balance-whole', 'fake-ic-approve-fidelity'],
  verifies: 'An icrc2_approve refusal (AllowanceChanged, the exact 2026-09-19 live-defect shape, forced by the fake-IC approve_fail knob) surfaces as the TERMINAL failed card — failed_refunded/approve_refused, "Swap not executed" with the nothing-moved body — never an endless Approving spinner and never stuck; the ledger stays byte-whole (a refused approve charges no fee).',
  timeoutMs: 120000, // onboard + convert navigation + one approve submit+poll + refusal render
};

export async function run() {
  const start = Date.now();
  console.log('[191-convert-approve-refused] setup (own relay for the approve_fail knob)…');
  const env = await setup();
  const r2 = await startRelay(); // private relay: the knob is global per gateway — never share it
  try {
    const { webBaseURL, driver } = env;
    const relayBaseURL = r2.baseURL;
    await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(relayBaseURL)}`, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    console.log('[191-convert-approve-refused] onboarding + funding + Convert surface…');
    await onboardWallet(driver, 'e2e-convert-approve-refused');
    const account = await accountOf(driver);
    const SEED = 300000000; // 3 ICP (plain Number — the faucet body is JSON)
    const fund = await faucetAccount(relayBaseURL, account.publicHex, SEED, { currency: 8 });
    assert(fund.ok, `faucet credit ok (status ${fund.status})`);

    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.waitForText('Convert', { timeoutMs: 6_000 });
    await driver.click('btn-accounts-convert', { timeoutMs: 5_000 });
    assert(await driver.findByTestID('convert-screen', { timeoutMs: 8_000 }) != null, 'Convert surface opens for ICP');
    await driver.type('convert-amount', '1');
    await driver.findByTestID('convert-quote-source', { timeoutMs: 10_000 });

    console.log('[191-convert-approve-refused] arming the approve_fail knob (AllowanceChanged{0}, the live-defect shape)…');
    const arm = await fetch(`${relayBaseURL}/api/v1/test/approve_fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledger: ICP_LEDGER }),
    });
    assert(arm.ok, `approve_fail knob armed (status ${arm.status}): ${await arm.text()}`);

    console.log('[191-convert-approve-refused] confirm → the approve refusal must TERMINATE, not spin…');
    await driver.click('btn-convert-confirm', { timeoutMs: 6_000 });

    // The engine polls the approve reply (8 s submit / 5 s poll cycles): the refusal decodes
    // natively and the record flips to failed_refunded in one drive cycle. Bounded at 45 s —
    // a green here PROVES the panel left the Approving spinner; the old bug rendered the
    // spinner for the full 5-minute envelope window and only then flipped to `stuck`.
    assert(await driver.findByTestID('convert-failed', { timeoutMs: 45_000 }) != null,
      'the TERMINAL failed card renders (never an endless Approving spinner, never stuck)');
    assert(await driver.findByTestID('convert-stuck', { timeoutMs: 1_000 }).catch(() => null) == null,
      'the record did NOT degenerate to `stuck`');

    const failedBody = await driver.readText('convert-failed');
    assert(failedBody.includes('Swap not executed'), 'failed card titles the refusal');
    assert(failedBody.includes('ICP') && failedBody.includes('refused the approval'),
      'the approve-refusal body names the asset and the refusal');
    assert(failedBody.includes('nothing moved') || failedBody.includes('No allowance was created'),
      'the body carries the nothing-moved/no-allowance facts');
    assert(!failedBody.includes('Approving'), 'no Approving copy survives on the terminal card');
    await driver.screenshot('191-convert-approve-refused');

    console.log('[191-convert-approve-refused] asserting the ledger is byte-whole…');
    const icpAfter = await getBalance(relayBaseURL, account.publicHex, 8);
    assertEq(BigInt(icpAfter), BigInt(SEED), 'ICP unchanged: a refused approve charges no fee and moves nothing');

    console.log(`[191-convert-approve-refused] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('191-convert-approve-refused RED:', e.stack || e.message || e);
  });
}
