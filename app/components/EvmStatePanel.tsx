// EvmStatePanel — the EVM record view: the §4 machine's EVM-shaped states (the SolStatePanel
// mirror, 2026-09-28). The executor signs the legs at drive time, so `swapping` is the signing
// + broadcast window; `settling` is the realized-balance read; done/failed/stuck are the
// honest edges. Same rules as every state panel: the numbers are the venue's own digits, the
// payout shown on done is the REALIZED chain credit (never the estimate).
import {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {venueDisplayName} from '../config/venues';
import {evmAmmChainOf} from '../config/evmAmm';
import type {ConvertRecord} from '../convert';
import {acknowledgeStuckRecord} from '../convertResume';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {ConvertHeader} from './ConvertShared';
import {ConvertStuckReceipts} from './ConvertStuckEvidence';
import {stuckLastCheckedAtMs} from '../convert/stuckProbeLog';
import {formatClock} from '../i18n/intl';

export function EvmStatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (record.step === 'stuck') {
      const t = setInterval(() => forceTick(n => n + 1), 30_000);
      return () => clearInterval(t);
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.step]);

  const venueName = venueDisplayName(record.venueId);
  const chainName = evmAmmChainOf(record.venueId)?.name ?? `chain ${record.evmSwap?.chainId ?? ''}`;
  const outDec = record.outDecimals ?? 18;
  const fmtOut = (raw: string) => fmtAssetCompact(raw, outDec, record.outSymbol);
  const fmtIn = (raw: string) => fmtAssetCompact(raw, record.inDecimals ?? 18, record.inSymbol);
  const detail = record.failureDetail ?? '';
  const legs = record.evmSwap?.txHashes ?? [];

  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.evm.heading(record.inSymbol, record.outSymbol, chainName)} onBack={onBack} />

      {record.step === 'swapping' ? (
        <View testID="convert-swapping">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.swappingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.swappingBody(venueName)}</Text>
          {legs.length > 0 ? <Text style={S.convertStateMeta}>{M.convert.doneTx(legs[legs.length - 1]!)}</Text> : null}
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
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtOut(record.outAmountNet ?? record.expectedNet))}</Text>
          {record.outTx != null && record.outTx !== '' ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.evm.failedBody(record.inSymbol, detail)}</Text>
          {legs.length > 0 ? <Text style={S.convertStateMeta}>{M.convert.doneTx(legs[0]!)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.evm.stuckBody(record.outSymbol)}</Text>
          <Text style={S.convertStateBody}>{M.convert.stuckSigned(fmtIn(record.amountIn), fmtOut(record.expectedNet), venueName)}</Text>
          {legs.length > 0 ? <Text style={S.convertStateMeta}>{M.convert.doneTx(legs[legs.length - 1]!)}</Text> : null}
          {/* The receipts block (2026-10-02 POCO P0): each broadcast leg + any failure cause,
              verbatim — never a bare "unknown". (No "keeps watching" claim: an EVM-shaped
              record has no engine probe of its own yet — only facts.) */}
          <ConvertStuckReceipts record={record} />
          {(() => {
            const at = stuckLastCheckedAtMs(record.id);
            return at != null ? (
              <Text testID="convert-stuck-last-checked" style={S.convertStateMeta}>
                {M.convert.stuckLastCheckedLine(formatClock(new Date(at)))}
              </Text>
            ) : null;
          })()}
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
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
