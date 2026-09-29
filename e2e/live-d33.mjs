#!/usr/bin/env node
// e2e/live-d33.mjs — D33: complete the founder's pair EURC→ICP→VCHF through the CHAIN route,
// with the D32 broadcast fix IN THE BUNDLE (the harness build from main @ the fix commit).
//
// Topology (the live-drive precedent): the REAL app built from app/ via the harness vite
// pipeline, served LOCALLY, pointed at the PROD relay via ?relay= — the harness browser launches
// with --disable-web-security (harness/browser.mjs BASE_LAUNCH_ARGS), so the bundle's embedded
// relay base (https://dpay.kalaj.org) is reachable cross-origin. The D32 fix ships in THIS
// build: submitRawSolTx broadcasts skipPreflight + the walk widens to preflight-shaped refusals.
//
// Seed discipline: the float seed decrypts IN-PROCESS and is typed into the restore form.
// Never printed, never logged, never written. Size: MAX-NET prefill (the sheet's own ceiling;
// the venue minimum floats — D32 measured 8.7895 → 8.807 in 70 min).
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const E2E = dirname(fileURLToPath(import.meta.url));
const ROOT = join(E2E, '..');
const EV = '/home/sat/projects/dpay/tmp/d33';
const SHOTS = join(E2E, 'shots');
mkdirSync(SHOTS, {recursive: true});
mkdirSync(EV, {recursive: true});

const PROD_RELAY = 'https://dpay.kalaj.org';
const FLOAT_PRINCIPAL = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const IC_ACCOUNT = '9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279';

const log = (...a) => console.log(`[d33 ${new Date().toISOString().slice(11, 23)}]`, ...a);
const evidence = {startedAt: new Date().toISOString(), faces: [], steps: []};
function face(driver, name, data) {
  evidence.faces.push({name, at: new Date().toISOString(), ...(data ?? {})});
  try { copyFileSync(join(SHOTS, `d33-${name}.png`), join(EV, `d33-${name}.png`)); } catch { /* best effort */ }
  log(`face: d33-${name}`);
}
function note(kind, text) {
  evidence.steps.push({kind, at: new Date().toISOString(), text: String(text).slice(0, 2_500)});
  log(`${kind}: ${String(text).slice(0, 300)}`);
}
const saveEvidence = () => writeFileSync(join(EV, 'evidence.json'), JSON.stringify(evidence, null, 1));

function floatSeed() {
  const hex = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('floatSeed: refused (not 64 hex chars)');
  return hex;
}

async function textIfPresent(testID) {
  if (!(await driver.isPresent(testID))) return null;
  return (await driver.readText(testID)).trim();
}

async function dumpConvertState() {
  return driver.eval(() => {
    const ids = ['convert-route-via', 'convert-quote-source', 'convert-headline', 'convert-settle-address',
      'convert-confirm-err', 'convert-step', 'convert-chain-live', 'convert-chain-awaiting',
      'convert-deposit-address', 'convert-done', 'convert-failed', 'convert-stuck'];
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      out[id] = el ? (el.innerText ?? el.textContent ?? '').trim() : null;
    }
    return out;
  });
}

async function watchToTerminal(label, timeoutMs) {
  const t0 = Date.now();
  let lastNarr = '';
  let lastFace = 0;
  for (;;) {
    for (const endId of ['convert-failed', 'convert-stuck']) {
      const t = await textIfPresent(endId);
      if (t != null) {
        note(`${label}-terminal`, `${endId}: ${t}`);
        await driver.screenshot(`d33-${label}-${endId}`);
        face(driver, `${label}-${endId}`);
        return {ended: endId, text: t};
      }
    }
    const done = await textIfPresent('convert-done');
    if (done != null) {
      note(`${label}-terminal`, `convert-done: ${done}`);
      await driver.screenshot(`d33-${label}-done`);
      face(driver, `${label}-done`);
      return {ended: 'convert-done', text: done};
    }
    const st = await dumpConvertState().catch(() => null);
    const narr = [st?.['convert-step'], st?.['convert-chain-live'], st?.['convert-chain-awaiting'],
      st?.['convert-confirm-err'] ? `ERR: ${st['convert-confirm-err']}` : null]
      .filter(Boolean).join(' | ');
    if (narr.length > 0 && narr !== lastNarr) {
      note(`${label}-narration`, narr);
      lastNarr = narr;
      const now = Date.now();
      if (now - lastFace > 25_000) {
        await driver.screenshot(`d33-${label}-t${Math.round((now - t0) / 1000)}s`);
        face(driver, `${label}-t${Math.round((now - t0) / 1000)}s`);
        lastFace = now;
      }
    }
    if (st?.['convert-confirm-err'] != null) {
      note(`${label}-confirm-err`, st['convert-confirm-err']);
      await driver.screenshot(`d33-${label}-confirm-err`);
      face(driver, `${label}-confirm-err`);
      return {ended: 'confirm-err', text: st['convert-confirm-err']};
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`watchToTerminal(${label}): timeout — last: ${lastNarr || '(form)'}`);
    }
    await sleep(4_000);
  }
}

/** The record store: newest record under dpay.convert.v3.* (a MAP of id → record). */
async function newestRecord() {
  return driver.eval(() => {
    let best = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('dpay.convert.v3.')) continue;
      let obj;
      try { obj = JSON.parse(localStorage.getItem(k)); } catch { continue; }
      if (obj == null || typeof obj !== 'object') continue;
      const records = Array.isArray(obj) ? obj : Object.values(obj);
      for (const r of records) {
        if (r && typeof r.createdAtMs === 'number' && (best == null || r.createdAtMs > best.createdAtMs)) best = r;
      }
    }
    return best;
  });
}

const {buildWeb, serveWeb} = await import('./harness/web.mjs');
const {Driver} = await import('./harness/driver.mjs');
const {openBalances, selectCurrency, accountOf} = await import('./harness/lib.mjs');
const {icpPrincipalBytes, principalToText} = await import('./harness/wire.mjs');

await buildWeb({});
const web = await serveWeb();
const {browser, stop: stopBrowser} = await Driver.launchBrowser();
// solRpcUrl:'derive' — injectTestGlobals DISABLES the SOL rail on every page this driver opens;
// 'derive' deletes the override so the relay-derived RPC list stands (the production path).
const driver = await Driver.create(browser, {solRpcUrl: 'derive'});

// LIVE: the value path goes device-direct to the real IC boundary (the local build has no
// /api/v2 of its own — the app's operator override outranks the test seam; live-drive precedent).
await driver.addInitScript(() => {
  try { localStorage.setItem('dpay.icpGateway.v1', 'https://icp-api.io'); } catch { /* fresh ctx */ }
});

const page = `/?relay=${encodeURIComponent(PROD_RELAY)}`;
log(`navigating ${web.baseURL}${page}`);
await driver.navigate(web.baseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 30_000});
await driver.waitReady({timeoutMs: 30_000});
try {
  await driver.findByTestID('walkthrough', {timeoutMs: 6_000});
  await driver.click('btn-walkthrough-skip');
  note('walkthrough', 'skipped');
} catch { note('walkthrough', 'not shown'); }

await driver.click('btn-restore', {timeoutMs: 15_000});
await driver.click('btn-restore-mode-toggle', {timeoutMs: 10_000});
const seed = floatSeed();
try {
  await driver.type('restore-seed-input', seed);
  await driver.click('btn-restore-confirm', {timeoutMs: 15_000});
} finally {
  seed.replace(/./g, '0');
}
try {
  await driver.findByTestID('btn-home-currency-continue', {timeoutMs: 10_000});
  await driver.click('home-currency-CHF');
  await driver.click('btn-home-currency-continue');
} catch { /* already answered */ }
await driver.findByTestID('btn-home-accounts', {timeoutMs: 30_000});
const acct = await accountOf(driver);
if (!acct?.secretHex) throw new Error('restore: no identity in storage');
{
  const ed = await import('@noble/ed25519');
  const seedBytes = Uint8Array.from(acct.secretHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const pub = await ed.getPublicKeyAsync(seedBytes);
  const pubHex = Array.from(pub, (b) => b.toString(16).padStart(2, '0')).join('');
  const principalText = principalToText(icpPrincipalBytes(pub));
  if (principalText !== FLOAT_PRINCIPAL) throw new Error(`restore: WRONG WALLET (${principalText})`);
  note('principal-verified', principalText);
}
await driver.screenshot('d33-boot');
face(driver, 'boot');

// Open Convert on the EURC row (accounts code EUR; harness asset key sol-eurc).
await openBalances(driver);
await selectCurrency(driver, 'sol-eurc');
await openBalances(driver);
await driver.click('btn-accounts-convert-EUR', {timeoutMs: 12_000});
await driver.findByTestID('convert-screen', {timeoutMs: 12_000});
log('convert open for EURC');

// Target: VCHF (chip code CHF).
{
  if ((await driver.isPresent('convert-target-line')) && !(await driver.isPresent('convert-target-chips'))) {
    await driver.click('convert-target-line');
    await sleep(600);
  }
  const chips = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid^="convert-target-chip-"]'))
      .map((el) => el.getAttribute('data-testid').slice('convert-target-chip-'.length)),
  );
  const lineName = (await textIfPresent('convert-target-line')) ?? '';
  note('target-chips', `chips=${JSON.stringify(chips)} line="${lineName.replace(/\s+/g, ' ')}"`);
  if (chips.includes('CHF')) {
    await driver.click('convert-target-chip-CHF');
    note('target-picked', 'CHF');
  } else if (lineName.toUpperCase().includes('CHF') || lineName.toUpperCase().includes('FRANC')) {
    note('target-already', 'target line already CHF');
  } else {
    throw new Error(`no CHF chip among ${JSON.stringify(chips)}; line="${lineName}"`);
  }
  await sleep(1_200);
}

// MAX-NET prefill (the mission's size: the sheet's own spendable ceiling — min + headroom by
// construction; the venue minimum floats).
await driver.click('btn-convert-max');
await sleep(800);
const amt = await driver.readInputValue('convert-amount');
evidence.amount = amt;
note('amount', `max-net prefill = ${amt}`);

// The chain row: auto-active standing (the twin-CHF review) or an expander row.
const ROW = 'chain:sideshift-eurc:icpswap';
{
  const deadline = Date.now() + 150_000;
  let settledPath = null;
  let lastLog = 0;
  for (;;) {
    let present = await driver.isPresent(`convert-venue-${ROW}`);
    if (!present && (await driver.isPresent('btn-convert-venues-other'))) {
      if (!(await driver.isPresent('convert-venues-expanded'))) {
        await driver.click('btn-convert-venues-other');
        await sleep(700);
      }
      present = await driver.isPresent(`convert-venue-${ROW}`);
    }
    if (present) {
      const quoted = await driver.isPresent(`convert-venue-${ROW}-quote`);
      const err = await textIfPresent(`convert-venue-${ROW}-err`);
      if (quoted) {
        note('chain-row-quote', await driver.readText(`convert-venue-${ROW}-quote`));
        await driver.click(`convert-venue-${ROW}`);
        note('row-picked', ROW);
        settledPath = 'expander';
        break;
      }
      if (err != null) throw new Error(`chain row quote error: ${err}`);
    }
    const settleNow = await textIfPresent('convert-settle-address');
    if (!present && settleNow != null && settleNow.includes('9fac39d1')) {
      note('row-active', 'chain row already the active review (settle = float IC account)');
      settledPath = 'standing';
      break;
    }
    const now = Date.now();
    if (now - lastLog > 15_000) {
      lastLog = now;
      const diag = await driver.eval(() => ({
        expanderBtn: document.querySelector('[data-testid="btn-convert-venues-other"]') != null,
        expanded: document.querySelector('[data-testid="convert-venues-expanded"]') != null,
        venueRows: Array.from(document.querySelectorAll('[data-testid^="convert-venue-"]'))
          .map((el) => el.getAttribute('data-testid')),
        source: document.querySelector('[data-testid="convert-quote-source"]')?.textContent ?? null,
      }));
      note('chain-row-wait', JSON.stringify(diag));
    }
    if (Date.now() > deadline) throw new Error('chain row never quoted');
    await sleep(1_500);
  }
  await sleep(1_200);
  if (!(await driver.isPresent('convert-settle-address'))) {
    await driver.findByTestID('convert-settle-address', {timeoutMs: 45_000});
  }
}

const headline = await textIfPresent('convert-headline');
const source = await textIfPresent('convert-quote-source');
const via = await textIfPresent('convert-route-via');
const settle = await textIfPresent('convert-settle-address');
evidence.quote = {headline, source, via, settle};
note('quote', JSON.stringify({headline, source, via, settle}));
await driver.screenshot('d33-review');
face(driver, 'review', {headline, source, via});
if (settle == null || !(settle.includes(IC_ACCOUNT) || settle.includes('9fac39d1'))) {
  evidence.guard = `ABORT: chain settle address "${settle}" is not the float IC account`;
  saveEvidence();
  throw new Error(`GUARD: chain settle "${settle}" != float IC account`);
}
evidence.guard = 'PASS: settle = float IC account';
saveEvidence();

// THE ONE CONSENT — order first, then the frozen deposit signs + broadcasts (D33: fixed path).
{
  const deadline = Date.now() + 180_000;
  let st = null;
  for (;;) {
    st = await driver.eval(() => {
      const btn = document.querySelector('[data-testid="btn-convert-confirm"]');
      if (!btn) return {present: false};
      const r = btn.getBoundingClientRect();
      return {present: true, disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true', w: r.width, h: r.height};
    });
    if (st.present && !st.disabled && st.w > 0) break;
    const err = await textIfPresent('convert-confirm-err');
    if (err != null) {
      note('confirm-err', err);
      await driver.screenshot('d33-confirm-err');
      face(driver, 'confirm-err');
      throw new Error(`confirm error before arming: ${err}`);
    }
    if (Date.now() > deadline) {
      const body = await driver.eval(() => (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1_200));
      note('cta-stuck', `disabled ${JSON.stringify(st)} body: ${body}`);
      await driver.screenshot('d33-cta-stuck');
      face(driver, 'cta-stuck');
      throw new Error(`CTA never armed: ${JSON.stringify(st)}`);
    }
    await sleep(3_000);
  }
  await driver.click('btn-convert-confirm');
  note('cta', 'pressed once');
}
saveEvidence();

const r = await watchToTerminal('trip', 40 * 60_000);
const rec = await newestRecord();
evidence.record = rec ? {
  id: rec.id, venueId: rec.venueId, venue2Id: rec.venue2Id, step: rec.step,
  failureCode: rec.failureCode ?? null, failureDetail: rec.failureDetail ?? null,
  amountIn: rec.amountIn, expectedGross: rec.expectedGross, expectedNet: rec.expectedNet,
  providerRef: rec.providerRef, chainRoute: rec.chainRoute, hopLedger: rec.hopLedger,
  outLedger: rec.outLedger,
  solanaLeg: rec.solanaLeg ? {signature: rec.solanaLeg.signature, lastValidBlockHeight: rec.solanaLeg.lastValidBlockHeight} : null,
  legs: rec.legs, outAmountNet: rec.outAmountNet ?? null, outTx: rec.outTx ?? null,
} : null;
note('record', JSON.stringify(evidence.record));
saveEvidence();
if (r.ended !== 'convert-done') {
  throw new Error(`D33 ENDED ${r.ended}: ${r.text}`);
}
log('D33 COMPLETE — chain trip done. Verify + ledger outside.');
