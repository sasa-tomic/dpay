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
    chooseAsset: selected =>
      `Esta caja no acepta ${selected}, pero sí estos: elige con cuál pagar. dpay nunca convierte: pagas el activo que elijas.`,
    assetNotAccepted: (selected, accepted) =>
      `Esta caja no acepta ${selected}. Acepta ${accepted}. dpay nunca convierte, así que cambia en «Saldos» a uno de esos activos y vuelve a escanear.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `Esta caja acepta ${selected}, pero el proveedor de pagos del comercio no puede procesar ${selected} ahora mismo. La caja también acepta ${alternatives}. dpay nunca convierte, así que cambia en «Saldos» a uno de esos activos y vuelve a escanear.`
        : `Esta caja acepta ${selected}, pero el proveedor de pagos del comercio no puede procesar ${selected} ahora mismo, y esta billetera no puede pagar ningún otro activo que acepte esta caja. Pide al comercio otra forma de pago.`,
    noPayableAsset: accepted =>
      `dpay no puede pagar en esta caja. Acepta ${accepted}, y esta billetera no puede pagar ninguno de esos activos; dpay nunca convierte. Paga esta compra de otra forma.`,
    quoteExpired:
      'El precio de esta caja ha caducado: cada uno dura unos cinco minutos. Vuelve a escanear el código para obtener un precio nuevo.',
    notEnoughTime:
      'Este precio caduca demasiado pronto para pagarlo con seguridad. Tu dinero saldría antes de que se pueda avisar al proveedor de pagos del comercio, y después él rechazaría la venta. Vuelve a escanear el código para obtener un precio nuevo.',
    unreportable: host =>
      `${host} no le ha dado a dpay ninguna forma de informarle de un pago, así que pagar aquí te costaría el dinero sin que se abone la venta. No se ha pagado nada. Volver a escanear no cambiará esto: pide al comercio otra forma de pago.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `El precio de este código viene de ${quoteHost}, pero pide que el comprobante de tu pago se envíe a ${proofHost}. Un pago no puede responder ante dos empresas distintas, así que dpay se ha detenido. No se ha pagado nada: pide al comercio que muestre su propio código de pago.`,
    tillCharging: price =>
      `El comercio cobra ${price}. Su proveedor de pagos fijó el importe de arriba; dpay no convierte.`,
    checkingTill: 'Comprobando con el proveedor de pagos del comercio…',
    badCode:
      'Este código está dañado, o no es un código de pago. Pide al comercio que lo muestre otra vez y comprueba que no lo tape nada.',
    notHttps:
      'Este código apunta a una dirección insegura, así que dpay no lo abre. Pide al comercio que muestre su propio código de pago: una pegatina encima del código real tiene exactamente este aspecto.',
    providerUnreachable:
      'No se pudo contactar con el proveedor de pagos del comercio. No se ha pagado nada. Comprueba tu conexión y vuelve a escanear.',
    badDestination: host =>
      `${host} respondió con una dirección de pago que no coincide con lo que elegiste, así que dpay se ha detenido. No se ha pagado nada: no pagues este código. Pide al comercio que muestre su propio código otra vez.`,
    providerRefused: (host, detail) =>
      `El proveedor de pagos del comercio (${host}) no ha aceptado este pago. No se ha pagado nada. Pide al comercio que registre la venta otra vez y vuelve a escanear el código. Si sigue fallando, muéstrale lo que dijo su proveedor: «${detail}».`,
    providerFailed: (host, status) =>
      `El proveedor de pagos del comercio (${host}) respondió con un error (${status}) y no dio ningún motivo. No se ha pagado nada. Espera un momento y vuelve a escanear el código; si sigue fallando, pide al comercio otra forma de pago.`,
    badAnswer: (host, part) =>
      `El proveedor de pagos del comercio (${host}) no envió ${part}, así que dpay no puede pagar en esta caja. No se ha pagado nada. Vuelve a escanear el código y avisa al comercio si sigue ocurriendo.`,
    answerPart: {
      body: 'una respuesta legible',
      details: 'los datos de pago completos',
      destination: 'una dirección de pago',
      expiry: 'una fecha de caducidad legible',
    },
    noPendingCharge: merchant =>
      `La caja de ${merchant} no tiene ningún cobro pendiente. Pide que registren la venta primero y vuelve a escanear el código.`,
    ref: {
      icBlock: index => `el bloque ${index} del registro`,
      solTransaction: signature => `la transacción de Solana ${signature}`,
    },
    submitUnknown: reference =>
      `Tu transferencia se realizó, pero el proveedor de pagos del comercio no la confirmó: no está pagada ni ha fallado. El dinero ha salido de tu billetera, así que no pagues otra vez. Muestra al comercio ${reference}: es la prueba de tu transferencia.`,
    submitRejected: reference =>
      `Tu transferencia se realizó, pero el proveedor de pagos del comercio rechazó la prueba, así que la venta no se ha abonado. El dinero ha salido de tu billetera, así que no pagues otra vez. Contacta con el comercio e indícale ${reference}.`,
    submitTooLate: reference =>
      `Tu transferencia se realizó, pero solo después de que este precio caducara, así que la venta no se ha abonado. El dinero ha salido de tu billetera, así que no pagues otra vez. Contacta con el comercio e indícale ${reference}: es la prueba de tu transferencia.`,
    transferUnknown:
      'dpay aún no ha podido confirmar tu transferencia, así que el comercio no sabe nada de ella: no está pagada ni ha fallado. Deja esta pantalla abierta: dpay sigue comprobándolo y completará el pago por su cuenta si la transferencia se realizó. Mientras tanto, no pagues otra vez.',
    transferRefused: reason =>
      `Tu transferencia no se realizó, así que no se ha pagado nada y tu dinero sigue en tu billetera: ${reason}. Vuelve a escanear el código para pagar en esta caja.`,
    transferFailed:
      'La red de Solana rechazó tu transacción, así que no se ha pagado nada: el importe sigue en tu billetera (se ha cobrado una pequeña comisión de red). Vuelve a escanear el código para intentarlo de nuevo.',
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
