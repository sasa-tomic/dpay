/**
 * i18n/domains/fr/receipt.ts — valeurs françaises du reçu d’une transaction.
 * Types, documentation des clés et copie de référence : ../en/receipt.ts. Glossaire : ../../fr.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptFr: ReceiptMessages = {
  title: 'Reçu',
  openRow: 'Ouvrir ce reçu',
  openRowHint: 'Montant exact, les deux comptes, preuve du registre',
  close: 'Fermer',

  amountLabel: 'Montant',
  toLabel: 'Payé à',
  fromLabel: 'Reçu de',
  whenLabel: 'Quand',
  assetLabel: 'Actif',
  referenceLabel: 'Référence',
  peer: 'Correspondant',
  note: 'Note',
  fees: 'Frais',
  blockLabel: 'Bloc du registre',
  signatureLabel: 'Signature de la transaction',

  noAccount: 'Aucun compte enregistré de ce côté.',
  partyPool: 'Un pool de liquidité',
  noReferenceIc: 'Ce transfert ne portait pas de mémo.',
  noReferenceSolana: 'Solana ne porte aucune référence dpay — la signature l’identifie.',
  pendingProof: 'Pas encore confirmé — sera réglé dans le registre plus tard.',

  copy: 'Copier le reçu',
  copied: 'Copié ✓',
  copyHint: 'Copie toutes les lignes ci-dessus',
  source: 'Lu dans le registre.',
  sourceAnnotated: 'Lu dans le registre · nom et note enregistrés sur cet appareil.',
};
