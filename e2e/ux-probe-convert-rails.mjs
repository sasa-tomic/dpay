// ux-probe-convert-rails.mjs — DOM geometry probe for the crossrail + cefi Convert surfaces.
// The zai-vision MCP is flaky (-32001); this is the pixel-independent fallback that still
// answers the layout questions that matter: truncation (scrollWidth overflow) on every long
// string (deposit address, settle address, calldata, hashes), fold placement (is the next
// action on-screen?), and font-size sanity per line. Pairs with ux-probe-layout.mjs (multihop).
//
// Run: node e2e/ux-probe-convert-rails.mjs   (prints a JSON table per state to stdout)
import {setup, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';
import {deriveSolanaKeypair} from './harness/jupiter.mjs';
import {installSideShiftStub, setSideShiftStatus} from './harness/sideshift.mjs';

const SEED_ICP = 2000000000; // 20 ICP
const SEED_ETH = 400000000000000; // 0.0004 ckETH
const ROUTE_C_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2:cctp:jupiter';
const CEFI_ROW = 'convert-dest-cefi-sideshift';
const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const AMOUNT = '5';

/** Measure every [data-testid] box: geometry, truncation, fold placement, font size. */
const PROBE_FN = () => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const out = [];
  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = el.getAttribute('data-testid');
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
    text = text.trim();
    const cs = getComputedStyle(el);
    out.push({
      id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      trunc: el.scrollWidth > el.clientWidth + 1,
      aboveFold: r.top >= 0 && r.bottom <= vh,
      belowFold: r.top > vh,
      fs: cs.fontSize, fw: cs.fontWeight,
      text: text.length > 64 ? `${text.slice(0, 61)}…` : text,
    });
  }
  return {vw, vh, overflowX: document.documentElement.scrollWidth > vw + 1, boxes: out};
};

async function report(driver, label) {
  const m = await driver.eval(PROBE_FN);
  const trunc = m.boxes.filter((b) => b.trunc);
  const below = m.boxes.filter((b) => b.belowFold).length;
  console.log(`\n=== ${label} (vw ${m.vw} vh ${m.vh} overflowX=${m.overflowX} boxes=${m.boxes.length} belowFold=${below}) ===`);
  if (trunc.length) for (const t of trunc) console.log(`  TRUNC ${t.id} w=${t.w} text="${t.text}"`);
  else console.log('  no truncation');
  for (const b of m.boxes) console.log(`  ${b.aboveFold ? 'fold' : b.belowFold ? 'under' : 'part '} ${b.id} (${b.x},${b.y} ${b.w}x${b.h} fs${b.fs}/${b.fw}) "${b.text}"`);
}

async function openConvertIcp(driver) {
  await openBalances(driver);
  await selectCurrency(driver, 'icp');
  await openBalances(driver);
  for (let i = 0; i < 3; i++) {
    try { await driver.click('btn-accounts-convert', {timeoutMs: 8_000}); return; }
    catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

const env = await setup({solStub: true});
const r2 = await startRelay();
try {
  const {driver, webBaseURL} = env;
  await driver.navigate(webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  await onboardWallet(driver, 'e2e-ux-probe-rails');
  const account = await accountOf(driver);
  for (const [amount, currency] of [[SEED_ICP, 8], [SEED_ETH, 6]]) {
    const ok = await faucetAccount(r2.baseURL, account.publicHex, amount, {currency});
    if (!ok.ok) throw new Error('faucet failed');
  }
  const passOrigins = [new URL(r2.baseURL).origin, new URL(env.webBaseURL).origin, new URL(env.relayBaseURL).origin];
  await installSideShiftStub(driver, {passOrigins, initialStatus: 'waiting'});

  // 1) picker, route C census
  await openConvertIcp(driver);
  await driver.type('convert-amount', AMOUNT);
  await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
  await report(driver, 'picker (all dest rows)');
  await driver.click(ROUTE_C_ROW, {timeoutMs: 5_000});
  await driver.type('convert-dest-address', DEST);
  await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
  await report(driver, 'census route C');

  // 2) cefi checklist (S1/S4 evidence: refusal line + pool-principal text in cefi mode)
  await driver.click('convert-dest-direct', {timeoutMs: 5_000});
  await driver.click(CEFI_ROW, {timeoutMs: 5_000});
  await driver.findByTestID('convert-settle-address', {timeoutMs: 8_000});
  await report(driver, 'cefi checklist');
  await setSideShiftStatus(driver, 'waiting');

  // 3) cefi deposit handoff
  await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
  await driver.findByTestID('convert-deposit-address', {timeoutMs: 30_000});
  await report(driver, 'cefi deposit handoff');
} finally {
  await env.stop();
  await r2.stop();
}
console.log('\n[probe] complete');
