// Flow 220 — the offline permit claim (D28 / D21-D25) through the REAL app, both roles:
//
//   MERCHANT (boot A): the request QR is minted OFFLINE in the Receive tab (evmreq:v1 — no
//     chain read), the payer's signed evmpay:v1 code is fed to the scan-back, and the claim
//     settles through the harness relay's evm pipe (permit → transferFrom, merchant gas). The
//     screen flips to "Received ✓" (D18's deterministic request flip — the claim echoes the rid
//     the device minted), and the pipe confirms the ZCHF moved exactly once.
//
//   PAYER (boot B): the merchant's request is scanned via the camera seam and signed with the
//     connectivity oracle pinned OFFLINE (the D22 offline sign — the cached nonce, zero RPC in
//     the signing path). The signed evmpay:v1 QR renders, "Handed to merchant" lands the honest
//     pending, and after the harness settles the claim the pending-claim badge's read-only
//     "Check now" finds the on-chain Transfer and reports settled (D25).
//
// The double hand-off (D24.4 — a second settle spends nothing) stays pinned harness-side below.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, ethCall, signEip1559, signDigest, sendRawRpc, permitDigestMinimal,
  encodePermit, encodeTransferFrom, encodeErc20BalanceOf, encodeErc20Nonces,
  decodeUint256, eip55, evmAddressOf,
} from '../harness/evm/evm-core.mjs';
import {encodeEvmReq, decodeEvmReq, encodeEvmPay} from '../harness/evm/qr.mjs';
import {ANVIL_ACCOUNT_0_PRIV, fundEth, transferToken} from '../harness/evm/anvil.mjs';
import {
  setup, onboardWallet, accountOf, selectEvmAsset, waitForEnabled, armPayScan,
} from '../harness/lib.mjs';

export const meta = {
  id: '220',
  name: 'evm-offline-claim',
  journey: 'offline',
  covers: ['evm-offline-claim', 'evmreq-wire', 'evmpay-wire', 'eip2612-permit', 'settle-first-wins', 'relay-evm-pipe'],
  verifies: 'EVM offline claim through the real app: the merchant mints an evmreq:v1 QR in the Receive tab (offline), the payer signs the EIP-2612 permit OFFLINE (connectivity pinned down, cached nonce) and hands it off honestly pending, the merchant\'s scan-back settles through the relay pipe (permit + transferFrom, merchant gas) and the request screen flips to Received, the pending-claim badge reports settled after the chain shows the Transfer, and a second settle of the same claim spends nothing.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[220] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const CLAIM_AMOUNT = ZCHF(7);
const MERCHANT_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH — covers permit + transferFrom settle gas

export async function run() {
  const start = Date.now();
  const payerSeed = devSeed('220-payer');
  const payer = deriveEvmKeypair(payerSeed);
  console.log(`[220-evm-offline-claim] staging: payer ${payer.address} (ZCHF, no ETH) · merchant boots in-app…`);
  const env = await stagePipe({
    recipients: [
      {seed: payerSeed, zchfRaw: ZCHF(100), ethWei: 0n},
    ],
  });
  const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
  const token = env.anvil.tokenAddress;
  const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);

  // The harness-side settle legs (the merchant mechanics the app drives below, exercised raw for
  // the payer boot): permit() then transferFrom(), signed by the merchant key. Retried with a
  // fresh nonce: the app's own e2e-cadence polls share the anvil, and its decoder has a measured
  // spurious-failure mode under concurrent load (sendRawRpc tolerates one; this tolerates a run).
  const settleRaw = async (merchant, data, attempts = 4) => {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const mNonce = BigInt(await viaPipe('eth_getTransactionCount', [merchant.address, 'pending']));
        const head = await viaPipe('eth_getBlockByNumber', ['latest', false]);
        const baseFee = BigInt(head.baseFeePerGas);
        const tip = 2_000_000_000n;
        const {rawTx} = signEip1559({
          privHex: merchant.privateKeyHex, chainId: 31337n, nonce: mNonce,
          maxFeePerGas: baseFee * 4n + tip, maxPriorityFeePerGas: tip,
          gasLimit: 120_000n, to: token, value: 0n, data,
        });
        const hash = await sendRawRpc(env.pipe, rawTx);
        for (let i = 0; i < 60; i++) {
          const r = await viaPipe('eth_getTransactionReceipt', [hash]);
          if (r != null) {
            assert(BigInt(r.status) === 1n, `settle leg reverted (status ${r.status})`);
            return r;
          }
          await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error('[220] settle leg never confirmed within 15s');
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        // A REVERT is a chain VERDICT (the replay leg depends on it surfacing): retry only
        // transport-shaped failures.
        if (msg.includes('reverted (status') || msg.includes('reverted (status 0x0)')) throw e;
        await new Promise((res) => setTimeout(res, 1_500));
      }
    }
    throw lastErr;
  };

  try {
    // ═══ BOOT A — the MERCHANT: request QR → scan-back → settle → "Received ✓" ════════════════
    const merchantApp = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
    try {
      await onboardWallet(merchantApp.driver, 'evm-220-merchant');
      const merchantId = await accountOf(merchantApp.driver);
      const merchant = deriveEvmKeypair(merchantId.secretHex);
      await fundEth(env.anvil.rpcUrl, merchant.address, MERCHANT_ETH_WEI);
      console.log(`[220-evm-offline-claim] merchant ${merchant.address} funded with settle gas`);

      await selectEvmAsset(merchantApp.driver, 'evm-zchf-anvil');
      await merchantApp.driver.click('tab-receive', {timeoutMs: 5_000});
      // The request form → mint the evmreq:v1 QR (OFFLINE by construction — no chain read).
      await merchantApp.driver.findByTestID('evm-req-amount-input', {timeoutMs: 5_000});
      await merchantApp.driver.type('evm-req-amount-input', '7', {timeoutMs: 5_000});
      await waitForEnabled(merchantApp.driver, 'btn-evm-req-make', {timeoutMs: 10_000});
      await merchantApp.driver.click('btn-evm-req-make', {timeoutMs: 5_000});
      await merchantApp.driver.findByTestID('evm-req-qr', {timeoutMs: 5_000});
      const reqUri = await merchantApp.driver.eval(() => window.__DPAY_QR_LAST);
      assert(typeof reqUri === 'string' && reqUri.startsWith('evmreq:v1?'), `the request QR must be an evmreq:v1 URI, got ${String(reqUri).slice(0, 40)}`);
      const req = decodeEvmReq(reqUri);
      assert(req.to.toLowerCase() === merchant.address.toLowerCase() && req.amt === CLAIM_AMOUNT.toString(), 'the request must bind the merchant address and the typed amount');
      console.log('[220-evm-offline-claim]  ✓ merchant request QR minted (evmreq:v1, rid ' + req.rid.slice(0, 8) + '…)');

      // Harness-side: sign the payer's permit claim over THIS request (the on-chain nonce —
      // what the payer's cached copy held at their last online moment).
      const nonce = decodeUint256(await ethCall(env.pipe, token, encodeErc20Nonces(payer.address)));
      const digest = permitDigestMinimal({
        chainId: 31337n, verifyingContract: token,
        owner: payer.address, spender: merchant.address,
        value: CLAIM_AMOUNT, deadline: BigInt(req.exp), nonce,
      });
      const sig = signDigest(digest, payer.privateKeyHex);
      const pay = {v: 1, rid: req.rid, owner: payer.address, deadline: req.exp, sig: sig.sigHex};
      const payUri = encodeEvmPay(pay);
      const payerZchfBefore = await balanceOf(payer.address);

      // The merchant scans the payer's signed code back (the camera seam) → the app queues +
      // settles ONLINE → the request screen flips to Received.
      await merchantApp.driver.click('btn-evm-req-scan', {timeoutMs: 5_000});
      await merchantApp.driver.eval((uri) => window.__DPAY_TEST_SCAN(uri), payUri);
      const statusDeadline = Date.now() + 60_000;
      for (;;) {
        if (await merchantApp.driver.isPresent('evm-req-status')) break;
        if (Date.now() > statusDeadline) {
          const body = await merchantApp.driver.bodyText();
          throw new Error(`the settle never flipped the request screen; body: ${body.slice(0, 240)}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const statusTxt = (await (await merchantApp.driver.findByTestID('evm-req-status')).evaluate((n) => (n.textContent ?? '').trim()));
      assert(/Received ✓/.test(statusTxt), `the request screen should read "Received ✓ …", got "${statusTxt}"`);
      console.log(`[220-evm-offline-claim]  ✓ scan-back settled: "${statusTxt}"`);

      // The chain: ZCHF moved payer → merchant exactly once, the permit nonce consumed.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const payerNow = await balanceOf(payer.address);
        const merchantNow = await balanceOf(merchant.address);
        const nonceNow = decodeUint256(await ethCall(env.pipe, token, encodeErc20Nonces(payer.address)));
        if (payerNow === payerZchfBefore - CLAIM_AMOUNT && merchantNow === CLAIM_AMOUNT && nonceNow === nonce + 1n) break;
        if (Date.now() > deadline) {
          assert(payerNow === payerZchfBefore - CLAIM_AMOUNT, `payer ${payerNow} != ${payerZchfBefore - CLAIM_AMOUNT}`);
          assert(merchantNow === CLAIM_AMOUNT, `merchant ${merchantNow} != ${CLAIM_AMOUNT}`);
          assert(nonceNow === nonce + 1n, `permit nonce ${nonceNow} != consumed ${nonce + 1n}`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      console.log('[220-evm-offline-claim]  ✓ on-chain: payer -7.00 exact · merchant +7.00 · nonce consumed');
    } finally {
      await merchantApp.stop();
    }

    // ═══ BOOT B — the PAYER: offline sign → honest pending → Check-now finds the settle ═══════
    const payerApp = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
    try {
      await onboardWallet(payerApp.driver, 'evm-220-payer');
      const payerId = await accountOf(payerApp.driver);
      const payerDevice = deriveEvmKeypair(payerId.secretHex);
      // Fund THIS boot's payer (the boot A payer was the staged seed; this one is the onboarded
      // identity) — ZCHF only, zero gas: an offline signer needs none.
      await transferToken(env.anvil.rpcUrl, token, ANVIL_ACCOUNT_0_PRIV, payerDevice.address, ZCHF(100));

      await selectEvmAsset(payerApp.driver, 'evm-zchf-anvil');
      // A fresh request addressed to the merchant (harness-built — the merchant's code, printed).
      const now = Math.floor(Date.now() / 1000);
      const rid = payerId.secretHex.slice(0, 32);
      const req2 = {
        v: 1, rid, chainId: 31337, token: 'ZCHF', to: eip55(evmAddressOf('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')),
        amt: ZCHF(7).toString(), iat: now, exp: now + 600,
        name: 'Kaffi Luzern', memo: 'tisch 4',
      };
      const req2Uri = encodeEvmReq(req2);

      // Pin the connectivity oracle OFFLINE, then scan: the balance gates fail OPEN (offline
      // first) and the permit signature is produced with ZERO network — the D22 offline sign.
      await payerApp.driver.eval(() => { globalThis.__DPAY_TEST_EVM_CONNECTIVITY = 'offline'; });
      await armPayScan(payerApp.driver);
      await payerApp.driver.eval((uri) => window.__DPAY_TEST_SCAN(uri), req2Uri);
      await payerApp.driver.findByTestID('evm-pay-qr', {timeoutMs: 15_000});
      const payUri2 = await payerApp.driver.eval(() => window.__DPAY_QR_LAST);
      assert(typeof payUri2 === 'string' && payUri2.startsWith('evmpay:v1?'), `the signed claim QR must be an evmpay:v1 URI, got ${String(payUri2).slice(0, 40)}`);
      const pay2 = JSON.parse(Buffer.from(payUri2.slice('evmpay:v1?'.length), 'base64url').toString('utf8'));
      assert(pay2.rid === rid && pay2.deadline === req2.exp, 'the claim must echo the request rid + deadline');
      console.log('[220-evm-offline-claim]  ✓ payer signed OFFLINE (evmpay:v1 QR rendered with connectivity down)');

      // "Handed to merchant" → the honest pending (never "Paid").
      await payerApp.driver.click('btn-evm-pay-handed', {timeoutMs: 5_000});
      const paidTxt = (await (await payerApp.driver.findByTestID('evm-pay-status', {timeoutMs: 5_000})).evaluate((n) => (n.textContent ?? '').trim()));
      assert(/Sent/.test(paidTxt) && !/Paid ✓/.test(paidTxt), `the pending headline must be "Sent …" (never "Paid ✓"), got "${paidTxt}"`);
      console.log(`[220-evm-offline-claim]  ✓ honest pending: "${paidTxt}"`);

      // The merchant collects: settle THIS claim through the pipe (harness-side legs). The gas
      // payer is anvil's well-known account #0 (valueless).
      const anvilPayer = {address: eip55(evmAddressOf(ANVIL_ACCOUNT_0_PRIV)), privateKeyHex: ANVIL_ACCOUNT_0_PRIV};
      const nonce2 = decodeUint256(await ethCall(env.pipe, token, encodeErc20Nonces(payerDevice.address)));
      const digest2 = permitDigestMinimal({
        chainId: 31337n, verifyingContract: token,
        owner: payerDevice.address, spender: req2.to,
        value: BigInt(req2.amt), deadline: BigInt(req2.exp), nonce: nonce2,
      });
      const sig2 = signDigest(digest2, payerDevice.privateKeyHex);
      await settleRaw(anvilPayer, encodePermit(payerDevice.address, req2.to, BigInt(req2.amt), BigInt(req2.exp), sig2.v + 27, sig2.r, sig2.s));
      await settleRaw(anvilPayer, encodeTransferFrom(payerDevice.address, req2.to, BigInt(req2.amt)));
      console.log('[220-evm-offline-claim]  ✓ the merchant collected the handed-off claim (through the pipe)');

      // Back online, the payer's read-only "Check now" finds the settled Transfer and reports it.
      await payerApp.driver.eval(() => { delete globalThis.__DPAY_TEST_EVM_CONNECTIVITY; });
      await payerApp.driver.click('btn-evm-pay-done', {timeoutMs: 5_000}); // back to the scanner
      await payerApp.driver.findByTestID('evm-pay-pending', {timeoutMs: 10_000});
      const checkDeadline = Date.now() + 45_000;
      let lastNote = '';
      for (;;) {
        // (Re-press the affordance — a poll tick can swallow a press between renders.)
        if (await payerApp.driver.isPresent('btn-evm-pay-check')) {
          await payerApp.driver.click('btn-evm-pay-check', {timeoutMs: 3_000}).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 2_500));
        lastNote = await payerApp.driver.isPresent('evm-pay-check-note')
          ? (await (await payerApp.driver.findByTestID('evm-pay-check-note')).evaluate((n) => (n.textContent ?? '').trim()))
          : '';
        if (/Settled/.test(lastNote)) { console.log(`[220-evm-offline-claim]  ✓ pending claim resolved: "${lastNote}"`); break; }
        if (!(await payerApp.driver.isPresent('evm-pay-pending'))) {
          // Success by the badge's own rule: no queued/unknown claim remains, so the row flipped
          // to settled and the pending notice unmounted with it.
          console.log('[220-evm-offline-claim]  ✓ pending claim resolved (badge cleared — nothing pending)');
          break;
        }
        if (Date.now() > checkDeadline) {
          const probeLogs = payerApp.driver.consoleLog.filter(e => /PROBE_|money: evm/.test(e.text)).map(e => e.text.slice(0, 140));
          const diag = await payerApp.driver.eval(() => {
            const el = document.querySelector('[data-testid="btn-evm-pay-check"]');
            if (!el) return 'button GONE';
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return 'rect=' + JSON.stringify({x: r.x, y: r.y, w: r.width, h: r.height}) + ' hit=' + (hit ? hit.tagName + '.' + (hit.getAttribute ? hit.getAttribute('data-testid') : '') : 'none') + ' disabled=' + el.disabled;
          });
          throw new Error(`the claim check never reported settled (last note: "${lastNote}"; ${diag}; console: ${probeLogs.slice(-6).join(' || ')})`);
        }
      }

      // The double hand-off (D24.4): a second settle of the same claim settles NOTHING — the
      // replayed permit REVERTS on-chain (the nonce is consumed), exactly one settlement.
      const payerZchf = await balanceOf(payerDevice.address);
      const merchantZchf = decodeUint256(await viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(req2.to)}, 'latest']));
      await settleRaw(anvilPayer, encodePermit(payerDevice.address, req2.to, BigInt(req2.amt), BigInt(req2.exp), sig2.v + 27, sig2.r, sig2.s)).then(
        () => { throw new Error('[220] a replayed permit SUCCEEDED — replay protection broken'); },
        () => { /* the expected shape: the permit re-run reverts on-chain */ },
      );
      assert((await balanceOf(payerDevice.address)) === payerZchf, 'the double hand-off must not move the payer twice');
      assert((await balanceOf(req2.to)) === merchantZchf, 'the double hand-off must not pay the merchant twice');
      console.log('[220-evm-offline-claim]  ✓ double hand-off: the replay reverts — exactly one settlement');
    } finally {
      await payerApp.stop();
    }
  } finally {
    await env.stop();
  }
  console.log(`[220-evm-offline-claim] PASS (${Date.now() - start}ms)`);
}
