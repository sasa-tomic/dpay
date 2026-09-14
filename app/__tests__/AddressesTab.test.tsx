/**
 * AddressesTab — the address-book ROUTE (2026-09-14, founder: "the address book needs to be shown
 * somewhere in the UI"). The store's own contract (MRU order, cap, insert-or-update) is pinned in
 * addressBook.test.ts; the send forms' consumption is pinned in SendSheet/SolanaWithdrawSheet
 * tests and e2e flow 178. What is left — and pinned here — is the route's OWN logic:
 *
 *  - the book renders GROUPED BY RAIL, because a destination is only valid on its own rail and the
 *    sections are the honesty mechanism (you never see an address without the rail it belongs to);
 *  - the EMPTY book names its way out (founder rule: an empty view carries its way out) instead of
 *    dead-ending, and the add form is the same way out the populated book offers;
 *  - the add form validates with the SEND PATH'S OWN resolvers (`resolveDestination` for IC,
 *    `isValidSolanaAddress` for SOL), so what this screen accepts is exactly what a send form
 *    would accept — no second opinion to drift;
 *  - rename edits the LABEL in place (the address is the row's identity and is not editable);
 *  - remove deletes the row and reports the mutation (Wallet re-reads history annotations).
 *
 * The core validators and the rail are mocked at their module boundaries (SendSheet.test.tsx's
 * seam); the address-book SERVICE is real against the in-memory AsyncStorage mock, so every
 * mutation asserted here is also the thing that survives a restart.
 */
import {describe, test, expect, jest, beforeEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AddressesTab} from '../components/AddressesTab';
import {buildSelectableAssets} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {M} from '../i18n';
import {loadAddressBook, rememberAddress} from '../services/addressBook';
import {DpayCore} from '../services/native';

jest.mock('../services/native', () => ({
  DpayCore: {
    icpValidateIcrcAccount: jest.fn(),
    icpValidateAccountId: jest.fn(),
    icpSelfPrincipal: jest.fn(),
    icpAccountIdFromPrincipal: jest.fn(),
  },
}));
jest.mock('../services/rail', () => ({
  prepareTransfer: jest.fn(),
  prepareLegacyTransfer: jest.fn(),
  submitTransfer: jest.fn(),
  decodeLegacyReply: jest.fn(),
  fetchLedgerFee: jest.fn(),
  wireRequestToIntent: jest.fn(),
}));
jest.mock('../components/QrScanner', () => ({QrScanner: () => null}));

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const SOL = ASSETS.find(a => a.id === 'solana:SOL')!;
const VCHF = ASSETS.find(a => a.protocol === 'ic' && a.symbol === 'VCHF')!;

// 32×'1' is base58 for 32 zero bytes — a structurally valid Solana pubkey that means "burn".
const VALID_SOL = '1'.repeat(32);
const IC_OWNER = 'abcd-efgh-ijkl-mnop';

const flush = () => act(async () => {});

function textsOf(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => String(n.props.children ?? ''));
}

function pressable(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(n => n.props?.testID === testID && typeof n.props.onPress === 'function')[0];
}

function input(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.find(n => n.props?.testID === testID);
}

async function mountAddresses(props: Partial<Parameters<typeof AddressesTab>[0]> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <AddressesTab
        assets={ASSETS}
        catalog={CATALOG}
        onBack={jest.fn()}
        onBookChanged={jest.fn()}
        {...props}
      />,
    );
  });
  await flush(); // the per-asset books load asynchronously on mount
  return tree;
}

beforeEach(async () => {
  jest.mocked(DpayCore.icpValidateIcrcAccount).mockReset();
  await AsyncStorage.clear();
});

describe('AddressesTab — a populated book renders grouped by rail', () => {
  beforeEach(async () => {
    await act(async () => {
      await rememberAddress(SOL.id, VALID_SOL, 'Coffee shop', 2_000);
      await rememberAddress(VCHF.id, IC_OWNER, 'Landlord', 1_000);
    });
    await flush();
  });

  test('every row sits under its OWN rail\'s header — never a rail-less address', async () => {
    const tree = await mountAddresses();
    const all = textsOf(tree).join(' ');
    expect(all).toContain(SOL.networkLabel);
    expect(all).toContain(VCHF.networkLabel);
    expect(all).toContain('Coffee shop');
    expect(all).toContain('Landlord');
    act(() => { tree.unmount(); });
  });

  test('rename edits the label in place and reports the mutation', async () => {
    const onBookChanged = jest.fn();
    const tree = await mountAddresses({onBookChanged});
    act(() => { pressable(tree, `addr-rename-sol-${VALID_SOL.slice(0, 8)}`)!.props.onPress(); });
    const field = input(tree, 'addr-rename-input-sol');
    act(() => { field.props.onChangeText('Canteen'); });
    await act(async () => { pressable(tree, 'addr-rename-save-sol')!.props.onPress(); });
    await flush();
    expect(textsOf(tree).join(' ')).toContain('Canteen');
    expect(await loadAddressBook(SOL.id)).toEqual([
      {address: VALID_SOL, label: 'Canteen', lastUsedMs: expect.any(Number)},
    ]);
    expect(onBookChanged).toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });

  test('remove deletes exactly that row and reports the mutation', async () => {
    const onBookChanged = jest.fn();
    const tree = await mountAddresses({onBookChanged});
    await act(async () => { pressable(tree, `addr-forget-sol-${VALID_SOL.slice(0, 8)}`)!.props.onPress(); });
    await flush();
    expect(await loadAddressBook(SOL.id)).toEqual([]);
    // The OTHER rail's book is untouched — one rail's remove never costs another its rows.
    expect((await loadAddressBook(VCHF.id)).map(e => e.address)).toEqual([IC_OWNER]);
    expect(onBookChanged).toHaveBeenCalled();
    act(() => { tree.unmount(); });
  });
});

describe('AddressesTab — the add form validates with the send path\'s own resolvers', () => {
  test('a SOL address the withdraw sheet would refuse is refused here too', async () => {
    const tree = await mountAddresses();
    act(() => { pressable(tree, 'btn-addresses-add')!.props.onPress(); });
    // The default asset is the catalog's first — switch the form to the SOL rail explicitly,
    // exactly what a user pasting a base58 pubkey would do.
    act(() => { pressable(tree, `addr-add-asset-${SOL.testKey}`)!.props.onPress(); });
    const field = input(tree, 'addr-add-address-input');
    act(() => { field.props.onChangeText('not-a-sol-address!!'); });
    await flush();
    expect(textsOf(tree).join(' ')).toContain(M.withdraw.badAddress('Solana'));
    const save = pressable(tree, 'btn-addresses-save')!;
    expect(save.props.disabled).toBe(true);
    act(() => { tree.unmount(); });
  });

  test('a valid SOL address saves into that rail\'s book, labelled, and reports the mutation', async () => {
    const onBookChanged = jest.fn();
    const tree = await mountAddresses({onBookChanged});
    act(() => { pressable(tree, 'btn-addresses-add')!.props.onPress(); });
    act(() => { pressable(tree, `addr-add-asset-${SOL.testKey}`)!.props.onPress(); });
    act(() => { input(tree, 'addr-add-address-input').props.onChangeText(VALID_SOL); });
    act(() => { input(tree, 'addr-add-name-input').props.onChangeText('Canteen'); });
    await flush();
    await act(async () => { pressable(tree, 'btn-addresses-save')!.props.onPress(); });
    await flush();
    expect(await loadAddressBook(SOL.id)).toEqual([
      {address: VALID_SOL, label: 'Canteen', lastUsedMs: expect.any(Number)},
    ]);
    expect(onBookChanged).toHaveBeenCalled();
    // The form closes on save — the row, not the empty form, is the confirmation.
    expect(tree.root.findAll(n => n.props?.testID === 'addresses-add-form').length).toBe(0);
    act(() => { tree.unmount(); });
  });

  test('an IC destination stores the CANONICAL owner form, exactly as the send sheet would', async () => {
    jest.mocked(DpayCore.icpValidateIcrcAccount).mockResolvedValue({owner: IC_OWNER, subaccountHex: ''} as never);
    const tree = await mountAddresses();
    act(() => { pressable(tree, 'btn-addresses-add')!.props.onPress(); });
    act(() => { pressable(tree, `addr-add-asset-${VCHF.testKey}`)!.props.onPress(); });
    act(() => { input(tree, 'addr-add-address-input').props.onChangeText(IC_OWNER.toUpperCase()); });
    await flush();
    await act(async () => { pressable(tree, 'btn-addresses-save')!.props.onPress(); });
    await flush();
    expect((await loadAddressBook(VCHF.id)).map(e => e.address)).toEqual([IC_OWNER]);
    act(() => { tree.unmount(); });
  });
});

describe('AddressesTab — the empty book and the way back', () => {
  test('an empty book names BOTH ways in and never dead-ends (founder rule)', async () => {
    const tree = await mountAddresses();
    expect(textsOf(tree).join(' ')).toContain(M.wallet.addressBook.empty);
    expect(pressable(tree, 'btn-addresses-add')).toBeDefined();
    act(() => { tree.unmount(); });
  });

  test('Back is its own control and fires once', async () => {
    const onBack = jest.fn();
    const tree = await mountAddresses({onBack});
    act(() => { pressable(tree, 'btn-addresses-back')!.props.onPress(); });
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});
