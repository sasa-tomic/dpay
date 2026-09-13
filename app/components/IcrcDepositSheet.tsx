import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {View, Text, Pressable, ActivityIndicator, Platform} from 'react-native';
import {QrCode} from './QrCode';
import {C} from '../config/palette';
import {S} from '../styles';
import {POLL, QR_SIZE_SMALL} from '../config/constants';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import {type CurrencyDescriptor, displayName, fmtCurrencyAmountCompact} from '../config/catalog';
import {type SelectableAsset, linkNetworkOf, prettyNetwork} from '../config/assets';
import {railBalanceOf} from '../services/rail';
import {DpayCore} from '../services/native';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {IconCheck, IconCopy} from './icons';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';

/**
 * IC-rail receive sheet (2026-08-29 founder hard rule: every funding gate gives useful practical
 * instructions — never a "check back soon" dead end). Serves two reachable-by-caller cases that
 * share ONE address shape: the user's OWN ICRC-1 account (owner = self-authenticating principal,
 * default subaccount) on the asset's ledger — the exact rail payments already use. (a) complete
 * no-minter rows (VCHF/ICP): a plain icrc1_transfer from ANY Internet Computer wallet. (b) the
 * home currency's IC rail (Objective 2: home=USD on ckUSDC) — the group's rail address with the
 * rail disclosure above it. The "address" is derived LOCALLY by the core (no gateway round trip)
 * and shown as QR + copyable text with honest instructions: send this asset only, no memo
 * needed, the ledger fee from the catalog, and the dpay-never-holds/never-converts line. The
 * network named in the instructions is the SETTLEMENT chain (linkNetworkOf), never the catalog's
 * `network` field — that one names the chain a wrapper is BACKED by (ckUSDC: "Ethereum") and
 * would misdirect a same-chain send. Reachability is the CALLER's call (ReceiveMode's rail
 * routing); this sheet fails closed only on incomplete data. Receive detection is the same
 * honest watch as DepositSheet: a signed icrc1_balance_of baseline + strictly-higher delta.
 */
export function IcrcDepositSheet({identity, catalog, asset, funding, onClose}: {identity: Identity; catalog: CurrencyDescriptor[]; asset: SelectableAsset; funding?: ReactNode; onClose: () => void}) {
  // SelectableAsset is a discriminated union and this sheet is IC-only by contract (ReceiveMode's
  // rail routing never passes a Solana row); a stray non-IC row narrows to a null descriptor and
  // hits the same fail-closed path as an incomplete one.
  const desc = asset.protocol === 'ic' ? catalog.find(c => c.currency === asset.currency) ?? null : null;
  const [principal, setPrincipal] = useState<string | null>(null);
  const [receivedTotal, setReceivedTotal] = useState<string | null>(null);
  // Balance baseline (first successful ledger read while open); received = strictly above it.
  const baselineRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const {copied, copy: doCopy} = useCopyFeedback();
  const [checkBusy, setCheckBusy] = useState(false);

  useEscapeToClose(onClose);

  // The receive address is the user's OWN principal — derived locally (a derivation failure is
  // the only error path; no network dependency at this step).
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr(null);
      try {
        if (desc == null || !desc.ledger) { if (alive) setErr(M.deposit.ck.noAddress); return; }
        const p = await DpayCore.icpSelfPrincipal(identity.secretHex);
        if (alive) setPrincipal(p);
      } catch {
        if (alive) setErr(M.deposit.ck.addressErr);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [identity.secretHex, desc]);

  // ONE refresh reused by BOTH the poll and the manual "Check now" — single source of truth,
  // mirroring DepositSheet's honest watch (baseline + strictly-higher delta).
  const refreshNow = useCallback(async (manual: boolean) => {
    if (manual) setCheckBusy(true);
    try {
      const ledger = desc?.ledger ?? '';
      if (!ledger) return;
      const bal = await railBalanceOf(identity.secretHex, ledger);
      if (bal != null) {
        const base = baselineRef.current;
        if (base == null) {
          baselineRef.current = bal; // first successful read while open — the watching baseline
        } else if (cmpRaw(bal, base) > 0) {
          setReceivedTotal((BigInt(bal) - BigInt(base)).toString());
        }
      }
    } catch (e) { console.warn('icrc receive balance recheck failed: ', e); }
    finally { if (manual) setCheckBusy(false); }
  }, [identity.secretHex, desc]);

  // Poll every POLL.deposit while open; cleans up on close.
  useEffect(() => {
    let alive = true;
    const poll = () => { if (alive) { refreshNow(false); } };
    poll(); const id = setInterval(poll, POLL.deposit);
    return () => { alive = false; clearInterval(id); };
  }, [refreshNow]);

  const copy = useCallback(async () => {
    if (principal) { await doCopy(principal); }
  }, [principal, doCopy]);

  const symbol = desc ? displayName(desc) : '';
  // The SETTLEMENT chain (linkNetworkOf → "Internet Computer"), never the catalog's `network` —
  // that field names the chain a wrapper is BACKED by (ckUSDC: "Ethereum"), which would misdirect
  // the sender off the rail this address actually lives on.
  const network = prettyNetwork(linkNetworkOf(asset));
  // The ledger fee from the catalog descriptor (already formatted in the asset's own units); the
  // feeNone word only renders for a malformed descriptor the caller failed to gate out.
  const feeVal = desc && desc.fee != null ? fmtCurrencyAmountCompact(catalog, desc.currency, desc.fee) : M.deposit.ck.feeNone;

  const body = (
    <>
      {loading ? (
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brandText} />
          <Text style={S.dim2}>{M.deposit.ck.fetchingAddress}</Text>
        </View>
      ) : err || !principal ? (
        <View style={S.centerAll}>
          <Text style={S.err}>{err ?? M.deposit.ck.noAddress}</Text>
        </View>
      ) : receivedTotal != null ? (
        <View style={S.centerAll}>
          <View style={S.check}><IconCheck size={44} color={C.brandInk}/></View>
          <Text style={S.paidText}>{M.deposit.deposited}</Text>
          <Text style={S.paidSub}>{M.deposit.icrc.receivedAmount(desc ? fmtCurrencyAmountCompact(catalog, desc.currency, receivedTotal) : '')}</Text>
          <Text style={S.dim2}>{M.deposit.balanceAuto}</Text>
          <Pressable testID="btn-deposit-done" style={[S.ghostBtn, S.ghostBtnMuted]} onPress={onClose} accessibilityRole="button" accessibilityLabel={M.common.done} accessibilityState={{disabled: false}}><Text style={S.ghostBtnText}>{M.common.done}</Text></Pressable>
        </View>
      ) : (
        <>
          {/* Complete, practical instructions: which asset, from where, no-memo, the exact
              network fee, and the non-custody line. All facts from the catalog descriptor. */}
          <View testID="deposit-instructions" style={S.instrCard}>
            <InstrLine runs={M.deposit.icrc.sendToAccount(symbol, network)} />
            {/* WHERE from, and what this address is. "From any Internet Computer wallet" is a
                complete instruction only for someone who already has one; the target user is a
                tourist who does not. These two lines name the kind of thing to look for, the other
                route that exists (an exchange withdrawal), and the fact that an address is not a
                card payment — without naming a product, which is a founder decision. */}
            <Text testID="deposit-where-from" style={S.instrLine}>{M.deposit.icrc.whereFrom(symbol, network)}</Text>
            <Text testID="deposit-only-accepts" style={S.instrMeta}>{M.deposit.icrc.onlyAccepts(symbol, network)}</Text>
            <Text style={S.instrMeta}>{M.deposit.icrc.noMemo}</Text>
            <Text style={S.instrMeta}>{M.deposit.icrc.feeLine(feeVal)}</Text>
            <Text style={S.instrCustody}>{M.deposit.icrc.custody(symbol)}</Text>
          </View>

          <View testID="deposit-qr" style={S.qrCard}><QrCode value={principal} size={QR_SIZE_SMALL} ecl="L" /></View>

          <Text testID="deposit-address" style={S.sheetAddr} selectable={true}>{principal}</Text>

          <Pressable
            testID="btn-deposit-copy"
            accessibilityRole="button"
            accessibilityLabel={copied === 'clipboard' ? M.deposit.addressCopied : copied === 'shared' ? M.deposit.addressShared : M.deposit.ck.copyDepositAddress}
            style={[S.primaryWide, S.depositCopy]}
            onPress={copy}>
            <IconCopy size={18} color={C.brandInk}/>
            <Text style={S.primaryText}>{copied === 'clipboard' ? M.deposit.copied : copied === 'shared' ? M.deposit.shared : M.deposit.copyAddress}</Text>
          </Pressable>

          {/* Same honest single progress cue as DepositSheet: watching + manual nudge. */}
          <View testID="deposit-status" style={S.depositStatus}>
            <Text style={S.depositStatusTitle}>{M.deposit.ck.statusTitle}</Text>
            <Text style={S.depositStatusMain}>{M.deposit.ck.watching}</Text>
            <Text style={S.depositStatusRow}>{M.deposit.ck.checkingEvery(POLL.deposit / 1000)}</Text>
          </View>

          <Pressable
            testID="btn-deposit-check"
            accessibilityRole="button"
            accessibilityLabel={M.deposit.ck.checkNowLabel}
            accessibilityState={{disabled: checkBusy}}
            style={[S.checkBtn, checkBusy && S.dim]}
            disabled={checkBusy}
            onPress={() => refreshNow(true)}>
            {checkBusy
              ? <ActivityIndicator size="small" color={C.brandText} />
              : <Text style={S.checkBtnText}>{M.deposit.checkNow}</Text>}
          </Pressable>

          {/* The step BEFORE the address (founder direction 2026-09-09). This sheet's instructions
              are complete and were still a dead end: "send VCHF from an Internet Computer wallet"
              names a thing the target user has never heard of. Built by the CALLER, because the
              caller is what picked this sheet: the mechanism that routed here is the mechanism the
              instruction must be written from, and a sheet that assembled its own could describe a
              different deposit than the one it implements. Placement is this sheet's, though — it
              renders only in the waiting state, never over a completed deposit. */}
          {funding}

          {Platform.OS === 'web' ? <Text style={S.dim2}>{M.deposit.pressEsc}</Text> : null}
        </>
      )}
    </>
  );

  return <View style={S.sheetBody}>{body}</View>;
}
