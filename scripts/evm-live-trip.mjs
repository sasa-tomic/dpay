#!/usr/bin/env node
// evm-live-trip.mjs — the D31 MAINNET ZCHF round trip, driven through the REAL app surfaces
// (the e2e/live-drive.mjs pattern: the real app built from app/ via the harness vite pipeline,
// a real browser, the float seed restored through the REAL restore form, every value path the
// production one). NOT part of any offline suite. Every op it performs MUST be ledgered via
// `just funds add` (float rules in CLAUDE.md).
//
//   node scripts/evm-live-trip.mjs <cmd> [args]
//     boot                      restore the float, verify principal, dump the EVM account rows
//     probe-eth <icp>           open Convert ICP→ETH, pick sideshift-eth, type <icp>, dump the
//                               quote + settle address (free — confirms, never confirms)
//     fund-icp <eurc>           EURC(SOL)→ICP via sideshift-eurc: order → in-app SPL deposit →
//                               watch to done (the flagship attempt-#9 path)
//     fund-eth <icp>            ICP→native ETH via sideshift-eth: order → in-app ICP deposit →
//                               watch to done (the flow-223 path, live)
//     watch <src>               re-open Convert for <src> and follow the parked record
//     show-zchf                 select the ZCHF·Eth row, dump balances + history, screenshots
//     send-zchf <amt> <to>      the EVM withdraw sheet: send <amt> ZCHF·Eth to <to>
//     claim <reqUri>            OFFLINE permit sign: pin the connectivity oracle down, scan
//                               B's evmreq QR, sign, hand off — prints the evmpay claim URI
//     check-claim               back online: press the pending claim's Check now → Settled
//
// Env: DPAY_LIVE_RELAY (default http://127.0.0.1:8898 — the xff proxy fronting the local
// relay, so CeFi calls carry a public x-user-ip), DPAY_LIVE_WEB (pin the sirv port).
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {mkdirSync} from 'node:fs';

const E2E = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e');
const ROOT = join(E2E, '..');
const SHOTS = join(ROOT, 'e2e', 'shots');
mkdirSync(SHOTS, {recursive: true});

const RELAY = process.env.DPAY_LIVE_RELAY ?? 'http://127.0.0.1:8898';
const FLOAT_PRINCIPAL = 'vloyo-oihno-j4uba-nhhke-zyh34-s2r4g-kwgx3-qkzzk-4svfu-focgr-5ae';
const FLOAT_ACCOUNT_ID = '9fac39d1ffbd746a5a6e18ad812d053ef2fbebeacd28a4e236d3cca052692279';
const RAIL = '0x18884BC8e867eEf401703b702097220bdAe27668';       // the device EVM identity (index 0)
const RAIL_B = '0xAa228406823f3816E04709DB4640009E6A0a2B56';     // the counterparty (index 1)
const RPC_ETH = 'https://ethereum-rpc.publicnode.com';

const {buildWeb, serveWeb} = await import(join(E2E, 'harness', 'web.mjs'));
const {Driver} = await import(join(E2E, 'harness', 'driver.mjs'));
const {
  openBalances, selectCurrency, openConvertFor, pickSwapTarget, pickSwapVenue,
  typeConvertAmount, openOtherVenues, accountOf, armPayScan, waitForEnabled, railPrincipalText,
} = await import(join(E2E, 'harness', 'lib.mjs'));

const log = (...a) => console.log(`[trip ${new Date().toISOString().slice(11, 19)}]`, ...a);
const runCapture = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});

/** The float seed hex, decrypted at the moment of use. NEVER printed/logged/written. */
function floatSeed() {
  const hex = runCapture('node', ['scripts/agent-key.mjs', 'seed']).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('floatSeed: refusing (bad seed shape)');
  return hex;
}

async function pubHexOf(seedHex) {
  // resolve @noble/ed25519 through the e2e package (the harness's own dep tree — scripts/ has
  // no node_modules of its own)
  const {createRequire} = await import('node:module');
  const reqE2E = createRequire(join(E2E, 'package.json'));
  const ed = reqE2E('@noble/ed25519');
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  const pub = await ed.getPublicKeyAsync(seed);
  let out = '';
  for (const b of pub) out += b.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// boot: build + serve the app, launch a browser, restore the float via Onboarding.
// ---------------------------------------------------------------------------

async function startApp() {
  await buildWeb({});
  const web = await serveWeb(process.env.DPAY_LIVE_WEB ? {port: Number(process.env.DPAY_LIVE_WEB)} : {});
  const {browser, stop: stopBrowser} = await Driver.launchBrowser();
  // solRpcUrl + evmRpcUrl 'derive': delete the e2e overrides so the app derives BOTH rails'
  // candidates from the relay base it was booted with — the exact production paths.
  const driver = await Driver.create(browser, {solRpcUrl: 'derive', evmRpcUrl: 'derive'});
  return {driver, web, stopBrowser};
}

async function bootAndRestore(driver, base) {
  // The e2e shims point /api/v2 at ?relay= — this is LIVE: the app's own operator override
  // (seeded pre-load) pins the value path to the real boundary nodes.
  await driver.addInitScript(() => {
    try { localStorage.setItem('dpay.icpGateway.v1', 'https://icp-api.io'); } catch { /* fresh ctx */ }
  });
  log(`navigating ${base}/?relay=${RELAY}`);
  await driver.navigate(base, `/?relay=${encodeURIComponent(RELAY)}`);
  await driver.waitReady();
  try {
    await driver.findByTestID('walkthrough', {timeoutMs: 8_000});
    await driver.click('btn-walkthrough-skip');
    log('walkthrough skipped');
  } catch { /* already awarded */ }
  await driver.click('btn-restore');
  await driver.click('btn-restore-mode-toggle'); // hex input mode
  const seed = floatSeed();
  try {
    await driver.type('restore-seed-input', seed);
    await driver.click('btn-restore-confirm');
  } finally {
    seed.replace(/./g, '0');
  }
  try {
    await driver.findByTestID('btn-home-currency-continue', {timeoutMs: 8_000});
    await driver.click('home-currency-CHF');
    await driver.click('btn-home-currency-continue');
    log('home currency: CHF');
  } catch { /* chooser already answered */ }
  await driver.findByTestID('btn-home-accounts', {timeoutMs: 20_000});
  const acct = await accountOf(driver);
  if (!acct?.secretHex) throw new Error('restore: no identity in storage after restore');
  const pubHex = await pubHexOf(acct.secretHex);
  const principal = await railPrincipalText(pubHex);
  if (principal !== FLOAT_PRINCIPAL) {
    throw new Error(`restore: WRONG WALLET restored (${principal}) — refusing to touch anything`);
  }
  log(`principal verified: ${principal}`);
  return {pubHex, principal};
}

async function withApp(fn) {
  const {driver, web, stopBrowser} = await startApp();
  try {
    const boot = await bootAndRestore(driver, web.baseURL);
    return await fn(driver, boot);
  } catch (e) {
    try { await driver.dumpDiagnostics('evm-trip', e); } catch {}
    throw e;
  } finally {
    await web.stop().catch(() => {});
    await stopBrowser().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Convert helpers (the current intent-sheet surface).
// ---------------------------------------------------------------------------

async function readQuote(driver, {timeoutMs = 25_000} = {}) {
  await driver.findByTestID('convert-headline', {timeoutMs});
  await sleep(1_500);
  const headline = await driver.readText('convert-headline');
  let quoteSource = '';
  for (let i = 0; i < 30; i++) {
    if (await driver.isPresent('convert-quote-source')) { quoteSource = await driver.readText('convert-quote-source'); break; }
    await sleep(1_000);
  }
  return {headline, quoteSource};
}

async function verifySettleAddress(driver, expected, label) {
  await driver.findByTestID('convert-settle-address', {timeoutMs: 30_000});
  const settle = (await driver.readText('convert-settle-address')).trim();
  if (!settle.includes(expected)) {
    await driver.screenshot('trip-settle-mismatch');
    throw new Error(`${label}: settle address on screen ${JSON.stringify(settle)} != expected ${expected} — refusing`);
  }
  log(`${label}: settle address verified ${settle === expected ? '(exact)' : `(contains ${expected.slice(0, 10)}…)`}`);
  return settle;
}

/** Read the CeFi deposit facts off the awaiting panel (verbatim strings). */
async function readDepositFacts(driver, {timeoutMs = 90_000} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await driver.isPresent('convert-deposit-address')) {
      const depositAddress = (await driver.readText('convert-deposit-address')).trim();
      const handoff = await driver.isPresent('convert-deposit-handoff')
        ? (await driver.readText('convert-deposit-handoff')).trim()
        : (await driver.readText('convert-awaiting-deposit')).trim();
      return {depositAddress, handoff};
    }
    if (Date.now() > deadline) throw new Error('readDepositFacts: awaiting-deposit panel never appeared');
    await sleep(2_000);
  }
}

async function watchConvert(driver, label, {timeoutMs, shotEveryMs = 90_000} = {}) {
  const t0 = Date.now();
  let last = '';
  let lastShot = 0;
  for (;;) {
    for (const endId of ['convert-failed', 'convert-stuck']) {
      if (await driver.isPresent(endId)) {
        const text = await driver.readText(endId);
        await driver.screenshot(`trip-${label}-${endId}`);
        return {ended: endId, text};
      }
    }
    if (await driver.isPresent('convert-done')) {
      const text = await driver.readText('convert-done');
      await driver.screenshot(`trip-${label}-done`);
      return {ended: 'convert-done', text};
    }
    let step = '(form)';
    for (const [id, name] of [['convert-step', 'step'], ['convert-provider-processing', 'processing'], ['convert-awaiting-deposit', 'awaiting-deposit'], ['convert-pending', 'pending']]) {
      if (await driver.isPresent(id)) { step = `${name}: ${(await driver.readText(id)).replace(/\s+/g, ' ').slice(0, 120)}`; break; }
    }
    if (step !== last) { log(`watch ${label}: ${step}`); last = step; }
    if (Date.now() - lastShot > shotEveryMs) {
      await driver.screenshot(`trip-${label}-t${Math.round((Date.now() - t0) / 1000)}s`);
      lastShot = Date.now();
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`watchConvert(${label}): timeout after ${Math.round(timeoutMs / 1000)}s — last: ${last}`);
    }
    await sleep(5_000);
  }
}

/** The IC send sheet: destination + exact amount + ONE confirm press (cmdB pattern). */
async function sendViaIcSheet(driver, assetKey, address, amount) {
  await openBalances(driver);
  await selectCurrency(driver, assetKey);
  await driver.click('tab-pay');
  await driver.click('btn-pay-send');
  await driver.type('send-address-input', address);
  await driver.type('send-amount-input', amount);
  await sleep(1_200);
  const reviewTo = await driver.isPresent('send-review-to') ? await driver.readText('send-review-to') : '(no review)';
  log(`send review → ${reviewTo}`);
  await driver.screenshot('trip-send-review');
  await driver.click('btn-send-confirm');
  await driver.findByTestID('send-outcome', {timeoutMs: 120_000});
  const outcome = await driver.readText('send-outcome');
  const blockLine = await driver.isPresent('send-block') ? await driver.readText('send-block') : '(no block line)';
  log(`DEPOSIT SENT: ${outcome} — ${blockLine}`);
  await driver.screenshot('trip-send-sent');
  await driver.click('btn-send-done');
  return {outcome, blockLine};
}

/** RN-web controlled-input SET + read-back (the resume-race-proof setter, live-drive verbatim). */
async function setInputValue(driver, testID, text) {
  return driver.page.evaluate((tid, val) => {
    const node = document.querySelector(`[data-testid="${tid}"]`);
    if (!node) return '(no node)';
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(node, val);
    else node.value = val;
    node.dispatchEvent(new Event('input', {bubbles: true}));
    return node.value;
  }, testID, text);
}

/** The SOL send sheet: race-proof inputs + echo + enabled wait + ONE press (cmdC6 pattern). */
async function sendViaSolSheet(driver, assetKey, address, amount) {
  await openBalances(driver);
  await selectCurrency(driver, assetKey);
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
  for (let attempt = 1; attempt <= 3; attempt++) {
    await setInputValue(driver, 'sol-send-address-input', address);
    await setInputValue(driver, 'sol-send-amount-input', amount);
    await sleep(1_200);
    const vals = await driver.page.evaluate(() => ({
      addr: document.querySelector('[data-testid="sol-send-address-input"]')?.value ?? '',
      amt: document.querySelector('[data-testid="sol-send-amount-input"]')?.value ?? '',
    }));
    log(`form values (attempt ${attempt}): ${JSON.stringify(vals)}`);
    if (vals.addr === address && vals.amt === amount) break;
    if (attempt === 3) throw new Error(`sol send: form never accepted the values: ${JSON.stringify(vals)}`);
  }
  let echoed = false;
  for (let i = 0; i < 20; i++) {
    if ((await driver.bodyText()).includes(address.slice(0, 10))) { echoed = true; break; }
    await sleep(500);
  }
  log(`send review echo: ${echoed ? 'ok' : 'MISSING'}`);
  if (!echoed) {
    await driver.screenshot('trip-sol-send-review');
    throw new Error('sol send: review card never echoed the destination — refusing');
  }
  await driver.screenshot('trip-sol-send-review');
  let enabled = false;
  for (let i = 0; i < 40; i++) {
    const st = await driver.page.evaluate(() => {
      const btn = document.querySelector('[data-testid="btn-sol-send-confirm"]');
      return {found: btn != null, disabled: btn?.getAttribute('disabled'), aria: btn?.getAttribute('aria-disabled')};
    });
    if (st.found && st.disabled !== 'true' && st.aria !== 'true') { enabled = true; break; }
    await sleep(1_000);
  }
  log(`confirm enabled: ${enabled}`);
  if (!enabled) throw new Error('sol send: confirm never enabled in 40s — refusing to press');
  try {
    await driver.click('btn-sol-send-confirm');
  } catch (e) {
    const clicked = await (await driver.page.$('body')).evaluate(() => {
      const btn = document.querySelector('[data-testid="btn-sol-send-confirm"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    log(`DOM fallback click: ${clicked}`);
    if (!clicked) throw e;
  }
  // ANY terminal phase: settled / unknown / failed (the outcome id is the settled phase only).
  const terminalIds = ['sol-send-outcome', 'sol-send-unknown-title', 'sol-send-failed-title', 'sol-send-unknown-note'];
  const t0 = Date.now();
  let terminal = null;
  for (;;) {
    for (const id of terminalIds) {
      if (await driver.isPresent(id)) { terminal = id; break; }
    }
    if (terminal != null) break;
    if (Date.now() - t0 > 120_000) {
      const tracer = driver.consoleLog.filter((e) => /money: sol send|error/i.test(e.text)).map((e) => e.text.slice(0, 200));
      const body = await driver.bodyText();
      await driver.screenshot('trip-sol-send-stall');
      throw new Error(`sol send: no terminal phase in 120s. tracer: ${tracer.slice(-12).join(' || ') || '(none captured)'} | surface: ${body.replace(/\s+/g, ' ').slice(0, 500)}`);
    }
    await sleep(2_000);
  }
  const outcome = terminal === 'sol-send-outcome' ? await driver.readText('sol-send-outcome')
    : `${terminal}: ${(await driver.readText(terminal)).replace(/\s+/g, ' ').slice(0, 200)}`;
  let sig = '';
  try { sig = await driver.readText('sol-send-signature', {timeoutMs: 5_000}); } catch {}
  const tracer = driver.consoleLog.filter((e) => /money: sol send/.test(e.text)).map((e) => e.text.slice(0, 160));
  log(`DEPOSIT SENT: ${outcome} | sig ${sig}`);
  log(`tracer: ${tracer.join(' || ')}`);
  await driver.screenshot('trip-sol-send-sent');
  return {outcome, sig};
}

const parseAmount = (handoff, assetRe) => {
  const m = handoff.match(assetRe);
  if (!m) throw new Error(`cannot parse deposit amount from ${JSON.stringify(handoff.slice(0, 200))}`);
  return m[1];
};

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function cmdBoot() {
  await withApp(async (driver) => {
    console.log(runCapture('node', ['scripts/agent-evm.mjs', 'balance', RAIL, '--census', 'rail']));
    await openBalances(driver);
    await driver.screenshot('trip-boot-accounts');
    const rows = await driver.eval(() =>
      Array.from(document.querySelectorAll('[data-testid^="asset-"]'))
        .map((el) => el.getAttribute('data-testid')).filter((t) => t.startsWith('asset-evm')),
    );
    log(`EVM rows on the accounts list: ${JSON.stringify(rows)}`);
  });
}

async function cmdProbeEth(icpAmount) {
  await withApp(async (driver) => {
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'ETH');
    await openOtherVenues(driver);
    await driver.findByTestID('convert-venue-sideshift-eth', {timeoutMs: 15_000});
    await driver.click('convert-venue-sideshift-eth');
    await typeConvertAmount(driver, icpAmount);
    const q = await readQuote(driver);
    log('QUOTE:', JSON.stringify(q, null, 2));
    const rail = await driver.isPresent('convert-settle-rail') ? await driver.readText('convert-settle-rail') : '(no settle-rail line)';
    log(`settle rail: ${rail}`);
    await verifySettleAddress(driver, RAIL, 'probe-eth');
    await driver.screenshot('trip-probe-eth');
    log('probe complete — NOTHING was confirmed');
  });
}

async function cmdFundIcp(eurcAmount) {
  await withApp(async (driver) => {
    driver.page.on('pageerror', (e) => log(`[pageerror] ${String(e).slice(0, 300)}`));
    await openConvertFor(driver, 'sol-eurc');
    await pickSwapTarget(driver, 'ICP');
    await typeConvertAmount(driver, eurcAmount);
    const q = await readQuote(driver);
    log('QUOTE:', JSON.stringify(q, null, 2));
    if (!/SideShift/i.test(q.quoteSource)) throw new Error(`quote source is not SideShift: ${q.quoteSource}`);
    await verifySettleAddress(driver, FLOAT_ACCOUNT_ID, 'fund-icp');
    await driver.screenshot('trip-fundicp-quote');
    await driver.click('btn-convert-confirm');
    const facts = await readDepositFacts(driver);
    log('DEPOSIT FACTS:', JSON.stringify(facts, null, 2));
    await driver.screenshot('trip-fundicp-awaiting-deposit');
    const amount = parseAmount(facts.handoff, /([\d.]+)\s*EURC/);
    log(`depositing ${amount} EURC via the app's own SPL send…`);
    await sendViaSolSheet(driver, 'sol-eurc', facts.depositAddress, amount);
    // Back to Convert: the persisted record adopts and the watch follows it to done.
    await openConvertFor(driver, 'sol-eurc', {timeoutMs: 15_000});
    const res = await watchConvert(driver, 'fundicp', {timeoutMs: 25 * 60_000});
    log(`fund-icp result: ${res.ended}: ${res.text}`);
  });
}

async function cmdFundEth(icpAmount) {
  await withApp(async (driver) => {
    driver.page.on('pageerror', (e) => log(`[pageerror] ${String(e).slice(0, 300)}`));
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'ETH');
    await openOtherVenues(driver);
    await driver.findByTestID('convert-venue-sideshift-eth', {timeoutMs: 15_000});
    await driver.click('convert-venue-sideshift-eth');
    await typeConvertAmount(driver, icpAmount);
    const q = await readQuote(driver);
    log('QUOTE:', JSON.stringify(q, null, 2));
    if (!/SideShift/i.test(q.quoteSource)) throw new Error(`quote source is not SideShift: ${q.quoteSource}`);
    const railLine = await driver.isPresent('convert-settle-rail') ? await driver.readText('convert-settle-rail') : '';
    log(`settle rail line: ${railLine}`);
    await verifySettleAddress(driver, RAIL, 'fund-eth');
    await driver.screenshot('trip-fundeth-quote');
    await driver.click('btn-convert-confirm');
    const facts = await readDepositFacts(driver);
    log('DEPOSIT FACTS:', JSON.stringify(facts, null, 2));
    await driver.screenshot('trip-fundeth-awaiting-deposit');
    const amount = parseAmount(facts.handoff, /([\d.]+)\s*ICP/);
    log(`depositing ${amount} ICP via the app's own send sheet…`);
    await sendViaIcSheet(driver, 'icp', facts.depositAddress, amount);
    // Back to Convert — the resume engine adopts the parked record and polls to settlement.
    await openConvertFor(driver, 'icp', {timeoutMs: 15_000});
    const res = await watchConvert(driver, 'fundeth', {timeoutMs: 25 * 60_000});
    log(`fund-eth result: ${res.ended}: ${res.text}`);
  });
}

async function cmdWatch(src) {
  await withApp(async (driver) => {
    await openConvertFor(driver, src, {timeoutMs: 15_000});
    const res = await watchConvert(driver, `watch-${src}`, {timeoutMs: 25 * 60_000});
    log(`watch result: ${res.ended}: ${res.text}`);
  });
}

async function cmdShowZchf() {
  await withApp(async (driver) => {
    await openBalances(driver);
    await driver.screenshot('trip-zchf-accounts');
    const rows = await driver.eval(() =>
      Array.from(document.querySelectorAll('[data-testid^="asset-evm"]'))
        .map((el) => ({t: el.getAttribute('data-testid'), text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 90)})),
    );
    log(`EVM rows: ${JSON.stringify(rows, null, 1)}`);
    // select the ZCHF·Eth row + history
    const key = rows.find((r) => /zchf-eth/.test(r.t))?.t;
    if (key == null) throw new Error(`no ZCHF·Eth row found: ${JSON.stringify(rows)}`);
    await driver.click(`${key}-select`);
    await driver.click('tab-transactions');
    await sleep(6_000);
    await driver.screenshot('trip-zchf-history');
    const body = await driver.bodyText();
    log(`history surface: ${body.replace(/\s+/g, ' ').slice(0, 600)}`);
  });
}

async function cmdSendZchf(amount, to) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '')) throw new Error(`send-zchf: bad destination ${to}`);
  await withApp(async (driver) => {
    driver.page.on('pageerror', (e) => log(`[pageerror] ${String(e).slice(0, 300)}`));
    await openBalances(driver);
    await driver.findByTestID('asset-evm-zchf-ethereum', {timeoutMs: 15_000});
    await driver.click('asset-evm-zchf-ethereum-select');
    await driver.click('tab-pay');
    await driver.click('btn-pay-send');
    await driver.findByTestID('evm-send-amount-input', {timeoutMs: 10_000});
    await driver.type('evm-send-address-input', to);
    await driver.type('evm-send-amount-input', amount);
    await driver.findByTestID('evm-send-review', {timeoutMs: 10_000});
    for (let i = 0; i < 20; i++) {
      const fee = await driver.eval(() => document.querySelector('[data-testid="evm-send-review-fee"]')?.textContent?.trim() ?? '');
      if (/≈/.test(fee)) { log(`fee line: ${fee}`); break; }
      await sleep(1_000);
    }
    await driver.screenshot('trip-evmsend-review');
    await waitForEnabled(driver, 'btn-evm-send-confirm', {timeoutMs: 30_000});
    await driver.click('btn-evm-send-confirm');
    await driver.findByTestID('evm-send-hash', {timeoutMs: 90_000});
    const hash = await driver.eval(() => document.querySelector('[data-testid="evm-send-hash"]')?.textContent?.trim());
    const body = await driver.bodyText();
    log(`SEND OUTCOME: ${body.includes('Sent · seen on') ? 'seen on-chain' : 'terminal'} | hash ${hash}`);
    log(`surface: ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
    await driver.screenshot('trip-evmsend-sent');
    console.log(JSON.stringify({txHash: hash}));
  });
}

async function cmdClaim(reqUri) {
  const {decodeEvmReq} = await import(join(E2E, 'harness', 'evm', 'qr.mjs'));
  const req = decodeEvmReq(reqUri); // shape + window validated by the codec
  if (req.to.toLowerCase() !== RAIL_B.toLowerCase()) throw new Error(`claim: request beneficiary ${req.to} is not rail B`);
  if (req.chainId !== 1) throw new Error(`claim: request chain ${req.chainId} is not mainnet`);
  await withApp(async (driver) => {
    driver.page.on('pageerror', (e) => log(`[pageerror] ${String(e).slice(0, 300)}`));
    // ONLINE first: the balance poll seeds the permit-nonce cache (D22.1, every-5th-tick).
    await openBalances(driver);
    await driver.findByTestID('asset-evm-zchf-ethereum', {timeoutMs: 20_000});
    const nonceKey = `dpay.evm.nonces.v1.${RAIL.toLowerCase()}`;
    let seeded = null;
    for (let i = 0; i < 60; i++) {
      seeded = await driver.eval((k) => {
        try { const raw = localStorage.getItem(k); return raw == null ? null : JSON.parse(raw); } catch { return null; }
      }, nonceKey);
      if (seeded != null && typeof seeded['1:ZCHF'] === 'number') break;
      await sleep(2_500);
    }
    if (seeded == null || typeof seeded['1:ZCHF'] !== 'number') {
      throw new Error(`claim: the permit-nonce cache never seeded (${nonceKey}) — stay online longer first`);
    }
    log(`nonce cache seeded: ${JSON.stringify(seeded)}`);
    // THE OFFLINE SEAM: pin the app's connectivity oracle down, then scan (D22 — the cached
    // nonce, zero RPC in the signing path).
    await driver.eval(() => { globalThis.__DPAY_TEST_EVM_CONNECTIVITY = 'offline'; });
    await openBalances(driver);
    await driver.click('asset-evm-zchf-ethereum-select');
    await armPayScan(driver);
    await driver.eval((uri) => window.__DPAY_TEST_SCAN(uri), reqUri);
    await driver.findByTestID('evm-pay-qr', {timeoutMs: 20_000});
    const payUri = await driver.eval(() => window.__DPAY_QR_LAST);
    if (typeof payUri !== 'string' || !payUri.startsWith('evmpay:v1?')) {
      throw new Error(`claim: the signed QR is not an evmpay URI: ${String(payUri).slice(0, 60)}`);
    }
    log('OFFLINE SIGN ok — evmpay QR rendered with connectivity down');
    await driver.screenshot('trip-claim-qr');
    await driver.click('btn-evm-pay-handed');
    await driver.findByTestID('evm-pay-status', {timeoutMs: 10_000});
    const status = await driver.readText('evm-pay-status');
    log(`handed off: ${status}`);
    if (/Paid ✓/.test(status)) throw new Error('claim: the screen claimed "Paid ✓" pre-settle — honesty bug');
    await driver.screenshot('trip-claim-handed');
    console.log(JSON.stringify({claimUri: payUri}));
  });
}

async function cmdCheckClaim() {
  await withApp(async (driver) => {
    // Fresh boot = back online. The pending-claim badge lives on the ZCHF·Eth Pay scanner.
    await openBalances(driver);
    await driver.click('asset-evm-zchf-ethereum-select');
    await driver.click('tab-pay');
    await driver.findByTestID('evm-pay-scan', {timeoutMs: 15_000});
    await driver.findByTestID('evm-pay-pending', {timeoutMs: 15_000}).catch(async () => {
      // the badge can sit behind the standing scanner arm — press the gate then re-look
      await armPayScan(driver);
      await driver.findByTestID('evm-pay-pending', {timeoutMs: 15_000});
    });
    const checkDeadline = Date.now() + 120_000;
    let lastNote = '';
    for (;;) {
      if (await driver.isPresent('btn-evm-pay-check')) {
        await driver.click('btn-evm-pay-check', {timeoutMs: 3_000}).catch(() => {});
      }
      await sleep(3_000);
      lastNote = await driver.isPresent('evm-pay-check-note')
        ? (await driver.readText('evm-pay-check-note')).trim() : '';
      if (/Settled/.test(lastNote)) { log(`pending claim: "${lastNote}"`); break; }
      if (!(await driver.isPresent('evm-pay-pending'))) { log('pending claim resolved (badge cleared)'); break; }
      if (Date.now() > checkDeadline) throw new Error(`claim check never reported settled (last note: "${lastNote}")`);
    }
    await driver.screenshot('trip-claim-settled');
    const body = await driver.bodyText();
    log(`surface: ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
  });
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const commands = {
  boot: cmdBoot,
  'probe-eth': cmdProbeEth,
  'fund-icp': cmdFundIcp,
  'fund-eth': cmdFundEth,
  watch: cmdWatch,
  'show-zchf': cmdShowZchf,
  'send-zchf': cmdSendZchf,
  claim: cmdClaim,
  'check-claim': cmdCheckClaim,
};
if (!commands[cmd]) {
  console.error(`usage: node scripts/evm-live-trip.mjs <${Object.keys(commands).join('|')}> [args]`);
  process.exit(1);
}
commands[cmd](...rest).then(
  () => process.exit(0),
  (e) => { console.error(`[trip] ${cmd} FAIL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); },
);
