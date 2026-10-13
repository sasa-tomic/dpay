/**
 * i18n/domains/de/convert.ts - German values for the delegated-conversion surface.
 * Types, key documentation and the reference copy: ../en/convert.ts. Glossary: ../../de.ts.
 * Stilmuster: Du-Form (wie der Rest der App). Glossar: „venue" → Handelsplatz; „quote" → Kurs
 * (beim CeFi-Anbieter als befristetes Angebot: Angebot); der Venue-Name kommt als Argument
 * herein (Anzeigename aus der Venue-Registry, nie hier fest verdrahtet). Geldbeträge und
 * Principals werden als fertige Anzeige-Strings übergeben. Zweite Verschlankung (2026-09-29):
 * Fragmente statt Sätze, wo der Sinn trägt.
 */
import type {ConvertMessages} from '../../keys';

export const convertDe: ConvertMessages = {
  actionConvert: 'Umtauschen',
  heading: (inSym, outSym) => `${inSym} → ${outSym} umtauschen`,
  backToWallet: 'Zurück zur Wallet',


  amountLabel: sym => `${sym}`,
  maxAmount: 'Max',
  balanceLine: balance => `Guthaben ${balance}`,
  counterparty: venue => `Ausgeführt vom ${venue}-Pool.`,
  counterpartySigns: 'Dein Handy signiert; der Pool darf nur den vereinbarten Betrag nutzen.',
  quoteSource: (at, venue) => `${venue} · ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} hat notiert: ${amt}`,
  rateLabel: (inSym, outSym) => `Kurs (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool-Gebühr: ${tier} (${venue}-Gebührenstufe)`,
  inputFeeLine: fee => `Eingangsgebühr: ${fee}`,
  outputFeeLine: fee => `Ausgangsgebühr: ${fee}`,
  disclosures: {
    byKey: {
      icpswap: venue => `Läuft auf dem Pool-Vertrag von ${venue}.`,
      jupiter: venue =>
        `${venue} ist ein autonomer On-Chain-Aggregator auf Solana - er wählt die Route und führt sie aus. Diese Wallet signiert die Transaktion, die ${venue} baut, und der Kurs kommt unverändert von ${venue}. dpay ist nicht Partei.`,
      sideshift: venue =>
        `${venue} ist ein automatisierter Tauschdienst - kein lizenzierter Anbieter, keine Bank. Er hält deine Mittel während des Tauschs und zahlt dann an deine Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen nach seiner Policy, stehen unter sideshift.ai/terms. Kurs und Einzahlungs-Adresse kommen unverändert von ${venue} - deine Mittel gehen direkt aus deiner Wallet an den Dienst; dpay ist nicht Partei und wird nicht bezahlt.`,
      trocador: venue =>
        `${venue} ist ein automatisierter Tausch-Aggregator - er leitet deinen Tausch an einen seiner Anbieter weiter und hält deine Mittel während des Tauschs, zahlt dann an deine Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen eines Anbieters, stehen unter trocador.app/terms. dpay bittet ${venue} nur um Anbieter ohne Identitätsprüfung. Kurs und Einzahlungs-Adresse kommen unverändert von ${venue} - deine Mittel gehen direkt aus deiner Wallet an den Dienst; dpay ist nicht Partei und wird nicht bezahlt.`,
      cowswap: venue =>
        `${venue} erfüllt signierte Off-Chain-Aufträge mit konkurrierenden Solvern, meist in Sekunden bis Minuten. Die Übersicht zeigt die Gebühr direkt von ${venue}. dpay signiert Ihren Auftrag, ist nicht Partei und wird nicht bezahlt.`,
    },
    generic: venue => `Ausgeführt von ${venue}.`,
  },
  slippageLabel: 'Slippage',
  refusalLine: sym =>
    `Über deinem Minimum scheitert der Tausch - dein ${sym} bleibt in deiner Wallet, die Freigabe läuft ungenutzt ab.`,
  arrives: 'Kommt in ein paar Minuten an.',
  feeAbout: fee => `Gebühr etwa ${fee}.`,
  exchangesInvolved: n => `${n} Börsen beteiligt.`,
  detailsLabel: 'Details',
  staleRefreshing: 'Kurs veraltet - wird neu geladen…',
  venueSlow: 'Kürzlich langsam bei der Abwicklung.',
  sheetTitle: inSym => `${inSym} umwandeln`,
  youReceive: amt => `Du erhältst ≈ ${amt}`,
  quoteFetching: 'Kurs wird geholt…',
  autoVenueLine: (venue, at, n) => `${venue} · ${at} · ${n} Handelsplätze`,
  otherVenues: n => `Optionen (${n})`,
  atLeast: amt => `Min. ${amt}`,
  ctaConvert: amt => `${amt} umwandeln`,
  rateMoved: newAmt => `Preis geändert: jetzt etwa ${newAmt}. Erneut bestätigen.`,
  neededVsHave: (need, have) => `${need} nötig, du hast ${have}`,
  smallerAmount: 'Wandle einen kleineren Betrag um',
  noPathTitle: inSym => `Keine Route von ${inSym}`,
  noPathBody: pairs => `Routen heute: ${pairs}`,
  noVenueBody: (inSym, outSym) => `Noch kein Anbieter tauscht ${inSym} zu ${outSym}. Das Paar bleibt gelistet; neue Anbieter erscheinen, sobald sie hinzukommen.`,
  noPathAction: 'Geld einzahlen',
  externalSignTitle: 'Ein Schritt braucht deine Ethereum-Wallet',
  externalSignBody: 'Du signierst die Überquerung in deiner Wallet; dpay hat ihre Schlüssel nie. Alles andere bleibt in diesem Sheet.',
  signing: 'Signieren…',
  awaitingPool: 'Warte auf die Pool-Auszahlung',
  receivedDone: amt => `Du hast ${amt} erhalten`,
  depositLegSent: amt => `${amt} an die Börse gesendet`,
  depositLegPending: amt => `Sende ${amt} an die Börse`,
  composedOrderLine: (venue, amt) => `Order bei ${venue}, Auszahlung festgelegt auf ${amt}`,
  depositRefusedBody: hopSym =>
    `Die Einzahlung wurde abgelehnt - der Tausch lief durch, dein ${hopSym} ist unangetastet. Es wird nichts weiter signiert: Tausche oder sende die ${hopSym} über ihr Konto.`,

  story: {
    letPoolUse: sym => `Dem Pool erlauben, dein ${sym} zu nutzen`,
    letPoolUseGas: sym => `Dem Pool erlauben, dein ${sym} für Gas zu nutzen`,
    swap: (inSym, outSym) => `${inSym} gegen ${outSym} tauschen`,
    swapFor: sym => `Auf ${sym} tauschen`,
    cross: (sym, network) => `${sym} hinüber nach ${network} bringen`,
    withdraw: (hopSym, destSym, network) => `${hopSym} raussenden - ${destSym} kommt auf ${network} an`,
    depositSend: amt => `${amt} an die Börse senden`,
    depositSent: amt => `${amt} an die Börse gesendet`,
  },

  sol: {
    heading: (inSym, outSym) => `${inSym} in ${outSym} umwandeln (Solana)`,
    counterparty: venue => `Ausgeführt von ${venue}.`,
    counterpartySigns: 'Dein Handy signiert die Transaktion des Handelsplatzes - niemand sonst signiert etwas.',
    priceImpactLine: (pct, venue) => `Preisauswirkung: ${pct} (Angabe von ${venue})`,
    solFeeLine: fee => `Solana-Netzwerkgebühr: ${fee} (an das Netzwerk, nicht an den Handelsplatz, nicht an dpay)`,
    refusalLine: sym =>
      `Über dem Minimum scheitert der Tausch ganz on-chain - dein ${sym} bleibt in deiner Wallet.`,
    pendingBody: 'Der Tausch liegt auf Solana - dieser Bildschirm klärt sich von selbst.',
    failedBody: (sym, detail) =>
      `Der Tausch ist gescheitert${detail ? ` (${detail})` : ''} - auf Solana bewegte sich nichts; dein ${sym} liegt, wo es lag.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Kein ${sym}. Zum Umtauschen erst ${sym} empfangen: öffne unten „${receiveTab}“ und wähle „${myAddress}“.`,
  fundOtherHolds: (held, toSym) => `Du hast ${held} - wandle das stattdessen in ${toSym}.`,
  fundOtherSwitch: sym => `Stattdessen aus ${sym} umwandeln`,
  insufficientLine: (needed, balance) => `${needed} nötig, du hast ${balance}`,

  approvingTitle: 'Signieren',
  approvingBody: (amount, at) =>
    `Der Pool darf nur ${amount} nutzen. Ungenutzt läuft das um ${at} ab.`,
  swappingTitle: 'Tausch läuft',
  swappingBody: 'Dein Tausch läuft - das dauert meist ein paar Minuten.',
  settlingTitle: 'Abwicklung',
  settlingBody: sym => `Fast geschafft - warte auf dein ${sym}…`,
  doneTitle: 'Fertig',
  doneBody: amount => `${amount} liegen in deiner Wallet.`,
  doneTx: tx => `Auszahlungs-Eintrag: ${tx}`,
  pendingTitle: 'Auszahlung ausstehend',
  pendingBody: sym => `Der Tausch wurde angenommen - deine ${sym}-Auszahlung ist noch nicht da.`,
  pendingSupport: ref => `Kommt sie nie, gib diese Referenz beim Support an: ${ref}`,
  stillWatching: 'Weitere Beobachtung der Auszahlung…',
  failedTitle: 'Gescheitert',
  failedApproveBody: sym =>
    `Das Ledger hat die erste Signatur verweigert - nichts bewegt, nichts zurückzusetzen. Dein ${sym} hat deine Wallet nie verlassen.`,
  failedSwapBody: (reason, sym) =>
    `Die Börse hat den Tausch abgelehnt (${reason}) - dein ${sym} hat deine Wallet nie verlassen.`,
  refundedTitle: 'Erstattet',
  refundedBody: sym =>
    `Der Pool hat dein ${sym} zurückgegeben - dein Guthaben ist wieder ganz.`,
  stuckTitle: 'Unbekannter Ausgang',
  chainStuckTitle: 'Eingang der Einzahlung unklar',
  chainStuckBody:
    'Die Einzahlung wurde gesendet, aber nie bestätigt. Sie geht von selbst durch oder verfällt - schicke sie nie ein zweites Mal.',
  stop: 'Stoppen',
  stopWatching: 'Nicht mehr beobachten',
  stopProvider: 'Nicht mehr beobachten',
  abortedTitle: 'Gestoppt',
  abortedClean: 'Nichts hat deine Wallet verlassen.',
  abortedFee: 'Du hast eine kleine Genehmigungsgebühr bezahlt.',
  abortedWatching: 'Der Tausch kann noch durchgehen. Sieh später unter Guthaben nach.',
  abortedProvider:
    'Beobachtung gestoppt. Ohne Einzahlung hat der Tausch nicht gestartet; gesendet → der Tausch kann noch abschließen. Sieh unter Guthaben und auf der Statusseite des Anbieters nach - die Shift-ID steht darunter.',
  stuckBody:
    'Tausch übermittelt - die Antwort des Pools blieb aus. Starte keinen zweiten Tausch.',
  stuckSigned: (amount, minAmount) =>
    `Du hast einen Tausch von ${amount} für mindestens ${minAmount} signiert.`,
  expiryLine: at => `Läuft spätestens um ${at} ab.`,

  awaitingDepositTitle: 'Warten auf die Einzahlung',
  awaitingDepositBody: sym =>
    `Warte auf deine ${sym}-Einzahlung - der Tausch startet, wenn sie ankommt. Verpasst sie das Zeitfenster, läuft das Angebot ab und dein ${sym} bleibt in deiner Wallet.`,
  providerProcessingTitle: 'Tausch läuft',
  providerProcessingBody: sym =>
    `Die Börse hält deine Einzahlung und tauscht. Dein ${sym} kommt an, sobald sie abschließt.`,
  quoteExpiredTitle: 'Angebot abgelaufen',
  quoteExpiredBody: sym =>
    `Das Angebot lief ab, bevor die Einzahlung ankam - nichts wurde getauscht, eine späte Einzahlung geht zurück. dpay beobachtet im Hintergrund, und dieser Bildschirm aktualisiert sich von selbst. Dein ${sym} bleibt, wo es ist.`,
  providerRefundedTitle: 'Erstattet',
  providerRefundedBody: sym =>
    `Die Börse hat die Order storniert und dein ${sym} zurückgezahlt. Beobachte Guthaben.`,
  stuckWatching: 'dpay beobachtet weiter - bewegen sich Mittel, springt dieser Bildschirm von selbst.',
  stuckAcknowledge: 'Verstanden - nicht mehr beobachten',
  stuckAcknowledged: 'Beobachtung gestoppt - später bewegte Mittel landen weiterhin an der Adresse dieser Wallet.',

  stuckReceiptsTitle: 'Was passiert ist',
  stuckErrorLine: d => `Fehler: ${d}`,
  stuckExpiredLine: at => `Abgelaufen um ${at}.`,
  stuckExpiredBody:
    'Der signierte Tausch kann nicht mehr ausgeführt werden. dpay klärt dies anhand der Belege oben: Nicht gesendetes Geld bleibt liegen; bewegtes Geld zeigt dein Guthaben.',
  stuckLastCheckedLine: at => `Zuletzt geprüft ${at}`,
  failedWindowClosedBody: sym =>
    `Der Tausch konnte vor Ablauf seines Zeitfensters nicht bestätigt werden - dein ${sym} hat deine Wallet nie verlassen.`,

  evm: {
    heading: (inSym, outSym, chain) => `${inSym} zu ${outSym} tauschen (${chain})`,
    feeLabel: unit => `Netzwerkgebühr (${unit}, Schätzung)`,
    pendingBody: 'Der Tausch ist on-chain bestätigt. Warten Sie, bis Ihr Guthaben ihn zeigt.',
    failedBody: inSym => `Es wurde nichts gesendet. Ihre ${inSym} sind noch in Ihrer Wallet.`,
    sentFailedBody: 'Der Tausch wurde gesendet, ist aber nicht fertig geworden. Der Transaktionseintrag unten zeigt, was bewegt wurde; die Netzwerkgebühr ist verbraucht.',
    stuckBody: outSym => `Der Tausch ist vielleicht gelandet. Ihr ${outSym}-Guthaben klärt sich von selbst; starten Sie keinen zweiten Tausch.`,
  },
  cow: {
    feeLine: fee => `CoW-Gebühr (Schätzung): ${fee}`,
    protocolFeeLine: bps => `zuzüglich der Volumengebühr des Anbieters (${bps} bps)`,
    settlingBody: 'Der Auftrag liegt bei den Solvern - er füllt in Sekunden bis Minuten. Diese Ansicht klärt sich von selbst; starte keinen zweiten Tausch.',
    failedBody: (inSym, detail) => `Der Auftrag wurde nicht ausgeführt (${detail}). Es hat nichts Ihre Wallet verlassen - Ihre ${inSym} sind noch da; nur die exakte Freigabe bleibt und läuft ungenutzt ab.`,
  },
  multihop: {
    destLabel: 'Ziel',
    destDirect: sym => `${sym} - deine Wallet`,
    destRoute: (sym, network) => `${sym} - an deine ${network}-Adresse`,
    destRouteSol: (sym, network, venue) => `${sym} - an deine ${network}-Adresse · letzter Schritt über ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route: ${inSym} → ${hopSym} (nach ${network})`,
    destAddressLabel: 'Deine Adresse im Zielnetzwerk',
    destAddressInvalid: 'Ungültige Adresse - erwartet: 0x gefolgt von 40 Hex-Zeichen.',
    destPayoutNote: 'Die Gelder landen auf deiner Adresse.',
    destChange: 'Zieladresse ändern',
    routeHeading: (inSym, hopSym, destSym, network) => `Route: ${inSym} → ${hopSym} → ${destSym} auf ${network}`,
    swapPaysLabel: 'Der Tausch zahlt in diese Wallet',
    legApprovePull: sym => `Den Pool ermächtigen, deine ${sym} abzuziehen`,
    legSwap: (venue, inSym, hopSym) => `${inSym} → ${hopSym} auf ${venue} tauschen`,
    legApproveBurn: sym => `Das Verbrennen von ${sym} ermächtigen (der Auszahlungsbetrag)`,
    legApproveGas: sym => `${sym} für das Auszahlungs-Gas ermächtigen`,
    legWithdraw: (hopSym, destSym, network) => `${hopSym} verbrennen - ${destSym} kommt auf ${network} an`,
    legStatePending: 'Wartet',
    legStateSent: 'Gesendet',
    legStateConfirmed: 'Bestätigt',
    legStateFailed: 'Abgelehnt',
    legProgress: (n, total) => `Schritt ${n} von ${total}`,
    destInWallet: sym => `${sym} - deine Wallet`,
    destGroupOther: 'Andere Ziele',
    mechDirect: 'Direkter Pool',
    mechViaHub: hubSym => `Über ${hubSym}`,
    mechViaCctp: 'Über Circle CCTP',
    mechViaVenue: venue => `Über ${venue}`,
    mechNoneSelected: 'Wähle oben einen Weg, um das Angebot zu sehen.',
    viaHub: hubSym => `über ${hubSym} · 2 Tauschgeschäfte`,
    hubShape: () => '2 Tauschgeschäfte',
    routeMinWalletLine: amount => `Min. ${amount}-Guthaben`,
    hubQuoteSource: (venue1, venue2, at) => `${venue1} + ${venue2} · ${at}`,
    hubCensusHeading: 'Zwei Tauschgeschäfte, einzeln aufgeschlüsselt',
    approveFeeLine: amount => `Die Freigabe des nächsten Pools kostet ${amount} (die Transfergebühr des Ledgers)`,
    hubRateLine: (inSym, destSym) => `Gesamtkurs ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Über der Untergrenze bleibt der Überschuss als ${hubSym} oder ${destSym} verfügbar.`,
    gasFeeLine: amount => `Auszahlungs-Gas (Live-Angebot): ${amount}`,
    routeMinLine: amount => `Min. ${amount} an deiner Adresse`,
    routeSurplusNote: hopSym => `Über der Untergrenze bleibt der Überschuss als ${hopSym} verfügbar.`,
    routeDestEstimate: (amount, sym) =>
      `Landet \u2248 ${amount} ${sym} an deiner Solana-Adresse - der letzte Jupiter-Schritt holt den Kurs frisch`,
    routeVenues: (icVenue, solVenue) => `Route: ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Erst Gas nötig',
    gasPreflightBody: needed =>
      `Die Überquerung braucht etwa ${needed} Gas-Geld in ckETH - diese Wallet hält zu wenig. Hol zuerst ckETH in diese Wallet und komm zurück.`,
    executingTitle: 'Route läuft',
    doneRouteTitle: 'Auszahlung läuft',
    doneRouteBody: (amount, address) => `Mindestens ${amount} ist unterwegs zu ${address}.`,
    doneOnItsWay: 'Die Zustellung läuft auf Ethereum und kann dauern - dpay kann dieses Netzwerk nicht beobachten.',
    failedLegTitle: 'Auszahlung abgelehnt',
    failedLegBody: (sym, reason) =>
      `Der Tausch lief - du hältst ${sym}. Die Auszahlung wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Auszahlen über Bezahlen ▸ Adresse senden - beliebige Ziel-Adresse einfügen.',
    stuckRouteBody: 'Das Ergebnis eines Schritts ist offen - dpay beobachtet die Ledgers; dieser Bildschirm springt von selbst.',
    stuckRouteBodyExpired: 'Das Beobachtungsfenster ist geschlossen. dpay rechnet anhand der Nachweise oben ab.',
    failedHop2Title: 'Zweiter Tausch abgelehnt',
    failedHop2Body: (hubSym, outSym, reason) =>
      `Der erste Tausch lief - du hältst ${hubSym}. Der Tausch ${hubSym} → ${outSym} wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Deine ${hubSym} sind so brauchbar wie immer - behalten, tauschen oder senden. Nichts rückgängig zu machen.`,
    stuckHoldsLine: hubSym => `Bisher: ${hubSym}.`,
    insufficientHubLine: (needed, balance) =>
      `Braucht ${needed} - der Betrag plus drei Gebühren - du hast ${balance}.`,
  },

  cefi: {
    destRow: (sym, network, venue) => `${sym} auf ${network} - über ${venue} (Tauschdienst)`,
    destRowMulti: (sym, network) => `${sym} auf ${network}`,
    settleAddressLabel: 'Auszahlung an deine Adresse',
    settleRailEthereum: 'Auszahlung in nativem ETH auf Ethereum Mainnet',
    depositAddressLabel: 'Einzahlungs-Adresse',
    depositAmountLabel: 'Exakter Betrag',
    depositMemoLabel: 'Memo (erforderlich)',
    counterparty: venue =>
      `Ausgeführt von ${venue} - ein automatisierter Tauschdienst, keine Bank, nicht dpay.`,
    checklistSigns:
      'Auf diesem Handy wird nichts signiert - nach der Bestätigung sendest du die Einzahlung selbst an die Adresse des Tauschdiensts.',
    checklistSignsAuto:
      'Nach der Bestätigung sendet diese Wallet die Einzahlung selbst an den Tauschdienst - der Tausch ist dessen Sache.',
    refusalLine: sym =>
      `Kommt die Einzahlung nie an, läuft die Bestellung ab - dein ${sym} bleibt in deiner Wallet.`,
    insufficientLine: (needed, balance) =>
      `Die Einzahlung braucht ${needed} (inkl. Transfergebühr) - du hast ${balance}.`,
    payoutAt: address => `Ausgezahlt auf deine Adresse: ${address}`,
    depositExpiryLine: at => `Bestellung läuft um ${at} ab`,
    noExpiryLine: 'Kein Ablaufdatum veröffentlicht - dpay beobachtet weiter.',
    lastCheckedLine: at => `Zuletzt geprüft: ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: 'Fonds bestätigt - deine Auszahlung ist auf den genannten Betrag festgelegt.',
    settlingWatchLine: 'Die meisten laufen in Minuten durch - dpay überwacht jeden Shift und greift ein, falls einer hakt.',
    depositNote: (venue, sym) =>
      `Sende ${sym} an die Einzahlungs-Adresse von ${venue} oben - den exakten Einzahlungsbetrag. ${venue} hält ihn während des Tauschs und zahlt dann an deine Adresse aus. dpay ist nicht Partei und wird nicht bezahlt.`,
    depositAutoNote: (venue, sym) =>
      `Die ${sym}-Einzahlung geht automatisch an die Adresse von ${venue} - den exakten Einzahlungsbetrag. ${venue} hält ihn während des Tauschs und zahlt dann an deine Adresse aus. dpay ist nicht Partei und wird nicht bezahlt.`,
    stillWaitingDeposit: 'Weitere Beobachtung deiner Einzahlung - diese Seite aktualisiert sich von selbst.',
    stillWaitingAuto: 'Die Einzahlung geht einmal von selbst raus - wartend auf das Wort des Tauschdiensts; diese Seite aktualisiert sich von selbst.',
    depositSolFeeNote: 'Die Einzahlung zahlt auch eine kleine Netzwerkgebühr in SOL - halte etwas SOL bereit.',
    solInsufficientLine: (needed, balance) =>
      `Die Einzahlung sendet ${needed} - du hast ${balance}.`,
    noQuoteTitle: 'Kein Live-Markt',
    noQuoteBody: 'Dieses Paar hat gerade keinen Live-Markt. Wähle einen anderen Handelsplatz oder versuche es später erneut.',
    minDepositBody: (venueMessage, min) =>
      `Der Betrag liegt unter dem Minimum der Börse: „${venueMessage}“ (Minimum ${min}). Erhöhe den Betrag und versuche es erneut.`,
  },

  chain: {
    depositSending: 'Deine Einzahlung wird gesendet',
    orderLine: (venue, depositAmt, midSym) => `Order bei ${venue}: ${depositAmt} rein, ${midSym} raus`,
    depositSent: (depositAmt, midSym) => `${depositAmt} gesendet - wartet auf die ${midSym}-Auszahlung`,
    phase2Note: 'Der zweite Schritt läuft von selbst, sobald die Auszahlung landet.',
    phase2Leg: (midSym, outSym, venue) => `Dann ${midSym} → ${outSym} über ${venue} - frisch quotiert bei der Auszahlung`,
    rowShape: midSym => `über ${midSym}, wandelt per Fingertipp`,
    phase2Failed: midSym => `Der zweite Schritt konnte nicht laufen - du hältst ${midSym}. Normal umwandeln (vorausgewählt).`,
    depositFailed: sym => `Die Einzahlung ist nie on-chain gelandet - dein ${sym} hat die Wallet nie verlassen.`,
  },

  crossrail: {
    heading: 'In deiner Ethereum-Wallet signieren',
    handoffIntro: (amount) =>
      `IC-Teil fertig: ${amount} liegt an deiner Ethereum-Adresse. Deine Wallet überquert es - dpay fasst deine Ethereum-Schlüssel nie an.`,
    stepApproveLabel: 'Schritt 1 - Circles Vertrag darf die USDC bewegen',
    stepBurnLabel: 'Schritt 2 - die USDC für den Solana-Transfer verbrennen',
    txAmountLabel: 'Betrag',
    copy: 'Kopieren',
    copied: 'Kopiert',
    approveHint: 'Erlaubt Circles TokenMessenger, exakt diese USDC zu bewegen - nichts weiter.',
    burnHint: 'Sperrt die USDC auf Ethereum; Circles Bridge prägt dieselben USDC an deiner Solana-Adresse - kein gewrapptes Token.',
    timingNote: 'Schneller Pfad: Sekunden bis wenige Minuten (live ~20 s gemessen). Ist Ethereum beschäftigt, länger - dieser Bildschirm aktualisiert sich von selbst.',
    externalGasLine: 'Gas zahlst du aus dem ETH deiner Wallet - dpay kann es weder zahlen noch im Voraus beziffern.',
    circleFeeLine: fee => `Circles Bridge-Gebühr (seine Zahl, vom Betrag): höchstens ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Min. ${floor} ${sym} an deiner Solana-Adresse - der letzte Schritt tauscht weiter`,
    mintFloorDestLine: (floor, sym) => `Min. ${floor} ${sym} kommen an deiner Solana-Adresse an`,
    burnTxLabel: 'Burn-Tx-Hash (aus deiner Wallet)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Ich habe signiert - den Transfer beobachten',
    burnTxInvalid: 'Kein Ethereum-Transaktions-Hash.',
    declineButton: 'Ich signiere nicht',
    whatSigning: 'Du signierst zwei ganz normale Ethereum-Transaktionen: eine Freigabe, dann den Burn. Auf dpay-Seite wird nichts signiert.',
    crossingTitle: 'Überquerung nach Solana',
    crossingBody: 'Deine USDC überqueren nach Solana - die Bridge prägt sie an deine Adresse. Dieser Bildschirm aktualisiert sich von selbst.',
    viewBurnTx: 'Burn-Transaktion ansehen',
    viewCircle: 'Circles Status-Seite',
    stillCrossing: 'Noch offen - wartet, nicht fehlgeschlagen. Schneller Pfad: Sekunden bis Minuten; bei Ethereum-Stau länger.',
    solReadyTitle: 'USDC sind auf Solana angekommen',
    solReadyBody: (credit, ata) => `${credit} verifiziert bei ${ata}. Schließe die Route ab - oder behalte die USDC; sie sind so oder so deine.`,
    abortedCrossing: ata =>
      `Beobachtung gestoppt. Die Überquerung ist raus - sie kann den Mint noch abschließen; die USDC landet so oder so an deiner Solana-Adresse ${ata}. Sieh später unter Guthaben nach.`,
    abortedSolReady: ata =>
      `Nichts wurde signiert - der letzte Tausch lief nie. Deine USDC liegen an deiner Solana-Adresse ${ata}: behalten oder dort umwandeln.`,
    solQuoteLabel: venue => `${venue}-Kurs`,
    solMinLine: (min, sym) => `Min. ${min} ${sym} an deiner Adresse`,
    solConfirmButton: sym => `Zu ${sym} tauschen`,
    solFeeLine: fee => `Solana-Gebühr: ${fee}`,
    solPreflightTitle: 'SOL für die Gebühr nötig',
    solPreflightBody:
      'Die Gebühr wird in SOL gezahlt, und diese Wallet hält keinen. Hol etwas SOL - die USDC bleiben derweil, wo sie sind.',
    doneTitle: 'Umgetauscht',
    doneBody: (amount, sym, address) => `${amount} ${sym} liegen an deiner Solana-Adresse ${address} - on-chain verifiziert.`,
    doneVia: (icVenue, solVenue) => `Über ${icVenue}, Circle und ${solVenue}.`,
    declinedTitle: 'Handoff abgebrochen',
    declinedBody: address =>
      `Nichts ist überquert. Deine USDC liegen an deiner Ethereum-Adresse ${address} - sende sie, wohin du willst, oder starte die Route später erneut.`,
    solFailedTitle: 'Solana-Tausch fehlgeschlagen',
    solFailedBody: ata =>
      `Die USDC sind sicher rüber - an deiner Solana-Adresse ${ata}. Der letzte Tausch wurde abgelehnt: gleich erneut versuchen oder die USDC behalten.`,
    legCctpBurn: (sym, network) => `${sym} über Circle nach ${network} bringen (du signierst das in deiner Wallet)`,
    legSolSwap: (venue, sym) => `Auf ${venue} in ${sym} tauschen`,
    destAddressCrossNote: 'Diese Adresse signiert auch die Überquerung - füge eine Adresse ein, die du kontrollierst.',
    deviceSignTitle: 'Dein Gerät signiert die Überquerung',
    deviceSignBody: 'Der Schlüssel dieser Wallet signiert die Überquerung - keine andere Wallet, kein zusätzlicher Schritt. Lass etwas ETH an der Auszahlungsadresse für ihr Gas liegen.',
    destAddressDeviceNote: 'Dein Gerät signiert die Überquerung - lass etwas ETH für ihr Gas liegen.',
    burnFailedBody: (address, reason) =>
      `Die Überquerung wurde abgelehnt, bevor etwas unterwegs war. Dein USDC liegt an deiner Ethereum-Adresse ${address}${reason ? `: ${reason}` : ''} - sende es beliebig oder führe diese Route später erneut aus.`,
    checksumMismatch: 'Prüfsummenfehler',
    retypeAddress: 'Adresse erneut eingeben',
    retypeMismatch: 'Stimmt nicht überein',
    gasFundTitle: 'Braucht ETH-Gas, das dir fehlt',
    gasFundNeed: eth => `Bedarf \u2248 ${eth}`,
    gasFundHave: eth => `Deine Wallet: ${eth}`,
    gasFundWalletButton: 'Aus dieser Wallet finanzieren',
    gasFundSelfButton: 'Ich finanziere selbst',
    gasFundSelfMin: eth => `Sende \u2265 ${eth} an:`,
    gasFundRecheck: 'Noch einmal prüfen',
    gasFundShort: short => `Es fehlen weiterhin ${short}`,
    gasLegsNote: 'Die ersten Schritte finanzieren das Gas.',
    abortedGasBody: 'Die Gas-Finanzierung ist gelandet, unangetastet. Die Umwandlung lief nie.',
    declinedWithGasBody: address => `Nichts ist überquert. Deine USDC liegen an deiner Ethereum-Adresse ${address}; die Gas-Finanzierung ist unangetastet.`,
    gasShortFailedBody: needed => `Die Gas-Finanzierung blieb unter ${needed}. Nichts hat die Wallet verlassen - die Umwandlung startete nie.`,
  },

  errors: {
    quoteUnreachable: 'Die Börse ist gerade nicht erreichbar. Prüfe deine Verbindung und versuche es gleich erneut.',
    quoteRefused: 'Für dieses Paar gibt es gerade keinen Kurs.',
    buildRefused: 'Der Tausch konnte nicht vorbereitet werden. Nichts bewegt - versuche es gleich erneut.',
    quoteUnavailable: code => `Kurs nicht verfügbar (${code}).`,
    quoteUnconfigured: 'Für dieses Paar ist auf diesem Relay noch keine Börse eingerichtet - mit deiner Wallet ist nichts verkehrt.',
    gasUnavailable: 'Der Gaspreis des Minters war nicht abrufbar - nichts wurde signiert. Versuche es erneut.',
    cctpFeeUnavailable: 'Die Gebühr der Überquerung ließ sich nicht abrufen - nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut.',
    chainDepositUnreadable: 'Die Einzahlungsadresse ließ sich auf Solana nicht verifizieren - nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut, oder sende die Einzahlung aus deiner eigenen Wallet.',
    chainSenderEmpty: sym => `Kein ${sym}-Token-Konto - nichts wurde signiert. Empfange zuerst ${sym}.`,
    chainSenderShort: sym => `Der ${sym}-Bestand dieser Wallet deckt diesen Betrag nicht - nichts wurde signiert.`,
    chainRentShort: sym => `Das ${sym}-Konto des Handelsplatzes kostet etwas SOL an Miete - das Guthaben reicht nicht. Nichts wurde signiert; lade SOL auf und versuche es erneut.`,
  },
};
