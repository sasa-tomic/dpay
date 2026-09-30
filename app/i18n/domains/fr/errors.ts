/**
 * i18n/domains/fr/errors.ts — French values for the copy that is thrown and rendered verbatim.
 * Types, key documentation and the reference copy: ../en/errors.ts. See also the
 * typography conventions for this locale: ../../fr.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsFr: ErrorMessages = {
  seedFormat: 'Le code doit comporter 64 caractères hexadécimaux (0-9, a-f).',

  ic: {
    clockUnreachable: 'Horloge IC inaccessible',
    clockSkew: 'Décalage d’horloge IC trop important',
    noLedgerForCurrency: 'Actif non pris en charge',
    feeUnavailable: 'Impossible de récupérer les frais du registre. Vérifiez votre connexion.',
  },

  solana: {
    offline: 'Solana est hors ligne (aucun point d’accès configuré)',
    tokenUnavailable: asset => `${asset} Solana indisponible (aucun point d’accès configuré)`,
    senderNoTokenAccount: asset =>
      `Pas encore de compte ${asset}. Connectez-vous à Internet et ouvrez Recevoir ▸ « Créer mon compte ${asset} », ou payez avec un actif que vous détenez`,
    senderTokenAccountUnverified: asset =>
      `Impossible de vérifier votre compte ${asset}. Sans lui, ce paiement ne pourra pas être réglé. Connectez-vous à Internet et ouvrez Recevoir ▸ Mon adresse pour le vérifier ou le créer.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `Impossible de vérifier votre compte ${asset} : Solana ne répond pas. Sans lui, ce paiement ne pourra pas être réglé. Dès qu’il répond : Recevoir ▸ Mon adresse.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Le destinataire n’a pas encore de compte ${asset}. Le créer coûte environ ${solAmount}, à votre charge — envoyez d’abord un peu de SOL ici`,
    ownTokenAccountRent: (solAmount, asset) =>
      `La création de votre compte ${asset} coûte environ ${solAmount}. Envoyez d’abord un peu de SOL ici.`,
  },

  rail: {
    refused: network =>
      `${network} a refusé la requête — soldes plus à jour. Rien n’a bougé ; dpay continue de réessayer.`,
    offline: network =>
      `Vous semblez hors ligne — soldes ${network} plus à jour. Rien n’a bougé. Ils se mettent à jour à la reconnexion ; payer par QR fonctionne aussi hors ligne.`,
    unreachable: network =>
      `${network} est injoignable alors que vous êtes en ligne — le relais de dpay n’arrive pas à le joindre. Argent intact ; les paiements IC fonctionnent ; les paiements se signent toujours hors ligne. Dans Paramètres ▸ Avancé, vous pouvez pointer ce portefeuille vers n’importe quel point d’accès ${network}.`,
    unreadable: network =>
      `${network} a envoyé des données que ce portefeuille ne peut pas lire — soldes plus à jour. Rien n’a bougé ; dpay continue de réessayer.`,
    historyStale: network =>
      `L’historique ${network} n’est pas à jour. Rien n’a bougé — il se met à jour tout seul.`,
    unreachableHint: () => 'Ouvre Paramètres ▸ Avancé.',
  },

  ethWallet: {
    receiptReverted: hash => `la transaction ${hash} a échoué sur la chaîne`,
    receiptTimeout: hash => `la transaction ${hash} n’a pas été minée dans le délai imparti`,
    hashMissing: received =>
      `Le portefeuille a répondu sans identifiant de transaction (${received}) : impossible de savoir si elle a été envoyée.`,
    sendTimedOut: 'Le portefeuille n’a pas répondu : impossible de savoir si la transaction a été envoyée.',
    requestTimedOut:
      'Le portefeuille n’a pas répondu. Ouvrez-le, traitez toute demande en attente, puis réessayez.',
    pairingTimedOut: 'délai d’association dépassé — aucun portefeuille scanné en 5 min',
    pairingFailed: detail => `échec de l’association WalletConnect : ${detail}`,
    invalidChainId: value =>
      `Le portefeuille a indiqué un réseau que dpay ne sait pas lire (${value}). Reconnectez-le ; si cela se reproduit, utilisez une autre application de portefeuille.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Le portefeuille n’a autorisé aucun réseau Ethereum ; ce dépôt se règle sur le réseau ${requested}. Passez-y, puis reconnectez-vous.`
        : `Le portefeuille a autorisé le réseau ${approved} ; ce dépôt se règle sur le réseau ${requested}. Changez, puis reconnectez-vous.`,
  },

  tap: {
    couldntConfirmOffline: 'Impossible de confirmer — vérifiez votre solde une fois en ligne',
    couldntVerifyRequest: 'Impossible de vérifier cette demande',
    couldntReturnResult: 'Impossible de renvoyer le résultat. Gardez les téléphones l’un contre l’autre et réessayez.',
    merchantRefusalUnverified:
      'D’après le registre, le transfert n’est pas passé, mais ce téléphone n’a pas pu le vérifier. Ne remettez pas la marchandise. Vérifiez vos Transactions dans un instant — l’argent y figure s’il est bien arrivé.',
    merchantNothingArrived:
      'Aucun paiement reçu. Ne remettez pas la marchandise — un transfert peut encore arriver et apparaîtra dans votre solde. Demandez un nouveau contact seulement si rien n’apparaît.',
    unsupportedAsset: currency => `Actif non pris en charge (monnaie ${currency})`,
    cannotConfirmAsset: currency => `Impossible de confirmer l’actif (monnaie ${currency})`,
    couldntReadRequest: 'Impossible de lire la demande de paiement',
    requestExpired: 'Cette demande a expiré — demandez-en une nouvelle',
    couldntAuthorize: 'Impossible d’autoriser le paiement — réessayez',
    noOpenRequest: 'Aucune demande en cours',
    paymentRejected: 'Paiement refusé',
    couldntConfirm: 'Impossible de confirmer',
    couldntConfirmCheckBalance: 'Impossible de confirmer — vérifiez votre solde',
    settlementNotVerified: 'Confirmé, mais ce n’est pas cette demande — vérifiez la signature avant la remise',
    paymentRequestExpired: 'Cette demande de paiement a expiré',
  },
};
