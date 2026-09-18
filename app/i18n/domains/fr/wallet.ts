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
    of: asset => `Solde ${asset}`,
    approx: asset => `~ ${asset} environ`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Appuyez à nouveau pour quitter',
  },

  homeCurrency: {
    name: {CHF: 'Francs suisses', USD: 'Dollars américains', EUR: 'Euros'},
    chooseTitle: 'Dans quelle monnaie penses-tu ?',
    chooseBody: 'Définit la monnaie affichée en premier — affichage seulement.',
    railReason: {destination: 'c’est lui que demande le paiement', funded: 'tu as un solde ici'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Principale',
    mainLabel: currency => `${currency} · Principale`,
    settingsTitle: 'Monnaie principale',
    settingsHint: 'La monnaie que dpay affiche en premier et utilise par défaut',
    confirm: 'Continuer',
    pickFirst: 'Choisis d’abord une monnaie.',
    noneAvailable: 'Aucune monnaie n’a pu être chargée. Vérifie l’adresse du serveur dans les Réglages, puis rouvre dpay.',
    a11y: currency => `Choisir ${currency}`,
  },

  railHealth: {
    thin: token => `Très peu de ${token} existe on-chain aujourd’hui — en recevoir peut être difficile, et payer suppose un destinataire qui en détient.`,
    deep: 'Circule largement on-chain aujourd’hui.',
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
      pay: 'Payer',
      payHint: 'Scanner un code ou toucher un téléphone',
      receive: 'Recevoir',
      receiveHint: 'Demander ou afficher votre adresse',
      addMoney: 'Ajouter de l’argent',
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
    intro: 'Appuyez sur un compte pour l’utiliser dans Payer et Recevoir.',
    back: 'Retour',
    practice: 'Argent d’entraînement — il ne fonctionne que dans dpay et aucun commerce ne l’accepte.',
    convertHint: 'Convertir auprès d’une plateforme externe',
  },

  addressBook: {
    title: 'Carnet d’adresses',
    intro: 'Les adresses auxquelles vous avez envoyé — enregistrées sur cet appareil uniquement.',
    back: 'Retour',
    empty: 'Aucune adresse enregistrée pour l’instant — chaque adresse à laquelle vous envoyez est enregistrée ici automatiquement.',
    addEntry: 'Ajouter une adresse',
    assetLabel: 'Pour',
    addressLabel: 'Adresse',
    addressPlaceholder: 'Coller l’adresse',
    addressHint: 'Exactement comme pour un envoi',
    nameLabel: 'Nom',
    namePlaceholder: 'p. ex. Alice (facultatif)',
    save: 'Enregistrer l’adresse',
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
    demoFundsHint: 'Ajoute ∂100 de démo',
    needsSetup: 'À configurer',
    select: symbol => `Sélectionner ${symbol}`,
    selectHint: 'Afficher sur votre écran d’accueil',
    selectSolanaHint: symbol => `Affiche ${symbol} sur l’accueil ; Payer et Recevoir utilisent Solana`,
    showTestnet: 'Afficher les actifs testnet',
    hideTestnet: 'Masquer les actifs testnet',
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
    back: 'Retour',
    next: 'Suivant',
    getStarted: 'Commencer',
    shopRequests: 'Demande',
  },

  practice: {
    sheetTitle: 'Paiement d’entraînement',
    eyebrow: 'ENTRAÎNEMENT',
    payeeName: 'Commerçant d’entraînement',
    title: 'Faites un vrai paiement',
    cardLine: 'Le code qu’un commerçant vous montrerait.',
    balance: amount => `Vous avez ${amount} en argent d’entraînement.`,
    review: 'Vérifier le paiement',
    skip: 'Passer l’entraînement',
    bothSides: 'L’entraînement a besoin d’une connexion — votre téléphone joue les deux rôles. En voyage, seul le commerçant en a besoin.',
    settledBody: 'Un vrai paiement : votre téléphone l’a signé et le registre d’entraînement l’a réglé.',
    settledBalance: amount => `Il reste ${amount} en argent d’entraînement.`,
    pendingBody: 'Signé et envoyé, pas encore réglé — rien n’est confirmé. C’est exactement à cela que ressemble un vrai paiement en attente.',
    refusedTitle: 'Le registre l’a refusé',
    refusedBody: 'Rien n’a bougé.',
    continue: 'Poursuivre la configuration',
    punchline: 'L’argent d’entraînement n’a aucune valeur.',
    noFaucet: {
      title: 'Pas d’argent d’entraînement ici',
      body: 'Ce serveur ne distribue pas d’argent d’entraînement. Rien ne manque à votre portefeuille — continuez et choisissez votre monnaie.',
    },
    cooldown: {
      title: 'L’argent d’entraînement, dans un instant',
      body: reason => `Ce serveur distribue de l’argent d’entraînement de temps en temps — il vient de le faire. Il indique : ${reason} Poursuivez la configuration ; revenez payer quand vous voudrez.`,
    },
    offline: {
      title: 'Cet entraînement a besoin d’une connexion',
      body: 'L’entraînement a besoin d’une connexion — votre téléphone joue le commerçant et le payeur ; un vrai paiement non. Reconnectez-vous et réessayez, ou poursuivez la configuration.',
    },
    empty: {
      title: 'Encore rien pour s’entraîner',
      body: 'Votre solde d’entraînement est vide. Rien ne manque à votre portefeuille — continuez et choisissez votre monnaie.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Montrez-le à votre client',
      body: 'Son téléphone scanne et approuve ; votre connexion confirme.',
    },
    offlineQr: {
      title: 'Signé — pas encore réglé',
      body: 'Pas de réseau ? Ce code signé est votre preuve de paiement. La connexion du destinataire le règle — le statut se met à jour dès votre retour en ligne.',
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
      recoverySaved: {label: 'MOTS\nNOTÉS', hint: 'Copiez vos mots de récupération dans les Paramètres', short: 'encore la sauvegarde'},
      flowUnderstood: {label: 'PARCOURS\nVU', hint: 'Faites le paiement d’entraînement au premier lancement — ou faites un paiement', short: 'encore le parcours'},
      fundsReady: {label: 'FONDS\nCHARGÉS', hint: 'Ajoutez de l’argent utilisable — les fonds d’entraînement ne comptent pas', short: 'encore des fonds'},
      paymentTested: {label: 'PREMIER\nPAIEMENT', hint: 'Faites un paiement — envoyé ou reçu', short: 'encore un paiement'},
    },
    close: title => `Fermer ${title}`,
    stripLabel: filled => `Prêt pour le voyage ${filled} sur 4`,
    count: filled => `${filled} SUR 4`,
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
