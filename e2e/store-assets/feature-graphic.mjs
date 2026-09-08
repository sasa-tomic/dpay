#!/usr/bin/env node
// Generate the Play Store feature graphic (1024×500) — the wide banner shown at the top of the
// listing. Dark brand gradient + large headline + asset badges, rendered via headless chrome.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolveExecutablePath } from '../harness/browser.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, '..', 'shots');
const OUT = join(__dirname, '..', '..', '.dev', 'store-assets');
mkdirSync(OUT, { recursive: true });

const BRAND = '#D03F00'; // app/config/palette.ts LIGHT.brand — the FILL step of the tangerine ramp
const BG = '#06070a';
const INK = '#f1f4f7';
const SUB = '#a6afba';

// Crop the balances screenshot to just the asset-list area (top ~60% of the 780×1688 capture).
const BALANCES_RAW = readFileSync(join(SHOTS, '39-store-balances.png')).toString('base64');

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1024px; height:500px; overflow:hidden;
  background: linear-gradient(135deg, #0a0e14 0%, ${BG} 100%);
  font-family: -apple-system, 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif;
  display:flex; align-items:center; padding:0 64px;
}
.glow {
  position:absolute; left:-100px; top:-100px; width:500px; height:500px;
  background: radial-gradient(circle, ${BRAND}15 0%, transparent 65%);
  border-radius:50%;
}
.left { flex:1; z-index:2; }
.headline .l1 { font-size:56px; font-weight:700; color:${INK}; line-height:1.1; letter-spacing:-1px; }
.headline .l2 { font-size:56px; font-weight:800; color:${BRAND}; line-height:1.1; letter-spacing:-1px; }
.sub { margin-top:14px; font-size:22px; color:${SUB}; line-height:1.4; }
.wordmark { margin-top:24px; font-size:28px; font-weight:700; color:${INK}; letter-spacing:2px; }
.wordmark .dot { color:${BRAND}; }
.badges { margin-top:18px; display:flex; gap:10px; }
.badge {
  font-size:16px; font-weight:600; color:${SUB};
  padding:6px 14px; border:1px solid rgba(255,255,255,0.12); border-radius:20px;
}
.right { z-index:2; margin-left:40px; }
.phone {
  border-radius:16px; overflow:hidden;
  box-shadow: 0 30px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
}
.phone img { display:block; width:260px; height:auto; }
</style></head><body>
<div class="glow"></div>
<div class="left">
  <div class="headline">
    <div class="l1">Pay anyone,</div>
    <div class="l2">anywhere</div>
  </div>
  <div class="sub">Non-custodial crypto wallet.<br>Bitcoin, USDC &amp; more — even offline.</div>
  <div class="wordmark">dpay<span class="dot">·</span></div>
  <div class="badges">
    <span class="badge">BTC</span>
    <span class="badge">USDC</span>
    <span class="badge">NFC</span>
    <span class="badge">Offline</span>
  </div>
</div>
<div class="right">
  <div class="phone">
    <img src="data:image/png;base64,${BALANCES_RAW}" />
  </div>
</div>
</body></html>`;

async function main() {
  const exe = resolveExecutablePath();
  const browser = await puppeteer.launch({
    executablePath: exe, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars',
           '--force-color-profile=srgb', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 500, deviceScaleFactor: 1 });
    await page.setContent(HTML, { waitUntil: 'load' });
    await page.waitForSelector('img', { timeout: 5000 });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({
      path: join(OUT, 'feature-graphic.png'), type: 'png',
      clip: { x: 0, y: 0, width: 1024, height: 500 },
    });
    console.log('✓ feature-graphic.png (1024×500)');
  } finally {
    await browser.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
