// SolStatePanel — the Solana record view: the §4 machine's Solana-shaped states (swapping →
// settling → done, with the honest edges). Extracted verbatim from ConvertMode.tsx
// (2026-09-21 decomposition).
import {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {venueDisplayName} from '../config/venues';
import type {ConvertRecord} from '../convert';
import {acknowledgeStuckRecord} from '../convertResume';
import {SOLANA_TOKENS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {ConvertHeader} from './ConvertShared';

/** The Solana record view: the §4 machine's Solana-shaped states only (swapping → settling →
 *  done, with pending_withdrawal/failed_refunded/stuck for the honest edges). Same rules as
 *  StatePanel: it renders the engine's record — the numbers are the venue's own digits, the
 *  payout shown on done is the REALIZED chain credit (never the estimate). */
export function SolStatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (record.step === 'stuck' || record.step === 'pending_withdrawal') {
      const t = setInterval(() => forceTick(n => n + 1), 30_000);
      return () => clearInterval(t);
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.step]);

  const venueName = venueDisplayName(record.venueId);
  const outDec = record.outDecimals ?? 8;
  const fmtOut = (raw: string) => fmtAssetCompact(raw, outDec, record.outSymbol);
  const fmtIn = (raw: string) => fmtAssetCompact(raw, record.inDecimals ?? 8, record.inSymbol);
  const solFeeLine = record.solFeeLamports != null
    ? M.convert.sol.solFeeLine(fmtAssetCompact(record.solFeeLamports, SOLANA_TOKENS.SOL.decimals, WRAPPED_SOL_TOKEN))
    : null;

  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.sol.heading(record.inSymbol, record.outSymbol)} onBack={onBack} />

      {record.step === 'swapping' ? (
        <View testID="convert-swapping">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.swappingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.swappingBody(venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'settling' ? (
        <View testID="convert-settling">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.settlingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.settlingBody(record.outSymbol)}</Text>
        </View>
      ) : null}
      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
          {/* The realized chain credit — the record's outAmountNet (filled by the driver from
              the transaction's own token-balance delta), the venue floor only as the fallback. */}
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtOut(record.outAmountNet ?? record.expectedNet))}</Text>
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          {/* sol.pendingBody already carries the watch fact ("resolves on its own") —
              a second watching line stacked meta on meta (round-2 verbosity validation). */}
          <Text style={S.convertStateBody}>{M.convert.sol.pendingBody}</Text>
        </View>
      ) : null}
      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.sol.failedBody(record.inSymbol, venueName, record.failureDetail ?? '')}</Text>
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.stuckBody}</Text>
          {/* What was signed, restated: the amount in and the VENUE'S own floor (expectedNet is
              Jupiter's otherAmountThreshold frozen at prepare — not a re-derived figure). */}
          <Text style={S.convertStateBody}>{M.convert.stuckSigned(fmtIn(record.amountIn), fmtOut(record.expectedNet), venueName)}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stuckWatching}</Text>
          {record.acknowledgedStuckAtMs == null ? (
            <Pressable
                testID="btn-convert-stuck-ack"
                style={S.primary}
                onPress={() => {
                  acknowledgeStuckRecord(record.id);
                }}
                accessibilityRole="button"
              >
                <Text style={S.primaryText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            ) : (
              <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
            )}
        </View>
      ) : null}
      {/* The fee census on every state panel (the IC stuck panel's rule): the realized network
          fee quoted by the chain before signing. dpay's nothing-charged line is GONE everywhere
          (10x-verbosity pass 2026-09-16). */}
      {solFeeLine != null ? (
        <Text testID="convert-sol-fee" style={S.convertMetaLine}>{solFeeLine}</Text>
      ) : null}
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
