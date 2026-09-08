/**
 * i18n/domains/fr/convert.ts — valeurs françaises pour la surface de conversion déléguée.
 * Types, documentation des clés et copie de référence : ../en/convert.ts. Glossaire : ../../fr.ts.
 * « Quote » reste un terme technique ; la venue s'appelle toujours « ICPSwap ». Les montants et
 * principals arrivent déjà formatés en chaînes d'affichage.
 */
import type {ConvertMessages} from '../../keys';

export const convertFr: ConvertMessages = {
  actionConvert: 'Convertir',
  heading: (inSym, outSym) => `Convertir ${inSym} → ${outSym}`,
  backToWallet: 'Retour au portefeuille',

  unavailableTitle: sym => `La conversion n'est pas encore disponible pour ${sym}`,
  unavailableBody: pair => `Aujourd'hui, dpay convertit ${pair} via ICPSwap — et rien d'autre.`,
  unavailableCkusdc:
    'Un pool direct VCHF ↔ USDC existe, mais sa profondeur est saturée (environ CHF 315) : dpay le refuse plutôt que de vous afficher un prix périmé.',

  amountLabel: sym => `Montant (${sym})`,
  balanceLine: balance => `Solde : ${balance}`,
  receiveHeadline: 'Tu recevras',
  counterparty:
    'Exécuté par le pool ICPSwap — un contrat autonome on-chain, pas un prestataire agréé et pas dpay.',
  counterpartySigns: 'Ton téléphone signe ; le pool prélève exactement le montant approuvé.',
  quoteSource: at => `Quote ICPSwap, récupérée ${at}`,
  rateLabel: (inSym, outSym) => `Taux (${inSym} → ${outSym})`,
  poolFeeTier: tier => `Frais du pool : ${tier} (palier ICPSwap)`,
  inputFeeLine: fee => `Frais d'entrée : ${fee}`,
  outputFeeLine: fee => `Frais de sortie : ${fee}`,
  dpayFeeLine: 'dpay ne prend rien et ne reçoit rien pour cela.',
  impactLine: pct => `Impact sur le prix : ${pct}`,
  impactWarnLine: pct => `Impact élevé sur le prix : ${pct} — la quote ci-dessus l'inclut déjà.`,
  impactUnavailable:
    "Impact sur le prix : non mesurable pour l’instant — ICPSwap n’a rien coté pour l’échange de référence, il n’y a donc aucun prix auquel comparer celui-ci. Le minimum garanti ci-dessous borne quand même ce que cet échange peut te coûter.",
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Minimum garanti : ${amount} (${pct} de slippage)`,
  refusalLine: sym =>
    `Si le prix du pool dépasse ton minimum, l'échange échoue : ton ${sym} reste dans ton portefeuille et l'autorisation expire sans être utilisée.`,
  netEndStateLine: amount => `Résultat final : ${amount} attendus dans ton portefeuille, nets de tous les frais.`,
  confirmButton: 'Requoter et confirmer',
  staleRefreshing: 'Quote périmée — actualisation…',
  quoteChanged: (oldAmt, newAmt) => `La quote a changé : ${oldAmt} → ${newAmt}. Vérifie et confirme à nouveau.`,

  fundBody: (sym, receiveTab, myAddress) =>
    `Ce portefeuille n'a pas de ${sym}. Pour convertir des ${sym}, reçois d'abord des ${sym} à ton adresse : ouvre « ${receiveTab} » en bas et choisis « ${myAddress} ».`,
  insufficientLine: (needed, balance) =>
    `Cette conversion demande ${needed} — le montant plus deux frais de ledger — et ce portefeuille détient ${balance}. Baisse le montant, ou reçois-en d'abord davantage.`,

  approvingTitle: 'Approbation en cours',
  approvingBody: (amount, at) =>
    `Ton téléphone approuve le prélèvement exact de ${amount} par le pool. L'autorisation expire à ${at} si elle ne sert pas.`,
  swappingTitle: 'Échange en cours',
  swappingBody: 'Envoi de l’échange au pool ICPSwap. Il ne peut prélever que le montant approuvé.',
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
  failedSwapBody: (reason, sym) =>
    `Le pool ICPSwap a refusé l'échange (${reason}). Ton ${sym} n'a jamais quitté ton portefeuille. dpay ne peut ni l'annuler ni le retenter pour toi ; rien d'autre n'est nécessaire.`,
  refundedBody: sym =>
    `L'échange a échoué et le pool t'a rendu ton ${sym} — ton solde est de nouveau intact. dpay ne peut rien annuler ici.`,
  stuckTitle: 'Issue inconnue',
  stuckBody:
    'L’échange a été envoyé, mais la réponse du pool n’est pas arrivée. Ne lance pas un second échange avec les mêmes fonds. Si le versement arrive, cet écran passera tout seul à « Converti ».',
  stuckSigned: (amount, minAmount) =>
    `Ce qui a été signé : approuver ${amount} au pool ICPSwap ; échanger pour un minimum de ${minAmount}.`,
  expiryLine: at => `L'autorisation inutilisée expire au plus tard à ${at} — après, le pool ne peut plus rien prélever.`,

  errors: {
    quoteUnreachable: () => 'Impossible d’atteindre la quote ICPSwap — le relay ne répond pas. Vérifie ta connexion et réessaie.',
    quoteRefused: () => 'ICPSwap a refusé de quoter cette paire pour le moment.',
    quoteUnavailable: code => `Quote indisponible (${code}).`,
    swapReplyShape: () => 'La réponse du pool n’a pas pu être lue.',
  },
};
