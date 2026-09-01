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
  linkNameClaimed: 'Nombre indicado por quien envía: comprueba la cuenta de arriba.',

  link: {
    title: 'Este enlace de pago no se puede pagar',
    part: {recipient: 'la cuenta que cobra', asset: 'el activo', network: 'la red', amount: 'el importe', ref: 'la referencia'},
    malformed: part => `Al enlace le falta ${part} o el valor está dañado. Pide un enlace nuevo a quien te lo envió.`,
    unknownAsset: (token, network) =>
      `El enlace pide ${token} en ${network}. Esta cartera no tiene ese activo y dpay nunca convierte, así que no hay alternativa. Pide un enlace en un activo que tengas.`,
    wrongNetwork: (token, network) =>
      `El enlace pide ${token} en ${network}. Tú tienes ${token} en otra red: es un activo distinto y el pago iría a la cadena equivocada. Pide un enlace en una red que tengas.`,
    hiddenAsset: token =>
      `El enlace pide ${token}, un activo de red de pruebas. Abre «Saldos», activa «Mostrar activos de prueba» y vuelve a abrir el enlace.`,
    unsupportedAsset: token =>
      `El enlace pide ${token} y esta cartera no puede pagarlo. dpay nunca convierte, así que no hay alternativa. Pide un enlace en un activo que tengas.`,
    badAmount: (amount, token) =>
      `«${amount}» no es un importe válido de ${token}: puede tener más decimales de los que admite ${token}. Pide un enlace nuevo.`,
    badAccount: network =>
      `La cuenta de este enlace no es una cuenta válida de ${network}. Pide a quien te lo envió que la revise y te mande el enlace otra vez.`,
  },

  ocp: {
    solanaUsdcUnsupported:
      'Esta caja acepta USDC en Solana, pero su código no indica a qué cuenta de token enviarlo: pagar así podría mandar dinero real a la cuenta equivocada. Paga con SOL, o cambia en «Saldos» a otro activo que acepte esta caja.',
    assetNotAccepted: (selected, accepted) =>
      `Esta caja no acepta ${selected}. Acepta ${accepted}. dpay nunca convierte, así que cambia en «Saldos» a uno de esos activos y vuelve a escanear.`,
    quoteExpired:
      'El precio de esta caja ha caducado: cada uno dura unos cinco minutos. Vuelve a escanear el código para obtener un precio nuevo.',
    badCode:
      'Este código está dañado, o no es un código de pago. Pide al comercio que lo muestre otra vez y comprueba que no lo tape nada.',
    notHttps:
      'Este código apunta a una dirección insegura, así que dpay no lo abre. Pide al comercio que muestre su propio código de pago: una pegatina encima del código real tiene exactamente este aspecto.',
    providerUnreachable:
      'No se pudo contactar con el proveedor de pagos del comercio. No se ha pagado nada. Comprueba tu conexión y vuelve a escanear.',
    noPendingCharge: merchant =>
      `La caja de ${merchant} no tiene ningún cobro pendiente. Pide que registren la venta primero y vuelve a escanear el código.`,
    submitUnknown: blockIndex =>
      `Tu transferencia se realizó, pero el proveedor de pagos del comercio no la confirmó: no está pagada ni ha fallado. El dinero ha salido de tu billetera, así que no pagues otra vez. Muestra al comercio el bloque ${blockIndex} del registro: es la prueba de tu transferencia.`,
    submitRejected: blockIndex =>
      `Tu transferencia se realizó, pero el proveedor de pagos del comercio rechazó la prueba, así que la venta no se ha abonado. El dinero ha salido de tu billetera, así que no pagues otra vez. Contacta con el comercio e indícale el bloque ${blockIndex} del registro.`,
    claimedMerchant: 'Nombre indicado por el código: dpay no lo verifica.',
    providerHost: host => `Precio de ${host}`,
  },

  fundsSymbol: 'fondos',
  fundTitle: (symbol, action) => `Añade ${symbol} para ${action === 'pay' ? 'pagar' : 'enviar'}`,
  fundBody: (symbol, action) =>
    `Esta billetera todavía no tiene ${symbol}. Envía ${symbol} a tu dirección y podrás ${action === 'pay' ? 'pagar' : 'enviar'} enseguida.`,
  fundBodyNoDeposits: symbol =>
    `Esta billetera todavía no tiene ${symbol}, y ${symbol} aún no admite depósitos. Añade fondos en otro activo o vuelve a intentarlo pronto.`,
  fundBodyUsdc: 'Envía USDC (Solana) a tu dirección de USDC. Deja un poco de SOL en la billetera para las comisiones de red.',
  showMyAddress: symbol => `Ver mi dirección de ${symbol}`,
  createUsdcAccount: 'Crear mi cuenta de USDC',

  offlineSendTitle: 'Enviar a una dirección necesita conexión',
  offlineSendBody: symbol =>
    `Al enviar a una dirección es tu teléfono quien envía la operación, así que necesita estar en línea. Para pagar sin conexión, escanea el código de pago del comercio: su teléfono envía tu pago en ${symbol} por ti.`,
  scannedAddressNotSendable: symbol =>
    `Eso es una dirección de billetera. ${symbol} no se puede enviar a una dirección: escanea el código de pago del comercio para pagar.`,

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
