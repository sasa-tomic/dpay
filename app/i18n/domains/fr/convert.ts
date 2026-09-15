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
  balanceLine: balance => `Solde : ${balance}`,
  receiveHeadline: 'Tu recevras',
  counterparty: venue =>
    `Exécuté par le pool ${venue} — un contrat autonome on-chain, pas un prestataire agréé et pas dpay.`,
  counterpartySigns: 'Ton téléphone signe ; le pool prélève exactement le montant approuvé.',
  quoteSource: (at, venue) => `Devis ${venue}, récupéré ${at}`,
  rateLabel: (inSym, outSym) => `Taux de ce devis (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Frais du pool : ${tier} (palier ${venue})`,
  inputFeeLine: fee => `Frais d'entrée : ${fee}`,
  outputFeeLine: fee => `Frais de sortie : ${fee}`,
  dpayFeeLine: 'dpay ne prend rien et ne reçoit rien pour cela.',
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (la clé du registre pour les pools ICPSwap) : le fait propre à
      // la venue est OÙ tourne l'échange — son propre contrat de pool, signé par l'utilisateur,
      // dpay n'est pas partie.
      icpswap: venue =>
        `L'échange s'exécute sur le propre contrat de pool de ${venue}. Chaque appel est signé par toi et envoyé directement — ${venue} exécute l'échange, et dpay n'en est pas partie.`,
      // disclosure_key 'jupiter' (la clé du registre pour la ligne de la venue Solana) : les faits
      // propres à la venue sont CE qu'est Jupiter — un agrégateur on-chain autonome — et que le
      // devis est le sien, affiché tel qu'il le publie, tandis que dpay reste hors de l'échange.
      // Ton miroir de icpswap : attribuer, nommer le signataire, nier la partie.
      jupiter: venue =>
        `${venue} est un agrégateur on-chain autonome sur Solana — il choisit la route et la route l'exécute. Ce portefeuille signe la transaction que ${venue} construit, et le devis est celui de ${venue}, affiché exactement comme il le publie. dpay n'en est pas partie.`,
    },
    generic: venue =>
      `Cette conversion est exécutée par ${venue}. Chaque appel est signé par toi et envoyé directement — dpay n'en est pas partie.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum garanti : ${amount} (${pct} de slippage)`,
  refusalLine: sym =>
    `Si le prix du pool dépasse ton minimum, l'échange échoue : ton ${sym} reste dans ton portefeuille et l'autorisation expire sans être utilisée.`,
  netEndStateLine: amount => `Résultat final : ${amount} attendus dans ton portefeuille, nets de tous les frais.`,
  confirmButton: 'Actualiser le devis et confirmer',
  staleRefreshing: 'Devis périmé — actualisation…',
  quoteChanged: (oldAmt, newAmt) => `Le devis a changé : ${oldAmt} → ${newAmt}. Vérifie et confirme à nouveau.`,
  venueChooserLabel: 'Plateforme',
  venueNoneSelected: 'Choisis une plateforme pour voir son devis complet et continuer.',
  venueRowQuote: amount => `Devis : ${amount}`,

  sol: {
    heading: (inSym, outSym) => `Convertir ${inSym} en ${outSym} (Solana)`,
    unavailableTitle: sym => `${sym} ne peut pas encore être converti`,
    unavailableBody: (sym, venue) =>
      `Les conversions d'actifs Solana passent par une venue Solana enregistrée (${venue} aujourd'hui). Aucune venue ne sert ${sym} pour l'instant — rien n'a été proposé, rien n'a bougé.`,
    counterparty: venue =>
      `Exécuté par ${venue} — un agrégateur on-chain autonome sur Solana, pas un fournisseur agréé et pas dpay.`,
    counterpartySigns: 'Ton téléphone signe la transaction que la venue a construite — personne d\u2019autre ne signe rien.',
    priceImpactLine: (pct, venue) => `Impact sur le prix : ${pct} (chiffre propre de ${venue})`,
    platformFeeLine: (pct, venue) => `Frais d'intégrateur ${venue} : ${pct}`,
    solFeeLine: fee => `Frais de réseau Solana : ${fee} (payés au réseau, pas à la venue, pas à dpay)`,
    refusalLine: sym =>
      `Si le prix dépasse le minimum, la transaction échoue on-chain : ton ${sym} reste dans ton portefeuille et rien d'autre n'a été signé.`,
    quoteFeesNote: 'Les frais de route sont déjà dans le montant devisé — rien ne s\u2019ajoute par-dessus.',
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
    `Le pool a accepté l'échange, mais le versement en ${sym} n'est pas encore arrivé dans ton portefeuille. Cet écran continue de surveiller — rien à faire pour l'instant. dpay ne peut ni annuler ni accélérer le versement. S'il n'arrive jamais, communique ceci au support : pool ${pool}, échange envoyé à ${at}.`,
  stillWatching: 'Toujours en attente du versement…',
  failedTitle: 'Échange non exécuté',
  failedApproveBody: sym =>
    `Le ledger ${sym} a refusé l'approbation, donc rien n'a bougé — tu possèdes toujours chaque unité de ton ${sym}. Aucune autorisation n'a été créée ; rien à rembourser ni à annuler.`,
  failedSwapBody: (reason, sym, venue) =>
    `Le pool ${venue} a refusé l'échange (${reason}). Ton ${sym} n'a jamais quitté ton portefeuille. dpay ne peut ni l'annuler ni le retenter pour toi ; rien d'autre n'est nécessaire.`,
  refundedBody: sym =>
    `L'échange a échoué et le pool t'a rendu ton ${sym} — ton solde est de nouveau intact. dpay ne peut rien annuler ici.`,
  stuckTitle: 'Issue inconnue',
  stuckBody:
    'L’échange a été envoyé, mais la réponse du pool n’est pas arrivée. Ne lance pas un second échange avec les mêmes fonds. Si le versement arrive, cet écran passera tout seul à « Converti ».',
  stuckSigned: (amount, minAmount, venue) =>
    `Ce qui a été signé : approuver ${amount} au pool ${venue} ; échanger pour un minimum de ${minAmount}.`,
  expiryLine: at => `L'autorisation inutilisée expire au plus tard à ${at} — après, le pool ne peut plus rien prélever.`,

  awaitingAuthTitle: 'Autorisation requise',
  awaitingAuthBody: venue =>
    `Cette commande est ouverte chez ${venue} et attend ton autorisation. Rien n'a bougé et rien ne bougera tant que tu ne l'approuves pas — dpay surveille en attendant le statut du prestataire.`,
  awaitingDepositTitle: 'En attente du dépôt',
  awaitingDepositBody: (sym, venue) =>
    `${venue} a émis cette commande et attend son dépôt en ${sym}. L'échange s'exécute quand le prestataire voit le dépôt ; dpay continue de surveiller son statut. Si aucun dépôt n'arrive à temps, le devis expire et rien ne bouge.`,
  providerProcessingTitle: 'Traitement chez le prestataire',
  providerProcessingBody: (sym, venue) =>
    `${venue} détient le dépôt et exécute la commande. Ton ${sym} arrive quand le prestataire la termine — dpay ne peut ni l'annuler ni l'accélérer, et continue de surveiller jusqu'à sa résolution.`,
  quoteExpiredTitle: 'Devis expiré',
  quoteExpiredBody: (sym, venue) =>
    `Le devis a expiré avant qu'une valeur ne bouge : ${venue} n'a jamais reçu le dépôt, donc rien n'a été échangé et rien n'est à annuler. Ton ${sym} est resté là où il était — lance une nouvelle conversion si tu en veux toujours une.`,
  providerRefundedTitle: 'Remboursé par le prestataire',
  providerRefundedBody: (sym, venue) =>
    `${venue} a annulé cette commande et retourné le dépôt. Surveille le retour de ton ${sym} — dpay ne peut ni annuler ni accélérer le remboursement du prestataire.`,
  stuckWatching: 'dpay continue de surveiller ceci en arrière-plan. Si le paiement ou le remboursement arrive, cet écran bascule tout seul.',
  stuckAcknowledge: 'Compris — arrêter la surveillance',
  stuckAcknowledged: 'Tu en as pris note et la surveillance en arrière-plan est arrêtée. Si des fonds bougent plus tard, ils arriveront toujours à l\u2019adresse de ce portefeuille.',

  multihop: {
    destLabel: 'Destination',
    destDirect: sym => `${sym} — dans ce portefeuille (échange direct)`,
    destRoute: (sym, network) => `${sym} sur ${network} — route échange + retrait`,
    routeNote: 'Une seule route est enregistrée pour cette paire aujourd\u2019hui — montrée ici, jamais choisie à ta place.',
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
    gasFeeLine: amount => `Gaz du retrait (devis en direct du minter) : ${amount}`,
    routeMinLine: (amount, pct) => `Au moins ${amount} à ton adresse (plancher de glissement ${pct})`,
    routeSurplusNote: hopSym => `Si l\u2019échange paie au-dessus du plancher, l\u2019excédent reste dans ce portefeuille en ${hopSym}.`,
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
    stuckRouteBody: 'Une étape a été envoyée mais son issue reste inconnue. dpay continue de surveiller les registres en arrière-plan ; cet écran changera tout seul quand la route se résout.',
  },

  errors: {
    quoteUnreachable: venue => `Impossible d'obtenir le devis de ${venue} — le relay ne répond pas. Vérifie ta connexion et réessaie.`,
    quoteRefused: venue => `${venue} a refusé d'établir un devis pour cette paire pour l'instant.`,
    quoteUnavailable: code => `Devis indisponible (${code}).`,
    gasUnavailable: 'Le prix du gaz du minter de retrait n\u2019a pas pu être demandé — rien n\u2019a été signé. Réessaie.',
  },
};
