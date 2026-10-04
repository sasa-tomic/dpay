// ConvertRouteStatePanel — the planned-record state surface for composed routes (the leg
// list IS the progress UI). Extracted verbatim from ConvertMode.tsx (2026-09-21
// decomposition) — it previously sat as a column-0 nested declaration inside the ConvertMode
// body; hoisting it to module scope changes no behavior. One component, not split internally.
import {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {venueDisplayName} from '../config/venues';
import type {ConvertRecord, LegPlan} from '../convert';
import {acknowledgeStuckRecord} from '../convertResume';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {
  ConvertHeader,
  activeLegExpiryMs,
  LEG_DONE_MARKER,
  legRowMood,
  pendingPayoutViewOf,
  plannedLegFee,
  plannedLegLabel,
  routeTitleOf,
} from './ConvertShared';
import {ConvertStuckReceipts, stuckWindowExpired} from './ConvertStuckEvidence';
import {stuckLastCheckedAtMs} from '../convert/stuckProbeLog';

/** The planned-record state surface (2026-09-14 spec §7): the leg list IS the progress UI —
 *  every leg carries its own pending/sent/confirmed/refused state and its own fee, and the
 *  step copy above it names what is running and, on every dead-end, exactly what the user
 *  holds and which door is the way out. */
export function RouteStatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  // stuck/pending states show when the leg envelopes expire — a 30 s tick keeps that honest.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  const inDecimals = record.inDecimals ?? 8;
  const hopDecimals = record.hopDecimals ?? record.outDecimals ?? 8;
  const hopSymbol = record.hopSymbol ?? record.outSymbol;
  const destSymbol = record.destSymbol ?? record.outSymbol;
  const venueName = venueDisplayName(record.venueId);
  // The stuck-evidence clock (the leg-0 envelope's death, verbatim history) vs the ACTIVE
  // leg's binding deadline the live bodies show (2026-10-04 composed-truth fix).
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.createdAtMs;
  const activeExpiryMs = activeLegExpiryMs(record);
  const legStateText = (s: LegPlan['state']) =>
    s === 'pending' ? M.convert.multihop.legStatePending
    : s === 'sent' ? M.convert.multihop.legStateSent
    : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
    : M.convert.multihop.legStateFailed;
  // D15: the top block tracks the CURRENT leg — the first non-confirmed leg in the frozen
  // plan. Pure render, so it stays correct regardless of executor choreography: a confirmed
  // leg never comes back, and the first open leg IS where the intent actually is.
  const legPlan = record.legPlan ?? [];
  const activeLegIndex = legPlan.findIndex(lp => lp.state !== 'confirmed');
  const activeLeg = activeLegIndex >= 0 ? legPlan[activeLegIndex] : null;
  const swapOrdinalOf = (i: number): number => legPlan.slice(0, i).filter(x => x.kind === 'swap').length;
  // S3: the active leg's own plain label - never a "Step n of m" counter.
  const stepLine = activeLeg != null
    ? plannedLegLabel(record, activeLeg, activeLeg.canister, venueName, swapOrdinalOf(activeLegIndex))
    : null;
  return (
    <View testID="convert-state" style={S.convertWrap}>
      {/* Planned records ARE the composed route — the header must name it (ICP → USDC → USDC on
          Ethereum), never the direct pair the screen was opened from (UX pass 2026-09-15).
          HUB records keep the plain selection heading: the destination is this wallet's own
          asset, and a route line would hang on an empty network name (D12). */}
      <ConvertHeader
        title={record.venue2Id != null
          ? M.convert.heading(record.inSymbol, destSymbol)
          : record.legPlan != null
            ? routeTitleOf(record, hopSymbol, destSymbol)
            : M.convert.heading(record.inSymbol, record.outSymbol)}
        onBack={onBack}
      />

      {/* D15: "Step 2 of 4 — Swapping VCHF → ICP on ICPSwap" — counter plus the leg's own
          label, always visible above the phase block. */}
      {stepLine != null ? (
        <Text testID="convert-step" style={S.convertMetaLine}>{stepLine}</Text>
      ) : null}

      {record.step === 'approving' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), formatClock(new Date(activeExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'pending_withdrawal' ? (() => {
        // ONE ACTIVE LEG (2026-10-04 composed-truth fix): the body names the payout the
        // executor is actually probing - a queued cefi leg keeps the pool-watch copy, a
        // hub record's second swap names ITS OWN dest pool, and the direct shape keeps
        // the payout template with the record's own pool.
        const view = pendingPayoutViewOf(record);
        return (
          <View testID="convert-pending">
            <ActivityIndicator size="large" color={C.brandText} />
            {view.kind === 'pool-watch' ? (
              <>
                <Text style={S.convertStateTitle}>{M.convert.awaitingPool}</Text>
                <Text style={S.convertStateBody}>{M.convert.settlingBody(view.sym)}</Text>
              </>
            ) : (
              <>
                <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
                <Text style={S.convertStateBody}>{M.convert.pendingBody(view.sym)}</Text>
              </>
            )}
            <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
            <Text testID="convert-expiry" style={S.convertStateMeta}>
              {M.convert.expiryLine(formatClock(new Date(activeExpiryMs)))}
            </Text>
          </View>
        );
      })() : null}

      {record.step === 'done' ? (
        record.venue2Id != null ? (
          // D17: a hub destination IS in this wallet — the direct flow's "Converted /
          // received in your wallet" copy with the SEEN payout amount and the dest-ledger
          // payout record. No address, and the cash-out "on its way" family must not leak.
          <View testID="convert-done">
            <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
            <Text style={S.convertStateBody}>
              {M.convert.doneBody(fmtAssetCompact(
                record.outAmountNet ?? record.expectedNet2 ?? '0',
                record.destDecimals ?? hopDecimals, destSymbol))}
            </Text>
            {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
          </View>
        ) : (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.multihop.doneRouteTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.multihop.doneRouteBody(fmtAssetCompact(record.outAmountNet ?? '0', hopDecimals, destSymbol), record.destAddress ?? '')}
          </Text>
          {/* Delivery on Ethereum is asynchronous and unwitnessable from IC (spec §4): the
              honest terminal says ON ITS WAY and what evidence exists — never "received". */}
          <Text style={S.convertStateMeta}>{M.convert.multihop.doneOnItsWay}</Text>
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
        )
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          {record.failureCode === 'approve_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedApproveBody(record.inSymbol)}</Text>
          ) : record.failureCode === 'window_closed' ? (
            // The stuck-expiry resolution (2026-10-02): unconfirmed past the deadline,
            // nothing left the wallet — never a phantom "the pool returned it".
            <>
              <Text style={S.convertStateBody}>{M.convert.failedWindowClosedBody(record.inSymbol)}</Text>
              {record.failureDetail != null && record.failureDetail !== '' ? (
                <Text style={S.convertStateMeta} selectable>{M.convert.stuckErrorLine(record.failureDetail)}</Text>
              ) : null}
            </>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol)}</Text>
          )}
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        record.venue2Id != null ? (
          // D18: ONE terminal meaning for a hub refusal — a completed swap is BEHIND you,
          // the rest refused, and the funds are the named HUB asset in THIS wallet. The exit
          // is that asset's own surfaces (keep / convert from its own account / send); the
          // cash-out exit would name Pay ▸ Send-to-address, the wrong door. A leg-3 approve
          // refusal (the hub ledger refusing the allowance) lands here too, with the hub
          // ledger's own reason.
          <View testID="convert-failed-leg">
            <Text style={S.convertStateTitle}>{M.convert.multihop.failedHop2Title}</Text>
            <Text style={S.convertStateBody}>
              {M.convert.multihop.failedHop2Body(hopSymbol, destSymbol, record.failureDetail ?? '')}
            </Text>
            <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedHop2Exit(hopSymbol)}</Text>
          </View>
        ) : (
        <View testID="convert-failed-leg">
          <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}</Text>
          {/* The actionable exit (spec §4): the funds are NOT lost — they are the hop asset,
              in this wallet, and the standalone Withdraw is the door out. */}
          <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedLegExit}</Text>
        </View>
        )
      ) : null}

      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.stuckRouteBody}</Text>
          {/* D19: on a hub record the outcome is NOT all-or-nothing — what is already held
              is a fact, stated plainly next to the watching copy. */}
          {record.venue2Id != null ? (
            <Text style={S.convertStateMeta}>{M.convert.multihop.stuckHoldsLine(hopSymbol)}</Text>
          ) : null}
          {/* The receipts block + the expiry flip + the last-checked fact (2026-10-02
              POCO P0): per-leg evidence, the honest dead-window copy, the verifiable watch. */}
          <ConvertStuckReceipts record={record} />
          {stuckWindowExpired(record) ? (
            <View testID="convert-stuck-expired">
              <Text testID="convert-expiry" style={S.convertStateMeta}>
                {M.convert.stuckExpiredLine(formatClock(new Date(legExpiryMs)))}
              </Text>
              <Text style={S.convertStateMeta}>{M.convert.stuckExpiredBody}</Text>
            </View>
          ) : (
            <Text testID="convert-expiry" style={S.convertStateMeta}>
              {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
            </Text>
          )}
          {(() => {
            const at = stuckLastCheckedAtMs(record.id);
            return at != null ? (
              <Text testID="convert-stuck-last-checked" style={S.convertStateMeta}>
                {M.convert.stuckLastCheckedLine(formatClock(new Date(at)))}
              </Text>
            ) : null;
          })()}
          {record.acknowledgedStuckAtMs == null ? (
            <>
              {!stuckWindowExpired(record) ? <Text style={S.convertStateMeta}>{M.convert.stuckWatching}</Text> : null}
              <Pressable
                testID="btn-convert-stuck-ack"
                style={S.linkBtn}
                onPress={() => {
                  void acknowledgeStuckRecord(record.id);
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.stuckAcknowledge}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.stuckAcknowledge}</Text>
              </Pressable>
            </>
          ) : (
            <Text style={S.convertStateMeta}>{M.convert.stuckAcknowledged}</Text>
          )}
        </View>
      ) : null}

      {/* THE leg list — every leg, its own state, its own fee; the leg that stopped names
          itself by its refusal state. This list is the progress UI the route promised. D14:
          it stays FULLY expanded for hub records — four legs, no folding. */}
      <View testID="convert-route-legs" style={S.convertChecklistCard}>
        {record.gasPre != null ? (
          <Text testID="convert-gas-legs-note" style={S.convertStateMeta}>{M.convert.crossrail.gasLegsNote}</Text>
        ) : null}
        {(record.legPlan ?? []).map((lp, i) => {
          const leg = record.legs[i];
          const canister = leg?.canister ?? lp.canister;
          const fee = plannedLegFee(record, lp, canister);
          const label = plannedLegLabel(record, lp, canister, venueName,
            (record.legPlan ?? []).slice(0, i).filter(x => x.kind === 'swap').length);
          // STATEFUL (2026-10-04): done recedes behind the done marker, the active row is
          // the one emphasized row, pending rows stay muted, refusals shout.
          const mood = legRowMood(record.legPlan, i);
          return (
            <View key={i} testID={`convert-leg-${i}`}>
              <Text style={mood === 'done' ? S.convertChecklistLineDone
                : mood === 'active' ? S.convertChecklistLineActive
                  : mood === 'pending' ? S.convertChecklistLinePending
                    : S.convertChecklistLine}>{label}</Text>
              <Text
                testID={`convert-leg-${i}-state`}
                style={mood === 'failed' ? [S.convertStateMeta, S.convertLegStateBad]
                  : mood === 'done' ? [S.convertStateMeta, S.convertLegStateDone]
                    : S.convertStateMeta}>
                {`${mood === 'done' ? LEG_DONE_MARKER + ' ' : ''}${fee != null ? `${legStateText(lp.state)} · ${fee}` : legStateText(lp.state)}`}
              </Text>
            </View>
          );
        })}
      </View>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
