/**
 * i18n/domains/es/errors.ts — Spanish values for the thrown-and-rendered failure copy.
 *
 * Reference copy, types and rationale: domains/en/errors.ts. Glossary: i18n/es.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsEs: ErrorMessages = {
  seedFormat: 'La semilla de recuperación debe tener 64 caracteres hexadecimales (0-9, a-f).',

  ic: {
    clockUnreachable: 'No se pudo consultar el reloj de Internet Computer',
    clockSkew: 'El desfase con el reloj de Internet Computer es demasiado grande',
    noLedgerForCurrency: 'Activo no admitido: no hay red para esta moneda',
    feeUnavailable: 'No se pudo obtener la comisión de la red: revisa tu conexión',
  },

  solana: {
    offline: 'Solana está sin conexión (no hay endpoint RPC configurado)',
    tokenUnavailable: asset => `El ${asset} de Solana no está disponible (no hay endpoint RPC configurado)`,
    senderNoTokenAccount: asset =>
      `Tu billetera aún no tiene una cuenta de ${asset}. Conéctate una vez a internet y abre Recibir ▸ «Crear mi cuenta de ${asset}» para crearla — o paga a este comercio con un activo que ya tengas`,
    senderTokenAccountUnverified: asset =>
      `dpay no pudo comprobar si tu billetera tiene una cuenta de ${asset}. Si no la tiene, este pago no puede liquidarse. Conéctate una vez a internet y abre Recibir ▸ Mi dirección para comprobarlo o crear la cuenta.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `dpay no pudo comprobar si tu billetera tiene una cuenta de ${asset}: Solana no responde a esta billetera, así que tener más cobertura no ayudará. Si la cuenta no existe, este pago no puede liquidarse. Abre Recibir ▸ Mi dirección para comprobarlo o crearla cuando Solana vuelva a responder.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Aún no tiene una cuenta de ${asset}: crearla requiere unos ${solAmount} en esta billetera (renta y comisión de una sola vez, las pagas tú); envía un poco de SOL aquí primero`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Crear tu cuenta de ${asset} requiere unos ${solAmount} en esta billetera (renta de la cuenta y comisión, una sola vez); envía un poco de SOL aquí primero`,
  },

  rail: {
    refused: network =>
      `El endpoint de ${network} rechazó la solicitud, así que estos saldos están desactualizados. No se movió nada, tus otras cuentas funcionan y dpay sigue reintentando.`,
    offline: network =>
      `Parece que estás sin conexión — los saldos de ${network} no están actualizados, no se movió nada. Se actualizan solos al volver la conexión; pagar por QR sigue funcionando.`,
    unreachable: network =>
      `${network} es inaccesible aunque estás en línea — el relay de dpay no puede alcanzar ${network} en este momento, y tu dinero está intacto. No se movió nada, tus pagos de Internet Computer siguen funcionando, y puedes seguir firmando pagos sin conexión. En Ajustes ▸ Avanzado puedes apuntar esta billetera a cualquier endpoint de ${network}.`,
    unreadable: network =>
      `${network} respondió con datos que esta billetera no puede leer, así que estos saldos están desactualizados. No se movió nada, tus otras cuentas funcionan y dpay sigue reintentando.`,
    historyStale: network =>
      `El historial de ${network} está desactualizado — no se movió nada y se actualiza solo.`,
    unreachableHint: () => 'Abre Ajustes ▸ Avanzado.',
  },

  ethWallet: {
    receiptReverted: hash => `la transacción ${hash} se revirtió en la cadena`,
    receiptTimeout: hash => `la transacción ${hash} no se minó dentro del tiempo de espera`,
    hashMissing: received =>
      `Tu billetera respondió sin identificador de transacción (${received}), así que dpay no puede saber si se envió.`,
    sendTimedOut: 'Tu billetera no respondió, así que dpay no puede saber si la transacción se envió.',
    requestTimedOut:
      'Tu billetera no respondió. Abre tu app de billetera, atiende cualquier solicitud pendiente y vuelve a intentarlo.',
    pairingTimedOut: 'se agotó el tiempo de vinculación: ninguna billetera escaneó el código en 5 min',
    pairingFailed: detail => `Falló la vinculación con WalletConnect: ${detail}`,
    invalidChainId: value =>
      `Tu billetera informó una red que dpay no puede leer (${value}). Vuelve a conectarla y, si sigue pasando, usa otra aplicación de billetera.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Tu billetera se conectó, pero no autorizó ninguna red de Ethereum. Este depósito se liquida en la red ${requested}: cambia a ella en tu billetera y vuelve a conectar.`
        : `Tu billetera autorizó la red ${approved}, pero este depósito se liquida en la red ${requested}. Cambia de red en tu billetera y vuelve a conectar.`,
  },

  tap: {
    couldntConfirmOffline: 'No se pudo confirmar: revisa tu saldo cuando vuelvas a tener conexión',
    couldntVerifyRequest: 'No se pudo verificar esta solicitud',
    couldntReturnResult: 'No se pudo devolver el resultado del pago: mantén los teléfonos juntos e inténtalo de nuevo',
    merchantRefusalUnverified:
      'Según la respuesta del libro mayor, esta transferencia no se realizó, pero dpay no pudo verificar esa respuesta en este teléfono. No entregues la mercancía. Revisa en un momento tu saldo y tus transacciones: si el dinero sí llegó, aparecerá ahí.',
    merchantNothingArrived:
      'No se recibió ningún pago. No entregues la mercancía. Una transferencia todavía puede llegar después del contacto y aparecerá en tu saldo y en tus transacciones. Pide al cliente que vuelva a acercar el teléfono solo si no aparece nada.',
    unsupportedAsset: currency => `Activo no admitido (moneda ${currency})`,
    cannotConfirmAsset: currency => `No se puede confirmar el activo (moneda ${currency})`,
    couldntReadRequest: 'No se pudo leer la solicitud de pago',
    requestExpired: 'Esta solicitud caducó: pide una nueva',
    couldntAuthorize: 'No se pudo autorizar el pago: inténtalo de nuevo',
    noOpenRequest: 'No hay ninguna solicitud abierta',
    paymentRejected: 'Pago rechazado',
    couldntConfirm: 'No se pudo confirmar',
    couldntConfirmCheckBalance: 'No se pudo confirmar el pago: revisa tu saldo',
    settlementNotVerified: 'Confirmado, pero no es esta solicitud: comprueba la firma antes de entregar',
    paymentRequestExpired: 'Esta solicitud de pago ha caducado',
  },
};
