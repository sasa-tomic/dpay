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

  unavailableTitle: sym => `Umtausch ist für ${sym} noch nicht verfügbar`,
  unavailableBody: (pair, venue) => `Heute tauscht dpay ${pair} über ${venue} um — und nichts sonst.`,

  amountLabel: sym => `Betrag (${sym})`,
  balanceLine: balance => `Guthaben: ${balance}`,
  receiveHeadline: 'Du erhältst',
  counterparty: venue => `Ausgeführt vom ${venue}-Pool.`,
  counterpartySigns: 'Dein Handy signiert; der Pool zieht genau den freigegebenen Betrag ab.',
  quoteSource: (at, venue) => `Kurs von ${venue}, abgerufen ${at}`,
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
    },
    generic: venue => `Diese Umwandlung wird von ${venue} ausgeführt.`,
  },
  slippageLabel: 'Slippage',
  minReceiveLine: (amount, pct) => `Mindestens erhältst du: ${amount} (${pct} Slippage)`,
  refusalLine: sym =>
    `Wenn der Pool-Preis bei der Bestätigung über dein Minimum hinaus wandert, scheitert der Tausch: Dein ${sym} bleibt in deiner Wallet, und die Freigabe läuft ungenutzt ab.`,
  detailsLabel: 'Details',
  confirmButton: 'Neuen Kurs holen und bestätigen',
  staleRefreshing: 'Kurs veraltet — wird neu geladen…',
  quoteChanged: (oldAmt, newAmt) => `Kurs geändert: ${oldAmt} → ${newAmt}. Prüfe und bestätige erneut.`,
  venueChooserLabel: 'Handelsplatz',
  venueNoneSelected: 'Wähle einen Handelsplatz, um seinen vollständigen Kurs zu sehen und fortzufahren.',

  sol: {
    heading: (inSym, outSym) => `${inSym} in ${outSym} umwandeln (Solana)`,
    unavailableTitle: sym => `${sym} kann noch nicht umgewandelt werden`,
    unavailableBody: (sym, venue) =>
      `Umwandlungen für Solana-Assets laufen über eine registrierte Solana-Venue (heute ${venue}). Keine Venue bedient derzeit ${sym} — nichts wurde angeboten, nichts hat sich bewegt.`,
    counterparty: venue => `Ausgeführt von ${venue}.`,
    counterpartySigns: 'Dein Telefon signiert die Transaktion, die die Venue gebaut hat — niemand sonst signiert irgendetwas.',
    priceImpactLine: (pct, venue) => `Preisauswirkung: ${pct} (eigene Angabe von ${venue})`,
    platformFeeLine: (pct, venue) => `${venue}-Integratorgebühr: ${pct}`,
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
    `${venue} hat diese Order ausgestellt und wartet auf die ${sym}-Einzahlung. Der Swap läuft, sobald der Anbieter die Einzahlung sieht; dpay beobachtet weiterhin seinen Status. Kommt rechtzeitig keine Einzahlung, läuft das Angebot ab und es bewegt sich nichts.`,
  providerProcessingTitle: 'Wird beim Anbieter verarbeitet',
  providerProcessingBody: (sym, venue) =>
    `${venue} hält die Einzahlung und führt die Order aus. Dein ${sym} kommt an, sobald der Anbieter sie abschließt — dpay beobachtet weiter, bis es sich auflöst.`,
  quoteExpiredTitle: 'Angebot abgelaufen',
  quoteExpiredBody: (sym, venue) =>
    `Das Angebot ist abgelaufen, bevor ein Wert bewegt wurde: ${venue} hat die Einzahlung nie erhalten, also wurde nichts getauscht und nichts muss rückgängig gemacht werden. Dein ${sym} ist geblieben, wo es war — starte eine neue Umwandlung, wenn du weiterhin eine möchtest.`,
  providerRefundedTitle: 'Vom Anbieter erstattet',
  providerRefundedBody: (sym, venue) =>
    `${venue} hat diese Order storniert und die Einzahlung zurückgezahlt. Beobachte, wann dein ${sym} zurückkommt.`,
  stuckWatching: 'dpay beobachtet dies im Hintergrund. Wenn die Auszahlung oder Erstattung ankommt, springt dieser Bildschirm von selbst um.',
  stuckAcknowledge: 'Verstanden — nicht mehr beobachten',
  stuckAcknowledged: 'Du hast dies zur Kenntnis genommen und die Hintergrundbeobachtung ist gestoppt. Wenn sich später Mittel bewegen, landen sie weiterhin an der Adresse dieser Wallet.',

  multihop: {
    destLabel: 'Ziel',
    destDirect: sym => `${sym} — in dieser Wallet (direkter Tausch)`,
    destRoute: (sym, network) => `${sym} auf ${network} — Tausch-und-Auszahlung-Route`,
    destInWallet: sym => `${sym} — in dieser Wallet`,
    mechDirect: 'Direkter Pool',
    mechViaHub: hubSym => `Über ${hubSym}`,
    mechViaCctp: 'Über Circle CCTP',
    mechViaVenue: venue => `Über ${venue}`,
    mechNoneSelected: 'Wähle oben einen Weg, um das Angebot zu sehen.',
    viaHub: hubSym => `über ${hubSym} · 2 Tauschgeschäfte`,
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
    gasFeeLine: amount => `Auszahlungs-Gas (Live-Angebot des Minters): ${amount}`,
    routeMinLine: (amount, pct) => `Mindestens ${amount} an deiner Adresse (Slippage-Untergrenze ${pct})`,
    routeSurplusNote: hopSym => `Zahlt der Tausch über der Untergrenze, bleibt der Überschuss als ${hopSym} in dieser Wallet.`,
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
    stuckRouteBody: 'Ein Schritt wurde gesendet, aber sein Ergebnis ist noch unbekannt. dpay beobachtet die Ledgers weiter im Hintergrund; dieser Bildschirm wechselt von selbst, sobald die Route sich auflöst.',
  },

  /** CeFi-Venues (SideShift-Erweiterung, 2026-09-15): die Einzahlungs-Übergabe. Die Venue
   *  hält die Mittel während des Tauschs; die eigene Einzahlung des Nutzers IST die
   *  Wertbewegung — von dpay wird nichts signiert. Jede Adresse/jeder Betrag ist der
   *  eigene der Venue, unverändert. */
  cefi: {
    destRow: (sym, network, venue) => `${sym} auf ${network} — über ${venue} (Tauschdienst)`,
    settleAddressLabel: 'Die Auszahlung landet an deiner eigenen Adresse im Zielnetzwerk',
    depositAddressLabel: 'Einzahlungs-Adresse',
    depositAmountLabel: 'Genauer Einzahlungsbetrag',
    depositMemoLabel: 'Memo (erforderlich)',
    depositExpiryLine: at => `Bestellung läuft um ${at} ab`,
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
    txToLabel: 'An',
    txAmountLabel: 'Betrag',
    txCalldataLabel: 'Transaktionsdaten',
    copy: 'Kopieren',
    copied: 'Kopiert',
    approveHint: 'Das erlaubt Circle\u2019s TokenMessenger, exakt die gesendeten USDC zu bewegen — nichts weiter.',
    burnHint: 'Das sperrt die USDC auf Ethereum. Circles Bridge prägt daraufhin dieselben USDC an deine Solana-Adresse — kein gewrapptes Token, Circle erledigt die Ankunft für dich.',
    timingNote: 'Auf dem schnellen Pfad dauert die Ankunft typischerweise Sekunden bis wenige Minuten (in unserer Live-Prüfung ~20 s). Ist Ethereum beschäftigt, kann es länger dauern — dieser Bildschirm aktualisiert sich von selbst.',
    externalGasLine: 'Das Ethereum-Gas für diese beiden Transaktionen zahlt das ETH deiner eigenen Wallet. dpay kann es weder zahlen noch exakt beziffern.',
    circleFeeLine: fee => `Circle\u2019s Bridge-Gebühr (seine eigene Zahl, vom Betrag abgezogen): höchstens ${fee}`,
    mintFloorLine: floor => `Mindestens ${floor} kommen an deiner Solana-Adresse an`,
    burnTxLabel: 'Burn-Transaktions-Hash',
    burnTxPlaceholder: '0x… (aus deiner Wallet, nach dem Signieren)',
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
    solQuoteLabel: venue => `${venue}-Kurs (frisch)`,
    solMinLine: min => `Mindestens ${min} SOL an deiner Adresse`,
    solConfirmButton: 'Zu SOL tauschen',
    solFeeLine: fee => `Solana-Transaktionsgebühr: ${fee}`,
    solPreflightTitle: 'Etwas SOL ist nötig für die Gebühr',
    solPreflightBody:
      'Die Netzwerkgebühr des Tauschs wird in SOL gezahlt, und diese Wallet hält kein SOL. Hol zuerst etwas SOL in diese Wallet — die USDC bleiben derweil sicher liegen.',
    doneTitle: 'Umgetauscht',
    doneBody: (amount, sym, address) => `${amount} ${sym} liegen an deiner Solana-Adresse ${address} — on-chain verifiziert.`,
    declinedTitle: 'Handoff abgebrochen',
    declinedBody: address =>
      `Nichts ist überquert. Deine USDC liegen an deiner eigenen Ethereum-Adresse ${address} — sende sie von deiner Wallet irgendwohin hin oder starte diese Route später erneut.`,
    solFailedTitle: 'Der Solana-Tausch ging nicht durch',
    solFailedBody: (ata, venue) =>
      `Die USDC sind bereits sicher überquert und liegen an deiner Solana-Adresse ${ata}. ${venue} hat den letzten Tausch abgelehnt — versuche es hier gleich nochmal oder behalte die USDC.`,
    legCctpBurn: (sym, network) => `${sym} über Circle nach ${network} bringen (du signierst das in deiner Wallet)`,
    legSolSwap: (venue, sym) => `Auf ${venue} in ${sym} tauschen`,
    destAddressCrossNote: 'Diese Ethereum-Adresse ist zugleich die Wallet, die die Überquerung signiert — füge eine Adresse ein, die du kontrollierst.',
  },

  errors: {
    quoteUnreachable: venue => `Der Kurs von ${venue} war nicht abrufbar — das Relay antwortet nicht. Prüfe deine Verbindung und versuche es erneut.`,
    quoteRefused: venue => `${venue} hat abgelehnt, für dieses Paar gerade einen Kurs zu liefern.`,
    quoteUnavailable: code => `Kurs nicht verfügbar (${code}).`,
    quoteUnconfigured: venue =>
      `${venue} ist auf diesem Relay noch nicht eingerichtet — es ist keine Partner-Berechtigung konfiguriert, daher kann kein Kurs angefragt werden. Mit deiner Wallet ist nichts verkehrt.`,
    gasUnavailable: 'Der Gaspreis des Auszahlungs-Minters ließ sich nicht abfragen — nichts wurde signiert. Versuche es erneut.',
    cctpFeeUnavailable: 'Circles Bridge-Gebühr ließ sich nicht abrufen — nichts wurde signiert. Prüfe deine Verbindung und versuche es erneut.',
  },
};
