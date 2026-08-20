// wasm-hammer — deterministic repro of the dual-allocation wasm corruption (OPEN_ISSUES
// "wasm dual-allocator corruption"). Drives the REAL web app's wasm-backed DpayCore
// (exposed as window.__DPAY_TEST_CORE by e2e/web/shims.ts) with concurrent
// icpEnvelopeRequestId + icpSelfPrincipal calls.
//
// On a healthy build: 320 iterations, zero failures.
// On the buggy build:  deterministic failure at call #281 (memory = exactly 18 pages):
//   - w_icp_envelope_request_id returns BAD_UTF8 on VALID input
//   - the input region is overwritten DURING the export call with envelope-shaped CBOR
//     (map(6) + "request_type" text — i.e. a concurrent sign call's OUTPUT landed on this
//     call's INPUT: w_alloc handed two callers overlapping regions)
//   - retrying the same call alone immediately after RECOVERS
// Node-side interleaved repro of the same shape PASSES — browser-only.
//
// Run: node e2e/debug/wasm-hammer.mjs
import { setup, onboardWallet } from '../harness/lib.mjs';
import { generateKeypair, icpPrincipalBytes, icpTransferArgBytes, icpSignUpdate } from '../harness/wire.mjs';

const env = await setup();
try {
  const { driver, relayBaseURL } = env;
  await onboardWallet(driver, 'hammer');
  const acct = await driver.eval(() => {
    const v = localStorage.getItem('dpay.identity.v1');
    return v ? JSON.parse(v) : null;
  });
  if (!acct) throw new Error('no identity after onboarding');
  const secretHex = acct.secretHex;

  // Build a valid envelope with the Node oracle
  const alice = await generateKeypair();
  const arg = icpTransferArgBytes(icpPrincipalBytes(alice.publicHex), 2500n, { fee: null, memoHex: '22'.repeat(16) });
  const expiryNs = BigInt(Date.now() + 300_000) * 1_000_000n;
  const catalog = (await (await fetch(`${relayBaseURL}/api/v1/currencies`)).json()).currencies;
  const ledger = catalog.find((c) => c.currency === 0).ledger;
  const signed = await icpSignUpdate(alice.secretHex, ledger, 'icrc1_transfer', arg, expiryNs);

  const res = await driver.eval(async (opts) => {
    const D = window.__DPAY_TEST_CORE ?? null;
    const out = { calls: 0, fails: [], stacks: [] };
    if (!D) { out.err = 'no __DPAY_TEST_CORE seam'; return out; }
    const run = async () => {
      try {
        out.calls++;
        const rid = await D.icpEnvelopeRequestId(opts.envHex);
        const p = await D.icpSelfPrincipal(opts.secretHex);
        if (rid.length !== 64 || !p || p.length < 20) throw new Error(`bad outputs rid=${rid.length} p=${p}`);
      } catch (e) {
        out.fails.push(e instanceof Error ? e.message : String(e));
        out.stacks.push(e instanceof Error ? (e.stack || '').split('\n').slice(0, 5).join('//') : 'n/a');
        throw e;
      }
    };
    const workers = Array.from({ length: 8 }, () => (async () => {
      for (let i = 0; i < 40; i++) await run();
    })());
    try { await Promise.all(workers); } catch {}
    if (out.fails.length) {
      try {
        const rid = await D.icpEnvelopeRequestId(opts.envHex);
        out.postMortem = `alone-after-failure: rid.length=${rid.length} ${rid.length === 64 ? 'RECOVERED' : 'STILL BAD'}`;
      } catch (e) { out.postMortem = `alone-after-failure STILL FAILS: ${e instanceof Error ? e.message : String(e)}`; }
    }
    return out;
  }, { envHex: signed.envelopeHex, secretHex });
  console.log(JSON.stringify(res, null, 1));
  if (res.fails?.length) { console.error('HAMMER: FAIL — wasm corruption reproduced'); process.exitCode = 1; }
  else console.error('HAMMER: PASS');
} finally { await env.stop(); }
