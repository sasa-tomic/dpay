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
    of: asset => `${asset}-Guthaben`,
    approx: asset => `~ ${asset} ca.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Nochmal Zurück zum Beenden',
  },

  homeCurrency: {
    name: {CHF: 'Schweizer Franken', USD: 'US-Dollar', EUR: 'Euro', BTC: 'Bitcoin', ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana'},
    chooseTitle: 'In welcher Währung denkst du?',
    chooseBody: 'Legt die zuerst angezeigte Währung fest — nur Anzeige.',
    railReason: {destination: 'die Zahlung verlangt diesen Weg', funded: 'du hast hier ein Guthaben'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Haupt',
    mainLabel: currency => `${currency} · Haupt`,
    settingsTitle: 'Hauptwährung',
    settingsHint: 'Die Währung, die dpay zuerst anzeigt und standardmässig verwendet',
    confirm: 'Weiter',
    pickFirst: 'Wähle zuerst eine Währung.',
    noneAvailable: 'Es konnten keine Währungen geladen werden. Prüfe die Serveradresse in den Einstellungen und öffne dpay erneut.',
    a11y: currency => `${currency} wählen`,
  },

  railHealth: {
    thin: 'Geringe Liquidität',
    deep: 'Zirkuliert heute breit on-chain.',
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
      pay: 'Bezahlen',
      payHint: 'Code scannen oder Telefon antippen',
      receive: 'Empfangen',
      receiveHint: 'Zahlung anfordern oder Adresse anzeigen',
      addMoney: 'Geld hinzufügen',
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
    intro: 'Tippe auf ein Konto, um es in Bezahlen und Empfangen zu verwenden.',
    back: 'Zurück',
    practice: 'Übungsgeld. Es funktioniert nur in dpay — kein Geschäft nimmt es an.',
    convertHint: 'Bei einem externen Handelsplatz tauschen',
    groupHome: name => `Haupt · ${name}`,
    groupOther: 'Andere Assets',
    switchRail: rail => `Zu ${rail} wechseln`,
  },

  addressBook: {
    title: 'Adressbuch',
    intro: 'Adressen, an die du gesendet hast — nur auf diesem Gerät gespeichert.',
    back: 'Zurück',
    empty: 'Noch keine gespeicherten Adressen. Adressen, an die du sendest, werden hier automatisch gespeichert.',
    addEntry: 'Adresse hinzufügen',
    assetLabel: 'Für',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Adresse einfügen',
    addressHint: 'Genau so, wie du senden würdest',
    nameLabel: 'Name',
    namePlaceholder: 'z. B. Alice (optional)',
    save: 'Adresse speichern',
    rename: 'Umbenennen',
    renameHint: who => `${who} umbenennen`,
  },

  backToPaying: asset => `Zurück zum Bezahlen mit ${asset}`,

  faucet: {
    unavailableOnRelay: 'Demo-Aufladen ist auf diesem Relay nicht verfügbar',
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
    selectHint: 'Auf deinem Startbildschirm anzeigen',
    selectSolanaHint: symbol => `Zeigt ${symbol} auf dem Startbildschirm; Bezahlen und Empfangen nutzen Solana`,
    showTestnet: 'Testnet-Assets zeigen',
    hideTestnet: 'Testnet-Assets verbergen',
  },

  ledger: {
    empty: 'Noch keine Zahlungen.',
    emptyHint: 'Tippe auf Empfangen, um eine Zahlungsanfrage zu erstellen, oder auf Bezahlen, um eine zu scannen.',
    recent: 'Zuletzt',
    allAssets: 'Alle Assets',
    all: 'Alle',
    filter: label => `${label} filtern`,
    to: who => `an ${who}`,
    from: who => `von ${who}`,
    fees: fee => `− ${fee} Gebühren`,
    mintCounterparty: 'Demo-Guthaben',
    failed: 'Fehlgeschlagen — nur die Netzwerkgebühr wurde abgebucht',
    dropped: count => count === 1
      ? '1 Solana-Transaktion konnte nicht gelesen werden — sie existiert on-chain, wird hier aber nicht angezeigt.'
      : `${count} Solana-Transaktionen konnten nicht gelesen werden — sie existieren on-chain, werden hier aber nicht angezeigt.`,
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
const DE_MONTHS = ['JAN', 'FEB', 'MÄR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];

export const educationDe: EducationMessages = {
  campaignLine: 'Signal? Nicht nötig.',
  howItWorksTitle: 'So funktioniert dpay',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'ZUERST: SO LÄUFT EINE ZAHLUNG',
        title: 'Ein Handy fordert an, das andere bezahlt',
        body: 'Das andere Handy zeigt eine Anfrage. Du scannst sie, prüfst den Betrag und gibst frei. Seine Verbindung sendet die Zahlung, wenn deins offline ist.',
      },
      key: {
        eyebrow: 'DEIN GELD',
        title: 'Dein Schlüssel bleibt auf diesem Gerät',
        body: 'dpay hält kein Geld und kann keine Zahlungen für dich freigeben. Es gibt kein dpay-Konto — nur deinen Schlüssel.',
      },
      exact: {
        eyebrow: 'KEINE ÜBERRASCHUNG',
        title: 'Genau das angeforderte Asset',
        body: 'Der Laden fordert genau ein Asset an. Du prüfst den Betrag und gibst frei. dpay tauscht nie um.',
      },
    },
    stageTags: ['01 — SIGNAL', '02 — SCHLÜSSEL', '03 — ASSET'],
    close: 'So funktioniert dpay schließen',
    skip: 'Überspringen',
    back: 'Zurück',
    next: 'Weiter',
    getStarted: 'Los geht’s',
    shopRequests: 'Ladenanfrage',
  },

  practice: {
    sheetTitle: 'Übungszahlung',
    eyebrow: 'ÜBUNG',
    payeeName: 'Übungsladen',
    title: 'Mach eine Zahlung, ganz echt',
    cardLine: 'Der Code, den dir ein Laden zeigt.',
    balance: amount => `Du hast ${amount} Übungsgeld.`,
    review: 'Zahlung prüfen',
    skip: 'Übung überspringen',
    bothSides: 'Die Übung braucht eine Verbindung — dein Handy spielt beide Seiten. Unterwegs nur der Laden.',
    settledBody: 'Eine echte Zahlung: dein Handy hat sie signiert, und das Übungs-Ledger hat sie abgewickelt.',
    settledBalance: amount => `Noch ${amount} Übungsgeld übrig.`,
    pendingBody: 'Signiert und gesendet, noch nicht abgewickelt — bestätigt ist nichts. Genau so sieht eine echte ausstehende Zahlung aus.',
    refusedTitle: 'Das Ledger hat sie abgelehnt',
    refusedBody: 'Es wurde nichts bewegt.',
    continue: 'Einrichtung fortsetzen',
    punchline: 'Übungsgeld hat keinen Gegenwert.',
    noFaucet: {
      title: 'Hier gibt es kein Übungsgeld',
      body: 'Dieser Server gibt kein Übungsgeld aus. In deiner Wallet fehlt nichts — mach weiter und wähle deine Währung.',
    },
    cooldown: {
      title: 'Übungsgeld, gleich',
      body: reason => `Dieser Server gibt Übungsgeld nur ab und zu aus — gerade eben hat er es getan. Er meldet: ${reason} Mach mit der Einrichtung weiter; komm jederzeit zurück.`,
    },
    offline: {
      title: 'Diese Übung braucht eine Verbindung',
      body: 'Die Übung braucht eine Verbindung, weil dein Handy beide Seiten spielt. Verbinde dich wieder und versuche es erneut, oder mach mit der Einrichtung weiter.',
    },
    empty: {
      title: 'Noch nichts zum Üben da',
      body: 'Dein Übungsguthaben ist leer. Mit deiner Wallet ist alles in Ordnung — mach weiter und wähle deine Währung.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Zeig ihn deiner Kundschaft',
      body: 'Ihr Handy scannt und gibt frei; deine Verbindung bestätigt.',
    },
    offlineQr: {
      title: 'Signiert — nicht abgewickelt',
      body: 'Kein Signal? Dieser signierte Code ist dein Zahlungsnachweis. Die Verbindung des Empfängers wickelt ihn ab — der Status aktualisiert sich, sobald du wieder da bist.',
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
      recoverySaved: {label: 'BACKUP\nGESICHERT', hint: 'Kopiere deine Backup-Wörter in den Einstellungen', short: 'noch das Backup'},
      flowUnderstood: {label: 'ABLAUF\nGESEHEN', hint: 'Mach die Übungszahlung — oder mach eine beliebige Zahlung', short: 'noch den Ablauf ansehen'},
      fundsReady: {label: 'GUTHABEN\nGELADEN', hint: 'Lade echtes Guthaben auf — Übungsguthaben zählt nicht', short: 'noch Guthaben aufladen'},
      paymentTested: {label: 'ERSTE\nZAHLUNG', hint: 'Schließe eine Zahlung ab — bezahlen oder empfangen', short: 'noch eine Zahlung'},
    },
    close: title => `${title} schließen`,
    stripLabel: filled => `Reisebereitschaft ${filled} von 4`,
    count: filled => `${filled} VON 4`,
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
