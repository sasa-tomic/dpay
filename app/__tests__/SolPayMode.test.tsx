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

jest.mock('../components/QrScanner', () => ({
  QrScanner: (_props: {onScan: (raw: string) => void}) => null,
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
    // No test may reach a Solana RPC; the OpenCryptoPay suite below drives this directly.
    sendSol: jest.fn(),
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
  payAndReport: jest.fn(),
}));

import {encodeSolReq, type SolReqInput} from '../solana/qr';
import {sendSol, signSolPayment} from '../solana';
import {payAndReport, resolveOcpScan, type OcpSendResult, type OcpTarget} from '../services/opencryptopay';
import {buildSelectableAssets} from '../config/assets';
import {SOL_SEND_TIMEOUT_MS} from '../config/constants';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {SolPayMode} from '../components/SolPayMode';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const IDENTITY: Identity = {secretHex: '33'.repeat(32), publicHex: '44'.repeat(32), username: 'Payer'};
const MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const BLOCKHASH = 'GZXyfzSTCBmA7rpeDLrmUbiSA45H5EEwJhoBeR6ZNb3u';

const shareSpy = jest.spyOn(Share, 'share');

function solReqUri(name: string = 'Cafe Sol'): string {
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
    memo: '',
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
      solBalance="5000000000"
      usdcBalance="0"
      usdcAtaAbsent={false}
      payGate="none"
      selectedToken="SOL"
      onSent={() => {}}
      onSentUsdc={() => {}}
      onShowSolAddress={() => {}}
      onShowUsdcAddress={() => {}}
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
    quoteId: 'plq_ec214dddae51da4d',
    quoteExpiresAt: Date.now() + 300_000,
    callbackUrl: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
    claimedMerchantName: 'Test Shop',
    requestedAmount: {asset: 'CHF', amount: '1'},
    transferAmounts: [{method: 'Solana', available: true, assets: [{asset: 'SOL', amount: '0.01221422'}]}],
  },
  host: 'api.dfx.swiss',
  method: 'Solana',
  asset: 'SOL',
  assetId: 'solana:SOL',
  to: MERCHANT,
  rawAmount: '12214220',
  expiresAt: Date.now() + 300_000,
  // A live price with room to spare. The gap to `expiresAt` is what the countdown shows and what
  // Approve is gated on — the same deadline the IC rail uses, from the same helper.
  payableUntil: Date.now() + 180_000,
};

/** The wallet's REAL Solana rows — the selection the till payment is made WITH. */
const SOL_ASSETS = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaUsdc: true,
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
    jest.mocked(sendSol).mockReset().mockResolvedValue('5ig'.repeat(10));
  });

  test('a scanned till lands on a review with the amount, the full address and the host — nothing is sent', async () => {
    const tree = mountTill();
    await scanTill(tree);

    expect(textByTestID(tree, 'sol-pay-amount')).toContain('0.01221422');
    expect(textByTestID(tree, 'sol-pay-payee')).toBe(MERCHANT);
    expect(textByTestID(tree, 'ocp-host')).toBe(M.pay.ocp.providerHost('api.dfx.swiss'));
    expect(textByTestID(tree, 'review-claimed')).toBe(M.pay.ocp.claimedMerchant);
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

  test('a refusal from the provider sequence stays on the scan screen, and nothing is sent', async () => {
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'refused', message: M.pay.ocp.solanaUsdcUnsupported});
    const tree = mountTill();
    await scanTill(tree);

    expect(texts(tree)).toContain(M.pay.ocp.solanaUsdcUnsupported);
    expect(hasTestID(tree, 'btn-approve')).toBe(false);
    expect(sendSol).not.toHaveBeenCalled();
  });

  test('a target that is not native SOL is refused before any transfer is built', async () => {
    // The System Program transfer below moves SOL, so a token target would pay SOL against a token
    // price. The resolver already refuses Solana USDC by name; this is the second lock.
    jest.mocked(resolveOcpScan).mockResolvedValue({kind: 'ok', target: {...OCP_TARGET, assetId: 'solana:USDC'}});
    const tree = mountTill();
    await scanTill(tree);

    expect(texts(tree)).toContain(M.pay.ocp.solanaUsdcUnsupported);
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

  test('the countdown runs to the payable deadline, not to the quote’s expiry', async () => {
    const now = Date.now();
    jest.mocked(resolveOcpScan).mockResolvedValue({
      kind: 'ok',
      target: {...OCP_TARGET, expiresAt: now + 300_000, payableUntil: now + 185_000},
    });
    const tree = mountTill();
    await scanTill(tree);
    expect(textByTestID(tree, 'ocp-expiry')).toBe(M.receive.validForMin(3));
    expect(textByTestID(tree, 'ocp-expiry')).not.toBe(M.receive.validForMin(5));
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
