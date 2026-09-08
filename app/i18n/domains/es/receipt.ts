/**
 * i18n/domains/es/receipt.ts — valores en español del comprobante de una transacción.
 * Tipos, documentación de claves y copia de referencia: ../en/receipt.ts. Glosario: ../../es.ts.
 */
import type {ReceiptMessages} from '../../keys';

export const receiptEs: ReceiptMessages = {
  title: 'Comprobante',
  openRow: 'Abrir este comprobante',
  openRowHint: 'Muestra el importe exacto, la cuenta de la otra parte y la prueba de la red',
  close: 'Cerrar',

  amountLabel: 'Importe',
  toLabel: 'Pagado a',
  fromLabel: 'Recibido de',
  whenLabel: 'Cuándo',
  assetLabel: 'Activo',
  referenceLabel: 'Referencia',
  blockLabel: 'Bloque de la red',
  signatureLabel: 'Firma de la transacción',

  noAccount: 'La red no registró ninguna cuenta en ese lado de la transferencia.',
  noReferenceIc: 'Sin referencia: esta transferencia no llevaba memo. Una solicitud de pago de dpay siempre pone una.',
  noReferenceSolana: 'Una transferencia de Solana no lleva referencia de dpay. La firma de abajo la identifica.',

  copy: 'Copiar comprobante',
  copied: 'Copiado ✓',
  copyHint: 'Copia todas las líneas de arriba como texto para pegar o enviar',
  source: 'Cada valor de arriba se leyó de la red.',
};
