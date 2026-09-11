/**
 * i18n/domains/de/convert.ts — German values for the delegated-conversion surface.
 * Types, key documentation and the reference copy: ../en/convert.ts. Glossary: ../../de.ts.
 * Stilmuster:Du-Form (wie der Rest der App). „Quote" bleibt als Fachbegriff erhalten; der
 * Venue-Name kommt als Argument herein (Anzeigename aus der Venue-Registry, nie hier fest
 * verdrahtet). Geldbeträge und Principals werden als fertige Anzeige-Strings übergeben.
 */
import type {ConvertMessages} from '../../keys';

export const convertDe: ConvertMessages = {
  actionConvert: 'Umtauschen',
  heading: (inSym, outSym) => `${inSym} → ${outSym} umtauschen`,
  backToWallet: 'Zurück zur Wallet',

  unavailableTitle: sym => `Umtausch ist für ${sym} noch nicht verfügbar`,
  unavailableBody: (pair, venue) => `Heute tauscht dpay ${pair} über ${venue} um — und nichts sonst.`,
  unavailableCkusdc: venue =>
    `Ein direkter VCHF-↔-USDC-Pool existiert bei ${venue}, aber seine Tiefe ist gesättigt (etwa CHF 315) — dpay lehnt ihn ab, statt dir einen veralteten Preis zu zeigen.`,

  amountLabel: sym => `Betrag (${sym})`,
  balanceLine: balance => `Guthaben: ${balance}`,
  receiveHeadline: 'Du erhältst',
  counterparty: venue =>
    `Ausgeführt vom ${venue}-Pool — ein autonomer On-Chain-Vertrag, kein lizenzierter Anbieter und nicht dpay.`,
  counterpartySigns: 'Dein Handy signiert; der Pool zieht genau den freigegebenen Betrag ab.',
  quoteSource: (at, venue) => `Quote von ${venue}, abgerufen ${at}`,
  rateLabel: (inSym, outSym) => `Kurs dieser Quote (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool-Gebühr: ${tier} (${venue}-Gebührenstufe)`,
  inputFeeLine: fee => `Eingangsgebühr: ${fee}`,
  outputFeeLine: fee => `Ausgangsgebühr: ${fee}`,
  dpayFeeLine: 'dpay verlangt nichts und bekommt nichts dafür.',
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (der Key der Registry für die ICPSwap-Pools): der
      // venue-spezifische Fakt ist, WO der Tausch läuft — der eigene Pool-Vertrag der Venue,
      // vom Nutzer signiert, dpay nicht Partei.
      icpswap: venue =>
        `Der Tausch läuft auf dem eigenen Pool-Vertrag von ${venue} ab. Jeder Aufruf wird von dir signiert und direkt übermittelt — ${venue} führt den Tausch aus, und dpay ist nicht daran beteiligt.`,
    },
    generic: venue =>
      `Diese Umwandlung wird von ${venue} ausgeführt. Jeder Aufruf wird von dir signiert und direkt übermittelt — dpay ist nicht daran beteiligt.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Mindestens erhältst du: ${amount} (${pct} Slippage)`,
  refusalLine: sym =>
    `Wenn der Pool-Preis bei der Bestätigung über dein Minimum hinaus wandert, scheitert der Tausch: Dein ${sym} bleibt in deiner Wallet, und die Freigabe läuft ungenutzt ab.`,
  netEndStateLine: amount => `Endergebnis: ${amount} erwartet in deiner Wallet, nach allen Gebühren.`,
  confirmButton: 'Neu quoten und bestätigen',
  staleRefreshing: 'Quote veraltet — wird neu geladen…',
  quoteChanged: (oldAmt, newAmt) => `Quote geändert: ${oldAmt} → ${newAmt}. Prüfe und bestätige erneut.`,
  venueChooserLabel: 'Venue',
  venueNoneSelected: 'Wähle eine Venue, um ihre vollständige Quote zu sehen und fortzufahren.',
  venueRowQuote: amount => `Quote: ${amount}`,

  fundBody: (sym, receiveTab, myAddress) =>
    `Diese Wallet hat kein ${sym}. Um ${sym} umzutauschen, empfange zuerst ${sym} an deiner Adresse: öffne unten „${receiveTab}“ und wähle „${myAddress}“.`,
  fundOtherHolds: (held, toSym) => `Du hast ${held} — das kannst du stattdessen in ${toSym} umwandeln.`,
  fundOtherSwitch: sym => `Stattdessen aus ${sym} umwandeln`,
  insufficientLine: (needed, balance) =>
    `Für diesen Umtausch brauchst du ${needed} — der Betrag plus zwei Ledger-Gebühren — und diese Wallet hält ${balance}. Verringere den Betrag oder empfange zuerst mehr.`,

  approvingTitle: 'Freigabe läuft',
  approvingBody: (amount, at) =>
    `Dein Handy gibt dem Pool frei, genau ${amount} abzuziehen. Die Freigabe läuft um ${at} ungenutzt ab.`,
  swappingTitle: 'Tausch läuft',
  swappingBody: venue => `Der Tausch wird an den ${venue}-Pool übermittelt. Er kann nur den freigegebenen Betrag abziehen.`,
  settlingTitle: 'Abwicklung',
  settlingBody: sym => `Der Pool hat den Tausch angenommen. Dein ${sym} trifft gleich in deiner Wallet ein…`,
  doneTitle: 'Getauscht ✓',
  doneBody: amount => `${amount} wurden in deiner Wallet gutgeschrieben.`,
  doneTx: tx => `Auszahlungs-Eintrag: ${tx}`,
  pendingTitle: 'Auszahlung ausstehend',
  pendingBody: (sym, pool, at) =>
    `Der Pool hat den Tausch angenommen, aber die ${sym}-Auszahlung ist noch nicht in deiner Wallet angekommen. Dieser Bildschirm bleibt am Ball — du musst gerade nichts tun. dpay kann die Auszahlung nicht rückgängig machen und nicht beschleunigen. Falls sie nie ankommt, nimm diese Angaben zum Support: Pool ${pool}, Tausch übermittelt um ${at}.`,
  stillWatching: 'Weitere Beobachtung der Auszahlung…',
  failedTitle: 'Tausch nicht ausgeführt',
  failedApproveBody: sym =>
    `Das ${sym}-Ledger hat die Freigabe verweigert, deshalb hat sich nichts bewegt — du besitzt weiterhin jede Einheit deines ${sym}. Es wurde keine Freigabe erstellt; nichts muss erstattet oder rückgängig gemacht werden.`,
  failedSwapBody: (reason, sym, venue) =>
    `Der ${venue}-Pool hat den Tausch abgelehnt (${reason}). Dein ${sym} hat deine Wallet nie verlassen. dpay kann ihn weder rückgängig machen noch für dich wiederholen; weiter ist nichts nötig.`,
  refundedBody: sym =>
    `Der Tausch ist gescheitert und der Pool hat dir dein ${sym} zurückgegeben — dein Guthaben ist wieder vollständig. dpay kann hier nichts rückgängig machen.`,
  stuckTitle: 'Unbekannter Ausgang',
  stuckBody:
    'Der Tausch wurde übermittelt, aber die Antwort des Pools kam nicht an. Starte keinen zweiten Tausch mit denselben Mitteln. Wenn die Auszahlung eintrifft, springt dieser Bildschirm von selbst auf „Getauscht".',
  stuckSigned: (amount, minAmount, venue) =>
    `Was signiert wurde: Freigabe von ${amount} an den ${venue}-Pool; Tausch auf mindestens ${minAmount}.`,
  expiryLine: at => `Die ungenutzte Freigabe läuft spätestens um ${at} ab — danach kann der Pool nichts mehr abziehen.`,

  awaitingAuthTitle: 'Freigabe erforderlich',
  awaitingAuthBody: venue =>
    `Diese Order liegt bei ${venue} und wartet auf deine Freigabe. Es hat sich nichts bewegt und wird sich nichts bewegen, bis du sie freigibst — dpay beobachtet derweil den Status des Anbieters.`,
  awaitingDepositTitle: 'Warten auf die Einzahlung',
  awaitingDepositBody: (sym, venue) =>
    `${venue} hat diese Order ausgestellt und wartet auf die ${sym}-Einzahlung. Der Swap läuft, sobald der Anbieter die Einzahlung sieht; dpay beobachtet weiterhin seinen Status. Kommt rechtzeitig keine Einzahlung, läuft die Quote ab und es bewegt sich nichts.`,
  providerProcessingTitle: 'Wird beim Anbieter verarbeitet',
  providerProcessingBody: (sym, venue) =>
    `${venue} hält die Einzahlung und führt die Order aus. Dein ${sym} kommt an, sobald der Anbieter sie abschließt — dpay kann das weder rückgängig machen noch beschleunigen und beobachtet weiter, bis es sich auflöst.`,
  quoteExpiredTitle: 'Quote abgelaufen',
  quoteExpiredBody: (sym, venue) =>
    `Die Quote ist abgelaufen, bevor ein Wert bewegt wurde: ${venue} hat die Einzahlung nie erhalten, also wurde nichts getauscht und nichts muss rückgängig gemacht werden. Dein ${sym} ist geblieben, wo es war — starte eine neue Umwandlung, wenn du weiterhin eine möchtest.`,
  providerRefundedTitle: 'Vom Anbieter erstattet',
  providerRefundedBody: (sym, venue) =>
    `${venue} hat diese Order storniert und die Einzahlung zurückgezahlt. Beobachte, wann dein ${sym} zurückkommt — dpay kann die Erstattung des Anbieters weder rückgängig machen noch beschleunigen.`,
  stuckWatching: 'dpay beobachtet dies im Hintergrund. Wenn die Auszahlung oder Erstattung ankommt, springt dieser Bildschirm von selbst um.',
  stuckAcknowledge: 'Verstanden — nicht mehr beobachten',
  stuckAcknowledged: 'Du hast dies zur Kenntnis genommen und die Hintergrundbeobachtung ist gestoppt. Wenn sich später Mittel bewegen, landen sie weiterhin an der Adresse dieser Wallet.',

  errors: {
    quoteUnreachable: venue => `Die ${venue}-Quote war nicht erreichbar — das Relay antwortet nicht. Prüfe deine Verbindung und versuche es erneut.`,
    quoteRefused: venue => `${venue} hat abgelehnt, dieses Paar gerade zu quoten.`,
    quoteUnavailable: code => `Quote nicht verfügbar (${code}).`,
  },
};
