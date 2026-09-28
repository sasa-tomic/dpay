/**
 * Flows 24 + 55 + 57 + 63 + 64 + 69 + 71 — wallet-cleanup, balances selection, seed backup, the
 * asset picker, Settings restore, Solana-USDC selection and the selection lock — the jest twins of
 * the e2e tests of the same names. (sol-pay-gate.test.ts / trust-fund-sheets.test.tsx pin pieces;
 * these port the live walks.)
 *
 * 24 (H1/H2/H3): header shows only the username; accounts rows name the CURRENCY first with the
 *     rail subtitle; a currency-1 (ckBTC) transfer lands in history and names the counterparty as
 *     a SHORT principal prefix — never the full identifier, never raw hex.
 * 55: the header chip headlines the MAIN currency; currency-row taps set main; the unfunded BTC
 *     row states its zero; the SOL figure renders "—" with the rail asleep.
 * 57: the seed lives behind the confirm gate — mnemonic words revealed by default, hex behind the
 *     toggle, both copy paths captured by the clipboard seam, hex equal to identity.secretHex.
 * 63: the Receive picker lists the SOL row; picking it switches the working rail (SolReceiveMode
 *     mounts) while the chip keeps the main currency.
 * 64: Settings → Restore — same seed (identity byte-identical, username preserved), the backup
 *     words (round-trip), and a different seed (new key, username STILL preserved).
 * 69: unified selection across protocols — both Receive forms share one complete picker list;
 *     crossing IC↔Solana clears the typed amount, symmetrically.
 * 71: a blocked-insufficient review LOCKS the selection — the account chip is disabled and a
 *     no-op; leaving the review unmounts the engine and releases the lock.
 */
import {describe, it, expect} from '@jest/globals';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from './solStub';
import {mountApp} from '../harness/mount';
import {
  accountOf, armPayScan, assertDisabled, assertEq, assertIncludes, DpayCore, faucetAccount,
  generateKeypair, goOffline, onboardWallet, openBalances, railPrincipalText, railTransfer,
  selectCurrency, selectSolRail, setRelay, waitForEnabled, waitForWallet,
} from '../harness/lib';
import {freshContext} from '../onboard/helpers';

const g = globalThis as unknown as Record<string, unknown>;

describe('flow 24 — wallet-cleanup', () => {
  it('username-only header; currency-first rows; a currency-1 payment lands in history with a SHORT principal counterparty', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-alice');
    const identity = await accountOf(m);
    const accountHex = identity?.publicHex ?? '';
    expect(accountHex).toHaveLength(64);
    expect(identity?.secretHex).toHaveLength(64);

    // H4: the header shows ONLY the username.
    const whoText = m.driver.readText('header-who');
    assertEq(whoText, 'e2e-alice', 'header who line');
    expect(whoText.includes(accountHex.slice(0, 8))).toBe(false);

    // H1: rows lead with the CURRENCY name; the ckUSDC rail lives in the subtitle.
    await openBalances(m);
    const ckusdcTxt = m.driver.readText('accounts-currency-USD');
    assertIncludes(ckusdcTxt, 'USDC', 'the USD row is labeled USDC');
    assertIncludes(ckusdcTxt, 'US dollars', 'the USD currency row names the CURRENCY');
    assertIncludes(ckusdcTxt, 'ckUSDC · Internet Computer', 'the USD row names its ckUSDC rail in the subtitle');
    const ckbtcTxt = m.driver.readText('accounts-currency-BTC');
    assertIncludes(ckbtcTxt, 'Bitcoin', 'the BTC row is labeled with the currency name');

    // H2: fund A with ckBTC via the rail faucet, then settle a currency-1 transfer A → B.
    const seeded = await faucetAccount(accountHex, 60_000, {currency: 1});
    expect(seeded.ok).toBe(true);
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const pay = await railTransfer(identity!.secretHex, bob.publicHex, BigInt(50_000), {currency: 1});
    expect({ok: pay.ok, status: pay.status}).toEqual({ok: true, status: 202});

    // H2/H3: RECENT renders the currency-1 transfer; the counterparty is a SHORT principal prefix.
    await m.driver.click('tab-transactions', {timeoutMs: 4000});
    expect(await m.driver.waitForText('Recent', {timeoutMs: 8000})).toBe(true);
    expect(await m.driver.waitForText(bobPrincipal.slice(0, 8), {timeoutMs: 8000})).toBe(true);
    const histBody = m.driver.bodyText();
    expect(histBody.includes(bobPrincipal)).toBe(false);   // never the full principal text
    expect(histBody.includes(bob.publicHex)).toBe(false);  // never the raw hex pubkey

    await m.unmount();
  }, 150_000);
});

describe('flow 55 — balances-select-asset', () => {
  it('the chip headlines the MAIN currency; row taps set main; the unfunded BTC row states its zero', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-select');

    // Baseline: the chip headlines the MAIN currency, never the practice rail.
    assertEq(m.driver.readText('active-asset-label'), 'Balance CHF', 'baseline chip: the MAIN currency');

    // The ckBTC currency row tap — the set-main gesture; the chip follows.
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');
    assertEq(m.driver.readText('active-asset-label'), 'Balance BTC', 'chip after the ckBTC row tap');

    // The BTC currency row states its unfunded zero in its rail's token unit.
    await openBalances(m);
    assertIncludes(m.driver.readText('accounts-currency-BTC'), '0 BTC', 'the BTC row shows the unfunded 0');

    // SOL via its currency row; the chip follows; the header figure is "—" (RPC disabled).
    await selectCurrency(m, 'sol');
    assertEq(m.driver.readText('active-asset-label'), 'Balance SOL', 'chip after the SOL row tap');
    assertIncludes(m.driver.readText('balance'), '—', 'header figure after selecting SOL (RPC asleep → "—")');

    await m.unmount();
  }, 120_000);
});

describe('flow 57 — settings-seed-backup', () => {
  it('the seed lives behind the confirm gate; words by default; hex behind the toggle; both copy paths work', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-seed');
    const identity = await accountOf(m);
    const secretHex = identity?.secretHex ?? '';
    expect(secretHex.length > 0).toBe(true);

    await m.driver.click('btn-settings', {timeoutMs: 5000});
    await m.driver.click('btn-advanced-toggle', {timeoutMs: 5000});
    await m.driver.findByTestID('settings-relay', {timeoutMs: 5000});

    // The Backup entry is present; the seed is NOT (it lives behind the confirm gate).
    await m.driver.findByTestID('btn-backup', {timeoutMs: 5000});
    expect(m.driver.isPresent('seed-phrase')).toBe(false);
    expect(m.driver.isPresent('mnemonic-words')).toBe(false);

    // The confirm gate: warning + confirm; the seed still hidden.
    await m.driver.click('btn-backup', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-backup-confirm', {timeoutMs: 5000});
    expect(m.driver.isPresent('seed-phrase')).toBe(false);

    // Confirm → the mnemonic words are revealed by DEFAULT; hex stays behind the toggle.
    await m.driver.click('btn-backup-confirm', {timeoutMs: 5000});
    await m.driver.findByTestID('mnemonic-words', {timeoutMs: 5000});
    expect(m.driver.readText('mnemonic-word-0').replace(/^\d+\s*/, '').length > 0).toBe(true);
    expect(m.driver.isPresent('seed-phrase')).toBe(false);

    // Copy the words → the clipboard seam captures 24 space-separated words. (jest has no
    // navigator.clipboard, so the copy takes the Share path — the button honestly says
    // 'Shared ✓' there; the captured BYTES are the assertion.)
    g.__DPAY_TEST_CLIPBOARD = '';
    await m.driver.click('btn-copy-mnemonic', {timeoutMs: 5000});
    let wordsClip = '';
    for (let i = 0; i < 80 && wordsClip === ''; i++) {
      wordsClip = String(g.__DPAY_TEST_CLIPBOARD ?? '');
      if (wordsClip === '') await new Promise((r) => setTimeout(r, 50));
    }
    expect(wordsClip.split(' ')).toHaveLength(24);

    // Toggle to hex view → the revealed seed equals identity.secretHex EXACTLY.
    await m.driver.click('btn-backup-show-hex', {timeoutMs: 5000});
    await m.driver.findByTestID('seed-phrase', {timeoutMs: 5000});
    assertEq(m.driver.readText('seed-phrase'), secretHex, 'revealed seed-phrase equals identity.secretHex');

    // Copy the hex seed → the clipboard holds the EXACT seed.
    await m.driver.click('btn-copy-seed', {timeoutMs: 5000});
    let hexClip = '';
    for (let i = 0; i < 80 && hexClip === ''; i++) {
      hexClip = String(g.__DPAY_TEST_CLIPBOARD ?? '');
      if (hexClip !== secretHex) { hexClip = ''; await new Promise((r) => setTimeout(r, 50)); }
    }
    expect(hexClip).toBe(secretHex);

    await m.unmount();
  }, 120_000);
});

describe('flow 63 — picker-sol-rail', () => {
  it('the Receive picker lists SOL; picking it switches the working rail while the chip keeps main', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-picker-sol');

    assertEq(m.driver.readText('active-asset-label'), 'Balance CHF', 'baseline chip: the MAIN currency');
    await m.driver.click('tab-receive', {timeoutMs: 4000});
    await m.driver.findByTestID('req-prefix', {timeoutMs: 4000});
    await m.driver.click('req-prefix', {timeoutMs: 4000});
    await m.driver.findByTestID('req-pick-sol', {timeoutMs: 4000});
    await m.driver.click('req-pick-sol', {timeoutMs: 5000});

    // The picker pick moves the WORKING rail — the chip keeps the main currency.
    assertEq(m.driver.readText('active-asset-label'), 'Balance CHF', 'the chip keeps the main currency');
    // SolReceiveMode mounted — its amount input is the active surface.
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 8000});

    await m.unmount();
  }, 120_000);
});

describe('flow 64 — settings-restore', () => {
  it('same-seed restore is byte-identical; the backup words round-trip; a different seed replaces the key but keeps the username', async () => {
    await freshContext();
    const SEED_B = '33'.repeat(32);
    const m = await onboardWallet('alice');
    const idA = await accountOf(m);
    const seedA = idA!.secretHex;
    const pubA = idA!.publicHex;

    // A restore REPLACES the identity, which closes the sheet asynchronously — settle that (wait
    // for it to close; close it by hand if it lingers) so each phase opens a FRESH sheet with its
    // entry buttons, never a consumed form. Without this, find-then-click races the close.
    const settleSheet = async (): Promise<void> => {
      const closed = await m.driver.waitForFunction(
        () => !m.driver.isPresent('btn-settings-close'),
        {timeoutMs: 3000},
      ).then(() => true).catch(() => false);
      if (!closed && m.driver.isPresent('btn-settings-close')) {
        await m.driver.click('btn-settings-close', {timeoutMs: 4000});
        await m.driver.waitGone('btn-settings-close', {timeoutMs: 4000});
      }
      await m.driver.waitGone('settings-restore-seed-input', {timeoutMs: 4000}).catch(() => {});
    };
    const openRestoreForm = async (): Promise<void> => {
      await settleSheet();
      await m.driver.click('btn-settings', {timeoutMs: 8000});
      await m.driver.click('btn-settings-restore', {timeoutMs: 8000});
      await m.driver.findByTestID('settings-restore-seed-input', {timeoutMs: 8000});
    };

    // Same-seed restore via Settings → Restore.
    await openRestoreForm();
    await m.driver.type('settings-restore-seed-input', seedA, {timeoutMs: 5000});
    await m.driver.click('btn-settings-restore-confirm', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 10_000});
    const afterSame = await accountOf(m);
    assertEq(afterSame!.secretHex, seedA, "same-seed restore: secretHex equals A's seed");
    assertEq(afterSame!.publicHex, pubA, 'same-seed restore: publicHex unchanged (deterministic derivation)');
    assertEq(afterSame!.username, 'alice', 'same-seed restore: username preserved');

    // Words restore: read A's 24 words from Backup, restore with THEM.
    await settleSheet();
    await m.driver.click('btn-settings', {timeoutMs: 8000});
    await m.driver.click('btn-backup', {timeoutMs: 8000});
    await m.driver.click('btn-backup-confirm', {timeoutMs: 5000});
    await m.driver.findByTestID('mnemonic-words', {timeoutMs: 5000});
    const wordsA: string[] = [];
    for (let i = 0; i < 24; i++) {
      wordsA.push(m.driver.readText(`mnemonic-word-${i}`).replace(/^\d+\s*/, '').trim());
    }
    expect(wordsA.every((w) => w.length > 0)).toBe(true);
    await openRestoreForm();
    await m.driver.type('settings-restore-seed-input', wordsA.join(' '), {timeoutMs: 5000});
    await m.driver.click('btn-settings-restore-confirm', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 10_000});
    const afterWords = await accountOf(m);
    assertEq(afterWords!.secretHex, seedA, "words restore: secretHex round-trips to A's seed");
    assertEq(afterWords!.publicHex, pubA, 'words restore: publicHex equals A');
    assertEq(afterWords!.username, 'alice', 'words restore: username preserved');

    // Different-seed restore: a NEW key, the username STILL preserved.
    await openRestoreForm();
    await m.driver.type('settings-restore-seed-input', SEED_B, {timeoutMs: 5000});
    await m.driver.click('btn-settings-restore-confirm', {timeoutMs: 5000});
    await waitForWallet(m, {timeoutMs: 10_000});
    const idB = await accountOf(m);
    assertEq(idB!.secretHex, SEED_B, 'different-seed restore: secretHex equals the entered seed B');
    expect(/^[0-9a-f]{64}$/.test(idB!.publicHex) && idB.publicHex !== pubA).toBe(true);
    assertEq(idB!.username, 'alice', 'different-seed restore: username STILL preserved');
    assertEq(m.driver.readText('header-who'), 'alice', 'the header shows the preserved username');

    await m.unmount();
  }, 180_000);
});

describe('flow 69 — sol-usdc-selection', () => {
  it('one complete picker list on both rails; crossing IC↔Solana clears the typed amount, symmetrically', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-usdc-x');
    g.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p, {lamports: 5000000000, token: null}),
      getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'sig_unused',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
      getAccountInfo: () => ({value: null}),
      getBalance: () => ({value: 5000000000}),
    };

    // Select IC USDC via Balances.
    await waitForWallet(m, {timeoutMs: 8000});
    await openBalances(m, {timeoutMs: 5000});
    await selectCurrency(m, 'ckusdc', {timeoutMs: 5000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});

    // ReceiveMode (IC rail) mounted; type an amount + memo to prove they clear on a rail switch.
    await m.driver.findByTestID('req-prefix', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('req-prefix'), '$', 'the IC USDC prefix shows the $ glyph');
    await m.driver.type('amount-input', '5', {timeoutMs: 5000});
    await m.driver.type('memo-input', 'secret-memo', {timeoutMs: 5000});

    // The IC picker lists IC + Solana rows — the SAME complete list.
    await m.driver.click('req-prefix', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-ckusdc', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-sol', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-sol-usdc', {timeoutMs: 5000});

    // Switch to Solana USDC → SolReceiveMode mounts fresh, amount EMPTY.
    await m.driver.click('req-pick-sol-usdc', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-req-amount-input', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('sol-req-prefix'), '$', 'the Solana USDC prefix shows the $ glyph');
    assertEq(m.driver.readInputValue('sol-req-amount-input'), '', 'the amount did not survive the rail flip');

    // The Solana picker opens the SAME list; switch back to IC USDC; the amount is cleared again.
    await m.driver.click('sol-req-prefix', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-ckusdc', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-sol', {timeoutMs: 5000});
    await m.driver.findByTestID('req-pick-sol-usdc', {timeoutMs: 5000});
    await m.driver.click('req-pick-ckusdc', {timeoutMs: 5000});
    await m.driver.findByTestID('amount-input', {timeoutMs: 8000});
    assertEq(m.driver.readInputValue('amount-input'), '', 'IC amount empty after switching back (symmetric)');
    assertIncludes(m.driver.readText('req-prefix'), '$', 'the IC prefix still shows the $ glyph');

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 150_000);
});

describe('flow 71 — selection-lock', () => {
  it('a blocked-insufficient review locks the account chip; leaving the review releases the lock', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-lock');
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    // A merchant request for ∂200 DEMO — more than the wallet holds → the review stands, unsigned.
    const bob = await generateKeypair();
    const nonce = [...(new Uint8Array(16))].map((x) => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
    const reqQr = await DpayCore.encodeRequest(bob.publicHex, '20000', nonce, Math.floor(Date.now() / 1000) + 600, 0, 'Bob', '');
    await armPayScan(m);
    g.__DPAY_TEST_SCAN(reqQr);

    await m.driver.findByTestID('pay-amount', {timeoutMs: 5000});
    assertIncludes(m.driver.readText('pay-amount'), '∂200.00', 'the review shows the scanned amount');

    // LOCKED: the header account chip is disabled (the lock rides an effect after the review
    // render — wait for it), and a press on it is a no-op. The driver fires onPress directly
    // (a real browser swallows the press on a disabled control), so the no-op is asserted by the
    // disabled STATE itself: the route cannot open while the chip is locked.
    await m.driver.waitForFunction(
      () => m.driver.propOf('balance', 'aria-disabled') === true || m.driver.propOf('balance', 'disabled') === true,
      {timeoutMs: 5000, label: 'the account chip locks'},
    );
    await assertDisabled(m, 'balance', 'the header chip is disabled while the review is in flight');
    expect(m.driver.isPresent('accounts-list')).toBe(false);
    expect(m.driver.isPresent('pay-amount')).toBe(true); // the engine was not unmounted

    // Lock release is BY CONSTRUCTION: leaving the review unmounts the engine.
    await m.driver.click('tab-home', {timeoutMs: 5000});
    await m.driver.findByTestID('home-headline-amount', {timeoutMs: 5000});
    expect(m.driver.isPresent('pay-amount')).toBe(false);
    await m.driver.click('btn-home-accounts', {timeoutMs: 5000});
    await m.driver.findByTestID('accounts-list', {timeoutMs: 5000});

    // The Pay scanner is reachable again — the lock released with the review.
    await selectCurrency(m, 'vchf', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-scan', {timeoutMs: 5000});

    // The released lock re-enabled the chip; it opens the accounts route again.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await waitForEnabled(m, 'balance', {timeoutMs: 5000});
    await openBalances(m);

    await m.unmount();
  }, 150_000);
});
