// Flow 221 — the EVM pay link (D28 / D17/D7): `…/wallet/pay/<0x…>?asset=ZCHF&network=<chain>`
// resolves onto the evm asset and PREFILLS the send form (route disclosed, never auto-signed).
//
// LIVE (this skeleton): the link grammar + the link's promise, UI-independent —
//   1. the canonical link shape is built exactly as deepLink.ts pins it (recipient in the path,
//      asset=ZCHF, network=<settlement-chain slug>, decimal display amount);
//   2. the network slug mapping is the registry's (42161→arbitrum, 1→ethereum, 421614→
//      arbitrum-sepolia, 31337→anvil) — the canonical shared-link spellings;
//   3. the link's promise is REAL: the named recipient holds the asset the link names, on the
//      chain the link names (staged + read through the relay pipe);
//   4. `ref` is ABSENT on a reusable link — the EVM request path uses rid inside evmreq:v1
//      instead (no on-chain memo channel exists on ERC-20 — the D18 fact, pinned here).
// TODO(app-ui) — the legs that need resolvePayLink + the send form (owned by other streams):
//   - opening the link prefills the send-to-address form on the evm asset, route disclosed
//     BEFORE the amount commits, full 0x destination rendered, nothing auto-signed;
//   - `?asset=ZCHF&network=solana` refuses `wrong_network` NAMING both the asset and the chain;
//   - the camera-scanned request QR opens the link (the flow-176 loop, evm arm).
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {deriveEvmKeypair, rpc, encodeErc20BalanceOf, decodeUint256} from '../harness/evm/evm-core.mjs';
import {ANVIL_ACCOUNT_0_PRIV, fundEth, transferToken} from '../harness/evm/anvil.mjs';
import {
  setup, onboardWallet, accountOf, openBalances, waitForWallet,
} from '../harness/lib.mjs';

export const meta = {
  id: '221',
  name: 'evm-paylink',
  journey: 'pay',
  covers: ['evm-pay-link', 'link-grammar', 'chain-slugs', 'relay-evm-pipe'],
  verifies: 'EVM pay link: the canonical /wallet/pay/<0x>?asset=ZCHF&network=<slug> grammar (registry chain slugs, decimal display amount, no ref on EVM) is pinned, the link\'s promise is real, the link prefills the REAL send form (full 0x destination + decimal amount, route disclosed before the amount commits, nothing signed), and ?asset=ZCHF&network=solana refuses wrong_network naming both the asset and the chain; the camera-scanned request loop is flow 220\'s offline claim (an EVM request is signed from its evmreq QR, never opened as a link — D21/D18).',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[221] ${msg}`); };

// The chain slugs (D7): the settlement-chain slug a shared link MUST spell. The registry lives
// once app-side (app/evm/chains.ts, stream S2); this table pins the wire spellings here so a
// registry rename breaks THIS flow loudly instead of silently changing shared links.
const CHAIN_SLUGS = {42161: 'arbitrum', 1: 'ethereum', 421614: 'arbitrum-sepolia', 31337: 'anvil'};

function payLink({origin, recipient, asset, network, amount}) {
  const u = new URL(`${origin}/wallet/pay/${recipient}`);
  u.searchParams.set('asset', asset);
  u.searchParams.set('network', network);
  if (amount != null) u.searchParams.set('amount', amount);
  return u.toString();
}

export async function run() {
  const start = Date.now();
  const merchantSeed = devSeed('221-merchant');
  const merchant = deriveEvmKeypair(merchantSeed);
  const ZCHF = (n) => BigInt(n) * 10n ** 18n;
  console.log(`[221-evm-paylink] staging: merchant ${merchant.address} holds ZCHF on chain 31337…`);
  const env = await stagePipe({recipients: [{seed: merchantSeed, zchfRaw: ZCHF(25), ethWei: 0n}]});
  try {
    // 1+2. the canonical link shapes — one per settlement chain, slugs from the registry table.
    const local = 'http://127.0.0.1:8787';
    const link = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: CHAIN_SLUGS[31337], amount: '12.50'});
    const parsed = new URL(link);
    assert(parsed.pathname === `/wallet/pay/${merchant.address}`, 'the recipient IS the resource: 0x address in the path');
    assert(parsed.searchParams.get('asset') === 'ZCHF' && parsed.searchParams.get('network') === 'anvil', 'asset + network (settlement chain slug) are the routing pair');
    assert(parsed.searchParams.get('amount') === '12.50', 'amount is decimal DISPLAY units');
    assert(parsed.searchParams.get('ref') === null, 'no ref on an EVM link — there is no on-chain memo channel; the request path carries rid in evmreq:v1 (D18)');
    for (const [chainId, slug] of Object.entries(CHAIN_SLUGS)) {
      const u = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: slug});
      assert(new URL(u).searchParams.get('network') === slug, `slug for chain ${chainId} must be ${slug}`);
      // The slug is also a REFUSAL gate: normaliseNetwork lowercases+hyphenates, so a hand-typed
      // "Arbitrum One" can never alias the pinned slug (the wrong_network refusal's raw material).
      assert(slug === slug.toLowerCase().replace(/\s+/g, '-'), `slug ${slug} must be lowercase-hyphenated (no aliasing)`);
    }
    console.log('[221-evm-paylink]  ✓ link grammar + registry slugs pinned (arbitrum / ethereum / arbitrum-sepolia / anvil)');

    // 3. the link's promise is REAL — the named recipient holds the named asset on the named
    // chain, read through the relay pipe.
    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const chainId = await viaPipe('eth_chainId', []);
    assert(BigInt(chainId) === 31337n, 'the link names chain 31337 (anvil) — the pipe must serve that chain');
    const bal = decodeUint256(await viaPipe('eth_call', [{to: env.anvil.tokenAddress, data: encodeErc20BalanceOf(merchant.address)}, 'latest']));
    assert(bal === ZCHF(25), `merchant balance ${bal} != staged 25 ZCHF — the link must never promise money that is not there`);
    console.log(`[221-evm-paylink]  ✓ promise verified: ${merchant.address} holds ${bal} raw ZCHF on 31337 (through the pipe)`);

    // 4. size/shape bounds a shared link must survive: a label at the 32-byte cap stays a URL.
    const longLabel = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: 'anvil', amount: '1'}) + '&label=' + 'x'.repeat(32);
    assert(longLabel.length <= 2000, 'a capped-label link must stay within the QR-safe URL bound');

    // ── The app legs: the link PREFILLS the send form on the evm asset, never signs ─────────────
    console.log('[221-evm-paylink] booting the app for the prefill legs…');
    const app = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
    const {driver} = app;
    try {
      await onboardWallet(driver, 'evm-221');
      const id = await accountOf(driver);
      const payer = deriveEvmKeypair(id.secretHex);
      // The payer holds a little of the asset + gas so the send sheet's review is fully live
      // (a known-zero balance gates the sheet fund-first — the link never signs).
      await fundEth(env.anvil.rpcUrl, payer.address, 10_000_000_000_000_000n); // 0.01 ETH
      await transferToken(env.anvil.rpcUrl, env.anvil.tokenAddress, ANVIL_ACCOUNT_0_PRIV, payer.address, ZCHF(25));

      // The anvil row is a TESTNET row: reveal it first, or the link cannot resolve onto it.
      await waitForWallet(driver);
      await openBalances(driver);
      await driver.findByTestID('btn-toggle-testnet', {timeoutMs: 15_000});
      await driver.click('btn-toggle-testnet', {timeoutMs: 5_000});

      // The LINK — delivered through the app's own link pipeline (the OS-intent seam).
      const linkUrl = `${local}/wallet/pay/${merchant.address}?asset=ZCHF&network=${CHAIN_SLUGS[31337]}&amount=12.50`;
      await driver.eval((u) => globalThis.__DPAY_TEST_DEEPLINK(u), linkUrl);
      // The send form prefilled on the evm asset: full 0x destination + the link's amount.
      await driver.findByTestID('evm-send-amount-input', {timeoutMs: 10_000});
      const prefillDeadline = Date.now() + 15_000;
      let addrVal = '';
      let amtVal = '';
      for (;;) {
        const vals = await driver.eval(() => ({
          addr: document.querySelector('[data-testid="evm-send-address-input"]')?.value ?? '',
          amt: document.querySelector('[data-testid="evm-send-amount-input"]')?.value ?? '',
        }));
        addrVal = vals.addr;
        amtVal = vals.amt;
        if (addrVal === merchant.address && amtVal === '12.50') break;
        if (Date.now() > prefillDeadline) {
          throw new Error(`prefill never landed: address "${addrVal}" amount "${amtVal}"`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      // The ROUTE is disclosed before the amount commits: the status line names the settlement chain.
      await driver.findByTestID('evm-send-status', {timeoutMs: 5_000});
      const statusTxt = (await (await driver.findByTestID('evm-send-status')).evaluate((n) => (n.textContent ?? '').trim()));
      assert(/Anvil/.test(statusTxt), `the route disclosure should name Anvil, got "${statusTxt}"`);
      // NEVER auto-signed: no send is in flight and no terminal exists.
      assert(!(await driver.isPresent('evm-send-hash')), 'a link must never sign — no tx hash may exist after prefill');
      console.log('[221-evm-paylink]  ✓ link prefilled the send form (full 0x + amount, route disclosed, nothing signed)');

      // The refusal leg: ZCHF does not live on Solana — wrong_network names BOTH by name.
      const badLink = `${local}/wallet/pay/${merchant.address}?asset=ZCHF&network=solana&amount=12.50`;
      await driver.eval((u) => globalThis.__DPAY_TEST_DEEPLINK(u), badLink);
      await driver.findByTestID('pay-link-error-body', {timeoutMs: 10_000});
      const errTxt = (await (await driver.findByTestID('pay-link-error-body')).evaluate((n) => (n.textContent ?? '').trim()));
      assert(/ZCHF/.test(errTxt) && /Solana/.test(errTxt), `wrong_network must name the asset AND the chain, got "${errTxt}"`);
      console.log('[221-evm-paylink]  ✓ wrong_network refused by name (ZCHF × Solana)');
    } finally {
      await app.stop();
    }

    // TODO(app-ui): open the link on the booted app → send-to-address form prefilled on the evm
    // asset (route disclosed before the amount commits, full 0x rendered, nothing signed);
    // ?asset=ZCHF&network=solana refuses wrong_network NAMING both; the camera-scanned request
    // QR opens the link (flow-176 loop, evm arm).
    console.log('[221-evm-paylink]  · TODO(app-ui): prefill / wrong_network refusal / scan-QR legs are stubbed');
  } finally {
    await env.stop();
  }
  console.log(`[221-evm-paylink] PASS (${Date.now() - start}ms)`);
}
