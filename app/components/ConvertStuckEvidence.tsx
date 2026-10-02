// ConvertStuckEvidence — the stuck surfaces' shared evidence block (2026-10-02 POCO P0).
//
// The founder's device showed a stuck record with NO per-step facts and NO error: "Unknown
// outcome" + a watching claim, nothing else. Hard rules baked into this component, shared by
// ALL six stuck surfaces (the one receipts builder, DRY):
//  - the per-leg receipts block ALWAYS renders from the record's own frozen facts — the user
//    sees WHAT happened per leg, never just "unknown";
//  - every tx/block identity the record carries renders (hop/dest/payout/refund/deposit rows,
//    burn + forward hashes, broadcast hashes, the Solana signature);
//  - a carried failureDetail/err renders VERBATIM (convert-stuck-error) — never hidden.
//
// Render facts only: rows state what the record states; nothing is inferred about outcomes.
import {Text, View} from 'react-native';
import {venueDisplayName} from '../config/venues';
import type {ConvertRecord, LegPlan} from '../convert';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {S} from '../styles';
import {plannedLegFee, plannedLegLabel} from './ConvertShared';
import {recordLegExpiryMs, stuckExpiryDue} from '../convert/stuckExpiry';

export {recordLegExpiryMs, stuckExpiryDue};

/** The expiry flip the panels render: window open → today's line; expired → the honest
 *  nothing-can-move-anymore block. Only IC envelopes carry a wall-clock window (a Solana
 *  leg dies at a block height, an EVM deadline is engine-side), so the flip exists only
 *  where an expiry line already renders. */
export function stuckWindowExpired(record: ConvertRecord): boolean {
  return stuckExpiryDue(record);
}

type StuckLegRow = {
  key: string;
  label: string;
  state: LegPlan['state'];
  fee: string | null;
  evidence?: string;
};

/** Per-leg facts from the record's own frozen vocabulary. For planned records the leg plan
 *  IS the truth (the executor froze each state); for shapes without a plan (direct, Solana,
 *  EVM) the rows name the legs and their submitted state — "sent" is the one state the
 *  record can honestly claim (the bytes were submitted; the outcome is the unknown the
 *  stuck state names). */
export function convertStuckLegs(record: ConvertRecord): StuckLegRow[] {
  const venueName = venueDisplayName(record.venueId);
  const ordinalOf = (plan: NonNullable<ConvertRecord['legPlan']>, i: number) =>
    plan.slice(0, i).filter(x => x.kind === 'swap').length;
  if (record.legPlan != null) {
    return record.legPlan.map((lp, i) => {
      const leg = record.legs[i];
      const canister = leg?.canister ?? lp.canister;
      return {
        key: `plan-${i}`,
        label: plannedLegLabel(record, lp, canister, venueName, ordinalOf(record.legPlan!, i)),
        state: lp.state,
        fee: plannedLegFee(record, lp, canister),
        evidence: leg?.requestIdHex,
      };
    });
  }
  if (record.solanaLeg != null) {
    const label = record.chainRoute != null
      // A chain phase-1 record's unknown is the venue DEPOSIT transfer's (D32).
      ? M.convert.depositLegSent(venueDisplayName(record.chainRoute.venueId),
        fmtAssetCompact(record.amountIn, record.inDecimals ?? 9, record.inSymbol))
      : record.crossRail?.kind === 'cctp_sol'
        ? M.convert.crossrail.legSolSwap(venueDisplayName(record.crossRail.solVenueId ?? record.venueId), record.destSymbol ?? record.outSymbol)
        : M.convert.multihop.legSwap(venueName, record.inSymbol, record.outSymbol);
    return [{key: 'sol', label, state: 'sent', fee: null, evidence: record.solanaLeg.signature}];
  }
  if (record.evmSwap != null) {
    const hashes = record.evmSwap.txHashes ?? [];
    return hashes.map((h, i) => ({
      key: `evm-${i}`,
      label: i === 0
        ? M.convert.multihop.legApprovePull(record.inSymbol)
        : M.convert.multihop.legSwap(venueName, record.inSymbol, record.outSymbol),
      state: 'sent' as const,
      fee: null,
      evidence: h,
    }));
  }
  // Direct IC shape (no plan): the approve + swap the user signed, in order.
  return record.legs.map((leg, i) => ({
    key: `leg-${i}`,
    label: i === 0
      ? M.convert.multihop.legApprovePull(record.inSymbol)
      : M.convert.multihop.legSwap(venueName, record.inSymbol, record.outSymbol),
    state: 'sent' as const,
    fee: null,
    evidence: leg.requestIdHex,
  }));
}

/** The record-level tx/block evidence, in the order the money moved. */
function convertStuckEvidenceLines(record: ConvertRecord): string[] {
  const ids: Array<string | undefined> = [
    record.hopTx,
    record.destTx,
    record.composedDeposit?.sentTx,
    record.crossRail?.burnTxHash,
    record.crossRail?.forwardTxHash,
    record.outTx,
    record.refundTx,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id != null && id !== '' && !seen.has(id)) {
      seen.add(id);
      out.push(M.convert.doneTx(id));
    }
  }
  return out;
}

const legStateText = (s: LegPlan['state']) =>
  s === 'pending' ? M.convert.multihop.legStatePending
  : s === 'sent' ? M.convert.multihop.legStateSent
  : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
  : M.convert.multihop.legStateFailed;

/** The receipts block every stuck surface mounts. Styles are the shared state-panel meta
 *  vocabulary so the same block reads correctly inside the sheet AND the panels. */
export function ConvertStuckReceipts({record}: {record: ConvertRecord}) {
  const rows = convertStuckLegs(record);
  const evidence = convertStuckEvidenceLines(record);
  return (
    <View testID="convert-stuck-receipts">
      <Text style={S.convertStateMeta}>{M.convert.stuckReceiptsTitle}</Text>
      {rows.map((r, i) => (
        <View key={r.key} testID={`convert-stuck-leg-${i}`}>
          <Text style={S.convertChecklistLine}>{r.label}</Text>
          <Text testID={`convert-stuck-leg-${i}-state`} style={r.state === 'failed' ? [S.convertStateMeta, S.convertLegStateBad] : S.convertStateMeta}>
            {r.fee != null ? `${legStateText(r.state)} · ${r.fee}` : legStateText(r.state)}
          </Text>
          {r.evidence != null && r.evidence !== '' ? (
            <Text style={S.convertStateMeta} selectable>{M.convert.doneTx(r.evidence)}</Text>
          ) : null}
        </View>
      ))}
      {evidence.map((line, i) => (
        <Text key={`ev-${i}`} style={S.convertStateMeta} selectable>{line}</Text>
      ))}
      {record.failureDetail != null && record.failureDetail !== '' ? (
        <Text testID="convert-stuck-error" style={S.convertChecklistWarn} selectable>
          {M.convert.stuckErrorLine(record.failureDetail)}
        </Text>
      ) : null}
    </View>
  );
}
