import {describe, test, expect} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildSelectableAssets, resolvePayLink} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import {parseSolanaPayUri} from '../solana/payUri';
import {USDC_MINT_ADDRESS} from '../solana/spl';
import type {PayLink} from '../lib/deepLink';

/**
 * The never-override pin (Objective 2, S5). A payment that NAMES its rail — a shared payment
 * link, an OpenCryptoPay request, a Solana Pay URI, a scanned wire/NFC request — must settle on
 * exactly the rail it names. The wallet's own rail CHOICE (`chooseRail` and its helpers in
 * config/currency.ts) exists ONLY on spend surfaces the user drives interactively (the
 * fund-first gates, the Send route line); it must be unreachable from every pinned path. This
 * suite pins that two ways: structurally (the pinned surfaces' sources contain no spend-side
 * chooser token and no config/currency import at all — assets.ts cannot even import it, the
 * import would be circular) and behaviorally (a link naming USDC@Solana resolves to the NAMED
 * rail while ckUSDC is both the group's preferred rail and funded).
 *
 * The structural pin is deliberately text-based: the moment someone wires `chooseRail` (or any
 * future spend-side rail helper) into a pinned path, the forbidden token appears in that file and
 * this suite fails before a device ever sees a misrouted payment.
 */
const PINNED_SOURCES: Record<string, string> = {
  'config/assets.ts (resolvePayLink — every payment link)': join(__dirname, '..', 'config', 'assets.ts'),
  'lib/opencryptopay.ts (OCP link grammar)': join(__dirname, '..', 'lib', 'opencryptopay.ts'),
  'services/opencryptopay.ts (OCP resolve/review)': join(__dirname, '..', 'services', 'opencryptopay.ts'),
  'services/rail.ts (wire/NFC request)': join(__dirname, '..', 'services', 'rail.ts'),
  'solana/payUri.ts (Solana Pay URI)': join(__dirname, '..', 'solana', 'payUri.ts'),
};

/** The spend-side rail-choice tokens from config/currency.ts. */
const SPEND_SIDE_CHOOSER = /chooseRail|currencyRails|railLineLabel|railFees|preferredRail/;
/** Any import of the currency module — the module path in an import position (prose comments
 *  that merely NAME the module stay legal; an import is what builds the call graph). */
const CURRENCY_IMPORT = /from ['"][^'"]*currency['"]/;

describe('never-override: pinned payment paths cannot reach the spend-side rail chooser', () => {
  for (const [label, path] of Object.entries(PINNED_SOURCES)) {
    test(`${label} carries no rail-choice token`, () => {
      const src = readFileSync(path, 'utf8');
      expect(src).not.toMatch(SPEND_SIDE_CHOOSER);
      expect(src).not.toMatch(CURRENCY_IMPORT);
    });
  }

  const CATALOG = icpCatalogOf(BUNDLED_NETWORKS);
  const ASSETS = buildSelectableAssets(CATALOG, {showTestnet: false, solanaEnabled: true, solanaUsdc: true});
  const DEST = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

  test('a link naming USDC@Solana resolves to the NAMED rail, not the preferred/funded ckUSDC', () => {
    const link: PayLink = {recipient: DEST, asset: 'USDC', network: 'solana', amount: '2.5', label: 'Cafe', memo: '', ref: null};
    const res = resolvePayLink(link, ASSETS, CATALOG);
    expect(res).toEqual({ok: true, target: {asset: expect.objectContaining({id: 'solana:USDC'}), rawAmount: '2500000', link}});
  });

  test('the same token on the OTHER named network stays on that network — network drives the pick', () => {
    const link: PayLink = {recipient: DEST, asset: 'USDC', network: 'internet-computer', amount: '2.5', label: '', memo: '', ref: null};
    expect(resolvePayLink(link, ASSETS, CATALOG)).toEqual({ok: false, err: 'wrong_network'});
  });

  test('a Solana Pay URI naming the USDC mint parses to exactly that request — no rail resolution happens', () => {
    const scan = parseSolanaPayUri(`solana:${DEST}?amount=2.5&spl-token=${USDC_MINT_ADDRESS}`);
    expect(scan).toEqual({
      ok: true,
      request: {recipient: DEST, amount: '2.5', splToken: USDC_MINT_ADDRESS, references: [], label: null, message: null, memo: null},
    });
  });
});
