/**
 * i18n/domains/de/errors.ts — German values for the copy that is thrown and rendered verbatim.
 * Types, key documentation and the reference copy: ../en/errors.ts. Glossary: ../../de.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsDe: ErrorMessages = {
  seedFormat: 'Der Wiederherstellungs-Seed muss aus 64 Hex-Zeichen bestehen (0-9, a-f).',

  ic: {
    clockUnreachable: 'IC-Uhr nicht erreichbar',
    clockSkew: 'IC-Zeitabweichung zu groß',
    noLedgerForCurrency: 'Asset nicht unterstützt — kein Ledger für diese Währung',
    feeUnavailable: 'Die Ledger-Gebühr konnte nicht geladen werden — prüfe deine Verbindung',
  },

  solana: {
    offline: 'Solana ist offline (kein RPC-Endpunkt konfiguriert)',
    tokenUnavailable: asset => `Solana-${asset} ist nicht verfügbar (kein RPC-Endpunkt konfiguriert)`,
    senderNoTokenAccount: asset =>
      `Du hast noch kein ${asset}-Konto. Geh einmal online und öffne Empfangen ▸ „Mein ${asset}-Konto erstellen“, oder zahl mit einem Asset, das du schon hast`,
    senderTokenAccountUnverified: asset =>
      `dpay konnte dein ${asset}-Konto nicht prüfen. Ohne eines kann diese Zahlung nicht abgeschlossen werden. Geh einmal online und öffne Empfangen ▸ Meine Adresse, um es zu prüfen oder anzulegen.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `dpay konnte dein ${asset}-Konto nicht prüfen, weil Solana nicht antwortet. Ohne eines kann diese Zahlung nicht abgeschlossen werden. Prüfe oder erstelle es in Empfangen ▸ Meine Adresse, sobald Solana wieder da ist.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Die Person hat noch kein ${asset}-Konto. Das Erstellen kostet etwa ${solAmount}, von dir bezahlt — sende zuerst etwas SOL hierher`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Das Erstellen deines ${asset}-Kontos kostet etwa ${solAmount}. Sende zuerst etwas SOL hierher.`,
  },

  rail: {
    refused: network =>
      `${network} hat die Anfrage abgelehnt, diese Guthaben sind daher nicht aktuell. Nichts wurde bewegt, und dpay versucht es weiter.`,
    offline: network =>
      `Du scheinst offline zu sein — ${network}-Guthaben sind nicht aktuell. Nichts wurde bewegt. Sie aktualisieren sich bei neuer Verbindung, und Bezahlen per QR geht auch offline.`,
    unreachable: network =>
      `${network} ist nicht erreichbar, obwohl du online bist — das dpay-Relay erreicht es gerade nicht. Dein Geld ist unberührt, deine IC-Zahlungen funktionieren weiterhin, und du kannst Zahlungen weiterhin offline signieren. Unter Einstellungen ▸ Erweitert kannst du diese Wallet auf einen beliebigen ${network}-Endpunkt zeigen lassen.`,
    unreadable: network =>
      `${network} hat Daten gesendet, die diese Wallet nicht lesen kann, diese Guthaben sind nicht aktuell. Nichts wurde bewegt, und dpay versucht es weiter.`,
    historyStale: network =>
      `Der ${network}-Verlauf ist nicht aktuell. Nichts wurde bewegt — er aktualisiert sich von selbst.`,
    unreachableHint: () => 'Öffnet Einstellungen ▸ Erweitert.',
  },

  ethWallet: {
    receiptReverted: hash => `Transaktion ${hash} wurde on-chain zurückgewiesen`,
    receiptTimeout: hash => `Transaktion ${hash} wurde nicht innerhalb der Frist in einen Block aufgenommen`,
    hashMissing: received =>
      `Deine Wallet hat ohne Transaktions-ID geantwortet (${received}) — dpay kann daher nicht erkennen, ob sie gesendet wurde.`,
    sendTimedOut: 'Deine Wallet hat nicht geantwortet — dpay kann daher nicht erkennen, ob die Transaktion gesendet wurde.',
    requestTimedOut:
      'Deine Wallet hat nicht geantwortet. Öffne sie, erledige eine dort wartende Anfrage und versuch es dann erneut.',
    pairingTimedOut: 'Zeitüberschreitung bei der Kopplung — innerhalb von 5 Min. hat keine Wallet gescannt',
    pairingFailed: detail => `WalletConnect-Kopplung fehlgeschlagen: ${detail}`,
    invalidChainId: value =>
      `Deine Wallet hat ein Netzwerk gemeldet, das dpay nicht lesen kann (${value}). Verbinde sie erneut; wenn das weiterhin passiert, nutze eine andere Wallet-App.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Deine Wallet hat kein Ethereum-Netzwerk freigegeben. Diese Einzahlung läuft über Netzwerk ${requested}. Wechsle in deiner Wallet dorthin und verbinde erneut.`
        : `Deine Wallet hat Netzwerk ${approved} freigegeben, diese Einzahlung läuft aber über Netzwerk ${requested}. Wechsle in deiner Wallet und verbinde erneut.`,
  },

  tap: {
    couldntConfirmOffline: 'Nicht bestätigt — prüfe dein Guthaben, wenn du wieder online bist',
    couldntVerifyRequest: 'Diese Anfrage konnte nicht geprüft werden',
    couldntReturnResult:
      'Das Ergebnis konnte nicht zurückgegeben werden. Halte die Handys zusammen und versuche es erneut.',
    merchantRefusalUnverified:
      'Laut Ledger ist die Überweisung nicht durchgegangen, aber dieses Handy konnte es nicht verifizieren. Gib die Ware nicht heraus. Prüfe gleich die Transaktionen — das Geld steht dort, wenn es angekommen ist.',
    merchantNothingArrived:
      'Es ist keine Zahlung eingegangen. Gib die Ware nicht heraus — eine Überweisung kann noch ankommen und erscheint dann in deinem Guthaben und in den Transaktionen. Bitte nur dann um einen neuen Tap, wenn nichts auftaucht.',
    unsupportedAsset: currency => `Asset nicht unterstützt (Währung ${currency})`,
    cannotConfirmAsset: currency => `Asset kann nicht bestätigt werden (Währung ${currency})`,
    couldntReadRequest: 'Die Zahlungsanfrage konnte nicht gelesen werden',
    requestExpired: 'Diese Anfrage ist abgelaufen — bitte um eine neue',
    couldntAuthorize: 'Zahlung konnte nicht freigegeben werden — versuche es erneut',
    noOpenRequest: 'Keine offene Anfrage',
    paymentRejected: 'Zahlung abgelehnt',
    couldntConfirm: 'Nicht bestätigt',
    couldntConfirmCheckBalance: 'Die Zahlung konnte nicht bestätigt werden — prüfe dein Guthaben',
    settlementNotVerified: 'Bestätigt — aber es ist nicht diese Anfrage. Prüfe die Signatur vor der Übergabe',
    paymentRequestExpired: 'Diese Zahlungsanfrage ist abgelaufen',
  },
};
