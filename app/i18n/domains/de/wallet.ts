/**
 * i18n/domains/de/wallet.ts — German values for the `wallet` + `education` domains.
 * Types, key documentation and the reference copy: ../en/wallet.ts. Glossary: ../../de.ts.
 */
import type {EducationMessages, WalletMessages} from '../../keys';

export const walletDe: WalletMessages = {
  header: {
    settings: 'Einstellungen',
    themeSwitch: target => `Design auf ${target} umstellen`,
    home: 'dpay-Startseite',
  },

  balance: {
    label: 'Guthaben',
    lockedHint: 'Beende oder brich zuerst die laufende Zahlung ab',
    approx: asset => `~ ${asset} ca.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Nochmal Zurück zum Beenden',
  },

  homeCurrency: {
    name: {CHF: 'Schweizer Franken', USD: 'US-Dollar', EUR: 'Euro', BTC: 'Bitcoin', ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana'},
    chooseTitle: 'In welcher Währung denkst du?',
    chooseBody: 'Nur Anzeige.',
    railReason: {destination: 'wird für die Zahlung gebraucht', funded: 'Guthaben vorhanden'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Haupt',
    settingsTitle: 'Hauptwährung',
    settingsHint: 'Zuerst angezeigt; Standard beim Bezahlen.',
    confirm: 'Weiter',
    pickFirst: 'Wähle zuerst eine Währung.',
    noneAvailable: 'Keine Währungen geladen. Prüfe die Serveradresse in den Einstellungen und öffne dpay erneut.',
    a11y: currency => `${currency} wählen`,
  },

  railHealth: {
    thin: 'Geringe Liquidität',
    deep: 'Weit verbreitet.',
  },

  railDetail: {
    back: 'Zurück',
    rampNone: 'Kein Fiat-Zugang — nur Wallet zu Wallet.',
    rampSellPartner: partner => `${partner} — heute nur Verkauf.`,
    rampBothDirect: 'Einzahlung und Auszahlung sind eingebaut.',
  },

  tab: {pay: 'Bezahlen', receive: 'Empfangen', transactions: 'Verlauf', home: 'Start'},

  home: {
    actions: {
      addFunds: 'Einzahlen',
      convert: 'Tauschen',
      withdraw: 'Abheben',
      more: 'Mehr',
    },
    balanceEyebrow: code => `Guthaben ${code}`,
    menu: {
      ledger: 'Verlauf',
      remove: 'Entfernen',
      close: 'Schliessen',
    },
    removeRefusal: {
      nonzero: amount => `${amount} zuerst tauschen oder verschieben.`,
      unreadable: 'Guthaben nicht lesbar. Verbinde dich erneut und versuche es dann.',
      last: 'Mindestens eine Währung muss bleiben.',
    },
    activity: {
      title: 'Aktivität',
      seeAll: 'Alle anzeigen',
    },
    accounts: {
      openLabel: 'Konten öffnen',
    },
  },

  accounts: {
    title: 'Konten',
    intro: 'Antippen setzt die Hauptwährung.',
    back: 'Zurück',
    practice: 'Übungsgeld. Kein Geschäft nimmt es an.',
    convertHint: 'Bei einem externen Handelsplatz tauschen',
    setMainHint: 'Setzt sie als Hauptwährung',
    addCurrency: 'Währung hinzufügen',
  },

  addCurrency: {
    title: 'Währung hinzufügen',
    search: 'Suchen',
    stable: 'Stable-Währungen',
    other: 'Andere',
    inWallet: 'In der Wallet',
    add: 'Hinzufügen',
    none: 'Keine Treffer.',
  },

  addressBook: {
    title: 'Adressbuch',
    intro: 'Nur auf diesem Gerät gespeichert.',
    back: 'Zurück',
    empty: 'Noch keine gespeicherten Adressen. Adressen, an die du sendest, erscheinen hier automatisch.',
    addEntry: 'Adresse hinzufügen',
    assetLabel: 'Für',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Adresse einfügen',
    addressHint: 'Genau so, wie du senden würdest',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Alice',
    save: 'Speichern',
    rename: 'Umbenennen',
    renameHint: who => `${who} umbenennen`,
  },

  backToPaying: asset => `Zurück zum Bezahlen mit ${asset}`,

  faucet: {
    unavailableOnRelay: 'Aufladen auf diesem Relay nicht verfügbar',
    failed: 'Aufladen fehlgeschlagen',
    unavailable: 'Faucet nicht verfügbar',
    offline: 'Offline — versuche es erneut, wenn du verbunden bist',
  },

  balances: {
    demoFunds: 'Demo-Guthaben',
    demoFundsLabel: 'Demo-Guthaben holen',
    demoFundsHint: 'Fügt ∂100 Demo-Geld hinzu',
    needsSetup: 'Einrichtung nötig',
    select: symbol => `${symbol} auswählen`,
    selectHint: 'Für Bezahlen und Empfangen verwendet',
    showTestnet: 'Testnet-Assets zeigen',
    hideTestnet: 'Testnet-Assets verbergen',
  },

  ledger: {
    empty: 'Noch keine Zahlungen.',
    emptyHint: 'Tippe auf Empfangen für eine Anfrage, auf Bezahlen zum Scannen.',
    recent: 'Zuletzt',
    allAssets: 'Alle Assets',
    all: 'Alle',
    filter: label => `${label} filtern`,
    to: who => `an ${who}`,
    from: who => `von ${who}`,
    fromPool: 'von einem Pool',
    toPool: 'an einen Pool',
    fees: fee => `− ${fee} Gebühren`,
    mintCounterparty: 'Demo-Guthaben',
    failed: 'Fehlgeschlagen — nur die Gebühr wurde abgebucht',
    dropped: count => count === 1
      ? '1 Solana-Transaktion konnte nicht gelesen werden — sie existiert weiterhin on-chain.'
      : `${count} Solana-Transaktionen konnten nicht gelesen werden — sie existieren weiterhin on-chain.`,
  },

  fund: {checking: 'Wird geprüft…', checkAgain: 'Erneut prüfen'},

  asset: {
    demoSubtitle: 'Spielgeld zum Testen',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    bridgedLabel: (symbol, from, to) => `${symbol} · ${from} → ${to}`,
    unsupported: 'Nicht unterstützt',
    testnetName: base => `${base} Testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Geteilt ✓'},
};

/** Month abbreviations for the passport stamp date — German caps, as inked on a document page. */
const DE_MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export const educationDe: EducationMessages = {
  campaignLine: 'Signal? Nicht nötig.',
  howItWorksTitle: 'So funktioniert dpay',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'Zuerst: so läuft eine Zahlung',
        title: 'Ein Handy fordert an, das andere bezahlt',
        body: 'Das andere Handy zeigt eine Anfrage. Du scannst sie, prüfst den Betrag und gibst frei. Seine Verbindung sendet die Zahlung, wenn deins offline ist.',
      },
      key: {
        eyebrow: 'Dein Geld',
        title: 'Dein Schlüssel bleibt auf diesem Gerät',
        body: 'dpay hält kein Geld und kann keine Zahlungen freigeben. Es gibt kein dpay-Konto — nur deinen Schlüssel.',
      },
      exact: {
        eyebrow: 'Keine Überraschung',
        title: 'Genau das angeforderte Asset',
        body: 'Der Laden fordert genau ein Asset an. Du prüfst den Betrag und gibst frei. dpay tauscht nie um.',
      },
    },
    stageTags: ['Signal', 'Schlüssel', 'Asset'],
    close: 'So funktioniert dpay schließen',
    skip: 'Überspringen',
    back: 'Zurück',
    next: 'Weiter',
    getStarted: 'Los geht’s',
    shopRequests: 'Ladenanfrage',
  },

  practice: {
    sheetTitle: 'Übungszahlung',
    eyebrow: 'Übung',
    payeeName: 'Übungsladen',
    title: 'Mach eine Zahlung, ganz echt',
    cardLine: 'Der Code, den ein Laden zeigt.',
    balance: amount => `${amount} Übungsgeld.`,
    review: 'Zahlung prüfen',
    skip: 'Übung überspringen',
    bothSides: 'Die Übung braucht eine Verbindung — dein Handy spielt beide Seiten. Unterwegs nur der Laden.',
    settledBody: 'Von deinem Handy signiert, vom Übungs-Ledger abgewickelt.',
    settledBalance: amount => `Noch ${amount} Übungsgeld übrig.`,
    pendingBody: 'Signiert und gesendet, noch nicht abgewickelt — bestätigt ist nichts. So sieht ausstehend aus.',
    refusedTitle: 'Abgelehnt',
    refusedBody: 'Es wurde nichts bewegt.',
    continue: 'Einrichtung fortsetzen',
    punchline: 'Übungsgeld hat keinen Gegenwert.',
    noFaucet: {
      title: 'Hier gibt es kein Übungsgeld',
      body: 'Dieser Server hat gerade keinen. In deiner Wallet fehlt nichts — mach weiter und wähle deine Währung.',
    },
    cooldown: {
      title: 'Übungsgeld, gleich',
      body: reason => `Dieser Server gibt Übungsgeld nur ab und zu aus — gerade eben hat er es getan. Er meldet: ${reason} Mach weiter; komm jederzeit zurück.`,
    },
    offline: {
      title: 'Die Übung braucht eine Verbindung',
      body: 'Dein Handy spielt beide Seiten. Verbinde dich wieder und versuche es erneut, oder mach mit der Einrichtung weiter.',
    },
    empty: {
      title: 'Noch kein Übungsgeld',
      body: 'In deiner Wallet fehlt nichts — mach weiter und wähle deine Währung.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Zeig ihn deiner Kundschaft',
      body: 'Ihr Handy scannt und gibt frei; deine Verbindung bestätigt.',
    },
    offlineQr: {
      title: 'Signiert — nicht abgewickelt',
      body: 'Dieser signierte Code ist dein Zahlungsnachweis. Die Verbindung des Empfängers wickelt ihn ab — der Status aktualisiert sich, sobald du wieder da bist.',
    },
    pendingOutcome: {
      title: 'Noch ausstehend',
      body: 'Das Ergebnis ist noch nicht bekannt — geh nie davon aus, dass es geklappt hat; schau hier wieder nach.',
    },
  },
  coachDismiss: title => `Tipp ausblenden: ${title}`,
  coachDismissHint: 'Blendet diesen Tipp aus; er erscheint nicht wieder',

  passport: {
    title: 'Reisebereitschaft',
    stamps: {
      recoverySaved: {label: 'Backup\ngesichert', hint: 'Kopiere deine Backup-Wörter in den Einstellungen', short: 'noch das Backup'},
      flowUnderstood: {label: 'Ablauf\ngesehen', hint: 'Mach die Übungszahlung — oder mach eine beliebige Zahlung', short: 'noch den Ablauf ansehen'},
      fundsReady: {label: 'Guthaben\ngeladen', hint: 'Lade echtes Guthaben auf — Übungsguthaben zählt nicht', short: 'noch Guthaben aufladen'},
      paymentTested: {label: 'Erste\nZahlung', hint: 'Schließe eine Zahlung ab — bezahlen oder empfangen', short: 'noch eine Zahlung'},
    },
    close: title => `${title} schließen`,
    stripLabel: filled => `Reisebereitschaft ${filled} von 4`,
    count: filled => `${filled} von 4`,
    goToStep: hint => `Los: ${hint}`,
    nextTag: 'Weiter',
    nextLabel: hint => `Weiter: ${hint}`,
    doneHint: 'Blendet die Leiste aus',
    ready: 'Reisebereit',
    readyLine: 'Du kannst bezahlen, auch wenn dein Handy kein Signal hat.',
    capstone: 'Reise\nbereit',
    capstoneMicro: 'Nichts mehr einzurichten. Gute Reise.',
    stampDate: (monthIndex, day) => `${DE_MONTHS[monthIndex]} ${day}`,
  },

  peak: {
    micro: 'Die ganze Zeit kein Signal.',
    settled: 'ohne Signal bezahlt',
  },
};
