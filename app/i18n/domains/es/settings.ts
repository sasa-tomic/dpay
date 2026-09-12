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
  escToClose: 'Pulsa Esc para cerrar',

  backup: {
    ...copyWordsEs,
    label: 'Copia de seguridad',
    warning: 'Esta semilla recupera TANTO tus fondos en IC como los de Solana. Guárdala en un lugar seguro. No la compartas nunca.',
    copyWordsHint: 'Copia tus 24 palabras de recuperación al portapapeles',
    copySeed: 'Copiar semilla',
    seedCopied: 'Semilla copiada',
    seedShared: 'Semilla compartida',
    copySeedHint: 'Copia tu semilla de recuperación al portapapeles',
    showAsHex: 'Ver en hex',
    showAsHexA11y: 'Ver la semilla en hex',
    showAsHexHint: 'Cambia a la vista de la semilla de 64 caracteres hex',
    showAsWords: 'Ver en palabras',
    showAsWordsA11y: 'Ver la semilla en palabras',
    showAsWordsHint: 'Cambia a la vista de la frase de recuperación de 24 palabras',
    hide: 'Ocultar',
    hideA11y: 'Ocultar la semilla',
    reveal: 'Mostrar semilla',
    revealA11y: 'Mostrar la semilla de recuperación',
    revealHint: 'Muestra tu semilla en pantalla: cualquiera que la vea puede copiarla',
    cancelA11y: 'Cancelar la copia de seguridad',
    action: 'Hacer una copia de seguridad de la billetera',
    entry: 'Copia de seguridad…',
    entryHint: 'Muestra tu semilla de recuperación: sirve de copia de seguridad de tus fondos en IC y en Solana',
  },

  restore: {
    label: 'Restaurar',
    warning:
      'Esto sustituye tu billetera actual por la que se recupera con esta semilla. Si aún no lo has hecho, haz primero una copia de seguridad de la actual: a sus fondos solo se llega con su propia semilla.',
    seedPlaceholder: '24 palabras de recuperación o 64 caracteres hex',
    seedA11y: 'Semilla de recuperación',
    seedHint: 'Tus 24 palabras de recuperación (o la semilla de 64 hex de Copia de seguridad) que recuperan tu billetera',
    action: 'Restaurar billetera',
    actionHint: 'Sustituye tu billetera actual por la que se recupera con esta semilla',
    busy: 'Restaurando…',
    cancelA11y: 'Cancelar la restauración',
    entry: 'Restaurar billetera…',
    entryHint: 'Importa una billetera desde tu semilla de 64 hex: sustituye la actual',
    errEmpty: 'Introduce tus 24 palabras de recuperación o la semilla de 64 hex.',
    errWords:
      'Hay palabras incorrectas o que faltan. Revisa que estén las 24 y bien escritas, o pega la semilla de 64 hex.',
  },

  reset: {
    label: 'Borrar',
    warning:
      'Esto borra la identidad de tu billetera de este dispositivo. Los fondos de esta dirección quedarán irrecuperables. No se puede deshacer.',
    confirm: 'Sí, borrarlo todo',
    confirmHint: 'Borra tu billetera de este dispositivo de forma permanente: los fondos quedarán irrecuperables',
    cancelA11y: 'Cancelar el borrado',
    action: 'Borrar billetera',
    entry: 'Borrar billetera…',
    entryHint: 'Abre un diálogo de confirmación: borra tu billetera de este dispositivo de forma permanente',
  },

  learn: {
    label: 'Aprende',
    passportHint: 'Muestra tu pasaporte de preparación del viaje: los cuatro sellos',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Vuelve a mostrar las tres escenas sobre cómo se paga con dpay',
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
    serverNote: 'Los servidores con los que habla tu billetera, una dirección por línea en orden de prioridad. Si el primero no responde, se usa el siguiente. Los cambios se aplican al tocar Aplicar.',
    serverLabel: 'Servidor',
    serverPlaceholder: 'http://<ip>:8787',
    serverHint: 'El servidor con el que habla tu billetera',
    apply: 'Aplicar',
    applyA11y: 'Aplicar la URL del servidor',
    applyHint: 'Cambia tu billetera a la URL de servidor introducida',
    solanaNote: 'El endpoint de Solana con el que esta billetera lee saldos y envía pagos. Déjalo vacío para seguir el relay de tu lista de servidores; pon tu propio proveedor para sacar a dpay del camino.',
    solanaLabel: 'Endpoint de Solana',
    solanaPlaceholder: 'https://<proveedor>/?api-key=<clave>',
    solanaHint: 'El endpoint RPC de Solana que usa esta billetera',
    solanaApplyA11y: 'Aplicar el endpoint de Solana',
    solanaApplyHint: 'Cambia esta billetera al endpoint de Solana introducido',
    // F2 — el override de la pasarela IC. Solo para operadores (demos/pruebas contra una réplica
    // local), no es una función de usuario; la nota lo dice con honestidad, como la línea de
    // Solana de arriba.
    icGatewayNote: 'Solo para operadores: la URL base a la que esta billetera envía las transacciones de Internet Computer. Déjala vacía para usar la pasarela IC pública; pon la dirección de una réplica local (p. ej. para una demo o pruebas contra una red local) para dirigir allí pagos y lecturas de saldos. No hace falta para el uso normal.',
    icGatewayLabel: 'Pasarela IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayHint: 'La pasarela IC a la que esta billetera envía las transacciones',
    icGatewayApplyA11y: 'Aplicar la pasarela IC',
    icGatewayApplyHint: 'Cambia esta billetera a la pasarela IC introducida',
  },

  about: {
    label: 'Acerca de',
    custody:
      'dpay no es custodio de tus fondos. Tu dinero lo controla únicamente la clave de este dispositivo. No existe ninguna cuenta de dpay, y dpay no puede mover, congelar ni recuperar tus fondos. Tus 24 palabras de recuperación son la única forma de recuperarlo.',
    privacy: 'Política de privacidad',
  },
};

export const onboardingEs: OnboardingMessages = {
  tagline: 'Acerca o escanea para pagar, con o sin conexión.',
  custody: 'Sin cuentas. Tu clave nunca sale de este teléfono. Ni siquiera dpay puede mover tu dinero.',
  continue: 'Continuar',
  errOwnSeed:
    'Esa semilla no parece correcta. Pega tus 24 palabras de recuperación o la semilla de 64 hex tal como las anotaste.',
  errWords: 'Hay palabras incorrectas o que faltan. Revisa que estén las 24 y bien escritas.',
  errSaveWallet: 'Este teléfono no pudo guardar tu monedero, así que todavía no se ha creado. Tus palabras siguen en pantalla: vuelve a tocar Continuar. Si sigue fallando, libera espacio de almacenamiento en el teléfono.',

  recoverySaved: {
    stamp: 'Copia guardada',
    line: 'Solo estas palabras pueden recuperar tu billetera.',
    sub: 'Las tienes tú. Nadie más.',
  },

  backup: {
    ...copyWordsEs,
    title: 'Haz una copia de seguridad',
    ritual:
      'Este es el momento en el que tu billetera pasa a ser de verdad tuya: solo estas palabras pueden recuperar tu dinero.',
    warning:
      'Anota estas 24 palabras y guárdalas en un lugar seguro. Son la ÚNICA forma de recuperar tu billetera si pierdes este dispositivo. No hay ninguna cuenta de dpay a la que volver a entrar. Si pierdes estas palabras y este teléfono, tu dinero desaparece. Ni siquiera nosotros podemos recuperarlo.',
    copyWordsHint: 'Copia las 24 palabras de recuperación al portapapeles, sin los números de posición',
    ack: 'He anotado las 24 palabras',
  },

  restore: {
    phraseLabel: 'Frase de recuperación',
    phrasePlaceholder: 'Introduce tus 24 palabras de recuperación',
    phraseHint: 'Las 24 palabras de recuperación de tu copia de seguridad',
    phraseNote: 'Introduce las 24 palabras de tu copia de seguridad. Una sola semilla recupera tus fondos en IC y en Solana.',
    seedLabel: 'Semilla de recuperación',
    seedPlaceholder: '64 caracteres hex',
    seedHint: 'La semilla de 64 hex que muestra Copia de seguridad y que recupera tu billetera',
    seedNote: 'Una sola semilla recupera tus fondos en IC y en Solana.',
    enterHex: 'Usar hex en su lugar',
    enterWords: 'Usar palabras en su lugar',
    action: 'Restaurar billetera',
    busy: 'Restaurando…',
    hintMnemonic: 'Recupera tu billetera con tus 24 palabras de recuperación',
    hintHex: 'Recupera tu billetera con la semilla de recuperación',
    cancelA11y: 'Cancelar la restauración',
    cancelHint: 'Vuelve a la creación de una billetera nueva',
    entryHint: 'Recupera una billetera con tu frase de recuperación de 24 palabras',
  },

  usernameLabel: 'Elige un nombre de usuario',
  usernamePlaceholder: 'p. ej. Ana',
  usernameA11y: 'Nombre de usuario',
  usernameHint: 'El nombre que ven los demás cuando solicitas o recibes un pago',

  ownSeed: {
    useOwn: 'Usar mi propia semilla',
    useRandom: 'Generar una semilla aleatoria',
    toggleHint:
      'Muestra un campo para pegar las 24 palabras de recuperación o la semilla de 64 hex de una billetera existente, en lugar de generar una nueva',
    placeholder: 'Tus 24 palabras o semilla de 64 hex',
    a11y: 'Semilla propia',
    hint: 'Opcional: las 24 palabras de recuperación o la semilla de 64 hex con las que crear esta billetera, en lugar de una nueva aleatoria',
    note: 'Déjalo vacío para generar una semilla aleatoria nueva.',
  },

  create: {
    action: 'Crear billetera',
    busy: 'Creando…',
    hint: 'Crea una clave de billetera en este dispositivo; no requiere depósito ni compra',
  },

  demoNote: 'Crear la billetera no deposita, compra ni mueve dinero.',
  demoGlyphNote: ' es dinero de práctica sin valor: ∂1 es solo una unidad DEMO.',
};
