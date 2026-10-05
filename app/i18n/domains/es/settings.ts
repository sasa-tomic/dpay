/**
 * i18n/domains/es/settings.ts - Spanish values for the Settings sheet + the Onboarding flow.
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
    warning: 'Recupera tus fondos en IC y en Solana. Guárdala en un lugar seguro, no la compartas nunca.',
    copyWordsHint: 'Copia las 24 palabras',
    copySeed: 'Copiar semilla',
    seedCopied: 'Semilla copiada',
    seedShared: 'Semilla compartida',
    copySeedHint: 'Copia la semilla',
    showAsHex: 'Ver en hex',
    showAsHexA11y: 'Ver la semilla en hex',
    showAsWords: 'Ver en palabras',
    showAsWordsA11y: 'Ver la semilla en palabras',
    hide: 'Ocultar',
    hideA11y: 'Ocultar la semilla',
    reveal: 'Mostrar semilla',
    revealA11y: 'Mostrar la semilla de recuperación',
    revealHint: 'Cualquiera que la vea puede copiarla',
    cancelA11y: 'Cancelar la copia de seguridad',
    action: 'Hacer una copia de seguridad de la billetera',
    entry: 'Copia de seguridad…',
    entryHint: 'Muestra tu semilla de recuperación',
  },

  restore: {
    label: 'Restaurar',
    warning:
      'Sustituye tu billetera actual. Haz antes copia de la actual: su dinero solo se alcanza con su semilla.',
    seedPlaceholder: '24 palabras de recuperación o 64 caracteres hex',
    seedA11y: 'Semilla de recuperación',
    seedHint: '24 palabras de recuperación o la semilla de 64 hex de Copia de seguridad',
    action: 'Restaurar billetera',
    actionHint: 'Sustituye tu billetera actual',
    busy: 'Restaurando…',
    cancelA11y: 'Cancelar la restauración',
    entry: 'Restaurar billetera…',
    entryHint: 'Sustituye tu billetera actual',
    errEmpty: 'Introduce tus 24 palabras de recuperación o la semilla de 64 hex.',
    errWords:
      'Hay palabras incorrectas o que faltan. Revisa las 24, o pega la semilla de 64 hex.',
  },

  reset: {
    label: 'Borrar',
    warning:
      'Borra esta billetera de este dispositivo. Su dinero quedará irrecuperable.',
    confirm: 'Borrarlo todo',
    cancelA11y: 'Cancelar el borrado',
    action: 'Borrar billetera',
    entry: 'Borrar billetera…',
    entryHint: 'Borra la billetera de este dispositivo',
  },

  learn: {
    label: 'Aprende',
    passportHint: 'Abre el pasaporte',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Vuelve a mostrar la guía',
  },

  addressBook: {
    label: 'Libreta de direcciones',
    entry: 'Direcciones guardadas…',
    entryHint: 'Ver, nombrar y eliminar direcciones guardadas',
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
    show: 'Mostrar avanzado',
    hide: 'Ocultar avanzado',
    hint: 'Servidores y endpoints de red',
    serverNote: 'Una por línea; se usa la primera que responde. Aplicar para guardar.',
    serverLabel: 'Servidor',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Aplicar',
    applyA11y: 'Aplicar la URL del servidor',
    solanaNote: 'Lee saldos y envía pagos. Vacío sigue tu lista de servidores; un proveedor tuyo saca a dpay del camino.',
    solanaLabel: 'Endpoint de Solana',
    solanaPlaceholder: 'https://<proveedor>/?api-key=<clave>',
    solanaApplyA11y: 'Aplicar el endpoint de Solana',
    evmNote: 'Liquida ZCHF en Ethereum y Arbitrum One a través del relé de dpay. Vacío sigue el servidor; un endpoint sirve TODAS las cadenas  -  debe probar primero la cadena correcta.',
    evmLabel: 'Endpoint EVM (todas las cadenas)',
    evmPlaceholder: 'https://<proveedor>',
    evmApplyA11y: 'Aplicar el endpoint EVM',
    // F2 - el override de la pasarela IC. Solo para operadores (demos/pruebas contra una réplica
    // local), no es una función de usuario; la nota lo dice con honestidad, como la línea de
    // Solana de arriba.
    icGatewayNote: 'Solo para operadores. Vacío usa la pasarela pública; pon una réplica local para demos y pruebas.',
    icGatewayLabel: 'Pasarela IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'Aplicar la pasarela IC',
  },

  about: {
    label: 'Acerca de',
    custody:
      'Sin custodia: tu dinero lo controla únicamente la clave de este dispositivo. No hay cuenta de dpay. dpay no puede moverlo, congelarlo ni recuperarlo: tus 24 palabras de recuperación son la única forma de recuperarlos.',
    privacy: 'Política de privacidad',
  },
};

export const onboardingEs: OnboardingMessages = {
  tagline: 'Acerca o escanea para pagar, con o sin conexión.',
  custody: 'Sin cuentas. Tu clave nunca sale de este teléfono. Ni siquiera dpay puede mover tu dinero.',
  continue: 'Continuar',
  errOwnSeed:
    'Esa semilla no parece correcta. Pega tus 24 palabras de recuperación o la semilla de 64 hex tal cual.',
  errWords: 'Hay palabras incorrectas o que faltan. Revisa las 24.',
  errSaveWallet: 'Tu billetera no se guardó. Vuelve a tocar Continuar para reintentarlo. Si sigue fallando, libera espacio de almacenamiento en el teléfono.',

  recoverySaved: {
    stamp: 'Copia guardada',
    line: 'Solo estas palabras pueden recuperar tu billetera.',
  },

  backup: {
    ...copyWordsEs,
    title: 'Haz una copia de seguridad',
    warning:
      'Anota estas 24 palabras y guárdalas en un lugar seguro. Son la única forma de recuperar esta billetera: ni siquiera dpay puede recuperarlas.',
    copyWordsHint: 'Copia las 24 palabras',
    ack: 'He anotado las 24 palabras',
  },

  restore: {
    phraseLabel: 'Frase de recuperación',
    phrasePlaceholder: 'Introduce tus 24 palabras de recuperación',
    phraseNote: 'Recupera tus fondos en IC y en Solana.',
    seedLabel: 'Semilla de recuperación',
    seedPlaceholder: '64 caracteres hex',
    seedHint: 'La semilla de 64 hex que muestra Copia de seguridad',
    seedNote: 'Recupera tus fondos en IC y en Solana.',
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
  usernameHint: 'El nombre que ven los demás',

  ownSeed: {
    useOwn: 'Usar mi semilla',
    useRandom: 'Generar una semilla aleatoria',
    toggleHint: 'Pega la semilla de una billetera existente',
    placeholder: 'Tus 24 palabras o semilla de 64 hex',
    a11y: 'Elegir mi semilla',
    hint: 'La semilla con la que crear esta billetera',
    note: 'Déjalo vacío para generar una.',
  },

  create: {
    action: 'Crear billetera',
    busy: 'Creando…',
  },

  demoNote: 'Crear la billetera no mueve dinero.',
  demoGlyphNote: ' es dinero de práctica sin valor: ∂1 es solo una unidad DEMO.',
};
