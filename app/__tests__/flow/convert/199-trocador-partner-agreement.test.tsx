/**
 * flow 199 (trocador-partner-agreement) — hermetic per-flow file: one describe, ONE PRIVATE relay
 * (harness/hermetic.ts), split from the old consolidated convert/flows.test.tsx. Knobs and stub
 * upstreams are per-spawn state of this file's relay; the counter audits are absolute; the old
 * cross-file sequencing (shared knobs, delta baselines, purge workarounds) is gone.
 */
import {it, expect, afterEach} from '@jest/globals';
import {
  assertIncludes, onboardWallet, accountOf, openConvertFor, typeConvertAmount,
  pickSwapTarget, openOtherVenues,
} from '../harness/lib';
import {relayGet} from '../harness/relayClient';
import {hermeticFlow, hermeticDescribe} from '../harness/hermetic';
import {readFile} from 'node:fs/promises';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installHeapProbe} from './heapProbe';
import {
  disposeConvertStubs, installSolRpcStub, deriveSolanaKeypair, solSentTxs,
  icpAccountIdHex, enableSolRail,
} from './convertStubs';

installHeapProbe();

const LOG_DIR = join(tmpdir(), 'dpay-flow-199-trocador-log');
rmSync(LOG_DIR, {recursive: true, force: true});
mkdirSync(LOG_DIR, {recursive: true});
// The partner agreement is relay-PROCESS config (DPAY_PUBLIC_ORIGIN + its own trocador
// access log): hermeticFlow spawns THIS file's relay with it; {{base}} resolves to the
// spawned relay's own address. The deterministic log dir is cleaned here at module scope
// (sync fs), before the spawn — the access-log census counts absolute lines.
const H = hermeticFlow({relay: {env: {DPAY_PUBLIC_ORIGIN: '{{base}}', DPAY_TROCADOR_LOG_DIR: LOG_DIR}}});

const DEPOSIT_ADDRESS_TROCADOR = 'e2e-trocador-deposit-01';

  // ── Flow 199 — the PARTNER AGREEMENT the relay runs around every Trocador call ────────────────
  // The pre-agreement SURFACE semantics are flow 198's pin (above); this pins what the agreement
  // ADDS when the relay runs as the agreement deploys it: DPAY_PUBLIC_ORIGIN set, its own
  // DPAY_TROCADOR_LOG_DIR. That is relay-PROCESS config, so the file's hermeticFlow spawns the relay WITH it
  // (env: DPAY_PUBLIC_ORIGIN + this file's trocador access-log dir; the SOL rail is the
  // in-memory stub behind the operator override, nothing broadcast — the cefi deposit is a
  // handoff).
  //
  //   1. TRADE CREATION CARRIES THE WEBHOOK PARAMS UPSTREAM — the stub venue observes
  //      webhook=<origin>/api/v1/trocador/webhook and webhook_key=<order_id>, and the relay
  //      answers the device with X-Dpay-Order-Id (the same id).
  //   2. THE WEBHOOK ROUTE IS LIVE AT CREATION TIME — the venue's probe-shaped GET answers 200.
  //   3. THE WEBHOOK IS THE PRIMARY STATUS CHANNEL — a delivery keyed to the order's webhook_key
  //      lands the pushed status in the app's convert view (processing → done) with the stub's
  //      status hit-count FROZEN (zero upstream status reads; the cache serves verbatim).
  //   4. THE ACCESS LOG EXISTS AND CORRELATES — kinds rate/trade/status/webhook/webhook-unmatched,
  //      matched webhook lines carry the order/trade ids, cache-served reads carry NO upstream
  //      status, and the unmatched deliveries are logged (the GET probe; the bogus-key POST).
hermeticDescribe('flow 199 — the trocador partner agreement (webhook registration, webhook-first status, access log)', () => {
  afterEach(() => {
    disposeConvertStubs();
  });

    it('drives a real SOL→ICP trocador convert on an agreement-configured private relay', async () => {
      // The hermetic relay IS the agreement-configured relay: hermeticFlow spawned it with
      // DPAY_PUBLIC_ORIGIN ({{base}} → its own address) and this file's trocador log dir.
      const r2 = await H.ready;
      const logDir = LOG_DIR;
      const webhookURL = `${r2.base}/api/v1/trocador/webhook`;
      const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
      const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
      const hitsAt = async (): Promise<{bareCalls: number; tradeCalls: number; rateCalls: number; statusCalls: number; lastTradeQuery?: string}> =>
        await relayGet('/api/v1/test/trocador-upstream/hits') as Awaited<ReturnType<typeof hitsAt>>;
      const accessLines = async (): Promise<Array<Record<string, unknown>>> => {
        const text = await readFile(join(logDir, 'trocador-access.jsonl'), 'utf8');
        return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      };
      const deliverWebhook = async (key: string, payload: string): Promise<void> => {
        const res = await fetch(`${webhookURL}?key=${encodeURIComponent(key)}`, {
          method: 'POST', headers: {'content-type': 'application/json'}, body: payload,
        });
        expect(res.ok).toBe(true);
        expect(await res.text()).toBe('{"ok":true}');
      };

      let m: Awaited<ReturnType<typeof onboardWallet>> | null = null;
      try {
        // The hermetic seams already ride the private relay (the IC gateway seam per test, the
        // app's baked-origin fetch rewritten, the test-side relay client re-pointed); the SOL
        // rail is the operator override + the in-memory RPC stub (nothing is ever broadcast).
        await enableSolRail();
        m = await onboardWallet('jest-trocador-agreement');
        const account = await accountOf(m);
        const kp = deriveSolanaKeypair(account!.secretHex);
        const settleAddress = await icpAccountIdHex(account!.publicHex);
        installSolRpcStub({refuseSend: true});

        // §1 drive a real convert to the Trocador order (the surface walk is flow 198's to pin).
        await openConvertFor(m, 'sol', {timeoutMs: 8_000});
        await pickSwapTarget(m, 'ICP');
        await openOtherVenues(m);
        await m.driver.click('convert-venue-trocador', {timeoutMs: 8_000});
        assertIncludes(m.driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
        await typeConvertAmount(m, '2');
        await m.driver.waitForFunction(
          () => m!.driver.readTextSafe('convert-headline')?.includes('0.0496 ICP') === true,
          {timeoutMs: 20_000, label: 'the venue settle figure rendered (the rate arrived)'},
        );
        assertIncludes(m.driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
        expect(m.driver.readText('convert-settle-address')).toBe(settleAddress);

        // §2 confirm → a REAL order at awaiting_deposit (nothing broadcast — the cefi handoff).
        await m.driver.click('btn-convert-confirm', {timeoutMs: 5_000});
        expect(await m.driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}).then(() => true).catch(() => false)).toBe(true);
        assertIncludes(m.driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS_TROCADOR, 'the venue deposit address renders verbatim');
        expect(solSentTxs().length).toBe(0);

        // §3 CREATION-TIME AGREEMENT FACTS: the webhook registration rode the trade upstream.
        const hits = await hitsAt();
        expect(hits.bareCalls).toBe(0); // no bare (keyless) upstream call — the key attaches server-side
        expect(hits.tradeCalls).toBe(1);
        expect(hits.rateCalls).toBeGreaterThanOrEqual(2);
        const tradeQuery = hits.lastTradeQuery ?? '';
        assertIncludes(tradeQuery, `webhook=${webhookURL}`, 'trade creation registered THIS relay\'s webhook URL upstream (stub observed it)');
        assertIncludes(tradeQuery, 'webhook_key=trod-', 'trade creation carried a relay-minted webhook_key');
        const webhookKey = new URLSearchParams(tradeQuery).get('webhook_key');
        expect(webhookKey ?? '').toMatch(/^trod-[0-9a-f]{16}$/);

        // The access log's trade line correlates: webhook_key IS the relay's order id.
        const lines = await accessLines();
        const tradeLines = lines.filter((l) => l.kind === 'trade');
        expect(tradeLines.length).toBe(1);
        expect(tradeLines[0].order_id).toBe(webhookKey);
        expect(tradeLines[0].upstream_status).toBe(200);
        const tradeId = tradeLines[0].trade_id as string;
        const orderId = webhookKey as string;
        expect(typeof tradeLines[0].client_order_id === 'string' && (tradeLines[0].client_order_id as string).length > 0).toBe(true);

        // (b) the venue PROBES the webhook URL at creation — the receiver is already live.
        const probe = await fetch(webhookURL);
        expect(probe.status).toBe(200);
        expect(await probe.text()).toBe('{"ok":true}');
        // An UNMATCHED delivery (bogus key) is still a 200 — never retry-worthy — and is logged.
        await deliverWebhook('trod-deadbeefdeadbeef', JSON.stringify({status: 'Completed'}));

        // §4 WEBHOOK-FIRST LIFECYCLE: deliveries drive the app; the stub's status counter freezes.
        const midPayload = JSON.stringify({
          trade_id: tradeId, status: 'Processing', amount_from: '2', amount_to: '0.0496',
          provider: 'StubSwap', fixed: true,
        });
        await deliverWebhook(orderId, midPayload);
        const statusCallsBeforePush = (await hitsAt()).statusCalls;

        // The status route serves the delivery VERBATIM — the zero-upstream cache.
        const cached = await fetch(`${r2.base}/api/v1/trocador/trade?id=${encodeURIComponent(tradeId)}`);
        expect(cached.status).toBe(200);
        expect(await cached.text()).toBe(midPayload);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // The app's convert view advances on the pushed status, cache-served either way (the
        // engine tick may wait out the pre-push fallback read's 60s spacing — hence the 90s).
        expect(await m.driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}).then(() => true).catch(() => false)).toBe(true);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // Terminal delivery: the venue's own realized figures ride the SAME channel.
        const donePayload = JSON.stringify({
          trade_id: tradeId, status: 'Completed', amount_from: '2', amount_to: '0.0496',
          provider: 'StubSwap', fixed: true, details: {hashout: 'sol-settle-sig-199'},
        });
        await deliverWebhook(orderId, donePayload);
        expect(await m.driver.waitForText('Converted', {timeoutMs: 90_000})).toBe(true);
        const done = m.driver.readText('convert-done');
        assertIncludes(done, '0.0496 ICP', 'done reports the realized settle figure off the webhook payload');
        assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
        assertIncludes(done, settleAddress.slice(0, 12), 'the payout address IS the derived IC identifier');
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // §5 the device-facing correlation: a protocol-level creation names the order id at
        // X-Dpay-Order-Id — the value the webhook_key echoes; each trade mints its OWN id. (The
        // app's own record is already terminal; this second order cannot disturb it.)
        const probeTrade = await fetch(`${r2.base}/api/v1/trocador/trade`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            rateId: 'stub-rate-1', provider: 'StubSwap',
            settleAddress, refundAddress: kp.address,
            depositLedger: WRAPPED_SOL_MINT, settleLedger: ICP_LEDGER, depositAmount: '2',
          }),
        });
        expect(probeTrade.status).toBe(200);
        const headerOrderId = probeTrade.headers.get('x-dpay-order-id');
        expect(headerOrderId ?? '').toMatch(/^trod-[0-9a-f]{16}$/);
        expect(headerOrderId).not.toBe(orderId);
        const probeQuery = new URLSearchParams((await hitsAt()).lastTradeQuery ?? '');
        expect(probeQuery.get('webhook')).toBe(webhookURL);
        expect(probeQuery.get('webhook_key')).toBe(headerOrderId);
        const probeLines = await accessLines();
        const probeTradeLine = probeLines.filter((l) => l.kind === 'trade').pop();
        expect(probeTradeLine?.order_id).toBe(headerOrderId);
        expect((await hitsAt()).statusCalls).toBe(statusCallsBeforePush);

        // §6 THE ACCESS LOG CENSUS: every proxied call correlated, the zero-upstream signature.
        const all = await accessLines();
        const kinds = new Set(all.map((l) => l.kind));
        for (const kind of ['rate', 'trade', 'status', 'webhook', 'webhook-unmatched']) {
          expect(kinds.has(kind)).toBe(true);
        }
        for (const l of all) {
          expect(typeof l.ip === 'string' && (l.ip as string).length > 0).toBe(true);
          expect(typeof l.user_agent === 'string' && (l.user_agent as string).length > 0).toBe(true);
          expect(typeof l.accept_language === 'string' && (l.accept_language as string).length > 0).toBe(true);
        }
        const webhookLines = all.filter((l) => l.kind === 'webhook');
        expect(webhookLines.length).toBe(2); // both deliveries logged as matched webhooks
        for (const l of webhookLines) {
          expect(l.order_id).toBe(orderId);
          expect(l.trade_id).toBe(tradeId);
        }
        const unmatched = all.filter((l) => l.kind === 'webhook-unmatched');
        expect(unmatched.some((l) => l.method === 'GET')).toBe(true); // the creation-time probe
        expect(unmatched.some((l) => l.method === 'POST')).toBe(true); // the bogus-key delivery
        const statusLines = all.filter((l) => l.kind === 'status');
        expect(statusLines.length).toBeGreaterThanOrEqual(1);
        expect(statusLines.some((l) => l.upstream_status != null)).toBe(true); // the fallback read
        expect(statusLines.some((l) => l.upstream_status == null)).toBe(true); // the cache-served reads
      } finally {
        if (m) await m.unmount().catch(() => undefined);
      }
    }, 300_000);
});
