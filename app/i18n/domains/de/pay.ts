/**
 * i18n/domains/de/pay.ts — German values for the Pay + Receive screens.
 * Types, key documentation and the reference copy: ../en/pay.ts. Glossary: ../../de.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payDe: PayMessages = {
  notAPaymentCode: 'Das ist kein dpay-Zahlungscode',
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
  reviewPayment: 'Zahlung prüfen',
  paying: 'Du zahlst',
  payAmount: amount => `${amount} bezahlen`,
  notEnoughBalance: 'Dein Guthaben reicht für diese Zahlung nicht aus.',
  localBalanceMayNotCover: 'Dein lokales Guthaben reicht dafür möglicherweise nicht — der Händler prüft es.',
  approve: 'Freigeben',
  approveA11y: 'Zahlung freigeben',
  approveHint: 'Signiert den angezeigten Betrag mit deinem Schlüssel und sendet ihn',
  signing: 'Signieren…',
  signsOffline: 'Das wird offline signiert — der Händler wickelt beim Einreichen ab.',
  linkNameClaimed: 'Name vom Absender angegeben — prüfe das Konto darüber.',

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
    solanaUsdcUnsupported:
      'Diese Kasse nimmt USDC auf Solana, aber ihr Code nennt kein Token-Konto als Ziel — eine Zahlung könnte echtes Geld auf das falsche Konto schicken. Zahle stattdessen mit SOL oder wechsle unter „Guthaben“ zu einem anderen Wert, den diese Kasse nimmt.',
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
    tillCharging: price =>
      `Der Händler verlangt ${price}. Sein Zahlungsanbieter hat den Betrag oben festgelegt — dpay rechnet nicht um.`,
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
    submitRejected: reference =>
      `Deine Überweisung ging durch, aber der Zahlungsanbieter des Händlers hat den Nachweis abgelehnt, der Verkauf wurde also nicht gutgeschrieben. Das Geld hat deine Wallet verlassen, zahle deshalb nicht erneut. Wende dich an den Händler und nenne ihm ${reference}.`,
    submitTooLate: reference =>
      `Deine Überweisung ging durch, aber erst nachdem dieser Preis abgelaufen war — der Verkauf wurde deshalb nicht gutgeschrieben. Das Geld hat deine Wallet verlassen, zahle deshalb nicht erneut. Wende dich an den Händler und nenne ihm ${reference}: das ist der Nachweis deiner Überweisung.`,
    transferUnknown:
      'dpay konnte deine Überweisung noch nicht bestätigen, deshalb weiß der Händler nichts davon — das ist weder bezahlt noch fehlgeschlagen. Lass diesen Bildschirm offen: dpay prüft weiter und schließt die Zahlung selbst ab, falls die Überweisung durchging. Zahle in der Zwischenzeit nicht erneut.',
    transferRefused: reason =>
      `Deine Überweisung ging nicht durch, es wurde also nichts bezahlt und dein Geld ist noch in deiner Wallet — ${reason}. Scanne den Code erneut, um an dieser Kasse zu zahlen.`,
    transferFailed:
      'Das Solana-Netzwerk hat deine Transaktion abgelehnt, es wurde also nichts bezahlt — der Betrag ist noch in deiner Wallet (eine kleine Netzwerkgebühr wurde berechnet). Scanne den Code erneut und versuche es noch einmal.',
    claimedMerchant: 'Name aus dem Code — dpay prüft ihn nicht.',
    providerHost: host => `Preis von ${host}`,
  },

  fundsSymbol: 'Guthaben',
  fundTitle: (symbol, action) => `${symbol} zum ${action === 'pay' ? 'Bezahlen' : 'Senden'} aufladen`,
  fundBody: (symbol, action) =>
    `Diese Wallet hat noch kein ${symbol}. Sende ${symbol} an deine Adresse und du kannst sofort ${action === 'pay' ? 'bezahlen' : 'senden'}.`,
  fundBodyNoDeposits: symbol =>
    `Diese Wallet hat noch kein ${symbol} — und ${symbol} ist noch nicht für Einzahlungen verfügbar. Lade ein anderes Asset auf oder schau bald wieder vorbei.`,
  fundBodyUsdc: 'Sende USDC (Solana) an deine USDC-Adresse. Behalte etwas SOL in der Wallet für Netzwerkgebühren.',
  showMyAddress: symbol => `Meine ${symbol}-Adresse zeigen`,
  createUsdcAccount: 'Mein USDC-Konto erstellen',

  offlineSendTitle: 'Senden an eine Adresse braucht eine Verbindung',
  offlineSendBody: symbol =>
    `Beim Senden an eine Adresse reicht dein Handy die Zahlung selbst ein — dafür muss es online sein. Um offline zu bezahlen, scanne stattdessen den Zahlungscode des Händlers: sein Handy reicht deine ${symbol}-Zahlung für dich ein.`,
  scannedAddressNotSendable: symbol =>
    `Das ist eine Wallet-Adresse. ${symbol} kann nicht an eine Adresse gesendet werden — scanne den Zahlungscode des Händlers, um zu bezahlen.`,

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
  savedDataCorrupt: 'Die gespeicherten Zahlungsdaten sind beschädigt.',
  paymentBeingConfirmed: 'Eine Zahlung wird gerade bestätigt',
  broadcastInterrupted:
    'Eine Übertragung wurde unterbrochen. Die Zahlung kann abgewickelt worden sein — versuche es erneut, um das zu prüfen.',
  retryBroadcast: 'Übertragung erneut versuchen',
  broadcasting: 'Übertragung auf Solana — das kann bis zu einer Minute dauern.',
};
