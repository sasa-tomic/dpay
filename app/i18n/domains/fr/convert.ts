/**
 * i18n/domains/fr/convert.ts — valeurs françaises pour la surface de conversion déléguée.
 * Types, documentation des clés et copie de référence : ../en/convert.ts. Glossaire : ../../fr.ts.
 * « Quote » reste un terme technique ; le nom de la venue arrive en argument (nom d'affichage du
 * registre des venues, jamais codé en dur ici). Les montants et principals arrivent déjà formatés
 * en chaînes d'affichage.
 */
import type {ConvertMessages} from '../../keys';

export const convertFr: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Retour au portefeuille',

  unavailableTitle: sym => `La conversion n'est pas encore disponible pour ${sym}`,
  unavailableBody: (pair, venue) => `Aujourd'hui, dpay convertit ${pair} via ${venue} — et rien d'autre.`,
  unavailableCkusdc: venue =>
    `Un pool direct VCHF ↔ USDC existe chez ${venue}, mais sa profondeur est saturée (environ CHF 315) : dpay le refuse plutôt que de vous afficher un prix périmé.`,

  amountLabel: sym => `Montant (${sym})`,
  balanceLine: balance => `Solde : ${balance}`,
  receiveHeadline: 'Tu recevras',
  counterparty: venue =>
    `Exécuté par le pool ${venue} — un contrat autonome on-chain, pas un prestataire agréé et pas dpay.`,
  counterpartySigns: 'Ton téléphone signe ; le pool prélève exactement le montant approuvé.',
  quoteSource: (at, venue) => `Quote ${venue}, récupérée ${at}`,
  rateLabel: (inSym, outSym) => `Taux de cette quote (${inSym} → ${outSym})`,
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
    },
    generic: venue =>
      `Cette conversion est exécutée par ${venue}. Chaque appel est signé par toi et envoyé directement — dpay n'en est pas partie.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum garanti : ${amount} (${pct} de slippage)`,
  refusalLine: sym =>
    `Si le prix du pool dépasse ton minimum, l'échange échoue : ton ${sym} reste dans ton portefeuille et l'autorisation expire sans être utilisée.`,
  netEndStateLine: amount => `Résultat final : ${amount} attendus dans ton portefeuille, nets de tous les frais.`,
  confirmButton: 'Requoter et confirmer',
  staleRefreshing: 'Quote périmée — actualisation…',
  quoteChanged: (oldAmt, newAmt) => `La quote a changé : ${oldAmt} → ${newAmt}. Vérifie et confirme à nouveau.`,
  venueChooserLabel: 'Venue',
  venueNoneSelected: 'Choisis une venue pour voir sa quote complète et continuer.',
  venueRowQuote: amount => `Quote : ${amount}`,

  fundBody: (sym, receiveTab, myAddress) =>
    `Ce portefeuille n'a pas de ${sym}. Pour convertir des ${sym}, reçois d'abord des ${sym} à ton adresse : ouvre « ${receiveTab} » en bas et choisis « ${myAddress} ».`,
  fundOtherHolds: (held, toSym) => `Vous avez ${held} — vous pouvez plutôt le convertir en ${toSym}.`,
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
    `${venue} a émis cette commande et attend son dépôt en ${sym}. L'échange s'exécute quand le prestataire voit le dépôt ; dpay continue de surveiller son statut. Si aucun dépôt n'arrive à temps, la quote expire et rien ne bouge.`,
  providerProcessingTitle: 'Traitement chez le prestataire',
  providerProcessingBody: (sym, venue) =>
    `${venue} détient le dépôt et exécute la commande. Ton ${sym} arrive quand le prestataire la termine — dpay ne peut ni l'annuler ni l'accélérer, et continue de surveiller jusqu'à sa résolution.`,
  quoteExpiredTitle: 'Quote expirée',
  quoteExpiredBody: (sym, venue) =>
    `La quote est morte avant qu'une valeur ne bouge : ${venue} n'a jamais reçu le dépôt, donc rien n'a été échangé et rien n'est à annuler. Ton ${sym} est resté là où il était — lance une nouvelle conversion si tu en veux toujours une.`,
  providerRefundedTitle: 'Remboursé par le prestataire',
  providerRefundedBody: (sym, venue) =>
    `${venue} a annulé cette commande et retourné le dépôt. Surveille le retour de ton ${sym} — dpay ne peut ni annuler ni accélérer le remboursement du prestataire.`,
  stuckWatching: 'dpay continue de surveiller ceci en arrière-plan. Si le paiement ou le remboursement arrive, cet écran bascule tout seul.',
  stuckAcknowledge: 'Compris — arrêter la surveillance',
  stuckAcknowledged: 'Tu en as pris note et la surveillance en arrière-plan est arrêtée. Si des fonds bougent plus tard, ils arriveront toujours à l\u2019adresse de ce portefeuille.',

  errors: {
    quoteUnreachable: venue => `Impossible d'atteindre la quote ${venue} — le relay ne répond pas. Vérifie ta connexion et réessaie.`,
    quoteRefused: venue => `${venue} a refusé de quoter cette paire pour le moment.`,
    quoteUnavailable: code => `Quote indisponible (${code}).`,
  },
};
