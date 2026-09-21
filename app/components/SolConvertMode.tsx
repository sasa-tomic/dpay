// SolConvertMode — the SOLANA convert surface (multi-venue readiness V11): the same entry
// gesture, the same pre-sign transparency checklist, the same engine-driven record view as the
// IC form — with the venue being a keyless https aggregator (Jupiter) or a registered cefi
// venue. Extracted verbatim from ConvertMode.tsx (2026-09-21 decomposition): the single-flight
// staleRefreshing guard and the 64-hex settle-address emission (DpayCore.icpAccountIdFromPrincipal)
// move with the component unchanged.
import {Fragment, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, Text, TextInput, View} from 'react-native';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {
  CONVERT_CEFI_CONFIRM_TIMEOUT_MS,
  CONVERT_SLIPPAGE_BPS_DEFAULT,
  CONVERT_SLIPPAGE_BPS_OPTIONS,
} from '../config/convert';
import {venueDisplayName} from '../config/venues';
import {
  ceFiQuoteFromResult,
  createCeFiOrder,
  fetchCeFiQuoteResult,
  ceFiServiceError,
  fetchCeFiConvertQuote,
  isQuoteStale,
  isTerminalConvertStep,
  prepareCeFiConvertRecord,
  prepareSolanaConvertRecord,
  type ConvertQuote,
  type ConvertRecord,
} from '../convert';
import {adoptConvertRecord, convertResumeSnapshot, subscribeConvertRecords} from '../convertResume';
import {fetchJupiterQuote, type JupiterQuote} from '../services/jupiter';
import {DpayCore} from '../services/native';
import {deriveSolanaAddress} from '../solana/identity';
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {M} from '../i18n';
import {fmtAssetCompact, parseUserAmount, rawToDecimal} from '../lib/format';
import type {AssetId, Identity} from '../lib/types';
import {C} from '../config/palette';
import {S} from '../styles';
import {IconSwap} from './icons';
import {InstructionPanel} from './InstructionPanel';
import {
  ConvertHeader,
  DetailsToggle,
  formatBps,
  isLiveRecord,
  nonBreakingClock,
  scaledRate,
  venueDisclosure,
} from './ConvertShared';
import {resolveSolDestinations, resolveSolLegs, solMechKeyOf, type SolDestGroup} from './ConvertSolDest';
import {StatePanel} from './ConvertStatePanel';
import {SolStatePanel} from './SolStatePanel';

type SolConvertProps = {
  identity: Identity;
  /** The active relay — the Jupiter quote/swap dials go through it (2026-09-16). */
  relayUrl: string;
  asset: Extract<SelectableAsset, {protocol: 'solana'}>;
  /** The catalog — resolves a cefi venue's settle ledger into the destination row's
   *  symbol/decimals (the IC half of the pair, on this surface since 2026-09-20). */
  catalog: CurrencyDescriptor[];
  solana: {sol: string | null; tokens: Record<string, string | null>};
  onBack: () => void;
  onShowDepositAddress: () => void;
  onSwitchAsset?: (id: AssetId) => void;
};

export function SolConvertMode({identity, relayUrl, asset, catalog, solana, onBack, onShowDepositAddress, onSwitchAsset}: SolConvertProps) {
  const [amountText, setAmountText] = useState('');
  const [slippageBps, setSlippageBps] = useState<number>(CONVERT_SLIPPAGE_BPS_DEFAULT);
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  // The CeFi quote (a ConvertQuote — the venue's verbatim settle figure), parallel to the
  // Jupiter quote: whichever MECHANISM is active renders its own quote's digits.
  const [cefiQuote, setCefiQuote] = useState<ConvertQuote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [staleRefreshing, setStaleRefreshing] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState<{oldAmt: string; newAmt: string} | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  // The one Details disclosure on the quote-ready surface (10x-verbosity pass 2026-09-16):
  // the venue/fee/signing census collapses behind it, default CLOSED for everyone.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const mountedRef = useRef(true);
  const recordIdRef = useRef<string | null>(null);
  // Sync latch for the confirm gesture: `confirmBusy` state lags a re-render, and a duplicate
  // press delivered inside that window would run prepare twice (two venue swap POSTs from one
  // gesture — observed once under heavy host load, 2026-09-17). The ref closes it same-tick.
  const confirmBusyRef = useRef(false);

  // --- the destination (spec 2026-09-16 §2 decision 5, widened 2026-09-20): one GROUP per
  //     destination ASSET — in-wallet SPL destinations (every registered solana_amm venue for
  //     this mint) plus the registered cefi venues settling onto the IC rail (defect 1 of the
  //     live sweep: the SAME rows the IC surface offers in the other direction). Registry
  //     order, merged by landing spot, never ranked. The DEFAULT is the FIRST option — the
  //     exact pair this surface served before widening, so a one-group mint renders no chooser
  //     chrome and behaves exactly as before. A switch resets the quote + its review state
  //     (the amount stays — the user's number is not the venue's business).
  const inMint = asset.mint ?? WRAPPED_SOL_MINT_ADDRESS;
  const [destKey, setDestKey] = useState<string | null>(null);
  const [destMintKey, setDestMintKey] = useState<string | null>(null);
  const [destMechKey, setDestMechKey] = useState<string | null>(null);
  if (destMintKey !== inMint) {
    // The pick is per-mint state — a different asset re-derives the default (render-phase
    // adjustment: set during render when a prop changed the fact the state is keyed on).
    setDestMintKey(inMint);
    setDestKey(null);
    setDestMechKey(null);
  }
  const solDests = resolveSolDestinations(asset, catalog);
  const destGroups: SolDestGroup[] = solDests?.groups ?? [];
  const activeGroup = destGroups.find(g => g.key === destKey) ?? destGroups[0] ?? null;
  // A group can hold SEVERAL mechanisms since 2026-09-20 (the trocador aggregator beside
  // sideshift on the IC landing spot). The sub-pick defaults to the FIRST — the registry's
  // order, never a ranking — and an explicit pick wins. A group with no mechanism cannot exist.
  const activeMech = activeGroup != null
    ? activeGroup.mechs.find(m => solMechKeyOf(m) === destMechKey) ?? activeGroup.mechs[0] ?? null
    : null;
  const venue = activeMech?.venue ?? null;
  const legs = activeMech != null ? resolveSolLegs(asset, activeMech) : null;
  const cefiMode = activeMech?.kind === 'cefi';
  const venueName = venue != null ? venueDisplayName(venue.venue_id) : venueDisplayName('jupiter');

  const pickDest = (key: string) => {
    // Frozen while a confirm is in flight: the in-flight confirm closes over THIS pair, and its
    // late setQuote/setQuoteChanged must never land under the newly picked pair's heading.
    if (key === destKey || confirmBusy) return;
    setDestKey(key);
    setDestMechKey(null); // the new group re-derives its default mechanism
    setQuote(null); setQuoteErr(null); setQuoteChanged(null); setQuoteBusy(false); setConfirmErr(null);
  };
  const balanceRaw = legs == null ? null : legs.inMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.inMint] ?? null;
  const outHeldRaw = legs != null && legs.kind === 'amm'
    ? (legs.outMint === WRAPPED_SOL_MINT_ADDRESS ? solana.sol : solana.tokens[legs.outMint] ?? null)
    : null; // a cefi settle side lives on the IC rail — this wallet's other SOL token is irrelevant

  // --- the CeFi payout target (IC-side twin: the cefiSettleAddress memo): the user's OWN
  //     address ON THE DESTINATION RAIL — the wallet's IC ACCOUNT IDENTIFIER: the 64-hex
  //     account hash of the wallet's own principal (default subaccount), the SAME
  //     derivation that mints the wallet's deposit addresses, from the same key that
  //     derives the Solana address. Nothing typed, nothing entrusted. NOT the principal
  //     text: the venue's ICP payout layer cannot deliver to principal-format addresses —
  //     only to these 32-byte identifiers (SideShift engineering, confirmed in writing
  //     2026-09-21; a shift naming the principal text sat `settling` for hours and was
  //     refunded 2026-09-20) — so the principal is only the derivation's INTERMEDIATE,
  //     never the emitted target.
  const [icSettleAddress, setIcSettleAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!cefiMode) {
      setIcSettleAddress(null);
      return;
    }
    let alive = true;
    DpayCore.icpPrincipalFromPubkey(identity.publicHex)
      .then(p => DpayCore.icpAccountIdFromPrincipal(p, ''))
      .then(id => {
        if (alive) setIcSettleAddress(id);
      })
      .catch(() => {
        if (alive) setIcSettleAddress(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cefiMode, identity.publicHex]);
  // The CeFi REFUND address, SOL surface: the DEPOSIT rail here is Solana, so refunds go
  // to the user's OWN derived Solana address (same shape as the IC surface's cefiRefundAddress —
  // the venue returns the funds there on a failed deposit or expiry; never a dpay address).
  const solRefundAddress = useMemo(
    () => deriveSolanaAddress(identity.secretHex),
    [identity.secretHex],
  );

  // --- engine view (the same shape as the IC surface: newest live/unacknowledged-stuck record,
  // honored-record lock, subscribe for updates — this screen never runs a private executor).
  useEffect(() => {
    mountedRef.current = true;
    const pick = (records: Record<string, ConvertRecord>) => {
      const id = recordIdRef.current;
      if (id != null) {
        setRecord(records[id] ?? null);
        return;
      }
      const live = Object.values(records)
        .filter(r => isLiveRecord(r) || (r.step === 'stuck' && r.acknowledgedStuckAtMs == null))
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
      if (live != null) recordIdRef.current = live.id;
      setRecord(live);
    };
    pick(convertResumeSnapshot());
    const unsub = subscribeConvertRecords((records) => {
      if (mountedRef.current) pick(records);
    });
    return () => {
      unsub();
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveRecord = record != null && isLiveRecord(record);
  const showRecord = record != null && (liveRecord || record.step === 'stuck' || isTerminalConvertStep(record.step));

  // --- the quote: through the relay proxy per keystroke (the relay pipes the venue
  // byte-faithfully, short-TTL-caching identical asks). Slippage IS a dep here (unlike IC):
  // Jupiter's route + threshold are computed against it, so a changed chip must re-ask the
  // venue. The cefi branch goes through the SAME CeFi quote path the IC surface uses
  // (partner-key proxy, verbatim settle figure) — rails differ, the pipeline does not.
  useEffect(() => {
    if (legs == null || venue == null || showRecord) return;
    const parsed = parseUserAmount(amountText, legs.inDecimals);
    if (!parsed.ok || parsed.raw === '0') {
      setQuote(null); setCefiQuote(null); setQuoteErr(null); setQuoteBusy(false); setQuoteChanged(null);
      return;
    }
    if (legs.kind === 'cefi') {
      let cancelled = false;
      setQuoteBusy(true);
      fetchCeFiConvertQuote(relayUrl, venue, legs.inMint, legs.outLedger, parsed.raw, {
        inDecimals: legs.inDecimals,
        outDecimals: legs.outDecimals,
      })
        .then(q => {
          if (cancelled) return;
          setCefiQuote(q);
          setQuoteErr(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setCefiQuote(null);
          setQuoteErr(e instanceof Error ? e.message : M.convert.errors.quoteUnreachable(venueName));
        })
        .finally(() => {
          if (!cancelled) setQuoteBusy(false);
        });
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    setQuoteBusy(true);
    fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, parsed.raw, slippageBps)
      .then(res => {
        if (cancelled) return;
        if (res.ok) {
          setQuote(res.quote); setQuoteErr(null);
        } else {
          setQuote(null);
          setQuoteErr(res.code === 'refused' ? M.convert.errors.quoteRefused(venueName) : M.convert.errors.quoteUnreachable(venueName));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setQuote(null);
        setQuoteErr(M.convert.errors.quoteUnreachable(venueName));
      })
      .finally(() => {
        if (!cancelled) setQuoteBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountText, legs?.inMint, legs != null && legs.kind === 'amm' ? legs.outMint : null, legs != null && legs.kind === 'cefi' ? legs.outLedger : null, slippageBps, showRecord]);

  // --- stale refresh (same 30s clock + test seam as IC; keeps the OLD quote on failure).
  // SINGLE-FLIGHT, the IC surface's exact guard (ConvertMode IC stale effect): a tick may fire
  // a refresh ONLY when none is in flight. Without the `staleRefreshing` check, a quote that
  // stays stale (venue slow or unreachable) re-fires the fetch EVERY SECOND — up to 8
  // concurrent 8s-budget calls hammering the relay's partner-key proxy. That stampede is the
  // live 2026-09-21 attempt-#3 signature: the venue throttled the shared partner credential,
  // so the CONFIRM's own re-quote could not answer inside its budget ("Could not reach
  // SideShift" alternating with the refresh's own "Quote changed" banner).
  useEffect(() => {
    if (legs == null || venue == null || showRecord) return;
    if (legs.kind === 'cefi') {
      if (cefiQuote == null) return;
      const tick = setInterval(() => {
        if (!mountedRef.current || staleRefreshing || !isQuoteStale(cefiQuote)) return;
        setStaleRefreshing(true);
        fetchCeFiConvertQuote(relayUrl, venue, legs.inMint, legs.outLedger, cefiQuote.amountIn, {
          inDecimals: legs.inDecimals,
          outDecimals: legs.outDecimals,
        })
          .then(q => {
            if (mountedRef.current) {
              setCefiQuote(q);
              if (q.amountOutGross !== cefiQuote.amountOutGross) {
                setQuoteChanged({oldAmt: cefiQuote.amountOutGross, newAmt: q.amountOutGross});
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            if (mountedRef.current) setStaleRefreshing(false);
          });
      }, 1000);
      return () => clearInterval(tick);
    }
    if (quote == null) return;
    const tick = setInterval(() => {
      if (!mountedRef.current || staleRefreshing || !isQuoteStale(quote)) return;
      setStaleRefreshing(true);
      fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, quote.inAmount, slippageBps)
        .then(res => {
          if (res.ok && mountedRef.current) {
            setQuote(res.quote);
            if (res.quote.outAmount !== quote.outAmount) {
              setQuoteChanged({oldAmt: quote.outAmount, newAmt: res.quote.outAmount});
            }
          }
        })
        .catch(() => {})
        .finally(() => {
          if (mountedRef.current) setStaleRefreshing(false);
        });
    }, 1000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, cefiQuote, staleRefreshing, slippageBps, showRecord]);

  const parsedAmount = parseUserAmount(amountText, legs != null ? legs.inDecimals : 0);
  const amountRaw = parsedAmount.ok ? parsedAmount.raw : null;
  const balanceN = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;
  const amountN = amountRaw != null && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;
  // The venue tx's network fee is paid in SOL on top of the swapped amount — when SOL is the
  // INPUT the honest available figure is the balance itself (the fee lives under the same SOL;
  // a dust edge fails on-chain and lands in the honest failure state, never a false pass).
  const insufficient = legs != null && amountN > 0n && balanceN != null && amountN > balanceN;
  const canConfirm = legs != null && !quoteBusy && !confirmBusy && !insufficient && amountN > 0n
    && (cefiMode ? cefiQuote != null && icSettleAddress != null : quote != null);

  const onConfirm = async () => {
    if (confirmBusyRef.current) return; // sync latch: a duplicate press before the re-render is a no-op
    if (legs == null || venue == null || amountRaw == null) return;
    if (legs.kind === 'cefi') {
      // The CeFi confirm — the IC surface's branch, mirrored rail-side. The re-quote exists
      // ONLY to mint a fresh quoteId (SideShift pins quoteId↔rate); there is deliberately NO
      // exact-match gate against the reviewed quote — a ticking venue rate can never be
      // matched exactly and the gate would livelock (the IC-side defect the same sweep found).
      // The ORDER is the lock and the consent point: its depositAmount is the reviewed
      // deposit, its settle figure is the venue's own locked number, and prepare still
      // refuses an order whose depositAmount differs.
      // The refund guard sits beside the settle guard: both addresses come from the
      // wallet's own key, and the order (per the relay's contract) needs both.
      if (icSettleAddress == null || solRefundAddress == null) {
        setConfirmErr(M.convert.errors.quoteUnavailable('order'));
        return;
      }
      confirmBusyRef.current = true;
      setConfirmBusy(true); setConfirmErr(null);
      try {
        let freshRes;
        try {
          // The 20s confirm budget, NOT the 8s review default (CONVERT_CEFI_CONFIRM_TIMEOUT_MS):
          // an abort below the relay's own 15s upstream bound means the phone gives up while
          // the venue is still answering — the order 201s venue-side, the record is never
          // adopted, and the deposit handoff never begins (the live attempt-#3 signature).
          freshRes = await fetchCeFiQuoteResult(relayUrl, venue, legs.inMint, legs.outLedger, rawToDecimal(amountRaw, legs.inDecimals), CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, venueName);
        }
        const fresh = ceFiQuoteFromResult(venue, legs.inMint, legs.outLedger, amountRaw, freshRes, legs.outDecimals);
        let order;
        try {
          // SOL-side cefi: the DEPOSIT rail is Solana, so the refund address — where the
          // venue returns the funds on a failed deposit or expiry — is this wallet's own
          // derived Solana address. The relay refuses any order without a well-formed one.
          order = await createCeFiOrder(relayUrl, venue, freshRes, {
            settleAddress: icSettleAddress,
            refundAddress: solRefundAddress,
            depositLedger: legs.inMint,
            settleLedger: legs.outLedger,
            depositAmountDecimal: rawToDecimal(amountRaw, legs.inDecimals),
          }, CONVERT_CEFI_CONFIRM_TIMEOUT_MS);
        } catch (e) {
          throw ceFiServiceError(e, venueName);
        }
        const rec = prepareCeFiConvertRecord({
          quote: fresh,
          order,
          relayUrl,
          settleAddress: icSettleAddress,
          inCurrency: null, // the INPUT is a Solana-rail asset — no IC catalog currency
          inSymbol: legs.inSym,
          outSymbol: legs.outSym,
          inDecimals: legs.inDecimals,
          outDecimals: legs.outDecimals,
        });
        if (!mountedRef.current) return;
        recordIdRef.current = rec.id;
        setRecord(rec);
        await adoptConvertRecord(rec);
      } catch (e) {
        setConfirmErr(e instanceof Error ? e.message : M.convert.errors.quoteUnavailable('unknown'));
      } finally {
        confirmBusyRef.current = false;
        setConfirmBusy(false);
      }
      return;
    }
    confirmBusyRef.current = true;
    setConfirmBusy(true); setConfirmErr(null);
    try {
      // Re-quote at the confirm gesture (the IC rule): a moved output gets a review line, never
      // a silent submit on stale digits.
      const fresh = await fetchJupiterQuote(relayUrl, venue, legs.inMint, legs.outMint, amountRaw, slippageBps);
      if (!fresh.ok) {
        setConfirmErr(M.convert.errors.quoteUnreachable(venueName));
        return;
      }
      if (quote != null && fresh.quote.outAmount !== quote.outAmount) {
        setQuote(fresh.quote);
        setQuoteChanged({oldAmt: quote.outAmount, newAmt: fresh.quote.outAmount});
        return;
      }
      const rec = await prepareSolanaConvertRecord({
        secretHex: identity.secretHex,
        relayUrl,
        quote: fresh.quote,
        inAsset: {symbol: legs.inSym, mint: legs.inMint, decimals: legs.inDecimals},
        outAsset: {symbol: legs.outSym, mint: legs.outMint, decimals: legs.outDecimals},
      });
      recordIdRef.current = rec.id;
      setRecord(rec);
      await adoptConvertRecord(rec);
    } catch (e) {
      setConfirmErr(e instanceof Error ? e.message : M.convert.errors.quoteUnavailable('unknown'));
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  };

  // The zero-balance fund gate, Solana side: the SAME shape + copy family as IC — land the
  // asset's own deposit surface (Receive ▸ My address works for Solana rows too), or point at
  // the OTHER leg when the user already holds it there (the pair's other side is the only
  // account that could ever help — the same argument as the IC gate).
  if (legs != null && balanceN === 0n) {
    const otherHeld = !cefiMode && outHeldRaw != null && /^\d+$/.test(outHeldRaw) && BigInt(outHeldRaw) > 0n
      ? fmtAssetCompact(outHeldRaw, legs.outDecimals, legs.outSym)
      : null;
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader
          title={cefiMode ? M.convert.heading(legs.inSym, legs.outSym) : M.convert.sol.heading(legs.inSym, legs.outSym)}
          onBack={onBack}
        />
        <InstructionPanel
          testID="convert-fund"
          title={M.pay.fundTitle(legs.inSym)}
          body={M.convert.fundBody(legs.inSym, M.wallet.tab.receive, M.receive.myAddress)}
          primaryLabel={M.pay.showMyAddress(legs.inSym)}
          onPrimary={onShowDepositAddress}
        />
        {otherHeld != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld, legs.inSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(`solana:${legs.outSym}`)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.fundOtherSwitch(legs.outSym)}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.fundOtherSwitch(legs.outSym)}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <View style={S.convertFooting}>
          <IconSwap size={20} color={C.sub} />
        </View>
      </View>
    );
  }

  if (legs == null || venue == null) {
    return (
      <View testID="convert-unavailable" style={S.convertWrap}>
        <ConvertHeader title={M.convert.actionConvert} onBack={onBack} />
        <Text testID="convert-unavailable-title" style={S.convertUnavailableTitle}>
          {M.convert.sol.unavailableTitle(asset.symbol)}
        </Text>
        <Text testID="convert-unavailable-body" style={S.convertUnavailableBody}>
          {M.convert.sol.unavailableBody(asset.symbol, venueName)}
        </Text>
        <View style={S.convertFooting}>
          <IconSwap size={20} color={C.sub} />
        </View>
      </View>
    );
  }

  if (showRecord && record != null) {
    // A provider-shaped record (the CeFi family) renders through the GENERIC StatePanel — its
    // awaiting_deposit handoff, provider_processing and refunded states are rail-agnostic and
    // already know the venue-driven machine; the SOL surface never had its own copy.
    return record.providerRef != null
      ? <StatePanel record={record} onBack={onBack} />
      : <SolStatePanel record={record} onBack={onBack} />;
  }

  const fmtIn = (raw: string) => fmtAssetCompact(raw, legs.inDecimals, legs.inSym);
  const fmtOut = (raw: string) => fmtAssetCompact(raw, legs.outDecimals, legs.outSym);
  const impact = quote?.priceImpactPct ?? null;
  const outEstimate = cefiMode
    ? (cefiQuote != null ? fmtOut(cefiQuote.amountOutGross) : null)
    : (quote != null ? fmtOut(quote.outAmount) : null);
  const outFloor = quote != null && !cefiMode ? fmtOut(quote.otherAmountThreshold) : null;

  return (
    <View testID="convert-screen" style={S.convertWrap}>
      <ConvertHeader
        title={cefiMode ? M.convert.heading(legs.inSym, legs.outSym) : M.convert.sol.heading(legs.inSym, legs.outSym)}
        onBack={onBack}
      />

      <Text style={S.convertAmountLabel}>{M.convert.amountLabel(legs.inSym)}</Text>
      <View style={S.amountRow}>
        <TextInput
          testID="convert-amount"
          style={S.amountInput}
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          autoCorrect={false}
          autoCapitalize="none"
          placeholderTextColor={C.sub}
        />
      </View>
      {balanceRaw != null ? (
        <Text testID="convert-balance" style={S.convertMetaLine}>{M.convert.balanceLine(fmtIn(balanceRaw))}</Text>
      ) : null}
      {insufficient && balanceN != null ? (
        <Text testID="convert-insufficient" style={S.err}>
          {cefiMode
            ? M.convert.cefi.solInsufficientLine(fmtIn(amountN.toString()), fmtIn(balanceN.toString()))
            : M.convert.insufficientLine(fmtIn(amountN.toString()), fmtIn(balanceN.toString()))}
        </Text>
      ) : null}

      {/* The out-destination (spec 2026-09-16 §2 decision 5, widened 2026-09-20): one row per
          DESTINATION ASSET — in-wallet SPL rows and the cefi rows settling onto the IC rail,
          in the venue chooser's own visual language — registry order, explicit pick, never
          chosen for the user. Only when there is a CHOICE: a single destination is a fact of
          the pair, not an option, and renders no chrome. */}
      {destGroups.length > 1 ? (
        <View testID="convert-sol-dest">
          <Text style={S.convertDestLabel}>{M.convert.multihop.destLabel}</Text>
          {destGroups.map(g => {
            const on = activeGroup?.key === g.key;
            const slowCefi = g.mechs[0]?.kind === 'cefi' ? g.mechs[0] : null;
            return (
              <Fragment key={g.key}>
              <Pressable
                testID={g.testID}
                style={[S.convertVenueRow, on && S.convertVenueRowOn]}
                onPress={() => pickDest(g.key)}
                accessibilityRole="radio"
                accessibilityState={{checked: on}}
                accessibilityLabel={g.label}>
                <View style={[S.convertVenueRadio, on && S.convertVenueRadioOn]}>
                  {on ? <View style={S.convertVenueRadioDot} /> : null}
                </View>
                <View style={S.convertVenueRowText}>
                  <Text style={[S.convertVenueName, on && S.convertVenueNameOn]}>{g.label}</Text>
                  {/* Settlement-SLA honesty (2026-09-20), same as the IC chooser. */}
                  {slowCefi != null && slowCefi.venue.health?.status === 'degraded' ? (
                    <Text testID={`convert-sol-dest-cefi-slow-${slowCefi.venue.venue_id}`} style={S.convertMetaLine}>
                      {M.convert.venueSlow}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              {/* The venue sub-picker for a merged group (the IC surface's convert-dest-mechs,
                  same shape): which SERVICE executes the spot the row names. Registry order,
                  never ranked; the default is the first. */}
              {on && g.mechs.length > 1 ? (
                <View testID="convert-sol-dest-mechs" style={S.convertMechGroup}>
                  {g.mechs.map(m => {
                    const id = solMechKeyOf(m);
                    const mechOn = activeMech != null && solMechKeyOf(activeMech) === id;
                    const mechLabel = m.kind === 'cefi'
                      ? M.convert.multihop.mechViaVenue(m.venue.display_name)
                      : M.convert.multihop.destDirect('SOL');
                    return (
                      <Pressable
                        key={id}
                        testID={`convert-sol-dest-mech-${id}`}
                        style={[S.convertVenueRow, mechOn && S.convertVenueRowOn]}
                        onPress={() => {
                          if (confirmBusy || mechOn) return;
                          setDestMechKey(id);
                          setQuote(null); setQuoteErr(null); setQuoteChanged(null); setQuoteBusy(false); setConfirmErr(null);
                        }}
                        accessibilityRole="radio"
                        accessibilityState={{checked: mechOn}}
                        accessibilityLabel={mechLabel}>
                        <View style={[S.convertVenueRadio, mechOn && S.convertVenueRadioOn]}>
                          {mechOn ? <View style={S.convertVenueRadioDot} /> : null}
                        </View>
                        <View style={S.convertVenueRowText}>
                          <Text style={[S.convertVenueName, mechOn && S.convertVenueNameOn]}>{mechLabel}</Text>
                          {m.kind === 'cefi' && m.venue.health?.status === 'degraded' ? (
                            <Text testID={`convert-sol-dest-mech-slow-${m.venue.venue_id}`} style={S.convertMetaLine}>
                              {M.convert.venueSlow}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              </Fragment>
            );
          })}
        </View>
      ) : null}

      {/* The CeFi payout target, shown BEFORE anything is created (the IC surface's exact
          slot): the user's own derived IC principal — read-only, selectable, never typed. */}
      {cefiMode && icSettleAddress != null ? (
        <View>
          <Text style={S.convertAmountLabel}>{M.convert.cefi.settleAddressLabel}</Text>
          <Text testID="convert-settle-address" style={S.convertMetaLine} selectable>{icSettleAddress}</Text>
        </View>
      ) : null}

      {/* The decision number + attribution — the IC headline card's exact shape, carrying the
          venue's OWN digits (Jupiter's outAmount / the cefi settle figure verbatim). The rate
          folds behind the Details control on the checklist card below (10x-verbosity pass
          2026-09-16); the attribution line stays — it is WHOSE number this is. */}
      {outEstimate != null ? (
        <View testID="convert-headline" style={S.convertHeadlineCard}>
          <Text style={S.convertHeadlineLabel}>{M.convert.receiveHeadline}</Text>
          <Text style={S.convertHeadlineAmount}>{outEstimate}</Text>
          <Text testID="convert-quote-source" style={S.convertHeadlineMeta}>
            {M.convert.quoteSource(nonBreakingClock(new Date((cefiMode ? cefiQuote : quote)?.fetchedAtMs ?? 0)), venueName)}
          </Text>
          {staleRefreshing ? (
            <Text testID="convert-stale" style={S.convertHeadlineMeta}>{M.convert.staleRefreshing}</Text>
          ) : null}
        </View>
      ) : null}

      {/* The pre-sign checklist, same rules as IC (10x-verbosity pass 2026-09-16): the main
          surface is the decision — slippage axis, the floor, quote-change warning. The
          venue/fee/signing census folds behind ONE Details control (default CLOSED). The V8
          impact exception still holds — Jupiter DOES publish a price-impact figure — but it
          too is census, not decision, so it lives behind the same control. */}
      <View style={S.convertChecklistCard}>
        {/* A fixed-shift CeFi order has NO slippage axis (its rate is LOCKED at order creation
            — the same reason the IC cefi surface hides this block). */}
        {!cefiMode ? (
        <View testID="convert-slippage">
          <Text style={S.convertSlippageLabel}>{M.convert.slippageLabel}</Text>
          <View
            testID="convert-slippage-chips"
            style={S.convertSlippageRow}
            accessibilityRole="radiogroup"
            accessibilityLabel={M.convert.slippageLabel}>
            {CONVERT_SLIPPAGE_BPS_OPTIONS.map((bps) => (
              <Pressable
                key={bps}
                testID={`convert-bps-${bps}`}
                style={[S.convertSlippageChip, slippageBps === bps && S.convertSlippageChipOn]}
                onPress={() => setSlippageBps(bps)}
                accessibilityRole="radio"
                accessibilityState={{selected: slippageBps === bps}}
                accessibilityLabel={formatBps(bps)}>
                <Text style={[S.convertSlippageChipText, slippageBps === bps && S.convertSlippageChipTextOn]}>{formatBps(bps)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        ) : null}
        {/* The floor is the VENUE'S OWN otherAmountThreshold — Jupiter computed it against the
            chosen slippage; dpay derives nothing here (V8). A cefi order's floor IS its locked
            settle figure — no second number, so no floor line (the IC cefi rule). */}
        {!cefiMode ? (
          <Text testID="convert-min-out" style={S.convertMinOutLine}>
            {M.convert.minReceiveLine(outFloor ?? '', formatBps(slippageBps))}
          </Text>
        ) : null}
        {quoteChanged != null ? (
          <Text testID="convert-quote-changed" style={S.convertChecklistWarn}>
            {M.convert.quoteChanged(fmtOut(quoteChanged.oldAmt), fmtOut(quoteChanged.newAmt))}
          </Text>
        ) : null}
        {/* The one Details control, at the bottom of the decision card. Default CLOSED. */}
        <DetailsToggle
          open={detailsOpen}
          onToggle={() => setDetailsOpen(o => !o)}
          label={M.convert.detailsLabel}
        />
        {detailsOpen ? (
          <View testID="convert-details-block">
            {!cefiMode && quote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(legs.inSym, legs.outSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(quote.outAmount, quote.inAmount, legs.inDecimals), legs.outDecimals, legs.outSym)}</Text>
              </View>
            ) : null}
            {cefiMode && cefiQuote != null ? (
              <View testID="convert-rate" style={S.convertRateRow}>
                <Text style={S.convertRateLabel}>{M.convert.rateLabel(legs.inSym, legs.outSym)}</Text>
                <Text style={S.convertRateValue}>{fmtAssetCompact(scaledRate(cefiQuote.amountOutGross, cefiQuote.amountIn, legs.inDecimals), legs.outDecimals, legs.outSym)}</Text>
              </View>
            ) : null}
            <View testID="convert-counterparty">
              <Text style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.counterparty(venueName) : M.convert.sol.counterparty(venueName)}
              </Text>
              {/* The IC-side cefi rule: NO pool-principal line — the venue's https API base is
                  where the relay carries the partner key, not a depositor-checkable fact. */}
              {!cefiMode ? (
                <Text testID="convert-pool-principal" style={S.convertPrincipal}>{venue.endpoint}</Text>
              ) : null}
              <Text style={S.convertChecklistLine}>
                {cefiMode ? M.convert.cefi.checklistSigns : M.convert.sol.counterpartySigns}
              </Text>
            </View>
            <Text testID="convert-venue-disclosure" style={S.convertChecklistLine}>
              {venueDisclosure(venue.venue_id)}
            </Text>
            {!cefiMode && impact != null ? (
              <Text testID="convert-sol-impact" style={S.convertChecklistLine}>
                {M.convert.sol.priceImpactLine(impact, venueName)}
              </Text>
            ) : null}
            {/* The refusal consequence (context, not an active error — the active error
                branches never fold). */}
            <Text testID="convert-refusal" style={S.convertChecklistLine}>
              {cefiMode ? M.convert.cefi.refusalLine(legs.inSym) : M.convert.sol.refusalLine(legs.inSym)}
            </Text>
            {/* Fee census, Solana side: the ROUTE's fees are inside the quoted output (Jupiter
                publishes no separate tier through this keyless integration — platformFee null,
                measured 2026-09-14); the network fee is quoted per-tx at prepare and shows on
                the record panels. The old fees-note + dpay line are GONE (10x-verbosity pass
                2026-09-16): the route fee is already inside the quoted number the headline
                shows, and dpay's nothing-charged line lives nowhere on the surface. */}
          </View>
        ) : null}
      </View>

      {quoteErr != null ? (
        <Text testID="convert-quote-err" style={S.err}>{quoteErr}</Text>
      ) : null}
      {confirmErr != null ? (
        <Text testID="convert-confirm-err" style={S.err}>{confirmErr}</Text>
      ) : null}

      <Pressable
        testID="btn-convert-confirm"
        style={[S.primary, !canConfirm && S.disabledFlat]}
        onPress={() => void onConfirm()}
        disabled={!canConfirm}
        accessibilityRole="button"
        accessibilityState={{disabled: !canConfirm}}
        accessibilityLabel={M.convert.confirmButton}>
        {confirmBusy || quoteBusy ? (
          <View style={S.convertBtnBusyRow}>
            <ActivityIndicator color={C.card} />
            <Text style={S.primaryText}>{M.convert.confirmButton}</Text>
          </View>
        ) : (
          <Text style={[S.primaryText, !canConfirm && S.disabledText]}>{M.convert.confirmButton}</Text>
        )}
      </Pressable>
      <View style={S.convertFooting}>
        <IconSwap size={20} color={C.sub} />
      </View>
    </View>
  );
}
