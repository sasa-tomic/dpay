/** SCRATCH PROBE — delete before commit. Reproduces the xevnm approve + read_state byte-path. */
import {it, expect} from '@jest/globals';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {DpayCore} from '../harness/setupFlow';

hermeticFlow();

hermeticDescribe('probe — approve/read_state byte path', () => {
  it('submits an approve and reads its status', async () => {
    const kp = await DpayCore.generateKeypair();
    const principal = await DpayCore.icpPrincipalFromPubkey(kp.publicHex);
    const XEVNM = 'xevnm-gaaaa-aaaar-qafnq-cai';
    const MINTER = 'sv3dd-oaaaa-aaaar-qacoa-cai';
    const now = Date.now();
    const envExpiry = (BigInt(now + 300_000) * 1_000_000n).toString();
    const arg = await DpayCore.icpApproveArg(MINTER, '', '', '4950000', '', '', '', '10000');
    const signed = await DpayCore.icpSignUpdate(kp.secretHex, XEVNM, 'icrc2_approve', arg, envExpiry);
    const base = (globalThis as unknown as {__DPAY_TEST_IC_GATEWAY?: string}).__DPAY_TEST_IC_GATEWAY ?? '';
    expect(base).not.toBe('');

    const bytes = new Uint8Array(signed.envelopeHex.match(/../g)!.map((h) => parseInt(h, 16)));
    const callRes = await fetch(`${base}/api/v2/canister/${XEVNM}/call`, {method: 'POST', headers: {'content-type': 'application/cbor'}, body: bytes});
    console.log('[probe] call status', callRes.status);
    expect(callRes.status).toBe(202);

    for (let i = 0; i < 6; i++) {
      const rsArg = await DpayCore.icpSignReadState(kp.secretHex, [signed.requestIdHex], true, (BigInt(Date.now() + 60_000) * 1_000_000n).toString());
      const rsBytes = new Uint8Array(rsArg.match(/../g)!.map((h) => parseInt(h, 16)));
      const rs = await fetch(`${base}/api/v2/canister/${XEVNM}/read_state`, {method: 'POST', headers: {'content-type': 'application/cbor'}, body: rsBytes});
      const raw = new Uint8Array(await rs.arrayBuffer());
      const hex = Buffer.from(raw).toString('hex');
      const ridInCert = hex.includes(signed.requestIdHex.toLowerCase());
      let decoded = 'n/a';
      try {
        const st = await DpayCore.icpDecodeReadState(hex, [signed.requestIdHex]);
        decoded = JSON.stringify(st);
      } catch (e) {
        decoded = `DECODE ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      console.log(`[probe] poll ${i}: http=${rs.status} bytes=${raw.length} ridInCert=${ridInCert} decode=${decoded}`);
      if (ridInCert) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 60_000);
});
