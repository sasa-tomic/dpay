/**
 * i18n/en.ts — English, the source copy.
 *
 * English is the language the product was written in and is the reference every other locale is
 * translated FROM. Copy changes start here; `tsc` then reports every locale that has drifted.
 *
 * Style rules this copy is held to (they survive translation — carry them into every locale):
 *   • Plain language. Say what happened and what to do next.
 *   • Honest states. "Not confirmed" is a real outcome, not a soft failure — never claim a payment
 *     settled unless the ledger says it did.
 *   • Never surface raw ledger/token identifiers; money uses the backing native symbol.
 */
import type {Messages} from './keys';
import {depositEn, withdrawEn} from './domains/en/deposit.ts';
import {errorsEn} from './domains/en/errors.ts';
import {payEn, receiveEn} from './domains/en/pay.ts';
import {onboardingEn, settingsEn} from './domains/en/settings.ts';
import {educationEn, walletEn} from './domains/en/wallet.ts';
import {convertEn} from './domains/en/convert.ts';

export const en: Messages = {
  common: {
    done: 'Done',
    cancel: 'Cancel',
  },

  time: {
    today: time => `Today, ${time}`,
    yesterday: time => `Yesterday, ${time}`,
  },

  settings: settingsEn,
  onboarding: onboardingEn,

  wallet: walletEn,
  education: educationEn,

  pay: payEn,
  receive: receiveEn,

  deposit: depositEn,
  withdraw: withdrawEn,

  convert: convertEn,

  nfc: {
    reason: {
      off: 'NFC is turned off in your device settings. Turn NFC on to pay by tap — or scan the QR code to pay now.',
      unsupported: "This device doesn't have NFC hardware. Scan the QR code to pay.",
      unknown: "Couldn't check NFC status. Scan the QR code to pay.",
    },
    phase: {
      listening: {title: 'Hold near the other phone', sub: 'dpay is listening for a tap'},
      linking: {title: 'Connecting…', sub: 'Linking the two phones'},
      exchanging: {title: 'Communicating…', sub: 'Keep the phones together'},
      awaitingApproval: {title: 'Waiting for the payer…', sub: 'They’re signing the payment'},
      settling: {title: 'Confirming…', sub: 'Keep the phones together while the merchant settles'},
      success: {title: 'Done ✓', sub: ''},
      declined: {title: 'Declined', sub: 'The payment was declined'},
      pending: {title: 'Not confirmed', sub: 'Couldn’t reach the ledger'},
      error: {title: 'Tap failed', sub: 'Move the phones together and try again'},
    },
    paidAmount: amount => `Paid ✓ ${amount}`.trim(),
    receivedAmount: amount => `Received ✓ ${amount}`.trim(),
    settled: 'The payment settled',
    settledStamp: 'settled',
    paying: (amount, network) => (network ? `Paying ${amount} on ${network}` : `Paying ${amount}`),
    collecting: (amount, network) => (network ? `Collecting ${amount} on ${network}` : `Collecting ${amount}`),
    holdToSend: 'Hold the phones together to send',
  },

  rail: {
    insufficientFunds: 'Not enough balance',
    badFee: detail => `Wrong fee${detail ? ` (${detail})` : ''} — try again`,
    badBurn: detail => `Amount below the ledger minimum${detail ? ` (${detail})` : ''}`,
    tooOld: 'The request expired',
    createdInFuture: 'Clock skew — try again',
    temporarilyUnavailable: 'The ledger is busy — try again',
    declined: detail =>
      detail ? `The ledger declined the payment (${detail})` : 'The ledger declined the payment',
  },

  sol: {
    noRecordOfCredit:
      "This account has no SOL, or the network hasn't synced your balance yet. If you just deposited, wait a moment and retry — otherwise deposit SOL to your address first.",
    timedOut: 'Timed out. Check your connection and try again.',
    insufficient: 'Not enough SOL for this send plus the network fee.',
    rentExempt: 'After this send, your account would fall below the minimum balance. Send a smaller amount.',
    blockhash: 'The network was too busy. Try again.',
    tapFailed: "Payment didn't complete — try again",
  },

  errors: errorsEn,
};
