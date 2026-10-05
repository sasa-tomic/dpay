/**
 * i18n/domains/es/deposit.ts - Spanish values for the deposit + withdraw surfaces.
 *
 * Reference copy, types and rationale: domains/en/deposit.ts. Glossary: i18n/es.ts.
 */
import type {DepositMessages, WithdrawMessages} from '../../keys';

/** Word-for-word identical on both sheets in Spanish too - one source, spread into both objects. */
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
    addressOffline: 'Pareces estar sin conexión, así que no se pudo crear tu dirección de depósito. Tu dinero está intacto. Inténtalo de nuevo cuando vuelvas a estar en línea.',
    addressUnreachable: 'Tu conexión está bien, pero Internet Computer no responde, así que no se pudo crear tu dirección de depósito. Tu dinero está intacto. Inténtalo de nuevo en un momento.',
    addressCreateErr: 'No se pudo crear tu dirección. Tu dinero está intacto. Cierra esta pantalla e inténtalo de nuevo.',
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
    copyDepositAddress: 'Copiar dirección de depósito',
    statusTitle: 'Estado',
    watching: 'Esperando tu depósito',
    checkingEvery: seconds => `se revisa cada ${seconds} s`,
    checkNowLabel: 'Revisar ahora el estado del depósito',
    mintedAmount: amount => `${amount} emitidos`,
  },

  icrc: {
    whereFrom: (symbol, network) => [
      {t: 'Envía '},
      {t: symbol, em: true},
      {t: ' desde cualquier billetera que lo tenga en '},
      {t: network, em: true},
      {t: ', o retíralo desde un exchange que la admita.'},
    ],
    onlyAccepts: (symbol, network) =>
      `Esta dirección recibe ${symbol} enviado por ${network}: cualquier otra cosa no se acreditará.`,
    noMemo: 'No hace falta memo ni referencia.',
    feeLine: fee => `Comisión de red ${fee}`,
    receivedAmount: amount => `${amount} recibidos`,
    alsoTitle: '¿Ya está en Internet Computer?',
    alsoBody: symbol => [
      {t: 'Envía '},
      {t: symbol, em: true},
      {t: ' desde cualquier billetera de Internet Computer a tu dirección IC de abajo. No hace falta memo.'},
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
    connectFailed: 'No se pudo conectar. Abre tu app de billetera, aprueba allí la solicitud y vuelve a intentarlo.',
    noWalletApp: 'No se encontró ninguna app de billetera. Escanea el QR con una billetera en otro dispositivo.',
    walletDisconnected: 'Billetera desconectada.',
    amountRequired: 'Introduce un importe mayor que cero.',
    missingErc20Address: 'Los datos del depósito no incluyen la dirección ERC-20.',
    txReverted: 'La transacción se revirtió en la cadena.',
    txUnconfirmed: 'Transacción enviada, aún sin confirmar. Seguimos esperando la emisión.',
    approveReverted:
      'La aprobación se revirtió en la cadena. No se envió ningún depósito y no salió dinero. Vuelve a intentarlo: primero la aprobación, después el depósito.',
    approveUnconfirmed:
      'La aprobación se envió pero no se confirmó: no salió dinero de tu billetera. Espera un momento y vuelve a intentarlo; tu billetera pedirá la aprobación otra vez. Es lo normal y solo cuesta gas.',
    depositHashUnknown:
      'Revisa la actividad reciente de tu billetera antes de volver a intentarlo. Si el depósito está ahí, se acreditará en unos 20 minutos: depositar otra vez pagaría dos veces.',
    approveHashUnknown:
      'No se hizo ningún depósito y no salió dinero de tu billetera. Revisa la actividad reciente de tu billetera y vuelve a intentarlo: primero pedirá la aprobación, es lo normal y solo cuesta gas.',
    txNotSigned: 'La transacción no se firmó.',
    txFailed: 'La transacción falló.',
    allowanceStands:
      'Tu aprobación de gasto ya está confirmada en la cadena, y no salió dinero de tu billetera. Reintentar pedirá las dos firmas de nuevo: la aprobación y después el depósito.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Envía solo '},
      {t: nativeAsset, em: true},
      {t: ' en '},
      {t: networkLabel, em: true},
      {t: '. Todo lo demás enviado por aquí no se acreditará y podría perderse.'},
    ],
    mintLine: 'Tu depósito se emite 1:1 en tu billetera al confirmarse (~20 min).',
    details: 'Detalles',
    gasNative: 'La comisión de red se paga en ETH: envía un poco más de lo que quieras depositar.',
    gasErc20: 'Necesitas un poco de ETH para las comisiones de gas de la red.',
    scanToPair: 'Escanea con tu billetera para vincular',
    orOpenHere: 'O abre una billetera en este teléfono:',
    openNamedWallet: name => `Abrir ${name}`,
    otherWallet: 'Otra billetera',
    otherWalletHint:
      'La vinculación funciona, pero después dpay no podrá volver a abrirla por ti: cambia a la billetera tú mismo para aprobar el depósito.',
    couldntOpenWallet: name =>
      `No se pudo abrir ${name}: puede que no esté instalada. Elige otra billetera o escanea el QR con una billetera en otro dispositivo.`,
    walletList: 'MetaMask · Trust · Rabby · cualquier billetera compatible con WalletConnect',
    explainNative:
      'Envía ETH directamente al contrato de depósito: una transacción firmada, con el importe del depósito como valor en ETH.',
    explainErc20: nativeAsset =>
      `${nativeAsset} es un token de Ethereum. Depositarlo requiere dos transacciones firmadas: primero la aprobación y después el depósito.`,
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
      'Depósito pendiente (~20 min): tu billetera no está conectada, pero la espera de la emisión continúa.',
    watchingFresh: 'Esperando la confirmación: tu depósito aparecerá en unos 20 minutos.',
    startNew: 'Empezar otro depósito',
    mintedToWallet: asset => `${asset} emitido en tu billetera.`,
  },

  sol: {
    createAtaLabel: asset => `Crear cuenta de ${asset}`,
    checkingAta: asset => `Revisando tu cuenta de ${asset}…`,
    ataUnverified: asset => `No se pudo revisar tu cuenta de ${asset}.`,
    ataUnverifiedDetail: asset =>
      `Tu dirección está bien; dpay no consigue contactar con Solana para confirmar tu cuenta de ${asset}. Revisa tu conexión e inténtalo de nuevo.`,
    ataUnverifiedRefused: asset =>
      `Tu dirección está bien; Solana rechazó la solicitud, así que no se pudo confirmar tu cuenta de ${asset}. Inténtalo de nuevo en un momento.`,
    ataUnverifiedOffline: asset =>
      `Tu dirección está bien; parece que estás sin conexión, así que no se pudo confirmar tu cuenta de ${asset}. Vuelve a comprobarlo cuando recuperes la conexión.`,
    ataUnverifiedUnreachable: asset =>
      `Tu dirección está bien; el relé de dpay no consigue alcanzar Solana, así que no se pudo confirmar tu cuenta de ${asset}. Tu dinero está intacto y tus pagos de Internet Computer siguen funcionando. Inténtalo de nuevo en un momento.`,
    ataUnverifiedUnreadable: asset =>
      `Tu dirección está bien; Solana envió datos que dpay no puede leer, así que no se pudo confirmar tu cuenta de ${asset}. Inténtalo de nuevo en un momento.`,
    retryAtaLabel: asset => `Reintentar la revisión de la cuenta de ${asset}`,
    checkAgain: 'Revisar de nuevo',
    backToRequest: 'Volver a la solicitud',
    sendToAddress: (asset, network) => [
      {t: 'Envía '},
      {t: asset, em: true},
      {t: ' a tu dirección de '},
      {t: network},
      {t: ' que aparece abajo.'},
    ],
    devnetWarn: asset =>
      `Estás en la devnet de Solana: NO envíes ${asset} de mainnet aquí, no aparecerá. Solo ${asset} de devnet.`,
    waitingDeposit: 'Esperando tu depósito · se revisa cada pocos segundos',
    copyAssetAddress: asset => `Copiar dirección de ${asset}`,
  },

  ata: {
    absent: asset => `Aún no hay una cuenta de ${asset}.`,
    cost: (setupCost, asset) =>
      `Crear tus ${asset} cuesta ${setupCost}, de tu saldo de SOL. Las cuentas son tuyas y están bajo tus claves.`,
    checkingSol: 'Revisando tu saldo de SOL…',
    needSol: setupCost =>
      `Primero necesitas unos ${setupCost}: recíbelos en tu dirección y luego crea la cuenta.`,
    showSolAddress: 'Ver mi dirección de SOL',
    creating: asset => `Creando tu cuenta de ${asset}. Confirmando en Solana…`,
    createHint: (setupCost, asset) => `Crea tu cuenta de ${asset} por ${setupCost} de tu saldo de SOL`,
    completeSetup: 'Completar configuración',
    completeHint: setupCost => `Lo configura todo con un toque (unos ${setupCost})`,
    targetsLabel: raw => {
      const symbols = Array.isArray(raw) ? raw : [String(raw)];
      return symbols.length === 1
        ? `cuenta de ${symbols[0]}`
        : `cuentas de ${symbols.slice(0, -1).join(', ')} y ${symbols[symbols.length - 1]}`;
    },
    finishSetup: targets => `Falta configurar: ${targets}`,
    costShort: setupCost => `Cuesta ${setupCost}`,
    minSwap: swap => `Necesita ${swap}.`,
    fundFrom: source => `Un pequeño canje de tus ${source} por SOL lo paga.`,
    fundConfirm: (swap, targets, setupCost) =>
      `Canjea ${swap} por SOL y crea tus ${targets} (${setupCost}).`,
    fundIcConfirm: (swap, targets, setupCost) =>
      `Canjea ${swap} por SOL y crea tus ${targets} (${setupCost}). Puede tardar uno o dos minutos; el SOL sobrante queda en tu wallet.`,
    createSource: 'Se paga desde tu saldo SOL.',
    fundShort: source => `Ni todos tus ${source} alcanzan: recibe algo de SOL en tu dirección.`,
    confirmAction: 'Confirmar',
    cancelAction: 'Cancelar',
    settingUp: 'Espera, tu cuenta se está configurando. Esto tarda 1-2 minutos.',
    errNextSafe: 'No salió nada de tu wallet. Completa la configuración de nuevo cuando quieras.',
    errNextUnknown: 'Revisa tu saldo de SOL en un momento: si el SOL llegó, completa la configuración de nuevo para crear las cuentas; si no, tu saldo te muestra dónde está tu dinero.',
    swapFailed: 'El canje no se completó: no se creó nada y el token canjeado sigue en tu wallet.',
    swapUnknown: 'El canje fue aceptado pero aún no se confirma. Revisa tu saldo de SOL en un momento y vuelve a completar la configuración.',
  },

  trust: {
    fund: 'Añadir desde Trust Wallet',
    fundHint: asset => `Abre Trust Wallet para enviar ${asset} a tu dirección de dpay`,
    err: 'No se pudo abrir Trust Wallet. Inténtalo de nuevo.',
  },

  funding: {
    title: '¿Todavía no tienes?',
    buyThenSend: (token, chain) => [
      {t: 'Compra '},
      {t: token, em: true},
      {t: ' en cualquier exchange o proveedor de tarjeta que pague en '},
      {t: chain, em: true},
      {t: ' y envíalo a la dirección de arriba.'},
    ],
    bridgeWithGas: (token, chain, gasToken) => [
      {t: 'Para este no existe dirección: compra '},
      {t: token, em: true},
      {t: ' en '},
      {t: chain, em: true},
      {t: ' en una billetera tuya, guarda en ella un poco de '},
      {t: gasToken, em: true},
      {t: ' para las comisiones y conecta esa billetera aquí: ella firma la transferencia.'},
    ],
    bridgeSelfGas: (token, chain) => [
      {t: 'Para este no existe dirección. Compra '},
      {t: token, em: true},
      {t: ' en '},
      {t: chain, em: true},
      {t: ' en una billetera tuya - un poco más de lo que quieras mover, porque la comisión sale de ahí. Después conecta esa billetera aquí: ella firma la transferencia.'},
    ],
    buyThenConvert: (viaToken, target) => [
      {t: 'Ningún proveedor vende '},
      {t: target, em: true},
      {t: ' directamente. Compra '},
      {t: viaToken, em: true},
      {t: ' con tarjeta, envíalo a la dirección de arriba y usa Convertir para cambiarlo por '},
      {t: target, em: true},
      {t: '.'},
    ],
    testnetOnly: (symbol, chain) => `${symbol} es dinero de prueba, sin ningún valor: nadie lo vende. Consíguelo gratis en un faucet público de ${chain} y envíalo a la dirección de arriba.`,
    testnetOnlyWallet: (symbol, chain) => `${symbol} es dinero de prueba, sin ningún valor: nadie lo vende. Consíguelo gratis en un faucet público de ${chain} en una billetera tuya y conecta esa billetera aquí.`,
    bankRoute: provider => `Desde una cuenta bancaria suiza, ${provider} lo vende por transferencia. Requiere verificación de identidad completa y tarda lo que tarda una transferencia bancaria.`,
    providersTitle: 'Dónde se compra',
    costCard: rate => `tarjeta ${rate}`,
    costBank: rate => `banco ${rate}`,
    costSepa: rate => `SEPA ${rate}`,
    costWalletPay: rate => `Apple & Google Pay ${rate}`,
    costMin: amount => `mín. ${amount}`,
    costSpread: rate => `más ${rate} de margen`,
    plusFixed: fixed => `+ ${fixed}`,
    nonUsdUplift: (from, to) => `compras fuera del USD: tarifa mínima ${from} a ${to} más alta, según la divisa`,
    qEur: 'EUR',
    qNonEur: 'no EUR',
    qUsdEurGbp: 'USD, EUR, GBP',
    qOtherCurrencies: 'otras divisas, incl. CHF',
    qManual: 'manual',
    qEasy: 'easy',
    qPix: 'Pix',
    upTo: pct => `hasta ${pct}`,
    from: pct => `desde ${pct}`,
    attribution: readOn => `Cifras publicadas por cada proveedor, consultadas el ${readOn}: límites, no precios. Su comisión exacta se muestra antes de pagar; la mayoría añade además un margen dentro del tipo.`,
    noEndorsement: 'Por orden alfabético: dpay no recomienda ninguno, ninguno te paga ni interviene en tu compra.',
  },
};

export const withdrawEs: WithdrawMessages = {
  ...bothSheets,

  overBalance: available => `Supera tu saldo disponible de ${available}.`,
  badAddress: asset => `Esto no parece una dirección de ${asset} válida.`,
  toDestination: destination => `a ${destination}`,
  enterAmount: 'Introduce un importe',
  offlineReviewNote: 'Estás sin conexión - revisa el envío. Solo sale de tu billetera cuando la red lo acepta; sin conexión, confirmar falla.',

  ic: {
    resumed: 'Había un retiro en curso cuando se cerró la app. Reintentar vuelve a enviar el mismo pago: no puede gastar dos veces.',
    approvalUnknown: 'No se pudo confirmar la aprobación: revisa tu saldo cuando vuelvas a tener conexión',
    withdrawalUnknown: 'No se pudo confirmar el retiro: puede que aún llegue; revisa tu saldo en breve',
    noRail: 'Este activo no tiene configurada ninguna vía de retiro',
    gasFeeErrOffline: 'Pareces estar sin conexión, así que no se pudo leer la comisión de gas actual. No se envió nada. Inténtalo de nuevo cuando vuelvas a estar en línea.',
    gasFeeErrUnreachable: 'Tu conexión está bien, pero Internet Computer no responde, así que no se pudo leer la comisión de gas actual. Tu dinero está intacto. Inténtalo de nuevo en un momento.',
    withdrawn: 'Retirado ✓',
    sentTo: 'Enviado a',
    copyDestinationLabel: 'Copiar dirección de destino',
    withdrawing: amount => `Retirando ${amount}…`,
    sendToNative: (networkLabel, nativeAsset) => `Envía tu ${networkLabel} a una dirección nativa de ${nativeAsset}`,
    availableMin: (available, min) => `Disponible: ${available} · mín. ${min}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Está por debajo del retiro mínimo de ${min}.`,
    gasNote: 'Necesitas ckETH para el gas. Si no tienes, añade algo primero.',
    inProgress: 'Retiro en curso',
    withdrawAmount: amount => `Retirar ${amount}`,
    resumeNote:
      'Ya está firmado: Reintentar vuelve a enviar el mismo pago (sin doble gasto). Si editas el formulario, empezarás un retiro nuevo.',
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
      `Ese es un identificador de cuenta ICP: el formato de 64 caracteres. Solo se puede enviar ICP a uno de ellos. Para ${asset}, pídele al destinatario su principal de Internet Computer (el que lleva guiones).`,
    refuseUnrecognised: asset => `Esto no parece una dirección a la que se pueda enviar ${asset}.`,
    refuseMistypedIc: 'Esta dirección de Internet Computer está incompleta o mal escrita: comprueba que la has copiado entera.',
    refuseMistypedLegacy: 'Esta dirección de cuenta ICP está incompleta o mal escrita: comprueba que has copiado los 64 caracteres.',
    refuseOwnSubaccount:
      'Esa es una subcuenta de tu billetera. dpay solo muestra y usa tu cuenta principal, así que el dinero enviado ahí dejaría de aparecer en Saldos. Pega la dirección de otra persona para enviar.',
    selfWarning: 'Es tu dirección: el dinero vuelve directamente a ti y aun así pagas la comisión.',

    maxLabel: 'Máx.',
    feeLine: fee => `Comisión de red ${fee}`,
    totalLine: total => `Total ${total}`,

    savedTitle: 'Direcciones guardadas',
    saveNamePlaceholder: 'Ponle un nombre (opcional)',
    forgetLabel: address => `Eliminar la dirección guardada ${address}`,
    unnamed: 'Sin nombre',
    ownAddress: 'Mi direcci\u00f3n',
    ownAddressHint: 'Rellenar con la direcci\u00f3n de esta billetera',
    manage: 'Libreta de direcciones',
    manageHint: 'Ver, nombrar y eliminar las direcciones guardadas',

    reviewTitle: 'Revisar',
    networkRow: 'Red',
    sendAmount: amount => `Enviar ${amount}`,
    sending: amount => `Enviando ${amount}…`,
    sent: 'Enviado',
    sentUnknown: 'Aún sin confirmar',
    sentUnknownBody:
      'Enviada, pero aún sin confirmar. Puede que todavía se complete: revisa tu saldo en un momento en vez de volver a enviarla.',
    blockIndex: index => `Bloque ${index} del registro`,
    noLedger: 'Este activo no tiene registro, así que no se puede enviar.',

    copyReference: 'Copiar la referencia',
    viewReceipt: 'Ver el recibo',
    checkStatus: 'Comprobar el estado',
    checking: 'Comprobando…',
    checkFailed: 'No se pudo comprobar ahora mismo. Inténtalo de nuevo en un momento.',
    failed: 'Falló',
    feeOnly: 'Falló en la cadena: no se entregó nada, solo se cobró la comisión de red.',
    nothingSent: 'No se envió nada. La red rechazó la transferencia antes de aceptarla, así que tu dinero nunca salió de la billetera.',
  },

  sol: {
    createAtaLabel: asset => `Crear mi cuenta de ${asset}`,
    backToScan: 'Volver a escanear',
    sent: 'Enviado',
    txSignature: 'firma de la transacción',
    copySignatureLabel: 'Copiar la firma de la transacción',
    copySignature: 'Copiar firma',
    sending: amount => `Enviando ${amount}…`,
    confirmingOnSolana: 'Confirmando en Solana: hasta un minuto.',
    sentUnknown: 'Enviado - aún sin confirmar',
    sentUnknownBody:
      'La red la aceptó, pero la confirmación no llegó a tiempo. Puede completarse: comprueba tu saldo en lugar de enviar de nuevo.',
    sendToSolana: asset => `Envía tus ${asset} a una dirección de Solana`,
    available: available => `Disponible: ${available}`,
    tokenAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: asset => `Enviar ${asset} requiere un poco de SOL para las comisiones de red: añade algo primero.`,
    reviewTitle: 'Revisa el envío',
    sendAmount: amount => `Enviar ${amount}`,
    recipientAtaNote: (cost, asset) =>
      `Si aún no tiene cuenta de ${asset}, se la crea (una sola vez, ≈${cost}, lo pagas tú).`,
    confirmLabel: asset => `Confirmar envío de ${asset}`,
    ataRentGate: (cost, held, asset) =>
      `Aún no tiene una cuenta de ${asset}: crearla cuesta unos ${cost}. Tus ${held} de SOL no alcanzan.`,
    ataRentTopUp: cost => `Recibe unos ${cost} de SOL en tu dirección y luego envía:`,
  },
};
