// Flow 201 — the send terminal, IC rail (2026-09 stream D): ONE surface both send rails end on.
//
// SendSheet routes its endings through the shared `SendTerminal` (app/components/SendTerminal.tsx).
// This flow pins both terminal stories on the IC rail, end to end through the REAL app + fake-IC
// gateway, extending the 104-107 send pattern:
//
//   Leg 1 — SETTLED: confirm a real icrc1_transfer, the terminal shows the check, the headline,
//   the amount, the FULL destination, the LEDGER BLOCK INDEX as the reference (copyable), and the
//   receipt affordance. View receipt opens the SAME `TxnReceipt` the History rows open (mounted
//   at the Wallet root): the block index rides as its PROOF and no "not confirmed yet" status
//   line exists — a settled receipt never hedges.
//
//   Leg 2 — the DEADLINE-FORCED UNKNOWN: the `ic_delay` knob (POST /api/v1/test/ic_delay, flow
//   192's pattern, own relay — the knob is global per gateway) holds the transfer's reply out of
//   every read_state cert for 12 s while the sheet's poll budget is 6 s. The send becomes the
//   honest pending: clock glyph, the may-still-land body, the FRESH MEMO HEX as the reference
//   (the handle the ledger will carry), the pending receipt (a "not confirmed yet" STATUS line,
//   and NO proof — a pending row has none), and — THE INVARIANT — no resend invite and no Check
//   status (IC cannot re-read a pending transfer; SOL's terminal can). The form never returns:
//   a retry over a signed send would be a second, independent transfer.
//
// Selector contract: 104's (`send-outcome`, `send-destination`, `btn-send-done`, `send-ref`) plus
// the terminal grammar — `send-unknown-title`, `send-unknown-note`, `btn-send-copy`,
// `btn-send-receipt`, `btn-send-check` (absent on IC), and the receipt's own `txn-receipt`,
// `txn-receipt-proof`, `txn-receipt-status`.
import {
  setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, openPaySend, railPrincipalText,
} from '../harness/lib.mjs';
import { startRelay } from '../harness/relay.mjs';

const CURRENCY = 7;        // VCHF — a complete no-minter direct-ICRC row
const ASSET_KEY = 'vchf';
const SEED = 500_000_000;  // 5.00000000 VCHF

const RECIPIENT_PUBKEY = 'c'.repeat(64); // a second wallet's pubkey — a REAL external destination

export const meta = {
  id: '201',
  name: 'send-terminal-ic',
  journey: 'withdraw',
  covers: ['send-terminal', 'send-receipt', 'honest-unknown', 'ic-delay-knob', 'vchf', 'direct-icrc', 'no-resend-invite'],
  verifies: 'The IC send ends on the shared SendTerminal: a settled transfer shows the block index as a copyable reference and opens the Wallet-root TxnReceipt with it as the proof; a deadline-forced unknown shows the honest pending (memo-hex reference, pending receipt, no resend invite, no Check status on the rail that cannot re-read).',
  timeoutMs: 150000,
};

export async function run() {
  const start = Date.now();

  // ── Leg 1: settled — the terminal and its receipt, on the shared relay ──────────────────────
  console.log('[201-send-terminal-ic] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;
    await onboardWallet(driver, 'e2e-send-term');
    const accountHex = (await accountOf(driver)).publicHex;
    const recipientPrincipal = await railPrincipalText(RECIPIENT_PUBKEY);

    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);
    await openBalances(driver);
    await driver.waitForText('5.00 VCHF', { timeoutMs: 8_000 });
    await selectCurrency(driver, ASSET_KEY);
    await openPaySend(driver);
    await driver.type('send-address-input', recipientPrincipal, { timeoutMs: 4_000 });
    await driver.findByTestID('send-status', { timeoutMs: 5_000 });
    await driver.type('send-amount-input', '1.25000000', { timeoutMs: 4_000 });

    console.log('[201-send-terminal-ic] confirm → the settled terminal…');
    await driver.click('btn-send-confirm', { timeoutMs: 5_000 });
    assert(await driver.waitForText('Sent', { timeoutMs: 15_000 }), 'the settled terminal shows the Sent headline');
    const shownDest = await driver.readText('send-destination');
    assertEq(shownDest, recipientPrincipal, 'the terminal shows the FULL destination');
    const blockRef = (await driver.readText('send-ref')).trim();
    assert(/^\d+$/.test(blockRef), `the settled reference is the LEDGER BLOCK INDEX, got "${blockRef}"`);
    assert((await driver.findByTestID('btn-send-copy', { timeoutMs: 4_000 })) != null, 'the reference is copyable');
    assert((await driver.findByTestID('btn-send-check', { timeoutMs: 1_000 }).catch(() => null)) == null,
      'IC offers NO Check status — this rail cannot re-read a pending transfer');

    // View receipt → the SAME TxnReceipt the History rows open, with the block index as PROOF.
    await driver.click('btn-send-receipt', { timeoutMs: 4_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    const proof = await driver.readText('txn-receipt-proof');
    assertIncludes(proof, blockRef, `the receipt's proof IS the terminal's block index (${blockRef})`);
    assert((await driver.findByTestID('txn-receipt-status', { timeoutMs: 1_000 }).catch(() => null)) == null,
      'a settled receipt carries NO "not confirmed yet" status line');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    await driver.screenshot('201-send-terminal-settled');
    console.log('[201-send-terminal-ic] ✓ settled terminal + receipt (block index as proof)');

    // ── Leg 2: the deadline-forced unknown — own relay, the ic_delay knob is global per gateway ──
    console.log('[201-send-terminal-ic] leg 2: own relay + ic_delay 12 s vs the 6 s poll budget…');
    const r2 = await startRelay();
    try {
      await driver.navigate(
        env.webBaseURL,
        `/?relay=${encodeURIComponent(r2.baseURL)}`,
        { waitUntil: 'domcontentloaded', timeoutMs: 8_000 },
      );
      await driver.waitReady({ timeoutMs: 8_000 });
      await onboardWallet(driver, 'e2e-send-term-2');
      const account2 = (await accountOf(driver)).publicHex;
      const fund2 = await faucetAccount(r2.baseURL, account2, SEED, { currency: CURRENCY });
      assert(fund2.ok, `private-relay funding must succeed, got HTTP ${fund2.status}`);

      const arm = await fetch(`${r2.baseURL}/api/v1/test/ic_delay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'icrc1_transfer', ms: 12000 }),
      });
      assert(arm.ok, `ic_delay knob armed (status ${arm.status}): ${await arm.text()}`);

      await openBalances(driver);
      await selectCurrency(driver, ASSET_KEY);
      await openPaySend(driver);
      await driver.type('send-address-input', recipientPrincipal, { timeoutMs: 4_000 });
      await driver.findByTestID('send-status', { timeoutMs: 5_000 });
      await driver.type('send-amount-input', '1.00000000', { timeoutMs: 4_000 });
      await driver.click('btn-send-confirm', { timeoutMs: 5_000 });

      // The poll budget (12 × 500 ms) exhausts long before the 12 s reply becomes visible — the
      // HONEST pending, never a failure and never a spinner.
      assert(await driver.waitForText('may still', { timeoutMs: 20_000 }),
        'the unknown terminal renders (the transfer may still execute)');
      assert((await driver.findByTestID('send-unknown-note', { timeoutMs: 4_000 })) != null,
        'the pending body names the next step');
      const memoRef = (await driver.readText('send-ref')).trim();
      assert(/^[0-9a-f]{32}$/.test(memoRef), `the unknown reference is the FRESH MEMO HEX, got "${memoRef}"`);
      assert((await driver.findByTestID('btn-send-confirm', { timeoutMs: 1_000 }).catch(() => null)) == null,
        'THE INVARIANT: no resend control over a signed send');
      assert((await driver.findByTestID('send-nothing-sent', { timeoutMs: 1_000 }).catch(() => null)) == null,
        'the honest pending never claims nothing-was-sent — the envelope IS out');

      // The pending receipt: a "not confirmed yet" STATUS line, and NO proof (a pending row has none).
      await driver.click('btn-send-receipt', { timeoutMs: 4_000 });
      await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
      const status = await driver.readText('txn-receipt-status');
      assert(/not confirmed|pending/i.test(status), `the pending receipt says so, got "${status}"`);
      assert((await driver.findByTestID('txn-receipt-proof', { timeoutMs: 1_000 }).catch(() => null)) == null,
        'a pending receipt shows NO proof — there is none yet');
      await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
      await driver.screenshot('201-send-terminal-unknown');

      const disarm = await fetch(`${r2.baseURL}/api/v1/test/ic_delay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'icrc1_transfer', ms: 0 }),
      });
      assert(disarm.ok, 'the knob disarms for teardown');
      console.log('[201-send-terminal-ic] ✓ deadline-forced unknown: honest pending, no resend invite');
    } finally {
      // The leg's page polls balances every 2.5s; close it BEFORE killing r2 so the
      // shutdown window can't record that poll as an unexpected connection failure.
      await driver.close();
      await r2.stop();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[201-send-terminal-ic] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[201-send-terminal-ic] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
