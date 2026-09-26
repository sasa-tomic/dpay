// Flow 215 — the offline permit claim (D28 / D21-D25): the merchant mints an evmreq:v1 OFFLINE,
// the payer signs an EIP-2612 permit OFFLINE (a cached nonce — the D22 model), the claim comes
// back as evmpay:v1, and the merchant settles (permit → transferFrom, gas from the merchant's
// ETH) THROUGH the harness relay's evm proxy. Settle-first-wins: the SECOND settle of the same
// claim spends nothing (D24.4).
//
// LIVE (this skeleton): the full money mechanics + wire codec, UI-independent —
//   1. stage: payer holds ZCHF and NO ETH (an offline signer needs no gas); merchant holds ETH
//      and NO ZCHF (that is what the claim collects);
//   2. the wire codec: evmreq:v1 / evmpay:v1 encode→decode round trips byte-exact, malformed
//      inputs fail TYPED, the 600s window is enforced (the D21 contract, pinned here so the app
//      twin cannot drift silently);
//   3. the payer's "last online moment": the nonce + DOMAIN_SEPARATOR read through the pipe,
//      the domain CROSS-CHECKED against the contract's own answer, then the permit digest is
//      signed OFFLINE (no network in the signing step, by construction);
//   4. the merchant settles through the pipe: permit() lands, transferFrom() lands, ZCHF moves
//      payer → merchant exactly, the permit nonce is consumed (single-use);
//   5. the double hand-off: the settle pre-check (eth_getLogs owner→to, amt) FINDS the settled
//      transfer — a second settle of the same claim reports settled and spends NOTHING.
// TODO(app-ui) — the legs that need both screens + the claim queue (owned by other streams):
//   - merchant request QR renders the evmreq URI; payer scan path feeds the offline signer;
//   - dead-URL seam during the offline sign (the flow-46 discipline, network-refusal assert);
//   - claim QR scan-back → settle action rides the request/receive screen; both screens flip;
//   - the claim queue persistence + needsResign marker for a stale-nonce failure.
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {
  deriveEvmKeypair, rpc, ethCall, signEip1559, signDigest, sendRawRpc, permitDigestMinimal, domainSeparatorMinimal,
  encodePermit, encodeTransferFrom, encodeErc20BalanceOf, encodeErc20Nonces,
  encodeDomainSeparator, decodeUint256, eip55, evmAddressOf, TRANSFER_TOPIC, decodeTransferLog,
} from '../harness/evm/evm-core.mjs';
import {encodeEvmReq, decodeEvmReq, encodeEvmPay, decodeEvmPay, isEvmReqExpired} from '../harness/evm/qr.mjs';

export const meta = {
  id: '215',
  name: 'evm-offline-claim',
  journey: 'offline',
  covers: ['evm-offline-claim', 'evmreq-wire', 'evmpay-wire', 'eip2612-permit', 'settle-first-wins', 'relay-evm-pipe'],
  verifies: 'EVM offline claim: an offline evmreq:v1 → offline EIP-2612 permit signature (cached nonce, domain cross-checked on-chain) → evmpay:v1 → merchant settle (permit + transferFrom, merchant gas) moves ZCHF payer→merchant exactly through the relay pipe, consumes the permit nonce, and a second settle of the same claim spends nothing (settle-first-wins); the QR screens, dead-URL seam assert and claim-queue legs are stubbed in this skeleton.',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
  optional: true, // excluded from the default suite until the UI legs land (needs the app/evm seam)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[215] ${msg}`); };
const ZCHF = (n) => BigInt(n) * 10n ** 18n;
const CLAIM_AMOUNT = ZCHF(7);
const MERCHANT_ETH_WEI = 10_000_000_000_000_000n; // 0.01 ETH — covers permit + transferFrom settle gas

export async function run() {
  const start = Date.now();
  const payerSeed = devSeed('215-payer');
  const merchantSeed = devSeed('215-merchant');
  const payer = deriveEvmKeypair(payerSeed);
  const merchant = deriveEvmKeypair(merchantSeed);
  console.log(`[215-evm-offline-claim] staging: payer ${payer.address} (ZCHF, no ETH) · merchant ${merchant.address} (ETH, no ZCHF)…`);
  const env = await stagePipe({
    recipients: [
      {seed: payerSeed, zchfRaw: ZCHF(100), ethWei: 0n},
      {seed: merchantSeed, zchfRaw: 0n, ethWei: MERCHANT_ETH_WEI},
    ],
  });
  try {
    const viaPipe = (method, params) => rpc(env.pipe, method, params, {timeoutMs: 8_000});
    const token = env.anvil.tokenAddress;
    const balanceOf = (owner) => viaPipe('eth_call', [{to: token, data: encodeErc20BalanceOf(owner)}, 'latest']).then(decodeUint256);

    // --- 1. the merchant mints the request OFFLINE (no chain read — the D21 fact) ------------
    const now = Math.floor(Date.now() / 1000);
    const rid = merchantSeed.slice(0, 32); // 32 lowercase hex from a valueless seed
    const req = {
      v: 1, rid, chainId: 31337, token: 'ZCHF', to: merchant.address,
      amt: CLAIM_AMOUNT.toString(), iat: now, exp: now + 600,
      name: 'Kaffi Luzern', memo: 'tisch 4',
    };
    const reqUri = encodeEvmReq(req);
    assert(reqUri.startsWith('evmreq:v1?') && reqUri.length <= 2000, 'request URI must be evmreq:v1?… and ≤ 2000 chars');
    assert(JSON.stringify(decodeEvmReq(reqUri)) === JSON.stringify(req), 'decode(encode(req)) must round-trip exactly');
    assert(encodeEvmReq(decodeEvmReq(reqUri)) === reqUri, 'encode(decode(uri)) must reproduce the URI bytes (canonical invariant)');
    for (const [bad, kinds] of [
      [reqUri.replace('evmreq:v1?', 'evmreq:v2?'), ['bad-scheme']],
      [reqUri + 'x', ['bad-base64', 'bad-json']], // extra char: non-canonical base64 OR one junk byte breaking JSON — typed either way
      [reqUri.slice(0, -4), ['bad-json']],
    ]) {
      let caught = null;
      try { decodeEvmReq(bad); } catch (e) { caught = e.kind ?? 'untyped'; }
      assert(kinds.includes(caught), `malformed request ${kinds[0]} must fail TYPED (${kinds.join('|')}), got ${caught}`);
    }
    assert(!isEvmReqExpired(req, now + 600) && isEvmReqExpired(req, now + 601), 'valid through the expiry second, expired after it');
    console.log('[215-evm-offline-claim]  ✓ evmreq:v1 wire: round trip byte-exact, typed failures, 600s window');

    // --- 2. the payer's LAST ONLINE moment: cache nonce + domain through the pipe ------------
    // The domain is the MINIMAL EIP-712 form (chainId + verifyingContract, no name/version) —
    // what the real ZCHF (ERC20PermitLight) signs and what the committed MockZCHF blob implements.
    const nonce = decodeUint256(await ethCall(env.pipe, token, encodeErc20Nonces(payer.address)));
    const dsOnChain = decodeUint256(await ethCall(env.pipe, token, encodeDomainSeparator())).toString(16).padStart(64, '0');
    const dsLocal = domainSeparatorMinimal({chainId: 31337, verifyingContract: token}).slice(2);
    assert(dsOnChain === dsLocal, `DOMAIN_SEPARATOR mismatch: chain 0x${dsOnChain} != local 0x${dsLocal} — the domain shape is wrong`);
    console.log('[215-evm-offline-claim]  ✓ nonce cached + DOMAIN_SEPARATOR cross-checked (minimal EIP-712 domain, chain+token-bound)');

    // --- 3. the OFFLINE signature: digest + sign, zero network in this step ------------------
    const digest = permitDigestMinimal({
      chainId: 31337, verifyingContract: token,
      owner: payer.address, spender: merchant.address,
      value: CLAIM_AMOUNT, deadline: BigInt(req.exp), nonce,
    });
    const sig = signDigest(digest, payer.privateKeyHex);
    const pay = {v: 1, rid, owner: payer.address, deadline: req.exp, sig: sig.sigHex};
    const payUri = encodeEvmPay(pay);
    const payRoundTrip = decodeEvmPay(payUri);
    assert(payRoundTrip.sig === sig.sigHex && payRoundTrip.rid === rid, 'claim must round-trip byte-exact');
    assert(sig.sigHex.length === 132 && /^0x[0-9a-f]{130}$/.test(sig.sigHex), 'the claim sig is 65 bytes as 130 lowercase hex');
    console.log('[215-evm-offline-claim]  ✓ evmpay:v1 claim signed OFFLINE (permit digest 65B r||s||v)');

    // --- 4. the merchant settles THROUGH the pipe: permit() → transferFrom() ------------------
    const settle = async (data) => {
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
      for (let i = 0; i < 40; i++) {
        const r = await viaPipe('eth_getTransactionReceipt', [hash]);
        if (r != null) {
          assert(BigInt(r.status) === 1n, `settle leg reverted (status ${r.status})`);
          return r;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      throw new Error('[215] settle leg never confirmed within 10s');
    };
    const payerZchfBefore = await balanceOf(payer.address);
    // ecrecover wants v ∈ {27,28}: the claim's 65-byte sig already ends in 1b/1c; the encoded
    // uint8 must be the same 27-offset form, never the raw 0/1 recovery id.
    await settle(encodePermit(payer.address, merchant.address, CLAIM_AMOUNT, BigInt(req.exp), sig.v + 27, sig.r, sig.s));
    console.log('[215-evm-offline-claim]  ✓ permit() included — the offline signature is on-chain-valid');
    await settle(encodeTransferFrom(payer.address, merchant.address, CLAIM_AMOUNT));
    console.log('[215-evm-offline-claim]  ✓ transferFrom() included — the pull-claim collected');

    // Balances + single-use nonce, polled past the 2s read TTL.
    const deadline = Date.now() + 8_000;
    for (;;) {
      const payerNow = await balanceOf(payer.address);
      const merchantNow = await balanceOf(merchant.address);
      const nonceNow = decodeUint256(await ethCall(env.pipe, token, encodeErc20Nonces(payer.address)));
      if (payerNow === payerZchfBefore - CLAIM_AMOUNT && merchantNow === CLAIM_AMOUNT && nonceNow === nonce + 1n) break;
      if (Date.now() > deadline) {
        assert(payerNow === payerZchfBefore - CLAIM_AMOUNT, `payer ${payerNow} != ${payerZchfBefore - CLAIM_AMOUNT}`);
        assert(merchantNow === CLAIM_AMOUNT, `merchant ${merchantNow} != ${CLAIM_AMOUNT}`);
        assert(nonceNow === nonce + 1n, `permit nonce ${nonceNow} != consumed ${nonce + 1n} — replay protection broken`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log('[215-evm-offline-claim]  ✓ settled exactly once · nonce consumed (single-use)');

    // --- 5. the double hand-off (D24.4): the second settle spends NOTHING ---------------------
    const head = await viaPipe('eth_getBlockByNumber', ['latest', false]);
    const dup = await viaPipe('eth_getLogs', [{
      fromBlock: '0x0', toBlock: head.number, address: token,
      // TRANSFER topic is REQUIRED here: permit() emits Approval(owner, spender, value) with the
      // SAME indexed positions, and the approval would masquerade as a settled transfer.
      topics: [TRANSFER_TOPIC, '0x' + payer.address.toLowerCase().slice(2).padStart(64, '0'), '0x' + merchant.address.toLowerCase().slice(2).padStart(64, '0')],
    }]);
    const settledTransfers = dup.map(decodeTransferLog).filter((d) => d != null && d.value === CLAIM_AMOUNT);
    assert(settledTransfers.length === 1, `pre-check must find EXACTLY one settled transfer, found ${settledTransfers.length} — a second settle would double-spend`);
    console.log('[215-evm-offline-claim]  ✓ double hand-off: pre-check finds the settled transfer → reports settled, spends nothing');

    // TODO(app-ui): request-QR render · dead-URL seam during the payer's offline sign (the
    // flow-46 network-refusal assert) · claim QR scan-back · settle action on the request
    // screen + both screens flip · the claim queue (queued→settled) + needsResign marker legs.
    console.log('[215-evm-offline-claim]  · TODO(app-ui): QR screens / dead-URL seam / claim-queue legs are stubbed');
  } finally {
    await env.stop();
  }
  console.log(`[215-evm-offline-claim] PASS (${Date.now() - start}ms)`);
}
