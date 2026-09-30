/**
 * i18n/domains/fr/convert.ts — valeurs françaises pour la surface de conversion déléguée.
 * Types, documentation des clés et copie de référence : ../en/convert.ts. Glossaire : ../../fr.ts.
 * Glossaire : « venue » → plateforme ; « quote » → devis. Le nom de la plateforme arrive en
 * argument (nom d'affichage du registre des venues, jamais codé en dur ici). Les montants et
 * principals arrivent déjà formatés en chaînes d'affichage. Deuxième passe de concision
 * (2026-09-29) : des fragments plutôt que des phrases quand le sens le permet.
 */
import type {ConvertMessages} from '../../keys';

export const convertFr: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Retour au portefeuille',


  amountLabel: sym => `${sym}`,
  maxAmount: 'Max',
  balanceLine: balance => `Solde ${balance}`,
  counterparty: venue => `Exécuté par le pool ${venue}.`,
  counterpartySigns: 'Votre téléphone signe ; le pool prélève exactement le montant approuvé.',
  quoteSource: (at, venue) => `${venue} · ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} a indiqué exactement ${amt}`,
  rateLabel: (inSym, outSym) => `Taux (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Frais du pool : ${tier} (palier ${venue})`,
  inputFeeLine: fee => `Frais d'entrée : ${fee}`,
  outputFeeLine: fee => `Frais de sortie : ${fee}`,
  disclosures: {
    byKey: {
      icpswap: venue => `Tourne sur le propre contrat de pool de ${venue}.`,
      jupiter: venue =>
        `${venue} est un agrégateur on-chain autonome sur Solana — il choisit la route ; la route l'exécute. Ce portefeuille signe la transaction que ${venue} construit, et le devis est celui de ${venue}, tel quel. dpay n'en est pas partie.`,
      sideshift: venue =>
        `${venue} est un service d'échange automatisé — ni un prestataire agréé, ni une banque. Il détient vos fonds pendant l'échange, puis paie vers votre propre adresse ; ses conditions, y compris d'éventuelles vérifications d'identité selon sa politique, sont sur sideshift.ai/terms. Ce portefeuille affiche le devis propre de ${venue} et l'adresse de dépôt — dpay ne signe rien, n'est pas partie et ne touche rien.`,
      trocador: venue =>
        `${venue} est un agrégateur d'échange automatisé — il dirige votre échange vers l'un de ses propres services et détient vos fonds pendant l'échange, puis paie vers votre propre adresse ; ses conditions, y compris d'éventuelles vérifications d'identité d'un service, sont sur trocador.app/terms. dpay demande à ${venue} uniquement des services sans vérification d'identité. Ce portefeuille affiche le devis propre de ${venue} et l'adresse de dépôt — dpay ne signe rien, n'est pas partie et ne touche rien.`,
    },
    generic: venue => `Exécuté par ${venue}.`,
  },
  slippageLabel: 'Slippage',
  refusalLine: sym =>
    `Passé votre minimum, l'échange échoue — votre ${sym} reste dans votre portefeuille et l'autorisation expire sans être utilisée.`,
  detailsLabel: 'Détails',
  staleRefreshing: 'Devis périmé — actualisation…',
  venueSlow: 'Récemment lent à régler.',
  sheetTitle: inSym => `Convertir ${inSym}`,
  youReceive: amt => `Vous recevrez ≈ ${amt}`,
  quoteFetching: venue => `Devis de ${venue}…`,
  autoVenueLine: (venue, at, n) => `${venue} · ${at} · ${n} plateformes`,
  otherVenues: n => `Autres plateformes (${n})`,
  atLeast: amt => `Min ${amt}`,
  ctaConvert: amt => `Convertir ${amt}`,
  rateMoved: (oldAmt, newAmt) => `Le devis a bougé : ${oldAmt} → ${newAmt}. Confirmez à nouveau.`,
  neededVsHave: (need, have) => `${need} nécessaires, vous avez ${have}`,
  smallerAmount: 'Convertissez un montant moins élevé',
  noPathTitle: inSym => `Aucune route depuis ${inSym}`,
  noPathBody: pairs => `Routes aujourd'hui : ${pairs}`,
  noVenueBody: (inSym, outSym) => `Aucun site ne convertit encore ${inSym} en ${outSym}. La paire reste listée ici ; les nouveaux sites apparaîtront dès leur ajout.`,
  noPathAction: 'Ajouter des fonds',
  externalSignTitle: 'Une étape demande votre propre portefeuille Ethereum',
  externalSignBody: 'Vous signez la traversée dans votre propre portefeuille ; dpay n\u2019en détient jamais les clés. Tout le reste reste dans ce volet.',
  signing: 'Signature…',
  swapVia: venue => `Échange via ${venue}`,
  awaitingPool: 'En attente du paiement du pool',
  receivedDone: amt => `Vous avez reçu ${amt}`,
  viaChain: venue => `via ${venue}`,
  depositLegSent: (venue, amt) => `Dépôt de ${amt} envoyé à ${venue}`,
  depositLegPending: (venue, amt) => `Envoi de ${amt} vers ${venue}`,
  composedOrderLine: (venue, amt) => `Ordre chez ${venue}, paiement verrouillé ${amt}`,
  depositRefusedBody: (hopSym, venue) =>
    `Le dépôt vers ${venue} a été refusé — l'échange est passé et vos ${hopSym} sont toujours dans ce portefeuille. Rien de plus ne sera signé : convertissez ou envoyez les ${hopSym} depuis leur propre compte.`,

  sol: {
    heading: (inSym, outSym) => `Convertir ${inSym} en ${outSym} (Solana)`,
    counterparty: venue => `Exécuté par ${venue}.`,
    counterpartySigns: 'Votre téléphone signe la transaction de la plateforme — personne d\u2019autre ne signe rien.',
    priceImpactLine: (pct, venue) => `Impact sur le prix : ${pct} (chiffre propre de ${venue})`,
    solFeeLine: fee => `Frais de réseau Solana : ${fee} (au réseau, pas à la plateforme, pas à dpay)`,
    refusalLine: sym =>
      `Passé le minimum, l'échange échoue entier on-chain — votre ${sym} reste dans votre portefeuille.`,
    pendingBody: 'L\u2019échange est sur Solana — cet écran se résout tout seul.',
    failedBody: (sym, venue, detail) =>
      `L'échange de ${venue} a échoué${detail ? ` (${detail})` : ''} — sur Solana, rien n'a bougé ; votre ${sym} est là où il était.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Pas de ${sym} ici. Pour convertir, recevez d'abord des ${sym} : ouvrez « ${receiveTab} » en bas et choisissez « ${myAddress} ».`,
  fundOtherHolds: (held, toSym) => `Vous avez ${held} — convertissez-le plutôt en ${toSym}.`,
  fundOtherSwitch: sym => `Convertir depuis ${sym} à la place`,
  insufficientLine: (needed, balance) => `${needed} nécessaires, vous avez ${balance}`,

  approvingTitle: 'Approbation en cours',
  approvingBody: (amount, at) =>
    `Approbation : le pool peut prélever exactement ${amount}. Inutilisée, elle expire à ${at}.`,
  swappingTitle: 'Échange en cours',
  swappingBody: venue => `Envoi au pool ${venue} — il ne peut prélever que le montant approuvé.`,
  settlingTitle: 'Règlement',
  settlingBody: sym => `Le pool a accepté — en attente de votre ${sym}…`,
  doneTitle: 'Converti ✓',
  doneBody: amount => `${amount} reçus dans votre portefeuille.`,
  doneTx: tx => `Référence du versement : ${tx}`,
  pendingTitle: 'Versement en attente',
  pendingBody: (sym, pool, at) =>
    `Échange accepté — le versement en ${sym} n'est pas encore arrivé. S'il n'arrive jamais, communiquez ceci au support : pool ${pool}, envoyé à ${at}.`,
  stillWatching: 'Toujours en attente du versement…',
  failedTitle: 'Échange non exécuté',
  failedApproveBody: sym =>
    `Le ledger ${sym} a refusé l'approbation — rien n'a bougé, rien à annuler.`,
  failedSwapBody: (reason, sym, venue) =>
    `Le pool ${venue} a refusé l'échange (${reason}) — votre ${sym} n'a jamais quitté votre portefeuille.`,
  refundedBody: sym =>
    `L'échange a échoué — le pool vous a rendu votre ${sym}. Solde à nouveau intact.`,
  stuckTitle: 'Issue inconnue',
  chainStuckTitle: 'Issue du dépôt inconnue',
  chainStuckBody: venue =>
    `Le dépôt pour ${venue} a été envoyé mais jamais confirmé. Il aboutit de lui-même ou expire — ne l'envoyez jamais une seconde fois.`,
  stop: 'Arrêter',
  stopWatching: 'Arrêter le suivi',
  stopProvider: 'Arrêter le suivi',
  abortedTitle: 'Arrêté',
  abortedClean: 'Rien n’a quitté votre portefeuille.',
  abortedFee: 'Vous avez payé de petits frais d’approbation.',
  abortedWatching: 'L’échange peut encore passer. Vérifiez Soldes plus tard.',
  abortedProvider:
    'Surveillance arrêtée. Sans dépôt envoyé, rien ne peut bouger ; déjà envoyé → l’échange peut encore aboutir. Vérifiez Soldes et la page de statut de la plateforme — l’ID du shift est en dessous.',
  stuckBody:
    'Échange envoyé — la réponse du pool n’est jamais arrivée. Ne lancez pas un second échange.',
  stuckSigned: (amount, minAmount, venue) =>
    `Signé : approuver ${amount} au pool ${venue}, échanger pour un minimum de ${minAmount}.`,
  expiryLine: at => `Expire au plus tard à ${at} — après, plus rien ne peut bouger.`,

  awaitingDepositTitle: 'En attente du dépôt',
  awaitingDepositBody: (sym, venue) =>
    `${venue} attend son dépôt en ${sym} ; l'échange démarre quand il arrive. Si rien n'arrive à temps, le devis expire et rien ne bouge.`,
  providerProcessingTitle: 'Traitement chez la plateforme',
  providerProcessingBody: (sym, venue) =>
    `${venue} détient le dépôt et exécute la commande. Votre ${sym} arrive quand elle termine.`,
  quoteExpiredTitle: 'Devis expiré',
  quoteExpiredBody: (sym, venue) =>
    `Le devis a expiré avant l'arrivée du dépôt : ${venue} a cessé d'attendre, rien n'a été échangé. Un dépôt en retard — la plateforme le renvoie ; dpay continue de surveiller en arrière-plan et cet écran se met à jour tout seul. Votre ${sym} reste où il est.`,
  providerRefundedTitle: 'Remboursé par la plateforme',
  providerRefundedBody: (sym, venue) =>
    `${venue} a annulé la commande et retourné votre ${sym}. Surveillez Soldes.`,
  stuckWatching: 'dpay continue de surveiller — si des fonds bougent, cet écran bascule tout seul.',
  stuckAcknowledge: 'Compris — arrêter la surveillance',
  stuckAcknowledged: 'Surveillance arrêtée — des fonds bougeant plus tard arriveront toujours à l\u2019adresse de ce portefeuille.',

  evm: {
    heading: (inSym, outSym, chain) => `Convertir ${inSym} en ${outSym} (${chain})`,
    feeLabel: unit => `Frais de réseau (${unit}, estimation)`,
    pendingBody: 'L’échange est confirmé sur la chaîne. Attendez que votre solde l’affiche.',
    failedBody: (inSym, detail) => String(detail).includes('approve landed')
      ? `L’échange a échoué après l’approbation. Vos ${inSym} sont toujours dans votre portefeuille ; l’approbation inutilisée ne couvre que le montant exact de l’échange.`
      : `Rien n’a été envoyé. Vos ${inSym} sont toujours dans votre portefeuille.`,
    stuckBody: outSym => `L’échange a pu aboutir ou non. Votre solde de ${outSym} se résoudra de lui-même ; ne lancez pas un second échange.`,
  },
  multihop: {
    destLabel: 'Destination',
    destDirect: sym => `${sym} — dans ce portefeuille`,
    destRoute: (sym, network) => `${sym} — vers votre adresse ${network}`,
    destRouteSol: (sym, network, venue) => `${sym} — vers votre adresse ${network} · dernière étape via ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route : ${inSym} → ${hopSym} (vers ${network})`,
    destAddressLabel: 'Votre propre adresse sur le réseau de destination',
    destAddressInvalid: 'Adresse invalide — attendu : 0x suivi de 40 caractères hexadécimaux.',
    destPayoutNote: 'Les fonds arrivent sur votre propre adresse de wallet.',
    destChange: 'Changer la destination',
    routeHeading: (inSym, hopSym, destSym, network) => `Route : ${inSym} → ${hopSym} → ${destSym} sur ${network}`,
    swapPaysLabel: 'L\u2019échange paie dans ce portefeuille',
    legApprovePull: sym => `Autoriser le pool à prendre vos ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Échanger ${inSym} → ${hopSym} sur ${venue}`,
    legApproveBurn: sym => `Autoriser la combustion de ${sym} (le montant du retrait)`,
    legApproveGas: sym => `Autoriser ${sym} pour payer le gaz du retrait`,
    legWithdraw: (hopSym, destSym, network) => `Brûler ${hopSym} — ${destSym} arrive sur ${network}`,
    legStatePending: 'En attente',
    legStateSent: 'Envoyé',
    legStateConfirmed: 'Confirmé',
    legStateFailed: 'Refusé',
    legProgress: (n, total) => `Étape ${n} sur ${total}`,
    destInWallet: sym => `${sym} — dans ce portefeuille`,
    destGroupOther: 'Autres destinations',
    mechDirect: 'Pool direct',
    mechViaHub: hubSym => `Via ${hubSym}`,
    mechViaCctp: 'Via Circle CCTP',
    mechViaVenue: venue => `Via ${venue}`,
    mechNoneSelected: 'Choisissez un moyen ci-dessus pour voir le devis.',
    viaHub: hubSym => `via ${hubSym} · 2 échanges`,
    hubShape: () => '2 échanges',
    routeMinWalletLine: amount => `Min ${amount} dans ce portefeuille`,
    hubQuoteSource: (venue1, venue2, at) => `${venue1} + ${venue2} · ${at}`,
    hubCensusHeading: 'Deux échanges, détaillés un par un',
    approveFeeLine: amount => `L\u2019autorisation du prochain pool coûte ${amount} (les propres frais de transfert du registre)`,
    hubRateLine: (inSym, destSym) => `Taux combiné ${inSym} → ${destSym} :`,
    hubSurplusNote: (hubSym, destSym) =>
      `Au-dessus du plancher, l'excédent reste dans ce portefeuille en ${hubSym} ou en ${destSym}.`,
    gasFeeLine: amount => `Gaz du retrait (devis en direct) : ${amount}`,
    routeMinLine: amount => `Min ${amount} à votre adresse`,
    routeSurplusNote: hopSym => `Au-dessus du plancher, l'excédent reste dans ce portefeuille en ${hopSym}.`,
    routeDestEstimate: (amount, sym) =>
      `Atterrit \u2248 ${amount} ${sym} à votre adresse Solana — la dernière étape Jupiter requote en direct`,
    routeVenues: (icVenue, solVenue) => `Route : ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'D\u2019abord le gaz',
    gasPreflightBody: needed =>
      `Brûler vers Ethereum demande environ ${needed} de gaz en ckETH — ce portefeuille en détient trop peu. Procure-vous du ckETH dans ce portefeuille d'abord, puis revenez.`,
    executingTitle: 'Route en cours',
    doneRouteTitle: 'Retrait en route',
    doneRouteBody: (amount, address) => `Au moins ${amount} est en route vers ${address}.`,
    doneOnItsWay: 'La livraison passe par Ethereum et peut prendre du temps — dpay ne peut pas surveiller ce réseau.',
    failedLegTitle: 'Retrait refusé',
    failedLegBody: (sym, reason) =>
      `L'échange est passé — vos fonds sont en ${sym} dans ce portefeuille. Le retrait a été refusé${reason ? ` : ${reason}` : ''}.`,
    failedLegExit: 'Retirer via Payer ▸ Vers une adresse — collez n\u2019importe quelle adresse de destination.',
    stuckRouteBody: 'L\u2019issue d\u2019une étape reste inconnue — dpay surveille les registres ; cet écran change tout seul.',
    failedHop2Title: 'Second échange refusé',
    failedHop2Body: (hubSym, outSym, reason) =>
      `Le premier échange est passé — vous détenez ${hubSym} dans ce portefeuille. L'échange ${hubSym} → ${outSym} a été refusé${reason ? ` : ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Vos ${hubSym} sont dépensables tels quels — gardez-les, convertissez-les ou envoyez-les. Rien à annuler.`,
    stuckHoldsLine: hubSym => `Jusqu'ici : ${hubSym} dans ce portefeuille.`,
    insufficientHubLine: (needed, balance) =>
      `Il faut ${needed} — le montant plus trois frais — vous avez ${balance}.`,
  },

  cefi: {
    destRow: (sym, network, venue) => `${sym} sur ${network} — via ${venue} (service d'échange)`,
    destRowMulti: (sym, network) => `${sym} sur ${network}`,
    settleAddressLabel: 'Le paiement arrive sur votre propre adresse',
    settleRailEthereum: 'Le paiement est versé en ETH natif sur Ethereum mainnet',
    depositAddressLabel: 'Adresse de dépôt',
    depositAmountLabel: 'Montant exact',
    depositMemoLabel: 'Memo (obligatoire)',
    counterparty: venue =>
      `Exécuté par ${venue} — un service d'échange automatisé, ni une banque, ni dpay.`,
    checklistSigns:
      'Rien n\'est signé sur ce téléphone — après confirmation, c\'est vous qui envoyez le dépôt à l\'adresse du service.',
    refusalLine: sym =>
      `Si le dépôt n'arrive jamais, l'ordre expire — rien ne bouge et votre ${sym} reste dans votre portefeuille.`,
    insufficientLine: (needed, balance) =>
      `Le dépôt exige ${needed} (frais de transfert inclus) — vous avez ${balance}.`,
    payoutAt: address => `Payé sur votre propre adresse : ${address}`,
    depositExpiryLine: at => `L'ordre expire ${at}`,
    noExpiryLine: 'Pas d’expiration publiée — dpay continue de surveiller.',
    lastCheckedLine: at => `Dernière vérification : ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: 'Fonds confirmés — votre versement est verrouillé au montant coté.',
    settlingWatchLine: 'La plupart se règlent en minutes — dpay surveille chaque shift et intervient si l\u2019un bloque.',
    depositNote: (venue, sym) =>
      `Envoyez ${sym} depuis votre portefeuille vers l'adresse de dépôt de ${venue} ci-dessus — exactement le montant indiqué. ${venue} le détient pendant l'échange, puis paie vers votre adresse. dpay n'est pas partie et ne touche rien.`,
    stillWaitingDeposit: 'Toujours en attente de votre dépôt — cet écran se met à jour tout seul.',
    depositSolFeeNote: 'Le dépôt paie aussi de petits frais de réseau en SOL — gardez un peu de SOL dans ce portefeuille.',
    solInsufficientLine: (needed, balance) =>
      `Le dépôt envoie exactement ${needed} — vous avez ${balance}.`,
    noQuoteTitle: 'Pas de marché en direct',
    noQuoteBody: venue =>
      `${venue} référence cette paire mais n\u2019a pas de marché en direct pour le moment. Rien n\u2019a été envoyé. Choisissez une autre plateforme ou réessayez plus tard.`,
    minDepositBody: (venue, venueMessage, min) =>
      `${venue} a refusé ce montant : « ${venueMessage} » (minimum ${min}). Rien n\u2019a été envoyé — augmentez le montant et réessayez.`,
  },

  chain: {
    depositSending: venue => `Envoi du dépôt à ${venue}`,
    orderLine: (venue, depositAmt, midSym) => `Commande chez ${venue} : ${depositAmt} en entrée, ${midSym} en sortie`,
    depositSent: (venue, depositAmt, midSym) => `${depositAmt} envoyé à ${venue} — en attente du paiement en ${midSym}`,
    phase2Note: 'La seconde étape tourne seule dès que le paiement arrive.',
    phase2Leg: (midSym, outSym, venue) => `Puis ${midSym} → ${outSym} via ${venue} — requoté à l\u2019arrivée du paiement`,
    rowShape: midSym => `via ${midSym}, se convertit d’un appui`,
    phase2Failed: midSym => `La seconde étape n\u2019a pas pu s\u2019exécuter — vos ${midSym} sont dans ce portefeuille. Convertissez-les normalement (présélectionné).`,
    depositFailed: sym => `Le dépôt n’a jamais atterri on-chain — vos ${sym} n’ont jamais quitté le portefeuille.`,
  },

  crossrail: {
    heading: 'Signer dans votre portefeuille Ethereum',
    handoffIntro: (amount) =>
      `Partie IC faite : ${amount} est à votre adresse Ethereum. Votre portefeuille le fait traverser — dpay ne touche jamais à vos clés Ethereum.`,
    stepApproveLabel: 'Étape 1 — autoriser le contrat de Circle à déplacer les USDC',
    stepBurnLabel: 'Étape 2 — brûler les USDC pour le transfer vers Solana',
    txAmountLabel: 'Montant',
    copy: 'Copier',
    copied: 'Copié',
    approveHint: 'Autorisez le TokenMessenger de Circle à déplacer exactement ces USDC — rien de plus.',
    burnHint: 'Verrouillez les USDC sur Ethereum ; le pont de Circle frappe ces mêmes USDC à votre adresse Solana — pas de jeton enveloppé.',
    timingNote: 'Voie rapide : de quelques secondes à quelques minutes (~20 s mesurés). Ethereum chargé, plus longtemps — cet écran se met à jour tout seul.',
    externalGasLine: 'Le gaz se paie avec l\u2019ETH de votre propre portefeuille — dpay ne peut ni le payer ni le chiffrer exactement.',
    circleFeeLine: fee => `Frais du pont de Circle (son propre chiffre, sur le montant) : au plus ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Min ${floor} ${sym} à votre adresse Solana — la dernière étape échange vers votre destination`,
    mintFloorDestLine: (floor, sym) => `Au moins ${floor} ${sym} arrivent à votre adresse Solana`,
    burnTxLabel: 'Hash de la tx de burn (de votre portefeuille)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Je l\u2019ai signé — surveiller la traversée',
    burnTxInvalid: 'Pas un hash de transaction Ethereum.',
    declineButton: 'Je ne signe pas',
    whatSigning: 'Vous signez deux transactions Ethereum ordinaires dans votre propre portefeuille : une approbation, puis le burn. Rien n\u2019est signé côté dpay.',
    crossingTitle: 'Traversée vers Solana',
    crossingBody: 'Circle atteste le burn et frappe les USDC à votre adresse Solana — dpay surveille le flux d\u2019état de Circle.',
    viewBurnTx: 'Voir la transaction de burn',
    viewCircle: 'Page d\u2019état de Circle',
    stillCrossing: 'Encore en attente — pas un échec. Voie rapide : secondes à minutes ; Ethereum congestionné, plus longtemps.',
    solReadyTitle: 'Les USDC sont arrivés sur Solana',
    solReadyBody: (credit, ata) => `${credit} vérifiés à ${ata}. Terminez la route — ou gardez les USDC ; ils sont à vous dans les deux cas.`,
    abortedCrossing: ata =>
      `Suveillance arrêtée. Votre burn est déjà parti — Circle peut encore compléter le mint ; l’USDC arrive de toute façon à votre propre adresse Solana ${ata}. Vérifiez Soldes plus tard.`,
    abortedSolReady: ata =>
      `Rien n’a été signé — l’échange final n’a jamais été lancé. Vos USDC sont à votre adresse Solana ${ata} : gardez-les ou convertissez-les là-bas.`,
    solQuoteLabel: venue => `Devis ${venue}`,
    solMinLine: (min, sym) => `Min ${min} ${sym} à votre adresse`,
    solConfirmButton: sym => `Échanger contre ${sym}`,
    solFeeLine: fee => `Frais Solana : ${fee}`,
    solPreflightTitle: 'SOL nécessaire pour les frais',
    solPreflightBody:
      'Les frais se paient en SOL et ce portefeuille n\u2019en détient pas. Ajoutez un peu de SOL — les USDC restent en place.',
    doneTitle: 'Converti',
    doneBody: (amount, sym, address) => `${amount} ${sym} sont à votre adresse Solana ${address} — vérifié on-chain.`,
    doneVia: (icVenue, solVenue) => `Via ${icVenue}, Circle et ${solVenue}.`,
    declinedTitle: 'Remise annulée',
    declinedBody: address =>
      `Rien n\u2019a traversé. Vos USDC sont à votre propre adresse Ethereum ${address} — envoyez-les où vous voulez ou relancez cette route plus tard.`,
    solFailedTitle: 'L\u2019échange Solana a échoué',
    solFailedBody: (ata, venue) =>
      `Les USDC ont déjà traversé — ils sont à votre adresse Solana ${ata}. ${venue} a refusé l\u2019échange final : réessayez ici dans un instant ou gardez les USDC.`,
    legCctpBurn: (sym, network) => `Emmener ${sym} vers ${network} via Circle (vous signez ça dans votre portefeuille)`,
    legSolSwap: (venue, sym) => `Échanger contre ${sym} sur ${venue}`,
    destAddressCrossNote: 'Cette adresse signe aussi la traversée — collez une adresse que vous contrôlez.',
    checksumMismatch: 'Erreur de checksum',
    retypeAddress: 'Retapez l\u2019adresse',
    retypeMismatch: 'Ne correspond pas',
    gasFundTitle: 'Il manque du gaz ETH',
    gasFundNeed: eth => `Besoin \u2248 ${eth}`,
    gasFundHave: eth => `Votre portefeuille : ${eth}`,
    gasFundWalletButton: 'Financer depuis ce portefeuille',
    gasFundSelfButton: 'Je le finance moi-même',
    gasFundSelfMin: eth => `Envoyez \u2265 ${eth} à :`,
    gasFundRecheck: 'Revérifier',
    gasFundShort: short => `Il manque toujours ${short}`,
    gasLegsNote: 'Les premières étapes financent le gaz.',
    abortedGasBody: 'Le financement du gaz est arrivé — toujours dans ce portefeuille. La conversion n\u2019a jamais été lancée.',
    declinedWithGasBody: address => `Rien n\u2019a traversé. Vos USDC sont à votre adresse Ethereum ${address} ; le gaz financé est toujours dans ce portefeuille.`,
    gasShortFailedBody: needed => `Le financement du gaz est resté sous ${needed}. Rien n\u2019a quitté ce portefeuille — la conversion n\u2019a jamais démarré.`,
  },

  errors: {
    quoteUnreachable: venue => `${venue} était inaccessible via le relay de dpay. Rien n'a été envoyé — vérifiez votre connexion et réessayez dans un instant.`,
    quoteRefused: venue => `${venue} a refusé pour l'instant d'établir un devis pour cette paire.`,
    buildRefused: venue => `${venue} n'a pas pu préparer cet échange. Rien n'a bougé — réessayez dans un instant.`,
    quoteUnavailable: code => `Devis indisponible (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} n'est pas encore configuré sur ce relay — aucun devis ne peut être demandé. Votre portefeuille n'a aucun problème.`,
    gasUnavailable: 'Le prix du gaz du minter était indisponible — rien n\u2019a été signé. Réessayez.',
    cctpFeeUnavailable: 'Les frais du pont de Circle n\u2019ont pas pu être récupérés — rien n\u2019a été signé. Vérifiez votre connexion et réessayez.',
    chainDepositUnreadable: venue =>
      `L\u2019adresse de dépôt de ${venue} n\u2019a pas pu être vérifiée sur Solana — rien n\u2019a été signé. Vérifiez votre connexion et réessayez, ou envoyez le dépôt depuis votre propre portefeuille.`,
    chainSenderEmpty: sym => `Pas de compte de jetons ${sym} dans ce portefeuille — rien n\u2019a été signé. Recevez d\u2019abord des ${sym}.`,
    chainSenderShort: sym => `Le solde de ${sym} du portefeuille ne couvre pas ce montant — rien n\u2019a été signé.`,
    chainRentShort: sym => `Le compte ${sym} de la plateforme demande un peu de SOL pour le loyer — le portefeuille n’en a pas assez. Rien n\u2019a été signé ; rechargez en SOL et réessayez.`,
  },
};
