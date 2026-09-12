/**
 * i18n/domains/de/pay.ts — German values for the Pay + Receive screens.
 * Types, key documentation and the reference copy: ../en/pay.ts. Glossary: ../../de.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payDe: PayMessages = {
  notAPaymentCode: 'Das ist kein dpay-Zahlungscode',
  scannedCoinRequest: (coin, uri) =>
    `Das ist eine Zahlungsanfrage für ${coin} (${uri}…). dpay kann sie nicht bezahlen — diese Wallet wickelt auf dem Internet Computer und Solana ab, nicht im ${coin}-Netzwerk. Bezahle sie mit einer Wallet, die ${coin} unterstützt.`,
  requestExpired: 'Diese Anfrage ist abgelaufen — bitte den Händler um einen neuen QR-Code',
  solRequestExpired: 'Diese Zahlungsanfrage ist abgelaufen. Bitte den Händler um einen neuen QR-Code.',

  sent: amount => (amount ? `${amount} gesendet` : 'Gesendet'),
  alreadyPaid: 'Bereits bezahlt',
  toWho: who => `an ${who}`,
  toWhoAwaiting: who => `an ${who} · warte auf die Bestätigung des Händlers`,
  alreadyNotCharged: (amount, who) => `${amount} an ${who} · nicht erneut belastet`,
  solAwaiting: who =>
    who ? `an ${who} · warte auf die Bestätigung des Händlers` : 'warte auf die Bestätigung des Händlers',
  balanceUpdatesOnSettle: 'Dein Guthaben aktualisiert sich, sobald der Händler die Zahlung on-chain abwickelt.',
  newPayment: 'Neue Zahlung',

  shareReceipt: 'Beleg teilen',
  shareReceiptHint: 'Teilt den Zahlungsnachweis als Link, den der Händler zur Bestätigung öffnen kann',
  shareAuthCode: 'Freigabecode teilen',
  shareSignedPayment: 'Signierte Zahlung teilen',
  shareSignedCode: 'Signierten Code teilen',
  linkCopied: 'Link kopiert ✓',
  copied: 'Kopiert ✓',

  showThisTo: who => `Zeig das ${who}`,
  showThisToMerchant: 'Zeig das dem Händler',
  amountToWho: (amount, who) => `${amount} an ${who}`,
  signedOnThisDevice: 'auf diesem Gerät signiert ✓',
  signedOffline: 'offline signiert ✓',
  waitingToScan: who => `Warte darauf, dass ${who} scannt…`,
  offlineSettles: who =>
    `Offline — ${who} wickelt die Zahlung beim Einreichen ab. Sobald du wieder online bist, siehst du sie in deinem Guthaben.`,
  solOfflineSettles:
    'Offline — der Händler wickelt die Zahlung beim Einreichen ab. Sobald sie bestätigt ist, siehst du sie in deinem Guthaben.',
  handedTo: who => `An ${who} übergeben`,
  handedToMerchant: 'An den Händler übergeben',
  handedOffHint:
    'Markiert die signierte Zahlung als übergeben; dein Guthaben aktualisiert sich, sobald der Händler abwickelt',

  unsupportedAsset: 'Asset nicht unterstützt',
  unsupportedAssetBody: currency =>
    `Diese Zahlung verlangt ein Asset, das diese Wallet nicht bezahlen kann (Währung ${currency}). dpay tauscht nie um, deshalb gibt es keinen Ausweg. Bitte den Händler, ein unterstütztes Asset anzufordern.`,
  paying: 'Du zahlst',
  payAmount: amount => `${amount} bezahlen`,
  notEnoughBalance: 'Dein Guthaben reicht für diese Zahlung nicht aus.',
  localBalanceMayNotCover: 'Dein lokales Guthaben reicht dafür möglicherweise nicht — der Händler prüft es.',
  approve: 'Freigeben',
  approveA11y: 'Zahlung freigeben',
  approveHint: 'Signiert den angezeigten Betrag mit deinem Schlüssel und sendet ihn',
  signing: 'Signieren…',
  signsOffline: 'Das wird offline signiert — der Händler wickelt beim Einreichen ab.',

  link: {
    title: 'Dieser Zahlungslink kann nicht bezahlt werden',
    part: {recipient: 'das Empfängerkonto', asset: 'der Vermögenswert', network: 'das Netzwerk', amount: 'der Betrag', ref: 'die Referenz'},
    malformed: part => `Im Link fehlt ${part} oder der Wert ist beschädigt. Bitte den Absender um einen neuen Link.`,
    unknownAsset: (token, network) =>
      `Der Link verlangt ${token} auf ${network}. Diese Wallet kennt diesen Wert nicht, und dpay tauscht nie um — es gibt keinen Ersatz. Bitte den Absender um einen Link in einem Wert, den du hältst.`,
    wrongNetwork: (token, network) =>
      `Der Link verlangt ${token} auf ${network}. Du hältst ${token} auf einem anderen Netzwerk — das ist ein anderer Vermögenswert, und die Zahlung ginge auf die falsche Chain. Bitte den Absender um einen Link auf einem Netzwerk, das du hältst.`,
    hiddenAsset: token =>
      `Der Link verlangt ${token}, einen Testnetz-Wert. Öffne „Guthaben“, aktiviere „Testnetz-Werte anzeigen“ und öffne den Link erneut.`,
    unsupportedAsset: token =>
      `Der Link verlangt ${token}. Diese Wallet kann das nicht bezahlen, und dpay tauscht nie um. Bitte den Absender um einen Link in einem Wert, den du hältst.`,
    badAmount: (amount, token) =>
      `„${amount}“ ist kein gültiger ${token}-Betrag — womöglich hat er mehr Nachkommastellen, als ${token} kennt. Bitte den Absender um einen neuen Link.`,
    badAccount: network =>
      `Das Konto in diesem Link ist kein gültiges ${network}-Konto. Bitte den Absender, es zu prüfen und den Link erneut zu senden.`,
  },

  ocp: {
    solanaTokenUnsupported: symbol =>
      `Diese Kasse nimmt ${symbol} auf Solana, aber ihr Code nennt kein Token-Konto als Ziel — eine Zahlung könnte echtes Geld auf das falsche Konto schicken. Zahle stattdessen mit SOL oder wechsle unter „Guthaben“ zu einem anderen Wert, den diese Kasse nimmt.`,
    chooseAsset: selected =>
      `Diese Kasse akzeptiert ${selected} nicht, aber diese hier — wähle eines zum Bezahlen. dpay tauscht nie um: Du zahlst mit dem gewählten Vermögenswert.`,
    assetNotAccepted: (selected, accepted) =>
      `Diese Kasse nimmt kein ${selected}. Sie nimmt ${accepted}. dpay tauscht nie um — wechsle unter „Guthaben“ zu einem davon und scanne erneut.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `Diese Kasse nimmt ${selected}, aber der Zahlungsanbieter des Händlers kann ${selected} gerade nicht verarbeiten. Die Kasse nimmt auch ${alternatives}. dpay tauscht nie um — wechsle unter „Guthaben“ zu einem davon und scanne erneut.`
        : `Diese Kasse nimmt ${selected}, aber der Zahlungsanbieter des Händlers kann ${selected} gerade nicht verarbeiten — und von allem anderen, was diese Kasse nimmt, kann diese Wallet nichts bezahlen. Bitte den Händler um eine andere Zahlungsmöglichkeit.`,
    noPayableAsset: accepted =>
      `dpay kann an dieser Kasse nicht zahlen. Sie nimmt ${accepted} — davon kann diese Wallet nichts bezahlen, und dpay tauscht nie um. Bezahle diesen Einkauf anders.`,
    quoteExpired:
      'Der Preis dieser Kasse ist abgelaufen — er gilt jeweils rund fünf Minuten. Scanne den Code erneut für einen frischen Preis.',
    notEnoughTime:
      'Dieser Preis läuft zu bald ab, um sicher damit zu zahlen. Dein Geld würde abgehen, bevor der Zahlungsanbieter des Händlers davon erfahren kann, und er würde den Verkauf danach ablehnen. Scanne den Code erneut für einen frischen Preis.',
    unreportable: host =>
      `${host} hat dpay keinen Weg genannt, eine Zahlung dorthin zu melden — eine Zahlung hier würde also dein Geld kosten, ohne dass der Verkauf gutgeschrieben wird. Es wurde nichts bezahlt. Erneutes Scannen ändert daran nichts — bitte den Händler um eine andere Zahlungsmöglichkeit.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `Der Preis dieses Codes kommt von ${quoteHost}, aber der Nachweis deiner Zahlung soll stattdessen an ${proofHost} gehen. Eine Zahlung kann nicht zwei verschiedenen Firmen gegenüber gelten, deshalb hat dpay abgebrochen. Es wurde nichts bezahlt — bitte den Händler, seinen eigenen Zahlungscode zu zeigen.`,
    tillPrice: (price, host) => `${price} · Preis von ${host}`,
    checkingTill: 'Wird beim Zahlungsanbieter des Händlers geprüft…',
    badCode:
      'Dieser Code ist beschädigt oder gar kein Zahlungscode. Bitte den Händler, ihn erneut zu zeigen, und achte darauf, dass nichts ihn verdeckt.',
    notHttps:
      'Dieser Code verweist auf eine unsichere Adresse, deshalb öffnet dpay ihn nicht. Bitte den Händler, seinen eigenen Zahlungscode zu zeigen — ein über den echten geklebter Aufkleber sieht genau so aus.',
    providerUnreachable:
      'Der Zahlungsanbieter des Händlers war nicht erreichbar. Es wurde nichts bezahlt. Prüfe deine Verbindung und scanne erneut.',
    badDestination: host =>
      `${host} hat eine Zahlungsadresse geliefert, die nicht zu deiner Auswahl passt — dpay hat abgebrochen. Es wurde nichts bezahlt. Zahle diesen Code nicht; bitte den Händler, seinen eigenen Code erneut zu zeigen.`,
    providerRefused: (host, detail) =>
      `Der Zahlungsanbieter des Händlers (${host}) hat diese Zahlung nicht angenommen. Es wurde nichts bezahlt. Bitte den Händler, den Verkauf erneut zu buchen, und scanne dann den Code. Wenn es weiter fehlschlägt, zeig ihm, was sein Anbieter gemeldet hat: „${detail}“.`,
    providerFailed: (host, status) =>
      `Der Zahlungsanbieter des Händlers (${host}) hat mit einem Fehler geantwortet (${status}) und keinen Grund genannt. Es wurde nichts bezahlt. Warte einen Moment und scanne den Code erneut; wenn es weiter fehlschlägt, bitte den Händler um eine andere Zahlungsmöglichkeit.`,
    badAnswer: (host, part) =>
      `Der Zahlungsanbieter des Händlers (${host}) hat ${part} geliefert, deshalb kann dpay an dieser Kasse nicht zahlen. Es wurde nichts bezahlt. Scanne den Code erneut und sag dem Händler Bescheid, wenn es weiter passiert.`,
    answerPart: {
      body: 'keine lesbare Antwort',
      details: 'keine vollständigen Zahlungsdaten',
      destination: 'keine Zahlungsadresse',
      expiry: 'keine lesbare Gültigkeitsdauer',
    },
    noPendingCharge: merchant =>
      `An der Kasse von ${merchant} steht kein Betrag offen. Bitte das Personal, den Verkauf zuerst zu buchen, und scanne dann erneut.`,
    ref: {
      icBlock: index => `Ledger-Block ${index}`,
      solTransaction: signature => `Solana-Transaktion ${signature}`,
    },
    submitUnknown: reference =>
      `Deine Überweisung ging durch, aber der Zahlungsanbieter des Händlers hat sie nicht bestätigt — das ist also weder bezahlt noch fehlgeschlagen. Das Geld hat deine Wallet verlassen, zahle deshalb nicht erneut. Zeig dem Händler ${reference}: das ist der Nachweis deiner Überweisung.`,
    submitPending: reference =>
      `Deine Überweisung ging durch und der Zahlungsanbieter des Händlers wurde informiert — er hat sie diesem Verkauf nur noch nicht zugeordnet. Sobald er die Überweisung sieht, wird sie gutgeschrieben; du musst nichts weiter tun. Das Geld hat deine Wallet verlassen: zahle nicht erneut. Zeigt die Kasse sie weiterhin nicht, nenne dem Händler ${reference}.`,
    submitRejected: (reference, said) =>
      `Deine Überweisung ging durch, aber der Zahlungsanbieter des Händlers hat den Nachweis abgelehnt, der Verkauf wurde also nicht gutgeschrieben. Das Geld hat deine Wallet verlassen, zahle deshalb nicht erneut. Wende dich an den Händler und nenne ihm ${reference}.`
      + (said === null ? '' : ` Der Anbieter meldet: „${said}“`),
    submitTooLate: reference =>
      `Deine Überweisung ging durch, aber erst nachdem dieser Preis abgelaufen war — der Verkauf wurde deshalb nicht gutgeschrieben. Das Geld hat deine Wallet verlassen, zahle deshalb nicht erneut. Wende dich an den Händler und nenne ihm ${reference}: das ist der Nachweis deiner Überweisung.`,
    transferUnknown:
      'dpay konnte deine Überweisung noch nicht bestätigen, deshalb weiß der Händler nichts davon — das ist weder bezahlt noch fehlgeschlagen. Lass diesen Bildschirm offen: dpay prüft weiter und schließt die Zahlung selbst ab, falls die Überweisung durchging. Zahle in der Zwischenzeit nicht erneut.',
    transferRefused: reason =>
      `Deine Überweisung ging nicht durch, es wurde also nichts bezahlt und dein Geld ist noch in deiner Wallet — ${reason}. Scanne den Code erneut, um an dieser Kasse zu zahlen.`,
    transferFailed:
      'Das Solana-Netzwerk hat deine Transaktion abgelehnt, es wurde also nichts bezahlt — der Betrag ist noch in deiner Wallet (eine kleine Netzwerkgebühr wurde berechnet). Scanne den Code erneut und versuche es noch einmal.',
    providerHost: host => `Preis von ${host}`,
  },

  fundsSymbol: 'Guthaben',
  fundTitle: symbol => `Kein ${symbol} verfügbar`,
  fundBody: (symbol, action) =>
    action === 'pay'
      ? `Diese Wallet hat kein ${symbol}. Um eine ${symbol}-Anfrage zu bezahlen, empfange zuerst ${symbol} an deiner Adresse.`
      : `Diese Wallet hat kein ${symbol}. Um ${symbol} zu senden, empfange zuerst ${symbol} an deiner Adresse.`,
  fundBodyNoDeposits: symbol =>
    `Diese Wallet hat kein ${symbol}, und dpay kann dafür keine Einzahlungsadresse anzeigen. Empfange ${symbol} von einer anderen Wallet, bevor du es ausgibst.`,
  fundBodyToken: symbol => `Sende ${symbol} (Solana) an deine ${symbol}-Adresse. Behalte etwas SOL in der Wallet für Netzwerkgebühren.`,
  showMyAddress: symbol => `Meine ${symbol}-Adresse zeigen`,
  createTokenAccount: symbol => `Mein ${symbol}-Konto erstellen`,
  fundSibling: {
    holds: (amount, rail) => `Du hältst ${amount} auf ${rail}`,
    switchTo: network => `Wechseln zu ${network}`,
    switchToAsset: asset => `Wechseln zu ${asset}`,
    practice: amount =>
      `Du hast ${amount} Übungsgeld. Damit kannst du eine Zahlung üben — es hat keinen Gegenwert und kann kein echtes Geschäft bezahlen.`,
    switchToPractice: 'Zum Übungsgeld wechseln',
  },

  offlineSendTitle: 'Senden an eine Adresse braucht eine Verbindung',
  offlineSendBody: symbol =>
    `Beim Senden an eine Adresse reicht dein Handy die Zahlung selbst ein — dafür muss es online sein. Um offline zu bezahlen, scanne stattdessen den Zahlungscode des Händlers: sein Handy reicht deine ${symbol}-Zahlung für dich ein.`,
  scannedAddressNotSendable: symbol =>
    `Das ist eine Wallet-Adresse. ${symbol} kann nicht an eine Adresse gesendet werden — scanne den Zahlungscode des Händlers, um zu bezahlen.`,

  spay: {
    wrongRail:
      'Das ist eine Solana-Pay-Anfrage. Dieser Bildschirm zahlt über den Internet Computer — wechsle unter Guthaben zu Solana und scanne den Code dort, um zu zahlen.',
    badUri: 'Dieser Solana-Pay-Code ist beschädigt. Bitte den Händler um einen neuen QR-Code.',
    badRecipient: 'Der Empfänger in diesem Solana-Pay-Code ist keine gültige Solana-Adresse. Bitte den Händler um einen neuen QR-Code.',
    badAmount: 'Der Betrag in diesem Solana-Pay-Code ist keine klare Zahl über null. Bitte den Händler um einen neuen QR-Code.',
    badSplToken: 'Der Token-Mint in diesem Solana-Pay-Code ist ungültig. Bitte den Händler um einen neuen QR-Code.',
    badReference: 'Die Zahlungsreferenz in diesem Solana-Pay-Code ist ungültig. Bitte den Händler um einen neuen QR-Code.',
    unexpectedParam: param =>
      `Dieser Solana-Pay-Code trägt einen Parameter, den dpay nicht kennt (${param}) — ihn zu zahlen hieße, Bedeutung zu unterschreiben, die dpay nicht prüfen kann. Bitte den Händler um einen Code ohne ihn.`,
    memoTooLong: 'Das Memo in diesem Solana-Pay-Code ist zu lang für eine Solana-Transaktion. Bitte den Händler um einen neuen QR-Code.',
    unknownMint: mint =>
      `Dieser Solana-Pay-Code verlangt einen Token, den dpay noch nicht führt (Mint ${mint}). Zahl ihn mit einer Wallet, die ihn unterstützt.`,
    offline:
      'Bei einem Solana-Pay-Code reicht dein Handy die Zahlung selbst ein — dafür braucht es eine Verbindung. Geh online und scanne erneut.',
    amountLabel: 'Betrag',
    merchantMessage: message => `Nachricht des Händlers: ${message}`,
    pendingNote:
      'Das Netzwerk hat diese Zahlung angenommen, aber die Bestätigung ist noch unterwegs. Die Transaktionssignatur unten ist dein Nachweis — prüfe sie, bevor du erneut zahlst.',
  },

  scanToPay: 'Scannen & zahlen',
  sendToAddress: 'An Adresse senden',
  tapOrScanToPay: 'Auflegen oder scannen',
  scanQrToPay: 'Scanne den QR-Code, um zu bezahlen.',
  solScanHint: 'Scanne den Zahlungscode des Händlers, um offline zu bezahlen.',
  payNow: 'Jetzt zahlen',
  payNowA11y: 'Jetzt zahlen',
  payNowHint: 'Schaltet Kamera und Tap-to-Pay ein, damit du bei einem Händler bezahlen kannst',
  nfcNotAvailable: 'NFC nicht verfügbar',
  whyNfcUnavailable: 'Warum NFC nicht verfügbar ist',
  nfcUnavailableTitle: 'NFC nicht verfügbar',
  close: 'Schließen',

  noCameraFound: 'Auf diesem Gerät wurde keine Kamera gefunden.',
  pointCamera: 'Richte deine Kamera auf einen Zahlungscode, um zu bezahlen',
  cameraPrivacy: 'dpay nutzt deine Kamera nur zum Scannen von Codes — nichts wird aufgezeichnet oder hochgeladen.',
  allowCameraScan: 'Kamera erlauben',
  allowCameraScanHint: 'Erlaubnis, deine Kamera zu nutzen, damit du Zahlungscodes scannen kannst',
};

export const receiveDe: ReceiveMessages = {
  amountToReceive: 'Zu empfangender Betrag',
  amountHint: 'Der Betrag, den der Zahler dir sendet',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Notiz',
  memoHint: 'Eine optionale Notiz zu dieser Zahlungsanfrage',
  memoPlaceholder: 'Notiz hinzufügen (optional)',
  chooseCurrency: 'Abwicklungswährung wählen',
  chooseCurrencyHint: 'Wähle, welches Asset der Zahler dir sendet',
  chooseAssetHint: 'Wähle das Asset, das der Zahler dir sendet',
  request: 'Anfordern',
  requestHint: 'Zeigt deinen QR-Code, damit der Zahler ihn scannen und dich bezahlen kann',
  creating: 'Wird erstellt…',
  creatingRequest: 'Anfrage wird erstellt…',
  solanaOffline: 'Solana ist offline — geh online, um eine Zahlungsanfrage zu erstellen.',

  receiveInTitle: 'Empfangen in',
  receiveIn: symbol => `In ${symbol} empfangen`,
  switchToRail: symbol => `Zu ${symbol} wechseln`,

  requestPayment: 'Zahlung anfordern',
  myAddress: 'Meine Adresse',
  rail: {
    feeLine: (network, fee) => `${network} · Gebühr ${fee}`,
    feeWithOneTime: (network, fee, oneTime) => `${network} · Gebühr ${fee} + einmalige Miete ${oneTime}`,
    feeUnknown: network => `${network} · Gebühr unbekannt`,
  },
  showToPayer: nfc =>
    `Zeig das dem Zahler${nfc === 'tap' ? ' · oder per Tap' : nfc === 'expired' ? ' · NFC-Tap abgelaufen' : ''}`,
  expiredMakeNew: 'Abgelaufen — erstelle eine neue Anfrage',
  validForMin: minutes => `Gültig für ~${minutes} Min.`,
  expiresIn: seconds => `Läuft ab in 0:${seconds}`,
  waitingForPayment: online => `Warte auf Zahlung${online ? '…' : ' — zum Einreichen wieder verbinden…'}`,
  waitingForSign: 'Warte darauf, dass der Zahler offline signiert…',
  offlineCantSubmit: 'Offline — Zahlungen können erst nach erneuter Verbindung eingereicht werden',
  shareRequestLink: 'Anfrage-Link teilen',
  shareRequestHint: 'Teilt diese Anfrage als Link, den der Zahler zum Bezahlen öffnen kann',
  linkUnavailable: 'Dieser Wert lässt sich nicht in einem Zahlungscode benennen. Wähle einen anderen Wert, um eine Zahlung anzufragen.',
  scanPayerSignedQr: 'Signierten QR des Zahlers scannen',
  scanPayerSignedQrPrompt: 'Scanne den signierten QR des Zahlers',
  scanPayerSignedQrHint: 'Scannt den signierten QR des Zahlers, um seine Offline-Zahlung einzureichen',
  scanPayerSignedCode: 'Signierten Code des Zahlers scannen',
  confirmWithTheirPhone:
    'Wenn der Zahler ohne Scan deines Codes bezahlt hat, tippe hier, um es mit seinem Handy zu bestätigen.',
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
    'Diese Zahlung konnte noch nicht bestätigt werden — falls der Zahler bezahlt hat, erscheint sie bei der nächsten Guthabenaktualisierung.',
  unknownLedger: 'Unbekanntes Ledger für dieses Asset — Einreichen nicht möglich',
  couldNotSubmit: 'Die Zahlung konnte nicht eingereicht werden — prüfe die Verbindung',
  noOpenRequest: 'Keine offene Anfrage.',
  paymentRejected: 'Zahlung abgelehnt.',
  paymentRejectedDetail:
    'Zahlung abgelehnt — das Guthaben des Zahlers reicht möglicherweise nicht, oder der Blockhash ist abgelaufen.',
  couldNotConfirmMaySettle:
    'Nicht bestätigt — die Zahlung kann trotzdem noch abgewickelt werden. Prüfe gleich dein Guthaben oder versuche es erneut.',
  stillCannotConfirm:
    'Weiterhin nicht bestätigt — die Zahlung kann trotzdem noch abgewickelt werden. Versuche es später erneut.',
  settlementNotVerified:
    'Bestätigt, aber die On-Chain-Transaktion stimmt nicht mit dieser Anfrage überein. Übergib die Ware noch nicht — prüfe die Signatur in einem Solana-Explorer und beobachte dein Guthaben; die Zahlung kann trotzdem noch korrekt ankommen.',
  savedDataCorrupt: 'Die gespeicherten Zahlungsdaten sind beschädigt.',
  paymentBeingConfirmed: 'Eine Zahlung wird gerade bestätigt',
  broadcastInterrupted:
    'Eine Übertragung wurde unterbrochen. Die Zahlung kann abgewickelt worden sein — versuche es erneut, um das zu prüfen.',
  retryBroadcast: 'Übertragung erneut versuchen',
  broadcasting: 'Übertragung auf Solana — das kann bis zu einer Minute dauern.',

  till: {
    codeForm: 'Wer diesen Code bezahlen kann',
    dpayCode: 'dpay-Code',
    tillCode: 'Kassen-Code',

    chargeLabel: 'Zu belastender Betrag',
    chargeHint: 'In Franken ausgezeichnet, in VCHF bezahlt — ein Franken, ein VCHF, kein Umtausch.',
    ringUp: 'Buchen',
    ringUpHint: 'Diesen Betrag auf deiner Kasse buchen und der Kundschaft einen bezahlbaren Code zeigen',
    ringingUp: 'Wird gebucht…',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'Ein Kassenbetrag geht auf ganze Rappen — buche 10.50 statt 10.505.'
        : reason === 'too-large'
        ? 'Dieser Betrag ist zu gross für eine Kassenbuchung. Gib ein, was diese Kundschaft schuldet.'
        : 'Gib den zu belastenden Betrag ein, zum Beispiel 10.50.',

    wrongAssetTitle: 'Ein Kassen-Code wird in VCHF bezahlt',
    wrongAsset: (selected, network) =>
      `Ein Kassen-Code wird immer in VCHF auf dem Internet Computer bezahlt — eine Kasse nimmt einen Wert an, und dpay tauscht nie um. Diese Anforderung lautet auf ${selected}${network ? ` auf ${network}` : ''}. Wechsle zu VCHF, um zu buchen — oder bleib beim dpay-Code: jede Handykamera öffnet ihn — dpay selbst oder die Web-Wallet — und er wird in ${selected} bezahlt.`,
    noTillAsset:
      'Diese Wallet führt kein VCHF, also gibt es kein Konto, auf das eine Kassenbuchung bezahlt werden könnte. Nimm den dpay-Code — jede Handykamera öffnet ihn, und er nimmt den gewählten Wert an.',
    switchTo: asset => `Zu ${asset} wechseln`,

    failedTitle: 'Der Betrag wurde nicht gebucht',
    notServed: host =>
      `${host} bietet keine Kassen-Codes an; es wurde nichts gebucht und nichts ist bezahlbar. Bitte die Person, die dieses Relay betreibt, die Kasse einzuschalten — oder nimm den dpay-Code, der braucht keine Kasse.`,
    unreachable: host =>
      `dpay hat ${host} nicht erreicht, es wurde nichts gebucht. Ein Kassen-Code entsteht online. Prüfe die Verbindung und buche erneut — oder nimm den dpay-Code, den dieses Telefon selbst erzeugt und auch offline zeigen kann.`,
    refused: said =>
      `Die Kasse hat diese Buchung abgelehnt: „${said}“ Nichts ist bezahlbar. Bring das in Ordnung und buche erneut.`,
    refusedNoReason: status =>
      `Die Kasse hat diese Buchung ohne Begründung abgelehnt (HTTP ${status}); nichts ist bezahlbar. Buche erneut — lehnt sie zweimal ab, sag der Person Bescheid, die das Relay betreibt.`,
    mispriced: (rung, quoted) =>
      `Du hast ${rung} gebucht, die Kasse hat ${quoted} zurückgemeldet. dpay zeigt keinen Code, der einen Betrag verlangt, den hier niemand gewählt hat — nichts ist bezahlbar. Buche erneut, und wenn es wieder passiert, sag der Person Bescheid, die das Relay betreibt, bevor du Geld annimmst.`,
    unsigned:
      'Dieses Telefon konnte die Buchung nicht signieren; es wurde nichts gebucht und nichts ist bezahlbar. Schliesse dpay, öffne es neu und buche erneut.',
    tryAgain: 'Erneut buchen',

    settlesAs: (amount, price) =>
      `Sie erhalten ${amount} auf dem Internet Computer. Die Ledger-Gebühr tragen Sie, die Kundschaft zahlt also genau ${price}.`,
    collecting: 'Die freigegebene Zahlung wird eingezogen …',
    collectNotApproved:
      'Die Wallet der Kundschaft hat für diesen Betrag zu wenig freigegeben, oder die Freigabe ist abgelaufen. Bitten Sie sie, den Code noch einmal zu bezahlen — es wurde nichts abgebucht.',
    collectNoFunds:
      'Die Kundschaft hat die Zahlung freigegeben, hat aber nicht genug Guthaben. Es wurde nichts abgebucht; bitten Sie sie, aufzuladen und den Code erneut zu bezahlen.',
    collectFailed:
      'Die freigegebene Zahlung konnte nicht eingezogen werden, und es wurde nichts abgebucht. Der Code ist weiterhin zahlbar — bitten Sie die Kundschaft, ihn erneut zu scannen oder zu tappen.',
    noFeeTitle: 'Diese Kasse kann keinen Betrag berechnen',
    noFee: (symbol, host) =>
      `Die Ledger-Gebühr trägt das Geschäft und wird vom Preis abgezogen — für ${symbol} kennt diese App aber keine Gebühr, ein Betrag würde sie also still der Kundschaft berechnen. Es ist nichts zahlbar. Aktualisieren Sie dpay, oder melden Sie der Betreiberin von ${host}, dass in der Währungsliste die ${symbol}-Gebühr fehlt.`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Zeig das der Kundschaft — jede Handykamera öffnet es, und ein dpay-Handy kann es auch auflegen.'
        : nfc === 'expired'
        ? 'Zeig das der Kundschaft — jede Handykamera öffnet es. Das Auflegen ist bei diesem Code abgelaufen; buch neu, wenn sie auflegen möchte.'
        : 'Zeig das der Kundschaft — jede Handykamera öffnet es und bezahlt.',
    waiting: 'Warten auf die Zahlung…',
    cantCheck:
      'Diese Buchung lässt sich gerade nicht prüfen — die Kasse ist nicht erreichbar. Das heisst NICHT, dass sie unbezahlt ist. Lass den Code stehen: sobald die Kasse wieder erreichbar ist, steht es hier.',
    expiredWatching:
      'Dieser Code ist abgelaufen, neu bezahlen kann ihn niemand mehr. Falls die Kundschaft das Geld schon geschickt hat, kann es noch eintreffen — es wird noch einen Moment beobachtet.',
    cancel: 'Buchung stornieren',
    cancelHint: 'Diese Buchung löschen, damit der Code kein Geld mehr annimmt',
    cancelling: 'Wird storniert…',
    cancelFailed: said =>
      `Die Buchung wurde NICHT storniert: „${said}“ Sie kann weiterhin bezahlbar sein — lies das und entscheide dann, ob du etwas herausgibst.`,
    cancelFailedNoReason: status =>
      `Die Buchung wurde ohne Begründung NICHT storniert (HTTP ${status}) — behandle sie als weiterhin bezahlbar. Versuch es erneut und gib auf diesen Code nichts heraus, bis er storniert ist oder abläuft.`,
    cancelUnreachable: host =>
      `dpay hat ${host} nicht erreicht, diese Buchung wurde also NICHT storniert — sie bleibt bezahlbar, bis sie abläuft. Versuch es erneut, sobald die Verbindung steht.`,

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
        : 'Das Relay hat sie nicht mehr — höchstwahrscheinlich wurde es neu gestartet. Hier wurde nichts gutgeschrieben. Buche erneut; sagt die Kundschaft, sie habe bezahlt, prüfe erst deinen VCHF-Bestand und die Transaktionen, bevor sie ein zweites Mal zahlt.',
    ringUpNext: 'Nächste Kundschaft buchen',

    paidAmount: price => `Bezahlt ${price}`,
    paidBlock: block => `Ledger-Block ${block}`,
    paidLate: 'Das kam nach Ablauf des Codes an — angenommen, das Geld liegt im Ledger.',
  },
};
