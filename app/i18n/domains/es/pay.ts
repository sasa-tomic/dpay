/**
 * i18n/domains/es/pay.ts - Spanish values for the Pay + Receive screens.
 *
 * Reference copy, types and rationale: domains/en/pay.ts. Glossary: i18n/es.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payEs: PayMessages = {
  notAPaymentCode: 'Este no es un código de pago de dpay',
  scannedCoinRequest: (coin, uri) =>
    `Esa es una solicitud de pago de ${coin} (${uri}…). Esta billetera paga en Internet Computer y Solana: usa una billetera de ${coin}.`,
  requestExpired: 'Esta solicitud caducó: pide al comercio un QR nuevo',

  sent: amount => (amount ? `Enviado ${amount}` : 'Enviado'),
  alreadyPaid: 'Ya está pagado',
  toWho: who => `a ${who}`,
  toWhoAwaiting: who => `a ${who} · esperando la confirmación del comercio`,
  alreadyNotCharged: (amount, who) => `${amount} a ${who} · no se cobró de nuevo`,
  solAwaiting: who =>
    who ? `a ${who} · esperando la confirmación del comercio` : 'esperando la confirmación del comercio',
  newPayment: 'Nuevo pago',

  shareReceipt: 'Compartir recibo',
  shareSignedCode: 'Compartir código firmado',
  linkCopied: 'Enlace copiado ✓',
  copied: 'Copiado ✓',

  showThisTo: who => `Muéstraselo a ${who}`,
  showThisToMerchant: 'Muéstraselo al comercio',
  amountToWho: (amount, who) => `${amount} a ${who}`,
  signedOnThisDevice: 'firmado ✓',
  signedOffline: 'firmado sin conexión ✓',
  waitingToScan: who => `Esperando a que ${who} lo escanee…`,
  offlineSettles: who =>
    `Sin conexión: ${who} lo confirma al enviarlo. Tu saldo se actualiza cuando vuelvas a tener conexión.`,
  solOfflineSettles:
    'Sin conexión: el comercio lo confirma al enviarlo. Tu saldo se actualiza cuando quede confirmado.',
  handedTo: who => `Entregado a ${who}`,
  handedToMerchant: 'Entregado al comercio',
  handedOffHint: 'Marca el pago como entregado - tu saldo se actualiza cuando el comercio lo confirme',

  unsupportedAsset: 'Activo no admitido',
  unsupportedAssetBody: currency =>
    `Este pago pide un activo que esta billetera no puede pagar (moneda ${currency}). dpay nunca convierte: pide al comercio un activo admitido.`,
  paying: 'Pagando',
  payAmount: amount => `Pagar ${amount}`,
  notEnoughBalance: 'No tienes saldo suficiente para este pago.',
  localBalanceMayNotCover: 'Puede que tu saldo local no alcance; el comercio lo verifica.',
  approve: 'Aprobar',
  approveA11y: 'Aprobar el pago',
  approveHint: 'Firma con tu clave el importe mostrado y lo envía',
  signing: 'Firmando…',
  signsOffline: 'Se firma sin conexión: el comercio lo confirma al enviarlo.',

  link: {
    title: 'Este enlace de pago no se puede pagar',
    part: {recipient: 'la cuenta que cobra', asset: 'el activo', network: 'la red', amount: 'el importe', ref: 'la referencia'},
    malformed: part => `Al enlace le falta ${part}, o el valor está dañado. Pide un enlace nuevo.`,
    unknownAsset: (token, network) =>
      `El enlace pide ${token} en ${network} y no tienes ninguno. dpay nunca convierte: pide un enlace en un activo que tengas.`,
    wrongNetwork: (token, network) =>
      `El enlace pide ${token} en ${network}, pero tienes ${token} en otra red. Pagar enviaría tu dinero a la cadena equivocada: pide a quien te lo envió un enlace en una red que tengas.`,
    hiddenAsset: token =>
      `El enlace pide ${token}, un activo de red de pruebas. En «Saldos», activa «Mostrar activos de prueba» y vuelve a abrir el enlace.`,
    unsupportedAsset: token =>
      `El enlace pide ${token} y esta billetera no puede pagarlo. dpay nunca convierte: pide un enlace en un activo que tengas.`,
    badAmount: (amount, token) =>
      `«${amount}» no es un importe válido de ${token}: revisa los decimales. Pide un enlace nuevo.`,
    badAccount: network =>
      `Esa cuenta no es una cuenta válida de ${network}. Pide a quien te lo envió que la revise y envíe un enlace nuevo.`,
  },

  ocp: {
    solanaTokenUnsupported: symbol =>
      `Esta caja acepta ${symbol} en Solana, pero su código no indica qué cuenta pagar: el dinero podría caer en la equivocada, así que paga con SOL, o cambia en «Saldos».`,
    chooseAsset: selected =>
      `Esta caja no acepta ${selected}, pero sí estos: dpay nunca convierte.`,
    assetNotAccepted: (selected, accepted) =>
      `Esta caja acepta ${accepted}, no ${selected}. dpay nunca convierte: cambia en «Saldos» y vuelve a escanear.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `La caja acepta ${selected}, pero su proveedor no puede procesarla ahora mismo. También acepta ${alternatives}: cambia en «Saldos» y vuelve a escanear.`
        : `La caja acepta ${selected}, pero su proveedor no puede procesarla, y esta billetera no puede pagar ningún otro activo que acepte la caja. Pide al comercio otra forma de pago.`,
    noPayableAsset: accepted =>
      `Esta caja acepta ${accepted}, nada que esta billetera pueda pagar. dpay nunca convierte. Paga de otra forma.`,
    quoteExpired:
      'Este precio ha caducado: vuelve a escanear el código para obtener uno nuevo.',
    notEnoughTime:
      'Este precio caduca demasiado pronto para pagarlo con seguridad: vuelve a escanear para obtener uno nuevo.',
    unreportable: host =>
      `${host} no dio ninguna forma de informar de un pago, así que pagar te costaría el dinero sin que se abone la venta. No se ha pagado nada. Volver a escanear no ayudará: pide al comercio otra forma de pago.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `El precio viene de ${quoteHost}, pero el comprobante de tu pago iría a ${proofHost}. Una venta no puede responder ante dos empresas. No se ha pagado nada: pide al comercio su código.`,
    checkoutPrice: (price, host) => `${price} · precio de ${host}`,
    checkingCheckout: 'Comprobando con el proveedor de pagos…',
    badCode:
      'Este código está dañado, o no es un código de pago. Pide al comercio que lo muestre otra vez: comprueba que no lo tape nada.',
    notHttps:
      'Este código apunta a una dirección insegura, así que dpay no lo abre. Pide al comercio su código: una pegatina encima del real tiene este mismo aspecto.',
    providerUnreachable:
      'No se pudo contactar con el proveedor de pagos. No se ha pagado nada: comprueba tu conexión y vuelve a escanear.',
    badDestination: host =>
      `${host} devolvió una dirección de pago que no coincide con lo que elegiste, así que dpay se ha detenido. No se ha pagado nada: no pagues este código. Pide al comercio uno nuevo.`,
    providerRefused: (host, detail) =>
      `El proveedor de pagos (${host}) rechazó este pago. No se ha pagado nada. Pide al comercio que registre de nuevo la venta y vuelve a escanear. Si sigue fallando, muéstrale lo que dijo: «${detail}».`,
    providerFailed: (host, status) =>
      `El proveedor de pagos (${host}) devolvió un error (${status}) sin motivo. No se ha pagado nada. Espera un momento y vuelve a escanear; si sigue fallando, pide al comercio otra forma de pago.`,
    badAnswer: (host, part) =>
      `El proveedor de pagos (${host}) no envió ${part}, así que dpay no puede pagar en esta caja. No se ha pagado nada. Vuelve a escanear y avisa al comercio si sigue ocurriendo.`,
    answerPart: {
      body: 'una respuesta legible',
      details: 'los datos de pago completos',
      destination: 'una dirección de pago',
      expiry: 'una fecha de caducidad legible',
    },
    noPendingCharge: merchant =>
      `La caja de ${merchant} no tiene ningún cobro abierto. Pide que registren uno primero y vuelve a escanear.`,
    ref: {
      icBlock: index => `el bloque ${index} del registro`,
      solTransaction: signature => `la transacción de Solana ${signature}`,
    },
    submitUnknown: reference =>
      `Tu transferencia se realizó, pero el proveedor no la confirmó: ni pagada ni fallida. El dinero ha salido de tu billetera: no pagues otra vez. Muestra al comercio ${reference}, la prueba de tu transferencia.`,
    submitPending: reference =>
      `Tu transferencia se realizó y el proveedor ya lo sabe: solo que aún no la ha asociado a esta venta; se abonará en cuanto la vea. El dinero ha salido de tu billetera: no pagues otra vez. Si la caja no la muestra, da ${reference} al comercio.`,
    submitRejected: (reference, said) =>
      `Tu transferencia se realizó, pero el proveedor rechazó la prueba: la venta no se ha abonado. El dinero ha salido de tu billetera: no pagues otra vez. Da ${reference} al comercio.`
      + (said === null ? '' : ` El proveedor indica: «${said}»`),
    submitTooLate: reference =>
      `Tu transferencia se realizó, pero solo después de que el precio caducara: la venta no se ha abonado. El dinero ha salido de tu billetera: no pagues otra vez. Da al comercio ${reference}.`,
    transferUnknown:
      'Tu transferencia aún no está confirmada, así que el comercio no sabe nada: ni pagada ni fallida. Deja esta pantalla abierta: dpay sigue comprobándolo y completará el pago si la transferencia se realizó. Mientras tanto, no pagues otra vez.',
    transferRefused: reason =>
      `La transferencia no se realizó: no se ha pagado nada y tu dinero sigue en tu billetera: ${reason}. Vuelve a escanear para pagar.`,
    transferFailed:
      'La red de Solana rechazó tu transacción: no se ha pagado nada. Tu importe está intacto; se cobró una pequeña comisión de red. Vuelve a escanear para reintentar.',
    providerHost: host => `Precio de ${host}`,
  },

  fundsSymbol: 'fondos',
  fundTitle: symbol => `No hay ${symbol} disponible`,
  fundBody: (symbol, action) =>
    action === 'pay'
      ? `Para pagar una solicitud de ${symbol}, primero recibe ${symbol} en tu dirección.`
      : `Para enviar ${symbol}, primero recibe ${symbol} en tu dirección.`,
  fundBodyNoDeposits: symbol =>
    `dpay no puede mostrar una dirección de depósito para ${symbol}. Recíbelo de otra billetera antes de gastarlo.`,
  fundBodyToken: symbol => `Envía ${symbol} (Solana) a tu dirección de ${symbol}. Deja un poco de SOL en la billetera para las comisiones de red.`,
  showMyAddress: symbol => `Ver mi dirección de ${symbol}`,
  createTokenAccount: symbol => `Crear mi cuenta de ${symbol}`,
  fundSibling: {
    holds: (amount, rail) => `Tienes ${amount} en ${rail}`,
    switchTo: network => `Cambiar a ${network}`,
    switchToAsset: asset => `Cambiar a ${asset}`,
    practice: amount =>
      `Tienes ${amount} en dinero de práctica. Practica con él: no tiene valor y no puede pagar a un comercio real.`,
    switchToPractice: 'Cambiar al dinero de práctica',
  },

  offlineSendTitle: 'Enviar a una dirección necesita conexión',
  offlineSendBody: symbol =>
    `Escanea el código del comercio: su teléfono envía tu pago en ${symbol} mientras estás sin conexión.`,
  scannedAddressNotSendable: symbol =>
    `Eso es una dirección de billetera: ${symbol} no se puede enviar a una. Escanea un código de pago para pagar.`,

  spay: {
    wrongRail:
      'Esa es un código de Solana Pay. Esta pantalla paga por Internet Computer: cambia a Solana en Saldos y escanea el código allí.',
    badUri: 'Este código de Solana Pay está dañado. Pide al comercio un QR nuevo.',
    badRecipient: 'El destinatario de este código no es una dirección Solana válida. Pide al comercio un QR nuevo.',
    badAmount: 'El importe de este código no es un número simple mayor que cero. Pide al comercio un QR nuevo.',
    badSplToken: 'El mint de token de este código no es válido. Pide al comercio un QR nuevo.',
    badReference: 'La referencia de pago de este código no es válida. Pide al comercio un QR nuevo.',
    unexpectedParam: param =>
      `Este código trae un parámetro desconocido (${param}): dpay no puede revisar lo que firmaría el pago. Pide al comercio un código sin él.`,
    memoTooLong: 'El memo de este código es demasiado largo para una transacción Solana. Pide al comercio un QR nuevo.',
    unknownMint: mint =>
      `Este código pide un token que dpay no ofrece (mint ${mint}). Págalo con una billetera que lo admita.`,
    offline:
      'Con un código de Solana Pay es tu teléfono quien envía, así que necesita conexión: conéctate y vuelve a escanear.',
    amountLabel: 'Importe',
    merchantMessage: message => `Del comercio: ${message}`,
    pendingNote:
      'La red aceptó este pago; la confirmación sigue en camino. La firma de abajo es tu comprobante: revísala antes de pagar de nuevo.',
  },

  scanToPay: 'Escanear y pagar',
  sendToAddress: 'Enviar a dirección',
  tapOrScanToPay: 'Acerca o escanea para pagar',
  solScanHint: 'Escanea el código del comercio para pagar sin conexión.',
  payNow: 'Pagar ahora',
  payNowA11y: 'Pagar ahora',
  payNowHint: 'Inicia la cámara y el pago sin contacto',
  nfcNotAvailable: 'NFC no disponible',
  whyNfcUnavailable: 'Por qué el NFC no está disponible',
  nfcUnavailableTitle: 'NFC no disponible',
  close: 'Cerrar',

  noCameraFound: 'No se encontró ninguna cámara.',
  pointCamera: 'Apunta la cámara a un código de pago',
  cameraPrivacy: 'Solo para escanear códigos: nunca graba ni sube nada.',
  allowCameraScan: 'Permitir la cámara',
};

export const receiveEs: ReceiveMessages = {
  amountToReceive: 'Importe a recibir',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Nota',
  memoPlaceholder: 'Añade una nota (opcional)',
  chooseCurrency: 'Elige la moneda del pago',
  chooseCurrencyHint: 'Elige qué activo te enviará quien paga',
  request: 'Mostrar código',
  creating: 'Creando…',
  solanaOffline: 'Solana está sin conexión: conéctate para crear una solicitud de pago.',
  solAmountUnderFee: fee =>
    `Una solicitud en SOL debe superar la comisión de red (${fee}). La comisión es tuya: quien paga paga lo que tú escribes.`,
  solFeeLine: (fee, receives) => `Comisión ${fee} · recibes ${receives}`,

  receiveInTitle: 'Recibir en',
  receiveIn: symbol => `Recibir en ${symbol}`,
  switchToRail: symbol => `Cambiar a la vía de ${symbol}`,

  requestPayment: 'Solicitar pago',
  myAddress: 'Mi dirección',
  rail: {
    feeLine: (network, fee) => `${network} · Comisión ${fee}`,
    feeWithOneTime: (network, fee, oneTime) => `${network} · Comisión ${fee} + alquiler único ${oneTime}`,
    feeUnknown: network => `${network} · Comisión desconocida`,
  },
  feeNetLine: (fee, net) => `Comisión ${fee} · recibes ${net}`,
  feeTooBig: fee => `Este importe no cubre la comisión de red (${fee}) - solicita un importe mayor.`,
  showToPayer: nfc =>
    `Muéstraselo a quien paga${nfc === 'tap' ? ' · o que acerque su teléfono' : nfc === 'expired' ? ' · NFC caducado' : ''}`,
  expiredMakeNew: 'Caducada: crea una solicitud nueva',
  validForMin: minutes => `Válida ~${minutes} min`,
  expiresIn: seconds => `Caduca en 0:${seconds}`,
  waitingForPayment: online => `Esperando el pago${online ? '…' : ' - conéctate para enviarlo…'}`,
  waitingForSign: 'Esperando a que quien paga firme sin conexión…',
  offlineCantSubmit: 'Sin conexión: no se pueden enviar pagos hasta que vuelvas a conectarte',
  shareRequestLink: 'Compartir enlace de la solicitud',
  linkUnavailable: 'Este activo no puede nombrarse en un código de pago. Elige otro activo para solicitar un pago.',
  scanPayerSignedCode: 'Escanea el código firmado de quien paga',
  confirmWithTheirPhone: 'Si quien paga lo hizo sin escanear tu código, confírmalo con su teléfono.',
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
  couldNotSubmit: 'No se pudo enviar ese pago. Escanéalo de nuevo. Si ya se procesó, aparecerá en tu saldo.',
  noOpenRequest: 'No hay ninguna solicitud abierta.',
  paymentRejected: 'Pago rechazado.',
  paymentRejectedDetail: 'Pago rechazado: puede que a quien paga le falte saldo, o que el blockhash haya caducado.',
  couldNotConfirmMaySettle: 'No se pudo confirmar: puede que el pago aún se confirme. Revisa tu saldo en breve o reinténtalo.',
  stillCannotConfirm: 'Sigue sin poder confirmarse: puede que el pago aún se confirme. Inténtalo más tarde.',
  settlementNotVerified: 'Confirmado, pero la transacción en cadena no coincide con esta solicitud. No entregues aún la mercancía: comprueba la firma en un explorador de Solana y vigila tu saldo; el pago aún puede llegar.',
  savedDataCorrupt: 'Los datos guardados del pago están dañados.',
  paymentBeingConfirmed: 'Se está confirmando un pago',
  broadcastInterrupted: 'Se interrumpió un envío a la red. Puede que el pago se haya confirmado: reintenta para saberlo.',
  retryBroadcast: 'Reintentar el envío',
  broadcasting: 'Enviando a la red de Solana: puede tardar hasta un minuto.',

  checkout: {
    checkoutCode: 'Muestra también un código de caja para apps OpenCryptoPay (Binance Pay, MoonPay) - el pagador debe tener la app abierta',

    openChargeHint: 'Abrir este importe en tu caja y mostrar al cliente un código pagable',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'Un importe de caja llega hasta el céntimo: pon 10.50, no 10.505.'
        : reason === 'too-large'
        ? 'Ese importe es demasiado alto para abrirlo. Escribe lo que debe este cliente.'
        : 'Escribe el importe a cobrar, por ejemplo 10.50.',

    wrongAssetTitle: 'Un código de caja se paga en VCHF',
    wrongAsset: (selected, network) =>
      `Un código de caja se paga siempre en VCHF en Internet Computer: dpay nunca convierte. Esta solicitud está en ${selected}${network ? ` en ${network}` : ''}. Cambia a VCHF, o quédate con el código dpay: cualquier cámara de teléfono lo abre, y se paga en ${selected}.`,
    noCheckoutAsset:
      'Esta billetera no tiene VCHF, así que no hay cuenta para un cobro de caja. Usa el código dpay: cualquier cámara de teléfono lo abre, y acepta el activo que has elegido.',
    switchTo: asset => `Cambiar a ${asset}`,

    failedTitle: 'El importe no se abrió',
    notServed: host =>
      `${host} no sirve códigos de caja: no se abrió nada. Pide a quien gestiona ese relay que active la caja, o usa el código dpay.`,
    unreachable: host =>
      `Tu conexión está bien, pero ${host} no responde: no se abrió nada. Inténtalo de nuevo en un momento, o usa el código dpay (este teléfono puede mostrarlo sin conexión).`,
    unreachableOffline: host =>
      `Pareces estar sin conexión, así que no se pudo contactar con ${host} y no se abrió nada. Usa por ahora el código dpay o inténtalo de nuevo cuando vuelvas a estar en línea.`,
    refused: said =>
      `La caja rechazó este importe: «${said}» No hay nada que pagar. Corrígelo y vuelve a cobrar.`,
    refusedNoReason: status =>
      `La caja rechazó este importe (HTTP ${status}) sin motivo: no hay nada que pagar. Vuelve a cobrar; si lo rechaza dos veces, avisa a quien gestiona el relay.`,
    mispriced: (cobrado, quoted) =>
      `Cobraste ${cobrado}, pero la caja respondió con ${quoted}: dpay no mostrará un código con una cifra que nadie ha elegido. Vuelve a cobrar; si ocurre otra vez, avisa a quien gestiona el relay antes de aceptar dinero.`,
    unsigned:
      'Este teléfono no pudo firmar el importe: no hay nada que pagar. Reinicia dpay y vuelve a cobrar.',
    servedOther: (served, picked) =>
      `La caja abrió este cobro en ${served}, no en ${picked}: todavía no liquida ${picked}. Vuelve a cobrar en ${served} o avisa a quien gestiona el relay.`,
    tryAgain: 'Reintentar',

    settleOption: (token, currency) => `${token} · ${currency}`,

    settlesAs: (amount, price) =>
      `Usted recibe ${amount} - la comisión del libro mayor corre de su cuenta, así que el cliente paga ${price}.`,
    collecting: 'Cobrando el pago autorizado por el cliente…',
    collectNotApproved:
      'El cliente no autorizó lo suficiente, o la autorización ha caducado. Pídale que vuelva a pagar el código: no se ha cobrado nada.',
    collectNoFunds:
      'El cliente autorizó pero no tiene el dinero. No se ha cobrado nada: pídale que recargue y pague otra vez.',
    collectFailed:
      'No se pudo cobrar el pago autorizado, y no se ha cobrado nada. El código sigue siendo pagable: pídale que lo escanee o acerque su teléfono otra vez.',
    noFeeTitle: 'Esta caja no puede fijar un importe',
    noFee: (symbol, host) =>
      `La comisión del libro mayor la paga el comercio y se descuenta del precio, pero dpay no conoce ninguna comisión para ${symbol}: un cobro se la cobraría al cliente en silencio. No hay nada que pagar. Actualice dpay, o avise a quien gestiona ${host} de que a su lista de monedas le falta la comisión de ${symbol}.`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Enséñaselo al cliente: cualquier cámara de teléfono lo abre, y un teléfono dpay también puede acercarlo.'
        : nfc === 'expired'
        ? 'Enséñaselo al cliente: cualquier cámara de teléfono lo abre. Acercar el teléfono ha caducado en este código: vuelve a marcar el importe para acercarlo.'
        : 'Enséñaselo al cliente: cualquier cámara de teléfono lo abre y paga.',
    waiting: 'Esperando el pago…',
    cantCheck:
      'No se puede comprobar este importe: la caja está incomunicada. Eso NO significa que esté sin pagar. Deja el código a la vista; esta pantalla se actualiza en cuanto vuelva el contacto.',
    expiredWatching:
      'Este código ha caducado, así que ya nadie nuevo puede pagarlo. Si el cliente ya pagó, el dinero todavía puede llegar: se sigue vigilando un momento más.',
    cancel: 'Anular el cobro',
    cancelling: 'Anulando…',
    cancelFailed: said =>
      `El cobro NO se anuló: «${said}» Puede seguir siendo pagable: decide antes de entregar nada.`,
    cancelFailedNoReason: status =>
      `El cobro NO se anuló (HTTP ${status}): trátalo como pagable. Inténtalo otra vez; no entregues nada hasta que se anule o caduque.`,
    cancelUnreachable: host =>
      `Tu conexión está bien, pero ${host} no responde, así que este cobro NO se anuló: sigue siendo pagable hasta que caduque. Inténtalo de nuevo en un momento.`,
    cancelUnreachableOffline: host =>
      `Pareces estar sin conexión, así que no se pudo contactar con ${host} y este cobro NO se anuló: sigue siendo pagable hasta que caduque. Inténtalo otra vez cuando vuelvas a estar en línea.`,

    endedTitle: reason =>
      reason === 'expired' ? 'Este código ha caducado'
      : reason === 'cancelled' ? 'Cobro anulado'
      : reason === 'superseded' ? 'Sustituido por un cobro más reciente'
      : 'La caja ya no tiene este cobro',
    endedBody: reason =>
      reason === 'expired'
        ? 'No llegó nada y ya nadie puede pagarlo. Vuelve a cobrar para enseñar al cliente un código nuevo.'
        : reason === 'cancelled'
        ? 'No se debe nada por él y nadie puede pagarlo. Vuelve a cobrar cuando esté listo el siguiente cliente.'
        : reason === 'superseded'
        ? 'En esta caja se abrió un cobro más reciente, así que este código ya no acepta dinero. Vuelve a cobrar para enseñar uno nuevo.'
        : 'El relay ya no lo tiene, casi seguro porque se reinició. Aquí no se abonó nada. Vuelve a cobrar; si el cliente dice que pagó, mira primero tu saldo de VCHF y las Transacciones.',
    openChargeNext: 'Siguiente cliente',

    paidAmount: price => `Pagado ${price}`,
    paidBlock: block => `Bloque del registro ${block}`,
    paidLate: 'Llegó después de que caducara el código: se acepta, y el dinero está en el registro.',
  },
};
