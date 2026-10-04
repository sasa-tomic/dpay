// ConvertStatePanel — the §4 state-machine record view for the direct/hub/CeFi surfaces.
// Extracted verbatim from ConvertMode.tsx (2026-09-21 decomposition); rendered by BOTH the
// IC form and the Solana surface (provider-shaped records).
import {useEffect, useState} from 'react';
import {ActivityIndicator, Pressable, Text, View} from 'react-native';
import {venueDisplayName} from '../config/venues';
import {convertAbortFlavor, convertRecordMinOut, type ConvertRecord} from '../convert';
import {abortConvertRecord, acknowledgeStuckRecord, providerLastCheckedAtMs} from '../convertResume';
import {solanaTokenOfMint} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact, toUnits} from '../lib/format';
import {copyToClipboard} from '../lib/clipboard';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {ConvertHeader, gasPreFundedAborted, nonBreakingClock, pendingPayoutViewOf} from './ConvertShared';
import {ConvertStuckReceipts, stuckWindowExpired} from './ConvertStuckEvidence';
import {stuckLastCheckedAtMs} from '../convert/stuckProbeLog';

/** Renders the §4 state-machine record — every non-done state carries practical instructions. */
export function StatePanel({record, onBack}: {record: ConvertRecord; onBack: () => void}) {
  const [, forceTick] = useState(0);
  // Which deposit fact was last copied ('address' | 'memo') — the transient "Copied" label on
  // the CeFi handoff's copy buttons, same pattern as the cross-rail calldata buttons.
  const [copiedDeposit, setCopiedDeposit] = useState<'address' | 'memo' | null>(null);
  // The Stop label follows the flavor (2026-09-24): a submitted swap is 'watching', a
  // provider order is 'provider', everything else is the plain Stop.
  const stopLabel = convertAbortFlavor(record) === 'watching' ? M.convert.stopWatching
    : convertAbortFlavor(record) === 'provider' ? M.convert.stopProvider
    : M.convert.stop;
  // The stuck screen restates what was signed, including the minimum bound. The record no
  // longer persists that figure (V2): it is re-derived by the compiled core from the record's
  // own frozen quote + slippage — the same deterministic arithmetic that computed it at prepare.
  const [minOut, setMinOut] = useState<string | null>(null);
  useEffect(() => {
    if (record.step !== 'stuck') return;
    let cancelled = false;
    convertRecordMinOut(record).then(
      (m) => { if (!cancelled) setMinOut(m); },
      () => { if (!cancelled) setMinOut(null); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.step]);
  // stuck/pending states show when the approval expires — a 30 s tick keeps that line honest.
  // provider_processing joins for the "last checked" clock (no SLA implied — just fresh).
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal' && record.step !== 'provider_processing') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);
  const {inSymbol, outSymbol} = record;
  // Each leg's decimals were frozen at prepare; records older than the field (and every
  // legacy-migrated v1 record) carry none — 8 is the e8s world those were signed in.
  const inDecimals = record.inDecimals ?? 8;
  const outDecimals = record.outDecimals ?? 8;
  // The record's own venue, looked up per V1 — display name and pool principal follow the
  // record, never a module constant.
  const venueName = venueDisplayName(record.venueId);
  // Both legs share the prepare-time expiry (the authority death the countdown shows).
  // The signed envelope's expiry: a pool leg carries its own; a CHAIN phase-1 record's only
  // signed thing is the deposit, whose window is the venue order's (chainRoute.expiresAtMs).
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.chainRoute?.expiresAtMs ?? record.createdAtMs;
  return (
    <View testID="convert-state" style={S.convertWrap}>
      <ConvertHeader title={M.convert.heading(inSymbol, outSymbol)} onBack={onBack} />

      {record.step === 'approving' || record.step === 'approved' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.approvingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, inSymbol), formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}
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
          <Text style={S.convertStateBody}>{M.convert.settlingBody(outSymbol)}</Text>
        </View>
      ) : null}
      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.doneTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.doneBody(fmtAssetCompact(record.outAmountNet ?? '0', outDecimals, outSymbol))}</Text>
          {/* A cross-rail payout (the CeFi settle) lands at a destination address on ANOTHER
              rail — the completed panel says which one. Only the cefi provider record carries
              destAddress through THIS panel (planned routes render via RouteStatePanel, cctp
              handoffs via CrossRailStatePanel), so the line fires for exactly that shape. */}
          {record.destAddress != null ? (
            <Text testID="convert-payout-address" style={S.convertStateMeta}>
              {M.convert.cefi.payoutAt(record.destAddress)}
            </Text>
          ) : null}
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}
      {record.step === 'pending_withdrawal' ? (() => {
        // ONE ACTIVE LEG (2026-10-04 composed-truth fix): the body names the payout the
        // executor is actually probing, via the shared view (a direct record's own values
        // fall out of it unchanged - sym = the output asset, pool = its own venue).
        const view = pendingPayoutViewOf(record);
        return (
          <View testID="convert-pending">
            <Text style={S.convertStateTitle}>
              {view.kind === 'pool-watch' ? M.convert.awaitingPool : M.convert.pendingTitle}
            </Text>
            <Text style={S.convertStateBody}>
              {view.kind === 'pool-watch'
                ? M.convert.settlingBody(view.sym)
                : M.convert.pendingBody(view.sym, view.pool, formatClock(new Date(record.createdAtMs)))}
            </Text>
            <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
          </View>
        );
      })() : null}
      {/* The user's Stop (2026-09-19): offered while the conversion runs — widened 2026-09-24
          to the provider-held states (awaiting_deposit / provider_processing), where stopping
          means dpay stops polling the venue (the order's own life is the venue's business).
          The flavor picks the honest label — a submitted swap keeps its own momentum, so the
          button says so. */}
      {(record.step === 'approving' || record.step === 'approved' || record.step === 'swapping'
        || record.step === 'settling' || record.step === 'pending_withdrawal'
        || record.step === 'awaiting_deposit' || record.step === 'provider_processing') ? (
        <Pressable
          testID="btn-convert-stop"
          style={S.linkBtn}
          onPress={() => {
            void abortConvertRecord(record.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          accessibilityState={{disabled: false}}
        >
          <Text style={S.linkText}>{stopLabel}</Text>
        </Pressable>
      ) : null}
      {record.step === 'aborted' ? (
        <View testID="convert-aborted">
          <Text style={S.convertStateTitle}>{M.convert.abortedTitle}</Text>
          <Text style={S.convertStateBody}>
            {gasPreFundedAborted(record) ? M.convert.crossrail.abortedGasBody
              : convertAbortFlavor(record) === 'provider' ? M.convert.abortedProvider
              : convertAbortFlavor(record) === 'watching' ? M.convert.abortedWatching
              : convertAbortFlavor(record) === 'fee' ? M.convert.abortedFee
              : M.convert.abortedClean}
          </Text>
          {/* The provider abort's copy points at the shift id ("right below") — the venue
              handle the user needs for the venue's own status page renders here. */}
          {convertAbortFlavor(record) === 'provider' && record.providerRef != null ? (
            <Text testID="convert-aborted-shift-id" style={S.convertStateMeta} selectable>
              {M.convert.cefi.shiftId(record.providerRef.orderId)}
            </Text>
          ) : null}
        </View>
      ) : null}
      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          <Text style={S.convertStateTitle}>{M.convert.failedTitle}</Text>
          {record.failureCode === 'approve_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedApproveBody(inSymbol)}</Text>
          ) : record.failureCode === 'swap_refused' ? (
            <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', inSymbol, venueName)}</Text>
          ) : record.failureCode === 'window_closed' ? (
            // The stuck-expiry resolution (2026-10-02): unconfirmed past the deadline, and
            // the balance read proved nothing left — the honest body, never a phantom refund.
            <>
              <Text style={S.convertStateBody}>{M.convert.failedWindowClosedBody(inSymbol)}</Text>
              {record.failureDetail != null && record.failureDetail !== '' ? (
                <Text style={S.convertStateMeta} selectable>{M.convert.stuckErrorLine(record.failureDetail)}</Text>
              ) : null}
            </>
          ) : (
            <Text style={S.convertStateBody}>{M.convert.refundedBody(inSymbol)}</Text>
          )}
          {/* The approval-expiry line renders ONLY where the window is still live
              (10x-verbosity pass 2026-09-16): on failed_refunded the pool has returned the
              funds — the approval window is closed, so the line is noise here. */}
        </View>
      ) : null}
      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          {/* The CHAIN record's phase 1 (chainRoute, no legs yet) has NO pool in flight — the
              unknown outcome is the venue DEPOSIT transfer's. The pool's copy ("do not start a
              second swap") would name a swap that never ran (D32 finding). */}
          {record.chainRoute != null && record.legs.length === 0 ? (
            <>
              <Text style={S.convertStateTitle}>{M.convert.chainStuckTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.chainStuckBody(venueName)}</Text>
            </>
          ) : (
            <>
              <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.stuckBody}</Text>
            </>
          )}
          {minOut != null ? (
            <Text style={S.convertStateMeta}>
              {M.convert.stuckSigned(fmtAssetCompact(record.amountIn, inDecimals, inSymbol), fmtAssetCompact(minOut, outDecimals, outSymbol), venueName)}
            </Text>
          ) : null}
          {/* The receipts block (2026-10-02 POCO P0): WHAT happened per leg + every tx
              identity the record carries + the failure cause verbatim — never a bare
              "unknown" with no evidence. */}
          <ConvertStuckReceipts record={record} />
          {/* The expiry line flips on the window: open → today's countdown; EXPIRED → the
              honest nothing-can-move-anymore copy (the founder's dead-window screen). */}
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
          {/* The last completed probe — the "keeps watching" claim, verifiable (no read this
              session renders nothing; nothing is claimed). */}
          {(() => {
            const at = stuckLastCheckedAtMs(record.id);
            return at != null ? (
              <Text testID="convert-stuck-last-checked" style={S.convertStateMeta}>
                {M.convert.stuckLastCheckedLine(formatClock(new Date(at)))}
              </Text>
            ) : null;
          })()}
          {/* V6: the honest unknown stays WATCHABLE — the engine slow-probes a stuck record until
              it resolves or the USER acknowledges it. The button is the acknowledgement: reading
              the instructions is the user's part; the watch stops only by this gesture.
              PAST the window the watching claim is gone (nothing can move) but the
              acknowledgement stays — the engine resolves the record either way. */}
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
      {/* The provider-held states (V6 drivers): the CeFi record's own venue is a provider, and
          every panel names it, which asset the user holds, and that dpay only WATCHES the
          provider's status — no fabricated progress, no reversal claims. */}
      {record.step === 'awaiting_deposit' ? (
        <View testID="convert-awaiting-deposit">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.awaitingDepositTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.awaitingDepositBody(inSymbol, venueName)}</Text>
          {/* The CeFi handoff (2026-09-15): the venue's own deposit facts, frozen at order
              creation. TWO arms (the record-lifecycle deposit, 2026-10-02 P0): an IC-source
              row's deposit is SENT BY THIS WALLET — the watcher fires once the record lands
              here — so the panel names that and renders NO manual send trio (a second,
              hand-copied deposit on top of the auto-send would be a double-spend invitation).
              An another-rail source (SOL-side) is still the USER's own transfer: the manual
              handoff stays verbatim. The amount goes through the SAME formatter as every
              other money line; the address stays verbatim. */}
          {record.providerDeposit != null ? (
            record.inCurrency != null ? (
              <View testID="convert-deposit-handoff">
                <Text testID="convert-deposit-auto-note" style={S.convertStateMeta}>
                  {M.convert.cefi.depositAutoNote(venueName, inSymbol)}
                </Text>
                {record.providerDeposit.expiresAtMs != null ? (
                  <Text style={S.convertStateMeta}>
                    {M.convert.cefi.depositExpiryLine(nonBreakingClock(new Date(record.providerDeposit.expiresAtMs)))}
                  </Text>
                ) : (
                  // The venue published NO expiry (e.g. Trocador orders): say so, instead of
                  // letting an unfunded order read as quietly abandoned. The shift id below
                  // is the handle; the watch is the commitment.
                  <Text testID="convert-deposit-no-expiry" style={S.convertStateMeta}>
                    {M.convert.cefi.noExpiryLine}
                  </Text>
                )}
                {/* The venue's own order id: the one handle support and the user both need
                    when talking to the venue's own status page — visible, not buried. */}
                {record.providerRef != null ? (
                  <Text testID="convert-shift-id" style={S.convertStateMeta} selectable>
                    {M.convert.cefi.shiftId(record.providerRef.orderId)}
                  </Text>
                ) : null}
              </View>
            ) : (
              <View testID="convert-deposit-handoff">
                <Text style={S.convertStateMeta}>{M.convert.cefi.depositNote(venueName, inSymbol)}</Text>
                <Text style={S.convertStateMeta}>{M.convert.cefi.depositAddressLabel}:</Text>
                {/* The address is the ONE thing the user must move verbatim into another wallet —
                    it gets the same machine-data treatment as the cross-rail calldata blocks
                    (mono, boxed), not prose styling. The memo equally: a fixed shift settles only
                    the exact (address, amount, memo) triple. */}
                <Text testID="convert-deposit-address" style={S.convertCalldata} selectable>
                  {record.providerDeposit.depositAddress}
                </Text>
                <Pressable
                  testID="btn-convert-copy-deposit-address"
                  style={S.linkBtn}
                  onPress={() => {
                    setCopiedDeposit(null);
                    void copyToClipboard(record.providerDeposit!.depositAddress).then(() => setCopiedDeposit('address'));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={M.convert.crossrail.copy}>
                  <Text style={S.linkText}>{copiedDeposit === 'address' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
                </Pressable>
                <Text testID="convert-deposit-amount" style={S.convertStateMeta}>
                  {M.convert.cefi.depositAmountLabel}: {fmtAssetCompact(toUnits(record.providerDeposit.depositAmount, inDecimals), inDecimals, inSymbol)}
                </Text>
                {/* SOL-side deposit leg (2026-09-20): the user sends an SPL transfer THEMSELVES —
                    its network fee is paid in SOL from the same wallet, a fact the IC-side
                    handoff never had to name. */}
                {solanaTokenOfMint(record.inLedger) != null ? (
                  <Text testID="convert-deposit-sol-fee-note" style={S.convertStateMeta}>
                    {M.convert.cefi.depositSolFeeNote}
                  </Text>
                ) : null}
                {record.providerDeposit.depositMemo != null ? (
                  <>
                    <Text testID="convert-deposit-memo" style={S.convertCalldata} selectable>
                      {M.convert.cefi.depositMemoLabel}: {record.providerDeposit.depositMemo}
                    </Text>
                    <Pressable
                      testID="btn-convert-copy-deposit-memo"
                      style={S.linkBtn}
                      onPress={() => {
                        setCopiedDeposit(null);
                        void copyToClipboard(record.providerDeposit!.depositMemo!).then(() => setCopiedDeposit('memo'));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={M.convert.crossrail.copy}>
                      <Text style={S.linkText}>{copiedDeposit === 'memo' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
                    </Pressable>
                  </>
                ) : null}
                {record.providerDeposit.expiresAtMs != null ? (
                  <Text style={S.convertStateMeta}>
                    {M.convert.cefi.depositExpiryLine(nonBreakingClock(new Date(record.providerDeposit.expiresAtMs)))}
                  </Text>
                ) : (
                  // The venue published NO expiry (e.g. Trocador orders): say so, instead of
                  // letting an unfunded order read as quietly abandoned. The shift id below
                  // is the handle; the watch is the commitment.
                  <Text testID="convert-deposit-no-expiry" style={S.convertStateMeta}>
                    {M.convert.cefi.noExpiryLine}
                  </Text>
                )}
                {/* The venue's own order id: the one handle support and the user both need
                    when talking to the venue's own status page — visible, not buried. */}
                {record.providerRef != null ? (
                  <Text testID="convert-shift-id" style={S.convertStateMeta} selectable>
                    {M.convert.cefi.shiftId(record.providerRef.orderId)}
                  </Text>
                ) : null}
              </View>
            )
          ) : null}
          {/* Deposit context says "deposit", never "payout" — the generic watching line belongs
              to the states past the deposit (processing/settling), where a payout is what is
              being watched for. The IC-source arm's deposit is the wallet's own job, so its
              tail names the venue wait, not the user's send. */}
          <Text style={S.convertStateMeta}>
            {record.inCurrency != null ? M.convert.cefi.stillWaitingAuto : M.convert.cefi.stillWaitingDeposit}
          </Text>
        </View>
      ) : null}
      {record.step === 'provider_processing' ? (
        <View testID="convert-provider-processing">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.providerProcessingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.providerProcessingBody(outSymbol, venueName)}</Text>
          {/* The calming PAIR (founder escalation 2026-09-20), moved here from
              awaiting_deposit (round-2 verbosity validation): "funds confirmed" is only
              true once the venue HOLDS the deposit — this is that state. The pair carries
              the watch commitment; the generic stillWatching line stacked a second one. */}
          {record.providerRef != null ? (
            <>
              <Text testID="convert-cefi-settling-note" style={S.convertStateMeta}>
                {M.convert.cefi.settlingFundsLine}
              </Text>
              <Text testID="convert-cefi-settling-watch" style={S.convertStateMeta}>
                {M.convert.cefi.settlingWatchLine}
              </Text>
            </>
          ) : (
            <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
          )}
          {/* The honest wait line (2026-09-24): when the engine last completed a status
              read. A timestamp only — the venue publishes no SLA, so none is invented and
              no verdict is implied. Hidden until this session's own first read lands. */}
          {(() => {
            const at = providerLastCheckedAtMs(record.id);
            return at != null ? (
              <Text testID="convert-last-checked" style={S.convertStateMeta}>
                {M.convert.cefi.lastCheckedLine(formatClock(new Date(at)))}
              </Text>
            ) : null;
          })()}
        </View>
      ) : null}
      {record.step === 'quote_expired' ? (
        <View testID="convert-quote-expired">
          <Text style={S.convertStateTitle}>{M.convert.quoteExpiredTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.quoteExpiredBody(inSymbol, venueName)}</Text>
        </View>
      ) : null}
      {record.step === 'provider_refunded' ? (
        <View testID="convert-provider-refunded">
          <Text style={S.convertStateTitle}>{M.convert.providerRefundedTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.providerRefundedBody(inSymbol, venueName)}</Text>
        </View>
      ) : null}
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
