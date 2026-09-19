/**
 * i18n/domains/es/receipt.ts — valores en español del comprobante de una transacción.
 * Tipos, documentación de claves y copia de referencia: ../en/receipt.ts. Glosario: ../../es.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptEs: ReceiptMessages = {
  title: 'Comprobante',
  openRow: 'Abrir este comprobante',
  openRowHint: 'Muestra el importe exacto, ambas cuentas y la prueba de la red',
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

  noAccount: 'La red no registró ninguna cuenta en ese lado.',
  noReferenceIc: 'Sin referencia: esta transferencia no llevaba memo.',
  noReferenceSolana: 'Una transferencia de Solana no lleva referencia de dpay: la firma de abajo la identifica.',
  pendingProof: 'Aún sin confirmar — este pago se liquidará en la red más tarde.',

  copy: 'Copiar comprobante',
  copied: 'Copiado ✓',
  copyHint: 'Copia todas las líneas de arriba como texto',
  source: 'Todos los valores se leyeron de la red.',
  sourceAnnotated: 'Valores leídos de la red · el nombre y la nota se guardaron en este dispositivo.',
};
