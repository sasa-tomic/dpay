#!/usr/bin/env node
// e2e/live-d32.mjs — D32 SELF-FUNDED FULL CHAIN ROUND TRIP, live mainnet, the REAL prod wallet.
//
// Founder-authorized 2026-09-29 ("why do you keep asking me for more funds all the time when
// there are funds"): convert ICP→EURC to fund the chain trip. Two phases, one browser session:
//   PHASE 1  ICP → EURC  — the cross-rail CeFi row (sideshift-eurc), deposit 3.20421219 ICP,
//                          GUARD: locked net ≥ 8.80 EURC or abort before the CTA.
//   PHASE 2  EURC → ICP → VCHF — the NEW any-pair chain row (chain:sideshift-eurc:icpswap),
//                          exact venue minimum 8.789539 EURC deposit.
// Topology: SAME-ORIGIN — the browser drives https://dpay.kalaj.org/wallet itself (the prod
// relay serves the app; /api has no CORS by design, so ?relay= cross-origin is a non-starter).
// Seed discipline: the IC float seed is decrypted INSIDE this process and typed into the
// restore form. Never printed, never logged, never written.
// Evidence: every face screenshotted (e2e/shots/d32-*) + copied to /home/sat/projects/dpay/tmp/d32/
// with evidence.json (verbatim strings, no secrets).
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const E2E = dirname(fileURLToPath(import.meta.url));
const ROOT = join(E2E, '..');
const EV = '/home/sat/projects/dpay/tmp/d32';
const SHOTS = join(E2E, 'shots');
mkdirSync(SHOTS, {recursive: true});
mkdirSync(EV, {recursive: true});

const PROD = 'https://dpay.kalaj.org';
const FLOAT_PRINCIPAL = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const SOL_SETTLE = 'BzFNJywhJYtPKNZN8fefuiKetSCD8Uotw1ibuP8MkZgX';
const IC_ACCOUNT = '9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279';
const PHASE1_AMOUNT = '3.20421219'; // balance 3.20431219 − 0.0001 ledger fee = max spendable
const PHASE2_AMOUNT = '8.789539';   // the chain venue's exact minimum
const GUARD_MIN = 8.8;              // founder-operator guard: locked net ≥ 8.80 EURC

const log = (...a) => console.log(`[d32 ${new Date().toISOString().slice(11, 23)}]`, ...a);

const evidence = {startedAt: new Date().toISOString(), faces: [], steps: []};
function face(driver, name, data) {
  evidence.faces.push({name, at: new Date().toISOString(), ...(data ?? {})});
  try { copyFileSync(join(SHOTS, `d32-${name}.png`), join(EV, `d32-${name}.png`)); } catch { /* shot may have failed */ }
  log(`face: d32-${name}`);
}
function note(kind, text) {
  evidence.steps.push({kind, at: new Date().toISOString(), text: String(text).slice(0, 2_000)});
  log(`${kind}: ${String(text).slice(0, 220)}`);
}
const saveEvidence = () => writeFileSync(join(EV, 'evidence.json'), JSON.stringify(evidence, null, 1));

function floatSeed() {
  const hex = execFileSync('node', ['scripts/agent-key.mjs', 'seed'],
    {encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('floatSeed: refused (not 64 hex chars)');
  return hex;
}

async function balanceSol() {
  const out = execFileSync('just', ['funds', 'balance', 'sol-rail'],
    {encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000});
  const eurc = out.match(/EURC\s+([\d.]+)/)?.[1] ?? null;
  const sol = out.match(/SOL\s+([\d.]+)/)?.[1] ?? null;
  const usdc = out.match(/USDC\s+([\d.]+)/)?.[1] ?? null;
  return {eurc, sol, usdc, raw: out};
}

// --- driver + app session -------------------------------------------------------------------

const {Driver} = await import('./harness/driver.mjs');
const {openBalances, selectCurrency, accountOf} = await import('./harness/lib.mjs');

const {browser, stop: stopBrowser} = await Driver.launchBrowser();
// solRpcUrl:'derive' — injectTestGlobals (unconditional on every page this driver opens)
// DISABLES the SOL rail by default (globalThis.__DPAY_TEST_SOLANA_RPC_URL = ''). 'derive'
// deletes that override so the app derives the RPC list from the relay bases — the exact
// production path (live-drive.mjs, found live 2026-09-20: submits die with SolanaRelayPathDown
// without it).
const driver = await Driver.create(browser, {solRpcUrl: 'derive'});

async function textIfPresent(testID) {
  if (!(await driver.isPresent(testID))) return null;
  return (await driver.readText(testID)).trim();
}

async function dumpConvertState(tag) {
  const state = await driver.eval(() => {
    const ids = ['convert-route-via', 'convert-quote-source', 'convert-headline', 'convert-settle-address',
      'convert-confirm-err', 'convert-step', 'convert-chain-live', 'convert-awaiting-deposit',
      'convert-deposit-address', 'convert-deposit-amount', 'convert-deposit-memo',
      'convert-done', 'convert-failed', 'convert-stuck'];
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      out[id] = el ? (el.innerText ?? el.textContent ?? '').trim() : null;
    }
    return out;
  });
  note(tag, JSON.stringify(state));
  return state;
}

async function readQuoteBlock() {
  await driver.findByTestID('convert-headline', {timeoutMs: 20_000});
  await sleep(1_500);
  const headline = await textIfPresent('convert-headline');
  const quoteSource = await textIfPresent('convert-quote-source');
  const routeVia = await textIfPresent('convert-route-via');
  const settleAddress = await textIfPresent('convert-settle-address');
  const body = await driver.bodyText();
  return {headline, quoteSource, routeVia, settleAddress, bodySlice: body.replace(/\s+/g, ' ').slice(0, 3_000)};
}

/** Watch the convert surface until a terminal testID appears. Logs every narration change. */
async function watchToTerminal(label, timeoutMs) {
  const t0 = Date.now();
  let lastNarr = '';
  let lastFace = 0;
  for (;;) {
    for (const endId of ['convert-failed', 'convert-stuck']) {
      const t = await textIfPresent(endId);
      if (t != null) {
        note(`${label}-terminal`, `${endId}: ${t}`);
        await driver.screenshot(`d32-${label}-${endId}`);
        face(driver, `${label}-${endId}`);
        return {ended: endId, text: t};
      }
    }
    const done = await textIfPresent('convert-done');
    if (done != null) {
      note(`${label}-terminal`, `convert-done: ${done}`);
      await driver.screenshot(`d32-${label}-done`);
      face(driver, `${label}-done`);
      return {ended: 'convert-done', text: done};
    }
    const st = await dumpConvertState(`${label}-poll`).catch(() => null);
    const narr = [st?.['convert-step'], st?.['convert-chain-live'], st?.['convert-awaiting-deposit'],
      st?.['convert-deposit-address'] ? 'deposit-panel' : null].filter(Boolean).join(' | ');
    if (narr.length > 0 && narr !== lastNarr) {
      note(`${label}-narration`, narr);
      lastNarr = narr;
      const now = Date.now();
      if (now - lastFace > 20_000) {
        await driver.screenshot(`d32-${label}-t${Math.round((now - t0) / 1000)}s`);
        face(driver, `${label}-t${Math.round((now - t0) / 1000)}s`);
        lastFace = now;
      }
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`watchToTerminal(${label}): timeout ${Math.round(timeoutMs / 1000)}s — last: ${lastNarr || '(form)'}`);
    }
    await sleep(4_000);
  }
}

/** The record store: newest record under dpay.convert.v3.* — order ids, exact figures.
 *  The store value is a MAP ({[recordId]: record}); older generations were arrays. */
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

async function openConvertFor(code) {
  await openBalances(driver);
  await selectCurrency(driver, code.toLowerCase());
  await openBalances(driver);
  await driver.click(`btn-accounts-convert-${code}`, {timeoutMs: 12_000});
  await driver.findByTestID('convert-screen', {timeoutMs: 12_000});
  log(`convert open for ${code}`);
}

/** The RECEIVE leg: open the target chips and pick one. Chips are CURRENCY CODES
 *  (USD/EUR/BTC/ETH/SOL/CHF…), not asset symbols — EURC is chip "EUR", VCHF is "CHF".
 *  If the chip set does not carry the code but the target line ALREADY names it, proceed. */
const CHIP_OF = {EURC: 'EUR', VCHF: 'CHF', USDC: 'USD'};
async function setTarget(code) {
  const chipCode = CHIP_OF[code] ?? code;
  if ((await driver.isPresent('convert-target-line'))
      && !(await driver.isPresent('convert-target-chips'))) {
    await driver.click('convert-target-line');
    await sleep(600);
  }
  const chips = await driver.eval(() =>
    Array.from(document.querySelectorAll('[data-testid^="convert-target-chip-"]'))
      .map((el) => el.getAttribute('data-testid').slice('convert-target-chip-'.length)),
  );
  const lineName = (await textIfPresent('convert-target-line')) ?? '';
  note('target-chips', `chips=${JSON.stringify(chips)} line="${lineName.replace(/\s+/g, ' ')}"`);
  if (chips.includes(chipCode)) {
    await driver.click(`convert-target-chip-${chipCode}`);
    note('target-picked', chipCode);
  } else if (lineName.toUpperCase().includes(chipCode)) {
    note('target-already', `target line already names ${chipCode}`);
  } else {
    throw new Error(`setTarget: no chip ${chipCode} among ${JSON.stringify(chips)}; line="${lineName}"`);
  }
  await sleep(1_200);
}

/** Open the Other-venues expander and pick ONE row once ITS OWN quote has landed.
 *  rowId is the registry row id verbatim (e.g. 'sideshift-eurc',
 *  'chain:sideshift-eurc:icpswap'). If the row is not in the expander but the ACTIVE
 *  review already names activeHint (auto-pick made it the standing row), proceed.
 *  Throws on the row's own quote error. */
async function pickVenueRow(rowId, activeHint, {timeoutMs = 150_000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let present = await driver.isPresent(`convert-venue-${rowId}`);
    if (!present && (await driver.isPresent('btn-convert-venues-other'))) {
      if (!(await driver.isPresent('convert-venues-expanded'))) {
        await driver.click('btn-convert-venues-other');
        await sleep(700);
      }
      present = await driver.isPresent(`convert-venue-${rowId}`);
    }
    if (present) {
      const quoted = await driver.isPresent(`convert-venue-${rowId}-quote`);
      const err = await textIfPresent(`convert-venue-${rowId}-err`);
      if (quoted) {
        await driver.click(`convert-venue-${rowId}`);
        note('row-picked', rowId);
        break;
      }
      if (err != null) throw new Error(`row ${rowId} quote error: ${err}`);
    }
    // Not an expander row: auto-pick may have made it the ACTIVE (standing) row already.
    if (!present && activeHint != null) {
      const src = ((await textIfPresent('convert-quote-source')) ?? '')
        + ' ' + ((await textIfPresent('convert-route-via')) ?? '');
      if (src.toLowerCase().includes(activeHint.toLowerCase())) {
        note('row-active', `${rowId} already the active row (matched "${activeHint}")`);
        break;
      }
    }
    if (Date.now() > deadline) throw new Error(`pickVenueRow: ${rowId} never quoted within ${timeoutMs / 1000}s`);
    await sleep(1_500);
  }
  // The picked row becomes the active review; its settle-address line must render.
  await driver.findByTestID('convert-settle-address', {timeoutMs: 45_000});
  await sleep(1_000);
}

/** Press the CTA once, but only when it is genuinely ARMED (present, enabled, laid out). */
async function armedConfirm(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await driver.eval(() => {
      const btn = document.querySelector('[data-testid="btn-convert-confirm"]');
      if (!btn) return {present: false};
      const r = btn.getBoundingClientRect();
      return {
        present: true,
        disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true',
        w: Math.round(r.width), h: Math.round(r.height),
      };
    });
    if (st.present && !st.disabled && st.w > 0 && st.h > 0) {
      await driver.click('btn-convert-confirm');
      note('cta', 'pressed once');
      return;
    }
    if (Date.now() > deadline) throw new Error(`armedConfirm: never armed (${JSON.stringify(st)})`);
    await sleep(2_000);
  }
}

// --- boot: prod wallet, walkthrough, restore, principal verify -------------------------------

log(`navigating ${PROD}/wallet`);
await driver.navigate(PROD, '/wallet', {waitUntil: 'domcontentloaded', timeoutMs: 30_000});
await driver.waitReady({timeoutMs: 30_000});

// Fresh browser context: the first-run walkthrough may show. Skip it.
try {
  await driver.findByTestID('walkthrough', {timeoutMs: 6_000});
  await driver.click('btn-walkthrough-skip');
  note('walkthrough', 'skipped');
} catch { note('walkthrough', 'not shown'); }

// Restore the float through the REAL restore form (hex seed mode).
await driver.click('btn-restore', {timeoutMs: 15_000});
await driver.click('btn-restore-mode-toggle', {timeoutMs: 10_000});
const seed = floatSeed();
try {
  await driver.type('restore-seed-input', seed);
  await driver.click('btn-restore-confirm', {timeoutMs: 15_000});
} finally {
  seed.replace(/./g, '0'); // in-memory hygiene only
}
try {
  await driver.findByTestID('btn-home-currency-continue', {timeoutMs: 10_000});
  await driver.click('home-currency-CHF');
  await driver.click('btn-home-currency-continue');
  note('home-currency', 'CHF');
} catch { note('home-currency', 'chooser not shown'); }

await driver.findByTestID('btn-home-accounts', {timeoutMs: 30_000});
const acct = await accountOf(driver);
if (!acct?.secretHex) throw new Error('restore: no identity in storage');
let pubHex;
let principalText;
{
  // Same derivation live-drive.mjs uses: pubkey from the restored secret, principal text from
  // the harness helpers. The public half only — never the seed.
  const ed = await import('@noble/ed25519');
  const seed = Uint8Array.from(acct.secretHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const pub = await ed.getPublicKeyAsync(seed);
  pubHex = Array.from(pub, (b) => b.toString(16).padStart(2, '0')).join('');
  const {icpPrincipalBytes, principalToText} = await import('./harness/wire.mjs');
  principalText = principalToText(icpPrincipalBytes(pub));
}
if (principalText !== FLOAT_PRINCIPAL) {
  throw new Error(`restore: WRONG WALLET (${principalText}) — refusing to touch anything`);
}
note('principal-verified', principalText);await driver.screenshot('d32-boot-restored');
face(driver, 'boot-restored');

// --- PHASE 1: ICP → EURC (cross-rail CeFi) ---------------------------------------------------

note('phase1-begin', `ICP→EURC, guard ≥ ${GUARD_MIN} EURC net, max-net prefill`);
await openConvertFor('ICP');
await setTarget('EURC');
await driver.click('btn-convert-max'); // Max-net prefill (the app's own spendable ceiling)
await sleep(800);
const amt1 = await driver.readInputValue('convert-amount');
evidence.phase1Amount = amt1;
note('phase1-amount', `max prefill = ${amt1}`);
await pickVenueRow('sideshift-eurc', 'SideShift');
const q1 = await readQuoteBlock();
evidence.phase1Quote = {headline: q1.headline, source: q1.quoteSource, via: q1.routeVia, settle: q1.settleAddress};
note('phase1-quote', JSON.stringify({headline: q1.headline, source: q1.quoteSource, via: q1.routeVia, settle: q1.settleAddress}));
await driver.screenshot('d32-p1-review');
face(driver, 'p1-review', {headline: q1.headline, source: q1.quoteSource, via: q1.routeVia});

// GUARD + settle-address verification — BEFORE anything is signed.
if (q1.settleAddress == null || !q1.settleAddress.includes(SOL_SETTLE)) {
  evidence.guard = 'ABORT: settle address on the review card is not the float SOL rail';
  saveEvidence();
  throw new Error(`GUARD: review settle address "${q1.settleAddress}" does not name ${SOL_SETTLE}`);
}
const eurcFigures = ((q1.headline ?? '') + ' ' + q1.bodySlice).match(/([\d][\d.,]*)\s*EURC/g)
  ?.map((s) => parseFloat(s.replace(/[^\d.]/g, ''))) ?? [];
const netQuote = eurcFigures.length > 0 ? Math.max(...eurcFigures) : NaN;
note('phase1-guard', `parsed EURC figures ${JSON.stringify(eurcFigures)} → net ${netQuote}`);
if (!(netQuote >= GUARD_MIN)) {
  evidence.guard = `ABORT: locked net ${netQuote} < ${GUARD_MIN} — ICP untouched`;
  saveEvidence();
  throw new Error(`GUARD FAILED: net ${netQuote} EURC < ${GUARD_MIN} — leaving the ICP untouched`);
}
evidence.guard = `PASS: net ${netQuote} ≥ ${GUARD_MIN}`;
saveEvidence();

// THE ONE CONSENT of phase 1 (re-quotes fresh at the gesture).
await armedConfirm();

// The plain-CeFi handoff: the order now exists; the deposit is the USER's own send from
// this wallet (the second press). Read the frozen facts from the record store itself.
let rec1 = null;
for (let i = 0; i < 60; i++) {
  rec1 = await newestRecord();
  if (rec1 != null && rec1.step === 'awaiting_deposit' && rec1.providerDeposit != null) break;
  await sleep(1_500);
}
if (rec1 == null || rec1.providerDeposit == null) {
  evidence.phase1Record = rec1;
  saveEvidence();
  throw new Error(`phase1: order never surfaced deposit facts — step=${rec1?.step}`);
}
const dep = rec1.providerDeposit;
evidence.phase1Order = {
  id: rec1.id, orderId: rec1.providerRef?.orderId, statusUrl: rec1.providerRef?.statusUrl,
  depositAddress: dep.depositAddress, depositAmount: dep.depositAmount,
  depositMemo: dep.depositMemo ?? null, expiresAtMs: dep.expiresAtMs ?? null,
  expectedNet: rec1.expectedNet, amountIn: rec1.amountIn,
};
note('phase1-order', JSON.stringify(evidence.phase1Order));
if (dep.depositMemo != null) {
  // The venue credits by (address, amount, memo) — a memo this app's send sheet cannot
  // carry (it stamps its own receipt memo) must not be guessed around.
  saveEvidence();
  throw new Error(`phase1: venue issued depositMemo "${dep.depositMemo}" — the send sheet cannot carry a venue memo; stopping unfunded`);
}
await driver.screenshot('d32-p1-handoff');
face(driver, 'p1-handoff', evidence.phase1Order);

// THE SECOND PRESS: the wallet's own IC send sheet, exact amount, the venue's address.
await openBalances(driver);
await selectCurrency(driver, 'icp');
await driver.click('tab-pay', {timeoutMs: 10_000});
await driver.click('btn-pay-send', {timeoutMs: 10_000});
await driver.findByTestID('send-address-input', {timeoutMs: 15_000});
await driver.type('send-address-input', dep.depositAddress);
let routed = false;
for (let i = 0; i < 30; i++) {
  const st = (await textIfPresent('send-status')) ?? '';
  if (st.includes('Internet Computer')) { routed = true; break; }
  const err = await textIfPresent('send-err');
  if (err != null) throw new Error(`phase1 send: destination refused: ${err}`);
  await sleep(1_000);
}
if (!routed) throw new Error(`phase1 send: destination never disclosed a route (status: ${(await textIfPresent('send-status')) ?? 'none'})`);
await driver.type('send-amount-input', dep.depositAmount);
await sleep(1_000);
const rvAmount = await textIfPresent('send-review-amount');
const rvTo = await textIfPresent('send-review-to');
note('phase1-send-review', `amount="${rvAmount}" to="${rvTo}"`);
evidence.phase1SendReview = {amount: rvAmount, to: rvTo};
await driver.screenshot('d32-p1-send-review');
face(driver, 'p1-send-review', {amount: rvAmount, to: rvTo});
await driver.click('btn-send-confirm', {timeoutMs: 15_000});
// The send terminal: block index once settled, "sent (unknown)" while pending.
let sendRef = null;
for (let i = 0; i < 60; i++) {
  sendRef = await textIfPresent('send-ref');
  if (sendRef != null) break;
  const err = await textIfPresent('send-err');
  if (err != null) throw new Error(`phase1 send failed: ${err}`);
  await sleep(2_000);
}
evidence.phase1SendRef = sendRef;
note('phase1-send-terminal', `ref=${sendRef}`);
await driver.screenshot('d32-p1-sent');
face(driver, 'p1-sent', {ref: sendRef});

// The venue settles → the resume engine flips the record to done. Watch BOTH the store
// and the measured rail (the chain is the oracle; the store is the narration).
let bal1 = null;
let done1 = false;
for (let i = 0; i < 60; i++) {
  bal1 = await balanceSol();
  const rec = await newestRecord();
  note('phase1-watch', `step=${rec?.step} EURC=${bal1.eurc}`);
  if (rec?.step === 'done') { done1 = true; evidence.phase1Record = rec; break; }
  if (bal1.eurc != null && parseFloat(bal1.eurc) >= 8.79 && rec?.step === 'done') { done1 = true; break; }
  if (i > 4 && bal1.eurc != null && parseFloat(bal1.eurc) >= 8.79 && ['settling', 'awaiting_deposit'].includes(rec?.step ?? '')) {
    // funds measured on-chain; keep waiting for the engine's done flip a few rounds only
  }
  if (Date.now() > (dep.expiresAtMs ?? (Date.now() + 14 * 60_000)) + 60_000) break;
  await sleep(20_000);
}
evidence.phase1Balances = bal1;
evidence.phase1Done = done1;
if (bal1.eurc == null || parseFloat(bal1.eurc) < 8.79) {
  saveEvidence();
  throw new Error(`phase1: EURC never reached 8.79 on the rail (last ${bal1.eurc}) — phase 2 not funded`);
}
note('phase1-settled', `EURC measured ${bal1.eurc} (record step ${done1 ? 'done' : 'still watching'})`);
if (bal1.eurc != null && parseFloat(bal1.eurc) < 8.79) {
  saveEvidence();
  throw new Error('phase1: EURC short of the chain minimum — not proceeding');
}

// --- PHASE 2: EURC → ICP → VCHF (the chain row) ----------------------------------------------

note('phase2-begin', `EURC→VCHF chain deposit ${PHASE2_AMOUNT} (exact venue minimum)`);
await openConvertFor('EURC');
await setTarget('VCHF');
await driver.type('convert-amount', PHASE2_AMOUNT);
await pickVenueRow('chain:sideshift-eurc:icpswap', 'SideShift');
const q2 = await readQuoteBlock();
evidence.phase2Quote = {headline: q2.headline, source: q2.quoteSource, via: q2.routeVia, settle: q2.settleAddress};
note('phase2-quote', JSON.stringify({headline: q2.headline, source: q2.quoteSource, via: q2.routeVia, settle: q2.settleAddress}));
await driver.screenshot('d32-p2-review');
face(driver, 'p2-review', {headline: q2.headline, source: q2.quoteSource, via: q2.routeVia});
if (q2.settleAddress == null || !(q2.settleAddress.includes(IC_ACCOUNT) || q2.settleAddress.includes('9fac39d1'))) {
  evidence.guard2 = 'ABORT: chain settle address is not the float IC account';
  saveEvidence();
  throw new Error(`GUARD: chain settle address "${q2.settleAddress}" is not the float IC account`);
}
evidence.guard2 = 'PASS: settle = float IC account';
saveEvidence();

// THE ONE CONSENT of phase 2: order → deposit sign+submit → venue watch → IC legs.
await armedConfirm();
const r2 = await watchToTerminal('p2', 30 * 60_000);
const rec2 = await newestRecord();
evidence.phase2Record = rec2 ? {
  id: rec2.id, venueId: rec2.venueId, venue2Id: rec2.venue2Id, step: rec2.step,
  amountIn: rec2.amountIn, expectedGross: rec2.expectedGross, expectedNet: rec2.expectedNet,
  providerRef: rec2.providerRef, chainRoute: rec2.chainRoute, hopLedger: rec2.hopLedger,
  outLedger: rec2.outLedger, solanaLeg: rec2.solanaLeg ? {signature: rec2.solanaLeg.signature} : null,
} : null;
note('phase2-record', JSON.stringify(evidence.phase2Record));
if (r2.ended !== 'convert-done') {
  saveEvidence();
  throw new Error(`PHASE 2 ENDED ${r2.ended}: ${r2.text}`);
}

const bal2 = await balanceSol();
evidence.phase2BalancesSol = bal2;
note('phase2-end', `SOL rail after: EURC ${bal2.eurc} SOL ${bal2.sol}`);
saveEvidence();
log('D32 SCRIPT COMPLETE — both phases done. Verify + ledger outside.');
