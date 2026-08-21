// Flow 87 — offline payer signs with no IC call, then accepts the merchant-returned result.
import {setup, assert, getBalance, onboardWallet, accountOf} from '../harness/lib.mjs';
import {generateKeypair, randNonceHex} from '../harness/wire.mjs';

export const meta = {
  id: '87',
  name: 'nfc-payer-settle',
  journey: 'nfc',
  covers: ['nfc', 'payer', 'offline', 'returned-result', 'exact-once'],
  verifies: 'Offline card prepares update+read_state, never submits, and only a nonce/rid-bound merchant result resolves Paid.',
  timeoutMs: 30000,
};

export async function run() {
  const env = await setup();
  try {
    const {driver, relayBaseURL} = env;
    await driver.eval(() => { window.__DPAY_TEST_NFC_STATUS = 'ready'; });
    await onboardWallet(driver, 'e2e-nfc-payer');
    const payer = await accountOf(driver);
    const merchant = await generateKeypair();
    const payerBefore = BigInt(await getBalance(relayBaseURL, payer.publicHex, 0));
    const merchantBefore = BigInt(await getBalance(relayBaseURL, merchant.publicHex, 0));

    const dispatch = event => driver.eval(e => window.__DPAY_TEST_NFC_SESSION(e), event);
    const nonceHex = randNonceHex();
    await dispatch({
      type: 'request', role: 'card', toHex: merchant.publicHex, amount: '1000',
      nonceHex, expiry: Math.floor(Date.now() / 1000) + 240, currency: 0,
    });
    await driver.findByTestID('nfc-status', {timeoutMs: 5000});

    let approved = null;
    for (let i = 0; i < 50 && !approved; i += 1) {
      approved = await driver.eval(() => window.__DPAY_TEST_NFC_APPROVED_WIRE);
      if (!approved) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(approved?.envelopeHex?.length > 128, 'offline payer must approve a real signed IC update');
    assert(approved?.readStateEnvelopeHex?.length > 128, 'offline payer must also provide a signed read_state envelope');

    await dispatch({type: 'phase', role: 'card', phase: 'settling'});
    await dispatch({type: 'done', role: 'card'});

    // The merchant owns submission. Nothing moves when card-side `done` fires.
    assert(BigInt(await getBalance(relayBaseURL, payer.publicHex, 0)) === payerBefore, 'payer card must not submit its own NFC update');
    const catalog = (await (await fetch(`${relayBaseURL}/api/v1/currencies`)).json()).currencies;
    const ledger = catalog.find(c => c.currency === 0)?.ledger;
    const submit = await fetch(`${relayBaseURL}/api/v2/canister/${ledger}/call`, {
      method: 'POST', headers: {'Content-Type': 'application/cbor'}, body: Buffer.from(approved.envelopeHex, 'hex'),
    });
    assert(submit.ok, `merchant submission must be accepted, got ${submit.status}`);
    await dispatch({type: 'result', role: 'card', status: 0, nonceHex, requestIdHex: approved.requestIdHex});
    assert(await driver.waitForText('Paid ✓ ∂10.00', {timeoutMs: 15000}), 'payer should resolve Paid only from the returned result');

    const payerAfter = BigInt(await getBalance(relayBaseURL, payer.publicHex, 0));
    const merchantAfter = BigInt(await getBalance(relayBaseURL, merchant.publicHex, 0));
    assert(payerAfter === payerBefore - 1000n, `payer must debit exactly 1000, got ${payerBefore}→${payerAfter}`);
    assert(merchantAfter === merchantBefore + 1000n, `merchant must credit exactly 1000, got ${merchantBefore}→${merchantAfter}`);
    await driver.screenshot('87-nfc-payer-settle');
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(e => { console.error(`\n[87-nfc-payer-settle] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
