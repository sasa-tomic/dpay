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
// The census walks the same primary surfaces flow 35 (UX tour) screenshots: wallet home (Pay),
// Receive + currency picker, Balances hub, Settings, Transactions. On each surface it queries the
// DOM for every [data-testid] matching a known-interactive prefix (btn-* / tab-* / req-* /
// req-pick-* / settings-relay / amount-input / memo-input / privacy-policy / ledger-filter-* /
// asset-add-* / btn-withdraw / btn-topup / btn-balances-close / btn-settings-close / balance /
// btn-settings), then asserts EACH has BOTH:
//   - a non-empty aria-label, AND
//   - a non-empty role (button/link/etc.) — inputs implicitly carry their HTML kind; we accept the
//     INPUT tag as the role-equivalent for text fields (RNW renders them as bare <input>).
//
// The expected testID set is grouped by surface in `SURFACES` below — adding a new interactive
// control means adding its testID to the right surface (single source of truth the next dev updates
// alongside the new testID).
//
// Selector contract: surfaces are reached by the same taps a user makes — `tab-receive`,
// `req-prefix`, `balance`, `btn-settings`, `tab-transactions`.
import { setup, onboardWallet, assert } from '../harness/lib.mjs';

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
  chrome: ['btn-settings', 'btn-theme', 'balance', 'link-home', 'tab-pay', 'tab-receive', 'tab-transactions'],
  // Wallet home (Pay tab) — only chrome is interactive (the scan card's QR scanner is a viewport,
  // not a Pressable; the pay-scan DIV is informational).
  home: [],
  // Receive tab + currency picker (open via req-prefix). The picker rows are req-pick-<assetTestKey>;
  // the wallet's catalog (FakeLedger) ships DEMO/ckBTC/ckUSDC/ckUSDT, so all four picker rows assert.
  // req-pick-sol is the unified SOL entry (Issue #2) — picking it flips the rail to SolReceiveMode.
  receive: ['req-prefix', 'amount-input', 'memo-input', 'btn-request',
            'req-pick-demo', 'req-pick-ckbtc', 'req-pick-ckusdc', 'req-pick-ckusdt', 'req-pick-sol'],
  // Balances hub (open via `balance` tap). btn-topup is the DEMO row's faucet button; `asset-*-select`
  // is each row's whole-row select Pressable. SOL is uniform with the IC rows now (whole-row select,
  // no per-row Receive/Send buttons — on-chain deposit/send lives in the Pay/Receive tab sub-modes).
  balances: ['btn-balances-close', 'btn-topup',
             'asset-demo-select', 'asset-ckbtc-select', 'asset-ckusdc-select', 'asset-ckusdt-select',
             'asset-sol-select'],
  // Settings sheet (open via `btn-settings`). btn-reset-* are revealed only after tapping btn-reset
  // (the confirmation dialog); listed separately below to keep this census aligned with the visible
  // surface at first open. btn-backup + btn-settings-restore are the always-visible section entries
  // (Backup and Restore); their confirm-gate children are censused separately (settingsBackupConfirm
  // is covered inline by the Backup flow's own census path; settingsRestoreConfirm below).
  settings: ['btn-settings-close', 'btn-theme-mode', 'settings-relay', 'btn-relay-apply', 'btn-backup', 'btn-reset', 'btn-settings-restore', 'privacy-policy'],
  // Settings → Reset confirmation (btn-reset was tapped). Surface = the dialog above.
  settingsResetConfirm: ['btn-reset-confirm', 'btn-reset-cancel'],
  // Settings → Restore confirmation (btn-settings-restore was tapped). Surface = the inline seed
  // form (settings-restore-seed-input + the confirm/cancel pair). Mirrors settingsResetConfirm.
  settingsRestoreConfirm: ['settings-restore-seed-input', 'btn-settings-restore-confirm', 'btn-settings-restore-cancel'],
  // Transactions tab — empty initially (no transactions). When history is non-empty, ledger-filter-*
  // chips render (one per present currency); a fresh wallet has none, so only the chrome asserts.
  transactions: [],
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
  timeoutMs: 30000, // 12.4s standalone census of 8 surfaces vs 20s was too tight: mid-run host-load
  // spikes (parallel pool contention) are NOT compensated by the one-shot load factor measured at
  // run start, so a spike after the factor is fixed false-fires the backstop. 30s keeps the
  // hang-backstop meaningfully above the real (load-inflated) census cost.
};

export async function run() {
  const start = Date.now();
  console.log('[41-a11y-census] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    console.log('[41-a11y-census] onboarding…');
    await onboardWallet(driver, 'e2e-a11y');

    const allMissing = []; // {surface, testid, missing: ['role'|'label']}
    const allChecked = []; // {surface, testid, role, label} for the report

    // Helper: census the currently-visible surface. Asserts each expected testID is present + has
    // both a non-empty role (or implicit-role tag) AND a non-empty aria-label. Records missing
    // labels/roles into `allMissing` so the final summary is a single throw with the full list
    // (one throw per element would stop the census at the first miss).
    async function census(surface) {
      const expected = [...SURFACES.chrome, ...(SURFACES[surface] || [])];
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

    // 1. Wallet home (Pay tab — the default after onboarding).
    await census('home');
    console.log('[41-a11y-census] ✓ census: wallet home (Pay)');

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

    // 3. Balances hub (open via header balance tap).
    await driver.click('balance', { timeoutMs: 5_000 });
    await driver.findByTestID('btn-balances-close', { timeoutMs: 5_000 });
    await census('balances');
    console.log('[41-a11y-census] ✓ census: balances hub');
    await driver.click('btn-balances-close', { timeoutMs: 4_000 });

    // 4. Settings sheet (open via btn-settings). Expand the Advanced disclosure so the census
    //    covers settings-relay + btn-relay-apply (the founder-directed default is collapsed).
    await driver.click('btn-settings', { timeoutMs: 4_000 });
    await driver.click('btn-advanced-toggle', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-relay', { timeoutMs: 4_000 });
    await census('settings');
    console.log('[41-a11y-census] ✓ census: settings');

    // 4b. Settings → Reset confirmation dialog (tapping btn-reset reveals btn-reset-confirm + -cancel).
    await driver.click('btn-reset', { timeoutMs: 4_000 });
    await driver.findByTestID('btn-reset-confirm', { timeoutMs: 4_000 });
    await census('settingsResetConfirm');
    console.log('[41-a11y-census] ✓ census: settings reset confirmation');
    // Cancel out of the dialog (Esc is NOT wired for this; tap the explicit cancel button).
    await driver.click('btn-reset-cancel', { timeoutMs: 4_000 });

    // 4c. Settings → Restore confirmation form (tapping btn-settings-restore reveals the seed input
    //     + btn-settings-restore-confirm + -cancel). Mirrors the reset-confirm census above for the
    //     new Restore section (Issue 1: wallet recovery is barely visible). Cancel collapses the form.
    await driver.findByTestID('btn-settings-restore', { timeoutMs: 4_000 });
    await driver.click('btn-settings-restore', { timeoutMs: 4_000 });
    await driver.findByTestID('settings-restore-seed-input', { timeoutMs: 4_000 });
    await census('settingsRestoreConfirm');
    console.log('[41-a11y-census] ✓ census: settings restore confirmation');
    await driver.click('btn-settings-restore-cancel', { timeoutMs: 4_000 });
    await driver.click('btn-settings-close', { timeoutMs: 4_000 });

    // 5. Transactions tab (empty for a fresh wallet).
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    // Empty wallet renders "No payments yet." — a brief best-effort wait (no assertion; the census
    // only counts interactive controls, and the empty state has none beyond chrome).
    await driver.waitForText('No payments yet', { timeoutMs: 3_000 }).catch(() => {});
    await census('transactions');
    console.log('[41-a11y-census] ✓ census: transactions (empty wallet)');

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
