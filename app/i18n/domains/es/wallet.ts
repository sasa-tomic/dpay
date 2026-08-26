/**
 * i18n/domains/es/wallet.ts — Spanish values for the `wallet` + `education` domains.
 *
 * Reference copy, types and rationale: domains/en/wallet.ts. Glossary: i18n/es.ts.
 */
import type {EducationMessages, WalletMessages} from '../../keys';

export const walletEs: WalletMessages = {
  header: {
    settings: 'Ajustes',
    settingsHint: 'Abre los ajustes de servidor, borrado y avanzados',
    themeSwitch: target => `Cambiar el tema a ${target}`,
    themeSwitchHint: 'Alterna el tema entre Claro y Oscuro; elige Auto en Ajustes',
    account: 'CUENTA',
    accountLabel: 'Cuenta',
    home: 'Inicio de dpay',
    homeHint: 'Abre el sitio principal de dpay',
  },

  balance: {
    label: 'Saldos: cambia de moneda o recibe',
    hint: 'Abre la lista completa de activos, cambia la moneda mostrada o recibe',
    lockedHint: 'Primero termina o cancela el pago en curso',
    of: asset => `Saldo de ${asset}`,
    approx: asset => `~ ${asset} aprox.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Pulsa atrás otra vez para salir',
  },

  tab: {pay: 'Pagar', receive: 'Recibir', transactions: 'Movimientos'},

  backToPaying: asset => `Volver a pagar con ${asset}`,

  faucet: {
    unavailableOnRelay: 'La recarga de prueba no está disponible en este servidor',
    failed: 'Falló la recarga',
    unavailable: 'Recarga no disponible',
    offline: 'Sin conexión: inténtalo cuando vuelvas a conectarte',
  },

  balances: {
    title: 'Saldos',
    close: 'Cerrar saldos',
    intro: 'Toca una moneda para mostrarla en tu pantalla de inicio. Recíbela o envíala desde las pestañas Recibir y Pagar.',
    demoFunds: 'Fondos de prueba',
    demoFundsLabel: 'Conseguir fondos de prueba',
    demoFundsHint: 'Añade ∂100 de dinero de prueba a esta billetera',
    needsSetup: 'Sin configurar',
    select: symbol => `Seleccionar ${symbol}`,
    selectHint: 'Muestra el saldo de este activo en tu pantalla de inicio',
    selectSolanaHint: symbol => `Muestra ${symbol} en tu pantalla de inicio y usa la vía de Solana para Pagar y Recibir`,
    showTestnet: 'Mostrar activos de testnet',
    hideTestnet: 'Ocultar activos de testnet',
    showTestnetHint: 'Muestra las monedas de testnet en esta lista',
    hideTestnetHint: 'Oculta las monedas de testnet de esta lista',
    escToClose: 'Pulsa Esc para cerrar',
  },

  ledger: {
    empty: 'Todavía no hay pagos.',
    emptyHint: 'Toca Recibir para crear una solicitud de pago, o Pagar para escanear una.',
    recent: 'Recientes',
    allAssets: 'Todos los activos',
    all: 'Todos',
    filter: label => `Filtrar ${label}`,
    to: who => `a ${who}`,
    from: who => `de ${who}`,
    mintCounterparty: 'Fondos de prueba',
  },

  fund: {checking: 'Revisando…', checkAgain: 'Revisar de nuevo'},

  asset: {
    demoSubtitle: 'dinero ficticio para pruebas',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    unsupported: 'No admitido',
    testnetName: base => `${base} testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Compartido ✓'},
};

/** Month abbreviations for the passport stamp date, in Spanish. */
const ES_MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

export const educationEs: EducationMessages = {
  campaignLine: '¿Señal? No hace falta.',
  howItWorksTitle: 'Cómo funciona dpay',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'CÓMO PAGA DPAY',
        title: 'Paga sin señal',
        body: 'Tu teléfono puede pagar sin nada de señal. La tienda envía el pago por ti, con su propia conexión a internet.',
      },
      key: {
        eyebrow: 'TU DINERO',
        title: 'Tu clave se queda en este dispositivo',
        body: 'dpay no guarda fondos ni puede aprobar un pago por ti. No hay ninguna cuenta de dpay: solo tu clave.',
      },
      exact: {
        eyebrow: 'SIN SORPRESAS',
        title: 'Paga el activo exacto que te piden',
        body: 'La tienda pide un activo exacto. Tú revisas el importe y lo apruebas. dpay nunca convierte otro saldo.',
      },
    },
    stageTags: ['01 — SEÑAL', '02 — CLAVE', '03 — ACTIVO'],
    close: 'Cerrar Cómo funciona dpay',
    skip: 'Saltar la introducción',
    skipHint: 'Ve directo a crear tu billetera',
    back: 'Atrás',
    backLabel: 'Escena anterior',
    next: 'Siguiente',
    nextLabel: 'Escena siguiente',
    nextHint: 'Muestra la escena siguiente',
    getStarted: 'Empezar',
    getStartedHint: 'Continúa para crear tu billetera',
    shopRequests: 'La tienda pide',
  },

  rehearsal: {
    title: 'Un pago honesto',
    sheetTitle: 'Ensayo',
    steps: {
      request: {
        title: 'La tienda pide',
        body: 'La tienda elige un activo y un importe exactos, y su terminal los convierte en un código de solicitud.',
      },
      approve: {
        title: 'Tú revisas y apruebas',
        body: 'Tu teléfono muestra exactamente lo que vas a pagar. Nada se mueve hasta que lo apruebas con tu clave.',
      },
      settle: {
        title: 'La tienda lo confirma',
        body: 'La conexión de la tienda envía el pago y se confirma en segundos en su pantalla.',
      },
    },
    stageTags: ['01 — SOLICITUD', '02 — APROBACIÓN', '03 — CONFIRMACIÓN'],
    punchline: 'Eso es todo. Tu teléfono puede estar sin conexión al aprobar y al entregar el pago.',
    skip: 'Ver mi billetera',
    skipHint: 'Salta el ensayo y abre tu billetera',
    try: 'Probar con fondos de prueba',
  },

  coachTips: {
    payReview: {
      title: 'Tú apruebas el pago exacto',
      body: 'Al aprobar se envía exactamente este importe de este activo, desde tu saldo y firmado con tu clave.',
    },
    receiveRequest: {
      title: 'Muestra tu código de solicitud',
      body: 'Muéstrale este código a tu cliente. Su teléfono lo escanea y lo aprueba; tu conexión lo confirma.',
    },
    offlineQr: {
      title: 'Firmado, no confirmado',
      body: '¿Sin señal? Este código firmado es tu comprobante de pago. La conexión de quien lo recibe lo confirma; el estado se actualiza cuando vuelvas.',
    },
    pendingOutcome: {
      title: 'Todavía pendiente',
      body: 'Pendiente significa que aún no se sabe el resultado. Nunca des por hecho que salió bien: vuelve a mirar aquí.',
    },
  },
  coachDismiss: title => `Descartar el consejo: ${title}`,
  coachDismissHint: 'Oculta este consejo; no volverá a aparecer',

  passport: {
    title: 'Preparación del viaje',
    stamps: {
      recoverySaved: {label: 'COPIA\nHECHA', hint: 'Copia tus palabras de recuperación en Ajustes', short: 'falta la copia de seguridad'},
      flowUnderstood: {label: 'FLUJO\nVISTO', hint: 'Mira el ensayo al crear una billetera, o haz cualquier pago', short: 'falta ver cómo funciona'},
      fundsReady: {label: 'FONDOS\nCARGADOS', hint: 'Añade fondos: los de prueba también valen', short: 'falta añadir fondos'},
      paymentTested: {label: 'PRIMER\nPAGO', hint: 'Completa un pago: paga o recibe', short: 'falta un pago'},
    },
    close: title => `Cerrar ${title}`,
    stripLabel: filled => `Preparación del viaje: ${filled} de 4`,
    count: filled => `${filled} DE 4`,
    goToStep: hint => `Ir: ${hint}`,
    goToStepHint: 'Abre la pantalla donde se hace este paso',
    nextTag: 'Siguiente',
    nextLabel: hint => `Siguiente: ${hint}`,
    nextHint: 'Ve a la pantalla donde se hace este paso',
    doneHint: 'Retira la barra de preparación del viaje',
    ready: 'Listo para viajar',
    readyLine: 'Puedes pagar aunque tu teléfono no tenga señal.',
    capstone: 'Listo para\nviajar',
    capstoneMicro: 'No queda nada por configurar. Disfruta del viaje.',
    stampDate: (monthIndex, day) => `${day} ${ES_MONTHS[monthIndex]}`,
  },

  peak: {
    micro: 'Sin señal en ningún momento.',
    settled: 'pagado sin señal',
  },
};
