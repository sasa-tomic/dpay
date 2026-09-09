/**
 * i18n/domains/es/deposit.ts — Spanish values for the deposit + withdraw surfaces.
 *
 * Reference copy, types and rationale: domains/en/deposit.ts. Glossary: i18n/es.ts.
 */
import type {DepositMessages, WithdrawMessages} from '../../keys';

/** Word-for-word identical on both sheets in Spanish too — one source, spread into both objects. */
const bothSheets = {
  pressEsc: 'Pulsa Esc para cerrar',
  balanceAuto: 'Tu saldo se actualiza automáticamente.',
  copied: 'Copiado ✓',
  shared: 'Compartido ✓',
  copyAddress: 'Copiar dirección',
  amountLabel: (asset: string) => `Importe (${asset})`,
};

export const depositEs: DepositMessages = {
  ...bothSheets,

  deposited: 'Depositado ✓',
  addressCopied: 'Dirección copiada',
  addressShared: 'Dirección compartida',
  checkNow: 'Revisar ahora',

  ck: {
    addressErr: 'No se pudo cargar tu dirección de depósito. Revisa tu conexión e inténtalo de nuevo.',
    noMinter: 'Este activo aún no admite depósitos.',
    fetchingAddress: 'Obteniendo tu dirección de depósito…',
    noAddress: 'No hay ninguna dirección de depósito disponible.',
    sendToAddress: (nativeAsset, networkLabel) => [
      {t: 'Envía '},
      {t: nativeAsset, em: true},
      {t: ' a tu dirección de '},
      {t: networkLabel, em: true},
      {t: ' que aparece abajo.'},
    ],
    confirmationLine: (required, estMin) =>
      `${required > 0 ? `~${required} ${required === 1 ? 'confirmación' : 'confirmaciones'}` : 'confirmaciones'}${estMin > 0 ? ` · normalmente ~${estMin} min` : ''}`,
    feeMinLine: (fee, min) => `Comisión de red ${fee} · Depósito mín. ${min}`,
    feeNone: 'ninguna',
    minNone: 'sin mínimo',
    custody: 'dpay nunca guarda tus claves: los fondos se emiten 1:1 en tu billetera al confirmarse.',
    copyDepositAddress: 'Copiar dirección de depósito',
    statusTitle: 'Estado',
    watching: 'Esperando tu depósito',
    checkingEvery: seconds => `se revisa cada ${seconds} s`,
    checkNowLabel: 'Revisar ahora el estado del depósito',
    mintedAmount: amount => `${amount} emitidos`,
  },

  icrc: {
    sendToAccount: (symbol, network) => [
      {t: 'Envía '},
      {t: symbol, em: true},
      {t: ' desde cualquier billetera de '},
      {t: network, em: true},
      {t: ' que lo soporte a tu cuenta de abajo.'},
    ],
    whereFrom: (symbol, network) =>
      `Envíalo desde cualquier app de billetera que tenga ${symbol} en ${network}, o retira ${symbol} de un exchange que admita la red ${network}.`,
    onlyAccepts: (symbol, network) =>
      `Esta dirección recibe ${symbol} enviado por ${network}: nada más, y ningún pago con tarjeta ni transferencia bancaria.`,
    noMemo: 'No hace falta memo ni referencia — una transferencia normal a esta cuenta es suficiente.',
    feeLine: fee => `Comisión de red ${fee}`,
    custody: asset => `dpay nunca guarda tus claves ni convierte — ${asset} llega directamente a tu billetera.`,
    receivedAmount: amount => `${amount} recibidos`,
    alsoTitle: '¿Ya está en Internet Computer?',
    alsoBody: symbol => [
      {t: 'Envía '},
      {t: symbol, em: true},
      {t: ' desde cualquier billetera de Internet Computer directamente a tu dirección IC de abajo — no hace falta memo.'},
    ],
  },

  erc20: {
    onrampParamsErr: 'No se pudo contactar con el servidor para obtener los datos del depósito.',
    deriveErr: 'No se pudo generar tu dirección de depósito. Cierra y vuelve a abrir esta pantalla.',
    noWalletWeb: 'No se encontró ninguna billetera de Ethereum. Instala MetaMask o Rabby en este navegador.',
    noWalletNative: 'No hay ninguna billetera conectada. Vincula una con WalletConnect.',
    pairRejected: 'No se aprobó la vinculación.',
    pairFailed: 'No se pudo vincular con tu billetera.',
    wrongNetwork: (networkLabel, expected, actual) =>
      `Red incorrecta: conéctate a ${networkLabel} (cadena ${expected}). Tu billetera está en la cadena ${actual}.`,
    connectFailed: 'No se pudo conectar con tu billetera. Abre tu app de billetera, aprueba allí la solicitud de conexión y vuelve a intentarlo.',
    noWalletApp: 'No se encontró ninguna app de billetera. Escanea el QR con una billetera en otro dispositivo.',
    walletDisconnected: 'Billetera desconectada.',
    amountRequired: 'Introduce un importe mayor que cero.',
    missingErc20Address: 'Los datos del depósito no incluyen la dirección ERC-20.',
    txReverted: 'La transacción se revirtió en la cadena.',
    txUnconfirmed: 'Transacción enviada, aún sin confirmar. Seguimos esperando la emisión.',
    approveReverted:
      'La aprobación se revirtió en la cadena: el depósito nunca se envió y no salió dinero de tu billetera. Vuelve a intentarlo; tu billetera pedirá primero la aprobación y después el depósito.',
    approveUnconfirmed:
      'La aprobación se envió pero no se confirmó: el depósito nunca se envió y no salió dinero de tu billetera. Espera un momento y vuelve a intentarlo; tu billetera pedirá la aprobación otra vez, es lo normal y solo cuesta gas.',
    depositHashUnknown:
      'Revisa la actividad reciente en tu app de billetera antes de volver a intentarlo: si el depósito está ahí, se acreditará en unos 20 minutos, y depositar otra vez enviaría el dinero dos veces.',
    approveHashUnknown:
      'No se hizo ningún depósito y no salió dinero de tu billetera. Revisa la actividad reciente en tu app de billetera y vuelve a intentarlo: pedirá primero la aprobación, es lo normal y solo cuesta gas.',
    txNotSigned: 'La transacción no se firmó.',
    txFailed: 'La transacción falló.',
    allowanceStands:
      'Tu aprobación de gasto ya está confirmada en la cadena y no salió dinero de tu billetera. Si lo intentas otra vez, tu billetera pedirá la aprobación y después el depósito, las dos firmas igual que antes.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Envía solo '},
      {t: nativeAsset, em: true},
      {t: ' en '},
      {t: networkLabel, em: true},
      {t: '. Otros activos u otras cadenas enviados por aquí no se acreditarán y podrían perderse.'},
    ],
    custody:
      'dpay nunca guarda tus claves: firma tu billetera y el activo se emite 1:1 en ella al confirmarse (~20 min).',
    gasNative: 'La comisión de red se paga en ETH: envía un poco más de lo que quieras depositar.',
    gasErc20: 'Necesitarás un poco de ETH para las comisiones de red de Ethereum.',
    scanToPair: 'Escanea con tu billetera para vincular',
    orOpenHere: 'O abre una billetera en este teléfono:',
    openNamedWallet: name => `Abrir ${name}`,
    otherWallet: 'Otra billetera',
    otherWalletHint:
      'Con «Otra billetera» es tu teléfono quien elige la app. La vinculación funciona, pero después dpay no podrá volver a abrirla por ti: tendrás que cambiar a ella tú mismo para aprobar el depósito.',
    couldntOpenWallet: name =>
      `No se pudo abrir ${name}; puede que ya no esté instalada. Elige otra billetera abajo o escanea el QR con una billetera en otro dispositivo.`,
    walletList: 'MetaMask · Trust · Rabby · cualquier billetera compatible con WalletConnect',
    explainNative:
      'Envía ETH directamente al contrato de depósito: una sola transacción que firma tu billetera, con el importe del depósito como valor en ETH.',
    explainErc20: nativeAsset =>
      `${nativeAsset} es un token de Ethereum: depositarlo requiere dos transacciones que firma tu billetera, no un envío a una dirección como en Bitcoin.`,
    connectLabel: 'Conectar billetera de Ethereum',
    connect: 'Conectar billetera',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `Desde ${shortAccount}`,
    confirmingLabel: 'Confirmando en tu billetera',
    switchToWalletApp: 'Tu billetera debería abrirse para aprobar. Si no lo hace, ábrela tú y vuelve aquí.',
    deposit: 'Depositar',
    approveDepositLabel: 'Aprobar y depositar',
    approveDeposit: 'Aprobar y depositar',
    confirming: 'Confirma en tu billetera…',
    depositingAmount: (amount, asset) => `Depositando ${amount} ${asset}`,
    watchingResumed:
      'Depósito pendiente (~20 min): tu billetera no está conectada, pero seguimos esperando la emisión.',
    watchingFresh: 'Esperando la confirmación: tu depósito aparecerá en unos 20 minutos.',
    startNew: 'Empezar otro depósito',
    mintedToWallet: asset => `${asset} emitido en tu billetera.`,
  },

  sol: {
    createAtaLabel: asset => `Crear cuenta de ${asset}`,
    checkingAta: asset => `Revisando tu cuenta de ${asset}…`,
    ataUnverified: asset => `No se pudo revisar tu cuenta de ${asset}.`,
    ataUnverifiedDetail: asset =>
      `Tu dirección está bien; lo que pasa es que ahora mismo no podemos contactar con Solana para confirmar tu cuenta de ${asset} en la cadena. Revisa tu conexión e inténtalo de nuevo.`,
    retryAtaLabel: asset => `Reintentar la revisión de la cuenta de ${asset}`,
    retryAtaHint: asset => `Vuelve a revisar si tu cuenta de ${asset} existe en la cadena`,
    checkAgain: 'Revisar de nuevo',
    backToRequest: 'Volver a la solicitud',
    sendToAddress: (asset, network) => [
      {t: 'Envía '},
      {t: asset, em: true},
      {t: ' a tu dirección de '},
      {t: network},
      {t: ' que aparece abajo.'},
    ],
    custody: asset => `dpay nunca guarda tus claves: ${asset} llega directamente a tu billetera al confirmarse.`,
    devnetWarn: asset =>
      `Estás en la devnet de Solana. NO envíes ${asset} de mainnet aquí: no aparecerá. Usa solo ${asset} de devnet.`,
    waitingDeposit: 'Esperando tu depósito · se revisa cada pocos segundos',
    checkNowHint: 'Vuelve a revisar tu saldo ahora mismo',
    balanceAutoOnConfirm: 'Tu saldo se actualiza automáticamente cuando se confirme el envío.',
    copyAssetAddress: asset => `Copiar dirección de ${asset}`,
    returnHint: 'Vuelve a la pestaña Pagar con este activo seleccionado',
  },

  ata: {
    absent: asset => `Todavía no tienes una cuenta de ${asset} en este dispositivo.`,
    cost: (setupCost, asset) =>
      `Solana guarda tus ${asset} en una cuenta de token única, ligada a esta billetera. Crearla cuesta ${setupCost} (renta de la cuenta + comisión) de tu saldo de SOL. La cuenta es tuya y está bajo tus claves: dpay nunca las guarda.`,
    checkingSol: 'Revisando tu saldo de SOL…',
    needSol: setupCost =>
      `Primero necesitas unos ${setupCost} en esta billetera: recibe SOL en tu dirección y luego crea la cuenta.`,
    showSolAddress: 'Ver mi dirección de SOL',
    creating: asset => `Creando tu cuenta de ${asset}. Confirmando en Solana…`,
    createHint: (setupCost, asset) => `Crea tu cuenta única de ${asset} por ${setupCost} de tu saldo de SOL`,
  },

  trust: {
    fund: 'Añadir desde Trust Wallet',
    fundHint: asset => `Abre Trust Wallet para enviar ${asset} a tu dirección de dpay`,
    err: 'No se pudo abrir Trust Wallet. Inténtalo de nuevo.',
  },

  funding: {
    title: '¿Todavía no tiene?',
    buyThenSend: (token, networkLabel) => [
      {t: 'Compre '},
      {t: token, em: true},
      {t: ' en cualquier exchange o proveedor de tarjeta que pague en '},
      {t: networkLabel, em: true},
      {t: ' y envíelo a la dirección de arriba. Llega a su propia cartera — dpay nunca lo recibe.'},
    ],
    buyThenConvert: (viaToken, target) => [
      {t: 'Ningún proveedor vende '},
      {t: target, em: true},
      {t: ' directamente. La ruta que funciona: compre '},
      {t: viaToken, em: true},
      {t: ' con tarjeta, envíelo a la dirección de arriba y use Convertir para cambiarlo por '},
      {t: target, em: true},
      {t: '. Ese cambio lo firma usted, y dpay no participa en él.'},
    ],
    testnetOnly: (symbol, networkLabel) => `${symbol} es dinero de prueba: no tiene valor y nadie lo vende. Consígalo gratis en un faucet público de ${networkLabel} y envíelo a la dirección de arriba.`,
    bankRoute: provider => `Desde una cuenta bancaria suiza, ${provider} lo vende directamente por transferencia. Requiere verificación de identidad completa y tarda lo que tarda una transferencia bancaria.`,
    providersTitle: 'Dónde se compra',
    costCard: rate => `tarjeta ${rate}`,
    costBank: rate => `banco ${rate}`,
    costMin: amount => `mín. ${amount}`,
    costSpread: rate => `más ${rate} de margen`,
    upTo: pct => `hasta ${pct}`,
    from: pct => `desde ${pct}`,
    varies: 'varía según el país',
    attribution: readOn => `Cifras publicadas por cada proveedor, consultadas el ${readOn}. Son límites, no precios — su comisión exacta se muestra antes de pagar, y la mayoría de proveedores añade además un margen dentro del tipo que ofrece.`,
    noEndorsement: 'Por orden alfabético. dpay no recomienda ninguno, ninguno le paga, y dpay no interviene en su compra.',
  },
};

export const withdrawEs: WithdrawMessages = {
  ...bothSheets,

  overBalance: available => `Supera tu saldo disponible de ${available}.`,
  badAddress: asset => `Esto no parece una dirección de ${asset} válida.`,
  toDestination: destination => `a ${destination}`,
  enterAmount: 'Introduce un importe',

  ic: {
    resumed:
      'Había un retiro en curso cuando se cerró la app. Reintentar vuelve a enviar los mismos sobres: no puede gastar dos veces.',
    approvalUnknown: 'No se pudo confirmar la aprobación: revisa tu saldo cuando vuelvas a tener conexión',
    withdrawalUnknown: 'No se pudo confirmar el retiro: puede que aún llegue; revisa tu saldo en breve',
    noRail: 'Este activo no tiene configurada ninguna vía de retiro',
    gasFeeErr: 'No se pudo obtener la comisión de gas actual: revisa tu conexión',
    withdrawn: 'Retirado ✓',
    sentTo: 'enviado a',
    copyDestinationLabel: 'Copiar dirección de destino',
    withdrawing: amount => `Retirando ${amount}…`,
    sendToNative: (networkLabel, nativeAsset) => `Envía tu ${networkLabel} a una dirección nativa de ${nativeAsset}`,
    availableMin: (available, min) => `Disponible: ${available} · mín. ${min}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Está por debajo del retiro mínimo de ${min}.`,
    gasNote: 'Necesitas ckETH para el gas. Si no tienes, añade ckETH primero.',
    inProgress: 'Retiro en curso',
    withdrawAmount: amount => `Retirar ${amount}`,
    resumeNote:
      'Ya está firmado: Reintentar vuelve a enviar los mismos sobres (no puede gastar dos veces). Si editas el formulario, empezarás un retiro nuevo.',
    reviewTitle: 'Revisa el retiro',
    confirmLabel: 'Confirmar retiro',
    retry: 'Reintentar retiro',
  },

  send: {
    destLabel: 'Enviar a',
    destPlaceholder: 'Pega o escanea una dirección',
    scanLabel: 'Escanear el QR de la dirección de destino',
    scanTitle: 'Escanea la dirección de destino',
    scanCancel: 'Escribirla a mano',

    routeIcrc: (network, fee) => `${network} · llega en segundos · comisión ${fee}`,
    routeIcrcOnRail: (rail, fee) => `${rail} · llega en segundos · comisión ${fee}`,
    routeIcrcUnknownFee: network => `${network} · llega en segundos · se aplica la comisión del registro`,
    routeIcrcOnRailUnknownFee: rail => `${rail} · llega en segundos · se aplica la comisión del registro`,
    routeSolana: network => `${network} · llega en segundos · se aplica una pequeña comisión de red en SOL`,
    feeUnknown: 'la fija el registro',
    routeLegacy: fee => `Cuenta ICP · llega en segundos · comisión ${fee}`,
    routeNative: (chain, minutes, min) => `${chain} · aprox. ${minutes} min · mínimo ${min}`,
    routeNativeNoMin: (chain, minutes) => `${chain} · aprox. ${minutes} min`,

    refuseWrongChain: (pastedChain, asset, assetChain) =>
      `Esa es una dirección de ${pastedChain}. ${asset} se liquida en ${assetChain}, así que no puede llegar ahí: pega una dirección de ${assetChain}.`,
    refuseLegacyNotIcp: asset =>
      `Ese es un identificador de cuenta ICP: el formato de 64 caracteres. Solo se puede enviar ICP a uno de ellos; para ${asset}, pídele al destinatario su principal de Internet Computer (el que lleva guiones).`,
    refuseUnrecognised: asset => `Esto no parece una dirección a la que se pueda enviar ${asset}.`,
    refuseMistypedIc: 'Esta dirección de Internet Computer está incompleta o mal escrita: comprueba que la has copiado entera.',
    refuseMistypedLegacy: 'Esta dirección de cuenta ICP está incompleta o mal escrita: comprueba que has copiado los 64 caracteres.',
    refuseOwnSubaccount:
      'Esa es una subcuenta de tu propia cartera, y dpay solo muestra y usa tu cuenta principal: el dinero enviado ahí dejaría de aparecer aquí. Ya tienes este activo; pega la dirección de otra persona para enviarlo.',
    selfWarning: 'Esta es tu propia dirección. Los fondos vuelven directamente a ti y aun así pagas la comisión.',

    maxLabel: 'Máx.',
    feeLine: fee => `Comisión de red ${fee}`,
    totalLine: total => `Total ${total}`,

    savedTitle: 'Direcciones guardadas',
    saveNamePlaceholder: 'Ponle un nombre (opcional)',
    forgetLabel: address => `Eliminar la dirección guardada ${address}`,
    unnamed: 'Sin nombre',

    reviewTitle: 'Revisar',
    networkRow: 'Red',
    sendAmount: amount => `Enviar ${amount}`,
    sending: amount => `Enviando ${amount}…`,
    sent: 'Enviado',
    sentUnknown: 'Aún sin confirmar',
    sentUnknownBody:
      'La transferencia se envió, pero aún no está confirmada. Puede que todavía se complete: revisa tu saldo en un momento en lugar de volver a enviarla.',
    blockIndex: index => `Bloque ${index} del registro`,
    noLedger: 'Este activo no tiene un registro configurado, así que no se puede enviar.',
  },

  sol: {
    createAtaLabel: asset => `Crear mi cuenta de ${asset}`,
    backToScan: 'Volver a escanear',
    sent: 'Enviado ✓',
    txSignature: 'firma de la transacción',
    copySignatureLabel: 'Copiar la firma de la transacción',
    copySignature: 'Copiar firma',
    sending: amount => `Enviando ${amount}…`,
    confirmingOnSolana: 'Confirmando en Solana: puede tardar hasta un minuto.',
    sendToSolana: asset => `Envía tus ${asset} a una dirección de Solana`,
    available: available => `Disponible: ${available}`,
    tokenAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: asset => `Enviar ${asset} requiere un poco de SOL en la billetera para las comisiones de red: añade algo primero.`,
    reviewTitle: 'Revisa el envío',
    sendAmount: amount => `Enviar ${amount}`,
    recipientAtaNote: (cost, asset) =>
      `Si aún no tiene cuenta de ${asset}, se la crea (una sola vez, ≈${cost}, lo pagas tú).`,
    confirmLabel: asset => `Confirmar envío de ${asset}`,
  },
};
