// ConvertMode — the convert ROUTE HOST (the two-tap intent sheet, brief Part V 2026-09-26).
//
// This file is the shell: the venue-registry load, the pair walk, the fail-closed gates (the
// no-route panel, the zero-balance fund gate), the engine view (V6 — the newest live record
// renders on entry, whatever this screen adopts renders as it updates), and the record-kind
// routing. The DECISION SURFACE itself is ConvertIntentSheet (the pre-computed sheet; tap 1
// was the entry, tap 2 is its CTA). After the confirm, the screen floods to the Settlement
// Field: ConvertFieldTracker renders the direct and hub record kinds; the CeFi provider,
// cross-rail and Solana record kinds keep their own panels — their deposit handoff, calldata
// signing and chain watches are their own surfaces, unchanged.
//
// The engine (app/convertResume.ts + hooks/useConvertResumeEngine) is reused WHOLE: records
// are prepared at the confirm gesture and adopted; this screen is a read model over the
// engine's notifications from then on.
import {useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, Text, View} from 'react-native';
import type {CurrencyDescriptor} from '../config/catalog';
import type {SelectableAsset} from '../config/assets';
import {currencyOfAsset, type HomeCurrency} from '../config/currency';
import {resolveSwapTargets, type SwapTarget} from '../config/swap';
import {loadVenueRegistry, TERMINAL_CONVERT_STEPS, type ConvertRecord} from '../convert';
import type {VenueEntry} from '../config/venues';
import {adoptConvertRecord, convertResumeSnapshot, subscribeConvertRecords} from '../convertResume';
import {isEvmRailConfigured} from '../evm';
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';
import {M} from '../i18n';
import {fmtAssetCompact} from '../lib/format';
import type {AssetId, Identity} from '../lib/types';
import type {BalanceView} from '../lib/assetBalances';
import {S} from '../styles';
import {InstructionPanel} from './InstructionPanel';
import {ConvertHeader, isLiveRecord, UnavailablePanel} from './ConvertShared';
import {ConvertFieldTracker, ConvertIntentSheet} from './ConvertIntentSheet';
import {StatePanel} from './ConvertStatePanel';
import {CrossRailStatePanel} from './ConvertCrossRailStatePanel';
import {SolStatePanel} from './SolStatePanel';

type Props = {
  identity: Identity;
  relayUrl: string;
  catalog: CurrencyDescriptor[];
  /** The standing SOURCE rail — resolved by the entry gesture (chooseRail: the funded rail,
   *  else the stated preference). Null renders the fail-closed panel. */
  selectedAsset: SelectableAsset | null;
  /** The user's spendable raw-unit balance strings for IC assets, if known. */
  assetBalances: Record<number, string>;
  /** The VISIBLE currencies, in list order — the swap's target scope (a hidden currency is
   *  re-added via Add new currency first; that is the list-first IA's own answer). */
  visibleCurrencies: readonly HomeCurrency[];
  /** The per-currency SUMMED views — both balance lines render in currency unit (fork #4). */
  currencyBalances: Readonly<Partial<Record<HomeCurrency, BalanceView>>>;
  /** The wallet's home currency — a non-stable source's default target (brief 5.3). */
  homeCurrency?: HomeCurrency | null;
  onBack: () => void;
  /** The zero-balance gate's one action: land the selected asset's own deposit surface. */
  onShowDepositAddress: () => void;
  /** Switch the wallet's selection (the funded-account pointer on the fund gate). Absent while
   *  the wallet's selection is locked — the account is still named, the button withheld. */
  onSwitchAsset?: (id: AssetId) => void;
  /** Solana-rail balances: raw-unit spendable SOL (lamports) + per-mint token amounts. The
   *  fund gate + insufficient check read these; absent/empty means "unknown" (fail soft). */
  solana?: {sol: string | null; tokens: Record<string, string | null>};
};

export function ConvertMode({
  identity, relayUrl, catalog, selectedAsset, assetBalances, visibleCurrencies,
  currencyBalances, homeCurrency, onBack, onShowDepositAddress, onSwitchAsset, solana,
}: Props) {
  const sourceCurrency: HomeCurrency | null = selectedAsset != null ? currencyOfAsset(selectedAsset) : null;
  const isSolSource = selectedAsset?.protocol === 'solana';
  const inMint: string | null = isSolSource ? (selectedAsset!.mint ?? WRAPPED_SOL_MINT_ADDRESS) : null;
  const inSym: string = selectedAsset == null
    ? ''
    : isSolSource
      ? selectedAsset.symbol
      : assetSymOf(catalog, selectedAsset);
  // The SOURCE balance the gates compute against — the standing rail's own raw figure.
  const balanceRaw: string | null = selectedAsset == null
    ? null
    : isSolSource
      ? (inMint === WRAPPED_SOL_MINT_ADDRESS ? solana?.sol ?? null : solana?.tokens[inMint ?? ''] ?? null)
      : selectedAsset.protocol === 'ic'
        ? assetBalances[selectedAsset.currency]
        : null;
  const balanceN = balanceRaw != null && /^\d+$/.test(balanceRaw) ? BigInt(balanceRaw) : null;

  // ── The resolved pair ────────────────────────────────────────────────────────────────────
  const targetScope = useMemo(
    () => visibleCurrencies.filter(c => c !== sourceCurrency),
    [visibleCurrencies, sourceCurrency],
  );
  // The relay's served venue registry (V5): what THIS relay serves, loaded once per relay;
  // the bundled table is the fallback until it lands. Key input to the pair walk — when the
  // served registry lands (the knob-armed fixture venue, a new pool) the pairs re-resolve.
  const [venueList, setVenueList] = useState<readonly VenueEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadVenueRegistry(relayUrl);
      if (!cancelled) setVenueList(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);
  // The EVM rail's own gate (the same `isEvmRailConfigured` the asset list reads): it
  // enables the EVM-NATIVE settle rails in the pair walk (ICP → native ETH). Off — the
  // default under jest/e2e with the rail unseeded — the walk resolves exactly the
  // pre-ETH pairs; a destination whose arrival the device cannot show is not offered
  // (no silent dead ends).
  const evmEnabled = isEvmRailConfigured();
  const targets: SwapTarget[] = useMemo(
    () => selectedAsset != null
      ? resolveSwapTargets({catalog, source: selectedAsset, targetCurrencies: targetScope, evmEnabled}) ?? []
      : [],
    [selectedAsset, catalog, targetScope, venueList, evmEnabled],
  );

  // ── The engine view (V6): pick the record to render, then follow it. The resume engine
  //    (hooks/useConvertResumeEngine, mounted from Wallet) drives EVERY live record from wallet
  //    load — this screen is a read model: the newest live/pending record on mount, then
  //    whatever updates arrive for the record this screen adopted or confirmed.
  const [record, setRecord] = useState<ConvertRecord | null>(null);
  const recordIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const pick = (records: Record<string, ConvertRecord>) => {
      const id = recordIdRef.current;
      if (id != null) {
        setRecord(records[id] ?? null);
        return;
      }
      const live = Object.values(records)
        .filter((r) => isLiveRecord(r)
          || (r.step === 'stuck' && r.acknowledgedStuckAtMs == null)) // still needs the user's eye
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
      if (live != null) recordIdRef.current = live.id;
      setRecord(live);
    };
    pick(convertResumeSnapshot());
    const unsubscribe = subscribeConvertRecords((records) => {
      if (mountedRef.current) pick(records);
    });
    return () => {
      unsubscribe();
      mountedRef.current = false;
    };
    // identity/relayUrl are stable for the wallet session; the view binds once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The sheet's confirm handoff: adopt the freshly prepared record into the engine and let
  // the routing below render it (the Settlement Field tracker, or the kind's own panel).
  const onPrepared = (rec: ConvertRecord) => {
    recordIdRef.current = rec.id;
    setRecord(rec);
    void adoptConvertRecord(rec);
  };

  // ── Early returns (AFTER every hook — the 196 rule). ─────────────────────────────────────
  if (selectedAsset == null || targets.length === 0) {
    return <UnavailablePanel
      selectedAsset={selectedAsset}
      onBack={onBack}
      onAddMoney={selectedAsset != null ? onShowDepositAddress : undefined}
    />;
  }
  if (record != null && (isLiveRecord(record) || TERMINAL_CONVERT_STEPS.has(record.step))) {
    // A COMPOSED record (the IC+CeFi chain) renders through the Settlement Field tracker:
    // its legPlan is the same planned-leg list (the deposit transfer is its last leg, in the
    // pre-provisioned depositLeg copy), and its awaiting_deposit phase is the venue payout
    // watch — the generic provider panel's manual-deposit instructions would be false here.
    // A provider-shaped LEGLESS record (the plain CeFi family) renders through the GENERIC
    // StatePanel; a CROSS-RAIL record carries the IC leg list PLUS the crossing phases; a
    // plain Solana record renders its own machine; the direct and hub (legPlan) kinds flood
    // to the tracker with it.
    if (record.composedDeposit != null) return <ConvertFieldTracker record={record} onBack={onBack} />;
    // A CHAIN record (the any-pair widening, 2026-09-28) renders through the Settlement
    // Field tracker too: its phase-1 narration is the venue order + the signed deposit
    // (the generic provider panel's MANUAL-deposit instructions would be false — the
    // device signed the transfer), and its phase-2 legs join the planned-leg list.
    if (record.chainRoute != null) return <ConvertFieldTracker record={record} onBack={onBack} />;
    if (record.providerRef != null) return <StatePanel record={record} onBack={onBack} />;
    if (record.crossRail != null) {
      return <CrossRailStatePanel record={record} secretHex={identity.secretHex} relayUrl={relayUrl} solLamports={solana?.sol ?? null} onBack={onBack} />;
    }
    if (record.solanaLeg != null) return <SolStatePanel record={record} onBack={onBack} />;
    return <ConvertFieldTracker record={record} onBack={onBack} />;
  }

  // The zero-balance gate: the Pay tab's fund-gate shape, pointed at the ONE surface that can
  // fund this asset (Receive ▸ My address — reachable from the bottom nav on this very screen).
  if (balanceN === 0n) {
    // The funded-account pointer, generalized to the pair walk: the first TARGET rail (in
    // resolution order) this wallet provably holds value on. A balance that has not been read
    // (null) is not a zero and is not offered — the same fail-open rule the gate uses.
    let otherHeld: {held: string; toSym: string; assetId: AssetId} | null = null;
    for (const t of targets) {
      for (const r of t.rows) {
        if (r.kind !== 'direct' && r.kind !== 'solamm') continue;
        const raw = r.kind === 'direct'
          ? assetBalances[r.outDesc.currency]
          : (r.outMint === WRAPPED_SOL_MINT_ADDRESS ? solana?.sol ?? null : solana?.tokens[r.outMint] ?? null);
        if (raw != null && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
          otherHeld = {
            held: r.kind === 'direct'
              ? fmtAssetCompact(raw, r.outDesc.decimals ?? 8, r.outDesc.backing_symbol ?? r.outDesc.symbol ?? '')
              : fmtAssetCompact(raw, r.outDecimals, r.outSym),
            toSym: inSym,
            assetId: r.kind === 'direct' ? `ic:${r.outDesc.currency}` as AssetId : `solana:${r.outSym}` as AssetId,
          };
          break;
        }
      }
      if (otherHeld != null) break;
    }
    return (
      <View testID="convert-screen" style={S.convertWrap}>
        <ConvertHeader title={M.convert.actionConvert} onBack={onBack} />
        <InstructionPanel
          testID="convert-fund"
          title={M.pay.fundTitle(inSym)}
          body={M.convert.fundBody(inSym, M.wallet.tab.receive, M.receive.myAddress)}
          primaryLabel={M.pay.showMyAddress(inSym)}
          onPrimary={onShowDepositAddress}
        />
        {otherHeld != null ? (
          <View testID="convert-fund-other">
            <Text testID="convert-fund-other-holds" style={S.convertMetaLine}>
              {M.convert.fundOtherHolds(otherHeld.held, otherHeld.toSym)}
            </Text>
            {onSwitchAsset ? (
              <Pressable
                testID="btn-convert-fund-other"
                style={S.linkBtn}
                onPress={() => onSwitchAsset(otherHeld!.assetId)}
                accessibilityRole="button"
                accessibilityLabel={M.convert.fundOtherSwitch(otherHeld.held)}
                accessibilityState={{disabled: false}}
              >
                <Text style={S.linkText}>{M.convert.fundOtherSwitch(otherHeld.held)}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <ConvertIntentSheet
      identity={identity}
      relayUrl={relayUrl}
      catalog={catalog}
      selectedAsset={selectedAsset}
      assetBalances={assetBalances}
      currencyBalances={currencyBalances}
      targets={targets}
      homeCurrency={homeCurrency ?? null}
      balanceRaw={balanceRaw}
      onPrepared={onPrepared}
      onBack={onBack}
    />
  );
}

/** The standing rail's display symbol (the backing currency when the catalog names one). */
function assetSymOf(catalog: CurrencyDescriptor[], asset: SelectableAsset): string {
  if (asset.protocol !== 'ic') return asset.symbol;
  const row = catalog.find(c => c.currency === asset.currency);
  return row?.backing_symbol ?? row?.symbol ?? asset.symbol;
}
