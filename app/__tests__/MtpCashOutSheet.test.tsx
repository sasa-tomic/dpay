/**
 * MtpCashOutSheet - the Mt Pelerin OFF-ramp's ONE surface (plan R2 step 2, the widget
 * handoff, 2026-10-13). The pins:
 *
 *   • The QUOTE is the relay's attributed + timestamped envelope, rendered verbatim: the
 *     venue's own net figure, "Mt Pelerin" named, the relay's read instant shown (§4: relayed,
 *     never computed). A quote that has not landed renders the pending line, never a number.
 *   • The order is registered THROUGH THE RELAY SEAM (the service module, mocked here): the
 *     correlation id is minted locally before the call (the partner-agreement law) and rides
 *     `clientOrderId`; the request carries the pair, the network and the amount ONLY (bank
 *     details are the widget session's, never dpay's). The record is born at REGISTRATION
 *     (the widget flow's C1 moment) and carries NO providerDeposit block.
 *   • The handoff opens the venue's sell widget EXTERNAL through the `__DPAY_TEST_MTP_OPEN`
 *     seam (the R1 buy pattern): success fires the onWidgetOpened contract; an open failure
 *     keeps the lifecycle view with its honest line and a retry. There is NO send step and
 *     NO EvmWithdrawSheet.
 *   • Cancel is the TYPED user-rejected path (the MtpBuyUserRejected precedent); nothing is
 *     ordered before it fires.
 *   • Validation: an unusable amount (zero, or over balance) keeps the continue button
 *     inert - no order call.
 *   • The fee facts render verbatim + dated (bank band, the ZCHF 0% partnership, the no-KYC
 *     band, the CHF 50 minimum), the counterparty is named — and the CARD line is ABSENT
 *     (card is a buy-side method; the venue publishes no cash-out card figure).
 *   • The adopted record HYDRATES through the real store validator (the
 *     venueOfId('mtpelerin') cefi exemption) - proven, not assumed.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {
  MtpCashOutSheet, MtpCashOutUserRejected, buildMtpCashOutRecord,
} from '../components/MtpCashOutSheet';
import * as mtpService from '../services/mtpelerin';
import {adoptConvertRecord} from '../convertResume';
import {hydrateConvertStore} from '../convert/records';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';

jest.mock('../services/mtpelerin', () => {
  const actual = jest.requireActual('../services/mtpelerin') as typeof mtpService;
  return {
    ...actual,
    fetchMtpCashQuote: jest.fn<typeof actual.fetchMtpCashQuote>(),
    createMtpCashOrder: jest.fn<typeof actual.createMtpCashOrder>(),
  };
});

jest.mock('../convertResume', () => ({
  adoptConvertRecord: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  convertResumeSnapshot: jest.fn<() => Record<string, never>>().mockReturnValue({}),
  subscribeConvertRecords: jest.fn<() => () => void>().mockReturnValue(() => {}),
}));

const mockQuote = mtpService.fetchMtpCashQuote as jest.MockedFunction<typeof mtpService.fetchMtpCashQuote>;
const mockCreate = mtpService.createMtpCashOrder as jest.MockedFunction<typeof mtpService.createMtpCashOrder>;
const mockAdopt = adoptConvertRecord as jest.MockedFunction<typeof adoptConvertRecord>;

const QUOTE_AT = Date.parse('2026-10-12T10:00:00Z');

const ZCHF = {
  id: 'evm:1:ZCHF' as const, protocol: 'evm' as const, token: 'ZCHF', symbol: 'ZCHF',
  chainId: 1, chainName: 'Ethereum', address: '0xAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAbAb',
  linkToken: 'ZCHF', networkLabel: 'ZCHF · Ethereum', network: 'Ethereum', decimals: 18,
  minFractionDigits: 2, liquidity: 'deep' as const, onramp: 'Partner' as const,
  offramp: 'Partner' as const, rampPartner: null, visible: true,
  testKey: 'evm-zchf-ethereum', testnet: false,
};

type Seam = (url: string) => Promise<void>;

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.find(n => n.props?.testID === testID);
  return node.findAllByType(Text).map(t => String(t.props.children ?? '')).join('');
}

function node(tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
  const n = tree.root.findAll(x => x.props && x.props.testID === testID)[0];
  if (!n) throw new Error(`no node with testID=${testID}`);
  return n;
}

function type(tree: renderer.ReactTestRenderer, testID: string, value: string): void {
  act(() => { node(tree, testID).props.onChangeText(value); });
}

/** Press + pump the promise chains (the MtpBuySheet.test idiom). */
async function pressAsync(tree: renderer.ReactTestRenderer, testID: string): Promise<void> {
  const n = node(tree, testID);
  await act(async () => {
    n.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(props: Partial<Parameters<typeof MtpCashOutSheet>[0]> = {}): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <MtpCashOutSheet
        relayUrl="https://relay.test"
        asset={ZCHF}
        token="ZCHF"
        balance="5000000000000000000"
        onClose={() => {}}
        {...props}
      />,
    );
    await Promise.resolve();
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks(); // the domain tier does not auto-clear: call records must not leak across tests
  jest.useFakeTimers();
  delete (globalThis as {__DPAY_TEST_MTP_OPEN?: unknown}).__DPAY_TEST_MTP_OPEN;
  mockQuote.mockResolvedValue({
    destAmount: '9651.10', networkFee: null, fetchedAtMs: QUOTE_AT,
  });
  // The relay's REAL born answer, normalized by the service: the venue's facts are null.
  mockCreate.mockResolvedValue({
    orderId: 'mtp-test000000000001', venueOrderId: null, offRampAddress: null, expiresAtMs: null,
  });
});

describe('MtpCashOutSheet — the relay quote', () => {
  test('the venue figure renders attributed + timestamped; the relay call carries the rail facts', async () => {
    const tree = await mount();
    type(tree, 'mtp-cashout-amount', '2');
    await act(async () => {
      jest.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockQuote).toHaveBeenCalledWith('https://relay.test', {
      sourceCurrency: 'ZCHF', destCurrency: 'CHF', sourceAmount: '2', sourceNetwork: 'mainnet',
    });
    expect(textOf(tree, 'mtp-cashout-quote-net')).toBe(M.deposit.mtpCash.quoteNet('9651.10 CHF'));
    expect(textOf(tree, 'mtp-cashout-quote-at'))
      .toBe(M.deposit.mtpCash.quoteBy('Mt Pelerin', formatClock(new Date(QUOTE_AT))));
    act(() => { tree.unmount(); });
  });

  test('no read yet, no number: the pending line renders until the quote lands', async () => {
    const tree = await mount();
    type(tree, 'mtp-cashout-amount', '2');
    await act(async () => { await Promise.resolve(); });
    expect(has(tree, 'mtp-cashout-quote-pending')).toBe(true);
    expect(has(tree, 'mtp-cashout-quote-net')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('MtpCashOutSheet - order registration through the relay seam', () => {
  async function fillAndContinue(tree: renderer.ReactTestRenderer): Promise<void> {
    type(tree, 'mtp-cashout-amount', '2');
    await act(async () => {
      jest.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    await pressAsync(tree, 'btn-mtp-cashout-continue');
  }

  test('continue registers the order: pair + network + amount, a locally minted clientOrderId, NO bank data', async () => {
    const tree = await mount();
    await fillAndContinue(tree);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const args = mockCreate.mock.calls[0]![1];
    expect(args.sourceCurrency).toBe('ZCHF');
    expect(args.destCurrency).toBe('CHF');
    expect(args.sourceAmount).toBe('2');
    expect(args.sourceNetwork).toBe('mainnet');
    expect(args.clientOrderId).toMatch(/^[0-9a-f]{32}$/); // minted BEFORE the order exists
    expect('iban' in args).toBe(false); // bank details are the widget session's, never dpay's
    expect('holderName' in args).toBe(false);
    // The lifecycle phase with the widget handoff; there is NO send step.
    expect(has(tree, 'mtp-cashout-lifecycle')).toBe(true);
    expect(has(tree, 'btn-evm-send-confirm')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('the handoff opens the venue sell widget through the seam and fires onWidgetOpened', async () => {
    const opened: string[] = [];
    (globalThis as {__DPAY_TEST_MTP_OPEN?: Seam}).__DPAY_TEST_MTP_OPEN = async (url) => {
      opened.push(url);
    };
    let widgetOpened = 0;
    const tree = await mount({onWidgetOpened: () => { widgetOpened += 1; }});
    await fillAndContinue(tree);
    expect(opened).toEqual(['https://widget.mtpelerin.com/']); // the documented bare link
    expect(widgetOpened).toBe(1);
    expect(has(tree, 'mtp-cashout-widget-note')).toBe(true);
    expect(has(tree, 'mtp-cashout-widget-failed')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('an open failure keeps the lifecycle view with its honest line and a working retry', async () => {
    (globalThis as {__DPAY_TEST_MTP_OPEN?: Seam}).__DPAY_TEST_MTP_OPEN = async () => {
      throw new Error('no handler');
    };
    const tree = await mount();
    await fillAndContinue(tree);
    expect(textOf(tree, 'mtp-cashout-widget-failed')).toBe(M.deposit.mtpCash.widgetOpenFailed);
    // The record still stands (adopted at registration).
    expect(mockAdopt).toHaveBeenCalledTimes(1);
    // The retry opens through the same seam and clears the failure.
    (globalThis as {__DPAY_TEST_MTP_OPEN?: Seam}).__DPAY_TEST_MTP_OPEN = async () => {};
    await pressAsync(tree, 'btn-mtp-cashout-widget-retry');
    expect(has(tree, 'mtp-cashout-widget-failed')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a refused registration keeps the sheet in the form with its honest line', async () => {
    mockCreate.mockRejectedValue(new Error('refused'));
    const tree = await mount();
    await fillAndContinue(tree);
    expect(textOf(tree, 'mtp-cashout-err')).toBe(M.deposit.mtpCash.errRefused);
    expect(has(tree, 'btn-mtp-cashout-continue')).toBe(true); // the form stays, retry lives
    expect(mockAdopt).not.toHaveBeenCalled(); // no registration, no record
    act(() => { tree.unmount(); });
  });

  test('a shape-refused registration (a record claiming venue-side facts) keeps the form, adopts nothing', async () => {
    mockCreate.mockRejectedValue(new Error('shape'));
    const tree = await mount();
    await fillAndContinue(tree);
    expect(textOf(tree, 'mtp-cashout-err')).toBe(M.deposit.mtpCash.errShape);
    expect(has(tree, 'btn-mtp-cashout-continue')).toBe(true);
    expect(mockAdopt).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

describe('MtpCashOutSheet — validation', () => {
  test('an unusable amount (zero, then over balance) keeps the continue inert', async () => {
    const tree = await mount();
    type(tree, 'mtp-cashout-amount', '0');
    expect(node(tree, 'btn-mtp-cashout-continue').props.disabled).toBe(true);
    await pressAsync(tree, 'btn-mtp-cashout-continue');
    expect(mockCreate).not.toHaveBeenCalled();
    type(tree, 'mtp-cashout-amount', '9'); // balance is 5
    expect(has(tree, 'mtp-cashout-overbal')).toBe(true);
    expect(node(tree, 'btn-mtp-cashout-continue').props.disabled).toBe(true);
    await pressAsync(tree, 'btn-mtp-cashout-continue');
    expect(mockCreate).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('no quote yet: the continue stays inert even with a valid amount (no quote, no order)', async () => {
    mockQuote.mockRejectedValue(new Error('unconfigured'));
    const tree = await mount();
    type(tree, 'mtp-cashout-amount', '2');
    await act(async () => {
      jest.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(node(tree, 'btn-mtp-cashout-continue').props.disabled).toBe(true);
    await pressAsync(tree, 'btn-mtp-cashout-continue');
    expect(mockCreate).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

describe('MtpCashOutSheet — cancel and disclosure', () => {
  test('Cancel is the typed user-rejected path: the observer gets MtpCashOutUserRejected, nothing ordered', async () => {
    let rejected: unknown = null;
    let closed = 0;
    const tree = await mount({onClose: () => { closed += 1; }, onReject: e => { rejected = e; }});
    await pressAsync(tree, 'btn-mtp-cashout-cancel');
    expect(rejected).toBeInstanceOf(MtpCashOutUserRejected);
    expect(closed).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('fee facts verbatim + dated, counterparty named, NO card line on the cash-out', async () => {
    const tree = await mount();
    const fees = textOf(tree, 'mtp-cashout-fees');
    expect(fees).toContain(M.deposit.mtpCash.feeBank);
    expect(fees).toContain(M.deposit.mtpCash.feeZchf);
    expect(fees).toContain(M.deposit.mtpCash.kycLine);
    expect(fees).toContain(M.deposit.mtpCash.minNote);
    expect(fees).toContain('2026'); // the as-of date rides the block
    expect(fees).not.toContain(M.deposit.mtp.feeCard); // card is a buy-side method
    expect(textOf(tree, 'mtp-cashout-counterparty')).toContain('Mt Pelerin');
    act(() => { tree.unmount(); });
  });

  test('USDC renders no ZCHF-partnership line (that fact is ZCHF-specific)', async () => {
    const usdc = {...ZCHF, id: 'evm:1:USDC' as const, token: 'USDC', symbol: 'USDC', linkToken: 'USDC', decimals: 6, testKey: 'evm-usdc-ethereum'};
    const tree = await mount({asset: usdc, token: 'USDC', balance: '5000000'});
    const fees = textOf(tree, 'mtp-cashout-fees');
    expect(fees).toContain(M.deposit.mtpCash.feeBank);
    expect(fees).not.toContain(M.deposit.mtpCash.feeZchf);
    act(() => { tree.unmount(); });
  });
});

describe('MtpCashOutSheet - the lifecycle record', () => {
  test('registration adopts the legless CeFi record (awaiting_deposit, NO providerDeposit) into the engine', async () => {
    const tree = await mount();
    type(tree, 'mtp-cashout-amount', '2');
    await act(async () => {
      jest.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });
    await pressAsync(tree, 'btn-mtp-cashout-continue');
    expect(mockAdopt).toHaveBeenCalledTimes(1);
    const adopted = mockAdopt.mock.calls[0]![0];
    expect(adopted.step).toBe('awaiting_deposit');
    expect(adopted.venueId).toBe('mtpelerin');
    expect(adopted.providerRef!.orderId).toBe('mtp-test000000000001');
    expect(adopted.providerRef!.statusUrl).toBe('https://relay.test/api/v1/mtpelerin/conversion?id=mtp-test000000000001');
    expect(adopted.providerDeposit).toBeUndefined(); // dpay never learns a deposit address
    expect(adopted.amountIn).toBe('2000000000000000000');
    expect(adopted.expectedNet).toBe((965110n).toString()); // the quote's net figure, minor units
    // The panel renders the awaiting_deposit state (no handoff block: nothing to copy).
    expect(has(tree, 'convert-awaiting-deposit')).toBe(true);
    expect(has(tree, 'convert-deposit-handoff')).toBe(false);
    expect(has(tree, 'btn-convert-copy-deposit-address')).toBe(false);
    act(() => { tree.unmount(); });
  });
});

describe('buildMtpCashOutRecord — the record HYDRATES (the store validator, real)', () => {
  test('the legless CeFi shape (no providerDeposit) survives salvageConvertStore with the mtpelerin venue row', () => {
    const rec = buildMtpCashOutRecord({
      id: 'mtp-hydrate00000001',
      createdAtMs: QUOTE_AT,
      venueId: 'mtpelerin',
      orderId: 'mtp-hydrate00000001',
      statusUrl: 'https://relay.test/api/v1/mtpelerin/conversion?id=mtp-hydrate00000001',
      inLedger: '0xabababababababababababababababababababab',
      registeredAmountDecimal: '2',
      amountIn: '2000000000000000000',
      inSymbol: 'ZCHF',
      inDecimals: 18,
      expectedFiatDecimal: '9651.10',
    });
    const hydrated = hydrateConvertStore({[rec.id]: rec});
    expect(hydrated[rec.id]).toBeDefined();
    expect(hydrated[rec.id]!.providerRef!.orderId).toBe('mtp-hydrate00000001');
    expect(hydrated[rec.id]!.providerDeposit).toBeUndefined();
    expect(hydrated[rec.id]!.inLedger).toBe('0xabababababababababababababababababababab');
    expect(hydrated[rec.id]!.expectedNet).toBe((965110n).toString()); // 9651.10 CHF in minor units
  });
});
