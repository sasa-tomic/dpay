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
    copyDepositAddress: 'Einzahlungsadresse kopieren',
    statusTitle: 'Status',
    watching: 'Wir warten auf deine Einzahlung',
    checkingEvery: seconds => `Prüfung alle ${seconds}s`,
    checkNowLabel: 'Einzahlungsstatus jetzt prüfen',
    mintedAmount: amount => `${amount} gutgeschrieben`,
  },

  icrc: {
    whereFrom: (symbol, network) => [
      {t: 'Sende '},
      {t: symbol, em: true},
      {t: ' aus einer beliebigen Wallet, die es auf '},
      {t: network, em: true},
      {t: ' hält, oder zahle es von einer Börse aus, die das Netzwerk unterstützt.'},
    ],
    onlyAccepts: (symbol, network) =>
      `Diese Adresse empfängt ${symbol}, das über ${network} gesendet wird — alles andere wird nicht gutgeschrieben.`,
    noMemo: 'Kein Memo und keine Referenz nötig.',
    feeLine: fee => `Netzwerkgebühr ${fee}`,
    receivedAmount: amount => `${amount} empfangen`,
    alsoTitle: 'Schon auf dem Internet Computer?',
    alsoBody: symbol => [
      {t: 'Sende '},
      {t: symbol, em: true},
      {t: ' von jeder Internet-Computer-Wallet an deine IC-Adresse unten. Kein Memo nötig.'},
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
    connectFailed: 'Verbindung zu deiner Wallet fehlgeschlagen. Öffne deine Wallet-App, bestätige dort die Verbindungsanfrage und versuch es dann erneut.',
    noWalletApp: 'Keine Wallet-App gefunden. Scanne den QR-Code stattdessen mit einer Wallet auf einem anderen Gerät.',
    walletDisconnected: 'Wallet getrennt.',
    amountRequired: 'Gib einen Betrag größer als null ein.',
    missingErc20Address: 'In den Einzahlungsdetails fehlt die ERC-20-Adresse.',
    txReverted: 'Die Transaktion wurde on-chain zurückgewiesen.',
    txUnconfirmed: 'Transaktion gesendet, aber noch nicht bestätigt — wir warten weiter auf die Gutschrift.',
    approveReverted:
      'Die Freigabe wurde on-chain zurückgewiesen. Es wurde keine Einzahlung gesendet und kein Geld hat deine Wallet verlassen. Versuch es erneut — deine Wallet fragt zuerst nach der Freigabe und dann nach der Einzahlung.',
    approveUnconfirmed:
      'Die Freigabe wurde gesendet, aber nicht bestätigt, es hat also kein Geld deine Wallet verlassen. Warte einen Moment und versuch es erneut — deine Wallet fragt dann noch einmal nach der Freigabe. Das ist normal und kostet nur Gas.',
    depositHashUnknown:
      'Prüf die letzten Aktivitäten in deiner Wallet, bevor du es erneut versuchst. Ist die Einzahlung dort, wird sie in etwa 20 Minuten gutgeschrieben — eine zweite Einzahlung würde doppelt bezahlen.',
    approveHashUnknown:
      'Es wurde nichts eingezahlt und kein Geld hat deine Wallet verlassen. Prüf die letzten Aktivitäten in deiner Wallet und versuch es dann erneut — sie fragt zuerst nach der Freigabe, das ist normal und kostet nur Gas.',
    txNotSigned: 'Transaktion nicht signiert.',
    txFailed: 'Transaktion fehlgeschlagen.',
    allowanceStands:
      'Deine Freigabe ist bereits on-chain bestätigt, und kein Geld hat deine Wallet verlassen. Ein erneuter Versuch fragt beide Signaturen wieder ab: Freigabe, dann Einzahlung.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Sende nur '},
      {t: nativeAsset, em: true},
      {t: ' auf '},
      {t: networkLabel, em: true},
      {t: '. Alles andere, das so gesendet wird, wird nicht gutgeschrieben und kann verloren gehen.'},
    ],
    mintLine: 'Deine Einzahlung wird nach der Bestätigung (~20 Min.) 1:1 deiner Wallet gutgeschrieben.',
    details: 'Details',
    gasNative: 'Die Netzwerkgebühr wird in ETH bezahlt — sende etwas mehr, als du einzahlen willst.',
    gasErc20: 'Du brauchst etwas ETH für die Gas-Gebühren des Netzwerks.',
    scanToPair: 'Zum Koppeln mit deiner Wallet scannen',
    orOpenHere: 'Oder öffne eine Wallet auf diesem Handy:',
    openNamedWallet: name => `${name} öffnen`,
    otherWallet: 'Andere Wallet',
    otherWalletHint:
      'Das Koppeln funktioniert, aber dpay kann sie später nicht für dich öffnen — wechsle zum Bestätigen der Einzahlung selbst dorthin.',
    couldntOpenWallet: name =>
      `${name} konnte nicht geöffnet werden — die App ist vielleicht nicht installiert. Wähle eine andere Wallet oder scanne den QR-Code mit einer Wallet auf einem anderen Gerät.`,
    walletList: 'MetaMask · Trust · Rabby · jede WalletConnect-kompatible Wallet',
    explainNative:
      'Sende ETH direkt an den Einzahlungs-Contract — eine signierte Transaktion, mit deinem Einzahlungsbetrag als ETH-Wert.',
    explainErc20: nativeAsset =>
      `${nativeAsset} ist ein Ethereum-Token. Die Einzahlung braucht zwei signierte Transaktionen: erst die Freigabe, dann die Einzahlung.`,
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
      `Mit deiner Adresse ist alles in Ordnung — dpay erreicht Solana nur gerade nicht, um dein ${asset}-Konto zu bestätigen. Prüfe deine Verbindung und versuche es erneut.`,
    ataUnverifiedRefused: asset =>
      `Mit deiner Adresse ist alles in Ordnung — Solana hat die Anfrage abgelehnt, daher konnte dein ${asset}-Konto nicht bestätigt werden. Es hat sich nichts bewegt. Versuche es gleich noch einmal.`,
    ataUnverifiedOffline: asset =>
      `Mit deiner Adresse ist alles in Ordnung — du scheinst offline zu sein, daher konnte dein ${asset}-Konto nicht bestätigt werden. Es hat sich nichts bewegt. Prüfe erneut, sobald du wieder online bist.`,
    ataUnverifiedUnreachable: asset =>
      `Mit deiner Adresse ist alles in Ordnung — dpays Relay erreicht Solana nicht, daher konnte dein ${asset}-Konto nicht bestätigt werden. Deine Verbindung ist in Ordnung; dein Geld ist unangetastet, und deine Internet-Computer-Zahlungen funktionieren weiter. Versuche es gleich noch einmal.`,
    ataUnverifiedUnreadable: asset =>
      `Mit deiner Adresse ist alles in Ordnung — Solana hat Daten gesendet, die dpay nicht lesen kann, daher konnte dein ${asset}-Konto nicht bestätigt werden. Es hat sich nichts bewegt. Versuche es gleich noch einmal.`,
    retryAtaLabel: asset => `${asset}-Konto erneut prüfen`,
    checkAgain: 'Erneut prüfen',
    backToRequest: 'Zurück zur Anfrage',
    sendToAddress: (asset, network) => [
      {t: 'Sende '},
      {t: asset, em: true},
      {t: ' an deine '},
      {t: network},
      {t: '-Adresse unten.'},
    ],
    devnetWarn: asset =>
      `Verbunden mit dem Solana-Devnet. Sende hier KEIN Mainnet-${asset} — es erscheint nicht. Nutze nur Devnet-${asset}.`,
    waitingDeposit: 'Wir warten auf deine Einzahlung · Prüfung alle paar Sekunden',
    copyAssetAddress: asset => `${asset}-Adresse kopieren`,
  },

  ata: {
    absent: asset => `Du hast auf diesem Gerät noch kein ${asset}-Konto.`,
    cost: (setupCost, asset) =>
      `Das Erstellen deines ${asset}-Kontos kostet ${setupCost}, bezahlt aus deinem SOL-Guthaben. Es bleibt deins, unter deinen Schlüsseln.`,
    checkingSol: 'Dein SOL-Guthaben wird geprüft…',
    needSol: setupCost =>
      `Du brauchst zuerst etwa ${setupCost} hier. Empfange SOL an deiner Adresse und erstelle dann das Konto.`,
    showSolAddress: 'Meine SOL-Adresse zeigen',
    creating: asset => `Dein ${asset}-Konto wird erstellt — Bestätigung auf Solana…`,
    createHint: (setupCost, asset) => `Erstellt dein ${asset}-Konto für ${setupCost} aus deinem SOL-Guthaben`,
  },

  trust: {
    fund: 'Aus Trust Wallet aufladen',
    fundHint: asset => `Öffnet Trust Wallet, um ${asset} an deine dpay-Adresse zu senden`,
    err: 'Trust Wallet konnte nicht geöffnet werden. Versuche es erneut.',
  },

  funding: {
    title: 'Noch nichts davon?',
    buyThenSend: (token, chain) => [
      {t: 'Kaufen Sie '},
      {t: token, em: true},
      {t: ' bei einer Börse oder einem Kartenanbieter mit Auszahlung auf '},
      {t: chain, em: true},
      {t: ' und senden Sie es an die Adresse oben.'},
    ],
    bridgeWithGas: (token, chain, gasToken) => [
      {t: 'Dafür existiert keine Adresse. Kaufen Sie '},
      {t: token, em: true},
      {t: ' auf '},
      {t: chain, em: true},
      {t: ' in eine Wallet, die Ihnen gehört, und halten Sie dort etwas '},
      {t: gasToken, em: true},
      {t: ' für die Gebühren bereit. Verbinden Sie dann diese Wallet hier — sie signiert die Überweisung.'},
    ],
    bridgeSelfGas: (token, chain) => [
      {t: 'Dafür existiert keine Adresse. Kaufen Sie '},
      {t: token, em: true},
      {t: ' auf '},
      {t: chain, em: true},
      {t: ' in eine Wallet, die Ihnen gehört — etwas mehr, als Sie bewegen wollen, denn die Gebühr geht davon ab. Verbinden Sie dann diese Wallet hier — sie signiert die Überweisung.'},
    ],
    buyThenConvert: (viaToken, target) => [
      {t: 'Kein Anbieter verkauft '},
      {t: target, em: true},
      {t: ' direkt. Kaufen Sie '},
      {t: viaToken, em: true},
      {t: ' mit Karte kaufen, an die Adresse oben senden und dann über Umtauschen in '},
      {t: target, em: true},
      {t: ' tauschen.'},
    ],
    testnetOnly: (symbol, chain) => `${symbol} ist Testgeld ohne Gegenwert — es wird nirgends verkauft. Holen Sie sich welches kostenlos bei einem öffentlichen ${chain}-Faucet und senden Sie es an die Adresse oben.`,
    testnetOnlyWallet: (symbol, chain) => `${symbol} ist Testgeld ohne Gegenwert — es wird nirgends verkauft. Holen Sie sich welches kostenlos bei einem öffentlichen ${chain}-Faucet in eine eigene Wallet und verbinden Sie diese Wallet hier.`,
    bankRoute: provider => `Von einem Schweizer Bankkonto verkauft ${provider} es per Überweisung. Dafür ist eine vollständige Identitätsprüfung nötig, und es dauert so lange wie eine Banküberweisung.`,
    providersTitle: 'Wo man es kauft',
    costCard: rate => `Karte ${rate}`,
    costBank: rate => `Bank ${rate}`,
    costSepa: rate => `SEPA ${rate}`,
    costWalletPay: rate => `Apple & Google Pay ${rate}`,
    costMin: amount => `mind. ${amount}`,
    costSpread: rate => `zzgl. ${rate} Marge`,
    plusFixed: fixed => `zzgl. ${fixed}`,
    nonUsdUplift: (from, to) => `Käufe in anderen Währungen als USD: Mindestgebühr um ${from} bis ${to} höher, je nach Währung`,
    qEur: 'EUR',
    qNonEur: 'Nicht-EUR',
    qUsdEurGbp: 'USD, EUR, GBP',
    qOtherCurrencies: 'andere Währungen, u. a. CHF',
    qManual: 'manual',
    qEasy: 'easy',
    qPix: 'Pix',
    upTo: pct => `bis zu ${pct}`,
    from: pct => `ab ${pct}`,
    attribution: readOn => `Jeweils die vom Anbieter selbst veröffentlichten Angaben, abgerufen am ${readOn}. Es sind Obergrenzen, keine Preise. Ihre genaue Gebühr wird vor der Zahlung angezeigt; die meisten Anbieter rechnen zusätzlich eine Marge im Kurs ein.`,
    noEndorsement: 'Alphabetisch aufgeführt. dpay empfiehlt keinen davon, wird von keinem bezahlt und ist an Ihrem Kauf nicht beteiligt.',
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
      'Beim Schließen der App lief eine Auszahlung. Ein erneuter Versuch sendet dieselbe Zahlung noch einmal — doppelt ausgeben ist ausgeschlossen.',
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
    amountPlaceholder: '0.00050000',
    belowMin: min => `Unter der Mindestauszahlung von ${min}.`,
    gasNote: 'Du brauchst ckETH für Gas. Füge zuerst welches hinzu, falls du keins hast.',
    inProgress: 'Auszahlung läuft',
    withdrawAmount: amount => `${amount} auszahlen`,
    resumeNote:
      'Bereits signiert — ein erneuter Versuch sendet dieselbe Zahlung noch einmal (doppelt ausgeben ist ausgeschlossen). Wenn du das Formular änderst, startet eine neue Auszahlung.',
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
      `Das ist ein ICP-Account-Identifier — die Form mit 64 Zeichen. Dorthin kann nur ICP gesendet werden. Für ${asset} brauchst du den Internet-Computer-Principal des Empfängers (die Schreibweise mit Bindestrichen).`,
    refuseUnrecognised: asset => `Das sieht nicht nach einer Adresse aus, an die ${asset} gesendet werden kann.`,
    refuseMistypedIc: 'Diese Internet-Computer-Adresse ist unvollständig oder vertippt — prüfe, ob du sie ganz kopiert hast.',
    refuseMistypedLegacy: 'Diese ICP-Kontoadresse ist unvollständig oder vertippt — prüfe, ob du alle 64 Zeichen kopiert hast.',
    refuseOwnSubaccount:
      'Das ist ein Unterkonto deiner eigenen Wallet. dpay zeigt und verwendet nur dein Hauptkonto, daher würde dorthin gesendetes Geld hier nicht mehr auftauchen. Du besitzt dieses Guthaben bereits — füge die Adresse einer anderen Person ein, um zu senden.',
    selfWarning: 'Das ist deine eigene Adresse. Das Geld kommt direkt zurück, und die Gebühr zahlst du trotzdem.',

    maxLabel: 'Max',
    feeLine: fee => `Netzwerkgebühr ${fee}`,
    totalLine: total => `Gesamt ${total}`,

    savedTitle: 'Gespeicherte Adressen',
    saveNamePlaceholder: 'Name vergeben (optional)',
    forgetLabel: address => `Gespeicherte Adresse ${address} entfernen`,
    unnamed: 'Ohne Namen',
    manage: 'Adressbuch',
    manageHint: 'Gespeicherte Adressen anzeigen, benennen und entfernen',

    reviewTitle: 'Prüfen',
    networkRow: 'Netzwerk',
    sendAmount: amount => `${amount} senden`,
    sending: amount => `${amount} werden gesendet…`,
    sent: 'Gesendet',
    sentUnknown: 'Noch nicht bestätigt',
    sentUnknownBody:
      'Die Überweisung wurde übermittelt, ist aber noch nicht bestätigt. Sie kann trotzdem noch ankommen — prüfe gleich dein Guthaben, statt sie noch einmal zu senden.',
    blockIndex: index => `Ledger-Block ${index}`,
    noLedger: 'Dieses Asset hat keinen Ledger, deshalb kann es nicht gesendet werden.',
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
