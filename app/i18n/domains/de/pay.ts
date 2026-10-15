/**
 * i18n/domains/de/pay.ts - German values for the Pay + Receive screens.
 * Types, key documentation and the reference copy: ../en/pay.ts. Glossary: ../../de.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payDe: PayMessages = {
  notAPaymentCode: 'Das ist kein dpay-Zahlungscode',
  scannedCoinRequest: (coin, uri) =>
    `Das ist eine Zahlungsanfrage für ${coin} (${uri}…). Diese Wallet zahlt auf dem Internet Computer und Solana - benutze eine ${coin}-Wallet.`,
  requestExpired: 'Diese Anfrage ist abgelaufen - frag den Händler nach einem neuen QR-Code',

  sent: amount => (amount ? `${amount} gesendet` : 'Gesendet'),
  alreadyPaid: 'Bezahlt',
  toWho: who => `an ${who}`,
  toWhoAwaiting: who => `an ${who} · warte auf die Bestätigung des Händlers`,
  alreadyNotCharged: (amount, who) => `${amount} an ${who} · nicht erneut belastet`,
  solAwaiting: who =>
    who ? `an ${who} · warte auf die Bestätigung des Händlers` : 'warte auf die Bestätigung des Händlers',
  newPayment: 'Neue Zahlung',

  shareReceipt: 'Beleg teilen',
  shareSignedCode: 'Signierten Code teilen',
  linkCopied: 'Link kopiert ✓',
  copied: 'Kopiert ✓',

  showThisTo: who => `Zeig das ${who}`,
  showThisToMerchant: 'Zeig das dem Händler',
  amountToWho: (amount, who) => `${amount} an ${who}`,
  signedOnThisDevice: 'signiert ✓',
  signedOffline: 'offline signiert ✓',
  waitingToScan: who => `Warte darauf, dass ${who} scannt…`,
  offlineSettles: who =>
    `Offline - ${who} reicht sie ein und wickelt sie ab. Dein Guthaben aktualisiert sich, sobald du wieder online bist.`,
  solOfflineSettles:
    'Offline - der Händler reicht sie ein und wickelt sie ab. Sobald sie bestätigt ist, siehst du sie in deinem Guthaben.',
  handedTo: who => `An ${who} übergeben`,
  handedToMerchant: 'An den Händler übergeben',
  handedOffHint:
    'Markiert die Zahlung als übergeben - dein Guthaben aktualisiert sich, sobald der Händler abwickelt',

  unsupportedAsset: 'Asset nicht unterstützt',
  unsupportedAssetBody: currency =>
    `Diese Zahlung verlangt ein Asset, das diese Wallet nicht bezahlen kann (Währung ${currency}). dpay tauscht nie um - frag den Händler nach einem unterstützten Asset.`,
  paying: 'Du zahlst',
  payAmount: amount => `${amount} bezahlen`,
  notEnoughBalance: 'Dein Guthaben reicht für diese Zahlung nicht aus.',
  localBalanceMayNotCover: 'Dein lokales Guthaben reicht dafür womöglich nicht - der Händler prüft es.',
  approve: 'Freigeben',
  approveA11y: 'Zahlung freigeben',
  approveHint: 'Signiert den angezeigten Betrag mit deinem Schlüssel und sendet ihn',
  signing: 'Signieren…',
  signsOffline: 'Wird offline signiert - der Händler reicht sie ein und wickelt ab.',

  link: {
    title: 'Dieser Zahlungslink kann nicht bezahlt werden',
    part: {recipient: 'das Empfängerkonto', asset: 'der Vermögenswert', network: 'das Netzwerk', amount: 'der Betrag', ref: 'die Referenz'},
    malformed: part => `Im Link fehlt ${part}, oder der Wert ist beschädigt. Frag nach einem neuen Link.`,
    unknownAsset: (token, network) =>
      `Der Link verlangt ${token} auf ${network} - du hältst nichts davon. dpay tauscht nie um: frag nach einem Link in einem Wert, den du hältst.`,
    wrongNetwork: (token, network) =>
      `Der Link verlangt ${token} auf ${network}, aber du hältst ${token} woanders. Zahlen würde dein Geld auf die falsche Chain schicken - frag den Absender nach einem Link auf einem Netzwerk, das du hältst.`,
    hiddenAsset: token =>
      `Der Link verlangt ${token}, einen Testnetz-Wert. Unter „Guthaben“ „Testnetz-Werte anzeigen“ einschalten und den Link erneut öffnen.`,
    unsupportedAsset: token =>
      `Der Link verlangt ${token}, das diese Wallet nicht bezahlen kann. dpay tauscht nie um - frag nach einem Link in einem Wert, den du hältst.`,
    badAmount: (amount, token) =>
      `„${amount}“ ist kein gültiger ${token}-Betrag - prüfe die Nachkommastellen. Frag nach einem neuen Link.`,
    badAccount: network =>
      `Das Konto ist kein gültiges ${network}-Konto. Frag den Absender, es zu prüfen und einen neuen Link zu senden.`,
  },

  ocp: {
    solanaTokenUnsupported: symbol =>
      `Diese Kasse nimmt ${symbol} auf Solana, aber ihr Code sagt nicht, welches Konto zu zahlen ist - das Geld könnte auf dem falschen landen, also zahle mit SOL oder wechsle unter „Guthaben“.`,
    chooseAsset: selected =>
      `Diese Kasse akzeptiert ${selected} nicht, aber eine andere - dpay tauscht nie um.`,
    assetNotAccepted: (selected, accepted) =>
      `Diese Kasse nimmt ${accepted}, nicht ${selected}. dpay tauscht nie um: wechsle unter „Guthaben“ und scanne erneut.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `Die Kasse nimmt ${selected}, aber ihr Anbieter kann sie gerade nicht verarbeiten. Sie nimmt auch ${alternatives} - wechsle unter „Guthaben“ und scanne erneut.`
        : `Die Kasse nimmt ${selected}, aber ihr Anbieter kann sie gerade nicht verarbeiten, und von allem anderen, was sie nimmt, kann diese Wallet nichts bezahlen. Bitte den Händler um eine andere Zahlungsmöglichkeit.`,
    noPayableAsset: accepted =>
      `Diese Kasse nimmt ${accepted} - nichts, das diese Wallet bezahlen kann. dpay tauscht nie um. Bezahle anders.`,
    quoteExpired:
      'Dieser Preis ist abgelaufen - scanne den Code erneut für einen frischen.',
    notEnoughTime:
      'Dieser Preis läuft zu bald ab, um sicher damit zu zahlen - scanne erneut für einen frischen.',
    unreportable: host =>
      `${host} hat keinen Weg genannt, eine Zahlung zu melden - zahlen könnte also dein Geld kosten, ohne dass der Verkauf gutgeschrieben wird. Es wurde nichts bezahlt. Erneutes Scannen hilft nicht - frag den Händler nach einer anderen Zahlungsmöglichkeit.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `Der Preis kommt von ${quoteHost}, aber der Nachweis deiner Zahlung würde an ${proofHost} gehen. Ein Verkauf kann nicht zwei Firmen gegenüber gelten. Es wurde nichts bezahlt - frag den Händler nach seinem Code.`,
    checkoutPrice: (price, host) => `${price} · Preis von ${host}`,
    checkingCheckout: 'Wird beim Zahlungsanbieter geprüft…',
    badCode:
      'Dieser Code ist beschädigt oder gar kein Zahlungscode. Frag den Händler, ihn erneut zu zeigen - achte darauf, dass nichts ihn verdeckt.',
    notHttps:
      'Dieser Code verweist auf eine unsichere Adresse, deshalb öffnet dpay ihn nicht. Frag den Händler nach seinem Code - ein über den echten geklebter Aufkleber sieht identisch aus.',
    providerUnreachable:
      'Der Zahlungsanbieter war nicht erreichbar. Es wurde nichts bezahlt - prüfe deine Verbindung und scanne erneut.',
    badDestination: host =>
      `${host} hat eine Zahlungsadresse geliefert, die nicht zu deiner Auswahl passt. dpay hat abgebrochen. Es wurde nichts bezahlt - zahle diesen Code nicht. Frag den Händler nach einem frischen.`,
    providerRefused: (host, detail) =>
      `Der Zahlungsanbieter (${host}) hat diese Zahlung abgelehnt. Es wurde nichts bezahlt. Frag den Händler, den Verkauf erneut zu buchen, und scanne dann. Wenn es weiter fehlschlägt, zeig ihm, was der Anbieter meldete: „${detail}“.`,
    providerFailed: (host, status) =>
      `Der Zahlungsanbieter (${host}) meldete einen Fehler (${status}) ohne Grund. Es wurde nichts bezahlt. Warte einen Moment und scanne erneut; wenn es weiter fehlschlägt, frag den Händler nach einer anderen Zahlungsmöglichkeit.`,
    badAnswer: (host, part) =>
      `Der Zahlungsanbieter (${host}) hat ${part} geliefert, deshalb kann dpay an dieser Kasse nicht zahlen. Es wurde nichts bezahlt. Scanne erneut und sag dem Händler Bescheid, wenn es weiter passiert.`,
    answerPart: {
      body: 'keine lesbare Antwort',
      details: 'keine vollständigen Zahlungsdaten',
      destination: 'keine Zahlungsadresse',
      expiry: 'keine lesbare Gültigkeitsdauer',
    },
    noPendingCharge: merchant =>
      `An der Kasse von ${merchant} steht kein Betrag offen. Frag das Personal, zuerst einen zu buchen, und scanne dann erneut.`,
    ref: {
      icBlock: index => `Ledger-Block ${index}`,
      solTransaction: signature => `Solana-Transaktion ${signature}`,
    },
    submitUnknown: reference =>
      `Deine Überweisung ging durch, aber der Anbieter hat sie nicht bestätigt - weder bezahlt noch fehlgeschlagen. Das Geld hat deine Wallet verlassen: zahle nicht erneut. Zeig dem Händler ${reference}, den Nachweis deiner Überweisung.`,
    submitPending: reference =>
      `Deine Überweisung ging durch, und der Anbieter wurde informiert - er hat sie diesem Verkauf nur noch nicht zugeordnet; sie wird gutgeschrieben, sobald er sie sieht. Das Geld hat deine Wallet verlassen: zahle nicht erneut. Zeigt die Kasse sie nicht, nenne dem Händler ${reference}.`,
    submitRejected: (reference, said) =>
      `Deine Überweisung ging durch, aber der Anbieter hat den Nachweis abgelehnt - der Verkauf wurde also nicht gutgeschrieben. Das Geld hat deine Wallet verlassen: zahle nicht erneut. Nenne dem Händler ${reference}.`
      + (said === null ? '' : ` Der Anbieter meldet: „${said}“`),
    submitTooLate: reference =>
      `Deine Überweisung ging durch, aber erst nach Ablauf dieses Preises - der Verkauf wurde also nicht gutgeschrieben. Das Geld hat deine Wallet verlassen: zahle nicht erneut. Nenne dem Händler ${reference}.`,
    transferUnknown:
      'Deine Überweisung ist noch nicht bestätigt, deshalb weiß der Händler nichts davon - weder bezahlt noch fehlgeschlagen. Lass diesen Bildschirm offen: dpay prüft weiter und schließt die Zahlung ab, falls die Überweisung durchging. Zahle in der Zwischenzeit nicht erneut.',
    transferRefused: reason =>
      `Die Überweisung ging nicht durch - es wurde nichts bezahlt, und dein Geld ist noch in deiner Wallet: ${reason}. Scanne erneut, um zu zahlen.`,
    transferFailed:
      'Das Solana-Netzwerk hat deine Transaktion abgelehnt - es wurde nichts bezahlt. Dein Betrag ist intakt; eine kleine Netzwerkgebühr wurde berechnet. Scanne erneut für einen neuen Versuch.',
    providerHost: host => `Preis von ${host}`,
  },

  fundsSymbol: 'Guthaben',
  fundTitle: symbol => `Kein ${symbol} verfügbar`,
  fundBody: (symbol, action) =>
    action === 'pay'
      ? `Um eine ${symbol}-Anfrage zu bezahlen, empfange zuerst ${symbol} an deiner Adresse.`
      : `Um ${symbol} zu senden, empfange zuerst ${symbol} an deiner Adresse.`,
  fundBodyNoDeposits: symbol =>
    `dpay kann dafür keine Einzahlungsadresse anzeigen. Empfange ${symbol} von einer anderen Wallet, bevor du es ausgibst.`,
  fundBodyToken: symbol => `Sende ${symbol} (Solana) an deine ${symbol}-Adresse. Behalte etwas SOL in der Wallet für Netzwerkgebühren.`,
  showMyAddress: symbol => `Meine ${symbol}-Adresse zeigen`,
  createTokenAccount: symbol => `Mein ${symbol}-Konto erstellen`,
  fundSibling: {
    holds: (amount, rail) => `Du hältst ${amount} auf ${rail}`,
    switchTo: network => `Wechseln zu ${network}`,
    switchToAsset: asset => `Wechseln zu ${asset}`,
    practice: amount =>
      `Du hast ${amount} Übungsgeld. Übe damit - es hat keinen Gegenwert und kann kein echtes Geschäft bezahlen.`,
    switchToPractice: 'Zum Übungsgeld wechseln',
  },

  offlineSendTitle: 'Senden an eine Adresse braucht eine Verbindung',
  offlineSendBody: symbol =>
    `Scanne stattdessen den Code des Händlers: sein Handy reicht deine ${symbol}-Zahlung ein, während du offline bist.`,
  scannedAddressNotSendable: symbol =>
    `Das ist eine Wallet-Adresse - ${symbol} kann nicht an eine gesendet werden. Scanne einen Zahlungscode, um zu bezahlen.`,

  spay: {
    wrongRail:
      'Das ist ein Solana-Pay-Code. Dieser Bildschirm zahlt über den Internet Computer - wechsle unter Guthaben zu Solana und scanne den Code dort.',
    badUri: 'Dieser Solana-Pay-Code ist beschädigt. Frag den Händler nach einem neuen QR-Code.',
    badRecipient: 'Der Empfänger dieses Codes ist keine gültige Solana-Adresse. Frag den Händler nach einem neuen QR-Code.',
    badAmount: 'Der Betrag dieses Codes ist keine klare Zahl über null. Frag den Händler nach einem neuen QR-Code.',
    badSplToken: 'Der Token-Mint dieses Codes ist ungültig. Frag den Händler nach einem neuen QR-Code.',
    badReference: 'Die Zahlungsreferenz dieses Codes ist ungültig. Frag den Händler nach einem neuen QR-Code.',
    unexpectedParam: param =>
      `Dieser Code trägt einen unbekannten Parameter (${param}) - dpay kann nicht prüfen, was ihn zu zahlen unterschreiben würde. Frag den Händler nach einem Code ohne ihn.`,
    memoTooLong: 'Das Memo dieses Codes ist zu lang für eine Solana-Transaktion. Frag den Händler nach einem neuen QR-Code.',
    unknownMint: mint =>
      `Dieser Code verlangt einen Token, den dpay nicht führt (Mint ${mint}). Zahl ihn mit einer Wallet, die ihn unterstützt.`,
    offline:
      'Bei einem Solana-Pay-Code reicht dein Handy selbst ein - dafür braucht es eine Verbindung. Geh online und scanne erneut.',
    amountLabel: 'Betrag',
    merchantMessage: message => `Vom Händler: ${message}`,
    pendingNote:
      'Das Netzwerk hat diese Zahlung angenommen; die Bestätigung ist noch unterwegs. Die Signatur unten ist dein Nachweis - prüfe sie, bevor du erneut zahlst.',
  },

  wc: {
    unavailable: 'WalletConnect ist nicht verfügbar. Verbinde in der dpay Mobile-App.',
    pairFailed: 'Dieser WalletConnect-Code hat nicht funktioniert. Fordere einen neuen an.',
    connectTitle: 'Eine App möchte sich verbinden',
    requestTitle: 'Signaturanfrage',
    appLabel: 'App',
    chainLabel: 'Netzwerk',
    chainsLabel: 'Netzwerke',
    messageLabel: 'Nachricht',
    domainLabel: 'Domain',
    typeLabel: 'Typ',
    fieldsLabel: 'Felder',
    toLabel: 'An',
    amountLabel: 'Betrag',
    spenderLabel: 'Spender',
    ownerLabel: 'Besitzer',
    deadlineLabel: 'Gültig bis',
    dataLabel: 'Daten',
    rawUnits: amount => `${amount} Roh-Einheiten`,
    unknownCall: 'Unbekannter Kontrakt-Aufruf. Lies die Rohdaten, bevor du freigibst.',
    fromLabel: 'Von',
    mintLabel: 'Mint',
    memoLabel: 'Memo',
    programLabel: 'Programm',
    feePayerLabel: 'Gebührenzahler',
    signersLabel: 'Signer',
    lookupTableProgram: 'Address-Lookup-Tabelle',
    unknownTx: 'Unbekannter Befehl. Prüfe die Rohdaten, bevor du freigibst.',
    rawBytesNote: 'Kein Text - als Rohbytes gezeigt.',
    externalFeePayer: 'Ein anderes Konto zahlt die Gebühr.',
    coSignNote: 'Weitere Signer sind nötig.',
    notSignerNote: 'Diese Wallet unterschreibt diese Transaktion nicht.',
    broadcastNote: 'Freigeben sendet diese Transaktion ins Netzwerk.',
    switchHeadline: chain => `Netzwerk zu ${chain} wechseln`,
    switchUnwired: 'dpay kann nicht zu diesem Netzwerk wechseln.',
    proposalUnsupported: 'dpay unterstützt nicht, was diese App verlangt.',
    approve: 'Freigeben',
    reject: 'Ablehnen',
    submittedTitle: 'Übermittelt',
    submittedNote:
      'Das Netzwerk hat die Transaktion angenommen. Die Bestätigung steht noch aus. Der Hash ist dein Beleg.',
    scanHint: 'WalletConnect-Codes verbinden deine dApps.',
  },

  scanToPay: 'Scannen & zahlen',
  sendToAddress: 'Adresse senden',
  tapOrScanToPay: 'Auflegen oder scannen',
  solScanHint: 'Scanne den Code des Händlers, um offline zu bezahlen.',
  nfcNotAvailable: 'NFC nicht verfügbar',
  whyNfcUnavailable: 'Warum NFC nicht verfügbar ist',
  nfcUnavailableTitle: 'NFC nicht verfügbar',
  close: 'Schließen',

  noCameraFound: 'Keine Kamera gefunden.',
  pointCamera: 'Richte die Kamera auf einen Zahlungscode',
  cameraPrivacy: 'Nur zum Scannen von Codes. Nichts wird aufgezeichnet oder hochgeladen.',
  allowCameraScan: 'Kamera erlauben',
};

export const receiveDe: ReceiveMessages = {
  amountToReceive: 'Zu empfangender Betrag',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Notiz',
  memoPlaceholder: 'Notiz hinzufügen (optional)',
  chooseCurrency: 'Abwicklungswährung wählen',
  chooseCurrencyHint: 'Wähle, welches Asset der Zahler dir sendet',
  request: 'Code anzeigen',
  creating: 'Wird erstellt…',
  solanaOffline: 'Solana ist offline - geh online, um eine Zahlungsanfrage zu erstellen.',
  solAmountUnderFee: fee =>
    `Eine SOL-Anfrage muss über der Netzwerkgebühr liegen (${fee}). Die Gebühr trägst du - der Zahler zahlt exakt den Betrag, den du eingibst.`,
  solFeeLine: (fee, receives) => `Gebühr ${fee} · du erhältst ${receives}`,

  receiveInTitle: 'Empfangen in',
  receiveIn: symbol => `In ${symbol} empfangen`,
  switchToRail: symbol => `Zu ${symbol} wechseln`,

  requestPayment: 'Anfordern',
  myAddress: 'Meine Adresse',
  rail: {
    feeLine: (network, fee) => `${network} · Gebühr ${fee}`,
    feeWithOneTime: (network, fee, oneTime) => `${network} · Gebühr ${fee} + einmalige Miete ${oneTime}`,
    feeUnknown: network => `${network} · Gebühr unbekannt`,
  },
  feeNetLine: (fee, net) => `Gebühr ${fee} · du erhältst ${net}`,
  feeTooBig: fee => `Dieser Betrag deckt die Netzwerkgebühr (${fee}) nicht - fordere einen höheren Betrag.`,
  showToPayer: nfc =>
    `Zeig das dem Zahler${nfc === 'tap' ? ' · oder per Tap' : nfc === 'expired' ? ' · NFC-Tap abgelaufen' : ''}`,
  expiredMakeNew: 'Abgelaufen - erstelle eine neue Anfrage',
  validForMin: minutes => `Gültig für ~${minutes} Min.`,
  expiresIn: seconds => `Läuft ab in 0:${seconds}`,
  waitingForPayment: online => `Warte auf Zahlung${online ? '…' : ' - zum Einreichen wieder verbinden…'}`,
  waitingForSign: 'Warte darauf, dass der Zahler offline signiert…',
  offlineCantSubmit: 'Offline - Zahlungen können erst nach erneuter Verbindung eingereicht werden',
  shareRequestLink: 'Anfrage-Link teilen',
  linkUnavailable: 'Dieser Wert lässt sich nicht in einem Zahlungscode benennen. Wähle einen anderen Wert, um eine Zahlung anzufragen.',
  scanPayerSignedCode: 'Signierten Code des Zahlers scannen',
  confirmWithTheirPhone:
    'Wenn der Zahler ohne Scan deines Codes bezahlt hat, bestätige es mit seinem Handy.',
  newRequest: 'Neue Anfrage',
  back: 'Zurück',

  payer: 'Zahler',
  receivedAmount: amount => `${amount} empfangen`,
  fromWho: who => `von ${who}`,
  transactionSignature: 'Transaktionssignatur',
  copySignature: 'Signatur kopieren',
  copySignatureA11y: 'Transaktionssignatur kopieren',
  sharedConfirm: 'Geteilt ✓',

  receiptMalformed: 'Dieser Beleg-Link ist fehlerhaft.',
  receiptMismatch: 'Dieser Beleg passt nicht zu deiner offenen Anfrage.',
  receiptUnreadable: 'Dieser Beleg-Link konnte nicht gelesen werden.',
  couldNotConfirmYet:
    'Diese Zahlung konnte noch nicht bestätigt werden - falls der Zahler bezahlt hat, erscheint sie bei der nächsten Guthabenaktualisierung.',
  unknownLedger: 'Unbekanntes Ledger für dieses Asset - Einreichen nicht möglich',
  couldNotSubmit: 'Die Zahlung konnte nicht eingereicht werden. Scanne sie erneut. Ist sie durchgegangen, erscheint sie in deinem Guthaben.',
  noOpenRequest: 'Keine offene Anfrage.',
  paymentRejected: 'Zahlung abgelehnt.',
  paymentRejectedDetail:
    'Zahlung abgelehnt - dem Zahler fehlt vielleicht Guthaben, oder der Blockhash ist abgelaufen.',
  couldNotConfirmMaySettle:
    'Nicht bestätigt - die Zahlung kann trotzdem noch abgewickelt werden. Prüfe gleich dein Guthaben oder versuche es erneut.',
  stillCannotConfirm:
    'Weiterhin nicht bestätigt - die Zahlung kann trotzdem noch abgewickelt werden. Versuche es später erneut.',
  settlementNotVerified:
    'Bestätigt, aber die On-Chain-Transaktion stimmt nicht mit dieser Anfrage überein. Übergib die Ware noch nicht - prüfe die Signatur in einem Solana-Explorer und beobachte dein Guthaben; die Zahlung kann trotzdem noch ankommen.',
  savedDataCorrupt: 'Die gespeicherten Zahlungsdaten sind beschädigt.',
  paymentBeingConfirmed: 'Eine Zahlung wird gerade bestätigt',
  broadcastInterrupted:
    'Eine Übertragung wurde unterbrochen. Die Zahlung kann abgewickelt worden sein - versuche es erneut, um das zu prüfen.',
  retryBroadcast: 'Übertragung erneut versuchen',
  broadcasting: 'Übertragung auf Solana - das kann bis zu einer Minute dauern.',

  checkout: {
    checkoutCode: 'Zeigt zusätzlich einen Kassen-Code für OpenCryptoPay-Apps (Binance Pay, MoonPay) - die App muss beim Zahler geöffnet sein',

    openChargeHint: 'Diesen Betrag auf deiner Kasse buchen und der Kundschaft einen zahlbaren Code zeigen',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'Ein Kassenbetrag geht auf ganze Rappen - buche 10.50, nicht 10.505.'
        : reason === 'too-large'
        ? 'Dieser Betrag ist zu gross für eine Buchung. Gib ein, was diese Kundschaft schuldet.'
        : 'Gib den zu belastenden Betrag ein, zum Beispiel 10.50.',

    wrongAssetTitle: 'Ein Kassen-Code wird in VCHF bezahlt',
    wrongAsset: (selected, network) =>
      `Ein Kassen-Code wird immer in VCHF auf dem Internet Computer bezahlt - dpay tauscht nie um. Diese Anforderung lautet auf ${selected}${network ? ` auf ${network}` : ''}. Wechsle zu VCHF - oder bleib beim dpay-Code: jede Handykamera öffnet ihn, und er wird in ${selected} bezahlt.`,
    noCheckoutAsset:
      'Diese Wallet führt kein VCHF, also gibt es kein Konto für eine Kassenbuchung. Nimm den dpay-Code - jede Handykamera öffnet ihn, und er nimmt den gewählten Wert an.',
    switchTo: asset => `Zu ${asset} wechseln`,

    failedTitle: 'Der Betrag wurde nicht gebucht',
    notServed: host =>
      `${host} bietet keine Kassen-Codes an; es wurde nichts gebucht. Frag die Person, die dieses Relay betreibt, die Kasse einzuschalten - oder nimm den dpay-Code.`,
    unreachable: host =>
      `Deine Verbindung ist in Ordnung, aber ${host} antwortet nicht; es wurde nichts gebucht. Versuche es gleich noch einmal, oder nimm den dpay-Code (zeigt dieses Telefon auch offline).`,
    unreachableOffline: host =>
      `Du scheinst offline zu sein, daher wurde ${host} nicht erreicht und nichts gebucht. Nimm vorerst den dpay-Code oder versuche es erneut, sobald du wieder online bist.`,
    refused: said =>
      `Die Kasse hat diese Buchung abgelehnt: „${said}“ Nichts ist bezahlbar. Bring das in Ordnung und buche erneut.`,
    refusedNoReason: status =>
      `Die Kasse hat diese Buchung ohne Grund abgelehnt (HTTP ${status}) - nichts ist bezahlbar. Buche erneut; lehnt sie zweimal ab, sag der Person Bescheid, die das Relay betreibt.`,
    mispriced: (gebucht, gemeldet) =>
      `Du hast ${gebucht} gebucht, die Kasse hat aber ${gemeldet} zurückgemeldet - dpay zeigt keinen Code für einen Betrag, den niemand gewählt hat. Buche erneut; wenn es wieder passiert, sag der Person Bescheid, die das Relay betreibt, bevor du Geld annimmst.`,
    servedOther: (served, picked) =>
      `Die Kasse hat diese Buchung in ${served} eröffnet, nicht in ${picked} - sie unterstuetzt ${picked} noch nicht. Buche erneut in ${served} oder sag der Person Bescheid, die das Relay betreibt.`,
    unsigned:
      'Dieses Telefon konnte die Buchung nicht signieren; nichts ist bezahlbar. Starte dpay neu und buche erneut.',
    tryAgain: 'Erneut versuchen',

    settleOption: (token, currency) => `${token} · ${currency}`,

    settlesAs: (amount, price) =>
      `Sie erhalten ${amount} - die Ledger-Gebühr tragen Sie, die Kundschaft zahlt also ${price}.`,
    collecting: 'Die freigegebene Zahlung wird eingezogen …',
    collectNotApproved:
      'Die Kundschaft hat zu wenig freigegeben, oder die Freigabe ist abgelaufen. Bitten Sie sie, den Code noch einmal zu bezahlen - es wurde nichts abgebucht.',
    collectNoFunds:
      'Die Kundschaft hat freigegeben, hat aber nicht das Geld. Es wurde nichts abgebucht - bitten Sie sie, aufzuladen und erneut zu bezahlen.',
    collectFailed:
      'Die freigegebene Zahlung konnte nicht eingezogen werden; es wurde nichts abgebucht. Der Code ist weiterhin zahlbar - bitten Sie sie, erneut zu scannen oder zu tappen.',
    noFeeTitle: 'Diese Kasse kann keinen Betrag berechnen',
    noFee: (symbol, host) =>
      `Die Ledger-Gebühr trägt das Geschäft und wird vom Preis abgezogen, aber dpay kennt keine Gebühr für ${symbol} - ein Betrag würde sie also still der Kundschaft berechnen. Es ist nichts zahlbar. Aktualisieren Sie dpay, oder melden Sie der Betreiberin von ${host}, dass in der Währungsliste die ${symbol}-Gebühr fehlt.`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Zeig das der Kundschaft - jede Handykamera öffnet es; ein dpay-Handy kann es auch auflegen.'
        : nfc === 'expired'
        ? 'Zeig das der Kundschaft - jede Handykamera öffnet es. Das Auflegen ist bei diesem Code abgelaufen; buch neu für Tap-Zahlungen.'
        : 'Zeig das der Kundschaft - jede Handykamera öffnet es und bezahlt.',
    waiting: 'Warten auf die Zahlung…',
    cantCheck:
      'Diese Buchung lässt sich gerade nicht prüfen - die Kasse ist nicht erreichbar. Das heisst NICHT, dass sie unbezahlt ist. Lass den Code stehen; dieser Bildschirm aktualisiert sich beim erneuten Kontakt.',
    expiredWatching:
      'Dieser Code ist abgelaufen, neu bezahlen kann ihn niemand mehr. Falls die Kundschaft bezahlt hat, kann das Geld noch ankommen - es wird noch einen Moment beobachtet.',
    cancel: 'Buchung stornieren',
    cancelling: 'Wird storniert…',
    cancelFailed: said =>
      `Die Buchung wurde NICHT storniert: „${said}“ Sie kann weiterhin bezahlbar sein - entscheide dann, ob du etwas herausgibst.`,
    cancelFailedNoReason: status =>
      `Die Buchung wurde NICHT storniert (HTTP ${status}) - behandle sie als weiterhin bezahlbar. Versuch es erneut; gib nichts heraus, bis sie storniert ist oder abläuft.`,
    cancelUnreachable: host =>
      `Deine Verbindung ist in Ordnung, aber ${host} antwortet nicht, diese Buchung wurde also NICHT storniert - sie bleibt bezahlbar, bis sie abläuft. Versuche es gleich noch einmal.`,
    cancelUnreachableOffline: host =>
      `Du scheinst offline zu sein, daher wurde ${host} nicht erreicht und diese Buchung NICHT storniert - sie bleibt bezahlbar, bis sie abläuft. Versuche es erneut, sobald du wieder online bist.`,

    endedTitle: reason =>
      reason === 'expired' ? 'Dieser Code ist abgelaufen'
      : reason === 'cancelled' ? 'Buchung storniert'
      : reason === 'superseded' ? 'Durch eine neuere Buchung ersetzt'
      : 'Die Kasse kennt diese Buchung nicht mehr',
    endedBody: reason =>
      reason === 'expired'
        ? 'Es ist nichts eingegangen, und bezahlen kann ihn jetzt niemand mehr. Buche erneut und zeig der Kundschaft einen frischen Code.'
        : reason === 'cancelled'
        ? 'Darauf ist nichts geschuldet, und bezahlen kann sie niemand. Buche erneut, wenn die nächste Kundschaft dran ist.'
        : reason === 'superseded'
        ? 'Auf dieser Kasse wurde eine neuere Buchung erfasst, dieser Code nimmt kein Geld mehr an. Buche erneut und zeig einen frischen Code.'
        : 'Das Relay hat sie nicht mehr - höchstwahrscheinlich wurde es neu gestartet. Es wurde nichts gutgeschrieben. Buche erneut; sagt die Kundschaft, sie habe bezahlt, prüfe erst deinen VCHF-Bestand und die Transaktionen.',
    openChargeNext: 'Nächste Kundschaft',

    paidAmount: price => `Bezahlt ${price}`,
    paidBlock: block => `Ledger-Block ${block}`,
    paidLate: 'Das kam nach Ablauf des Codes an - angenommen, das Geld liegt im Ledger.',
  },
};
