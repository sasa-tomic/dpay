/**
 * Flow 03 deposit-address — the jest twin of `e2e/tests/03-deposit-address.mjs`.
 *
 * A returning user (identity persisted) cold-loads `?screen=deposit` and lands directly on the
 * Receive tab's "My address" sub-mode for ckBTC: the per-account native address, the complete
 * decision-relevant instruction block (network "Bitcoin", asset "BTC", est. time, fee, min —
 * values from the REAL relay's deposit_info, never hardcoded), the honest watching cue, and the
 * "Already on the Internet Computer?" ICRC-1 receive section (own principal).
 */
import {describe, it, expect} from '@jest/globals';
import {
  accountOf, assertEq, assertIncludes, onboardWallet, railPrincipalText,
} from '../harness/lib';

describe('flow 03 — deposit address: address + complete instructions + ICRC-1 receive route', () => {
  it('?screen=deposit lands a returning user on the ckBTC deposit sheet', async () => {
    // 1. Onboard once so an identity is persisted (the deep link only seeds the Receive
    //    "My address" sub-mode for a RETURNING user — Onboarding never mounts the Wallet).
    const m = await onboardWallet('jest-deposit');

    // 2. Re-navigate with the deep link — remount WITHOUT clearing storage, URL set first
    //    (mountApp({url}) is exactly the cold-load contract; jest has no browser to navigate).
    await m.remount({url: '/?screen=deposit'});

    // 3. The deep link landed on the Receive "My address" sub-mode — the address is the gate.
    await m.driver.findByTestID('deposit-address', {timeoutMs: 10_000});
    const address = m.driver.readText('deposit-address');
    // The FakeLedger derives a recognizable `bc1qdpay<pubkey[:8] hex>` address.
    expect(address).toMatch(/^bc1qdpay[0-9a-f]{16}$/);

    // 4. The complete instruction block is present and correct (the heart of U1). Every value
    //    comes from deposit_info; the network/asset are single-sourced constants in App.tsx.
    const body = m.driver.bodyText();
    assertIncludes(body, 'Bitcoin', 'deposit instructions should include network name "Bitcoin"');
    assertIncludes(body, 'BTC', 'deposit instructions should include asset "BTC"');
    assertIncludes(body, 'confirmation', 'deposit instructions should include a confirmation estimate');
    assertIncludes(body, 'fee', 'deposit instructions should include a network fee line');
    assertIncludes(body, 'Min', 'deposit instructions should include a minimum deposit line');

    // C3: the INSTRUCTIONS block must NEVER render a raw "0.00000000". The FakeLedger/test minter
    // returns zero fee + zero min; the line shows "—" for a zero value. Scoped to the
    // deposit-instructions card (the wallet's zero-balance asset cards render behind the sheet).
    const instrTxt = m.driver.readText('deposit-instructions');
    expect(instrTxt.includes('0.00000000')).toBe(false);

    // 5. The single linear progress cue (U2): the honest balance-watching copy.
    assertIncludes(body, 'Watching for your deposit', 'progress cue shows the waiting state');

    // 6. ckBTC is ALSO receivable by plain ICRC-1 transfer — the sheet surfaces the
    //    "Already on the Internet Computer?" section with the wallet's own ICRC-1 account.
    await m.driver.findByTestID('ic-also-section', {timeoutMs: 5_000});
    const icTxt = m.driver.readText('ic-also-section');
    assertIncludes(icTxt, 'Already on the Internet Computer', 'IC-receive section is present');
    assertIncludes(icTxt, 'ckBTC', 'IC-receive section names the LEDGER token (ckBTC, not BTC)');
    const acct = await accountOf(m);
    assertEq(m.driver.readText('ic-also-address').trim(), await railPrincipalText(acct!.publicHex),
      'IC section shows the wallet\'s own ICRC-1 principal');

    await m.unmount();
  }, 90_000);
});
