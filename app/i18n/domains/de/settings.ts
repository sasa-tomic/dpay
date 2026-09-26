/**
 * i18n/domains/de/settings.ts — German values for the Settings sheet + the Onboarding flow.
 * Types, key documentation and the reference copy: ../en/settings.ts. Glossary: ../../de.ts.
 */
import type {CopyWordsCopy, OnboardingMessages, SettingsMessages} from '../../keys';

const copyWordsDe: CopyWordsCopy = {
  copyWords: 'Wörter kopieren',
  wordsCopied: 'Wörter kopiert',
  wordsShared: 'Wörter geteilt',
  copiedCheck: 'Kopiert ✓',
  sharedCheck: 'Geteilt ✓',
};

export const settingsDe: SettingsMessages = {
  title: 'Einstellungen',
  close: 'Einstellungen schließen',

  backup: {
    ...copyWordsDe,
    label: 'Backup',
    warning:
      'Dieser Seed stellt SOWOHL dein IC- als auch dein Solana-Guthaben wieder her. Bewahre ihn sicher auf, teile ihn niemals.',
    copyWordsHint: 'Kopiert deine 24 Wiederherstellungswörter in die Zwischenablage',
    copySeed: 'Seed kopieren',
    seedCopied: 'Seed kopiert',
    seedShared: 'Seed geteilt',
    copySeedHint: 'Kopiert deinen Wiederherstellungs-Seed in die Zwischenablage',
    showAsHex: 'Als Hex zeigen',
    showAsHexA11y: 'Seed als Hex zeigen',
    showAsWords: 'Als Wörter zeigen',
    showAsWordsA11y: 'Seed als Wörter zeigen',
    hide: 'Verbergen',
    hideA11y: 'Seed verbergen',
    reveal: 'Seed anzeigen',
    revealA11y: 'Wiederherstellungs-Seed anzeigen',
    revealHint: 'Zeigt deinen Seed auf dem Bildschirm — wer mitschaut, kann ihn abschreiben',
    cancelA11y: 'Backup abbrechen',
    action: 'Wallet sichern',
    entry: 'Wallet sichern…',
    entryHint: 'Zeigt deinen Wiederherstellungs-Seed',
  },

  restore: {
    label: 'Wiederherstellen',
    warning:
      'Ersetzt deine aktuelle Wallet durch die aus diesem Seed. Sichere zuerst die aktuelle — ihr Guthaben ist nur mit ihrem eigenen Seed erreichbar.',
    seedPlaceholder: '24 Wiederherstellungswörter oder 64 Hex-Zeichen',
    seedA11y: 'Wiederherstellungs-Seed',
    seedHint: 'Deine 24 Wiederherstellungswörter oder der 64-Hex-Seed aus dem Backup',
    action: 'Wallet wiederherstellen',
    actionHint: 'Ersetzt deine aktuelle Wallet',
    busy: 'Wird wiederhergestellt…',
    cancelA11y: 'Wiederherstellung abbrechen',
    entry: 'Wallet wiederherstellen…',
    entryHint: 'Importiert eine Wallet aus einem Seed — ersetzt deine aktuelle Wallet',
    errEmpty: 'Gib deine 24 Wiederherstellungswörter oder den 64-Hex-Seed ein.',
    errWords:
      'Einige Wörter sind falsch oder fehlen. Prüfe, ob alle 24 Wörter richtig geschrieben sind, oder füge stattdessen den 64-Hex-Seed ein.',
  },

  reset: {
    label: 'Zurücksetzen',
    warning:
      'Das löscht deine Wallet von diesem Gerät. Geld an dieser Adresse ist dann unwiederbringlich verloren.',
    confirm: 'Ja, alles zurücksetzen',
    cancelA11y: 'Zurücksetzen abbrechen',
    action: 'Wallet zurücksetzen',
    entry: 'Wallet zurücksetzen…',
    entryHint: 'Löscht deine Wallet dauerhaft von diesem Gerät',
  },

  learn: {
    label: 'Lernen',
    passportHint: 'Zeigt deinen Reisebereitschafts-Pass',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Spielt die Anleitung noch einmal ab, wie dpay bezahlt',
  },

  addressBook: {
    label: 'Adressbuch',
    entry: 'Gespeicherte Adressen…',
    entryHint: 'Adressen, an die du gesendet hast, benennen, hinzufügen und entfernen',
  },

  theme: {
    label: 'Design',
    light: 'Hell',
    dark: 'Dunkel',
    auto: 'Auto',
    choice: label => `Design: ${label}`,
  },

  language: {
    label: 'Sprache',
    auto: 'Auto',
    choice: label => `Sprache: ${label}`,
  },

  advanced: {
    label: 'Erweitert',
    show: 'Erweiterte Einstellungen zeigen',
    hide: 'Erweiterte Einstellungen verbergen',
    hint: 'Server- und Netzwerk-Endpunkte, mit denen diese Wallet spricht',
    serverNote: 'Eine Adresse pro Zeile. Verwendet wird die erste, die antwortet. Tippe auf Übernehmen, um zu speichern.',
    serverLabel: 'Server',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Übernehmen',
    applyA11y: 'Server-URL übernehmen',
    solanaNote: 'Liest Guthaben und sendet Zahlungen über Solana. Leer folgt deine Serverliste; ein eigener Anbieter nimmt dpay aus dem Pfad.',
    solanaLabel: 'Solana-Endpunkt',
    solanaPlaceholder: 'https://<anbieter>/?api-key=<schlüssel>',
    solanaApplyA11y: 'Solana-Endpunkt übernehmen',
    // F2 — der IC-Gateway-Override. Nur für Betreiber (Demos/Tests gegen eine lokale Replica),
    // kein Nutzer-Feature; der Hinweis sagt es ehrlich, wie die Solana-Zeile darüber.
    icGatewayNote: 'Nur für Betreiber: die Basis-URL, an die diese Wallet IC-Transaktionen sendet. Leer nutzt das öffentliche Gateway; setze eine lokale Replica für Demos und Tests.',
    icGatewayLabel: 'IC-Gateway',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'IC-Gateway übernehmen',
  },

  about: {
    label: 'Über dpay',
    custody:
      'dpay ist nicht verwahrend: Dein Geld wird allein durch den Schlüssel auf diesem Gerät kontrolliert. Es gibt kein dpay-Konto. dpay kann es weder bewegen noch einfrieren noch wiederherstellen — deine 24 Backup-Wörter sind der einzige Weg zurück.',
    privacy: 'Datenschutzerklärung',
  },
};

export const onboardingDe: OnboardingMessages = {
  tagline: 'Auflegen oder scannen zum Bezahlen — online oder offline.',
  custody: 'Kein Konto. Dein Schlüssel verlässt dieses Handy nie. Nicht einmal dpay kann dein Geld bewegen.',
  continue: 'Weiter',
  errOwnSeed:
    'Dieser Seed sieht nicht richtig aus. Füge deine 24 Wiederherstellungswörter oder den 64-Hex-Seed genau so ein, wie notiert.',
  errWords: 'Einige Wörter sind falsch oder fehlen. Prüfe, ob alle 24 Wörter richtig geschrieben sind.',
  errSaveWallet: 'Dieses Handy konnte deine Wallet nicht speichern, sie wurde also noch nicht erstellt. Tippe erneut auf Weiter, um es erneut zu versuchen. Wenn es weiter fehlschlägt, gib Speicherplatz auf dem Handy frei.',

  recoverySaved: {
    stamp: 'Backup gesichert',
    line: 'Nur diese Wörter holen deine Wallet zurück.',
  },

  backup: {
    ...copyWordsDe,
    title: 'Sichere deine Wallet',
    warning:
      'Schreib diese 24 Wörter auf und bewahre sie sicher auf. Sie sind der einzige Weg, deine Wallet wiederherzustellen, wenn du dieses Gerät verlierst — es gibt kein dpay-Konto, und nicht einmal dpay kann sie wiederherstellen.',
    copyWordsHint: 'Kopiert alle 24 Wörter ohne die Positionsnummern',
    ack: 'Ich habe alle 24 Wörter aufgeschrieben',
  },

  restore: {
    phraseLabel: 'Wiederherstellungsphrase',
    phrasePlaceholder: 'Gib deine 24 Wiederherstellungswörter ein',
    phraseNote: 'Ein Seed stellt dein IC- und dein Solana-Guthaben wieder her.',
    seedLabel: 'Wiederherstellungs-Seed',
    seedPlaceholder: '64 Hex-Zeichen',
    seedHint: 'Der 64-Hex-Seed aus dem Backup',
    seedNote: 'Ein Seed stellt dein IC- und dein Solana-Guthaben wieder her.',
    enterHex: 'Stattdessen Hex eingeben',
    enterWords: 'Stattdessen Wörter eingeben',
    action: 'Wallet wiederherstellen',
    busy: 'Wird wiederhergestellt…',
    cancelA11y: 'Wiederherstellung abbrechen',
    cancelHint: 'Zurück zum Erstellen einer neuen Wallet',
    entryHint: 'Stellt eine Wallet aus deinem Backup wieder her',
  },

  usernameLabel: 'Wähle einen Benutzernamen',
  usernamePlaceholder: 'z. B. Alice',
  usernameA11y: 'Benutzername',
  usernameHint: 'Der Name, den andere sehen, wenn du eine Zahlung anforderst oder empfängst',

  ownSeed: {
    useOwn: 'Stattdessen eigenen Seed nutzen',
    useRandom: 'Stattdessen zufälligen Seed erzeugen',
    toggleHint: 'Füge den Seed einer bestehenden Wallet ein, statt einen neuen zu erzeugen',
    placeholder: 'Deine 24 Wörter oder der 64-Hex-Seed',
    a11y: 'Eigener Seed',
    hint: 'Optional: der Seed, aus dem diese Wallet gebaut wird',
    note: 'Leer lassen, um einen neuen zufälligen Seed zu erzeugen.',
  },

  create: {
    action: 'Wallet erstellen',
    busy: 'Wird erstellt…',
  },

  demoNote: 'Beim Erstellen der Wallet wird kein Geld eingezahlt, gekauft oder bewegt.',
  demoGlyphNote: ' ist Übungsgeld ohne Geldwert — ∂1 ist einfach eine DEMO-Einheit.',
};
