/**
 * i18n/domains/es/convert.ts — valores en español para la superficie de conversión delegada.
 * Tipos, documentación de claves y copia de referencia: ../en/convert.ts. Glosario: ../../es.ts.
 * Glosario: «venue» → sede; «quote» → cotización. El nombre de la sede llega como argumento
 * (nombre de presentación del registro de venues, nunca codificado aquí). Los importes y
 * principals llegan ya formateados como cadenas de presentación.
 */
import type {ConvertMessages} from '../../keys';

export const convertEs: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Volver al monedero',

  unavailableTitle: sym => `Convertir aún no está disponible para ${sym}`,
  unavailableBody: (pair, venue) => `Hoy dpay convierte ${pair} a través de ${venue} — y nada más.`,

  amountLabel: sym => `Importe (${sym})`,
  balanceLine: balance => `Saldo: ${balance}`,
  receiveHeadline: 'Recibirás',
  counterparty: venue => `Ejecutado por el pool de ${venue}.`,
  counterpartySigns: 'Tu teléfono firma; el pool retira exactamente el importe aprobado.',
  quoteSource: (at, venue) => `Cotización de ${venue}, obtenida ${at}`,
  rateLabel: (inSym, outSym) => `Tipo de esta cotización (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Comisión del pool: ${tier} (nivel de ${venue})`,
  inputFeeLine: fee => `Comisión de entrada: ${fee}`,
  outputFeeLine: fee => `Comisión de salida: ${fee}`,
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (la clave del registro para los pools de ICPSwap): el hecho
      // propio de la venue es DÓNDE se ejecuta el intercambio — su propio contrato de pool.
      icpswap: venue => `El intercambio se ejecuta en el contrato de pool propio de ${venue}.`,
      // disclosure_key 'jupiter' (la clave del registro para la fila de la venue Solana): los
      // hechos propios de la venue son QUÉ es Jupiter — un agregador on-chain autónomo — y que
      // la cotización es la suya, mostrada tal como la publica, mientras dpay queda fuera del
      // intercambio por completo. Tono espejo de icpswap: atribuir, nombrar al firmante, negar la parte.
      jupiter: venue =>
        `${venue} es un agregador on-chain autónomo en Solana — elige la ruta y la ruta la ejecuta. Este monedero firma la transacción que construye ${venue}, y la cotización es la propia de ${venue}, mostrada exactamente como la publica. dpay no es parte de ello.`,
      // disclosure_key 'sideshift' (la clave de la primera venue CeFi, 2026-09-15): los hechos
      // CeFi fijados por el founder — un servicio de intercambio automatizado que retiene
      // fondos durante el intercambio, no un proveedor con licencia; el KYC según SU política
      // es SUYO que divulgar (se nombran sus propios términos publicados); dpay no es parte y
      // no cobra nada (el relay fija commissionRate «0»).
      sideshift: venue =>
        `${venue} es un servicio de intercambio automatizado — no un proveedor con licencia ni un banco. Retiene tus fondos durante el intercambio y luego paga a tu propia dirección; sus términos, incluidas las verificaciones de identidad según su política, están publicados en sideshift.ai/terms. Este monedero te muestra la cotización propia de ${venue} y la dirección de depósito, y dpay no firma nada. dpay no es parte del intercambio y no cobra nada.`,
    },
    generic: venue => `Esta conversión la ejecuta ${venue}.`,
  },
  slippageLabel: 'Deslizamiento',
  minReceiveLine: (amount, pct) => `Mínimo que recibirás: ${amount} (${pct} de deslizamiento)`,
  refusalLine: sym =>
    `Si el precio del pool pasa de tu mínimo, el intercambio falla: tu ${sym} se queda en tu monedero y la autorización caduca sin usarse.`,
  detailsLabel: 'Detalles',
  confirmButton: 'Recotizar y confirmar',
  staleRefreshing: 'Cotización caducada — actualizando…',
  quoteChanged: (oldAmt, newAmt) => `La cotización cambió: ${oldAmt} → ${newAmt}. Revisa y confirma de nuevo.`,
  venueChooserLabel: 'Sede',
  venueNoneSelected: 'Elige una sede para ver su cotización completa y continuar.',

  sol: {
    heading: (inSym, outSym) => `Convertir ${inSym} en ${outSym} (Solana)`,
    unavailableTitle: sym => `${sym} aún no se puede convertir`,
    unavailableBody: (sym, venue) =>
      `Las conversiones de activos Solana pasan por una venue Solana registrada (hoy ${venue}). Ninguna venue atiende ${sym} por ahora — no se ofreció nada, nada se movió.`,
    counterparty: venue => `Ejecutado por ${venue}.`,
    counterpartySigns: 'Tu teléfono firma la transacción que construyó la venue — nadie más firma nada.',
    priceImpactLine: (pct, venue) => `Impacto en el precio: ${pct} (cifra propia de ${venue})`,
    platformFeeLine: (pct, venue) => `Comisión de integrador de ${venue}: ${pct}`,
    solFeeLine: fee => `Comisión de red de Solana: ${fee} (pagada a la red, no a la venue, no a dpay)`,
    refusalLine: sym =>
      `Si el precio pasa del mínimo, la transacción falla on-chain: tu ${sym} se queda en tu monedero y no se firmó nada más.`,
    pendingBody:
      'La transacción de intercambio está en la red de Solana. Esta pantalla observa la propia cadena y se resuelve sola — sin recargar, sin reintentar.',
    failedBody: (sym, venue, detail) =>
      `La transacción de intercambio de ${venue} falló${detail ? ` (${detail})` : ''}. En Solana una transacción fallida nunca mueve fondos — tu ${sym} sigue donde estaba.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Este monedero no tiene ${sym}. Para convertir ${sym}, recibe primero ${sym} en tu dirección: abre «${receiveTab}» abajo y elige «${myAddress}».`,
  fundOtherHolds: (held, toSym) => `Tienes ${held}: puedes convertir eso a ${toSym} en su lugar.`,
  fundOtherSwitch: sym => `Convertir desde ${sym} en su lugar`,
  insufficientLine: (needed, balance) =>
    `Convertir esto necesita ${needed} — el importe más dos comisiones de ledger — y este monedero tiene ${balance}. Baja el importe, o recibe más primero.`,

  approvingTitle: 'Autorizando',
  approvingBody: (amount, at) =>
    `Tu teléfono autoriza al pool a retirar exactamente ${amount}. La autorización caduca a las ${at} si no se usa.`,
  swappingTitle: 'Intercambiando',
  swappingBody: venue => `Enviando el intercambio al pool de ${venue}. Solo puede retirar el importe aprobado.`,
  settlingTitle: 'Liquidando',
  settlingBody: sym => `El pool aceptó el intercambio. Esperando que tu ${sym} aparezca en tu monedero…`,
  doneTitle: 'Convertido ✓',
  doneBody: amount => `${amount} recibidos en tu monedero.`,
  doneTx: tx => `Registro del pago: ${tx}`,
  pendingTitle: 'Pago pendiente',
  pendingBody: (sym, pool, at) =>
    `El pool aceptó el intercambio, pero el pago en ${sym} aún no llegó a tu monedero. Esta pantalla sigue vigilando — no tienes que hacer nada ahora. Si nunca llega, indica esto al soporte: pool ${pool}, intercambio enviado a las ${at}.`,
  stillWatching: 'Siguiendo esperando el pago…',
  failedTitle: 'Intercambio no ejecutado',
  failedApproveBody: sym =>
    `El ledger de ${sym} rechazó la autorización, así que no se movió nada — sigues teniendo cada unidad de tu ${sym}. No se creó ninguna autorización; no hay nada que reembolsar ni revertir.`,
  failedSwapBody: (reason, sym, venue) =>
    `El pool de ${venue} rechazó el intercambio (${reason}). Tu ${sym} nunca salió de tu monedero — no hace falta nada más.`,
  refundedBody: sym =>
    `El intercambio falló y el pool te devolvió tu ${sym} — tu saldo vuelve a estar completo.`,
  stuckTitle: 'Desenlace desconocido',
  stuckBody:
    'El intercambio se envió, pero la respuesta del pool no llegó. No inicies un segundo intercambio con los mismos fondos. Si el pago llega, esta pantalla pasará a «Convertido» por sí sola.',
  stuckSigned: (amount, minAmount, venue) =>
    `Lo firmado: autorizar ${amount} al pool de ${venue}; intercambiar por un mínimo de ${minAmount}.`,
  expiryLine: at => `La autorización sin usar caduca a más tardar a las ${at} — después, el pool no puede retirar nada.`,

  awaitingAuthTitle: 'Falta tu autorización',
  awaitingAuthBody: venue =>
    `Esta orden está abierta en ${venue} y espera tu autorización. Nada se ha movido y nada se moverá hasta que la apruebes — dpay vigila mientras tanto el estado del proveedor.`,
  awaitingDepositTitle: 'Esperando el depósito',
  awaitingDepositBody: (sym, venue) =>
    `${venue} emitió esta orden y espera su depósito en ${sym}. El intercambio se ejecuta cuando el proveedor ve el depósito; dpay sigue vigilando su estado. Si no llega ningún depósito a tiempo, la cotización caduca y nada se mueve.`,
  providerProcessingTitle: 'Procesando en el proveedor',
  providerProcessingBody: (sym, venue) =>
    `${venue} retiene el depósito y está ejecutando la orden. Tu ${sym} llega cuando el proveedor la complete — dpay sigue vigilando hasta que se resuelva.`,
  quoteExpiredTitle: 'Cotización caducada',
  quoteExpiredBody: (sym, venue) =>
    `La cotización murió antes de que se moviera algún valor: ${venue} nunca recibió el depósito, así que no se intercambió nada y no hay nada que revertir. Tu ${sym} se quedó donde estaba — inicia una nueva conversión si aún quieres una.`,
  providerRefundedTitle: 'Reembolsado por el proveedor',
  providerRefundedBody: (sym, venue) =>
    `${venue} canceló esta orden y devolvió el depósito. Vigila la llegada de tu ${sym}.`,
  stuckWatching: 'dpay sigue vigilando esto en segundo plano. Si llega el pago o el reembolso, esta pantalla cambia sola.',
  stuckAcknowledge: 'Entendido — dejar de vigilar',
  stuckAcknowledged: 'Has tomado nota y la vigilancia en segundo plano se ha detenido. Si los fondos se mueven más tarde, seguirán llegando a la dirección de esta cartera.',

  multihop: {
    destLabel: 'Destino',
    destDirect: sym => `${sym} — en esta cartera (canje directo)`,
    destRoute: (sym, network) => `${sym} en ${network} — ruta de canje y retiro`,
    destInWallet: sym => `${sym} — en esta cartera`,
    mechDirect: 'Pool directo',
    mechViaHub: hubSym => `Vía ${hubSym}`,
    mechViaCctp: 'Vía Circle CCTP',
    mechViaVenue: venue => `Vía ${venue}`,
    mechNoneSelected: 'Elige un mecanismo arriba para ver la cotización.',
    viaHub: hubSym => `vía ${hubSym} · 2 canjes`,
    routeMinWalletLine: (amount, pct) => `Al menos ${amount} se quedan en esta cartera (piso de deslizamiento ${pct})`,
    hubQuoteSource: (venue1, venue2, at) => `Cotizaciones de ${venue1} y ${venue2}, obtenidas ${at}`,
    hubCensusHeading: 'Dos canjes, desglosados uno por uno',
    approveFeeLine: amount => `Aprobar el siguiente pool cuesta ${amount} (la propia tarifa de transferencia del ledger)`,
    hubRateLine: (inSym, destSym) => `Tasa combinada ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Si un canje paga por encima de su piso, el excedente se queda en esta cartera como ${hubSym} o ${destSym}.`,
    destAddressLabel: 'Tu propia dirección en la red de destino',
    destAddressInvalid: 'Dirección de destino no válida — se espera 0x seguido de 40 caracteres hexadecimales.',
    routeHeading: (inSym, hopSym, destSym, network) => `Ruta: ${inSym} → ${hopSym} → ${destSym} en ${network}`,
    swapPaysLabel: 'El canje paga dentro de esta cartera',
    legApprovePull: sym => `Autorizar al pool a tomar tus ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Canjear ${inSym} → ${hopSym} en ${venue}`,
    legApproveBurn: sym => `Autorizar la quema de ${sym} (el monto del retiro)`,
    legApproveGas: sym => `Autorizar ${sym} para pagar el gas del retiro`,
    legWithdraw: (hopSym, destSym, network) => `Quemar ${hopSym} — ${destSym} llega en ${network}`,
    legStatePending: 'En espera',
    legStateSent: 'Enviado',
    legStateConfirmed: 'Confirmado',
    legStateFailed: 'Rechazado',
    legProgress: (n, total) => `Paso ${n} de ${total}`,
    gasFeeLine: amount => `Gas del retiro (cotización en vivo del minter): ${amount}`,
    routeMinLine: (amount, pct) => `Al menos ${amount} en tu dirección (piso de deslizamiento ${pct})`,
    routeSurplusNote: hopSym => `Si el canje paga por encima del piso, el excedente queda en esta cartera como ${hopSym}.`,
    gasPreflightTitle: 'El retiro necesita gas primero',
    gasPreflightBody: needed =>
      `Quemar hacia Ethereum cuesta un gas pagado en ckETH, y esta cartera no tiene suficiente. Se necesita aproximadamente ${needed} (la cotización de gas en vivo del minter más su comisión de autorización). Consigue ckETH en esta cartera primero y vuelve — comprar una porción de gas aquí es trabajo futuro, y dpay no te esconderá este costo.`,
    executingTitle: 'Ejecutando la ruta',
    doneRouteTitle: 'Retiro en camino',
    doneRouteBody: (amount, address) => `Al menos ${amount} va en camino a ${address}.`,
    doneOnItsWay: 'La entrega ocurre en Ethereum y puede tardar — dpay no puede vigilar esa red. No necesitas hacer nada más.',
    failedLegTitle: 'El tramo del retiro fue rechazado',
    failedLegBody: (sym, reason) =>
      `El canje se completó — tus fondos están en ${sym} en esta cartera, nada perdido ni bloqueado. El retiro fue rechazado${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Para retirar, abre Pagar, elige Enviar a dirección y pega cualquier dirección de destino — el paso de retiro corre desde ahí.',
    stuckRouteBody: 'Se envió un tramo pero su resultado aún se desconoce. dpay sigue vigilando los libros en segundo plano; esta pantalla cambiará sola cuando la ruta se resuelva.',
    failedHop2Title: 'El segundo canje fue rechazado',
    failedHop2Body: (hubSym, outSym, reason) =>
      `El primer canje pasó — tienes ${hubSym} en esta cartera, nada perdido y nada atascado. El canje ${hubSym} → ${outSym} fue rechazado${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Tus ${hubSym} se pueden gastar tal cual: consérvalos, cámbialos más tarde desde su propia cuenta, o envíalos. Nada necesita revertirse.`,
    stuckHoldsLine: hubSym => `Logrado hasta ahora: tienes ${hubSym} en esta cartera.`,
    insufficientHubLine: (needed, balance) =>
      `Esta conversión necesita ${needed} — el monto más tres comisiones de registro — y esta cartera tiene ${balance}. Baja el monto o recibe más primero.`,
  },

  /** Venues CeFi (ampliación SideShift, 2026-09-15): la entrega del depósito. La venue
   *  retiene los fondos durante el intercambio; el depósito propio del usuario ES el
   *  movimiento de valor — dpay no firma nada. Cada dirección/cantidad mostrada es la
   *  propia de la venue, sin cambios. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} en ${network} — vía ${venue} (servicio de intercambio)`,
    settleAddressLabel: 'El pago llega a tu propia dirección en la red de destino',
    depositAddressLabel: 'Dirección de depósito',
    depositAmountLabel: 'Cantidad exacta a depositar',
    depositMemoLabel: 'Memo (obligatorio)',
    depositExpiryLine: at => `La orden caduca ${at}`,
    counterparty: venue =>
      `Ejecutado por ${venue}: un servicio de intercambio automatizado, no un proveedor con licencia y no dpay.`,
    checklistSigns:
      'No se firma nada en este teléfono: tras confirmar, tú mismo envías el depósito a la dirección del servicio.',
    refusalLine: sym =>
      `Si el depósito no llega, la orden caduca: no se mueve nada y tu ${sym} sigue en tu monedero.`,
    insufficientLine: (needed, balance) =>
      `Este depósito necesita ${needed} — el importe más una comisión de transferencia — y este monedero tiene ${balance}. Baja el importe o recibe más primero.`,
    payoutAt: address => `Pagado a tu propia dirección: ${address}`,
    depositNote: (venue, sym) =>
      `Envía ${sym} desde tu monedero a la dirección de depósito de ${venue} arriba — exactamente la cantidad indicada. ${venue} es un servicio de intercambio automatizado: retiene tu ${sym} durante el intercambio y luego paga a tu dirección. dpay no es parte de este intercambio y no cobra nada.`,
    stillWaitingDeposit: 'Siguiendo con la espera de tu depósito — esta página se actualiza sola.',
  },

  /** La familia cross-rail (rutas B/C, 2026-09-16): todo lo que sigue a las cinco piernas IC —
   *  el handoff CCTP (dpay muestra las transacciones exactas, las firma la cartera Ethereum
   *  PROPIA del usuario; dpay nunca retiene claves EVM), la espera de la atestación de Circle
   *  y la oferta final de Júpiter en la ruta C. Cada callejón sin salida dice dónde están
   *  los fondos y cuál es la salida. */
  crossrail: {
    heading: 'Firmar en tu cartera Ethereum',
    handoffIntro: (amount) =>
      `La parte de Internet Computer está hecha: ${amount} está en tu dirección Ethereum. Tu cartera ahora lo envía al otro lado — dpay jamás toca tus claves Ethereum.`,
    stepApproveLabel: 'Paso 1 — permitir que el contrato de Circle mueva los USDC',
    stepBurnLabel: 'Paso 2 — quemar los USDC para el transfer a Solana',
    txToLabel: 'Para',
    txAmountLabel: 'Importe',
    txCalldataLabel: 'Datos de la transacción',
    copy: 'Copiar',
    copied: 'Copiado',
    approveHint: 'Permite que el TokenMessenger de Circle mueva exactamente los USDC enviados — nada más.',
    burnHint: 'Esto bloquea los USDC en Ethereum. El puente de Circle acuña los mismos USDC en tu dirección Solana — no es un token envuelto; Circle ejecuta la llegada por ti.',
    timingNote: 'Por la vía rápida la llegada suele tardar de segundos a pocos minutos (en nuestra prueba real ~20 s). Si Ethereum está congestionado puede tardar más — esta pantalla se actualiza sola.',
    externalGasLine: 'El gas Ethereum de estas dos transacciones lo paga el ETH de tu propia cartera. dpay no puede pagarlo ni cotizarlo con exactitud.',
    circleFeeLine: fee => `Comisión del puente de Circle (su propia cifra, descontada del importe): como máximo ${fee}`,
    mintFloorLine: floor => `Llegan como mínimo ${floor} a tu dirección Solana`,
    burnTxLabel: 'Hash de la transacción de burn',
    burnTxPlaceholder: '0x… (de tu cartera, tras firmar)',
    attachButton: 'Ya lo firmé — vigilar el cruce',
    burnTxInvalid: 'Eso no parece un hash de transacción Ethereum.',
    declineButton: 'No voy a firmar esto',
    whatSigning: 'Firmas dos transacciones Ethereum completamente normales en tu propia cartera: una aprobación y luego el burn. En el lado de dpay no se firma nada en este paso.',
    crossingTitle: 'Cruzando a Solana',
    crossingBody: 'Circle atestigua el burn y acuña los USDC en tu dirección Solana. dpay vigila el propio feed de estado de Circle — esta pantalla cambiará sola.',
    viewBurnTx: 'Ver la transacción de burn',
    viewCircle: 'Página de estado de Circle',
    stillCrossing: 'La atestación todavía no está lista. Esto queda pendiente — no es un fallo. Por la vía rápida son segundos o minutos; con Ethereum congestionado, más.',
    solReadyTitle: 'Los USDC ya están en Solana',
    solReadyBody: (credit, ata) => `${credit} están en ${ata}, verificado on-chain. Termina la ruta — o deja ahí los USDC; son tuyos en cualquier caso.`,
    solQuoteLabel: venue => `Cotización de ${venue} (reciente)`,
    solMinLine: min => `Como mínimo ${min} SOL a tu dirección`,
    solConfirmButton: 'Cambiar a SOL',
    solFeeLine: fee => `Comisión de la transacción Solana: ${fee}`,
    solPreflightTitle: 'Hace falta algo de SOL para la comisión',
    solPreflightBody:
      'La comisión de red del cambio se paga en SOL y esta cartera no tiene SOL. Consigue primero algo de SOL en esta cartera — los USDC quedan seguros mientras tanto.',
    doneTitle: 'Convertido',
    doneBody: (amount, sym, address) => `${amount} ${sym} están en tu dirección Solana ${address} — verificado on-chain.`,
    declinedTitle: 'Handoff cancelado',
    declinedBody: address =>
      `No cruzó nada. Tus USDC están en tu propia dirección Ethereum ${address} — envíalos donde quieras desde tu cartera o repite esta ruta más tarde.`,
    solFailedTitle: 'El cambio en Solana no salió',
    solFailedBody: (ata, venue) =>
      `Los USDC ya cruzaron sin problema y están en tu dirección Solana ${ata}. ${venue} rechazó el cambio final — reinténtalo aquí en un momento o quédate con los USDC.`,
    legCctpBurn: (sym, network) => `Llevar ${sym} a ${network} vía Circle (esto lo firmas en tu cartera)`,
    legSolSwap: (venue, sym) => `Cambiar a ${sym} en ${venue}`,
    destAddressCrossNote: 'Esta dirección Ethereum es también la cartera que firma el cruce — pega una dirección que controles.',
  },

  errors: {
    quoteUnreachable: venue => `No se pudo alcanzar la cotización de ${venue} — el relay no responde. Revisa tu conexión y vuelve a intentarlo.`,
    quoteRefused: venue => `${venue} se negó a cotizar este par ahora mismo.`,
    quoteUnavailable: code => `Cotización no disponible (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} aún no está configurado en este relay — no hay ninguna credencial de socio configurada, así que no se puede pedir una cotización. Tu monedero no tiene ningún problema.`,
    gasUnavailable: 'No se pudo consultar el precio del gas al minter de retiro — no se firmó nada. Inténtalo de nuevo.',
    cctpFeeUnavailable: 'No se pudo consultar la comisión del puente de Circle — no se firmó nada. Revisa tu conexión y vuelve a intentarlo.',
  },
};
