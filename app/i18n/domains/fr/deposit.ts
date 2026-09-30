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
    addressOffline: 'Vous semblez hors ligne, donc votre adresse de dépôt n’a pas pu être créée. Votre argent est intact. Réessayez une fois de nouveau en ligne.',
    addressUnreachable: 'Votre connexion est bonne, mais Internet Computer ne répond pas, donc votre adresse de dépôt n’a pas pu être créée. Votre argent est intact. Réessayez dans un instant.',
    addressCreateErr: 'Votre adresse n’a pas pu être créée. Votre argent est intact. Fermez cet écran et réessayez.',
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
    copyDepositAddress: 'Copier l’adresse de dépôt',
    statusTitle: 'Statut',
    watching: 'En attente de votre dépôt',
    checkingEvery: seconds => `vérifié toutes les ${seconds} s`,
    checkNowLabel: 'Vérifier le statut du dépôt maintenant',
    mintedAmount: amount => `${amount} émis`,
  },

  icrc: {
    whereFrom: (symbol, network) => [
      {t: 'Envoyez des '},
      {t: symbol, em: true},
      {t: ' depuis n’importe quel portefeuille qui en détient sur '},
      {t: network, em: true},
      {t: ', ou retirez-en depuis une plateforme d’échange qui le prend en charge.'},
    ],
    onlyAccepts: (symbol, network) =>
      `Cette adresse reçoit ${symbol} envoyé sur ${network} — rien d’autre ne sera crédité.`,
    noMemo: 'Aucun memo ni référence nécessaire.',
    feeLine: fee => `Frais de réseau ${fee}`,
    receivedAmount: amount => `${amount} reçus`,
    alsoTitle: 'Déjà sur Internet Computer ?',
    alsoBody: symbol => [
      {t: 'Envoyez des '},
      {t: symbol, em: true},
      {t: ' depuis n’importe quel portefeuille Internet Computer vers votre adresse IC ci-dessous. Aucun memo nécessaire.'},
    ],
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
    connectFailed: 'Connexion impossible. Ouvrez votre application de portefeuille, approuvez-y la demande, puis réessayez.',
    noWalletApp: 'Aucune application de portefeuille trouvée. Scannez plutôt le QR avec un portefeuille sur un autre appareil.',
    walletDisconnected: 'Portefeuille déconnecté.',
    amountRequired: 'Saisissez un montant supérieur à zéro.',
    missingErc20Address: 'L’adresse ERC-20 manque dans les paramètres de dépôt.',
    txReverted: 'La transaction a échoué sur la chaîne.',
    txUnconfirmed: 'Transaction envoyée mais pas encore confirmée — nous surveillons toujours l’émission.',
    approveReverted:
      'L’approbation a échoué sur la chaîne. Aucun dépôt envoyé, aucun argent quitté. Réessayez — d’abord l’approbation, puis le dépôt.',
    approveUnconfirmed:
      'L’approbation a été envoyée mais pas confirmée : aucun argent n’a quitté votre portefeuille. Patientez un instant, puis réessayez — votre portefeuille redemandera l’approbation. C’est normal et cela ne coûte que des frais de réseau.',
    depositHashUnknown:
      'Vérifiez l’activité récente de votre portefeuille avant de réessayer. Si le dépôt s’y trouve, il sera crédité dans une vingtaine de minutes — déposer à nouveau paierait deux fois.',
    approveHashUnknown:
      'Aucun dépôt n’a été fait et aucun argent n’a quitté votre portefeuille. Vérifiez l’activité récente de votre portefeuille, puis réessayez — l’approbation vient d’abord, c’est normal et cela ne coûte que des frais de réseau.',
    txNotSigned: 'Transaction non signée.',
    txFailed: 'Échec de la transaction.',
    allowanceStands:
      'Votre approbation de dépense est déjà confirmée sur la chaîne, et aucun argent n’a quitté votre portefeuille. Réessayer redemande les deux signatures : l’approbation, puis le dépôt.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Envoyez uniquement des '},
      {t: nativeAsset, em: true},
      {t: ' sur '},
      {t: networkLabel, em: true},
      {t: '. Tout le reste envoyé ainsi ne sera pas crédité et pourra être perdu.'},
    ],
    mintLine: 'Votre dépôt est émis 1:1 dans votre portefeuille dès la confirmation (~20 min).',
    details: 'Détails',
    gasNative: 'Les frais de réseau sont payés en ETH — envoyez un peu plus que le montant à déposer.',
    gasErc20: 'Il vous faut un peu d’ETH pour les frais de réseau.',
    scanToPair: 'Scannez avec votre portefeuille pour l’associer',
    orOpenHere: 'Ou ouvrez un portefeuille sur ce téléphone :',
    openNamedWallet: name => `Ouvrir ${name}`,
    otherWallet: 'Un autre portefeuille',
    otherWalletHint:
      'L’association fonctionne, mais dpay ne pourra pas la rouvrir pour vous ensuite — basculez vous-même vers le portefeuille pour approuver le dépôt.',
    couldntOpenWallet: name =>
      `Impossible d’ouvrir ${name} — l’application n’est peut-être pas installée. Choisissez un autre portefeuille, ou scannez le QR avec un portefeuille sur un autre appareil.`,
    walletList: 'MetaMask · Trust · Rabby · tout portefeuille compatible WalletConnect',
    explainNative:
      'Envoyez des ETH directement au contrat de dépôt — une transaction signée, avec votre montant de dépôt comme valeur en ETH.',
    explainErc20: nativeAsset =>
      `${nativeAsset} est un jeton Ethereum. Son dépôt demande deux transactions signées : d’abord l’approbation, puis le dépôt.`,
    connectLabel: 'Connecter un portefeuille Ethereum',
    connect: 'Connecter',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `Depuis ${shortAccount}`,
    confirmingLabel: 'Confirmation dans votre portefeuille',
    switchToWalletApp: 'Votre portefeuille devrait s’ouvrir pour approuver. Sinon, ouvrez-le vous-même, puis revenez.',
    deposit: 'Déposer',
    approveDepositLabel: 'Approuver et déposer',
    approveDeposit: 'Approuver & déposer',
    confirming: 'Confirmez dans votre portefeuille…',
    depositingAmount: (amount, asset) => `Dépôt de ${amount} ${asset} en cours`,
    watchingResumed:
      'Dépôt en attente (~20 min) — votre portefeuille n’est pas connecté, mais la surveillance de l’émission continue.',
    watchingFresh: 'En attente de confirmation — votre dépôt apparaîtra dans une vingtaine de minutes.',
    startNew: 'Nouveau dépôt',
    mintedToWallet: asset => `${asset} émis dans votre portefeuille.`,
  },

  sol: {
    createAtaLabel: asset => `Créer le compte ${asset}`,
    checkingAta: asset => `Vérification de votre compte ${asset}…`,
    ataUnverified: asset => `Impossible de vérifier votre compte ${asset}.`,
    ataUnverifiedDetail: asset =>
      `Votre adresse est correcte — dpay n’arrive simplement pas à joindre Solana pour confirmer votre compte ${asset}. Vérifiez votre connexion et réessayez.`,
    ataUnverifiedRefused: asset =>
      `Votre adresse est correcte — Solana a refusé la demande, donc votre compte ${asset} n’a pas pu être confirmé. Rien n’a bougé. Réessayez dans un instant.`,
    ataUnverifiedOffline: asset =>
      `Votre adresse est correcte — vous semblez hors ligne, donc votre compte ${asset} n’a pas pu être confirmé. Rien n’a bougé. Vérifiez à nouveau une fois de retour en ligne.`,
    ataUnverifiedUnreachable: asset =>
      `Votre adresse est correcte — le relais de dpay n’arrive pas à joindre Solana, donc votre compte ${asset} n’a pas pu être confirmé. Votre argent est intact et vos paiements Internet Computer fonctionnent toujours. Réessayez dans un instant.`,
    ataUnverifiedUnreadable: asset =>
      `Votre adresse est correcte — Solana a envoyé des données que dpay ne peut pas lire, donc votre compte ${asset} n’a pas pu être confirmé. Rien n’a bougé. Réessayez dans un instant.`,
    retryAtaLabel: asset => `Réessayer la vérification du compte ${asset}`,
    checkAgain: 'Revérifier',
    backToRequest: 'Retour à la demande',
    sendToAddress: (asset, network) => [
      {t: 'Envoyez des '},
      {t: asset, em: true},
      {t: ' à votre adresse '},
      {t: network},
      {t: ' ci-dessous.'},
    ],
    devnetWarn: asset =>
      `Connecté au devnet Solana — n’envoyez PAS de ${asset} du mainnet ici, ils n’apparaîtront pas. Uniquement des ${asset} du devnet.`,
    waitingDeposit: 'En attente de votre dépôt · vérifié toutes les quelques secondes',
    copyAssetAddress: asset => `Copier l’adresse ${asset}`,
  },

  ata: {
    absent: asset => `Pas encore de compte ${asset} sur cet appareil.`,
    cost: (setupCost, asset) =>
      `La création de vos ${asset} coûte ${setupCost}, sur votre solde SOL. Ils restent les vôtres, sous vos clés.`,
    checkingSol: 'Vérification de votre solde SOL…',
    needSol: setupCost =>
      `Il vous faut d’abord environ ${setupCost} en SOL — recevez-en à votre adresse, puis créez le compte.`,
    showSolAddress: 'Voir mon adresse SOL',
    creating: asset => `Création de votre compte ${asset} — confirmation sur Solana…`,
    createHint: (setupCost, asset) => `Crée votre compte ${asset} pour ${setupCost} sur votre solde SOL`,
    completeSetup: 'Terminer la configuration',
    completeHint: setupCost => `Tout configure en un geste (environ ${setupCost})`,
    targetsLabel: raw => {
      const symbols = Array.isArray(raw) ? raw : [String(raw)];
      return symbols.length === 1
        ? `compte ${symbols[0]}`
        : `comptes ${symbols.slice(0, -1).join(', ')} et ${symbols[symbols.length - 1]}`;
    },
    fundFrom: source => `Un petit échange de vos ${source} contre du SOL le paie.`,
    fundConfirm: (swap, source, targets, setupCost) =>
      `Échange environ ${swap} de vos ${source} contre du SOL et crée vos ${targets} (${setupCost}).`,
    fundShort: source => `Même tous vos ${source} ne suffisent pas — recevez un peu de SOL à votre adresse.`,
    confirmAction: 'Confirmer',
    cancelAction: 'Annuler',
    creatingAll: targets => `Création de vos ${targets} — confirmation sur Solana…`,
    swapFailed: 'L’échange n’a pas abouti — rien n’a été créé et le token échangé est toujours dans votre wallet. Vous pouvez réessayer.',
    swapUnknown: 'L’échange a été accepté mais n’est pas encore confirmé. Vérifiez votre solde SOL dans un instant, puis terminez la configuration à nouveau.',
  },

  trust: {
    fund: 'Alimenter via Trust Wallet',
    fundHint: asset => `Ouvrez Trust Wallet pour envoyer des ${asset} vers votre adresse dpay`,
    err: 'Impossible d’ouvrir Trust Wallet. Réessayez.',
  },

  funding: {
    title: 'Vous n\'en avez pas encore ?',
    buyThenSend: (token, chain) => [
      {t: 'Achetez des '},
      {t: token, em: true},
      {t: ' auprès d\'une plateforme ou d\'un fournisseur par carte qui verse sur '},
      {t: chain, em: true},
      {t: ', puis envoyez-les à l\'adresse ci-dessus.'},
    ],
    bridgeWithGas: (token, chain, gasToken) => [
      {t: 'Il n’existe pas d’adresse pour celui-ci : achetez des '},
      {t: token, em: true},
      {t: ' sur '},
      {t: chain, em: true},
      {t: ' dans un portefeuille qui vous appartient, gardez-y un peu d\''},
      {t: gasToken, em: true},
      {t: ' pour les frais, puis connectez ce portefeuille ici : c\'est lui qui signe le transfert.'},
    ],
    bridgeSelfGas: (token, chain) => [
      {t: 'Il n’existe pas d’adresse pour celui-ci. Achetez des '},
      {t: token, em: true},
      {t: ' sur '},
      {t: chain, em: true},
      {t: ' dans un portefeuille qui vous appartient — un peu plus que ce que vous voulez déplacer, car les frais en sont déduits. Connectez ensuite ce portefeuille ici : c\'est lui qui signe le transfert.'},
    ],
    buyThenConvert: (viaToken, target) => [
      {t: 'Aucun fournisseur ne vend de '},
      {t: target, em: true},
      {t: ' directement. Achetez des '},
      {t: viaToken, em: true},
      {t: ' par carte, envoyez-les à l\'adresse ci-dessus, puis utilisez Convertir pour les échanger contre des '},
      {t: target, em: true},
      {t: '.'},
    ],
    testnetOnly: (symbol, chain) => `${symbol} est de la monnaie de test, sans aucune valeur — personne n’en vend. Procurez-vous-en gratuitement sur un faucet public ${chain}, puis envoyez-la à l\'adresse ci-dessus.`,
    testnetOnlyWallet: (symbol, chain) => `${symbol} est de la monnaie de test, sans aucune valeur — personne n’en vend. Procurez-vous-en gratuitement sur un faucet public ${chain} dans un portefeuille qui vous appartient, puis connectez ce portefeuille ici.`,
    bankRoute: provider => `Depuis un compte bancaire suisse, ${provider} en vend par virement. Cela exige une vérification d\'identité complète et prend le temps d\'un virement bancaire.`,
    providersTitle: 'Où on en achète',
    costCard: rate => `carte ${rate}`,
    costBank: rate => `banque ${rate}`,
    costSepa: rate => `SEPA ${rate}`,
    costWalletPay: rate => `Apple & Google Pay ${rate}`,
    costMin: amount => `min. ${amount}`,
    costSpread: rate => `plus ${rate} de marge`,
    plusFixed: fixed => `+ ${fixed}`,
    nonUsdUplift: (from, to) => `achats hors USD : frais minimum majorés de ${from} à ${to}, selon la devise`,
    qEur: 'EUR',
    qNonEur: 'hors EUR',
    qUsdEurGbp: 'USD, EUR, GBP',
    qOtherCurrencies: 'autres devises, dont CHF',
    qManual: 'manual',
    qEasy: 'easy',
    qPix: 'Pix',
    upTo: pct => `jusqu\'à ${pct}`,
    from: pct => `à partir de ${pct}`,
    attribution: readOn => `Chiffres publiés par chaque fournisseur, consultés le ${readOn} — des plafonds, pas des prix. Vos frais exacts s\'affichent avant le paiement ; la plupart ajoutent en plus une marge dans le taux.`,
    noEndorsement: 'Par ordre alphabétique : dpay n\'en recommande aucun, n\'est payé par aucun et n\'intervient pas dans votre achat.',
  },
};

export const withdrawFr: WithdrawMessages = {
  ...bothSheetsFr,

  overBalance: available => `Plus que votre solde disponible de ${available}.`,
  badAddress: asset => `Cette adresse ${asset} ne semble pas valide.`,
  toDestination: destination => `vers ${destination}`,
  enterAmount: 'Saisissez un montant',
  offlineReviewNote: 'Vous êtes hors ligne — vous pouvez encore vérifier cet envoi. Il ne quitte votre portefeuille qu’une fois accepté par le réseau ; hors ligne, la confirmation échoue et rien ne bouge.',

  ic: {
    resumed:
      'Un retrait était en cours à la fermeture de l’application. Réessayer renvoie le même paiement — aucune double dépense possible.',
    approvalUnknown: 'Impossible de confirmer l’approbation — vérifiez votre solde une fois de retour en ligne',
    withdrawalUnknown: 'Impossible de confirmer le retrait — il peut encore aboutir ; vérifiez votre solde bientôt',
    noRail: 'Le retrait n’est pas configuré pour cet actif',
    gasFeeErrOffline: 'Vous semblez hors ligne, donc les frais de réseau actuels n’ont pas pu être lus. Rien n’a été envoyé. Réessayez une fois de nouveau en ligne.',
    gasFeeErrUnreachable: 'Votre connexion est bonne, mais Internet Computer ne répond pas, donc les frais de réseau actuels n’ont pas pu être lus. Votre argent est intact. Réessayez dans un instant.',
    withdrawn: 'Retiré ✓',
    sentTo: 'Envoyé à',
    copyDestinationLabel: 'Copier l’adresse de destination',
    withdrawing: amount => `Retrait de ${amount}…`,
    sendToNative: (networkLabel, nativeAsset) => `Envoyez vos ${networkLabel} vers une adresse ${nativeAsset} native`,
    availableMin: (available, min) => `Disponible : ${available} · min. ${min}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Inférieur au retrait minimum de ${min}.`,
    gasNote: 'Il vous faut des ckETH pour les frais de réseau. Ajoutez-en d’abord si vous n’en avez pas.',
    inProgress: 'Retrait en cours',
    withdrawAmount: amount => `Retirer ${amount}`,
    resumeNote:
      'Déjà signé — Réessayer renvoie le même paiement (aucune double dépense). Modifier le formulaire lance un nouveau retrait.',
    reviewTitle: 'Vérifier le retrait',
    confirmLabel: 'Confirmer le retrait',
    retry: 'Réessayer le retrait',
  },

  send: {
    destLabel: 'Envoyer à',
    destPlaceholder: 'Collez ou scannez une adresse',
    scanLabel: 'Scanner le QR code de l’adresse de destination',
    scanTitle: 'Scannez l’adresse de destination',
    scanCancel: 'La saisir à la main',

    routeIcrc: (network, fee) => `${network} · arrive en quelques secondes · frais ${fee}`,
    routeIcrcOnRail: (rail, fee) => `${rail} · arrive en quelques secondes · frais ${fee}`,
    routeIcrcUnknownFee: network => `${network} · arrive en quelques secondes · les frais du registre s’appliquent`,
    routeIcrcOnRailUnknownFee: rail => `${rail} · arrive en quelques secondes · les frais du registre s’appliquent`,
    routeSolana: network => `${network} · arrive en quelques secondes · de petits frais de réseau en SOL s’appliquent`,
    feeUnknown: 'fixés par le registre',
    routeLegacy: fee => `Compte ICP · arrive en quelques secondes · frais ${fee}`,
    routeNative: (chain, minutes, min) => `${chain} · environ ${minutes} min · minimum ${min}`,
    routeNativeNoMin: (chain, minutes) => `${chain} · environ ${minutes} min`,

    refuseWrongChain: (pastedChain, asset, assetChain) =>
      `C’est une adresse ${pastedChain}. ${asset} ne circule que sur ${assetChain} et ne peut donc pas l’atteindre — collez plutôt une adresse ${assetChain}.`,
    refuseLegacyNotIcp: asset =>
      `C’est un identifiant de compte ICP — la forme à 64 caractères. Seul l’ICP peut y être envoyé. Pour ${asset}, demandez au destinataire son principal Internet Computer (la forme avec des tirets).`,
    refuseUnrecognised: asset => `Cela ne ressemble pas à une adresse vers laquelle ${asset} peut être envoyé.`,
    refuseMistypedIc: 'Cette adresse Internet Computer est incomplète ou mal saisie — vérifiez que vous l’avez copiée en entier.',
    refuseMistypedLegacy: 'Cette adresse de compte ICP est incomplète ou mal saisie — vérifiez que vous avez bien copié les 64 caractères.',
    refuseOwnSubaccount:
      'C’est un sous-compte de votre propre portefeuille. dpay n’affiche et n’utilise que votre compte principal, donc les fonds envoyés là n’apparaîtraient plus ici. Collez l’adresse de quelqu’un d’autre pour envoyer.',
    selfWarning: 'Votre propre adresse — l’argent vous revient directement et les frais restent à votre charge.',

    maxLabel: 'Max',
    feeLine: fee => `Frais de réseau ${fee}`,
    totalLine: total => `Total ${total}`,

    savedTitle: 'Adresses enregistrées',
    saveNamePlaceholder: 'Donnez-lui un nom (facultatif)',
    forgetLabel: address => `Supprimer l’adresse enregistrée ${address}`,
    unnamed: 'Sans nom',
    manage: 'Carnet d’adresses',
    manageHint: 'Parcourir, nommer et supprimer les adresses enregistrées',

    reviewTitle: 'Vérifier',
    networkRow: 'Réseau',
    sendAmount: amount => `Envoyer ${amount}`,
    sending: amount => `Envoi de ${amount}…`,
    sent: 'Envoyé',
    sentUnknown: 'Pas encore confirmé',
    sentUnknownBody:
      'Soumis mais pas encore confirmé. Il peut encore aboutir — vérifiez votre solde dans un instant au lieu de l’envoyer à nouveau.',
    blockIndex: index => `Bloc ${index} du registre`,
    noLedger: 'Cet actif n’a aucun registre : il ne peut donc pas être envoyé.',

    copyReference: 'Copier la référence',
    viewReceipt: 'Voir le reçu',
    checkStatus: 'Vérifier le statut',
    checking: 'Vérification…',
    checkFailed: 'Impossible de vérifier pour le moment. Réessayez dans un instant.',
    failed: 'Échec',
    feeOnly: 'Échec sur la chaîne — rien n’a été livré, seuls les frais de réseau ont été prélevés.',
    nothingSent: 'Rien n’a été envoyé. Le réseau a refusé le transfert avant de l’accepter, votre argent n’a donc jamais quitté le portefeuille.',
  },

  sol: {
    createAtaLabel: asset => `Créer mon compte ${asset}`,
    backToScan: 'Retour au scan',
    sent: 'Envoyé',
    txSignature: 'signature de la transaction',
    copySignatureLabel: 'Copier la signature de la transaction',
    copySignature: 'Copier la signature',
    sending: amount => `Envoi de ${amount}…`,
    confirmingOnSolana: 'Confirmation sur Solana — jusqu’à une minute.',
    sentUnknown: 'Envoyé — pas encore confirmé',
    sentUnknownBody:
      'Le réseau l’a accepté, mais la confirmation n’est pas arrivée à temps. Il peut encore aboutir — vérifiez votre solde au lieu de renvoyer.',
    sendToSolana: asset => `Envoyez vos ${asset} vers une adresse Solana`,
    available: available => `Disponible : ${available}`,
    tokenAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: asset => `L’envoi de ${asset} demande un peu de SOL pour les frais de réseau — ajoutez-en d’abord.`,
    reviewTitle: 'Vérifier l’envoi',
    sendAmount: amount => `Envoyer ${amount}`,
    recipientAtaNote: (cost, asset) =>
      `Si le destinataire n’a pas encore de compte ${asset}, cet envoi le crée pour lui (≈${cost} une seule fois, à votre charge).`,
    confirmLabel: asset => `Confirmer l’envoi de ${asset}`,
    ataRentGate: (cost, held, asset) =>
      `Le destinataire n’a pas encore de compte ${asset} — sa création coûte environ ${cost}. Vos ${held} de SOL ne suffisent pas.`,
    ataRentTopUp: cost => `Recevez environ ${cost} de SOL à votre adresse, puis envoyez :`,
  },
};
