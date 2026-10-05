/**
 * i18n/domains/de/settings.ts - German values for the Settings sheet + the Onboarding flow.
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
      'Stellt dein IC- und dein Solana-Guthaben wieder her. Bewahre ihn sicher auf, teile ihn niemals.',
    copyWordsHint: 'Kopiert die 24 Wörter',
    copySeed: 'Seed kopieren',
    seedCopied: 'Seed kopiert',
    seedShared: 'Seed geteilt',
    copySeedHint: 'Kopiert den Seed',
    showAsHex: 'Als Hex zeigen',
    showAsHexA11y: 'Seed als Hex zeigen',
    showAsWords: 'Als Wörter zeigen',
    showAsWordsA11y: 'Seed als Wörter zeigen',
    hide: 'Verbergen',
    hideA11y: 'Seed verbergen',
    reveal: 'Seed anzeigen',
    revealA11y: 'Wiederherstellungs-Seed anzeigen',
    revealHint: 'Wer mitschaut, kann ihn abschreiben',
    cancelA11y: 'Backup abbrechen',
    action: 'Wallet sichern',
    entry: 'Wallet sichern…',
    entryHint: 'Zeigt deinen Wiederherstellungs-Seed',
  },

  restore: {
    label: 'Wiederherstellen',
    warning:
      'Ersetzt deine aktuelle Wallet. Sichere sie zuerst - ihr Guthaben ist nur mit ihrem eigenen Seed erreichbar.',
    seedPlaceholder: '24 Wiederherstellungswörter oder 64 Hex-Zeichen',
    seedA11y: 'Wiederherstellungs-Seed',
    seedHint: '24 Wiederherstellungswörter oder der 64-Hex-Seed aus dem Backup',
    action: 'Wallet wiederherstellen',
    actionHint: 'Ersetzt deine aktuelle Wallet',
    busy: 'Wird wiederhergestellt…',
    cancelA11y: 'Wiederherstellung abbrechen',
    entry: 'Wallet wiederherstellen…',
    entryHint: 'Ersetzt deine aktuelle Wallet',
    errEmpty: 'Gib deine 24 Wiederherstellungswörter oder den 64-Hex-Seed ein.',
    errWords:
      'Einige Wörter sind falsch oder fehlen. Prüfe alle 24, oder füge stattdessen den 64-Hex-Seed ein.',
  },

  reset: {
    label: 'Zurücksetzen',
    warning:
      'Löscht diese Wallet von diesem Gerät. Ihr Geld ist dann unwiederbringlich verloren.',
    confirm: 'Alles zurücksetzen',
    cancelA11y: 'Zurücksetzen abbrechen',
    action: 'Wallet zurücksetzen',
    entry: 'Wallet zurücksetzen…',
    entryHint: 'Löscht die Wallet von diesem Gerät',
  },

  learn: {
    label: 'Lernen',
    passportHint: 'Öffnet den Pass',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Spielt die Anleitung noch einmal ab',
  },

  addressBook: {
    label: 'Adressbuch',
    entry: 'Gespeicherte Adressen…',
    entryHint: 'Gespeicherte Adressen ansehen, benennen und entfernen',
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
    show: 'Erweitert zeigen',
    hide: 'Erweitert verbergen',
    hint: 'Server- und Netzwerk-Endpunkte',
    serverNote: 'Eine pro Zeile; verwendet wird die erste, die antwortet. Übernehmen zum Speichern.',
    serverLabel: 'Server',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Übernehmen',
    applyA11y: 'Server-URL übernehmen',
    solanaNote: 'Liest Guthaben und sendet Zahlungen. Leer folgt der Serverliste; ein anderer Anbieter nimmt dpay aus dem Pfad.',
    solanaLabel: 'Solana-Endpunkt',
    solanaPlaceholder: 'https://<anbieter>/?api-key=<schlüssel>',
    solanaApplyA11y: 'Solana-Endpunkt übernehmen',
    evmNote: 'Wickelt ZCHF auf Ethereum und Arbitrum One über das dpay-Relais ab. Leer folgt dem Server; ein Endpunkt bedient ALLE Chains  -  er muss zuerst die richtige Chain nachweisen.',
    evmLabel: 'EVM-Endpunkt (alle Chains)',
    evmPlaceholder: 'https://<anbieter>',
    evmApplyA11y: 'EVM-Endpunkt übernehmen',
    // F2 - der IC-Gateway-Override. Nur für Betreiber (Demos/Tests gegen eine lokale Replica),
    // kein Nutzer-Feature; der Hinweis sagt es ehrlich, wie die Solana-Zeile darüber.
    icGatewayNote: 'Nur für Betreiber. Leer nutzt das öffentliche Gateway; setze eine lokale Replica für Demos und Tests.',
    icGatewayLabel: 'IC-Gateway',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'IC-Gateway übernehmen',
  },

  about: {
    label: 'Über dpay',
    custody:
      'Nicht verwahrend: Dein Geld wird allein durch deinen Schlüssel kontrolliert. Kein dpay-Konto. dpay kann es weder bewegen noch einfrieren noch wiederherstellen - deine 24 Backup-Wörter sind der einzige Weg zurück.',
    privacy: 'Datenschutzerklärung',
  },
};

export const onboardingDe: OnboardingMessages = {
  tagline: 'Auflegen oder scannen zum Bezahlen - online oder offline.',
  custody: 'Kein Konto. Dein Schlüssel verlässt dieses Handy nie. Nicht einmal dpay kann dein Geld bewegen.',
  continue: 'Weiter',
  errOwnSeed:
    'Dieser Seed sieht nicht richtig aus. Füge deine 24 Wiederherstellungswörter oder den 64-Hex-Seed vollständig ein.',
  errWords: 'Einige Wörter sind falsch oder fehlen. Prüfe alle 24.',
  errSaveWallet: 'Deine Wallet wurde nicht gespeichert. Tippe erneut auf Weiter. Wenn es weiter fehlschlägt, gib Speicherplatz auf dem Handy frei.',

  recoverySaved: {
    stamp: 'Backup gesichert',
    line: 'Nur diese Wörter holen deine Wallet zurück.',
  },

  backup: {
    ...copyWordsDe,
    title: 'Sichere deine Wallet',
    warning:
      'Schreib diese 24 Wörter auf und bewahre sie sicher auf. Sie sind der einzige Weg, diese Wallet wiederherzustellen - nicht einmal dpay kann sie wiederherstellen.',
    copyWordsHint: 'Kopiert die 24 Wörter',
    ack: 'Ich habe alle 24 Wörter aufgeschrieben',
  },

  restore: {
    phraseLabel: 'Wiederherstellungsphrase',
    phrasePlaceholder: 'Gib deine 24 Wiederherstellungswörter ein',
    phraseNote: 'Stellt dein IC- und dein Solana-Guthaben wieder her.',
    seedLabel: 'Wiederherstellungs-Seed',
    seedPlaceholder: '64 Hex-Zeichen',
    seedHint: 'Der 64-Hex-Seed aus dem Backup',
    seedNote: 'Stellt dein IC- und dein Solana-Guthaben wieder her.',
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
  usernameHint: 'Der Name, den andere sehen',

  ownSeed: {
    useOwn: 'Stattdessen eigenen Seed nutzen',
    useRandom: 'Stattdessen zufälligen Seed erzeugen',
    toggleHint: 'Füge den Seed einer bestehenden Wallet ein',
    placeholder: 'Deine 24 Wörter oder der 64-Hex-Seed',
    a11y: 'Seed selbst wählen',
    hint: 'Der Seed, aus dem diese Wallet gebaut wird',
    note: 'Leer lassen, um einen zu erzeugen.',
  },

  create: {
    action: 'Wallet erstellen',
    busy: 'Wird erstellt…',
  },

  demoNote: 'Beim Erstellen der Wallet wird kein Geld bewegt.',
  demoGlyphNote: ' ist Übungsgeld ohne Geldwert - ∂1 ist eine DEMO-Einheit.',
};
