/**
 * HomeTab — what the surface CLAIMS about a balance it cannot read, and what it announces.
 *
 * Two defects found on the 2026-09-08 pass, both invisible to every existing gate:
 *
 *   A2 — the headline carried a hand-built accessible name (`headlineA11y`) that re-derived its
 *        own sentence from the asset name + the formatted amount. It therefore (a) stated the
 *        unit twice ("SOL balance 1.5 SOL" — `fmtAsset` already owns the unit) and, worse,
 *        (b) DIVERGED from the rendered eyebrow: it said "balance" where the screen says
 *        "· Main", and it dropped the offline "~ approx." marker entirely — a screen-reader user
 *        was told a confident balance the wallet cannot know. The eyebrow is the one owner of
 *        that sentence; the block announces what it renders.
 *
 *   A4 — 'error' and 'loading' rendered identically as a bare "—". The baked Helius RPC key is
 *        out of quota (HTTP 429, measured 2026-09-08), so SOL / USDC·Solana / EURC·Solana show
 *        that dash on every shipped build — and EURC·Solana is the preferred EUR rail. A row the
 *        wallet cannot read must SAY it cannot read it, say it is the network and not the user's
 *        wallet, and say what still holds (founder rule 2026-08-29: useful practical instructions
 *        on every step, especially the error path). A first poll that has not answered yet is NOT
 *        that state and must stay silent.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {HomeTab} from '../components/HomeTab';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {preferredRail} from '../config/currency';
import {M} from '../i18n';
import {walletDe} from '../i18n/domains/de/wallet';
import {walletEs} from '../i18n/domains/es/wallet';
import {walletFr} from '../i18n/domains/fr/wallet';
import {walletEn} from '../i18n/domains/en/wallet';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
const SOL = ASSETS.find(a => a.id === 'solana:SOL')!;
const VCHF = ASSETS.find(a => a.id === 'ic:7')!;
const HOME = 'CHF' as const;
const HOME_RAIL = preferredRail(HOME, ASSETS);

/** What a screen reader gets for a block: its explicit accessible name if it has one, else the
 *  text it actually renders. The point of the A2 fix is that these can never disagree. */
function announced(tree: renderer.ReactTestRenderer, testID: string): string {
  const node = tree.root.findAll(n => n.props?.testID === testID)[0];
  if (node == null) return '';
  if (typeof node.props.accessibilityLabel === 'string') return node.props.accessibilityLabel;
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join(' ') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
}

/** Every distinct string this block would hand a screen reader, one per element — the unit-once
 *  rule is per STRING (the eyebrow and the amount are two separate announcements). */
function announcedStrings(tree: renderer.ReactTestRenderer, testID: string): string[] {
  const node = tree.root.findAll(n => n.props?.testID === testID)[0];
  if (node == null) return [];
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join(' ') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  const own = typeof node.props.accessibilityLabel === 'string' ? [node.props.accessibilityLabel] : [];
  return [...own, ...node.findAllByType(Text).map(n => flat(n.props.children))].filter(s => s.length > 0);
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const present = (tree: renderer.ReactTestRenderer, testID: string): boolean =>
  tree.root.findAll(n => n.props?.testID === testID).length > 0;

const textOf = (tree: renderer.ReactTestRenderer, testID: string): string => {
  const node = tree.root.findAll(n => n.props?.testID === testID)[0];
  if (node == null) return '';
  const flat = (c: unknown): string =>
    Array.isArray(c) ? c.map(flat).join('') : typeof c === 'string' || typeof c === 'number' ? String(c) : '';
  return node.findAllByType(Text).map(n => flat(n.props.children)).join(' ');
};

type SolState = Parameters<typeof buildAssetBalances>[0]['solState'];

function balancesFor(solState: SolState, online = true) {
  return buildAssetBalances({
    catalog: CATALOG,
    assets: ASSETS,
    icBalances: {7: '120000000'},
    primaryBalance: '12345',
    online,
    solState,
    tokenStates: {},
  });
}

function mountHome(props: Partial<Parameters<typeof HomeTab>[0]> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <HomeTab
        assets={ASSETS}
        selectedAsset={SOL}
        selectedId={SOL.id}
        balances={balancesFor({balance: '1500000000', status: 'ok'})}
        catalog={CATALOG}
        homeCurrency={HOME}
        homeAsset={HOME_RAIL}
        online={true}
        history={[]}
        topUpBusy={false}
        topUpErr={null}
        demoFaucetAvailable={true}
        hasTestnet={false}
        showTestnet={false}
        onToggleTestnet={jest.fn()}
        onPay={jest.fn()}
        onReceive={jest.fn()}
        onDeposit={jest.fn()}
        onTopUp={jest.fn()}
        onConvert={jest.fn()}
        onSelect={jest.fn()}
        onSeeAll={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('A2 — the headline announces exactly what it renders, unit stated once', () => {
  test('no announcement of the headline block states the unit twice', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-amount')).toContain('SOL');
    for (const s of announcedStrings(tree, 'home-headline')) {
      expect(`${s} :: SOL×${occurrences(s, 'SOL')}`).toBe(`${s} :: SOL×${Math.min(occurrences(s, 'SOL'), 1)}`);
    }
    act(() => { tree.unmount(); });
  });

  test('the offline approximation marker reaches a screen reader (it outranks every other name)', () => {
    const tree = mountHome({
      selectedAsset: VCHF,
      selectedId: VCHF.id,
      online: false,
      balances: balancesFor({balance: null, status: 'unavailable'}, false),
    });
    expect(announced(tree, 'home-headline')).toContain(M.wallet.balance.approx(M.wallet.homeCurrency.name[HOME]));
    act(() => { tree.unmount(); });
  });

  test('the home rail announces its Main marker, not a re-derived "balance" sentence', () => {
    const tree = mountHome({selectedAsset: VCHF, selectedId: VCHF.id});
    expect(announced(tree, 'home-headline'))
      .toContain(M.wallet.homeCurrency.mainLabel(M.wallet.homeCurrency.name[HOME]));
    act(() => { tree.unmount(); });
  });
});

describe('A4 — a rail the wallet cannot read says so, and says what still holds', () => {
  test("an unreadable rail's row explains the failure, blames the network, and stays honest", () => {
    const tree = mountHome({balances: balancesFor({balance: null, status: 'error'})});
    expect(present(tree, 'asset-sol-unreadable')).toBe(true);
    const line = textOf(tree, 'asset-sol-unreadable');
    expect(line).toContain('Solana'); // WHICH network is not answering
    expect(line.toLowerCase()).toContain('not your wallet'); // whose fault it is not
    expect(line.toLowerCase()).toContain('untouched'); // the funds are fine
    expect(line.toLowerCase()).toContain('other accounts'); // what still works
    expect(line.toLowerCase()).toContain('retr'); // it recovers on its own — no button to press
    // It speaks about the READ, not about the figure: 'error' ALSO covers a later failure that
    // keeps the last value it read, and a row saying "unreadable" beside a visible "2 SOL" would
    // contradict itself (seen on the 147 e2e screenshot before this wording).
    expect(line.toLowerCase()).not.toContain('unreadable');
    act(() => { tree.unmount(); });
  });

  test('a first poll that has not answered is NOT an unreadable rail (loading stays silent)', () => {
    const tree = mountHome({balances: balancesFor({balance: null, status: 'loading'})});
    expect(present(tree, 'asset-sol-unreadable')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a readable rail says nothing at all', () => {
    const tree = mountHome();
    expect(present(tree, 'asset-sol-unreadable')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('all four locales carry the line, name the network, and promise no button', () => {
    for (const [locale, w] of Object.entries({en: walletEn, de: walletDe, es: walletEs, fr: walletFr})) {
      const line = w.balances.railUnreadable('Solana');
      expect(`${locale}: ${line}`).toContain('Solana');
      expect(`${locale}: ${line}`).not.toContain('undefined');
      expect(line.length).toBeGreaterThan(60); // a sentence with instructions, not a shrug
    }
  });
});
