/**
 * CkErc20DepositSheet — watch honesty (verifier P2#5, 2026-08-20).
 *
 * The watching poll used to treat a NULL startBal (the connect-time snapshot failed) as
 * "any-positive balance ⇒ done" — so a wallet that ALREADY held the chain-key asset
 * false-positived 'done' on the very first poll, and a mint landing between a failed snapshot
 * and the first poll could too. The honest contract under test:
 *   - null baseline → the FIRST successful railBalanceOf read SETS the baseline (never done);
 *   - done requires OBSERVED GROWTH from a real baseline (cmpRaw(bal, startBal) > 0) — an
 *     equal-or-lower balance keeps watching;
 *   - persistence is unchanged: watching persists only once a real baseline exists, done clears it.
 *
 * Drives the REAL component wiring (connect → enter → submit → watching) with the wallet/rail
 * boundaries mocked; the connect-time snapshot is made to FAIL (null startBal), so the watching
 * poll is the only balance source — the exact P2#5 precondition.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('../services/native', () => ({
  DpayCore: {icpSelfPrincipal: jest.fn(async () => 'td2nx-oaaaa-aaaab-qhdnq-cai')},
}));
jest.mock('../services/relay', () => ({
  ckerc20OnrampParams: jest.fn(async () => ({
    helper_address: '0x' + '11'.repeat(20),
    erc20_address: '0x' + '22'.repeat(20),
    kind: 'erc20' as const,
  })),
}));
jest.mock('../services/rail', () => ({
  railBalanceOf: jest.fn(),
}));
// The wallet seam's FUNCTIONS are mocked; its typed errors are the REAL ones. `instanceof` inside
// the component resolves against whatever `../wallet` exports, so a locally-declared stub class
// would be a second definition to keep in step — and its message would be a copy of the i18n
// sentence the sheet is asserted to surface verbatim. `requireActual` reaches only wallet.ts, which
// never statically imports `@walletconnect/*` (the isolation boundary is intact).
jest.mock('../wallet', () => {
  const actual = jest.requireActual('../wallet') as typeof import('../wallet');
  return {
    resolveOnrampProvider: jest.fn(async () => ({})),
    connectWallet: jest.fn(async () => '0xAbC0000000000000000000000000000000000dEaD'),
    getChainId: jest.fn(async () => 1),
    sendTransaction: jest.fn(async () => '0x' + 'aa'.repeat(32)),
    waitForReceipt: jest.fn(async () => undefined),
    ReceiptReverted: actual.ReceiptReverted,
    TransactionHashMissing: actual.TransactionHashMissing,
    PairingRejected: actual.PairingRejected,
    ChainNotApproved: actual.ChainNotApproved,
    pairOnrampWallet: jest.fn(async () => false),
    openWalletApp: jest.fn(async () => false),
    installedWallets: jest.fn(async () => []),
    openWalletWithUri: jest.fn(async () => false),
  };
});
// The pairing-QR branch is unreachable here (wcUri only goes non-null on native via WalletConnect)
// but the module pulls react-native-svg — stub it like ReceiveMode stubs QrScanner.
jest.mock('../components/QrCode', () => ({QrCode: () => null}));

import {railBalanceOf} from '../services/rail';
import {
  connectWallet, installedWallets, openWalletApp, openWalletWithUri, pairOnrampWallet,
  resolveOnrampProvider, sendTransaction, waitForReceipt,
  ChainNotApproved, PairingRejected, ReceiptReverted, TransactionHashMissing,
  type KnownWallet,
} from '../wallet';
import {loadDeposit} from '../services/ckerc20Persist';
import {CkErc20DepositSheet} from '../components/CkErc20DepositSheet';
import type {FamilyDisplay} from '../config/catalog';
import type {Identity} from '../lib/types';
import {M} from '../i18n';

const IDENTITY: Identity = {secretHex: '11'.repeat(32), publicHex: '22'.repeat(32), username: 'Bob'};
const LEDGER = 'td2nx-oaaaa-aaaab-qhdnq-cai';
const DISPLAY: FamilyDisplay = {
  networkLabel: 'Ethereum', nativeAsset: 'USDC',
  amountDecimals: 6, blockMin: 1, withdrawMinRaw: 1, addressPlaceholder: '0x…',
};

// The component warns on the deliberately-failed snapshot + poll errors — silence the noise.
// (Referenced so the strict noUnusedLocals gate keeps the spy declared.)
const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
void warnSpy;

function has(tree: renderer.ReactTestRenderer, testID: string): boolean {
  return tree.root.findAll(node => node.props && node.props.testID === testID).length > 0;
}

/** Every line carrying the status testID, joined. In 'watching' WITH an error there are two of them
 *  (the error line above the flow and the watch line), which `findByProps` refuses to return. */
function statusText(tree: renderer.ReactTestRenderer): string {
  return tree.root
    .findAll(node => node.props && node.props.testID === 'ckerc20-status')
    .map(node => String(node.props.children))
    .join(' | ');
}

function mountSheet(nativeEth = false) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <CkErc20DepositSheet
        identity={IDENTITY} relayUrl="http://relay.test" currency={2} decimals={6}
        display={DISPLAY} chainId={null} nativeEth={nativeEth} ledger={LEDGER} icSymbol="ckUSDC"
        onClose={() => {}}
      />,
    );
  });
  return tree;
}

/** connect → amount entered: the sheet sits in 'enter' with the form filled, ready to submit. */
async function driveToEnter(tree: renderer.ReactTestRenderer) {
  await act(async () => { await Promise.resolve(); }); // let the mount effects (params, principal) settle
  await act(async () => {
    await tree.root.findByProps({testID: 'btn-connect-wallet'}).props.onPress();
  });
  await act(async () => {
    tree.root.findByProps({testID: 'ckerc20-amount'}).props.onChangeText('1');
  });
}

/** …and press Deposit, awaiting submit() to settle. Where the sheet lands is what each test asserts:
 *  'watching' only when the DEPOSIT tx itself was broadcast. railBalanceOf call #1 is the
 *  connect-time snapshot — queue it to REJECT for a null baseline, to RESOLVE for a persisted watch. */
async function driveSubmit(tree: renderer.ReactTestRenderer) {
  await driveToEnter(tree);
  await act(async () => {
    await tree.root.findByProps({testID: 'btn-approve'}).props.onPress();
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear(); // persisted watches must not leak across tests
});

describe('CkErc20DepositSheet — null-baseline watch honesty (P2#5)', () => {
  // Founder 2026-08-29: the connect view must ALSO surface the plain ICRC-1 receive route
  // (ckUSDC already on the IC — no Ethereum txs, no gas) with the wallet's own principal.
  test('connect view → "Already on the Internet Computer?" section with the ICRC-1 account', async () => {
    const tree = mountSheet();
    await act(async () => { await Promise.resolve(); }); // settle the principal derivation effect
    const addr = tree.root.findByProps({testID: 'ic-also-address'}).props.children;
    expect(addr).toBe('td2nx-oaaaa-aaaab-qhdnq-cai'); // the mocked DpayCore.icpSelfPrincipal
    const sectionText = tree.root.findByProps({testID: 'ic-also-section'})
      .findAll(n => typeof n.props?.children === 'string')
      .map(n => n.props.children).join(' ');
    expect(sectionText).toContain('ckUSDC');
    expect(has(tree, 'btn-ic-also-copy')).toBe(true);
    expect(has(tree, 'btn-connect-wallet')).toBe(true); // the primary Ethereum route is untouched
    act(() => { tree.unmount(); });
  });

  test('null baseline: the FIRST successful read SETS the baseline — never done, even with a pre-existing balance', async () => {
    // Snapshot fails at connect (null startBal); the wallet ALREADY holds 5 USDC. The first
    // watching read sees that balance — the old any-positive fallback would declare done here.
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // first watching read → SETS baseline
      .mockImplementationOnce(() => new Promise<string>(() => {})); // post-baseline read — held
    const tree = mountSheet();
    await driveSubmit(tree);

    // Still watching (never done), and the baseline-set is observable in the PERSISTED record.
    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(false);
    expect(statusText(tree)).toContain('Waiting for confirmation');
    const saved = await loadDeposit(IDENTITY.publicHex, 2);
    expect(saved?.phase).toBe('watching');
    expect(saved?.startBal).toBe('5000000'); // the baseline the first read set
    act(() => { tree.unmount(); });
  });

  test('growth after the baseline → done (observed growth is the only done path)', async () => {
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // baseline
      .mockResolvedValueOnce('6000000');                      // the mint lands — growth
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(true); // the done screen
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull(); // done cleared the key
    act(() => { tree.unmount(); });
  });

  test('an EQUAL balance after the baseline keeps watching (growth required, not mere presence)', async () => {
    jest.mocked(railBalanceOf)
      .mockRejectedValueOnce(new Error('ledger unreachable')) // connect-time snapshot → null
      .mockResolvedValueOnce('5000000')                       // baseline
      .mockResolvedValueOnce('5000000');                      // equal → cmpRaw == 0 → keep watching
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-deposit-done')).toBe(false);
    expect(statusText(tree)).toContain('Waiting for confirmation');
    act(() => { tree.unmount(); });
  });
});

/**
 * submit() phase routing (money safety, 2026-08-30). The phase after a throw depends on ONE fact —
 * whether the DEPOSIT transaction specifically was broadcast — because only that tx can ever mint.
 * Two ways the old code got it wrong, both of them lies about money in flight:
 *   - a broadcast deposit whose RECEIPT READ failed (a plain Error: on WalletConnect that read goes
 *     to a third-party HTTP RPC, not the wallet) was reported as "Transaction failed" — inviting the
 *     user to deposit the same money a second time;
 *   - an unknown-outcome APPROVE went to 'watching', where nothing can ever land because the deposit
 *     tx was never sent.
 */
describe('CkErc20DepositSheet — submit() routes on whether the DEPOSIT tx was broadcast', () => {
  const APPROVE_HASH = '0x' + 'a1'.repeat(32);
  const DEPOSIT_HASH = '0x' + 'd2'.repeat(32);

  test('ERC-20: deposit broadcast, then the RECEIPT READ fails → watching with both hashes, never "failed"', async () => {
    jest.mocked(railBalanceOf).mockResolvedValueOnce('0'); // a real baseline, so the watch persists
    jest.mocked(sendTransaction)
      .mockResolvedValueOnce(APPROVE_HASH)
      .mockResolvedValueOnce(DEPOSIT_HASH);
    jest.mocked(waitForReceipt)
      .mockResolvedValueOnce({status: 1})                              // the approve mined
      .mockRejectedValueOnce(new Error('rpc.walletconnect.org: 503')); // the deposit's receipt READ failed
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(true); // the watching UI
    expect(statusText(tree)).toContain('Transaction sent but not yet confirmed');
    expect(statusText(tree)).not.toContain('503'); // never the raw read failure dressed as a decline
    const saved = await loadDeposit(IDENTITY.publicHex, 2);
    expect(saved?.phase).toBe('watching');
    expect(saved?.txHashes).toEqual([APPROVE_HASH, DEPOSIT_HASH]); // the deposit hash IS persisted
    act(() => { tree.unmount(); });
  });

  // A timed-out poll and a failed receipt READ are the same plain Error and the same user position —
  // allowance possibly live, deposit definitely not sent — so there is one case, not two.
  test('ERC-20: an unconfirmed APPROVE stays in enter — the deposit was never sent, so nothing can mint', async () => {
    jest.mocked(waitForReceipt).mockRejectedValueOnce(new Error('rpc.walletconnect.org: 503'));
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(false); // NOT watching
    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(false); // back in enter
    expect(sendTransaction).toHaveBeenCalledTimes(1); // the approve only — no deposit tx
    expect(statusText(tree)).toContain('approval was sent but not confirmed');
    expect(statusText(tree)).toContain('approve once more'); // the second prompt is forewarned
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull(); // nothing to resume
    act(() => { tree.unmount(); });
  });

  test('ERC-20: the APPROVE reverts → enter, and the copy is about the approval, not the deposit', async () => {
    jest.mocked(waitForReceipt).mockRejectedValueOnce(new ReceiptReverted('reverted'));
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(false);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(statusText(tree)).toContain('approval reverted on chain');
    expect(statusText(tree)).not.toContain('Transaction reverted on chain'); // that copy is the deposit's
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull();
    act(() => { tree.unmount(); });
  });

  test('native ETH: the ONLY tx is the deposit — a failed receipt read watches it', async () => {
    jest.mocked(railBalanceOf).mockResolvedValueOnce('0');
    jest.mocked(sendTransaction).mockResolvedValueOnce(DEPOSIT_HASH);
    jest.mocked(waitForReceipt).mockRejectedValueOnce(new Error('rpc.walletconnect.org: 503'));
    const tree = mountSheet(true);
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(true);
    expect(statusText(tree)).toContain('Transaction sent but not yet confirmed');
    const saved = await loadDeposit(IDENTITY.publicHex, 2);
    expect(saved?.txHashes).toEqual([DEPOSIT_HASH]);
    act(() => { tree.unmount(); });
  });

  test('native ETH: the deposit REVERTS → hard fail in enter (it will never credit)', async () => {
    jest.mocked(waitForReceipt).mockRejectedValueOnce(new ReceiptReverted('reverted'));
    const tree = mountSheet(true);
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(false);
    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(false);
    expect(statusText(tree)).toContain('Transaction reverted on chain');
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull();
    act(() => { tree.unmount(); });
  });

  // Founder hard rule 2026-08-29: every step gives a practical instruction. A WalletConnect signing
  // request does not foreground the wallet app on native, so "Confirm in your wallet…" alone points
  // at a screen the user has to go find themselves.
  test('while sending, the native sheet says to switch to the wallet app and come back', async () => {
    // Park submit() inside eth_sendTransaction — exactly where the user is waiting on their wallet.
    jest.mocked(sendTransaction).mockImplementationOnce(() => new Promise<string>(() => {}));
    const tree = mountSheet();
    await driveToEnter(tree);
    await act(async () => {
      void tree.root.findByProps({testID: 'btn-approve'}).props.onPress();
      await Promise.resolve();
    });

    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(true); // still 'sending'
    expect(String(tree.root.findByProps({testID: 'ckerc20-switch-wallet'}).props.children))
      .toBe(M.deposit.erc20.switchToWalletApp);
    act(() => { tree.unmount(); });
  });

  // A LOST HASH is the third outcome: the wallet took the request and answered without an id, so it
  // may have broadcast it. "Failed" invites paying twice and 'watching' promises a credit that may
  // never come — the sheet must claim neither.
  test('ERC-20: the DEPOSIT loses its hash → enter, saying dpay cannot tell whether it was sent', async () => {
    jest.mocked(sendTransaction)
      .mockResolvedValueOnce(APPROVE_HASH)
      .mockRejectedValueOnce(new TransactionHashMissing('""', 'answered-without-id'));
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(has(tree, 'btn-ckerc20-check')).toBe(false); // NOT watching — nothing may be promised
    expect(tree.root.findByProps({testID: 'btn-approve'}).props.disabled).toBe(false); // back in enter
    // Two sentences from two owners: WHAT dpay knows (the error's own message — the wallet answered
    // without an id) and WHAT TO DO about it for THIS transaction (the sheet's step copy).
    expect(statusText(tree)).toContain('answered without a transaction id');
    expect(statusText(tree)).toContain('depositing again would send the money twice');
    expect(statusText(tree)).not.toContain('Transaction not signed'); // the old, fabricated verdict
    // …and the allowance line must NOT be appended here: it claims no funds left the wallet, which
    // is exactly what this outcome cannot say.
    expect(statusText(tree)).not.toContain('no funds have left your wallet');
    expect(await loadDeposit(IDENTITY.publicHex, 2)).toBeNull();
    act(() => { tree.unmount(); });
  });

  test('ERC-20: the APPROVE loses its hash → its own copy — nothing can mint, so the retry is safe', async () => {
    jest.mocked(sendTransaction).mockRejectedValueOnce(new TransactionHashMissing('null', 'no-answer'));
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(sendTransaction).toHaveBeenCalledTimes(1); // the deposit was never attempted
    // This one timed OUT, so the copy must not say the wallet accepted anything — dpay does not
    // know it ever saw the request. That claim was the defect; the step copy is unchanged.
    expect(statusText(tree)).toContain("Your wallet didn't answer");
    expect(statusText(tree)).not.toMatch(/accepted/i);
    expect(statusText(tree)).toContain('No deposit was made');
    expect(statusText(tree)).not.toContain('send the money twice'); // that risk is the deposit's
    act(() => { tree.unmount(); });
  });

  // The allowance the user just approved stays on chain when the deposit never goes out. Saying only
  // "Transaction not signed." hides it, and hides why the retry asks for two signatures again.
  test('ERC-20: a CONFIRMED approval then a declined deposit reports the standing allowance', async () => {
    jest.mocked(sendTransaction)
      .mockResolvedValueOnce(APPROVE_HASH)                       // approve accepted…
      .mockRejectedValueOnce(new Error('User rejected the request.')); // …deposit declined
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(statusText(tree)).toContain('Transaction not signed.');
    expect(statusText(tree)).toContain('spending approval is already confirmed on chain');
    expect(statusText(tree)).toContain('approve and then deposit');
    act(() => { tree.unmount(); });
  });

  test('ERC-20: a declined APPROVE says only "not signed" — no allowance exists to warn about', async () => {
    jest.mocked(sendTransaction).mockRejectedValueOnce(new Error('User rejected the request.'));
    const tree = mountSheet();
    await driveSubmit(tree);

    expect(statusText(tree)).toContain('Transaction not signed.');
    expect(statusText(tree)).not.toContain('spending approval');
    act(() => { tree.unmount(); });
  });
});

/**
 * The WalletConnect pairing screen (native only; `wcUri` never goes non-null on web).
 *
 * The named-wallet buttons exist because `@walletconnect/sign-client` foregrounds a wallet for a
 * signing request only when a deeplink choice was recorded for it, and only `openWalletWithUri`
 * records one — the bare `wc:` system chooser cannot report which app it launched. The rows here are
 * FIXTURES, not a copy of `KNOWN_WALLETS`: the sheet renders whatever `installedWallets()` returns,
 * and the real table is pinned in `wallet-picker.test.ts`.
 */
describe('CkErc20DepositSheet — the pairing screen', () => {
  const TRUST: KnownWallet = {name: 'Trust Wallet', scheme: 'trust://', androidPackage: 'com.wallet.crypto.trustapp'};
  const METAMASK: KnownWallet = {name: 'MetaMask', scheme: 'metamask://', androidPackage: 'io.metamask'};
  const URI = 'wc:c0ffee-1234@2?relay-protocol=irn&symKey=deadbeef';

  /** Park connect() in the pairing state: the URI is emitted, the session never settles. */
  async function driveToPairing(installed: KnownWallet[]) {
    jest.mocked(installedWallets).mockResolvedValue(installed);
    jest.mocked(pairOnrampWallet).mockImplementationOnce(async (onUri) => {
      onUri(URI); // display_uri — the QR goes up
      await new Promise<void>(() => {}); // …and no wallet ever approves
      return true;
    });
    const tree = mountSheet();
    await act(async () => { await Promise.resolve(); }); // mount effects (params, principal)
    await act(async () => {
      void tree.root.findByProps({testID: 'btn-connect-wallet'}).props.onPress();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); }); // the installedWallets probe
    return tree;
  }

  test('lists one button per installed wallet, alongside the QR and the chooser', async () => {
    const tree = await driveToPairing([TRUST, METAMASK]);

    expect(has(tree, 'wc-pair-qr')).toBe(true); // the other-device route is kept
    expect(has(tree, `btn-open-wallet-${TRUST.androidPackage}`)).toBe(true);
    expect(has(tree, `btn-open-wallet-${METAMASK.androidPackage}`)).toBe(true);
    expect(has(tree, 'btn-other-wallet')).toBe(true); // the 200+ wallets dpay cannot name
    expect(tree.root.findByProps({testID: `btn-open-wallet-${TRUST.androidPackage}`}).props.accessibilityLabel)
      .toBe('Open Trust Wallet');
    act(() => { tree.unmount(); });
  });

  // Founder hard rule 2026-08-29: never a dead end. An empty probe result is a legitimate answer
  // (nothing on the table installed, or every scheme unqueryable), not a screen with no way forward.
  test('no known wallet installed → the QR and the chooser still give the user something to do', async () => {
    const tree = await driveToPairing([]);

    expect(tree.root.findAll(n =>
      typeof n.props?.testID === 'string' && n.props.testID.startsWith('btn-open-wallet-'),
    )).toHaveLength(0);
    expect(has(tree, 'wc-pair-qr')).toBe(true);
    expect(has(tree, 'btn-other-wallet')).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('tapping a listed wallet opens it WITH the pairing URI — the route that records the choice', async () => {
    jest.mocked(openWalletWithUri).mockResolvedValueOnce(true);
    const tree = await driveToPairing([TRUST]);
    await act(async () => {
      await tree.root.findByProps({testID: `btn-open-wallet-${TRUST.androidPackage}`}).props.onPress();
    });

    expect(openWalletWithUri).toHaveBeenCalledWith(TRUST, URI);
    // NOT the system chooser: that route records nothing, so the later "Approve & deposit" request
    // would sit unseen in a backgrounded wallet.
    expect(openWalletApp).not.toHaveBeenCalled();
    expect(has(tree, 'ckerc20-status')).toBe(false); // no error line
    act(() => { tree.unmount(); });
  });

  test('a listed wallet that will not open names THAT wallet and what is left to try', async () => {
    jest.mocked(openWalletWithUri).mockResolvedValueOnce(false);
    const tree = await driveToPairing([METAMASK]);
    await act(async () => {
      await tree.root.findByProps({testID: `btn-open-wallet-${METAMASK.androidPackage}`}).props.onPress();
    });

    expect(statusText(tree)).toContain('MetaMask');
    expect(statusText(tree)).toContain('scan the QR with a wallet on another device');
    expect(has(tree, 'wc-pair-qr')).toBe(true); // …and that QR is still on screen to act on
    act(() => { tree.unmount(); });
  });
});

/**
 * connect() — pairing failures are classified by TYPE, and the provider is resolved AFTER pairing.
 *
 * The deleted classifier string-matched `/reject|denied|user/i` against copy that ships in four
 * languages; the provider used to be captured BEFORE `pairOnrampWallet`, which tears the provider
 * down and re-inits when a cached session approved a different chain than the deposit needs.
 */
describe('CkErc20DepositSheet — connect() pairing outcomes', () => {
  async function drivePairFailure(error: Error) {
    jest.mocked(pairOnrampWallet).mockRejectedValueOnce(error);
    const tree = mountSheet();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await tree.root.findByProps({testID: 'btn-connect-wallet'}).props.onPress();
    });
    return tree;
  }

  test('a declined pairing reads as a decline, and nothing runs on the dead session', async () => {
    const tree = await drivePairFailure(new PairingRejected('WalletConnect pairing failed: User rejected.'));

    expect(statusText(tree)).toContain('Pairing not approved.');
    expect(statusText(tree)).not.toContain('WalletConnect pairing failed'); // not the raw SDK wording
    expect(resolveOnrampProvider).not.toHaveBeenCalled();
    expect(connectWallet).not.toHaveBeenCalled();
    expect(has(tree, 'btn-connect-wallet')).toBe(true); // still on the connect screen
    act(() => { tree.unmount(); });
  });

  test('a wrong-network session surfaces its own actionable sentence, unchanged', async () => {
    const message = M.errors.ethWallet.chainNotApproved(11155111, '1');
    const tree = await drivePairFailure(new ChainNotApproved(11155111, ['1']));

    // Verbatim: it already names the network to switch to and what to do next. Re-wording it into
    // "Could not pair with your wallet." would throw that away.
    expect(statusText(tree)).toContain(message);
    expect(statusText(tree)).not.toContain('Could not pair');
    expect(statusText(tree)).not.toContain('Pairing not approved');
    act(() => { tree.unmount(); });
  });

  test('a pairing failure that merely MENTIONS a user is not reported as a decline', async () => {
    const message = M.errors.ethWallet.pairingFailed('the relay closed the connection for this user agent');
    const tree = await drivePairFailure(new Error(message));

    // The regex matched 'user' here and told the user they had declined — a verdict nobody reached.
    expect(statusText(tree)).toContain(message);
    expect(statusText(tree)).not.toContain('Pairing not approved');
    act(() => { tree.unmount(); });
  });

  test('the provider is resolved AFTER pairing, exactly once', async () => {
    const seen: string[] = [];
    jest.mocked(pairOnrampWallet).mockImplementationOnce(async () => { seen.push('pair'); return true; });
    jest.mocked(resolveOnrampProvider).mockImplementationOnce(async () => {
      seen.push('resolve');
      return {request: async () => []};
    });
    jest.mocked(connectWallet).mockImplementationOnce(async () => {
      seen.push('connect');
      return '0xAbC0000000000000000000000000000000000dEaD';
    });
    const tree = mountSheet();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await tree.root.findByProps({testID: 'btn-connect-wallet'}).props.onPress();
    });

    // A provider captured before pairing is the DISCONNECTED instance whenever pairWalletConnect
    // re-inits on the requested chain, and every call below it then runs on a dead session.
    expect(seen).toEqual(['pair', 'resolve', 'connect']);
    expect(resolveOnrampProvider).toHaveBeenCalledTimes(1);
    expect(has(tree, 'ckerc20-amount')).toBe(true); // …and the sheet advanced to 'enter'
    act(() => { tree.unmount(); });
  });
});
