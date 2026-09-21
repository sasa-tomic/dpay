/**
 * i18n/de.ts — German (de). Translated from ./en.ts, which stays the reference copy: when a key
 * changes there, `tsc` reports this locale, and the English file is the one to read for what the
 * key MEANS. The style rules in en.ts (plain language, honest states, backing symbols) apply here
 * unchanged — this file adds only the German-specific decisions below.
 *
 * REGISTER: informal "du" throughout — the German consumer-fintech convention (N26,
 * Trade Republic). Never "Sie", never a mix.
 *
 * GLOSSARY — one German term per concept, applied with zero variation. A future translator
 * inherits these; change one and change every site.
 *
 *   payment · pay · payer      die Zahlung · bezahlen · der Zahler
 *   merchant · shop            der Händler · der Laden (the education copy's warmer "shop")
 *   request (noun · verb)      die (Zahlungs-)Anfrage · anfordern
 *   receive                    empfangen
 *   settle · settled           abwickeln · abgewickelt (die Abwicklung)
 *   confirm · confirmation     bestätigen · die Bestätigung
 *   approve                    freigeben (die Freigabe) — kept distinct from "bestätigen"
 *   sign                       signieren
 *   submit                     einreichen
 *   offline                    offline
 *   tap (NFC)                  der Tap; the gesture is "auflegen" / "die Handys zusammenhalten"
 *   scan                       scannen
 *   wallet                     die Wallet
 *   balance · funds            das Guthaben
 *   deposit (on-chain)         einzahlen · die Einzahlung
 *   add money / top up         aufladen — the consumer act (faucet, fund-first gate)
 *   mint (chain-key credit)    gutschreiben · die Gutschrift — what the user actually sees happen
 *   cash out / withdraw        auszahlen · die Auszahlung
 *   address                    die Adresse
 *   recovery words             die Wiederherstellungswörter (short form: die Wörter)
 *   recovery seed              der Wiederherstellungs-Seed (short form: der Seed)
 *   backup · restore           das Backup / sichern · wiederherstellen
 *   network fee                die Netzwerkgebühr
 *   ledger (the chain ledger)  das Ledger — NOT "Netzwerk", which would blur it with fees
 *   testnet · demo funds       Testnet · das Demo-Guthaben
 *   transactions (the tab)     der Verlauf
 *   trip readiness             die Reisebereitschaft · reisebereit
 *   relay                      das Relay
 *   expire · expired           ablaufen · abgelaufen
 *   asset · amount · key       das Asset · der Betrag · der Schlüssel
 *   memo · phone · device      die Notiz · das Handy · das Gerät
 *   rail                       not translated literally — rendered as the asset/network itself
 *
 * NUMERIC PLACEHOLDERS ('0.00', '1.5', '0.025', '0.00050000') keep the '.' decimal point: they are
 * examples for the amount INPUT, whose parser is locale-invariant. Display formatting is
 * lib/format.ts's job (Intl), not the catalog's.
 */
import type {Messages} from './keys';
import {depositDe, withdrawDe} from './domains/de/deposit.ts';
import {convertDe} from './domains/de/convert.ts';
import {receiptDe} from './domains/de/receipt.ts';
import {errorsDe} from './domains/de/errors.ts';
import {payDe, receiveDe} from './domains/de/pay.ts';
import {onboardingDe, settingsDe} from './domains/de/settings.ts';
import {educationDe, walletDe} from './domains/de/wallet.ts';

export const de: Messages = {
  common: {
    done: 'Fertig',
    cancel: 'Abbrechen',
  },

  time: {
    today: time => `Heute, ${time}`,
    yesterday: time => `Gestern, ${time}`,
  },

  settings: settingsDe,
  onboarding: onboardingDe,

  wallet: walletDe,
  education: educationDe,

  pay: payDe,
  receive: receiveDe,

  deposit: depositDe,
  withdraw: withdrawDe,
  convert: convertDe,

  receipt: receiptDe,

  nfc: {
    reason: {
      off: 'NFC ist in deinen Geräteeinstellungen ausgeschaltet. Schalte NFC ein, um per Tap zu bezahlen — oder scanne jetzt den QR-Code.',
      unsupported: 'Dieses Gerät hat keine NFC-Hardware. Scanne den QR-Code, um zu bezahlen.',
      unknown: 'Der NFC-Status konnte nicht geprüft werden. Scanne den QR-Code, um zu bezahlen.',
    },
    phase: {
      listening: {title: 'Halte es an das andere Handy', sub: 'dpay wartet auf einen Tap'},
      linking: {title: 'Verbinden…', sub: 'Die beiden Handys werden verbunden'},
      exchanging: {title: 'Austausch…', sub: 'Halte die Handys zusammen'},
      awaitingApproval: {title: 'Warte auf den Zahler…', sub: 'Die Zahlung wird gerade signiert'},
      settling: {title: 'Bestätigen…', sub: 'Halte die Handys zusammen, während der Händler abwickelt'},
      success: {title: 'Fertig ✓', sub: ''},
      declined: {title: 'Abgelehnt', sub: 'Die Zahlung wurde abgelehnt'},
      pending: {title: 'Nicht bestätigt', sub: 'Das Ledger war nicht erreichbar'},
      error: {title: 'Tap fehlgeschlagen', sub: 'Halte die Handys zusammen und versuche es erneut'},
    },
    paidAmount: amount => `Bezahlt ✓ ${amount}`.trim(),
    receivedAmount: amount => `Empfangen ✓ ${amount}`.trim(),
    settled: 'Die Zahlung wurde abgewickelt',
    paying: (amount, network) => (network ? `Zahlung von ${amount} auf ${network}` : `Zahlung von ${amount}`),
    collecting: (amount, network) => (network ? `Empfang von ${amount} auf ${network}` : `Empfang von ${amount}`),
    holdToSend: 'Halte die Handys zusammen zum Senden',
  },

  rail: {
    insufficientFunds: 'Guthaben reicht nicht',
    badFee: detail => `Falsche Gebühr${detail ? ` (${detail})` : ''} — versuche es erneut`,
    badBurn: detail => `Betrag unter dem Ledger-Minimum${detail ? ` (${detail})` : ''}`,
    tooOld: 'Die Anfrage ist abgelaufen',
    createdInFuture: 'Zeitabweichung — versuche es erneut',
    temporarilyUnavailable: 'Das Ledger ist ausgelastet — versuche es erneut',
    declined: detail =>
      detail ? `Das Ledger hat die Zahlung abgelehnt (${detail})` : 'Das Ledger hat die Zahlung abgelehnt',
  },

  sol: {
    noRecordOfCredit:
      'Dieses Konto hat kein SOL, oder das Netzwerk hat dein Guthaben noch nicht synchronisiert. Wenn du gerade eingezahlt hast, warte kurz und versuche es erneut — zahle sonst zuerst SOL an deine Adresse ein.',
    timedOut: 'Zeitüberschreitung. Prüfe deine Verbindung und versuche es erneut.',
    engineLoad: 'Die Zahlungs-Engine wurde nicht geladen. Prüfe deine Verbindung, öffne diesen Bildschirm erneut und versuche es — dein Geld ist noch da, wo es war.',
    insufficient: 'Nicht genug SOL für diese Überweisung plus Netzwerkgebühr.',
    rentExempt: 'Nach dieser Überweisung läge dein Konto unter dem Mindestguthaben. Sende einen kleineren Betrag.',
    blockhash: 'Das Netzwerk war zu ausgelastet. Versuche es erneut.',
    blockhashTwice: 'Das Netzwerk hat die Überweisung zweimal abgelehnt — es wurde nichts gesendet. Versuche es erneut.',
    tapFailed: 'Zahlung nicht abgeschlossen — versuche es erneut',
  },

  errors: errorsDe,
};
