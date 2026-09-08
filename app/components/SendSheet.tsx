import {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {fmtAsset, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import type {Identity} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import {railLineLabel} from '../config/currency';
import type {CurrencyDescriptor, FamilyDisplay, MinterFamily} from '../config/catalog';
import {displayName, fmtCurrencyAmount, isTestnetCurrency, testnetDisplayName, isValidDestinationAddress} from '../config/catalog';
import {detectAddressShape, routeForShape, chainNameOfShape} from '../lib/destination';
import {prepareTransfer, prepareLegacyTransfer, submitTransfer, decodeLegacyReply, fetchLedgerFee, type RailPrepared, type RailOutcome} from '../services/rail';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {DpayCore} from '../services/native';
import {AddressField, shortAddress} from './AddressField';
import {WithdrawSheet} from './WithdrawSheet';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {IconCheck, IconClock} from './icons';
import {M} from '../i18n';

/** Where an `icrc1_transfer` actually executes. Every ledger in this catalog is an IC canister, so
 *  this is a fact about the RAIL, not about the asset — unlike `descriptor.network`, which names
 *  the asset's BACKING chain ("Bitcoin" for ckBTC). Wire/display proper noun, never translated. */
const IC_NETWORK = 'Internet Computer';

/**
 * THE send-to-address surface for every IC asset. ONE destination field; the address decides the
 * rail, so the user never picks a mechanism — they paste an address and are told what will happen.
 *
 * `app/lib/destination.ts` classifies what was pasted or scanned, and this sheet renders the
 * consequence BEFORE the user commits: which chain, how long, what fee — or, when the address
 * cannot be used with this asset, exactly what it is and what to do instead.
 *
 * Three routes, two engines:
 *   • an IC account       → `icrc1_transfer` on the asset's own ledger. Available to EVERY IC
 *                           asset, which is what lets ckBTC go straight to an Internet Computer
 *                           wallet instead of round-tripping through Bitcoin. Handled here.
 *   • a 64-hex ICP account→ the ICP ledger's legacy `transfer`. ICP-ledger-only. Handled here.
 *   • a native address    → the chain-key burn, DELEGATED to `WithdrawSheet`, which owns the
 *                           multi-step approve→minter sequence and its double-burn resume
 *                           discipline. That machinery is deliberately not duplicated here; this
 *                           sheet only supplies the destination it already validated.
 *
 * The deposit side already offered both directions ("Already on the Internet Computer?" on the ck*
 * sheets, 2026-08-29). Until this, sending back out the same way was impossible — the asymmetry
 * this surface closes.
 *
 * Envelope discipline (rail-wide): a prepared envelope is submitted VERBATIM and never re-signed —
 * a fresh signature is a fresh request_id, i.e. a second payment. An 'unknown' outcome is honest
 * pending, never a failure.
 */
export function SendSheet({
  identity, catalog, desc, balance, family, display, tokenContract,
  homeRail = null, prefillAddress = null, onPrefillConsumed, onSent, onClose,
}: {
  identity: Identity;
  catalog: CurrencyDescriptor[];
  desc: CurrencyDescriptor;
  balance: string;
  /** The chain-key family, when this asset has one — enables the NATIVE route. */
  family: MinterFamily | null;
  display: FamilyDisplay | null;
  tokenContract: string | null;
  /** When the asset being sent is a rail of the home currency's group (Objective 2, S5), the
   *  selected asset itself — the route line then names the RAIL (`railLineLabel`, e.g. "ckUSDC ·
   *  Internet Computer") instead of the bare network, because several rails carry this currency
   *  and the sender should see which one this send settles on. Null for every non-group asset:
   *  ckBTC/ckETH/ICP/DEMO and any foreign-currency selection keep the existing copy. */
  homeRail?: SelectableAsset | null;
  /** A destination the Pay tab's camera read instead of a payment code. Pre-fills the field ONLY —
   *  the route disclosure and the Confirm press below are still the whole consent, exactly as when
   *  the address is typed by hand. */
  prefillAddress?: string | null;
  onPrefillConsumed?: () => void;
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
  // Trip Ready J5b — paymentTested. A send IS a real payment, so it fills the stamp exactly as a
  // scanned or tapped one does; without this a wallet whose only money movement is outbound never
  // completed the passport. `send()` is called from the Confirm press, so the plain hook value is
  // the current render's journey (no ref needed — unlike the poll/effect call sites in PayMode).
  const {journey} = useJourney();

  useEscapeToClose(onClose);

  const decimals = desc.decimals ?? 0;
  const displayDecimals = desc.display_decimals ?? decimals;
  const unit = desc.backing_symbol ?? desc.symbol ?? '';
  const assetName = isTestnetCurrency(desc) ? testnetDisplayName(desc) : displayName(desc);
  // The fee is READ FROM THE LEDGER, not from the catalog: the catalog's fee is display metadata
  // and some rows (ckBTC) carry none at all, so quoting it would either be stale or a fabricated 0.
  // Until the query answers, the fee is genuinely UNKNOWN and the screen says so — it never
  // defaults to 0, and no total is shown that would understate what leaves the account.
  const [feeRaw, setFeeRaw] = useState<string | null>(null);
  const feeKnown = feeRaw != null;
  const assetKey = `ic:${desc.currency}`;
  const fmt = useCallback(
    (raw: string) => fmtAsset(raw, decimals, unit, displayDecimals),
    [decimals, unit, displayDecimals],
  );
  // How a fee READS. A ledger that genuinely charges nothing says so in words — the deposit sheets
  // set this precedent (`M.deposit.ck.feeNone`), because "0.00000000 BTC" on a money screen looks
  // like a bug rather than good news. Distinct from an UNKNOWN fee, which is a different statement.
  const feeText = useCallback(
    (raw: string) => (BigInt(raw) === 0n ? M.deposit.ck.feeNone : fmt(raw)),
    [fmt],
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

  // A destination the Pay camera read instead of a payment code. Guarded on the form phase so an
  // arriving scan can never rewrite a send already in flight, and consumed as it is taken so the
  // user's own edits are never overwritten by a re-render. Mirrors SolanaWithdrawSheet's prefill.
  useEffect(() => {
    if (prefillAddress == null || phase !== 'form') return;
    setAddress(prefillAddress);
    onPrefillConsumed?.();
    // onPrefillConsumed is an inline closure; the [prefillAddress, phase] guard + immediate clear
    // make its identity irrelevant (exhaustive-deps would force a re-run on every render's new
    // closure for no behavioral change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillAddress, phase]);

  // The authoritative fee. A failure leaves it null — honest "we don't know" beats a wrong number
  // on a money screen — and the send still works, since the envelope carries `fee: None` and the
  // ledger applies its own.
  useEffect(() => {
    let alive = true;
    if (!desc.ledger) return;
    fetchLedgerFee(identity.secretHex, desc.ledger)
      .then(f => { if (alive) setFeeRaw(f); })
      .catch((e: unknown) => {
        console.warn('ledger fee query failed:', e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [identity.secretHex, desc.ledger]);

  // Resolve the typed destination: shape → route → the core validator for that route. Generation-
  // guarded so a slow validation for an older keystroke can never overwrite a newer verdict.
  useEffect(() => {
    const text = address.trim();
    if (text.length === 0) { setResolved(null); return; }
    let alive = true;
    (async () => {
      const r = await resolveDestination(text, desc, selfAccount?.principal ?? null);
      if (alive) setResolved(r);
    })();
    return () => { alive = false; };
  }, [address, desc, selfAccount]);

  const raw = toUnits(amountStr, decimals);
  const overBalance = cmpRaw(raw, balance) > 0;
  // Fee is charged ON TOP of the amount by the ledger, so the spendable maximum is balance − fee.
  // Only computable once the ledger has told us its fee. Without it, "Max" would fill the entire
  // balance and the transfer would be rejected for amount+fee — a doomed action offered as a
  // convenience. Reserving a GUESSED fee is not an option on a screen whose rule is never to state
  // a fee it does not know, so the button is simply disabled until the query answers.
  const maxSpendable = useMemo(() => {
    if (feeRaw == null) return null;
    const b = BigInt(balance || '0');
    const f = BigInt(feeRaw);
    return b > f ? (b - f).toString() : '0';
  }, [balance, feeRaw]);
  // Only computable when the fee is known; otherwise the review omits it rather than guessing.
  const total = useMemo(
    () => (feeKnown ? (BigInt(raw || '0') + BigInt(feeRaw)).toString() : null),
    [raw, feeRaw, feeKnown],
  );
  const overTotal = cmpRaw(total ?? raw, balance) > 0;
  // Our own MAIN account in either namespace. A subaccount of ours never reaches here — the
  // resolver refuses it outright — so comparing the one destination string against our principal is
  // the whole test on the ICRC side.
  const isSelf = !!resolved?.ok && !!selfAccount && (
    (resolved.kind === 'icrc' && resolved.destination === selfAccount.principal) ||
    (resolved.kind === 'icp-legacy' && resolved.destination === selfAccount.accountId)
  );
  // The native route is confirmed by WithdrawSheet's own button, not this one.
  const directRoute = resolved?.ok === true && resolved.kind !== 'native';
  const canSend = directRoute && raw !== '0' && !overTotal && phase === 'form';

  // The one status line under the address field: route disclosure when usable, the specific reason
  // when not. Never a bare "invalid address" — every branch names what the address IS.
  const status = useMemo((): {text: string; tone: 'ok' | 'warn' | 'bad'} | null => {
    if (address.trim().length === 0) return null;
    if (resolved == null) return null; // still resolving — say nothing rather than flash a refusal
    if (!resolved.ok) return {text: resolved.message, tone: 'bad'};
    if (isSelf) return {text: M.withdraw.send.selfWarning, tone: 'warn'};
    // A native destination is disclosed with ITS chain's economics — minutes and a minimum, not
    // the IC's seconds-and-a-flat-fee. Showing the IC numbers for a Bitcoin withdrawal would be
    // the single most misleading thing this screen could say.
    if (resolved.kind === 'native' && display) {
      // A zero floor is not a minimum — saying "minimum 0 USDC" reads as a malfunction. Only the
      // chains that actually impose one (BTC, native ETH) get the clause.
      return {
        text: display.withdrawMinRaw > 0
          ? M.withdraw.send.routeNative(
              display.networkLabel,
              display.blockMin,
              fmtAsset(String(display.withdrawMinRaw), decimals, display.nativeAsset, display.amountDecimals),
            )
          : M.withdraw.send.routeNativeNoMin(display.networkLabel, display.blockMin),
        tone: 'ok',
      };
    }
    // The settlement chain for BOTH direct routes is the Internet Computer — that is where an
    // icrc1_transfer executes, for every asset in this catalog. `desc.network` is the BACKING
    // chain (ckBTC's is "Bitcoin"), so using it here would tell a ckBTC sender their IC transfer
    // settles on Bitcoin. It does not.
    //
    // A rail of the home currency's group (S5) names the RAIL, not just the network — the group
    // carries this currency on several rails and the sender should see which one settles.
    if (!feeKnown) {
      return {
        text: homeRail != null
          ? M.withdraw.send.routeIcrcOnRailUnknownFee(railLineLabel(homeRail))
          : M.withdraw.send.routeIcrcUnknownFee(IC_NETWORK),
        tone: 'ok',
      };
    }
    const fee = feeText(feeRaw);
    return {
      text: resolved.kind === 'icp-legacy'
        ? M.withdraw.send.routeLegacy(fee)
        : homeRail != null
          ? M.withdraw.send.routeIcrcOnRail(railLineLabel(homeRail), fee)
          : M.withdraw.send.routeIcrc(IC_NETWORK, fee),
      tone: 'ok',
    };
  }, [address, resolved, isSelf, feeText, feeRaw, feeKnown, display, decimals, homeRail]);

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
          // Again the one string the screen showed — see `ResolvedDestination`.
          ledger: desc.ledger, toAccountId: resolved.destination, amountE8s: raw, feeE8s: feeRaw ?? '',
        });
        out = await submitTransfer(prepared, identity.secretHex, {attempts: 12, intervalMs: 500}, decodeLegacyReply);
      } else {
        // A send is not a payment against a request, so there is no request nonce to reconcile
        // against; the memo is a fresh random 16 bytes — see `randomMemoHex`.
        prepared = await prepareTransfer(identity.secretHex, {currencies: [desc]}, {
          // The SAME string the field showed, the review showed and the address book will save.
          // The rail parses owner + subaccount out of it, so a `principal.subaccount` destination
          // is credited to the account the user actually read.
          toAccount: resolved.destination, amount: raw, currency: desc.currency, nonceHex: randomMemoHex(),
        });
        out = await submitTransfer(prepared, identity.secretHex, {attempts: 12, intervalMs: 500});
      }
      if (out.kind === 'settled') {
        setBlockIndex(out.blockIndex);
        setPhase('done');
        void rememberAddress(assetKey, resolved.destination, saveName.trim(), Date.now());
        onSent();
        awardPaymentTested(journey); // CONFIRMED settle only — the 'unknown' branch below claims nothing
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
          <Text testID="send-outcome" style={S.paidText}>
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
          <ActivityIndicator color={C.brandText} />
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

      {/* Naming is offered once the destination is usable, ABOVE the route split, so a chain-key
          destination can be named too — it is saved by the offramp path on settle just as the
          direct path saves its own. */}
      {resolved?.ok && saved.every(sv => sv.address !== resolved.destination) ? (
        <TextInput
          testID="send-save-name"
          accessibilityLabel={M.withdraw.send.saveNamePlaceholder}
          style={S.withdrawAddrInput}
          value={saveName}
          onChangeText={setSaveName}
          placeholder={M.withdraw.send.saveNamePlaceholder}
          placeholderTextColor={C.sub2}
          autoCapitalize="words"
        />
      ) : null}

      {/* NATIVE route: hand off to the chain-key offramp engine, which owns the amount rules
          (per-chain minimum, ckERC20 gas) and the retained/resume double-burn discipline. It
          renders no destination field of its own — this one above is the only one. */}
      {resolved?.ok && resolved.kind === 'native' && family && display ? (
        <WithdrawSheet
          identity={identity}
          catalog={catalog}
          currency={desc.currency}
          decimals={decimals}
          display={display}
          family={family}
          tokenContract={tokenContract}
          balance={balance}
          address={resolved.destination}
          onResumeAddress={setAddress}
          onSaveAddress={a => { void rememberAddress(assetKey, a, saveName.trim(), Date.now()).then(setSaved); }}
          onClose={onClose}
          onWithdrawn={onSent}
        />
      ) : (
      <>
      <Text style={S.inputLabel}>{M.withdraw.amountLabel(unit)}</Text>
      <View style={S.amtRow}>
        <TextInput
          testID="send-amount-input"
          accessibilityLabel={M.withdraw.amountLabel(unit)}
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
          style={[S.maxBtn, maxSpendable == null && S.disabledFlat]}
          disabled={maxSpendable == null}
          onPress={() => { if (maxSpendable != null) setAmountStr(fmtAsset(maxSpendable, decimals, '', decimals).trim()); }}
          accessibilityRole="button"
          accessibilityLabel={M.withdraw.send.maxLabel}
          accessibilityState={{disabled: maxSpendable == null}}>
          <Text style={[S.maxBtnText, maxSpendable == null && S.disabledText]}>{M.withdraw.send.maxLabel}</Text>
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
            <Text style={S.reviewRowValue}>{IC_NETWORK}</Text>
          </View>
          <View style={S.reviewRow}>
            <Text style={S.reviewRowLabel}>{M.withdraw.send.feeLine('')}</Text>
            <Text testID="send-review-fee" style={S.reviewRowValue}>
              {feeKnown ? feeText(feeRaw) : M.withdraw.send.feeUnknown}
            </Text>
          </View>
          {/* No total without a known fee — a "total" that silently equals the amount would
              understate what leaves the account. */}
          {total != null ? (
            <View style={S.reviewRow}>
              <Text style={S.reviewRowLabel}>{M.withdraw.send.totalLine('')}</Text>
              <Text testID="send-review-total" style={S.reviewRowValue}>{fmt(total)}</Text>
            </View>
          ) : null}
        </View>
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
        <Text style={[S.primaryText, !canSend && S.disabledText]}>
          {raw !== '0' ? M.withdraw.send.sendAmount(fmt(raw)) : M.withdraw.enterAmount}
        </Text>
      </Pressable>

      {Platform.OS === 'web' ? <Text style={S.dim2}>{M.withdraw.pressEsc}</Text> : null}
      </>
      )}
    </View>
  );
}

/** What the typed destination resolved to: a usable route with its canonical destination, or the
 *  precise reason it cannot be used with this asset.
 *
 *  EVERY usable branch carries exactly ONE address value, `destination`. That is deliberate and it
 *  is the money invariant of this screen: `destination` is what the field shows, what the review
 *  shows, what the address book saves AND what the rail signs, so there is no second field a call
 *  site could sign instead of the one the user read. The ICRC route used to carry a parsed
 *  `{owner, subaccountHex}` beside the text, and the send passed `owner` — which paid the owner's
 *  DEFAULT subaccount while the screen displayed the subaccount account the user pasted. The parts
 *  now stay local to the resolver; `services/rail.ts` re-parses the one string it is given. */
type ResolvedDestination =
  | {ok: true; kind: 'icrc'; destination: string}
  | {ok: true; kind: 'icp-legacy'; destination: string}
  | {ok: true; kind: 'native'; destination: string; family: MinterFamily}
  | {ok: false; message: string};

/**
 * Classify + validate one destination for one asset. Shape decides the namespace and the route;
 * the CORE decides validity, so a checksum failure is reported against a known namespace ("this IC
 * address is mistyped") rather than as a shrug.
 *
 * `native` routes never reach here — the Pay tab hands those to WithdrawSheet — so a native route
 * arriving is a wiring bug and is refused rather than silently mishandled.
 *
 * `selfPrincipal` is this wallet's own owner principal, used for ONE refusal: a subaccount OF THIS
 * WALLET. dpay addresses exactly one account per asset — owner + default subaccount — everywhere it
 * reads (`railBalanceOf`, the relay's balance and history queries) and everywhere it signs (every
 * transfer goes out with `from_subaccount` empty). So money parked at another subaccount of our own
 * principal is money this wallet can neither show nor ever spend again, which is why that one
 * destination fails closed while a STRANGER's subaccount is paid normally: theirs is an account
 * their wallet can read. `null` (the self-derivation failed — logged by the caller, and the
 * self-send warning is absent for the same reason) skips the check rather than refusing a
 * legitimate external subaccount with a message that would be a guess.
 */
export async function resolveDestination(
  text: string,
  desc: CurrencyDescriptor,
  selfPrincipal: string | null,
): Promise<ResolvedDestination> {
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
      // Canonical lowercase from the core — the one spelling shown, saved and signed.
      return {ok: true, kind: 'icp-legacy', destination: await DpayCore.icpValidateAccountId(text)};
    } catch (e: unknown) {
      console.warn('legacy account id rejected:', e instanceof Error ? e.message : String(e));
      return {ok: false, message: M.withdraw.send.refuseMistypedLegacy};
    }
  }
  if (routed.route.kind === 'icrc') {
    try {
      const parts = await DpayCore.icpValidateIcrcAccount(text);
      if (parts.subaccountHex !== '' && parts.owner === selfPrincipal) {
        return {ok: false, message: M.withdraw.send.refuseOwnSubaccount};
      }
      // The canonical spelling is what gets shown, saved, and signed — one address, one spelling.
      // The core accepts only the spec-canonical textual account, so the pasted text lowercased IS
      // the canonical spelling of `{owner, subaccountHex}`; the parts are not carried any further,
      // so nothing downstream can sign an account other than this string.
      const destination = parts.subaccountHex ? text.trim().toLowerCase() : parts.owner;
      return {ok: true, kind: 'icrc', destination};
    } catch (e: unknown) {
      console.warn('IC account rejected:', e instanceof Error ? e.message : String(e));
      return {ok: false, message: M.withdraw.send.refuseMistypedIc};
    }
  }
  // A native-chain destination for this asset's own chain: the minter burn. Validated HERE, with
  // the same strict check the offramp used to run on its own, so that EVERY route refuses in the
  // one shared status line. Leaving it to the offramp body meant a short-but-plausible Bitcoin
  // address passed the shape test, opened the burn form, and only then said "not a valid BTC
  // address" — one refusal in a different place from all the others.
  //
  // Two stages by design, mirroring the IC path (shape → core CRC parse): `detectAddressShape`
  // says WHICH namespace, `isValidDestinationAddress` says whether it is well-formed.
  if (!isValidDestinationAddress(routed.route.family, text)) {
    return {ok: false, message: M.withdraw.badAddress(desc.backing_symbol ?? assetName)};
  }
  // The text is kept VERBATIM — the minter is the final authority and a native address has no
  // canonical re-spelling we are entitled to impose (base58 is case-significant).
  return {ok: true, kind: 'native', destination: text.trim(), family: routed.route.family};
}

/** A fresh 16-byte memo, hex. Not a reconciliation key (a send has no open request to reconcile
 *  against) — it is what makes two otherwise identical sends tell themselves apart on the ledger,
 *  and it is the value the recipient can quote back when asking which transfer was which.
 *
 *  It is NOT a duplicate guard, and it never was: dpay sends no `created_at_time`, so an ICRC-1
 *  ledger runs no duplicate check at all and two identical transfers both execute (the rule and
 *  the reasoning: `icp_transfer_arg` in dpay-ffi). The freshness costs nothing and the honest
 *  claim is the smaller one. */
function randomMemoHex(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
