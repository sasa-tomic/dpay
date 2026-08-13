// Flow 75 — seam fail-loud regression guard.
//
// Every test-injection seam (`__DPAY_TEST_SCAN` / `__DPAY_TEST_NFC_SESSION` /
// `__DPAY_TEST_SOL_NFC_SESSION`) MUST throw an actionable error when no target component is
// mounted (listeners=0). Without this guard, a dropped payload is SILENTLY LOST — the flow hangs
// and times out with an opaque error, or passes on stale UI. That exact class of bug let the SOL
// QR-scanner regression sail through review (commit ed43734 fixed the camera seam; this flow locks
// the contract for ALL seams).
//
// This flow boots the app to Onboarding WITHOUT calling `onboardWallet`, so the Wallet (and its
// QrScanner/NfcTap/SolNfcTap listeners) never mounts. It then calls each seam and asserts the
// throw fires with a message naming the missing component. If anyone weakens a seam back to a
// silent-drop (e.g. re-introducing a swallowing `try/catch`), this flow goes RED immediately.
import { setup, assert, assertIncludes } from '../harness/lib.mjs';

export const meta = {
  id: '75',
  name: 'seam-fail-loud',
  journey: 'system',
  covers: ['seam-integrity', 'fail-loud', 'regression-guard'],
  verifies: 'Every injection seam (scan/NFC/SOL-NFC) throws when no listener is mounted — regression guard against silent-drop bugs.',
  timeoutMs: 30000,
};

// Call a seam inside the page, capturing whether it threw (instead of letting the throw escape as
// an uncaught page error). Returns { threw, message }.
async function probeSeam(driver, seamGlobal, payload) {
  return await driver.eval((g, p) => {
    try {
      window[g](p);
      return { threw: false, message: '' };
    } catch (e) {
      return { threw: true, message: e.message };
    }
  }, seamGlobal, payload);
}

export async function run() {
  const start = Date.now();
  console.log('[75-seam-fail-loud] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver } = env;

    // Confirm the shims installed (the app booted to Onboarding, but shims.ts runs before any
    // screen). If a global is missing, the app never bootstrapped — fail loud with a precise msg.
    const seams = await driver.eval(() => ({
      scan: typeof window.__DPAY_TEST_SCAN,
      nfc: typeof window.__DPAY_TEST_NFC_SESSION,
      solNfc: typeof window.__DPAY_TEST_SOL_NFC_SESSION,
    }));
    assert(seams.scan === 'function', `__DPAY_TEST_SCAN must be a function (got ${seams.scan}); the camera shim failed to install`);
    assert(seams.nfc === 'function', `__DPAY_TEST_NFC_SESSION must be a function (got ${seams.nfc}); the NFC shim failed to install`);
    assert(seams.solNfc === 'function', `__DPAY_TEST_SOL_NFC_SESSION must be a function (got ${seams.solNfc}); the SOL NFC shim failed to install`);
    console.log('[75-seam-fail-loud] ✓ all three injection seams installed');

    // No Wallet mounted (Onboarding only) → every listener count MUST be 0. This is the
    // precondition for the fail-loud probe below.
    const counts = await driver.eval(() => ({
      scan: window.__DPAY_TEST_SCAN_COUNT(),
      nfc: window.__DPAY_TEST_NFC_COUNT(),
      solNfc: window.__DPAY_TEST_SOL_NFC_COUNT(),
    }));
    assert(counts.scan === 0, `scan listener count must be 0 with no Wallet mounted (got ${counts.scan})`);
    assert(counts.nfc === 0, `IC NFC listener count must be 0 with no Wallet mounted (got ${counts.nfc})`);
    assert(counts.solNfc === 0, `SOL NFC listener count must be 0 with no Wallet mounted (got ${counts.solNfc})`);
    console.log('[75-seam-fail-loud] ✓ all listener counts are 0 (Onboarding only, no Wallet)');

    // SCAN seam: must throw (no QrScanner mounted).
    {
      const r = await probeSeam(driver, '__DPAY_TEST_SCAN', 'https://example.com/req');
      assert(r.threw, '__DPAY_TEST_SCAN must throw when no QrScanner is mounted (listeners=0)');
      assertIncludes(r.message, 'QrScanner', `scan seam error must name the missing component; got: ${r.message}`);
      console.log('[75-seam-fail-loud] ✓ scan seam throws: "…QrScanner…"');
    }

    // IC NFC seam: must throw (no NfcTap mounted).
    {
      const r = await probeSeam(driver, '__DPAY_TEST_NFC_SESSION', { type: 'phase', role: 'card', phase: 'linking' });
      assert(r.threw, '__DPAY_TEST_NFC_SESSION must throw when no NfcTap is mounted (listeners=0)');
      assertIncludes(r.message, 'NfcEvent', `IC NFC seam error must name the missing event listener; got: ${r.message}`);
      console.log('[75-seam-fail-loud] ✓ IC NFC seam throws: "…NfcEvent…"');
    }

    // SOL NFC seam: must throw (no SolNfcTap mounted).
    {
      const r = await probeSeam(driver, '__DPAY_TEST_SOL_NFC_SESSION', { type: 'phase', role: 'card', phase: 'linking' });
      assert(r.threw, '__DPAY_TEST_SOL_NFC_SESSION must throw when no SolNfcTap is mounted (listeners=0)');
      assertIncludes(r.message, 'NfcEvent', `SOL NFC seam error must name the missing event listener; got: ${r.message}`);
      console.log('[75-seam-fail-loud] ✓ SOL NFC seam throws: "…NfcEvent…"');
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[75-seam-fail-loud] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[75-seam-fail-loud] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
