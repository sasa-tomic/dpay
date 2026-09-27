/**
 * i18n/domains/de/convert.ts — German values for the delegated-conversion surface.
 * Types, key documentation and the reference copy: ../en/convert.ts. Glossary: ../../de.ts.
 * Stilmuster: Du-Form (wie der Rest der App). Glossar: „venue" → Handelsplatz; „quote" → Kurs
 * (beim CeFi-Anbieter als befristetes Angebot: Angebot); der Venue-Name kommt als Argument
 * herein (Anzeigename aus der Venue-Registry, nie hier fest verdrahtet). Geldbeträge und
 * Principals werden als fertige Anzeige-Strings übergeben.
 */
import type {ConvertMessages} from '../../keys';

export const convertDe: ConvertMessages = {
  actionConvert: 'Umtauschen',
  heading: (inSym, outSym) => `${inSym} → ${outSym} umtauschen`,
  backToWallet: 'Zurück zur Wallet',


  amountLabel: sym => `Betrag (${sym})`,
  maxAmount: 'Max',
  balanceLine: balance => `Guthaben: ${balance}`,
  counterparty: venue => `Ausgeführt vom ${venue}-Pool.`,
  counterpartySigns: 'Dein Handy signiert; der Pool zieht genau den freigegebenen Betrag ab.',
  quoteSource: (at, venue) => `Kurs von ${venue}, abgerufen ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} hat genau ${amt} notiert`,
  rateLabel: (inSym, outSym) => `Kurs für diesen Umtausch (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool-Gebühr: ${tier} (${venue}-Gebührenstufe)`,
  inputFeeLine: fee => `Eingangsgebühr: ${fee}`,
  outputFeeLine: fee => `Ausgangsgebühr: ${fee}`,
  disclosures: {
    byKey: {
      // disclosure_key 'icpswap' (der Key der Registry für die ICPSwap-Pools): der
      // venue-spezifische Fakt ist, WO der Tausch läuft — der eigene Pool-Vertrag der Venue.
      icpswap: venue => `Der Tausch läuft auf dem eigenen Pool-Vertrag von ${venue} ab.`,
      // disclosure_key 'jupiter' (der Key der Registry für die Solana-Venue-Zeile): die
      // venue-spezifischen Fakten sind, WAS Jupiter ist — ein autonomer On-Chain-Aggregator —
      // und dass der Kurs der eigene ist, unverändert angezeigt, während dpay ganz außerhalb
      // des Tauschs bleibt. Ton wie bei icpswap: benennen, Signer nennen, Parteischeidung.
      jupiter: venue =>
        `${venue} ist ein autonomer On-Chain-Aggregator auf Solana — er wählt die Route, und die Route führt sie aus. Diese Wallet signiert die von ${venue} gebaute Transaktion, und der Kurs ist der eigene von ${venue}, unverändert so angezeigt, wie er ihn veröffentlicht. dpay ist nicht daran beteiligt.`,
      // disclosure_key 'sideshift' (der Key der ersten CeFi-Venue, 2026-09-15): die CeFi-Fakten
      // laut Founder-Entscheid — ein automatisierter Tauschdienst, der Mittel während des
      // Tauschs hält, kein lizenzierter Anbieter; KYC nach DEREN Policy ist DEREN Offenlegung
      // (die eigenen veröffentlichten Bedingungen werden genannt); dpay ist keine Partei und
      // wird nicht bezahlt (das Relay pinnt commissionRate „0").
      sideshift: venue =>
        `${venue} ist ein automatisierter Tauschdienst — kein lizenzierter Anbieter und keine Bank. Er hält deine Mittel während des Tauschs und zahlt dann an deine eigene Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen nach seiner Policy, sind unter sideshift.ai/terms veröffentlicht. Diese Wallet zeigt dir ${venue}s eigenen Kurs und die Einzahlungs-Adresse, und von dpay wird nichts signiert. dpay ist keine Partei des Tauschs und wird nicht bezahlt.`,

      // disclosure_key 'trocador' (der Registry-Schlüssel der ersten AGGREGATOR-CeFi-Zeile,
      // 2026-09-20): dieselben CeFi-Wahrheiten wie sideshift — ein automatisierter
      // Tauschdienst, der Mittel während des Tauschs hält, genannte Bedingungen, dpay ist
      // keine Partei und wird nicht bezahlt — plus die Aggregator-Tatsache: Die Venue wählt
      // unter ihren eigenen Anbietern (dpay rangiert darunter nie) und wird nur um Anbieter
      // ohne Identitätsprüfung gebeten.
      trocador: venue =>
        `${venue} ist ein automatisierter Tausch-Aggregator — er leitet deinen Tausch an einen seiner eigenen Tausch-Anbieter weiter, hält deine Mittel während des Tauschs und zahlt dann an deine eigene Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen eines Anbieters, sind unter trocador.app/terms veröffentlicht. dpay bittet ${venue} um Anbieter ohne Identitätsprüfung. Diese Wallet zeigt dir ${venue}s eigenen Kurs und die Einzahlungs-Adresse, und von dpay wird nichts signiert. dpay ist keine Partei des Tauschs und wird nicht bezahlt.`,
    },
    generic: venue => `Diese Umwandlung wird von ${venue} ausgeführt.`,
  },
  slippageLabel: 'Slippage',
  refusalLine: sym =>
    `Wenn der Pool-Preis bei der Bestätigung über dein Minimum hinaus wandert, scheitert der Tausch: Dein ${sym} bleibt in deiner Wallet, und die Freigabe läuft ungenutzt ab.`,
  detailsLabel: 'Details',
  staleRefreshing: 'Kurs veraltet — wird neu geladen…',
  venueSlow: 'Kürzlich langsam bei der Abwicklung.',
  sheetTitle: inSym => `${inSym} umwandeln`,
  youConvert: amt => `Du wandelst ${amt} um`,
  youReceive: amt => `Du erhältst ≈ ${amt}`,
  quoteFetching: venue => `Kurs von ${venue} wird geholt`,
  autoVenueLine: (venue, n) => `Ausgeführt über ${venue}, höchster gelisteter Kurs von ${n} Venues`,
  autoVenueSingle: venue => `Ausgeführt über ${venue}`,
  otherVenues: n => `Weitere Venues (${n})`,
  atLeast: (amt, pct) => `Mindestens ${amt} (${pct} Slippage)`,
  ctaConvert: amt => `${amt} umwandeln`,
  rateMoved: (oldAmt, newAmt) => `Der Kurs hat sich geändert: ${oldAmt} → ${newAmt}. Bestätige erneut.`,
  neededVsHave: (need, have) => `${need} nötig, du hast ${have}`,
  smallerAmount: 'Wandle einen kleineren Betrag um',
  noPathTitle: inSym => `Kein Umtausch-Kurs von ${inSym} vorhanden`,
  noPathBody: pairs => `Paare mit Kurs heute: ${pairs}`,
  noPathAction: 'Stattdessen Geld einzahlen',
  externalSignTitle: 'Ein Schritt braucht deine eigene Ethereum-Wallet',
  externalSignBody: 'Du signierst die Überquerung in deiner eigenen Wallet; dpay hat ihre Schlüssel nie. Alles davor und danach bleibt hier.',
  signing: 'Signieren…',
  swapVia: venue => `Tausch über ${venue}`,
  awaitingPool: 'Warte auf die Auszahlung des Pools',
  receivedDone: amt => `Du hast ${amt} erhalten`,
  viaChain: venue => `über ${venue}`,
  depositLegSent: (venue, amt) => `${amt} Einzahlung an ${venue} gesendet`,
  depositLegPending: (venue, amt) => `Sende ${amt} an ${venue}`,
  composedOrderLine: (venue, amt) => `Order bei ${venue} erstellt, Auszahlung festgelegt auf ${amt}`,
  depositRefusedBody: (hopSym, venue) =>
    `Die Einzahlung an ${venue} wurde abgelehnt — der Tausch selbst ist durchgelaufen, dein ${hopSym} liegt noch in dieser Wallet. Es wird nichts weiter signiert; tausche oder sende die ${hopSym} über ihr eigenes Konto.`,

  sol: {
    heading: (inSym, outSym) => `${inSym} in ${outSym} umwandeln (Solana)`,
    counterparty: venue => `Ausgeführt von ${venue}.`,
    counterpartySigns: 'Dein Telefon signiert die Transaktion, die die Venue gebaut hat — niemand sonst signiert irgendetwas.',
    priceImpactLine: (pct, venue) => `Preisauswirkung: ${pct} (eigene Angabe von ${venue})`,
    solFeeLine: fee => `Solana-Netzwerkgebühr: ${fee} (an das Netzwerk gezahlt, nicht an die Venue, nicht an dpay)`,
    refusalLine: sym =>
      `Wenn der Preis über das Minimum hinaus wandert, scheitert die Transaktion on-chain: Dein ${sym} bleibt in deiner Wallet, und nichts anderes wurde signiert.`,
    pendingBody:
      'Die Swap-Transaktion liegt im Solana-Netzwerk. Dieser Bildschirm beobachtet die Chain selbst und löst sich von allein auf — kein Neuladen, kein erneuter Versuch nötig.',
    failedBody: (sym, venue, detail) =>
      `${venue}s Swap-Transaktion ist gescheitert${detail ? ` (${detail})` : ''}. Auf Solana bewegt eine gescheiterte Transaktion niemals Gelder — dein ${sym} liegt, wo es lag.`,
  },

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
    `Der Pool hat den Tausch angenommen, aber die ${sym}-Auszahlung ist noch nicht in deiner Wallet angekommen. Dieser Bildschirm bleibt am Ball — du musst gerade nichts tun. Falls sie nie ankommt, nimm diese Angaben zum Support: Pool ${pool}, Tausch übermittelt um ${at}.`,
  stillWatching: 'Weitere Beobachtung der Auszahlung…',
  failedTitle: 'Tausch nicht ausgeführt',
  failedApproveBody: sym =>
    `Das ${sym}-Ledger hat die Freigabe verweigert, deshalb hat sich nichts bewegt — du besitzt weiterhin jede Einheit deines ${sym}. Es wurde keine Freigabe erstellt; nichts muss erstattet oder rückgängig gemacht werden.`,
  failedSwapBody: (reason, sym, venue) =>
    `Der ${venue}-Pool hat den Tausch abgelehnt (${reason}). Dein ${sym} hat deine Wallet nie verlassen — weiter ist nichts nötig.`,
  refundedBody: sym =>
    `Der Tausch ist gescheitert und der Pool hat dir dein ${sym} zurückgegeben — dein Guthaben ist wieder vollständig.`,
  stuckTitle: 'Unbekannter Ausgang',
  stop: 'Stoppen',
  stopWatching: 'Nicht mehr beobachten',
  stopProvider: 'Nicht mehr beobachten',
  abortedTitle: 'Gestoppt',
  abortedClean: 'Nichts hat deine Wallet verlassen.',
  abortedFee: 'Du hast bereits eine kleine Genehmigungsgebühr bezahlt.',
  abortedWatching: 'Der Tausch kann noch durchgehen. Sieh später unter Guthaben nach.',
  abortedProvider:
    'Beobachtung gestoppt. Hast du die Einzahlung nie geschickt, kann sich nichts bewegen — die Order verfällt unbezahlt beim Anbieter. Hast du sie schon geschickt, kann der Tausch noch abschließen: Sieh unter Guthaben nach und auf der Statusseite des Anbieters \u2014 die Shift-ID steht direkt darunter.',
  stuckBody:
    'Der Tausch wurde übermittelt, aber die Antwort des Pools kam nicht an. Starte keinen zweiten Tausch mit denselben Mitteln. Wenn die Auszahlung eintrifft, springt dieser Bildschirm von selbst auf „Getauscht".',
  stuckSigned: (amount, minAmount, venue) =>
    `Was signiert wurde: Freigabe von ${amount} an den ${venue}-Pool; Tausch auf mindestens ${minAmount}.`,
  expiryLine: at => `Die signierten Anweisungen laufen spätestens um ${at} ab — danach kann sich nichts mehr bewegen.`,

  awaitingDepositTitle: 'Warten auf die Einzahlung',
  awaitingDepositBody: (sym, venue) =>
    `${venue} hat diese Order ausgestellt und wartet auf die ${sym}-Einzahlung. Der Swap läuft, sobald der Anbieter die Einzahlung sieht; dpay beobachtet weiterhin seinen Status. Kommt rechtzeitig keine Einzahlung, läuft das Angebot ab und es bewegt sich nichts.`,
  providerProcessingTitle: 'Wird beim Anbieter verarbeitet',
  providerProcessingBody: (sym, venue) =>
    `${venue} hält die Einzahlung und führt die Order aus. Dein ${sym} kommt an, sobald der Anbieter sie abschließt — dpay beobachtet weiter, bis es sich auflöst.`,
  quoteExpiredTitle: 'Angebot abgelaufen',
  quoteExpiredBody: (sym, venue) =>
    `Das Angebot ist abgelaufen, bevor die Einzahlung ankam: ${venue} wartet nicht mehr, also wurde nichts getauscht. Trifft eine Einzahlung doch noch spät ein, gibt sie der Anbieter zurück — dpay beobachtet im Hintergrund weiter, und dieser Bildschirm aktualisiert sich von selbst. Dein ${sym} bleibt solange, wo es ist.`,
  providerRefundedTitle: 'Vom Anbieter erstattet',
  providerRefundedBody: (sym, venue) =>
    `${venue} hat diese Order storniert und die Einzahlung zurückgezahlt. Beobachte, wann dein ${sym} zurückkommt.`,
  stuckWatching: 'dpay beobachtet dies im Hintergrund. Wenn die Auszahlung oder Erstattung ankommt, springt dieser Bildschirm von selbst um.',
  stuckAcknowledge: 'Verstanden — nicht mehr beobachten',
  stuckAcknowledged: 'Du hast dies zur Kenntnis genommen und die Hintergrundbeobachtung ist gestoppt. Wenn sich später Mittel bewegen, landen sie weiterhin an der Adresse dieser Wallet.',

  multihop: {
    destLabel: 'Ziel',
    destDirect: sym => `${sym} — in dieser Wallet`,
    destRoute: (sym, network) => `${sym} — an deine ${network}-Adresse`,
    destRouteSol: (sym, network, venue) => `${sym} — an deine ${network}-Adresse · letzter Schritt über ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route: ${inSym} → ${hopSym} (nach ${network})`,
    destInWallet: sym => `${sym} — in dieser Wallet`,
    destGroupOther: 'Andere Ziele',
    mechDirect: 'Direkter Pool',
    mechViaHub: hubSym => `Über ${hubSym}`,
    mechViaCctp: 'Über Circle CCTP',
    mechViaVenue: venue => `Über ${venue}`,
    mechNoneSelected: 'Wähle oben einen Weg, um das Angebot zu sehen.',
    viaHub: hubSym => `über ${hubSym} · 2 Tauschgeschäfte`,
    hubShape: () => '2 Tauschgeschäfte',
    routeMinWalletLine: (amount, pct) => `Mindestens ${amount} bleiben in dieser Wallet (Slippage-Untergrenze ${pct})`,
    hubQuoteSource: (venue1, venue2, at) => `Angebote von ${venue1} und ${venue2}, abgerufen ${at}`,
    hubCensusHeading: 'Zwei Tauschgeschäfte, einzeln aufgeschlüsselt',
    approveFeeLine: amount => `Die Freigabe des nächsten Pools kostet ${amount} (die eigene Transfergebühr des Ledgers)`,
    hubRateLine: (inSym, destSym) => `Gesamtkurs ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Zahlt ein Tauschgeschäft über seiner Untergrenze aus, bleibt der Überschuss als ${hubSym} oder ${destSym} in dieser Wallet.`,
    destAddressLabel: 'Deine eigene Adresse im Zielnetzwerk',
    destAddressInvalid: 'Keine gültige Zieladresse — erwartet: 0x gefolgt von 40 Hex-Zeichen.',
    routeHeading: (inSym, hopSym, destSym, network) => `Route: ${inSym} → ${hopSym} → ${destSym} auf ${network}`,
    swapPaysLabel: 'Der Tausch zahlt in diese Wallet',
    legApprovePull: sym => `Den Pool ermächtigen, deine ${sym} abzuziehen`,
    legSwap: (venue, inSym, hopSym) => `${inSym} → ${hopSym} auf ${venue} tauschen`,
    legApproveBurn: sym => `Das Verbrennen von ${sym} ermächtigen (der Auszahlungsbetrag)`,
    legApproveGas: sym => `${sym} für das Auszahlungs-Gas ermächtigen`,
    legWithdraw: (hopSym, destSym, network) => `${hopSym} verbrennen — ${destSym} kommt auf ${network} an`,
    legStatePending: 'Wartet',
    legStateSent: 'Gesendet',
    legStateConfirmed: 'Bestätigt',
    legStateFailed: 'Abgelehnt',
    legProgress: (n, total) => `Schritt ${n} von ${total}`,
    gasFeeLine: amount => `Auszahlungs-Gas (Live-Angebot des Minters): ${amount}`,
    routeMinLine: (amount, pct) => `Mindestens ${amount} an deiner Adresse (Slippage-Untergrenze ${pct})`,
    routeSurplusNote: hopSym => `Zahlt der Tausch über der Untergrenze, bleibt der Überschuss als ${hopSym} in dieser Wallet.`,
    routeDestEstimate: (amount, sym) =>
      `Geschätzte Ankunft: \u2248 ${amount} ${sym} an deiner Solana-Adresse — der letzte Schritt holt bei Jupiter einen frischen Kurs`,
    routeVenues: (icVenue, solVenue) => `Route: ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Die Auszahlung braucht erst Gas',
    gasPreflightBody: needed =>
      `Das Verbrennen nach Ethereum kostet Gas in ckETH — und diese Wallet hat nicht genug davon. Es braucht etwa ${needed} (das Live-Gas-Angebot des Minters plus seine Ermächtigungsgebühr). Hol zuerst ckETH in diese Wallet und komm dann zurück — einen Gas-Anteil hier zu kaufen ist Zukunftarbeit, und dpay versteckt dir diese Kosten nicht.`,
    executingTitle: 'Route läuft',
    doneRouteTitle: 'Auszahlung läuft',
    doneRouteBody: (amount, address) => `Mindestens ${amount} ist unterwegs zu ${address}.`,
    doneOnItsWay: 'Die Zustellung passiert auf Ethereum und kann dauern — dpay kann dieses Netzwerk nicht beobachten. Du musst nichts weiter tun.',
    failedLegTitle: 'Der Auszahlungsschritt wurde abgelehnt',
    failedLegBody: (sym, reason) =>
      `Der Tausch ist durch — deine Mittel liegen als ${sym} in dieser Wallet, nichts verloren und nichts blockiert. Die Auszahlung wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Zum Auszahlen öffne Bezahlen, wähle An Adresse senden und füge eine beliebige Ziel-Adresse ein — der Auszahlungsschritt läuft von dort.',
    stuckRouteBody: 'Ein Schritt wurde gesendet, aber sein Ergebnis ist noch unbekannt. dpay beobachtet die Ledgers weiter im Hintergrund — sobald die Auszahlung oder Rückerstattung ankommt, wechselt dieser Bildschirm von selbst.',
    failedHop2Title: 'Der zweite Tausch wurde abgelehnt',
    failedHop2Body: (hubSym, outSym, reason) =>
      `Der erste Tausch ist durch — du hältst ${hubSym} in dieser Wallet, nichts verloren und nichts steckengeblieben. Der Tausch ${hubSym} → ${outSym} wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Deine ${hubSym} sind so brauchbar wie immer: behalte sie, tausche sie später von ihrem eigenen Konto, oder sende sie. Nichts muss rückgängig gemacht werden.`,
    stuckHoldsLine: hubSym => `Bisher erreicht: du hältst ${hubSym} in dieser Wallet.`,
    insufficientHubLine: (needed, balance) =>
      `Diese Umrechnung braucht ${needed} — der Betrag plus drei Ledger-Gebühren — und diese Wallet hält ${balance}. Senke den Betrag oder lade zuerst mehr auf.`,
  },

  /** CeFi-Venues (SideShift-Erweiterung, 2026-09-15): die Einzahlungs-Übergabe. Die Venue
   *  hält die Mittel während des Tauschs; die eigene Einzahlung des Nutzers IST die
   *  Wertbewegung — von dpay wird nichts signiert. Jede Adresse/jeder Betrag ist der
   *  eigene der Venue, unverändert. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} auf ${network} — über ${venue} (Tauschdienst)`,
    destRowMulti: (sym, network) => `${sym} auf ${network}`,
    settleAddressLabel: 'Die Auszahlung landet an deiner eigenen Adresse im Zielnetzwerk',
    depositAddressLabel: 'Einzahlungs-Adresse',
    depositAmountLabel: 'Genauer Einzahlungsbetrag',
    depositMemoLabel: 'Memo (erforderlich)',
    depositExpiryLine: at => `Bestellung läuft um ${at} ab`,
    noExpiryLine: 'Kein Ablaufdatum veröffentlicht — dpay beobachtet weiter, bis der Anbieter die Order abschließt.',
    lastCheckedLine: at => `Zuletzt geprüft: ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: `Fonds bei der Plattform bestätigt — deine Auszahlung ist auf den genannten Betrag festgelegt.`,
    settlingWatchLine: `Die meisten Konvertierungen sind in Minuten abgewickelt. dpay überwacht jeden Shift und interviniert bei der Plattform, falls einer hakt — nichts für dich zu tun.`,
    counterparty: venue =>
      `Ausgeführt von ${venue} — ein automatisierter Tauschdienst, kein lizenzierter Anbieter und nicht dpay.`,
    checklistSigns:
      'Auf diesem Telefon wird nichts signiert — nach der Bestätigung sendest du die Einzahlung selbst an die Adresse des Tauschdiensts.',
    refusalLine: sym =>
      `Wenn die Einzahlung nicht ankommt, läuft die Bestellung ab — nichts wird bewegt und dein ${sym} bleibt in deiner Wallet.`,
    insufficientLine: (needed, balance) =>
      `Diese Einzahlung braucht ${needed} — der Betrag plus eine Transfergebühr — und diese Wallet hält ${balance}. Reduziere den Betrag oder empfange zuerst mehr.`,
    payoutAt: address => `Ausgezahlt auf deine eigene Adresse: ${address}`,
    depositNote: (venue, sym) =>
      `Sende ${sym} aus deiner Wallet an die Einzahlungs-Adresse von ${venue} oben — genau den Einzahlungsbetrag. ${venue} ist ein automatisierter Tauschdienst: Er hält dein ${sym} während des Tauschs und zahlt dann an deine Adresse aus. dpay ist keine Partei dieses Tauschs und wird nicht bezahlt.`,
    stillWaitingDeposit: 'Weitere Beobachtung deiner Einzahlung — diese Seite aktualisiert sich von selbst.',
    depositSolFeeNote: 'Beim Senden der Einzahlung fällt auch eine kleine Netzwerkgebühr in SOL an — halte etwas SOL in dieser Wallet.',
    solInsufficientLine: (needed, balance) =>
      `Diese Einzahlung sendet genau ${needed} und diese Wallet hält ${balance}. Reduziere den Betrag oder empfange zuerst mehr.`,
    noQuoteTitle: 'Gerade kein Markt für dieses Paar',
    noQuoteBody: venue =>
      `${venue} listet dieses Paar, hat aber gerade keinen Live-Markt. Nichts wurde gesendet. Wähle einen anderen Handelsplatz oder versuche es später erneut.`,
  },

  /** Die Cross-Rail-Familie (Routen B/C, 2026-09-16): alles nach den fünf IC-Beinen —
   *  der CCTP-Handoff (dpay zeigt die exakten Transaktionen, die EIGENE Ethereum-Wallet
   *  des Nutzers signiert; dpay hält nie einen EVM-Schlüssel), das Warten auf Circles
   *  Attestierung und Jupiters finales Angebot in Route C. Jede Sackgasse nennt, wo die
   *  Mittel liegen, und den Ausweg. */
  crossrail: {
    heading: 'In deiner Ethereum-Wallet signieren',
    handoffIntro: (amount) =>
      `Der Internet-Computer-Teil ist erledigt: ${amount} liegt an deiner Ethereum-Adresse. Deine Wallet schickt ihn jetzt rüber — dpay fasst deine Ethereum-Schlüssel nie an.`,
    stepApproveLabel: 'Schritt 1 — Circle\u2019s Vertrag darf die USDC bewegen',
    stepBurnLabel: 'Schritt 2 — die USDC für den Solana-Transfer verbrennen',
    txAmountLabel: 'Betrag',
    copy: 'Kopieren',
    copied: 'Kopiert',
    approveHint: 'Das erlaubt Circle\u2019s TokenMessenger, exakt die gesendeten USDC zu bewegen — nichts weiter.',
    burnHint: 'Das sperrt die USDC auf Ethereum. Circles Bridge prägt daraufhin dieselben USDC an deine Solana-Adresse — kein gewrapptes Token, Circle erledigt die Ankunft für dich.',
    timingNote: 'Auf dem schnellen Pfad dauert die Ankunft typischerweise Sekunden bis wenige Minuten (in unserer Live-Prüfung ~20 s). Ist Ethereum beschäftigt, kann es länger dauern — dieser Bildschirm aktualisiert sich von selbst.',
    externalGasLine: 'Das Ethereum-Gas für diese beiden Transaktionen zahlt das ETH deiner eigenen Wallet. dpay kann es weder zahlen noch exakt beziffern.',
    circleFeeLine: fee => `Circle\u2019s Bridge-Gebühr (seine eigene Zahl, vom Betrag abgezogen): höchstens ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Mindestens ${floor} ${sym} werden zu deiner Solana-Adresse übertragen — der letzte Schritt tauscht sie für dein Ziel weiter`,
    mintFloorDestLine: (floor, sym) => `Mindestens ${floor} ${sym} kommen an deiner Solana-Adresse an`,
    burnTxLabel: 'Burn-Transaktions-Hash (aus deiner Wallet, nach dem Signieren)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Ich habe signiert — den Transfer beobachten',
    burnTxInvalid: 'Das sieht nicht nach einem Ethereum-Transaktions-Hash aus.',
    declineButton: 'Ich signiere das nicht',
    whatSigning: 'Du signierst zwei ganz normale Ethereum-Transaktionen in deiner eigenen Wallet: eine Freigabe, dann den Burn. Auf dpay-Seite wird bei diesem Schritt nichts signiert.',
    crossingTitle: 'Überquerung nach Solana',
    crossingBody: 'Circle attestiert den Burn und prägt die USDC an deine Solana-Adresse. dpay beobachtet Circles eigenen Status-Feed — diese Seite wechselt von selbst.',
    viewBurnTx: 'Burn-Transaktion ansehen',
    viewCircle: 'Circles Status-Seite',
    stillCrossing: 'Die Attestierung ist noch nicht fertig. Das bleibt offen — es ist nicht fehlgeschlagen. Auf dem schnellen Pfad sind es Sekunden bis Minuten; bei Stau auf Ethereum länger.',
    solReadyTitle: 'USDC sind auf Solana angekommen',
    solReadyBody: (credit, ata) => `${credit} liegen bei ${ata}, on-chain verifiziert. Schließe die Route ab — oder lass die USDC dort, sie sind in beiden Fällen deine.`,
    abortedCrossing: ata =>
      `Beobachtung gestoppt. Dein Burn ist schon raus, Circle kann den Mint also noch abschließen — die USDC landet so oder so an deiner eigenen Solana-Adresse ${ata}. Sieh später unter Guthaben nach.`,
    abortedSolReady: ata =>
      `Es wurde nichts signiert — der letzte Tausch lief nie. Deine USDC liegen an deiner eigenen Solana-Adresse ${ata}: behalte sie oder wandle sie dort weiter um.`,
    solQuoteLabel: venue => `${venue}-Kurs (frisch)`,
    solMinLine: (min, sym) => `Mindestens ${min} ${sym} an deiner Adresse`,
    solConfirmButton: sym => `Zu ${sym} tauschen`,
    solFeeLine: fee => `Solana-Transaktionsgebühr: ${fee}`,
    solPreflightTitle: 'Etwas SOL ist nötig für die Gebühr',
    solPreflightBody:
      'Die Netzwerkgebühr des Tauschs wird in SOL gezahlt, und diese Wallet hält kein SOL. Hol zuerst etwas SOL in diese Wallet — die USDC bleiben derweil sicher liegen.',
    doneTitle: 'Umgetauscht',
    doneBody: (amount, sym, address) => `${amount} ${sym} liegen an deiner Solana-Adresse ${address} — on-chain verifiziert.`,
    doneVia: (icVenue, solVenue) => `Umgetauscht über ${icVenue}, Circle und ${solVenue}.`,
    declinedTitle: 'Handoff abgebrochen',
    declinedBody: address =>
      `Nichts ist überquert. Deine USDC liegen an deiner eigenen Ethereum-Adresse ${address} — sende sie von deiner Wallet irgendwohin hin oder starte diese Route später erneut.`,
    solFailedTitle: 'Der Solana-Tausch ging nicht durch',
    solFailedBody: (ata, venue) =>
      `Die USDC sind bereits sicher überquert und liegen an deiner Solana-Adresse ${ata}. ${venue} hat den letzten Tausch abgelehnt — versuche es hier gleich nochmal oder behalte die USDC.`,
    legCctpBurn: (sym, network) => `${sym} über Circle nach ${network} bringen (du signierst das in deiner Wallet)`,
    legSolSwap: (venue, sym) => `Auf ${venue} in ${sym} tauschen`,
    destAddressCrossNote: 'Diese Ethereum-Adresse ist zugleich die Wallet, die die Überquerung signiert — füge eine Adresse ein, die du kontrollierst.',
    checksumMismatch: 'Prüfsummenfehler',
    retypeAddress: 'Adresse erneut eingeben',
    retypeMismatch: 'Stimmt nicht überein',
    gasFundTitle: 'Diese Umwandlung braucht ETH-Gas, das du nicht hast',
    gasFundNeed: eth => `Bedarf \u2248 ${eth}`,
    gasFundHave: eth => `Deine Wallet: ${eth}`,
    gasFundWalletButton: 'Aus dieser Wallet finanzieren',
    gasFundSelfButton: 'Ich finanziere selbst',
    gasFundSelfMin: eth => `Sende \u2265 ${eth} an:`,
    gasFundRecheck: 'Noch einmal prüfen',
    gasFundShort: short => `Es fehlen weiterhin ${short}`,
    gasLegsNote: 'Die ersten Schritte finanzieren das Gas.',
    abortedGasBody: 'Die Gas-Finanzierung ist abgeschlossen — sie liegt noch in dieser Wallet. Die Umwandlung selbst lief nie.',
    declinedWithGasBody: address => `Nichts ist überquert. Deine USDC liegen an deiner Ethereum-Adresse ${address}; die Gas-Finanzierung liegt noch in dieser Wallet.`,
    gasShortFailedBody: needed => `Die Gas-Finanzierung blieb unter ${needed}. Nichts hat diese Wallet verlassen — die Umwandlung startete nie.`,
  },

  errors: {
    quoteUnreachable: venue => `Der Kurs von ${venue} war nicht abrufbar — das Relay antwortet nicht. Prüfe deine Verbindung und versuche es erneut.`,
    quoteRefused: venue => `${venue} hat abgelehnt, für dieses Paar gerade einen Kurs zu liefern.`,
    buildRefused: venue => `${venue} konnte den Tausch gerade nicht vorbereiten. Nichts wurde bewegt. Erneut versuchen.`,
    quoteUnavailable: code => `Kurs nicht verfügbar (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} ist auf diesem Relay noch nicht eingerichtet — es ist keine Partner-Berechtigung konfiguriert, daher kann kein Kurs angefragt werden. Mit deiner Wallet ist nichts verkehrt.`,
    gasUnavailable: 'Der Gaspreis des Auszahlungs-Minters ließ sich nicht abfragen — nichts wurde signiert. Versuche es erneut.',
    cctpFeeUnavailable: 'Circles Bridge-Gebühr ließ sich nicht abrufen — nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut.',
  },
};
