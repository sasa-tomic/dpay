/**
 * i18n/domains/fr/receipt.ts — valeurs françaises du reçu d’une transaction.
 * Types, documentation des clés et copie de référence : ../en/receipt.ts. Glossaire : ../../fr.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptFr: ReceiptMessages = {
  title: 'Reçu',
  openRow: 'Ouvrir ce reçu',
  openRowHint: 'Affiche le montant exact, les deux comptes et la preuve du registre',
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

  noAccount: 'Le registre n’a enregistré aucun compte de ce côté.',
  noReferenceIc: 'Aucune référence — ce transfert ne portait pas de mémo.',
  noReferenceSolana: 'Un transfert Solana ne porte aucune référence dpay — la signature ci-dessous l’identifie.',
  pendingProof: 'Pas encore confirmé — ce paiement sera réglé dans le registre plus tard.',

  copy: 'Copier le reçu',
  copied: 'Copié ✓',
  copyHint: 'Copie toutes les lignes ci-dessus sous forme de texte',
  source: 'Toutes les valeurs ont été lues dans le registre.',
  sourceAnnotated: 'Valeurs lues dans le registre · le nom et la note ont été enregistrés sur cet appareil.',
};
