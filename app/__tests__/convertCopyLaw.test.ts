/**
 * The COPY LAW pin (spec 2026-10-04-convert-ux-rework §3) - the test that makes F1 impossible
 * to re-introduce: it walks EVERY convert template in ALL FOUR locales, calls each with
 * probing arguments (a venue brand, a canister-id-shaped pool, real-shaped amounts), and
 * asserts the law on the rendered line:
 *
 *   PRIMARY lines (the open card, the progress story, the terminal cards) contain
 *     - NO canister-id-shaped string  (/[0-9a-z]{5}-[0-9a-z]{5}/)
 *     - NO venue brand name           (the registries' display names)
 *     - NO approve/withdraw/burn/attest jargon (plain verbs only)
 *   EVERY line (Details included) carries no em-dash - plain hyphens only.
 *
 * Keys rendered only inside a collapsed Details/Options disclosure, the destination-picker
 * mechanism rows, the external-wallet handoff (a machine surface the user signs against), or
 * the stuck-receipts audit block are classified DETAILS_ONLY and exempt from the brand/id/
 * jargon arms - still never an em-dash.
 */
import {describe, expect, test} from '@jest/globals';
import {convertEn} from '../i18n/domains/en/convert';
import {convertDe} from '../i18n/domains/de/convert';
import {convertEs} from '../i18n/domains/es/convert';
import {convertFr} from '../i18n/domains/fr/convert';

const CANISTER_SHAPE = /[0-9a-z]{5}-[0-9a-z]{5}/;
const BRANDS = /ICPSwap|SideShift|Trocador|Jupiter|Circle|CoW|Uniswap|sideshift\.ai|trocador\.app/i;
const JARGON = /\b(approve|approves|approved|approving|withdraw|withdraws|withdrawing|withdrawal|burn|burns|burning|attest|attests|attesting|attestation)\b/i;
const EM_DASH = /[—–]/;

/** Keys rendered ONLY behind a collapsed disclosure, in a picker/handoff machine surface,
 *  or in the stuck receipts block. Everything else is PRIMARY and gets the full law. */
const DETAILS_ONLY = new Set<string>([
  // the sheet's Details census
  'counterparty', 'counterpartySigns', 'quoteSource', 'quoteVerbatim', 'rateLabel',
  'poolFeeTier', 'inputFeeLine', 'outputFeeLine', 'slippageLabel', 'refusalLine',
  'autoVenueLine',
  'disclosures', // the whole byKey/generic subtree
  // Solana machine census
  'sol.counterparty', 'sol.counterpartySigns', 'sol.priceImpactLine', 'sol.solFeeLine',
  'sol.refusalLine',
  // EVM census
  'evm.feeLabel',
  'cow.feeLine', 'cow.protocolFeeLine',
  // multi-hop census + destination-picker mechanism rows (the Options surface)
  'multihop.legApprovePull', 'multihop.legSwap', 'multihop.legApproveBurn',
  'multihop.legApproveGas', 'multihop.legWithdraw',
  'multihop.destDirect', 'multihop.destRoute', 'multihop.destRouteSol',
  'multihop.destInWallet', 'multihop.destGroupOther',
  'multihop.mechDirect', 'multihop.mechViaHub', 'multihop.mechViaCctp',
  'multihop.mechViaVenue', 'multihop.mechNoneSelected', 'multihop.hubShape',
  'multihop.hubQuoteSource', 'multihop.hubCensusHeading', 'multihop.approveFeeLine',
  'multihop.hubRateLine', 'multihop.hubSurplusNote', 'multihop.routeVenues',
  'multihop.routeDestEstimate', 'multihop.gasFeeLine', 'multihop.routeSurplusNote',
  // CeFi: counterparty census, checklist sentences, deposit handoff notes, order handles
  'cefi.counterparty', 'cefi.checklistSigns', 'cefi.checklistSignsAuto',
  'cefi.depositNote', 'cefi.depositAutoNote', 'cefi.shiftId', 'cefi.refusalLine',
  'cefi.destRow', 'cefi.destRowMulti',
  // chain: the order narration block (under Details)
  'chain.orderLine', 'chain.phase2Leg', 'chain.rowShape',
  // cross-rail: the external-wallet handoff is a machine surface (raw bytes on the page)
  'crossrail.handoffIntro', 'crossrail.stepApproveLabel', 'crossrail.stepBurnLabel',
  'crossrail.approveHint', 'crossrail.burnHint', 'crossrail.timingNote',
  'crossrail.externalGasLine', 'crossrail.circleFeeLine', 'crossrail.mintFloorLine',
  'crossrail.mintFloorDestLine', 'crossrail.whatSigning', 'crossrail.viewBurnTx',
  'crossrail.burnTxLabel', 'crossrail.burnTxPlaceholder', 'crossrail.attachButton',
  'crossrail.viewCircle', 'crossrail.solQuoteLabel', 'crossrail.legCctpBurn',
  'crossrail.legSolSwap',
  'crossrail.doneVia',
  // the composed order block (under Details while it is not the active leg)
  'composedOrderLine',
  // the stuck receipts' verbatim error line (the venue's own words, founder rule)
  'stuckErrorLine',
]);

const DOMAINS: Array<[string, unknown]> = [
  ['en', convertEn], ['de', convertDe], ['es', convertEs], ['fr', convertFr],
];

const isDetailsOnly = (path: string): boolean =>
  DETAILS_ONLY.has(path) || [...DETAILS_ONLY].some(k => path.startsWith(`${k}.`));

function checkLine(path: string, line: string, violations: string[]): void {
  if (EM_DASH.test(line)) violations.push(`${path}: em-dash in "${line}"`);
  if (isDetailsOnly(path)) return;
  if (CANISTER_SHAPE.test(line)) violations.push(`${path}: canister-id shape in "${line}"`);
  if (BRANDS.test(line)) violations.push(`${path}: venue brand in "${line}"`);
  if (JARGON.test(line)) violations.push(`${path}: jargon in "${line}"`);
}

/** The probe a parameter receives, keyed by its name. Venue args get the BRAND (a primary
 *  line that renders its venue argument fails); pool args get a canister-id shape; address
 *  args get a payout-shaped 0x string (the 'where the money lands' fact stays legal on
 *  terminal receipts - the ban is canister-id-shaped strings, not the user's own address). */
function probeFor(param: string): string | number {
  const p = param.toLowerCase();
  if (p === 'n' || p === 'n1' || p === 'n2') return 2;
  if (p === 'venue' || p === 'venue1' || p === 'venue2') return 'ICPSwap';
  if (p === 'pool') return 'aaaaa-bbbbb';
  if (p === 'address' || p === 'ata') return '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
  if (p === 'at') return '2:59 PM';
  if (p === 'ref' || p === 'tx' || p === 'id' || p === 'hash') return 'deadbeef00';
  if (p === 'd') return 'boom';
  if (p === 'tier' || p === 'bps' || p === 'pct') return '0.30%';
  if (p === 'unit') return 'ETH';
  if (p === 'detail') return 'boom';
  return 'X';
}

/** Call one template with probes for every parameter. Params arrive either parenthesised
 *  (`(venue, amt) =>`) or bare (`venue =>`) - parse both; never args-less. */
function callTemplate(fn: (...args: unknown[]) => unknown): string {
  const src = fn.toString();
  const bare = src.match(/^\s*([A-Za-z_$][\w$]*)\s*=>/);
  const paren = src.match(/^\s*\(([^)]*)\)\s*=>/);
  const params = bare != null
    ? [bare[1]!]
    : paren != null && paren[1]!.trim() !== ''
      ? paren[1]!.split(',').map(s => s.trim().split(/[:=]/)[0]!.trim())
      : [];
  const args = params.map(p => probeFor(p));
  return String(fn(...args));
}

describe('the convert copy law (spec 2026-10-04 §3), every locale', () => {
  for (const [locale, domain] of DOMAINS) {
    test(`${locale}: primary lines carry no canister ids, venue brands, or jargon; no line carries an em-dash`, () => {
      const violations: string[] = [];
      const walk = (obj: unknown, path: string): void => {
        if (obj == null) return;
        if (typeof obj === 'function') {
          const line = callTemplate(obj as (...args: unknown[]) => unknown);
          checkLine(path, line, violations);
          return;
        }
        if (typeof obj === 'string') {
          checkLine(path, obj, violations);
          return;
        }
        if (typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            walk(v, path === '' ? k : `${path}.${k}`);
          }
        }
      };
      walk(domain, '');
      expect(violations).toEqual([]);
    });
  }

  test('the DETAILS_ONLY classification never drifts: every named key exists in en', () => {
    const has = (path: string): boolean => {
      let cur: unknown = convertEn;
      for (const part of path.split('.')) {
        if (cur == null || typeof cur !== 'object') return false;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur != null;
    };
    const missing = [...DETAILS_ONLY].filter(k => !has(k));
    expect(missing).toEqual([]);
  });
});
