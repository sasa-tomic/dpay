/**
 * i18n/domains/de/convert.ts — German values for the delegated-conversion surface.
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
  counterpartySigns: 'Dein Handy signiert; der Pool zieht genau den freigegebenen Betrag ab.',
  quoteSource: (at, venue) => `${venue} · ${at}`,
  quoteVerbatim: (venue, amt) => `${venue} hat genau ${amt} notiert`,
  rateLabel: (inSym, outSym) => `Kurs (${inSym} → ${outSym})`,
  poolFeeTier: (tier, venue) => `Pool-Gebühr: ${tier} (${venue}-Gebührenstufe)`,
  inputFeeLine: fee => `Eingangsgebühr: ${fee}`,
  outputFeeLine: fee => `Ausgangsgebühr: ${fee}`,
  disclosures: {
    byKey: {
      icpswap: venue => `Läuft auf dem eigenen Pool-Vertrag von ${venue}.`,
      jupiter: venue =>
        `${venue} ist ein autonomer On-Chain-Aggregator auf Solana — er wählt die Route und führt sie aus. Diese Wallet signiert die Transaktion, die ${venue} baut, und der Kurs ist der eigene von ${venue}, unverändert. dpay ist nicht Partei.`,
      sideshift: venue =>
        `${venue} ist ein automatisierter Tauschdienst — kein lizenzierter Anbieter, keine Bank. Er hält deine Mittel während des Tauschs und zahlt dann an deine eigene Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen nach seiner Policy, stehen unter sideshift.ai/terms. Diese Wallet zeigt ${venue}s eigenen Kurs und die Einzahlungs-Adresse — deine Mittel gehen direkt aus deiner eigenen Wallet an den Dienst; dpay ist nicht Partei und wird nicht bezahlt.`,
      trocador: venue =>
        `${venue} ist ein automatisierter Tausch-Aggregator — er leitet deinen Tausch an einen seiner eigenen Anbieter weiter und hält deine Mittel während des Tauschs, zahlt dann an deine eigene Adresse aus; seine Bedingungen, einschließlich etwaiger Identitätsprüfungen eines Anbieters, stehen unter trocador.app/terms. dpay bittet ${venue} nur um Anbieter ohne Identitätsprüfung. Diese Wallet zeigt ${venue}s eigenen Kurs und die Einzahlungs-Adresse — deine Mittel gehen direkt aus deiner eigenen Wallet an den Dienst; dpay ist nicht Partei und wird nicht bezahlt.`,
      cowswap: venue =>
        `${venue} erfüllt signierte Off-Chain-Aufträge mit konkurrierenden Solvern, meist in Sekunden bis Minuten. Die Übersicht zeigt ${venue}s eigene Gebühr. dpay signiert Ihren Auftrag, ist nicht Partei und wird nicht bezahlt.`,
    },
    generic: venue => `Ausgeführt von ${venue}.`,
  },
  slippageLabel: 'Slippage',
  refusalLine: sym =>
    `Über deinem Minimum scheitert der Tausch — dein ${sym} bleibt in deiner Wallet, die Freigabe läuft ungenutzt ab.`,
  detailsLabel: 'Details',
  staleRefreshing: 'Kurs veraltet — wird neu geladen…',
  venueSlow: 'Kürzlich langsam bei der Abwicklung.',
  sheetTitle: inSym => `${inSym} umwandeln`,
  youReceive: amt => `Du erhältst ≈ ${amt}`,
  quoteFetching: venue => `Kurs von ${venue}…`,
  autoVenueLine: (venue, at, n) => `${venue} · ${at} · ${n} Handelsplätze`,
  otherVenues: n => `Weitere Handelsplätze (${n})`,
  atLeast: amt => `Min. ${amt}`,
  ctaConvert: amt => `${amt} umwandeln`,
  rateMoved: (oldAmt, newAmt) => `Kurs geändert: ${oldAmt} → ${newAmt}. Erneut bestätigen.`,
  neededVsHave: (need, have) => `${need} nötig, du hast ${have}`,
  smallerAmount: 'Wandle einen kleineren Betrag um',
  noPathTitle: inSym => `Keine Route von ${inSym}`,
  noPathBody: pairs => `Routen heute: ${pairs}`,
  noVenueBody: (inSym, outSym) => `Noch kein Anbieter tauscht ${inSym} zu ${outSym}. Das Paar bleibt hier gelistet; neue Anbieter erscheinen, sobald sie hinzukommen.`,
  noPathAction: 'Geld einzahlen',
  externalSignTitle: 'Ein Schritt braucht deine eigene Ethereum-Wallet',
  externalSignBody: 'Du signierst die Überquerung in deiner eigenen Wallet; dpay hat ihre Schlüssel nie. Alles andere bleibt in diesem Sheet.',
  signing: 'Signieren…',
  swapVia: venue => `Tausch über ${venue}`,
  awaitingPool: 'Warte auf die Pool-Auszahlung',
  receivedDone: amt => `Du hast ${amt} erhalten`,
  viaChain: venue => `über ${venue}`,
  depositLegSent: (venue, amt) => `${amt} Einzahlung an ${venue} gesendet`,
  depositLegPending: (venue, amt) => `Sende ${amt} an ${venue}`,
  composedOrderLine: (venue, amt) => `Order bei ${venue}, Auszahlung festgelegt auf ${amt}`,
  depositRefusedBody: (hopSym, venue) =>
    `Die Einzahlung an ${venue} wurde abgelehnt — der Tausch lief durch, dein ${hopSym} liegt weiter in dieser Wallet. Es wird nichts weiter signiert: Tausche oder sende die ${hopSym} über ihr eigenes Konto.`,

  sol: {
    heading: (inSym, outSym) => `${inSym} in ${outSym} umwandeln (Solana)`,
    counterparty: venue => `Ausgeführt von ${venue}.`,
    counterpartySigns: 'Dein Handy signiert die Transaktion des Handelsplatzes — niemand sonst signiert etwas.',
    priceImpactLine: (pct, venue) => `Preisauswirkung: ${pct} (eigene Angabe von ${venue})`,
    solFeeLine: fee => `Solana-Netzwerkgebühr: ${fee} (an das Netzwerk, nicht an den Handelsplatz, nicht an dpay)`,
    refusalLine: sym =>
      `Über dem Minimum scheitert der Tausch ganz on-chain — dein ${sym} bleibt in deiner Wallet.`,
    pendingBody: 'Der Tausch liegt auf Solana — dieser Bildschirm klärt sich von selbst.',
    failedBody: (sym, venue, detail) =>
      `${venue}s Tausch ist gescheitert${detail ? ` (${detail})` : ''} — auf Solana bewegte sich nichts; dein ${sym} liegt, wo es lag.`,
  },

  fundBody: (sym, receiveTab, myAddress) =>
    `Kein ${sym} hier. Zum Umtauschen erst ${sym} empfangen: öffne unten „${receiveTab}“ und wähle „${myAddress}“.`,
  fundOtherHolds: (held, toSym) => `Du hast ${held} — wandle das stattdessen in ${toSym}.`,
  fundOtherSwitch: sym => `Stattdessen aus ${sym} umwandeln`,
  insufficientLine: (needed, balance) => `${needed} nötig, du hast ${balance}`,

  approvingTitle: 'Freigabe läuft',
  approvingBody: (amount, at) =>
    `Freigabe: Der Pool darf genau ${amount} abziehen. Ungenutzt läuft sie um ${at} ab.`,
  swappingTitle: 'Tausch läuft',
  swappingBody: venue => `Übermittlung an den ${venue}-Pool — er kann nur den freigegebenen Betrag abziehen.`,
  settlingTitle: 'Abwicklung',
  settlingBody: sym => `Pool hat angenommen — warte auf dein ${sym}…`,
  doneTitle: 'Getauscht ✓',
  doneBody: amount => `${amount} wurden in deiner Wallet gutgeschrieben.`,
  doneTx: tx => `Auszahlungs-Eintrag: ${tx}`,
  pendingTitle: 'Auszahlung ausstehend',
  pendingBody: (sym, pool, at) =>
    `Tausch angenommen — die ${sym}-Auszahlung ist noch nicht da. Kommt sie nie, gib dies beim Support an: Pool ${pool}, gesendet um ${at}.`,
  stillWatching: 'Weitere Beobachtung der Auszahlung…',
  failedTitle: 'Tausch nicht ausgeführt',
  failedApproveBody: sym =>
    `Das ${sym}-Ledger hat die Freigabe verweigert — nichts bewegt, nichts zurückzusetzen.`,
  failedSwapBody: (reason, sym, venue) =>
    `Der ${venue}-Pool hat den Tausch abgelehnt (${reason}) — dein ${sym} hat deine Wallet nie verlassen.`,
  refundedBody: sym =>
    `Tausch gescheitert — der Pool hat dein ${sym} zurückgegeben. Guthaben wieder ganz.`,
  stuckTitle: 'Unbekannter Ausgang',
  chainStuckTitle: 'Eingang der Einzahlung unklar',
  chainStuckBody: venue =>
    `Die ${venue}-Einzahlung wurde gesendet, aber nie bestätigt. Sie geht von selbst durch oder verfällt — schicke sie nie ein zweites Mal.`,
  stop: 'Stoppen',
  stopWatching: 'Nicht mehr beobachten',
  stopProvider: 'Nicht mehr beobachten',
  abortedTitle: 'Gestoppt',
  abortedClean: 'Nichts hat deine Wallet verlassen.',
  abortedFee: 'Du hast eine kleine Genehmigungsgebühr bezahlt.',
  abortedWatching: 'Der Tausch kann noch durchgehen. Sieh später unter Guthaben nach.',
  abortedProvider:
    'Beobachtung gestoppt. Ohne Einzahlung kann sich nichts bewegen; schon gesendet → der Tausch kann noch abschließen. Sieh unter Guthaben und auf der Statusseite des Anbieters nach — die Shift-ID steht darunter.',
  stuckBody:
    'Tausch übermittelt — die Antwort des Pools blieb aus. Starte keinen zweiten Tausch.',
  stuckSigned: (amount, minAmount, venue) =>
    `Signiert: Freigabe von ${amount} an den ${venue}-Pool, Tausch auf mindestens ${minAmount}.`,
  expiryLine: at => `Läuft spätestens um ${at} ab — danach kann sich nichts bewegen.`,

  awaitingDepositTitle: 'Warten auf die Einzahlung',
  awaitingDepositBody: (sym, venue) =>
    `${venue} wartet auf die ${sym}-Einzahlung; der Tausch startet, wenn sie ankommt. Kommt rechtzeitig keine, läuft das Angebot ab — nichts bewegt sich.`,
  providerProcessingTitle: 'Verarbeitung beim Handelsplatz',
  providerProcessingBody: (sym, venue) =>
    `${venue} hält die Einzahlung und führt aus. Dein ${sym} kommt an, sobald sie abschließt.`,
  quoteExpiredTitle: 'Angebot abgelaufen',
  quoteExpiredBody: (sym, venue) =>
    `Das Angebot lief ab, bevor die Einzahlung ankam: ${venue} wartet nicht mehr, nichts wurde getauscht. Eine späte Einzahlung gibt der Anbieter zurück — dpay beobachtet im Hintergrund, und dieser Bildschirm aktualisiert sich von selbst. Dein ${sym} bleibt, wo es ist.`,
  providerRefundedTitle: 'Vom Handelsplatz erstattet',
  providerRefundedBody: (sym, venue) =>
    `${venue} hat die Order storniert und dein ${sym} zurückgezahlt. Beobachte Guthaben.`,
  stuckWatching: 'dpay beobachtet weiter — bewegen sich Mittel, springt dieser Bildschirm von selbst.',
  stuckAcknowledge: 'Verstanden — nicht mehr beobachten',
  stuckAcknowledged: 'Beobachtung gestoppt — später bewegte Mittel landen weiterhin an der Adresse dieser Wallet.',

  stuckReceiptsTitle: 'Was passiert ist',
  stuckErrorLine: d => `Fehler: ${d}`,
  stuckExpiredLine: at => `Abgelaufen um ${at} - nichts kann sich mehr bewegen.`,
  stuckExpiredBody:
    'Der signierte Tausch kann nicht mehr ausgeführt werden. dpay klärt dies anhand der Belege oben: Geld, das noch in dieser Wallet liegt, bleibt liegen; bewegtes Geld zeigt dein Guthaben.',
  stuckLastCheckedLine: at => `Zuletzt geprüft ${at}`,
  failedWindowClosedBody: sym =>
    `Der Tausch konnte vor Ablauf seines Zeitfensters nicht bestätigt werden - dein ${sym} hat deine Wallet nie verlassen.`,

  evm: {
    heading: (inSym, outSym, chain) => `${inSym} zu ${outSym} tauschen (${chain})`,
    feeLabel: unit => `Netzwerkgebühr (${unit}, Schätzung)`,
    pendingBody: 'Der Tausch ist on-chain bestätigt. Warten Sie, bis Ihr Guthaben ihn zeigt.',
    failedBody: (inSym, detail) => String(detail).includes('approve landed')
      ? `Der Tausch scheiterte nach der Freigabe. Ihre ${inSym} sind noch in Ihrer Wallet; die ungenutzte Freigabe gilt nur für den exakten Tauschbetrag.`
      : `Es wurde nichts gesendet. Ihre ${inSym} sind noch in Ihrer Wallet.`,
    stuckBody: outSym => `Der Tausch ist vielleicht gelandet. Ihr ${outSym}-Guthaben klärt sich von selbst; starten Sie keinen zweiten Tausch.`,
  },
  cow: {
    feeLine: fee => `CoW-Gebühr (Schätzung): ${fee}`,
    protocolFeeLine: bps => `zuzüglich der Volumengebühr des Anbieters (${bps} bps)`,
    settlingBody: 'Der Auftrag liegt bei den CoW-Solvern - er füllt in Sekunden bis Minuten. Diese Ansicht klärt sich von selbst; starten Sie keinen zweiten Tausch.',
    failedBody: (inSym, detail) => `Der Auftrag wurde nicht ausgeführt (${detail}). Es hat nichts Ihre Wallet verlassen - Ihre ${inSym} sind noch da; nur die exakte Freigabe bleibt und läuft ungenutzt ab.`,
  },
  multihop: {
    destLabel: 'Ziel',
    destDirect: sym => `${sym} — in dieser Wallet`,
    destRoute: (sym, network) => `${sym} — an deine ${network}-Adresse`,
    destRouteSol: (sym, network, venue) => `${sym} — an deine ${network}-Adresse · letzter Schritt über ${venue}`,
    routeHeadingCollapsed: (inSym, hopSym, network) => `Route: ${inSym} → ${hopSym} (nach ${network})`,
    destAddressLabel: 'Deine eigene Adresse im Zielnetzwerk',
    destAddressInvalid: 'Ungültige Adresse — erwartet: 0x gefolgt von 40 Hex-Zeichen.',
    destPayoutNote: 'Die Gelder landen auf deiner eigenen Wallet-Adresse.',
    destChange: 'Zieladresse ändern',
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
    destInWallet: sym => `${sym} — in dieser Wallet`,
    destGroupOther: 'Andere Ziele',
    mechDirect: 'Direkter Pool',
    mechViaHub: hubSym => `Über ${hubSym}`,
    mechViaCctp: 'Über Circle CCTP',
    mechViaVenue: venue => `Über ${venue}`,
    mechNoneSelected: 'Wähle oben einen Weg, um das Angebot zu sehen.',
    viaHub: hubSym => `über ${hubSym} · 2 Tauschgeschäfte`,
    hubShape: () => '2 Tauschgeschäfte',
    routeMinWalletLine: amount => `Min. ${amount} in dieser Wallet`,
    hubQuoteSource: (venue1, venue2, at) => `${venue1} + ${venue2} · ${at}`,
    hubCensusHeading: 'Zwei Tauschgeschäfte, einzeln aufgeschlüsselt',
    approveFeeLine: amount => `Die Freigabe des nächsten Pools kostet ${amount} (die eigene Transfergebühr des Ledgers)`,
    hubRateLine: (inSym, destSym) => `Gesamtkurs ${inSym} → ${destSym}:`,
    hubSurplusNote: (hubSym, destSym) =>
      `Über der Untergrenze bleibt der Überschuss als ${hubSym} oder ${destSym} in dieser Wallet.`,
    gasFeeLine: amount => `Auszahlungs-Gas (Live-Angebot): ${amount}`,
    routeMinLine: amount => `Min. ${amount} an deiner Adresse`,
    routeSurplusNote: hopSym => `Über der Untergrenze bleibt der Überschuss als ${hopSym} in dieser Wallet.`,
    routeDestEstimate: (amount, sym) =>
      `Landet \u2248 ${amount} ${sym} an deiner Solana-Adresse — der letzte Jupiter-Schritt holt den Kurs frisch`,
    routeVenues: (icVenue, solVenue) => `Route: ${icVenue} → Circle CCTP → ${solVenue}`,
    gasPreflightTitle: 'Erst Gas nötig',
    gasPreflightBody: needed =>
      `Der Burn nach Ethereum braucht etwa ${needed} Gas in ckETH — diese Wallet hält zu wenig. Hol zuerst ckETH in diese Wallet und komm zurück.`,
    executingTitle: 'Route läuft',
    doneRouteTitle: 'Auszahlung läuft',
    doneRouteBody: (amount, address) => `Mindestens ${amount} ist unterwegs zu ${address}.`,
    doneOnItsWay: 'Die Zustellung läuft auf Ethereum und kann dauern — dpay kann dieses Netzwerk nicht beobachten.',
    failedLegTitle: 'Auszahlung abgelehnt',
    failedLegBody: (sym, reason) =>
      `Der Tausch lief — deine Mittel liegen als ${sym} in dieser Wallet. Die Auszahlung wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedLegExit: 'Auszahlen über Bezahlen ▸ Adresse senden — beliebige Ziel-Adresse einfügen.',
    stuckRouteBody: 'Das Ergebnis eines Schritts ist offen — dpay beobachtet die Ledgers; dieser Bildschirm springt von selbst.',
    stuckRouteBodyExpired: 'Das Beobachtungsfenster ist geschlossen - nichts kann sich mehr bewegen. dpay rechnet anhand der Nachweise oben ab.',
    failedHop2Title: 'Zweiter Tausch abgelehnt',
    failedHop2Body: (hubSym, outSym, reason) =>
      `Der erste Tausch lief — du hältst ${hubSym} in dieser Wallet. Der Tausch ${hubSym} → ${outSym} wurde abgelehnt${reason ? `: ${reason}` : ''}.`,
    failedHop2Exit: hubSym =>
      `Deine ${hubSym} sind so brauchbar wie immer — behalten, tauschen oder senden. Nichts rückgängig zu machen.`,
    stuckHoldsLine: hubSym => `Bisher: ${hubSym} in dieser Wallet.`,
    insufficientHubLine: (needed, balance) =>
      `Braucht ${needed} — der Betrag plus drei Gebühren — du hast ${balance}.`,
  },

  cefi: {
    destRow: (sym, network, venue) => `${sym} auf ${network} — über ${venue} (Tauschdienst)`,
    destRowMulti: (sym, network) => `${sym} auf ${network}`,
    settleAddressLabel: 'Auszahlung an deine eigene Adresse',
    settleRailEthereum: 'Auszahlung in nativem ETH auf Ethereum Mainnet',
    depositAddressLabel: 'Einzahlungs-Adresse',
    depositAmountLabel: 'Exakter Betrag',
    depositMemoLabel: 'Memo (erforderlich)',
    counterparty: venue =>
      `Ausgeführt von ${venue} — ein automatisierter Tauschdienst, keine Bank, nicht dpay.`,
    checklistSigns:
      'Auf diesem Handy wird nichts signiert — nach der Bestätigung sendest du die Einzahlung selbst an die Adresse des Tauschdiensts.',
    checklistSignsAuto:
      'Nach der Bestätigung sendet diese Wallet die Einzahlung selbst an den Tauschdienst — der Tausch ist dessen Sache.',
    refusalLine: sym =>
      `Kommt die Einzahlung nie an, läuft die Bestellung ab — nichts bewegt sich, dein ${sym} bleibt in deiner Wallet.`,
    insufficientLine: (needed, balance) =>
      `Die Einzahlung braucht ${needed} (inkl. Transfergebühr) — du hast ${balance}.`,
    payoutAt: address => `Ausgezahlt auf deine eigene Adresse: ${address}`,
    depositExpiryLine: at => `Bestellung läuft um ${at} ab`,
    noExpiryLine: 'Kein Ablaufdatum veröffentlicht — dpay beobachtet weiter.',
    lastCheckedLine: at => `Zuletzt geprüft: ${at}.`,
    shiftId: id => `Shift ${id}`,
    settlingFundsLine: 'Fonds bestätigt — deine Auszahlung ist auf den genannten Betrag festgelegt.',
    settlingWatchLine: 'Die meisten laufen in Minuten durch — dpay überwacht jeden Shift und greift ein, falls einer hakt.',
    depositNote: (venue, sym) =>
      `Sende ${sym} an die Einzahlungs-Adresse von ${venue} oben — genau den Einzahlungsbetrag. ${venue} hält ihn während des Tauschs und zahlt dann an deine Adresse aus. dpay ist nicht Partei und wird nicht bezahlt.`,
    depositAutoNote: (venue, sym) =>
      `Diese Wallet sendet die ${sym}-Einzahlung selbst an die Adresse von ${venue} — genau den Einzahlungsbetrag. ${venue} hält ihn während des Tauschs und zahlt dann an deine Adresse aus. dpay ist nicht Partei und wird nicht bezahlt.`,
    stillWaitingDeposit: 'Weitere Beobachtung deiner Einzahlung — diese Seite aktualisiert sich von selbst.',
    stillWaitingAuto: 'Die Einzahlung geht einmal von selbst raus — wartend auf das Wort des Tauschdiensts; diese Seite aktualisiert sich von selbst.',
    depositSolFeeNote: 'Die Einzahlung zahlt auch eine kleine Netzwerkgebühr in SOL — halte etwas SOL in dieser Wallet.',
    solInsufficientLine: (needed, balance) =>
      `Die Einzahlung sendet genau ${needed} — du hast ${balance}.`,
    noQuoteTitle: 'Kein Live-Markt',
    noQuoteBody: venue =>
      `${venue} listet dieses Paar, hat aber gerade keinen Live-Markt. Nichts wurde gesendet. Wähle einen anderen Handelsplatz oder versuche es später erneut.`,
    minDepositBody: (venue, venueMessage, min) =>
      `${venue} hat den Betrag abgelehnt: „${venueMessage}“ (Minimum ${min}). Nichts wurde gesendet — erhöhe den Betrag und versuche es erneut.`,
  },

  chain: {
    depositSending: venue => `Einzahlung geht an ${venue}`,
    orderLine: (venue, depositAmt, midSym) => `Order bei ${venue}: ${depositAmt} rein, ${midSym} raus`,
    depositSent: (venue, depositAmt, midSym) => `${depositAmt} an ${venue} gesendet — wartet auf die ${midSym}-Auszahlung`,
    phase2Note: 'Der zweite Schritt läuft von selbst, sobald die Auszahlung landet.',
    phase2Leg: (midSym, outSym, venue) => `Dann ${midSym} → ${outSym} über ${venue} — frisch quotiert bei der Auszahlung`,
    rowShape: midSym => `über ${midSym}, wandelt per Fingertipp`,
    phase2Failed: midSym => `Der zweite Schritt konnte nicht laufen — deine ${midSym} liegen in dieser Wallet. Normal umwandeln (vorausgewählt).`,
    depositFailed: sym => `Die Einzahlung ist nie on-chain gelandet — dein ${sym} hat die Wallet nie verlassen.`,
  },

  crossrail: {
    heading: 'In deiner Ethereum-Wallet signieren',
    handoffIntro: (amount) =>
      `IC-Teil fertig: ${amount} liegt an deiner Ethereum-Adresse. Deine Wallet überquert es — dpay fasst deine Ethereum-Schlüssel nie an.`,
    stepApproveLabel: 'Schritt 1 — Circles Vertrag darf die USDC bewegen',
    stepBurnLabel: 'Schritt 2 — die USDC für den Solana-Transfer verbrennen',
    txAmountLabel: 'Betrag',
    copy: 'Kopieren',
    copied: 'Kopiert',
    approveHint: 'Erlaubt Circles TokenMessenger, exakt diese USDC zu bewegen — nichts weiter.',
    burnHint: 'Sperrt die USDC auf Ethereum; Circles Bridge prägt dieselben USDC an deiner Solana-Adresse — kein gewrapptes Token.',
    timingNote: 'Schneller Pfad: Sekunden bis wenige Minuten (live ~20 s gemessen). Ist Ethereum beschäftigt, länger — dieser Bildschirm aktualisiert sich von selbst.',
    externalGasLine: 'Gas zahlst du aus dem eigenen ETH deiner Wallet — dpay kann es weder zahlen noch exakt beziffern.',
    circleFeeLine: fee => `Circles Bridge-Gebühr (seine eigene Zahl, vom Betrag): höchstens ${fee}`,
    mintFloorLine: (floor, sym) =>
      `Min. ${floor} ${sym} an deiner Solana-Adresse — der letzte Schritt tauscht weiter`,
    mintFloorDestLine: (floor, sym) => `Min. ${floor} ${sym} kommen an deiner Solana-Adresse an`,
    burnTxLabel: 'Burn-Tx-Hash (aus deiner Wallet)',
    burnTxPlaceholder: '0x…',
    attachButton: 'Ich habe signiert — den Transfer beobachten',
    burnTxInvalid: 'Kein Ethereum-Transaktions-Hash.',
    declineButton: 'Ich signiere nicht',
    whatSigning: 'Du signierst zwei ganz normale Ethereum-Transaktionen: eine Freigabe, dann den Burn. Auf dpay-Seite wird nichts signiert.',
    crossingTitle: 'Überquerung nach Solana',
    crossingBody: 'Circle attestiert den Burn und prägt die USDC an deine Solana-Adresse — dpay beobachtet Circles Status-Feed.',
    viewBurnTx: 'Burn-Transaktion ansehen',
    viewCircle: 'Circles Status-Seite',
    stillCrossing: 'Noch offen — wartet, nicht fehlgeschlagen. Schneller Pfad: Sekunden bis Minuten; bei Ethereum-Stau länger.',
    solReadyTitle: 'USDC sind auf Solana angekommen',
    solReadyBody: (credit, ata) => `${credit} verifiziert bei ${ata}. Schließe die Route ab — oder behalte die USDC; sie sind so oder so deine.`,
    abortedCrossing: ata =>
      `Beobachtung gestoppt. Der Burn ist raus — Circle kann den Mint noch abschließen; die USDC landet so oder so an deiner eigenen Solana-Adresse ${ata}. Sieh später unter Guthaben nach.`,
    abortedSolReady: ata =>
      `Nichts wurde signiert — der letzte Tausch lief nie. Deine USDC liegen an deiner Solana-Adresse ${ata}: behalten oder dort umwandeln.`,
    solQuoteLabel: venue => `${venue}-Kurs`,
    solMinLine: (min, sym) => `Min. ${min} ${sym} an deiner Adresse`,
    solConfirmButton: sym => `Zu ${sym} tauschen`,
    solFeeLine: fee => `Solana-Gebühr: ${fee}`,
    solPreflightTitle: 'SOL für die Gebühr nötig',
    solPreflightBody:
      'Die Gebühr wird in SOL gezahlt, und diese Wallet hält keinen. Hol etwas SOL — die USDC bleiben derweil, wo sie sind.',
    doneTitle: 'Umgetauscht',
    doneBody: (amount, sym, address) => `${amount} ${sym} liegen an deiner Solana-Adresse ${address} — on-chain verifiziert.`,
    doneVia: (icVenue, solVenue) => `Über ${icVenue}, Circle und ${solVenue}.`,
    declinedTitle: 'Handoff abgebrochen',
    declinedBody: address =>
      `Nichts ist überquert. Deine USDC liegen an deiner eigenen Ethereum-Adresse ${address} — sende sie, wohin du willst, oder starte die Route später erneut.`,
    solFailedTitle: 'Solana-Tausch fehlgeschlagen',
    solFailedBody: (ata, venue) =>
      `Die USDC sind sicher rüber — an deiner Solana-Adresse ${ata}. ${venue} hat den letzten Tausch abgelehnt: gleich hier erneut versuchen oder die USDC behalten.`,
    legCctpBurn: (sym, network) => `${sym} über Circle nach ${network} bringen (du signierst das in deiner Wallet)`,
    legSolSwap: (venue, sym) => `Auf ${venue} in ${sym} tauschen`,
    destAddressCrossNote: 'Diese Adresse signiert auch die Überquerung — füge eine Adresse ein, die du kontrollierst.',
    deviceSignTitle: 'Die Überquerung signiert auf diesem Gerät',
    deviceSignBody: 'Der eigene Schlüssel dieser Wallet signiert die Circle-Überquerung - keine andere Wallet, kein zusätzlicher Schritt. Lass etwas ETH an der Auszahlungsadresse für das Gas der Überquerung liegen.',
    destAddressDeviceNote: 'Die Überquerung signiert auf diesem Gerät - lass hier etwas ETH für ihr Gas liegen.',
    burnFailedBody: (address, reason) =>
      `Die Circle-Überquerung wurde abgelehnt, bevor etwas verbrannt wurde. Dein USDC liegt an deiner eigenen Ethereum-Adresse ${address}${reason ? `: ${reason}` : ''} - sende es beliebig oder führe diese Route später erneut aus.`,
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
    abortedGasBody: 'Die Gas-Finanzierung ist gelandet — noch in dieser Wallet. Die Umwandlung lief nie.',
    declinedWithGasBody: address => `Nichts ist überquert. Deine USDC liegen an deiner Ethereum-Adresse ${address}; die Gas-Finanzierung liegt noch in dieser Wallet.`,
    gasShortFailedBody: needed => `Die Gas-Finanzierung blieb unter ${needed}. Nichts hat die Wallet verlassen — die Umwandlung startete nie.`,
  },

  errors: {
    quoteUnreachable: venue => `${venue} war über dpays Relay nicht erreichbar. Nichts wurde gesendet — prüfe deine Verbindung und versuche es gleich erneut.`,
    quoteRefused: venue => `${venue} hat abgelehnt, für dieses Paar gerade einen Kurs zu liefern.`,
    buildRefused: venue => `${venue} konnte den Tausch nicht vorbereiten. Nichts bewegt — versuche es gleich erneut.`,
    quoteUnavailable: code => `Kurs nicht verfügbar (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} ist auf diesem Relay noch nicht eingerichtet — kein Kurs anfragbar. Mit deiner Wallet ist nichts verkehrt.`,
    gasUnavailable: 'Der Gaspreis des Minters war nicht abrufbar — nichts wurde signiert. Versuche es erneut.',
    cctpFeeUnavailable: 'Circles Bridge-Gebühr ließ sich nicht abrufen — nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut.',
    chainDepositUnreadable: venue =>
      `${venue}s Einzahlungsadresse ließ sich auf Solana nicht verifizieren — nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut, oder sende die Einzahlung aus deiner eigenen Wallet.`,
    chainSenderEmpty: sym => `Kein ${sym}-Token-Konto in dieser Wallet — nichts wurde signiert. Empfange zuerst ${sym}.`,
    chainSenderShort: sym => `Der ${sym}-Bestand dieser Wallet deckt diesen Betrag nicht — nichts wurde signiert.`,
    chainRentShort: sym => `Das ${sym}-Konto des Handelsplatzes kostet etwas SOL an Miete — das Guthaben reicht nicht. Nichts wurde signiert; lade SOL auf und versuche es erneut.`,
  },
};
