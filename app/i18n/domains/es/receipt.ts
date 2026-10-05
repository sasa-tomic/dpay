/**
 * i18n/domains/es/receipt.ts - valores en español del comprobante de una transacción.
 * Tipos, documentación de claves y copia de referencia: ../en/receipt.ts. Glosario: ../../es.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptEs: ReceiptMessages = {
  title: 'Comprobante',
  openRow: 'Abrir este comprobante',
  openRowHint: 'Importe exacto, ambas cuentas, prueba de la red',
  close: 'Cerrar',

  amountLabel: 'Importe',
  toLabel: 'Pagado a',
  fromLabel: 'Recibido de',
  whenLabel: 'Cuándo',
  assetLabel: 'Activo',
  referenceLabel: 'Referencia',
  peer: 'Contraparte',
  note: 'Nota',
  fees: 'Comisiones',
  blockLabel: 'Bloque de la red',
  signatureLabel: 'Firma de la transacción',

  noAccount: 'Sin cuenta registrada en ese lado.',
  partyPool: 'Un pool de liquidez',
  noReferenceIc: 'Esta transferencia no llevaba memo.',
  noReferenceSolana: 'Solana no lleva referencia de dpay: la firma la identifica.',
  pendingProof: 'Aún sin confirmar - se liquidará en la red más tarde.',

  copy: 'Copiar comprobante',
  copied: 'Copiado ✓',
  copyHint: 'Copia todas las líneas de arriba',
  source: 'Leído de la red.',
  sourceAnnotated: 'Leído de la red · nombre y nota guardados en tu teléfono.',
};
