#!/usr/bin/env node
// Compose Play Store marketing screenshots from raw app captures.
//
// Renders each raw screenshot (780×1688) inside a 1080×1920 marketing frame using headless chrome:
// dark gradient bg matching the app palette, brand-green headline, phone screenshot with rounded
// corners + soft shadow. The bottom "Press Esc to close" web-only text is masked by the frame.
//
// Usage: node e2e/store-assets/compose.mjs
// Input:  e2e/shots/39-store-*.png
// Output: .dev/store-assets/screenshot-N.png  (1080×1920, Play Store ready)
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

// Brand palette (app/config/palette.ts)
const BRAND = '#3ee0ac';
const BG_DARK = '#06070a';
const INK = '#f1f4f7';
const SUB = '#a6afba';

// Each slide: raw screenshot file → headline (two lines) + accent color for line 2.
const SLIDES = [
  { file: '39-store-balances.png', h1: 'All your assets,', h2: 'one wallet', order: 1 },
  { file: '39-store-request.png', h1: 'Get paid in', h2: 'any currency', order: 2 },
  { file: '39-store-deposit.png', h1: 'Add Bitcoin', h2: 'in seconds', order: 3 },
  { file: '39-store-wallet.png', h1: 'Pay anyone,', h2: 'anywhere', order: 4 },
  { file: '39-store-ledger.png', h1: 'Every transaction,', h2: 'crystal clear', order: 5 },
];

function frameHTML(slide, imgData) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1920px; overflow:hidden;
  background: radial-gradient(ellipse at 50% 25%, #0d1117 0%, ${BG_DARK} 70%);
  font-family: -apple-system, 'Segoe UI', system-ui, 'Helvetica Neue', sans-serif;
  display:flex; flex-direction:column; align-items:center;
}
/* subtle brand glow */
.glow {
  position:absolute; top:120px; width:600px; height:600px;
  background: radial-gradient(circle, ${BRAND}11 0%, transparent 70%);
  border-radius:50%; pointer-events:none;
}
.headline {
  margin-top:100px; text-align:center; z-index:2;
}
.headline .l1 {
  font-size:58px; font-weight:700; color:${INK}; letter-spacing:-1px; line-height:1.12;
}
.headline .l2 {
  font-size:58px; font-weight:800; color:${BRAND}; letter-spacing:-1px; line-height:1.12;
}
.tagline {
  margin-top:18px; font-size:28px; color:${SUB}; font-weight:400; z-index:2;
}
/* phone frame */
.phone-wrap {
  margin-top:45px; z-index:2;
  border-radius:24px; overflow:hidden;
  box-shadow: 0 40px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06);
}
.phone-wrap img {
  display:block; width:700px; height:auto;
  /* clip bottom 40px (Press Esc to close web-only text) */
  margin-bottom:-40px;
}
.wordmark {
  position:absolute; bottom:55px; font-size:32px; font-weight:700;
  color:${INK}; letter-spacing:2px; z-index:2;
}
.wordmark .dot { color:${BRAND}; }
</style></head><body>
<div class="glow"></div>
<div class="headline">
  <div class="l1">${slide.h1}</div>
  <div class="l2">${slide.h2}</div>
</div>
<div class="phone-wrap">
  <img src="data:image/png;base64,${imgData}" />
</div>
<div class="wordmark">dpay<span class="dot">·</span></div>
</body></html>`;
}

async function main() {
  const exe = resolveExecutablePath();
  if (!exe) throw new Error('no chromium found — run `npm install` in e2e/');

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars',
           '--force-color-profile=srgb', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

    for (const slide of SLIDES) {
      const raw = readFileSync(join(SHOTS, slide.file));
      const imgData = raw.toString('base64');
      await page.setContent(frameHTML(slide, imgData), { waitUntil: 'load' });
      await page.waitForSelector('img', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 300));
      const outPath = join(OUT, `screenshot-${slide.order}.png`);
      await page.screenshot({ path: outPath, type: 'png', clip: { x:0, y:0, width:1080, height:1920 } });
      const kb = (raw.length / 1024).toFixed(0);
      console.log(`✓ screenshot-${slide.order}.png  (${slide.h1} ${slide.h2})  [src ${kb}KB]`);
    }
    console.log(`\n5 Play Store screenshots → ${OUT}/`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
