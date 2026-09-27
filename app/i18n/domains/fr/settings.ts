/**
 * i18n/domains/fr/settings.ts — French values for the Settings sheet + the Onboarding flow.
 *
 * Reference copy and all documentation: ../en/settings.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {CopyWordsCopy, OnboardingMessages, SettingsMessages} from '../../keys';

/** French twin of the English `copyWordsEn` — one source for both surfaces that reveal the words. */
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
    warning: 'Ce code de récupération restaure À LA FOIS vos fonds IC et Solana. Conservez-le en lieu sûr, ne le partagez jamais.',
    copyWordsHint: 'Copie vos 24 mots de récupération dans le presse-papiers',
    copySeed: 'Copier le code',
    seedCopied: 'Code copié',
    seedShared: 'Code partagé',
    copySeedHint: 'Copie votre code de récupération dans le presse-papiers',
    showAsHex: 'Voir en hexa',
    showAsHexA11y: 'Voir le code en hexadécimal',
    showAsWords: 'Voir en mots',
    showAsWordsA11y: 'Voir le code en mots',
    hide: 'Masquer',
    hideA11y: 'Masquer le code',
    reveal: 'Afficher le code',
    revealA11y: 'Afficher le code de récupération',
    revealHint: 'Affiche votre code à l’écran — toute personne qui voit votre écran peut le copier',
    cancelA11y: 'Annuler la sauvegarde',
    action: 'Sauvegarder le portefeuille',
    entry: 'Sauvegarder le portefeuille…',
    entryHint: 'Affiche votre code de récupération',
  },

  restore: {
    label: 'Restaurer',
    warning:
      'Remplace votre portefeuille actuel par celui de ce code. Sauvegardez d’abord l’actuel — son argent n’est accessible qu’avec son propre code.',
    seedPlaceholder: '24 mots de récupération ou 64 caractères hexa',
    seedA11y: 'Code de récupération',
    seedHint: 'Vos 24 mots de récupération, ou le code hexadécimal de la Sauvegarde',
    action: 'Restaurer le portefeuille',
    actionHint: 'Remplace votre portefeuille actuel',
    busy: 'Restauration…',
    cancelA11y: 'Annuler la restauration',
    entry: 'Restaurer le portefeuille…',
    entryHint: 'Importe un portefeuille depuis un code — remplace votre portefeuille actuel',
    errEmpty: 'Saisissez vos 24 mots de récupération ou votre code de 64 caractères hexadécimaux.',
    errWords:
      'Certains mots sont incorrects ou manquants. Vérifiez que les 24 mots sont correctement orthographiés, ou collez plutôt le code de récupération.',
  },

  reset: {
    label: 'Réinitialiser',
    warning:
      'Cette action efface votre portefeuille de cet appareil. L’argent à cette adresse devient irrécupérable.',
    confirm: 'Oui, tout réinitialiser',
    cancelA11y: 'Annuler la réinitialisation',
    action: 'Réinitialiser le portefeuille',
    entry: 'Réinitialiser le portefeuille…',
    entryHint: 'Efface définitivement votre portefeuille de cet appareil',
  },

  learn: {
    label: 'Découvrir',
    passportHint: 'Affiche votre passeport Prêt pour le voyage',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Rejoue la présentation du paiement dpay',
  },

  addressBook: {
    label: 'Carnet d’adresses',
    entry: 'Adresses enregistrées…',
    entryHint: 'Nommer, ajouter et supprimer les adresses auxquelles vous avez envoyé',
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
    show: 'Afficher les paramètres avancés',
    hide: 'Masquer les paramètres avancés',
    hint: 'Serveurs et points d’accès réseau utilisés par ce portefeuille',
    serverNote: 'Une adresse par ligne. La première qui répond est utilisée. Appuyez sur Appliquer pour enregistrer.',
    serverLabel: 'Serveur',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Appliquer',
    applyA11y: 'Appliquer l’URL du serveur',
    solanaNote: 'Lit les soldes et envoie les paiements via Solana. Vide, il suit votre liste de serveurs ; votre propre fournisseur retire dpay du chemin.',
    solanaLabel: 'Point d’accès Solana',
    solanaPlaceholder: 'https://<fournisseur>/?api-key=<clé>',
    solanaApplyA11y: 'Appliquer le point d’accès Solana',
    evmNote: 'Lit les soldes et règle les ZCHF sur Ethereum et Arbitrum One via le relais dpay. Vide, il suit le serveur ; ton propre point d\u2019accès sert TOUTES les chaînes — il doit prouver la bonne chaîne avant tout envoi.',
    evmLabel: 'Point d’accès EVM (toutes les chaînes)',
    evmPlaceholder: 'https://<fournisseur>',
    evmApplyA11y: 'Appliquer le point d’accès EVM',
    // F2 — le remplacement de la passerelle IC. Réservé aux opérateurs (démos/tests contre une
    // réplique locale), pas une fonction utilisateur ; la note le dit honnêtement, comme la
    // ligne Solana ci-dessus.
    icGatewayNote: 'Réservé aux opérateurs : l’URL de base où ce portefeuille envoie les transactions IC. Vide, la passerelle publique est utilisée ; définissez une réplique locale pour les démos et les tests.',
    icGatewayLabel: 'Passerelle IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'Appliquer la passerelle IC',
  },

  about: {
    label: 'À propos',
    custody:
      'dpay ne conserve pas vos fonds : votre argent est contrôlé par la seule clé de cet appareil. Il n’existe aucun compte dpay. dpay ne peut ni le déplacer, ni le bloquer, ni le récupérer — vos 24 mots de sauvegarde sont le seul moyen de récupération.',
    privacy: 'Politique de confidentialité',
  },
};

export const onboardingFr: OnboardingMessages = {
  tagline: 'Payez sans contact ou par scan — en ligne ou hors ligne.',
  custody: 'Aucun compte. Votre clé ne quitte jamais ce téléphone. Même dpay ne peut pas déplacer votre argent.',
  continue: 'Continuer',
  errOwnSeed:
    'Ce code ne semble pas correct. Collez vos 24 mots de récupération ou votre code hexadécimal exactement comme notés.',
  errWords: 'Certains mots sont incorrects ou manquants. Vérifiez que les 24 mots sont correctement orthographiés.',
  errSaveWallet: "Ce téléphone n'a pas pu enregistrer votre portefeuille, il n'a donc pas encore été créé. Touchez de nouveau Continuer pour réessayer. Si cela échoue encore, libérez de l'espace de stockage sur le téléphone.",

  recoverySaved: {
    stamp: 'Sauvegarde faite',
    line: 'Seuls ces mots peuvent ramener votre portefeuille.',
  },

  backup: {
    ...copyWordsFr,
    title: 'Sauvegardez votre portefeuille',
    warning:
      'Notez ces 24 mots et conservez-les en lieu sûr. C’est le seul moyen de récupérer votre portefeuille si vous perdez cet appareil — il n’y a aucun compte dpay, et même dpay ne peut pas les récupérer.',
    copyWordsHint: 'Copie les 24 mots sans les numéros',
    ack: 'J’ai noté les 24 mots',
  },

  restore: {
    phraseLabel: 'Phrase de récupération',
    phrasePlaceholder: 'Saisissez vos 24 mots de récupération',
    phraseNote: 'Un seul code restaure vos fonds IC et Solana.',
    seedLabel: 'Code de récupération',
    seedPlaceholder: '64 caractères hexadécimaux',
    seedHint: 'Le code hexadécimal affiché par la Sauvegarde',
    seedNote: 'Un seul code restaure vos fonds IC et Solana.',
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
  usernameHint: 'Le nom que les autres voient quand vous demandez ou recevez un paiement',

  ownSeed: {
    useOwn: 'Utiliser plutôt mon code',
    useRandom: 'Générer plutôt un code aléatoire',
    toggleHint: 'Colle le code d’un portefeuille existant au lieu d’en générer un',
    placeholder: 'Vos 24 mots ou votre code hexa',
    a11y: 'Mon code de récupération',
    hint: 'Facultatif : le code à partir duquel construire ce portefeuille',
    note: 'Laissez vide pour générer un nouveau code aléatoire.',
  },

  create: {
    action: 'Créer le portefeuille',
    busy: 'Création…',
  },

  demoNote: 'Créer le portefeuille ne dépose, n’achète et ne déplace aucun argent.',
  demoGlyphNote: ' désigne de l’argent d’exercice sans valeur — ∂1 est simplement une unité DÉMO.',
};
