// Flow 157 — a transaction row opens its RECEIPT (X6).
//
// Before this, every row in the wallet was dead: no press handler, no detail, no reference, no
// ledger id, no way to copy a proof. That is the merchant-reconciliation and dispute path, and it
// did not exist — a merchant who was paid could not show WHAT they were paid.
//
// The flow settles a REAL rail payment (a harness-side payer → the wallet, carrying a memo, through
// the fake-IC /api/v2 gateway) so every value the receipt claims came off a ledger rather than a
// fixture, and then drives the surface a merchant would:
//
//   (a) the row is pressable, and the receipt names the EXACT amount, the payer's FULL principal
//       (not the row's truncated label), the memo that is the payee's reconciliation key, and the
//       LEDGER BLOCK INDEX — the only stable identity an IC-rail row has, since its dpay nonce is
//       always empty (see `TxnRecord::block`, crates/dpay-relay/src/ledger/types.rs);
//   (b) the copy affordance really puts that proof on the clipboard — read back from the clipboard,
//       not inferred from a button label;
//   (c) a row the ledger recorded NO counterparty and NO memo for (the onboarding faucet MINT) says
//       so in a sentence instead of rendering two blank labelled rows, and shows no reference value;
//   (d) the Home activity feed opens the SAME receipt from its own row — one surface, both lists.
//
// Deliberately NOT asserted: a Solana receipt. That rail is exercised by the unit tests
// (app/__tests__/HistoryRow.test.tsx), and the offline suite has no Solana ledger to settle
// against — a stubbed signature here would prove less than the IC half already does.
import {
  setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, railTransfer,
  railPrincipalText,
} from '../harness/lib.mjs';
import { generateKeypair } from '../harness/wire.mjs';

export const meta = {
  id: '157',
  name: 'transaction-receipt',
  journey: 'system',
  covers: ['ledger', 'receipt', 'reconciliation', 'home-tab', 'activity-feed', 'honest-copy'],
  verifies: 'A transaction row opens a receipt carrying the exact amount, the counterparty\'s full account, the memo reference and the ledger block index, and copies all of it to the clipboard; a row whose ledger recorded no counterparty and no memo says so instead of rendering blank labelled fields; the Home feed opens the same receipt.',
  timeoutMs: 90000,
};

const MEMO_HEX = '9f2c00112233445566778899aabbccdd';

export async function run() {
  const start = Date.now();
  console.log('[157-transaction-receipt] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL, webBaseURL } = env;
    // The real clipboard write must be permitted, or `copyToClipboard` falls through to its Share
    // path and the observed call never happens.
    await driver.context.overridePermissions(new URL(webBaseURL).origin, ['clipboard-write']);

    console.log('[157-transaction-receipt] onboarding…');
    await onboardWallet(driver, 'e2e-receipt');
    const me = await accountOf(driver);
    const payer = await generateKeypair();
    const payerPrincipal = await railPrincipalText(payer.publicHex);
    const fund = await faucetAccount(relayBaseURL, payer.publicHex, 20000);
    assert(fund.ok, `payer faucet should succeed, got status ${fund.status}: ${JSON.stringify(fund.body)}`);
    const paid = await railTransfer(relayBaseURL, payer.secretHex, me.publicHex, 4200n, { memoHex: MEMO_HEX });
    assert(paid.ok === true && paid.status === 202, `the rail payment must be accepted (202), got ${JSON.stringify(paid)}`);
    console.log(`[157-transaction-receipt] ✓ ∂42.00 settled from ${payerPrincipal.slice(0, 12)}… with memo ${MEMO_HEX}`);

    // ---- (a) the row is pressable and the receipt states what the ledger recorded --------------
    await driver.click('tab-transactions', { timeoutMs: 5_000 });
    await driver.findByTestID('ledger-view', { timeoutMs: 5_000 });
    assert(await driver.waitForText('+∂42.00', { timeoutMs: 12_000 }), 'the settled payment should reach the Transactions tab');
    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });

    const amount = await driver.readText('txn-receipt-amount');
    assert(amount === '+∂42.00', `the receipt headline must be the EXACT amount, got ${JSON.stringify(amount)}`);
    const account = await driver.readText('txn-receipt-account');
    assert(account === payerPrincipal,
      `the receipt must carry the payer's FULL principal (${payerPrincipal}), got ${JSON.stringify(account)}`);
    const ref = await driver.readText('txn-receipt-ref');
    assert(ref === MEMO_HEX, `the reference must be the memo the payment carried, got ${JSON.stringify(ref)}`);
    const block = await driver.readText('txn-receipt-proof');
    assert(/^\d+$/.test(block), `the ledger block index must be a number, got ${JSON.stringify(block)}`);
    await driver.screenshot('157-transaction-receipt');
    console.log(`[157-transaction-receipt] ✓ receipt: +∂42.00 · ${account.slice(0, 12)}… · ref ${ref} · block ${block}`);

    // ---- (b) the proof really lands on the clipboard -------------------------------------------
    // Observed at the PLATFORM boundary: the app's real `copyToClipboard` runs untouched and we
    // record the bytes it hands `navigator.clipboard.writeText`, delegating to the original. A
    // readback is not available here — chrome-headless-shell resolves `writeText` and then reads
    // back an empty string (measured), because it has no system clipboard; asserting on that would
    // assert nothing. The wrapper is on the browser API, never on app code.
    await driver.eval(() => {
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      globalThis.__COPIED = null;
      navigator.clipboard.writeText = (t) => { globalThis.__COPIED = t; return real(t); };
    });
    await driver.click('btn-txn-receipt-copy', { timeoutMs: 5_000 });
    // The write is async (`copyToClipboard`), so wait for the button to CONFIRM it landed before
    // reading — checking on the click's own tick races the promise.
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="btn-txn-receipt-copy"]')?.textContent ?? '').includes('✓'),
      { timeoutMs: 5_000 },
    );
    const clip = await driver.eval(() => globalThis.__COPIED ?? '');
    assertIncludes(clip, '+∂42.00', 'the copied receipt carries the amount');
    assertIncludes(clip, payerPrincipal, 'the copied receipt carries the full payer account');
    assertIncludes(clip, MEMO_HEX, 'the copied receipt carries the reference');
    assertIncludes(clip, block, 'the copied receipt carries the ledger block index');
    console.log('[157-transaction-receipt] ✓ the copy affordance put the whole proof on the clipboard');

    // ---- (c) the row the ledger recorded nothing for SAYS so ----------------------------------
    // The onboarding faucet credit is a MINT: no sending account, no memo. Its receipt must carry
    // sentences in both slots, never two blank labelled rows — a blank in a dispute reads as a
    // value that failed to load.
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    await driver.click('hist-row-1', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    const mintAmount = await driver.readText('txn-receipt-amount');
    assert(mintAmount === '+∂100.00', `the mint row's receipt should show the faucet credit, got ${JSON.stringify(mintAmount)}`);
    const mintAccount = await driver.readText('txn-receipt-account');
    assert(mintAccount.length > 0 && !mintAccount.includes('-'),
      `a mint has no sending account — the receipt must say so, got ${JSON.stringify(mintAccount)}`);
    assertIncludes(mintAccount, 'no account', 'the empty-counterparty slot names what is missing');
    const mintRef = await driver.readText('txn-receipt-ref');
    assertIncludes(mintRef, 'carried no memo', 'the empty-memo slot names what is missing');
    const mintBlock = await driver.readText('txn-receipt-proof');
    assert(/^\d+$/.test(mintBlock), `the mint still has a ledger block, got ${JSON.stringify(mintBlock)}`);
    await driver.screenshot('157-transaction-receipt-absent-fields');
    console.log('[157-transaction-receipt] ✓ absent fields read as sentences, and the block is still there');

    // ---- (d) the Home feed opens the SAME receipt ---------------------------------------------
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-activity', { timeoutMs: 5_000 });
    await driver.click('home-hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertEqText(await driver.readText('txn-receipt-account'), payerPrincipal,
      'the Home feed opens the same receipt for the same row');
    console.log('[157-transaction-receipt] ✓ the Home activity feed opens the identical receipt');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[157-transaction-receipt] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEqText(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[157-transaction-receipt] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
