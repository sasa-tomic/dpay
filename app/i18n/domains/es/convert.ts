/**
 * i18n/domains/es/convert.ts — valores en español para la superficie de conversión delegada.
 * Tipos, documentación de claves y copia de referencia: ../en/convert.ts. Glosario: ../../es.ts.
 * «Quote» se mantiene como término técnico; la sala siempre se nombra «ICPSwap». Los importes y
 * principals llegan ya formateados como cadenas de presentación.
 */
import type {ConvertMessages} from '../../keys';

export const convertEs: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Volver al monedero',

  unavailableTitle: sym => `Convertir aún no está disponible para ${sym}`,
  unavailableBody: pair => `Hoy dpay convierte ${pair} a través de ICPSwap — y nada más.`,
  unavailableCkusdc:
    'Existe un pool directo VCHF ↔ USDC, pero su profundidad está saturada (unos CHF 315): dpay lo rechaza antes que darte un precio caducado.',

  amountLabel: sym => `Importe (${sym})`,
  balanceLine: balance => `Saldo: ${balance}`,
  receiveHeadline: 'Recibirás',
  counterparty:
    'Ejecutado por el pool de ICPSwap — un contrato autónomo on-chain, no un proveedor con licencia y no dpay.',
  counterpartySigns: 'Tu teléfono firma; el pool retira exactamente el importe aprobado.',
  quoteSource: at => `Cotización de ICPSwap, obtenida ${at}`,
  rateLabel: (inSym, outSym) => `Tipo (${inSym} → ${outSym})`,
  poolFeeTier: tier => `Comisión del pool: ${tier} (nivel de ICPSwap)`,
  inputFeeLine: fee => `Comisión de entrada: ${fee}`,
  outputFeeLine: fee => `Comisión de salida: ${fee}`,
  dpayFeeLine: 'dpay no cobra nada ni recibe nada por esto.',
  impactLine: pct => `Impacto en el precio: ${pct}`,
  impactWarnLine: pct => `Impacto alto en el precio: ${pct} — la cotización de arriba ya lo incluye.`,
  impactUnavailable:
    'Impacto en el precio: ahora mismo no es medible — ICPSwap no cotizó nada para el intercambio de referencia, así que no hay ningún precio con el que comparar este. El mínimo que recibirás, abajo, sigue acotando lo que este intercambio puede costarte.',
  slippageLabel: 'Deslizamiento',
  minReceiveLine: (amount, pct) => `Mínimo que recibirás: ${amount} (${pct} de deslizamiento)`,
  refusalLine: sym =>
    `Si el precio del pool pasa de tu mínimo, el intercambio falla: tu ${sym} se queda en tu monedero y la autorización caduca sin usarse.`,
  netEndStateLine: amount => `Estado final: ${amount} previstos en tu monedero, netos de todas las comisiones.`,
  confirmButton: 'Recotizar y confirmar',
  staleRefreshing: 'Cotización caducada — actualizando…',
  quoteChanged: (oldAmt, newAmt) => `La cotización cambió: ${oldAmt} → ${newAmt}. Revisa y confirma de nuevo.`,

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
  swappingBody: 'Enviando el intercambio al pool de ICPSwap. Solo puede retirar el importe aprobado.',
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
  failedSwapBody: (reason, sym) =>
    `El pool de ICPSwap rechazó el intercambio (${reason}). Tu ${sym} nunca salió de tu monedero. dpay no puede revertirlo ni reintentarlo por ti; no hace falta nada más.`,
  refundedBody: sym =>
    `El intercambio falló y el pool te devolvió tu ${sym} — tu saldo vuelve a estar completo. dpay no puede revertir nada aquí.`,
  stuckTitle: 'Desenlace desconocido',
  stuckBody:
    'El intercambio se envió, pero la respuesta del pool no llegó. No inicies un segundo intercambio con los mismos fondos. Si el pago llega, esta pantalla pasará a «Convertido» por sí sola.',
  stuckSigned: (amount, minAmount) =>
    `Lo firmado: autorizar ${amount} al pool de ICPSwap; intercambiar por un mínimo de ${minAmount}.`,
  expiryLine: at => `La autorización sin usar caduca a más tardar a las ${at} — después, el pool no puede retirar nada.`,

  errors: {
    quoteUnreachable: () => 'No se pudo alcanzar la cotización de ICPSwap — el relay no responde. Revisa tu conexión y vuelve a intentarlo.',
    quoteRefused: () => 'ICPSwap se negó a cotizar este par ahora mismo.',
    quoteUnavailable: code => `Cotización no disponible (${code}).`,
  },
};
