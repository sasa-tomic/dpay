// Flow 103 — a payment link this wallet cannot pay is REFUSED with a usable instruction.
//
// Founder hard rule (2026-08-29): the user must be given useful practical instructions on every
// step, especially the error path. A link is the one surface where a stranger controls the input,
// so it is where a wallet is most tempted to either guess (pay a same-named asset on the wrong
// chain — unrecoverable) or shrug (a blank screen the payer can do nothing about). This flow pins
// the opposite behaviour for the three refusals a real user will actually hit.
//
// Each leg opens a real link in the browser and asserts the refusal names what was asked for AND
// what to do next:
//   1. WRONG CHAIN — `asset=ckUSDC&network=solana`. The wallet DOES hold ckUSDC, just on the
//      Internet Computer, so this is the dangerous case: the token name matches something real and
//      only the chain is wrong. dpay never swaps and never substitutes a chain, so it must refuse
//      rather than quietly pay the IC row — this is the failure the required `network` parameter
//      exists to prevent.
//   2. UNKNOWN ASSET — `asset=ckDOGE`. Nothing in the catalog: say so and tell the payer to ask
//      for a link in an asset they hold.
//   3. MALFORMED — no `amount`. The link is damaged; name the missing part so the payer can ask
//      the sender for a new one.
//
// In every leg the payer must be left with a dismissible explanation and NO payment surface —
// never a pre-filled review of a payment the wallet does not actually understand.
//
// Selector contract: `pay-link-error`, `pay-link-error-body`, `btn-pay-link-error-close`,
// `btn-start-scan` (the normal Pay surface the wallet returns to).
import {setup, assert, assertIncludes, onboardWallet} from '../harness/lib.mjs';

export const meta = {
  id: '103',
  name: 'pay-link-refused',
  journey: 'pay',
  covers: ['pay-link', 'fail-closed', 'wrong-network', 'honest-instructions'],
  verifies: 'A payment link naming the wrong chain, an unknown asset, or a damaged field is refused with an instruction the payer can act on — never a guessed asset and never a silent dead end.',
  timeoutMs: 90000,
};

const PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai'; // a real, CRC-valid IC principal

export async function run() {
  const start = Date.now();
  console.log('[103-pay-link-refused] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL, webBaseURL} = env;

    console.log('[103-pay-link-refused] onboarding…');
    await onboardWallet(driver, 'e2e-link-refused');

    const open = async (query) => {
      await driver.navigate(webBaseURL, `/wallet/pay/${PRINCIPAL}?${query}&relay=${encodeURIComponent(relayBaseURL)}`,
        {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
      await driver.waitReady({timeoutMs: 10_000});
      await driver.findByTestID('pay-link-error', {timeoutMs: 8_000});
      return await driver.readText('pay-link-error-body');
    };

    // 1. WRONG CHAIN — the exact confusion the required `network` parameter exists to prevent. The
    //    wallet holds this very token on ANOTHER chain, so a wallet that ignored `network` would
    //    happily pay the wrong one; the money would be unrecoverable.
    let body = await open('asset=ckUSDC&network=solana&amount=1');
    assertIncludes(body, 'ckUSDC', 'the refusal must name the asset the link asked for');
    assertIncludes(body, 'Solana', 'the refusal must name the chain the link asked for');
    assertIncludes(body, 'different network', 'the refusal must say the wallet holds it on another chain');
    assertIncludes(body, 'wrong chain', 'the refusal must state the consequence of guessing');
    assertIncludes(body, 'Ask the sender', 'the refusal must tell the payer what to do next');
    // No payment surface may be rendered behind it — nothing about this link was understood.
    assert(!(await driver.isPresent('pay-amount')), 'a refused link must not render a payment review');
    assert(!(await driver.isPresent('btn-approve')), 'a refused link must not render an Approve button');
    console.log(`[103-pay-link-refused] ✓ wrong chain refused: ${body.slice(0, 90)}…`);

    // Dismissing returns the payer to the normal Pay surface — the refusal is not a trap.
    await driver.click('btn-pay-link-error-close', {timeoutMs: 5_000});
    await driver.waitGone('pay-link-error', {timeoutMs: 5_000});
    await driver.findByTestID('btn-start-scan', {timeoutMs: 5_000});
    console.log('[103-pay-link-refused] ✓ dismissing lands on the normal Pay screen');

    // 2. UNKNOWN ASSET — not in the catalog at all. dpay never swaps, so there is no fallback to
    //    offer; the honest instruction is to ask for a link in an asset the payer holds.
    body = await open('asset=ckDOGE&network=internet-computer&amount=1');
    assertIncludes(body, 'ckDOGE', 'the refusal must name the unknown asset verbatim');
    assertIncludes(body, 'never swaps', 'the refusal must state why no substitute is offered');
    console.log(`[103-pay-link-refused] ✓ unknown asset refused: ${body.slice(0, 90)}…`);

    // 3. MALFORMED — a link with no amount. Naming the missing part is what lets the payer ask the
    //    sender for a correct link instead of guessing.
    body = await open('asset=DEMO&network=internet-computer');
    assertIncludes(body, 'the amount', 'the refusal must name the missing part of the link');
    assertIncludes(body, 'new link', 'the refusal must tell the payer to ask for a new link');
    console.log(`[103-pay-link-refused] ✓ malformed link refused: ${body.slice(0, 90)}…`);

    await driver.screenshot('103-pay-link-refused');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[103-pay-link-refused] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[103-pay-link-refused] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
