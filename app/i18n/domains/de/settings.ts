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
  escToClose: 'Esc drücken zum Schließen',

  backup: {
    ...copyWordsDe,
    label: 'Backup',
    warning:
      'Dieser Seed stellt SOWOHL dein IC- als auch dein Solana-Guthaben wieder her. Bewahre ihn sicher auf. Teile ihn niemals.',
    copyWordsHint: 'Kopiert deine 24 Wiederherstellungswörter in die Zwischenablage',
    copySeed: 'Seed kopieren',
    seedCopied: 'Seed kopiert',
    seedShared: 'Seed geteilt',
    copySeedHint: 'Kopiert deinen Wiederherstellungs-Seed in die Zwischenablage',
    showAsHex: 'Als Hex zeigen',
    showAsHexA11y: 'Seed als Hex zeigen',
    showAsHexHint: 'Wechselt zur Ansicht des rohen 64-Hex-Seeds',
    showAsWords: 'Als Wörter zeigen',
    showAsWordsA11y: 'Seed als Wörter zeigen',
    showAsWordsHint: 'Wechselt zur Ansicht der 24-Wort-Wiederherstellungsphrase',
    hide: 'Verbergen',
    hideA11y: 'Seed verbergen',
    reveal: 'Seed anzeigen',
    revealA11y: 'Wiederherstellungs-Seed anzeigen',
    revealHint: 'Zeigt deinen Seed auf dem Bildschirm — wer mitschaut, kann ihn abschreiben',
    cancelA11y: 'Backup abbrechen',
    action: 'Wallet sichern',
    entry: 'Wallet sichern…',
    entryHint: 'Zeigt deinen Wiederherstellungs-Seed — sichert dein IC- und dein Solana-Guthaben',
  },

  restore: {
    label: 'Wiederherstellen',
    warning:
      'Das ersetzt deine aktuelle Wallet durch die aus diesem Seed wiederhergestellte. Sichere zuerst deine aktuelle Wallet, falls noch nicht geschehen — ihr Guthaben ist nur über ihren eigenen Seed erreichbar.',
    seedPlaceholder: '24 Wiederherstellungswörter oder 64 Hex-Zeichen',
    seedA11y: 'Wiederherstellungs-Seed',
    seedHint:
      'Deine 24 Wiederherstellungswörter (oder der 64-Hex-Seed aus dem Backup), die deine Wallet wiederherstellen',
    action: 'Wallet wiederherstellen',
    actionHint: 'Ersetzt deine aktuelle Wallet durch die aus diesem Seed wiederhergestellte',
    busy: 'Wird wiederhergestellt…',
    cancelA11y: 'Wiederherstellung abbrechen',
    entry: 'Wallet wiederherstellen…',
    entryHint: 'Importiert eine Wallet aus deinem 64-Hex-Seed — ersetzt deine aktuelle Wallet',
    errEmpty: 'Gib deine 24 Wiederherstellungswörter oder den 64-Hex-Seed ein.',
    errWords:
      'Einige Wörter sind falsch oder fehlen. Prüfe, ob alle 24 Wörter richtig geschrieben sind — oder füge stattdessen den 64-Hex-Seed ein.',
  },

  reset: {
    label: 'Zurücksetzen',
    warning:
      'Das löscht deine Wallet-Identität von diesem Gerät. Guthaben an dieser Adresse ist dann unwiederbringlich verloren. Das lässt sich nicht rückgängig machen.',
    confirm: 'Ja, alles zurücksetzen',
    confirmHint: 'Löscht deine Wallet dauerhaft von diesem Gerät — Guthaben wird unwiederbringlich',
    cancelA11y: 'Zurücksetzen abbrechen',
    action: 'Wallet zurücksetzen',
    entry: 'Wallet zurücksetzen…',
    entryHint: 'Öffnet eine Bestätigung — löscht deine Wallet dauerhaft von diesem Gerät',
  },

  learn: {
    label: 'Lernen',
    passportHint: 'Zeigt deinen Reisebereitschafts-Pass — die vier Stempel',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Spielt die drei Szenen noch einmal ab, die zeigen, wie dpay bezahlt',
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
    hint: 'Server-Konfiguration für das Relay der Wallet',
    serverNote: 'Der Server, mit dem deine Wallet spricht. Änderungen gelten, wenn du auf Übernehmen tippst.',
    serverLabel: 'Server',
    serverPlaceholder: 'http://<ip>:8787',
    serverHint: 'Der Server, mit dem deine Wallet spricht',
    apply: 'Übernehmen',
    applyA11y: 'Server-URL übernehmen',
    applyHint: 'Schaltet deine Wallet auf die eingegebene Server-URL um',
  },

  about: {
    label: 'Über dpay',
    custody:
      'dpay ist nicht verwahrend. Dein Geld wird allein durch den Schlüssel auf diesem Gerät kontrolliert. Es gibt kein dpay-Konto, und dpay kann dein Guthaben weder bewegen noch einfrieren noch wiederherstellen. Deine 24 Backup-Wörter sind der einzige Weg zurück.',
    privacy: 'Datenschutzerklärung',
  },
};

export const onboardingDe: OnboardingMessages = {
  tagline: 'Auflegen oder scannen zum Bezahlen — online oder offline.',
  custody: 'Kein Konto. Dein Schlüssel verlässt dieses Handy nie. Nicht einmal dpay kann dein Geld bewegen.',
  continue: 'Weiter',
  errOwnSeed:
    'Dieser Seed sieht nicht richtig aus. Füge deine 24 Wiederherstellungswörter oder den 64-Hex-Seed genau so ein, wie du sie notiert hast.',
  errWords: 'Einige Wörter sind falsch oder fehlen. Prüfe, ob alle 24 Wörter richtig geschrieben sind.',

  recoverySaved: {
    stamp: 'Backup gesichert',
    line: 'Nur diese Wörter holen deine Wallet zurück.',
    sub: 'Du hast sie. Sonst niemand.',
  },

  backup: {
    ...copyWordsDe,
    title: 'Sichere deine Wallet',
    ritual: 'Ab jetzt gehört die Wallet wirklich dir — nur diese Wörter holen dein Geld zurück.',
    warning:
      'Schreib diese 24 Wörter auf und bewahre sie sicher auf. Sie sind der EINZIGE Weg, deine Wallet wiederherzustellen, wenn du dieses Gerät verlierst. Es gibt kein dpay-Konto, in das du dich zurück einloggen kannst. Verlierst du diese Wörter und dieses Handy, ist dein Geld weg. Nicht einmal wir können es zurückholen.',
    copyWordsHint: 'Kopiert alle 24 Wiederherstellungswörter ohne die Positionsnummern in die Zwischenablage',
    ack: 'Ich habe alle 24 Wörter aufgeschrieben',
  },

  faucetFailed:
    'Wallet erstellt, aber das Startguthaben konnte nicht hinzugefügt werden. Der Server ist womöglich offline — du kannst später im Guthaben-Bereich aufladen.',

  restore: {
    phraseLabel: 'Wiederherstellungsphrase',
    phrasePlaceholder: 'Gib deine 24 Wiederherstellungswörter ein',
    phraseHint: 'Die 24 Wiederherstellungswörter aus deinem Backup',
    phraseNote: 'Gib die 24 Wörter aus deinem Backup ein. Ein Seed stellt dein IC- und dein Solana-Guthaben wieder her.',
    seedLabel: 'Wiederherstellungs-Seed',
    seedPlaceholder: '64 Hex-Zeichen',
    seedHint: 'Der 64-Hex-Seed aus dem Backup, der deine Wallet wiederherstellt',
    seedNote: 'Ein Seed stellt dein IC- und dein Solana-Guthaben wieder her.',
    enterHex: 'Stattdessen Hex eingeben',
    enterWords: 'Stattdessen Wörter eingeben',
    action: 'Wallet wiederherstellen',
    busy: 'Wird wiederhergestellt…',
    hintMnemonic: 'Stellt deine Wallet aus deinen 24 Wiederherstellungswörtern wieder her',
    hintHex: 'Stellt deine Wallet aus dem Wiederherstellungs-Seed wieder her',
    cancelA11y: 'Wiederherstellung abbrechen',
    cancelHint: 'Zurück zum Erstellen einer neuen Wallet',
    entryHint: 'Stellt eine Wallet aus deiner 24-Wort-Wiederherstellungsphrase wieder her',
  },

  usernameLabel: 'Wähle einen Benutzernamen',
  usernamePlaceholder: 'z. B. Alice',
  usernameA11y: 'Benutzername',
  usernameHint: 'Der Name, den andere sehen, wenn du eine Zahlung anforderst oder empfängst',

  ownSeed: {
    useOwn: 'Stattdessen eigenen Seed nutzen',
    useRandom: 'Stattdessen zufälligen Seed erzeugen',
    toggleHint:
      'Zeigt ein Feld, in das du die 24 Wiederherstellungswörter oder den 64-Hex-Seed einer bestehenden Wallet einfügst, statt einen neuen zu erzeugen',
    placeholder: 'Deine 24 Wörter oder der 64-Hex-Seed',
    a11y: 'Eigener Seed',
    hint: 'Optional: die 24 Wiederherstellungswörter oder der 64-Hex-Seed, aus dem diese Wallet gebaut wird, statt eines neuen zufälligen',
    note: 'Leer lassen, um einen neuen zufälligen Seed zu erzeugen.',
  },

  create: {
    action: 'Wallet erstellen',
    busy: 'Wird erstellt…',
    hint: 'Erzeugt deinen Schlüssel auf dem Gerät und fügt Demo-Guthaben hinzu',
  },

  demoNote: 'Erstellt deine Wallet und fügt für den Start ∂100 Demo-Guthaben hinzu.',
  demoGlyphNote: ' ist das Symbol für Demo-Dollar — Spielgeld, ∂1 = $1.',
};
