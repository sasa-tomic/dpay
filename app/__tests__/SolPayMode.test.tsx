/**
 * SolPayMode — the offline-signed SOL payment's share affordance (U-F1, 2026-08-16 UX finding)
 * and the auto-sign one-press rule (founder directive 2026-08-24).
 *
 * "Share signed code" fires Share.share with no in-DOM confirmation. The fix mirrors the
 * DepositSheet useCopyFeedback pattern: after the share resolves with sharedAction the label
 * flips to 'Copied ✓' for the 1500ms dwell; a dismissal leaves the label honest. The SOL rail's
 * ≤90s request window is untouched (blockhash physics — this test builds a fresh request like
 * the real flow does).
 *
 * The codec + offline signer are REAL (pure modules, no RPC): the test encodes a now-relative
 * solreq:v2 request and drives it through the same scan → AUTO-SIGN → qr path the camera flow
 * takes (the "Pay Now" gate press is the single deliberate press — no Approve button exists).
 * The read-only sign surface only survives a scan when the sign FAILS; the U-F5 payee-line tests
 * pin it there via a throwing signer mock (the honest terminal: reason + Cancel).
 * QrScanner is stubbed so its onScan prop can be driven directly.
 */
import {describe, test, expect, jest, beforeEach, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Share, Platform, Text} from 'react-native';

// Scanner mount counter — the per-request-mint refusal must REMOUNT the camera (scanKey++), the
// same dead-camera fix as every other scan refusal. `mock` prefix = jest.mock hoisting rule.
const mockScannerMounts = {n: 0};
jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => {
    const {useEffect} = jest.requireActual('react') as {useEffect: (fn: () => void, deps: unknown[]) => void};
    useEffect(() => { mockScannerMounts.n += 1; }, []);
    return null;
  },
}));
jest.mock('../components/SolNfcTap', () => ({
  SolNfcTap: (_props: {role: string}) => null,
}));
jest.mock('../services/native', () => ({
  DpaySolNfc: {},
}));
// The send-to-address body has its own suite (SolanaWithdrawSheet.test.tsx); stubbed here so this
// suite stays a pure SolPayMode test while the prefill prop it is handed stays assertable.
jest.mock('../components/SolanaWithdrawSheet', () => ({
  SolanaWithdrawSheet: (_props: {prefill?: {address: string; amount: string} | null}) => null,
}));
// The signer is real by default (the U-F1 tests sign genuinely); the U-F5 suite swaps in a
// throwing implementation to park the read-only sign surface with its honest error terminal.
jest.mock('../solana', () => {
  const actual = jest.requireActual<typeof import('../solana')>('../solana');
  return {
    ...actual,
    signSolPayment: jest.fn(actual.signSolPayment),
    signSplPayment: jest.fn(actual.signSplPayment),
    // No test may reach a Solana RPC; the OpenCryptoPay + Solana Pay suites drive these directly.
    sendSol: jest.fn(),
    sendSolanaPay: jest.fn(),
    getSolSignatureStatus: jest.fn(),
  };
});
// The provider sequence is tested for real (recorded bodies, no network) in
// opencryptopayClient.test.ts. Stubbed here so this stays a component test of the WIRING.
// `ocpTimeRefusal` is NOT stubbed: it is the module's ONE approve deadline, shared by the resolver,
// the countdown and both rails, and a hand-written copy of it here would be a second rule that can
// drift from the one under test.
jest.mock('../services/opencryptopay', () => ({
  ocpTimeRefusal: jest.requireActual<typeof import('../services/opencryptopay')>('../services/opencryptopay').ocpTimeRefusal,
  resolveOcpScan: jest.fn(),
  resolveOcpOffer: jest.fn(),
  payAndReport: jest.fn(),
}));

import {encodeSolReq, type SolReqInput} from '../solana/qr';
import {getSolSignatureStatus, sendSol, sendSolanaPay, signSolPayment, signSplPayment, type SolanaSignatureStatus} from '../solana';
import {payAndReport, resolveOcpOffer, resolveOcpScan, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
// Spied (not mocked) in the till-note test, as in the IC twin (PayMode.test.tsx): only the SEAM's
// arguments matter here; the store's own behaviour is txNotes.test.ts's to pin.
import * as txNotes from '../services/txNotes';
import {buildSelectableAssets} from '../config/assets';
import {USDC_MINT_ADDRESS, EURC_MINT_ADDRESS} from '../solana/tokens';
import {POLL, SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {SolPayMode} from '../components/SolPayMode';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const IDENTITY: Identity = {secretHex: '33'.repeat(32), publicHex: '44'.repeat(32), username: 'Payer'};
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const BLOCKHASH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';

const shareSpy = jest.spyOn(Share, 'share');

function solReqUri(name: string = 'Cafe Sol', memo: string = ''): string {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const input: SolReqInput = {
    rid: '0123456789abcdef0123456789abcdef',
    net: 'mainnet-beta',
    bh: BLOCKHASH,
    lvh: 300_000_000,
    slot: 290_000_000,
    iat,
    exp: iat + 90, // the v2 protocol maximum — fresh for another ~60s
    to: MERCHANT,
    amt: '2000000', // 0.002 SOL
    cur: 'SOL',
    mint: null,
    toAta: null,
    name,
    memo,
  };
  return encodeSolReq(input);
}

type SolPayModeProps = Parameters<typeof SolPayMode>[0];

/** The element under test with every required prop defaulted — ONE prop list for mounts and for
 *  the re-render (`tree.update`) cases, so a new required prop is added in one place. */
function solPayElement(props: Partial<SolPayModeProps> = {}) {
  return (
    <SolPayMode
      identity={IDENTITY}
      online={true}
      nfcStatus="off"
      assets={[]}
      catalog={[]}
      homeCurrency={null}
      balances={{}}
      solBalance="5000000000"
      tokenBalance="0"
      tokenAtaAbsent={false}
      tokenBalances={{}}
      payGate="none"
      selectedToken="SOL"
      onSent={() => {}}
      onSentToken={() => {}}
      onShowSolAddress={() => {}}
      onShowTokenAddress={() => {}}
      onRecheckBalances={() => {}}
      subMode="scan"
      onSubModeChange={() => {}}
      onScannedLink={() => {}}
      {...props}
    />
  );
}

function mountSolPay(props: Partial<SolPayModeProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(solPayElement(props));
  });
  return tree;
}

/** Drive the camera-scan path with the pay-intent gate armed — the AUTO-SIGN entry (the "Pay
 *  Now" gate press that armed the scanner IS the single deliberate press; the sync offline sign
 *  lands in the qr phase before this helper returns). */
async function scanToSign(tree: renderer.ReactTestRenderer, uri: string) {
  pressByTestID(tree, 'btn-sol-start-scan');
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan(uri);
  });
}

/** Mounted camera rail — the QrScanner stub carries onScan; presence = armed camera. */
function scannerNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && typeof node.props.onScan === 'function');
}

/** Mounted HCE rail — the SolNfcTap stub carries role="card"; presence = armed card. */
function cardNodes(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(node => node.props && node.props.role === 'card');
}
/** Depth-first text of a props.children tree — strings, numbers, arrays, nested elements. */
function textOf(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  const el = children as {props?: {children?: unknown}};
  return el.props ? textOf(el.props.children) : '';
}

/** All visible text of Text nodes — the assertion target for label flips. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => textOf(n.props.children));
}

function hasTestID(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function textByTestID(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.findAll(n => n.props && n.props.testID === testID)[0];
  return node ? textOf(node.props.children) : '';
}

function pressByTestID(tree: renderer.ReactTestRenderer, testID: string) {
  const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
  if (!node) throw new Error(`no node with testID=${testID}`);
  act(() => {
    node.props.onPress();
  });
}

async function pressByLabel(tree: renderer.ReactTestRenderer, label: string) {
  const node = tree.root.findAll(node => node.props && node.props.accessibilityLabel === label)[0];
  if (!node) throw new Error(`no node with accessibilityLabel=${label}`);
  await act(async () => {
    node.props.onPress();
  });
}

beforeEach(() => {
  // Fake timers keep jest's loop clean; Date stays real — the v2 request's iat/exp math (and the
  // decoder's freshness check) reads Date.now().
  jest.useFakeTimers({doNotFake: ['Date']});
  mockScannerMounts.n = 0;
  shareSpy.mockReset().mockResolvedValue({action: 'sharedAction' as const});
  // The signer mock defaults to the REAL implementation each test (the U-F5 suite swaps in a
  // throwing one to park the sign surface — without this reset it leaks into later suites).
  jest.mocked(signSolPayment).mockReset().mockImplementation(jest.requireActual<typeof import('../solana')>('../solana').signSolPayment);
});

afterEach(() => {
  jest.useRealTimers(); // the share dwell timer would keep the worker alive
  (Platform as {OS: string}).OS = 'ios'; // restore the jest-preset default (webLabel() tests mutate it)
});

// The jest preset pins Platform.OS to 'ios' (native). shareConfirmLabel: web says what the
// fallback DID ('Copied ✓' — the no-Web-Share path copies), native says 'Shared ✓' (the real
// Share sheet was the feedback, nothing was copied). The flip test runs as WEB; native has its own.
function asWeb() {
  (Platform as {OS: string}).OS = 'web';
}

describe('SolPayMode — share signed code feedback (U-F1)', () => {
  test('(web) "Share signed code" flips to "Copied ✓" after the share resolves', async () => {
    asWeb();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri()); // pure offline auto-sign → the qr phase
    expect(texts(tree)).toContain('Share signed code');
    await pressByLabel(tree, 'Share signed payment');
    expect(shareSpy).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining('solpay:v2?')}));
    expect(texts(tree)).toContain('Copied ✓');
    expect(texts(tree)).not.toContain('Share signed code');
    act(() => {
      tree.unmount();
    });
  });

  test('native: a completed Share sheet flips to "Shared ✓" — never "Copied ✓" (nothing was copied)', async () => {
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    await pressByLabel(tree, 'Share signed payment');
    expect(texts(tree)).toContain('Shared ✓');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });

  test('a dismissed share sheet leaves the label honest (dismissedAction does not flip)', async () => {
    shareSpy.mockResolvedValue({action: 'dismissedAction' as const});
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    await pressByLabel(tree, 'Share signed payment');
    expect(texts(tree)).toContain('Share signed code');
    expect(texts(tree)).not.toContain('Copied ✓');
    act(() => {
      tree.unmount();
    });
  });
});

describe('SolPayMode — sign status shows the short destination under a merchant name (U-F5)', () => {
  function textByTestID(tree: renderer.ReactTestRenderer, testID: string): string {
    const node = tree.root.findAll(node => node.props && node.props.testID === testID)[0];
    if (!node) throw new Error(`no node with testID=${testID}`);
    return textOf(node.props.children);
  }

  // The sync offline sign succeeds instantly, so the read-only sign surface only SURVIVES a
  // failing sign — pin it there (the honest terminal keeps the payee lines + reason + Cancel).
  function throwOnSign() {
    jest.mocked(signSolPayment).mockImplementation(() => {
      throw new Error('sign failed');
    });
  }

  test('named merchant: the dim sol-pay-payee line carries the short base58 address', async () => {
    throwOnSign();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri('Cafe Sol'));
    expect(texts(tree)).toContain('to Cafe Sol');
    // short() = first 8 chars + '…' — MERCHANT starts 'Ecs89dz8'
    expect(textByTestID(tree, 'sol-pay-payee')).toBe('Ecs89dz8…');
    expect(texts(tree)).toContain('sign failed'); // honest sign-error terminal, no silent success
    expect(texts(tree)).not.toContain('Approve'); // one-press rule: no sign button exists
    act(() => {
      tree.unmount();
    });
  });

  test('unnamed merchant: the primary line carries the FULL address, no duplicate short line', async () => {
    throwOnSign();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri(''));
    expect(texts(tree)).toContain(`to ${MERCHANT}`);
    const payee = tree.root.findAll(node => node.props && node.props.testID === 'sol-pay-payee');
    expect(payee).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  // The scanned solreq is a STRANGER's string: a printed QR, or a phone that tapped this one. The
  // 32-character cap bounds its length, but length was never the weapon — React Native `Text`
  // renders newlines, so a name of blank lines pushes the destination address (the ONLY checkable
  // thing on this screen) out of view, and the payer approves a payment whose payee they cannot
  // see. Same helper as the IC wire request, a payment link's label/memo and a till's merchant
  // name: one rule for display text, wherever it came from.
  test('a name and memo of blank lines are neutralised — the destination stays on screen', async () => {
    throwOnSign();
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri('Cafe\n\n\n\n\n\n\n\n\n\nSol', 'note​\r\n\r\nhere'));

    // Collapsed to single spaces, not deleted: the words the merchant wrote still read as words.
    expect(texts(tree)).toContain('to Cafe Sol');
    expect(textByTestID(tree, 'sol-pay-memo')).toBe('note here');
    // Nothing rendered still carries a line break to push the address off the screen.
    for (const t of texts(tree)) expect(t).not.toContain('\n');
    expect(textByTestID(tree, 'sol-pay-payee')).toBe('Ecs89dz8…');
    act(() => {
      tree.unmount();
    });
  });

  test('the sanitising is DISPLAY only — the signed request keeps the bytes the merchant verifies', async () => {
    // The payer's signature commits to sha256(encodeSolReq(req)) and the merchant re-derives that
    // exact URI to verify the payment (`verifySolPayment`). A sanitised name inside the SIGNED
    // request is a payment the merchant's own verifier rejects — so the codec's canonical bytes
    // must reach the signer untouched, and only the rendered locals may differ.
    throwOnSign();
    const hostileName = 'Cafe\n\n\n\n\n\n\n\n\n\nSol';
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri(hostileName, 'note​\r\n\r\nhere'));

    const [, signedReq] = jest.mocked(signSolPayment).mock.calls[0];
    expect(signedReq.name).toBe(hostileName);
    expect(signedReq.memo).toBe('note​\r\n\r\nhere');
    act(() => {
      tree.unmount();
    });
  });
});

// Pay-intent scan gate (founder rule 2026-08-23, same as IC PayMode): the camera (QrScanner)
// and the HCE card (SolNfcTap) mount ONLY after "Pay Now". The sol-pay-scan container
// + hint stay in IDLE; reset() and leaving the scan sub-mode disarm.
describe('SolPayMode — pay-intent scan gate', () => {
  test('idle: NEITHER rail mounts; sol-pay-scan + CTA render; one tap arms BOTH rails', () => {
    const tree = mountSolPay({nfcStatus: 'ready'});
    expect(hasTestID(tree, 'sol-pay-scan')).toBe(true); // idle keeps the container + hint
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0); // camera rail off
    expect(cardNodes(tree)).toHaveLength(0); // HCE rail off (radio ready, but the scan gate has not been tapped)
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    expect(cardNodes(tree)).toHaveLength(1);
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(false);
    act(() => {
      tree.unmount();
    });
  });

  test("reset() (the qr-phase Cancel) disarms — the next attempt needs a fresh intent", async () => {
    const tree = mountSolPay();
    await scanToSign(tree, solReqUri());
    expect(hasTestID(tree, 'btn-sol-pay-discard')).toBe(true); // the qr-phase Cancel
    pressByTestID(tree, 'btn-sol-pay-discard');
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true); // idle CTA back
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  test('leaving the scan sub-mode disarms; flipping back shows the idle CTA again', () => {
    const tree = mountSolPay();
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).toHaveLength(1);
    act(() => {
      tree.update(solPayElement({subMode: 'send'}));
    });
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.update(solPayElement({subMode: 'scan'}));
    });
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    expect(scannerNodes(tree)).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });
});

// The camera's second opinion, SOL side (defects found 2026-08-30). Identical routing to the IC
// rail's PayMode — same three verdicts in the same order — because the same-surfaces hard rule
// says a scanned link and a scanned address must behave the same whichever rail is active.
// Classification is pinned in scan.test.ts; these pin the ROUTING.
describe('SolPayMode — what the camera does with a code that is not a payment request', () => {
  const IC_ACCOUNT = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
  const PAY_LINK = `https://dpay.kalaj.org/wallet/pay/${MERCHANT}?asset=SOL&network=solana&amount=0.5`;

  async function scanUnreadable(tree: renderer.ReactTestRenderer, raw: string) {
    pressByTestID(tree, 'btn-sol-start-scan');
    const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
    await act(async () => {
      scanner.props.onScan(raw);
    });
  }

  test('a scanned payment LINK is handed to the Wallet link pipeline VERBATIM', async () => {
    const scanned: string[] = [];
    const tree = mountSolPay({onScannedLink: (u: string) => scanned.push(u)});
    await scanUnreadable(tree, ` ${PAY_LINK} `);
    expect(scanned).toEqual([PAY_LINK]);
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    act(() => { tree.unmount(); });
  });

  test('a scanned Solana ADDRESS switches to Send to address with the destination prefilled', async () => {
    const modes: string[] = [];
    const tree = mountSolPay({onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, MERCHANT);
    expect(modes).toEqual(['send']);
    act(() => { tree.update(solPayElement({subMode: 'send'})); });
    const sheet = tree.root.find(node => node.props && 'prefill' in node.props);
    expect(sheet.props.prefill).toEqual({address: MERCHANT, amount: ''});
    act(() => { tree.unmount(); });
  });

  test('a WRONG-CHAIN address still opens the send form — the one place that can name the chain', async () => {
    // An IC principal scanned on the SOL rail is a real user mistake. Refusing it here would give a
    // generic message; the send form's status line says what the address IS and what to do instead.
    const modes: string[] = [];
    const tree = mountSolPay({onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, IC_ACCOUNT);
    expect(modes).toEqual(['send']);
    act(() => { tree.unmount(); });
  });

  test('a scanned ethereum: request is refused BY NAME and stays on scan', async () => {
    const modes: string[] = [];
    const scanned: string[] = [];
    const tree = mountSolPay({onScannedLink: (u: string) => scanned.push(u), onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, 'ethereum:0x2D39863d5A1E1B1e8b7b0b8c7c9d0e1f2a3b4c5d?value=1e17');
    expect(texts(tree)).toContain(M.pay.scannedCoinRequest('Ethereum', 'ethereum:'));
    expect(texts(tree)).not.toContain(M.pay.notAPaymentCode);
    expect(scanned).toEqual([]);
    expect(modes).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('a payload NOTHING recognises keeps the honest "not a payment code" refusal', async () => {
    const modes: string[] = [];
    const tree = mountSolPay({onSubModeChange: (m: string) => modes.push(m)});
    await scanUnreadable(tree, 'solreq:v2:not-actually-a-request');
    expect(texts(tree)).toContain(M.pay.notAPaymentCode);
    expect(modes).toEqual([]);
    act(() => { tree.unmount(); });
  });

  test('offline, Send to address states the constraint and offers the rail that DOES work offline', () => {
    // This rail broadcasts to a Solana RPC from THIS phone, so airplane mode blocks an address send
    // outright — while scan-to-pay keeps working (the payer signs against the merchant's blockhash).
    const modes: string[] = [];
    const tree = mountSolPay({online: false, subMode: 'send', onSubModeChange: (m: string) => modes.push(m)});
    expect(hasTestID(tree, 'sol-send-offline')).toBe(true);
    expect(tree.root.findAll(node => node.props && 'prefill' in node.props)).toHaveLength(0);
    expect(texts(tree)).toContain(M.pay.offlineSendBody('SOL'));
    pressByTestID(tree, 'sol-send-offline-go');
    expect(modes).toEqual(['scan']);
    act(() => { tree.unmount(); });
  });

  test('online, Send to address renders the form — the gate is connectivity, nothing else', () => {
    const tree = mountSolPay({online: true, subMode: 'send'});
    expect(hasTestID(tree, 'sol-send-offline')).toBe(false);
    expect(tree.root.findAll(node => node.props && 'prefill' in node.props)).toHaveLength(1);
    act(() => { tree.unmount(); });
  });
});

// ---------------------------------------------------------------------------------------------
// OpenCryptoPay — the same till code, scanned while SOL is the selected asset
// ---------------------------------------------------------------------------------------------
// Same camera, same gesture, same review shape as the IC rail (CLAUDE.md's same-surfaces rule);
// only the settlement differs — a native SOL transfer instead of a signed ICRC envelope. The rules
// that make it safe are identical and are what these tests pin: never auto-signed, and a transfer
// whose outcome is unknown is never reported to the provider.

const TILL_QR = 'LNURL1DP68GURN8GHJ7CTSDYHXGENC9EEHW6TNWVHHVVF0D3H82UNVWQHHQMZLVFJK2ERYVG6RZCMYX33RVEPEV5YEJ9WT';
const OCP_TARGET: OcpTarget = {
  details: {
    submitUrl: 'https://api.dfx.swiss/v1/lnurlp/tx/pl_beeddb41cd4b6d9e',
    // Equal to the scanned host by construction — see the IC twin in PayMode.test.tsx.
    proofHost: 'api.dfx.swiss',
    quoteId: 'plq_ec214dddae51da4d',
    quoteExpiresAt: Date.now() + 300_000,
    callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
    claimedMerchantName: 'Test Shop',
    // The dpay till's own note — the same fixture contract as the IC twin in PayMode.test.tsx.
    claimedNote: '2× Kafi, Tisch 4',
    requestedAmount: {asset: 'CHF', amount: '1'},
    transferAmounts: [{method: 'Solana', available: true, assets: [{asset: 'SOL', amount: '0.01221422'}]}],
  },
  host: 'api.dfx.swiss',
  method: 'Solana',
  asset: 'SOL',
  assetId: 'solana:SOL',
  // Always null on this rail: a `solana:` URI names no ledger, and nothing on Solana is reported by
  // block index (`destinationOf`, services/opencryptopay.ts).
  ledger: null,
  to: MERCHANT,
  rawAmount: '12214220',
  // Always null on this rail: a `solana:` URI has no reference field, and this integration signs
  // no SPL memo instruction (`destinationOf`, services/opencryptopay.ts).
  reference: null,
  expiresAt: Date.now() + 300_000,
  // A live price with room to spare. The gap to `expiresAt` is what the countdown shows and what
  // Approve is gated on — the same deadline the IC rail uses, from the same helper.
  payableUntil: Date.now() + 180_000,
};

/** The wallet's REAL Solana rows — the selection the till payment is made WITH. */
const SOL_ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaTokens: true,
});

function mountTill(props: Partial<SolPayModeProps> = {}) {
  return mountSolPay({assets: SOL_ASSETS, ...props});
}

async function scanTill(tree: renderer.ReactTestRenderer, code = TILL_QR) {
  pressByTestID(tree, 'btn-sol-start-scan');
  const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
  await act(async () => {
    scanner.props.onScan(code);
  });
  await act(async () => {});
}

describe('SolPayMode — OpenCryptoPay till', () => {
  beforeEach(() => {
    jest.mocked(resolveOcpScan).mockReset().mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    jest.mocked(payAndReport).mockReset().mockResolvedValue({kind: 'paid'});
    jest.mocked(resolveOcpOffer).mockReset();
    jest.mocked(sendSol).mockReset().mockResolvedValue('5ig'.repeat(10));
  });

  test('offers the till’s own menu on this rail too, and pays what was picked', async () => {
    // RAIL PARITY, not a nice-to-have: CLAUDE.md makes a per-rail divergence on a money surface a
    // bug, and the IC rail answers a not-taken asset with the till's menu (flow 111). The same
    // component renders it here, so the payer meets one surface whichever asset they had selected.
    const offer = {method: 'Solana', asset: 'SOL', amount: '0.01221422', assetId: 'solana:SOL' as const, rawAmount: '12214220'};
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'choose', details: OCP_TARGET.details, host: 'api.dfx.swiss', options: [offer],
    });
    jest.mocked(resolveOcpOffer).mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    // USDC selected: the one asset this rail carries that a till may decline. Funded, so the Pay
    // tab reaches the scan surface rather than the fund-first panel.
    const tree = mountTill({selectedToken: 'USDC', tokenBalance: '5000000', tokenBalances: {[USDC_MINT_ADDRESS]: {amount: '5000000', status: 'balance'}}});
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-choose')).toBe(M.pay.ocp.chooseAsset('USDC'));
    // The amount is stated in the asset's OWN units — picking blind is not consent.
    expect(textByTestID(tree, 'ocp-option-solana:SOL')).toContain('0.01221422');
    expect(hasTestID(tree, 'btn-approve')).toBe(false);

    await act(async () => { pressByTestID(tree, 'ocp-option-solana:SOL'); });
    await act(async () => {});
    // The pick resolves THAT offer and lands on the normal review — still explicit, still no
    // auto-sign. The deadline is re-asked with a fresh clock, because the menu costs real seconds.
    expect(jest.mocked(resolveOcpOffer)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(resolveOcpOffer).mock.calls[0][1]).toBe(OCP_TARGET.details);
    expect(jest.mocked(resolveOcpOffer).mock.calls[0][2]).toBe(offer);
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
    expect(jest.mocked(payAndReport)).not.toHaveBeenCalled();
  });

  test('refuses to approve a till the wallet cannot cover, instead of signing a doomed transfer', async () => {
    // The IC rail has gated a till payment on the selected asset's balance since it shipped; this
    // rail did not (review row 12), which is a divergence on a money surface — CLAUDE.md's
    // same-surfaces rule makes that a bug, not an exception. An OCP payer is ONLINE by construction
    // (two provider reads got them here), so the balance is fresh and the gate BLOCKS rather than
    // warns — unlike the offline dpay-request path, where a stale local balance only earns a warning.
    // The fee is included: a transfer of exactly the balance cannot pay for itself.
    const tree = mountTill({solBalance: '12214220'}); // the amount exactly — short by the fee
    await scanTill(tree);

    expect(textByTestID(tree, 'sol-pay-lowbal')).toBe(M.pay.notEnoughBalance);
    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(true);
    pressByTestID(tree, 'btn-approve');
    await act(async () => {});
    expect(jest.mocked(payAndReport)).not.toHaveBeenCalled();
  });

  test('approves a till the wallet can cover, with no low-balance warning', async () => {
    // The positive half: one lamport past amount+fee is enough, and nothing about the gate shows.
    const tree = mountTill({solBalance: String(12214220 + 5000)});
    await scanTill(tree);

    expect(hasTestID(tree, 'sol-pay-lowbal')).toBe(false);
    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(false);
  });

  test('a scanned till lands on a review with the amount, the full address and the host — nothing is sent', async () => {
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'sol-pay-amount')).toContain('0.01221422');
    expect(textByTestID(tree, 'sol-pay-payee')).toBe(MERCHANT);
    expect(textByTestID(tree, 'ocp-price')).toContain('api.dfx.swiss');
    expect(hasTestID(tree, 'review-claimed')).toBe(false);
    // The one-press rule does NOT reach a till: every value here came from a stranger's server.
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
    expect(sendSol).not.toHaveBeenCalled();
    expect(payAndReport).not.toHaveBeenCalled();
  });

  test('Approve runs the one-shot sequence for the Solana method and shows Paid on acceptance', async () => {
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(payAndReport).toHaveBeenCalledTimes(1);
    const [details, method, asset] = jest.mocked(payAndReport).mock.calls[0];
    expect(details).toBe(OCP_TARGET.details);
    expect(method).toBe('Solana');
    expect(asset).toBe('SOL');
    expect(texts(tree).join(' ')).toContain(M.nfc.paidAmount('0.012214220 SOL'));
  });

  test('the till’s claimed note rides the review’s memo line and the SOL seam’s annotation', async () => {
    // RAIL PARITY with the IC twin (PayMode.test.tsx): the note shows on the review's memo line
    // and reaches the payer's history row as `msg` beside the claimed name — keyed by the
    // signature here (this rail signs no memo to key by), by the on-chain memo there.
    const tree = mountTill();
    await scanTill(tree);
    expect(textByTestID(tree, 'sol-pay-memo')).toBe('2× Kafi, Tisch 4');

    // The seam lives in the rail-side send, which only runs when the captured sender is invoked.
    const noteSpy = jest.spyOn(txNotes, 'saveTxNote');
    await pressByLabel(tree, M.pay.approveA11y);
    await (jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>)();
    const saved = noteSpy.mock.calls.map(([, n]) => n).find(n => n.msg === '2× Kafi, Tisch 4');
    expect(saved?.k).toBe('5ig'.repeat(10)); // sendSol's mocked signature — the join key
    expect(saved?.who).toBe('Test Shop');
    noteSpy.mockRestore();

    // Absence renders nothing — the same null contract as every other claimed field.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, details: {...OCP_TARGET.details, claimedNote: null}},
    });
    const bare = mountTill();
    await scanTill(bare);
    expect(hasTestID(bare, 'sol-pay-memo')).toBe(false);
  });

  test('an outcome that is neither paid nor failed renders as neither, carrying the transaction', async () => {
    const message = M.pay.ocp.submitUnknown(M.pay.ocp.ref.solTransaction('5ig'.repeat(10)));
    jest.mocked(payAndReport).mockResolvedValue({kind: 'unresolved', message});
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);

    expect(textByTestID(tree, 'ocp-outcome')).toBe(message);
    expect(texts(tree).join(' ')).not.toContain(M.nfc.paidAmount('0.012214220 SOL'));
  });

  test('the Solana rail reports a CONFIRMED signature, and a broadcast it cannot confirm as unknown', async () => {
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    const send = jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Confirmed: the signature is what the provider verifies against the chain.
    await expect(send()).resolves.toEqual({
      kind: 'settled',
      txId: '5ig'.repeat(10),
      reference: M.pay.ocp.ref.solTransaction('5ig'.repeat(10)),
    });
    const [, destination, lamports] = jest.mocked(sendSol).mock.calls[0];
    expect(destination).toBe(MERCHANT);
    expect(lamports).toBe(12214220n);

    // Nothing was broadcast — a dead RPC or a rejected transaction. Definitive: nothing moved.
    jest.mocked(sendSol).mockRejectedValue(new Error('found no record of a prior credit'));
    await expect(send()).resolves.toEqual({kind: 'refused', message: M.sol.noRecordOfCredit});

    // Broadcast ACCEPTED, then the confirmation failed: the transfer may still land, so the outcome
    // is unknown and the provider must not be told — reporting it would spend the one attempt on a
    // transaction that may not exist, and the id would be burned for the real one.
    jest.mocked(sendSol).mockImplementation(
      async (_secret: string, _to: string, _lamports: bigint, _signal?: AbortSignal, onBroadcast?: (s: string) => void) => {
        onBroadcast?.('5ig'.repeat(10));
        throw new Error('solana confirmation timeout');
      },
    );
    await expect(send()).resolves.toEqual({kind: 'unknown'});
    warn.mockRestore();
  });

  test('the review states the till’s price and its host in ONE line, in the IC rail’s words', async () => {
    // `0.01221422 SOL` is uncheckable against a price tag; "CHF 1" is what the till prints. One
    // component renders it for both rails (`OcpQuoteLines`), so the payer meets the same line
    // whichever asset is selected — CLAUDE.md's same-surfaces rule — and naming the host is what
    // marks the price as the MERCHANT's rather than dpay's.
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-price')).toBe(M.pay.ocp.tillPrice('CHF 1', 'api.dfx.swiss'));
  });

  test('a till that states no price of its own still names the host, and still pays', async () => {
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, details: {...OCP_TARGET.details, requestedAmount: null}},
    });
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'ocp-price')).toBe(M.pay.ocp.providerHost('api.dfx.swiss'));
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
  });

  test('a refusal from the provider sequence stays on the scan screen, and nothing is sent', async () => {
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'refused', message: M.pay.ocp.solanaTokenUnsupported('USDC')});
    const tree = mountTill();
    await scanTill(tree);

    expect(texts(tree)).toContain(M.pay.ocp.solanaTokenUnsupported('USDC'));
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
    expect(sendSol).not.toHaveBeenCalled();
  });

  test('a target that is not native SOL is refused before any transfer is built', async () => {
    // The System Program transfer below moves SOL, so a token target would pay SOL against a token
    // price. The resolver already refuses Solana USDC by name; this is the second lock.
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'ok', target: {...OCP_TARGET, assetId: 'solana:USDC'}});
    const tree = mountTill();
    await scanTill(tree);

    expect(texts(tree)).toContain(M.pay.ocp.solanaTokenUnsupported('USDC'));
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
  });

  // A transaction the network INCLUDED and then failed is the one post-broadcast outcome the chain
  // has already decided: no lamports reached the merchant and none ever will. Reporting it as
  // unknown told the payer "don't pay again" about a purchase they still have to pay for — the
  // honest-unknown asymmetry pointing the wrong way. The distinguishing fact was in the thrown
  // message all along (`confirmTransaction` throws `transaction failed: <err>`).
  test('a transaction the network included and FAILED is a definite failure, not an unknown one', async () => {
    const tree = mountTill();
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    const send = jest.mocked(payAndReport).mock.calls[0][3] as () => Promise<OcpSendResult>;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    jest.mocked(sendSol).mockImplementation(
      async (_secret: string, _to: string, _lamports: bigint, _signal?: AbortSignal, onBroadcast?: (s: string) => void) => {
        onBroadcast?.('5ig'.repeat(10)); // accepted by the network…
        throw new Error('transaction failed: {"InstructionError":[0,{"Custom":1}]}'); // …then failed on-chain
      },
    );
    // Definitive AND localized: the raw on-chain error JSON is a console diagnostic, never copy.
    await expect(send()).resolves.toEqual({kind: 'refused', message: M.pay.ocp.transferFailed});
    expect(M.pay.ocp.transferFailed).not.toContain('InstructionError');
    warn.mockRestore();
  });

  test('a price with too little runway left disables Approve on this rail too, in the same words', async () => {
    // Same gate, same helper, same sentence as the IC rail (CLAUDE.md's same-surfaces rule): a
    // price that cannot fit the whole sequence is not payable, and it is not called "expired"
    // either, because the payer can see it still counting down.
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: Date.now() + 30_000, payableUntil: Date.now() - 1_000},
    });
    const tree = mountTill();
    await scanTill(tree);
    expect(textByTestID(tree, 'sol-pay-err')).toBe(M.pay.ocp.notEnoughTime);
    expect(tree.root.findAll(n => n.props && n.props.testID === 'btn-approve')[0].props.disabled).toBe(true);

    // And the press re-checks, because the countdown only ticks once a second.
    await pressByLabel(tree, M.pay.approveA11y);
    expect(payAndReport).not.toHaveBeenCalled();
    expect(sendSol).not.toHaveBeenCalled();
  });

  test('the countdown stays off while there is runway, and appears counting to the PAYABLE deadline', async () => {
    // The IC rail's twin (PayMode.test) — one component renders this for both rails, and the
    // same-surfaces rule says a payer meets the identical behaviour whichever asset is selected.
    const now = Date.now();
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 300_000, payableUntil: now + 185_000},
    });
    let tree = mountTill();
    await scanTill(tree);
    expect(hasTestID(tree, 'ocp-expiry')).toBe(false);

    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 120_000, payableUntil: now + 42_000},
    });
    tree = mountTill();
    await scanTill(tree);
    expect(textByTestID(tree, 'ocp-expiry')).toMatch(/^Expires in 0:4[01]$/);
  });

  test('the runway this rail asks for is the bound its send actually runs under', async () => {
    // `sendSolForOcp` wraps the WHOLE send — blockhash, broadcast, confirmation — in
    // `withTimeout(SOL_SEND_TIMEOUT_MS)`, so that constant IS this rail's worst case. Naming it here
    // rather than a number keeps the deadline moving with the bound it is meant to cover.
    const tree = mountTill();
    await scanTill(tree);
    expect(jest.mocked(resolveOcpScan).mock.calls[0][1].sequenceBudgetMs).toBe(SOL_SEND_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// An OpenCryptoPay transfer the Solana rail could not resolve — the RECOVERABLE loss
// ---------------------------------------------------------------------------------------------
// The IC twin of this suite is PayMode's "an unresolved till transfer stays recoverable", and the
// situation is the same one: the likeliest failure of a till payment is not a refusal, it is a
// flaky connection while the transaction is already landing. The network accepted it, the provider
// was not told, the quote is still alive and the chain can still be asked what became of it — so
// throwing the broadcast signature away turns the recoverable case into the unrecoverable one.
//
// `payAndReport` is stubbed with its OWN contract (report a settled send, never an unknown one), so
// "was the provider told?" is answerable by looking at which calls' sends settled — and the
// one-shot rule is checked by counting them.
describe('SolPayMode — an unresolved till transfer stays recoverable', () => {
  const SIGNATURE = '5ig'.repeat(10);
  /** Every send verdict `payAndReport` was handed, in order. */
  let sends: OcpSendResult[];
  let warn: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    sends = [];
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.mocked(resolveOcpScan).mockReset().mockResolvedValue({kind: 'ok', target: OCP_TARGET});
    // The cluster has not seen it yet. Reset here rather than only where it is exercised: a value
    // left over from a previous test would silently resolve the NEXT test's claim under it.
    jest.mocked(getSolSignatureStatus).mockReset().mockResolvedValue(null);
    // Broadcast ACCEPTED, then the confirmation failed — the one shape that leaves real money in
    // flight, and the only one that produces a claim.
    jest.mocked(sendSol).mockReset().mockImplementation(
      async (_secret: string, _to: string, _lamports: bigint, _signal?: AbortSignal, onBroadcast?: (s: string) => void) => {
        onBroadcast?.(SIGNATURE);
        throw new Error('solana confirmation timeout');
      },
    );
    jest.mocked(payAndReport).mockReset().mockImplementation(async (_quote, _method, _asset, send) => {
      const s = await send();
      sends.push(s);
      if (s.kind === 'settled') return {kind: 'paid'};
      if (s.kind === 'refused') return {kind: 'not-paid', message: s.message};
      return {kind: 'unresolved', message: M.pay.ocp.transferUnknown};
    });
  });

  afterEach(() => { warn.mockRestore(); });

  /** Approve a till payment whose confirmation leaves the outcome indefinite. */
  async function approveIntoUnknown(tree: renderer.ReactTestRenderer) {
    await scanTill(tree);
    await pressByLabel(tree, M.pay.approveA11y);
    await act(async () => {}); // the claim's first re-poll tick
  }

  async function tick(tree: renderer.ReactTestRenderer) {
    await act(async () => { jest.advanceTimersByTime(POLL.receiptPay); });
    await act(async () => {});
    return tree;
  }

  test('a transaction that turns out to have CONFIRMED is reported — once — and the sale completes', async () => {
    const tree = mountTill();
    await approveIntoUnknown(tree);
    // Indefinite: the provider was NOT told, so the one submission is still unspent. The first
    // re-poll already ran and found nothing — a signature the cluster has not seen proves nothing.
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);
    expect(sends).toEqual([{kind: 'unknown'}]);

    // One more look at the SAME signature — the one that used to be discarded — finds it confirmed.
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'confirmed'});
    await tick(tree);

    expect(sends[1]).toEqual({kind: 'settled', txId: SIGNATURE, reference: M.pay.ocp.ref.solTransaction(SIGNATURE)});
    expect(jest.mocked(getSolSignatureStatus).mock.calls[0][0]).toBe(SIGNATURE); // re-read, never re-broadcast
    expect(sendSol).toHaveBeenCalledTimes(1);
    expect(texts(tree).join(' ')).toContain(M.nfc.paidAmount('0.012214220 SOL'));
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);

    // The claim is SPENT. `/tx` is granted exactly once in total, so no later tick may report again.
    const reports = jest.mocked(payAndReport).mock.calls.length;
    await tick(tree);
    await tick(tree);
    expect(jest.mocked(payAndReport).mock.calls.length).toBe(reports);
    act(() => { tree.unmount(); });
  });

  test('a transaction the chain FAILED says nothing was paid, and tells nobody', async () => {
    const tree = mountTill();
    jest.mocked(getSolSignatureStatus).mockResolvedValue({err: {InstructionError: [0, {Custom: 1}]}});
    await approveIntoUnknown(tree);

    // "Your money may be gone" was honest a moment ago and is a lie now: nothing reached the
    // merchant. The screen says so and puts the payer back where they can actually pay.
    expect(texts(tree)).toContain(M.pay.ocp.transferFailed);
    expect(hasTestID(tree, 'ocp-outcome')).toBe(false);
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    // The provider was never told about a transfer that never happened.
    expect(sends).toEqual([{kind: 'unknown'}]);
    act(() => { tree.unmount(); });
  });

  test('a transaction that confirms only AFTER the price died is not reported — the claim is worth more', async () => {
    // Submitting against a dead quote is refused AND binds the transaction id to it, which is
    // exactly what would stop the merchant crediting this payment by hand. So the signature is
    // handed to the payer instead of being spent.
    const base = Date.now();
    let clock = base;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: base + 60_000, payableUntil: base + 30_000},
    });
    const tree = mountTill();
    await approveIntoUnknown(tree);
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);

    clock = base + 61_000; // the price lapses while the app is still finding out what happened
    jest.mocked(getSolSignatureStatus).mockResolvedValue({confirmationStatus: 'finalized'});
    await tick(tree);

    expect(sends).toEqual([{kind: 'unknown'}]); // the submission was NOT spent
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.submitTooLate(M.pay.ocp.ref.solTransaction(SIGNATURE)));
    expect(texts(tree).join(' ')).not.toContain(M.nfc.paidAmount('0.012214220 SOL'));
    nowSpy.mockRestore();
    act(() => { tree.unmount(); });
  });

  test('a transaction that is only "processed" stays indefinite — one node, one fork deep', async () => {
    // Not a verdict: a processed transaction can still be rolled back, and the provider verifies
    // the identifier against the chain, so reporting it would spend the attempt on a maybe.
    const tree = mountTill();
    await approveIntoUnknown(tree);
    jest.mocked(getSolSignatureStatus).mockClear().mockResolvedValue({confirmationStatus: 'processed'});
    await tick(tree);

    // The claim WAS looked at — and deliberately not acted on.
    expect(getSolSignatureStatus).toHaveBeenCalledWith(SIGNATURE);
    expect(sends).toEqual([{kind: 'unknown'}]);
    expect(textByTestID(tree, 'ocp-outcome')).toBe(M.pay.ocp.transferUnknown);
    act(() => { tree.unmount(); });
  });

  test('two overlapping re-polls cannot both report the same transaction', async () => {
    // Each tick can outlive the next — the status read is a network call and the interval does not
    // wait for it. Without one-at-a-time serialisation every tick that piled up behind a slow read
    // would resume together and each would spend the one submission we are granted.
    let release!: (s: SolanaSignatureStatus) => void;
    jest.mocked(getSolSignatureStatus).mockReturnValue(new Promise<SolanaSignatureStatus>(r => { release = r; }));
    const tree = mountTill();
    await approveIntoUnknown(tree); // the first read starts and hangs

    await tick(tree); // two more ticks fire while it is still in flight
    await tick(tree);
    await act(async () => { release({confirmationStatus: 'confirmed'}); });
    await act(async () => {});

    // ONE report: the approve's own call, plus exactly one from the recovery.
    expect(payAndReport).toHaveBeenCalledTimes(2);
    expect(sends).toEqual([
      {kind: 'unknown'},
      {kind: 'settled', txId: SIGNATURE, reference: M.pay.ocp.ref.solTransaction(SIGNATURE)},
    ]);
    act(() => { tree.unmount(); });
  });
});

describe('SolPayMode — a scanned Solana Pay request (the open standard the receive QR speaks)', () => {
  const REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

  /** Scan any payload through the real camera gate — the entry a merchant's printed QR takes. */
  async function scanCode(tree: renderer.ReactTestRenderer, uri: string) {
    pressByTestID(tree, 'btn-sol-start-scan');
    const scanner = tree.root.find(node => typeof node.props.onScan === 'function');
    await act(async () => {
      scanner.props.onScan(uri);
    });
  }

  function errText(tree: renderer.ReactTestRenderer): string {
    return textByTestID(tree, 'sol-pay-err');
  }

  beforeEach(() => {
    jest.mocked(sendSolanaPay).mockReset().mockResolvedValue('SigSpayBase58');
  });

  test('a full request reviews FIXED values — amount, label, message, FULL destination — never auto-signs', async () => {
    const tree = mountSolPay();
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}&label=Coffee%20Bar&message=Order%2042`);
    expect(textByTestID(tree, 'sol-pay-amount')).toContain('0.001000000 SOL');
    expect(textByTestID(tree, 'sol-pay-payee')).toBe(MERCHANT);
    expect(texts(tree)).toContain(M.pay.toWho('Coffee Bar'));
    expect(textByTestID(tree, 'sol-spay-message')).toBe(M.pay.spay.merchantMessage('Order 42'));
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
    expect(hasTestID(tree, 'btn-sol-pay-cancel')).toBe(true);
    expect(jest.mocked(sendSolanaPay)).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('Approve sends ONE transfer carrying the reference key and memo, then reports Paid', async () => {
    const sent: string[] = [];
    const tree = mountSolPay({onSent: () => sent.push('sol')});
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}&memo=order-42`);
    await pressByLabel(tree, M.pay.approveA11y);
    expect(jest.mocked(sendSolanaPay)).toHaveBeenCalledTimes(1);
    const [secretHex, transfer] = jest.mocked(sendSolanaPay).mock.calls[0];
    expect(secretHex).toBe(IDENTITY.secretHex);
    expect(transfer).toEqual({recipient: MERCHANT, splToken: null, amount: 1000000n, references: [REFERENCE], memo: 'order-42'});
    expect(sent).toEqual(['sol']);
    expect(textByTestID(tree, 'sol-pay-status')).toContain('0.001000000 SOL');
    expect(textByTestID(tree, 'sol-spay-signature')).toBe('SigSpayBase58');
    expect(hasTestID(tree, 'btn-sol-pay-done')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('an amount-less request (the shape this wallet itself emits) opens review with amount ENTRY', async () => {
    const tree = mountSolPay();
    await scanCode(tree, `solana:${MERCHANT}?reference=${REFERENCE}`);
    // The read-back contract: the receive tab's own QR carries no amount, and scanning it back
    // must reach a review that can still be paid — not die at a missing number.
    expect(hasTestID(tree, 'sol-spay-amount-input')).toBe(true);
    expect(hasTestID(tree, 'sol-pay-amount')).toBe(false);
    // Approve is blocked until an amount exists…
    const approve = tree.root.findAll(node => node.props && node.props.testID === 'btn-approve')[0];
    expect(approve.props.disabled).toBe(true);
    // …then the typed amount is what gets sent.
    const input = tree.root.find(node => node.props && node.props.testID === 'sol-spay-amount-input');
    await act(async () => { input.props.onChangeText('0.0005'); });
    expect(tree.root.findAll(node => node.props && node.props.testID === 'btn-approve')[0].props.disabled).toBe(false);
    await pressByLabel(tree, M.pay.approveA11y);
    const [, transfer] = jest.mocked(sendSolanaPay).mock.calls[0];
    expect(transfer.amount).toBe(500000n);
    act(() => { tree.unmount(); });
  });

  test('a spl-token request pays USDC via the recipient ATA path and reports onSentToken with its mint', async () => {
    const sentMints: string[] = [];
    const tree = mountSolPay({tokenBalance: '2000000', tokenBalances: {[USDC_MINT_ADDRESS]: {amount: '2000000', status: 'balance'}}, onSentToken: mint => sentMints.push(mint ?? '')});
    await scanCode(tree, `solana:${MERCHANT}?spl-token=${USDC_MINT_ADDRESS}&amount=1.5&reference=${REFERENCE}`);
    expect(textByTestID(tree, 'sol-pay-amount')).toContain('1.500000 USDC');
    expect(hasTestID(tree, 'sol-spay-ata-note')).toBe(true);
    await pressByLabel(tree, M.pay.approveA11y);
    const [, transfer] = jest.mocked(sendSolanaPay).mock.calls[0];
    expect(transfer).toEqual({recipient: MERCHANT, splToken: USDC_MINT_ADDRESS, amount: 1500000n, references: [REFERENCE], memo: null});
    expect(sentMints).toEqual([USDC_MINT_ADDRESS]);
    act(() => { tree.unmount(); });
  });

  test('refusals are BY NAME, each with its own four-locale sentence — never the generic shrug', async () => {
    const cases: Array<[string, string]> = [
      [`solana:${MERCHANT}?amount=0.001&residual=1`, M.pay.spay.unexpectedParam('residual')],
      [`solana:${MERCHANT}?spl-token=${REFERENCE}`, M.pay.spay.unknownMint(REFERENCE)],
      [`solana:${MERCHANT}?amount=0`, M.pay.spay.badAmount],
      [`solana:${MERCHANT}?label=x&label=y`, M.pay.spay.badUri],
      [`solana:${MERCHANT}?reference=not-a-pubkey!!`, M.pay.spay.badReference],
      [`solana:${MERCHANT}?memo=${'a'.repeat(65)}`, M.pay.spay.memoTooLong],
    ];
    for (const [uri, expected] of cases) {
      const tree = mountSolPay();
      await scanCode(tree, uri);
      expect(errText(tree)).toBe(expected);
      expect(jest.mocked(sendSolanaPay)).not.toHaveBeenCalled();
      act(() => { tree.unmount(); });
    }
  });

  test('offline, a Solana Pay request is refused at the scan — the payer broadcasts it, so online is required', async () => {
    const tree = mountSolPay({online: false});
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    expect(errText(tree)).toBe(M.pay.spay.offline);
    act(() => { tree.unmount(); });
  });

  test('a USDC request against a wallet with no USDC account is refused at the scan, by name', async () => {
    const tree = mountSolPay({tokenBalances: {[USDC_MINT_ADDRESS]: {amount: null, status: 'absent'}}});
    await scanCode(tree, `solana:${MERCHANT}?spl-token=${USDC_MINT_ADDRESS}&amount=1.5`);
    expect(errText(tree)).toBe(M.errors.solana.senderNoTokenAccount('USDC'));
    act(() => { tree.unmount(); });
  });

  test('insufficient balance (fee-inclusive) blocks Approve with the named warning', async () => {
    // 0.001 SOL balance vs a 0.001 transfer + 5000 lamports fee — the fee is what tips it.
    const tree = mountSolPay({solBalance: '1000000'});
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    expect(hasTestID(tree, 'sol-pay-lowbal')).toBe(true);
    expect(texts(tree)).toContain(M.pay.notEnoughBalance);
    expect(tree.root.findAll(node => node.props && node.props.testID === 'btn-approve')[0].props.disabled).toBe(true);
    expect(jest.mocked(sendSolanaPay)).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('a broadcast-then-confirm-failure lands on the honest PENDING screen, not a false Paid', async () => {
    jest.mocked(sendSolanaPay).mockImplementation(
      (_s: string, _t: unknown, _sig?: AbortSignal, onBroadcast?: (x: string) => void) => {
        onBroadcast?.('SigSpayUnknown');
        return Promise.reject(new Error('confirm blown'));
      },
    );
    const sent: string[] = [];
    const tree = mountSolPay({onSent: () => sent.push('sol')});
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    await pressByLabel(tree, M.pay.approveA11y);
    // The money may be landing: no Paid claim, the signature is the record, the note says so.
    expect(texts(tree)).not.toContain(M.nfc.paidAmount('0.001000000 SOL'));
    expect(textByTestID(tree, 'sol-spay-signature')).toBe('SigSpayUnknown');
    expect(textByTestID(tree, 'sol-spay-outcome')).toBe(M.pay.spay.pendingNote);
    expect(sent).toEqual(['sol']);
    // And no retry affordance that could double-charge: Done, not Approve.
    expect(hasTestID(tree, 'btn-sol-pay-done')).toBe(true);
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a pre-broadcast failure stays on the review with the honest error — nothing was sent', async () => {
    jest.mocked(sendSolanaPay).mockRejectedValue(new Error('rpc down'));
    const tree = mountSolPay();
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    await pressByLabel(tree, M.pay.approveA11y);
    expect(hasTestID(tree, 'btn-approve')).toBe(true);
    expect(errText(tree)).toBe('rpc down');
    expect(hasTestID(tree, 'btn-sol-pay-done')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('Cancel returns to the scan surface clean — a second scan starts fresh', async () => {
    const tree = mountSolPay();
    await scanCode(tree, `solana:${MERCHANT}?amount=0.001&reference=${REFERENCE}`);
    pressByTestID(tree, 'btn-sol-pay-cancel');
    expect(hasTestID(tree, 'sol-pay-scan')).toBe(true);
    expect(errText(tree)).toBe('');
    await scanCode(tree, `solana:${MERCHANT}?amount=0.002&reference=${REFERENCE}`);
    expect(textByTestID(tree, 'sol-pay-amount')).toContain('0.002000000 SOL');
    act(() => { tree.unmount(); });
  });
});

describe('SolPayMode — the fund-first surfaces: the camera, and the funded account (X1/X3)', () => {
  test('a USDC-zero surface with a funded ckUSDC sibling names it and offers the one-tap switch', () => {
    const onSwitchRail = jest.fn();
    const tree = mountTill({
      homeCurrency: 'USD',
      balances: {'ic:2': {displayText: '5.00 ckUSDC', status: 'ok', failure: null}},
      payGate: 'token-zero',
      selectedToken: 'USDC',
      onSwitchRail,
    });
    expect(hasTestID(tree, 'sol-pay-fund')).toBe(true);
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe('You hold 5.00 ckUSDC on ckUSDC · Internet Computer');
    pressByTestID(tree, 'btn-fund-sibling-switch');
    expect(onSwitchRail).toHaveBeenCalledWith('ic:2');
    act(() => { tree.unmount(); });
  });

  test('X1: a SOL gate now points too — the funded account is a fact whatever the rail group', () => {
    // Was "points nowhere": SOL belongs to no home currency, so the same-currency pointer had
    // nothing to say and the gate stayed a dead end while the wallet held dollars one tap away.
    const tree = mountTill({
      homeCurrency: 'USD',
      balances: {'solana:USDC': {displayText: '2.50 USDC', status: 'ok', failure: null}},
      payGate: 'sol-zero',
      selectedToken: 'SOL',
    });
    expect(hasTestID(tree, 'sol-pay-fund')).toBe(true);
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe('You hold 2.50 USDC on USDC · Solana');
    act(() => { tree.unmount(); });
  });

  test('X3: a zero SELECTED balance no longer hides the camera — the solreq names its own mint', () => {
    // IC twin: PayMode's X3 test, same reason. A `solreq:v2` carries its own currency and mint, so
    // the selection cannot decide whether it is payable — and hiding the lens stopped the payer
    // reading a code they could have settled. The sign gate stays per-request (`solSplSignGate`).
    const tree = mountTill({payGate: 'sol-zero', selectedToken: 'SOL', balances: {}});
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    expect(hasTestID(tree, 'sol-pay-fund')).toBe(true);
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).not.toHaveLength(0);
    expect(hasTestID(tree, 'sol-pay-fund')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('X3: an ABSENT token account keeps its setup card AND the camera', () => {
    // The same class: the account this wallet lacks is the SELECTED one, and a request naming SOL
    // or any other mint is perfectly payable from here.
    const tree = mountTill({payGate: 'token-absent', selectedToken: 'USDC', balances: {}});
    expect(hasTestID(tree, 'sol-pay-ata-instructions')).toBe(true);
    expect(hasTestID(tree, 'btn-sol-start-scan')).toBe(true);
    pressByTestID(tree, 'btn-sol-start-scan');
    expect(scannerNodes(tree)).not.toHaveLength(0);
    act(() => { tree.unmount(); });
  });

  test('X1: the practice balance is named on this rail too — one pointer, both engines', () => {
    const onSwitchRail = jest.fn();
    const tree = mountTill({
      homeCurrency: 'CHF',
      payGate: 'sol-zero',
      selectedToken: 'SOL',
      balances: {'ic:0': {displayText: '∂100.00', status: 'ok', failure: null}},
      onSwitchRail,
    });
    expect(textByTestID(tree, 'fund-sibling-holds')).toBe(M.pay.fundSibling.practice('∂100.00'));
    pressByTestID(tree, 'btn-fund-sibling-switch');
    expect(onSwitchRail).toHaveBeenCalledWith('ic:0');
    act(() => { tree.unmount(); });
  });
});

describe('SolPayMode — per-request-mint solreq sign gate (OPEN_ISSUES 6(a))', () => {
  // The solreq names its OWN mint, which need not be the selected asset's: a KNOWN-absent mint
  // would sign pure against an ATA that doesn't exist and the merchant's broadcast would be
  // REJECTED (dead QR). The gate refuses at the scan, by name; unconfirmed states fail open.
  const SPL_DEST_ATA = '9AkkgHAxGYiX6RXhXbkVhFiyMAK81GYcj4zDtk9wbT4u'; // golden-vector ATA — any valid pubkey works as the merchant's destination
  const UNREGISTERED_MINT = 'So11111111111111111111111111111111111111112'; // wrapped SOL — a real mainnet mint dpay doesn't carry

  /** A cross-mint SPL solreq — same shape as solReqUri but cur/mint/toAta name the REQUEST's token. */
  function splReqUri(mint: string, cur: string): string {
    const iat = Math.floor(Date.now() / 1000) - 30;
    const input: SolReqInput = {
      rid: '0123456789abcdef0123456789abcdef',
      net: 'mainnet-beta',
      bh: BLOCKHASH,
      lvh: 300_000_000,
      slot: 290_000_000,
      iat,
      exp: iat + 90,
      to: MERCHANT,
      amt: '1500000',
      cur,
      mint,
      toAta: SPL_DEST_ATA,
      name: 'Cafe Sol',
      memo: '',
    };
    return encodeSolReq(input);
  }

  test('a cross-mint solreq naming a KNOWN-absent mint is refused at the scan, by name — nothing signs', async () => {
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: null, status: 'absent'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(textByTestID(tree, 'sol-pay-err')).toBe(M.errors.solana.senderNoTokenAccount('EURC'));
    expect(jest.mocked(signSplPayment)).not.toHaveBeenCalled();
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(false); // never reached the signed-QR phase
    expect(hasTestID(tree, 'sol-pay-scan')).toBe(true); // still on the scan surface
    act(() => { tree.unmount(); });
  });

  test('the refusal REMOUNTS the camera and a fresh scan of a fundable request signs right after', async () => {
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {
      [USDC_MINT_ADDRESS]: {amount: '2500000', status: 'balance'},
      [EURC_MINT_ADDRESS]: {amount: null, status: 'absent'},
    }});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    await act(async () => {}); // let the remount's passive effect flush
    expect(textByTestID(tree, 'sol-pay-err')).toBe(M.errors.solana.senderNoTokenAccount('EURC'));
    // Exactly TWO scanner mounts so far: the arm (btn-sol-start-scan) + ONE refusal remount
    // (scanKey++). A dead camera would read 1; a remount loop would read 3+.
    expect(mockScannerMounts.n).toBe(2);
    // Same wallet, fundable cross-mint request (USDC funded) — the REMOUNTED camera is live
    // (the surface stays armed), so this scan rides the mounted scanner, not the CTA.
    const scanner = tree.root.find((n: renderer.ReactTestInstance) => typeof n.props.onScan === 'function');
    await act(async () => { await scanner.props.onScan(splReqUri(USDC_MINT_ADDRESS, 'USDC')); });
    expect(jest.mocked(signSplPayment)).toHaveBeenCalledTimes(1);
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(true);
    expect(textByTestID(tree, 'sol-pay-err')).toBe('');
    act(() => { tree.unmount(); });
  });

  test('fail-open: an UNCONFIRMED request-mint state signs anyway (offline-first)', async () => {
    for (const state of [
      {amount: null, status: 'loading'},
      {amount: null, status: 'unavailable'},
      {amount: '0', status: 'error'},
    ]) {
      jest.mocked(signSplPayment).mockClear();
      const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: state}});
      await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
      expect(jest.mocked(signSplPayment)).toHaveBeenCalledTimes(1);
      expect(hasTestID(tree, 'sol-pay-qr')).toBe(true);
      act(() => { tree.unmount(); });
    }
    // never-polled mint (no state at all) fails open too
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(jest.mocked(signSplPayment)).toHaveBeenCalledTimes(1);
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(true);
    act(() => { tree.unmount(); });
  });

  // …and failing open SILENTLY is the half that was missing: a payment that cannot settle looked
  // exactly like one that can, right up until it never arrived. The hand-off surface is where the
  // payer meets it (the sync auto-sign never paints the 'review' phase), and the copy differs by
  // WHY there is no fact, because the payer's next move differs.
  test('a fact-less signature discloses itself ON the hand-off QR — and never blocks it', async () => {
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: null, status: 'loading'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(true); // the QR is still handed over
    expect(jest.mocked(signSplPayment)).toHaveBeenCalledTimes(1);
    expect(textByTestID(tree, 'sol-pay-sign-caveat')).toBe(M.errors.solana.senderTokenAccountUnverified('EURC'));
    act(() => { tree.unmount(); });
  });

  test('an endpoint that REFUSED this wallet gets the rail-down copy, not the get-online copy', async () => {
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: null, status: 'error', failure: 'refused'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(textByTestID(tree, 'sol-pay-sign-caveat'))
      .toBe(M.errors.solana.senderTokenAccountUnverifiedRailDown('EURC'));
    act(() => { tree.unmount(); });
  });

  test('a signature made ON a fact discloses nothing — no caveat on the common path', async () => {
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: '5000000', status: 'balance'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(true);
    expect(hasTestID(tree, 'sol-pay-sign-caveat')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('cancelling clears the caveat — it belongs to ONE signed request, not to the screen', async () => {
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: null, status: 'loading'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(hasTestID(tree, 'sol-pay-sign-caveat')).toBe(true);
    pressByTestID(tree, 'btn-sol-pay-discard');
    expect(hasTestID(tree, 'sol-pay-sign-caveat')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('fail-open inverse: a funded request-mint signs — even a known-zero balance (ATA exists)', async () => {
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {[EURC_MINT_ADDRESS]: {amount: '0', status: 'balance'}}});
    await scanToSign(tree, splReqUri(EURC_MINT_ADDRESS, 'EURC'));
    expect(jest.mocked(signSplPayment)).toHaveBeenCalledTimes(1);
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('an unregistered mint is refused with the named unknown-mint copy — not a raw signer crash', async () => {
    jest.mocked(signSplPayment).mockClear();
    const tree = mountSolPay({tokenBalances: {}});
    await scanToSign(tree, splReqUri(UNREGISTERED_MINT, 'USDC'));
    expect(textByTestID(tree, 'sol-pay-err')).toBe(M.pay.spay.unknownMint(UNREGISTERED_MINT));
    expect(jest.mocked(signSplPayment)).not.toHaveBeenCalled(); // the old honesty bug: the raw throw rendered verbatim
    expect(hasTestID(tree, 'sol-pay-qr')).toBe(false);
    act(() => { tree.unmount(); });
  });
});
