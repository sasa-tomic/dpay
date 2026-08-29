/**
 * i18n/domains/de/deposit.ts — German values for the deposit + withdraw surfaces.
 * Types, key documentation and the reference copy: ../en/deposit.ts. Glossary: ../../de.ts.
 */
import type {DepositMessages, WithdrawMessages} from '../../keys';

/** Word-for-word identical on both sheets — one German source, spread into both objects. */
const beideSheets = {
  pressEsc: 'Esc drücken zum Schließen',
  balanceAuto: 'Dein Guthaben aktualisiert sich automatisch.',
  copied: 'Kopiert ✓',
  shared: 'Geteilt ✓',
  copyAddress: 'Adresse kopieren',
  amountLabel: (asset: string) => `Betrag (${asset})`,
};

export const depositDe: DepositMessages = {
  ...beideSheets,

  deposited: 'Eingezahlt ✓',
  addressCopied: 'Adresse kopiert',
  addressShared: 'Adresse geteilt',
  checkNow: 'Jetzt prüfen',

  ck: {
    addressErr: 'Deine Einzahlungsadresse konnte nicht geladen werden. Prüfe deine Verbindung und versuche es erneut.',
    noMinter: 'Für dieses Asset sind Einzahlungen noch nicht möglich.',
    fetchingAddress: 'Einzahlungsadresse wird geladen…',
    noAddress: 'Keine Einzahlungsadresse verfügbar.',
    sendToAddress: (nativeAsset, networkLabel) => [
      {t: 'Sende '},
      {t: nativeAsset, em: true},
      {t: ' an deine '},
      {t: networkLabel, em: true},
      {t: '-Adresse unten.'},
    ],
    confirmationLine: (required, estMin) =>
      `${required > 0 ? `~${required} Bestätigung${required === 1 ? '' : 'en'}` : 'Bestätigungen'}${estMin > 0 ? ` · meist ~${estMin} Min.` : ''}`,
    feeMinLine: (fee, min) => `Netzwerkgebühr ${fee} · Min. Einzahlung ${min}`,
    feeNone: 'keine',
    minNone: 'kein Minimum',
    custody: 'dpay hält deine Schlüssel nie — nach der Bestätigung wird der Betrag 1:1 deiner Wallet gutgeschrieben.',
    copyDepositAddress: 'Einzahlungsadresse kopieren',
    statusTitle: 'Status',
    watching: 'Wir warten auf deine Einzahlung',
    checkingEvery: seconds => `Prüfung alle ${seconds}s`,
    checkNowLabel: 'Einzahlungsstatus jetzt prüfen',
    mintedAmount: amount => `${amount} gutgeschrieben`,
  },

  icrc: {
    sendToAccount: (symbol, network) => [
      {t: 'Sende '},
      {t: symbol, em: true},
      {t: ' von jeder '},
      {t: network, em: true},
      {t: '-Wallet, die es unterstützt, an dein Konto unten.'},
    ],
    noMemo: 'Kein Memo und keine Referenz nötig — eine normale Überweisung an dieses Konto genügt.',
    feeLine: fee => `Netzwerkgebühr ${fee}`,
    custody: asset => `dpay hält deine Schlüssel nie und wechselt nie — ${asset} landet direkt in deiner Wallet.`,
    receivedAmount: amount => `${amount} empfangen`,
  },

  erc20: {
    onrampParamsErr: 'Der Server war für die Einzahlungsdetails nicht erreichbar.',
    deriveErr: 'Deine Einzahlungsadresse konnte nicht abgeleitet werden — schließe die Ansicht und öffne sie erneut.',
    noWalletWeb: 'Keine Ethereum-Wallet gefunden. Installiere MetaMask oder Rabby in diesem Browser.',
    noWalletNative: 'Keine Wallet verbunden. Kopple eine Wallet über WalletConnect.',
    pairRejected: 'Kopplung nicht freigegeben.',
    pairFailed: 'Kopplung mit deiner Wallet fehlgeschlagen.',
    wrongNetwork: (networkLabel, expected, actual) =>
      `Falsches Netzwerk: Verbinde dich mit ${networkLabel} (Chain ${expected}). Deine Wallet ist auf Chain ${actual}.`,
    connectFailed: 'Verbindung zu deiner Wallet fehlgeschlagen.',
    noWalletApp: 'Keine Wallet-App gefunden. Scanne den QR-Code stattdessen mit einer Wallet auf einem anderen Gerät.',
    walletDisconnected: 'Wallet getrennt.',
    amountRequired: 'Gib einen Betrag größer als null ein.',
    missingErc20Address: 'In den Einzahlungsdetails fehlt die ERC-20-Adresse.',
    txReverted: 'Die Transaktion wurde on-chain zurückgewiesen.',
    txUnconfirmed: 'Transaktion gesendet, aber noch nicht bestätigt — wir warten weiter auf die Gutschrift.',
    txNotSigned: 'Transaktion nicht signiert.',
    txFailed: 'Transaktion fehlgeschlagen.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Sende nur '},
      {t: nativeAsset, em: true},
      {t: ' auf '},
      {t: networkLabel, em: true},
      {t: '. Andere Assets oder Chains werden so nicht gutgeschrieben und können verloren gehen.'},
    ],
    custody:
      'dpay hält deine Schlüssel nie — deine Wallet signiert, und nach der Bestätigung (~20 Min.) wird dir das Chain-Key-Asset 1:1 in deiner Wallet gutgeschrieben.',
    gasNative: 'Die Netzwerkgebühr wird in ETH bezahlt — sende etwas mehr, als du einzahlen willst.',
    gasErc20: 'Du brauchst etwas ETH für die Gas-Gebühren im Ethereum-Netzwerk.',
    scanToPair: 'Zum Koppeln mit deiner Wallet scannen',
    openWalletHint: 'Öffnet eine installierte Wallet-App auf diesem Gerät',
    openWallet: 'Wallet auf diesem Gerät öffnen',
    walletListPair: 'MetaMask · Trust · Rabby · jede WalletConnect-Wallet',
    walletList: 'MetaMask · Trust · Rabby · jede WalletConnect-kompatible Wallet',
    explainNative:
      'Sende ETH direkt an den Einzahlungs-Contract — eine Transaktion, die deine Wallet signiert, mit deinem Einzahlungsbetrag als ETH-Wert.',
    explainErc20: nativeAsset =>
      `${nativeAsset} ist ein Ethereum-Token — für die Einzahlung signiert deine Wallet zwei Transaktionen, kein einfaches Senden an eine Adresse wie bei Bitcoin.`,
    connectLabel: 'Ethereum-Wallet verbinden',
    connect: 'Wallet verbinden',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `Von ${shortAccount}`,
    confirmingLabel: 'Bestätigung in deiner Wallet',
    deposit: 'Einzahlen',
    approveDepositLabel: 'Freigeben und einzahlen',
    approveDeposit: 'Freigeben & einzahlen',
    confirming: 'Bestätige in deiner Wallet…',
    depositingAmount: (amount, asset) => `${amount} ${asset} werden eingezahlt`,
    watchingResumed:
      'Einzahlung ausstehend (~20 Min.) — deine Wallet ist nicht verbunden, aber wir warten weiter auf die Gutschrift.',
    watchingFresh: 'Warten auf die Bestätigung — deine Einzahlung erscheint in etwa 20 Minuten.',
    startNew: 'Neue Einzahlung starten',
    mintedToWallet: asset => `${asset} wurde deiner Wallet gutgeschrieben.`,
  },

  sol: {
    createAtaLabel: 'USDC-Konto erstellen',
    checkingAta: 'Dein USDC-Konto wird geprüft…',
    ataUnverified: 'Dein USDC-Konto konnte nicht geprüft werden.',
    ataUnverifiedDetail:
      'Mit deiner Adresse ist alles in Ordnung — wir erreichen Solana gerade nur nicht, um dein USDC-Konto on-chain zu bestätigen. Prüfe deine Verbindung und versuche es erneut.',
    retryAtaLabel: 'USDC-Konto erneut prüfen',
    retryAtaHint: 'Prüft erneut, ob dein USDC-Konto on-chain existiert',
    checkAgain: 'Erneut prüfen',
    backToRequest: 'Zurück zur Anfrage',
    sendToAddress: (asset, network) => [
      {t: 'Sende '},
      {t: asset, em: true},
      {t: ' an deine '},
      {t: network},
      {t: '-Adresse unten.'},
    ],
    custody: asset => `dpay hält deine Schlüssel nie — ${asset} landet nach der Bestätigung direkt in deiner Wallet.`,
    devnetWarn: asset =>
      `Verbunden mit dem Solana-Devnet. Sende hier KEIN Mainnet-${asset} — es erscheint nicht. Nutze nur Devnet-${asset}.`,
    waitingDeposit: 'Wir warten auf deine Einzahlung · Prüfung alle paar Sekunden',
    checkNowHint: 'Prüft dein Guthaben sofort erneut',
    balanceAutoOnConfirm: 'Dein Guthaben aktualisiert sich automatisch, sobald die Überweisung bestätigt ist.',
    copyAssetAddress: asset => `${asset}-Adresse kopieren`,
    returnHint: 'Geht zurück zum Bezahlen-Tab mit diesem Asset ausgewählt',
  },

  ata: {
    absent: 'Du hast auf diesem Gerät noch kein USDC-Konto.',
    cost: setupCost =>
      `Solana verwahrt dein USDC in einem einmaligen Token-Konto, das zu dieser Wallet gehört. Das Erstellen kostet ${setupCost} (Kontomiete + Gebühr) aus deinem SOL-Guthaben — es bleibt dein Konto, unter deinen Schlüsseln. dpay hält sie nie.`,
    checkingSol: 'Dein SOL-Guthaben wird geprüft…',
    needSol: setupCost =>
      `Du brauchst zuerst etwa ${setupCost} in dieser Wallet — empfange SOL an deiner Adresse und erstelle dann das Konto.`,
    showSolAddress: 'Meine SOL-Adresse zeigen',
    creating: 'Dein USDC-Konto wird erstellt — Bestätigung auf Solana…',
    createHint: setupCost => `Erstellt dein einmaliges USDC-Konto für ${setupCost} aus deinem SOL-Guthaben`,
  },

  trust: {
    fund: 'Aus Trust Wallet aufladen',
    fundHint: asset => `Öffnet Trust Wallet, um ${asset} an deine dpay-Adresse zu senden`,
    err: 'Trust Wallet konnte nicht geöffnet werden. Versuche es erneut.',
  },
};

export const withdrawDe: WithdrawMessages = {
  ...beideSheets,

  overBalance: available => `Mehr als verfügbar (${available}).`,
  badAddress: asset => `Das sieht nicht nach einer gültigen ${asset}-Adresse aus.`,
  toDestination: destination => `an ${destination}`,
  enterAmount: 'Betrag eingeben',

  ic: {
    resumed:
      'Beim Schließen der App lief eine Auszahlung. Ein erneuter Versuch sendet dieselben Envelopes noch einmal — doppelt ausgeben ist ausgeschlossen.',
    approvalUnknown: 'Die Freigabe konnte nicht bestätigt werden — prüfe dein Guthaben, wenn du wieder online bist',
    withdrawalUnknown:
      'Die Auszahlung konnte nicht bestätigt werden — sie kann trotzdem noch ankommen; prüfe bald dein Guthaben',
    noRail: 'Für dieses Asset ist kein Auszahlungsweg konfiguriert',
    gasFeeErr: 'Die aktuelle Gas-Gebühr konnte nicht geladen werden — prüfe deine Verbindung',
    withdrawn: 'Ausgezahlt ✓',
    sentTo: 'gesendet an',
    copyDestinationLabel: 'Zieladresse kopieren',
    withdrawing: amount => `${amount} werden ausgezahlt…`,
    sendToNative: (networkLabel, nativeAsset) => `Sende dein ${networkLabel} an eine native ${nativeAsset}-Adresse`,
    availableMin: (available, min) => `Verfügbar: ${available} · min. ${min}`,
    addressLabel: asset => `${asset}-Adresse`,
    useLastLabel: 'Zuletzt gespeicherte Adresse verwenden',
    useLast: address => `Zuletzt: ${address}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Unter der Mindestauszahlung von ${min}.`,
    gasNote: 'Du brauchst ckETH für Gas. Zahle zuerst ckETH ein, falls du keins hast.',
    inProgress: 'Auszahlung läuft',
    withdrawAmount: amount => `${amount} auszahlen`,
    resumeNote:
      'Bereits signiert — ein erneuter Versuch sendet dieselben Envelopes noch einmal (doppelt ausgeben ist ausgeschlossen). Wenn du das Formular änderst, startet stattdessen eine neue Auszahlung.',
    reviewTitle: 'Auszahlung prüfen',
    confirmLabel: 'Auszahlung bestätigen',
    retry: 'Auszahlung erneut versuchen',
  },

  sol: {
    createAtaLabel: 'Mein USDC-Konto erstellen',
    backToScan: 'Zurück zum Scannen',
    sent: 'Gesendet ✓',
    txSignature: 'Transaktionssignatur',
    copySignatureLabel: 'Transaktionssignatur kopieren',
    copySignature: 'Signatur kopieren',
    sending: amount => `${amount} werden gesendet…`,
    confirmingOnSolana: 'Bestätigung auf Solana — das kann bis zu einer Minute dauern.',
    sendToSolana: asset => `Sende dein ${asset} an eine Solana-Adresse`,
    available: available => `Verfügbar: ${available}`,
    addressLabel: 'Solana-Adresse',
    addressPlaceholder: 'Base58-Adresse des Empfängers',
    usdcAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: 'Für das Senden von USDC brauchst du etwas SOL in der Wallet für Netzwerkgebühren — zahle zuerst etwas ein.',
    reviewTitle: 'Senden prüfen',
    sendAmount: amount => `${amount} senden`,
    recipientAtaNote: cost =>
      `Falls die Person noch kein USDC-Konto hat, wird es hiermit für sie erstellt (einmalig ≈${cost}, von dir bezahlt).`,
    confirmLabel: asset => `Senden von ${asset} bestätigen`,
  },
};
