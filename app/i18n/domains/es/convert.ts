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
  unavailableCkusdc: venue =>
    `Existe un pool directo VCHF ↔ USDC en ${venue}, pero su profundidad está saturada (unos CHF 315): dpay lo rechaza antes que darte un precio caducado.`,

  amountLabel: sym => `Importe (${sym})`,
  balanceLine: balance => `Saldo: ${balance}`,
  receiveHeadline: 'Recibirás',
  counterparty: venue =>
    `Ejecutado por el pool de ${venue} — un contrato autónomo on-chain, no un proveedor con licencia y no dpay.`,
  counterpartySigns: 'Tu teléfono firma; el pool retira exactamente el importe aprobado.',
  quoteSource: (at, venue) => `Cotización de ${venue}, obtenida ${at}`,
  rateLabel: (inSym, outSym) => `Tipo de esta cotización (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Comisión del pool: ${tier} (nivel de ${venue})`,
  inputFeeLine: fee => `Comisión de entrada: ${fee}`,
  outputFeeLine: fee => `Comisión de salida: ${fee}`,
  dpayFeeLine: 'dpay no cobra nada ni recibe nada por esto.',
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (la clave del registro para los pools de ICPSwap): el hecho
      // propio de la venue es DÓNDE se ejecuta el intercambio — su propio contrato de pool,
      // firmado por el usuario, dpay no es parte.
      icpswap: venue =>
        `El intercambio se ejecuta en el contrato de pool propio de ${venue}. Cada llamada la firmas tú y se envía directamente — ${venue} ejecuta el intercambio, y dpay no es parte de él.`,
    },
    generic: venue =>
      `Esta conversión la ejecuta ${venue}. Cada llamada la firmas tú y se envía directamente — dpay no es parte de ella.`,
  },
  slippageLabel: 'Deslizamiento',
  minReceiveLine: (amount, pct) => `Mínimo que recibirás: ${amount} (${pct} de deslizamiento)`,
  refusalLine: sym =>
    `Si el precio del pool pasa de tu mínimo, el intercambio falla: tu ${sym} se queda en tu monedero y la autorización caduca sin usarse.`,
  netEndStateLine: amount => `Estado final: ${amount} previstos en tu monedero, netos de todas las comisiones.`,
  confirmButton: 'Recotizar y confirmar',
  staleRefreshing: 'Cotización caducada — actualizando…',
  quoteChanged: (oldAmt, newAmt) => `La cotización cambió: ${oldAmt} → ${newAmt}. Revisa y confirma de nuevo.`,
  venueChooserLabel: 'Sede',
  venueNoneSelected: 'Elige una sede para ver su cotización completa y continuar.',
  venueRowQuote: amount => `Cotización: ${amount}`,

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
    `El pool aceptó el intercambio, pero el pago en ${sym} aún no llegó a tu monedero. Esta pantalla sigue vigilando — no tienes que hacer nada ahora. dpay no puede revertir ni acelerar el pago. Si nunca llega, indica esto al soporte: pool ${pool}, intercambio enviado a las ${at}.`,
  stillWatching: 'Siguiendo esperando el pago…',
  failedTitle: 'Intercambio no ejecutado',
  failedApproveBody: sym =>
    `El ledger de ${sym} rechazó la autorización, así que no se movió nada — sigues teniendo cada unidad de tu ${sym}. No se creó ninguna autorización; no hay nada que reembolsar ni revertir.`,
  failedSwapBody: (reason, sym, venue) =>
    `El pool de ${venue} rechazó el intercambio (${reason}). Tu ${sym} nunca salió de tu monedero. dpay no puede revertirlo ni reintentarlo por ti; no hace falta nada más.`,
  refundedBody: sym =>
    `El intercambio falló y el pool te devolvió tu ${sym} — tu saldo vuelve a estar completo. dpay no puede revertir nada aquí.`,
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
    `${venue} retiene el depósito y está ejecutando la orden. Tu ${sym} llega cuando el proveedor la complete — dpay no puede revertirla ni acelerarla, y sigue vigilando hasta que se resuelva.`,
  quoteExpiredTitle: 'Cotización caducada',
  quoteExpiredBody: (sym, venue) =>
    `La cotización murió antes de que se moviera algún valor: ${venue} nunca recibió el depósito, así que no se intercambió nada y no hay nada que revertir. Tu ${sym} se quedó donde estaba — inicia una nueva conversión si aún quieres una.`,
  providerRefundedTitle: 'Reembolsado por el proveedor',
  providerRefundedBody: (sym, venue) =>
    `${venue} canceló esta orden y devolvió el depósito. Vigila la llegada de tu ${sym} — dpay no puede revertir ni acelerar el reembolso del proveedor.`,
  stuckWatching: 'dpay sigue vigilando esto en segundo plano. Si llega el pago o el reembolso, esta pantalla cambia sola.',
  stuckAcknowledge: 'Entendido — dejar de vigilar',
  stuckAcknowledged: 'Has tomado nota y la vigilancia en segundo plano se ha detenido. Si los fondos se mueven más tarde, seguirán llegando a la dirección de esta cartera.',

  errors: {
    quoteUnreachable: venue => `No se pudo alcanzar la cotización de ${venue} — el relay no responde. Revisa tu conexión y vuelve a intentarlo.`,
    quoteRefused: venue => `${venue} se negó a cotizar este par ahora mismo.`,
    quoteUnavailable: code => `Cotización no disponible (${code}).`,
  },
};
