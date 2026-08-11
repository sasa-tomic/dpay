// Flow 67 — SOL setup-nonce FAILURE + RESYNC (the error/recovery paths flow 46's happy path
// doesn't cover, for the SOL rail).
//
// Flow 46 covers the happy path: createNonceAccount → scan → sign → honest pending. But TWO error
// surfaces in SolPayMode.tsx have ZERO coverage:
//   (A) **Setup failure** (line ~107): createNonceAccount can fail (unfunded account, network
//       error). `sol-pay-setup-err` surfaces `friendlySolError`. The raw RPC jargon
//       ("Transaction simulation failed: Attempt to debit an account but found no record of a prior
//       credit") MUST NOT leak — friendlySolError rewrites it to actionable user copy. There's also
//       an escape hatch: when setup errors AND onShowDeposit is wired (it is, in Wallet.tsx), the
//       `sol-show-deposit` Pressable renders so the unfunded user can reach their deposit address.
//   (B) **Resync** (line ~156-172): `btn-sol-pay-resync` is wired for stale-nonce recovery. After a
//       rejected/unreachable broadcast the nonceState is marked 'stale' (signing against a stale
//       value produces a tx Solana rejects on-chain). Resync re-reads the current on-chain nonce
//       value via resyncNonce → getNonceAccount and flips status back to 'ready' so offline signing
//       works again. Cheaper than re-running setupNonce (no fresh rent cost).
//
// This flow drives BOTH surfaces through the REAL app code (NO app-layer mocks — the only mocks are
// at the I/O boundary: `__DPAY_TEST_SOLANA_RPC_STUB` + the AsyncStorage shim, which is what those
// seams exist for):
//   - Part A: install a REJECTING SOL RPC stub whose sendTransaction throws the canonical unfunded-
//     account error. Click `btn-sol-pay-setup` → setupNonce's createNonceAccount throws → SolPayMode
//     catches + sets `err = friendlySolError(msg)`. Assert:
//       • `sol-pay-setup-err` renders with the FRIENDLY message (contains "no SOL" or "deposited");
//         NOT the raw "Transaction simulation failed" / "Attempt to debit" RPC text.
//       • `sol-show-deposit` (the unfunded escape hatch) renders — A3, the dead-end-has-an-exit UX.
//   - Part B: pre-seed AsyncStorage with a `stale` nonce state, switch SOL → DEMO → SOL to remount
//     SolPayMode (its useEffect reads loadSolNonce on mount only). Assert:
//       • `btn-sol-pay-resync` renders (the stale surface).
//     Then install a FUNCTIONAL stub, click resync → resyncNonce reads the on-chain value → status
//     flips to 'ready' → `sol-pay-stale` + `btn-sol-pay-resync` are GONE (the resync unblocked
//     offline pay).
//
// The resync path is the higher-value half (it's the recovery flow that follows a rejected
// broadcast — uniquely SOL, no IC analog). The setup-error path catches the "raw RPC leaked" UX
// regression (friendlySolError is the single friendly-error source for the entire SOL rail).
//
// Selector contract: `balance` (header → Balances), `asset-sol-select` (the SOL row whole-row
// select), `btn-sol-pay-setup`, `sol-pay-setup-err`, `sol-show-deposit`, `btn-sol-pay-resync`,
// `sol-pay-stale`, `sol-pay-scan`.
import {setup, assert, assertIncludes, onboardWallet, accountOf, selectCurrency} from '../harness/lib.mjs';

export const meta = {
  id: '67',
  name: 'sol-setup-error',
  journey: 'offline',
  covers: ['sol-setup-error', 'sol-nonce-resync', 'sol-friendly-error', 'sol-unfunded-hatch', 'sol-stale-recovery'],
  verifies: 'SOL setup-nonce failure surfaces a friendly error (not raw RPC) + the unfunded escape hatch; the stale-nonce resync flips status back to ready so offline signing works again.',
  timeoutMs: 25000,
  notes: 'The resync path is driven by pre-seeding AsyncStorage with a stale nonce state and force-remounting SolPayMode via a SOL→DEMO→SOL asset switch (loadSolNonce only runs on mount). Driving the stale state end-to-end (an actual rejected broadcast → auto-mark-stale → resync) would require a full NFC or QR round-trip with a rejecting stub; the pre-seed shortcut covers the SAME resync code path (resyncNonce → getNonceAccount → saveSolNonce) at lower complexity, with no loss of protocol coverage.',
};

// Build the 80-byte NonceState account data as base64 (u32 version | u32 state=Initialized |
// 32B authority | 32B nonce value | u64 fee) — the layout getNonceAccount parses. Verbatim from
// flow 47/66.
function nonceAccountB64() {
  const buf = Buffer.alloc(80, 0);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt32LE(1, 4);
  buf.fill(1, 8, 40);
  Buffer.from('deadbeef'.repeat(8), 'hex').copy(buf, 40);
  buf.writeBigUInt64LE(5000n, 72);
  return buf.toString('base64');
}

export async function run() {
  const start = Date.now();
  console.log('[67-sol-setup-error] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[67-sol-setup-error] onboarding…');
    await onboardWallet(driver, 'e2e-sol-setup-err');

    // -------- Part A: setup-nonce FAILURE → friendlySolError + escape hatch. -----------------
    //
    // Install a REJECTING stub: sendTransaction throws the canonical unfunded-account error (the
    // #1 failure an account with no SOL produces). The other methods stay functional so the failure
    // is isolated to the broadcast step (the createNonceAccount flow reaches sendTransaction after
    // getLatestBlockhash + getMinimumBalanceForRentExemption succeed).
    const nonceB64 = nonceAccountB64();
    console.log('[67-sol-setup-error] Part A: installing REJECTING stub (unfunded-account error)…');
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => {
          throw new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit');
        },
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 0}),
      };
    }, nonceB64);

    // Select SOL → SolPayMode mounts in 'setup' (no persisted nonce state on a fresh identity).
    console.log('[67-sol-setup-error] selecting SOL via Balances (SolPayMode mounts in setup)…');
    await driver.findByTestID('balance', {timeoutMs: 8_000});
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('asset-sol-select', {timeoutMs: 5_000});
    await driver.click('asset-sol-select', {timeoutMs: 5_000});
    await driver.findByTestID('btn-sol-pay-setup', {timeoutMs: 5_000});

    // Click setup → createNonceAccount throws (sendTransaction rejected) → catch sets
    // `err = friendlySolError(msg)`. friendlySolError's "no record of a prior credit" branch returns
    // "This account has no SOL, or the network hasn't synced your balance yet. If you just
    // deposited, wait a moment and retry — otherwise deposit SOL to your address first."
    console.log('[67-sol-setup-error] clicking btn-sol-pay-setup (expecting friendly failure)…');
    await driver.click('btn-sol-pay-setup', {timeoutMs: 5_000});
    const errEl = await driver.findByTestID('sol-pay-setup-err', {timeoutMs: 12_000});
    const errTxt = await errEl.evaluate((n) => (n.textContent ?? '').trim());

    // The friendly message must mention SOL / deposit — actionable user copy.
    assert(/SOL/i.test(errTxt) || /deposited|deposit/i.test(errTxt),
      `the friendly setup error should mention SOL or deposit, got: "${errTxt}"`);
    // The raw RPC jargon MUST NOT leak (the whole point of friendlySolError).
    assert(!/Transaction simulation failed/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    assert(!/Attempt to debit/.test(errTxt),
      `the raw RPC error must not leak to the UI, got: "${errTxt}"`);
    console.log(`[67-sol-setup-error] ✓ friendly setup error: "${errTxt}"`);

    // The unfunded-account escape hatch (A3): `sol-show-deposit` renders alongside the error so the
    // dead-end has an exit (the user can navigate to their SOL deposit address to fund it).
    await driver.findByTestID('sol-show-deposit', {timeoutMs: 5_000});
    console.log('[67-sol-setup-error] ✓ unfunded escape hatch (sol-show-deposit) rendered');

    // -------- Part B: stale-nonce RESYNC → status flips back to ready. -----------------------
    //
    // Pre-seed AsyncStorage with a `stale` nonce state for THIS identity. Switching SOL → DEMO →
    // SOL unmounts + remounts SolPayMode; on remount its useEffect reads loadSolNonce → returns the
    // stale state → phase='scan' with the stale-nonce surface (sol-pay-stale + btn-sol-pay-resync).
    console.log('[67-sol-setup-error] Part B: pre-seeding stale nonce state + remounting SolPayMode…');
    const account = await accountOf(driver);
    assert(account && account.publicHex, 'account identity should be available after onboarding');
    // The address is arbitrary base58 (the stub returns nonce data regardless of the queried key).
    // Use a 32-byte fixed value so the persist round-trip is byte-stable.
    const STALE_NPUB = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
    const STALE_VALUE = '9WzDXwBbmkg8ZTbNMqJx8W4tTKKqXNFN1YmqE7GwcmKz'; // arbitrary valid base58
    await driver.eval((pubhex, json) => {
      localStorage.setItem('dpay.sol.nonce.v1.' + pubhex, json);
    }, account.publicHex, JSON.stringify({address: STALE_NPUB, value: STALE_VALUE, status: 'stale'}));

    // Remount SolPayMode: switch to DEMO (unmounts SolPayMode), then back to SOL (re-mounts it).
    // On remount, loadSolNonce reads the seeded stale state → phase='scan' (stale).
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('btn-balances-close', {timeoutMs: 5_000});
    await selectCurrency(driver, 'demo');
    // DEMO is now active (PayMode mounts, not SolPayMode). Switch back to SOL.
    await driver.click('balance', {timeoutMs: 5_000});
    await driver.findByTestID('btn-balances-close', {timeoutMs: 5_000});
    await selectCurrency(driver, 'sol');

    // The stale surface should now render: sol-pay-stale + btn-sol-pay-resync.
    await driver.findByTestID('sol-pay-stale', {timeoutMs: 8_000});
    await driver.findByTestID('btn-sol-pay-resync', {timeoutMs: 5_000});
    console.log('[67-sol-setup-error] ✓ stale-nonce surface rendered (sol-pay-stale + btn-sol-pay-resync)');

    // Flip the stub back to FUNCTIONAL so resyncNonce can read a fresh nonce value. The address
    // queried is STALE_NPUB (the seeded address); getAccountInfo returns the valid nonce account,
    // which resyncNonce parses to extract the value field.
    console.log('[67-sol-setup-error] installing FUNCTIONAL stub + clicking btn-sol-pay-resync…');
    await driver.eval((b64) => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
        getMinimumBalanceForRentExemption: () => 1447680,
        sendTransaction: () => 'sig_' + Math.random().toString(36).slice(2, 12),
        getSignatureStatuses: () => ({value: [{confirmationStatus: 'confirmed'}]}),
        getAccountInfo: () => ({value: {data: [b64, 'base64'], owner: '11111111111111111111111111111111', lamports: 1447680}}),
        getBalance: () => ({value: 5000000000}),
      };
    }, nonceB64);

    // Click resync → resyncNonce(STALE_NPUB) → getNonceAccount parses the stub's nonce account →
    // returns the fresh value → saveSolNonce({status:'ready'}) → setNonceState → re-render → the
    // stale overlay disappears.
    await driver.click('btn-sol-pay-resync', {timeoutMs: 5_000});
    // sol-pay-stale + btn-sol-pay-resync should be GONE (status flipped to 'ready'). sol-pay-scan
    // is always present in 'scan' phase (it's the QR scanner container the stale overlay covered).
    await driver.waitGone('sol-pay-stale', {timeoutMs: 8_000});
    await driver.waitGone('btn-sol-pay-resync', {timeoutMs: 5_000});
    await driver.findByTestID('sol-pay-scan', {timeoutMs: 5_000});
    console.log('[67-sol-setup-error] ✓ resync flipped status to ready (stale overlay gone, scan rendered)');

    // Verify the persisted nonce state is now 'ready' (resync saved the fresh value).
    const persisted = await driver.eval((pubhex) => {
      const raw = localStorage.getItem('dpay.sol.nonce.v1.' + pubhex);
      return raw ? JSON.parse(raw) : null;
    }, account.publicHex);
    assert(persisted && persisted.status === 'ready',
      `persisted nonce status should be 'ready' after resync, got: ${JSON.stringify(persisted)?.slice(0, 120)}`);
    console.log('[67-sol-setup-error] ✓ persisted nonce state is ready after resync');

    await driver.screenshot('67-sol-setup-error');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[67-sol-setup-error] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[67-sol-setup-error] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
