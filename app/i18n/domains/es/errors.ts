/**
 * i18n/domains/es/errors.ts — Spanish values for the copy that is thrown and rendered verbatim.
 * Types, key documentation and the reference copy: ../en/errors.ts. Glossary: ../../es.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsEs: ErrorMessages = {
  seedFormat: 'La semilla debe tener 64 caracteres hexadecimales (0-9, a-f).',

  ic: {
    clockUnreachable: 'Reloj de IC inaccesible',
    clockSkew: 'Desfase de reloj de IC demasiado grande',
    noLedgerForCurrency: 'Activo no admitido',
    feeUnavailableOffline: 'Pareces estar sin conexión, así que no se pudo leer la comisión de la red. No se envió nada. Inténtalo de nuevo cuando vuelvas a estar en línea.',
    feeUnavailableUnreachable: 'Tu conexión está bien, pero Internet Computer no responde, así que no se pudo leer la comisión de la red. Tu dinero está intacto. Inténtalo de nuevo en un momento.',
  },

  solana: {
    offline: 'Solana está sin conexión (no hay endpoint configurado)',
    tokenUnavailable: asset => `${asset} de Solana no disponible (no hay endpoint configurado)`,
    senderNoTokenAccount: asset =>
      `No tienes cuenta de ${asset}. Conéctate a internet y abre Recibir ▸ «Crear mi cuenta de ${asset}», o paga con un activo que tengas`,
    senderTokenAccountUnverified: asset =>
      `No se pudo comprobar tu cuenta de ${asset}. Sin ella, este pago no puede liquidarse. Conéctate a internet y abre Recibir ▸ Mi dirección para comprobarla o crearla.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `No se pudo comprobar tu cuenta de ${asset}: Solana no responde. Sin ella, este pago no puede liquidarse. Cuando vuelva: Recibir ▸ Mi dirección.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Todavía no tiene una cuenta de ${asset}. Crearla cuesta unos ${solAmount}, los pagas tú: envía un poco de SOL aquí primero`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Crear tu cuenta de ${asset} cuesta unos ${solAmount}. Envía un poco de SOL aquí primero.`,
  },

  rail: {
    refused: network =>
      `${network} rechazó la solicitud — saldos desactualizados. No se movió nada; dpay sigue reintentando.`,
    offline: network =>
      `Parece que estás sin conexión — saldos de ${network} desactualizados. No se movió nada. Se actualizan al reconectar; pagar por QR sigue funcionando.`,
    unreachable: network =>
      `${network} es inaccesible aunque estás en línea — el relay de dpay no logra conectar. Dinero intacto; los pagos de IC funcionan; los pagos se siguen firmando sin conexión. En Ajustes ▸ Avanzado puedes apuntar esta billetera a cualquier endpoint de ${network}.`,
    unreadable: network =>
      `${network} envió datos que esta billetera no puede leer — saldos desactualizados. No se movió nada; dpay sigue reintentando.`,
    historyStale: network =>
      `El historial de ${network} está desactualizado. No se movió nada y se actualiza solo.`,
    unreachableHint: () => 'Abre Ajustes ▸ Avanzado.',
  },

  ethWallet: {
    receiptReverted: hash => `la transacción ${hash} se revirtió en la cadena`,
    receiptTimeout: hash => `la transacción ${hash} no se minó dentro del tiempo de espera`,
    hashMissing: received =>
      `La billetera respondió sin identificador de transacción (${received}): no se sabe si se envió.`,
    sendTimedOut: 'La billetera no respondió: no se sabe si la transacción se envió.',
    requestTimedOut: 'La billetera no respondió. Ábrela, atiende cualquier solicitud pendiente y reintenta.',
    pairingTimedOut: 'se agotó el tiempo de vinculación: ninguna billetera escaneó el código en 5 min',
    pairingFailed: detail => `Falló la vinculación con WalletConnect: ${detail}`,
    invalidChainId: value =>
      `La billetera informó una red que dpay no puede leer (${value}). Reconecta; si sigue pasando, usa otra app de billetera.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `La billetera no autorizó ninguna red de Ethereum; este depósito se liquida en la red ${requested}. Cambia a ella y vuelve a conectar.`
        : `La billetera autorizó la red ${approved}; este depósito se liquida en la red ${requested}. Cambia y vuelve a conectar.`,
  },

  engine: {
    offline: 'Pareces estar sin conexión, así que el motor de pagos no cargó. Tu dinero está intacto. Vuelve a abrir esta pantalla cuando vuelvas a estar en línea.',
    unreachable: 'Tu conexión está bien, pero el motor de pagos de dpay no cargó. Tu dinero está intacto. Vuelve a abrir esta pantalla e inténtalo de nuevo en un momento.',
  },

  tap: {
    couldntConfirmOffline: 'No se pudo confirmar: revisa tu saldo cuando tengas conexión',
    couldntVerifyRequest: 'No se pudo verificar esta solicitud',
    couldntReturnResult: 'No se pudo devolver el resultado. Mantén los teléfonos juntos y reintenta.',
    merchantRefusalUnverified:
      'Según el libro mayor, la transferencia no se realizó, pero este teléfono no pudo verificarlo. No entregues la mercancía. Revisa en un momento tus transacciones: el dinero aparecerá ahí si llegó.',
    merchantNothingArrived:
      'No se recibió ningún pago. No entregues la mercancía: una transferencia todavía puede llegar y aparecerá en tu saldo. Pide otro acercamiento solo si no aparece nada.',
    unsupportedAsset: currency => `Activo no admitido (moneda ${currency})`,
    cannotConfirmAsset: currency => `No se puede confirmar el activo (moneda ${currency})`,
    couldntReadRequest: 'No se pudo leer la solicitud de pago',
    requestExpired: 'Esta solicitud caducó: pide una nueva',
    couldntAuthorize: 'No se pudo autorizar el pago: inténtalo de nuevo',
    noOpenRequest: 'No hay ninguna solicitud abierta',
    paymentRejected: 'Pago rechazado',
    couldntConfirm: 'No se pudo confirmar',
    couldntConfirmCheckBalance: 'No se pudo confirmar: revisa tu saldo',
    settlementNotVerified: 'Confirmado, pero no es esta solicitud: comprueba la firma antes de entregar',
    paymentRequestExpired: 'Esta solicitud de pago caducó',
  },
};
