/**
 * i18n/domains/fr/errors.ts — French values for the copy that is thrown and rendered verbatim.
 *
 * Reference copy and all documentation: ../en/errors.ts (shapes: ../../keys.ts). Glossary and
 * typography conventions for this locale: ../../fr.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsFr: ErrorMessages = {
  seedFormat: 'Le code de récupération doit comporter 64 caractères hexadécimaux (0-9, a-f).',

  ic: {
    clockUnreachable: 'Horloge IC inaccessible',
    clockSkew: 'Décalage d’horloge IC trop important',
    noLedgerForCurrency: 'Actif non pris en charge — aucun registre pour cette monnaie',
    feeUnavailable: 'Impossible de récupérer les frais du registre — vérifiez votre connexion',
  },

  solana: {
    offline: 'Solana est hors ligne (aucun point d’accès RPC configuré)',
    tokenUnavailable: asset => `Le ${asset} Solana n’est pas disponible (aucun point d’accès RPC configuré)`,
    senderNoTokenAccount: asset =>
      `Votre portefeuille n’a pas encore de compte ${asset}. Connectez-vous une fois à Internet et ouvrez Recevoir ▸ « Créer mon compte ${asset} » pour le créer — ou payez ce commerçant avec un actif que vous détenez déjà`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Le destinataire n’a pas encore de compte ${asset} — le créer demande environ ${solAmount} de SOL dans ce portefeuille (loyer + frais, une seule fois, à votre charge) — envoyez d’abord un peu de SOL ici`,
    ownTokenAccountRent: (solAmount, asset) =>
      `La création de votre compte ${asset} demande environ ${solAmount} dans ce portefeuille (loyer du compte + frais, une seule fois) — envoyez d’abord un peu de SOL ici`,
  },

  ethWallet: {
    receiptReverted: hash => `la transaction ${hash} a échoué sur la chaîne`,
    receiptTimeout: hash => `la transaction ${hash} n’a pas été minée dans le délai imparti`,
    hashMissing: received => `votre portefeuille a accepté la transaction mais n’a renvoyé aucun identifiant de transaction (${received})`,
    pairingTimedOut: 'délai d’association dépassé — aucun portefeuille scanné en 5 min',
    pairingFailed: detail => `échec de l’association WalletConnect : ${detail}`,
    invalidChainId: value =>
      `Votre portefeuille a indiqué un réseau que dpay ne sait pas lire (${value}). Reconnectez-le ; si cela se reproduit, utilisez une autre application de portefeuille.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Votre portefeuille s’est connecté sans autoriser aucun réseau Ethereum. Ce dépôt se règle sur le réseau ${requested} — passez-y dans votre portefeuille, puis reconnectez-vous.`
        : `Votre portefeuille a autorisé le réseau ${approved}, mais ce dépôt se règle sur le réseau ${requested}. Changez de réseau dans votre portefeuille, puis reconnectez-vous.`,
  },

  tap: {
    couldntConfirmOffline: 'Impossible de confirmer — vérifiez votre solde une fois de retour en ligne',
    couldntVerifyRequest: 'Impossible de vérifier cette demande',
    couldntReturnResult: 'Impossible de renvoyer le résultat du paiement — gardez les téléphones l’un contre l’autre et réessayez',
    merchantRefusalUnverified:
      'D’après la réponse du registre, ce transfert n’est pas passé, mais dpay n’a pas pu vérifier cette réponse sur ce téléphone. Ne remettez pas la marchandise. Vérifiez dans un instant votre solde et vos transactions — si l’argent est bien arrivé, il y figure.',
    merchantNothingArrived:
      'Aucun paiement reçu. Ne remettez pas la marchandise. Un transfert peut encore arriver après le contact ; il apparaîtra alors dans votre solde et vos transactions. Demandez au client de recommencer seulement si rien n’apparaît.',
    unsupportedAsset: currency => `Actif non pris en charge (monnaie ${currency})`,
    cannotConfirmAsset: currency => `Impossible de confirmer l’actif (monnaie ${currency})`,
    couldntReadRequest: 'Impossible de lire la demande de paiement',
    requestExpired: 'Cette demande a expiré — demandez-en une nouvelle',
    couldntAuthorize: 'Impossible d’autoriser le paiement — réessayez',
    noOpenRequest: 'Aucune demande en cours',
    paymentRejected: 'Paiement refusé',
    couldntConfirm: 'Impossible de confirmer',
    couldntConfirmCheckBalance: 'Impossible de confirmer le paiement — vérifiez votre solde',
    paymentRequestExpired: 'Cette demande de paiement a expiré',
  },
};
