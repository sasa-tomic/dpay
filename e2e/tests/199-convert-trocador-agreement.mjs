// Flow 199 — the PARTNER AGREEMENT the relay now runs around every Trocador call
// (committed 4dba939, 2026-09-22): the access log, the per-trade webhooks, and the
// webhook-first status contract — proven END TO END through the real app driving a real
// convert, with the relay started the way the agreement's deployment runs it
// (DPAY_PUBLIC_ORIGIN set, DPAY_TROCADOR_LOG_DIR pointed at the flow's own directory).
//
// Flow 198 pins the pre-agreement SURFACE semantics (merged spot, sub-picker, relay-borne
// venue calls) on a relay with NO public origin — the byte-identical-legacy branch. This
// flow pins what the agreement ADDS when the origin IS set:
//
//   1. TRADE CREATION CARRIES THE WEBHOOK PARAMS UPSTREAM — the stub upstream (standing in
//      for the venue) observes `webhook=<origin>/api/v1/trocador/webhook` and
//      `webhook_key=<order_id>` on the new_trade query, and the relay answers the device
//      with `X-Dpay-Order-Id: <order_id>` — the same id, so the device can correlate a
//      webhook to its own order.
//   2. THE WEBHOOK ROUTE IS LIVE AT CREATION TIME — the venue probes the URL when the trade
//      is created and a non-2xx probe FAILS the trade, so the GET (probe-shaped) must
//      already answer 200.
//   3. THE WEBHOOK IS THE PRIMARY STATUS CHANNEL — a delivery keyed to the order's
//      webhook_key updates the order, and the NEXT status read serves that payload VERBATIM
//      with ZERO upstream calls (the stub's status hit-count freezes). The pushed status
//      lands the app's convert view (processing, then done) purely off the webhook.
//   4. THE ACCESS LOG EXISTS AND CORRELATES — one append-only JSONL line per proxied call
//      carrying ip / user-agent / accept-language and the correlation ids, with the
//      rate/trade/status/webhook/webhook-unmatched kinds all present.
import {setup, assert, assertEq, assertIncludes, onboardWallet, accountOf, openBalances} from '../harness/lib.mjs';
import {startRelay, pickFreePort} from '../harness/relay.mjs';
import {deriveSolanaKeypair} from '../harness/jupiter.mjs';
import {icpAccountIdentifierHex} from '../harness/wire.mjs';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const AMOUNT_TEXT = '2';
// The relay stub's deterministic venue figures (src/app.rs trocador_stub_*): the rate is a
// FIXED 0.0496 settle for any pair — rendered in ICP (the settle side, 8 decimals).
const SETTLE_TEXT = '0.0496 ICP';
const DEPOSIT_ADDRESS = 'e2e-trocador-deposit-01';
const SETTLE_HASH = 'sol-settle-sig-199';
const TROCADOR_MECH = 'convert-sol-dest-mech-trocador';
const CEFI_ROW = 'convert-sol-dest-cefi-sideshift';
const WEBHOOK_PATH = '/api/v1/trocador/webhook';
// The rail ids the registered Trocador row trades (the relay's own catalog constants — the
// same ids the app sends; the §5 protocol probe needs them node-side).
const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export const meta = {
  id: '199',
  name: 'convert-trocador-agreement',
  journey: 'convert',
  covers: ['convert', 'solana-rail', 'venue:trocador', 'cefi', 'partner-agreement', 'webhook',
    'webhook-first-status', 'zero-upstream-status', 'order-id-correlation', 'access-log'],
  verifies: 'With the relay running the partner agreement (DPAY_PUBLIC_ORIGIN set, its own log dir) a real SOL→ICP convert through the Trocador mechanism carries the webhook registration upstream — the stub venue observes webhook=<origin>/api/v1/trocador/webhook and webhook_key=<order_id> on the trade, the response names the same order id at X-Dpay-Order-Id, and the webhook route answers 200 to the creation-time GET probe; a venue delivery keyed to that webhook_key lands the pushed status in the app\'s convert view (processing, then done with the venue\'s own realized figures) served from the order store VERBATIM with ZERO upstream status reads (the stub\'s status hit-count freezes); and every proxied call appends a correlated line to the compliance access log (ip, user-agent, accept-language, order/trade/client ids; rate, trade, status, webhook and webhook-unmatched kinds all present).',
  timeoutMs: 300_000,
};

async function relayHits(relayBaseURL) {
  const res = await fetch(`${relayBaseURL}/api/v1/test/trocador-upstream/hits`);
  if (!res.ok) throw new Error(`relay stub hits failed (${res.status})`);
  return res.json();
}

/** The access log's lines (the agreement appends each line synchronously BEFORE the owning
 *  route answers, so everything a completed response implies is already on disk). */
async function accessLines(logDir) {
  const text = await readFile(join(logDir, 'trocador-access.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** One venue→relay status delivery: POST the trade JSON to the webhook route, keyed to the
 *  order's webhook_key (the venue echoes it back as `key` — module doc §2). */
async function deliverWebhook(relayBaseURL, key, payload) {
  const res = await fetch(`${relayBaseURL}${WEBHOOK_PATH}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: payload,
  });
  if (!res.ok) throw new Error(`webhook delivery failed (${res.status})`);
  assertEq(await res.text(), '{"ok":true}', 'the webhook receiver answers its lenient 200 sink body');
}

/** Same SOL-rail balance simulator as flows 185/197/198 — the surface reads the wallet's SOL
 *  balance honestly; nothing is ever broadcast (the cefi deposit is a handoff). */
async function installSolRpcStub(driver) {
  await driver.eval(() => {
    globalThis.__E2E_SOL_SENT = [];
    globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
      getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 5000000000, token: {amount: '2500000', decimals: 6}}),
      getGenesisHash: () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      getLatestBlockhash: () => ({context: {slot: 250000000}, value: {blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999}}),
      getMinimumBalanceForRentExemption: () => 1447680,
      getFeeForMessage: () => ({context: {slot: 250000000}, value: {lamports: 5000}}),
      sendTransaction: () => { throw new Error('NO BROADCAST: the cefi deposit is a handoff, the app never sends'); },
      getSignatureStatuses: () => ({context: {slot: 250000001}, value: [{confirmationStatus: 'confirmed'}]}),
      getBlockHeight: () => 250000000,
      getTransaction: () => ({meta: {err: null}, slot: 250000000, blockTime: 1700000000}),
      getBalance: () => ({value: 5000000000}),
      getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      getTokenAccountBalance: () => ({value: {amount: '2500000', decimals: 6, uiAmount: 2.5, uiAmountString: '2.5'}}),
    };
  });
}

/** Enter the native SOL convert surface from the accounts route (flow 198's entry). */
async function openSolConvert(driver) {
  await openBalances(driver);
  await driver.click('asset-sol-select', {timeoutMs: 8_000});
  // The tap's state can lag the click by a render under pool contention — wait for the row to
  // actually report aria-selected before asking for convert (flow 198's note).
  const selDeadline = Date.now() + 8_000;
  for (;;) {
    const selected = await driver.eval((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      return el ? el.getAttribute('aria-selected') === 'true' : null;
    }, 'asset-sol');
    if (selected === true) break;
    if (Date.now() > selDeadline) throw new Error('openSolConvert: asset-sol never reported aria-selected — the selection never landed');
    await new Promise((r) => setTimeout(r, 150));
  }
  await driver.waitForText('Convert', {timeoutMs: 6_000});
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    try {
      await driver.click('btn-accounts-convert', {timeoutMs: 8_000});
      opened = true;
    } catch (e) { if (i === 2) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
}

export async function run() {
  const env = await setup({solStub: true});
  // OWN relay + OWN log dir: the agreement's append-only files and its webhook order store are
  // SERVER-side state on the relay this page dials, and the setup relay is SHARED across lanes
  // (the flow-194/197/198 isolation rule). The public origin is THIS relay's own base — the
  // same shape prod sets — so trade creation registers a webhook URL this flow can deliver to.
  const port = await pickFreePort();
  const logDir = await mkdtemp(join(tmpdir(), 'dpay-e2e-199-agreement-'));
  const r2 = await startRelay({
    port,
    env: {
      DPAY_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      DPAY_TROCADOR_LOG_DIR: logDir,
    },
  });
  try {
    const {driver, webBaseURL} = env;
    const webhookURL = `${r2.baseURL}${WEBHOOK_PATH}`;
    const page = `/?relay=${encodeURIComponent(r2.baseURL)}`;
    await driver.navigate(webBaseURL, page, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 8_000});
    await onboardWallet(driver, 'e2e-trocador-agreement');

    const id = await accountOf(driver);
    assert(id != null && typeof id.secretHex === 'string', 'onboarded identity carries the secret');
    const kp = deriveSolanaKeypair(id.secretHex);
    const settleAddress = icpAccountIdentifierHex(id.publicHex);
    assert(settleAddress.length === 64, 'the wallet\'s own IC account identifier derives (the payout target)');

    await installSolRpcStub(driver);

    // --- §1 drive a real convert to the Trocador order (the surface walk is flow 198's to
    // pin; here it only needs to reach a REAL trade through the UI)
    await openSolConvert(driver);
    assert(await driver.findByTestID('convert-screen', {timeoutMs: 8_000}) != null, 'Convert surface opens for SOL');
    assert(await driver.waitForText('Convert SOL to USDC', {timeoutMs: 12_000}),
      'the convert surface is the SOL surface (the row testIDs below are SOL-surface facts)');
    await driver.click(CEFI_ROW, {timeoutMs: 8_000});
    await driver.click(TROCADOR_MECH, {timeoutMs: 8_000});
    assertIncludes(await driver.readText('convert-screen'), 'Convert SOL → ICP', 'the heading names the picked pair');
    await driver.type('convert-amount', AMOUNT_TEXT);
    await driver.findByTestID('convert-headline', {timeoutMs: 15_000});
    assertIncludes(await driver.readText('convert-headline'), SETTLE_TEXT, 'receive estimate is the venue settle figure verbatim');
    assertIncludes(await driver.readText('convert-quote-source'), 'Trocador', 'attribution names the venue');
    assertEq(await driver.readText('convert-settle-address'), settleAddress,
      'the payout target is the wallet\'s OWN derived IC account identifier');
    await driver.screenshot('199-agreement-checklist');

    // --- §2 confirm → a REAL order at awaiting_deposit (nothing broadcast, the cefi handoff)
    await driver.click('btn-convert-confirm', {timeoutMs: 5_000});
    assert(await driver.findByTestID('convert-awaiting-deposit', {timeoutMs: 30_000}) != null, 'the record lands at awaiting_deposit');
    assertIncludes(await driver.readText('convert-deposit-address'), DEPOSIT_ADDRESS, 'the venue deposit address renders verbatim');
    const sent = await driver.eval(() => globalThis.__E2E_SOL_SENT);
    assertEq(sent.length, 0, 'NOTHING was ever broadcast on the SOL rail — the deposit is a handoff');
    await driver.screenshot('199-agreement-awaiting-deposit');

    // --- §3 CREATION-TIME AGREEMENT FACTS: the webhook registration rode the trade upstream,
    // the receiver was already live for the venue's probe, and the ids correlate
    const hits = await relayHits(r2.baseURL);
    assertEq(hits.bareCalls, 0, 'no bare (keyless) upstream call — the key attaches server-side');
    assertEq(hits.tradeCalls, 1, 'exactly one trade creation (the confirm)');
    assert(hits.rateCalls >= 2, `the review + confirm quotes rode the proxy (saw ${hits.rateCalls})`);
    const tradeQuery = hits.lastTradeQuery ?? '';
    assertIncludes(tradeQuery, `webhook=${webhookURL}`, 'trade creation registered THIS relay\'s webhook URL upstream (stub observed it)');
    assertIncludes(tradeQuery, 'webhook_key=trod-', 'trade creation carried a relay-minted webhook_key (stub observed it)');
    const creationQuery = new URLSearchParams(tradeQuery);
    const webhookKey = creationQuery.get('webhook_key');
    assert(webhookKey != null && /^trod-[0-9a-f]{16}$/.test(webhookKey),
      `the webhook_key is a relay order id (trod- + 16 hex), saw ${webhookKey}`);

    // The access log's trade line carries the SAME order id — webhook_key == the relay's order
    // id for THIS trade (the log is written before the route answers, so it is on disk now).
    const lines = await accessLines(logDir);
    const tradeLines = lines.filter((l) => l.kind === 'trade');
    assertEq(tradeLines.length, 1, 'exactly one proxied trade so far');
    assertEq(tradeLines[0].order_id, webhookKey, 'the upstream webhook_key IS the relay\'s order id for the app\'s trade');
    assertEq(tradeLines[0].upstream_status, 200, 'the trade line records the upstream status');
    assert(typeof tradeLines[0].client_order_id === 'string' && tradeLines[0].client_order_id.length > 0,
      'the trade line correlates the device\'s clientOrderId');
    assert(typeof tradeLines[0].trade_id === 'string' && tradeLines[0].trade_id.length > 0,
      'the trade line correlates the venue\'s trade id');
    const tradeId = tradeLines[0].trade_id;
    const orderId = tradeLines[0].order_id;

    // (b) the venue PROBES the webhook URL at trade creation — the receiver must already be
    // live and answering 2xx (a failed probe fails the trade).
    const probe = await fetch(webhookURL);
    assertEq(probe.status, 200, 'the GET probe of the webhook route answers 200 at creation time');
    assertEq(await probe.text(), '{"ok":true}', 'the probe-shaped lenient sink answers its 200 body');

    // An UNMATCHED delivery (bogus key) is still a 200 — failed deliveries are never retried,
    // and a 4xx would read as retry-worthy — logged with only the hashed key.
    await deliverWebhook(r2.baseURL, 'trod-deadbeefdeadbeef', JSON.stringify({ status: 'Completed' }));

    // --- §4 WEBHOOK-FIRST LIFECYCLE: the venue (this flow) pushes the SAME transaction data
    // the trade endpoint returned, keyed to the order's webhook_key; the app's convert view
    // advances on the pushed status with ZERO upstream status reads.
    const midPayload = JSON.stringify({
      trade_id: tradeId, status: 'Processing', amount_from: AMOUNT_TEXT, amount_to: '0.0496',
      provider: 'StubSwap', fixed: true,
    });
    await deliverWebhook(r2.baseURL, orderId, midPayload);
    const statusCallsBeforePush = (await relayHits(r2.baseURL)).statusCalls;

    // The status route serves the delivery VERBATIM (byte-for-byte) — the zero-upstream cache.
    const cached = await fetch(`${r2.baseURL}/api/v1/trocador/trade?id=${encodeURIComponent(tradeId)}`);
    assertEq(cached.status, 200, 'the webhook-served status answers 200');
    assertEq(await cached.text(), midPayload, 'the webhook-served status is the delivery VERBATIM');
    // (e) a SECOND read inside the 60s window: the cache serves again — no upstream, no 429.
    const cachedAgain = await fetch(`${r2.baseURL}/api/v1/trocador/trade?id=${encodeURIComponent(tradeId)}`);
    assertEq(cachedAgain.status, 200, 'a second status read inside the window is cache-served too');
    assertEq((await relayHits(r2.baseURL)).statusCalls, statusCallsBeforePush,
      'cache-served status reads make ZERO upstream status calls');

    // The app's convert view advances on the pushed status. The next engine tick may wait out
    // a 429 backoff armed by a pre-push fallback poll (the agreement's 60s spacing) — the
    // pushed status arrives whenever that tick lands, cache-served either way.
    assert(await driver.findByTestID('convert-provider-processing', {timeoutMs: 90_000}) != null,
      'the pushed mid status drives the app\'s convert view to processing');
    assertEq((await relayHits(r2.baseURL)).statusCalls, statusCallsBeforePush,
      'the pushed status reached the app WITHOUT any upstream status poll (stub hit-count frozen)');

    // Terminal delivery: the venue's own realized figures ride the SAME channel.
    const donePayload = JSON.stringify({
      trade_id: tradeId, status: 'Completed', amount_from: AMOUNT_TEXT, amount_to: '0.0496',
      provider: 'StubSwap', fixed: true, details: {hashout: SETTLE_HASH},
    });
    await deliverWebhook(r2.baseURL, orderId, donePayload);
    assert(await driver.waitForText('Converted', {timeoutMs: 45_000}), 'the pushed terminal status drives the record to done');
    const done = await driver.readText('convert-done');
    assertIncludes(done, SETTLE_TEXT, 'done reports the realized settle figure off the webhook payload');
    assertIncludes(done, 'Paid out to your own address', 'done names the payout destination');
    assertIncludes(done, settleAddress.slice(0, 12), 'the payout address IS the derived IC principal');
    assertEq((await relayHits(r2.baseURL)).statusCalls, statusCallsBeforePush,
      'the terminal status ALSO reached the app with zero upstream status polls');
    await driver.screenshot('199-agreement-done');

    // --- §5 the device-facing half of the correlation: the trade response NAMES the order id
    // at X-Dpay-Order-Id — the value the webhook_key echoes. A protocol-level creation (the
    // documented device contract, node-side) observes the header live; the app's own record is
    // already terminal, so this second order cannot disturb its correlation.
    const probeTrade = await fetch(`${r2.baseURL}/api/v1/trocador/trade`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        rateId: 'stub-rate-1', provider: 'StubSwap',
        settleAddress, refundAddress: kp.address,
        depositLedger: WRAPPED_SOL_MINT, settleLedger: ICP_LEDGER, depositAmount: AMOUNT_TEXT,
      }),
    });
    assertEq(probeTrade.status, 200, 'the protocol probe trade creation answers 200');
    const headerOrderId = probeTrade.headers.get('x-dpay-order-id');
    assert(headerOrderId != null && /^trod-[0-9a-f]{16}$/.test(headerOrderId),
      `the trade response carries X-Dpay-Order-Id (a relay order id), saw ${headerOrderId}`);
    assert(headerOrderId !== orderId, 'each trade mints its OWN order id');
    const probeHits = await relayHits(r2.baseURL);
    const probeQuery = new URLSearchParams(probeHits.lastTradeQuery ?? '');
    assertEq(probeQuery.get('webhook'), webhookURL, 'the probe trade registered the webhook URL upstream too');
    assertEq(probeQuery.get('webhook_key'), headerOrderId,
      'the upstream webhook_key IS the X-Dpay-Order-Id value the device was given');
    const probeLines = await accessLines(logDir);
    const probeTradeLine = probeLines.filter((l) => l.kind === 'trade').pop();
    assertEq(probeTradeLine.order_id, headerOrderId, 'the access log correlates the probe trade to the same order id');
    assertEq((await relayHits(r2.baseURL)).statusCalls, statusCallsBeforePush,
      'the probe trade consumed no upstream status reads');

    // --- §6 THE ACCESS LOG CENSUS: one append-only file, every proxied call correlated
    const all = await accessLines(logDir);
    const kinds = new Set(all.map((l) => l.kind));
    for (const kind of ['rate', 'trade', 'status', 'webhook', 'webhook-unmatched']) {
      assert(kinds.has(kind), `the access log carries kind "${kind}"`);
    }
    for (const l of all) {
      assert(typeof l.ip === 'string' && l.ip.length > 0, `every line carries the client ip (${l.kind})`);
      assert(typeof l.user_agent === 'string' && l.user_agent.length > 0, `every line carries the user-agent (${l.kind})`);
      assert(typeof l.accept_language === 'string' && l.accept_language.length > 0, `every line carries accept-language (${l.kind})`);
      assert(typeof l.ts === 'string' && typeof l.ts_unix === 'number', `every line is timestamped (${l.kind})`);
    }
    assertEq(all[0].ip, '127.0.0.1', 'the client ip is the real connecting peer (no trust-proxy fabrication)');
    const webhookLines = all.filter((l) => l.kind === 'webhook');
    assertEq(webhookLines.length, 2, 'both deliveries logged as matched webhooks');
    for (const l of webhookLines) {
      assertEq(l.order_id, orderId, 'a matched webhook line correlates the order id');
      assertEq(l.trade_id, tradeId, 'a matched webhook line correlates the trade id');
    }
    const unmatched = all.filter((l) => l.kind === 'webhook-unmatched');
    assert(unmatched.some((l) => l.method === 'GET'), 'the creation-time GET probe is logged (unmatched, probe-shaped)');
    assert(unmatched.some((l) => l.method === 'POST' && /^[0-9a-f]{16}$/.test(l.key_hash ?? '')),
      'a bogus-key delivery is logged with only the hashed key');
    const statusLines = all.filter((l) => l.kind === 'status');
    assert(statusLines.length >= 3, `the status reads are logged (saw ${statusLines.length})`);
    assert(statusLines.every((l) => l.trade_id === tradeId), 'every status line correlates the trade id');
    assert(statusLines.some((l) => l.upstream_status != null), 'the pre-webhook fallback read logs its upstream status');
    assert(statusLines.some((l) => l.upstream_status == null), 'the cache-served reads log with NO upstream status (the zero-upstream signature)');
    await driver.screenshot('199-agreement-access-log-census');

    console.log(`GREEN 199 — the partner agreement around a real SOL→ICP Trocador convert: webhook=<origin>/api/v1/trocador/webhook + webhook_key=<order_id> rode the trade upstream (stub-observed) and the order id answered at X-Dpay-Order-Id; the webhook route answered the creation-time GET probe 200; both deliveries (Processing, then Completed with the venue's own figures) landed the app's convert view verbatim with the stub's status hit-count FROZEN (zero upstream status polls); and the access log correlated every proxied call (rate/trade/status/webhook/webhook-unmatched, ip+ua+accept-language, order/trade/client ids, cache reads carrying no upstream status)`);
  } finally {
    await env.stop();
    await r2.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error('FAIL 199:', e);
    process.exit(1);
  });
}
