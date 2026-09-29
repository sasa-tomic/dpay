/**
 * Flow 09 — the jest twin of `e2e/tests/09-double-spend.mjs` (IC-rail replay safety).
 *
 * A replayed payment must be credited ONCE: the idempotency key is the request_id (a sha256 over
 * the signed envelope's content) — POSTing the SAME envelope bytes twice returns 202 both times
 * but executes exactly once. Re-signing (even identical fields) yields a NEW request_id and WOULD
 * double-pay — the hazard the flow pins on the request_id derivation. No app mount needed: this is
 * the relay's own money-safety contract, signed here with the SAME wasm core the app signs with.
 */
import {it, expect} from '@jest/globals';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {
  DpayCore, faucetAccount, generateKeypair, getBalance, icpCatalog, relayGet,
} from '../harness/lib';

// The file's private relay — the origin every shared-relay reference below means.
const HF = hermeticFlow();
import {hexBytes} from './local';

const PAY_CENTS = '2500';
const NONCE_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

hermeticDescribe('flow 09 — double-spend: request_id dedup on identical-byte resubmit', () => {
  it('both POSTs 202, the transfer executes once, and re-signing is a NEW request', async () => {
    // --- Payer + payee, both funded so balances are unambiguous. ---------------------------------
    const alice = await generateKeypair();
    const bob = await generateKeypair();
    expect((await faucetAccount(alice.publicHex, 10_000)).ok).toBe(true);
    expect((await faucetAccount(bob.publicHex, 10_000)).ok).toBe(true);

    // --- Sign ONE envelope (the payer would hand this to the rail exactly once). -----------------
    const catalog = await icpCatalog();
    const desc = catalog.find((c) => c.currency === 0);
    if (!desc?.ledger) throw new Error('no currency-0 ledger in the catalog');
    const payee = await DpayCore.icpPrincipalFromPubkey(bob.publicHex);
    const argHex = await DpayCore.icpTransferArg(payee, '', '', PAY_CENTS, desc.fee ?? '', NONCE_HEX);
    const expiryNs = (BigInt(Date.now()) * 1_000_000n + 300_000n * 1_000_000n).toString();
    const signed = await DpayCore.icpSignUpdate(alice.secretHex, desc.ledger, 'icrc1_transfer', argHex, expiryNs);
    const envelopeBytes = hexBytes(signed.envelopeHex);

    // --- POST the SAME bytes twice — both accepted (202), executed once. -------------------------
    const post = () => fetch(`${HF.relay.baseURL}/api/v2/canister/${desc.ledger}/call`, {
      method: 'POST',
      headers: {'Content-Type': 'application/cbor'},
      body: envelopeBytes,
    });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // --- Ledger truth: credited once, debited once. ----------------------------------------------
    expect(await getBalance(bob.publicHex, 0)).toBe('12500');
    expect(await getBalance(alice.publicHex, 0)).toBe('7500');

    // --- The txn log carries exactly ONE transfer row for this memo. ------------------------------
    const txns = (await relayGet(`/api/v1/transactions/${bob.publicHex}?currency=0&limit=10`) as {transactions: Array<{memo: string; amount: string}>}).transactions;
    const transferRows = txns.filter((t) => t.memo === NONCE_HEX && t.amount === PAY_CENTS);
    expect(transferRows).toHaveLength(1);

    // --- The hazard: re-signing identical fields = NEW request_id = would double-pay. ------------
    const resigned = await DpayCore.icpSignUpdate(alice.secretHex, desc.ledger, 'icrc1_transfer', argHex, (BigInt(expiryNs) + 1_000_000n).toString());
    expect(resigned.requestIdHex).not.toBe(signed.requestIdHex);
  }, 60_000);
});
