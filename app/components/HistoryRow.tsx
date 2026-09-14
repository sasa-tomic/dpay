import {Pressable, ScrollView, Text, View} from 'react-native';
import {S} from '../styles';
import {M} from '../i18n';
import {C} from '../config/palette';
import {fmtCurrencyAmountCompact, type CurrencyDescriptor} from '../config/catalog';
import {type SelectableAsset} from '../config/assets';
import {fmtAssetCompact} from '../lib/format';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {useEscapeToClose} from '../hooks/useHotkeys';
import {AppModal} from './AppModal';
import {IconArrowDownLeft, IconArrowUpRight, IconCopy} from './icons';
import type {Txn} from '../lib/types';
import type {TxAnnotation} from '../services/txNotes';

// One row's amount in the row's OWN units, dispatched on rail. History is a glanceable surface, so
// both rails use the COMPACT formatter (trailing zeros trimmed to the asset's floor; "≈"/"<" when a
// display cap hides value) — the exact string stays on the surfaces where money is committed. An IC
// row goes through `fmtCurrencyAmountCompact` (DEMO's `∂` early-return lives inside it, and it
// fail-closes to the explicit "Unsupported" sentinel for an unknown family — never a wrong
// "… BTC"); a Solana row formats at its SelectableAsset's `decimals` + `symbol` + compact floor,
// the only place those facts exist for that rail. A row
// whose asset is not in the visible list (a testnet asset hidden mid-poll, a disabled rail) fails
// closed to the SAME sentinel rather than guessing a unit.
export function fmtRowAmount(t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[], note?: TxAnnotation): string {
  const asset = assets.find(a => a.id === t.assetId);
  if (!asset) return M.wallet.asset.unsupported;
  // The direction sign goes THROUGH the formatter (never concatenated here) so it lands inside a
  // truncation marker — "≈ −0.039922 ETH", not "−≈ 0.039922 ETH". See fmtAssetCompact.
  // Founder rule 2026-09-14: when the device saved the payment's GROSS (a netted request payment),
  // the row HEADLINES it — the typed price, not the wire the ledger recorded.
  const raw = note?.gross ?? t.amount;
  const sign = t.dir === 'out' ? '−' : '+';
  return asset.protocol === 'ic'
    ? fmtCurrencyAmountCompact(catalog, asset.currency, raw, sign)
    : fmtAssetCompact(raw, asset.decimals, asset.symbol, undefined, asset.minFractionDigits, sign);
}

// The fee a note carried, formatted in the row's own units (the founder example: "0.01 VCHF −
// 0.0001 VCHF fees"). Optional `sign` goes THROUGH the formatter like every amount sign. Null
// when the note carried no fee, a zero fee (nothing to annotate — a DEMO/fee-0 cell), or the
// asset is unknown (no honest unit to format it in).
function fmtNoteFee(
  t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[], note?: TxAnnotation, sign?: string,
): string | null {
  const fee = note?.fee;
  if (fee === undefined || fee === '0') return null;
  const asset = assets.find(a => a.id === t.assetId);
  if (!asset) return null;
  return asset.protocol === 'ic'
    ? fmtCurrencyAmountCompact(catalog, asset.currency, fee, sign)
    : fmtAssetCompact(fee, asset.decimals, asset.symbol, undefined, asset.minFractionDigits, sign);
}

// The RECEIPT's amount — the same dispatch, through the same COMPACT formatters as the row
// (founder rule 2026-09-13: every glanceable money surface shows the best-effort rounded amount;
// the padded exact form survives only where a string round-trips through the amount parser).
// The sign goes THROUGH the formatter so it lands inside a truncation marker, same as the row.
// Same gross-over-wire precedence as the row (founder rule 2026-09-14).
function fmtReceiptAmount(t: Txn, catalog: CurrencyDescriptor[], asset: SelectableAsset | undefined, note?: TxAnnotation): string {
  if (!asset) return M.wallet.asset.unsupported;
  const raw = note?.gross ?? t.amount;
  const sign = t.dir === 'out' ? '−' : '+';
  return asset.protocol === 'ic'
    ? fmtCurrencyAmountCompact(catalog, asset.currency, raw, sign)
    : fmtAssetCompact(raw, asset.decimals, asset.symbol, undefined, asset.minFractionDigits, sign);
}

// One transaction row — the shared renderer extracted verbatim from Ledger's list map so the Home
// tab's inline activity feed renders the IDENTICAL row grammar (direction glyph, counterparty,
// own-unit amount, time). The rendered output for the Ledger is byte-stable: `testPrefix` defaults
// to the Ledger's historical 'hist' testID namespace, and a second surface (the Home activity feed)
// passes its own ('home-hist') instead of the two sharing selectors — e2e anchors stay per-surface.
//
// X6 — the row is PRESSABLE and opens its receipt. `onPress` is required, not optional: a row that
// only some surfaces can open is the defect this closes (the merchant-reconciliation and dispute
// path did not exist). Both list surfaces get the opener from `useTxnReceipt` below.
//
// `note` is the row's DEVICE-SAVED annotation (services/txNotes + the address book, resolved by
// the Wallet root): a peer name and/or human message known at payment time, which the rail itself
// does not carry. Precedence is note-first and the ledger truth is never hidden: a named peer
// replaces the truncated principal PREFIX in `who`, an annotated message replaces the memo LINE —
// and the receipt still shows the full principal and the hex reference whatever the note says. A
// note-less row renders exactly as before this prop existed.
export function HistoryRow({t, i, catalog, assets, testPrefix = 'hist', onPress, note}: {t: Txn; i: number; catalog: CurrencyDescriptor[]; assets: SelectableAsset[]; testPrefix?: string; onPress: (t: Txn) => void; note?: TxAnnotation}) {
  const amtTxt = fmtRowAmount(t, catalog, assets, note);
  // `''`/absent never override: the store never saves an empty who/msg, but the fallback chain
  // stays total for any caller-assembled annotation.
  const whoTxt = note?.who || t.who || '—';
  const memoTxt = note?.msg || t.memo;
  // Founder rule 2026-09-14: the fee rides the row ONLY as this annotation line, never in the
  // headline. Hidden when the fee is unknown or zero.
  const feeTxt = fmtNoteFee(t, catalog, assets, note);
  return (
    <Pressable
      testID={`${testPrefix}-row-${i}`}
      style={S.histRow}
      onPress={() => onPress(t)}
      accessibilityRole="button"
      accessibilityLabel={M.receipt.openRow}
      accessibilityHint={M.receipt.openRowHint}
      accessibilityState={{disabled: false}}
    >
      {/* P4 — direction glyph leading each row (t.dir is Txn's reliable 'out' | 'in' field):
          incoming = arrow-down-left in ok green (matching the credited amount; tangerine stays
          reserved for CTA/active), outgoing = arrow-up-right neutral. The icon renders no
          textContent, so the asserted amounts/memos are untouched. */}
      <View style={S.histDirIcon}>
        {t.dir === 'out' ? <IconArrowUpRight size={16} color={C.sub} /> : <IconArrowDownLeft size={16} color={C.ok} />}
      </View>
      <View style={S.histWhoCol}>
        <Text style={S.histWho}>{t.dir === 'out' ? M.wallet.ledger.to(whoTxt) : M.wallet.ledger.from(whoTxt)}</Text>
        {/* Second line: WHEN, then the memo. The time used to sit to the right of the amount, where
            its own width changes (the hour's 1↔2 digits) pushed the amount sideways — the rule and
            the measurement are on `S.histAmt`. Here its width is absorbed by the flexible column.
            The visual flows (40/84) still MASK it on the Ledger: the digits differ every run. */}
        <View style={S.histSubRow}>
          <Text style={S.histTime} testID={`${testPrefix}-time-${i}`}>{t.time}</Text>
          {memoTxt ? <Text style={S.histMemo} testID={`${testPrefix}-memo-${i}`}>{memoTxt}</Text> : null}
          {feeTxt != null ? <Text style={S.histFee} testID={`${testPrefix}-fee-${i}`}>{M.wallet.ledger.fees(feeTxt)}</Text> : null}
        </View>
      </View>
      <Text style={[S.histAmt, {color: t.dir === 'out' ? C.ink : C.ok}]} testID={`${testPrefix}-amt-${i}`}>{amtTxt}</Text>
    </Pressable>
  );
}

// ─── The receipt (X6) ──────────────────────────────────────────────────────────────────────────
// A transaction row used to be dead: no press handler, no detail, no reference, no ledger id, no
// way to copy a proof. That is the merchant-reconciliation and dispute path, and it did not exist —
// a merchant who was paid could not show WHAT they were paid.
//
// THE RULE: a field renders only when the rail really provides it. The two rails record different
// things, and the difference is not cosmetic —
//   • Internet Computer: the transfer's ICRC memo is the payee's reconciliation key (`nonce` in
//     CLAUDE.md's terms table), and the row's identity is its LEDGER BLOCK INDEX (an IC row's
//     `Txn.nonce` is always empty, so the block is the only stable id it has).
//   • Solana: a transfer made here carries no dpay reference at all; its identity is the
//     transaction SIGNATURE.
// Where a rail provides nothing, the receipt prints ONE honest sentence saying so — never a label
// over an empty value, which in a dispute reads as a value that failed to load.

/** Everything the receipt shows, resolved once so the rendered sheet and the copied text cannot
 *  disagree. Pure. `assets`/`catalog` supply the unit and the asset line, exactly as the row does.
 *  `note` (optional) is the device-saved annotation; its peer name and message become the Peer and
 *  Note lines, ADDITIVE to the ledger fields — the account stays the FULL principal and the
 *  reference stays the hex key, so a dispute never loses the checkable truth to the display name. */
function receiptFields(t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[], note?: TxAnnotation) {
  const asset = assets.find(a => a.id === t.assetId);
  const solana = asset?.protocol === 'solana';
  return {
    solana,
    amount: fmtReceiptAmount(t, catalog, asset, note),
    // The fee with its minus sign THROUGH the formatter (same truncation rule as every amount):
    // the founder example reads "0.01 VCHF − 0.0001 VCHF fees". Null when unknown/zero — no label
    // over an absent value.
    fee: fmtNoteFee(t, catalog, assets, note, '−'),
    assetLine: asset?.networkLabel ?? M.wallet.asset.unsupported,
    partyLabel: t.dir === 'out' ? M.receipt.toLabel : M.receipt.fromLabel,
    // The FULL account, never the row's truncated display label — a truncated principal proves
    // nothing. '' means the ledger recorded no account on that side (an IC mint has no payer, a
    // burn no payee, a Solana batch no unique counterparty), which is said rather than left blank.
    account: t.counterparty || M.receipt.noAccount,
    // The peer name the DEVICE knew at payment time (request to_name, link label, spay label, or
    // a saved address-book label — resolved by the caller). '' = none: the line does not render.
    peer: note?.who || '',
    // The device-saved message, same rule.
    noteText: note?.msg || '',
    // The reference is the IC rail's memo. Solana has none, and says which rail fact replaces it.
    reference: solana ? M.receipt.noReferenceSolana : (t.memo || M.receipt.noReferenceIc),
    referenceIsValue: !solana && t.memo.length > 0,
    proofLabel: solana ? M.receipt.signatureLabel : M.receipt.blockLabel,
    proof: t.ledgerRef,
    // A FAILED Solana transaction moved nothing and was charged only the fee. The row carries that
    // status in its memo slot (`hooks/useSolanaHistory.ts#toTxn`), and a receipt for it must repeat
    // it — "−0.000005 SOL" alone reads as a tiny successful payment.
    status: solana ? t.memo : '',
  };
}

/** The receipt as PLAIN TEXT — what the copy button puts on the clipboard, and what a merchant
 *  pastes into a dispute. Every line the sheet renders, in the same order; no label is ever emitted
 *  without a value, because the honest-absence sentences ARE the values. */
export function receiptText(t: Txn, catalog: CurrencyDescriptor[], assets: SelectableAsset[], note?: TxAnnotation): string {
  const f = receiptFields(t, catalog, assets, note);
  const lines = [
    M.receipt.title,
    `${M.receipt.amountLabel}: ${f.amount}`,
    `${M.receipt.assetLabel}: ${f.assetLine}`,
    `${f.partyLabel}: ${f.account}`,
  ];
  // Annotated lines only when the device actually knows them — the same render rule as the sheet.
  if (f.fee != null) lines.push(`${M.receipt.fees}: ${f.fee}`);
  if (f.peer) lines.push(`${M.receipt.peer}: ${f.peer}`);
  if (f.noteText) lines.push(`${M.receipt.note}: ${f.noteText}`);
  lines.push(`${M.receipt.whenLabel}: ${t.time}`, `${M.receipt.referenceLabel}: ${f.reference}`, `${f.proofLabel}: ${f.proof}`);
  if (f.status) lines.splice(1, 0, f.status);
  return lines.join('\n');
}

/** One label + value block. The value is LEFT-aligned mono on its own line rather than right-
 *  aligned beside the label: a 63-character IC principal is the thing a payee checks character by
 *  character, and the review-card's right-aligned value row wraps it into a ragged column. */
function Field({label, value, testID, note = false}: {label: string; value: string; testID: string; note?: boolean}) {
  return (
    <View style={S.receiptField}>
      <Text style={S.receiptLabel}>{label}</Text>
      <Text testID={testID} style={note ? S.receiptNote : S.receiptValue} selectable={!note}>{value}</Text>
    </View>
  );
}

/**
 * MOUNT POINT: the Wallet ROOT, beside the other overlays — never inside a list.
 * `AppModal`'s web host is `SheetOverlay` (`position:absolute; inset:0`), whose containing block is
 * the nearest positioned ancestor; rendered inside `Ledger` or the Home feed it therefore covered
 * only that list's own box, and a card taller than it was clipped at the top (measured: the amount,
 * the asset line and the payer's account were all off-surface). One owner, one instance: Wallet
 * holds the selected `Txn` and both lists hand rows to it.
 */
export function TxnReceipt({t, catalog, assets, onClose, note}: {t: Txn; catalog: CurrencyDescriptor[]; assets: SelectableAsset[]; onClose: () => void; note?: TxAnnotation}) {
  const f = receiptFields(t, catalog, assets, note);
  const {copied, copy} = useCopyFeedback();
  useEscapeToClose(onClose);
  return (
    <AppModal onRequestClose={onClose}>
      {/* The centered-card idiom the wallet already uses for a short explanatory surface (the
          pay-link refusal): backdrop dismisses, the card swallows the press. */}
      <Pressable style={S.pickBackdrop} onPress={onClose}>
        <View testID="txn-receipt" style={S.pickCard} onStartShouldSetResponder={() => true}>
          <Text style={S.pickTitle}>{M.receipt.title}</Text>
          <Text testID="txn-receipt-amount" style={[S.receiptAmount, {color: t.dir === 'out' ? C.ink : C.ok}]}>{f.amount}</Text>
          <Text testID="txn-receipt-asset" style={S.receiptAsset}>{f.assetLine}</Text>
          {f.status ? <Text testID="txn-receipt-status" style={S.receiptNote}>{f.status}</Text> : null}
          {/* The fee line (founder rule 2026-09-14): the receipt headlines the GROSS and shows the
              fee BESIDE it — only when the device knew the fee. */}
          {f.fee != null ? <Field label={M.receipt.fees} value={f.fee} testID="txn-receipt-fees" /> : null}
          <ScrollView style={S.pickScroll}>
            <Field label={f.partyLabel} value={f.account} testID="txn-receipt-account" note={!t.counterparty} />
            {/* Peer/Note render ONLY when the device-saved annotation exists (the receipt's own
                rule: no label over an absent value). The Note renders in the note style — it is
                display text, not a checkable value; Peer stays selectable like the account. */}
            {f.peer ? <Field label={M.receipt.peer} value={f.peer} testID="txn-receipt-peer" /> : null}
            {f.noteText ? <Field label={M.receipt.note} value={f.noteText} testID="txn-receipt-note" note /> : null}
            <Field label={M.receipt.whenLabel} value={t.time} testID="txn-receipt-when" />
            <Field label={M.receipt.referenceLabel} value={f.reference} testID="txn-receipt-ref" note={!f.referenceIsValue} />
            <Field label={f.proofLabel} value={f.proof} testID="txn-receipt-proof" />
            {/* The source line is CONDITIONAL now that annotations exist: it claims every value
                came from the ledger, which is only true when nothing above was device-saved. An
                annotated receipt says so instead — the same honesty rule, extended (the fee and
                the gross headline are device-saved facts too). */}
            <Text style={S.receiptSource}>{f.peer || f.noteText || f.fee != null ? M.receipt.sourceAnnotated : M.receipt.source}</Text>
          </ScrollView>
          <Pressable
            testID="btn-txn-receipt-copy"
            style={[S.primaryWide, S.depositCopy]}
            onPress={() => { void copy(receiptText(t, catalog, assets, note)); }}
            accessibilityRole="button"
            accessibilityLabel={M.receipt.copy}
            accessibilityHint={M.receipt.copyHint}
            accessibilityState={{disabled: false}}
          >
            <IconCopy size={18} color={C.brandInk} />
            <Text style={S.primaryText}>{copied === null ? M.receipt.copy : M.receipt.copied}</Text>
          </Pressable>
          <Pressable
            testID="btn-txn-receipt-close"
            style={S.nfcInfoClose}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={M.receipt.close}
            accessibilityState={{disabled: false}}
          >
            <Text style={S.nfcInfoCloseText}>{M.receipt.close}</Text>
          </Pressable>
        </View>
      </Pressable>
    </AppModal>
  );
}
