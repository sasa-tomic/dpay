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
    themeSwitch: target => `Passer au thème ${target}`,
    home: 'Accueil dpay',
  },

  balance: {
    label: 'Soldes',
    lockedHint: 'Terminez ou annulez d’abord le paiement en cours',
    approx: asset => `~ ${asset} environ`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Appuyez à nouveau pour quitter',
  },

  homeCurrency: {
    name: {CHF: 'Francs suisses', USD: 'Dollars américains', EUR: 'Euros', BTC: 'Bitcoin', ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana'},
    chooseTitle: 'Dans quelle monnaie penses-tu ?',
    chooseBody: 'Affichage seulement.',
    railReason: {destination: 'c’est lui que demande le paiement', funded: 'solde présent ici'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principale',
    settingsTitle: 'Monnaie principale',
    settingsHint: 'Affichée en premier ; par défaut pour payer.',
    confirm: 'Continuer',
    pickFirst: 'Choisis d’abord une monnaie.',
    noneAvailable: 'Aucune monnaie chargée. Vérifie l’adresse du serveur dans les Réglages, puis rouvre dpay.',
    a11y: currency => `Choisir ${currency}`,
  },

  railHealth: {
    thin: 'Liquidité faible',
    deep: 'Circule largement.',
  },

  railDetail: {
    back: 'Retour',
    rampNone: 'Pas de rampe fiat — de wallet à wallet uniquement.',
    rampSellPartner: partner => `${partner} — vente seule aujourd’hui.`,
    rampBothDirect: 'Dépôt et retrait sont câblés.',
  },

  tab: {pay: 'Payer', receive: 'Recevoir', transactions: 'Transactions', home: 'Accueil'},

  home: {
    actions: {
      addFunds: 'Ajouter',
      convert: 'Convertir',
      withdraw: 'Retirer',
      more: 'Plus',
    },
    balanceEyebrow: code => `Solde ${code}`,
    menu: {
      ledger: 'Transactions',
      remove: 'Retirer',
      close: 'Fermer',
    },
    removeRefusal: {
      nonzero: amount => `Convertissez ou déplacez ${amount} d’abord.`,
      unreadable: 'Solde illisible. Reconnectez-vous, puis réessayez.',
      last: 'Gardez au moins une devise.',
    },
    activity: {
      title: 'Activité',
      seeAll: 'Tout voir',
    },
    accounts: {
      openLabel: 'Ouvrir les comptes',
    },
  },

  accounts: {
    title: 'Comptes',
    intro: 'Appuyez sur une devise pour la rendre principale.',
    back: 'Retour',
    practice: 'Argent d’entraînement. Aucun commerce ne l’accepte.',
    convertHint: 'Convertir auprès d’une plateforme externe',
    setMainHint: 'Définit cette devise comme principale',
    addCurrency: 'Ajouter une devise',
  },

  addCurrency: {
    title: 'Ajouter une devise',
    search: 'Rechercher',
    stable: 'Devises stables',
    other: 'Autres',
    inWallet: 'Dans le portefeuille',
    add: 'Ajouter',
    none: 'Aucune correspondance.',
  },

  addressBook: {
    title: 'Carnet d’adresses',
    intro: 'Enregistrées sur cet appareil uniquement.',
    back: 'Retour',
    empty: 'Aucune adresse enregistrée pour l’instant. Celles auxquelles vous envoyez apparaissent ici automatiquement.',
    addEntry: 'Ajouter une adresse',
    assetLabel: 'Pour',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Coller l’adresse',
    addressHint: 'Exactement comme pour un envoi',
    nameLabel: 'Nom',
    namePlaceholder: 'p. ex. Alice',
    save: 'Enregistrer',
    rename: 'Renommer',
    renameHint: who => `Renommer ${who}`,
  },

  backToPaying: asset => `Retour au paiement en ${asset}`,

  faucet: {
    unavailableOnRelay: 'Recharge non disponible sur ce serveur',
    failed: 'Échec de la recharge',
    unavailable: 'Recharge indisponible',
    offline: 'Hors ligne — réessayez une fois connecté',
  },

  balances: {
    demoFunds: 'Fonds de démo',
    demoFundsLabel: 'Obtenir des fonds de démo',
    demoFundsHint: 'Ajoute ∂100 de démo',
    needsSetup: 'À configurer',
    select: symbol => `Sélectionner ${symbol}`,
    selectHint: 'Utilisé pour Payer et Recevoir',
    showTestnet: 'Afficher les actifs testnet',
    hideTestnet: 'Masquer les actifs testnet',
  },

  ledger: {
    empty: 'Aucun paiement pour l’instant.',
    emptyHint: 'Appuyez sur Recevoir pour demander, ou sur Payer pour scanner.',
    recent: 'Récent',
    allAssets: 'Tous les actifs',
    all: 'Tous',
    filter: label => `Filtrer ${label}`,
    to: who => `à ${who}`,
    from: who => `de ${who}`,
    fromPool: 'd’un pool',
    toPool: 'à un pool',
    fees: fee => `− ${fee} de frais`,
    mintCounterparty: 'la démo',
    failed: 'Échec — seuls les frais ont été prélevés',
    dropped: count => count === 1
      ? '1 transaction Solana n’a pas pu être lue — elle existe toujours on-chain.'
      : `${count} transactions Solana n’ont pas pu être lues — elles existent toujours on-chain.`,
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
const FR_MONTHS = ['Janv', 'Févr', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];

export const educationFr: EducationMessages = {
  campaignLine: 'Sans réseau ? Aucun souci.',
  howItWorksTitle: 'Comment dpay fonctionne',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'D’abord, le déroulement',
        title: 'Un téléphone demande, l’autre paie',
        body: 'L’autre téléphone affiche une demande. Vous la scannez, vérifiez le montant, puis approuvez. Sa connexion envoie le paiement si le vôtre est hors ligne.',
      },
      key: {
        eyebrow: 'Votre argent',
        title: 'Votre clé reste sur ce téléphone',
        body: 'dpay ne détient aucun argent et ne peut pas approuver de paiements. Il n’y a pas de compte dpay — seulement votre clé.',
      },
      exact: {
        eyebrow: 'Aucune surprise',
        title: 'Payez exactement l’actif demandé',
        body: 'Le commerçant demande un actif précis. Vous vérifiez le montant et vous approuvez. dpay ne convertit jamais.',
      },
    },
    stageTags: ['Réseau', 'Clé', 'Actif'],
    close: 'Fermer la présentation de dpay',
    skip: 'Passer l’intro',
    back: 'Retour',
    next: 'Suivant',
    getStarted: 'Commencer',
    shopRequests: 'Demande',
  },

  practice: {
    sheetTitle: 'Paiement d’entraînement',
    eyebrow: 'Entraînement',
    payeeName: 'Commerçant d’entraînement',
    title: 'Faites un vrai paiement',
    cardLine: 'Le code qu’un commerçant affiche.',
    balance: amount => `${amount} en argent d’entraînement.`,
    review: 'Vérifier le paiement',
    skip: 'Passer l’entraînement',
    bothSides: 'L’entraînement a besoin d’une connexion — votre téléphone joue les deux rôles. En voyage, seul le commerçant en a besoin.',
    settledBody: 'Signé par votre téléphone, réglé par le registre d’entraînement.',
    settledBalance: amount => `Il reste ${amount} en argent d’entraînement.`,
    pendingBody: 'Signé et envoyé, pas encore réglé — rien n’est confirmé. Voilà à quoi ressemble un paiement en attente.',
    refusedTitle: 'Refusé',
    refusedBody: 'Rien n’a bougé.',
    continue: 'Poursuivre la configuration',
    punchline: 'L’argent d’entraînement n’a aucune valeur.',
    noFaucet: {
      title: 'Pas d’argent d’entraînement ici',
      body: 'Ce serveur n’en a pas pour l’instant. Rien ne manque à votre portefeuille — continuez et choisissez votre monnaie.',
    },
    cooldown: {
      title: 'L’argent d’entraînement, dans un instant',
      body: reason => `Ce serveur distribue de l’argent d’entraînement de temps en temps — il vient de le faire. Il indique : ${reason} Continuez ; revenez quand vous voudrez.`,
    },
    offline: {
      title: 'L’entraînement a besoin d’une connexion',
      body: 'Votre téléphone joue les deux rôles. Reconnectez-vous et réessayez, ou poursuivez la configuration.',
    },
    empty: {
      title: 'Pas encore d’argent d’entraînement',
      body: 'Rien ne manque à votre portefeuille — continuez et choisissez votre monnaie.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Montrez-le à votre client',
      body: 'Son téléphone scanne et approuve ; votre connexion confirme.',
    },
    offlineQr: {
      title: 'Signé — pas encore réglé',
      body: 'Ce code signé est votre preuve de paiement. La connexion du destinataire le règle — le statut se met à jour dès votre retour en ligne.',
    },
    pendingOutcome: {
      title: 'Toujours en attente',
      body: 'Le résultat n’est pas encore connu — ne supposez jamais que c’est réussi ; revenez vérifier ici.',
    },
  },
  coachDismiss: title => `Masquer le conseil : ${title}`,
  coachDismissHint: 'Masque ce conseil ; il ne réapparaîtra plus',

  passport: {
    title: 'Prêt pour le voyage',
    stamps: {
      recoverySaved: {label: 'Mots\nnotés', hint: 'Copiez vos mots de récupération dans les Paramètres', short: 'encore la sauvegarde'},
      flowUnderstood: {label: 'Parcours\nvu', hint: 'Faites le paiement d’entraînement — ou faites un paiement', short: 'encore le parcours'},
      fundsReady: {label: 'Fonds\nchargés', hint: 'Ajoutez de l’argent utilisable — les fonds d’entraînement ne comptent pas', short: 'encore des fonds'},
      paymentTested: {label: 'Premier\npaiement', hint: 'Faites un paiement — envoyé ou reçu', short: 'encore un paiement'},
    },
    close: title => `Fermer ${title}`,
    stripLabel: filled => `Prêt pour le voyage ${filled} sur 4`,
    count: filled => `${filled} sur 4`,
    goToStep: hint => `Aller : ${hint}`,
    nextTag: 'À faire',
    nextLabel: hint => `À faire : ${hint}`,
    doneHint: 'Masque le bandeau',
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
