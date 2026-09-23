/**
 * i18n/domains/fr/convert.ts — valeurs françaises pour la surface de conversion déléguée.
 * Types, documentation des clés et copie de référence : ../en/convert.ts. Glossaire : ../../fr.ts.
 * Glossaire : « venue » → plateforme ; « quote » → devis. Le nom de la plateforme arrive en
 * argument (nom d'affichage du registre des venues, jamais codé en dur ici). Les montants et
 * principals arrivent déjà formatés en chaînes d'affichage.
 */
import type {ConvertMessages} from '../../keys';

export const convertFr: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Retour au portefeuille',

  unavailableTitle: sym => `La conversion n'est pas encore disponible pour ${sym}`,
  unavailableBody: (pair, venue) => `Aujourd'hui, dpay convertit ${pair} via ${venue} — et rien d'autre.`,

  amountLabel: sym => `Montant (${sym})`,
  maxAmount: 'Max',
  balanceLine: balance => `Solde : ${balance}`,
  receiveHeadline: 'Tu recevras',
  counterparty: venue => `Exécuté par le pool ${venue}.`,
  counterpartySigns: 'Ton téléphone signe ; le pool prélève exactement le montant approuvé.',
  quoteSource: (at, venue) => `Devis ${venue}, récupéré ${at}`,
  rateLabel: (inSym, outSym) => `Taux de ce devis (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Frais du pool : ${tier} (palier ${venue})`,
  inputFeeLine: fee => `Frais d'entrée : ${fee}`,
  outputFeeLine: fee => `Frais de sortie : ${fee}`,
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (la clé du registre pour les pools ICPSwap) : le fait propre à
      // la venue est OÙ tourne l'échange — son propre contrat de pool.
      icpswap: venue => `L'échange s'exécute sur le propre contrat de pool de ${venue}.`,
      // disclosure_key 'jupiter' (la clé du registre pour la ligne de la venue Solana) : les faits
      // propres à la venue sont CE qu'est Jupiter — un agrégateur on-chain autonome — et que le
      // devis est le sien, affiché tel qu'il le publie, tandis que dpay reste hors de l'échange.
      // Ton miroir de icpswap : attribuer, nommer le signataire, nier la partie.
      jupiter: venue =>
        `${venue} est un agrégateur on-chain autonome sur Solana — il choisit la route et la route l'exécute. Ce portefeuille signe la transaction que ${venue} construit, et le devis est celui de ${venue}, affiché exactement comme il le publie. dpay n'en est pas partie.`,
      // disclosure_key 'sideshift' (la clé de la première venue CeFi, 2026-09-15) : les faits
      // CeFi fixés par le fondateur — un service d'échange automatisé détenant les fonds
      // pendant l'échange, pas un prestataire agréé ; le KYC selon SA politique est à LUI de
      // le divulguer (ses propres conditions publiées sont nommées) ; dpay n'est pas partie
      // et ne touche rien (le relay épinglé commissionRate « 0 »).
      sideshift: venue =>
        `${venue} est un service d'échange automatisé — ni un prestataire agréé, ni une banque. Il détient tes fonds pendant l'échange, puis paie vers ta propre adresse ; ses conditions, y compris d'éventuelles vérifications d'identité selon sa politique, sont publiées sur sideshift.ai/terms. Ce portefeuille t'affiche le devis propre de ${venue} et l'adresse de dépôt, et dpay ne signe rien. dpay n'est pas partie à l'échange et ne touche rien.`,

      // disclosure_key 'trocador' (la clé du registre pour la première ligne CeFI
      // d'AGRÉGATEUR, 2026-09-20) : les mêmes vérités CeFi que sideshift — un service
      // d'échange automatisé détenant les fonds pendant l'échange, conditions nommées,
      // dpay n'est pas partie et ne touche rien — plus le fait d'agrégateur : la venue
      // choisit parmi ses propres services (dpay ne classe jamais en dessous de ce choix)
      // et on ne lui demande que des services sans vérification d'identité.
      trocador: venue =>
        `${venue} est un agrégateur d'échange automatisé — il dirige ton échange vers l'un de ses propres services d'échange et détient tes fonds pendant l'échange, puis paie vers ta propre adresse ; ses conditions, y compris d'éventuelles vérifications d'identité qu'un service peut appliquer, sont publiées sur trocador.app/terms. dpay demande à ${venue} des services sans vérification d'identité. Ce portefeuille t'affiche le devis propre de ${venue} et l'adresse de dépôt, et dpay ne signe rien. dpay n'est pas partie à l'échange et ne touche rien.`,
    },
    generic: venue => `Cette conversion est exécutée par ${venue}.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum garanti : ${amount} (${pct} de slippage)`,
  refusalLine: sym =>
    `Si le prix du pool dépasse ton minimum, l'échange échoue : ton ${sym} reste dans ton portefeuille et l'autorisation expire sans être utilisée.`,
  detailsLabel: 'Détails',
  confirmButton: 'Actualiser le devis et confirmer',
  staleRefreshing: 'Devis périmé — actualisation…',
  quoteChanged: (oldAmt, newAmt) => `Le devis a changé : ${oldAmt} → ${newAmt}. Vérifie et confirme à nouveau.`,
  venueChooserLabel: 'Plateforme',
  venueNoneSelected: 'Choisis une plateforme pour voir son devis complet et continuer.',
  venueSlow: 'Récemment lent à régler.',

  sol: {
    heading: (inSym, outSym) => `Convertir ${inSym} en ${outSym} (Solana)`,
    unavailableTitle: sym => `${sym} ne peut pas encore être converti`,
    unavailableBody: (sym, venue) =>
      `Les conversions d'actifs Solana passent par une venue Solana enregistrée (${venue} aujourd'hui). Aucune venue ne sert ${sym} pour l'instant — rien n'a été proposé, rien n'a bougé.`,
    counterparty: venue => `Exécuté par ${venue}.`,
    counterpartySigns: 'Ton téléphone signe la transaction que la venue a construite — personne d\u2019autre ne signe rien.',
    priceImpactLine: (pct, venue) => `Impact sur le prix : ${pct} (chiffre propre de ${venue})`,
    solFeeLine: fee => `Frais de réseau Solana : ${fee} (payés au réseau, pas à la venue, pas à dpay)`,
    refusalLine: sym =>
      `Si le prix dépasse le minimum, la transaction échoue on-chain : ton ${sym} reste dans ton portefeuille et rien d'autre n'a été signé.`,
    pendingBody:
      'La transaction d\u2019échange est sur le réseau Solana. Cet écran observe la chaîne elle-même et se résout de lui-même — sans recharger, sans réessayer.',
    failedBody: (sym, venue, detail) =>
      `La transaction d'échange de ${venue} a échoué${detail ? ` (${detail})` : ''}. Sur Solana, une transaction échouée ne déplace jamais de fonds — ton ${sym} est là où il était.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Ce portefeuille n'a pas de ${sym}. Pour convertir des ${sym}, reçois d'abord des ${sym} à ton adresse : ouvre « ${receiveTab} » en bas et choisis « ${myAddress} ».`,
  fundOtherHolds: (held, toSym) => `Tu as ${held} — tu peux plutôt le convertir en ${toSym}.`,
  fundOtherSwitch: sym => `Convertir depuis ${sym} à la place`,
  insufficientLine: (needed, balance) =>
    `Cette conversion demande ${needed} — le montant plus deux frais de ledger — et ce portefeuille détient ${balance}. Baisse le montant, ou reçois-en d'abord davantage.`,

  approvingTitle: 'Approbation en cours',
  approvingBody: (amount, at) =>
    `Ton téléphone approuve le prélèvement exact de ${amount} par le pool. L'autorisation expire à ${at} si elle ne sert pas.`,
  swappingTitle: 'Échange en cours',
  swappingBody: venue => `Envoi de l'échange au pool ${venue}. Il ne peut prélever que le montant approuvé.`,
  settlingTitle: 'Règlement',
  settlingBody: sym => `Le pool a accepté l'échange. En attente de ton ${sym} dans ton portefeuille…`,
  doneTitle: 'Converti ✓',
  doneBody: amount => `${amount} reçus dans ton portefeuille.`,
  doneTx: tx => `Référence du versement : ${tx}`,
  pendingTitle: 'Versement en attente',
  pendingBody: (sym, pool, at) =>
    `Le pool a accepté l'échange, mais le versement en ${sym} n'est pas encore arrivé dans ton portefeuille. Cet écran continue de surveiller — rien à faire pour l'instant. S'il n'arrive jamais, communique ceci au support : pool ${pool}, échange envoyé à ${at}.`,
  stillWatching: 'Toujours en attente du versement…',
  failedTitle: 'Échange non exécuté',
  failedApproveBody: sym =>
    `Le ledger ${sym} a refusé l'approbation, donc rien n'a bougé — tu possèdes toujours chaque unité de ton ${sym}. Aucune autorisation n'a été créée ; rien à rembourser ni à annuler.`,
  failedSwapBody: (reason, sym, venue) =>
    `Le pool ${venue} a refusé l'échange (${reason}). Ton ${sym} n'a jamais quitté ton portefeuille — rien d'autre n'est nécessaire.`,
  refundedBody: sym =>
    `L'échange a échoué et le pool t'a rendu ton ${sym} — ton solde est de nouveau intact.`,
  stuckTitle: 'Issue inconnue',
  stop: 'Arrêter',
  stopWatching: 'Arrêter le suivi',
  abortedTitle: 'Arrêté',
  abortedClean: 'Rien n’a quitté votre portefeuille.',
  abortedFee: 'Vous avez déjà payé des petits frais d’approbation.',
  abortedWatching: 'L’échange peut encore passer. Vérifiez Soldes plus tard.',
  stuckBody:
    'L’échange a été envoyé, mais la réponse du pool n’est pas arrivée. Ne lance pas un second échange avec les mêmes fonds. Si le versement arrive, cet écran passera tout seul à « Converti ».',
  stuckSigned: (amount, minAmount, venue) =>
    `Ce qui a été signé : approuver ${amount} au pool ${venue} ; échanger pour un minimum de ${minAmount}.`,
  expiryLine: at => `Les instructions signées expirent au plus tard à ${at} — après, plus rien ne peut bouger.`,

  awaitingDepositTitle: 'En attente du dépôt',
  awaitingDepositBody: (sym, venue) =>
    `${venue} a émis cette commande et attend son dépôt en ${sym}. L'échange s'exécute quand le prestataire voit le dépôt ; dpay continue de surveiller son statut. Si aucun dépôt n'arrive à temps, le devis expire et rien ne bouge.`,
  providerProcessingTitle: 'Traitement chez le prestataire',
  providerProcessingBody: (sym, venue) =>
    `${venue} détient le dépôt et exécute la commande. Ton ${sym} arrive quand le prestataire la termine — dpay continue de surveiller jusqu'à sa résolution.`,
  quoteExpiredTitle: 'Devis expiré',
  quoteExpiredBody: (sym, venue) =>
    `Le devis a expiré avant l'arrivée du dépôt : ${venue} a cessé d'attendre, donc rien n'a été échangé. Si un dépôt arrive quand même en retard, la plateforme le renvoie — dpay continue de surveiller en arrière-plan et cet écran se met à jour tout seul. Ton ${sym} reste où il est entre-temps.`,
  providerRefundedTitle: 'Remboursé par le prestataire',
  providerRefundedBody: (sym, venue) =>
    `${venue} a annulé cette commande et retourné le dépôt. Surveille le retour de ton ${sym}.`,
  stuckWatching: 'dpay continue de surveiller ceci en arrière-plan. Si le paiement ou le remboursement arrive, cet écran bascule tout seul.',
  stuckAcknowledge: 'Compris — arrêter la surveillance',
  stuckAcknowledged: 'Tu en as pris note et la surveillance en arrière-plan est arrêtée. Si des fonds bougent plus tard, ils arriveront toujours à l\u2019adresse de ce portefeuille.',

  multihop: {
    destLabel: 'Destination',
    destDirect: sym => `${sym} — dans ce portefeuille`,
    destRoute: (sym, network) => `${sym} — vers ton adresse ${network}`,
    destRouteSol: (sym, network, venue) => `${sym} — vers ton adresse ${network} · dernière étape via ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route : ${inSym} → ${hopSym} (vers ${network})`,
    destInWallet: sym => `${sym} — dans ce portefeuille`,
    mechDirect: 'Pool direct',
    mechViaHub: hubSym => `Via ${hubSym}`,
    mechViaCctp: 'Via Circle CCTP',
    mechViaVenue: venue => `Via ${venue}`,
    mechNoneSelected: 'Choisis un moyen ci-dessus pour voir le devis.',
    viaHub: hubSym => `via ${hubSym} · 2 échanges`,
    hubShape: () => '2 échanges',
    routeMinWalletLine: (amount, pct) => `Au moins ${amount} restent dans ce portefeuille (plancher de glissement ${pct})`,
    hubQuoteSource: (venue1, venue2, at) => `Devis de ${venue1} et ${venue2}, obtenus ${at}`,
    hubCensusHeading: 'Deux échanges, détaillés un par un',
    approveFeeLine: amount => `L\u2019autorisation du prochain pool coûte ${amount} (les propres frais de transfert du registre)`,
    hubRateLine: (inSym, destSym) => `Taux combiné ${inSym} → ${destSym} :`,
    hubSurplusNote: (hubSym, destSym) =>
      `Si un échange paie au-dessus de son plancher, le surplus reste dans ce portefeuille en ${hubSym} ou en ${destSym}.`,
    destAddressLabel: 'Ta propre adresse sur le réseau de destination',
    destAddressInvalid: 'Adresse de destination invalide — attendu : 0x suivi de 40 caractères hexadécimaux.',
    routeHeading: (inSym, hopSym, destSym, network) => `Route : ${inSym} → ${hopSym} → ${destSym} sur ${network}`,
    swapPaysLabel: 'L\u2019échange paie dans ce portefeuille',
    legApprovePull: sym => `Autoriser le pool à prendre tes ${sym}`,
    legSwap: (venue, inSym, hopSym) => `Échanger ${inSym} → ${hopSym} sur ${venue}`,
    legApproveBurn: sym => `Autoriser la combustion de ${sym} (le montant du retrait)`,
    legApproveGas: sym => `Autoriser ${sym} pour payer le gaz du retrait`,
    legWithdraw: (hopSym, destSym, network) => `Brûler ${hopSym} — ${destSym} arrive sur ${network}`,
    legStatePending: 'En attente',
    legStateSent: 'Envoyé',
    legStateConfirmed: 'Confirmé',
    legStateFailed: 'Refusé',
    legProgress: (n, total) => `Étape ${n} sur ${total}`,
    gasFeeLine: amount => `Gaz du retrait (devis en direct du minter) : ${amount}`,
    routeMinLine: (amount, pct) => `Au moins ${amount} à ton adresse (plancher de glissement ${pct})`,
    routeSurplusNote: hopSym => `Si l\u2019échange paie au-dessus du plancher, l\u2019excédent reste dans ce portefeuille en ${hopSym}.`,
    routeDestEstimate: (amount, sym) =>
      `Arrivée estimée : \u2248 ${amount} ${sym} à ton adresse Solana — la dernière étape passe par Jupiter avec une cotation fraîche`,
    routeVenues: (icVenue, solVenue) => `Route : ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Le retrait exige du gaz d\u2019abord',
    gasPreflightBody: needed =>
      `Brûler vers Ethereum coûte un gaz payé en ckETH, et ce portefeuille n\u2019en a pas assez. Il en faut environ ${needed} (le devis de gaz en direct du minter plus ses frais d\u2019autorisation). Procure-toi du ckETH dans ce portefeuille d\u2019abord, puis reviens — acheter une part de gaz ici est un travail futur, et dpay ne te cachera pas ce coût.`,
    executingTitle: 'Route en cours',
    doneRouteTitle: 'Retrait en route',
    doneRouteBody: (amount, address) => `Au moins ${amount} est en route vers ${address}.`,
    doneOnItsWay: 'La livraison se fait sur Ethereum et peut prendre du temps — dpay ne peut pas surveiller ce réseau. Tu n\u2019as rien de plus à faire.',
    failedLegTitle: 'L\u2019étape du retrait a été refusée',
    failedLegBody: (sym, reason) =>
      `L\u2019échange a bien eu lieu — tes fonds sont en ${sym} dans ce portefeuille, rien de perdu ni de bloqué. Le retrait a été refusé${reason ? ` : ${reason}` : ''}.`,
    failedLegExit: 'Pour retirer, ouvre Payer, choisis Vers une adresse et colle n\u2019importe quelle adresse de destination — l\u2019étape de retrait part de là.',
    stuckRouteBody: 'Une étape a été envoyée mais son issue reste inconnue. dpay continue de surveiller les registres en arrière-plan ; dès que le paiement ou le remboursement arrive, cet écran changera tout seul.',
    failedHop2Title: 'Le second échange a été refusé',
    failedHop2Body: (hubSym, outSym, reason) =>
      `Le premier échange est passé — tu détiens ${hubSym} dans ce portefeuille, rien n\u2019est perdu ni bloqué. L\u2019échange ${hubSym} → ${outSym} a été refusé${reason ? ` : ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Tes ${hubSym} sont dépensables tels quels : garde-les, convertis-les plus tard depuis leur propre compte, ou envoie-les. Rien à annuler.`,
    stuckHoldsLine: hubSym => `Accompli jusqu\u2019ici : tu détiens ${hubSym} dans ce portefeuille.`,
    insufficientHubLine: (needed, balance) =>
      `Cette conversion nécessite ${needed} — le montant plus trois frais de registre — et ce portefeuille détient ${balance}. Baisse le montant, ou reçois d\u2019abord plus.`,
  },

  /** Venues CeFi (élargissement SideShift, 2026-09-15) : la remise du dépôt. La venue
   *  détient les fonds pendant l'échange ; le dépôt de l'utilisateur EST le mouvement de
   *  valeur — dpay ne signe rien. Chaque adresse/montant affiché est celui de la venue,
   *  tel quel. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} sur ${network} — via ${venue} (service d'échange)`,
    destRowMulti: (sym, network) => `${sym} sur ${network}`,
    settleAddressLabel: 'Le paiement arrive sur ta propre adresse sur le réseau de destination',
    depositAddressLabel: 'Adresse de dépôt',
    depositAmountLabel: 'Montant exact à déposer',
    depositMemoLabel: 'Memo (obligatoire)',
    depositExpiryLine: at => `L'ordre expire ${at}`,
    noExpiryLine: 'Pas d’expiration publiée — dpay continue de surveiller jusqu’à ce que la plateforme résolve la commande.',
    lastCheckedLine: at => `Dernière vérification : ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: `Fonds confirmés auprès de la plateforme — votre versement est verrouillé au montant coté.`,
    settlingWatchLine: `La plupart des conversions sont réglées en quelques minutes. dpay surveille chaque shift et intervient auprès de la plateforme si l'un bloque — rien à faire de votre côté.`,
    counterparty: venue =>
      `Exécuté par ${venue} — un service d'échange automatisé, pas un prestataire agréé et pas dpay.`,
    checklistSigns:
      'Rien n\'est signé sur ce téléphone — après confirmation, c\'est toi qui envoies le dépôt à l\'adresse du service.',
    refusalLine: sym =>
      `Si le dépôt n'arrive pas, l'ordre expire — rien ne bouge et ton ${sym} reste dans ton portefeuille.`,
    insufficientLine: (needed, balance) =>
      `Ce dépôt exige ${needed} — le montant plus un seul frais de transfert — et ce portefeuille détient ${balance}. Réduis le montant ou reçois d'abord davantage.`,
    payoutAt: address => `Payé sur ta propre adresse : ${address}`,
    depositNote: (venue, sym) =>
      `Envoie ${sym} depuis ton portefeuille vers l'adresse de dépôt de ${venue} ci-dessus — exactement le montant indiqué. ${venue} est un service d'échange automatisé : il détient ton ${sym} pendant l'échange, puis paie vers ton adresse. dpay n'est pas partie à cet échange et ne touche rien.`,
    stillWaitingDeposit: 'Toujours en attente de ton dépôt — cet écran se met à jour tout seul.',
    depositSolFeeNote: 'L\u2019envoi du dépôt paie aussi de petits frais de réseau en SOL — garde un peu de SOL dans ce portefeuille.',
    solInsufficientLine: (needed, balance) =>
      `Ce dépôt envoie exactement ${needed} et ce portefeuille détient ${balance}. Réduis le montant ou reçois d\u2019abord davantage.`,
  },

  /** La famille cross-rail (routes B/C, 2026-09-16) : tout ce qui suit les cinq jambes IC —
   *  la remise CCTP (dpay affiche les transactions exactes, c\u2019est le portefeuille Ethereum
   *  PROPRE de l\u2019utilisateur qui signe ; dpay ne détient jamais de clé EVM), l\u2019attente de
   *  l\u2019attestation de Circle et l\u2019offre finale de Jupiter en route C. Chaque impasse nomme
   *  où se trouvent les fonds et la sortie. */
  crossrail: {
    heading: 'Signer dans ton portefeuille Ethereum',
    handoffIntro: (amount) =>
      `La partie Internet Computer est faite : ${amount} est arrivé à ton adresse Ethereum. Ton portefeuille l\u2019envoie maintenant de l\u2019autre côté — dpay ne touche jamais à tes clés Ethereum.`,
    stepApproveLabel: 'Étape 1 — autoriser le contrat de Circle à déplacer les USDC',
    stepBurnLabel: 'Étape 2 — brûler les USDC pour le transfer vers Solana',
    txAmountLabel: 'Montant',
    copy: 'Copier',
    copied: 'Copié',
    approveHint: 'Cela autorise le TokenMessenger de Circle à déplacer exactement les USDC envoyés — rien de plus.',
    burnHint: 'Cela verrouille les USDC sur Ethereum. Le pont de Circle frappe ensuite ces mêmes USDC à ton adresse Solana — pas de jeton enveloppé, Circle exécute l\u2019arrivée pour toi.',
    timingNote: 'Sur la voie rapide, l\u2019arrivée prend typiquement de quelques secondes à quelques minutes (~20 s lors de notre vérification en direct). Si Ethereum est chargé, cela peut durer plus longtemps — cet écran se met à jour tout seul.',
    externalGasLine: 'Le gaz Ethereum de ces deux transactions est payé par l\u2019ETH de ton propre portefeuille. dpay ne peut ni le payer ni le chiffrer exactement.',
    circleFeeLine: fee => `Frais du pont de Circle (son propre chiffre, déduit du montant) : au plus ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Au moins ${floor} ${sym} traversent vers ton adresse Solana — la dernière étape les échange contre ta destination`,
    mintFloorDestLine: (floor, sym) => `Au moins ${floor} ${sym} arrivent à ton adresse Solana`,
    burnTxLabel: 'Hash de la transaction de burn (de ton portefeuille, après signature)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Je l\u2019ai signé — surveiller la traversée',
    burnTxInvalid: 'Ça ne ressemble pas à un hash de transaction Ethereum.',
    declineButton: 'Je ne signe pas ça',
    whatSigning: 'Tu signes deux transactions Ethereum tout à fait ordinaires dans ton propre portefeuille : une approbation, puis le burn. Rien n\u2019est signé côté dpay à cette étape.',
    crossingTitle: 'Traversée vers Solana',
    crossingBody: 'Circle atteste le burn et frappe les USDC à ton adresse Solana. dpay surveille le propre flux d\u2019état de Circle — cet écran changera tout seul.',
    viewBurnTx: 'Voir la transaction de burn',
    viewCircle: 'Page d\u2019état de Circle',
    stillCrossing: 'L\u2019attestation n\u2019est pas encore prête. Cela reste en attente — ce n\u2019est pas un échec. Sur la voie rapide, comptes des secondes à des minutes ; Ethereum congestionné, plus longtemps.',
    solReadyTitle: 'Les USDC sont arrivés sur Solana',
    solReadyBody: (credit, ata) => `${credit} sont à ${ata}, vérifié on-chain. Termine la route — ou laisse les USDC là, ils sont à toi dans les deux cas.`,
    solQuoteLabel: venue => `Devis ${venue} (en direct)`,
    solMinLine: (min, sym) => `Au moins ${min} ${sym} à ton adresse`,
    solConfirmButton: sym => `Échanger contre ${sym}`,
    solFeeLine: fee => `Frais de transaction Solana : ${fee}`,
    solPreflightTitle: 'Un peu de SOL est nécessaire pour les frais',
    solPreflightBody:
      'Les frais réseau de l\u2019échange se paient en SOL et ce portefeuille ne détient pas de SOL. Procure-toi d\u2019abord un peu de SOL dans ce portefeuille — les USDC restent en sécurité entre-temps.',
    doneTitle: 'Converti',
    doneBody: (amount, sym, address) => `${amount} ${sym} sont à ton adresse Solana ${address} — vérifié on-chain.`,
    doneVia: (icVenue, solVenue) => `Converti via ${icVenue}, Circle et ${solVenue}.`,
    declinedTitle: 'Remise annulée',
    declinedBody: address =>
      `Rien n\u2019a traversé. Tes USDC se trouvent à ta propre adresse Ethereum ${address} — envoie-les où tu veux depuis ton portefeuille ou relance cette route plus tard.`,
    solFailedTitle: 'L\u2019échange Solana n\u2019a pas abouti',
    solFailedBody: (ata, venue) =>
      `Les USDC ont déjà traversé sans problème et sont à ton adresse Solana ${ata}. ${venue} a refusé l\u2019échange final — réessaie ici dans un instant ou garde les USDC.`,
    legCctpBurn: (sym, network) => `Emmener ${sym} vers ${network} via Circle (tu signes ça dans ton portefeuille)`,
    legSolSwap: (venue, sym) => `Échanger contre ${sym} sur ${venue}`,
    destAddressCrossNote: 'Cette adresse Ethereum est aussi le portefeuille qui signe la traversée — colle une adresse que tu contrôles.',
    checksumMismatch: 'Erreur de checksum',
    retypeAddress: 'Retape l\u2019adresse',
    retypeMismatch: 'Ne correspond pas',
    gasFundTitle: 'Cette conversion a besoin de gaz ETH que tu n\u2019as pas',
    gasFundNeed: eth => `Besoin \u2248 ${eth}`,
    gasFundHave: eth => `Ton portefeuille : ${eth}`,
    gasFundWalletButton: 'Financer depuis ce portefeuille',
    gasFundSelfButton: 'Je le finance moi-même',
    gasFundSelfMin: eth => `Envoie \u2265 ${eth} à :`,
    gasFundRecheck: 'Revérifier',
    gasFundShort: short => `Il manque toujours ${short}`,
    gasLegsNote: 'Les premières étapes financent le gaz.',
    abortedGasBody: 'Le financement du gaz est terminé — il est toujours dans ce portefeuille. La conversion, elle, n\u2019a jamais tourné.',
    declinedWithGasBody: address => `Rien n\u2019a traversé. Tes USDC sont à ton adresse Ethereum ${address} ; le gaz financé est toujours dans ce portefeuille.`,
    gasShortFailedBody: needed => `Le financement du gaz est resté sous ${needed}. Rien n\u2019a quitté ce portefeuille — la conversion n\u2019a jamais démarré.`,
  },

  errors: {
    quoteUnreachable: venue => `Impossible d'obtenir le devis de ${venue} — le relay ne répond pas. Vérifie ta connexion et réessaie.`,
    quoteRefused: venue => `${venue} a refusé d'établir un devis pour cette paire pour l'instant.`,
    quoteUnavailable: code => `Devis indisponible (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} n'est pas encore configuré sur ce relay — aucune identification de partenaire n'est configurée, aucun devis ne peut donc être demandé. Ton portefeuille n'a aucun problème.`,
    gasUnavailable: 'Le prix du gaz du minter de retrait n\u2019a pas pu être demandé — rien n\u2019a été signé. Réessaie.',
    cctpFeeUnavailable: 'Les frais du pont de Circle n\u2019ont pas pu être récupérés — rien n\u2019a été signé. Vérifie ta connexion et réessaie.',
  },
};
