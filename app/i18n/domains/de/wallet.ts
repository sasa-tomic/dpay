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
    account: 'KONTO',
    accountLabel: 'Konto',
    home: 'dpay-Startseite',
    homeHint: 'Öffnet die dpay-Website',
  },

  balance: {
    label: 'Guthaben — Währung wechseln oder empfangen',
    hint: 'Öffnet die volle Asset-Liste, wechselt die angezeigte Währung oder empfängt',
    lockedHint: 'Beende oder brich zuerst die laufende Zahlung ab',
    of: asset => `${asset}-Guthaben`,
    approx: asset => `~ ${asset} ca.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Nochmal Zurück zum Beenden',
  },

  homeCurrency: {
    name: {CHF: 'Schweizer Franken', USD: 'US-Dollar', EUR: 'Euro'},
    chooseTitle: 'In welcher Währung denkst du?',
    chooseBody: 'dpay zeigt diese Währung zuerst an und bezahlt standardmässig damit. Du kannst auch alle anderen halten und das jederzeit in den Einstellungen ändern.',
    railReason: {destination: 'die Zahlung verlangt diesen Weg', funded: 'du hast hier ein Guthaben', preference: 'dpays Standard-Weg'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Haupt',
    mainLabel: currency => `${currency} · Haupt`,
    settingsTitle: 'Hauptwährung',
    settingsHint: 'Die Währung, die dpay zuerst anzeigt und standardmässig verwendet',
    confirm: 'Weiter',
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

  tab: {pay: 'Bezahlen', receive: 'Empfangen', transactions: 'Verlauf'},

  backToPaying: asset => `Zurück zum Bezahlen mit ${asset}`,

  faucet: {
    unavailableOnRelay: 'Demo-Aufladen ist auf diesem Relay nicht verfügbar',
    failed: 'Aufladen fehlgeschlagen',
    unavailable: 'Faucet nicht verfügbar',
    offline: 'Offline — versuche es erneut, wenn du verbunden bist',
  },

  balances: {
    title: 'Guthaben',
    close: 'Guthaben schließen',
    intro:
      'Tippe auf eine Währung, um sie auf deinem Startbildschirm zu zeigen. Empfangen und senden kannst du sie in den Tabs Empfangen und Bezahlen.',
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
    escToClose: 'Esc drücken zum Schließen',
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
        eyebrow: 'SO ZAHLT DPAY',
        title: 'Bezahlen ohne Signal',
        body: 'Dein Handy kann ganz ohne Signal bezahlen. Der Laden sendet die Zahlung für dich — über seine eigene Internetverbindung.',
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

  rehearsal: {
    title: 'Eine ehrliche Zahlung',
    sheetTitle: 'Probelauf',
    steps: {
      request: {
        title: 'Der Laden fordert an',
        body: 'Der Laden wählt genau ein Asset und einen Betrag — sein Terminal macht daraus einen Anfragecode.',
      },
      approve: {
        title: 'Du prüfst und gibst frei',
        body: 'Dein Handy zeigt genau, was du bezahlst. Nichts bewegt sich, bevor du es mit deinem Schlüssel freigibst.',
      },
      settle: {
        title: 'Der Laden wickelt ab',
        body: 'Die eigene Verbindung des Ladens sendet die Zahlung — in Sekunden auf seinem Bildschirm bestätigt.',
      },
    },
    stageTags: ['01 — ANFRAGE', '02 — FREIGABE', '03 — ABWICKLUNG'],
    punchline: 'Das war’s. Dein Handy darf bei Freigabe und Übergabe offline sein.',
    skip: 'Wallet ansehen',
    skipHint: 'Überspringt den Probelauf und öffnet deine Wallet',
    try: 'Mit Demo-Guthaben testen',
  },

  coachTips: {
    payReview: {
      title: 'Du gibst genau diese Zahlung frei',
      body: 'Mit der Freigabe wird genau dieser Betrag dieses Assets gesendet — aus deinem Guthaben, signiert mit deinem Schlüssel.',
    },
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
      flowUnderstood: {label: 'ABLAUF\nGESEHEN', hint: 'Sieh dir den Probelauf beim Erstellen einer Wallet an — oder mach eine Zahlung', short: 'noch den Ablauf ansehen'},
      fundsReady: {label: 'GUTHABEN\nGELADEN', hint: 'Lade Guthaben auf — Demo-Guthaben zählt', short: 'noch Guthaben aufladen'},
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
