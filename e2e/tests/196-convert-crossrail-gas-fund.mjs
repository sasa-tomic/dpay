// Flow 196 — the cross-rail gas-fund card ("pay the gas from what you have").
//
// Route C (ICP→ckUSDC→USDC→Solana) burns through the user's Ethereum wallet, and the burn
// legs' gas is paid in IN-WALLET ckETH. A wallet with no ckETH used to dead-end as a passive
// warning. This flow drives the actionable card end to end:
//   §1 the destination gains EIP-55 checksum enforcement at entry plus a one-time re-entry
//      confirm that must pass BEFORE the gas-fund offer can ever render (this also closes the
//      pre-existing Route A typo exposure: one flipped case verifies as a DIFFERENT address);
//   §2 with gasShort + a measured external balance, the card shows Need ≈ and Your wallet:
//      (one number per line), the passive warn stands down, and [Fund from this wallet] is
//      enabled because a funding path exists (the icpswap-cketh pool pairs ICP→ckETH);
//   §3 the self path: the address, `Send ≥ X ETH`, [Check again] — a recheck with a still-short
//      balance names the missing slice, a recheck with a funded balance re-opens the offer;
//   §4 the funded path: the wallet button prepends the funding legs (7 total, the checklist
//      says the first legs fund the gas), the record runs to awaiting_external, and declining
//      there names BOTH stranded assets — the USDC at the address, the gas funding in-wallet.
// The external-wallet read is the app's own device-direct eth_getBalance (publicnode): the
// engine's cctp stub fail-closes unknown origins, and this flow layers a MUTABLE balance
// answer on top so §3 can move the balance between rechecks.

import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, faucetAccount, getBalance, openBalances, selectCurrency, isDisabled, openConvertFor,
  pickSwapTarget,
  pickSwapVenue, openOtherVenues,
  typeConvertAmount,
} from '../harness/lib.mjs';
import {startRelay} from '../harness/relay.mjs';
import {installCctpStub, FORWARD_TX_HASH} from '../harness/cctp.mjs';

const ROUTE_C_ROW = 'convert-venue-multihop:icpswap-ckusdc:2:cctp:jupiter';
// The USDC token contract in checksummed form, a ONE-CHARACTER case corruption of it
// (checksum-bad, shape-valid — the mixed-case typo class), and a lowercase lookalike with a
// different final nibble for proving the re-entry gate actually COMPARES the two typings.
const DEST = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEST_BAD = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eb48';
const DEST_OTHER = DEST.toLowerCase().slice(0, -1) + '3';

const SEED_ICP = 2000000000n;     // 20 ICP — conversion principal + the funding budget
const SEED_ETH = 50000000000000n; // 0.00005 ckETH — below need: gasShort from the start
const NEED_WEI = 93600000000000n; // fresh feeWei 7.8e13 + 20% (the engine's own headroom rule)
const F = (n, d) => { const s = BigInt(n).toString().padStart(d + 1, '0'); return `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, ''); };

export const meta = {
  id: '196',
  name: 'convert-crossrail-gas-fund',
  journey: 'convert',
  covers: ['convert', 'multihop', 'route-c', 'cross-rail', 'cctp', 'gas-fund', 'eip55',
    'checksum', 're-entry', 'eth_getBalance', 'honest-exit'],
  verifies: 'A gasShort cross-rail conversion offers to fund the gas from the wallet — but only ' +
    'behind a checksummed, re-typed destination. The card shows Need ≈ and Your wallet: one number ' +
    'per line (the passive warn stands down), the self path rechecks against the live balance and ' +
    'names the shortfall, the funded path prepends the gas legs into the same checklist, and the ' +
    'decline card says where BOTH the USDC and the gas funding sit.',
  timeoutMs: 180000,
};

export async function run() {
  const start = Date.now();
  console.log('[196-gas-fund] setup (own relay + shared web + browser)…');
  const env = await setup({ solStub: true });
  const r2 = await startRelay();
  try {
    const { driver, webBaseURL } = env;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, { waitUntil: 'domcontentloaded', timeoutMs: 8_000 });
    await driver.waitReady({ timeoutMs: 8_000 });

    console.log('[196-gas-fund] onboarding + funding ICP and a SHORT ckETH balance…');
    await onboardWallet(driver, 'e2e-crossrail-gas-fund');
    const account = await accountOf(driver);
    const fundIcp = await faucetAccount(r2.baseURL, account.publicHex, Number(SEED_ICP), { currency: 8 });
    assert(fundIcp.ok, `faucet ICP credit ok (status ${fundIcp.status})`);
    const fundEth = await faucetAccount(r2.baseURL, account.publicHex, Number(SEED_ETH), { currency: 6 });
    assert(fundEth.ok, `faucet ckETH credit ok (status ${fundEth.status})`);

    // The engine's fail-closed CCTP/publicnode stub, then a MUTABLE balance layer on top
    // (last wrap wins for the publicnode origin) so §3 can move the balance per recheck.
    const passOrigins = [new URL(r2.baseURL).origin, new URL(webBaseURL).origin, new URL(env.relayBaseURL).origin];
    await installCctpStub(driver, { passOrigins, forwardTxHash: FORWARD_TX_HASH });
    await driver.eval((hex) => {
      const prev = window.fetch.bind(window);
      globalThis.__E2E_ETH_BALANCE_HEX = hex;
      globalThis.__E2E_ETH_READS = 0;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.startsWith('https://ethereum-rpc.publicnode.com')) {
          let body = {};
          try { body = JSON.parse((init && init.body) || '{}'); } catch { /* fall through */ }
          if (body.method === 'eth_getBalance') {
            globalThis.__E2E_ETH_READS += 1;
            return Promise.resolve(new Response(JSON.stringify({
              jsonrpc: '2.0', id: body.id ?? 1, result: globalThis.__E2E_ETH_BALANCE_HEX,
            }), { status: 200, headers: { 'content-type': 'application/json' } }));
          }
        }
        return prev(input, init);
      };
    }, '0x' + SEED_ETH.toString(16));

    // --- §1 checksum at entry + the one-time re-type gate -----------------------------------
    await openConvertFor(driver, 'icp');
    await pickSwapTarget(driver, 'SOL');
    await typeConvertAmount(driver, '5');
    // The sheet auto-picks the device-signable AMM row; Route C (the CCTP crossing) is the
    // explicit opt-in row behind the ONE Other-venues expander (brief 5.4.1).
    await openOtherVenues(driver);
    assert(await driver.findByTestID(ROUTE_C_ROW, { timeoutMs: 3_000 }) != null, 'the Route C row is offered');
    await driver.click(ROUTE_C_ROW);
    await driver.findByTestID('convert-headline', { timeoutMs: 15_000 });

    console.log('[196-gas-fund] §1 checksum reject + re-entry confirm…');
    // Shape-valid but checksum-bad: refused AT ENTRY, minimal line, no re-type ask yet.
    await driver.type('convert-dest-address', DEST_BAD);
    await driver.waitForText('Checksum mismatch', { timeoutMs: 8_000 });
    assert(!(await driver.isPresent('convert-dest-address-invalid')), 'the SHAPE is not flagged — only the checksum');
    assertEq(await isDisabled(driver, 'btn-convert-confirm'), true, 'confirm stays disabled on a checksum-bad destination');
    assert(!(await driver.isPresent('convert-dest-reenter')), 'no re-type ask while the checksum is bad');

    // Fix the one character (type replaces the field): the ask becomes a one-time re-entry.
    await driver.type('convert-dest-address', DEST);
    await driver.waitForFunction(
      () => !document.querySelector('[data-testid="convert-dest-checksum"]'), { timeoutMs: 8_000 });
    await driver.findByTestID('convert-dest-reenter', { timeoutMs: 5_000 });
    // The gate must COMPARE: a full-length but different typing names the mismatch…
    await driver.type('convert-dest-reenter', DEST_OTHER);
    await driver.waitForText('Does not match', { timeoutMs: 5_000 });
    // …and the real re-type opens it.
    await driver.type('convert-dest-reenter', DEST);
    await driver.waitForFunction(
      () => !document.querySelector('[data-testid="convert-dest-reenter"]'), { timeoutMs: 8_000 });
    await driver.findByTestID('convert-route-min', { timeoutMs: 15_000 });
    assertIncludes(await driver.readText('convert-dest-cross-note'), 'also the wallet that signs',
      'the destination input still warns that this address also SIGNS the crossing');

    // --- §2 the offer card: Need ≈ / Your wallet: (one number per line) ---------------------
    console.log('[196-gas-fund] §2 the card: need vs have…');
    await driver.findByTestID('convert-gas-fund-card', { timeoutMs: 20_000 });
    const card = await driver.readText('convert-gas-fund-card');
    assertIncludes(card, `Need ≈ ${F(NEED_WEI, 18)} ETH`, 'the card names the need (fresh feeWei + headroom)');
    assertIncludes(card, `Your wallet: ${F(SEED_ETH, 18)} ETH`, 'the card names the measured have');
    assert(!(await driver.isPresent('convert-gas-preflight')), 'the passive warn stands down while the card is up');
    assertEq(await isDisabled(driver, 'btn-gas-fund-wallet'), false, 'the wallet button is enabled — a funding path exists');
    const readsAfterMount = await driver.eval(() => globalThis.__E2E_ETH_READS);
    assert(readsAfterMount >= 1, 'the card measured the external wallet (eth_getBalance)');

    // --- §3 the self path: address, Send ≥, recheck names the shortfall, recheck returns ----
    console.log('[196-gas-fund] §3 self-fund + rechecks…');
    await driver.click('btn-gas-fund-self');
    await driver.waitForText(`Send ≥ ${F(NEED_WEI, 18)} ETH`, { timeoutMs: 5_000 });
    const selfCard = await driver.readText('convert-gas-fund-card');
    assertIncludes(selfCard, DEST, 'the self path names the destination to fund');

    // Balance drained to 2e13: the recheck names the STILL-missing slice (need − have).
    await driver.eval(() => { globalThis.__E2E_ETH_BALANCE_HEX = '0x' + (20000000000000n).toString(16); });
    await driver.click('btn-gas-fund-recheck');
    await driver.waitForText(`Still ${F(NEED_WEI - 20000000000000n, 18)} ETH short`, { timeoutMs: 10_000 });

    // Balance funded (0.001): the recheck closes the self branch and re-opens the offer.
    await driver.eval(() => { globalThis.__E2E_ETH_BALANCE_HEX = '0x' + (1000000000000000n).toString(16); });
    await driver.click('btn-gas-fund-recheck');
    await driver.waitForText('Your wallet: 0.001 ETH', { timeoutMs: 10_000 });

    // --- §4 the funded path: prepended legs, honest decline --------------------------------
    console.log('[196-gas-fund] §4 fund from this wallet…');
    const ethBefore = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    await driver.click('btn-gas-fund-wallet');
    // Quote churn re-review (the 186 loop), but through the wallet-fund gesture.
    for (let round = 0; round < 5; round++) {
      const changed = await driver.findByTestID('convert-moved-note', { timeoutMs: 2_000 }).catch(() => null);
      if (changed == null) break;
      console.log(`[196-gas-fund] quote moved (round ${round + 1}) — re-funding`);
      if (await driver.isPresent('btn-gas-fund-wallet')) await driver.click('btn-gas-fund-wallet');
      else await driver.click('btn-convert-confirm');
    }

    // The record adopts with the funding legs PREPENDED: 2 gas legs + 5 conversion legs = 7,
    // and the checklist says in one line what the first legs are for.
    await driver.findByTestID('convert-gas-legs-note', { timeoutMs: 20_000 });
    assertIncludes(await driver.readText('convert-gas-legs-note'), 'fund the gas', 'the checklist names the gas legs');
    assert(await driver.findByTestID('convert-leg-6-state', { timeoutMs: 10_000 }) != null, '7 legs are planned (2 gas + 5 conversion)');

    await driver.waitForText('is at your Ethereum address', { timeoutMs: 60_000 });
    const ethAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 6));
    assert(ethAfter > ethBefore, 'in-wallet ckETH grew: the funding legs delivered more than the burn spent');

    // Decline at awaiting_external on a gas-funded record: BOTH assets get their whereabouts.
    await driver.click('btn-crossrail-decline', { timeoutMs: 10_000 });
    await driver.waitForText('Nothing crossed', { timeoutMs: 10_000 });
    const failedCard = await driver.readText('convert-failed-leg');
    assertIncludes(failedCard, DEST, 'the decline card names the USDC\u2019s address');
    assertIncludes(failedCard, 'still in this wallet', 'the decline card names where the gas funding sits');

    // Ledger truth: the funding came out of the same wallet (ICP spent beyond principal+fee)
    // and the ckETH net position is UP (funded in-wallet, gas not yet spent — nothing signed).
    const icpAfter = BigInt(await getBalance(r2.baseURL, account.publicHex, 8));
    assert(icpAfter < SEED_ICP - 500000000n - 10000n, 'ICP: the funding budget left the wallet too');
    assert(icpAfter > 0n, 'ICP: a real remainder stays (the budget is a thin gas slice, not the wallet)');

    console.log(`GREEN 196 — cross-rail gas-fund card: checksum+re-entry gate, need-vs-have offer, self-fund recheck, prepended gas legs, honest decline (in ${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 196:', e);
    process.exit(1);
  });
}
