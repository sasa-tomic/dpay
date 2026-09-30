/**
 * i18n/domains/de/errors.ts — German values for the copy that is thrown and rendered verbatim.
 * Types, key documentation and the reference copy: ../en/errors.ts. Glossary: ../../de.ts.
 */
import type {ErrorMessages} from '../../keys';

export const errorsDe: ErrorMessages = {
  seedFormat: 'Der Seed muss aus 64 Hex-Zeichen bestehen (0-9, a-f).',

  ic: {
    clockUnreachable: 'IC-Uhr nicht erreichbar',
    clockSkew: 'IC-Zeitabweichung zu groß',
    noLedgerForCurrency: 'Asset nicht unterstützt',
    feeUnavailable: 'Ledger-Gebühr konnte nicht geladen werden. Prüfe die Verbindung.',
  },

  solana: {
    offline: 'Solana ist offline (kein Endpunkt konfiguriert)',
    tokenUnavailable: asset => `Solana-${asset} nicht verfügbar (kein Endpunkt konfiguriert)`,
    senderNoTokenAccount: asset =>
      `Noch kein ${asset}-Konto. Geh online und öffne Empfangen ▸ „Mein ${asset}-Konto erstellen“, oder zahl mit einem Asset, das du hast`,
    senderTokenAccountUnverified: asset =>
      `${asset}-Konto konnte nicht geprüft werden. Ohne eines kann diese Zahlung nicht abgeschlossen werden. Geh online und öffne Empfangen ▸ Meine Adresse, um es zu prüfen oder anzulegen.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `${asset}-Konto konnte nicht geprüft werden — Solana antwortet nicht. Ohne eines kann diese Zahlung nicht abgeschlossen werden. Sobald Solana wieder da ist: Empfangen ▸ Meine Adresse.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Die Person hat noch kein ${asset}-Konto. Das Erstellen kostet etwa ${solAmount}, von dir bezahlt — sende zuerst etwas SOL hierher`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Das Erstellen deines ${asset}-Kontos kostet etwa ${solAmount}. Sende zuerst etwas SOL hierher.`,
  },

  rail: {
    refused: network =>
      `${network} hat die Anfrage abgelehnt — Guthaben nicht aktuell. Nichts wurde bewegt, dpay versucht es weiter.`,
    offline: network =>
      `Du scheinst offline — ${network}-Guthaben nicht aktuell. Nichts wurde bewegt. Sie aktualisieren sich bei neuer Verbindung; Bezahlen per QR geht auch offline.`,
    unreachable: network =>
      `${network} ist nicht erreichbar, obwohl du online bist — das dpay-Relay erreicht es gerade nicht. Geld unberührt; IC-Zahlungen funktionieren; Zahlungen lassen sich weiterhin offline signieren. Unter Einstellungen ▸ Erweitert kannst du diese Wallet auf einen beliebigen ${network}-Endpunkt zeigen lassen.`,
    unreadable: network =>
      `${network} hat Daten gesendet, die diese Wallet nicht lesen kann — Guthaben nicht aktuell. Nichts wurde bewegt, dpay versucht es weiter.`,
    historyStale: network =>
      `Der ${network}-Verlauf ist nicht aktuell. Nichts wurde bewegt — er aktualisiert sich von selbst.`,
    unreachableHint: () => 'Öffnet Einstellungen ▸ Erweitert.',
  },

  ethWallet: {
    receiptReverted: hash => `Transaktion ${hash} wurde on-chain zurückgewiesen`,
    receiptTimeout: hash => `Transaktion ${hash} wurde nicht innerhalb der Frist in einen Block aufgenommen`,
    hashMissing: received =>
      `Wallet hat ohne Transaktions-ID geantwortet (${received}) — unklar, ob gesendet.`,
    sendTimedOut: 'Wallet hat nicht geantwortet — unklar, ob die Transaktion gesendet wurde.',
    requestTimedOut:
      'Wallet hat nicht geantwortet. Öffne sie, erledige eine wartende Anfrage und versuch es erneut.',
    pairingTimedOut: 'Zeitüberschreitung bei der Kopplung — innerhalb von 5 Min. hat keine Wallet gescannt',
    pairingFailed: detail => `WalletConnect-Kopplung fehlgeschlagen: ${detail}`,
    invalidChainId: value =>
      `Wallet hat ein Netzwerk gemeldet, das dpay nicht lesen kann (${value}). Verbinde sie erneut; passiert es weiter, nutze eine andere Wallet-App.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Wallet hat kein Ethereum-Netzwerk freigegeben — diese Einzahlung läuft über Netzwerk ${requested}. Wechsle dorthin und verbinde erneut.`
        : `Wallet hat Netzwerk ${approved} freigegeben, diese Einzahlung läuft über Netzwerk ${requested}. Wechsle und verbinde erneut.`,
  },

  tap: {
    couldntConfirmOffline: 'Nicht bestätigt — prüfe dein Guthaben, sobald du online bist',
    couldntVerifyRequest: 'Diese Anfrage konnte nicht geprüft werden',
    couldntReturnResult:
      'Das Ergebnis konnte nicht zurückgegeben werden. Halte die Handys zusammen und versuch es erneut.',
    merchantRefusalUnverified:
      'Laut Ledger ist die Überweisung nicht durchgegangen, aber dieses Handy konnte es nicht verifizieren. Gib die Ware nicht heraus. Prüfe gleich die Transaktionen — das Geld steht dort, wenn es angekommen ist.',
    merchantNothingArrived:
      'Es ist keine Zahlung eingegangen. Gib die Ware nicht heraus — eine Überweisung kann noch ankommen und erscheint in deinem Guthaben. Bitte nur dann um einen neuen Tap, wenn nichts auftaucht.',
    unsupportedAsset: currency => `Asset nicht unterstützt (Währung ${currency})`,
    cannotConfirmAsset: currency => `Asset kann nicht bestätigt werden (Währung ${currency})`,
    couldntReadRequest: 'Die Zahlungsanfrage konnte nicht gelesen werden',
    requestExpired: 'Diese Anfrage ist abgelaufen — bitte um eine neue',
    couldntAuthorize: 'Zahlung konnte nicht freigegeben werden — versuche es erneut',
    noOpenRequest: 'Keine offene Anfrage',
    paymentRejected: 'Zahlung abgelehnt',
    couldntConfirm: 'Nicht bestätigt',
    couldntConfirmCheckBalance: 'Nicht bestätigt — prüfe dein Guthaben',
    settlementNotVerified: 'Bestätigt — aber es ist nicht diese Anfrage. Prüfe die Signatur vor der Übergabe',
    paymentRequestExpired: 'Diese Zahlungsanfrage ist abgelaufen',
  },
};
