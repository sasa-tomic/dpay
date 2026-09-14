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
import {IconAlert} from '../components/icons';
import {buildSelectableAssets} from '../config/assets';
import {buildAssetBalances} from '../lib/assetBalances';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {C} from '../config/palette';
import {preferredRail} from '../config/currency';
import {S} from '../styles';
import {M} from '../i18n';
import type {SolanaReadFailure} from '../solana';
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

/** The measured X9 state WITH its classified cause (R3): every Solana account reports 'error' AND
 *  carries the seam's failure value, the way a real poll does once the hook threads
 *  `read.sol.failure` into the balance views. */
function solanaDownWith(failure: SolanaReadFailure) {
  const mints = ASSETS.flatMap(a => (a.protocol === 'solana' && a.mint != null ? [a.mint] : []));
  const tokenStates = Object.fromEntries(
    mints.map(m => [m, {amount: null, decimals: null, status: 'error' as const, failure}]),
  );
  return buildAssetBalances({
    catalog: CATALOG,
    assets: ASSETS,
    icBalances: {7: '120000000'},
    primaryBalance: '12345',
    online: true,
    solState: {balance: null, status: 'error', failure},
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
        onPay={jest.fn()}
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
    // R3 (spec 2026-09-09): four causes, four sentences. `unreachable` is allowed to run longer
    // because the spec requires it to carry FIVE facts (names dpay's side of the path, money
    // untouched, what still works, offline-pay unaffected, the Settings ▸ Advanced escape) — still
    // ONE line per network (X9), never one per account.
    const keys = ['refused', 'offline', 'unreachable', 'unreadable'] as const;
    const bounds: Record<typeof keys[number], number> = {refused: 180, offline: 180, unreachable: 400, unreadable: 180};
    for (const [locale, e] of Object.entries({en: errorsEn, de: errorsDe, es: errorsEs, fr: errorsFr})) {
      for (const key of keys) {
        const line = e.rail[key]('Solana');
        expect(`${locale}.${key}: ${line}`).toContain('Solana');
        expect(`${locale}.${key}: ${line}`).not.toContain('undefined');
        expect(line.length).toBeGreaterThan(40); // a sentence with instructions, not a shrug
        expect(line.length).toBeLessThan(bounds[key]); // …and one line, not a paragraph per account (X9)
      }
    }
  });
});

describe('R3 — the sentence follows the classified cause', () => {
  test('each of the four failures renders its OWN sentence, once, for the network', () => {
    // Four causes, four sentences — the note must never collapse them, because the user's next
    // move differs: a refused endpoint recovers on its own behind its cooldown, an offline phone
    // is the payer's designed state (nothing to fix), an unreachable path names the Settings ▸
    // Advanced escape, and unreadable bytes are the wallet saying "do not trust this read". The
    // cause is classified at the transport seam and only CHOSEN here — if this mapping drifts, the
    // user is told the wrong one of those four stories.
    for (const failure of ['refused', 'offline', 'unreachable', 'unreadable'] as const) {
      const tree = mountAccounts({balances: solanaDownWith(failure)});
      expect(textOf(tree, 'rail-unreadable-solana')).toBe(M.errors.rail[failure]('Solana'));
      expect(countOf(tree, 'rail-unreadable-solana')).toBe(1); // still ONE banner (X9), cause or not
      act(() => { tree.unmount(); });
    }
  });

  test('an error with NO classified cause renders the unreadable sentence (back-compat default)', () => {
    // `failure` is optional end to end (a view built before R3, a hook state that predates the
    // field): the note must fall back to a sentence — never an empty string, never a crash — and
    // the honest default is the one that makes no claim about WHY.
    const tree = mountAccounts({balances: solanaDown()}); // the pre-R3 fixture: 'error' with no failure
    expect(textOf(tree, 'rail-unreadable-solana')).toBe(M.errors.rail.unreadable('Solana'));
    act(() => { tree.unmount(); });
  });
});

describe('R3 audit — token-cause banner, offline chrome, and the tappable escape', () => {
  /** The note node (first render), host or composite — the OUTERMOST `rail-unreadable-solana`. */
  const noteNode = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props?.testID === 'rail-unreadable-solana')[0];

  test("SOL fine but a token in error: the banner reads the TOKEN row's classified cause", () => {
    // AccountsTab emits the banner above the FIRST affected row and feeds it THAT row's view — so
    // when SOL polls ok while a token errs with 'offline', the banner's cause is the token's, not
    // SOL's (which has none to give). This pins the selection rule the audit asked to be verified:
    // a token-only error DOES get a banner, and it carries the token's failure verbatim.
    const mints = ASSETS.flatMap(a => (a.protocol === 'solana' && a.mint != null ? [a.mint] : []));
    expect(mints.length).toBeGreaterThanOrEqual(2); // SOL is not a mint row; USDC + EURC are
    type TokState = {amount: string | null; decimals: number | null; status: 'absent' | 'error'; failure?: SolanaReadFailure};
    const tokenStates: Record<string, TokState> = Object.fromEntries(
      mints.map(m => [m, {amount: null, decimals: null, status: 'absent'}]),
    );
    const usdcAsset = ASSETS.flatMap(a => (a.protocol === 'solana' && a.symbol === 'USDC' ? [a] : []))[0];
    const usdcMint = usdcAsset?.mint ?? '';
    expect(usdcMint).not.toBe(''); // the registry pins the USDC mainnet mint on the row
    expect(mints).toContain(usdcMint);
    tokenStates[usdcMint] = {amount: null, decimals: null, status: 'error', failure: 'offline'};
    const balances = buildAssetBalances({
      catalog: CATALOG,
      assets: ASSETS,
      icBalances: {7: '120000000'},
      primaryBalance: '12345',
      online: true,
      solState: {balance: '1500000000', status: 'ok'},
      tokenStates,
    });
    const tree = mountAccounts({balances});
    expect(textOf(tree, 'rail-unreadable-solana')).toBe(M.errors.rail.offline('Solana'));
    expect(countOf(tree, 'rail-unreadable-solana')).toBe(1); // still ONE banner for the network
    act(() => { tree.unmount(); });
  });

  test("offline renders in the NEUTRAL register — C.sub, never C.warn (no one's fault)", () => {
    const tree = mountAccounts({balances: solanaDownWith('offline')});
    const note = noteNode(tree);
    const text = note.findAllByType(Text)[0];
    // The style override array is the pin: the base rail style PLUS the neutral color.
    expect(text.props.style).toEqual([S.railHealthText, {color: C.sub}]);
    const icon = note.findAllByType(IconAlert)[0];
    expect(icon.props.color).toBe(C.sub); // the icon follows the register (layout continuity kept)
    act(() => { tree.unmount(); });
  });

  test('the other three causes keep the ALARM register (C.warn)', () => {
    for (const failure of ['refused', 'unreachable', 'unreadable'] as const) {
      const tree = mountAccounts({balances: solanaDownWith(failure)});
      const note = noteNode(tree);
      expect(note.findAllByType(Text)[0].props.style).toBe(S.railHealthText); // no override array
      expect(note.findAllByType(IconAlert)[0].props.color).toBe(C.warn);
      act(() => { tree.unmount(); });
    }
  });

  test('unreachable + onOpenSettings renders the row as the tappable Settings escape — and ONLY then', () => {
    // The founder UX directive: the unreachable copy names Settings ▸ Advanced, so that variant is
    // actionable. The tap target is the OUTERMOST element (same testID), announced as a button
    // with a hint; every OTHER cause stays a plain fact — and unreachable without the wiring does
    // too, so existing callers/tests mount unchanged.
    const wired = mountAccounts({balances: solanaDownWith('unreachable'), onOpenSettings: jest.fn()});
    const wiredNote = noteNode(wired);
    expect(wiredNote.props.accessibilityRole).toBe('button');
    expect(wiredNote.props.accessibilityHint).toBe(M.errors.rail.unreachableHint('Solana'));
    expect(typeof wiredNote.props.onPress).toBe('function');
    expect(wiredNote.props.testID).toBe('rail-unreadable-solana');
    act(() => { wired.unmount(); });

    for (const failure of ['refused', 'offline', 'unreadable'] as const) {
      const tree = mountAccounts({balances: solanaDownWith(failure), onOpenSettings: jest.fn()});
      const note = noteNode(tree);
      expect(note.props.accessibilityRole).toBeUndefined(); // a fact, not a button
      expect(note.props.onPress).toBeUndefined();
      act(() => { tree.unmount(); });
    }
    // …and unreachable WITHOUT the wiring stays plain (optional prop, back-compat).
    const unwired = mountAccounts({balances: solanaDownWith('unreachable')});
    expect(noteNode(unwired).props.onPress).toBeUndefined();
    act(() => { unwired.unmount(); });
  });

  test('tapping the unreachable note fires onOpenSettings (the escape is wired, not decorative)', () => {
    const onOpenSettings = jest.fn();
    const tree = mountAccounts({balances: solanaDownWith('unreachable'), onOpenSettings});
    act(() => { noteNode(tree).props.onPress(); });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    act(() => { tree.unmount(); });
  });
});
