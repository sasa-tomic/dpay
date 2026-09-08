/**
 * The home SURFACES — what they CLAIM about a balance they cannot read, and what they announce.
 * A2 is the Home headline (HomeTab); A4 is the account row (AccountsTab, where the rows moved
 * 2026-09-08). One file because it is one honesty rule wearing two hats.
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
import {AccountsTab} from '../components/AccountsTab';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {preferredRail} from '../config/currency';
import {M} from '../i18n';
import {errorsDe} from '../i18n/domains/de/errors';
import {errorsEs} from '../i18n/domains/es/errors';
import {errorsFr} from '../i18n/domains/fr/errors';
import {errorsEn} from '../i18n/domains/en/errors';

const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
const ASSETS = buildSelectableAssets(CATALOG, {
  showTestnet: false, solanaEnabled: true, solanaTokens: true, networks: BUNDLED_NETWORKS,
});
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

/** How many times this testID is actually RENDERED — the X9 assertion is a COUNT, not a presence.
 *  Filtered to HOST nodes (`typeof type === 'string'`): react-test-renderer surfaces both the
 *  composite `<View>` element and the host instance it renders, so an unfiltered count doubles. */
const countOf = (tree: renderer.ReactTestRenderer, testID: string): number =>
  tree.root.findAll(n => n.props?.testID === testID && typeof n.type === 'string').length;

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

/** The measured X9 state: the whole Solana endpoint refusing (HTTP 429), so EVERY Solana account —
 *  SOL and each visible SPL token — reports 'error' at once. That is the shape the banner used to
 *  be rendered three times for. Mints come from the built asset list, never hardcoded. */
function solanaDown() {
  const mints = ASSETS.flatMap(a => (a.protocol === 'solana' && a.mint != null ? [a.mint] : []));
  const tokenStates = Object.fromEntries(
    mints.map(m => [m, {amount: null, decimals: null, status: 'error' as const}]),
  );
  return buildAssetBalances({
    catalog: CATALOG,
    assets: ASSETS,
    icBalances: {7: '120000000'},
    primaryBalance: '12345',
    online: true,
    solState: {balance: null, status: 'error'},
    tokenStates,
  });
}

function mountHome(props: Partial<Parameters<typeof HomeTab>[0]> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <HomeTab
        assets={ASSETS}
        balances={balancesFor({balance: '1500000000', status: 'ok'})}
        catalog={CATALOG}
        homeCurrency={HOME}
        homeAsset={HOME_RAIL}
        online={true}
        history={[]}
        onScan={jest.fn()}
        onReceive={jest.fn()}
        onDeposit={jest.fn()}
        onOpenAccounts={jest.fn()}
        onSeeAll={jest.fn()}
        onOpenReceipt={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

/** The accounts route, where the per-rail rows live since 2026-09-08. */
function mountAccounts(props: Partial<Parameters<typeof AccountsTab>[0]> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <AccountsTab
        assets={ASSETS}
        selectedId="ic:0"
        balances={balancesFor({balance: '1500000000', status: 'ok'})}
        homeCurrency={HOME}
        demoFaucetAvailable={true}
        topUpBusy={false}
        hasTestnet={false}
        showTestnet={false}
        onToggleTestnet={jest.fn()}
        onBack={jest.fn()}
        onSelect={jest.fn()}
        onTopUp={jest.fn()}
        onConvert={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('A2 — the headline announces exactly what it renders, unit stated once', () => {
  test('no announcement of the headline block states the unit twice', () => {
    const tree = mountHome();
    expect(textOf(tree, 'home-headline-amount')).toContain('VCHF');
    for (const s of announcedStrings(tree, 'home-headline')) {
      expect(`${s} :: VCHF×${occurrences(s, 'VCHF')}`).toBe(`${s} :: VCHF×${Math.min(occurrences(s, 'VCHF'), 1)}`);
    }
    act(() => { tree.unmount(); });
  });

  test('the offline approximation marker reaches a screen reader (it outranks every other name)', () => {
    const tree = mountHome({
      online: false,
      balances: balancesFor({balance: null, status: 'unavailable'}, false),
    });
    expect(announced(tree, 'home-headline')).toContain(M.wallet.balance.approx(M.wallet.homeCurrency.name[HOME]));
    act(() => { tree.unmount(); });
  });

  test('the home rail announces its Main marker, not a re-derived "balance" sentence', () => {
    const tree = mountHome();
    expect(announced(tree, 'home-headline'))
      .toContain(M.wallet.homeCurrency.mainLabel(M.wallet.homeCurrency.name[HOME]));
    act(() => { tree.unmount(); });
  });
});

describe('A4 — a rail the wallet cannot read says so ONCE, for the network', () => {
  test("the outage is stated once for the network, above its first affected row (X9)", () => {
    const tree = mountAccounts({balances: solanaDown()});
    // Three Solana accounts are unreadable; ONE banner names the network. Before X9 this rendered
    // the same ~48-word paragraph on every one of them.
    expect(present(tree, 'rail-unreadable-solana')).toBe(true);
    expect(countOf(tree, 'rail-unreadable-solana')).toBe(1);
    // …and independently of the renderer's node model: the SENTENCE appears once in everything the
    // screen renders. Three Solana rows are on this screen (asserted below), so a per-row banner
    // would put it there three times.
    const solanaRows = ASSETS.filter(a => a.protocol === 'solana').length;
    expect(solanaRows).toBeGreaterThanOrEqual(3);
    const screen = tree.root.findAllByType(Text)
      .map(n => (typeof n.props.children === 'string' ? n.props.children : '')).join('\n');
    expect(occurrences(screen, M.errors.rail.unreadable('Solana'))).toBe(1);
    const line = textOf(tree, 'rail-unreadable-solana');
    expect(line).toContain('Solana'); // WHICH network is not answering
    expect(line.toLowerCase()).toContain('other accounts'); // what still works
    expect(line.toLowerCase()).toContain('retr'); // it recovers on its own — no button to press
    // It speaks about the READ, not about the figure: 'error' ALSO covers a later failure that
    // keeps the last value it read, and a line saying "unreadable" beside a visible "2 SOL" would
    // contradict itself (seen on the 147 e2e screenshot before this wording).
    expect(line.toLowerCase()).not.toContain('unreadable');
    // The banner is short enough to read at a glance — that is the whole defect.
    expect(line.length).toBeLessThan(180);
    act(() => { tree.unmount(); });
  });

  test('the IC rows on the same screen claim nothing about a Solana outage', () => {
    const tree = mountAccounts({balances: solanaDown()});
    expect(present(tree, 'rail-unreadable-internet-computer')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a first poll that has not answered is NOT an unreadable rail (loading stays silent)', () => {
    const tree = mountAccounts({balances: balancesFor({balance: null, status: 'loading'})});
    expect(present(tree, 'rail-unreadable-solana')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('a readable rail says nothing at all', () => {
    const tree = mountAccounts();
    expect(present(tree, 'rail-unreadable-solana')).toBe(false);
    act(() => { tree.unmount(); });
  });

  test('all four locales carry the line, name the network, and promise no button', () => {
    for (const [locale, e] of Object.entries({en: errorsEn, de: errorsDe, es: errorsEs, fr: errorsFr})) {
      const line = e.rail.unreadable('Solana');
      expect(`${locale}: ${line}`).toContain('Solana');
      expect(`${locale}: ${line}`).not.toContain('undefined');
      expect(line.length).toBeGreaterThan(40); // a sentence with instructions, not a shrug
      expect(line.length).toBeLessThan(180);   // …and one line, not a paragraph per account (X9)
    }
  });
});
