// UIX2 CHAIN CAPTURE — the any-pair convert widening's sheet states (validation artifact,
// 2026-09-28). NOT a numbered flow: drives the REAL app (offline test-helpers relay) through
// the CHAIN route's faces — the standing twin-CHF line on a SOL-rail source, the quoted
// chain review card (order venue + IC pool named leg by leg), the Other-venues expander's
// chain rows, and the phase-1 tracker (order created → deposit sent → payout watch) — in
// LIGHT and DARK. No assertions beyond sanity waits; a capture that fails loudly on a
// missing testID is the signal, not a red test.
// Run: node e2e/uix2-capture-chain.mjs   → e2e/shots/uix2/chain-*.png
import {setup, onboardWallet, openBalances, selectCurrency} from './harness/lib.mjs';
import {startRelay} from './harness/relay.mjs';
import {mkdirSync} from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A VALID base58 Solana address (32 bytes of zeros — the System program's own text). The
// venue's chain deposit address must decode to 32 bytes or the prepare refuses; the page
// SOL RPC stub answers every address with a USDC token account, so the builder reads it as
// a direct token account (plain SPL transfer into it).
const SOL_DEPOSIT = '11111111111111111111111111111111';

const DARK = process.env.DPAY_CHAIN_DARK === '1';
const tag = DARK ? 'dark' : 'light';
const env = await setup({solStub: true, dark: DARK});
const r2 = await startRelay();
try {
  const {driver, webBaseURL} = env;
  mkdirSync(new URL('./shots/uix2/', import.meta.url), {recursive: true});
  const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
  await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
  await driver.waitReady({timeoutMs: 8_000});
  console.log('[chain-capture] onboarding…');
  await onboardWallet(driver, 'uix2-chain');

  // The SOL rail's page stub: balances (5 SOL + a 2.5 USDC token account), instant
  // confirmation, recorded submits (the rails capture's stub, verbatim shape).
  await driver.eval(() => {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const b58 = (bytes) => {
      let n = 0n;
      for (const b of bytes) n = n * 256n + BigInt(b);
      let s = '';
      while (n > 0n) {
        s = B58[Number(n % 58n)] + s;
        n /= 58n;
        if (n === 0n) break;
      }
      return s;
    };
    globalThis.__E2E_SOL_SENT = [];
    // Self-contained getMultipleAccounts: EVERY queried address answers as a funded USDC
    // token account (the venue's direct SPL deposit account + the sender's ATA). The
    // positional harness helper would answer a single-address query as the wallet itself.
    const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const dec58 = (t) => {
      const bytes = [0];
      for (const ch of t) {
        const v = B58A.indexOf(ch);
        if (v < 0) throw new Error('stub: not base58: ' + t);
        let carry = v;
        for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
        while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
      }
      for (let i = 0; i < t.length && t[i] === '1'; i++) bytes.push(0);
      return new Uint8Array(bytes.reverse());
    };
    const USDC_MINT_B58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const TOKEN_OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const tokenAcct = (ownerBytes) => {
      const b = new Uint8Array(165);
      b.set(dec58(USDC_MINT_B58), 0);
      b.set(ownerBytes, 32);
      let v = 2500000n;
      for (let i = 0; i < 8; i++) { b[64 + i] = Number(v & 0xffn); v >>= 8n; }
      return {lamports: 2039280, owner: TOKEN_OWNER, data: [btoa(String.fromCharCode(...b)), 'base64'], executable: false, rentEpoch: 0, space: 165};
    };
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      // The wallet poll rides the harness helper (positional: wallet, ata, mint). A
      // SINGLE-address query is the chain deposit leg's own read — the venue's direct SPL
      // deposit account (and the sender ATA check): answer a funded USDC token account.
      getMultipleAccounts: (p, spec) => {
        const addrs = p[0];
        if (Array.isArray(addrs) && addrs.length === 1) {
          return Promise.resolve({context: {slot: 250000000}, value: [tokenAcct(dec58(addrs[0]))]});
        }
        return globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 2039280, token: {amount: '2500000', decimals: 6}});
      },
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      sendTransaction: (params) => {
        const raw = Array.isArray(params) ? params[0] : null;
        const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
        const sig = b58(bytes.slice(1, 65));
        globalThis.__E2E_SOL_SENT.push({signature: sig, raw});
        return sig;
      },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getSignaturesForAddress: () => [],
      getBlockHeight: () => 250000000,
      getTransaction: () => null,
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });

  // The CeFi seam: the relay's own sideshift proxy answers pair-agnostically, but its
  // fixture deposit address is IC-shaped (the composed flow's validator). The CHAIN
  // deposit leg needs a SOLANA-shaped venue address, so this page stub answers the relay
  // origin's sideshift paths directly (quotes + fixed order) with chain-shaped bodies —
  // and the keyless device-direct status read on sideshift.ai with a scripted lifecycle.
  await driver.eval((deposit) => {
    const st = {status: 'waiting', extra: {}, unexpected: []};
    globalThis.__E2E_CHAIN_SIDESHIFT = st;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) ?? String(input);
      let u;
      try { u = new URL(url); } catch { return realFetch(input, init); }
      if (!u.protocol.startsWith('http')) return realFetch(input, init);
      if (u.origin === 'https://sideshift.ai' && u.pathname.startsWith('/api/v2/shifts/')) {
        const id = u.pathname.split('/').filter(Boolean).pop();
        return new Response(JSON.stringify({id, status: st.status, ...st.extra}), {
          status: 200, headers: {'content-type': 'application/json'},
        });
      }
      if (u.pathname.startsWith('/api/v1/sideshift/')) {
        let req = {};
        try { req = JSON.parse(init?.body ?? '{}'); } catch { /* stub answers pair-blind */ }
        if (u.pathname.endsWith('/quotes')) {
          // The relay's WRAPPED quote shape: {venue_id, quote, fetched_at} (the app pins
          // venue_id to the calling venue row). One venue per deposit mint, the registry's own.
          const venueByMint = {
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'sideshift-usdc',
            'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr': 'sideshift-eurc',
            'So11111111111111111111111111111111111111112': 'sideshift',
          };
          return new Response(JSON.stringify({
            venue_id: venueByMint[req.depositLedger] ?? 'sideshift-usdc',
            quote: {id: 'chain-quote-1', settleAmount: '0.0495', rate: '0.0495'},
            fetched_at: Math.floor(Date.now() / 1000),
          }), {status: 201, headers: {'content-type': 'application/json'}});
        }
        if (u.pathname.endsWith('/shifts/fixed')) {
          return new Response(JSON.stringify({
            id: 'chain-shift-9c1d',
            depositCoin: req.depositCoin ?? 'USDC',
            settleCoin: req.settleCoin ?? 'ICP',
            depositAddress: deposit,
            settleAddress: req.settleAddress ?? '',
            depositAmount: req.depositAmount ?? '1',
            settleAmount: '0.0495',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }), {status: 201, headers: {'content-type': 'application/json'}});
        }
      }
      return realFetch(input, init);
    };
  }, SOL_DEPOSIT);

  // Open Convert on the SOL rail's USDC (the standing twin-CHF line is the chain's headline).
  await openBalances(driver);
  await selectCurrency(driver, 'sol-usdc');
  await openBalances(driver);
  await driver.click('btn-accounts-convert-USD', {timeoutMs: 10_000});
  await driver.findByTestID('convert-screen', {timeoutMs: 10_000});
  await sleep(400);
  await driver.screenshot(`uix2/chain-${tag}-standing-chf`);

  // Type 1 USDC — the chain rows quote (cefi leg through the stub, IC legs through the
  // fake-IC pools) and the review card names BOTH executors leg by leg.
  await driver.type('convert-amount', '1');
  for (let i = 0; i < 40; i++) {
    const via = await driver.eval(() => document.querySelector('[data-testid="convert-route-via"]')?.textContent ?? null);
    if (via != null && via.length > 0) break;
    await sleep(500);
  }
  const viaText = await driver.eval(() => document.querySelector('[data-testid="convert-route-via"]')?.textContent ?? 'MISSING');
  console.log('[chain-capture] route-via:', viaText);
  await sleep(600);
  await driver.screenshot(`uix2/chain-${tag}-review`);

  // The Other-venues expander: the chain rows verbatim in registry order.
  await driver.click('btn-convert-venues-other', {timeoutMs: 8_000}).catch(() => {});
  await sleep(500);
  await driver.screenshot(`uix2/chain-${tag}-expander`);
  await driver.click('btn-convert-venues-other', {timeoutMs: 4_000}).catch(() => {});

  // DARK — run the script again with DPAY_CHAIN_DARK=1 (the convert route dropped the
  // global header, so the theme toggle is unreachable from here).
  await driver.screenshot(`uix2/chain-${tag}-review-dark-toggle`);

  // THE ONE CONSENT — confirm rides the whole chain: order created, deposit signed+frozen,
  // submitted, then the venue payout watch (the tracker narrates all of it).
  await driver.click('btn-convert-confirm', {timeoutMs: 8_000});
  for (let i = 0; i < 40; i++) {
    const live = await driver.eval(() => document.querySelector('[data-testid="convert-chain-live"]') != null);
    if (live) break;
    await sleep(500);
  }
  await sleep(2_500); // the deposit flight (instant in the stub) → awaiting payout
  await driver.screenshot(`uix2/chain-${tag}-phase1-order`);
  const liveText = await driver.eval(() => document.querySelector('[data-testid="convert-chain-live"]')?.textContent ?? 'MISSING');
  const errText = await driver.eval(() => document.querySelector('[data-testid="convert-confirm-err"]')?.textContent ?? null);
  if (errText != null) console.log('[chain-capture] CONFIRM ERR:', errText);
  console.log('[chain-capture] phase-1 live block:', liveText);

  // The venue settles → phase 2 signs the IC legs from the frozen plan (fresh quote). The
  // settle's ICP payout itself needs an offline leg too: the faucet credits the wallet the
  // mid asset the venue just "paid", so the approve/swap legs can actually settle.
  const {faucetAccount, accountOf} = await import('./harness/lib.mjs');
  await driver.eval(() => {
    const st = globalThis.__E2E_CHAIN_SIDESHIFT;
    st.status = 'settled';
    st.extra = {settleAmount: '0.0495', settleHash: 'chain-settle-hash-1'};
  });
  const acct = await accountOf(driver);
  await faucetAccount(r2.baseURL, acct.publicHex, 60_000_000, {currency: 8}); // 0.6 ICP
  await sleep(9_000);
  await driver.screenshot(`uix2/chain-${tag}-phase2`);
  await sleep(9_000);
  await driver.screenshot(`uix2/chain-${tag}-phase2-later`);
  const step2 = await driver.eval(() => document.body.textContent?.match(/[^\n]{0,90}(done|Settled|received|VCHF)[^\n]*/)?.[0]?.slice(0, 400) ?? 'no-terminal-yet');
  console.log('[chain-capture] tail state:', step2);
  console.log('[chain-capture] done — shots in e2e/shots/uix2/');
} finally {
  await env.stop();
  await r2.stop();
}
