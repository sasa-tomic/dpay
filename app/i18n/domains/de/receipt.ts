/**
 * i18n/domains/de/receipt.ts — Deutsche Werte für den Transaktions-Beleg.
 * Typen, Key-Dokumentation und die Referenz-Copy: ../en/receipt.ts. Glossar: ../../de.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptDe: ReceiptMessages = {
  title: 'Beleg',
  openRow: 'Diesen Beleg öffnen',
  openRowHint: 'Zeigt den genauen Betrag, das Konto der Gegenseite und den Ledger-Nachweis',
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

  noAccount: 'Das Ledger hat für diese Seite der Überweisung kein Konto festgehalten.',
  noReferenceIc: 'Keine Referenz — diese Überweisung trug kein Memo. Eine dpay-Zahlungsanfrage setzt immer eine.',
  noReferenceSolana: 'Eine Solana-Überweisung trägt keine dpay-Referenz. Die Signatur unten identifiziert sie.',
  pendingProof: 'Noch nicht bestätigt — diese Zahlung wird später im Ledger verbucht.',

  copy: 'Beleg kopieren',
  copied: 'Kopiert ✓',
  copyHint: 'Kopiert alle Zeilen oben als Text zum Einfügen oder Versenden',
  source: 'Jeder Wert oben wurde aus dem Ledger gelesen.',
  sourceAnnotated: 'Werte aus dem Ledger gelesen · Name und Notiz wurden beim Tätigen der Zahlung auf diesem Gerät gespeichert.',
};
