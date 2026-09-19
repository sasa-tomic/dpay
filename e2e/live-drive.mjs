#!/usr/bin/env node
// e2e/live-drive.mjs — LIVE mainnet driver for the agent test float (FX-matrix phase 1).
//
// NOT part of the offline e2e suite — this drives the REAL app (built from app/ via the same
// vite pipeline as the harness) against a REAL relay (default http://127.0.0.1:8899) with REAL
// funds. Every op it performs MUST be logged in docs/AGENT-FUNDS.md (float rules in CLAUDE.md).
//
// Seed discipline: the IC float seed is decrypted INSIDE this process (execFileSync capture) and
// typed straight into the restore input. It is never printed, logged, or written to disk.
//
// Usage: node e2e/live-drive.mjs <cmd> [args]
//   boot                       restore the float, verify principal, print measured balances
//   probe <src> <amount>       open Convert for <src>, type <amount>, dump dest-route options
//   conv-a                     ckUSDC→VCHF via pool hx7nb (~0.1 ckUSDC)
//   conv-b <icp>               ICP→SOL via venue sideshift (founder-approved shift), incl. the
//                              app-signed deposit icrc1_transfer + shift watch to settlement
//   conv-c1 <sol>              SOL→USDC (Jupiter) on the device-signed SOL rail
//   conv-c2 <usdc>             USDC→EURC (Jupiter)
//   conv-c3 <eurc>             EURC→USDC (Jupiter, round-trip proof)
//   watch                      re-open Convert and follow the parked record (resume engine)
//
// Env: DPAY_LIVE_RELAY (default http://127.0.0.1:8899), DPAY_LIVE_WEB (pin the sirv port).
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {mkdirSync} from 'node:fs';

const E2E = dirname(fileURLToPath(import.meta.url));
const ROOT = join(E2E, '..');
const SHOTS = join(E2E, 'shots');
mkdirSync(SHOTS, {recursive: true});

const RELAY = process.env.DPAY_LIVE_RELAY ?? 'http://127.0.0.1:8899';
const FLOAT_PRINCIPAL = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
// The app's OWN Solana rail address: SLIP-10 ed25519 m/44'/501'/0'/0' of the IC float seed
// (app/solana/identity.ts; ConvertMode.tsx:497 derives the CeFi settle address the same way).
// VERIFIED in-process 2026-09-20: deriveSolanaKeypair(IC float seed) → exactly this address.
// NOTE the divergence from the registered `sol-float` wallet (4Cuacz…, an independent raw-seed
// key the app can never sign from) — see the docs/AGENT-FUNDS.md finding; measured live via
// `node e2e/live-sol.mjs`.
const SOL_SETTLE = 'BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX';

const {buildWeb, serveWeb} = await import('./harness/web.mjs');
const {Driver} = await import('./harness/driver.mjs');
const {openBalances, selectCurrency, accountOf, railPrincipalText} = await import('./harness/lib.mjs');
const {icpPrincipalBytes, principalToText} = await import('./harness/wire.mjs');

const log = (...a) => console.log(`[live ${new Date().toISOString().slice(11, 19)}]`, ...a);

function runCapture(cmd, args) {
  // execFileSync with capture: output NEVER reaches a terminal or a file.
  return execFileSync(cmd, args, {encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
}

/** The float's IC seed hex, decrypted at the moment of restore. NEVER print. */
function floatSeed() {
  const hex = runCapture('node', ['scripts/agent-key.mjs', 'seed']).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('floatSeed: agent-key seed did not return 64 hex chars — refusing');
  return hex;
}

async function agentBalance() {
  return runCapture('just', ['agent-balance']);
}
async function agentFunds() {
  return runCapture('just', ['agent-funds']);
}
async function agentHistory() {
  return runCapture('just', ['agent-history']);
}

/** pubkey hex (the account hex every IC route keys on) from the seed hex. */
async function pubHexOf(seedHex) {
  const ed = await import('@noble/ed25519');
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  const pub = await ed.getPublicKeyAsync(seed);
  let out = '';
  for (const b of pub) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Relay-side measured balances for the float (the app's own poll route). */
async function relayBalances(pubHex) {
  const r = await fetch(`${RELAY}/api/v1/balances/${pubHex}`, {signal: AbortSignal.timeout(15_000)});
  const body = await r.text();
  return {status: r.status, body};
}

// ---------------------------------------------------------------------------
// boot: build + serve the app, launch a browser, restore the float via Onboarding.
// ---------------------------------------------------------------------------

async function startApp() {
  await buildWeb({});
  const web = await serveWeb(process.env.DPAY_LIVE_WEB ? {port: Number(process.env.DPAY_LIVE_WEB)} : {});
  const {browser, stop: stopBrowser} = await Driver.launchBrowser();
  const driver = await Driver.create(browser);
  return {driver, web, stopBrowser};
}

async function bootAndRestore(driver, base) {
  // The e2e shims point the app's /api/v2 envelope transport at ?relay= (the OFFLINE fake-IC
  // seam). This is LIVE: the plain relay build has no /api/v2, so the value path must go
  // device-direct to the real boundary. The app's own operator override (IC_GATEWAY_STORAGE_KEY,
  // applied by App.tsx before the wallet renders) outranks the test seam — seed it pre-load.
  await driver.addInitScript(() => {
    try { localStorage.setItem('dpay.icpGateway.v1', 'https://icp-api.io'); } catch { /* fresh ctx */ }
  });
  log(`navigating ${base}/?relay=${RELAY}`);
  await driver.navigate(base, `/?relay=${encodeURIComponent(RELAY)}`);
  await driver.waitReady();
  // First-run walkthrough (fresh browser context every run) — skip it instantly.
  try {
    await driver.findByTestID('walkthrough', {timeoutMs: 8_000});
    await driver.click('btn-walkthrough-skip');
    log('walkthrough skipped');
  } catch { /* already awarded */ }
  // Restore the float from its 64-hex seed through the REAL restore form.
  await driver.click('btn-restore');
  await driver.click('btn-restore-mode-toggle'); // hex input mode
  const seed = floatSeed();
  try {
    await driver.type('restore-seed-input', seed);
    await driver.click('btn-restore-confirm');
  } finally {
    seed.replace(/./g, '0'); // in-memory only hygiene; never logged anywhere
  }
  // The wallet lands on the first-run HOME-CURRENCY chooser (restore path skips backup gates),
  // then Home. Pick CHF (the float's home story) and continue when the chooser appears.
  try {
    await driver.findByTestID('btn-home-currency-continue', {timeoutMs: 8_000});
    await driver.click('home-currency-CHF');
    await driver.click('btn-home-currency-continue');
    log('home currency: CHF');
  } catch { /* chooser already answered */ }
  // Wait for Home (the headline IS the accounts affordance on this surface).
  await driver.findByTestID('btn-home-accounts', {timeoutMs: 20_000});
  // Verify the restored principal is THE float principal before anything else.
  const acct = await accountOf(driver);
  if (!acct?.secretHex) throw new Error('restore: no identity in storage after restore');
  const pubHex = await pubHexOf(acct.secretHex);
  const principal = await railPrincipalText(pubHex);
  if (principal !== FLOAT_PRINCIPAL) {
    throw new Error(`restore: WRONG WALLET restored (${principal}) — refusing to touch anything`);
  }
  log(`principal verified: ${principal}`);
  await driver.screenshot('live-restored');
  return {pubHex, principal};
}

async function withApp(fn) {
  const {driver, web, stopBrowser} = await startApp();
  try {
    const boot = await bootAndRestore(driver, web.baseURL);
    return await fn(driver, boot);
  } catch (e) {
    try { await driver.dumpDiagnostics('live-drive', e); } catch {}
    throw e;
  } finally {
    await web.stop().catch(() => {});
    await stopBrowser().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Convert helpers.
// ---------------------------------------------------------------------------

async function openConvert(driver, assetKey) {
  // The dance: accounts route → select the row (harness returns us to the PAY tab) → accounts
  // route again → the SELECTED row's convert action.
  await openBalances(driver);
  await selectCurrency(driver, assetKey);
  await openBalances(driver);
  await driver.click('btn-accounts-convert', {timeoutMs: 10_000});
  await driver.findByTestID('convert-screen', {timeoutMs: 10_000});
  log(`convert open for ${assetKey}`);
}

async function listDestRoutes(driver) {
  const routes = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid^="convert-dest-route-"]')).map((el) => ({
      id: el.getAttribute('data-testid'),
      text: (el.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
    })),
  );
  if (routes.length > 0) return routes;
  // Fallback visibility aid: every dest-picker testID on screen (the picker's row scheme is
  // other agents' territory — this only records what IS there, verbatim).
  const all = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid^="convert-dest"]')).map((el) => ({
      id: el.getAttribute('data-testid'),
      text: (el.innerText || '').replace(/\s*\n\s*/g, ' | ').trim().slice(0, 70),
    })),
  );
  console.log('[live] dest-picker testIDs (no route-* rows):', JSON.stringify(all, null, 1));
  return [];
}

async function pickDest(driver, substr, {timeoutMs = 15_000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Candidate scheme (this build): destination-currency rows `convert-dest-inwallet-<cur>`,
    // mechanism rows `convert-dest-mech-*`, and the older `convert-dest-route-*` rows. Prefer
    // the destination-currency row on a hit; the mechanism sub-picker defaults sensibly and
    // readQuote records exactly which route was chosen.
    const rows = await driver.eval(() =>
      Array.from(document.querySelectorAll('[data-testid^="convert-dest-"]')).map((el) => ({
        id: el.getAttribute('data-testid'),
        text: (el.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      })).filter((r) => r.id !== 'convert-dest' && r.id !== 'convert-dest-mechs'
        && r.id !== 'convert-dest-cross-note' && !r.id.endsWith('-address')
        && !r.id.endsWith('-invalid') && !r.id.startsWith('convert-dest-mechs')),
    );
    const rank = (id) => (id.startsWith('convert-dest-inwallet-') ? 0
      : id.startsWith('convert-dest-route-') ? 1 : 2);
    // Exact testID wins outright; otherwise a row that is a proper path-prefix of another row
    // (e.g. `:cctp` before `:cctp:jupiter`) is an intermediate, not a leaf — deprioritize it.
    const allIds = rows.map((r) => r.id);
    const isIntermediate = (id) => allIds.some((o) => o.startsWith(id + ':'));
    const hits = rows.filter((r) => r.id === String(substr)
        || r.id.includes(substr) || r.text.toLowerCase().includes(String(substr).toLowerCase()))
      .sort((a, b) => (rank(a.id) - rank(b.id))
        || ((a.id === substr ? 0 : 1) - (b.id === substr ? 0 : 1))
        || ((isIntermediate(a.id) ? 1 : 0) - (isIntermediate(b.id) ? 1 : 0)));
    if (hits.length > 0) {
      log(`dest picked: ${hits[0].id} — ${hits[0].text}`);
      await driver.click(hits[0].id);
      return hits[0];
    }
    if (Date.now() > deadline) {
      throw new Error(`pickDest: no dest row matching ${JSON.stringify(substr)}; options: ${JSON.stringify(rows, null, 2)}`);
    }
    await sleep(300);
  }
}

async function readQuote(driver, {timeoutMs = 20_000} = {}) {
  await driver.findByTestID('convert-headline', {timeoutMs});
  await sleep(1_200); // let the venue details settle
  const headline = await driver.readText('convert-headline');
  const body = await driver.bodyText();
  const venues = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid^="convert-venue-"][data-testid$="-quote"]')).map((el) => ({
      id: el.getAttribute('data-testid'),
      text: el.innerText,
    })),
  );
  return {headline, venues, body: body.slice(0, 4_000)};
}

async function watchConvert(driver, label, {timeoutMs, shotEveryMs = 60_000}) {
  const t0 = Date.now();
  let last = '';
  let lastShot = 0;
  for (;;) {
    for (const endId of ['convert-failed', 'convert-stuck']) {
      if (await driver.isPresent(endId)) {
        const text = await driver.readText(endId);
        await driver.screenshot(`live-${label}-${endId}`);
        return {ended: endId, text};
      }
    }
    if (await driver.isPresent('convert-done')) {
      const text = await driver.readText('convert-done');
      await driver.screenshot(`live-${label}-done`);
      return {ended: 'convert-done', text};
    }
    let step = '(form)';
    if (await driver.isPresent('convert-step')) step = await driver.readText('convert-step');
    else if (await driver.isPresent('convert-awaiting-deposit')) step = 'awaiting-deposit (cefi handoff)';
    else if (await driver.isPresent('convert-approving')) step = 'approving';
    else if (await driver.isPresent('convert-pending')) step = 'pending';
    if (step !== last) {
      log(`watch ${label}: ${step}`);
      last = step;
    }
    if (Date.now() - lastShot > shotEveryMs) {
      await driver.screenshot(`live-${label}-t${Math.round((Date.now() - t0) / 1000)}s`);
      lastShot = Date.now();
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`watchConvert(${label}): timeout after ${Math.round(timeoutMs / 1000)}s — last step: ${last}`);
    }
    await sleep(4_000);
  }
}

/** Read the CeFi deposit facts off the awaiting panel (verbatim strings). */
async function readDepositFacts(driver, {timeoutMs = 60_000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await driver.isPresent('convert-deposit-address')) {
      const depositAddress = (await driver.readText('convert-deposit-address')).trim();
      const depositAmountLine = await driver.isPresent('convert-deposit-amount')
        ? await driver.readText('convert-deposit-amount') : '';
      const depositMemo = await driver.isPresent('convert-deposit-memo')
        ? (await driver.readText('convert-deposit-memo')).trim() : null;
      return {depositAddress, depositAmountLine, depositMemo};
    }
    if (Date.now() > deadline) throw new Error('readDepositFacts: awaiting-deposit panel never appeared');
    await sleep(2_000);
  }
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdBoot() {
  await withApp(async (driver, {pubHex}) => {
    console.log(await agentBalance());
    const rb = await relayBalances(pubHex);
    console.log(`relay /api/v1/balances → ${rb.status}: ${rb.body.slice(0, 1_200)}`);
  });
}

async function cmdProbe(src, amount) {
  await withApp(async (driver) => {
    await openConvert(driver, src);
    await driver.type('convert-amount', amount);
    await sleep(3_000);
    const routes = await listDestRoutes(driver);
    console.log('dest routes:', JSON.stringify(routes, null, 2));
    // D2 evolution: click the crossrail route row and watch the picker + settle address appear.
    // The CeFi leaf is the FULL `:cctp:jupiter` row ("SOL — to your Solana address"); `:cctp`
    // alone is the USDC-on-Solana intermediate and clicking it does nothing visible.
    const row = routes.find((r) => r.id.endsWith(':jupiter'))
      ?? routes.find((r) => r.id.includes('multihop') || /sol/i.test(r.text));
    if (row) {
      log(`probe picks route row: ${row.id}`);
      await driver.click(row.id);
      for (let t = 0; t <= 45; t += 5) {
        await sleep(5_000);
        const all = await driver.eval(() =>
          Array.from(document.querySelectorAll('[data-testid^="convert-"]')).map((el) => el.getAttribute('data-testid'))
            .filter((id) => /mech|settle|route|dest/.test(id)),
        );
        const uniq = [...new Set(all)];
        console.log(`t+${t}s convert picker ids:`, JSON.stringify(uniq));
        if (uniq.some((id) => id === 'convert-settle-address' || id.startsWith('convert-dest-mech-'))) {
          const body = await driver.bodyText();
          console.log(`t+${t}s body slice:`, body.replace(/\s+/g, ' ').slice(0, 700));
          break;
        }
      }
      const q = await readQuote(driver, {timeoutMs: 30_000}).catch((e) => ({err: String(e)}));
      console.log('quote after D2 pick:', JSON.stringify(q, null, 2));
    }
    await driver.screenshot('live-probe');
  });
}

async function cmdA() {
  // OP A — ckUSDC→VCHF through pool hx7nb (completes every IC pool in BOTH directions).
  await withApp(async (driver) => {
    await openConvert(driver, 'ckusdc');
    await driver.type('convert-amount', '0.1');
    await pickDest(driver, 'vchf');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-a-quote');
    await driver.click('btn-convert-confirm');
    const res = await watchConvert(driver, 'a', {timeoutMs: 8 * 60_000});
    log(`OP A result: ${res.ended}: ${res.text}`);
    console.log('--- agent-balance after ---');
    console.log(await agentBalance());
  });
}

async function cmdB(icpAmount) {
  // OP B — ICP→SOL via venue sideshift (the FIRST live CeFi order). The app creates the shift;
  // the deposit is the float's OWN signed icrc1_transfer. Watch the shift to settlement.
  await withApp(async (driver) => {
    await openConvert(driver, 'icp');
    await driver.type('convert-amount', icpAmount);
    // The CeFi leaf is the FULL route id (flow 187's row): "SOL — to your Solana address".
    // 'sol' as a plain substring also matches the USDC-on-Solana intermediate — use the id.
    await pickDest(driver, 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter');
    // If a mechanism sub-picker appears, the CeFi rail is a mechanism choice — take sideshift.
    try {
      await driver.findByTestID('convert-dest-mechs', {timeoutMs: 4_000});
      await driver.click('convert-dest-mech-sideshift');
      log('mechanism: sideshift');
    } catch { /* single mechanism — already picked */ }
    // The CeFi surface replaces the venue-quote headline (flow 187's drive): settle address +
    // quote-source naming the venue. No convert-headline exists on this path.
    await driver.findByTestID('convert-settle-address', {timeoutMs: 30_000});
    const settleShown = (await driver.readText('convert-settle-address')).trim();
    if (settleShown !== SOL_SETTLE) {
      throw new Error(`OP B: settle address on screen ${JSON.stringify(settleShown)} != agent SOL wallet — refusing`);
    }
    log(`settle address verified: ${settleShown}`);
    // The venue quote rides the relay's /api/v1/sideshift/* proxy — allow it a moment to land.
    let qsrc = '(none)';
    for (let i = 0; i < 30; i++) {
      if (await driver.isPresent('convert-quote-source')) { qsrc = await driver.readText('convert-quote-source'); break; }
      await sleep(1_000);
    }
    log(`quote source: ${qsrc}`);
    if (!/SideShift/i.test(qsrc)) throw new Error('OP B: quote source is not SideShift — refusing');
    const cparty = await driver.isPresent('convert-counterparty')
      ? await driver.readText('convert-counterparty') : '(none)';
    log(`counterparty disclosure: ${cparty.replace(/\s+/g, ' ').slice(0, 300)}`);
    const body = await driver.bodyText();
    log('CEFI SURFACE:', body.replace(/\s+/g, ' ').slice(0, 600));
    await driver.screenshot('live-b-quote');
    await driver.click('btn-convert-confirm');

    // The shift order is created, then the panel waits for the deposit.
    const facts = await readDepositFacts(driver, {timeoutMs: 90_000});
    log('DEPOSIT FACTS:', JSON.stringify(facts, null, 2));
    await driver.screenshot('live-b-awaiting-deposit');
    const m = facts.depositAmountLine.match(/([\d.]+)\s*ICP/);
    if (!m) throw new Error(`OP B: cannot parse deposit amount from ${JSON.stringify(facts.depositAmountLine)}`);
    const depositAmount = m[1];

    // Was the deposit already sent by the app's confirm flow? (CeFi handoff design says the user
    // sends it — but measure, never assume.) agent-history shows recent ICP ledger transfers.
    const histBefore = agentHistory();
    if (histBefore.split('\n').filter(Boolean).length === 0) throw new Error('agent-history empty?');

    // Send the deposit through the app's OWN send surface (Pay ▸ Send to address) — a signed
    // icrc1_transfer to the venue's deposit address, exactly the amount the panel froze.
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    await driver.type('send-address-input', facts.depositAddress);
    await driver.type('send-amount-input', depositAmount);
    await sleep(1_000);
    const reviewTo = await driver.isPresent('send-review-to') ? await driver.readText('send-review-to') : '(no review)';
    log(`send review → ${reviewTo}`);
    await driver.screenshot('live-b-send-review');
    await driver.click('btn-send-confirm');
    await driver.findByTestID('send-outcome', {timeoutMs: 90_000});
    const outcome = await driver.readText('send-outcome');
    const blockLine = await driver.isPresent('send-block') ? await driver.readText('send-block') : '(no block line)';
    log(`DEPOSIT SENT: ${outcome} — ${blockLine}`);
    await driver.screenshot('live-b-sent');
    console.log('--- agent-history after deposit ---');
    console.log(agentHistory());
    await driver.click('btn-send-done');

    // Back to Convert — the resume engine adopts the parked shift and polls it to settlement.
    // The send surface left the Pay tab with ICP still the selected asset.
    await openBalances(driver);
    await driver.click('btn-accounts-convert');
    const res = await watchConvert(driver, 'b', {timeoutMs: 25 * 60_000});
    log(`OP B result: ${res.ended}: ${res.text}`);
    // The settle address is the APP-DERIVED SOL rail (BzFNJ…), not the registered sol-float —
    // measure it with the derived-address watcher; agent-funds' sol-float row will read 0.
    console.log('--- live-sol (app-derived SOL rail truth) ---');
    console.log(execFileSync('node', ['live-sol.mjs'], {encoding: 'utf8', cwd: new URL('.', import.meta.url).pathname}));
    console.log('--- agent-funds after (registered wallets) ---');
    console.log(agentFunds());
  });
}

async function cmdC1(solAmount) {
  // OP C1 — SOL→USDC via Jupiter on the device-signed SOL rail.
  await withApp(async (driver) => {
    await openConvert(driver, 'sol');
    await driver.type('convert-amount', solAmount);
    await pickDest(driver, 'usdc');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c1-quote');
    await driver.click('btn-convert-confirm');
    const res = await watchConvert(driver, 'c1', {timeoutMs: 6 * 60_000});
    log(`OP C1 result: ${res.ended}: ${res.text}`);
    console.log('--- agent-funds after ---');
    console.log(agentFunds());
  });
}

async function cmdC2(usdcAmount) {
  await withApp(async (driver) => {
    await openConvert(driver, 'sol'); // USDC/EURC are SOL-rail assets
    await driver.type('convert-amount', usdcAmount);
    await pickDest(driver, 'eurc');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c2-quote');
    await driver.click('btn-convert-confirm');
    const res = await watchConvert(driver, 'c2', {timeoutMs: 6 * 60_000});
    log(`OP C2 result: ${res.ended}: ${res.text}`);
    console.log('--- agent-funds after ---');
    console.log(agentFunds());
  });
}

async function cmdC3(eurcAmount) {
  await withApp(async (driver) => {
    await openConvert(driver, 'sol');
    await driver.type('convert-amount', eurcAmount);
    await pickDest(driver, 'usdc');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c3-quote');
    await driver.click('btn-convert-confirm');
    const res = await watchConvert(driver, 'c3', {timeoutMs: 6 * 60_000});
    log(`OP C3 result: ${res.ended}: ${res.text}`);
    console.log('--- agent-funds after ---');
    console.log(agentFunds());
  });
}

async function cmdWatch() {
  await withApp(async (driver) => {
    await selectCurrency(driver, 'icp');
    await openBalances(driver);
    await driver.click('btn-accounts-convert');
    const res = await watchConvert(driver, 'watch', {timeoutMs: 20 * 60_000});
    log(`watch result: ${res.ended}: ${res.text}`);
  });
}

// ---------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'boot') await cmdBoot();
  else if (cmd === 'probe') await cmdProbe(args[0], args[1]);
  else if (cmd === 'conv-a') await cmdA();
  else if (cmd === 'conv-b') await cmdB(args[0] ?? '1.04');
  else if (cmd === 'conv-c1') await cmdC1(args[0]);
  else if (cmd === 'conv-c2') await cmdC2(args[0]);
  else if (cmd === 'conv-c3') await cmdC3(args[0]);
  else if (cmd === 'watch') await cmdWatch();
  else {
    console.error('unknown command — see header comment');
    process.exit(2);
  }
} catch (e) {
  console.error(`[live] FAILED: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
}
