/**
 * i18n/fr.ts — French (fr).
 *
 * Translated FROM en.ts, which is the reference copy: its style rules (plain language, honest
 * states, never a raw ledger/token identifier) carry over unchanged. When a key changes, it changes
 * in English first and `tsc` reports this locale.
 *
 * TYPOGRAPHY. `’` is the apostrophe (never `'`). A NARROW NO-BREAK SPACE (U+202F) sits before `:`
 * `;` `?` `!` — it is a real character in these strings, not an ordinary space; keep it when you
 * edit a line. Product identity is NOT translated: dpay, Bitcoin, Ethereum, Solana, Internet
 * Computer, USDC, ckBTC/ckETH/ckUSDC, SOL, ETH, BTC, NFC, QR, testnet, devnet, mainnet, and every
 * glyph (∂ $ € ₿ • ✓ · — ~ ≈).
 *
 * GLOSSARY — one French term per concept, applied with zero variation. A future translator inherits
 * these; change one only by changing every site.
 *
 *   payment / to pay ............. paiement / payer
 *   payment request / request .... demande de paiement / demande
 *   receive ...................... recevoir
 *   settle / settled ............. régler / réglé
 *   confirmation / to confirm .... confirmation / confirmer
 *   offline / online ............. hors ligne / en ligne
 *   tap (NFC) .................... sans contact (the gesture: approcher les téléphones)
 *   scan ......................... scanner
 *   merchant / the shop .......... commerçant (one word for both — French has no useful split here)
 *   payer ........................ payeur
 *   wallet ....................... portefeuille
 *   balance ...................... solde
 *   funds ........................ fonds
 *   asset ........................ actif
 *   add money / deposit .......... dépôt / déposer
 *   cash out / withdraw .......... retrait / retirer
 *   address ...................... adresse
 *   network fee .................. frais de réseau
 *   ledger (the chain ledger) .... registre
 *   transactions (the tab) ....... Transactions
 *   mint (chain-key issuance) .... émettre / émis
 *   recovery words (the 24) ...... mots de récupération
 *   recovery phrase .............. phrase de récupération
 *   recovery seed (the 64-hex) ... code de récupération  (NOT « graine »/« seed »; « clé » is
 *                                  reserved for the on-device key, which the copy contrasts with it)
 *   backup / to back up .......... sauvegarde / sauvegarder
 *   demo funds ................... fonds de démo
 *   testnet ...................... testnet (proper noun, kept)
 *   trip readiness ............... Prêt pour le voyage
 *   relay ("Server") ............. serveur
 *   expire / expired ............. expirer / expiré
 *   practice (the first run) ..... entraînement
 */
import type {Messages} from './keys';
import {depositFr, withdrawFr} from './domains/fr/deposit.ts';
import {convertFr} from './domains/fr/convert.ts';
import {receiptFr} from './domains/fr/receipt.ts';
import {evmFr} from './domains/fr/evm.ts';
import {errorsFr} from './domains/fr/errors.ts';
import {payFr, receiveFr} from './domains/fr/pay.ts';
import {onboardingFr, settingsFr} from './domains/fr/settings.ts';
import {educationFr, walletFr} from './domains/fr/wallet.ts';

export const fr: Messages = {
  common: {
    done: 'Terminé',
    cancel: 'Annuler',
  },

  time: {
    today: time => `Aujourd’hui, ${time}`,
    yesterday: time => `Hier, ${time}`,
  },

  settings: settingsFr,
  onboarding: onboardingFr,

  wallet: walletFr,
  education: educationFr,

  pay: payFr,
  receive: receiveFr,

  deposit: depositFr,
  convert: convertFr,

  receipt: receiptFr,

  evm: evmFr,
  withdraw: withdrawFr,

  nfc: {
    reason: {
      off: 'Le NFC est désactivé dans les paramètres de votre appareil. Activez-le pour payer sans contact — ou scannez le QR pour payer maintenant.',
      unsupported: 'Cet appareil n’a pas de NFC. Scannez le QR pour payer.',
      unknown: 'Impossible de vérifier l’état du NFC. Scannez le QR pour payer.',
    },
    phase: {
      listening: {title: 'Approchez l’autre téléphone', sub: 'dpay attend le contact'},
      linking: {title: 'Connexion…', sub: 'Liaison des deux téléphones'},
      exchanging: {title: 'Échange…', sub: 'Gardez les téléphones l’un contre l’autre'},
      awaitingApproval: {title: 'En attente du payeur…', sub: 'Il signe le paiement'},
      settling: {title: 'Confirmation…', sub: 'Gardez les téléphones ensemble pendant que le commerçant règle'},
      success: {title: 'Terminé ✓', sub: ''},
      declined: {title: 'Refusé', sub: 'Le paiement a été refusé'},
      pending: {title: 'Non confirmé', sub: 'Registre injoignable'},
      error: {title: 'Échec du contact', sub: 'Rapprochez les téléphones et réessayez'},
    },
    paidAmount: amount => `Payé ✓ ${amount}`.trim(),
    receivedAmount: amount => `Reçu ✓ ${amount}`.trim(),
    settled: 'Le paiement est réglé',
    paying: (amount, network) => (network ? `Paiement de ${amount} sur ${network}` : `Paiement de ${amount}`),
    collecting: (amount, network) =>
      network ? `Encaissement de ${amount} sur ${network}` : `Encaissement de ${amount}`,
    holdToSend: 'Gardez les téléphones ensemble pour envoyer',
  },

  rail: {
    insufficientFunds: 'Solde insuffisant',
    badFee: detail => `Frais incorrects${detail ? ` (${detail})` : ''} — réessayez`,
    badBurn: detail => `Montant inférieur au minimum du registre${detail ? ` (${detail})` : ''}`,
    tooOld: 'La demande a expiré',
    createdInFuture: 'Décalage d’horloge — réessayez',
    temporarilyUnavailable: 'Le registre est occupé — réessayez',
    declined: detail =>
      detail ? `Le registre a refusé le paiement (${detail})` : 'Le registre a refusé le paiement',
  },

  sol: {
    noRecordOfCredit:
      'Ce compte n’a pas de SOL, ou le réseau n’a pas encore synchronisé votre solde. Si vous venez de déposer, patientez un instant et réessayez — sinon, déposez d’abord des SOL à votre adresse.',
    timedOut: 'Délai dépassé. Vérifiez votre connexion et réessayez.',
    engineLoad: "Le moteur de paiement ne s'est pas chargé. Vérifiez votre connexion, rouvrez cet écran puis réessayez — votre argent est resté à sa place.",
    insufficient: 'Pas assez de SOL pour cet envoi et les frais de réseau.',
    rentExempt: 'Après cet envoi, votre compte passerait sous le solde minimum. Envoyez un montant plus petit.',
    blockhash: 'Le réseau était trop chargé. Réessayez.',
    tapFailed: 'Le paiement n’a pas abouti — réessayez',
  },

  errors: errorsFr,
};
