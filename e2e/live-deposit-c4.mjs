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

const E2E = '/home/sat/projects/dpay/dpay-main/e2e';
const ROOT = '/home/sat/projects/dpay/dpay-main';
const SHOTS = '/home/sat/projects/dpay/tmp/shots-c4';
mkdirSync(SHOTS, {recursive: true});

const RELAY = process.env.DPAY_LIVE_RELAY ?? 'http://127.0.0.1:8898';
const FLOAT_PRINCIPAL = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
// The app's OWN Solana rail address: SLIP-10 ed25519 m/44'/501'/0'/0' of the IC float seed
// (app/solana/identity.ts; ConvertMode.tsx:497 derives the CeFi settle address the same way).
// VERIFIED in-process 2026-09-20: deriveSolanaKeypair(IC float seed) → exactly this address.
// NOTE the divergence from the registered `sol-float` wallet (4Cuacz…, an independent raw-seed
// key the app can never sign from) — see the docs/AGENT-FUNDS.md finding; measured live via
// `node e2e/live-sol.mjs`.
const SOL_SETTLE = 'BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX';

const {buildWeb, serveWeb} = await import('/home/sat/projects/dpay/dpay-main/e2e/harness/web.mjs');
const {Driver} = await import('/home/sat/projects/dpay/dpay-main/e2e/harness/driver.mjs');
const {openBalances, selectCurrency, accountOf, railPrincipalText} = await import('/home/sat/projects/dpay/dpay-main/e2e/harness/lib.mjs');
const {icpPrincipalBytes, principalToText, icpAccountIdentifierHex} = await import('/home/sat/projects/dpay/dpay-main/e2e/harness/wire.mjs');

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
  return runCapture('just', ['funds', 'balance']);
}
async function agentFunds() {
  return runCapture('just', ['funds']);
}
async function agentHistory() {
  return runCapture('just', ['funds', 'history']);
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
  // solRpcUrl:'derive' — the e2e env (injectTestGlobals) DISABLES the SOL rail by default
  // (globalThis.__DPAY_TEST_SOLANA_RPC_URL = '' → "no RPC endpoint configured" on any SOL
  // convert submit). 'derive' deletes that override so the app derives the RPC list from the
  // App-installed relay bases (+/api/v1/solana/rpc) — the exact production path. Found live
  // 2026-09-20: op-C submits died instantly with SolanaRelayPathDown despite the relay's
  // solana pipe being enabled and healthy.
  const driver = await Driver.create(browser, {solRpcUrl: 'derive'});
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
    // 0.099 not 0.1: the fund gate needs amount + two ledger fees (0.12) and the
    // float holds 0.11961 ckUSDC after yesterday's 0.01 approve-fee burn — 0.1 no longer clears.
    await driver.type('convert-amount', '0.099');
    await pickDest(driver, 'vchf');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-a-quote');
    await driver.click('btn-convert-confirm');
    const res = await watchConvert(driver, 'a', {timeoutMs: 8 * 60_000});
    log(`OP A result: ${res.ended}: ${res.text}`);
    console.log('--- funds balance after ---');
    console.log(await agentBalance());
  });
}

// probe-confirm — diagnostic (founder rule: verbatim evidence). Reaches the CeFi surface
// exactly like conv-b, then instead of blind re-clicks: dumps the confirm button's live DOM
// state (disabled, bounding box, pointer events), attaches a console listener, fires a
// DOM-level click (React synthetic events still receive it), and polls the surface so the
// POST-click truth (order created? error? no-op?) is observable.
async function cmdProbeConfirm() {
  await withApp(async (driver) => {
    await openConvert(driver, 'icp');
    await driver.type('convert-amount', '1.10');
    await pickDest(driver, 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter');
    try {
      await driver.findByTestID('convert-dest-mechs', {timeoutMs: 4_000});
      await driver.click('convert-dest-mech-sideshift');
      log('mechanism: sideshift');
    } catch { /* single mechanism */ }
    await driver.findByTestID('convert-settle-address', {timeoutMs: 30_000});
    for (let i = 0; i < 30; i++) {
      if (await driver.isPresent('convert-quote-source')) break;
      await sleep(1_000);
    }
    const state = await (await driver.page.$('body')).evaluate(() => {
      const btn = document.querySelector('[data-testid="btn-convert-confirm"]');
      if (!btn) return {present: false};
      const r = btn.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      return {
        present: true,
        disabled: btn.hasAttribute('disabled'),
        ariaDisabled: btn.getAttribute('aria-disabled'),
        rect: {x: r.x, y: r.y, w: r.width, h: r.height},
        opacity: cs.opacity, pointerEvents: cs.pointerEvents, visibility: cs.visibility, display: cs.display,
        cls: btn.className,
        text: (btn.textContent ?? '').trim(),
      };
    });
    log(`CONFIRM BUTTON DOM STATE: ${JSON.stringify(state)}`);
    driver.page.on('console', (m) => log(`[page-console] ${m.type()}: ${m.text().slice(0, 300)}`));
    await (await driver.page.$('body')).evaluate(() => {
      const btn = document.querySelector('[data-testid="btn-convert-confirm"]');
      if (btn) btn.click();
    });
    log('DOM click dispatched');
    for (let i = 0; i < 10; i++) {
      await sleep(1_000);
      const t = (await driver.bodyText()).replace(/\s+/g, ' ');
      if (/awaiting deposit|Awaiting your deposit|Deposit exactly/i.test(t)) { log(`t+${i}s: AWAITING DEPOSIT up`); return; }
      if (i === 2 || i === 5 || i === 9) log(`t+${i}s surface: ${t.slice(0, 500)}`);
    }
    await driver.screenshot('live-probe-confirm-end');
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
    if (!/SideShift/i.test(qsrc)) {
      // Diagnose before refusing: the quote effect can fail SILENTLY (legs == null) or with a
      // rendered error line — either way the surface body is the evidence (founder rule:
      // verbatim venue/app errors are findings).
      const errEl = await driver.isPresent('convert-quote-err') ? await driver.readText('convert-quote-err') : '(no convert-quote-err)';
      log(`quote-err: ${errEl}`);
      const body = await driver.bodyText();
      log('SURFACE AT QUOTE FAILURE:', body.replace(/\s+/g, ' ').slice(0, 1200));
      await driver.screenshot('live-b-quote-failure');
      throw new Error('OP B: quote source is not SideShift — refusing');
    }
    const cparty = await driver.isPresent('convert-counterparty')
      ? await driver.readText('convert-counterparty') : '(none)';
    log(`counterparty disclosure: ${cparty.replace(/\s+/g, ' ').slice(0, 300)}`);
    const body = await driver.bodyText();
    log('CEFI SURFACE:', body.replace(/\s+/g, ' ').slice(0, 600));
    await driver.screenshot('live-b-quote');
    // Confirm with re-quote retries (shared helper — see confirmWithRequote below).
    const facts = await confirmWithRequote(driver, 'B', {cefi: true});
    if (!facts) throw new Error('OP B: awaiting-deposit panel never appeared after 30 rapid confirm attempts');
    log('DEPOSIT FACTS:', JSON.stringify(facts, null, 2));
    await driver.screenshot('live-b-awaiting-deposit');
    const m = facts.depositAmountLine.match(/([\d.]+)\s*ICP/);
    if (!m) throw new Error(`OP B: cannot parse deposit amount from ${JSON.stringify(facts.depositAmountLine)}`);
    const depositAmount = m[1];

    // Was the deposit already sent by the app's confirm flow? (CeFi handoff design says the user
    // sends it — but measure, never assume.) `just funds history` shows recent ICP ledger transfers.
    const histBefore = await agentHistory();
    if (histBefore.split('\n').filter(Boolean).length === 0) throw new Error('funds history empty?');

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
    console.log('--- funds history after deposit ---');
    console.log(agentHistory());
    await driver.click('btn-send-done');

    // Back to Convert — the resume engine adopts the parked shift and polls it to settlement.
    // The send surface left the Pay tab with ICP still the selected asset.
    await openBalances(driver);
    await driver.click('btn-accounts-convert');
    const res = await watchConvert(driver, 'b', {timeoutMs: 25 * 60_000});
    log(`OP B result: ${res.ended}: ${res.text}`);
    // The settle address is the APP-DERIVED SOL rail (BzFNJ…), not the registered sol-float —
    // measure it with the derived-address watcher; `just funds`' sol-float row will read 0.
    console.log('--- live-sol (app-derived SOL rail truth) ---');
    console.log(execFileSync('node', ['live-sol.mjs'], {encoding: 'utf8', cwd: new URL('.', import.meta.url).pathname}));
    console.log('--- funds after (registered wallets) ---');
    console.log(agentFunds());
  });
}

async function cmdC1(solAmount) {
  // OP C1 — SOL→USDC via Jupiter on the device-signed SOL rail.
  await withApp(async (driver) => {
    await openConvert(driver, 'sol');
    await driver.type('convert-amount', solAmount);
    // USDC — in this wallet is the DEFAULT selected destination on the SOL rail
    // (rows carry no convert-dest-* testIDs; nothing to click).
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c1-quote');
    await confirmWithRequote(driver, 'C1');
    const res = await watchConvert(driver, 'c1', {timeoutMs: 6 * 60_000});
    log(`OP C1 result: ${res.ended}: ${res.text}`);
    if (res.ended === 'convert-stuck' || res.ended === 'convert-failed') {
      await driver.dumpDiagnostics('c1-stuck', null);
      log('C1 diagnostics dumped');
    }
    console.log('--- funds after ---');
    console.log(agentFunds());
  });
}

async function cmdC2(usdcAmount) {
  await withApp(async (driver) => {
    await openConvert(driver, 'sol-usdc'); // SOURCE is the SOL rail's USDC token (from C1)
    await driver.type('convert-amount', usdcAmount);
    await clickByText(driver, 'EURC — in this wallet');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c2-quote');
    await confirmWithRequote(driver, 'C2');
    const res = await watchConvert(driver, 'c2', {timeoutMs: 6 * 60_000});
    log(`OP C2 result: ${res.ended}: ${res.text}`);
    console.log('--- funds after ---');
    console.log(agentFunds());
  });
}

async function cmdBSendSol(address, amount) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address ?? '')) throw new Error(`b-send-sol: destination is not a base58 SOL address: ${address}`);
  if (!/^\d+(\.\d+)?$/.test(amount ?? '')) throw new Error(`b-send-sol: bad amount ${amount}`);
  log(`b-send-sol: ${amount} EURC -> ${address}`);
  await withApp(async (driver) => {
    await openBalances(driver);
    await selectCurrency(driver, 'sol-eurc');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    await driver.type('send-address-input', address);
    await driver.type('send-amount-input', amount);
    await sleep(1_000);
    const reviewTo = await driver.readText('send-review-to');
    log(`send review → ${reviewTo}`);
    if (!reviewTo.includes(address.slice(0, 8))) {
      await driver.screenshot('live-c4-send-review');
      throw new Error(`b-send-sol: review does not echo the destination — refusing (${reviewTo})`);
    }
    await driver.screenshot('live-c4-send-review');
    await driver.click('btn-send-confirm');
    await driver.waitForText('send-outcome', {timeoutMs: 90_000});
    const outcome = await driver.readText('send-outcome');
    log(`SEND OUTCOME: ${outcome}`);
    await driver.screenshot('live-c4-sent');
  });
}

  // OP 1c — the RETURN shift: EURC(SOL)→ICP through the SOL-side cefi destination group
  // (convert-sol-dest-cefi-sideshift-eurc — the merge's new surface). Deposit = the SPL
  // transfer the UI instructs (self-send handoff to the shift's deposit address); payout
  // lands at the float's OWN derived IC principal.
async function cmdC4(eurcAmount) {
  await withApp(async (driver, boot) => {
    // TEMP C4-R2 adaptation (2026-09-21): the settle target is the float's 64-hex ACCOUNT
    // IDENTIFIER (SideShift's ICP payout layer cannot pay principal-format addresses —
    // engineering-confirmed; the 2026-09-20 shift refunded on exactly this). The app now
    // emits the hex form; refuse unless the rendered settle equals the in-harness
    // derivation of THIS wallet's pubkey AND equals the engineering-pinned vector.
    const ACCOUNT_ID_VECTOR = '9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279';
    const expectedSettle = icpAccountIdentifierHex(boot.pubHex);
    if (expectedSettle !== ACCOUNT_ID_VECTOR) {
      throw new Error(`OP 1c: derived account identifier ${expectedSettle} != pinned vector — refusing`);
    }
    await openConvert(driver, 'sol-eurc'); // SOURCE is the SOL rail's EURC token row
    await driver.type('convert-amount', eurcAmount);
    const cefiRow = 'convert-sol-dest-cefi-sideshift-eurc';
    await driver.click(cefiRow);
    log(`dest picked: ${cefiRow}`);
    await driver.findByTestID('convert-settle-address', {timeoutMs: 30_000});
    const settle = await driver.readText('convert-settle-address');
    log(`settle address: ${settle}`);
    if (settle !== expectedSettle) {
      await driver.screenshot('live-c4-settle');
      throw new Error(`OP 1c: settle address is not the float's own 64-hex account identifier — refusing (${settle} != ${expectedSettle})`);
    }
    // Live-min re-check at order time (venue minimums move; 8.705423 measured at session
    // start). Refuse BEFORE any order exists if the typed amount dipped below the min.
    const pair = await (await fetch('https://sideshift.ai/api/v2/pair/eurc-solana/icp', {signal: AbortSignal.timeout(20_000)})).json();
    log(`live pair min ${pair.min} rate ${pair.rate}`);
    if (!(Number(eurcAmount) >= Number(pair.min))) {
      throw new Error(`OP 1c: ${eurcAmount} EURC is below the live venue min ${pair.min} — refusing (no order created)`);
    }
    for (let i = 0; i < 30; i++) {
      if (await driver.isPresent('convert-quote-source')) break;
      await sleep(1_000);
    }
    const qsrc = await driver.readText('convert-quote-source');
    log(`quote source: ${qsrc}`);
    if (!/SideShift/i.test(qsrc)) {
      await driver.screenshot('live-c4-quote-failure');
      throw new Error(`OP 1c: quote source is not SideShift — refusing`);
    }
    await driver.screenshot('live-c4-quote');
    const facts = await confirmWithRequote(driver, 'C4', {cefi: true});
    if (facts == null) throw new Error('OP 1c: confirm did not reach awaiting-deposit');
    log(`DEPOSIT FACTS: ${JSON.stringify(facts, null, 2)}`);
    // Capture the venue's shift id (the 2026-09-20 probe gap: the id was never logged).
    let shiftId = '';
    try {
      shiftId = (await driver.readText('convert-shift-id', {timeoutMs: 8_000})).trim();
    } catch {}
    log(`SHIFT ID: ${shiftId || '(convert-shift-id not rendered)'}`);
    await driver.screenshot('live-c4-awaiting-deposit');
    const m = facts.depositAmountLine.match(/([\d.]+)\s*EURC/);
    if (!m) throw new Error(`OP 1c: cannot parse EURC deposit amount from "${facts.depositAmountLine}"`);
    const depositAmount = m[1];
    // The handoff: send the venue's exact deposit via the app's own Pay▸Send (SPL transfer).
    await openBalances(driver);
    await selectCurrency(driver, 'sol-eurc');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    // The send form can be gated by a transient offline state (the balance poll's online flag
    // flips false on one failed IC read) — click the panel's recheck until the form renders.
    for (let i = 0; i < 10; i++) {
      if (await driver.isPresent('sol-send-address-input')) break;
      if (await driver.isPresent('sol-send-offline-check')) {
        log('offline gate up — rechecking');
        await driver.click('sol-send-offline-check');
      }
      await sleep(1_500);
    }
    try {
      await driver.type('sol-send-address-input', facts.depositAddress);
      await driver.type('sol-send-amount-input', depositAmount);
    } catch (e) {
      log(`OP 1c send form failure: ${e.message}`);
      log(`SEND SURFACE: ${(await driver.bodyText()).replace(/\s+/g, ' ').slice(0, 1200)}`);
      await driver.screenshot('live-c4-send-form');
      throw e;
    }
    await sleep(1_000);
    // Echo check: the sheet's review card prints the destination as TEXT — poll the body for
    // the deposit address prefix (input-value reads race AddressField remounts).
    let echoed = false;
    for (let i = 0; i < 20; i++) {
      if ((await driver.bodyText()).includes(facts.depositAddress.slice(0, 10))) { echoed = true; break; }
      await sleep(500);
    }
    log(`send review echo: ${echoed ? 'ok' : 'MISSING'}`);
    if (!echoed) {
      await driver.screenshot('live-c4-send-review');
      throw new Error('OP 1c: send form never echoed the venue deposit address — refusing');
    }
    await driver.screenshot('live-c4-send-review');
    try {
      await driver.click('btn-sol-send-confirm');
    } catch (e) {
      log(`confirm click failed: ${e.message}`);
      log(`POST-ECHO SURFACE: ${(await driver.bodyText()).replace(/\s+/g, ' ').slice(0, 1200)}`);
      await driver.screenshot('live-c4-confirm-gone');
      // DOM-level click fallback (probe-confirm lesson: React synthetic events receive it).
      const clicked = await (await driver.page.$('body')).evaluate(() => {
        const btn = document.querySelector('[data-testid="btn-sol-send-confirm"]');
        if (!btn) return false;
        btn.click();
        return true;
      });
      log(`DOM fallback click: ${clicked}`);
      if (!clicked) throw e;
    }
    const outcome = await driver.readText('sol-send-outcome', {timeoutMs: 120_000});
    let sig = '';
    try { sig = await driver.readText('sol-send-signature', {timeoutMs: 5_000}); } catch {}
    log(`DEPOSIT SENT: ${outcome} | sig ${sig}`);
    await driver.screenshot('live-c4-sent');
    // Back to Convert: the persisted record adopts and the watch follows it to done.
    await selectCurrency(driver, 'sol-eurc');
    await driver.click('btn-accounts-convert');
    // STRICT one-attempt discipline: 15 minutes, then STOP and report (no new orders).
    const res = await watchConvert(driver, 'c4', {timeoutMs: 15 * 60_000});
    log(`OP 1c result: ${res.ended}: ${res.text}`);
    log(`C4 STATE: ${JSON.stringify({shiftId, settle, depositAmount, sig, ended: res.ended, text: res.text})}`);
  });
}


/** OP 2 — gas-funder core mechanic, live: 0.5 ICP → USDC at OUR Ethereum address (EVM-float),
 *  WITH the gas-fund card (the wallet's ckETH is far short of gas; the app prepends gas legs and
 *  funds ckETH from the input). The CCTP burn itself stays user-side by design — the record parks
 *  at awaiting_external naming both assets; we verify native ETH arrived at the destination. */
async function cmdGas(icpAmount, evmAddress) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) throw new Error(`conv-gas: not an EVM address: ${evmAddress}`);
  await withApp(async (driver) => {
    log(`OP 2 — gas-funder: ${icpAmount} ICP → USDC at ${evmAddress} (gas funded from this wallet)`);
    await openConvert(driver, 'icp');
    await driver.type('convert-amount', icpAmount);
    await pickDest(driver, 'convert-dest-route-multihop:icpswap-ckusdc:2');
    // EVM destination + checksum gate (the human-facing double-type gate). §1: a lowercase
    // (shape-valid, checksum-BAD) form must be refused; the checksummed re-type clears it.
    await driver.type('convert-dest-address', evmAddress.toLowerCase());
    const bad = await driver.waitForText('Checksum mismatch', {timeoutMs: 8_000});
    if (!bad) {
      await driver.screenshot('live-gas-checksum-gate');
      throw new Error('OP 2: lowercase address did NOT trip the checksum gate — gate missing?');
    }
    log('checksum gate: lowercase refused ✓');
    await driver.screenshot('live-gas-checksum-bad');
    await driver.type('convert-dest-address', evmAddress);
    if (await driver.isPresent('convert-dest-reenter')) {
      log('re-enter gate up — typing the address again');
      await driver.type('convert-dest-reenter', evmAddress);
      await sleep(500);
    }
    await driver.screenshot('live-gas-dest-ok');
    // Gas-fund card: need-vs-have, then the wallet-fund gesture.
    await driver.waitForText('ETH', {timeoutMs: 30_000});
    const cardText = await driver.readText('convert-gas-fund-card');
    log(`GAS CARD: ${cardText.replace(/\s+/g, ' ')}`);
    await driver.screenshot('live-gas-card');
    // §3 [I'll fund it myself] renders + the short-recheck branch (evm-float starts at 0 ETH).
    await driver.click('btn-gas-fund-self');
    await sleep(1_000);
    const selfText = (await driver.bodyText()).replace(/\s+/g, ' ').match(/.{0,80}(Send ≥|Send >=|fund it myself|gas-fund-self).{0,220}/i);
    log(`SELF-FUND PATH: ${selfText ? selfText[0] : '(pattern not found — dumping card) ' + (await driver.readText('convert-gas-fund-card')).replace(/\s+/g, ' ')}`);
    await driver.screenshot('live-gas-self');
    const short = await driver.isPresent('btn-gas-fund-recheck');
    if (short) {
      await driver.click('btn-gas-fund-recheck');
      await sleep(1_000);
      const shortText = (await driver.readText('convert-gas-fund-card')).replace(/\s+/g, ' ');
      log(`SHORT RECHECK: ${shortText.slice(0, 300)}`);
      if (!/short/i.test(shortText)) throw new Error('OP 2: recheck after 0-ETH balance did not report short');
      log('still-short recheck ✓ (honest 0-ETH read)');
      await driver.screenshot('live-gas-short');
    }
    // §4 the real gesture: fund the gas from this wallet.
    await driver.click('btn-gas-fund-wallet');
    await driver.waitForText('ETH', {timeoutMs: 20_000}); // legs note names the gas funding
    const body = (await driver.bodyText()).replace(/\s+/g, ' ');
    const legsNote = body.match(/convert gas[^.]*|fund the gas[^.]*|.{0,120}gas.{0,160}/i);
    log(`AFTER FUND GESTURE: ${legsNote ? legsNote[0] : body.slice(0, 400)}`);
    await driver.screenshot('live-gas-funded');
    const done = await confirmWithRequote(driver, 'GAS', {cefi: false});
    log(`OP 2 confirm → ${done === true ? 'submitted' : JSON.stringify(done)?.slice(0, 200)}`);
    await watchConvert(driver, 'gas', {timeoutMs: 20 * 60_000});
    log(`FINAL SURFACE: ${(await driver.bodyText()).replace(/\s+/g, ' ').slice(0, 1400)}`);
    await driver.screenshot('live-gas-final');
    await agentFunds();
  });
}

async function cmdC3(eurcAmount) {
  await withApp(async (driver) => {
    await openConvert(driver, 'sol-eurc'); // the SOURCE is the SOL rail's EURC token row
    await driver.type('convert-amount', eurcAmount);
    await clickByText(driver, 'USDC — in this wallet');
    const q = await readQuote(driver);
    log('QUOTE (verbatim):', JSON.stringify(q, null, 2));
    await driver.screenshot('live-c3-quote');
    await confirmWithRequote(driver, 'C3');
    const res = await watchConvert(driver, 'c3', {timeoutMs: 6 * 60_000});
    log(`OP C3 result: ${res.ended}: ${res.text}`);
    console.log('--- funds after ---');
    console.log(agentFunds());
  });
}

// clickByText — the SOL-rail destination rows ("USDC — in this wallet") carry no
// convert-dest-* testIDs (SolConvertMode renders its own picker); click by visible text.
async function clickByText(driver, text) {
  const ok = await driver.eval((t) => {
    const els = [...document.querySelectorAll('div,span,button')];
    const hit = els.filter((e) => e.textContent && e.textContent.includes(t) && e.textContent.length < t.length + 30).pop();
    if (hit == null) return false;
    hit.click();
    return true;
  }, text);
  if (!ok) throw new Error(`clickByText: no row containing ${JSON.stringify(text)}`);
  log(`clicked row by text: ${text}`);
}

// confirmWithRequote — shared confirm loop for live venue quotes. The app's confirm
// re-quotes and refuses on ANY out-amount delta (exact string compare); a live venue's
// rate ticks constantly, so consecutive fetches almost never match. Rapid re-clicks
// shrink the fetch-to-fetch window so two quotes can land inside one venue tick.
// Findings (recorded 2026-09-20, op B): this is a real-user-facing defect — a human
// cannot confirm a live CeFi/AMM quote in a moving market without luck; the confirm
// path needs a drift tolerance. Offline e2e cannot see it (static fake quotes).
// opts.cefi: returns the deposit facts once the awaiting-deposit panel renders (CeFi);
// otherwise returns true once the engine view (convert-state) takes over.
async function confirmWithRequote(driver, label, opts = {}) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    await driver.click('btn-convert-confirm');
    // Order creation (fresh venue quote + fixed-order POST + panel render) can take ~5s on a
    // live venue — poll long enough to SEE it before declaring "no progress" (finding 2026-09-20:
    // the 2.4s window mis-read every successful confirm as a no-op and re-clicked a dead form).
    for (let i = 0; i < 20; i++) {
      await sleep(750);
      if (opts.cefi && await driver.isPresent('convert-awaiting-deposit')) {
        return await readDepositFacts(driver, {timeoutMs: 90_000});
      }
      if (!opts.cefi && await driver.isPresent('convert-state')) return true;
      if (await driver.isPresent('convert-failed')) {
        log(`[${label}] convert-failed after attempt ${attempt}: ${await driver.readText('convert-failed')}`);
        return opts.cefi ? null : true;
      }
    }
    const bodyNow = await driver.bodyText();
    if (/Quote changed/i.test(bodyNow)) {
      log(`[${label}] confirm attempt ${attempt}: quote drifted — rapid re-confirm`);
    } else if (await driver.isPresent('convert-awaiting-deposit')) {
      // Late handoff: the panel landed between polls.
      return opts.cefi ? await readDepositFacts(driver, {timeoutMs: 90_000}) : true;
    } else if (await driver.isPresent('convert-state')) {
      return opts.cefi ? null : true;
    } else if (await driver.isPresent('convert-failed')) {
      log(`[${label}] convert-failed after attempt ${attempt}: ${await driver.readText('convert-failed')}`);
      return opts.cefi ? null : true;
    } else {
      // No recognized state — dump the surface so the actual post-click state is evidence,
      // not guesswork (verbatim errors are findings).
      log(`[${label}] confirm attempt ${attempt}: no recognized state — SURFACE NOW: ${bodyNow.slice(0, 1400)}`);
      await driver.screenshot(`live-${label.toLowerCase()}-after-confirm-${attempt}`);
      await sleep(1_500);
    }
  }
  return null;
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

// b-send <address> <amount> — complete op B's CeFi deposit handoff: the app's own
// Pay▸Send surface (destination = the venue's deposit account, exact amount from the
// awaiting-deposit panel). The facts come from the app's own panel — this command
// refuses a destination that is not a 64-hex ICP account id (venue ICP deposits).
async function cmdBSend(address, amount) {
  if (!/^[0-9a-f]{64}$/.test(address ?? '')) throw new Error(`b-send: destination is not a 64-hex ICP account id: ${address}`);
  if (!/^\d+(\.\d+)?$/.test(amount ?? '')) throw new Error(`b-send: bad amount ${amount}`);
  log(`b-send: ${amount} ICP -> ${address}`);
  await withApp(async (driver) => {
    await openBalances(driver);
    await selectCurrency(driver, 'icp');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    await driver.type('send-address-input', address);
    await driver.type('send-amount-input', amount);
    const reviewTo = await driver.readText('send-review-to');
    log(`send-review-to: ${reviewTo}`);
    if (!reviewTo.includes(address.slice(0, 12))) {
      await driver.screenshot('live-b-send-review');
      throw new Error(`b-send: review does not echo the destination — refusing (${reviewTo})`);
    }
    await driver.screenshot('live-b-send-review');
    await driver.click('btn-send-confirm');
    await driver.waitForText('send-outcome', {timeoutMs: 90_000});
    const outcome = await driver.readText('send-outcome');
    let block = '';
    try { block = await driver.readText('send-block'); } catch {}
    log(`SEND OUTCOME: ${outcome} | ${block}`);
    await driver.screenshot('live-b-sent');
  });
}

// ---------------------------------------------------------------------------


/** deposit-c4 — complete the deposit leg of the EXISTING shift b4f0dd3e0ad88d4b1617
 *  (created 14:08:32Z by the conv-c4 attempt; the send sheet ate the first confirm click).
 *  NO new order: same shift, same deposit address, same exact amount. HARD self-abort
 *  after the venue expiry minus margin. */
async function cmdDepositC4() {
  const DEPOSIT_ADDR = '7H4smPYESw7LQD2iosXWYoJVbxwv4Tq5HNVotajxHHCg';
  const AMOUNT = '9.284071';
  const CUTOFF = Date.parse('2026-09-21T14:21:00Z'); // 2min before the shift's 14:23:25Z expiry
  if (Date.now() > CUTOFF) throw new Error('deposit-c4: past the 14:21:00Z self-abort cutoff — refusing');
  const st = await (await fetch(`https://sideshift.ai/api/v2/shifts/b4f0dd3e0ad88d4b1617`, {signal: AbortSignal.timeout(15_000)})).json();
  if (st.status !== 'waiting') throw new Error(`deposit-c4: shift status is ${st.status}, not waiting — refusing`);
  log(`shift b4f0dd3e0ad88d4b1617 status=${st.status} expires=${st.expiresAt} — proceeding to deposit`);
  await withApp(async (driver) => {
    await openBalances(driver);
    await selectCurrency(driver, 'sol-eurc');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    for (let i = 0; i < 10; i++) {
      if (await driver.isPresent('sol-send-address-input')) break;
      if (await driver.isPresent('sol-send-offline-check')) {
        log('offline gate up — rechecking');
        await driver.click('sol-send-offline-check');
      }
      await sleep(1_500);
    }
    await driver.type('sol-send-address-input', DEPOSIT_ADDR);
    await driver.type('sol-send-amount-input', AMOUNT);
    await sleep(1_000);
    let echoed = false;
    for (let i = 0; i < 20; i++) {
      if ((await driver.bodyText()).includes(DEPOSIT_ADDR.slice(0, 10))) { echoed = true; break; }
      await sleep(500);
    }
    if (!echoed) { await driver.screenshot('live-dep-review'); throw new Error('deposit-c4: review never echoed the deposit address — refusing'); }
    log('send review echo: ok');
    // HARDENED confirm: wait until the button is actually ENABLED (the first attempt's click
    // raced the form's final validation and produced no transfer), then click.
    let enabled = false;
    for (let i = 0; i < 30; i++) {
      const h = await driver.page.$('[data-testid="btn-sol-send-confirm"]');
      if (h) {
        const dis = await h.evaluate((b) => b.disabled || b.getAttribute('aria-disabled') === 'true');
        if (!dis) { enabled = true; break; }
      }
      await sleep(500);
    }
    if (!enabled) { await driver.screenshot('live-dep-btn-disabled'); throw new Error('deposit-c4: confirm button never enabled — refusing'); }
    if (Date.now() > CUTOFF) throw new Error('deposit-c4: cutoff hit before confirm — refusing');
    log('confirm enabled — clicking');
    try { await driver.click('btn-sol-send-confirm'); } catch (e) {
      const clicked = await (await driver.page.$('body')).evaluate(() => {
        const btn = document.querySelector('[data-testid="btn-sol-send-confirm"]');
        if (!btn) return false; btn.click(); return true;
      });
      log(`DOM fallback click: ${clicked}`);
      if (!clicked) throw e;
    }
    await driver.screenshot('live-dep-clicked');
    const outcome = await driver.readText('sol-send-outcome', {timeoutMs: 180_000});
    let sig = '';
    try { sig = await driver.readText('sol-send-signature', {timeoutMs: 8_000}); } catch {}
    log(`DEPOSIT SENT: ${outcome} | sig ${sig}`);
    await driver.screenshot('live-dep-sent');
  });
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'boot') await cmdBoot();
  else if (cmd === 'probe') await cmdProbe(args[0], args[1]);
  else if (cmd === 'probe-confirm') await cmdProbeConfirm();
  else if (cmd === 'conv-a') await cmdA();
  else if (cmd === 'conv-b') await cmdB(args[0] ?? '1.04');
  else if (cmd === 'conv-c1') await cmdC1(args[0]);
  else if (cmd === 'conv-c2') await cmdC2(args[0]);
  else if (cmd === 'conv-c3') await cmdC3(args[0]);
  else if (cmd === 'conv-c4') await cmdC4(args[0]);
  else if (cmd === 'deposit-c4') await cmdDepositC4();
  else if (cmd === 'conv-gas') await cmdGas(args[0], args[1]);
  else if (cmd === 'b-send-sol') await cmdBSendSol(args[0], args[1]);
  else if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'b-send') await cmdBSend(args[0], args[1]);
  else if (cmd === 'assets') await withApp(async (driver) => {
    await openBalances(driver);
    await sleep(1_500);
    const ids = await driver.eval(() => [...document.querySelectorAll('[data-testid^="asset-"]')].map((e) => e.getAttribute('data-testid')));
    log('asset rows:', JSON.stringify(ids));
  });
  else {
    console.error('unknown command — see header comment');
    process.exit(2);
  }
} catch (e) {
  console.error(`[live] FAILED: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
}
