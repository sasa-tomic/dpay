/**
 * Flows 72 + 75 + 76 + 79 + 80 + 81 — the Solana send/ATA gates, the seam fail-loud contract, the
 * fund-first funnels, and the IC fund-first parity — the jest twins of the e2e tests of the same
 * names, driven through the app's own `__DPAY_TEST_SOLANA_RPC_STUB` seam (solStub.ts shapes the
 * getMultipleAccounts answers; each flow declares only its NUMBERS).
 *
 * 72: an absent device USDC ATA fail-closes the SPL send (instruction card replaces the form);
 *     one tap creates it (busy → form); a failed create surfaces verbatim and the sheet stays usable.
 * 75: the three injection seams are installed and FAIL LOUD with 0 listeners (no Wallet mounted).
 * 76: the REQUEST form and My-address both gate on the ATA; the create's honest cost gate (SOL <
 *     rent+fee disables); one-tap create flips status → the address renders; Request unblocks.
 * 79: a KNOWN-zero SOL balance shows the fund panel BESIDE a reachable scan surface (X3); the
 *     1-tap funnel; stub funding auto-releases it; RPC errors fail OPEN; the USDC zero panel with
 *     the SOL-address secondary and the resume funnel.
 * 80: the USDC-pay setup card with the fund-SOL hatch; create unlocks when SOL lands; post-create
 *     the Pay surface becomes the USDC fund panel.
 * 81: the IC rail's fund panel rides below the scanner; offline fails open; the send sub-mode
 *     states the SEND instruction; the resume link appears only after the balance goes positive.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
// FIRST: the SOL RPC override + stub helper (the app captures the URL at module load).
import {installSolAccountsHelper} from './solStub';
import {
  accountOf, assertIncludes, faucetAccount, goOffline, onboardWallet, openBalances,
  selectCurrency, selectSolRail, setRelay,
} from '../harness/lib';
import {mountApp} from '../harness/mount';
import {scaled as budgetScaled} from '../harness/budget';
import {freshContext} from '../onboard/helpers';

const g = globalThis as unknown as Record<string, unknown>;
const SOL = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

type AtaState = {ataExists: boolean; createDelayMs: number; failCreate: boolean};

function installAtaStub(st: AtaState): void {
  g.__DPAY_TEST_SOLANA_RPC_STUB = {
    getMultipleAccounts: (p: unknown[]) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
      st.ataExists ? {lamports: 5000000000, token: {amount: '2500000', decimals: 6}} : {lamports: 5000000000, token: null}),
    getGenesisHash: () => SOL,
    getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
    getMinimumBalanceForRentExemption: () => 1447680,
    sendTransaction: async () => {
      await new Promise((resolve) => setTimeout(resolve, st.createDelayMs));
      if (st.failCreate) throw new Error('e2e stub: create ATA broadcast rejected');
      st.ataExists = true;
      return 'sig_ata_' + Math.random().toString(36).slice(2, 12);
    },
    getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
    getAccountInfo: () => (st.ataExists
      ? {value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}
      : {value: null}),
    getBalance: () => ({value: 5000000000}),
    getTokenAccountBalance: () => (st.ataExists
      ? {value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}
      : {value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}}),
  };
}

hermeticDescribe('flow 72 — sol-usdc-send', () => {
  it('absent ATA fail-closes the send; one-tap create opens the form; a failed create surfaces and stays usable', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-sol-usdc-send');
    const st: AtaState = {ataExists: false, createDelayMs: 2500, failCreate: false};
    installAtaStub(st);

    // Select Solana USDC via Balances, then the Pay tab's send sub-mode.
    await openBalances(m);
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('pay-mode-toggle', {timeoutMs: 5000});
    await m.driver.click('btn-pay-send', {timeoutMs: 5000});

    // FAIL-CLOSED: the instruction card replaces the entire form body.
    await m.driver.findByTestID('sol-send-instructions', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('sol-send-instructions'), 'USDC account',
      'the fail-closed instruction mentions the USDC account');
    expect(m.driver.isPresent('sol-send-address-input')).toBe(false);

    // ONE-TAP CREATE (happy path): enabled (SOL funded), busy while the broadcast holds, then the form.
    await m.driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 8000});
    expect(m.driver.propOf('btn-sol-send-ata-create', 'aria-disabled') === true
      || m.driver.propOf('btn-sol-send-ata-create', 'disabled') === true).toBe(false);
    await m.driver.click('btn-sol-send-ata-create', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-ata-busy', {timeoutMs: 2000});
    await m.driver.findByTestID('sol-send-address-input', {timeoutMs: 15_000});

    // CREATE FAILURE — the sheet stays usable: re-gate, fail the broadcast, error surfaces verbatim.
    st.ataExists = false;
    st.failCreate = true;
    st.createDelayMs = 300;
    await m.driver.waitGone('sol-send-address-input', {timeoutMs: 8000});
    await m.driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 8000});
    await m.driver.click('btn-sol-send-ata-create', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-ata-err', {timeoutMs: 8000});
    assertIncludes(m.driver.readText('sol-ata-err'), 'create ATA broadcast rejected',
      'the setup card surfaces the create failure verbatim');
    await m.driver.findByTestID('btn-sol-send-ata-create', {timeoutMs: 5000});
    expect(m.driver.isPresent('sol-ata-busy')).toBe(false);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 150_000);
});

hermeticDescribe('flow 75 — seam-fail-loud', () => {
  it('all three injection seams installed; with no Wallet mounted every count is 0 and every seam throws, naming the missing piece', async () => {
    await freshContext();
    const m = await mountApp(); // Onboarding only — no Wallet surfaces
    expect(m.driver.isPresent('tab-home')).toBe(false);

    const seams: Array<[string, unknown, string]> = [
      ['__DPAY_TEST_SCAN', 'https://example.com/req', 'QrScanner'],
      ['__DPAY_TEST_NFC_SESSION', {type: 'phase', role: 'card', phase: 'linking'}, 'NfcEvent'],
      ['__DPAY_TEST_SOL_NFC_SESSION', {type: 'phase', role: 'card', phase: 'linking'}, 'NfcEvent'],
    ];
    for (const [name, payload, mustName] of seams) {
      const fn = g[name] as ((p: unknown) => void) | undefined;
      expect(typeof fn).toBe('function');
      let threw = false;
      let message = '';
      try {
        fn!(payload);
      } catch (e) {
        threw = true;
        message = e instanceof Error ? e.message : String(e);
      }
      expect({name, threw}).toEqual({name, threw: true});
      assertIncludes(message, mustName, `${name} must name the missing component`);
    }

    // With no Wallet mounted, every listener count is 0 (the fail-loud precondition).
    expect((g.__DPAY_TEST_SCAN_COUNT as () => number)()).toBe(0);
    expect((g.__DPAY_TEST_NFC_COUNT as () => number)()).toBe(0);
    expect((g.__DPAY_TEST_SOL_NFC_COUNT as () => number)()).toBe(0);

    await m.unmount();
  }, 60_000);
});

hermeticDescribe('flow 76 — sol-usdc-ata-gate', () => {
  it('request + address gate on the ATA; the cost gate is honest; one-tap create flips status and unblocks Request', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-sol-usdc-ata');
    let ataExists = false;
    const stub: Record<string, (p: unknown[]) => unknown> = {
      getMultipleAccounts: (p) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
        {lamports: 5000000000, token: ataExists ? {amount: '0', decimals: 6} : null}),
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: ataExists
        ? {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}
        : null}),
      getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'SigAtaE2E',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    g.__DPAY_TEST_SOLANA_RPC_STUB = stub;

    await openBalances(m);
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
    await m.driver.click('btn-receive-request', {timeoutMs: 5000}); // drive the REQUEST form

    // 1. ABSENT: the request form shows the inline setup card and Request is BLOCKED.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-req-ata-create', {timeoutMs: 8000});
    expect(m.driver.propOf('btn-sol-req-make', 'aria-disabled') === true
      || m.driver.propOf('btn-sol-req-make', 'disabled') === true).toBe(true);

    // 2. ABSENT: "My address" shows the setup card, NOT the address, no false warning.
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-ata-create', {timeoutMs: 8000});
    expect(m.driver.isPresent('sol-receive-address')).toBe(false);
    expect(m.driver.isPresent('sol-ata-insufficient')).toBe(false);

    // 3. INSUFFICIENT: drop SOL below rent+fee → warning + create DISABLED (both readers move).
    stub.getBalance = () => ({value: 1000000});
    stub.getMultipleAccounts = (p) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
      {lamports: 1000000, token: ataExists ? {amount: '0', decimals: 6} : null});
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.waitGone('btn-receive-address', {timeoutMs: 8000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-ata-insufficient', {timeoutMs: 10_000});
    expect(m.driver.propOf('btn-sol-ata-create', 'aria-disabled') === true
      || m.driver.propOf('btn-sol-ata-create', 'disabled') === true).toBe(true);

    // 4. FUNDED + CREATE: the real broadcast → status flips → the address QR appears.
    stub.getBalance = () => ({value: 5000000000});
    stub.getMultipleAccounts = (p) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
      {lamports: 5000000000, token: ataExists ? {amount: '0', decimals: 6} : null});
    const origSend = stub.sendTransaction;
    stub.sendTransaction = (tx) => {
      ataExists = true;
      return origSend(tx);
    };
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.waitGone('btn-receive-address', {timeoutMs: 8000});
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-ata-create', {timeoutMs: 10_000});
    await m.driver.waitGone('sol-ata-insufficient', {timeoutMs: 10_000});
    await m.driver.click('btn-sol-ata-create', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 15_000});
    expect(m.driver.readText('sol-receive-address')).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

    // 5. BALANCE (direct): the request form is unblocked.
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.waitGone('btn-sol-req-ata-create', {timeoutMs: 8000});
    expect(m.driver.propOf('btn-sol-req-make', 'aria-disabled') === true
      || m.driver.propOf('btn-sol-req-make', 'disabled') === true).toBe(false);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 180_000);
});

hermeticDescribe('flow 79 — sol-fund-first-pay', () => {
  it('known zero gates beside a live scan; the 1-tap funnel; funding auto-releases; errors fail open; the USDC zero panel + resume', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-sol-fund');
    let ataExists = true;
    let lamports = 0;
    let failRpc = false;
    const stub: Record<string, (p: unknown[]) => unknown> = {
      getMultipleAccounts: (p) => {
        if (failRpc) throw new Error('rpc down');
        return (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
          {lamports, token: ataExists ? {amount: '0', decimals: 6} : null});
      },
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
      getBalance: () => ({value: lamports}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'SigE2E',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    g.__DPAY_TEST_SOLANA_RPC_STUB = stub;

    await openBalances(m);
    await selectCurrency(m, 'sol', {timeoutMs: 5000});

    // 1. KNOWN-ZERO: the fund panel rides BELOW the scan surface (X3), never in front.
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    const panelText = m.driver.readText('sol-pay-fund');
    assertIncludes(panelText, 'No SOL available', 'gate headline');
    assertIncludes(panelText, 'Show my SOL address', 'primary deposit action');
    expect(m.driver.isPresent('btn-sol-start-scan')).toBe(true);
    expect(m.driver.isPresent('scan-cam-box')).toBe(false); // the camera waits for the Pay Now press

    // 2. FUNNEL: one tap lands on the deposit address QR + the honest waiting cue.
    await m.driver.click('sol-pay-fund-go', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 8000});
    await m.driver.findByTestID('sol-receive-qr', {timeoutMs: 5000});
    expect(m.driver.readText('sol-receive-address')).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    await m.driver.findByTestID('sol-receive-waiting', {timeoutMs: 5000});

    // 3. RESUME FUNNEL + AUTO-RELEASE: fund SOL → the gate releases (poll-driven).
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-fund', {timeoutMs: 5000});
    lamports = 5000000000;
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 15_000});
    await m.driver.waitGone('sol-pay-fund', {timeoutMs: 5000});

    // 4. FAIL-OPEN: an RPC error keeps the scanner live; zero re-gates.
    failRpc = true;
    await m.driver.findByTestID('sol-pay-scan', {timeoutMs: 10_000});
    failRpc = false;
    lamports = 0;
    await m.driver.findByTestID('sol-pay-fund', {timeoutMs: 15_000});

    // 5. USDC ZERO: same panel, USDC copy + the SOL-address secondary.
    await openBalances(m);
    await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-fund', {timeoutMs: 10_000});
    const usdcText = m.driver.readText('sol-pay-fund');
    assertIncludes(usdcText, 'No USDC available', 'USDC gate headline');
    assertIncludes(usdcText, 'Show my USDC address', 'USDC deposit primary');
    assertIncludes(usdcText, 'Show my SOL address', 'SOL-address secondary (fees note pair)');
    expect(m.driver.isPresent('btn-sol-start-scan')).toBe(true);

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 180_000);
});

hermeticDescribe('flow 80 — sol-fund-funnel', () => {
  it('USDC-pay setup card with the fund hatch; create unlocks when SOL lands; post-create the surface becomes the USDC fund panel', async () => {
    await freshContext();
    installSolAccountsHelper();
    const m = await onboardWallet('e2e-fund-funnel');
    let ataExists = false;
    let lamports = 0;
    const stub: Record<string, (p: unknown[]) => unknown> = {
      getMultipleAccounts: (p) => (g.__DPAY_SOL_ACCOUNTS as (p2: unknown, o: unknown) => unknown)(p,
        {lamports, token: ataExists ? {amount: '0', decimals: 6} : null}),
      getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
      getBalance: () => ({value: lamports}),
      getAccountInfo: () => ({value: ataExists
        ? {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}
        : null}),
      getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      sendTransaction: () => 'SigAtaE2E',
      getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
    };
    g.__DPAY_TEST_SOLANA_RPC_STUB = stub;

    // Reach the Solana-USDC rail through the receive asset-switch (the currency-first path).
    let picked = false;
    for (let i = 0; i < 3 && !picked; i++) {
      try {
        await selectSolRail(m, 'sol-usdc', {timeoutMs: 5000});
        picked = true;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise((r) => setTimeout(r, budgetScaled(600)));
        await openBalances(m);
      }
    }
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.click('btn-receive-asset-switch', {timeoutMs: 5000});
    await m.driver.click('req-pick-sol-usdc', {timeoutMs: 5000});
    await new Promise((r) => setTimeout(r, 1500));

    // 1. USDC absent + SOL zero: setup card + warning + escape hatch (no dead end).
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-ata-instructions', {timeoutMs: 10_000});
    const instr = m.driver.readText('sol-pay-ata-instructions');
    assertIncludes(instr, 'You need about', 'insufficient warning present');
    expect(instr.includes('then come back')).toBe(false); // the dead-end copy is gone
    await m.driver.findByTestID('btn-sol-ata-fund', {timeoutMs: 5000});
    expect(m.driver.propOf('btn-sol-pay-ata-create', 'aria-disabled') === true
      || m.driver.propOf('btn-sol-pay-ata-create', 'disabled') === true).toBe(true);
    expect(m.driver.isPresent('btn-sol-start-scan')).toBe(true); // X3: the scan surface stays reachable

    // 2. Escape hatch → one tap to the SOL deposit address.
    await m.driver.click('btn-sol-ata-fund', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 8000});
    await m.driver.findByTestID('sol-receive-waiting', {timeoutMs: 5000});

    // 3. Stub-fund SOL → create unlocks (re-reach the rail through the asset switch).
    lamports = 5000000000;
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.click('btn-receive-asset-switch', {timeoutMs: 5000});
    await m.driver.click('req-pick-sol-usdc', {timeoutMs: 5000});
    await m.driver.click('tab-pay', {timeoutMs: 5000});
    await m.driver.findByTestID('btn-sol-pay-ata-create', {timeoutMs: 10_000});
    await m.driver.waitGone('sol-ata-insufficient', {timeoutMs: 10_000});

    // 4. Create → confirmed → the USDC Pay surface becomes the USDC fund panel.
    const origSend = stub.sendTransaction;
    stub.sendTransaction = (tx) => {
      ataExists = true;
      return origSend(tx);
    };
    await m.driver.click('btn-sol-pay-ata-create', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-pay-fund', {timeoutMs: 15_000});
    assertIncludes(m.driver.readText('sol-pay-fund'), 'No USDC available', 'post-create Pay = USDC fund panel');

    // 5. The Solana-USDC surface stays reachable once the ATA exists.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.findByTestID('sol-receive-address', {timeoutMs: 8000});

    await m.unmount();
    g.__DPAY_TEST_SOLANA_RPC_STUB = undefined;
  }, 240_000);
});

hermeticDescribe('flow 81 — ic-fund-first-pay', () => {
  it('the BTC fund panel rides below the scanner; the funnel lands the deposit; offline fails open; send parity; the resume link after funding', async () => {
    await freshContext();
    const m = await onboardWallet('e2e-ic-fund');

    // Select ckBTC (a fresh wallet holds DEMO ∂100 but zero ckBTC).
    await openBalances(m);
    await selectCurrency(m, 'ckbtc');

    // (1) Online + known zero → the fund panel rides BELOW the scan surface (X3).
    await m.driver.click('tab-pay');
    await m.driver.findByTestID('pay-fund', {timeoutMs: 8000});
    const txt = m.driver.readText('pay-fund');
    assertIncludes(txt, 'No BTC available', 'panel headline names the selected asset');
    assertIncludes(txt, 'To pay in BTC, first receive BTC at your address.', 'the scan sub-mode states the PAY instruction');
    assertIncludes(txt, 'Show my BTC address', 'depositable asset offers the deposit primary');
    expect(m.driver.isPresent('btn-start-scan')).toBe(true);
    expect(m.driver.isPresent('scan-cam-box')).toBe(false);

    // (2) One tap → the ckBTC deposit address.
    await m.driver.click('pay-fund-go');
    await m.driver.findByTestID('deposit-address', {timeoutMs: 8000});
    const addr = m.driver.readText('deposit-address');
    expect(addr.startsWith('bc1q')).toBe(true);
    expect(m.driver.isPresent('deposit-qr')).toBe(true);

    // (3) Fail-open: relay unreachable → the scanner returns (offline-first rule).
    await goOffline(m);
    await m.driver.click('tab-pay');
    await m.driver.waitGone('pay-fund', {timeoutMs: 10_000});
    expect(await m.driver.waitForText('Scan to pay', {timeoutMs: 6000})).toBe(true);

    // (4) Send sub-mode parity: back online, known zero → the same panel, the SEND instruction.
    await setRelay(m, 'https://dpay.kalaj.org');
    await m.driver.click('tab-pay');
    await m.driver.findByTestID('pay-fund', {timeoutMs: 10_000});
    await m.driver.click('btn-pay-send');
    const sendTxt = m.driver.readText('pay-fund');
    assertIncludes(sendTxt, 'No BTC available', 'send sub-mode shows the same fund panel');
    assertIncludes(sendTxt, 'To send BTC, first receive BTC at your address.', 'the send sub-mode states the SEND instruction');
    expect(sendTxt.includes('To pay in BTC')).toBe(false);
    expect(m.driver.isPresent('send-address-input')).toBe(false);
    assertIncludes(sendTxt, 'Show my BTC address', 'the send panel keeps the deposit primary');

    // (5) Fund-funnel RESUME: no link while zero; after the balance lands, one tap back to sending.
    await m.driver.click('pay-fund-go');
    await m.driver.findByTestID('deposit-address', {timeoutMs: 8000});
    expect(m.driver.isPresent('btn-ic-receive-return')).toBe(false);

    const identity = await accountOf(m);
    const fund = await faucetAccount(identity!.publicHex, 150_000, {currency: 1});
    expect(fund.ok).toBe(true);

    await m.driver.findByTestID('btn-ic-receive-return', {timeoutMs: 12_000});
    const label = m.driver.readText('btn-ic-receive-return');
    assertIncludes(label, 'Back to paying', 'the resume link names the action');
    assertIncludes(label, 'BTC', 'the resume link names the asset');
    await m.driver.click('btn-ic-receive-return');
    await m.driver.findByTestID('send-address-input', {timeoutMs: 8000});
    expect(m.driver.isPresent('pay-fund')).toBe(false);

    await m.unmount();
  }, 180_000);
});
