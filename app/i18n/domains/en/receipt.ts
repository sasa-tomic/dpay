/**
 * i18n/domains/en/receipt.ts — the transaction RECEIPT (X6).
 *
 * Its own domain because it is its own surface: the merchant-reconciliation and dispute path. A
 * transaction row opens it, and it states what the LEDGER recorded — the exact amount, the full
 * account on the other side, the reference the payee reconciles against, and the ledger's own id
 * for the row.
 *
 * THE RULE THIS COPY IS HELD TO: a field is shown only when the rail really provides it. The two
 * rails differ — an Internet Computer transfer carries a memo and lands in a numbered ledger
 * block; a Solana transfer carries no dpay reference and is identified by its signature — so where
 * a field is absent the copy says WHY in one line. A blank labelled row is worse than an absent
 * one, and in a dispute it is worse still: it looks like a value that failed to load.
 */

export type ReceiptMessages = {
  /** Sheet title. */
  title: string;
  /** The transaction row that opens the sheet (accessible name + hint). */
  openRow: string;
  openRowHint: string;
  close: string;

  /** Field labels. `toLabel`/`fromLabel` are chosen by the row's direction. */
  amountLabel: string;
  toLabel: string;
  fromLabel: string;
  whenLabel: string;
  assetLabel: string;
  /** The payee's reconciliation key — the memo that rode the transfer (IC rail). */
  referenceLabel: string;
  /** The peer's NAME as this device knew it at payment time (request to_name, link/spay label,
   *  saved-address label). Rendered only when one exists — the account line above stays the full
   *  ledger principal whatever this says. */
  peer: string;
  /** The human MESSAGE this device saved when the payment was made (the on-chain memo is the
   *  nonce — this is the request/link/spay text, device-side only). Rendered only when one exists. */
  note: string;
  /** The IC ledger's own index for this transfer. */
  blockLabel: string;
  /** The Solana transaction's own id. */
  signatureLabel: string;

  /** Honest absences — each says what the ledger did NOT record, and what stands in its place. */
  noAccount: string;
  noReferenceIc: string;
  noReferenceSolana: string;

  /** The copy-the-proof action. */
  copy: string;
  copied: string;
  copyHint: string;
  /** One line at the foot: where these values came from. */
  source: string;
  /** The same line for an ANNOTATED receipt — the peer/note lines above were saved on this device
   *  when the payment was made, and the copy must not claim the ledger said them. */
  sourceAnnotated: string;
};

export const receiptEn: ReceiptMessages = {
  title: 'Receipt',
  openRow: 'Open this receipt',
  openRowHint: 'Shows the exact amount, the account it moved between and the ledger proof',
  close: 'Close',

  amountLabel: 'Amount',
  toLabel: 'Paid to',
  fromLabel: 'Received from',
  whenLabel: 'When',
  assetLabel: 'Asset',
  referenceLabel: 'Reference',
  peer: 'Peer',
  note: 'Note',
  blockLabel: 'Ledger block',
  signatureLabel: 'Transaction signature',

  noAccount: 'The ledger recorded no account on that side of this transfer.',
  noReferenceIc: 'No reference — this transfer carried no memo. A dpay payment request always sets one.',
  noReferenceSolana: 'A Solana transfer carries no dpay reference. The signature below identifies it.',

  copy: 'Copy receipt',
  copied: 'Copied ✓',
  copyHint: 'Copies every line above as text you can paste or send',
  source: 'Every value above was read from the ledger.',
  sourceAnnotated: 'Values read from the ledger · the name and note were saved on this device when the payment was made.',
};
