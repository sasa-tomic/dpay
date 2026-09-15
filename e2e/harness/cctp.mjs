// The Circle CCTP v2 stand-in for the offline e2e harness (the jupiter.mjs pattern: a
// window.fetch replacement that answers ONLY Circle's iris-api origin, passes the relay/web
// origins through to the real fetch, and REFUSES + records every other origin — the
// fail-closed ocp.mjs rule: `unexpected` must stay empty or the flow fails).
//
// Two surfaces are faked, both keyed exactly as production reads them:
//   * GET  /v2/burn/USDC/fees/0/5?forward=true&includeRecipientSetup=true — the fee census
//     source (the LIVE body shape, captured 2026-09-15: fast=1000 minimumFee 1 bps +
//     forwardFee low/med/high in USDC subunits; standard=2000 fee 0).
//   * GET  /v2/messages/0?transactionHash=0x… — the attestation/mint status feed. Circle
//     answers 404 "Message not found…" until the burn is attested; the stub mirrors that,
//     then a scripted state machine the TEST advances from node (pending → attested →
//     complete, where complete carries the forwardTxHash = Circle's own destination mint).
//
// The state lives at globalThis.__E2E_CCTP so the flow can drive and read it via driver.eval
// (setCctpMessageState / cctpStubState below). No other seam: the app's own fetchCctpBurnFee /
// fetchCctpMessageStatus code paths run unmodified against these bytes.

/** The live fee body (captured from iris-api.circle.com 2026-09-15) — jest pins the parser
 *  against the same bytes (app/__tests__/cctp.test.ts). */
export const CCTP_FEES_BODY = [
  {finalityThreshold: 1000, minimumFee: 1, forwardFee: {low: 269688, med: 282032, high: 305756}},
  {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 269688, med: 282032, high: 305756}},
];

/** A plausible destination-mint signature (base58, Solana-shaped) standing in for the tx
 *  Circle's Forwarding Service executes on Solana. */
export const FORWARD_TX_HASH = '5KqxTAk9FnZfQrpHcQhg5rHJFwjW9uF2mYbAoXdE3vRk';

/** Mirror of the app's fee math (app/cctp.ts cctpMaxFee/cctpMintFloor — floor division
 *  everywhere) so the flow can predict the census digits from the oracle's minOut. */
export function cctpFeeExpectations(minOut) {
  const base = (minOut * 1n) / 10000n + 282032n; // protocolFee(1 bps) + med forwardFee
  const maxFee = (base * 6n) / 5n; // +20% buffer, floored
  return {maxFee, mintFloor: minOut - maxFee};
}

/** Install the in-page Circle stub. cfg: {passOrigins: string[], fees?, forwardTxHash?}. */
export async function installCctpStub(driver, cfg) {
  await driver.eval((c) => {
    if (globalThis.__E2E_CCTP_INSTALLED) return;
    globalThis.__E2E_CCTP_INSTALLED = true;
    globalThis.__E2E_CCTP = {
      state: 'pending', // 'pending' | 'attested' | 'complete' — the test advances this
      feesCalls: 0,
      messageCalls: [], // {hash, state} — every status poll, in order
      unexpected: [],
    };
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      let parsed;
      try {
        parsed = new URL(url, window.location.href);
      } catch {
        return orig(input, init);
      }
      if (parsed.origin === 'https://iris-api.circle.com') {
        if (parsed.pathname.startsWith('/v2/burn/USDC/fees/')) {
          globalThis.__E2E_CCTP.feesCalls += 1;
          return Promise.resolve(new Response(JSON.stringify(c.fees ?? [
            {finalityThreshold: 1000, minimumFee: 1, forwardFee: {low: 269688, med: 282032, high: 305756}},
            {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 269688, med: 282032, high: 305756}},
          ]), {status: 200, headers: {'content-type': 'application/json'}}));
        }
        if (parsed.pathname.startsWith('/v2/messages/')) {
          const hash = parsed.searchParams.get('transactionHash') ?? '';
          const state = globalThis.__E2E_CCTP.state;
          globalThis.__E2E_CCTP.messageCalls.push({hash, state});
          if (state === 'complete') {
            return Promise.resolve(new Response(JSON.stringify({
              messages: [{forwardTxHash: c.forwardTxHash, status: 'complete', forwardState: 'COMPLETED'}],
              sourceTxHash: hash,
            }), {status: 200, headers: {'content-type': 'application/json'}}));
          }
          if (state === 'attested') {
            // Attested but the destination mint has not landed yet (forwardState PENDING).
            return Promise.resolve(new Response(JSON.stringify({
              messages: [{status: 'complete', forwardState: 'PENDING'}],
              sourceTxHash: hash,
            }), {status: 200, headers: {'content-type': 'application/json'}}));
          }
          // pending — Circle's honest not-yet-attested answer is a 404 with a JSON error body.
          return Promise.resolve(new Response(
            JSON.stringify({error: 'Message not found for provided parameters'}),
            {status: 404, headers: {'content-type': 'application/json'}}));
        }
        globalThis.__E2E_CCTP.unexpected.push(`circle-path:${parsed.pathname}`);
        return Promise.reject(new Error(`e2e cctp stub: unexpected Circle path ${parsed.pathname}`));
      }
      if (c.passOrigins.includes(parsed.origin)) return orig(input, init);
      globalThis.__E2E_CCTP.unexpected.push(parsed.origin);
      return Promise.reject(new Error(`e2e cctp stub: unexpected origin ${parsed.origin}`));
    };
  }, {fees: cfg.fees, forwardTxHash: cfg.forwardTxHash ?? FORWARD_TX_HASH, passOrigins: cfg.passOrigins});
}

/** Advance the scripted message state (the "user's wallet signed, Circle is working" clock). */
export async function setCctpMessageState(driver, state) {
  await driver.eval((s) => {
    globalThis.__E2E_CCTP.state = s;
  }, state);
}

/** Read the stub's counters (fees calls, status polls, refused origins). */
export async function cctpStubState(driver) {
  return driver.eval(() => ({
    state: globalThis.__E2E_CCTP.state,
    feesCalls: globalThis.__E2E_CCTP.feesCalls,
    messageCalls: globalThis.__E2E_CCTP.messageCalls,
    unexpected: globalThis.__E2E_CCTP.unexpected,
  }));
}
