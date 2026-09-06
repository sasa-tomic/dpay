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
    alsoTitle: 'Schon auf dem Internet Computer?',
    alsoBody: symbol => [
      {t: 'Sende '},
      {t: symbol, em: true},
      {t: ' von jeder Internet-Computer-Wallet direkt an deine IC-Adresse unten — kein Memo nötig.'},
    ],
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
    approveReverted:
      'Die Freigabe wurde on-chain zurückgewiesen, die Einzahlung wurde also nie gesendet und es hat kein Geld deine Wallet verlassen. Versuch es erneut — deine Wallet fragt zuerst nach der Freigabe und dann nach der Einzahlung.',
    approveUnconfirmed:
      'Die Freigabe wurde gesendet, aber nicht bestätigt, die Einzahlung wurde also nie gesendet und es hat kein Geld deine Wallet verlassen. Warte einen Moment und versuch es erneut: Deine Wallet fragt dann noch einmal nach der Freigabe — das ist normal und kostet nur Gas.',
    depositHashUnknown:
      'Deine Wallet hat die Einzahlung angenommen, aber keine Transaktions-ID zurückgegeben — dpay kann daher nicht erkennen, ob sie gesendet wurde. Sieh in deiner Wallet-App in den letzten Aktivitäten nach, bevor du es erneut versuchst: Ist die Einzahlung dort, wird sie in etwa 20 Minuten gutgeschrieben, und eine zweite Einzahlung würde das Geld doppelt senden.',
    approveHashUnknown:
      'Deine Wallet hat die Freigabe angenommen, aber keine Transaktions-ID zurückgegeben — dpay kann daher nicht erkennen, ob sie gesendet wurde. Es wurde nichts eingezahlt und es hat kein Geld deine Wallet verlassen. Sieh in deiner Wallet-App in den letzten Aktivitäten nach und versuch es dann erneut — sie fragt zuerst nach der Freigabe, das ist normal und kostet nur Gas.',
    txNotSigned: 'Transaktion nicht signiert.',
    txFailed: 'Transaktion fehlgeschlagen.',
    allowanceStands:
      'Deine Freigabe ist bereits on-chain bestätigt und es hat kein Geld deine Wallet verlassen. Beim nächsten Versuch fragt deine Wallet wieder nach Freigabe und Einzahlung — beide Signaturen wie zuvor.',
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
    orOpenHere: 'Oder öffne eine Wallet auf diesem Handy:',
    openNamedWallet: name => `${name} öffnen`,
    otherWallet: 'Andere Wallet',
    otherWalletHint:
      'Bei „Andere Wallet“ wählt dein Handy die App aus. Das Koppeln funktioniert, aber dpay kann sie später nicht für dich öffnen — du musst zum Bestätigen der Einzahlung selbst dorthin wechseln.',
    couldntOpenWallet: name =>
      `${name} konnte nicht geöffnet werden — die App ist vielleicht nicht mehr installiert. Wähle unten eine andere Wallet oder scanne den QR-Code mit einer Wallet auf einem anderen Gerät.`,
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
    switchToWalletApp: 'Deine Wallet sollte sich zum Bestätigen öffnen. Falls nicht, wechsle selbst dorthin — und komm dann hierher zurück.',
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
    createAtaLabel: asset => `${asset}-Konto erstellen`,
    checkingAta: asset => `Dein ${asset}-Konto wird geprüft…`,
    ataUnverified: asset => `Dein ${asset}-Konto konnte nicht geprüft werden.`,
    ataUnverifiedDetail: asset =>
      `Mit deiner Adresse ist alles in Ordnung — wir erreichen Solana gerade nur nicht, um dein ${asset}-Konto on-chain zu bestätigen. Prüfe deine Verbindung und versuche es erneut.`,
    retryAtaLabel: asset => `${asset}-Konto erneut prüfen`,
    retryAtaHint: asset => `Prüft erneut, ob dein ${asset}-Konto on-chain existiert`,
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
    absent: asset => `Du hast auf diesem Gerät noch kein ${asset}-Konto.`,
    cost: (setupCost, asset) =>
      `Solana verwahrt dein ${asset} in einem einmaligen Token-Konto, das zu dieser Wallet gehört. Das Erstellen kostet ${setupCost} (Kontomiete + Gebühr) aus deinem SOL-Guthaben — es bleibt dein Konto, unter deinen Schlüsseln. dpay hält sie nie.`,
    checkingSol: 'Dein SOL-Guthaben wird geprüft…',
    needSol: setupCost =>
      `Du brauchst zuerst etwa ${setupCost} in dieser Wallet — empfange SOL an deiner Adresse und erstelle dann das Konto.`,
    showSolAddress: 'Meine SOL-Adresse zeigen',
    creating: asset => `Dein ${asset}-Konto wird erstellt — Bestätigung auf Solana…`,
    createHint: (setupCost, asset) => `Erstellt dein einmaliges ${asset}-Konto für ${setupCost} aus deinem SOL-Guthaben`,
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

  send: {
    destLabel: 'Senden an',
    destPlaceholder: 'Adresse einfügen oder scannen',
    scanLabel: 'QR-Code der Zieladresse scannen',
    scanTitle: 'Zieladresse scannen',
    scanCancel: 'Stattdessen von Hand eingeben',

    routeIcrc: (network, fee) => `${network} · in Sekunden da · Gebühr ${fee}`,
    routeIcrcOnRail: (rail, fee) => `${rail} · in Sekunden da · Gebühr ${fee}`,
    routeIcrcUnknownFee: network => `${network} · in Sekunden da · es gilt die Gebühr des Ledgers`,
    routeIcrcOnRailUnknownFee: rail => `${rail} · in Sekunden da · es gilt die Gebühr des Ledgers`,
    routeSolana: network => `${network} · in Sekunden da · es fällt eine kleine SOL-Netzwerkgebühr an`,
    feeUnknown: 'vom Ledger festgelegt',
    routeLegacy: fee => `ICP-Konto · in Sekunden da · Gebühr ${fee}`,
    routeNative: (chain, minutes, min) => `${chain} · etwa ${minutes} Min. · Minimum ${min}`,
    routeNativeNoMin: (chain, minutes) => `${chain} · etwa ${minutes} Min.`,

    refuseWrongChain: (pastedChain, asset, assetChain) =>
      `Das ist eine ${pastedChain}-Adresse. ${asset} wird auf ${assetChain} abgewickelt und kann sie deshalb nicht erreichen — füge stattdessen eine ${assetChain}-Adresse ein.`,
    refuseLegacyNotIcp: asset =>
      `Das ist ein ICP-Account-Identifier — die Form mit 64 Zeichen. Dorthin kann nur ICP selbst gesendet werden; für ${asset} brauchst du den Internet-Computer-Principal des Empfängers (die Schreibweise mit Bindestrichen).`,
    refuseUnrecognised: asset => `Das sieht nicht nach einer Adresse aus, an die ${asset} gesendet werden kann.`,
    refuseMistypedIc: 'Diese Internet-Computer-Adresse ist unvollständig oder vertippt — prüfe, ob du sie ganz kopiert hast.',
    refuseMistypedLegacy: 'Diese ICP-Kontoadresse ist unvollständig oder vertippt — prüfe, ob du alle 64 Zeichen kopiert hast.',
    refuseOwnSubaccount:
      'Das ist ein Unterkonto deiner eigenen Wallet, und dpay zeigt und verwendet nur dein Hauptkonto — dorthin gesendetes Geld würde hier nicht mehr auftauchen. Du besitzt dieses Guthaben bereits: füge die Adresse einer anderen Person ein, um zu senden.',
    selfWarning: 'Das ist deine eigene Adresse. Das Geld kommt direkt zurück, und die Gebühr zahlst du trotzdem.',

    maxLabel: 'Max',
    feeLine: fee => `Netzwerkgebühr ${fee}`,
    totalLine: total => `Gesamt ${total}`,

    savedTitle: 'Gespeicherte Adressen',
    saveNamePlaceholder: 'Name vergeben (optional)',
    forgetLabel: address => `Gespeicherte Adresse ${address} entfernen`,
    unnamed: 'Ohne Namen',

    reviewTitle: 'Prüfen',
    networkRow: 'Netzwerk',
    sendAmount: amount => `${amount} senden`,
    sending: amount => `${amount} werden gesendet…`,
    sent: 'Gesendet',
    sentUnknown: 'Noch nicht bestätigt',
    sentUnknownBody:
      'Die Überweisung wurde übermittelt, ist aber noch nicht bestätigt. Sie kann trotzdem noch ankommen — prüfe gleich dein Guthaben, statt sie noch einmal zu senden.',
    blockIndex: index => `Ledger-Block ${index}`,
    noLedger: 'Für dieses Asset ist kein Ledger konfiguriert, deshalb kann es nicht gesendet werden.',
  },

  sol: {
    createAtaLabel: asset => `Mein ${asset}-Konto erstellen`,
    backToScan: 'Zurück zum Scannen',
    sent: 'Gesendet ✓',
    txSignature: 'Transaktionssignatur',
    copySignatureLabel: 'Transaktionssignatur kopieren',
    copySignature: 'Signatur kopieren',
    sending: amount => `${amount} werden gesendet…`,
    confirmingOnSolana: 'Bestätigung auf Solana — das kann bis zu einer Minute dauern.',
    sendToSolana: asset => `Sende dein ${asset} an eine Solana-Adresse`,
    available: available => `Verfügbar: ${available}`,
    tokenAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: asset => `Für das Senden von ${asset} brauchst du etwas SOL in der Wallet für Netzwerkgebühren — zahle zuerst etwas ein.`,
    reviewTitle: 'Senden prüfen',
    sendAmount: amount => `${amount} senden`,
    recipientAtaNote: (cost, asset) =>
      `Falls die Person noch kein ${asset}-Konto hat, wird es hiermit für sie erstellt (einmalig ≈${cost}, von dir bezahlt).`,
    confirmLabel: asset => `Senden von ${asset} bestätigen`,
  },
};
