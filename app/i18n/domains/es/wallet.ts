/**
 * i18n/domains/es/wallet.ts — Spanish values for the `wallet` + `education` domains.
 *
 * Reference copy, types and rationale: domains/en/wallet.ts. Glossary: i18n/es.ts.
 */
import type {EducationMessages, WalletMessages} from '../../keys';

export const walletEs: WalletMessages = {
  header: {
    settings: 'Ajustes',
    themeSwitch: target => `Cambiar el tema a ${target}`,
    home: 'Inicio de dpay',
  },

  balance: {
    label: 'Saldos',
    lockedHint: 'Primero termina o cancela el pago en curso',
    approx: asset => `~ ${asset} aprox.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Pulsa atrás otra vez para salir',
  },

  homeCurrency: {
    name: {CHF: 'Francos suizos', USD: 'Dólares estadounidenses', EUR: 'Euros', BTC: 'Bitcoin', ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana'},
    chooseTitle: '¿En qué moneda piensas?',
    chooseBody: 'Solo vista.',
    railReason: {destination: 'es el que pide el cobro', funded: 'tienes saldo aquí'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principal',
    settingsTitle: 'Moneda principal',
    settingsHint: 'Se muestra primero; por defecto al pagar.',
    confirm: 'Continuar',
    pickFirst: 'Elige antes una moneda.',
    noneAvailable: 'No se cargó ninguna moneda. Revisa la dirección del servidor en Ajustes y vuelve a abrir dpay.',
    a11y: currency => `Elegir ${currency}`,
  },

  railHealth: {
    thin: 'Baja liquidez',
    deep: 'Circula ampliamente.',
  },

  railDetail: {
    back: 'Atrás',
    rampNone: 'Sin rampa fiduciaria — de wallet a wallet.',
    rampSellPartner: partner => `${partner} — hoy solo venta.`,
    rampBothDirect: 'Depósito y retiro están integrados.',
  },

  tab: {pay: 'Pagar', receive: 'Recibir', transactions: 'Movimientos', home: 'Inicio'},

  home: {
    actions: {
      addFunds: 'Depositar',
      convert: 'Convertir',
      withdraw: 'Retirar',
      more: 'Más',
    },
    balanceEyebrow: code => `Saldo ${code}`,
    menu: {
      ledger: 'Movimientos',
      remove: 'Quitar',
      close: 'Cerrar',
    },
    removeRefusal: {
      nonzero: amount => `Convierte o mueve ${amount} primero.`,
      unreadable: 'Saldo ilegible. Reconéctate e inténtalo de nuevo.',
      last: 'Debe quedar al menos una moneda.',
    },
    activity: {
      title: 'Actividad',
      seeAll: 'Ver todo',
    },
    accounts: {
      openLabel: 'Abrir cuentas',
    },
  },

  accounts: {
    title: 'Cuentas',
    intro: 'Toca una moneda para hacerla principal.',
    back: 'Atrás',
    practice: 'Dinero de práctica. Ninguna tienda lo acepta.',
    convertHint: 'Convertir en un servicio externo',
    setMainHint: 'La convierte en tu moneda principal',
    addCurrency: 'Añadir moneda',
  },

  addCurrency: {
    title: 'Añadir moneda',
    search: 'Buscar',
    stable: 'Monedas estables',
    other: 'Otras',
    inWallet: 'En la billetera',
    add: 'Añadir',
    none: 'Sin coincidencias.',
  },

  addressBook: {
    title: 'Libreta de direcciones',
    intro: 'Guardadas solo en este dispositivo.',
    back: 'Atrás',
    empty: 'Aún no hay direcciones guardadas. Las que uses para enviar aparecen aquí automáticamente.',
    addEntry: 'Añadir dirección',
    assetLabel: 'Para',
    addressLabel: 'Dirección',
    addressPlaceholder: 'Pega la dirección',
    addressHint: 'Exactamente como la usarías para enviar',
    nameLabel: 'Nombre',
    namePlaceholder: 'p. ej. Alice',
    save: 'Guardar',
    rename: 'Renombrar',
    renameHint: who => `Renombrar ${who}`,
  },

  backToPaying: asset => `Volver a pagar con ${asset}`,

  faucet: {
    unavailableOnRelay: 'Recarga no disponible en este servidor',
    failed: 'Falló la recarga',
    unavailable: 'Recarga no disponible',
    offline: 'Sin conexión: inténtalo cuando vuelvas a conectarte',
  },

  balances: {
    demoFunds: 'Fondos de prueba',
    demoFundsLabel: 'Conseguir fondos de prueba',
    demoFundsHint: 'Añade ∂100 de prueba',
    needsSetup: 'Sin configurar',
    select: symbol => `Seleccionar ${symbol}`,
    selectHint: 'Se usa en Pagar y Recibir',
    showTestnet: 'Mostrar activos de testnet',
    hideTestnet: 'Ocultar activos de testnet',
  },

  ledger: {
    empty: 'Todavía no hay pagos.',
    emptyHint: 'Toca Recibir para solicitar, o Pagar para escanear.',
    recent: 'Recientes',
    allAssets: 'Todos los activos',
    all: 'Todos',
    filter: label => `Filtrar ${label}`,
    to: who => `a ${who}`,
    from: who => `de ${who}`,
    fromPool: 'de un pool',
    toPool: 'a un pool',
    fees: fee => `− ${fee} de comisiones`,
    mintCounterparty: 'Fondos de prueba',
    failed: 'Falló — solo se cobró la comisión',
    dropped: count => count === 1
      ? 'No se pudo leer 1 transacción de Solana: sigue existiendo on-chain.'
      : `No se pudieron leer ${count} transacciones de Solana: siguen existiendo on-chain.`,
  },

  fund: {checking: 'Revisando…', checkAgain: 'Revisar de nuevo'},

  asset: {
    demoSubtitle: 'dinero ficticio para pruebas',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    bridgedLabel: (symbol, from, to) => `${symbol} · ${from} → ${to}`,
    unsupported: 'No admitido',
    testnetName: base => `${base} testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Compartido ✓'},
};

/** Month abbreviations for the passport stamp date, in Spanish. */
const ES_MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export const educationEs: EducationMessages = {
  campaignLine: '¿Señal? No hace falta.',
  howItWorksTitle: 'Cómo funciona dpay',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'Primero, cómo funciona un pago',
        title: 'Un teléfono solicita y el otro paga',
        body: 'El otro teléfono muestra una solicitud. La escaneas, compruebas el importe y apruebas. Su conexión envía el pago si el tuyo está sin conexión.',
      },
      key: {
        eyebrow: 'Tu dinero',
        title: 'Tu clave se queda en este dispositivo',
        body: 'dpay no guarda dinero ni puede aprobar pagos. No hay ninguna cuenta de dpay: solo tu clave.',
      },
      exact: {
        eyebrow: 'Sin sorpresas',
        title: 'Paga el activo exacto que te piden',
        body: 'La tienda pide un activo exacto. Tú revisas el importe y lo apruebas. dpay nunca convierte.',
      },
    },
    stageTags: ['Señal', 'Clave', 'Activo'],
    close: 'Cerrar Cómo funciona dpay',
    skip: 'Saltar la introducción',
    back: 'Atrás',
    next: 'Siguiente',
    getStarted: 'Empezar',
    shopRequests: 'La tienda pide',
  },

  practice: {
    sheetTitle: 'Pago de práctica',
    eyebrow: 'Práctica',
    payeeName: 'Tienda de práctica',
    title: 'Haz un pago de verdad',
    cardLine: 'El código que muestra una tienda.',
    balance: amount => `${amount} en dinero de práctica.`,
    review: 'Revisar el pago',
    skip: 'Saltar la práctica',
    bothSides: 'La práctica necesita conexión: tu teléfono hace los dos papeles. En un viaje, solo la tienda.',
    settledBody: 'Tu teléfono lo firmó y la red de práctica lo confirmó.',
    settledBalance: amount => `Te quedan ${amount} en dinero de práctica.`,
    pendingBody: 'Firmado y enviado, aún sin confirmar: no hay nada confirmado. Así se ve un pago pendiente.',
    refusedTitle: 'Rechazado',
    refusedBody: 'No se movió nada.',
    continue: 'Seguir con la configuración',
    punchline: 'El dinero de práctica no tiene valor.',
    noFaucet: {
      title: 'Aquí no hay dinero de práctica',
      body: 'Este servidor no tiene ahora mismo. A tu billetera no le falta nada: sigue y elige tu moneda.',
    },
    cooldown: {
      title: 'Dinero de práctica, en un momento',
      body: reason => `Este servidor reparte dinero de práctica de vez en cuando, y acaba de hacerlo. Dice: ${reason} Sigue; vuelve cuando quieras.`,
    },
    offline: {
      title: 'La práctica necesita conexión',
      body: 'Tu teléfono hace los dos papeles. Vuelve a conectarte e inténtalo otra vez, o sigue con la configuración.',
    },
    empty: {
      title: 'Aún no hay dinero de práctica',
      body: 'A tu billetera no le falta nada: sigue y elige tu moneda.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Muéstraselo a tu cliente',
      body: 'Su teléfono lo escanea y lo aprueba; tu conexión lo confirma.',
    },
    offlineQr: {
      title: 'Firmado, no confirmado',
      body: 'Este código firmado es tu comprobante de pago. La conexión de quien lo recibe lo confirma; el estado se actualiza cuando vuelvas.',
    },
    pendingOutcome: {
      title: 'Todavía pendiente',
      body: 'El resultado aún no se sabe: nunca des por hecho que salió bien; vuelve a mirar aquí.',
    },
  },
  coachDismiss: title => `Descartar el consejo: ${title}`,
  coachDismissHint: 'Oculta este consejo; no volverá a aparecer',

  passport: {
    title: 'Preparación del viaje',
    stamps: {
      recoverySaved: {label: 'Copia\nhecha', hint: 'Copia tus palabras de recuperación en Ajustes', short: 'falta la copia de seguridad'},
      flowUnderstood: {label: 'Flujo\nvisto', hint: 'Haz el pago de práctica, o haz cualquier pago', short: 'falta ver cómo funciona'},
      fundsReady: {label: 'Fondos\ncargados', hint: 'Añade dinero que puedas gastar; los fondos de práctica no cuentan', short: 'falta añadir fondos'},
      paymentTested: {label: 'Primer\npago', hint: 'Completa un pago: paga o recibe', short: 'falta un pago'},
    },
    close: title => `Cerrar ${title}`,
    stripLabel: filled => `Preparación del viaje: ${filled} de 4`,
    count: filled => `${filled} de 4`,
    goToStep: hint => `Ir: ${hint}`,
    nextTag: 'Siguiente',
    nextLabel: hint => `Siguiente: ${hint}`,
    doneHint: 'Retira la barra',
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
