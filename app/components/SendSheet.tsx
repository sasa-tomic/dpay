import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, Pressable, TextInput, ActivityIndicator, Platform} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {fmtAsset, fmtAssetCompact, toUnits} from '../lib/format';
import {cmpRaw} from '../lib/amount';
import {useJourney} from '../lib/journey';
import {awardPaymentTested} from '../lib/readiness';
import type {Identity} from '../lib/types';
import type {SelectableAsset} from '../config/assets';
import {railLineLabel} from '../config/currency';
import type {CurrencyDescriptor, FamilyDisplay, MinterFamily} from '../config/catalog';
import {displayName, fmtCurrencyAmountCompact, isTestnetCurrency, testnetDisplayName, isValidDestinationAddress} from '../config/catalog';
import {detectAddressShape, routeForShape, chainNameOfShape} from '../lib/destination';
import {prepareTransfer, prepareLegacyTransfer, submitTransfer, decodeLegacyReply, fetchLedgerFee, type RailPrepared, type RailOutcome} from '../services/rail';
import {loadAddressBook, rememberAddress, forgetAddress, type SavedAddress} from '../services/addressBook';
import {DpayCore} from '../services/native';
import type {Txn} from '../lib/types';
import {fmtTime} from '../lib/format';
import {AddressField, shortAddress} from './AddressField';
import {WithdrawSheet} from './WithdrawSheet';
import {SendTerminal} from './SendTerminal';
import {useEscapeToClose} from '../hooks/useHotkeys';
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
  homeRail = null, prefillAddress = null, onPrefillConsumed, onOpenAddressBook, onSent, onClose, onSendActiveChange, online = true, onReviewShown, onOpenReceipt,
}: {
  identity: Identity;
  catalog: CurrencyDescriptor[];
  desc: CurrencyDescriptor;
  /** The LAST-KNOWN balance in raw units — null when no balance was EVER known. Stale-ok
   *  gating (2026-09-21, the SOL twin's live attempt #7): the gate compares against the
   *  last-known figure WITHOUT demanding a fresh poll, so an aborted-poll season can never
   *  disable a review that checks out; an honest unknown (null) still gates. */
  balance: string | null;
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
  /** Escape to the address-book route from the saved list (2026-09-14). Optional so narrow
   *  mounts (tests) keep working; the Pay tab always passes it. */
  onOpenAddressBook?: () => void;
  onSent: () => void;
  onClose: () => void;
  /** Whether this sheet is off the form — submitting, or holding a terminal outcome. The Pay tab
   *  DEFERS its offline gate while true (2026-09-21, the SOL twin's live defect): the balance
   *  poll's 3-strike offline flip would otherwise REPLACE an in-flight send's sheet, so no
   *  terminal surface ever rendered. The same teardown class, fixed on both rails. */
  onSendActiveChange?: (active: boolean) => void;
  /** The device's connectivity as the parent's balance polls see it — only shapes the in-sheet
   *  offline notice, never a gate (a genuinely-offline send fails honestly at submit). */
  online?: boolean;
  /** Fired ONCE per mount, the first time this sheet renders its review card (surface ownership,
   *  2026-09-21): the parent's offline strike gate must then stop replacing this sheet. */
  onReviewShown?: (shown: boolean) => void;
  /** Open the shared `TxnReceipt` for a finished send: the sheet builds the `Txn` (amount,
   *  destination, ledger reference, honest pending flag) and hands it up — the receipt itself
   *  stays mounted at the Wallet root per its documented rule. Optional so narrow mounts
   *  (tests) keep working; PayMode always passes it. */
  onOpenReceipt?: (t: Txn) => void;
}) {
  const [address, setAddress] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [phase, setPhase] = useState<'form' | 'submitting' | 'done' | 'unknown'>('form');
  const [err, setErr] = useState<string | null>(null);
  const [blockIndex, setBlockIndex] = useState<string>('');
  // This send's fresh memo hex (randomMemoHex below) — shown on the unknown terminal as the
  // transfer's reference and stamped into the receipt, so a pending send still names the handle
  // the ledger will carry instead of showing nothing. The legacy route stamps its own handle: the
  // signed envelope's request id (a legacy send carries no memo argument).
  const [memoHex, setMemoHex] = useState<string>('');
  // The error phase's honesty line (the SOL sheet's `accepted` twin): TRUE only when the failing
  // attempt provably put nothing on the wire — a validate/prepare throw, or the ledger's own
  // rejection — so the returned form is a SAFE retry. Never true after the envelope was signed:
  // that throw lands in the honest unknown instead (see the split in send()).
  const [nothingSent, setNothingSent] = useState(false);
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

  // The send OWNS its surface while it is off the form (the SOL twin SolanaWithdrawSheet, same
  // 2026-09-21 live defect fixed here too). `submitting` and the terminal phases report active;
  // the unmount cleanup clears the flag so a mid-send detour cannot leave it stuck.
  const sendActive = phase !== 'form';
  useEffect(() => {
    onSendActiveChange?.(sendActive);
  }, [sendActive, onSendActiveChange]);
  useEffect(() => () => onSendActiveChange?.(false), []);

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
    (raw: string) => fmtAssetCompact(raw, decimals, unit, displayDecimals, desc.min_fraction_digits ?? 0),
    [decimals, unit, displayDecimals, desc.min_fraction_digits],
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
  // STALE-OK BALANCE GATING (the IC twin of the SOL sheet's 2026-09-21 fix): both comparisons
  // read the LAST-KNOWN balance — never a fresh-poll demand — and a NEVER-known balance (null)
  // gates the confirm without claiming a zero. An aborted-poll season must not disable a review
  // that checks out against the last-known figure.
  const balanceKnown = balance != null;
  const overBalance = balanceKnown && cmpRaw(raw, balance!) > 0;
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
  const overTotal = balanceKnown && cmpRaw(total ?? raw, balance!) > 0;
  // Our own MAIN account in either namespace. A subaccount of ours never reaches here — the
  // resolver refuses it outright — so comparing the one destination string against our principal is
  // the whole test on the ICRC side.
  const isSelf = !!resolved?.ok && !!selfAccount && (
    (resolved.kind === 'icrc' && resolved.destination === selfAccount.principal) ||
    (resolved.kind === 'icp-legacy' && resolved.destination === selfAccount.accountId)
  );
  // The native route is confirmed by WithdrawSheet's own button, not this one.
  const directRoute = resolved?.ok === true && resolved.kind !== 'native';
  const canSend = directRoute && raw !== '0' && balanceKnown && !overTotal && phase === 'form';

  // Surface ownership (the offline-gate half, same 2026-09-21 live attempt): the FIRST rendered
  // review reports up, sticky for this mount — the parent's 3-strike offline gate then stops
  // replacing this sheet and may only show a notice inside it.
  const reviewVisible = phase === 'form' && raw !== '0' && resolved?.ok === true;
  const reviewShownRef = useRef(false);
  useEffect(() => {
    if (!reviewVisible || reviewShownRef.current) return;
    reviewShownRef.current = true;
    onReviewShown?.(true);
  }, [reviewVisible, onReviewShown]);

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
              fmtAssetCompact(String(display.withdrawMinRaw), decimals, display.nativeAsset, display.amountDecimals),
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
    // A fresh send starts with no memo reference and no nothing-sent claim; the ICRC branch below
    // stamps its own memo. (A retry after a rejection must never show the previous attempt's memo
    // as this send's reference.)
    setMemoHex('');
    setNothingSent(false);
    // THE SIGNATURE BOUNDARY — this rail's twin of the SOL sheet's `broadcast.sig`. Everything
    // before `submitTransfer` is local (validate/prepare/sign): a throw there provably put
    // NOTHING on the wire, so the honest ending is the form + the nothing-was-sent line and a
    // retry is safe. From `submitTransfer` on, a SIGNED envelope exists whose fate this device
    // can no longer decide — a throw there is the honest UNKNOWN (the transfer may still
    // execute), never an error that invites a resend: a resend signs a SECOND, independent
    // transfer (a fresh memo), and the first could still land. The invariant "retry is offered
    // only when nothing was accepted; post-submission failures land in unknown, never error" is
    // the same one SolanaWithdrawSheet pins over `broadcast.sig`.
    let prepared: RailPrepared;
    try {
      if (!desc.ledger) throw new Error(M.withdraw.send.noLedger);
      if (resolved.kind === 'icp-legacy') {
        prepared = await prepareLegacyTransfer(identity.secretHex, {
          // Again the one string the screen showed — see `ResolvedDestination`.
          ledger: desc.ledger, toAccountId: resolved.destination, amountE8s: raw, feeE8s: feeRaw ?? '',
        });
        // The legacy rail carries no memo argument; its reference handle is the signed envelope's
        // request id — what the unknown terminal and the receipt name while no block exists.
        setMemoHex(prepared.requestIdHex);
      } else {
        // A send is not a payment against a request, so there is no request nonce to reconcile
        // against; the memo is a fresh random 16 bytes — see `randomMemoHex`. Captured in state:
        // the terminal surface shows it as the transfer's reference (the honest unknown has no
        // block index yet, but the ledger will carry THIS memo either way).
        const memo = randomMemoHex();
        setMemoHex(memo);
        prepared = await prepareTransfer(identity.secretHex, {currencies: [desc]}, {
          // The SAME string the field showed, the review showed and the address book will save.
          // The rail parses owner + subaccount out of it, so a `principal.subaccount` destination
          // is credited to the account the user actually read.
          toAccount: resolved.destination, amount: raw, currency: desc.currency, nonceHex: memo,
        });
      }
    } catch (e: unknown) {
      // Pre-signature throw: validation or prepare failed — nothing was sent, definitively.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('send failed (nothing sent):', msg);
      setErr(msg);
      setNothingSent(true);
      setPhase('form');
      return;
    }
    let out: RailOutcome;
    try {
      out = await submitTransfer(prepared, identity.secretHex, {attempts: 12, intervalMs: 500},
        resolved.kind === 'icp-legacy' ? decodeLegacyReply : undefined);
    } catch (e: unknown) {
      // Post-signature throw (the submit POST or the poll lost the network): the envelope is
      // signed and its fate is unknown — the honest pending terminal, with the reference this
      // send will be reconciled by. NEVER the error phase: no resend invite over a signed send.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('send outcome unknown (envelope signed):', msg);
      setPhase('unknown');
      onSent();
      return;
    }
    if (out.kind === 'settled') {
      setBlockIndex(out.blockIndex);
      setPhase('done');
      void rememberAddress(assetKey, resolved.destination, saveName.trim(), Date.now());
      onSent();
      awardPaymentTested(journey); // CONFIRMED settle only — the 'unknown' branch below claims nothing
      return;
    }
    if (out.kind === 'rejected') {
      // The ledger REFUSED the transfer — nothing moved, so the form returns with the reason and
      // the nothing-was-sent line (a retry really is safe here).
      console.warn('send rejected:', out.reason);
      setErr(out.reason);
      setNothingSent(true);
      setPhase('form');
      return;
    }
    // Not terminal within budget. The transfer MAY still execute, so this is an honest pending
    // state — never a failure, and never an invitation to send again.
    setPhase('unknown');
    onSent();
  }

  if (phase === 'done' || phase === 'unknown') {
    const pending = phase === 'unknown';
    // The terminal receipt (the SAME TxnReceipt the History rows open, mounted at the Wallet
    // root): amount, destination, the ledger reference and — for the honest unknown — the
    // pending flag that makes the receipt say "not confirmed yet" instead of printing a proof.
    // The unknown's reference is the send's memo hex (no block exists yet; the memo is the
    // handle the ledger will carry either way).
    const txn: Txn = {
      nonce: memoHex || `ic-send-${Date.now()}`,
      amount: raw,
      who: '',
      memo: memoHex,
      time: fmtTime(Date.now()),
      ts: Date.now(),
      dir: 'out',
      assetId: `ic:${desc.currency}`,
      counterparty: resolved?.ok ? resolved.destination : '',
      ledgerRef: pending ? '' : blockIndex,
      ...(pending ? {pending: true as const} : {}),
    };
    return (
      <View style={S.sheetBody}>
        <SendTerminal
          settled={!pending}
          headline={pending ? M.withdraw.send.sentUnknown : M.withdraw.send.sent}
          amountText={fmt(raw)}
          destinationLabel={M.withdraw.ic.sentTo}
          destination={resolved?.ok ? resolved.destination : ''}
          pendingBody={pending ? M.withdraw.send.sentUnknownBody : undefined}
          referenceLabel={pending ? M.receipt.referenceLabel : M.receipt.blockLabel}
          reference={pending ? memoHex : blockIndex}
          refTestID="send-ref"
          prefix="send"
          onOpenReceipt={onOpenReceipt != null ? () => onOpenReceipt(txn) : undefined}
          onDone={onClose}
        />
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
      {balance != null ? <Text style={S.dim2}>{M.withdraw.sol.available(fmt(balance))}</Text> : null}

      <AddressField
        value={address}
        onChange={setAddress}
        status={status}
        saved={saved}
        onPickSaved={setAddress}
        onForgetSaved={a => { void forgetAddress(assetKey, a).then(setSaved); }}
        onManageSaved={onOpenAddressBook}
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
          // The chain-key offramp keeps its own fail-closed shape: an unknown balance coerces to
          // a known zero THERE (it gates — the honest-unknown rule) without this sheet ever
          // rendering a fabricated "Available: 0" line above.
          balance={balance ?? '0'}
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
            {fmtCurrencyAmountCompact([desc], desc.currency, raw)}
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
      {phase === 'form' && err != null && nothingSent ? <Text testID="send-nothing-sent" style={S.dim2}>{M.withdraw.send.nothingSent}</Text> : null}

      {/* Offline while the review is up: a NOTICE inside the sheet, never a teardown — the
          strike gate defers (see onReviewShown). A genuinely-offline send fails at submit. */}
      {!online ? <Text testID="send-offline-note" style={S.warnNote}>{M.withdraw.offlineReviewNote}</Text> : null}

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
