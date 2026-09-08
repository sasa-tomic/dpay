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
    hint: 'Abre la pestaña Inicio con todos los activos, cambia la moneda mostrada o recibe',
    lockedHint: 'Primero termina o cancela el pago en curso',
    of: asset => `Saldo de ${asset}`,
    approx: asset => `~ ${asset} aprox.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Pulsa atrás otra vez para salir',
  },

  homeCurrency: {
    name: {CHF: 'Francos suizos', USD: 'Dólares estadounidenses', EUR: 'Euros'},
    chooseTitle: '¿En qué moneda piensas?',
    chooseBody: 'Elige qué moneda aparece primero. Esto solo cambia la vista y los valores predeterminados; dpay no mueve ni convierte fondos.',
    railReason: {destination: 'es el que pide el cobro', funded: 'aquí tienes saldo'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principal',
    mainLabel: currency => `${currency} · Principal`,
    settingsTitle: 'Moneda principal',
    settingsHint: 'La moneda que dpay muestra primero y usa por defecto',
    confirm: 'Continuar',
    noneAvailable: 'No se pudo cargar ninguna moneda. Revisa la dirección del servidor en Ajustes y vuelve a abrir dpay.',
    a11y: currency => `Elegir ${currency}`,
  },

  railHealth: {
    thin: token => `Hoy hay muy poco ${token} on-chain: recibir puede ser difícil y pagar requiere a alguien que lo tenga.`,
    deep: 'Circula ampliamente on-chain hoy.',
  },

  railDetail: {
    back: 'Atrás',
    rampNone: 'Hoy no hay rampa fiduciaria — se mueve de wallet a wallet.',
    rampSellPartner: partner => `${partner} lista este token como vendible; comprar no está disponible hoy.`,
    rampBothDirect: 'Depósito y retiro a su cadena nativa están conectados en dpay.',
  },

  tab: {pay: 'Pagar', receive: 'Recibir', transactions: 'Movimientos', home: 'Inicio'},

  home: {
    actions: {
      pay: 'Pagar',
      payHint: 'Escanea un código o envía a una dirección',
      receive: 'Recibir',
      receiveHint: 'Pide un pago o muestra tu dirección',
      addMoney: 'Añadir dinero',
      addMoneyHint: 'Añade fondos a esta cartera',
    },
    activity: {
      title: 'Actividad',
      seeAll: 'Ver todo',
      seeAllHint: 'Abrir la lista completa de transacciones',
      empty: 'Aún no hay pagos.',
    },
    accounts: {
      title: 'Cuentas',
      intro: 'Toca una moneda para mostrarla en tu pantalla de inicio. Recíbela o envíala desde las pestañas Recibir y Pagar.',
    },
  },

  backToPaying: asset => `Volver a pagar con ${asset}`,

  faucet: {
    unavailableOnRelay: 'La recarga de prueba no está disponible en este servidor',
    failed: 'Falló la recarga',
    unavailable: 'Recarga no disponible',
    offline: 'Sin conexión: inténtalo cuando vuelvas a conectarte',
  },

  balances: {
    demoFunds: 'Fondos de prueba',
    demoFundsLabel: 'Conseguir fondos de prueba',
    demoFundsHint: 'Añade ∂100 de dinero de prueba a esta billetera',
    needsSetup: 'Sin configurar',
    railUnreadable: network =>
      `La red ${network} no responde ahora mismo, así que este saldo no se pudo actualizar. Es esa conexión, no tu billetera: tus fondos están intactos y tus otras cuentas siguen funcionando. dpay lo reintenta por su cuenta.`,
    select: symbol => `Seleccionar ${symbol}`,
    selectHint: 'Muestra el saldo de este activo en tu pantalla de inicio',
    selectSolanaHint: symbol => `Muestra ${symbol} en tu pantalla de inicio y usa la vía de Solana para Pagar y Recibir`,
    showTestnet: 'Mostrar activos de testnet',
    hideTestnet: 'Ocultar activos de testnet',
    showTestnetHint: 'Muestra las monedas de testnet en esta lista',
    hideTestnetHint: 'Oculta las monedas de testnet de esta lista',
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
    failed: 'Falló — solo se cobró la comisión de red',
    dropped: count => count === 1
      ? 'No se pudo leer 1 transacción de Solana — sigue existiendo on-chain, pero no se muestra aquí.'
      : `No se pudieron leer ${count} transacciones de Solana — siguen existiendo on-chain, pero no se muestran aquí.`,
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
        eyebrow: 'PRIMERO, CÓMO FUNCIONA UN PAGO',
        title: 'Un teléfono solicita y el otro paga',
        body: 'El teléfono que recibe muestra una solicitud. La escaneas, compruebas el importe y el activo y apruebas. Su conexión envía el pago si tu teléfono está sin conexión.',
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
    title: 'Practica un pago sin riesgo',
    sheetTitle: 'Práctica DEMO',
    steps: {
      request: {
        title: 'En el otro teléfono: solicita ∂1',
        body: 'Abre dpay en otro teléfono, elige DEMO, toca Recibir, introduce 1 y toca Solicitar.',
      },
      approve: {
        title: 'En este teléfono: escanea y comprueba',
        body: 'Elige DEMO, toca Pagar y escanea el código dpay del otro teléfono. Comprueba ∂1 y el destinatario antes de aprobar.',
      },
      settle: {
        title: 'Después cambia los papeles',
        body: 'Para practicar cómo recibir, crea una solicitud DEMO de ∂1 en este teléfono y escanéala con el otro.',
      },
    },
    stageTags: ['01 — RECIBIR', '02 — PAGAR', '03 — CAMBIAR'],
    punchline: 'DEMO es dinero de práctica sin valor. Esta introducción nunca te pide depositar ni comprar nada.',
    skip: 'Saltar la práctica',
    skipHint: 'Salta la práctica y elige tu moneda principal',
    try: 'Elegir mi moneda',
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
