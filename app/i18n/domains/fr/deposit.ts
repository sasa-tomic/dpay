/**
 * i18n/domains/fr/deposit.ts — French values for the deposit + withdraw surfaces.
 *
 * Reference copy and all documentation: ../en/deposit.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {DepositMessages, WithdrawMessages} from '../../keys';

/** French twin of the English `bothSheets` — one source for the copy both sheets render. */
const bothSheetsFr = {
  pressEsc: 'Appuyez sur Échap pour fermer',
  balanceAuto: 'Votre solde se met à jour automatiquement.',
  copied: 'Copié ✓',
  shared: 'Partagé ✓',
  copyAddress: 'Copier l’adresse',
  amountLabel: (asset: string) => `Montant (${asset})`,
};

export const depositFr: DepositMessages = {
  ...bothSheetsFr,

  deposited: 'Déposé ✓',
  addressCopied: 'Adresse copiée',
  addressShared: 'Adresse partagée',
  checkNow: 'Vérifier',

  ck: {
    addressErr: 'Impossible de charger votre adresse de dépôt. Vérifiez votre connexion et réessayez.',
    noMinter: 'Cet actif n’est pas encore disponible en dépôt.',
    fetchingAddress: 'Récupération de votre adresse de dépôt…',
    noAddress: 'Aucune adresse de dépôt disponible.',
    sendToAddress: (nativeAsset, networkLabel) => [
      {t: 'Envoyez des '},
      {t: nativeAsset, em: true},
      {t: ' à votre adresse '},
      {t: networkLabel, em: true},
      {t: ' ci-dessous.'},
    ],
    confirmationLine: (required, estMin) =>
      `${required > 0 ? `~${required} confirmation${required < 2 ? '' : 's'}` : 'confirmations'}${estMin > 0 ? ` · en général ~${estMin} min` : ''}`,
    feeMinLine: (fee, min) => `Frais de réseau ${fee} · Dépôt min. ${min}`,
    feeNone: 'gratuit',
    minNone: 'aucun',
    custody: 'dpay ne détient jamais vos clés — les fonds sont émis 1:1 dans votre portefeuille dès la confirmation.',
    copyDepositAddress: 'Copier l’adresse de dépôt',
    statusTitle: 'Statut',
    watching: 'En attente de votre dépôt',
    checkingEvery: seconds => `vérifié toutes les ${seconds} s`,
    checkNowLabel: 'Vérifier le statut du dépôt maintenant',
    mintedAmount: amount => `${amount} émis`,
  },

  erc20: {
    onrampParamsErr: 'Impossible de contacter le serveur pour les paramètres de dépôt.',
    deriveErr: 'Impossible de calculer votre adresse de dépôt — rouvrez cette fenêtre.',
    noWalletWeb: 'Aucun portefeuille Ethereum trouvé. Installez MetaMask ou Rabby dans ce navigateur.',
    noWalletNative: 'Aucun portefeuille connecté. Associez un portefeuille via WalletConnect.',
    pairRejected: 'Association refusée.',
    pairFailed: 'Impossible d’associer votre portefeuille.',
    wrongNetwork: (networkLabel, expected, actual) =>
      `Mauvais réseau : connectez-vous à ${networkLabel} (chaîne ${expected}). Votre portefeuille est sur la chaîne ${actual}.`,
    connectFailed: 'Impossible de se connecter à votre portefeuille.',
    noWalletApp: 'Aucune application de portefeuille trouvée. Scannez plutôt le QR avec un portefeuille sur un autre appareil.',
    walletDisconnected: 'Portefeuille déconnecté.',
    amountRequired: 'Saisissez un montant supérieur à zéro.',
    missingErc20Address: 'L’adresse ERC-20 manque dans les paramètres de dépôt.',
    txReverted: 'La transaction a échoué sur la chaîne.',
    txUnconfirmed: 'Transaction envoyée mais pas encore confirmée — nous surveillons toujours l’émission.',
    txNotSigned: 'Transaction non signée.',
    txFailed: 'Échec de la transaction.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Envoyez uniquement des '},
      {t: nativeAsset, em: true},
      {t: ' sur '},
      {t: networkLabel, em: true},
      {t: '. Tout autre actif ou réseau envoyé ainsi ne sera pas crédité et pourra être perdu.'},
    ],
    custody:
      'dpay ne détient jamais vos clés — votre portefeuille signe, et l’actif est émis 1:1 dans votre portefeuille dès la confirmation (~20 min).',
    gasNative: 'Les frais de réseau sont payés en ETH — envoyez un peu plus que le montant à déposer.',
    gasErc20: 'Il vous faudra un peu d’ETH pour les frais de réseau Ethereum.',
    scanToPair: 'Scannez avec votre portefeuille pour l’associer',
    openWalletHint: 'Ouvre une application de portefeuille installée sur cet appareil',
    openWallet: 'Ouvrir le portefeuille sur cet appareil',
    walletListPair: 'MetaMask · Trust · Rabby · tout portefeuille WalletConnect',
    walletList: 'MetaMask · Trust · Rabby · tout portefeuille compatible WalletConnect',
    explainNative:
      'Envoyez des ETH directement au contrat de dépôt — une seule transaction signée par votre portefeuille, avec votre montant comme valeur en ETH.',
    explainErc20: nativeAsset =>
      `${nativeAsset} est un jeton Ethereum — son dépôt demande deux transactions signées par votre portefeuille, et non un simple envoi vers une adresse comme pour Bitcoin.`,
    connectLabel: 'Connecter un portefeuille Ethereum',
    connect: 'Connecter',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `Depuis ${shortAccount}`,
    confirmingLabel: 'Confirmation dans votre portefeuille',
    deposit: 'Déposer',
    approveDepositLabel: 'Approuver et déposer',
    approveDeposit: 'Approuver & déposer',
    confirming: 'Confirmez dans votre portefeuille…',
    depositingAmount: (amount, asset) => `Dépôt de ${amount} ${asset} en cours`,
    watchingResumed:
      'Dépôt en attente (~20 min) — votre portefeuille n’est pas connecté, mais nous surveillons toujours l’émission.',
    watchingFresh: 'En attente de confirmation — votre dépôt apparaîtra dans une vingtaine de minutes.',
    startNew: 'Nouveau dépôt',
    mintedToWallet: asset => `${asset} émis dans votre portefeuille.`,
  },

  sol: {
    createAtaLabel: 'Créer le compte USDC',
    checkingAta: 'Vérification de votre compte USDC…',
    ataUnverified: 'Impossible de vérifier votre compte USDC.',
    ataUnverifiedDetail:
      'Votre adresse est correcte — nous n’arrivons simplement pas à joindre Solana pour confirmer votre compte USDC sur la chaîne. Vérifiez votre connexion et réessayez.',
    retryAtaLabel: 'Réessayer la vérification du compte USDC',
    retryAtaHint: 'Vérifie à nouveau si votre compte USDC existe sur la chaîne',
    checkAgain: 'Revérifier',
    backToRequest: 'Retour à la demande',
    sendToAddress: (asset, network) => [
      {t: 'Envoyez des '},
      {t: asset, em: true},
      {t: ' à votre adresse '},
      {t: network},
      {t: ' ci-dessous.'},
    ],
    custody: asset => `dpay ne détient jamais vos clés — les ${asset} arrivent directement dans votre portefeuille dès la confirmation.`,
    devnetWarn: asset =>
      `Connecté au devnet Solana. N’envoyez PAS de ${asset} du mainnet ici — ils n’apparaîtront pas. Utilisez uniquement des ${asset} du devnet.`,
    waitingDeposit: 'En attente de votre dépôt · vérifié toutes les quelques secondes',
    checkNowHint: 'Revérifie votre solde immédiatement',
    balanceAutoOnConfirm: 'Votre solde se met à jour automatiquement dès que l’envoi est confirmé.',
    copyAssetAddress: asset => `Copier l’adresse ${asset}`,
    returnHint: 'Revient à l’onglet Payer avec cet actif sélectionné',
  },

  ata: {
    absent: 'Vous n’avez pas encore de compte USDC sur cet appareil.',
    cost: setupCost =>
      `Solana conserve vos USDC dans un compte de jeton créé une seule fois et rattaché à ce portefeuille. Sa création coûte ${setupCost} (loyer du compte + frais) sur votre solde SOL — il reste votre compte, sous vos clés. dpay ne les détient jamais.`,
    checkingSol: 'Vérification de votre solde SOL…',
    needSol: setupCost =>
      `Il vous faut d’abord environ ${setupCost} dans ce portefeuille — recevez des SOL à votre adresse, puis créez le compte.`,
    showSolAddress: 'Voir mon adresse SOL',
    creating: 'Création de votre compte USDC — confirmation sur Solana…',
    createHint: setupCost => `Crée votre compte USDC unique pour ${setupCost} sur votre solde SOL`,
  },

  trust: {
    fund: 'Alimenter via Trust Wallet',
    fundHint: asset => `Ouvre Trust Wallet pour envoyer des ${asset} vers votre adresse dpay`,
    err: 'Impossible d’ouvrir Trust Wallet. Réessayez.',
  },
};

export const withdrawFr: WithdrawMessages = {
  ...bothSheetsFr,

  overBalance: available => `Plus que votre solde disponible de ${available}.`,
  badAddress: asset => `Cette adresse ${asset} ne semble pas valide.`,
  toDestination: destination => `vers ${destination}`,
  enterAmount: 'Saisissez un montant',

  ic: {
    resumed:
      'Un retrait était en cours à la fermeture de l’application. Réessayer renvoie les mêmes enveloppes — aucune double dépense possible.',
    approvalUnknown: 'Impossible de confirmer l’approbation — vérifiez votre solde une fois de retour en ligne',
    withdrawalUnknown: 'Impossible de confirmer le retrait — il peut encore aboutir ; vérifiez votre solde bientôt',
    noRail: 'Le retrait n’est pas configuré pour cet actif',
    gasFeeErr: 'Impossible de récupérer les frais de réseau actuels — vérifiez votre connexion',
    withdrawn: 'Retiré ✓',
    sentTo: 'envoyé à',
    copyDestinationLabel: 'Copier l’adresse de destination',
    withdrawing: amount => `Retrait de ${amount}…`,
    sendToNative: (networkLabel, nativeAsset) => `Envoyez vos ${networkLabel} vers une adresse ${nativeAsset} native`,
    availableMin: (available, min) => `Disponible : ${available} · min. ${min}`,
    addressLabel: asset => `Adresse ${asset}`,
    useLastLabel: 'Utiliser la dernière adresse enregistrée',
    useLast: address => `Réutiliser : ${address}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Inférieur au retrait minimum de ${min}.`,
    gasNote: 'Il vous faut des ckETH pour les frais de réseau. Ajoutez-en d’abord si vous n’en avez pas.',
    inProgress: 'Retrait en cours',
    withdrawAmount: amount => `Retirer ${amount}`,
    resumeNote:
      'Déjà signé — Réessayer renvoie les mêmes enveloppes (aucune double dépense possible). Modifier le formulaire lance un nouveau retrait.',
    reviewTitle: 'Vérifier le retrait',
    confirmLabel: 'Confirmer le retrait',
    retry: 'Réessayer le retrait',
  },

  sol: {
    createAtaLabel: 'Créer mon compte USDC',
    backToScan: 'Retour au scan',
    sent: 'Envoyé ✓',
    txSignature: 'signature de la transaction',
    copySignatureLabel: 'Copier la signature de la transaction',
    copySignature: 'Copier la signature',
    sending: amount => `Envoi de ${amount}…`,
    confirmingOnSolana: 'Confirmation sur Solana — cela peut prendre jusqu’à une minute.',
    sendToSolana: asset => `Envoyez vos ${asset} vers une adresse Solana`,
    available: available => `Disponible : ${available}`,
    addressLabel: 'Adresse Solana',
    addressPlaceholder: 'Adresse base58 du destinataire',
    usdcAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: 'L’envoi d’USDC demande un peu de SOL dans le portefeuille pour les frais de réseau — ajoutez-en d’abord.',
    reviewTitle: 'Vérifier l’envoi',
    sendAmount: amount => `Envoyer ${amount}`,
    recipientAtaNote: cost =>
      `Si le destinataire n’a pas encore de compte USDC, cet envoi le crée pour lui (≈${cost} une seule fois, à votre charge).`,
    confirmLabel: asset => `Confirmer l’envoi de ${asset}`,
  },
};
