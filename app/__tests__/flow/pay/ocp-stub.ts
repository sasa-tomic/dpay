/**
 * ocp-stub.ts — the OpenCryptoPay provider fixture for jest, ported from `e2e/harness/ocp.mjs`
 * (verbatim fixture data + the fetch-interceptor contract) and `e2e/harness/lnurl.mjs` (the QR).
 *
 * Fail-closed like the twin: everything not addressed to the fixture provider passes through to the
 * real (harness-rewritten) fetch; anything addressed to the provider that the fixture does not know
 * is recorded as unexpected and refused. State (calls / txUrls / unexpected / quote / txMode) is
 * readable and flippable in-process.
 */
import {readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {encodeLnurl} from './lnurl';

/** The live provider — configuration, not a constant (the findings doc). */
export const PROVIDER_HOST = 'api.dfx.swiss';
export const PROVIDER_ORIGIN = `https://${PROVIDER_HOST}`;
export const PAYMENT_ID = 'pl_beeddb41cd4b6d9e';
export const API_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/${PAYMENT_ID}`;
export const CALLBACK_URL = `${PROVIDER_ORIGIN}/v1/lnurlp/cb/${PAYMENT_ID}`;
/** The QR the checkout prints: an app.dfx.swiss URL with the LNURL in `lightning`, uppercase. */
export const CHECKOUT_QR = `https://app.dfx.swiss/pl/?lightning=${encodeLnurl(API_URL).toUpperCase()}`;
export const CLAIMED_MERCHANT = 'Kiosk am Bahnhof';
export const QUOTE_LIFETIME_MS = 300_000;

/** The checkout's menu — the live 2026-09-01 recordings. */
export const TRANSFER_AMOUNTS = [
  {
    method: 'InternetComputer', available: true,
    assets: [
      {asset: 'ckBTC', amount: '0.000016'},
      {asset: 'VCHF', amount: '1.'},
      {asset: 'ICP', amount: '0.50795551'},
      {asset: 'VEUR', amount: '1.06'},
    ],
  },
  {
    method: 'Solana', available: true,
    assets: [
      {asset: 'SOL', amount: '0.01219252'},
      {asset: 'USDC', amount: '1.246922'},
      {asset: 'USDT', amount: '1.246922'},
    ],
  },
  {method: 'Arkade', available: false, assets: [{asset: 'BTC', amount: '0.000016'}]},
];

/** What the DFX checkout is charging, in its own unit — a JSON NUMBER, as measured. */
export const REQUESTED_AMOUNT = {asset: 'CHF', amount: 1};

// --- dpay's own checkout (the checkout_wire.json golden, as ocp.mjs reads it) ---------------------

const CHECKOUT_WIRE = JSON.parse(
  readFileSync(join(dirname(__filename), '..', '..', '..', '..', 'dfx', 'checkout_wire.json'), 'utf8'),
) as {
  open: {id: string};
  input: {merchant_name: string; note: string};
  details: {transferAmounts: unknown; requestedAmount: unknown};
  amount_raw: string;
  callback: {uri: string};
  submit_pending: unknown;
};
const CHECKOUT_LEDGER = /^icp:([^/]+)\/transfer\?/.exec(CHECKOUT_WIRE.callback.uri);
if (CHECKOUT_LEDGER === null) throw new Error(`checkout_wire.json's callback URI is not an icp: transfer: ${CHECKOUT_WIRE.callback.uri}`);
const CHECKOUT_REF = /&ref=([0-9a-f]{32})$/.exec(CHECKOUT_WIRE.callback.uri);
if (CHECKOUT_REF === null) throw new Error(`checkout_wire.json's callback URI names no per-charge ref: ${CHECKOUT_WIRE.callback.uri}`);

/** dpay's own checkout: ONE method, ONE asset, the raw units its decimal amount means. */
export const DPAY_CHECKOUT = {
  merchant: CHECKOUT_WIRE.input.merchant_name,
  note: CHECKOUT_WIRE.input.note,
  paymentId: CHECKOUT_WIRE.open.id,
  transferAmounts: CHECKOUT_WIRE.details.transferAmounts,
  requestedAmount: CHECKOUT_WIRE.details.requestedAmount,
  method: (CHECKOUT_WIRE.details.transferAmounts as Array<{method: string; assets: Array<{asset: string; amount: string}>}>)[0].method,
  asset: (CHECKOUT_WIRE.details.transferAmounts as Array<{method: string; assets: Array<{asset: string; amount: string}>}>)[0].assets[0].asset,
  amount: (CHECKOUT_WIRE.details.transferAmounts as Array<{method: string; assets: Array<{asset: string; amount: string}>}>)[0].assets[0].amount,
  amountRaw: CHECKOUT_WIRE.amount_raw,
  ledger: CHECKOUT_LEDGER[1],
  ref: CHECKOUT_REF[1],
  pendingBody: CHECKOUT_WIRE.submit_pending,
};

/** Stub config + QR for dpay's own checkout, served from the host the wallet talks to. */
export function dpayCheckoutAt(relayBaseURL: string, destination: string): {host: string; qr: string; cfg: OcpCfg} {
  const host = new URL(relayBaseURL).host;
  const origin = `https://${host}`;
  const apiUrl = `${origin}/v1/lnurlp/${DPAY_CHECKOUT.paymentId}`;
  return {
    host,
    qr: apiUrl,
    cfg: {
      providerOrigin: origin,
      paymentId: DPAY_CHECKOUT.paymentId,
      callbackUrl: `${origin}/v1/lnurlp/cb/${DPAY_CHECKOUT.paymentId}`,
      merchantName: DPAY_CHECKOUT.merchant,
      note: DPAY_CHECKOUT.note,
      transferAmounts: DPAY_CHECKOUT.transferAmounts,
      requestedAmount: DPAY_CHECKOUT.requestedAmount,
      pendingBody: DPAY_CHECKOUT.pendingBody,
      uris: {
        [`${DPAY_CHECKOUT.method}/${DPAY_CHECKOUT.asset}`]:
          `icp:${DPAY_CHECKOUT.ledger}/transfer?to=${destination}&amount=${DPAY_CHECKOUT.amount}&ref=${DPAY_CHECKOUT.ref}`,
      },
    },
  };
}

export type OcpCfg = {
  providerOrigin: string;
  paymentId: string;
  callbackUrl: string;
  merchantName: string;
  transferAmounts: unknown;
  requestedAmount: unknown;
  pendingBody?: unknown;
  uris: Record<string, string>;
  note?: string;
  detailsDelayMs?: number;
  quoteLifetimeMs?: number;
};

export type OcpState = {
  calls: string[];
  txUrls: string[];
  unexpected: string[];
  quoteId: string | null;
  txMode: 'accept' | 'pending' | 'indefinite';
};

let state: OcpState | null = null;

/** Read the stub's recorded state (the ocpStubState twin — no driver needed in jest). */
export function ocpStubState(): OcpState {
  if (state === null) throw new Error('ocp stub not installed');
  return state;
}

/** Flip the submission behaviour between legs ('accept' | 'pending' | 'indefinite'). */
export function setOcpTxMode(mode: OcpState['txMode']): void {
  if (state === null) throw new Error('ocp stub not installed');
  state.txMode = mode;
}

let prevFetch: typeof fetch | null = null;

/** Install the provider stub over globalThis.fetch. Returns the uninstaller. */
export function installCheckoutStub(cfg: OcpCfg): () => void {
  if (prevFetch !== null) throw new Error('ocp stub already installed');
  prevFetch = globalThis.fetch;
  const real = prevFetch;
  state = {calls: [], txUrls: [], unexpected: [], quoteId: null, txMode: 'accept'};

  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
  const err = (status: number, message: string): Response =>
    json({statusCode: status, message, error: status === 404 ? 'Not Found' : 'Bad Request'}, status);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();
  let quoteSeq = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!state || !url.startsWith(`${cfg.providerOrigin}/`)) {
      return real(input, init); // relative + the harness relay's own traffic
    }
    state.calls.push(url);
    const u = new URL(url);

    // Step 4 — the ONE-SHOT proof submission. Counted, never retried by anyone.
    if (u.pathname === `/v1/lnurlp/tx/${cfg.paymentId}`) {
      state.txUrls.push(url);
      if (state.txMode === 'accept') return json({}, 200);
      if (state.txMode === 'pending' && cfg.pendingBody !== undefined) return json(cfg.pendingBody, 202);
      throw new DOMException('The user aborted a request.', 'AbortError');
    }

    // Step 3 — the destination for one {method, asset} of the LIVE quote.
    if (u.pathname === `/v1/lnurlp/cb/${cfg.paymentId}`) {
      const quote = u.searchParams.get('quote');
      if (state.quoteId === null || quote !== state.quoteId) {
        return err(404, `No actual quote with ID ${quote} found`);
      }
      const method = u.searchParams.get('method');
      const asset = u.searchParams.get('asset');
      const uri = cfg.uris[`${method}/${asset}`];
      if (!uri) return err(400, 'Invalid method or asset');
      return json({
        expiryDate: isoIn(cfg.quoteLifetimeMs ?? QUOTE_LIFETIME_MS),
        blockchain: method, // the echo — the only integrity signal the answer carries
        uri,
        hint: `Send the exact amount, then report the transaction to /v1/lnurlp/tx/${cfg.paymentId}`,
      }, 200);
    }

    // Step 2 — the payment link itself (optionally slow, so a flow can observe the waiting copy).
    if (u.pathname === `/v1/lnurlp/${cfg.paymentId}`) {
      if ((cfg.detailsDelayMs ?? 0) > 0) await sleep(cfg.detailsDelayMs ?? 0);
      quoteSeq += 1;
      state.quoteId = `q_e2e_${quoteSeq}`;
      return json({
        callback: cfg.callbackUrl,
        displayName: cfg.merchantName,
        displayQr: true,
        externalId: null,
        id: cfg.paymentId,
        maxSendable: 100000,
        metadata: '[["text/plain","OpenCryptoPay"]]',
        minSendable: 100000,
        mode: 'Single',
        ...(cfg.note ? {note: cfg.note} : {}),
        possibleStandards: ['OpenCryptoPay', 'FrankencoinPay', 'LightningBolt11'],
        quote: {id: state.quoteId, expiration: isoIn(cfg.quoteLifetimeMs ?? QUOTE_LIFETIME_MS)},
        recipient: {name: cfg.merchantName},
        requestedAmount: cfg.requestedAmount,
        route: cfg.paymentId,
        standard: 'OpenCryptoPay',
        tag: 'payRequest',
        transferAmounts: cfg.transferAmounts,
      }, 200);
    }

    state.unexpected.push(url);
    return err(404, 'Payment link not found');
  }) as typeof fetch;

  return () => {
    globalThis.fetch = prevFetch as typeof fetch;
    prevFetch = null;
    state = null;
  };
}
