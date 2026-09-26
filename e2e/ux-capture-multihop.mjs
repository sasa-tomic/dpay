// UX-EXPERT CAPTURE SCRIPT — multi-hop Route A (ICP → USDC on Ethereum), 2026-09-14 spec.
//
// NOT a numbered flow: a one-shot visual-evidence collector for the founder UX pass. It drives
// the REAL app through every meaningful state of the new convert UI and screenshots each:
//   A (light/en):  destination picker → gas-preflight block (no ckETH) → invalid address →
//                  funded route detail (fee census) → mid-execution leg list → done panel →
//                  the failed_leg dead-end (via a seeded expired resume + hung ledger probe) →
//                  the stuck panel (seeded, unacknowledged).
//   B (dark/de):   picker, preflight (German long-copy), route detail, done, dead-end.
//   C/D (es, fr):  route detail + dead-end.
//
// The dead-end is reached HONESTLY through the real engine: a planned record is seeded at
// `pending_withdrawal` with legs already expired and a hop payout row that EXISTS on the private
// relay (the wallet's own earlier swap payout). The engine's expiry trichotomy (app/convert.ts
// executePlannedConvert) probes the hop row, sees it, and commits failed_leg — on screen. To keep
// the record in `pending_withdrawal` until the convert screen is mounted (terminal records are
// never resurrected by ConvertMode.pick), /api/v1/transactions requests are intercepted+hung until
// the panel is on screen, then released so the probe resolves while the screen watches.
//
// Run: node e2e/ux-capture-multihop.mjs            (screenshots land in e2e/shots/ux-*)
import {setup, stopSession, assert, assertIncludes, onboardWallet, accountOf,
        faucetAccount, getBalance, openBalances, selectCurrency, railPrincipalText} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const CKUSDC_LEDGER = 'xevnm-gaaaa-aaaar-qafnq-cai';
const CKUSDC_POOL = 'mohjv-bqaaa-aaaag-qjyia-cai'; // venue icpswap-ckusdc's OWN pool
const ROUTE_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2';
const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // valid 0x+40hex (lowercase)
const BAD_DEST = '0x1234'; // fails live validation

const SEED_ICP = 2000000000;      // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH — passes the gas preflight
const AMOUNT = '5';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Open the convert screen for ICP (the flow-184 entry path). */
async function openConvertIcp(driver) {
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver);
  await driver.click('btn-accounts-convert', {timeoutMs: 6_000});
}

/** Pick the Route A row, type the destination address, wait for the census (route-min testID). */
async function pickRouteAndWaitCensus(driver, address) {
  await driver.click(ROUTE_ROW, {timeoutMs: 4_000});
  await driver.findByTestID('convert-dest-address', {timeoutMs: 4_000});
  await driver.type('convert-dest-address', address);
  await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
}

/** aria-disabled read on the confirm button (flow-145's confirmDisabled pattern). */
async function confirmDisabled(driver) {
  const el = await driver.findByTestID('btn-convert-confirm', {timeoutMs: 4_000});
  return await el.evaluate(node => node.getAttribute('aria-disabled') === 'true' || node.disabled === true);
}

/** Root overflow check (flow-145's class): the money screen must never slide sideways. */
async function overflowReport(driver) {
  return await driver.eval(() => {
    const d = document.scrollingElement;
    return {scrollW: d.scrollWidth, clientW: d.clientWidth};
  });
}

/** The wallet's ckUSDC payout row FROM THE POOL on this private relay (probeHop's exact match). */
async function poolPayoutRow(relayBaseURL, publicHex) {
  const principal = (await railPrincipalText(publicHex)).toLowerCase();
  const res = await fetch(`${relayBaseURL}/api/v1/transactions/${publicHex}?currency=2&limit=50`);
  if (!res.ok) throw new Error(`transactions read failed (${res.status})`);
  const body = await res.json();
  const rows = body.transactions ?? body.rows ?? [];
  const row = rows.find(r => String(r.from ?? '').toLowerCase() === CKUSDC_POOL
    && String(r.to ?? '').toLowerCase() === principal);
  if (row == null) throw new Error(`no pool→wallet ckUSDC row found (${rows.length} rows scanned; `
    + `first row keys: ${rows[0] ? JSON.stringify(Object.keys(rows[0])) : 'none'}; `
    + `wanted from=${CKUSDC_POOL} to=${principal})`);
  return row;
}

/**
 * Seed the convert store with a clone of the wallet's (done) multihop record, patched into a
 * `pending_withdrawal` resume whose legs are EXPIRED and whose [minOut..expectedGross] bracket
 * equals `payoutAmount` exactly (slippage 0 → lo = hi = n → the probe's BigInt(n)===lo match).
 */
async function seedPendingWithdrawal(driver, publicHex, payoutAmount, {id, failureDetail}) {
  await driver.eval((key, seedId, payout, detail, now) => {
    const store = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    const tpl = Object.values(store).find(r => r != null && Array.isArray(r.legPlan) && r.step === 'done');
    if (tpl == null) throw new Error('no done multihop record to clone');
    const rec = JSON.parse(JSON.stringify(tpl));
    delete rec.outAmountNet; delete rec.outTx; delete rec.hopTx;
    delete rec.failureCode; delete rec.failureDetail; delete rec.acknowledgedStuckAtMs;
    rec.id = seedId;
    rec.step = 'pending_withdrawal';
    rec.createdAtMs = now + 1_000;
    rec.slippageBps = 0;
    rec.expectedGross = String(payout);
    if (detail != null) rec.failureDetail = detail;
    rec.legs = rec.legs.map(l => ({...l, expiresAtMs: now - 60_000}));
    rec.legPlan = rec.legPlan.map((lp, i) => ({...lp, state: i === 0 ? 'confirmed' : 'pending'}));
    store[seedId] = rec;
    window.localStorage.setItem(key, JSON.stringify(store));
    return Object.keys(store);
  }, `dpay.convert.v3.${publicHex}`, id, String(payoutAmount), failureDetail ?? null, Date.now());
}

/** Seed a `stuck` (unacknowledged, planned) record — ConvertMode still shows it (needs the eye). */
async function seedStuck(driver, publicHex, payoutAmount, {id}) {
  await driver.eval((key, seedId, payout, now) => {
    const store = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    const tpl = Object.values(store).find(r => r != null && Array.isArray(r.legPlan));
    if (tpl == null) throw new Error('no multihop record to clone');
    const rec = JSON.parse(JSON.stringify(tpl));
    delete rec.failureCode; delete rec.failureDetail; delete rec.acknowledgedStuckAtMs;
    rec.id = seedId;
    rec.step = 'stuck';
    rec.createdAtMs = now + 2_000;
    rec.slippageBps = 0;
    rec.expectedGross = String(BigInt(payout) + 1n); // OUT of probe range → stays stuck
    rec.legPlan = rec.legPlan.map((lp, i) => ({...lp, state: i < 2 ? 'confirmed' : (i === 4 ? 'sent' : 'pending')}));
    // drop other seeds, keep genuine records
    for (const k of Object.keys(store)) if (k.startsWith('seeded-')) delete store[k];
    store[seedId] = rec;
    window.localStorage.setItem(key, JSON.stringify(store));
    return Object.keys(store);
  }, `dpay.convert.v3.${publicHex}`, id, String(payoutAmount), Date.now());
}

/**
 * Hang every /api/v1/transactions request until `release()`. Keeps the engine's hop probe
 * in flight so the seeded record is still `pending_withdrawal` when the convert screen mounts.
 */
async function hangTransactionProbes(driver) {
  const queued = [];
  const handler = req => {
    if (req.url().includes('/api/v1/transactions')) queued.push(req); // hang: no continue/abort
    else req.continue().catch(() => {});
  };
  driver.page.on('request', handler); // listener FIRST — a paused request with no listener hangs forever
  await driver.page.setRequestInterception(true);
  return {
    release() {
      for (const req of queued.splice(0)) req.continue().catch(() => {});
      driver.page.off('request', handler);
      driver.page.on('request', req => req.continue().catch(() => {}));
    },
  };
}

/** Drive the happy path (confirm loop) and screenshot the mid-execution leg list + done panel. */
async function runHappyPath(driver, relayBaseURL, {tag, wantShots}) {
  // quote-changed interrupts demand a re-confirm — retry a few rounds (flow-184 pattern)
  for (let round = 0; round < 5; round++) {
    await driver.click('btn-convert-confirm');
    const changed = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_000}).catch(() => null);
    if (changed == null) break;
    await sleep(300);
  }
  if (wantShots?.mid) {
    await driver.findByTestID('convert-approving', {timeoutMs: 10_000}).catch(() => {});
    await driver.screenshot(`${tag}-mid-execution`);
    for (let i = 0; i < 5; i++) {
      const t = await driver.readText(`convert-leg-${i}-state`).catch(() => '?');
      console.log(`[ux]   leg ${i} at mid-capture: ${t}`);
    }
  }
  await driver.findByTestID('convert-done', {timeoutMs: 60_000});
  await sleep(400); // let the leg list settle
  if (wantShots?.done) await driver.screenshot(`${tag}-done`);
}

/** Reload (resume persisted wallet) and re-open the convert screen for ICP. */
async function reloadAndOpenConvert(driver, webBaseURL, relayBaseURL) {
  await driver.navigate(webBaseURL, `/wallet?relay=${encodeURIComponent(relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 10_000});
  await driver.findByTestID('tab-home', {timeoutMs: 10_000});
  await openConvertIcp(driver);
}

/** Full wallet journey for one phase: onboard, fund, pick route, census, (optional preflight block). */
async function phaseJourney({driver, r2, tag, locale, dark, fundEth, wantShots, localeOverride}) {
  const log = s => console.log(`[ux ${tag}] ${s}`);
  // Onboard on THIS phase's private-relay page (onboarding placeholders are localized, so the
  // wallet is created under en-US and the locale is emulated + reloaded AFTER it exists).
  await onboardWallet(driver, `e2e-ux-${tag}`);
  const account = await accountOf(driver);
  if (localeOverride) {
    await driver.cdp.send('Emulation.setLocaleOverride', {locale: localeOverride}); // reuses the create-time session
    await driver.navigate(driver._webBaseURL, `/wallet?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    await driver.findByTestID('tab-home', {timeoutMs: 10_000});
    log(`locale switched to ${localeOverride} and reloaded`);
  }
  const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
  assert(fundIcp.ok, `faucet ICP ok (${fundIcp.status})`);
  if (fundEth) {
    const fundE0 = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundE0.ok, `faucet ckETH up front ok (${fundE0.status})`);
  }

  log('destination picker (direct default + route row, nothing preselected)');
  await openConvertIcp(driver);
  await driver.type('convert-amount', AMOUNT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  assert(await driver.findByTestID(ROUTE_ROW, {timeoutMs: 3_000}) != null, 'route row offered');
  if (wantShots?.picker) await driver.screenshot(`${tag}-dest-picker`);

  if (!fundEth) {
    log('route picked, valid address, NO ckETH → gas preflight block');
    await pickRouteAndWaitCensus(driver, DEST);
    assert(await driver.findByTestID('convert-gas-preflight', {timeoutMs: 8_000}) != null, 'preflight renders on known shortfall');
    assert(await confirmDisabled(driver), 'confirm disabled under the preflight block');
    if (wantShots?.preflight) await driver.screenshot(`${tag}-gas-preflight`);
    log('preflight copy: ' + (await driver.readText('convert-gas-preflight')).replace(/\s+/g, ' '));
    const of = await overflowReport(driver);
    log(`overflow check after preflight: ${JSON.stringify(of)}`);
    assert(of.scrollW <= of.clientW + 1, 'no horizontal overflow (preflight state)');
    // fund gas now, reload (the deterministic balance refresh), and come back
    const fundE = await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
    assert(fundE.ok, `faucet ckETH ok (${fundE.status})`);
    await reloadAndOpenConvert(driver, driver._webBaseURL, r2.baseURL);
    await driver.type('convert-amount', AMOUNT);
  }

  log('route picked + valid address + funded gas → the census');
  await pickRouteAndWaitCensus(driver, DEST);
  assert(await driver.findByTestID('convert-gas-preflight', {timeoutMs: 2_000}).catch(() => null) == null,
    'no preflight when ckETH covers gas');
  if (wantShots?.detail) {
    await driver.eval(() => window.scrollTo(0, 0));
    await sleep(200);
    await driver.screenshot(`${tag}-route-detail`);
  }
  if (locale === 'en') {
    for (const id of ['convert-headline', 'convert-counterparty', 'convert-pool-fee', 'convert-in-fee',
                      'convert-out-fee', 'convert-dpay-fee', 'convert-route-min', 'convert-gas-note']) {
      log(`${id}: ${(await driver.readText(id)).replace(/\s+/g, ' ')}`);
    }
    const of = await overflowReport(driver);
    log(`overflow check (census): ${JSON.stringify(of)}`);
    assert(of.scrollW <= of.clientW + 1, 'no horizontal overflow (census state)');
  }

  log('invalid address → live validation, confirm stays withheld');
  await driver.type('convert-dest-address', BAD_DEST);
  await driver.findByTestID('convert-dest-address-invalid', {timeoutMs: 4_000});
  assert(await confirmDisabled(driver), 'confirm disabled on invalid address');
  if (wantShots?.invalid) await driver.screenshot(`${tag}-dest-invalid`);
  await driver.type('convert-dest-address', DEST); // restore
  await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
  return account;
}

/** Capture the failed_leg dead-end via the seeded expired resume (engine-driven, on screen). */
async function captureDeadEnd({driver, r2, account, tag, wantShots}) {
  const log = s => console.log(`[ux ${tag}] ${s}`);
  const row = await poolPayoutRow(r2.baseURL, account.publicHex);
  log(`hop payout row on relay: from pool ${row.from} amount ${row.amount}`);
  await seedPendingWithdrawal(driver, account.publicHex, BigInt(row.amount), {
    id: 'seeded-deadend-1',
    failureDetail: 'canister rejected the call: insufficient allowance for the gas fee',
  });
  const hang = await hangTransactionProbes(driver);
  await reloadAndOpenConvert(driver, driver._webBaseURL, r2.baseURL);
  await driver.findByTestID('convert-pending', {timeoutMs: 15_000}); // parked pending_withdrawal
  log('pending_withdrawal panel on screen; releasing the probe');
  hang.release();
  await driver.findByTestID('convert-failed-leg', {timeoutMs: 20_000});
  await sleep(300);
  if (wantShots) await driver.screenshot(`${tag}-failed-leg`);
  for (let i = 0; i < 5; i++) {
    log(`leg ${i}: ${(await driver.readText(`convert-leg-${i}-state`)).replace(/\s+/g, ' ')}`);
  }
  const body = (await driver.readText('convert-state')).replace(/\s+/g, ' ');
  log('dead-end panel text: ' + body.slice(0, 600));
}

/** Capture the stuck panel (seeded, unacknowledged). */
async function captureStuck({driver, r2, account, tag}) {
  const log = s => console.log(`[ux ${tag}] ${s}`);
  const row = await poolPayoutRow(r2.baseURL, account.publicHex);
  await seedStuck(driver, account.publicHex, BigInt(row.amount), {id: 'seeded-stuck-1'});
  await reloadAndOpenConvert(driver, driver._webBaseURL, r2.baseURL);
  await driver.findByTestID('convert-stuck', {timeoutMs: 15_000});
  assert(await driver.findByTestID('btn-convert-stuck-ack', {timeoutMs: 3_000}) != null, 'ack button present');
  await sleep(300);
  await driver.screenshot(`${tag}-stuck`);
  log('stuck panel text: ' + (await driver.readText('convert-state')).replace(/\s+/g, ' ').slice(0, 400));
}

/** Scroll a testID into the viewport center, let FREEZE settle, then screenshot. */
async function shotScrolled(driver, testID, name) {
  await driver.eval(tid => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (el) el.scrollIntoView({block: 'center'});
    else throw new Error(`no element ${tid}`);
  }, testID);
  await new Promise(r => setTimeout(r, 300));
  await driver.screenshot(name);
}

/** Slow every /api/v2/canister/ call by `ms` — makes the 5 legs observable mid-flight.
 *  The request listener MUST be attached before interception is enabled: a request paused with
 *  no listener hangs forever, and a hung catalog/venue fetch unmounts the convert form. */
function slowCanisterCalls(driver, ms) {
  const page = driver.page;
  const onReq = req => {
    if (req.url().includes('/api/v2/canister/')) {
      setTimeout(() => req.continue().catch(() => {}), ms);
    } else {
      req.continue().catch(() => {});
    }
  };
  page.on('request', onReq);
  return page.setRequestInterception(true).then(() => ({
    async release() {
      page.off('request', onReq);
      await page.setRequestInterception(false).catch(() => {});
    },
  }));
}

/** Phase A2: same walk as A, but every shot SCROLLED to its subject and legs slowed mid-flight. */
async function phaseA2(r2) {
  const tag = 'ux-a2';
  const log = s => console.log(`[ux ${tag}] ${s}`);
  const env = await setup();
  const {driver} = env;
  driver._webBaseURL = env.webBaseURL;
  await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await onboardWallet(driver, 'e2e-ux-a2');
  const account = await accountOf(driver);
  const fund = await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
  assert(fund.ok, 'faucet ICP');

  // gas preflight — scrolled onto the panel
  await openConvertIcp(driver);
  await driver.type('convert-amount', AMOUNT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  await pickRouteAndWaitCensus(driver, DEST);
  await driver.findByTestID('convert-gas-preflight', {timeoutMs: 8_000});
  await shotScrolled(driver, 'convert-gas-preflight', `${tag}-gas-preflight`);
  log('preflight shot scrolled onto panel');

  // fund gas, reload, census shots (money rows + confirm area)
  await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});
  await reloadAndOpenConvert(driver, env.webBaseURL, r2.baseURL);
  await driver.type('convert-amount', AMOUNT);
  await pickRouteAndWaitCensus(driver, DEST);
  await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
  await shotScrolled(driver, 'convert-route-min', `${tag}-census-min-gas`);
  await shotScrolled(driver, 'btn-convert-confirm', `${tag}-confirm-area`);
  log('census + confirm-area shots');

  // confirm with slowed canister calls — catch legs mid-flight
  const slow = await slowCanisterCalls(driver, 2_500);
  try {
    for (let round = 0; round < 5; round++) {
      const btn = await driver.findByTestID('btn-convert-confirm', {timeoutMs: 10_000}).catch(async e => {
        const txt = (await driver.bodyText().catch(() => '?')).slice(-900);
        const unavail = await driver.isPresent('convert-unavailable').catch(() => false);
        const qerr = await driver.isPresent('convert-quote-err').catch(() => false);
        throw new Error(`confirm button vanished. unavailable=${unavail} quoteErr=${qerr} url=${driver.page.url()}\nbody tail: …${txt}`);
      });
      await btn.click();
      const qc = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_500}).catch(() => null);
      if (qc == null) break;
    }
    // wait until at least one leg is not-yet-confirmed while the run is live
    let midState = null;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 150));
      const approving = await driver.isPresent('convert-approving');
      const legs = [];
      for (let n = 0; n < 5; n++) legs.push(await driver.readText(`convert-leg-${n}-state`).catch(() => ''));
      const inFlight = legs.some(t => t.includes('Waiting') || t.includes('Sent'));
      if (approving && inFlight) { midState = legs; break; }
    }
    log(`mid-flight leg states: ${JSON.stringify(midState)}`);
    if (midState) await shotScrolled(driver, 'convert-route-legs', `${tag}-mid-execution`);
    else log('WARN: could not catch mid-flight legs');
    await slow.release();
    await driver.findByTestID('convert-done', {timeoutMs: 60_000});
    await shotScrolled(driver, 'convert-done', `${tag}-done`);
    log('done shot');
  } finally {
    await slow.release();
  }

  // dead-end: seeded expired pending_withdrawal, parked panel shot, then release to failed_leg
  const payoutRow = await poolPayoutRow(r2.baseURL, account.publicHex);
  const payoutAmount = BigInt(payoutRow.amount);
  await seedPendingWithdrawal(driver, account.publicHex, payoutAmount, {id: `${tag}-dead-1`});
  const hang = await hangTransactionProbes(driver);
  await reloadAndOpenConvert(driver, env.webBaseURL, r2.baseURL);
  await driver.findByTestID('convert-pending', {timeoutMs: 20_000});
  await shotScrolled(driver, 'convert-pending', `${tag}-pending-withdrawal`);
  log('pending_withdrawal panel shot');
  await hang.release();
  await driver.findByTestID('convert-failed-leg', {timeoutMs: 20_000});
  await shotScrolled(driver, 'convert-failed-leg', `${tag}-failed-leg`);
  log('failed-leg shot');

  // stuck
  await seedStuck(driver, account.publicHex, payoutAmount, {id: `${tag}-stuck-1`});
  await reloadAndOpenConvert(driver, env.webBaseURL, r2.baseURL);
  await driver.findByTestID('convert-stuck', {timeoutMs: 20_000});
  await shotScrolled(driver, 'convert-stuck', `${tag}-stuck`);
  log('stuck shot');
  await env.stop();
}

async function main() {
  const ONLY = (process.env.DPAY_UX_PHASES ?? 'a,b,c,d').split(',');
  const r2 = await startRelay();
  console.log(`[ux] private relay at ${r2.baseURL} (phases: ${ONLY.join(',')})`);
  try {
    // --- Phase A: light, en — the full state walk ---------------------------------------------
    if (ONLY.includes('a')) {
      const env = await setup();
      const {driver} = env;
      driver._webBaseURL = env.webBaseURL;
      try {
        await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
        await driver.waitReady({timeoutMs: 8_000});
        const account = await phaseJourney({driver, r2, tag: 'ux-a', locale: 'en', dark: false, fundEth: false,
          wantShots: {picker: true, preflight: true, invalid: true, detail: true}});
        await runHappyPath(driver, r2.baseURL, {tag: 'ux-a', wantShots: {mid: true, done: true}});
        await captureDeadEnd({driver, r2, account, tag: 'ux-a', wantShots: true});
        await captureStuck({driver, r2, account, tag: 'ux-a'});
      } finally {
        await env.stop();
      }
    }

    // --- Phase A2: light, en — scrolled shots + slowed legs ------------------------------------
    if (ONLY.includes('a2')) {
      await phaseA2(r2);
    }

    // --- Phase B: dark, de-DE — long-copy locale + dark theme ---------------------------------
    if (ONLY.includes('b')) {
      const env = await setup({dark: true}); // locale switched AFTER onboarding (localized placeholders)
      const {driver} = env;
      driver._webBaseURL = env.webBaseURL;
      try {
        await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
        await driver.waitReady({timeoutMs: 8_000});
        const account = await phaseJourney({driver, r2, tag: 'ux-b-de-dark', locale: 'de', dark: true, fundEth: false, localeOverride: 'de-DE',
          wantShots: {picker: true, preflight: true, invalid: true, detail: true}});
        await runHappyPath(driver, r2.baseURL, {tag: 'ux-b-de-dark', wantShots: {done: true}});
        await captureDeadEnd({driver, r2, account, tag: 'ux-b-de-dark', wantShots: true});
      } finally {
        await env.stop();
      }
    }

    // --- Phases C/D: light, es-ES / fr-FR — detail + dead-end ---------------------------------
    for (const [tag, locale] of [['ux-c-es', 'es-ES'], ['ux-d-fr', 'fr-FR']]) {
      if (!ONLY.includes(tag.slice(3, 4).toLowerCase())) continue;
      const env = await setup(); // locale switched AFTER onboarding (localized placeholders)
      const {driver} = env;
      driver._webBaseURL = env.webBaseURL;
      try {
        await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
        await driver.waitReady({timeoutMs: 8_000});
        const account = await phaseJourney({driver, r2, tag, locale: tag.endsWith('-es') ? 'es' : 'fr', dark: false, fundEth: true,
          localeOverride: tag.endsWith('-es') ? 'es-ES' : 'fr-FR',
          wantShots: {detail: true}});
        await runHappyPath(driver, r2.baseURL, {tag, wantShots: {}});
        await captureDeadEnd({driver, r2, account, tag, wantShots: true});
      } finally {
        await env.stop();
      }
    }
  } finally {
    await stopSession();
    await r2.stop();
  }
  console.log('[ux] ALL PHASES COMPLETE');
}

main().then(() => process.exit(0), err => {
  console.error('[ux] FAILED:', err);
  process.exit(1);
});
