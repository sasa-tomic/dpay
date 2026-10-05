/**
 * i18n/domains/fr/settings.ts - French values for the Settings sheet + the Onboarding flow.
 *
 * Reference copy and all documentation: ../en/settings.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {CopyWordsCopy, OnboardingMessages, SettingsMessages} from '../../keys';

/** French twin of the English `copyWordsEn` - one source for both surfaces that reveal the words. */
const copyWordsFr: CopyWordsCopy = {
  copyWords: 'Copier les mots',
  wordsCopied: 'Mots copiés',
  wordsShared: 'Mots partagés',
  copiedCheck: 'Copié ✓',
  sharedCheck: 'Partagé ✓',
};

export const settingsFr: SettingsMessages = {
  title: 'Paramètres',
  close: 'Fermer les paramètres',

  backup: {
    ...copyWordsFr,
    label: 'Sauvegarde',
    warning: 'Restaure vos fonds IC et Solana. Conservez-le en lieu sûr, ne le partagez jamais.',
    copyWordsHint: 'Copie les 24 mots',
    copySeed: 'Copier le code',
    seedCopied: 'Code copié',
    seedShared: 'Code partagé',
    copySeedHint: 'Copie le code',
    showAsHex: 'Voir en hexa',
    showAsHexA11y: 'Voir le code en hexadécimal',
    showAsWords: 'Voir en mots',
    showAsWordsA11y: 'Voir le code en mots',
    hide: 'Masquer',
    hideA11y: 'Masquer le code',
    reveal: 'Afficher le code',
    revealA11y: 'Afficher le code de récupération',
    revealHint: 'Toute personne qui voit votre écran peut le copier',
    cancelA11y: 'Annuler la sauvegarde',
    action: 'Sauvegarder le portefeuille',
    entry: 'Sauvegarder le portefeuille…',
    entryHint: 'Affiche votre code de récupération',
  },

  restore: {
    label: 'Restaurer',
    warning:
      'Remplace votre portefeuille actuel. Sauvegardez d’abord l’actuel - son argent n’est accessible qu’avec son code.',
    seedPlaceholder: '24 mots de récupération ou 64 caractères hexa',
    seedA11y: 'Code de récupération',
    seedHint: '24 mots de récupération ou le code hexadécimal de la Sauvegarde',
    action: 'Restaurer le portefeuille',
    actionHint: 'Remplace votre portefeuille actuel',
    busy: 'Restauration…',
    cancelA11y: 'Annuler la restauration',
    entry: 'Restaurer le portefeuille…',
    entryHint: 'Remplace votre portefeuille actuel',
    errEmpty: 'Saisissez vos 24 mots de récupération ou votre code de 64 caractères hexadécimaux.',
    errWords:
      'Certains mots sont incorrects ou manquants. Vérifiez les 24, ou collez plutôt le code de récupération.',
  },

  reset: {
    label: 'Réinitialiser',
    warning:
      'Efface ce portefeuille de cet appareil. Son argent devient irrécupérable.',
    confirm: 'Tout réinitialiser',
    cancelA11y: 'Annuler la réinitialisation',
    action: 'Réinitialiser le portefeuille',
    entry: 'Réinitialiser le portefeuille…',
    entryHint: 'Efface le portefeuille de cet appareil',
  },

  learn: {
    label: 'Découvrir',
    passportHint: 'Ouvrez le passeport',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Rejoue la présentation',
  },

  addressBook: {
    label: 'Carnet d’adresses',
    entry: 'Adresses enregistrées…',
    entryHint: 'Consulter, nommer et supprimer les adresses enregistrées',
  },

  theme: {
    label: 'Thème',
    light: 'Clair',
    dark: 'Sombre',
    auto: 'Auto',
    choice: label => `Thème : ${label}`,
  },

  language: {
    label: 'Langue',
    auto: 'Auto',
    choice: label => `Langue : ${label}`,
  },

  advanced: {
    label: 'Avancé',
    show: 'Afficher l’avancé',
    hide: 'Masquer l’avancé',
    hint: 'Serveurs et points d’accès réseau',
    serverNote: 'Une par ligne ; la première qui répond est utilisée. Appliquer pour enregistrer.',
    serverLabel: 'Serveur',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Appliquer',
    applyA11y: 'Appliquer l’URL du serveur',
    solanaNote: 'Lit les soldes et envoie les paiements. Vide, il suit votre liste de serveurs ; votre fournisseur retire dpay du chemin.',
    solanaLabel: 'Point d’accès Solana',
    solanaPlaceholder: 'https://<fournisseur>/?api-key=<clé>',
    solanaApplyA11y: 'Appliquer le point d’accès Solana',
    evmNote: 'Règle les ZCHF sur Ethereum et Arbitrum One via le relais dpay. Vide, il suit le serveur ; un point d\u2019accès sert TOUTES les chaînes  -  il doit d\u2019abord prouver la bonne chaîne.',
    evmLabel: 'Point d’accès EVM (toutes les chaînes)',
    evmPlaceholder: 'https://<fournisseur>',
    evmApplyA11y: 'Appliquer le point d’accès EVM',
    // F2 - le remplacement de la passerelle IC. Réservé aux opérateurs (démos/tests contre une
    // réplique locale), pas une fonction utilisateur ; la note le dit honnêtement, comme la
    // ligne Solana ci-dessus.
    icGatewayNote: 'Réservé aux opérateurs. Vide, la passerelle publique est utilisée ; définissez une réplique locale pour les démos et les tests.',
    icGatewayLabel: 'Passerelle IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'Appliquer la passerelle IC',
  },

  about: {
    label: 'À propos',
    custody:
      'Sans conservation de fonds : votre argent est contrôlé par la seule clé de cet appareil. Aucun compte dpay. dpay ne peut ni le déplacer, ni le bloquer, ni le récupérer - vos 24 mots de sauvegarde sont le seul moyen de récupération.',
    privacy: 'Politique de confidentialité',
  },
};

export const onboardingFr: OnboardingMessages = {
  tagline: 'Payez sans contact ou par scan - en ligne ou hors ligne.',
  custody: 'Aucun compte. Votre clé ne quitte jamais ce téléphone. Même dpay ne peut pas déplacer votre argent.',
  continue: 'Continuer',
  errOwnSeed:
    'Ce code ne semble pas correct. Collez vos 24 mots de récupération ou votre code hexadécimal en entier.',
  errWords: 'Certains mots sont incorrects ou manquants. Vérifiez les 24.',
  errSaveWallet: 'Votre portefeuille n’a pas été enregistré. Touchez de nouveau Continuer pour réessayer. Si cela échoue encore, libérez de l’espace de stockage sur le téléphone.',

  recoverySaved: {
    stamp: 'Sauvegarde faite',
    line: 'Seuls ces mots peuvent ramener votre portefeuille.',
  },

  backup: {
    ...copyWordsFr,
    title: 'Sauvegardez votre portefeuille',
    warning:
      'Notez ces 24 mots et conservez-les en lieu sûr. C’est le seul moyen de récupérer ce portefeuille - même dpay ne peut pas les récupérer.',
    copyWordsHint: 'Copie les 24 mots',
    ack: 'J’ai noté les 24 mots',
  },

  restore: {
    phraseLabel: 'Phrase de récupération',
    phrasePlaceholder: 'Saisissez vos 24 mots de récupération',
    phraseNote: 'Restaure vos fonds IC et Solana.',
    seedLabel: 'Code de récupération',
    seedPlaceholder: '64 caractères hexadécimaux',
    seedHint: 'Le code hexadécimal affiché par la Sauvegarde',
    seedNote: 'Restaure vos fonds IC et Solana.',
    enterHex: 'Saisir plutôt l’hexa',
    enterWords: 'Saisir plutôt les mots',
    action: 'Restaurer le portefeuille',
    busy: 'Restauration…',
    cancelA11y: 'Annuler la restauration',
    cancelHint: 'Revient à la création d’un nouveau portefeuille',
    entryHint: 'Restaure un portefeuille depuis votre sauvegarde',
  },

  usernameLabel: 'Choisissez un nom d’utilisateur',
  usernamePlaceholder: 'ex. Alice',
  usernameA11y: 'Nom d’utilisateur',
  usernameHint: 'Le nom que les autres voient',

  ownSeed: {
    useOwn: 'Utiliser plutôt mon code',
    useRandom: 'Générer plutôt un code aléatoire',
    toggleHint: 'Collez le code d’un portefeuille existant',
    placeholder: 'Vos 24 mots ou votre code hexa',
    a11y: 'Mon code de récupération',
    hint: 'Le code à partir duquel construire ce portefeuille',
    note: 'Laissez vide pour en générer un.',
  },

  create: {
    action: 'Créer le portefeuille',
    busy: 'Création…',
  },

  demoNote: 'Créer le portefeuille ne déplace aucun argent.',
  demoGlyphNote: ' désigne de l’argent d’exercice sans valeur - ∂1 est une unité DÉMO.',
};
