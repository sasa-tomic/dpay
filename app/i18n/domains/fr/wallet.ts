/**
 * i18n/domains/fr/wallet.ts — French values for the `wallet` + `education` domains.
 *
 * Reference copy and all documentation: ../en/wallet.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {EducationMessages, WalletMessages} from '../../keys';

export const walletFr: WalletMessages = {
  header: {
    settings: 'Paramètres',
    settingsHint: 'Ouvre le serveur, la réinitialisation et les paramètres avancés',
    themeSwitch: target => `Passer au thème ${target}`,
    themeSwitchHint: 'Bascule le thème entre Clair et Sombre ; choisissez Auto dans les Paramètres',
    home: 'Accueil dpay',
    homeHint: 'Ouvre le site principal de dpay',
  },

  balance: {
    label: 'Soldes — changer de monnaie ou recevoir',
    hint: 'Ouvre l’onglet Accueil avec tous les actifs, change la monnaie affichée ou permet de recevoir',
    lockedHint: 'Terminez ou annulez d’abord le paiement en cours',
    of: asset => `Solde ${asset}`,
    approx: asset => `~ ${asset} environ`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Appuyez à nouveau pour quitter',
  },

  homeCurrency: {
    name: {CHF: 'Francs suisses', USD: 'Dollars américains', EUR: 'Euros'},
    chooseTitle: 'Dans quelle monnaie penses-tu ?',
    chooseBody: 'Choisis la monnaie affichée en premier. Cela ne change que l’affichage et les valeurs par défaut.',
    railReason: {destination: 'c’est lui que demande le paiement', funded: 'tu as un solde ici'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principale',
    mainLabel: currency => `${currency} · Principale`,
    settingsTitle: 'Monnaie principale',
    settingsHint: 'La monnaie que dpay affiche en premier et utilise par défaut',
    confirm: 'Continuer',
    pickFirst: 'Touchez d’abord la monnaie voulue, puis Continuer.',
    noneAvailable: 'Aucune monnaie n’a pu être chargée. Vérifie l’adresse du serveur dans les Réglages, puis rouvre dpay.',
    a11y: currency => `Choisir ${currency}`,
  },

  railHealth: {
    thin: token => `Très peu de ${token} existe on-chain aujourd’hui — en recevoir peut être difficile, et payer suppose un destinataire qui en détient.`,
    deep: 'Circule largement on-chain aujourd’hui.',
  },

  railDetail: {
    back: 'Retour',
    rampNone: 'Pas de rampe fiat aujourd’hui — les transferts se font de wallet à wallet.',
    rampSellPartner: partner => `${partner} liste ce jeton comme vendable ; l’achat n’est pas disponible aujourd’hui.`,
    rampBothDirect: 'Le dépôt et le retrait vers sa chaîne native sont câblés dans dpay.',
  },

  tab: {pay: 'Payer', receive: 'Recevoir', transactions: 'Transactions', home: 'Accueil'},

  home: {
    actions: {
      pay: 'Payer',
      payHint: 'Scanner un code ou payer en touchant le téléphone',
      receive: 'Recevoir',
      receiveHint: 'Demander un paiement ou afficher votre adresse',
      addMoney: 'Ajouter de l’argent',
      addMoneyHint: 'Ajouter des fonds à ce portefeuille',
    },
    activity: {
      title: 'Activité',
      seeAll: 'Tout voir',
      seeAllHint: 'Ouvrir la liste complète des transactions',
      empty: 'Aucun paiement pour l’instant.',
    },
    accounts: {
      openLabel: 'Ouvrir les comptes',
      openHint: 'Voir tous les comptes que ce portefeuille peut détenir',
    },
  },

  accounts: {
    title: 'Comptes',
    intro: 'Appuyez sur un compte pour l’utiliser dans les onglets Payer et Recevoir. Votre écran d’accueil continue d’afficher votre monnaie principale.',
    back: 'Retour',
    backHint: 'Revenir là où vous étiez',
    practice: 'Argent d’entraînement — il ne fonctionne que dans dpay et aucun commerce ne l’accepte.',
    convertHint: 'Convertir le solde de ce compte auprès d’une plateforme externe que vous signez vous-même',
  },

  addressBook: {
    title: 'Carnet d’adresses',
    intro: 'Toutes les adresses auxquelles vous avez envoyé, les plus récemment utilisées en premier — enregistrées sur cet appareil uniquement.',
    back: 'Retour',
    backHint: 'Revenir là où vous étiez',
    empty: 'Aucune adresse enregistrée pour l’instant. Chaque adresse à laquelle vous envoyez est enregistrée ici automatiquement — ou ajoutez-en une maintenant.',
    addEntry: 'Ajouter une adresse',
    addEntryHint: 'Enregistrer une adresse à laquelle vous envoyez souvent',
    assetLabel: 'Pour',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Collez l’adresse de destination',
    addressHint: 'L’adresse exactement comme vous lui enverriez',
    nameLabel: 'Nom',
    namePlaceholder: 'p. ex. Alice (facultatif)',
    nameHint: 'Comment vous appelez cette adresse — facultatif',
    save: 'Enregistrer l’adresse',
    saveHint: 'Ajoute cette adresse au carnet d’adresses',
    rename: 'Renommer',
    renameHint: who => `Renommer ${who}`,
  },

  backToPaying: asset => `Retour au paiement en ${asset}`,

  faucet: {
    unavailableOnRelay: 'La recharge de démo n’est pas disponible sur ce serveur',
    failed: 'Échec de la recharge',
    unavailable: 'Recharge indisponible',
    offline: 'Hors ligne — réessayez une fois connecté',
  },

  balances: {
    demoFunds: 'Fonds de démo',
    demoFundsLabel: 'Obtenir des fonds de démo',
    demoFundsHint: 'Ajoute ∂100 d’argent de démo à ce portefeuille',
    needsSetup: 'À configurer',
    select: symbol => `Sélectionner ${symbol}`,
    selectHint: 'Affiche le solde de cet actif sur votre écran d’accueil',
    selectSolanaHint: symbol => `Affiche ${symbol} sur votre écran d’accueil et utilise Solana pour Payer/Recevoir`,
    showTestnet: 'Afficher les actifs testnet',
    hideTestnet: 'Masquer les actifs testnet',
    showTestnetHint: 'Affiche les monnaies testnet dans cette liste',
    hideTestnetHint: 'Masque les monnaies testnet de cette liste',
  },

  ledger: {
    empty: 'Aucun paiement pour l’instant.',
    emptyHint: 'Appuyez sur Recevoir pour créer une demande de paiement, ou sur Payer pour en scanner une.',
    recent: 'Récent',
    allAssets: 'Tous les actifs',
    all: 'Tous',
    filter: label => `Filtrer ${label}`,
    to: who => `à ${who}`,
    from: who => `de ${who}`,
    fees: fee => `− ${fee} de frais`,
    mintCounterparty: 'la démo',
    failed: 'Échec — seuls les frais de réseau ont été prélevés',
    dropped: count => count === 1
      ? '1 transaction Solana n’a pas pu être lue — elle existe toujours on-chain, mais n’est pas affichée ici.'
      : `${count} transactions Solana n’ont pas pu être lues — elles existent toujours on-chain, mais ne sont pas affichées ici.`,
  },

  fund: {checking: 'Vérification…', checkAgain: 'Revérifier'},

  asset: {
    demoSubtitle: 'argent fictif pour les tests',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    bridgedLabel: (symbol, from, to) => `${symbol} · ${from} → ${to}`,
    unsupported: 'Non pris en charge',
    testnetName: base => `${base} testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Partagé ✓'},
};

/** Month abbreviations for the passport stamp date — French caps, as inked on a document page. */
const FR_MONTHS = ['JANV', 'FÉVR', 'MARS', 'AVR', 'MAI', 'JUIN', 'JUIL', 'AOÛT', 'SEPT', 'OCT', 'NOV', 'DÉC'];

export const educationFr: EducationMessages = {
  campaignLine: 'Sans réseau ? Aucun souci.',
  howItWorksTitle: 'Comment dpay fonctionne',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'D’ABORD, LE DÉROULEMENT',
        title: 'Un téléphone demande, l’autre paie',
        body: 'Le téléphone qui reçoit affiche une demande. Vous la scannez, vérifiez le montant et l’actif, puis approuvez. Sa connexion envoie le paiement si votre téléphone est hors ligne.',
      },
      key: {
        eyebrow: 'VOTRE ARGENT',
        title: 'Votre clé reste sur ce téléphone',
        body: 'dpay ne détient aucun fonds et ne peut pas approuver un paiement à votre place. Il n’y a pas de compte dpay — seulement votre clé.',
      },
      exact: {
        eyebrow: 'AUCUNE SURPRISE',
        title: 'Payez exactement l’actif demandé',
        body: 'Le commerçant demande un actif précis. Vous vérifiez le montant et vous approuvez. dpay ne convertit jamais un autre solde.',
      },
    },
    stageTags: ['01 — RÉSEAU', '02 — CLÉ', '03 — ACTIF'],
    close: 'Fermer la présentation de dpay',
    skip: 'Passer l’intro',
    skipHint: 'Passe directement à la création de votre portefeuille',
    back: 'Retour',
    backLabel: 'Scène précédente',
    next: 'Suivant',
    nextLabel: 'Scène suivante',
    nextHint: 'Affiche la scène suivante',
    getStarted: 'Commencer',
    getStartedHint: 'Continue vers la création de votre portefeuille',
    shopRequests: 'Demande',
  },

  practice: {
    sheetTitle: 'Paiement d’entraînement',
    eyebrow: 'ENTRAÎNEMENT',
    payeeName: 'Commerçant d’entraînement',
    title: 'Faites un vrai paiement',
    cardLine: 'Voici le code qu’un commerçant vous montrerait.',
    balance: amount => `Vous avez ${amount} en argent d’entraînement.`,
    review: 'Vérifier le paiement',
    reviewHint: 'Voir le montant et le destinataire avant d’approuver',
    skip: 'Passer l’entraînement',
    skipHint: 'Passe le paiement d’entraînement et va au choix de votre monnaie principale',
    bothSides: 'Votre téléphone joue ici les deux rôles, cet entraînement a donc besoin d’une connexion. En voyage, seul le commerçant en a besoin.',
    settledBody: 'C’était un vrai paiement sur le registre d’entraînement — votre téléphone l’a signé et le registre l’a réglé.',
    settledBalance: amount => `Il reste ${amount} en argent d’entraînement.`,
    pendingBody: 'Le paiement a été signé et envoyé. dpay ne l’a pas encore vu se régler, rien n’est donc confirmé. C’est exactement à cela que ressemble un vrai paiement en attente.',
    refusedTitle: 'Le registre l’a refusé',
    refusedBody: 'Rien n’a bougé.',
    continue: 'Poursuivre la configuration',
    continueHint: 'Continue vers le choix de votre monnaie principale',
    punchline: 'L’argent d’entraînement n’a aucune valeur — il sert uniquement à essayer l’application.',
    noFaucet: {
      title: 'Pas d’argent d’entraînement ici',
      body: 'Ce serveur ne distribue pas d’argent d’entraînement, il n’y a donc rien pour s’entraîner. Rien ne manque à votre portefeuille — continuez et choisissez votre monnaie. Vous ferez votre premier vrai paiement quand vous voudrez.',
    },
    cooldown: {
      title: 'L’argent d’entraînement, dans un instant',
      body: reason => `Ce serveur distribue de l’argent d’entraînement de temps en temps, et il vient de le faire. Il indique : ${reason} Poursuivez la configuration — vous pourrez revenir payer quand vous voudrez.`,
    },
    offline: {
      title: 'Cet entraînement a besoin d’une connexion',
      body: 'Votre téléphone joue ici le commerçant et le payeur, il doit donc atteindre le registre lui-même. Un vrai paiement n’en a pas besoin : c’est le commerçant qui a besoin d’une connexion. Reconnectez-vous et réessayez, ou poursuivez la configuration.',
    },
    empty: {
      title: 'Encore rien pour s’entraîner',
      body: 'Votre solde d’entraînement est vide, il n’y a donc rien à payer. Votre portefeuille n’a aucun problème — continuez et choisissez votre monnaie.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Montrez votre code de demande',
      body: 'Montrez ce code à votre client. Son téléphone le scanne et approuve ; votre connexion confirme.',
    },
    offlineQr: {
      title: 'Signé — pas encore réglé',
      body: 'Pas de réseau ? Ce code signé est votre preuve de paiement. La connexion du destinataire le règle — le statut se met à jour dès votre retour en ligne.',
    },
    pendingOutcome: {
      title: 'Toujours en attente',
      body: 'En attente signifie que le résultat n’est pas encore connu. Ne supposez jamais que c’est réussi — revenez vérifier ici.',
    },
  },
  coachDismiss: title => `Masquer le conseil : ${title}`,
  coachDismissHint: 'Masque ce conseil ; il ne réapparaîtra plus',

  passport: {
    title: 'Prêt pour le voyage',
    stamps: {
      recoverySaved: {label: 'MOTS\nNOTÉS', hint: 'Copiez vos mots de récupération dans les Paramètres', short: 'encore la sauvegarde'},
      flowUnderstood: {label: 'PARCOURS\nVU', hint: 'Faites le paiement d’entraînement au premier lancement — ou faites un paiement', short: 'encore le parcours'},
      fundsReady: {label: 'FONDS\nCHARGÉS', hint: 'Ajoutez de l’argent utilisable — les fonds d’entraînement ne comptent pas', short: 'encore des fonds'},
      paymentTested: {label: 'PREMIER\nPAIEMENT', hint: 'Faites un paiement — envoyé ou reçu', short: 'encore un paiement'},
    },
    close: title => `Fermer ${title}`,
    stripLabel: filled => `Prêt pour le voyage ${filled} sur 4`,
    count: filled => `${filled} SUR 4`,
    goToStep: hint => `Aller : ${hint}`,
    goToStepHint: 'Ouvre l’écran où se déroule cette étape',
    nextTag: 'À faire',
    nextLabel: hint => `À faire : ${hint}`,
    nextHint: 'Va à l’écran où se déroule cette étape',
    doneHint: 'Masque le bandeau Prêt pour le voyage',
    ready: 'Prêt à voyager',
    readyLine: 'Vous pouvez payer même sans réseau sur votre téléphone.',
    capstone: 'Prêt à\nvoyager',
    capstoneMicro: 'Plus rien à configurer. Bon voyage.',
    stampDate: (monthIndex, day) => `${FR_MONTHS[monthIndex]} ${day}`,
  },

  peak: {
    micro: 'Sans réseau du début à la fin.',
    settled: 'payé sans réseau',
  },
};
