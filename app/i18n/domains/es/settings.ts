/**
 * i18n/domains/es/settings.ts — Spanish values for the Settings sheet + the Onboarding flow.
 *
 * Reference copy, types and rationale: domains/en/settings.ts. Glossary: i18n/es.ts.
 */
import type {CopyWordsCopy, OnboardingMessages, SettingsMessages} from '../../keys';

const copyWordsEs: CopyWordsCopy = {
  copyWords: 'Copiar palabras',
  wordsCopied: 'Palabras copiadas',
  wordsShared: 'Palabras compartidas',
  copiedCheck: 'Copiado ✓',
  sharedCheck: 'Compartido ✓',
};

export const settingsEs: SettingsMessages = {
  title: 'Ajustes',
  close: 'Cerrar ajustes',

  backup: {
    ...copyWordsEs,
    label: 'Copia de seguridad',
    warning: 'Esta semilla recupera TANTO tus fondos en IC como los de Solana. Guárdala en un lugar seguro, no la compartas nunca.',
    copyWordsHint: 'Copia tus 24 palabras de recuperación al portapapeles',
    copySeed: 'Copiar semilla',
    seedCopied: 'Semilla copiada',
    seedShared: 'Semilla compartida',
    copySeedHint: 'Copia tu semilla de recuperación al portapapeles',
    showAsHex: 'Ver en hex',
    showAsHexA11y: 'Ver la semilla en hex',
    showAsWords: 'Ver en palabras',
    showAsWordsA11y: 'Ver la semilla en palabras',
    hide: 'Ocultar',
    hideA11y: 'Ocultar la semilla',
    reveal: 'Mostrar semilla',
    revealA11y: 'Mostrar la semilla de recuperación',
    revealHint: 'Muestra tu semilla en pantalla: cualquiera que la vea puede copiarla',
    cancelA11y: 'Cancelar la copia de seguridad',
    action: 'Hacer una copia de seguridad de la billetera',
    entry: 'Copia de seguridad…',
    entryHint: 'Muestra tu semilla de recuperación',
  },

  restore: {
    label: 'Restaurar',
    warning:
      'Sustituye tu billetera actual por la de esta semilla. Haz antes copia de la actual: su dinero solo se alcanza con su propia semilla.',
    seedPlaceholder: '24 palabras de recuperación o 64 caracteres hex',
    seedA11y: 'Semilla de recuperación',
    seedHint: 'Tus 24 palabras de recuperación, o la semilla de 64 hex de Copia de seguridad',
    action: 'Restaurar billetera',
    actionHint: 'Sustituye tu billetera actual',
    busy: 'Restaurando…',
    cancelA11y: 'Cancelar la restauración',
    entry: 'Restaurar billetera…',
    entryHint: 'Importa una billetera desde una semilla: sustituye la actual',
    errEmpty: 'Introduce tus 24 palabras de recuperación o la semilla de 64 hex.',
    errWords:
      'Hay palabras incorrectas o que faltan. Revisa que las 24 estén bien escritas, o pega la semilla de 64 hex.',
  },

  reset: {
    label: 'Borrar',
    warning:
      'Esto borra tu billetera de este dispositivo. El dinero de esta dirección quedará irrecuperable.',
    confirm: 'Sí, borrarlo todo',
    cancelA11y: 'Cancelar el borrado',
    action: 'Borrar billetera',
    entry: 'Borrar billetera…',
    entryHint: 'Borra tu billetera de este dispositivo de forma permanente',
  },

  learn: {
    label: 'Aprende',
    passportHint: 'Muestra tu pasaporte de preparación del viaje',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Vuelve a mostrar la guía sobre cómo se paga con dpay',
  },

  addressBook: {
    label: 'Libreta de direcciones',
    entry: 'Direcciones guardadas…',
    entryHint: 'Nombrar, añadir y eliminar las direcciones a las que has enviado',
  },

  theme: {
    label: 'Tema',
    light: 'Claro',
    dark: 'Oscuro',
    auto: 'Auto',
    choice: label => `Tema: ${label}`,
  },

  language: {
    label: 'Idioma',
    auto: 'Auto',
    choice: label => `Idioma: ${label}`,
  },

  advanced: {
    label: 'Avanzado',
    show: 'Mostrar los ajustes avanzados',
    hide: 'Ocultar los ajustes avanzados',
    hint: 'Servidores y endpoints de red con los que habla esta billetera',
    serverNote: 'Una dirección por línea. Se usa la primera que responde. Toca Aplicar para guardar.',
    serverLabel: 'Servidor',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Aplicar',
    applyA11y: 'Aplicar la URL del servidor',
    solanaNote: 'Lee saldos y envía pagos por Solana. Vacío sigue tu lista de servidores; tu propio proveedor saca a dpay del camino.',
    solanaLabel: 'Endpoint de Solana',
    solanaPlaceholder: 'https://<proveedor>/?api-key=<clave>',
    solanaApplyA11y: 'Aplicar el endpoint de Solana',
    evmNote: 'Lee saldos y liquida ZCHF en Ethereum y Arbitrum One a través del relé de dpay. Vacío sigue el servidor; tu propio endpoint sirve TODAS las cadenas — debe demostrar la cadena correcta antes de enviar nada.',
    evmLabel: 'Endpoint EVM (todas las cadenas)',
    evmPlaceholder: 'https://<proveedor>',
    evmApplyA11y: 'Aplicar el endpoint EVM',
    // F2 — el override de la pasarela IC. Solo para operadores (demos/pruebas contra una réplica
    // local), no es una función de usuario; la nota lo dice con honestidad, como la línea de
    // Solana de arriba.
    icGatewayNote: 'Solo para operadores: la URL base a la que esta billetera envía las transacciones IC. Vacío usa la pasarela pública; pon una réplica local para demos y pruebas.',
    icGatewayLabel: 'Pasarela IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'Aplicar la pasarela IC',
  },

  about: {
    label: 'Acerca de',
    custody:
      'dpay no es custodio de tu dinero: lo controla únicamente la clave de este dispositivo. No existe ninguna cuenta de dpay. dpay no puede moverlo, congelarlo ni recuperarlo: tus 24 palabras de recuperación son la única forma de recuperarlos.',
    privacy: 'Política de privacidad',
  },
};

export const onboardingEs: OnboardingMessages = {
  tagline: 'Acerca o escanea para pagar, con o sin conexión.',
  custody: 'Sin cuentas. Tu clave nunca sale de este teléfono. Ni siquiera dpay puede mover tu dinero.',
  continue: 'Continuar',
  errOwnSeed:
    'Esa semilla no parece correcta. Pega tus 24 palabras de recuperación o la semilla de 64 hex tal como las anotaste.',
  errWords: 'Hay palabras incorrectas o que faltan. Revisa que las 24 estén bien escritas.',
  errSaveWallet: 'Este teléfono no pudo guardar tu billetera, así que todavía no se ha creado. Vuelve a tocar Continuar para reintentarlo. Si sigue fallando, libera espacio de almacenamiento en el teléfono.',

  recoverySaved: {
    stamp: 'Copia guardada',
    line: 'Solo estas palabras pueden recuperar tu billetera.',
  },

  backup: {
    ...copyWordsEs,
    title: 'Haz una copia de seguridad',
    warning:
      'Anota estas 24 palabras y guárdalas en un lugar seguro. Son la ÚNICA forma de recuperar tu billetera si pierdes este dispositivo: no hay cuenta de dpay, y ni siquiera dpay puede recuperarlas.',
    copyWordsHint: 'Copia las 24 palabras sin los números de posición',
    ack: 'He anotado las 24 palabras',
  },

  restore: {
    phraseLabel: 'Frase de recuperación',
    phrasePlaceholder: 'Introduce tus 24 palabras de recuperación',
    phraseNote: 'Una sola semilla recupera tus fondos en IC y en Solana.',
    seedLabel: 'Semilla de recuperación',
    seedPlaceholder: '64 caracteres hex',
    seedHint: 'La semilla de 64 hex que muestra Copia de seguridad',
    seedNote: 'Una sola semilla recupera tus fondos en IC y en Solana.',
    enterHex: 'Usar hex en su lugar',
    enterWords: 'Usar palabras en su lugar',
    action: 'Restaurar billetera',
    busy: 'Restaurando…',
    cancelA11y: 'Cancelar la restauración',
    cancelHint: 'Vuelve a la creación de una billetera nueva',
    entryHint: 'Recupera una billetera desde tu copia de seguridad',
  },

  usernameLabel: 'Elige un nombre de usuario',
  usernamePlaceholder: 'p. ej. Ana',
  usernameA11y: 'Nombre de usuario',
  usernameHint: 'El nombre que ven los demás cuando solicitas o recibes un pago',

  ownSeed: {
    useOwn: 'Usar mi propia semilla',
    useRandom: 'Generar una semilla aleatoria',
    toggleHint: 'Pega la semilla de una billetera existente en lugar de generar una',
    placeholder: 'Tus 24 palabras o semilla de 64 hex',
    a11y: 'Semilla propia',
    hint: 'Opcional: la semilla con la que crear esta billetera',
    note: 'Déjalo vacío para generar una semilla aleatoria nueva.',
  },

  create: {
    action: 'Crear billetera',
    busy: 'Creando…',
  },

  demoNote: 'Crear la billetera no deposita, compra ni mueve dinero.',
  demoGlyphNote: ' es dinero de práctica sin valor: ∂1 es solo una unidad DEMO.',
};
