/**
 * Flow 29 — the jest twin of `e2e/tests/29-exact-amount.mjs` (MC1 units 2-4, IC-rail edition).
 *
 * Proves a raw amount > 2^53 round-trips BYTE-EXACT through every boundary that can carry it:
 *   1. FAUCET: a >2^53 credit returns the balance as the EXACT decimal string.
 *   2. REQUEST WIRE: build + decode a 132-byte request carrying the >2^53 raw amount.
 *   3. SIGN: the icrc1_transfer arg uleb128-encodes the exact raw and the SIGNED ENVELOPE embeds
 *      those arg bytes verbatim (the signature covers the exact raw).
 *   4. SETTLE: the u128 fake-IC ledger credits/debits exact decimal strings on both sides.
 * `Number("9007199254740993") === 9007199254740992` — impossible via number.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe} from '../harness/hermetic';
import {
  accountOf, assertEq, DpayCore, generateKeypair, getBalance, icpCatalog,
  onboardWallet, railTransfer,
} from '../harness/lib';
import {relayBaseURL, relayGet} from '../harness/relayClient';

const BIG_RAW = '9007199254740993'; // 2^53 + 1
const FUTURE_EXPIRY = 4_102_444_800; // 2100-01-01Z

hermeticDescribe('flow 29 — exact amount transport (>2^53) on the IC rail', () => {
  it('2^53+1 round-trips byte-exact through faucet / request wire / signed envelope / rail settle', async () => {
    // --- 1. FAUCET: the balance answer is the EXACT decimal string. ------------------------------
    // (The amount crosses as a DECIMAL STRING — the relay's U64String parses it without the
    // precision loss a JS number would introduce before the body was even built.)
    const alice = await generateKeypair();
    const fund = await fetch(`${relayBaseURL()}/api/v1/faucet`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({account: alice.publicHex, amount: BIG_RAW}),
    });
    expect(fund.ok).toBe(true);
    expect(((await fund.json()) as {balance?: string}).balance).toBe(BIG_RAW);

    // --- 2. REQUEST WIRE: build + decode a 132-byte request carrying the >2^53 amount. -----------
    const m = await onboardWallet('jest-bigamt');
    const bobHex = (await accountOf(m))!.publicHex;
    const nonce = 'ef'.repeat(16);
    const requestQR = await DpayCore.encodeRequest(bobHex, BIG_RAW, nonce, FUTURE_EXPIRY, 0, 'jest-bigamt', 'big');
    const req = await DpayCore.decodeRequest(requestQR);
    assertEq(req.toHex, bobHex, 'decoded request.to == merchant B');
    assertEq(req.amount, BIG_RAW, 'decoded request.amount == 2^53+1 (byte-exact; impossible via number)');

    // --- 3. SIGN: the arg's uleb128 tail IS the exact raw; the envelope embeds the arg verbatim. --
    const catalog = await icpCatalog();
    const desc = catalog.find((c) => c.currency === 0);
    if (!desc?.ledger) throw new Error('no currency-0 ledger');
    const payee = await DpayCore.icpPrincipalFromPubkey(bobHex);
    const argHex = await DpayCore.icpTransferArg(payee, '', '', BIG_RAW, desc.fee ?? '', nonce);
    const uleb: number[] = [];
    for (let v = BigInt(BIG_RAW);; v >>= 7n) {
      const b = Number(v & 0x7fn);
      if (v >> 7n === 0n) { uleb.push(b); break; }
      uleb.push(b | 0x80);
    }
    const ulebHex = Buffer.from(uleb).toString('hex');
    expect(argHex.slice(-ulebHex.length / 2 * 2)).toBe(ulebHex);
    const expiryNs = (BigInt(Date.now()) * 1_000_000n + 300_000n * 1_000_000n).toString();
    const signed = await DpayCore.icpSignUpdate(alice.secretHex, desc.ledger, 'icrc1_transfer', argHex, expiryNs);
    expect(signed.envelopeHex.includes(argHex)).toBe(true);

    // --- 4. SETTLE: u128 ledger, decimal-string truth on both sides + the txn log. ----------------
    const pay = await railTransfer(alice.secretHex, bobHex, BIG_RAW, {memoHex: nonce});
    expect(pay.ok).toBe(true);
    expect(pay.status).toBe(202);
    assertEq(await getBalance(bobHex, 0), (10_000n + BigInt(BIG_RAW)).toString(), 'payee B balance');
    assertEq(await getBalance(alice.publicHex, 0), '0', 'payer A balance (the 2^53+1 debit landed whole)');
    const j = await relayGet(`/api/v1/transactions/${bobHex}?currency=0&limit=5`) as {transactions: Array<{memo: string; amount: string}>};
    const bigRow = j.transactions.find((t) => t.memo === nonce);
    expect(bigRow !== undefined && bigRow.amount === BIG_RAW).toBe(true);

    await m.unmount();
  }, 120_000);
});
