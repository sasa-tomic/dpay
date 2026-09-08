/**
 * i18n/domains/de/convert.ts — German values for the delegated-conversion surface.
 * Types, key documentation and the reference copy: ../en/convert.ts. Glossary: ../../de.ts.
 * Stilmuster:Du-Form (wie der Rest der App). „Quote" bleibt als Fachbegriff erhalten; die Venue
 * heißt immer „ICPSwap". Geldbeträge und Principals werden als fertige Anzeige-Strings übergeben.
 */
import type {ConvertMessages} from '../../keys';

export const convertDe: ConvertMessages = {
  actionConvert: 'Umtauschen',
  heading: (inSym, outSym) => `${inSym} → ${outSym} umtauschen`,
  backToWallet: 'Zurück zur Wallet',

  unavailableTitle: sym => `Umtausch ist für ${sym} noch nicht verfügbar`,
  unavailableBody: pair => `Heute tauscht dpay ${pair} über ICPSwap um — und nichts sonst.`,
  unavailableCkusdc:
    'Ein direkter VCHF-↔-USDC-Pool existiert, aber seine Tiefe ist gesättigt (etwa CHF 315) — dpay lehnt ihn ab, statt dir einen veralteten Preis zu zeigen.',

  amountLabel: sym => `Betrag (${sym})`,
  balanceLine: balance => `Guthaben: ${balance}`,
  receiveHeadline: 'Du erhältst',
  counterparty:
    'Ausgeführt vom ICPSwap-Pool — ein autonomer On-Chain-Vertrag, kein lizenzierter Anbieter und nicht dpay.',
  counterpartySigns: 'Dein Handy signiert; der Pool zieht genau den freigegebenen Betrag ab.',
  quoteSource: at => `Quote von ICPSwap, abgerufen ${at}`,
  rateLabel: (inSym, outSym) => `Kurs (${inSym} → ${outSym})`,
  poolFeeTier: tier => `Pool-Gebühr: ${tier} (ICPSwap-Gebührenstufe)`,
  inputFeeLine: fee => `Eingangsgebühr: ${fee}`,
  outputFeeLine: fee => `Ausgangsgebühr: ${fee}`,
  dpayFeeLine: 'dpay verlangt nichts und bekommt nichts dafür.',
  impactLine: pct => `Preiseffekt: ${pct}`,
  impactWarnLine: pct => `Hoher Preiseffekt: ${pct} — die Quote oben enthält ihn bereits.`,
  impactUnavailable:
    'Preiseffekt: gerade nicht messbar — ICPSwap hat für den Referenz-Tausch nichts angeboten, es gibt also keinen Kurs zum Vergleich. Der Mindestbetrag unten begrenzt trotzdem, was dich dieser Tausch kosten kann.',
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Mindestens erhältst du: ${amount} (${pct} Slippage)`,
  refusalLine: sym =>
    `Wenn der Pool-Preis bei der Bestätigung über dein Minimum hinaus wandert, scheitert der Tausch: Dein ${sym} bleibt in deiner Wallet, und die Freigabe läuft ungenutzt ab.`,
  netEndStateLine: amount => `Endergebnis: ${amount} erwartet in deiner Wallet, nach allen Gebühren.`,
  confirmButton: 'Neu quoten und bestätigen',
  staleRefreshing: 'Quote veraltet — wird neu geladen…',
  quoteChanged: (oldAmt, newAmt) => `Quote geändert: ${oldAmt} → ${newAmt}. Prüfe und bestätige erneut.`,

  fundBody: (sym, receiveTab, myAddress) =>
    `Diese Wallet hat kein ${sym}. Um ${sym} umzutauschen, empfange zuerst ${sym} an deiner Adresse: öffne unten „${receiveTab}“ und wähle „${myAddress}“.`,
  insufficientLine: (needed, balance) =>
    `Für diesen Umtausch brauchst du ${needed} — der Betrag plus zwei Ledger-Gebühren — und diese Wallet hält ${balance}. Verringere den Betrag oder empfange zuerst mehr.`,

  approvingTitle: 'Freigabe läuft',
  approvingBody: (amount, at) =>
    `Dein Handy gibt dem Pool frei, genau ${amount} abzuziehen. Die Freigabe läuft um ${at} ungenutzt ab.`,
  swappingTitle: 'Tausch läuft',
  swappingBody: 'Der Tausch wird an den ICPSwap-Pool übermittelt. Er kann nur den freigegebenen Betrag abziehen.',
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
  failedSwapBody: (reason, sym) =>
    `Der ICPSwap-Pool hat den Tausch abgelehnt (${reason}). Dein ${sym} hat deine Wallet nie verlassen. dpay kann ihn weder rückgängig machen noch für dich wiederholen; weiter ist nichts nötig.`,
  refundedBody: sym =>
    `Der Tausch ist gescheitert und der Pool hat dir dein ${sym} zurückgegeben — dein Guthaben ist wieder vollständig. dpay kann hier nichts rückgängig machen.`,
  stuckTitle: 'Unbekannter Ausgang',
  stuckBody:
    'Der Tausch wurde übermittelt, aber die Antwort des Pools kam nicht an. Starte keinen zweiten Tausch mit denselben Mitteln. Wenn die Auszahlung eintrifft, springt dieser Bildschirm von selbst auf „Getauscht".',
  stuckSigned: (amount, minAmount) =>
    `Was signiert wurde: Freigabe von ${amount} an den ICPSwap-Pool; Tausch auf mindestens ${minAmount}.`,
  expiryLine: at => `Die ungenutzte Freigabe läuft spätestens um ${at} ab — danach kann der Pool nichts mehr abziehen.`,

  errors: {
    quoteUnreachable: () => 'Die ICPSwap-Quote war nicht erreichbar — das Relay antwortet nicht. Prüfe deine Verbindung und versuche es erneut.',
    quoteRefused: () => 'ICPSwap hat abgelehnt, dieses Paar gerade zu quoten.',
    quoteUnavailable: code => `Quote nicht verfügbar (${code}).`,
    swapReplyShape: () => 'Die Antwort des Pools ließ sich nicht lesen.',
  },
};
