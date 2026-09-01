/**
 * i18n/domains/fr/pay.ts — French values for the Pay + Receive screens.
 *
 * Reference copy and all documentation: ../en/pay.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payFr: PayMessages = {
  notAPaymentCode: 'Ce n’est pas un code de paiement dpay',
  requestExpired: 'Cette demande a expiré — demandez un nouveau QR au commerçant',
  solRequestExpired: 'Cette demande de paiement a expiré. Demandez un nouveau QR au commerçant.',

  sent: amount => (amount ? `Envoyé ${amount}` : 'Envoyé'),
  alreadyPaid: 'Déjà payé',
  toWho: who => `à ${who}`,
  toWhoAwaiting: who => `à ${who} · en attente de la confirmation du commerçant`,
  alreadyNotCharged: (amount, who) => `${amount} à ${who} · non débité une seconde fois`,
  solAwaiting: who =>
    who ? `à ${who} · en attente de la confirmation du commerçant` : 'en attente de la confirmation du commerçant',
  balanceUpdatesOnSettle: 'Votre solde se met à jour quand le commerçant règle ce paiement sur la chaîne.',
  newPayment: 'Nouveau paiement',

  shareReceipt: 'Partager le reçu',
  shareReceiptHint: 'Partage la preuve de paiement sous forme de lien que le commerçant peut ouvrir pour confirmer',
  shareAuthCode: 'Partager l’autorisation',
  shareSignedPayment: 'Partager le paiement signé',
  shareSignedCode: 'Partager le code signé',
  linkCopied: 'Lien copié ✓',
  copied: 'Copié ✓',

  showThisTo: who => `Montrez ceci à ${who}`,
  showThisToMerchant: 'Montrez ceci au commerçant',
  amountToWho: (amount, who) => `${amount} à ${who}`,
  signedOnThisDevice: 'signé sur cet appareil ✓',
  signedOffline: 'signé hors ligne ✓',
  waitingToScan: who => `En attente du scan par ${who}…`,
  offlineSettles: who =>
    `Hors ligne — ${who} règle ce paiement en l’envoyant. Vous le verrez sur votre solde dès votre retour en ligne.`,
  solOfflineSettles:
    'Hors ligne — le commerçant règle ce paiement en l’envoyant. Vous le verrez sur votre solde une fois confirmé.',
  handedTo: who => `Remis à ${who}`,
  handedToMerchant: 'Remis au commerçant',
  handedOffHint: 'Marque le paiement signé comme remis ; votre solde se met à jour quand le commerçant règle',

  unsupportedAsset: 'Actif non pris en charge',
  unsupportedAssetBody: currency =>
    `Ce paiement demande un actif que ce portefeuille ne peut pas payer (monnaie ${currency}). dpay ne convertit jamais, il n’y a donc aucune solution de repli. Demandez au commerçant un actif pris en charge.`,
  reviewPayment: 'Vérifier le paiement',
  paying: 'Vous payez',
  payAmount: amount => `Payer ${amount}`,
  notEnoughBalance: 'Solde insuffisant pour ce paiement.',
  localBalanceMayNotCover: 'Votre solde local ne suffit peut-être pas — le commerçant vérifiera.',
  approve: 'Approuver',
  approveA11y: 'Approuver le paiement',
  approveHint: 'Signe le montant affiché avec votre clé et l’envoie',
  signing: 'Signature…',
  signsOffline: 'La signature se fait hors ligne — le commerçant règle en envoyant le paiement.',
  linkNameClaimed: 'Nom fourni par l’expéditeur — vérifiez le compte ci-dessus.',

  link: {
    title: 'Ce lien de paiement ne peut pas être payé',
    part: {recipient: 'le compte à payer', asset: 'l’actif', network: 'le réseau', amount: 'le montant', ref: 'la référence'},
    malformed: part => `Le lien n’indique pas ${part}, ou la valeur est corrompue. Demandez un nouveau lien à l’expéditeur.`,
    unknownAsset: (token, network) =>
      `Le lien demande ${token} sur ${network}. Ce portefeuille n’a pas cet actif, et dpay ne convertit jamais : aucun remplacement n’est possible. Demandez un lien dans un actif que vous détenez.`,
    wrongNetwork: (token, network) =>
      `Le lien demande ${token} sur ${network}. Vous détenez ${token} sur un autre réseau — c’est un actif différent, et le paiement partirait sur la mauvaise chaîne. Demandez un lien sur un réseau que vous détenez.`,
    hiddenAsset: token =>
      `Le lien demande ${token}, un actif de réseau de test. Ouvrez « Soldes », activez « Afficher les actifs de test », puis rouvrez le lien.`,
    unsupportedAsset: token =>
      `Le lien demande ${token}, que ce portefeuille ne peut pas payer. dpay ne convertit jamais : il n’y a pas de solution de repli. Demandez un lien dans un actif que vous détenez.`,
    badAmount: (amount, token) =>
      `« ${amount} » n’est pas un montant ${token} valide — il a peut-être plus de décimales que ${token} n’en accepte. Demandez un nouveau lien à l’expéditeur.`,
    badAccount: network =>
      `Le compte de ce lien n’est pas un compte ${network} valide. Demandez à l’expéditeur de le vérifier et de renvoyer le lien.`,
  },

  ocp: {
    solanaUsdcUnsupported:
      'Cette caisse accepte les USDC sur Solana, mais son code n’indique pas vers quel compte de jetons les envoyer — payer ainsi risquerait d’envoyer de l’argent réel sur le mauvais compte. Payez plutôt en SOL, ou passez dans « Soldes » à un autre actif accepté par cette caisse.',
    assetNotAccepted: (selected, accepted) =>
      `Cette caisse n’accepte pas ${selected}. Elle accepte ${accepted}. dpay ne convertit jamais : passez à l’un de ces actifs dans « Soldes », puis scannez à nouveau.`,
    quoteExpired:
      'Le prix de cette caisse a expiré — chacun tient environ cinq minutes. Scannez le code à nouveau pour obtenir un prix frais.',
    badCode:
      'Ce code est abîmé, ou ce n’est pas un code de paiement. Demandez au commerçant de le montrer à nouveau, et vérifiez que rien ne le recouvre.',
    notHttps:
      'Ce code pointe vers une adresse non sécurisée : dpay ne l’ouvre pas. Demandez au commerçant de montrer son propre code de paiement — un autocollant collé par-dessus le vrai ressemble exactement à cela.',
    providerUnreachable:
      'Impossible de joindre le prestataire de paiement du commerçant. Rien n’a été payé. Vérifiez votre connexion et scannez à nouveau.',
    noPendingCharge: merchant =>
      `La caisse de ${merchant} n’a aucun montant en attente. Demandez que la vente soit enregistrée d’abord, puis scannez le code à nouveau.`,
    submitUnknown: blockIndex =>
      `Votre transfert est passé, mais le prestataire de paiement du commerçant ne l’a pas confirmé — ce n’est donc ni payé ni échoué. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Montrez au commerçant le bloc ${blockIndex} du registre, c’est la preuve de votre transfert.`,
    submitRejected: blockIndex =>
      `Votre transfert est passé, mais le prestataire de paiement du commerçant a refusé la preuve : la vente n’a pas été créditée. L’argent a quitté votre portefeuille — ne payez pas une seconde fois. Contactez le commerçant et donnez-lui le bloc ${blockIndex} du registre.`,
    claimedMerchant: 'Nom fourni par le code — dpay ne le vérifie pas.',
    providerHost: host => `Prix de ${host}`,
  },

  fundsSymbol: 'fonds',
  fundTitle: (symbol, action) => `Ajouter des ${symbol} pour ${action === 'pay' ? 'payer' : 'envoyer'}`,
  fundBody: (symbol, action) =>
    `Ce portefeuille n’a pas encore de ${symbol}. Envoyez des ${symbol} à votre adresse et vous pourrez ${action === 'pay' ? 'payer' : 'envoyer'} aussitôt.`,
  fundBodyNoDeposits: symbol =>
    `Ce portefeuille n’a pas encore de ${symbol} — et les ${symbol} ne sont pas encore disponibles en dépôt. Approvisionnez un autre actif, ou revenez bientôt.`,
  fundBodyUsdc: 'Envoyez des USDC (Solana) à votre adresse USDC. Gardez un peu de SOL dans le portefeuille pour les frais de réseau.',
  showMyAddress: symbol => `Voir mon adresse ${symbol}`,
  createUsdcAccount: 'Créer mon compte USDC',

  offlineSendTitle: 'Envoyer vers une adresse demande une connexion',
  offlineSendBody: symbol =>
    `Pour un envoi vers une adresse, c’est votre téléphone qui soumet l’opération : il doit donc être en ligne. Pour payer hors ligne, scannez plutôt le code de paiement du commerçant — son téléphone soumet votre paiement en ${symbol} à votre place.`,
  scannedAddressNotSendable: symbol =>
    `C’est une adresse de portefeuille. Les ${symbol} ne peuvent pas être envoyés vers une adresse — scannez le code de paiement du commerçant pour payer.`,

  scanToPay: 'Scanner pour payer',
  sendToAddress: 'Vers une adresse',
  tapOrScanToPay: 'Sans contact ou scan',
  scanQrToPay: 'Scannez le QR pour payer.',
  solScanHint: 'Scannez le code de paiement du commerçant pour payer hors ligne.',
  payNow: 'Payer',
  payNowA11y: 'Payer maintenant',
  payNowHint: 'Active la caméra et le paiement sans contact pour payer un commerçant',
  nfcNotAvailable: 'NFC indisponible',
  whyNfcUnavailable: 'Pourquoi le NFC est indisponible',
  nfcUnavailableTitle: 'NFC indisponible',
  close: 'Fermer',

  noCameraFound: 'Aucune caméra détectée sur cet appareil.',
  pointCamera: 'Visez un code de paiement avec votre caméra',
  cameraPrivacy: 'dpay n’utilise votre caméra que pour scanner des codes — sans jamais enregistrer ni envoyer.',
  allowCameraScan: 'Autoriser la caméra',
  allowCameraScanHint: 'Autorise l’usage de votre caméra pour scanner les codes de paiement',
};

export const receiveFr: ReceiveMessages = {
  amountToReceive: 'Montant à recevoir',
  amountHint: 'Le montant que le payeur vous enverra',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Note',
  memoHint: 'Une note facultative jointe à cette demande de paiement',
  memoPlaceholder: 'Ajouter une note (facultatif)',
  chooseCurrency: 'Choisir la monnaie de règlement',
  chooseCurrencyHint: 'Choisit l’actif que le payeur vous enverra',
  chooseAssetHint: 'Choisissez l’actif que le payeur vous enverra',
  request: 'Créer la demande',
  requestHint: 'Affiche votre QR pour que le payeur le scanne et vous paie',
  creating: 'Création…',
  creatingRequest: 'Création de la demande…',
  solanaOffline: 'Solana est hors ligne — reconnectez-vous pour créer une demande de paiement.',

  receiveInTitle: 'Recevoir en',
  receiveIn: symbol => `Recevoir en ${symbol}`,
  switchToRail: symbol => `Basculer sur ${symbol}`,

  requestPayment: 'Demander',
  myAddress: 'Mon adresse',
  showToPayer: nfc =>
    `Montrez ceci au payeur${nfc === 'tap' ? ' · ou sans contact' : nfc === 'expired' ? ' · NFC expiré' : ''}`,
  expiredMakeNew: 'Expiré — créez une nouvelle demande',
  validForMin: minutes => `Valable ~${minutes} min`,
  expiresIn: seconds => `Expire dans 0:${seconds}`,
  waitingForPayment: online => `En attente du paiement${online ? '…' : ' — reconnectez-vous pour envoyer…'}`,
  waitingForSign: 'En attente de la signature hors ligne du payeur…',
  offlineCantSubmit: 'Hors ligne — impossible d’envoyer les paiements avant reconnexion',
  shareRequestLink: 'Partager le lien',
  shareRequestHint: 'Partage cette demande sous forme de lien que le payeur peut ouvrir pour payer',
  scanPayerSignedQr: 'Scanner le QR signé',
  scanPayerSignedQrPrompt: 'Scannez le QR signé du payeur',
  scanPayerSignedQrHint: 'Scanne le QR signé du payeur pour envoyer son paiement hors ligne',
  scanPayerSignedCode: 'Scanner le code signé du payeur',
  confirmWithTheirPhone: 'Si le payeur a payé sans scanner votre code, appuyez ici pour confirmer avec son téléphone.',
  newRequest: 'Nouvelle demande',
  back: 'Retour',

  payer: 'votre payeur',
  receivedAmount: amount => `Reçu ${amount}`,
  fromWho: who => `de ${who}`,
  transactionSignature: 'signature de la transaction',
  copySignature: 'Copier la signature',
  copySignatureA11y: 'Copier la signature de la transaction',
  sharedConfirm: 'Partagé ✓',

  receiptMalformed: 'Ce lien de reçu est mal formé.',
  receiptMismatch: 'Ce reçu ne correspond pas à votre demande en cours.',
  receiptUnreadable: 'Impossible de lire ce lien de reçu.',
  couldNotConfirmYet: 'Impossible de confirmer ce paiement pour l’instant — si le payeur a payé, il apparaîtra à la prochaine actualisation du solde.',
  unknownLedger: 'Registre inconnu pour cet actif — envoi impossible',
  couldNotSubmit: 'Impossible d’envoyer le paiement — vérifiez la connexion',
  noOpenRequest: 'Aucune demande en cours.',
  paymentRejected: 'Paiement refusé.',
  paymentRejectedDetail: 'Paiement refusé — le solde du payeur est peut-être insuffisant, ou le blockhash a expiré.',
  couldNotConfirmMaySettle: 'Impossible de confirmer — le paiement peut encore être réglé. Vérifiez votre solde dans un instant ou réessayez.',
  stillCannotConfirm: 'Toujours impossible de confirmer — le paiement peut encore être réglé. Réessayez plus tard.',
  savedDataCorrupt: 'Les données de paiement enregistrées sont corrompues.',
  paymentBeingConfirmed: 'Un paiement est en cours de confirmation',
  broadcastInterrupted: 'Un envoi a été interrompu. Le paiement a peut-être été réglé — réessayez pour vérifier.',
  retryBroadcast: 'Réessayer l’envoi',
  broadcasting: 'Envoi sur Solana — cela peut prendre jusqu’à une minute.',
};
