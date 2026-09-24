/**
 * SOL payee-quoted requests net the fee in (founder rule 2026-09-12: "if price of something is
 * $1, the customer pays exactly $1 — the merchant pays the fees").
 *
 * The merchant's request screen is the ONE producer of a SOL payee-quoted wire: `makeRequest`
 * builds the solreq:v2 (and the payment LINK the QR actually renders derives from that request),
 * so the netting — native wire amt = typed price − SOL_FEE_LAMPORTS, the SOL twin of the checkout's
 * `amount_raw = price − fee` — must land exactly there. Every downstream signer/verifier is
 * byte-exact against the request, so the payer cannot change the amount at sign time — which is
 * also why this suite proves the payer half needs NO change: their displayed total (wire + fee)
 * IS the typed price under a netted wire.
 *
 * SPL tokens (USDC, EURC, …) stay VERBATIM — their fee is separate-asset SOL gas, physically
 * impossible to subtract from a token amount. That one documented exception is pinned here too:
 * no netting, and no invented token-fee line on the request screen.
 *
 * End-to-end: the netted request is signed by the REAL offline signer and byte-verifies against
 * the canonical rebuild (a hand-edited amount still fails) — proof that netting in the request
 * breaks nothing in the verify/broadcast chain downstream of it.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

// createSolPaymentRequest is the ONLINE step (genesis + blockhash read); its stub records the
// wire the screen tried to build — the seam under test — and answers a valid request built from
// THAT input, so the QR screen renders from the same facts the real flow would. Everything else
// in the seam (the signers above all) stays real: the end-to-end test signs with the actual
// signSolPayment through this same mocked module (the mock spreads requireActual).
jest.mock('../solana', () => {
  const actual = jest.requireActual<typeof import('../solana')>('../solana');
  return {
    ...actual,
    createSolPaymentRequest: jest.fn(),
    // The request button is RPC-gated; the netting is not a network question.
    isSolanaRpcAvailable: () => true,
  };
});

// Same no-op mocks as SolReceiveWatch.test.tsx: no native NFC surface, and a clean merchant
// store so the mount-reconciliation effect restores nobody's open request over the test's.
jest.mock('../services/native', () => ({
  DpaySolNfc: {
    addListener: () => ({remove: () => {}}),
    removeListeners: () => {},
    armCard: jest.fn(async () => {}),
    disarmCard: jest.fn(async () => {}),
    startSolReader: jest.fn(async () => {}),
    stopSolReader: jest.fn(async () => {}),
    confirmSolReceipt: jest.fn(async () => {}),
  },
}));
jest.mock('../services/solMerchantPersist', () => ({
  loadSolMerchantState: jest.fn(async () => null),
  saveSolMerchantState: jest.fn(async () => {}),
  clearSolMerchantState: jest.fn(async () => {}),
}));

import {SolReceiveMode} from '../components/SolReceiveMode';
import {QrCode} from '../components/QrCode';
import {netSolWireLamports, SOL_FEE_LAMPORTS} from '../solana/spl';
import {encodeSolReq, type SolReqInput, type SolReqV2} from '../solana/qr';
import {buildCanonicalSolMessage, verifySolPayment} from '../solana/tx';
import {deriveSolanaKeypair} from '../solana/identity';
import {USDC_MINT_ADDRESS} from '../solana/tokens';
import {createSolPaymentRequest, signSolPayment} from '../solana';
import {parsePayLink} from '../lib/deepLink';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {AssetId} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';

const createMock = jest.mocked(createSolPaymentRequest);

// --- fixtures (same constants as solana-seam.test.ts — a valid mainnet-shaped request) ---
const SEED_HEX = '4f66b8c0a9b6e1f2d3a4c5b6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const BLOCKHASH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN'; // valid base58 32-byte

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const IDENTITY = {secretHex: '9f'.repeat(32), publicHex: '11'.repeat(32), username: 'test'};

/** The input shape makeRequest hands createSolPaymentRequest (the ONLINE half stamps
 *  rid/net/bh/lvh/slot/iat/exp itself — the short input carries only the payee's own facts). */
type MakeInput = Parameters<typeof createSolPaymentRequest>[0];

/** The offline half of createSolPaymentRequest: stamp v/rid/net/bh/lvh/slot/iat/exp onto the
 *  wire the screen handed over. The QR screen only reads these fields (the freshness state
 *  machine is the seam suite's to test) — here the AMOUNT is the fact under test. */
function requestFromInput(input: MakeInput): {request: SolReqV2; uri: string} {
  const iat = Math.floor(Date.now() / 1000);
  const stamped: SolReqInput = {
    ...input,
    rid: 'ab'.repeat(16),
    net: 'mainnet-beta',
    bh: BLOCKHASH,
    lvh: 300_000_000,
    slot: 250_000_000,
    iat,
    exp: iat + 90,
  };
  return {request: {...stamped, v: 2}, uri: encodeSolReq(stamped)};
}

let tree: renderer.ReactTestRenderer | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  createMock.mockReset();
  createMock.mockImplementation(async (input: MakeInput) => requestFromInput(input));
});
afterEach(() => {
  if (tree) { const t = tree; tree = null; act(() => { t.unmount(); }); }
  jest.useRealTimers();
  jest.clearAllMocks();
});

function mount(over: {selectedToken?: string; selectedAssetId?: string} = {}) {
  act(() => {
    tree = renderer.create(
      <SolReceiveMode
        identity={IDENTITY}
        relayUrl="http://relay.test"
        nfcStatus="unsupported"
        solAddress={MERCHANT}
        subMode="request"
        onSubModeChange={jest.fn()}
        codeForm="dpay"
        onCodeFormChange={jest.fn()}
        checkoutAvailable={false}
        catalog={CATALOG}
        selectedToken={over.selectedToken ?? 'SOL'}
        assets={ASSETS}
        selectedAssetId={(over.selectedAssetId ?? 'solana:SOL') as AssetId}
        balances={{} as Record<AssetId, BalanceView>}
        onSelectAsset={jest.fn()}
        onSelectAssetProgrammatic={jest.fn()}
      />,
    );
  });
  return tree!;
}

/** Type a price into the request form and press Request (the whole payee-quoted wire build). */
async function typeAndRequest(typed: string) {
  const root = tree!.root;
  act(() => { root.findByProps({testID: 'sol-req-amount-input'}).props.onChangeText(typed); });
  await act(async () => { root.findByProps({testID: 'btn-sol-req-make'}).props.onPress(); });
}

/** Every visible string on the tree (the form-phase refusal has no testID — its words ARE the
 *  assertion: the refusal must name the fee). */
function flatten(x: unknown): string {
  return Array.isArray(x) ? x.map(flatten).join('') : typeof x === 'string' || typeof x === 'number' ? String(x) : '';
}
function allText(): string {
  return tree!.root.findAllByType(Text).map(t => flatten(t.props.children)).join('\n');
}

describe('netSolWireLamports — the netting math (price − SOL_FEE_LAMPORTS)', () => {
  test('nets the one-signature fee out of a payee-quoted native price', () => {
    expect(netSolWireLamports('1000000')).toBe('995000'); // 0.001 typed → 0.000995 on the wire
    expect(netSolWireLamports((SOL_FEE_LAMPORTS + 1n).toString())).toBe('1'); // the smallest honest request
  });

  test('refuses (null) a price at or under the fee — nothing honest is left to request', () => {
    expect(netSolWireLamports(SOL_FEE_LAMPORTS.toString())).toBeNull();
    expect(netSolWireLamports('4999')).toBeNull();
    expect(netSolWireLamports('0')).toBeNull();
  });
});

describe('SolReceiveMode — native-SOL requests net the fee in (founder rule 2026-09-12)', () => {
  test('the wire and the LINK carry price − fee; the headline stays the typed price; the fee line says both numbers', async () => {
    mount();
    await typeAndRequest('0.001');
    // THE WIRE: 0.001 SOL typed (1_000_000 lamports) minus the 5_000-lamport fee.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({to: MERCHANT, amt: '995000', cur: 'SOL', mint: null, toAta: null});
    // THE HEADLINE: the typed price — re-derived as wire + fee, never the netted wire itself.
    expect(tree!.root.findByProps({testID: 'sol-req-price'}).props.children).toBe('0.001 SOL');
    // THE HONEST LINE: the payee sees the fee and what actually lands, both from the request.
    expect(tree!.root.findByProps({testID: 'sol-req-fee-line'}).props.children).toBe('Fee 0.000005 SOL · you receive 0.000995 SOL');
    // THE LINK (what the QR encodes, what any phone camera opens): the same netted number — the
    // payer's total display (wire + fee) becomes exactly the typed price, unchanged.
    const parsed = parsePayLink(tree!.root.findAllByType(QrCode)[0].props.value);
    expect(parsed != null && parsed.ok).toBe(true);
    const link = parsed != null && parsed.ok ? parsed.link : null;
    expect(link).toMatchObject({recipient: MERCHANT, amount: '0.000995', asset: 'SOL', network: 'solana'});
  });

  test('a typed price at or under the fee is refused before any wire is built', async () => {
    mount();
    await typeAndRequest('0.000005'); // exactly the fee — nothing nets
    expect(createMock).not.toHaveBeenCalled();
    expect(tree!.root.findAllByProps({testID: 'sol-req-qr'})).toHaveLength(0); // still on the form
    expect(allText()).toContain('0.000005 SOL'); // the refusal names the fee
    await typeAndRequest('0.000004'); // under the fee — same refusal
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('SolReceiveMode — SPL requests stay VERBATIM (the fee is separate-asset gas)', () => {
  test('USDC: the wire carries the typed token amount unchanged, and no fee line is invented', async () => {
    mount({selectedToken: 'USDC', selectedAssetId: 'solana:USDC'});
    await typeAndRequest('2');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({amt: '2000000', cur: 'USDC', mint: USDC_MINT_ADDRESS});
    expect(tree!.root.findByProps({testID: 'sol-req-price'}).props.children).toBe('2 USDC');
    expect(tree!.root.findAllByProps({testID: 'sol-req-fee-line'})).toHaveLength(0);
    const parsed = parsePayLink(tree!.root.findAllByType(QrCode)[0].props.value);
    const link = parsed != null && parsed.ok ? parsed.link : null;
    expect(link).toMatchObject({amount: '2', asset: 'USDC', network: 'solana'});
  });
});

describe('the netted request through the REAL byte-exact chain', () => {
  test('a payer signing the netted request verifies against it; a hand-edited amount still fails', () => {
    // What makeRequest builds for a typed 0.001 SOL price:
    const wireAmt = netSolWireLamports('1000000');
    expect(wireAmt).toBe('995000');
    const {request} = requestFromInput({to: MERCHANT, amt: wireAmt!, cur: 'SOL', mint: null, toAta: null, name: 'Test', memo: ''});
    // signSolPayment is the REAL offline signer (the component mock spreads requireActual).
    const pay = signSolPayment(SEED_HEX, request);
    const {publicKey} = deriveSolanaKeypair(SEED_HEX);
    expect(verifySolPayment(buildCanonicalSolMessage(publicKey, request), pay).ok).toBe(true);
    // Hand-editing the wire back to the gross price does NOT verify: the memo (sha256 of the
    // request URI) and the transfer instruction both commit to the netted amount. This is why
    // the netting lives in the request the PAYEE builds — nowhere downstream can change it.
    const tampered: SolReqV2 = {...request, amt: '1000000'};
    expect(verifySolPayment(buildCanonicalSolMessage(publicKey, tampered), pay).ok).toBe(false);
  });
});
