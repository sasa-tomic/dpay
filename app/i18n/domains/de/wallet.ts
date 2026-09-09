/**
 * i18n/domains/de/wallet.ts — German values for the `wallet` + `education` domains.
 * Types, key documentation and the reference copy: ../en/wallet.ts. Glossary: ../../de.ts.
 */
import type {EducationMessages, WalletMessages} from '../../keys';

export const walletDe: WalletMessages = {
  header: {
    settings: 'Einstellungen',
    settingsHint: 'Öffnet Relay, Zurücksetzen und erweiterte Einstellungen',
    themeSwitch: target => `Design auf ${target} umstellen`,
    themeSwitchHint: 'Wechselt zwischen Hell und Dunkel; Auto stellst du in den Einstellungen ein',
    home: 'dpay-Startseite',
    homeHint: 'Öffnet die dpay-Website',
  },

  balance: {
    label: 'Guthaben — Währung wechseln oder empfangen',
    hint: 'Öffnet den Home-Tab mit jedem Asset, wechselt die angezeigte Währung oder empfängt',
    lockedHint: 'Beende oder brich zuerst die laufende Zahlung ab',
    of: asset => `${asset}-Guthaben`,
    approx: asset => `~ ${asset} ca.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Nochmal Zurück zum Beenden',
  },

  homeCurrency: {
    name: {CHF: 'Schweizer Franken', USD: 'US-Dollar', EUR: 'Euro'},
    chooseTitle: 'In welcher Währung denkst du?',
    chooseBody: 'Wähle, welche Währung zuerst erscheint. Das ändert nur Anzeige und Vorgaben.',
    railReason: {destination: 'die Zahlung verlangt diesen Weg', funded: 'du hast hier ein Guthaben'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Haupt',
    mainLabel: currency => `${currency} · Haupt`,
    settingsTitle: 'Hauptwährung',
    settingsHint: 'Die Währung, die dpay zuerst anzeigt und standardmässig verwendet',
    confirm: 'Weiter',
    pickFirst: 'Tippe zuerst auf die gewünschte Währung, dann auf Weiter.',
    noneAvailable: 'Es konnten keine Währungen geladen werden. Prüfe die Serveradresse in den Einstellungen und öffne dpay erneut.',
    a11y: currency => `${currency} wählen`,
  },

  railHealth: {
    thin: token => `Heute gibt es on-chain nur sehr wenig ${token} — Empfangen kann schwierig sein, und Zahlen geht nur an jemanden, der ${token} hält.`,
    deep: 'Zirkuliert heute breit on-chain.',
  },

  railDetail: {
    back: 'Zurück',
    rampNone: 'Kein Fiat-Zugang heute — Überweisungen laufen von Wallet zu Wallet.',
    rampSellPartner: partner => `${partner} listet dieses Token als verkäuflich; Kaufen ist heute nicht möglich.`,
    rampBothDirect: 'Einzahlung und Auszahlung auf die native Chain sind in dpay eingebaut.',
  },

  tab: {pay: 'Bezahlen', receive: 'Empfangen', transactions: 'Verlauf', home: 'Start'},

  home: {
    actions: {
      scan: 'Scannen und zahlen',
      scanHint: 'Kamera öffnen und den Code des Geschäfts scannen',
      receive: 'Empfangen',
      receiveHint: 'Zahlung anfordern oder eigene Adresse anzeigen',
      addMoney: 'Geld hinzufügen',
      addMoneyHint: 'Guthaben auf dieses Wallet laden',
    },
    activity: {
      title: 'Aktivität',
      seeAll: 'Alle anzeigen',
      seeAllHint: 'Die vollständige Transaktionsliste öffnen',
      empty: 'Noch keine Zahlungen.',
    },
    accounts: {
      open: count => `Konten · ${count}`,
      openHint: 'Alle Konten anzeigen, die dieses Wallet halten kann',
    },
  },

  accounts: {
    title: 'Konten',
    intro: 'Tippe auf ein Konto, um es in den Tabs Bezahlen und Empfangen zu verwenden. Dein Startbildschirm zeigt weiterhin deine Hauptwährung.',
    back: 'Zurück',
    backHint: 'Zurück zur vorherigen Ansicht',
    practice: 'Übungsgeld — es funktioniert nur in dpay, kein Geschäft nimmt es an.',
    convertHint: 'Das Guthaben dieses Kontos bei einem externen Handelsplatz tauschen, den du selbst signierst',
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
    demoFundsHint: 'Fügt dieser Wallet ∂100 Demo-Geld hinzu',
    needsSetup: 'Einrichtung nötig',
    select: symbol => `${symbol} auswählen`,
    selectHint: 'Zeigt das Guthaben dieses Assets auf deinem Startbildschirm',
    selectSolanaHint: symbol => `Zeigt ${symbol} auf deinem Startbildschirm und nutzt Solana zum Bezahlen und Empfangen`,
    showTestnet: 'Testnet-Assets zeigen',
    hideTestnet: 'Testnet-Assets verbergen',
    showTestnetHint: 'Blendet Testnet-Währungen in dieser Liste ein',
    hideTestnetHint: 'Blendet Testnet-Währungen aus dieser Liste aus',
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
    mintCounterparty: 'Demo-Guthaben',
    failed: 'Fehlgeschlagen — nur die Netzwerkgebühr wurde abgebucht',
    dropped: count => count === 1
      ? '1 Solana-Transaktion konnte nicht gelesen werden — sie existiert weiterhin on-chain, wird hier aber nicht angezeigt.'
      : `${count} Solana-Transaktionen konnten nicht gelesen werden — sie existieren weiterhin on-chain, werden hier aber nicht angezeigt.`,
  },

  fund: {checking: 'Wird geprüft…', checkAgain: 'Erneut prüfen'},

  asset: {
    demoSubtitle: 'Spielgeld zum Testen',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
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
        body: 'Das empfangende Handy zeigt eine Anfrage. Du scannst sie, prüfst Betrag und Asset und gibst frei. Ist dein Handy offline, sendet seine Internetverbindung die Zahlung.',
      },
      key: {
        eyebrow: 'DEIN GELD',
        title: 'Dein Schlüssel bleibt auf diesem Gerät',
        body: 'dpay hält kein Guthaben und kann keine Zahlung für dich freigeben. Es gibt kein dpay-Konto — nur deinen Schlüssel.',
      },
      exact: {
        eyebrow: 'KEINE ÜBERRASCHUNG',
        title: 'Genau das angeforderte Asset',
        body: 'Der Laden fordert genau ein Asset an. Du prüfst den Betrag und gibst frei. dpay rechnet nie ein anderes Guthaben um.',
      },
    },
    stageTags: ['01 — SIGNAL', '02 — SCHLÜSSEL', '03 — ASSET'],
    close: 'So funktioniert dpay schließen',
    skip: 'Überspringen',
    skipHint: 'Direkt zum Erstellen deiner Wallet',
    back: 'Zurück',
    backLabel: 'Vorherige Szene',
    next: 'Weiter',
    nextLabel: 'Nächste Szene',
    nextHint: 'Zeigt die nächste Szene',
    getStarted: 'Los geht’s',
    getStartedHint: 'Weiter zum Erstellen deiner Wallet',
    shopRequests: 'Ladenanfrage',
  },

  practice: {
    sheetTitle: 'Übungszahlung',
    eyebrow: 'ÜBUNG',
    payeeName: 'Übungsladen',
    title: 'Mach eine Zahlung, ganz echt',
    cardLine: 'So sieht der Code aus, den dir ein Laden zeigt.',
    balance: amount => `Du hast ${amount} Übungsgeld.`,
    review: 'Zahlung prüfen',
    reviewHint: 'Zeigt Betrag und Empfänger vor der Freigabe',
    skip: 'Übung überspringen',
    skipHint: 'Überspringt die Übungszahlung und wählt deine Hauptwährung',
    bothSides: 'Dein Handy spielt hier beide Seiten, deshalb braucht diese Übung eine Verbindung. Unterwegs braucht nur der Laden eine.',
    settledBody: 'Das war eine echte Zahlung auf dem Übungs-Ledger — dein Handy hat sie signiert, und das Ledger hat sie abgewickelt.',
    settledBalance: amount => `Noch ${amount} Übungsgeld übrig.`,
    pendingBody: 'Die Zahlung wurde signiert und gesendet. dpay hat die Abwicklung noch nicht gesehen, bestätigt ist also nichts. Genau so sieht eine echte ausstehende Zahlung aus.',
    refusedTitle: 'Das Ledger hat sie abgelehnt',
    refusedBody: 'Es wurde nichts bewegt.',
    continue: 'Einrichtung fortsetzen',
    continueHint: 'Weiter zur Wahl deiner Hauptwährung',
    punchline: 'Übungsgeld hat keinen Gegenwert — es ist nur dazu da, die App auszuprobieren.',
    noFaucet: {
      title: 'Hier gibt es kein Übungsgeld',
      body: 'Dieser Server gibt kein Übungsgeld aus, es gibt also nichts zum Üben. In deiner Wallet fehlt nichts — mach weiter und wähle deine Währung. Deine erste echte Zahlung kannst du jederzeit machen.',
    },
    cooldown: {
      title: 'Übungsgeld, gleich',
      body: reason => `Dieser Server gibt Übungsgeld nur ab und zu aus, und gerade eben hat er es getan. Er meldet: ${reason} Mach mit der Einrichtung weiter — du kannst jederzeit zurückkommen und zahlen.`,
    },
    offline: {
      title: 'Diese Übung braucht eine Verbindung',
      body: 'Dein Handy spielt hier den Laden und den Zahler, deshalb muss es das Ledger selbst erreichen. Eine echte Zahlung braucht das nicht: Da braucht nur der Laden eine Verbindung. Verbinde dich wieder und versuche es erneut, oder mach mit der Einrichtung weiter.',
    },
    empty: {
      title: 'Noch nichts zum Üben da',
      body: 'Dein Übungsguthaben ist leer, es gibt also nichts zu bezahlen. Mit deiner Wallet ist alles in Ordnung — mach weiter und wähle deine Währung.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Zeig deinen Anfragecode',
      body: 'Zeig diesen Code deiner Kundschaft. Ihr Handy scannt und gibt frei; deine Verbindung bestätigt.',
    },
    offlineQr: {
      title: 'Signiert — nicht abgewickelt',
      body: 'Kein Signal? Dieser signierte Code ist dein Zahlungsnachweis. Die Verbindung des Empfängers wickelt ihn ab — der Status aktualisiert sich, sobald du wieder da bist.',
    },
    pendingOutcome: {
      title: 'Noch ausstehend',
      body: 'Ausstehend heißt: Das Ergebnis ist noch nicht bekannt. Geh nie davon aus, dass es geklappt hat — schau hier wieder nach.',
    },
  },
  coachDismiss: title => `Tipp ausblenden: ${title}`,
  coachDismissHint: 'Blendet diesen Tipp aus; er erscheint nicht wieder',

  passport: {
    title: 'Reisebereitschaft',
    stamps: {
      recoverySaved: {label: 'BACKUP\nGESICHERT', hint: 'Kopiere deine Backup-Wörter in den Einstellungen', short: 'noch das Backup'},
      flowUnderstood: {label: 'ABLAUF\nGESEHEN', hint: 'Mach beim ersten Start die Übungszahlung — oder mach eine beliebige Zahlung', short: 'noch den Ablauf ansehen'},
      fundsReady: {label: 'GUTHABEN\nGELADEN', hint: 'Lade echtes Guthaben auf — Übungsguthaben zählt nicht', short: 'noch Guthaben aufladen'},
      paymentTested: {label: 'ERSTE\nZAHLUNG', hint: 'Schließe eine Zahlung ab — bezahlen oder empfangen', short: 'noch eine Zahlung'},
    },
    close: title => `${title} schließen`,
    stripLabel: filled => `Reisebereitschaft ${filled} von 4`,
    count: filled => `${filled} VON 4`,
    goToStep: hint => `Los: ${hint}`,
    goToStepHint: 'Öffnet den Bereich, in dem dieser Schritt passiert',
    nextTag: 'Weiter',
    nextLabel: hint => `Weiter: ${hint}`,
    nextHint: 'Geht zu dem Bereich, in dem dieser Schritt passiert',
    doneHint: 'Blendet die Reisebereitschafts-Leiste dauerhaft aus',
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
