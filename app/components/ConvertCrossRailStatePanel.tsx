// ConvertCrossRailStatePanel — the cross-rail record surface (Routes B/C): everything after
// the five IC legs. Extracted verbatim from ConvertMode.tsx (2026-09-21 decomposition). The
// e2e harness's wallet-double seam (__DPAY_TEST_EVM_SIGN, read at CALL time from globalThis)
// moves with it unchanged — never an import or config.
import {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import {venueDisplayName, venueEndpointOf, venueOfId} from '../config/venues';
import {buildCctpHandoff, convertAbortFlavor, convertRecordMinOut, type ConvertRecord, type LegPlan} from '../convert';
import {abortConvertRecord, acknowledgeStuckRecord, attachCctpBurnTx, confirmCrossRailSolLeg, declineCctpHandoff} from '../convertResume';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {SOLANA_TOKENS, USDC_MINT_ADDRESS, WRAPPED_SOL_MINT_ADDRESS, WRAPPED_SOL_TOKEN} from '../solana/tokens';
import {formatClock} from '../i18n/intl';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import {copyToClipboard} from '../lib/clipboard';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {ConvertHeader, gasPreFundedAborted, LinkRow, plannedLegFee, plannedLegLabel, routeTitleOf} from './ConvertShared';
import {ConvertStuckReceipts, stuckWindowExpired} from './ConvertStuckEvidence';
import {stuckLastCheckedAtMs} from '../convert/stuckProbeLog';

/** The cross-rail record surface (Routes B/C, 2026-09-16): everything after the five IC legs.
 *  The IC phases render exactly like RouteStatePanel's; then the surface splits —
 *  awaiting_external hands the user's OWN wallet the two exact Ethereum transactions (dpay
 *  holds no EVM key and signs nothing here), crossing watches Circle's own status feed until
 *  the mint lands AND is corroborated on-chain at the ATA, and sol_ready offers the final
 *  Jupiter leg on a fresh quote. Every dead-end names where the funds sit (in-wallet ckUSDC,
 *  USDC at the user's own EVM address, or USDC(SOL) at their ATA) and the way out. */
export function CrossRailStatePanel({record, secretHex, relayUrl, solLamports, onBack}: {
  record: ConvertRecord;
  secretHex: string;
  relayUrl: string;
  solLamports: string | null;
  onBack: () => void;
}) {
  const cross = record.crossRail;
  const [, forceTick] = useState(0);
  const [handoff, setHandoff] = useState<Awaited<ReturnType<typeof buildCctpHandoff>> | null>(null);
  const [handoffErr, setHandoffErr] = useState<string | null>(null);
  const [burnTxText, setBurnTxText] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const [copiedWhich, setCopiedWhich] = useState<'approve' | 'burn' | null>(null);
  const [solQuote, setSolQuote] = useState<JupiterQuote | null>(null);
  const [solQuoteErr, setSolQuoteErr] = useState<string | null>(null);
  const [crossAmtStr, setCrossAmtStr] = useState('');
  // A tether for async setState after unmount (the same mountedRef discipline the form uses).
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const inDecimals = record.inDecimals ?? 8;
  const hopDecimals = record.hopDecimals ?? record.outDecimals ?? 8;
  const hopSymbol = record.hopSymbol ?? record.outSymbol;
  const destSymbol = record.destSymbol ?? record.outSymbol;
  const venueName = venueDisplayName(record.venueId);
  const solVenueName = venueDisplayName(cross?.solVenueId ?? record.venueId);
  const legExpiryMs = record.legs[0]?.expiresAtMs ?? record.createdAtMs;
  const legStateText = (s: LegPlan['state']) =>
    s === 'pending' ? M.convert.multihop.legStatePending
    : s === 'sent' ? M.convert.multihop.legStateSent
    : s === 'confirmed' ? M.convert.multihop.legStateConfirmed
    : M.convert.multihop.legStateFailed;

  // The long-haul views (crossing, hop watch) stay honest about elapsed time — a 30 s tick.
  useEffect(() => {
    if (record.step !== 'stuck' && record.step !== 'pending_withdrawal' && record.step !== 'crossing') return;
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [record.step]);

  // The crossing amount for the intro line — the AUTHORITATIVE floor (convertRecordMinOut,
  // the same function the executor's numbers come from), never a hand-rolled mirror of it.
  useEffect(() => {
    let live = true;
    convertRecordMinOut(record)
      .then((v) => { if (live && mountedRef.current) setCrossAmtStr(v); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [record.id, record.expectedGross, record.slippageBps]);

  // The handoff bytes: built + fee re-fetched LIVE the moment the surface opens (never a
  // cached copy — the number the user reads is the number the wallet will be asked to sign),
  // and the mint recipient is re-derived and matched against the frozen record first.
  useEffect(() => {
    if (record.step !== 'awaiting_external') return;
    let live = true;
    buildCctpHandoff(secretHex, record)
      .then((h) => { if (live && mountedRef.current) { setHandoff(h); setHandoffErr(null); } })
      .catch((e) => { if (live && mountedRef.current) setHandoffErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [record.step, record.id, secretHex]);

  // The final leg's offer: a FRESH Jupiter quote on the minted amount (never the prepare-time
  // number — minutes may have passed), refreshed whenever the offer surface (re)mounts.
  useEffect(() => {
    if (record.step !== 'sol_ready' || cross == null || cross.mintSubunits == null || cross.solVenueId == null) return;
    const venue = venueOfId(cross.solVenueId);
    if (venue == null) return;
    let live = true;
    fetchJupiterQuote(relayUrl, venue, USDC_MINT_ADDRESS, cross.solOutMint ?? WRAPPED_SOL_MINT_ADDRESS, cross.mintSubunits, record.slippageBps)
      .then((q) => {
        if (!live || !mountedRef.current) return;
        if (q.ok) { setSolQuote(q.quote); setSolQuoteErr(null); }
        else if (q.code === 'refused') setSolQuoteErr(M.convert.errors.quoteRefused(solVenueName));
        else setSolQuoteErr(M.convert.errors.quoteUnavailable(q.code));
      })
      .catch(() => { if (live && mountedRef.current) setSolQuoteErr(M.convert.errors.quoteUnreachable(solVenueName)); });
    return () => { live = false; };
  }, [record.step, record.id, cross?.mintSubunits, cross?.solVenueId, cross?.solOutMint, record.slippageBps]);

  // The attach gesture. Production: the hash the user pasted back from their wallet. Under
  // e2e: if the harness installed a wallet double (__DPAY_TEST_EVM_SIGN), asking IT to sign
  // IS the simulated gesture — the returned hash is what the paste field would have held, and
  // the double also records WHAT dpay asked the wallet to sign (to, calldata, per tx).
  const onAttach = async () => {
    if (attachBusy) return;
    setAttachBusy(true);
    setAttachErr(null);
    try {
      let hash = burnTxText.trim();
      const seam = (globalThis as unknown as Record<string, unknown>).__DPAY_TEST_EVM_SIGN;
      if (typeof seam === 'function' && handoff != null) {
        const signed = await (seam as (txs: unknown) => Promise<string>)({
          approveTo: handoff.burnToken,
          approveCalldata: handoff.approveCalldata,
          burnTo: handoff.tokenMessenger,
          burnCalldata: handoff.burnCalldata,
          amountSubunits: handoff.amountSubunits,
        });
        hash = String(signed).trim();
        if (mountedRef.current) setBurnTxText(hash);
      }
      await attachCctpBurnTx(record.id, hash);
    } catch (e) {
      if (mountedRef.current) setAttachErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setAttachBusy(false);
    }
  };

  if (cross == null) return null; // the render fork only reaches here with a crossRail record

  // The final leg's out units: the record's own frozen decimals when it names an SPL out
  // mint (e.g. EURC's 6), the native-SOL 9 otherwise.
  const solOutDecimals = cross.solOutDecimals ?? SOLANA_TOKENS.SOL.decimals;
  const solFeeKnown = record.solFeeLamports != null && BigInt(record.solFeeLamports) > 0n;
  const solShort = solLamports != null && solLamports.length > 0 && BigInt(solLamports) <= 0n
    && record.step !== 'done' && record.step !== 'failed_refunded' && record.step !== 'failed_leg';
  // doneBody carries its own ${sym} — hand it the BARE number (fmtAssetCompact appends the unit,
  // so pass an empty unit and trim the trailing space it leaves).
  const amountStr = fmtAssetCompact(record.outAmountNet ?? '0',
    cross.kind === 'cctp_sol' ? solOutDecimals : hopDecimals, '').trim();

  return (
    <View testID="convert-crossrail" style={S.convertWrap}>
      <ConvertHeader
        title={routeTitleOf(record, hopSymbol, destSymbol)}
        onBack={onBack}
      />

      {/* The IC phases render exactly as Route A does — same copy, same leg list below. */}
      {record.step === 'approving' ? (
        <View testID="convert-approving">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.approvingBody(fmtAssetCompact(record.amountIn, inDecimals, record.inSymbol), formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {record.step === 'pending_withdrawal' ? (
        <View testID="convert-pending">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.pendingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.pendingBody(hopSymbol, venueEndpointOf(record.venueId), formatClock(new Date(record.createdAtMs)))}</Text>
          <Text style={S.convertStateMeta}>{M.convert.stillWatching}</Text>
          <Text testID="convert-expiry" style={S.convertStateMeta}>
            {M.convert.expiryLine(formatClock(new Date(legExpiryMs)))}
          </Text>
        </View>
      ) : null}

      {/* THE HANDOFF (spec §3, cross-rail widening): the user's own wallet signs; dpay renders
          the exact bytes, copyable, with the fee re-fetched live and the recipient re-derived. */}
      {record.step === 'awaiting_external' ? (
        <View testID="crossrail-handoff">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.heading}</Text>
          <Text style={S.convertStateBody}>
            {crossAmtStr !== ''
              ? M.convert.crossrail.handoffIntro(fmtAssetCompact(crossAmtStr, hopDecimals, hopSymbol))
              : null}
          </Text>
          {handoff != null ? (
            <>
              <Text testID="crossrail-handoff-amount" style={S.convertChecklistLine}>
                {M.convert.crossrail.txAmountLabel}: {fmtAssetCompact(handoff.amountSubunits, hopDecimals, hopSymbol)}
              </Text>
              <Text style={S.convertChecklistWarn}>{M.convert.crossrail.whatSigning}</Text>
              <Text style={S.convertSlippageLabel}>{M.convert.crossrail.stepApproveLabel}</Text>
              <Text style={S.convertPrincipal}>{handoff.burnToken}</Text>
              <Text testID="crossrail-approve-calldata" style={S.convertCalldata} selectable>{handoff.approveCalldata}</Text>
              <Pressable
                testID="btn-crossrail-copy-approve"
                style={S.linkBtn}
                onPress={() => {
                  setCopiedWhich(null);
                  void copyToClipboard(handoff.approveCalldata).then(() => setCopiedWhich('approve'));
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.copy}>
                <Text style={S.linkText}>{copiedWhich === 'approve' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
              </Pressable>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.approveHint}</Text>
              <Text style={S.convertSlippageLabel}>{M.convert.crossrail.stepBurnLabel}</Text>
              <Text style={S.convertPrincipal}>{handoff.tokenMessenger}</Text>
              <Text testID="crossrail-burn-calldata" style={S.convertCalldata} selectable>{handoff.burnCalldata}</Text>
              <Pressable
                testID="btn-crossrail-copy-burn"
                style={S.linkBtn}
                onPress={() => {
                  setCopiedWhich(null);
                  void copyToClipboard(handoff.burnCalldata).then(() => setCopiedWhich('burn'));
                }}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.copy}>
                <Text style={S.linkText}>{copiedWhich === 'burn' ? M.convert.crossrail.copied : M.convert.crossrail.copy}</Text>
              </Pressable>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.burnHint}</Text>
              <Text testID="crossrail-circle-fee" style={S.convertChecklistLine}>
                {M.convert.crossrail.circleFeeLine(fmtAssetCompact(handoff.maxFeeSubunits, hopDecimals, hopSymbol))}
              </Text>
              <Text style={S.convertChecklistLine}>
                {/* Same mid-stop split as the review census: on a Route C the crossing USDC
                    is the MID-STOP (a final Jupiter step swaps it onward); Route B's USDC is
                    the outcome at the address. BARE number + symbol (the copy owns the unit). */}
                {cross.kind === 'cctp_sol'
                  ? M.convert.crossrail.mintFloorLine(fmtAssetCompact(handoff.mintFloorSubunits, hopDecimals, '').trim(), hopSymbol)
                  : M.convert.crossrail.mintFloorDestLine(fmtAssetCompact(handoff.mintFloorSubunits, hopDecimals, '').trim(), hopSymbol)}
              </Text>
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.timingNote}</Text>
              <Text testID="crossrail-external-gas" style={S.convertChecklistLine}>{M.convert.crossrail.externalGasLine}</Text>
            </>
          ) : handoffErr != null ? (
            <Text testID="crossrail-handoff-err" style={S.err}>{handoffErr}</Text>
          ) : (
            <ActivityIndicator color={C.sub} />
          )}
          {handoff != null ? (
            <>
              <Text style={S.convertAmountLabel}>{M.convert.crossrail.burnTxLabel}</Text>
              <View style={S.amountRow}>
                <TextInput
                  testID="crossrail-burn-tx"
                  style={S.monoInput}
                  value={burnTxText}
                  onChangeText={setBurnTxText}
                  autoCorrect={false}
                  autoCapitalize="characters"
                  placeholder={M.convert.crossrail.burnTxPlaceholder}
                  placeholderTextColor={C.sub}
                />
              </View>
              <Pressable
                testID="btn-crossrail-attach"
                style={[S.primary, (attachBusy || burnTxText.trim().length === 0) && S.disabledFlat]}
                onPress={() => void onAttach()}
                disabled={attachBusy || burnTxText.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.attachButton}>
                <Text style={S.primaryText}>{M.convert.crossrail.attachButton}</Text>
              </Pressable>
              {/* attachErr carries the thrown validation's own message (today that is only the
                  burn-tx hash shape check) — rendered verbatim, never re-labeled: a future error
                  must not wear the hash-error's clothes. */}
              {attachErr != null ? <Text style={S.err}>{attachErr}</Text> : null}
              <Pressable
                testID="btn-crossrail-decline"
                style={S.linkBtn}
                onPress={() => void declineCctpHandoff(record.id)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.crossrail.declineButton}>
                <Text style={S.linkText}>{M.convert.crossrail.declineButton}</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}

      {/* THE CROSSING: Circle's own status feed, watched by burn tx hash. Pending is PENDING —
          never rendered as failure — and the two links make the wait independently checkable. */}
      {record.step === 'crossing' ? (
        <View testID="crossrail-crossing">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.crossrail.crossingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.crossrail.crossingBody}</Text>
          <Text testID="crossrail-still" style={S.convertStateMeta}>{M.convert.crossrail.stillCrossing}</Text>
          {cross.burnTxHash != null ? (
            <>
              <Text testID="crossrail-burn-hash" style={S.convertPrincipal} selectable>{cross.burnTxHash}</Text>
              <LinkRow testID="btn-crossrail-view-burn" label={M.convert.crossrail.viewBurnTx} href={`https://etherscan.io/tx/${cross.burnTxHash}`} />
            </>
          ) : null}
          <LinkRow testID="btn-crossrail-view-circle" label={M.convert.crossrail.viewCircle} href="https://cctp.cash/" />
          {/* The user's Stop (2026-09-24): the burn tx is OUT, so the flavor is 'watching' —
              Circle may still complete the mint, and the funds land at the user's OWN ATA
              either way. The button says so; the aborted card names it. */}
          <Pressable
            testID="btn-convert-stop"
            style={S.linkBtn}
            onPress={() => {
              void abortConvertRecord(record.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={M.convert.stopWatching}
            accessibilityState={{disabled: false}}
          >
            <Text style={S.linkText}>{M.convert.stopWatching}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* THE FINAL LEG'S OFFER: USDC verified at the ATA; Jupiter re-quoted fresh; keeping the
          USDC is named as an equal outcome, not a consolation. */}
      {record.step === 'sol_ready' ? (
        <View testID="crossrail-sol-ready">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.solReadyTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.crossrail.solReadyBody(fmtAssetCompact(cross.mintSubunits ?? '0', hopDecimals, hopSymbol), cross.mintRecipientAta)}
          </Text>
          {solQuote != null ? (
            <>
              <Text testID="crossrail-sol-quote" style={S.convertChecklistLine}>
                {/* Venue name comes from the RECORD's own frozen registry key (solVenueId, with
                    the record's venue as the type-level fallback), never a hardcoded string — the
                    same locale-invariant attribution rule as every other number on this screen. */}
                {M.convert.crossrail.solQuoteLabel(venueDisplayName(cross.solVenueId ?? record.venueId))}
              </Text>
              <Text testID="crossrail-sol-out" style={S.convertHeadlineAmount}>
                {fmtAssetCompact(solQuote.outAmount, solOutDecimals, destSymbol)}
              </Text>
              <Text style={S.convertChecklistLine}>
                {/* The BARE number + the sym: the copy owns the unit (one owner), and the
                    sym argument renders EURC and SOL through the SAME sentence. */}
                {M.convert.crossrail.solMinLine(fmtAssetCompact(solQuote.otherAmountThreshold, solOutDecimals, '').trim(), destSymbol)}
              </Text>
            </>
          ) : solQuoteErr != null ? (
            <Text testID="crossrail-sol-quote-err" style={S.err}>{solQuoteErr}</Text>
          ) : (
            <ActivityIndicator color={C.sub} />
          )}
          {solShort ? (
            <View testID="crossrail-sol-preflight">
              <Text style={S.convertChecklistWarn}>{M.convert.crossrail.solPreflightTitle}</Text>
              {/* The panel only renders this block when the wallet's measured SOL balance is
                  exactly zero — so it SAYS that, rather than fabricating a dust figure the
                  wallet was never quoted. */}
              <Text style={S.convertChecklistLine}>{M.convert.crossrail.solPreflightBody}</Text>
            </View>
          ) : null}
          <Pressable
            testID="btn-crossrail-sol-confirm"
            style={[S.primary, solQuote == null && S.disabledFlat]}
            onPress={() => void confirmCrossRailSolLeg(record.id)}
            disabled={solQuote == null}
            accessibilityRole="button"
            accessibilityLabel={M.convert.crossrail.solConfirmButton(destSymbol)}>
            <Text style={S.primaryText}>{M.convert.crossrail.solConfirmButton(destSymbol)}</Text>
          </Pressable>
          {/* The user's Stop (2026-09-24): the final Jupiter leg is UNSIGNED — the stop is
              genuinely clean, and the USDC already sits at the user's own ATA. The aborted
              card names where it is and what the exit is. */}
          <Pressable
            testID="btn-convert-stop"
            style={S.linkBtn}
            onPress={() => {
              void abortConvertRecord(record.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={M.convert.stop}
            accessibilityState={{disabled: false}}
          >
            <Text style={S.linkText}>{M.convert.stop}</Text>
          </Pressable>
        </View>
      ) : null}

      {/* The final leg running / landing: the device signature exists; the leg list below is
          the progress. */}
      {record.step === 'swapping' || record.step === 'settling' ? (
        <View testID="crossrail-sol-swap">
          <ActivityIndicator size="large" color={C.brandText} />
          <Text style={S.convertStateTitle}>{M.convert.multihop.executingTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.crossrail.legSolSwap(solVenueName, destSymbol)}</Text>
          {solFeeKnown ? (
            <Text testID="crossrail-sol-fee" style={S.convertChecklistLine}>
              {/* The network fee is paid in SOL whatever the out token is (SOL, EURC) —
                  the fee line's unit is always the gas asset, never the destination. */}
              {M.convert.crossrail.solFeeLine(fmtAssetCompact(record.solFeeLamports!, SOLANA_TOKENS.SOL.decimals, WRAPPED_SOL_TOKEN))}
            </Text>
          ) : null}
        </View>
      ) : null}

      {record.step === 'done' ? (
        <View testID="convert-done">
          <Text style={S.convertStateTitle}>{M.convert.crossrail.doneTitle}</Text>
          <Text style={S.convertStateBody}>
            {M.convert.crossrail.doneBody(amountStr, destSymbol, cross.solAddress)}
          </Text>
          {/* The receipt names WHO executed it (founder clarity fix 2026-09-22): the IC
              swap venue, Circle's crossing, and the final leg's venue — the record's own
              frozen registry keys, never literals. Route B has no final venue: its receipt
              keeps the plain done body. */}
          {cross.kind === 'cctp_sol' && cross.solVenueId != null ? (
            <Text testID="crossrail-done-via" style={S.convertStateMeta}>
              {M.convert.crossrail.doneVia(venueName, solVenueName)}
            </Text>
          ) : null}
          {record.outTx != null ? <Text style={S.convertStateMeta}>{M.convert.doneTx(record.outTx)}</Text> : null}
        </View>
      ) : null}

      {record.step === 'failed_refunded' ? (
        <View testID="convert-failed">
          {record.solanaLeg != null ? (
            /* The SOL leg refused: the USDC ALREADY crossed — the dead-end copy must say so. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.crossrail.solFailedTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.crossrail.solFailedBody(cross.mintRecipientAta, solVenueName)}</Text>
            </>
          ) : (
            <>
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
                <Text style={S.convertStateBody}>{M.convert.failedSwapBody(record.failureDetail ?? '', record.inSymbol, venueName)}</Text>
              )}
              {/* No approval-expiry line here: failed_refunded means the window is closed
                  (10x-verbosity pass 2026-09-16); only live windows carry the line. */}
            </>
          )}
        </View>
      ) : null}

      {record.step === 'failed_leg' ? (
        <View testID="convert-failed-leg">
          {record.failureCode === 'external_declined' ? (
            /* The user walked away from the wallet step: nothing crossed; the USDC is at
                their OWN Ethereum address — an address they control, not a dead end. On a
                gas-funded record BOTH stranded assets get their whereabouts named. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.crossrail.declinedTitle}</Text>
              <Text style={S.convertStateBody}>{record.gasPre != null
                ? M.convert.crossrail.declinedWithGasBody(record.destAddress ?? '')
                : M.convert.crossrail.declinedBody(record.destAddress ?? '')}</Text>
            </>
          ) : record.failureCode === 'gas_short' ? (
            /* The funding pre-legs did not deliver (a refusal, or the executor's balance
                re-check came up short): the main conversion never started and every source
                value sits in-wallet — the card names the shortfall as the exit. */
            <>
              <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
              <Text testID="convert-gas-short-failed" style={S.convertStateBody}>
                {M.convert.crossrail.gasShortFailedBody(fmtAssetCompact(record.gasPre?.neededWei ?? '0', record.gasDecimals ?? 18, record.gasSymbol ?? 'ckETH'))}
              </Text>
            </>
          ) : (
            <>
              <Text style={S.convertStateTitle}>{M.convert.multihop.failedLegTitle}</Text>
              <Text style={S.convertStateBody}>{M.convert.multihop.failedLegBody(hopSymbol, record.failureDetail ?? '')}</Text>
              <Text style={S.convertChecklistWarn}>{M.convert.multihop.failedLegExit}</Text>
            </>
          )}
        </View>
      ) : null}

      {record.step === 'stuck' ? (
        <View testID="convert-stuck">
          <Text style={S.convertStateTitle}>{M.convert.stuckTitle}</Text>
          <Text style={S.convertStateBody}>{M.convert.multihop.stuckRouteBody}</Text>
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
                onPress={() => { void acknowledgeStuckRecord(record.id); }}
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

      {/* The aborted card (2026-09-24): the Stop on `crossing` (the mint may still land — the
          funds are at the user's OWN ATA either way) and on `sol_ready` (the final Jupiter leg
          was UNSIGNED — genuinely clean). Keyed on abortedFromStep; the gas-funded case keeps
          its own honest body; anything else falls back to the shared flavors. */}
      {record.step === 'aborted' ? (
        <View testID="convert-aborted">
          <Text style={S.convertStateTitle}>{M.convert.abortedTitle}</Text>
          <Text style={S.convertStateBody}>
            {record.abortedFromStep === 'crossing' ? M.convert.crossrail.abortedCrossing(cross.mintRecipientAta)
              : record.abortedFromStep === 'sol_ready' ? M.convert.crossrail.abortedSolReady(cross.mintRecipientAta)
              : gasPreFundedAborted(record) ? M.convert.crossrail.abortedGasBody
              : convertAbortFlavor(record) === 'watching' ? M.convert.abortedWatching
              : convertAbortFlavor(record) === 'fee' ? M.convert.abortedFee
              : M.convert.abortedClean}
          </Text>
        </View>
      ) : null}

      {/* The leg list — same shape as Route A's, extended with the two cross-rail kinds. */}
      <View testID="convert-crossrail-legs" style={S.convertChecklistCard}>
        {record.gasPre != null ? (
          <Text testID="convert-gas-legs-note" style={S.convertStateMeta}>{M.convert.crossrail.gasLegsNote}</Text>
        ) : null}
        {(record.legPlan ?? []).map((lp, i) => {
          const leg = record.legs[i];
          const canister = leg?.canister ?? lp.canister;
          const fee = plannedLegFee(record, lp, canister);
          return (
            <View key={i} testID={`convert-leg-${i}`}>
              <Text style={S.convertChecklistLine}>{plannedLegLabel(record, lp, canister, venueName)}</Text>
              <Text
                testID={`convert-leg-${i}-state`}
                style={lp.state === 'failed' ? [S.convertStateMeta, S.convertLegStateBad] : S.convertStateMeta}>
                {fee != null ? `${legStateText(lp.state)} · ${fee}` : legStateText(lp.state)}
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
