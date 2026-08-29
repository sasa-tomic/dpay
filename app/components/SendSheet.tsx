import {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import type {Identity} from '../lib/types';
import type {CurrencyDescriptor} from '../config/catalog';
import {displayName, fmtCurrencyAmount, isTestnetCurrency, testnetDisplayName} from '../config/catalog';
import {detectAddressShape, routeForShape, chainNameOfShape} from '../lib/destination';
import {prepareTransfer, prepareLegacyTransfer, submitTransfer, decodeLegacyReply, type RailPrepared, type RailOutcome} from '../services/rail';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {DpayCore} from '../services/native';
import {AddressField, shortAddress} from './AddressField';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconCheck, IconClock} from './icons';
import {M} from '../i18n';

/**
 * Send an IC asset to an EXTERNAL address — the direct rails: an `icrc1_transfer` to any ICRC-1
 * account, or the ICP ledger's legacy `transfer` to a 64-hex account identifier.
 *
 * ONE destination field decides which. `app/lib/destination.ts` classifies what was pasted or
 * scanned and this sheet renders the consequence BEFORE the user commits: which chain, how long,
 * what fee — or, when the address cannot be used, exactly what it is and what to do instead.
 *
 * NOT the chain-key offramp. Burning ckBTC/ckETH to a native chain stays in `WithdrawSheet`, which
 * owns the multi-step approve→minter sequence and its double-burn resume discipline; this sheet is
 * a single envelope. The Pay tab's send sub-mode picks between the two by the ROUTE the typed
 * destination resolves to, so the user never chooses a mechanism — they paste an address.
 *
 * Envelope discipline (rail-wide): a prepared envelope is submitted VERBATIM and never re-signed —
 * a fresh signature is a fresh request_id, i.e. a second payment. An 'unknown' outcome is honest
 * pending, never a failure, and the retained envelope is what a retry would resubmit.
 */
export function SendSheet({
  identity, desc, balance, onSent, onClose,
}: {
  identity: Identity;
  desc: CurrencyDescriptor;
  balance: string;
  onSent: () => void;
  onClose: () => void;
}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'unknown'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [blockIndex, setBlockIndex] = useState<string>('');
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  const [saveName, setSaveName] = useState('');
  // The core's verdict on the CURRENT address text: the canonical destination, or the reason it
  // cannot be used. Resolved asynchronously (the validators are the real base32/CRC parsers, not
  // regexes), so it lags the keystroke by a tick — `checking` suppresses a flash of "mistyped"
  // while an in-progress address is still being typed.
  const [resolved, setResolved] = useState<ResolvedDestination | null>(null);
  const [selfAccount, setSelfAccount] = useState<{principal: string; accountId: string} | null>(null);

  useEscapeToClose(onClose);

  const decimals = desc.decimals ?? 0;
  const displayDecimals = desc.display_decimals ?? decimals;
  const unit = desc.backing_symbol ?? desc.symbol ?? '';
  const assetName = isTestnetCurrency(desc) ? testnetDisplayName(desc) : displayName(desc);
  const feeRaw = desc.fee ?? '0';
  const assetKey = `ic:${desc.currency}`;
  const fmt = useCallback(
    (raw: string) => fmtAsset(raw, decimals, unit, displayDecimals),
    [decimals, unit, displayDecimals],
  );

  // The user's own accounts, in BOTH namespaces — the self-send guard. An account identifier is a
  // one-way hash, so recognising our own means deriving it; there is no way to invert theirs.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const principal = await DpayCore.icpSelfPrincipal(identity.secretHex);
        const accountId = await DpayCore.icpAccountIdFromPrincipal(principal, '');
        if (alive) setSelfAccount({principal, accountId});
      } catch (e: unknown) {
        // Non-fatal: without this the self-send WARNING is absent, but nothing is blocked and no
        // send is affected. Logged rather than surfaced — it is not the user's problem.
        console.warn('self-account derivation failed:', e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [identity.secretHex]);

  useEffect(() => {
    let alive = true;
    loadAddressBook(assetKey).then(list => { if (alive) setSaved(list); });
    return () => { alive = false; };
  }, [assetKey]);

  // Resolve the typed destination: shape → route → the core validator for that route. Generation-
  // guarded so a slow validation for an older keystroke can never overwrite a newer verdict.
  useEffect(() => {
    const text = address.trim();
    if (text.length === 0) { setResolved(null); return; }
    let alive = true;
    (async () => {
      const r = await resolveDestination(text, desc);
      if (alive) setResolved(r);
    })();
    return () => { alive = false; };
  }, [address, desc]);

  const raw = toUnits(amountStr, decimals);
  const overBalance = cmpRaw(raw, balance) > 0;
  // Fee is charged ON TOP of the amount by the ledger, so the spendable maximum is balance − fee.
  const maxSpendable = useMemo(() => {
    const b = BigInt(balance || '0');
    const f = BigInt(feeRaw || '0');
    return b > f ? (b - f).toString() : '0';
  }, [balance, feeRaw]);
  const total = useMemo(() => (BigInt(raw || '0') + BigInt(feeRaw || '0')).toString(), [raw, feeRaw]);
  const overTotal = cmpRaw(total, balance) > 0;
  const isSelf = !!resolved?.ok && !!selfAccount && (
    (resolved.kind === 'icrc' && resolved.owner === selfAccount.principal && resolved.subaccountHex === '') ||
    (resolved.kind === 'icp-legacy' && resolved.accountId === selfAccount.accountId)
  );
  const canSend = !!resolved?.ok && raw !== '0' && !overTotal && phase === 'form';

  // The one status line under the address field: route disclosure when usable, the specific reason
  // when not. Never a bare "invalid address" — every branch names what the address IS.
  const status = useMemo((): {text: string; tone: 'ok' | 'warn' | 'bad'} | null => {
    if (address.trim().length === 0) return null;
    if (resolved == null) return null; // still resolving — say nothing rather than flash a refusal
    if (!resolved.ok) return {text: resolved.message, tone: 'bad'};
    if (isSelf) return {text: M.withdraw.send.selfWarning, tone: 'warn'};
    const feeText = fmt(feeRaw);
    return {
      text: resolved.kind === 'icp-legacy'
        ? M.withdraw.send.routeLegacy(feeText)
        : M.withdraw.send.routeIcrc(desc.network ?? 'Internet Computer', feeText),
      tone: 'ok',
    };
  }, [address, resolved, isSelf, fmt, feeRaw, desc.network]);

  async function send() {
    if (!canSend || !resolved?.ok) return;
    setPhase('submitting');
    setErr(null);
    try {
      if (!desc.ledger) throw new Error(M.withdraw.send.noLedger);
      let prepared: RailPrepared;
      let out: RailOutcome;
      if (resolved.kind === 'icp-legacy') {
        prepared = await prepareLegacyTransfer(identity.secretHex, {
          ledger: desc.ledger, toAccountId: resolved.accountId, amountE8s: raw, feeE8s: feeRaw,
        });
        out = await submitTransfer(prepared, identity.secretHex, {attempts: 12, intervalMs: 500}, decodeLegacyReply);
      } else {
        // A send is not a payment against a request, so there is no request nonce to reconcile
        // against; the memo is a fresh random 16 bytes purely to keep two identical sends (same
        // destination, same amount) from colliding under the ledger's duplicate check.
        prepared = await prepareTransfer(identity.secretHex, {currencies: [desc]}, {
          toPrincipal: resolved.owner, amount: raw, currency: desc.currency, nonceHex: randomMemoHex(),
        });
        out = await submitTransfer(prepared, identity.secretHex, {attempts: 12, intervalMs: 500});
      }
      if (out.kind === 'settled') {
        setBlockIndex(out.blockIndex);
        setPhase('done');
        void rememberAddress(assetKey, resolved.destination, saveName.trim(), Date.now());
        onSent();
        return;
      }
      if (out.kind === 'rejected') { setErr(out.reason); setPhase('form'); return; }
      // Not terminal within budget. The transfer MAY still execute, so this is an honest pending
      // state — never a failure, and never an invitation to send again.
      setPhase('unknown');
      onSent();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('send failed:', msg);
      setErr(msg);
      setPhase('form');
    }
  }

  if (phase === 'done' || phase === 'unknown') {
    const pending = phase === 'unknown';
    return (
      <View style={S.sheetBody}>
        <View style={S.centerAll}>
          <View style={[S.check, pending && S.checkAlready]}>
            {pending ? <IconClock size={44} color={C.brandInk} /> : <IconCheck size={44} color={C.brandInk} />}
          </View>
          <Text testID="send-status" style={S.paidText}>
            {pending ? M.withdraw.send.sentUnknown : M.withdraw.send.sent}
          </Text>
          <Text style={S.paidSub}>{fmt(raw)}</Text>
          <Text style={S.dim2}>{M.withdraw.ic.sentTo}</Text>
          <Text testID="send-destination" selectable={true} style={S.sheetAddr}>
            {resolved?.ok ? resolved.destination : ''}
          </Text>
          {pending ? (
            <Text testID="send-unknown-note" style={S.warnNote}>{M.withdraw.send.sentUnknownBody}</Text>
          ) : blockIndex ? (
            <Text testID="send-block" style={S.dim2}>{M.withdraw.send.blockIndex(blockIndex)}</Text>
          ) : null}
          <Text style={S.dim2}>{M.withdraw.balanceAuto}</Text>
          <Pressable
            testID="btn-send-done"
            style={[S.ghostBtn, S.ghostBtnMuted]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={M.common.done}
            accessibilityState={{disabled: false}}>
            <Text style={S.ghostBtnText}>{M.common.done}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'submitting') {
    return (
      <View style={S.sheetBody}>
        <View style={S.centerAll}>
          <ActivityIndicator color={C.brand} />
          <Text style={S.dim2}>{M.withdraw.send.sending(fmt(raw))}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={S.sheetBody}>
      <Text style={S.label}>{M.withdraw.send.sendAmount(assetName)}</Text>
      <Text style={S.dim2}>{M.withdraw.sol.available(fmt(balance))}</Text>

      <AddressField
        value={address}
        onChange={setAddress}
        status={status}
        saved={saved}
        onPickSaved={setAddress}
        onForgetSaved={a => { void forgetAddress(assetKey, a).then(setSaved); }}
        testIDPrefix="send"
      />

      <Text style={S.inputLabel}>{M.withdraw.amountLabel(unit)}</Text>
      <View style={S.amtRow}>
        <TextInput
          testID="send-amount-input"
          style={[S.withdrawAmtInput, {flex: 1}]}
          value={amountStr}
          onChangeText={setAmountStr}
          keyboardType="decimal-pad"
          placeholder={M.withdraw.ic.amountPlaceholder}
          placeholderTextColor={C.sub2}
        />
        {/* Max is balance MINUS the fee — the amount that actually clears, so tapping it can never
            produce a total the balance cannot cover. */}
        <Pressable
          testID="btn-send-max"
          style={S.maxBtn}
          onPress={() => setAmountStr(fmtAsset(maxSpendable, decimals, '', decimals).trim())}
          accessibilityRole="button"
          accessibilityLabel={M.withdraw.send.maxLabel}
          accessibilityState={{disabled: false}}>
          <Text style={S.maxBtnText}>{M.withdraw.send.maxLabel}</Text>
        </Pressable>
      </View>

      {overBalance || overTotal ? (
        <Text testID="send-overbalance" style={S.warnNote}>{M.withdraw.overBalance(fmt(balance))}</Text>
      ) : null}

      {raw !== '0' && resolved?.ok ? (
        <View testID="send-review" style={S.reviewCard}>
          <Text style={S.reviewLabel}>{M.withdraw.send.reviewTitle}</Text>
          <Text testID="send-review-amount" style={S.reviewAmount}>
            {fmtCurrencyAmount([desc], desc.currency, raw)}
          </Text>
          <View style={S.reviewRow}>
            <Text style={S.reviewRowLabel}>{M.withdraw.ic.sentTo}</Text>
            <Text testID="send-review-to" style={S.reviewRowValue}>{shortAddress(resolved.destination)}</Text>
          </View>
          <View style={S.reviewRow}>
            <Text style={S.reviewRowLabel}>{M.withdraw.send.networkRow}</Text>
            <Text style={S.reviewRowValue}>{desc.network ?? 'Internet Computer'}</Text>
          </View>
          <View style={S.reviewRow}>
            <Text style={S.reviewRowLabel}>{M.withdraw.send.feeLine('')}</Text>
            <Text testID="send-review-fee" style={S.reviewRowValue}>{fmt(feeRaw)}</Text>
          </View>
          <View style={S.reviewRow}>
            <Text style={S.reviewRowLabel}>{M.withdraw.send.totalLine('')}</Text>
            <Text testID="send-review-total" style={S.reviewRowValue}>{fmt(total)}</Text>
          </View>
        </View>
      ) : null}

      {/* Naming is optional and offered only once the destination is usable — an address worth
          naming is one the user is about to send to. */}
      {resolved?.ok && saved.every(s => s.address !== resolved.destination) ? (
        <TextInput
          testID="send-save-name"
          style={S.withdrawAddrInput}
          value={saveName}
          onChangeText={setSaveName}
          placeholder={M.withdraw.send.saveNamePlaceholder}
          placeholderTextColor={C.sub2}
          autoCapitalize="words"
        />
      ) : null}

      {err ? <Text testID="send-err" style={S.err}>{err}</Text> : null}

      <Pressable
        testID="btn-send-confirm"
        style={[S.primaryWide, !canSend && S.disabledFlat]}
        disabled={!canSend}
        onPress={() => void send()}
        accessibilityRole="button"
        accessibilityLabel={M.withdraw.send.sendAmount(raw !== '0' ? fmt(raw) : assetName)}
        accessibilityState={{disabled: !canSend}}>
        <Text style={S.primaryText}>
          {raw !== '0' ? M.withdraw.send.sendAmount(fmt(raw)) : M.withdraw.enterAmount}
        </Text>
      </Pressable>

      {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
    </View>
  );
}

/** What the typed destination resolved to: a usable route with its canonical destination, or the
 *  precise reason it cannot be used with this asset. */
type ResolvedDestination =
  | {ok: true; kind: 'icrc'; destination: string; owner: string; subaccountHex: string}
  | {ok: true; kind: 'icp-legacy'; destination: string; accountId: string}
  | {ok: false; message: string};

/**
 * Classify + validate one destination for one asset. Shape decides the namespace and the route;
 * the CORE decides validity, so a checksum failure is reported against a known namespace ("this IC
 * address is mistyped") rather than as a shrug.
 *
 * `native` routes never reach here — the Pay tab hands those to WithdrawSheet — so a native route
 * arriving is a wiring bug and is refused rather than silently mishandled.
 */
export async function resolveDestination(text: string, desc: CurrencyDescriptor): Promise<ResolvedDestination> {
  const assetName = isTestnetCurrency(desc) ? testnetDisplayName(desc) : displayName(desc);
  const shape = detectAddressShape(text);
  const routed = routeForShape(shape, desc);
  if (!routed.ok) {
    switch (routed.refusal.reason) {
      case 'wrong-chain': {
        const pasted = chainNameOfShape(routed.refusal.shape) ?? '';
        return {ok: false, message: M.withdraw.send.refuseWrongChain(pasted, assetName, desc.network ?? 'Internet Computer')};
      }
      case 'legacy-not-icp':
        return {ok: false, message: M.withdraw.send.refuseLegacyNotIcp(assetName)};
      case 'unrecognised':
        return {ok: false, message: M.withdraw.send.refuseUnrecognised(assetName)};
    }
  }
  if (routed.route.kind === 'icp-legacy') {
    try {
      const accountId = await DpayCore.icpValidateAccountId(text);
      return {ok: true, kind: 'icp-legacy', destination: accountId, accountId};
    } catch (e: unknown) {
      console.warn('legacy account id rejected:', e instanceof Error ? e.message : String(e));
      return {ok: false, message: M.withdraw.send.refuseMistypedLegacy};
    }
  }
  if (routed.route.kind === 'icrc') {
    try {
      const parts = await DpayCore.icpValidateIcrcAccount(text);
      // The canonical spelling is what gets shown, saved, and signed — one address, one spelling.
      const destination = parts.subaccountHex ? text.trim().toLowerCase() : parts.owner;
      return {ok: true, kind: 'icrc', destination, owner: parts.owner, subaccountHex: parts.subaccountHex};
    } catch (e: unknown) {
      console.warn('IC account rejected:', e instanceof Error ? e.message : String(e));
      return {ok: false, message: M.withdraw.send.refuseMistypedIc};
    }
  }
  // A native route reached the direct-send sheet — a wiring bug, not a user error. Fail closed.
  return {ok: false, message: M.withdraw.send.refuseUnrecognised(assetName)};
}

/** A fresh 16-byte memo, hex. Not a reconciliation key (a send has no open request to reconcile
 *  against) — it exists so two identical sends are distinct transfers to the ledger's duplicate
 *  check rather than one silently-deduped no-op. */
function randomMemoHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
