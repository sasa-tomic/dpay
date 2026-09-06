// UX evidence capture — drives the REAL app (shared relay + web + headless browser, zero mocks)
// through every Trip Ready surface and screenshots each at a phone viewport (390×844) AND a desktop
// viewport (1280×900). The phone shots are the "what the user sees" baseline; the desktop shots are
// the evidence pack for the founder-reported "screens show up outside the app screen" bug (RN-web
// <Modal> portals render full-viewport, escaping App.tsx's centered 480px app column).
//
// Usage: node e2e/debug/ux-capture.mjs          (writes e2e/shots/ux/*.png)
//
// Not part of `just e2e` — a debugging/evidence tool like the other e2e/debug scripts.
import { mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, stopSession, openBalances } from '../harness/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shots', 'ux');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// driver.screenshot writes flat to e2e/shots/<name>.png — relocate into shots/ux/ (the shared
// driver stays untouched; every other caller wants the flat layout).
async function shoot(driver, name) {
  const flat = await driver.screenshot(name);
  const dest = join(OUT, `${name}.png`);
  renameSync(flat, dest);
  console.log(`[ux-capture] 📸 ${name}`);
}

async function run() {
  const env = await setup();
  try {
    const { driver } = env;

    // ---- Phase A: first-run journey at PHONE viewport (390×844 — the default) ----------------
    await driver.findByTestID('walkthrough', { timeoutMs: 10_000 });
    await sleep(1200); // entrance animation settle
    await shoot(driver, 'A01-phone-walk-scene1');
    await driver.click('btn-walkthrough-next'); await sleep(1000);
    await shoot(driver, 'A02-phone-walk-scene2');
    await driver.click('btn-walkthrough-next'); await sleep(1000);
    await shoot(driver, 'A03-phone-walk-scene3');
    await driver.click('btn-walkthrough-next'); // "Get started"
    await driver.findByTestID('username-input', { timeoutMs: 8_000 });
    await shoot(driver, 'A04-phone-create-form');
    await driver.typeByPlaceholder('e.g. Alice', 'ux');
    await driver.click('btn-create');
    await driver.findByTestID('mnemonic-backup', { timeoutMs: 8_000 });
    await shoot(driver, 'A05-phone-mnemonic-backup');
    await driver.click('mnemonic-backup-checkbox');
    await sleep(300);
    await driver.click('btn-mnemonic-continue');
    // RECOVERY SAVED beat plays ~750ms then auto-advances — catch it mid-flight.
    await sleep(350);
    await shoot(driver, 'A06-phone-recovery-beat');
    await driver.findByTestID('rehearsal', { timeoutMs: 15_000 });
    await sleep(1200);
    // One-page rehearsal: a single shot carries all 3 steps + punchline + CTA.
    await shoot(driver, 'A07-phone-rehearsal-page');
    await driver.click('btn-rehearsal-next'); // "Try with demo funds"
    await driver.findByTestID('balance', { timeoutMs: 15_000 });
    await driver.waitForText('∂100.00', { timeoutMs: 15_000 });
    await sleep(600);
    await shoot(driver, 'A10-phone-wallet-pay');

    // Receive tab → receiveRequest coach tip (one-time card). DEMO has no on-chain address mode,
    // so no btn-receive-address here — the tab surface itself + the coach card is the shot.
    await driver.click('tab-receive');
    await sleep(1200);
    await shoot(driver, 'A11-phone-receive-coach');

    // Home tab accounts list (O4 S3 — the ex-Balances sheet, inline now).
    await driver.click('tab-pay');
    await openBalances(driver);
    await sleep(700);
    await shoot(driver, 'A12-phone-home-accounts');
    await driver.click('tab-pay');

    // TripStrip (home) → the archive (the strip is the live entry; the archive the record).
    await driver.findByTestID('trip-strip', { timeoutMs: 5_000 });
    await shoot(driver, 'A12b-phone-trip-strip');
    await driver.click('btn-trip-strip');
    await driver.findByTestID('passport-archive', { timeoutMs: 8_000 });
    await sleep(800);
    await shoot(driver, 'A15-phone-passport-archive');
    await driver.click('btn-passport-close');

    // Settings → sheet, How-it-works replay, Trip readiness archive.
    await driver.click('btn-settings');
    await driver.findByTestID('btn-settings-close', { timeoutMs: 5_000 });
    await sleep(500);
    await shoot(driver, 'A13-phone-settings-sheet');
    await driver.click('btn-how-it-works');
    await driver.findByTestID('walkthrough', { timeoutMs: 8_000 });
    await sleep(1000);
    await shoot(driver, 'A14-phone-settings-replay');
    await driver.click('btn-walkthrough-close');
    await driver.findByTestID('btn-trip-readiness', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness');
    await driver.findByTestID('passport-archive', { timeoutMs: 8_000 });
    await sleep(800);
    await shoot(driver, 'A15-phone-passport-archive');
    await driver.click('btn-passport-close');
    await driver.click('btn-settings-close');

    // ---- Phase B: the SAME surfaces at DESKTOP viewport (1280×900) — the Modal-escape evidence --
    await driver.page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await sleep(700);
    await shoot(driver, 'B01-desktop-wallet-pay');
    await driver.click('btn-settings');
    await driver.findByTestID('btn-settings-close', { timeoutMs: 5_000 });
    await sleep(500);
    await shoot(driver, 'B02-desktop-settings-sheet');
    await driver.click('btn-how-it-works');
    await driver.findByTestID('walkthrough', { timeoutMs: 8_000 });
    await sleep(1000);
    await shoot(driver, 'B03-desktop-settings-replay');
    await driver.click('btn-walkthrough-close');
    await driver.findByTestID('btn-trip-readiness', { timeoutMs: 5_000 });
    await driver.click('btn-trip-readiness');
    await driver.findByTestID('passport-archive', { timeoutMs: 8_000 });
    await sleep(800);
    await shoot(driver, 'B04-desktop-passport-archive');
    await driver.click('btn-passport-close');
    // Home tab accounts list at desktop for comparison.
    await driver.click('btn-settings-close');
    await driver.click('tab-home');
    await sleep(700);
    await shoot(driver, 'B05-desktop-home-accounts');
    await driver.click('tab-pay');

    console.log(`[ux-capture] done — ${OUT}`);
  } finally {
    await env.stop();
    await stopSession();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
