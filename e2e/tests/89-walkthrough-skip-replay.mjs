// 89 — Trip Ready J1: walkthrough Skip path + persistence + the Settings "How dpay works" replay.
//
// Three phases in one flow (each on a FRESH setup context — the harness supports re-onboarding):
//   A. fresh boot → Skip IMMEDIATELY (scene 1, zero Next taps) → the create form appears at once.
//      Skip awards walkthroughDone too — the walkthrough is educational, not a gate.
//   B. a second fresh context, but pre-seed dpay.journey.v1 with the walkthroughDone stamp BEFORE
//      first render: the walkthrough must NOT show (persisted gate — no second showing, ever).
//   C. onboard a wallet, open Settings → "How dpay works" → the replay Modal renders the SAME
//      walkthrough (scene 1 + body copy pinned) with a CLOSE affordance and NO Skip; close returns
//      to Settings; the journey store is UNCHANGED by replay (replay never awards anything).
//
// Selector contract: `btn-walkthrough-skip`, `btn-walkthrough-close`, `btn-how-it-works`,
// `walkthrough-scene-1`, `walkthrough-body-1`, plus the existing settings + onboarding net.
import { setup, assert, assertIncludes, onboardWallet } from '../harness/lib.mjs';

export const meta = {
  id: 89,
  name: 'Walkthrough skip, persistence, and Settings replay',
  journey: 'onboard',
  covers: ['walkthrough', 'education', 'settings-replay', 'journey-stamps', 'skip-path'],
  verifies: [
    'Skip dismisses the walkthrough instantly and reveals the create form',
    'Skip also persists walkthroughDone',
    'a pre-seeded walkthroughDone stamp suppresses the walkthrough on the next boot',
    'Settings → How dpay works replays the walkthrough with a close affordance and no Skip',
    'the replay leaves the journey store unchanged',
  ],
  timeoutMs: 90000,
};

export async function run() {
  // ── Phase A — Skip on sight ──────────────────────────────────────────────────────────────
  {
    const env = await setup({ lazyBoot: false });
    try {
      const { driver } = env;
      await driver.findByTestID('walkthrough-scene-1', { timeoutMs: 10_000 });
      console.log('[89-walkthrough-skip] phase A: walkthrough showing');
      await driver.click('btn-walkthrough-skip', { timeoutMs: 5_000 });
      await driver.waitGone('walkthrough', { timeoutMs: 5_000 });
      await driver.typeByPlaceholder('e.g. Alice', 'skipper', { timeoutMs: 8_000 });
      console.log('[89-walkthrough-skip] ✓ Skip → create form immediately');
      const journey = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
      assertIncludes(journey ?? '', 'walkthroughDone', 'Skip also awards walkthroughDone');
      await driver.screenshot('89-skip-form');
    } finally {
      await env.stop();
    }
  }

  // ── Phase B — persisted stamp suppresses the walkthrough ────────────────────────────────
  {
    const env = await setup({ lazyBoot: false });
    try {
      const { driver, webBaseURL, relayBaseURL } = env;
      // Pre-seed the stamp BEFORE the next first-render (same origin, then hard-navigate back).
      await driver.eval(
        (url) => {
          localStorage.setItem('dpay.journey.v1', JSON.stringify({stamps: ['walkthroughDone'], at: {walkthroughDone: 1}}));
          window.location.href = url;
        },
        `${webBaseURL}/?relay=${encodeURIComponent(relayBaseURL)}`,
      );
      // Wait for the CREATE FORM first (proves we're on the new document), then assert the
      // walkthrough never mounted — asserting absence first would race the old page.
      await driver.findByTestID('username-input', { timeoutMs: 10_000 });
      assert(!(await driver.isPresent('walkthrough')), 'persisted walkthroughDone must suppress the walkthrough');
      console.log('[89-walkthrough-skip] ✓ phase B: persisted stamp → straight to the create form');
    } finally {
      await env.stop();
    }
  }

  // ── Phase C — the Settings replay ────────────────────────────────────────────────────────
  {
    const env = await setup({ lazyBoot: false });
    try {
      const { driver } = env;
      await onboardWallet(driver, 'replayer');
      await driver.click('btn-settings', { timeoutMs: 5_000 });
      await driver.findByTestID('btn-how-it-works', { timeoutMs: 5_000 });
      console.log('[89-walkthrough-skip] phase C: Settings shows "How dpay works"');

      await driver.click('btn-how-it-works', { timeoutMs: 5_000 });
      await driver.findByTestID('walkthrough-scene-1', { timeoutMs: 5_000 });
      const body1 = await driver.readText('walkthrough-body-1');
      assertIncludes(body1, 'other phone shows a request', 'replay renders the same education copy');
      assert(!(await driver.isPresent('btn-walkthrough-skip')), 'replay must have NO Skip');
      await driver.findByTestID('btn-walkthrough-close', { timeoutMs: 5_000 });
      console.log('[89-walkthrough-skip] ✓ replay: scene 1 + close affordance, no Skip');

      const before = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
      await driver.click('btn-walkthrough-close', { timeoutMs: 5_000 });
      await driver.waitGone('walkthrough', { timeoutMs: 5_000 });
      await driver.findByTestID('btn-how-it-works', { timeoutMs: 5_000 });
      const after = await driver.eval(() => localStorage.getItem('dpay.journey.v1'));
      assertEqSafe(before, after);
      console.log('[89-walkthrough-skip] ✓ replay closes back to Settings; journey unchanged');
      await driver.screenshot('89-replay-closed');
    } finally {
      await env.stop();
    }
  }
}

function assertEqSafe(a, b) {
  if (a !== b) throw new Error(`[89-walkthrough-skip] journey changed across replay: ${a} → ${b}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
