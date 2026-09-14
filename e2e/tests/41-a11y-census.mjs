// Flow 41 — Accessibility census: every interactive element with a `data-testid` on every primary
// surface MUST carry a non-empty `aria-label` (or implicit label) AND a `role`. Catches the class
// "a developer adds a button/input and forgets the label" — a real a11y regression that's invisible
// to the testID/textContent net but blazes through to a screen-reader user as "button" / "edit text"
// with no name.
//
// Empirically determined RNW a11y mapping (probed in this repo, 2026-08-05):
//   accessibilityRole="button"  → <button type="button" role="button">
//   accessibilityRole="link"    → <div role="link">
//   accessibilityLabel="..."    → aria-label="..."
//   accessibilityHint="..."     → (NOT rendered to a standard attribute by RNW)
//   accessibilityState          → aria-disabled / aria-checked (subset; we don't assert on these)
// A bare <TextInput> with no accessibilityLabel renders as <input> with NO aria-label — the bug this
// flow catches. A bare <Text>/<View> renders as <div> with NO role/aria (correct: not interactive).
//
// The census walks the same primary surfaces flow 35 (UX tour) screenshots: the Pay scanner,
// Receive + currency picker, the Home tab, the ACCOUNTS route (its own surface since 2026-09-08),
// Settings, Transactions, and Pay → "Send to address"
// (which needs a funded asset to reach — see `paySend`). On each surface it queries the
// DOM for every [data-testid] matching a known-interactive prefix (btn-* / tab-* / req-* /
// req-pick-* / settings-relay / amount-input / memo-input / privacy-policy / ledger-filter-* /
// asset-add-* / btn-withdraw / btn-topup / btn-settings-close / balance /
// btn-settings), then asserts EACH has BOTH:
//   - a non-empty aria-label, AND
//   - a non-empty role (button/link/etc.) — inputs implicitly carry their HTML kind; we accept the
//     INPUT tag as the role-equivalent for text fields (RNW renders them as bare <input>).
//
// The expected testID set is grouped by surface in `SURFACES` below — adding a new interactive
// control means adding its testID to the right surface (single source of truth the next dev updates
// alongside the new testID).
//
// Selector contract: surfaces are reached by the same taps a user makes — `tab-home`, `balance`
// (the header chip → the accounts route), `tab-receive`, `req-prefix`, `btn-settings`,
// `tab-transactions`, `asset-vchf-select`, `btn-pay-send`.
import {
  setup, onboardWallet, assert, accountOf, faucetAccount, openBalances, selectCurrency, openPaySend,
  railPrincipalText,
} from '../harness/lib.mjs';

// The asset the send census runs on: VCHF is a no-minter direct-ICRC row, so "Send to address"
// lands on the direct send form rather than delegating to the chain-key burn body.
const SEND_CURRENCY = 7;
const SEND_ASSET_KEY = 'vchf';
const SEND_SEED = 500_000_000; // 5.00000000 VCHF — any non-zero balance clears the fund-first gate
// A second wallet's pubkey; its principal is a real external destination as far as the app knows.
const SEND_RECIPIENT_PUBKEY = 'e'.repeat(64);

// The expected interactive testIDs per primary surface. A testID is in scope here ONLY if it's
// (a) interactive (a Pressable-onPress or a TextInput) AND (b) carries a testID. Non-interactive
// <View>/<Text> wrappers (asset-demo, pay-scan, header-who) are intentionally EXCLUDED — they have
// no role and no label by design (correct: they're not user-actionable). Inputs are listed alongside
// buttons; an input's role-equivalent is its <input> tag (RNW renders bare <input> with no role
// attribute).
const SURFACES = {
  // Always-present (header + tabbar) on every surface. link-home is the web-only wordmark
  // back-link to the site root (WordmarkLink in Logo.tsx) — on native it degrades to inert
  // text, so the census (web) is its only role/label gate.
  chrome: ['btn-settings', 'btn-theme', 'link-home', 'tab-home', 'tab-pay', 'tab-receive', 'tab-transactions'],
  // Wallet home (Pay tab) — only chrome is interactive (the scan card's QR scanner is a viewport,
  // not a Pressable; the pay-scan DIV is informational).
  home: [],
  // Home tab — the LANDING surface (2026-09-08): the primary Scan button, the two secondary
  // action-row buttons (Receive navigates; Add money funds the HOME rail), the accounts
  // affordance, and the activity feed's See-all link. The headline block itself is informational.
  homeTab: ['btn-home-scan', 'btn-home-receive', 'btn-home-add-money', 'btn-home-accounts',
            'btn-home-activity-all'],
  // The ACCOUNTS route — the retired Balances sheet's body, its own surface since 2026-09-08.
  // btn-accounts-back leaves the route; btn-topup is the practice row's faucet; `asset-*-select`
  // is each row's whole-row select Pressable; btn-accounts-convert is the per-asset Convert action
  // on the SELECTED row; btn-toggle-testnet reveals the testnet rows. SOL is uniform with the IC
  // rows (whole-row select — on-chain deposit/send lives in the Pay/Receive tab sub-modes).
  accounts: ['btn-accounts-back', 'btn-accounts-convert', 'btn-topup', 'btn-toggle-testnet',
             'asset-demo-select', 'asset-ckbtc-select', 'asset-ckusdc-select',
             'asset-cketh-select', 'asset-vchf-select', 'asset-icp-select',
             'asset-sol-select'],
  // Receive tab + currency picker (open via req-prefix). The picker rows are req-pick-<assetTestKey>;
  // the wallet's IC-mainnet catalog ships DEMO/ckBTC/ckUSDC/ckETH/VCHF/ICP (the REAL prod rows —
  // six mainnet IC assets since the 2026-08-28 catalog transplant), so all six picker rows assert.
  // req-pick-sol is the unified SOL entry (Issue #2) — picking it flips the rail to SolReceiveMode.
  receive: ['req-prefix', 'amount-input', 'memo-input', 'btn-request',
            'req-pick-demo', 'req-pick-ckbtc', 'req-pick-ckusdc', 'req-pick-cketh',
            'req-pick-vchf', 'req-pick-icp', 'req-pick-sol'],
  // Balances hub — RETIRED with the sheet (O4 S3); its rows are censused on `accounts` above.
  // Settings sheet (open via `btn-settings`). btn-reset-* are revealed only after tapping btn-reset
  // (the confirmation dialog); listed separately below to keep this census aligned with the visible
  // surface at first open. btn-backup + btn-settings-restore are the always-visible section entries
  // (Backup and Restore); their confirm-gate children are censused separately — the Backup path
  // is covered inline by the Backup flow's own census path; settingsRestoreConfirm below). The theme
  // control is the Wave-8 three-way segmented control (Light / Dark / Auto radio segments).
  // Trip Ready J5b: `btn-trip-readiness` (Learn section — the passport archive modal).
  settings: ['btn-settings-close', 'btn-theme-auto', 'btn-theme-light', 'btn-theme-dark', 'settings-relay', 'btn-relay-apply', 'btn-backup', 'btn-reset', 'btn-settings-restore', 'privacy-policy', 'btn-trip-readiness'],
  // Settings → Reset confirmation (btn-reset was tapped). Surface = the dialog above.
  settingsResetConfirm: ['btn-reset-confirm', 'btn-reset-cancel'],
  // Settings → Restore confirmation (btn-settings-restore was tapped). Surface = the inline seed
  // form (settings-restore-seed-input + the confirm/cancel pair). Mirrors settingsResetConfirm.
  settingsRestoreConfirm: ['settings-restore-seed-input', 'btn-settings-restore-confirm', 'btn-settings-restore-cancel'],
  // Transactions tab — empty initially (no transactions). When history is non-empty, ledger-filter-*
  // chips render (one per present ASSET, across both rails); a fresh wallet has none, so only the
  // chrome asserts.
  transactions: [],
  // Pay tab → "Send to address" (SendSheet + AddressField — the one send-to-address surface for
  // every IC asset). Reached with `btn-pay-send`, but only for an asset that is BOTH send-capable
  // and funded: a known-zero balance replaces the whole form with the fund-first panel, so the
  // census funds VCHF and selects it first. `btn-pay-scan`/`btn-pay-send` are the two segments of
  // the sub-mode toggle; `send-scan` is the destination field's QR button; `btn-send-max` fills the
  // spendable maximum. (`send-save-name` renders only once a destination has resolved and is
  // censused on the sub-surface below, exactly as the settings confirm-gates are.)
  paySend: ['btn-pay-scan', 'btn-pay-send', 'send-address-input', 'send-scan',
            'send-amount-input', 'btn-send-max', 'btn-send-confirm'],
  // Pay → Send to address, with a resolved destination in the field. Surface = the same form plus
  // the optional "name this address" field the address book offers once there is something to name.
  paySendResolved: ['send-save-name'],
};

// HTML tags that imply an interactive role even when no `role` attribute is present (RNW's rendering
// of accessibilityRole="button" produces <button>; an accessibilityLabel-less TextInput renders as
// <input>). Treat these tags as the role-equivalent for the census.
const IMPLICIT_ROLE_TAGS = new Set(['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA']);

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '41',
  name: 'a11y-census',
  journey: 'system',
  covers: ['a11y', 'accessibility', 'aria'],
  verifies: 'Every interactive element (btn-*/tab-*/inputs/picker rows) carries a non-empty aria-label + role on every primary surface.',
  timeoutMs: 45000, // 12.4s standalone census of 8 surfaces vs 20s was too tight: mid-run host-load
  // spikes (parallel pool contention) are NOT compensated by the one-shot load factor measured at
  // run start, so a spike after the factor is fixed false-fires the backstop. 30s keeps the
  // hang-backstop meaningfully above the real (load-inflated) census cost. 2026-09-14: raised
  // 30s → 45s — on a shared 5-user host (load ~8-9) a SERIAL run died one leg from the end
  // (pay-send-resolve's 58-char type + resolution round trip) at the 30s wall with every census
  // leg green; the backstop was no longer above the load-inflated cost.
};

export async function run() {
  const start = Date.now();
  console.log('[41-a11y-census] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    console.log('[41-a11y-census] onboarding…');
    await onboardWallet(driver, 'e2e-a11y');

    // Fund VCHF up front: the send surface censused at the end is behind the fund-first gate, and a
    // zero balance would substitute the fund panel for the very controls under census.
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, `wallet account must be a 32-byte hex pubkey, got "${accountHex}"`);
    const fund = await faucetAccount(relayBaseURL, accountHex, SEND_SEED, { currency: SEND_CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}: ${JSON.stringify(fund.body)}`);

    const allMissing = []; // {surface, testid, missing: ['role'|'label']}
    const allChecked = []; // {surface, testid, role, label} for the report

    // Helper: census the currently-visible surface. Asserts each expected testID is present + has
    // both a non-empty role (or implicit-role tag) AND a non-empty aria-label. Records missing
    // labels/roles into `allMissing` so the final summary is a single throw with the full list
    // (one throw per element would stop the census at the first miss).
    async function census(surface) {
      // The header account chip is chrome on every surface EXCEPT the landing screen: Home states
      // the HOME CURRENCY in its own headline, and the chip states the SELECTION — two different
      // accounts, so only one of them renders there (founder, 2026-09-09; flow 158 pins it).
      // Home's own `btn-home-accounts` carries the route instead, and is censused below.
      const expected = [
        ...SURFACES.chrome,
        ...(surface === 'homeTab' ? [] : ['balance']),
        ...(SURFACES[surface] || []),
      ];
      const found = await driver.eval((testids) => {
        const out = {};
        for (const id of testids) {
          const el = document.querySelector(`[data-testid="${CSS.escape(id)}"]`);
          if (!el) { out[id] = null; continue; }
          out[id] = {
            tag: el.tagName,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
          };
        }
        return out;
      }, expected);
      for (const id of expected) {
        const hit = found[id];
        if (!hit) {
          allMissing.push({surface, testid: id, missing: ['present']});
          continue;
        }
        const hasRole = (hit.role && hit.role.length > 0) || IMPLICIT_ROLE_TAGS.has(hit.tag);
        const hasLabel = hit.ariaLabel && hit.ariaLabel.length > 0;
        const missing = [];
        if (!hasRole) missing.push('role');
        if (!hasLabel) missing.push('aria-label');
        if (missing.length > 0) allMissing.push({surface, testid: id, missing, tag: hit.tag});
        allChecked.push({surface, testid: id, role: hit.role ?? `(${hit.tag})`, label: hit.ariaLabel});
      }
    }

    // 1. The Pay scanner (the harness preamble leaves the app here; the app itself lands on Home).
    await census('home');
    console.log('[41-a11y-census] ✓ census: wallet home (Pay)');

    // 1b. Home tab — the landing surface.
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-headline-amount', { timeoutMs: 5_000 });
    await census('homeTab');
    console.log('[41-a11y-census] ✓ census: home tab (the landing overview)');

    // 1c. The accounts route — one tap from Home, and from every other screen via the header chip.
    await driver.click('btn-home-accounts', { timeoutMs: 4_000 });
    await driver.findByTestID('accounts-list', { timeoutMs: 5_000 });
    await census('accounts');
    console.log('[41-a11y-census] ✓ census: accounts route');
    await driver.click('btn-accounts-back', { timeoutMs: 4_000 });

    // 2. Receive + currency picker (open via req-prefix → modal).
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    // Wait for the Receive form to mount before opening the picker.
    await driver.findByTestID('req-prefix', { timeoutMs: 4_000 });
    await driver.click('req-prefix', { timeoutMs: 4_000 });
    // The picker is a fade-in <Modal>; the picker rows are present immediately. Wait for one.
    await driver.findByTestID('req-pick-demo', { timeoutMs: 4_000 });
    await census('receive');
    console.log('[41-a11y-census] ✓ census: receive + currency picker');
    // Dismiss the picker (Esc is wired via useEscapeToClose in ReceiveMode).
    await driver.pressKey('Escape');

    // 3. Settings sheet (open via btn-settings). Expand the Advanced disclosure so the census
    //    covers settings-relay + btn-relay-apply (the founder-directed default is collapsed).
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-relay', { timeoutMs: 4_000 });
    await census('settings');
    console.log('[41-a11y-census] ✓ census: settings');

    // 3b. Settings → Reset confirmation dialog (tapping btn-reset reveals btn-reset-confirm + -cancel).
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-reset-confirm', { timeoutMs: 4_000 });
    await census('settingsResetConfirm');
    console.log('[41-a11y-census] ✓ census: settings reset confirmation');
    // Cancel out of the dialog (Esc is NOT wired for this; tap the explicit cancel button), and
    // WAIT for it to actually go: the confirmation replaces the settings body, so the Restore
    // section below cannot render until this dialog is gone. Without the intermediate wait the two
    // steps — "the dialog collapses" and "the section renders" — shared one 4s budget, and under
    // contention the census died on the second while the first was still finishing (observed RED,
    // 2026-09-01).
    await driver.click('btn-reset-cancel', { timeoutMs: 4_000 });
    await driver.waitGone('btn-reset-confirm', { timeoutMs: 6_000 });

    // 3c. Settings → Restore confirmation form (tapping btn-settings-restore reveals the seed input
    //     + btn-settings-restore-confirm + -cancel). Mirrors the reset-confirm census above for the
    //     new Restore section (Issue 1: wallet recovery is barely visible). Cancel collapses the form.
    await driver.findByTestID('btn-settings-restore', { timeoutMs: 4_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-restore-seed-input', { timeoutMs: 4_000 });
    await census('settingsRestoreConfirm');
    console.log('[41-a11y-census] ✓ census: settings restore confirmation');
    await driver.click('btn-settings-restore-cancel', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 4. Transactions tab (empty for a fresh wallet).
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    // Empty wallet renders "No payments yet." — a brief best-effort wait (no assertion; the census
    // only counts interactive controls, and the empty state has none beyond chrome).
    await driver.waitForText('No payments yet', { timeoutMs: 3_000 }).catch(() => {});
    await census('transactions');
    console.log('[41-a11y-census] ✓ census: transactions (empty wallet)');

    // 5. Pay → "Send to address" for the funded VCHF row. Selecting the asset in the accounts
    //    route is the only way to make it active (the row is one whole select Pressable),
    //    and the sub-mode toggle is what opens the send form. Run LAST so it cannot perturb the
    //    surfaces above.
    await openBalances(driver);
    await selectCurrency(driver, SEND_ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });
    await census('paySend');
    console.log('[41-a11y-census] ✓ census: pay → send to address');

    // 5b. The same form once a destination resolves — the address book's optional name field
    //     appears only then, exactly as the settings confirm-gates reveal their children.
    await driver.type('send-address-input', await railPrincipalText(SEND_RECIPIENT_PUBKEY), { timeoutMs: 4_000 });
    await driver.findByTestID('send-save-name', { timeoutMs: 6_000 });
    await census('paySendResolved');
    console.log('[41-a11y-census] ✓ census: pay → send to address (destination resolved)');

    // Final report + verdict.
    const checked = allChecked.length;
    const missingCount = allMissing.length;
    console.log(`[41-a11y-census] census: ${checked} interactive elements checked across ${Object.keys(SURFACES).length} surfaces; ${missingCount} missing label/role.`);
    if (missingCount > 0) {
      const lines = allMissing.map(m => `  - [${m.surface}] ${m.testid}: missing ${m.missing.join(' + ')}${m.tag ? ` (tag=${m.tag})` : ''}`);
      throw new Error(`[41-a11y-census] ${missingCount} interactive element(s) missing role/aria-label:\n${lines.join('\n')}`);
    }
    assert(checked > 0, 'census should have checked at least one element (sanity: the chrome set must be non-empty)');

    await driver.screenshot('41-a11y-census');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[41-a11y-census] GREEN in ${elapsed}s (${checked} elements, all carry role + aria-label)`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[41-a11y-census] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
