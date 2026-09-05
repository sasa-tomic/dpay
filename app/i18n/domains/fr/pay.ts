/**
 * i18n/domains/fr/pay.ts — French values for the Pay + Receive screens.
 *
 * Reference copy and all documentation: ../en/pay.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {PayMessages, ReceiveMessages} from '../../keys';

export const payFr: PayMessages = {
  notAPaymentCode: 'Ce n’est pas un code de paiement dpay',
  scannedCoinRequest: (coin, uri) =>
    `C’est une demande de paiement ${coin} (${uri}…). dpay ne peut pas la payer — ce portefeuille règle sur Internet Computer et Solana, pas sur le réseau ${coin}. Payez-la avec un portefeuille qui prend ${coin} en charge.`,
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
    chooseAsset: selected =>
      `Cette caisse n’accepte pas ${selected}, mais elle accepte ceux-ci — choisis avec lequel payer. dpay ne convertit jamais : tu paies l’actif que tu choisis.`,
    assetNotAccepted: (selected, accepted) =>
      `Cette caisse n’accepte pas ${selected}. Elle accepte ${accepted}. dpay ne convertit jamais : passez à l’un de ces actifs dans « Soldes », puis scannez à nouveau.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `Cette caisse accepte ${selected}, mais le prestataire de paiement du commerçant ne peut pas traiter ${selected} pour le moment. La caisse accepte aussi ${alternatives}. dpay ne convertit jamais : passez à l’un de ces actifs dans « Soldes », puis scannez à nouveau.`
        : `Cette caisse accepte ${selected}, mais le prestataire de paiement du commerçant ne peut pas traiter ${selected} pour le moment — et ce portefeuille ne peut payer aucun autre actif accepté par cette caisse. Demandez au commerçant un autre moyen de paiement.`,
    noPayableAsset: accepted =>
      `dpay ne peut pas payer à cette caisse. Elle accepte ${accepted}, et ce portefeuille ne peut payer aucun de ces actifs — dpay ne convertit jamais. Réglez cet achat autrement.`,
    quoteExpired:
      'Le prix de cette caisse a expiré — chacun tient environ cinq minutes. Scannez le code à nouveau pour obtenir un prix frais.',
    notEnoughTime:
      'Ce prix expire trop tôt pour être payé sans risque. Votre argent partirait avant que le prestataire de paiement du commerçant puisse en être informé, et il refuserait ensuite la vente. Scannez le code à nouveau pour obtenir un prix frais.',
    unreportable: host =>
      `${host} n’a donné à dpay aucun moyen de lui signaler un paiement : payer ici vous coûterait votre argent sans que la vente soit créditée. Rien n’a été payé. Scanner à nouveau n’y changera rien — demandez au commerçant un autre moyen de paiement.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `Le prix de ce code vient de ${quoteHost}, mais il demande que la preuve de votre paiement soit envoyée à ${proofHost}. Un paiement ne peut pas répondre à deux sociétés différentes : dpay s’est arrêté. Rien n’a été payé — demandez au commerçant de montrer son propre code de paiement.`,
    tillCharging: price =>
      `Le commerçant demande ${price}. Son prestataire de paiement a fixé le montant ci-dessus — dpay ne convertit pas.`,
    checkingTill: 'Vérification auprès du prestataire de paiement du commerçant…',
    badCode:
      'Ce code est abîmé, ou ce n’est pas un code de paiement. Demandez au commerçant de le montrer à nouveau, et vérifiez que rien ne le recouvre.',
    notHttps:
      'Ce code pointe vers une adresse non sécurisée : dpay ne l’ouvre pas. Demandez au commerçant de montrer son propre code de paiement — un autocollant collé par-dessus le vrai ressemble exactement à cela.',
    providerUnreachable:
      'Impossible de joindre le prestataire de paiement du commerçant. Rien n’a été payé. Vérifiez votre connexion et scannez à nouveau.',
    badDestination: host =>
      `${host} a répondu avec une adresse de paiement qui ne correspond pas à votre choix : dpay s’est arrêté. Rien n’a été payé — ne payez pas ce code. Demandez au commerçant de montrer son propre code à nouveau.`,
    providerRefused: (host, detail) =>
      `Le prestataire de paiement du commerçant (${host}) n’a pas accepté ce paiement. Rien n’a été payé. Demandez au commerçant d’enregistrer la vente à nouveau, puis scannez le code. Si l’échec persiste, montrez-lui ce que son prestataire a répondu : « ${detail} ».`,
    providerFailed: (host, status) =>
      `Le prestataire de paiement du commerçant (${host}) a répondu par une erreur (${status}) sans en donner la raison. Rien n’a été payé. Patientez un instant et scannez le code à nouveau ; si l’échec persiste, demandez au commerçant un autre moyen de paiement.`,
    badAnswer: (host, part) =>
      `Le prestataire de paiement du commerçant (${host}) n’a pas envoyé ${part} : dpay ne peut pas payer à cette caisse. Rien n’a été payé. Scannez le code à nouveau, et signalez-le au commerçant si cela se reproduit.`,
    answerPart: {
      body: 'de réponse lisible',
      details: 'de données de paiement complètes',
      destination: 'd’adresse de paiement',
      expiry: 'de date d’expiration lisible',
    },
    noPendingCharge: merchant =>
      `La caisse de ${merchant} n’a aucun montant en attente. Demandez que la vente soit enregistrée d’abord, puis scannez le code à nouveau.`,
    ref: {
      icBlock: index => `le bloc ${index} du registre`,
      solTransaction: signature => `la transaction Solana ${signature}`,
    },
    submitUnknown: reference =>
      `Votre transfert est passé, mais le prestataire de paiement du commerçant ne l’a pas confirmé — ce n’est donc ni payé ni échoué. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Montrez au commerçant ${reference}, c’est la preuve de votre transfert.`,
    submitPending: reference =>
      `Votre transfert est passé et le prestataire de paiement du commerçant en a été informé — il ne l’a simplement pas encore rattaché à cette vente. Il sera crédité dès qu’il verra le transfert : vous n’avez rien d’autre à faire. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Si la caisse ne l’affiche toujours pas, donnez ${reference} au commerçant.`,
    submitRejected: (reference, said) =>
      `Votre transfert est passé, mais le prestataire de paiement du commerçant a refusé la preuve : la vente n’a pas été créditée. L’argent a quitté votre portefeuille — ne payez pas une seconde fois. Contactez le commerçant et donnez-lui ${reference}.`
      + (said === null ? '' : ` Le prestataire indique : « ${said} »`),
    submitTooLate: reference =>
      `Votre transfert est passé, mais seulement après l’expiration de ce prix : la vente n’a pas été créditée. L’argent a quitté votre portefeuille — ne payez pas une seconde fois. Contactez le commerçant et donnez-lui ${reference}, c’est la preuve de votre transfert.`,
    transferUnknown:
      'dpay n’a pas encore pu confirmer votre transfert, le commerçant n’en sait donc rien — ce n’est ni payé ni échoué. Gardez cet écran ouvert : dpay continue de vérifier et terminera le paiement lui-même si le transfert est passé. Entre-temps, ne payez pas une seconde fois.',
    transferRefused: reason =>
      `Votre transfert n’est pas passé : rien n’a été payé et votre argent est toujours dans votre portefeuille — ${reason}. Scannez le code à nouveau pour payer à cette caisse.`,
    transferFailed:
      'Le réseau Solana a rejeté votre transaction : rien n’a été payé, le montant est toujours dans votre portefeuille (de petits frais de réseau ont été prélevés). Scannez le code à nouveau pour réessayer.',
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
  fundSibling: {
    holds: (amount, rail) => `Vous détenez ${amount} sur ${rail}`,
    switchTo: network => `Passer à ${network}`,
  },

  offlineSendTitle: 'Envoyer vers une adresse demande une connexion',
  offlineSendBody: symbol =>
    `Pour un envoi vers une adresse, c’est votre téléphone qui soumet l’opération : il doit donc être en ligne. Pour payer hors ligne, scannez plutôt le code de paiement du commerçant — son téléphone soumet votre paiement en ${symbol} à votre place.`,
  scannedAddressNotSendable: symbol =>
    `C’est une adresse de portefeuille. Les ${symbol} ne peuvent pas être envoyés vers une adresse — scannez le code de paiement du commerçant pour payer.`,

  spay: {
    wrongRail:
      'C’est une demande Solana Pay. Cet écran règle sur Internet Computer — passez à Solana dans Soldes et scannez-y le code pour la payer.',
    badUri: 'Ce code Solana Pay est endommagé. Demandez un nouveau QR au commerçant.',
    badRecipient: 'Le destinataire de ce code Solana Pay n’est pas une adresse Solana valide. Demandez un nouveau QR au commerçant.',
    badAmount: 'Le montant de ce code Solana Pay n’est pas un nombre positif simple. Demandez un nouveau QR au commerçant.',
    badSplToken: 'Le mint de jeton de ce code Solana Pay n’est pas valide. Demandez un nouveau QR au commerçant.',
    badReference: 'La référence de paiement de ce code Solana Pay n’est pas valide. Demandez un nouveau QR au commerçant.',
    unexpectedParam: param =>
      `Ce code Solana Pay porte un paramètre inconnu de dpay (${param}) — le payer signerait un sens que dpay ne peut pas vérifier. Demandez au commerçant un code sans ce paramètre.`,
    memoTooLong: 'Le memo de ce code Solana Pay est trop long pour une transaction Solana. Demandez un nouveau QR au commerçant.',
    unknownMint: mint =>
      `Ce code Solana Pay demande un jeton que dpay ne propose pas encore (mint ${mint}). Payez-le avec un portefeuille qui le prend en charge.`,
    offline:
      'Pour un code Solana Pay, c’est votre téléphone qui soumet le transfert : il doit être en ligne. Reconnectez-vous et scannez à nouveau.',
    amountLabel: 'Montant',
    merchantMessage: message => `Message du commerçant : ${message}`,
    pendingNote:
      'Le réseau a accepté ce paiement, mais sa confirmation est encore en route. La signature de transaction ci-dessous est votre preuve — vérifiez-la avant de payer à nouveau.',
  },

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
  rail: {
    feeLine: (network, fee) => `${network} · Frais ${fee}`,
    feeWithOneTime: (network, fee, oneTime) => `${network} · Frais ${fee} + loyer unique ${oneTime}`,
    feeUnknown: network => `${network} · Frais inconnus`,
  },
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

  till: {
    codeForm: 'Qui peut payer ce code',
    dpayCode: 'Code dpay',
    tillCode: 'Code de caisse',

    chargeLabel: 'Montant à encaisser',
    chargeHint: 'Affiché en francs, payé en VCHF — un franc, un VCHF, sans conversion.',
    ringUp: 'Encaisser',
    ringUpHint: 'Ouvrir ce montant sur votre caisse et montrer au client un code qu’il peut payer',
    ringingUp: 'Ouverture…',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'Un montant de caisse s’arrête au centime — saisissez 10.50 plutôt que 10.505.'
        : reason === 'too-large'
        ? 'Ce montant est trop élevé pour une caisse. Saisissez ce que ce client doit.'
        : 'Saisissez le montant à encaisser, par exemple 10.50.',

    wrongAssetTitle: 'Un code de caisse se paie en VCHF',
    wrongAsset: (selected, network) =>
      `Un code de caisse se paie toujours en VCHF sur l’Internet Computer — un comptoir accepte un seul actif, et dpay ne convertit jamais. Cette demande est en ${selected}${network ? ` sur ${network}` : ''}. Passez à VCHF pour encaisser, ou gardez le code dpay : n’importe quel portefeuille dpay peut le payer en ${selected}.`,
    noTillAsset:
      'Ce portefeuille ne détient pas de VCHF : il n’y a donc aucun compte où un encaissement pourrait être payé. Utilisez le code dpay — n’importe quel portefeuille dpay peut le payer dans l’actif choisi.',
    switchTo: asset => `Passer à ${asset}`,

    failedTitle: 'Le montant n’a pas été encaissé',
    notServed: host =>
      `${host} ne sert pas de codes de caisse : rien n’a été ouvert et rien n’est payable. Demandez à la personne qui exploite ce relais d’activer la caisse, ou utilisez le code dpay — il n’a besoin d’aucune caisse.`,
    unreachable: host =>
      `dpay n’a pas pu joindre ${host} : rien n’a été ouvert. Un code de caisse se crée en ligne. Vérifiez la connexion et recommencez — ou utilisez le code dpay, que ce téléphone fabrique seul et peut afficher hors ligne.`,
    refused: said =>
      `La caisse a refusé ce montant : « ${said} » Rien n’est payable. Corrigez cela, puis recommencez.`,
    refusedNoReason: status =>
      `La caisse a refusé ce montant (HTTP ${status}) sans dire pourquoi : rien n’est payable. Recommencez ; si elle refuse deux fois, prévenez la personne qui exploite le relais.`,
    mispriced: (rung, quoted) =>
      `Vous avez encaissé ${rung} et la caisse a répondu ${quoted}. dpay n’affiche pas un code qui réclame un montant que personne n’a choisi ici : rien n’est payable. Recommencez — et si cela se reproduit, prévenez la personne qui exploite le relais avant d’accepter le moindre paiement.`,
    unsigned:
      'Ce téléphone n’a pas pu signer le montant : rien n’a été ouvert et rien n’est payable. Fermez puis rouvrez dpay, et recommencez.',
    tryAgain: 'Encaisser à nouveau',

    settlesAs: amount => `${amount} sur l’Internet Computer`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Montrez ceci au client — son portefeuille dpay approche le téléphone ou scanne, comme il préfère.'
        : nfc === 'expired'
        ? 'Montrez ceci au client — son portefeuille dpay le scanne. Le paiement sans contact a expiré sur ce code ; ressaisissez le montant s’il veut approcher son téléphone.'
        : 'Montrez ceci au client — son portefeuille dpay le scanne et paie.',
    waiting: 'En attente du paiement…',
    cantCheck:
      'Impossible de vérifier ce montant pour l’instant — la caisse est injoignable. Cela ne veut PAS dire qu’il est impayé. Laissez le code affiché : cet écran le dira dès qu’il pourra joindre la caisse.',
    expiredWatching:
      'Ce code a expiré : plus personne ne peut le payer. Si le client a déjà envoyé l’argent, il peut encore arriver — surveillance encore un instant.',
    cancel: 'Annuler le montant',
    cancelHint: 'Effacer ce montant pour que le code n’accepte plus de paiement',
    cancelling: 'Annulation…',
    cancelFailed: said =>
      `Le montant n’a PAS été annulé : « ${said} » Il peut rester payable — lisez cela avant de remettre quoi que ce soit.`,
    cancelFailedNoReason: status =>
      `Le montant n’a PAS été annulé (HTTP ${status}) et aucune raison n’a été donnée : considérez-le comme toujours payable. Réessayez, et ne remettez rien sur ce code tant qu’il n’est pas annulé ou expiré.`,
    cancelUnreachable:
      'La caisse était injoignable : ce montant n’a donc PAS été annulé — il reste payable jusqu’à son expiration. Réessayez dès que la connexion revient.',

    endedTitle: reason =>
      reason === 'expired' ? 'Ce code a expiré'
      : reason === 'cancelled' ? 'Montant annulé'
      : reason === 'superseded' ? 'Remplacé par un montant plus récent'
      : 'La caisse n’a plus ce montant',
    endedBody: reason =>
      reason === 'expired'
        ? 'Rien n’est arrivé pour lui et plus personne ne peut le payer. Recommencez pour montrer au client un code tout neuf.'
        : reason === 'cancelled'
        ? 'Rien n’est dû dessus et personne ne peut le payer. Recommencez quand le client suivant est prêt.'
        : reason === 'superseded'
        ? 'Un montant plus récent a été ouvert sur cette caisse : ce code n’accepte plus de paiement. Recommencez pour en montrer un tout neuf.'
        : 'Le relais ne l’a plus — très probablement parce qu’il a redémarré. Rien n’a été crédité ici. Recommencez ; si le client dit avoir payé, vérifiez votre solde VCHF et vos Transactions avant de lui demander de payer une deuxième fois.',
    ringUpNext: 'Encaisser le client suivant',

    paidAmount: price => `Payé ${price}`,
    paidBlock: block => `Bloc du registre ${block}`,
    paidLate: 'C’est arrivé après l’expiration du code — accepté, l’argent est sur le registre.',
  },
};
