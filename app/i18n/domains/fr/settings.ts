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
  escToClose: 'Appuyez sur Échap pour fermer',

  backup: {
    ...copyWordsFr,
    label: 'Sauvegarde',
    warning: 'Ce code de récupération restaure À LA FOIS vos fonds IC et Solana. Conservez-le en lieu sûr. Ne le partagez jamais.',
    copyWordsHint: 'Copie vos 24 mots de récupération dans le presse-papiers',
    copySeed: 'Copier le code',
    seedCopied: 'Code copié',
    seedShared: 'Code partagé',
    copySeedHint: 'Copie votre code de récupération dans le presse-papiers',
    showAsHex: 'Voir en hexa',
    showAsHexA11y: 'Voir le code en hexadécimal',
    showAsHexHint: 'Bascule vers le code de récupération brut de 64 caractères hexadécimaux',
    showAsWords: 'Voir en mots',
    showAsWordsA11y: 'Voir le code en mots',
    showAsWordsHint: 'Bascule vers la phrase de récupération de 24 mots',
    hide: 'Masquer',
    hideA11y: 'Masquer le code',
    reveal: 'Afficher le code',
    revealA11y: 'Afficher le code de récupération',
    revealHint: 'Affiche votre code à l’écran — toute personne qui voit votre écran peut le copier',
    cancelA11y: 'Annuler la sauvegarde',
    action: 'Sauvegarder le portefeuille',
    entry: 'Sauvegarder le portefeuille…',
    entryHint: 'Affiche votre code de récupération — sauvegarde vos fonds IC et Solana',
  },

  restore: {
    label: 'Restaurer',
    warning:
      'Cette action remplace votre portefeuille actuel par celui récupéré à partir de ce code. Sauvegardez d’abord votre portefeuille actuel si ce n’est pas fait — ses fonds ne sont accessibles qu’avec son propre code.',
    seedPlaceholder: '24 mots de récupération ou 64 caractères hexa',
    seedA11y: 'Code de récupération',
    seedHint: 'Vos 24 mots de récupération (ou le code de 64 caractères hexadécimaux de la Sauvegarde) qui restaurent votre portefeuille',
    action: 'Restaurer le portefeuille',
    actionHint: 'Remplace votre portefeuille actuel par celui récupéré à partir de ce code',
    busy: 'Restauration…',
    cancelA11y: 'Annuler la restauration',
    entry: 'Restaurer le portefeuille…',
    entryHint: 'Importe un portefeuille depuis votre code de récupération — remplace votre portefeuille actuel',
    errEmpty: 'Saisissez vos 24 mots de récupération ou votre code de 64 caractères hexadécimaux.',
    errWords:
      'Certains mots sont incorrects ou manquants. Vérifiez que vous avez bien les 24 mots correctement orthographiés — ou collez plutôt le code de récupération.',
  },

  reset: {
    label: 'Réinitialiser',
    warning:
      'Cette action efface votre identité de portefeuille de cet appareil. Les fonds à cette adresse deviennent irrécupérables. C’est irréversible.',
    confirm: 'Oui, tout réinitialiser',
    confirmHint: 'Efface définitivement votre portefeuille de cet appareil — les fonds deviennent irrécupérables',
    cancelA11y: 'Annuler la réinitialisation',
    action: 'Réinitialiser le portefeuille',
    entry: 'Réinitialiser le portefeuille…',
    entryHint: 'Ouvre une confirmation — efface définitivement votre portefeuille de cet appareil',
  },

  learn: {
    label: 'Découvrir',
    passportHint: 'Affiche votre passeport Prêt pour le voyage — les quatre tampons',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Rejoue la présentation en trois scènes du paiement dpay',
  },

  addressBook: {
    label: 'Carnet d’adresses',
    entry: 'Adresses enregistrées…',
    entryHint: 'Parcourir, nommer, ajouter et supprimer les adresses auxquelles vous avez envoyé',
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
    serverNote: 'Les serveurs auxquels votre portefeuille s’adresse, une adresse par ligne, par ordre de priorité. Si le premier est injoignable, le suivant est utilisé. Les modifications s’appliquent quand vous appuyez sur Appliquer.',
    serverLabel: 'Serveur',
    serverPlaceholder: 'http://<ip>:8787',
    serverHint: 'Le serveur avec lequel votre portefeuille communique',
    apply: 'Appliquer',
    applyA11y: 'Appliquer l’URL du serveur',
    applyHint: 'Bascule votre portefeuille vers l’URL de serveur saisie',
    solanaNote: 'Le point d’accès Solana par lequel ce portefeuille lit les soldes et envoie les paiements. Laissez-le vide pour suivre le relais de votre liste de serveurs ; indiquez votre propre fournisseur pour retirer dpay du chemin.',
    solanaLabel: 'Point d’accès Solana',
    solanaPlaceholder: 'https://<fournisseur>/?api-key=<clé>',
    solanaHint: 'Le point d’accès RPC Solana utilisé par ce portefeuille',
    solanaApplyA11y: 'Appliquer le point d’accès Solana',
    solanaApplyHint: 'Bascule ce portefeuille vers le point d’accès Solana saisi',
    // F2 — le remplacement de la passerelle IC. Réservé aux opérateurs (démos/tests contre une
    // réplique locale), pas une fonction utilisateur ; la note le dit honnêtement, comme la
    // ligne Solana ci-dessus.
    icGatewayNote: 'Réservé aux opérateurs : l’URL de base vers laquelle ce portefeuille envoie les transactions Internet Computer. Laissez-la vide pour utiliser la passerelle IC publique ; indiquez l’adresse d’une réplique locale (par ex. pour une démo ou des tests sur un réseau local) pour y diriger paiements et lectures de soldes. Inutile en usage normal.',
    icGatewayLabel: 'Passerelle IC',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayHint: 'La passerelle IC vers laquelle ce portefeuille envoie les transactions',
    icGatewayApplyA11y: 'Appliquer la passerelle IC',
    icGatewayApplyHint: 'Bascule ce portefeuille vers la passerelle IC saisie',
  },

  about: {
    label: 'À propos',
    custody:
      'dpay ne conserve pas vos fonds. Votre argent n’est contrôlé que par la clé présente sur cet appareil. Il n’existe aucun compte dpay, et dpay ne peut ni déplacer, ni bloquer, ni récupérer vos fonds. Vos 24 mots de sauvegarde sont le seul moyen de récupération.',
    privacy: 'Politique de confidentialité',
  },
};

export const onboardingFr: OnboardingMessages = {
  tagline: 'Payez sans contact ou par scan — en ligne ou hors ligne.',
  custody: 'Aucun compte. Votre clé ne quitte jamais ce téléphone. Même dpay ne peut pas déplacer votre argent.',
  continue: 'Continuer',
  errOwnSeed:
    'Ce code ne semble pas correct. Collez vos 24 mots de récupération ou votre code de 64 caractères hexadécimaux, exactement comme vous les avez notés.',
  errWords: 'Certains mots sont incorrects ou manquants. Vérifiez que vous avez bien les 24 mots correctement orthographiés.',
  errSaveWallet: "Ce téléphone n'a pas pu enregistrer votre portefeuille, il n'a donc pas encore été créé. Vos mots sont toujours à l'écran : touchez de nouveau Continuer. Si cela échoue encore, libérez de l'espace de stockage sur le téléphone.",

  recoverySaved: {
    stamp: 'Sauvegarde faite',
    line: 'Seuls ces mots peuvent ramener votre portefeuille.',
    sub: 'Vous les avez. Personne d’autre.',
  },

  backup: {
    ...copyWordsFr,
    title: 'Sauvegardez votre portefeuille',
    ritual:
      'C’est le moment où votre portefeuille devient vraiment le vôtre — seuls ces mots peuvent ramener votre argent.',
    warning:
      'Notez ces 24 mots et conservez-les en lieu sûr. C’est le SEUL moyen de récupérer votre portefeuille si vous perdez cet appareil. Il n’y a aucun compte dpay auquel se reconnecter. Perdez ces mots et ce téléphone, et votre argent est perdu. Même nous ne pouvons pas le récupérer.',
    copyWordsHint: 'Copie les 24 mots de récupération dans le presse-papiers, sans les numéros',
    ack: 'J’ai noté les 24 mots',
  },

  restore: {
    phraseLabel: 'Phrase de récupération',
    phrasePlaceholder: 'Saisissez vos 24 mots de récupération',
    phraseHint: 'Les 24 mots de récupération de votre sauvegarde',
    phraseNote: 'Saisissez les 24 mots de votre sauvegarde. Un seul code restaure vos fonds IC et Solana.',
    seedLabel: 'Code de récupération',
    seedPlaceholder: '64 caractères hexadécimaux',
    seedHint: 'Le code de 64 caractères hexadécimaux affiché par la Sauvegarde, qui restaure votre portefeuille',
    seedNote: 'Un seul code restaure vos fonds IC et Solana.',
    enterHex: 'Saisir plutôt l’hexa',
    enterWords: 'Saisir plutôt les mots',
    action: 'Restaurer le portefeuille',
    busy: 'Restauration…',
    hintMnemonic: 'Restaure votre portefeuille à partir de vos 24 mots de récupération',
    hintHex: 'Restaure votre portefeuille à partir du code de récupération',
    cancelA11y: 'Annuler la restauration',
    cancelHint: 'Revient à la création d’un nouveau portefeuille',
    entryHint: 'Restaure un portefeuille à partir de votre phrase de 24 mots',
  },

  usernameLabel: 'Choisissez un nom d’utilisateur',
  usernamePlaceholder: 'ex. Alice',
  usernameA11y: 'Nom d’utilisateur',
  usernameHint: 'Le nom que les autres voient quand vous demandez ou recevez un paiement',

  ownSeed: {
    useOwn: 'Utiliser plutôt mon code',
    useRandom: 'Générer plutôt un code aléatoire',
    toggleHint:
      'Affiche un champ pour coller les 24 mots de récupération ou le code hexadécimal d’un portefeuille existant, au lieu d’en générer un nouveau',
    placeholder: 'Vos 24 mots ou votre code hexa',
    a11y: 'Mon code de récupération',
    hint: 'Facultatif : les 24 mots de récupération ou le code hexadécimal à partir desquels construire ce portefeuille, au lieu d’un nouveau code aléatoire',
    note: 'Laissez vide pour générer un nouveau code aléatoire.',
  },

  create: {
    action: 'Créer le portefeuille',
    busy: 'Création…',
    hint: 'Crée une clé de portefeuille sur cet appareil ; aucun dépôt ni achat requis',
  },

  demoNote: 'Créer le portefeuille ne dépose, n’achète et ne déplace aucun argent.',
  demoGlyphNote: ' désigne de l’argent d’exercice sans valeur — ∂1 est simplement une unité DÉMO.',
};
