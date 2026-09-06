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
    account: 'COMPTE',
    accountLabel: 'Compte',
    home: 'Accueil dpay',
    homeHint: 'Ouvre le site principal de dpay',
  },

  balance: {
    label: 'Soldes — changer de monnaie ou recevoir',
    hint: 'Ouvre la liste complète des actifs, change la monnaie affichée ou permet de recevoir',
    lockedHint: 'Terminez ou annulez d’abord le paiement en cours',
    of: asset => `Solde ${asset}`,
    approx: asset => `~ ${asset} environ`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Appuyez à nouveau pour quitter',
  },

  homeCurrency: {
    name: {CHF: 'Francs suisses', USD: 'Dollars américains', EUR: 'Euros'},
    chooseTitle: 'Dans quelle monnaie penses-tu ?',
    chooseBody: 'dpay affiche cette monnaie en premier et paie avec par défaut. Tu peux aussi détenir les autres, et changer ce choix à tout moment dans les Réglages.',
    railReason: {destination: 'c’est lui que demande le paiement', funded: 'tu as un solde ici', preference: 'la voie par défaut de dpay'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principale',
    mainLabel: currency => `${currency} · Principale`,
    settingsTitle: 'Monnaie principale',
    settingsHint: 'La monnaie que dpay affiche en premier et utilise par défaut',
    confirm: 'Continuer',
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
    headlineA11y: (amount, asset) => `Solde ${asset} : ${amount}`,
    actions: {
      pay: 'Payer',
      payHint: 'Scanner un code ou envoyer à une adresse',
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
  },

  backToPaying: asset => `Retour au paiement en ${asset}`,

  faucet: {
    unavailableOnRelay: 'La recharge de démo n’est pas disponible sur ce serveur',
    failed: 'Échec de la recharge',
    unavailable: 'Recharge indisponible',
    offline: 'Hors ligne — réessayez une fois connecté',
  },

  balances: {
    title: 'Soldes',
    close: 'Fermer les soldes',
    intro: 'Appuyez sur une monnaie pour l’afficher sur votre écran d’accueil. Recevez-la ou envoyez-la depuis les onglets Recevoir et Payer.',
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
    escToClose: 'Appuyez sur Échap pour fermer',
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
        eyebrow: 'PAYER AVEC DPAY',
        title: 'Payez sans réseau',
        body: 'Votre téléphone peut payer sans le moindre réseau. Le commerçant envoie le paiement à votre place, avec sa propre connexion internet.',
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

  rehearsal: {
    title: 'Un paiement en toute clarté',
    sheetTitle: 'Répétition',
    steps: {
      request: {
        title: 'Le commerçant demande',
        body: 'Le commerçant choisit un actif et un montant précis — son terminal en fait un code de demande.',
      },
      approve: {
        title: 'Vous vérifiez et approuvez',
        body: 'Votre téléphone affiche exactement ce que vous payez. Rien ne bouge tant que vous n’avez pas approuvé avec votre clé.',
      },
      settle: {
        title: 'Le commerçant règle',
        body: 'La connexion du commerçant envoie le paiement — confirmé en quelques secondes sur son écran.',
      },
    },
    stageTags: ['01 — DEMANDE', '02 — APPROUVER', '03 — RÉGLER'],
    punchline: 'C’est tout. Votre téléphone peut rester hors ligne pour approuver et transmettre.',
    skip: 'Voir le portefeuille',
    skipHint: 'Passe la répétition et ouvre votre portefeuille',
    try: 'Essayer avec la démo',
  },

  coachTips: {
    payReview: {
      title: 'Vous approuvez le paiement exact',
      body: 'Approuver envoie exactement ce montant de cet actif — depuis votre solde, signé par votre clé.',
    },
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
      flowUnderstood: {label: 'PARCOURS\nVU', hint: 'Regardez la répétition à la création du portefeuille — ou faites un paiement', short: 'encore le parcours'},
      fundsReady: {label: 'FONDS\nCHARGÉS', hint: 'Ajoutez des fonds — les fonds de démo comptent', short: 'encore des fonds'},
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
