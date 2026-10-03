/**
 * i18n/domains/es/convert.ts — valores en español para la superficie de conversión delegada.
 * Tipos, documentación de claves y copia de referencia: ../en/convert.ts. Glosario: ../../es.ts.
 * Glosario: «venue» → sede; «quote» → cotización. El nombre de la sede llega como argumento
 * (nombre de presentación del registro de venues, nunca codificado aquí). Los importes y
 * principals llegan ya formateados como cadenas de presentación. Segunda pasada de concisión
 * (2026-09-29): fragmentos en vez de frases donde el sentido lo permite.
 */
import type {ConvertMessages} from '../../keys';

export const convertEs: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Volver a la billetera',


  amountLabel: sym => `${sym}`,
  maxAmount: 'Max',
  balanceLine: balance => `Saldo ${balance}`,
  counterparty: venue => `Ejecutado por el pool de ${venue}.`,
  counterpartySigns: 'Tu teléfono firma; el pool retira exactamente el importe aprobado.',
  quoteSource: (at, venue) => `${venue} · ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} cotizó exactamente ${amt}`,
  rateLabel: (inSym, outSym) => `Tipo (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Comisión del pool: ${tier} (nivel de ${venue})`,
  inputFeeLine: fee => `Comisión de entrada: ${fee}`,
  outputFeeLine: fee => `Comisión de salida: ${fee}`,
  disclosures: {
    byKey: {
      icpswap: venue => `Se ejecuta en el contrato de pool propio de ${venue}.`,
      jupiter: venue =>
        `${venue} es un agregador on-chain autónomo en Solana — elige la ruta; la ruta la ejecuta. Esta billetera firma la transacción que construye ${venue}, y la cotización es la propia de ${venue}, tal cual. dpay no es parte.`,
      sideshift: venue =>
        `${venue} es un servicio de intercambio automatizado — ni un proveedor con licencia ni un banco. Retiene tus fondos durante el intercambio y luego paga a tu propia dirección; sus términos, incluidas las verificaciones de identidad según su política, están en sideshift.ai/terms. Esta billetera muestra la cotización propia de ${venue} y la dirección de depósito — dpay no firma nada, no es parte y no cobra nada.`,
      trocador: venue =>
        `${venue} es un agregador de intercambio automatizado — dirige tu intercambio a uno de sus propios servicios y retiene tus fondos durante el intercambio, luego paga a tu propia dirección; sus términos, incluidas las verificaciones de identidad que un servicio pueda aplicar, están en trocador.app/terms. dpay pide a ${venue} solo servicios sin verificación de identidad. Esta billetera muestra la cotización propia de ${venue} y la dirección de depósito — dpay no firma nada, no es parte y no cobra nada.`,
      cowswap: venue =>
        `${venue} ejecuta órdenes firmadas fuera de la cadena con solvers competidores, normalmente en segundos a minutos. La revisión muestra la comisión propia de ${venue}. dpay firma su orden, no es parte y no recibe nada.`,
    },
    generic: venue => `Ejecutado por ${venue}.`,
  },
  slippageLabel: 'Deslizamiento',
  refusalLine: sym =>
    `Pasado tu mínimo el intercambio falla — tu ${sym} se queda en tu billetera y la autorización caduca sin usarse.`,
  detailsLabel: 'Detalles',
  staleRefreshing: 'Cotización caducada — actualizando…',
  venueSlow: 'Recientemente lento para liquidar.',
  sheetTitle: inSym => `Convertir ${inSym}`,
  youReceive: amt => `Recibirás ≈ ${amt}`,
  quoteFetching: venue => `Cotización de ${venue}…`,
  autoVenueLine: (venue, at, n) => `${venue} · ${at} · ${n} sedes`,
  otherVenues: n => `Otras sedes (${n})`,
  atLeast: amt => `Mín. ${amt}`,
  ctaConvert: amt => `Convertir ${amt}`,
  rateMoved: (oldAmt, newAmt) => `La cotización cambió: ${oldAmt} → ${newAmt}. Confirma de nuevo.`,
  neededVsHave: (need, have) => `Se necesitan ${need}, tienes ${have}`,
  smallerAmount: 'Convierte un importe menor',
  noPathTitle: inSym => `Sin ruta desde ${inSym}`,
  noPathBody: pairs => `Rutas hoy: ${pairs}`,
  noVenueBody: (inSym, outSym) => `Todavía no hay un sitio que convierta ${inSym} a ${outSym}. El par sigue listado aquí; los nuevos sitios aparecen cuando se agregan.`,
  noPathAction: 'Añadir dinero',
  externalSignTitle: 'Un paso necesita tu propia billetera Ethereum',
  externalSignBody: 'Firmas el cruce en tu propia billetera; dpay nunca tiene sus claves. Todo lo demás queda en esta hoja.',
  signing: 'Firmando…',
  swapVia: venue => `Intercambiando vía ${venue}`,
  awaitingPool: 'Esperando el pago del pool',
  receivedDone: amt => `Recibiste ${amt}`,
  viaChain: venue => `vía ${venue}`,
  depositLegSent: (venue, amt) => `Depósito de ${amt} enviado a ${venue}`,
  depositLegPending: (venue, amt) => `Enviando ${amt} a ${venue}`,
  composedOrderLine: (venue, amt) => `Orden en ${venue}, pago bloqueado ${amt}`,
  depositRefusedBody: (hopSym, venue) =>
    `El depósito a ${venue} fue rechazado — el intercambio sí se ejecutó y tu ${hopSym} sigue en esta billetera. No se firmará nada más: convierte o envía el ${hopSym} desde su propia cuenta.`,

  sol: {
    heading: (inSym, outSym) => `Convertir ${inSym} en ${outSym} (Solana)`,
    counterparty: venue => `Ejecutado por ${venue}.`,
    counterpartySigns: 'Tu teléfono firma la transacción de la sede — nadie más firma nada.',
    priceImpactLine: (pct, venue) => `Impacto en el precio: ${pct} (cifra propia de ${venue})`,
    solFeeLine: fee => `Comisión de red de Solana: ${fee} (a la red, no a la sede, no a dpay)`,
    refusalLine: sym =>
      `Pasado el mínimo el intercambio falla entero on-chain — tu ${sym} se queda en tu billetera.`,
    pendingBody: 'El intercambio está en Solana — esta pantalla se resuelve sola.',
    failedBody: (sym, venue, detail) =>
      `El intercambio de ${venue} falló${detail ? ` (${detail})` : ''} — en Solana no se movió nada; tu ${sym} sigue donde estaba.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Sin ${sym} aquí. Para convertir, recibe antes ${sym}: abre «${receiveTab}» abajo y elige «${myAddress}».`,
  fundOtherHolds: (held, toSym) => `Tienes ${held} — convierte eso a ${toSym} en su lugar.`,
  fundOtherSwitch: sym => `Convertir desde ${sym} en su lugar`,
  insufficientLine: (needed, balance) => `Se necesitan ${needed}, tienes ${balance}`,

  approvingTitle: 'Autorizando',
  approvingBody: (amount, at) =>
    `Autorizando al pool a retirar exactamente ${amount}. Sin usar, caduca a las ${at}.`,
  swappingTitle: 'Intercambiando',
  swappingBody: venue => `Enviando al pool de ${venue} — solo puede retirar el importe aprobado.`,
  settlingTitle: 'Liquidando',
  settlingBody: sym => `El pool aceptó — esperando tu ${sym}…`,
  doneTitle: 'Convertido ✓',
  doneBody: amount => `${amount} recibidos en tu billetera.`,
  doneTx: tx => `Registro del pago: ${tx}`,
  pendingTitle: 'Pago pendiente',
  pendingBody: (sym, pool, at) =>
    `Intercambio aceptado — el pago en ${sym} aún no llega. Si nunca llega, indica esto al soporte: pool ${pool}, enviado a las ${at}.`,
  stillWatching: 'Todavía esperando el pago…',
  failedTitle: 'Intercambio no ejecutado',
  failedApproveBody: sym =>
    `El ledger de ${sym} rechazó la autorización — nada se movió, nada que deshacer.`,
  failedSwapBody: (reason, sym, venue) =>
    `El pool de ${venue} rechazó el intercambio (${reason}) — tu ${sym} nunca salió de tu billetera.`,
  refundedBody: sym =>
    `El intercambio falló — el pool devolvió tu ${sym}. Saldo completo de nuevo.`,
  stuckTitle: 'Desenlace desconocido',
  chainStuckTitle: 'Resultado del depósito sin confirmar',
  chainStuckBody: venue =>
    `El depósito para ${venue} fue enviado pero nunca confirmado. Se confirma solo o caduca — nunca lo envíes una segunda vez.`,
  stop: 'Detener',
  stopWatching: 'Dejar de vigilar',
  stopProvider: 'Dejar de vigilar',
  abortedTitle: 'Detenido',
  abortedClean: 'Nada salió de tu billetera.',
  abortedFee: 'Pagaste una pequeña comisión de aprobación.',
  abortedWatching: 'El intercambio puede completarse igual. Revisa Saldos más tarde.',
  abortedProvider:
    'Vigilancia detenida. Sin depósito enviado nada puede moverse; ya enviado → el intercambio aún puede completarse. Revisa Saldos y la página de estado del proveedor — el ID de shift está debajo.',
  stuckBody:
    'Intercambio enviado — la respuesta del pool nunca llegó. No inicies un segundo intercambio.',
  stuckSigned: (amount, minAmount, venue) =>
    `Firmado: autorizar ${amount} al pool de ${venue}, intercambiar por un mínimo de ${minAmount}.`,
  expiryLine: at => `Caduca a más tardar a las ${at} — después nada puede moverse.`,

  awaitingDepositTitle: 'Esperando el depósito',
  awaitingDepositBody: (sym, venue) =>
    `${venue} espera su depósito en ${sym}; el intercambio empieza cuando llega. Si no llega a tiempo, la cotización caduca y nada se mueve.`,
  providerProcessingTitle: 'Procesando en la sede',
  providerProcessingBody: (sym, venue) =>
    `${venue} retiene el depósito y ejecuta la orden. Tu ${sym} llega cuando la complete.`,
  quoteExpiredTitle: 'Cotización caducada',
  quoteExpiredBody: (sym, venue) =>
    `La cotización caducó antes de que llegara el depósito: ${venue} dejó de esperar, no se intercambió nada. Un depósito tardío — el proveedor lo devuelve; dpay sigue vigilando en segundo plano y esta pantalla se actualiza sola. Tu ${sym} se queda donde está.`,
  providerRefundedTitle: 'Reembolsado por la sede',
  providerRefundedBody: (sym, venue) =>
    `${venue} canceló la orden y devolvió tu ${sym}. Vigílalo en Saldos.`,
  stuckWatching: 'dpay sigue vigilando — si los fondos se mueven, esta pantalla cambia sola.',
  stuckAcknowledge: 'Entendido — dejar de vigilar',
  stuckAcknowledged: 'Vigilancia detenida — los fondos que se muevan más tarde seguirán llegando a la dirección de esta billetera.',

  stuckReceiptsTitle: 'Qué pasó',
  stuckErrorLine: d => `Error: ${d}`,
  stuckExpiredLine: at => `Venció a las ${at} - ya nada puede moverse.`,
  stuckExpiredBody:
    'El intercambio firmado ya no puede ejecutarse. dpay lo cierra con la evidencia de arriba: el dinero que sigue en esta billetera se queda; el que se movió se ve en tu saldo.',
  stuckLastCheckedLine: at => `Última comprobación ${at}`,
  failedWindowClosedBody: sym =>
    `El intercambio no pudo confirmarse antes de que cerrara su ventana - tu ${sym} nunca salió de tu billetera.`,

  evm: {
    heading: (inSym, outSym, chain) => `Convertir ${inSym} a ${outSym} (${chain})`,
    feeLabel: unit => `Tarifa de red (${unit}, estimación)`,
    pendingBody: 'El intercambio está confirmado en la cadena. Espere a que su saldo lo muestre.',
    failedBody: (inSym, detail) => String(detail).includes('approve landed')
      ? `El intercambio falló tras la aprobación. Su ${inSym} sigue en su cartera; la aprobación sin usar cubre solo el monto exacto del intercambio.`
      : `No se envió nada. Su ${inSym} sigue en su cartera.`,
    stuckBody: outSym => `El intercambio puede haber llegado o no. Su saldo de ${outSym} se resolverá solo; no inicie un segundo intercambio.`,
  },
  cow: {
    feeLine: fee => `Comisión de CoW (estimada): ${fee}`,
    protocolFeeLine: bps => `más la comisión de volumen del sitio (${bps} pbs)`,
    settlingBody: 'La orden está con los solvers de CoW - se completa en segundos a minutos. Esta pantalla se resuelve sola; no inicie un segundo intercambio.',
    failedBody: (inSym, detail) => `La orden no se ejecutó (${detail}). Nada salió de su cartera - su ${inSym} sigue ahí; solo queda la aprobación exacta, que expira sin usarse.`,
  },
  multihop: {
    destLabel: 'Destino',
    destDirect: sym => `${sym} — en esta billetera`,
    destRoute: (sym, network) => `${sym} — a tu dirección de ${network}`,
    destRouteSol: (sym, network, venue) => `${sym} — a tu dirección de ${network} · último paso vía ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Ruta: ${inSym} → ${hopSym} (hacia ${network})`,
    destAddressLabel: 'Tu propia dirección en la red de destino',
    destAddressInvalid: 'Dirección no válida — se espera 0x seguido de 40 caracteres hexadecimales.',
    destPayoutNote: 'Los fondos llegan a tu propia dirección de wallet.',
    destChange: 'Cambiar destino',
    routeHeading: (inSym, hopSym, destSym, network) => `Ruta: ${inSym} → ${hopSym} → ${destSym} en ${network}`,
    swapPaysLabel: 'El intercambio paga a esta billetera',
    legApprovePull: sym => `Autorizar al pool a tomar tus ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Intercambiar ${inSym} → ${hopSym} en ${venue}`,
    legApproveBurn: sym => `Autorizar la quema de ${sym} (el monto del retiro)`,
    legApproveGas: sym => `Autorizar ${sym} para pagar el gas del retiro`,
    legWithdraw: (hopSym, destSym, network) => `Quemar ${hopSym} — ${destSym} llega en ${network}`,
    legStatePending: 'En espera',
    legStateSent: 'Enviado',
    legStateConfirmed: 'Confirmado',
    legStateFailed: 'Rechazado',
    legProgress: (n, total) => `Paso ${n} de ${total}`,
    destInWallet: sym => `${sym} — en esta billetera`,
    destGroupOther: 'Otros destinos',
    mechDirect: 'Pool directo',
    mechViaHub: hubSym => `Vía ${hubSym}`,
    mechViaCctp: 'Vía Circle CCTP',
    mechViaVenue: venue => `Vía ${venue}`,
    mechNoneSelected: 'Elige un mecanismo arriba para ver la cotización.',
    viaHub: hubSym => `vía ${hubSym} · 2 intercambios`,
    hubShape: () => '2 intercambios',
    routeMinWalletLine: amount => `Mín. ${amount} en esta billetera`,
    hubQuoteSource: (venue1, venue2, at) => `${venue1} + ${venue2} · ${at}`,
    hubCensusHeading: 'Dos intercambios, desglosados uno por uno',
    approveFeeLine: amount => `Aprobar el siguiente pool cuesta ${amount} (la propia tarifa de transferencia del ledger)`,
    hubRateLine: (inSym, destSym) => `Tasa combinada ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Sobre el piso, el excedente se queda en esta billetera como ${hubSym} o ${destSym}.`,
    gasFeeLine: amount => `Gas del retiro (cotización en vivo): ${amount}`,
    routeMinLine: amount => `Mín. ${amount} en tu dirección`,
    routeSurplusNote: hopSym => `Sobre el piso, el excedente se queda en esta billetera como ${hopSym}.`,
    routeDestEstimate: (amount, sym) =>
      `Aterriza \u2248 ${amount} ${sym} en tu dirección Solana — el paso final de Jupiter re-cotiza al momento`,
    routeVenues: (icVenue, solVenue) => `Ruta: ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Primero falta gas',
    gasPreflightBody: needed =>
      `Quemar hacia Ethereum necesita unos ${needed} de gas en ckETH — esta billetera no tiene suficiente. Consigue ckETH en esta billetera primero y vuelve.`,
    executingTitle: 'Ejecutando la ruta',
    doneRouteTitle: 'Retiro en camino',
    doneRouteBody: (amount, address) => `Al menos ${amount} va en camino a ${address}.`,
    doneOnItsWay: 'La entrega corre por Ethereum y puede tardar — dpay no puede vigilar esa red.',
    failedLegTitle: 'Retiro rechazado',
    failedLegBody: (sym, reason) =>
      `El intercambio se completó — tus fondos están en ${sym} en esta billetera. El retiro fue rechazado${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Retira vía Pagar ▸ Enviar a dirección — pega cualquier dirección de destino.',
    stuckRouteBody: 'El resultado de un tramo sigue abierto — dpay vigila los libros; esta pantalla cambia sola.',
    failedHop2Title: 'Segundo intercambio rechazado',
    failedHop2Body: (hubSym, outSym, reason) =>
      `El primer intercambio pasó — tienes ${hubSym} en esta billetera. El intercambio ${hubSym} → ${outSym} fue rechazado${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Tus ${hubSym} se pueden gastar tal cual — consérvalos, cámbialos o envíalos. Nada que revertir.`,
    stuckHoldsLine: hubSym => `Hasta aquí: ${hubSym} en esta billetera.`,
    insufficientHubLine: (needed, balance) =>
      `Faltan ${needed} — el monto más tres comisiones — tienes ${balance}.`,
  },

  cefi: {
    destRow: (sym, network, venue) => `${sym} en ${network} — vía ${venue} (servicio de intercambio)`,
    destRowMulti: (sym, network) => `${sym} en ${network}`,
    settleAddressLabel: 'El pago llega a tu propia dirección',
    settleRailEthereum: 'El pago se entrega en ETH nativo en Ethereum mainnet',
    depositAddressLabel: 'Dirección de depósito',
    depositAmountLabel: 'Importe exacto',
    depositMemoLabel: 'Memo (obligatorio)',
    counterparty: venue =>
      `Ejecutado por ${venue} — un servicio de intercambio automatizado, ni un banco ni dpay.`,
    checklistSigns:
      'No se firma nada en este teléfono: tras confirmar, tú mismo envías el depósito a la dirección del servicio.',
    refusalLine: sym =>
      `Si el depósito nunca llega, la orden caduca — no se mueve nada y tu ${sym} sigue en tu billetera.`,
    insufficientLine: (needed, balance) =>
      `El depósito necesita ${needed} (comisión de transferencia incluida) — tienes ${balance}.`,
    payoutAt: address => `Pagado a tu propia dirección: ${address}`,
    depositExpiryLine: at => `La orden caduca ${at}`,
    noExpiryLine: 'Sin caducidad publicada — dpay sigue vigilando.',
    lastCheckedLine: at => `Última comprobación: ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: 'Fondos confirmados — tu pago queda bloqueado por el importe cotizado.',
    settlingWatchLine: 'La mayoría se liquidan en minutos — dpay supervisa cada shift e interviene si uno se demora.',
    depositNote: (venue, sym) =>
      `Envía ${sym} desde tu billetera a la dirección de depósito de ${venue} arriba — exactamente la cantidad indicada. ${venue} la retiene durante el intercambio y luego paga a tu dirección. dpay no es parte y no cobra nada.`,
    stillWaitingDeposit: 'Todavía esperando tu depósito — esta página se actualiza sola.',
    depositSolFeeNote: 'El depósito también paga una pequeña comisión de red en SOL — conserva algo de SOL en esta billetera.',
    solInsufficientLine: (needed, balance) =>
      `El depósito envía exactamente ${needed} — tienes ${balance}.`,
    noQuoteTitle: 'Sin mercado en vivo',
    noQuoteBody: venue =>
      `${venue} lista este par, pero ahora mismo no tiene un mercado en vivo. No se envió nada. Elige otra sede o inténtalo más tarde.`,
    minDepositBody: (venue, venueMessage, min) =>
      `${venue} rechazó este importe: “${venueMessage}” (mínimo ${min}). No se envió nada — sube el importe e inténtalo de nuevo.`,
  },

  chain: {
    depositSending: venue => `Enviando el depósito a ${venue}`,
    orderLine: (venue, depositAmt, midSym) => `Orden en ${venue}: ${depositAmt} entra, ${midSym} sale`,
    depositSent: (venue, depositAmt, midSym) => `${depositAmt} enviado a ${venue} — esperando el pago en ${midSym}`,
    phase2Note: 'El segundo tramo corre solo cuando llega el pago.',
    phase2Leg: (midSym, outSym, venue) => `Luego ${midSym} → ${outSym} vía ${venue} — cotizado de nuevo al llegar el pago`,
    rowShape: midSym => `vía ${midSym}, convierte con un toque`,
    phase2Failed: midSym => `El segundo tramo no pudo ejecutarse — tus ${midSym} están en esta billetera. Conviértelos normalmente (preseleccionado).`,
    depositFailed: sym => `El depósito nunca llegó on-chain — tus ${sym} nunca salieron de la billetera.`,
  },

  crossrail: {
    heading: 'Firmar en tu billetera Ethereum',
    handoffIntro: (amount) =>
      `Parte IC hecha: ${amount} está en tu dirección Ethereum. Tu billetera lo cruza — dpay jamás toca tus claves Ethereum.`,
    stepApproveLabel: 'Paso 1 — permitir que el contrato de Circle mueva los USDC',
    stepBurnLabel: 'Paso 2 — quemar los USDC para el transfer a Solana',
    txAmountLabel: 'Importe',
    copy: 'Copiar',
    copied: 'Copiado',
    approveHint: 'Permite que el TokenMessenger de Circle mueva exactamente estos USDC — nada más.',
    burnHint: 'Bloquea los USDC en Ethereum; el puente de Circle acuña los mismos USDC en tu dirección Solana — sin token envuelto.',
    timingNote: 'Vía rápida: de segundos a pocos minutos (medidos ~20 s). Con Ethereum congestionado, más — esta pantalla se actualiza sola.',
    externalGasLine: 'El gas se paga con el ETH de tu propia billetera — dpay no puede pagarlo ni cotizarlo exacto.',
    circleFeeLine: fee => `Comisión del puente de Circle (su propia cifra, del importe): como máximo ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Mín. ${floor} ${sym} en tu dirección Solana — el paso final los cambia por tu destino`,
    mintFloorDestLine: (floor, sym) => `Llegan como mínimo ${floor} ${sym} a tu dirección Solana`,
    burnTxLabel: 'Hash de la tx de burn (de tu billetera)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Ya lo firmé — vigilar el cruce',
    burnTxInvalid: 'No es un hash de transacción Ethereum.',
    declineButton: 'No voy a firmar',
    whatSigning: 'Firmas dos transacciones Ethereum normales en tu propia billetera: una aprobación y luego el burn. Del lado de dpay no se firma nada.',
    crossingTitle: 'Cruzando a Solana',
    crossingBody: 'Circle atestigua el burn y acuña los USDC en tu dirección Solana — dpay vigila el feed de estado de Circle.',
    viewBurnTx: 'Ver la transacción de burn',
    viewCircle: 'Página de estado de Circle',
    stillCrossing: 'Aún pendiente — no es un fallo. Vía rápida: segundos o minutos; con Ethereum congestionado, más.',
    solReadyTitle: 'Los USDC ya están en Solana',
    solReadyBody: (credit, ata) => `${credit} verificado en ${ata}. Termina la ruta — o quédate los USDC; son tuyos igual.`,
    abortedCrossing: ata =>
      `Vigilancia detenida. Tu burn ya salió — Circle aún puede completar el mint; el USDC llega de todos modos a tu propia dirección de Solana ${ata}. Revisa Saldos más tarde.`,
    abortedSolReady: ata =>
      `Nada se firmó — el último intercambio nunca se ejecutó. Tu USDC está en tu dirección de Solana ${ata}: consérvalo o conviértelo allí.`,
    solQuoteLabel: venue => `Cotización de ${venue}`,
    solMinLine: (min, sym) => `Mín. ${min} ${sym} en tu dirección`,
    solConfirmButton: sym => `Cambiar a ${sym}`,
    solFeeLine: fee => `Comisión Solana: ${fee}`,
    solPreflightTitle: 'Falta SOL para la comisión',
    solPreflightBody:
      'La comisión se paga en SOL y esta billetera no tiene. Añade un poco de SOL — los USDC se quedan donde están.',
    doneTitle: 'Convertido',
    doneBody: (amount, sym, address) => `${amount} ${sym} están en tu dirección Solana ${address} — verificados on-chain.`,
    doneVia: (icVenue, solVenue) => `Vía ${icVenue}, Circle y ${solVenue}.`,
    declinedTitle: 'Handoff cancelado',
    declinedBody: address =>
      `No cruzó nada. Tus USDC están en tu propia dirección Ethereum ${address} — envíalos donde quieras o repite esta ruta más tarde.`,
    solFailedTitle: 'El intercambio en Solana falló',
    solFailedBody: (ata, venue) =>
      `Los USDC ya cruzaron — están en tu dirección Solana ${ata}. ${venue} rechazó el intercambio final: reintenta aquí en un momento o quédate los USDC.`,
    legCctpBurn: (sym, network) => `Llevar ${sym} a ${network} vía Circle (esto lo firmas en tu billetera)`,
    legSolSwap: (venue, sym) => `Cambiar a ${sym} en ${venue}`,
    destAddressCrossNote: 'Esta dirección también firma el cruce — pega una dirección que controles.',
    deviceSignTitle: 'El cruce firma en este dispositivo',
    deviceSignBody: 'La clave de esta propia billetera firma el cruce de Circle - sin otra billetera, sin paso extra. Deja un poco de ETH en la dirección de pago para el gas del cruce.',
    destAddressDeviceNote: 'El cruce firma en este dispositivo - deja aquí un poco de ETH para su gas.',
    burnFailedBody: (address, reason) =>
      `El cruce de Circle fue rechazado antes de quemar nada. Tu USDC está en tu propia dirección de Ethereum ${address}${reason ? `: ${reason}` : ''} - envíalo donde quieras o repite esta ruta más tarde.`,
    checksumMismatch: 'Error de checksum',
    retypeAddress: 'Vuelve a escribir la dirección',
    retypeMismatch: 'No coincide',
    gasFundTitle: 'Falta gas ETH que no tienes',
    gasFundNeed: eth => `Necesita \u2248 ${eth}`,
    gasFundHave: eth => `Tu billetera: ${eth}`,
    gasFundWalletButton: 'Financiar desde esta billetera',
    gasFundSelfButton: 'La financio yo mismo',
    gasFundSelfMin: eth => `Envía \u2265 ${eth} a:`,
    gasFundRecheck: 'Comprobar de nuevo',
    gasFundShort: short => `Todavía faltan ${short}`,
    gasLegsNote: 'Los primeros tramos financian el gas.',
    abortedGasBody: 'La financiación del gas llegó — sigue en esta billetera. La conversión nunca se ejecutó.',
    declinedWithGasBody: address => `No cruzó nada. Tus USDC están en tu dirección Ethereum ${address}; el gas financiado sigue en esta billetera.`,
    gasShortFailedBody: needed => `La financiación del gas se quedó por debajo de ${needed}. Nada salió de esta billetera — la conversión nunca empezó.`,
  },

  errors: {
    quoteUnreachable: venue => `${venue} no fue accesible a través del relay de dpay. No se envió nada — revisa tu conexión e inténtalo en un momento.`,
    quoteRefused: venue => `${venue} se negó a cotizar este par ahora mismo.`,
    buildRefused: venue => `${venue} no pudo preparar este intercambio. No se movió nada — inténtalo de nuevo en un momento.`,
    quoteUnavailable: code => `Cotización no disponible (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} aún no está configurado en este relay — no se puede pedir cotización. Tu billetera no tiene ningún problema.`,
    gasUnavailable: 'El precio del gas del minter no estuvo disponible — no se firmó nada. Inténtalo de nuevo.',
    cctpFeeUnavailable: 'No se pudo consultar la comisión del puente de Circle — no se firmó nada. Revisa tu conexión y vuelve a intentarlo.',
    chainDepositUnreadable: venue =>
      `No se pudo verificar la dirección de depósito de ${venue} en Solana — no se firmó nada. Revisa tu conexión y vuelve a intentarlo, o envía el depósito desde tu propia billetera.`,
    chainSenderEmpty: sym => `Sin cuenta de tokens ${sym} en esta billetera — no se firmó nada. Recibe ${sym} primero.`,
    chainSenderShort: sym => `El saldo de ${sym} de la billetera no cubre este monto — no se firmó nada.`,
    chainRentShort: sym => `La cuenta de ${sym} de la sede necesita un poco de SOL para el alquiler — la billetera no alcanza. No se firmó nada; carga SOL y vuelve a intentarlo.`,
  },
};
