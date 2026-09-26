/**
 * i18n/es.ts — Spanish (neutral, international). Translated from en.ts, which stays the reference.
 *
 * Register: "tú" throughout. Vocabulary is kept neutral between Spain and Latin America — where a
 * term genuinely splits, the more widely understood option wins (noted below).
 *
 * GLOSSARY — one term per concept, applied with zero variation:
 *   payment / to pay ........ el pago / pagar
 *   request ................. la solicitud (verb: solicitar; "Request" button = "Solicitar")
 *   receive ................. recibir
 *   settle / settled ........ confirmar / confirmado. "Liquidar" reads like a bank back office;
 *                             "confirmado" also gives the honest opposite the product needs —
 *                             `pending` = "Sin confirmar", never "Falló".
 *   confirmation ............ la confirmación (same root, deliberately: from the user's seat the
 *                             merchant's confirmation IS the settlement)
 *   offline / online ........ sin conexión / con conexión ("conéctate", "vuelvas a tener conexión")
 *   tap (NFC) ............... acercar (el teléfono); the feature = "pago sin contacto"
 *   scan .................... escanear
 *   wallet .................. la billetera (vs "cartera"/"monedero" — "billetera" is the one both
 *                             regions read as a payment wallet)
 *   balance ................. el saldo
 *   funds ................... los fondos
 *   add money / deposit ..... añadir / depositar, el depósito ("añadir" over "agregar": RAE-neutral
 *                             and read everywhere)
 *   cash out / withdraw ..... retirar, el retiro (over "la retirada", which is Spain-only)
 *   address ................. la dirección
 *   recovery words / backup . las palabras de recuperación / la copia de seguridad; seed = la semilla
 *   merchant / shop ......... el comercio / la tienda (English keeps both registers; so does this)
 *   payer ................... quien paga (a noun phrase, so "de quien paga" stays grammatical)
 *   network fee ............. la comisión de red
 *   ledger .................. la red — the consumer-level referent; "libro mayor" reads as accounting
 *                             software and gives the user nothing to act on
 *   transactions / ledger UI  Movimientos (the standard Spanish banking word for an activity list)
 *   rail .................... la vía
 *   testnet ................. testnet (untranslated, like Bitcoin/Solana/NFC/QR)
 *   demo funds .............. fondos de prueba (demo money = dinero de prueba)
 *   trip readiness .......... preparación del viaje ("Listo para viajar" when it is complete)
 *   relay ................... el servidor (matches the English UI, which already says "Server")
 *   expire .................. caducar / caducado
 *   check (re-query) ........ revisar (over "comprobar"/"verificar" — shortest and fully neutral)
 *   enter (a value) ......... introducir — NOT "ingresar", which in Spain also means "to deposit"
 *                             and would be ambiguous on a money screen
 *   amount .................. el importe (over "monto", which is not idiomatic in Spain)
 */
import type {Messages} from './keys';
import {depositEs, withdrawEs} from './domains/es/deposit.ts';
import {convertEs} from './domains/es/convert.ts';
import {receiptEs} from './domains/es/receipt.ts';
import {errorsEs} from './domains/es/errors.ts';
import {payEs, receiveEs} from './domains/es/pay.ts';
import {onboardingEs, settingsEs} from './domains/es/settings.ts';
import {educationEs, walletEs} from './domains/es/wallet.ts';

export const es: Messages = {
  common: {
    done: 'Listo',
    cancel: 'Cancelar',
    linkFallback: url => `No se pudo abrir el enlace. Ábrelo manualmente: ${url}`,
  },

  time: {
    today: time => `Hoy, ${time}`,
    yesterday: time => `Ayer, ${time}`,
  },

  settings: settingsEs,
  onboarding: onboardingEs,

  wallet: walletEs,
  education: educationEs,

  pay: payEs,
  receive: receiveEs,

  deposit: depositEs,
  convert: convertEs,

  receipt: receiptEs,
  withdraw: withdrawEs,

  nfc: {
    reason: {
      off: 'El NFC está desactivado en los ajustes del dispositivo. Actívalo para pagar sin contacto, o escanea el código QR para pagar ahora.',
      unsupported: 'Este dispositivo no tiene NFC. Escanea el código QR para pagar.',
      unknown: 'No se pudo revisar el estado del NFC. Escanea el código QR para pagar.',
    },
    phase: {
      listening: {title: 'Acércalo al otro teléfono', sub: 'dpay espera el acercamiento'},
      linking: {title: 'Conectando…', sub: 'Enlazando los dos teléfonos'},
      exchanging: {title: 'Comunicando…', sub: 'Mantén los teléfonos juntos'},
      awaitingApproval: {title: 'Esperando a quien paga…', sub: 'Está firmando el pago'},
      settling: {title: 'Confirmando…', sub: 'Mantén los teléfonos juntos mientras el comercio lo confirma'},
      success: {title: 'Listo ✓', sub: ''},
      declined: {title: 'Rechazado', sub: 'El pago fue rechazado'},
      pending: {title: 'Sin confirmar', sub: 'No se pudo contactar con la red'},
      error: {title: 'Fallo al acercar', sub: 'Junta los teléfonos e inténtalo de nuevo'},
    },
    paidAmount: amount => `Pagado ✓ ${amount}`.trim(),
    receivedAmount: amount => `Recibido ✓ ${amount}`.trim(),
    settled: 'El pago quedó confirmado',
    paying: (amount, network) => (network ? `Pagando ${amount} en ${network}` : `Pagando ${amount}`),
    collecting: (amount, network) => (network ? `Cobrando ${amount} en ${network}` : `Cobrando ${amount}`),
    holdToSend: 'Mantén los teléfonos juntos para enviarlo',
  },

  rail: {
    insufficientFunds: 'Saldo insuficiente',
    badFee: detail => `Comisión incorrecta${detail ? ` (${detail})` : ''}: inténtalo de nuevo`,
    badBurn: detail => `El importe está por debajo del mínimo de la red${detail ? ` (${detail})` : ''}`,
    tooOld: 'La solicitud caducó',
    createdInFuture: 'Desfase del reloj: inténtalo de nuevo',
    temporarilyUnavailable: 'La red está ocupada: inténtalo de nuevo',
    declined: detail =>
      detail ? `La red rechazó el pago (${detail})` : 'La red rechazó el pago',
  },

  sol: {
    noRecordOfCredit:
      'Esta cuenta no tiene SOL, o la red aún no ha sincronizado tu saldo. Si acabas de depositar, espera un momento y reinténtalo; si no, deposita primero SOL en tu dirección.',
    timedOut: 'Se agotó el tiempo de espera. Revisa tu conexión e inténtalo de nuevo.',
    engineLoad: 'El motor de pagos no cargó. Revisa tu conexión, vuelve a abrir esta pantalla e inténtalo de nuevo — tu dinero sigue donde estaba.',
    insufficient: 'No tienes SOL suficiente para este envío más la comisión de red.',
    rentExempt: 'Después de este envío, tu cuenta quedaría por debajo del saldo mínimo. Envía un importe menor.',
    blockhash: 'La red estaba demasiado ocupada. Inténtalo de nuevo.',
    tapFailed: 'El pago no se completó: inténtalo de nuevo',
  },

  errors: errorsEs,
};
