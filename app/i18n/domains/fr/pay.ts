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
    `C’est une demande de paiement ${coin} (${uri}…). Ce portefeuille paie sur Internet Computer et Solana — utilisez un portefeuille ${coin}.`,
  requestExpired: 'Cette demande a expiré — demandez un nouveau QR au commerçant',

  sent: amount => (amount ? `Envoyé ${amount}` : 'Envoyé'),
  alreadyPaid: 'Déjà payé',
  toWho: who => `à ${who}`,
  toWhoAwaiting: who => `à ${who} · en attente de la confirmation du commerçant`,
  alreadyNotCharged: (amount, who) => `${amount} à ${who} · non débité une seconde fois`,
  solAwaiting: who =>
    who ? `à ${who} · en attente de la confirmation du commerçant` : 'en attente de la confirmation du commerçant',
  newPayment: 'Nouveau paiement',

  shareReceipt: 'Partager le reçu',
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
    `Hors ligne — ${who} le règle en l’envoyant. Votre solde se met à jour dès votre retour en ligne.`,
  solOfflineSettles:
    'Hors ligne — le commerçant le règle en l’envoyant. Votre solde se met à jour une fois confirmé.',
  handedTo: who => `Remis à ${who}`,
  handedToMerchant: 'Remis au commerçant',
  handedOffHint: 'Marque le paiement comme remis — votre solde se met à jour quand le commerçant règle',

  unsupportedAsset: 'Actif non pris en charge',
  unsupportedAssetBody: currency =>
    `Ce paiement demande un actif que ce portefeuille ne peut pas payer (monnaie ${currency}). dpay ne convertit jamais — demandez au commerçant un actif pris en charge.`,
  paying: 'Vous payez',
  payAmount: amount => `Payer ${amount}`,
  notEnoughBalance: 'Solde insuffisant pour ce paiement.',
  localBalanceMayNotCover: 'Votre solde local ne suffit peut-être pas — le commerçant vérifie.',
  approve: 'Approuver',
  approveA11y: 'Approuver le paiement',
  approveHint: 'Signez le montant affiché avec votre clé et l’envoyez',
  signing: 'Signature…',
  signsOffline: 'Signature hors ligne — le commerçant le règle en l’envoyant.',

  link: {
    title: 'Ce lien de paiement ne peut pas être payé',
    part: {recipient: 'le compte à payer', asset: 'l’actif', network: 'le réseau', amount: 'le montant', ref: 'la référence'},
    malformed: part => `Il manque ${part} dans le lien, ou la valeur est corrompue. Demandez un nouveau lien.`,
    unknownAsset: (token, network) =>
      `Le lien demande ${token} sur ${network} — vous n’en détenez pas. dpay ne convertit jamais : demandez un lien dans un actif que vous détenez.`,
    wrongNetwork: (token, network) =>
      `Le lien demande ${token} sur ${network}, mais vous détenez ${token} ailleurs. Payer enverrait votre argent sur la mauvaise chaîne — demandez à l’expéditeur un lien sur un réseau que vous détenez.`,
    hiddenAsset: token =>
      `Le lien demande ${token}, un actif de réseau de test. Dans « Soldes », activez « Afficher les actifs de test », puis rouvrez le lien.`,
    unsupportedAsset: token =>
      `Le lien demande ${token}, que ce portefeuille ne peut pas payer. dpay ne convertit jamais — demandez un lien dans un actif que vous détenez.`,
    badAmount: (amount, token) =>
      `« ${amount} » n’est pas un montant ${token} valide — vérifiez les décimales. Demandez un nouveau lien.`,
    badAccount: network =>
      `Ce compte n’est pas un compte ${network} valide. Demandez à l’expéditeur de le vérifier et d’envoyer un nouveau lien.`,
  },

  ocp: {
    solanaTokenUnsupported: symbol =>
      `Cette caisse accepte les ${symbol} sur Solana, mais son code n’indique pas quel compte payer — l’argent pourrait tomber sur le mauvais, alors payez en SOL, ou passez dans « Soldes ».`,
    chooseAsset: selected =>
      `Cette caisse n’accepte pas ${selected}, mais elle accepte ceux-ci — dpay ne convertit jamais.`,
    assetNotAccepted: (selected, accepted) =>
      `Cette caisse accepte ${accepted}, pas ${selected}. dpay ne convertit jamais : passez dans « Soldes », puis scannez à nouveau.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `La caisse accepte ${selected}, mais son prestataire ne peut pas la traiter pour le moment. Elle accepte aussi ${alternatives} — passez dans « Soldes », puis scannez à nouveau.`
        : `La caisse accepte ${selected}, mais son prestataire ne peut pas la traiter, et ce portefeuille ne peut payer aucun autre actif qu’elle accepte. Demandez au commerçant un autre moyen de paiement.`,
    noPayableAsset: accepted =>
      `Cette caisse accepte ${accepted} — rien que ce portefeuille puisse payer. dpay ne convertit jamais. Payez autrement.`,
    quoteExpired:
      'Ce prix a expiré — scannez le code à nouveau pour en obtenir un frais.',
    notEnoughTime:
      'Ce prix expire trop tôt pour être payé sans risque — scannez à nouveau pour en obtenir un frais.',
    unreportable: host =>
      `${host} n’a donné aucun moyen de signaler un paiement : payer vous coûterait votre argent sans que la vente soit créditée. Rien n’a été payé. Scanner à nouveau n’aidera pas — demandez au commerçant un autre moyen de paiement.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `Le prix vient de ${quoteHost}, mais la preuve de votre paiement partirait vers ${proofHost}. Une vente ne peut pas répondre à deux sociétés. Rien n’a été payé — demandez au commerçant son propre code.`,
    checkoutPrice: (price, host) => `${price} · prix de ${host}`,
    checkingCheckout: 'Vérification auprès du prestataire de paiement…',
    badCode:
      'Ce code est abîmé, ou ce n’est pas un code de paiement. Demandez au commerçant de le montrer à nouveau — vérifiez que rien ne le recouvre.',
    notHttps:
      'Ce code pointe vers une adresse non sécurisée : dpay ne l’ouvre pas. Demandez au commerçant son propre code — un autocollant par-dessus le vrai ressemble exactement à cela.',
    providerUnreachable:
      'Impossible de joindre le prestataire de paiement. Rien n’a été payé — vérifiez votre connexion et scannez à nouveau.',
    badDestination: host =>
      `${host} a renvoyé une adresse de paiement qui ne correspond pas à votre choix : dpay s’est arrêté. Rien n’a été payé — ne payez pas ce code. Demandez au commerçant un code frais.`,
    providerRefused: (host, detail) =>
      `Le prestataire de paiement (${host}) a refusé ce paiement. Rien n’a été payé. Demandez au commerçant d’enregistrer de nouveau la vente, puis scannez. Si l’échec persiste, montrez-lui ce qu’il a répondu : « ${detail} ».`,
    providerFailed: (host, status) =>
      `Le prestataire de paiement (${host}) a renvoyé une erreur (${status}) sans raison. Rien n’a été payé. Patientez un instant et scannez à nouveau ; si l’échec persiste, demandez au commerçant un autre moyen de paiement.`,
    badAnswer: (host, part) =>
      `Le prestataire de paiement (${host}) n’a pas envoyé ${part} : dpay ne peut pas payer à cette caisse. Rien n’a été payé. Scannez à nouveau, et signalez-le au commerçant si cela se reproduit.`,
    answerPart: {
      body: 'de réponse lisible',
      details: 'de données de paiement complètes',
      destination: 'd’adresse de paiement',
      expiry: 'de date d’expiration lisible',
    },
    noPendingCharge: merchant =>
      `La caisse de ${merchant} n’a aucun montant ouvert. Demandez qu’un montant soit enregistré d’abord, puis scannez à nouveau.`,
    ref: {
      icBlock: index => `le bloc ${index} du registre`,
      solTransaction: signature => `la transaction Solana ${signature}`,
    },
    submitUnknown: reference =>
      `Votre transfert est passé, mais le prestataire ne l’a pas confirmé — ni payé ni échoué. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Montrez au commerçant ${reference}, la preuve de votre transfert.`,
    submitPending: reference =>
      `Votre transfert est passé et le prestataire en a été informé — il ne l’a simplement pas encore rattaché à cette vente ; il sera crédité dès qu’il le verra. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Si la caisse ne l’affiche pas, donnez ${reference} au commerçant.`,
    submitRejected: (reference, said) =>
      `Votre transfert est passé, mais le prestataire a refusé la preuve : la vente n’a pas été créditée. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Donnez ${reference} au commerçant.`
      + (said === null ? '' : ` Le prestataire indique : « ${said} »`),
    submitTooLate: reference =>
      `Votre transfert est passé, mais seulement après l’expiration du prix : la vente n’a pas été créditée. L’argent a quitté votre portefeuille : ne payez pas une seconde fois. Donnez au commerçant ${reference}.`,
    transferUnknown:
      'Votre transfert n’est pas encore confirmé, le commerçant n’en sait donc rien — ni payé ni échoué. Gardez cet écran ouvert : dpay continue de vérifier et terminera le paiement si le transfert est passé. Entre-temps, ne payez pas une seconde fois.',
    transferRefused: reason =>
      `Le transfert n’est pas passé — rien n’a été payé et votre argent est toujours dans votre portefeuille : ${reason}. Scannez à nouveau pour payer.`,
    transferFailed:
      'Le réseau Solana a rejeté votre transaction — rien n’a été payé. Votre montant est intact ; de petits frais de réseau ont été prélevés. Scannez à nouveau pour réessayer.',
    providerHost: host => `Prix de ${host}`,
  },

  fundsSymbol: 'fonds',
  fundTitle: symbol => `Aucun ${symbol} disponible`,
  fundBody: (symbol, action) =>
    action === 'pay'
      ? `Pour payer une demande en ${symbol}, recevez d’abord des ${symbol} à votre adresse.`
      : `Pour envoyer des ${symbol}, recevez-en d’abord à votre adresse.`,
  fundBodyNoDeposits: symbol =>
    `dpay ne peut pas afficher d’adresse de dépôt pour ${symbol}. Recevez-en d’un autre portefeuille avant de le dépenser.`,
  fundBodyToken: symbol => `Envoyez des ${symbol} (Solana) à votre adresse ${symbol}. Gardez un peu de SOL dans le portefeuille pour les frais de réseau.`,
  showMyAddress: symbol => `Voir mon adresse ${symbol}`,
  createTokenAccount: symbol => `Créer mon compte ${symbol}`,
  fundSibling: {
    holds: (amount, rail) => `Vous détenez ${amount} sur ${rail}`,
    switchTo: network => `Passer à ${network}`,
    switchToAsset: asset => `Passer à ${asset}`,
    practice: amount =>
      `Vous avez ${amount} en argent d’entraînement. Entraînez-vous avec — il n’a aucune valeur et ne peut pas payer un vrai commerçant.`,
    switchToPractice: 'Passer à l’argent d’entraînement',
  },

  offlineSendTitle: 'Envoyer vers une adresse demande une connexion',
  offlineSendBody: symbol =>
    `Scannez plutôt le code du commerçant — son téléphone soumet votre paiement en ${symbol} pendant que vous êtes hors ligne.`,
  scannedAddressNotSendable: symbol =>
    `C’est une adresse de portefeuille — les ${symbol} ne peuvent pas y être envoyés. Scannez un code de paiement pour payer.`,

  spay: {
    wrongRail:
      'C’est un code Solana Pay. Cet écran règle sur Internet Computer — passez à Solana dans Soldes et scannez-y le code.',
    badUri: 'Ce code Solana Pay est endommagé. Demandez un nouveau QR au commerçant.',
    badRecipient: 'Le destinataire de ce code n’est pas une adresse Solana valide. Demandez un nouveau QR au commerçant.',
    badAmount: 'Le montant de ce code n’est pas un nombre positif simple. Demandez un nouveau QR au commerçant.',
    badSplToken: 'Le mint de jeton de ce code n’est pas valide. Demandez un nouveau QR au commerçant.',
    badReference: 'La référence de paiement de ce code n’est pas valide. Demandez un nouveau QR au commerçant.',
    unexpectedParam: param =>
      `Ce code porte un paramètre inconnu (${param}) : dpay ne peut pas vérifier ce que le payer signerait. Demandez au commerçant un code sans ce paramètre.`,
    memoTooLong: 'Le memo de ce code est trop long pour une transaction Solana. Demandez un nouveau QR au commerçant.',
    unknownMint: mint =>
      `Ce code demande un jeton que dpay ne propose pas (mint ${mint}). Payez-le avec un portefeuille qui le prend en charge.`,
    offline:
      'Pour un code Solana Pay, c’est votre téléphone qui soumet : il doit être en ligne. Reconnectez-vous et scannez à nouveau.',
    amountLabel: 'Montant',
    merchantMessage: message => `Du commerçant : ${message}`,
    pendingNote:
      'Le réseau a accepté ce paiement ; la confirmation est encore en route. La signature ci-dessous est votre preuve — vérifiez-la avant de payer à nouveau.',
  },

  scanToPay: 'Scanner',
  sendToAddress: 'Vers une adresse',
  tapOrScanToPay: 'Sans contact ou scan',
  solScanHint: 'Scannez le code du commerçant pour payer hors ligne.',
  payNow: 'Payer',
  payNowA11y: 'Payer maintenant',
  payNowHint: 'Démarre la caméra et le paiement sans contact',
  nfcNotAvailable: 'NFC indisponible',
  whyNfcUnavailable: 'Pourquoi le NFC est indisponible',
  nfcUnavailableTitle: 'NFC indisponible',
  close: 'Fermer',

  noCameraFound: 'Aucune caméra détectée sur cet appareil.',
  pointCamera: 'Visez un code de paiement avec la caméra',
  cameraPrivacy: 'Utilisée uniquement pour scanner des codes. Jamais enregistrée ni envoyée.',
  allowCameraScan: 'Autoriser la caméra',
};

export const receiveFr: ReceiveMessages = {
  amountToReceive: 'Montant à recevoir',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Note',
  memoPlaceholder: 'Ajouter une note (facultatif)',
  chooseCurrency: 'Choisir la monnaie de règlement',
  chooseCurrencyHint: 'Choisit l’actif que le payeur vous enverra',
  request: 'Afficher le code',
  creating: 'Création…',
  solanaOffline: 'Solana est hors ligne — reconnectez-vous pour créer une demande de paiement.',
  solAmountUnderFee: fee =>
    `Une demande en SOL doit dépasser les frais de réseau (${fee}). Les frais sont à votre charge — le payeur paie exactement le montant que vous saisissez.`,
  solFeeLine: (fee, receives) => `Frais ${fee} · vous recevez ${receives}`,

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
  feeNetLine: (fee, net) => `Frais ${fee} · vous recevez ${net}`,
  feeTooBig: fee => `Ce montant ne couvre pas les frais de réseau (${fee}) — demandez un montant plus élevé.`,
  showToPayer: nfc =>
    `Montrez ceci au payeur${nfc === 'tap' ? ' · ou sans contact' : nfc === 'expired' ? ' · NFC expiré' : ''}`,
  expiredMakeNew: 'Expiré — créez une nouvelle demande',
  validForMin: minutes => `Valable ~${minutes} min`,
  expiresIn: seconds => `Expire dans 0:${seconds}`,
  waitingForPayment: online => `En attente du paiement${online ? '…' : ' — reconnectez-vous pour envoyer…'}`,
  waitingForSign: 'En attente de la signature hors ligne du payeur…',
  offlineCantSubmit: 'Hors ligne — impossible d’envoyer les paiements avant reconnexion',
  shareRequestLink: 'Partager le lien',
  linkUnavailable: 'Cet actif ne peut pas être nommé dans un code de paiement. Choisissez un autre actif pour demander un paiement.',
  scanPayerSignedCode: 'Scanner le code signé du payeur',
  confirmWithTheirPhone: 'Si le payeur a payé sans scanner votre code, confirmez avec son téléphone.',
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
  couldNotSubmit: 'Impossible d’envoyer ce paiement. Scannez-le à nouveau. S’il est déjà passé, il apparaîtra dans votre solde.',
  noOpenRequest: 'Aucune demande en cours.',
  paymentRejected: 'Paiement refusé.',
    paymentRejectedDetail:
      'Paiement refusé — le payeur manque peut-être de solde, ou le blockhash a expiré.',
  couldNotConfirmMaySettle: 'Impossible de confirmer — le paiement peut encore être réglé. Vérifiez votre solde dans un instant ou réessayez.',
  stillCannotConfirm: 'Toujours impossible de confirmer — le paiement peut encore être réglé. Réessayez plus tard.',
  settlementNotVerified: 'Confirmé, mais la transaction on-chain ne correspond pas à cette demande. Ne remettez pas encore la marchandise — vérifiez la signature dans un explorateur Solana et surveillez votre solde ; le paiement peut encore arriver.',
  savedDataCorrupt: 'Les données de paiement enregistrées sont corrompues.',
  paymentBeingConfirmed: 'Un paiement est en cours de confirmation',
  broadcastInterrupted: 'Un envoi a été interrompu. Le paiement a peut-être été réglé — réessayez pour vérifier.',
  retryBroadcast: 'Réessayer l’envoi',
  broadcasting: 'Envoi sur Solana — cela peut prendre jusqu’à une minute.',

  checkout: {
    checkoutCode: 'Affiche aussi un code de caisse pour les apps OpenCryptoPay (Binance Pay, MoonPay) — le payeur doit avoir l’application ouverte',

    openChargeHint: 'Ouvrir ce montant sur votre caisse et montrer au client un code payable',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'Un montant de caisse s’arrête au centime — saisissez 10.50, pas 10.505.'
        : reason === 'too-large'
        ? 'Ce montant est trop élevé pour être ouvert. Saisissez ce que ce client doit.'
        : 'Saisissez le montant à encaisser, par exemple 10.50.',

    wrongAssetTitle: 'Un code de caisse se paie en VCHF',
    wrongAsset: (selected, network) =>
      `Un code de caisse se paie toujours en VCHF sur l’Internet Computer — dpay ne convertit jamais. Cette demande est en ${selected}${network ? ` sur ${network}` : ''}. Passez à VCHF, ou gardez le code dpay : n’importe quel appareil photo de téléphone l’ouvre, et il se paie en ${selected}.`,
    noCheckoutAsset:
      'Ce portefeuille n’a pas de VCHF : il n’y a donc aucun compte pour un encaissement. Utilisez le code dpay — n’importe quel appareil photo de téléphone l’ouvre, et il accepte l’actif choisi.',
    switchTo: asset => `Passer à ${asset}`,

    failedTitle: 'Le montant n’a pas été encaissé',
    notServed: host =>
      `${host} ne sert pas de codes de caisse : rien n’a été ouvert. Demandez à la personne qui exploite ce relais d’activer la caisse, ou utilisez le code dpay.`,
    unreachable: host =>
      `Impossible de joindre ${host} : rien n’a été ouvert. Les codes de caisse se créent en ligne — vérifiez la connexion et réessayez, ou utilisez le code dpay (ce téléphone sait l’afficher hors ligne).`,
    refused: said =>
      `La caisse a refusé ce montant : « ${said} » Rien n’est payable. Corrigez cela, puis recommencez.`,
    refusedNoReason: status =>
      `La caisse a refusé ce montant (HTTP ${status}) sans raison : rien n’est payable. Recommencez ; si elle refuse deux fois, prévenez la personne qui exploite le relais.`,
    mispriced: (encaisse, quoted) =>
      `Vous avez encaissé ${encaisse}, mais la caisse a répondu ${quoted} — dpay n’affichera pas un code pour un montant que personne n’a choisi. Recommencez ; si cela se reproduit, prévenez la personne qui exploite le relais avant d’accepter de l’argent.`,
    unsigned:
      'Ce téléphone n’a pas pu signer le montant : rien n’est payable. Redémarrez dpay, puis recommencez.',
    servedOther: (served, picked) =>
      `La caisse a ouvert ce montant en ${served}, pas en ${picked} — elle ne règle pas encore ${picked}. Recommencez en ${served} ou prévenez la personne qui gère le relais.`,
    tryAgain: 'Réessayer',

    settleOption: (token, currency) => `${token} · ${currency}`,

    settlesAs: (amount, price) =>
      `Vous recevez ${amount} — les frais du registre sont à votre charge, le client paie donc exactement ${price}.`,
    collecting: 'Encaissement du paiement autorisé par le client …',
    collectNotApproved:
      'Le client n’a pas autorisé assez, ou l’autorisation a expiré. Demandez-lui de repayer le code — rien n’a été prélevé.',
    collectNoFunds:
      'Le client a autorisé mais n’a pas l’argent. Rien n’a été prélevé — demandez-lui d’approvisionner son compte et de repayer.',
    collectFailed:
      'Le paiement autorisé n’a pas pu être encaissé, et rien n’a été prélevé. Le code reste payable — demandez-lui de scanner ou de payer sans contact à nouveau.',
    noFeeTitle: 'Cette caisse ne peut pas chiffrer un montant',
    noFee: (symbol, host) =>
      `Les frais du registre sont à la charge du commerce et se déduisent du prix, mais dpay ne connaît aucuns frais pour ${symbol} — un montant facturerait donc silencieusement le client. Rien n’est payable. Mettez dpay à jour, ou signalez à l’exploitant de ${host} que sa liste de devises n’indique pas les frais ${symbol}.`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Montrez ceci au client — n’importe quel appareil photo de téléphone l’ouvre, et un téléphone dpay peut aussi le contacter.'
        : nfc === 'expired'
        ? 'Montrez ceci au client — n’importe quel appareil photo de téléphone l’ouvre. Le paiement sans contact a expiré sur ce code ; ressaisissez le montant pour le sans-contact.'
        : 'Montrez ceci au client — n’importe quel appareil photo de téléphone l’ouvre et paie.',
    waiting: 'En attente du paiement…',
    cantCheck:
      'Impossible de vérifier ce montant — la caisse est injoignable. Cela ne veut PAS dire qu’il est impayé. Laissez le code affiché ; cet écran se met à jour dès le rétablissement du contact.',
    expiredWatching:
      'Ce code a expiré : plus personne ne peut le payer. Si le client a déjà payé, l’argent peut encore arriver — surveillance encore un instant.',
    cancel: "Annuler l'encaissement",
    cancelling: 'Annulation…',
    cancelFailed: said =>
      `Le montant n’a PAS été annulé : « ${said} » Il peut rester payable — décidez avant de remettre quoi que ce soit.`,
    cancelFailedNoReason: status =>
      `Le montant n’a PAS été annulé (HTTP ${status}) : considérez-le comme toujours payable. Réessayez ; ne remettez rien tant qu’il n’est pas annulé ou expiré.`,
    cancelUnreachable: host =>
      `Impossible de joindre ${host} : ce montant n’a donc PAS été annulé — il reste payable jusqu’à son expiration. Réessayez dès que la connexion revient.`,

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
        : 'Le relais ne l’a plus — très probablement parce qu’il a redémarré. Rien n’a été crédité ici. Recommencez ; si le client dit avoir payé, vérifiez d’abord votre solde VCHF et vos Transactions.',
    openChargeNext: 'Client suivant',

    paidAmount: price => `Payé ${price}`,
    paidBlock: block => `Bloc du registre ${block}`,
    paidLate: 'C’est arrivé après l’expiration du code — accepté, l’argent est sur le registre.',
  },
};
