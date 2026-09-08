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
      `Deine Wallet hat noch kein ${asset}-Konto. Geh einmal online und öffne Empfangen ▸ „Mein ${asset}-Konto erstellen“, um es anzulegen — oder zahl diesem Händler mit einem Asset, das du schon hast`,
    senderTokenAccountUnverified: asset =>
      `dpay konnte nicht prüfen, ob deine Wallet ein ${asset}-Konto hat. Falls nicht, kann diese Zahlung nicht abgeschlossen werden. Geh einmal online und öffne Empfangen ▸ Meine Adresse, um es zu prüfen oder das Konto anzulegen.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `dpay konnte nicht prüfen, ob deine Wallet ein ${asset}-Konto hat — Solana antwortet dieser Wallet nicht, mehr Empfang hilft also nicht. Falls das Konto nicht existiert, kann diese Zahlung nicht abgeschlossen werden. Öffne Empfangen ▸ Meine Adresse, um es zu prüfen oder anzulegen, sobald Solana wieder antwortet.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `Die Person hat noch kein ${asset}-Konto — zum Erstellen brauchst du etwa ${solAmount} in dieser Wallet (einmalige Kontomiete + Gebühr, von dir bezahlt) — sende zuerst etwas SOL hierher`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Für dein ${asset}-Konto brauchst du etwa ${solAmount} in dieser Wallet (einmalige Kontomiete + Gebühr) — sende zuerst etwas SOL hierher`,
  },

  rail: {
    unreadable: network =>
      `${network} antwortet nicht, diese Guthaben sind daher nicht aktuell. Nichts wurde bewegt, deine anderen Konten funktionieren, und dpay versucht es weiter.`,
  },

  ethWallet: {
    receiptReverted: hash => `Transaktion ${hash} wurde on-chain zurückgewiesen`,
    receiptTimeout: hash => `Transaktion ${hash} wurde nicht innerhalb der Frist in einen Block aufgenommen`,
    hashMissing: received =>
      `Deine Wallet hat ohne Transaktions-ID geantwortet (${received}) — dpay kann daher nicht erkennen, ob die Transaktion gesendet wurde.`,
    sendTimedOut: 'Deine Wallet hat nicht geantwortet — dpay kann daher nicht erkennen, ob die Transaktion gesendet wurde.',
    requestTimedOut:
      'Deine Wallet hat nicht geantwortet. Öffne deine Wallet-App, erledige eine dort wartende Anfrage und versuch es dann erneut.',
    pairingTimedOut: 'Zeitüberschreitung bei der Kopplung — innerhalb von 5 Min. hat keine Wallet gescannt',
    pairingFailed: detail => `WalletConnect-Kopplung fehlgeschlagen: ${detail}`,
    invalidChainId: value =>
      `Deine Wallet hat ein Netzwerk gemeldet, das dpay nicht lesen kann (${value}). Verbinde sie erneut — wenn das weiterhin passiert, nutze eine andere Wallet-App.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Deine Wallet hat sich verbunden, aber kein Ethereum-Netzwerk freigegeben. Diese Einzahlung läuft über Netzwerk ${requested} — wechsle in deiner Wallet dorthin und verbinde erneut.`
        : `Deine Wallet hat Netzwerk ${approved} freigegeben, diese Einzahlung läuft aber über Netzwerk ${requested}. Wechsle das Netzwerk in deiner Wallet und verbinde erneut.`,
  },

  tap: {
    couldntConfirmOffline: 'Nicht bestätigt — prüfe dein Guthaben, wenn du wieder online bist',
    couldntVerifyRequest: 'Diese Anfrage konnte nicht geprüft werden',
    couldntReturnResult:
      'Das Zahlungsergebnis konnte nicht zurückgegeben werden — halte die Handys zusammen und versuche es erneut',
    merchantRefusalUnverified:
      'Laut Antwort des Ledgers ist diese Überweisung nicht durchgegangen, aber dpay konnte diese Antwort auf diesem Handy nicht verifizieren. Gib die Ware nicht heraus. Prüfe gleich dein Guthaben und die Transaktionen — wenn das Geld doch angekommen ist, steht es dort.',
    merchantNothingArrived:
      'Es ist keine Zahlung eingegangen. Gib die Ware nicht heraus. Eine Überweisung kann auch nach dem Tap noch ankommen und erscheint dann in deinem Guthaben und in den Transaktionen. Bitte den Kunden nur dann, erneut zu tappen, wenn nichts auftaucht.',
    unsupportedAsset: currency => `Asset nicht unterstützt (Währung ${currency})`,
    cannotConfirmAsset: currency => `Asset kann nicht bestätigt werden (Währung ${currency})`,
    couldntReadRequest: 'Die Zahlungsanfrage konnte nicht gelesen werden',
    requestExpired: 'Diese Anfrage ist abgelaufen — bitte um eine neue Anfrage',
    couldntAuthorize: 'Zahlung konnte nicht freigegeben werden — versuche es erneut',
    noOpenRequest: 'Keine offene Anfrage',
    paymentRejected: 'Zahlung abgelehnt',
    couldntConfirm: 'Nicht bestätigt',
    couldntConfirmCheckBalance: 'Die Zahlung konnte nicht bestätigt werden — prüfe dein Guthaben',
    settlementNotVerified: 'Bestätigt — aber es ist nicht diese Anfrage. Prüfe die Signatur vor der Übergabe',
    paymentRequestExpired: 'Diese Zahlungsanfrage ist abgelaufen',
  },
};
