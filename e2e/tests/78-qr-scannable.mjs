// Flow 78 — qr-scannable: the branded QR pixels must stay MACHINE-decodable.
//
// Why this flow exists: the shared <QrCode> component (app/components/QrCode.tsx) renders every
// payment QR on every rail — crisp butt-cap modules, a built-in quiet zone, and a centered dpay
// '∂' brand mark that occludes ~2% of the code (within ecl M's budget, under L's 7%). The visual
// flow (40) proves the pixels LOOK right; nothing else proves a real scanner can still READ them.
// A regression here (bigger mark, wrong ecl, quiet-zone collapse, shim cap change) sails through
// every existing gate and bricks every "show QR" surface in production.
//
// The gate rasterizes the RENDERED element (element screenshot → PNG → vendored jsQR — the exact
// decoder the prod web wallet ships) and asserts the decode matches the encoded value:
//   - request-qr  (QR_SIZE 244, ecl M, brand mark, 132-byte wire request) vs window.__DPAY_QR_LAST
//   - sol-receive-qr (QR_SIZE_SMALL 200, ecl L, Solana Pay URI solana:<address>?reference=<base58>)
//     vs the on-screen address text; and the USDC variant (owner recipient + spl-token mint param)
import { strict as assert } from 'node:assert';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup, onboardWallet, openBalances } from '../harness/lib.mjs';

const jsqrMod = await import(new URL('../web/vendor/jsQR.js', import.meta.url).href);
const jsQR = jsqrMod.default;
assert.equal(typeof jsQR, 'function', 'vendored jsQR must load as a function under node ESM');

/** Screenshot one testID element and jsQR-decode it. Returns the decoded string or null. */
async function decodeQrElement(driver, testID, outPng) {
  const el = await driver.findByTestID(testID);
  const box = await el.boundingBox();
  assert.ok(box && box.width > 10 && box.height > 10, `${testID} has no rendered box (${JSON.stringify(box)})`);
  const shot = outPng ?? `/tmp/qr-${testID}.png`;
  await driver.page.screenshot({ path: shot, type: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  const png = PNG.sync.read(readFileSync(shot));
  const out = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return out ? out.data : null;
}

export const meta = {
  id: '78',
  name: 'qr-scannable',
  journey: 'tour',
  covers: ['qr-scannable', 'qr-brand-mark', 'quiet-zone', 'solana-pay'],
  verifies:
    'every rendered <QrCode> stays machine-decodable: request-qr (244/M + brand mark) decodes to the exact encoded value (__DPAY_QR_LAST byte-for-byte) and sol-receive-qr (200/L) decodes to the Solana Pay URI — solana:<address>?reference=<base58> for SOL, solana:<owner>?spl-token=<USDC mint>&reference=<base58> for USDC — rasterized pixels through the same vendored jsQR the prod web wallet ships',
  timeoutMs: 25_000,
};

export async function run() {
  const env = await setup({solStub: true});
  const { driver } = env;
  try {
    await onboardWallet(driver, 'e2e-qr');

    // Surface 1 — the payment-request QR (ecl M, QR_SIZE 244, brand mark occluding the center).
    await driver.click('tab-receive');
    await driver.type('amount-input', '12.34');
    await driver.click('btn-request');
    const encoded = await driver.eval(() => window.__DPAY_QR_LAST);
    assert.equal(typeof encoded, 'string', 'qrcode shim must stash the encoded value (__DPAY_QR_LAST)');
    const decodedReq = await decodeQrElement(driver, 'request-qr', '/tmp/qr-request.png');
    assert.ok(decodedReq, 'request-qr pixels must decode (jsQR returned null — brand mark / quiet zone / ecl regression?)');
    assert.equal(decodedReq, encoded, 'request-qr decode must match the encoded value byte-for-byte');
    writeFileSync('/tmp/qr-request.decoded.txt', decodedReq); // diagnostics artifact

    // Surface 2 — the SOL address QR (ecl L, QR_SIZE_SMALL 200, 44-char base58 payload).
    // First clear the pending request (btn-new) — a showing reqQr LOCKS selection (ReceiveMode
    // sets onLockChange(true) while reqQr/result exists), and handleSelect bails on the lock, so
    // the Balances row tap would silently no-op and the sheet would never close.
    await driver.page.click('[aria-label="New request"]');
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.click('tab-receive', { timeoutMs: 5_000 });
    await driver.findByTestID('receive-mode-toggle', { timeoutMs: 5_000 });
    await driver.click('btn-receive-address', { timeoutMs: 5_000 });
    const addr = (await driver.readText('sol-receive-address')).trim();
    assert.match(addr, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'sol-receive-address must render a base58 pubkey');
    const decodedAddr = await decodeQrElement(driver, 'sol-receive-qr', '/tmp/qr-sol.png');
    assert.ok(decodedAddr, 'sol-receive-qr pixels must decode');
    assert.match(decodedAddr.trim(), new RegExp(`^solana:${addr}\\?reference=[1-9A-HJ-NP-Za-km-z]{32,44}$`),
      'sol-receive-qr decode must be the Solana Pay URI solana:<address>?reference=<base58 pubkey>');

    // Surface 3 — the USDC address QR (ecl L, QR_SIZE_SMALL 200, owner recipient + spl-token mint).
    // The stub seeds an EXISTING USDC token account so the ATA gate opens ('balance' → address + QR)
    // with no create step. `addr` above IS this device's owner pubkey (same seed), so the URI's
    // recipient must equal it while the on-screen text stays the derived ATA.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getLatestBlockhash: () => ({context: {slot: 100}, value: {blockhash: '1'.repeat(32), lastValidBlockHeight: 999999}}),
        getBalance: () => ({value: 5000000000}),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
        getTokenAccountBalance: () => ({value: {amount: '0', decimals: 6}}),
      };
    });
    await openBalances(driver);
    await driver.click('asset-sol-usdc-select', {timeoutMs: 5_000});
    await driver.click('tab-receive', {timeoutMs: 5_000});
    await driver.findByTestID('receive-mode-toggle', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    await driver.findByTestID('sol-receive-address', {timeoutMs: 10_000});
    const decodedUsdc = await decodeQrElement(driver, 'sol-receive-qr', '/tmp/qr-sol-usdc.png');
    assert.ok(decodedUsdc, 'USDC sol-receive-qr pixels must decode');
    assert.match(decodedUsdc.trim(),
      new RegExp(`^solana:${addr}\\?spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=[1-9A-HJ-NP-Za-km-z]{32,44}$`),
      'USDC sol-receive-qr decode must be the Solana Pay URI solana:<owner>?spl-token=<USDC mint>&reference=<base58 pubkey>');
  } finally {
    await env.stop();
  }
}
