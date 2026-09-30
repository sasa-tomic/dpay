/**
 * i18n/domains/de/receipt.ts — Deutsche Werte für den Transaktions-Beleg.
 * Typen, Key-Dokumentation und die Referenz-Copy: ../en/receipt.ts. Glossar: ../../de.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptDe: ReceiptMessages = {
  title: 'Beleg',
  openRow: 'Diesen Beleg öffnen',
  openRowHint: 'Genauer Betrag, beide Konten, Ledger-Nachweis',
  close: 'Schließen',

  amountLabel: 'Betrag',
  toLabel: 'Bezahlt an',
  fromLabel: 'Empfangen von',
  whenLabel: 'Wann',
  assetLabel: 'Asset',
  referenceLabel: 'Referenz',
  peer: 'Gegenstelle',
  note: 'Notiz',
  fees: 'Gebühren',
  blockLabel: 'Ledger-Block',
  signatureLabel: 'Transaktionssignatur',

  noAccount: 'Kein Konto auf dieser Seite vermerkt.',
  partyPool: 'Ein Liquiditätspool',
  noReferenceIc: 'Diese Überweisung trug kein Memo.',
  noReferenceSolana: 'Solana trägt keine dpay-Referenz — die Signatur identifiziert sie.',
  pendingProof: 'Noch nicht bestätigt — wird später im Ledger verbucht.',

  copy: 'Beleg kopieren',
  copied: 'Kopiert ✓',
  copyHint: 'Kopiert alle Zeilen oben',
  source: 'Aus dem Ledger gelesen.',
  sourceAnnotated: 'Aus dem Ledger gelesen · Name und Notiz auf diesem Gerät gespeichert.',
};
