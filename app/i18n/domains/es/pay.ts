/**
 * i18n/domains/es/pay.ts — Spanish values for the Pay + Receive screens.
 *
 * Reference copy, types and rationale: domains/en/pay.ts. Glossary: i18n/es.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payEs: PayMessages = {
  notAPaymentCode: 'Este no es un código de pago de dpay',
  requestExpired: 'Esta solicitud caducó: pide al comercio un QR nuevo',
  solRequestExpired: 'Esta solicitud de pago ha caducado. Pide al comercio un QR nuevo.',

  sent: amount => (amount ? `Enviado ${amount}` : 'Enviado'),
  alreadyPaid: 'Ya está pagado',
  toWho: who => `a ${who}`,
  toWhoAwaiting: who => `a ${who} · esperando la confirmación del comercio`,
  alreadyNotCharged: (amount, who) => `${amount} a ${who} · no se cobró de nuevo`,
  solAwaiting: who =>
    who ? `a ${who} · esperando la confirmación del comercio` : 'esperando la confirmación del comercio',
  balanceUpdatesOnSettle: 'Tu saldo se actualiza cuando el comercio lo confirme en la cadena.',
  newPayment: 'Nuevo pago',

  shareReceipt: 'Compartir recibo',
  shareReceiptHint: 'Comparte el comprobante del pago como un enlace que el comercio puede abrir para confirmarlo',
  shareAuthCode: 'Compartir código de autorización',
  shareSignedPayment: 'Compartir pago firmado',
  shareSignedCode: 'Compartir código firmado',
  linkCopied: 'Enlace copiado ✓',
  copied: 'Copiado ✓',

  showThisTo: who => `Muéstraselo a ${who}`,
  showThisToMerchant: 'Muéstraselo al comercio',
  amountToWho: (amount, who) => `${amount} a ${who}`,
  signedOnThisDevice: 'firmado en este dispositivo ✓',
  signedOffline: 'firmado sin conexión ✓',
  waitingToScan: who => `Esperando a que ${who} lo escanee…`,
  offlineSettles: who =>
    `Sin conexión: ${who} lo confirmará al enviarlo. Lo verás en tu saldo cuando vuelvas a tener conexión.`,
  solOfflineSettles:
    'Sin conexión: el comercio lo confirmará al enviarlo. Lo verás en tu saldo cuando quede confirmado.',
  handedTo: who => `Entregado a ${who}`,
  handedToMerchant: 'Entregado al comercio',
  handedOffHint: 'Marca el pago firmado como entregado; tu saldo se actualiza cuando el comercio lo confirme',

  unsupportedAsset: 'Activo no admitido',
  unsupportedAssetBody: currency =>
    `Este pago pide un activo que esta billetera no puede pagar (moneda ${currency}). dpay nunca cambia un activo por otro, así que no hay alternativa. Pide al comercio que solicite un activo admitido.`,
  reviewPayment: 'Revisa el pago',
  paying: 'Pagando',
  payAmount: amount => `Pagar ${amount}`,
  notEnoughBalance: 'No tienes saldo suficiente para este pago.',
  localBalanceMayNotCover: 'Puede que tu saldo local no alcance; el comercio lo verificará.',
  approve: 'Aprobar',
  approveA11y: 'Aprobar el pago',
  approveHint: 'Firma con tu clave el importe mostrado y lo envía',
  signing: 'Firmando…',
  signsOffline: 'Esto se firma sin conexión: el comercio lo confirma al enviarlo.',

  fundsSymbol: 'fondos',
  fundTitle: (symbol, action) => `Añade ${symbol} para ${action === 'pay' ? 'pagar' : 'enviar'}`,
  fundBody: (symbol, action) =>
    `Esta billetera todavía no tiene ${symbol}. Envía ${symbol} a tu dirección y podrás ${action === 'pay' ? 'pagar' : 'enviar'} enseguida.`,
  fundBodyNoDeposits: symbol =>
    `Esta billetera todavía no tiene ${symbol}, y ${symbol} aún no admite depósitos. Añade fondos en otro activo o vuelve a intentarlo pronto.`,
  fundBodyUsdc: 'Envía USDC (Solana) a tu dirección de USDC. Deja un poco de SOL en la billetera para las comisiones de red.',
  showMyAddress: symbol => `Ver mi dirección de ${symbol}`,
  createUsdcAccount: 'Crear mi cuenta de USDC',

  scanToPay: 'Escanear y pagar',
  sendToAddress: 'Enviar a dirección',
  tapOrScanToPay: 'Acerca o escanea para pagar',
  scanQrToPay: 'Escanea el código QR para pagar.',
  solScanHint: 'Escanea el código de pago del comercio para pagar sin conexión.',
  payNow: 'Pagar ahora',
  payNowA11y: 'Pagar ahora',
  payNowHint: 'Activa la cámara y el pago sin contacto para poder pagar en un comercio',
  nfcNotAvailable: 'NFC no disponible',
  whyNfcUnavailable: 'Por qué el NFC no está disponible',
  nfcUnavailableTitle: 'NFC no disponible',
  close: 'Cerrar',

  noCameraFound: 'No se encontró ninguna cámara en este dispositivo.',
  pointCamera: 'Apunta con la cámara a un código de pago para pagar',
  cameraPrivacy: 'dpay usa la cámara solo para escanear códigos: nunca graba ni sube nada.',
  allowCameraScan: 'Permitir la cámara',
  allowCameraScanHint: 'Permiso para usar la cámara y poder escanear códigos de pago',
};

export const receiveEs: ReceiveMessages = {
  amountToReceive: 'Importe a recibir',
  amountHint: 'El importe que te enviará quien paga',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Nota',
  memoHint: 'Una nota opcional que se adjunta a esta solicitud de pago',
  memoPlaceholder: 'Añade una nota (opcional)',
  chooseCurrency: 'Elige la moneda del pago',
  chooseCurrencyHint: 'Elige qué activo te enviará quien paga',
  chooseAssetHint: 'Elige qué activo te va a enviar quien paga',
  request: 'Solicitar',
  requestHint: 'Muestra tu código QR para que quien paga lo escanee y te pague',
  creating: 'Creando…',
  creatingRequest: 'Creando la solicitud…',
  solanaOffline: 'Solana está sin conexión: conéctate para crear una solicitud de pago.',

  receiveInTitle: 'Recibir en',
  receiveIn: symbol => `Recibir en ${symbol}`,
  switchToRail: symbol => `Cambiar a la vía de ${symbol}`,

  requestPayment: 'Solicitar pago',
  myAddress: 'Mi dirección',
  showToPayer: nfc =>
    `Muéstraselo a quien paga${nfc === 'tap' ? ' · o que acerque su teléfono' : nfc === 'expired' ? ' · NFC caducado' : ''}`,
  expiredMakeNew: 'Caducada: crea una solicitud nueva',
  validForMin: minutes => `Válida ~${minutes} min`,
  expiresIn: seconds => `Caduca en 0:${seconds}`,
  waitingForPayment: online => `Esperando el pago${online ? '…' : ' — conéctate para enviarlo…'}`,
  waitingForSign: 'Esperando a que quien paga firme sin conexión…',
  offlineCantSubmit: 'Sin conexión: no se pueden enviar pagos hasta que vuelvas a conectarte',
  shareRequestLink: 'Compartir enlace de la solicitud',
  shareRequestHint: 'Comparte esta solicitud como un enlace que quien paga puede abrir para pagar',
  scanPayerSignedQr: 'Escanear el QR firmado',
  scanPayerSignedQrPrompt: 'Escanea el QR firmado de quien paga',
  scanPayerSignedQrHint: 'Escanea el QR firmado de quien paga para enviar su pago sin conexión',
  scanPayerSignedCode: 'Escanea el código firmado de quien paga',
  confirmWithTheirPhone: 'Si quien paga lo hizo sin escanear tu código, toca aquí para confirmarlo con su teléfono.',
  newRequest: 'Nueva solicitud',
  back: 'Atrás',

  payer: 'quien paga',
  receivedAmount: amount => `Recibido ${amount}`,
  fromWho: who => `de ${who}`,
  transactionSignature: 'firma de la transacción',
  copySignature: 'Copiar firma',
  copySignatureA11y: 'Copiar la firma de la transacción',
  sharedConfirm: 'Compartido ✓',

  receiptMalformed: 'Este enlace de recibo no es válido.',
  receiptMismatch: 'Este recibo no coincide con tu solicitud abierta.',
  receiptUnreadable: 'No se pudo leer este enlace de recibo.',
  couldNotConfirmYet: 'Aún no se pudo confirmar este pago: si quien paga lo hizo, aparecerá en la próxima actualización del saldo.',
  unknownLedger: 'Red desconocida para este activo: no se pudo enviar',
  couldNotSubmit: 'No se pudo enviar el pago: revisa la conexión',
  noOpenRequest: 'No hay ninguna solicitud abierta.',
  paymentRejected: 'Pago rechazado.',
  paymentRejectedDetail: 'Pago rechazado: puede que quien paga no tenga saldo suficiente o que el blockhash haya caducado.',
  couldNotConfirmMaySettle: 'No se pudo confirmar: puede que el pago aún se confirme. Revisa tu saldo en breve o reinténtalo.',
  stillCannotConfirm: 'Sigue sin poder confirmarse: puede que el pago aún se confirme. Inténtalo más tarde.',
  savedDataCorrupt: 'Los datos guardados del pago están dañados.',
  paymentBeingConfirmed: 'Se está confirmando un pago',
  broadcastInterrupted: 'Se interrumpió un envío a la red. Puede que el pago se haya confirmado: reintenta para saberlo.',
  retryBroadcast: 'Reintentar el envío',
  broadcasting: 'Enviando a la red de Solana: puede tardar hasta un minuto.',
};
