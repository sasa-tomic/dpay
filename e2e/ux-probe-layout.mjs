// UX layout probe (NOT a numbered flow — a one-shot evidence collector for the multihop UX pass).
// DOM-level fallback while zai-vision is timing out: per-testID geometry that catches the classes
// of defect pixels would show — truncation (scrollWidth>clientWidth), cramping (row heights vs
// line-height), fold position (is the action reachable without scrolling?), and dark-mode
// contrast (computed color vs effective background).
//
//   node e2e/ux-probe-layout.mjs            # light en + dark de passes
import {setup, stopSession, onboardWallet, accountOf, faucetAccount, assert} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';

const SEED_ICP = 2_000_000_000; // 20 ICP
const SEED_ETH = 400_000_000_000_000; // 0.0004 ckETH (gas)
const AMOUNT = '5';
const DEST = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ROUTE_ROW = 'convert-dest-route-multihop:icpswap-ckusdc:2';

const PROBE_IDS = [
  'convert-screen', 'convert-amount', 'convert-balance', 'convert-dest', 'convert-dest-direct',
  ROUTE_ROW, 'convert-route-note', 'convert-dest-address', 'convert-dest-address-invalid',
  'convert-headline', 'convert-rate', 'convert-quote-source', 'convert-counterparty',
  'convert-pool-principal', 'convert-minter-principal', 'convert-venue-disclosure',
  'convert-pool-fee', 'convert-in-fee', 'convert-out-fee', 'convert-dpay-fee',
  'convert-route-min', 'convert-gas-note', 'convert-gas-preflight', 'btn-convert-confirm',
  'convert-approving', 'convert-route-legs', 'convert-pending', 'convert-done',
  'convert-failed-leg', 'convert-stuck', 'btn-convert-stuck-ack',
];

async function metrics(driver) {
  return await driver.eval(ids => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el == null) { out[id] = null; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // nearest effective background: walk up until a non-transparent background-color
      let bgEl = el, bg = 'rgba(0, 0, 0, 0)';
      while (bgEl && bgEl !== document.documentElement) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && !c.includes('0, 0, 0, 0') && c !== 'transparent') { bg = c; break; }
        bgEl = bgEl.parentElement;
      }
      out[id] = {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        trunc: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        aboveFoldTop: Math.round(r.top), belowFold: r.bottom > vh,
        color: cs.color, bg, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      };
    }
    out.__viewport = {w: vw, h: vh};
    out.__pageOverflowX = document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth;
    return out;
  }, PROBE_IDS);
}

async function openConvertIcp(driver, lib) {
  await lib.openBalances(driver);
  await lib.selectCurrency(driver, 'icp');
  await lib.openBalances(driver);
      await driver.click('btn-accounts-convert', {timeoutMs: 10_000});
      // NOTE: no wait for convert-screen — with a live record the PANEL mounts instead of the form.
}

async function main() {
  const lib = await import('./harness/lib.mjs');
  const r2 = await startRelay();
  console.log(`[probe] private relay ${r2.baseURL}`);
  try {
    for (const pass of [{tag: 'light-en', dark: false}, {tag: 'dark-en', dark: true}]) {
      const env = await setup(pass.dark ? {dark: true} : {});
      const {driver} = env;
      await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
      await driver.waitReady({timeoutMs: 10_000});
      await onboardWallet(driver, `e2e-probe-${pass.tag}`);
      const account = await accountOf(driver);
      await faucetAccount(r2.baseURL, account.publicHex, SEED_ICP, {currency: 8});
      await faucetAccount(r2.baseURL, account.publicHex, SEED_ETH, {currency: 6});

      // state 1: destination picker
      await openConvertIcp(driver, lib);
      await driver.type('convert-amount', AMOUNT);
      await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
      console.log(`\n===== ${pass.tag} / dest-picker =====`);
      console.log(JSON.stringify(await metrics(driver), null, 1));

      // state 2: route picked + address + funded census
      await driver.click(ROUTE_ROW, {timeoutMs: 15_000});
      await driver.findByTestID('convert-dest-address', {timeoutMs: 10_000});
      await driver.type('convert-dest-address', DEST);
      await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});
      console.log(`\n===== ${pass.tag} / census =====`);
      console.log(JSON.stringify(await metrics(driver), null, 1));

      // state 3: invalid address
      await driver.type('convert-dest-address', '0x123');
      await driver.findByTestID('convert-dest-address-invalid', {timeoutMs: 5_000});
      console.log(`\n===== ${pass.tag} / invalid-address =====`);
      const inv = await metrics(driver);
      console.log(JSON.stringify({invalid: inv['convert-dest-address-invalid'], confirm: inv['btn-convert-confirm']}, null, 1));
      await driver.type('convert-dest-address', DEST);
      await driver.findByTestID('convert-route-min', {timeoutMs: 15_000});

      // state 4..: execute, then read each panel (capture-script pattern: quote-changed retries)
      for (let round = 0; round < 5; round++) {
        const btn = await driver.findByTestID('btn-convert-confirm', {timeoutMs: 10_000}).catch(async e => {
          const txt = (await driver.bodyText().catch(() => '?')).slice(-600);
          const unavail = await driver.isPresent('convert-unavailable').catch(() => false);
          throw new Error(`confirm button vanished (unavailable=${unavail}). body tail: …${txt}`);
        });
        await btn.click();
        const qc = await driver.findByTestID('convert-quote-changed', {timeoutMs: 2_500}).catch(() => null);
        if (qc == null) break;
      }
      await driver.findByTestID('convert-done', {timeoutMs: 60_000});
      console.log(`\n===== ${pass.tag} / done-panel =====`);
      const done = await metrics(driver);
      console.log(JSON.stringify({done: done['convert-done'], legs: done['convert-route-legs']}, null, 1));

      // dead-end via seeded expired pending_withdrawal (engine-driven)
      const body = await (await fetch(`${r2.baseURL}/api/v1/transactions/${account.publicHex}?currency=2&limit=50`)).json();
      const rows = body.transactions ?? body.rows ?? [];
      const principal = await import('./harness/lib.mjs').then(m => m.railPrincipalText(account.publicHex)).catch(() => account.publicHex);
      const row = rows.find(r => String(r.from ?? '').toLowerCase().includes('mohjv') && String(r.to ?? '').toLowerCase() === principal.toLowerCase());
      assert(row != null, 'pool payout row found');
      await driver.eval((key, seedId, payout, now) => {
        const store = JSON.parse(window.localStorage.getItem(key) ?? '{}');
        const tpl = Object.values(store).find(r => r != null && Array.isArray(r.legPlan));
        const rec = JSON.parse(JSON.stringify(tpl));
        delete rec.outAmountNet; delete rec.outTx; delete rec.hopTx; delete rec.failureCode; delete rec.failureDetail;
        rec.id = seedId; rec.step = 'pending_withdrawal'; rec.createdAtMs = now + 1_000;
        rec.slippageBps = 0; rec.expectedGross = String(payout);
        rec.legs = rec.legs.map(l => ({...l, expiresAtMs: now - 60_000}));
        rec.legPlan = rec.legPlan.map((lp, i) => ({...lp, state: i === 0 ? 'confirmed' : 'pending'}));
        store[seedId] = rec;
        window.localStorage.setItem(key, JSON.stringify(store));
      }, `dpay.convert.v2.${account.publicHex}`, `${pass.tag}-dead-1`, String(BigInt(row.amount)), Date.now());
      // keep the engine's ledger probe parked so the record is still LIVE (pending_withdrawal)
      // when the screen mounts — released once convert-pending is on screen (capture-script trick).
      // Listener BEFORE enabling interception: a paused request with no listener hangs forever.
      const probeQueue = [];
      const probeHandler = req => {
        if (req.url().includes('/api/v1/transactions')) probeQueue.push(req);
        else req.continue().catch(() => {});
      };
      driver.page.on('request', probeHandler);
      await driver.page.setRequestInterception(true);
      await driver.navigate(env.webBaseURL, `/wallet?relay=${encodeURIComponent(r2.baseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
      await driver.waitReady({timeoutMs: 10_000});
      await openConvertIcp(driver, lib); // the panel only renders when ConvertMode mounts
      await driver.findByTestID('convert-pending', {timeoutMs: 25_000});
      for (const q of probeQueue.splice(0)) q.continue().catch(() => {});
      driver.page.off('request', probeHandler);
      driver.page.on('request', req => req.continue().catch(() => {}));
      await driver.findByTestID('convert-failed-leg', {timeoutMs: 25_000});
      console.log(`\n===== ${pass.tag} / failed-leg =====`);
      const dead = await metrics(driver);
      console.log(JSON.stringify({panel: dead['convert-failed-leg'], legs: dead['convert-route-legs']}, null, 1));
      await env.stop();
    }
  } finally {
    await stopSession();
    await r2.stop();
  }
  console.log('\n[probe] COMPLETE');
}

// standalone runner
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch(e => { console.error('[probe] FAILED:', e); process.exit(1); });
}
