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
    usdcUnavailable: 'Solana-USDC ist nicht verfügbar (kein RPC-Endpunkt konfiguriert)',
    senderNoUsdcAccount: 'Deine Wallet hat noch kein USDC-Konto',
    recipientNoUsdcAccount: solAmount =>
      `Die Person hat noch kein USDC-Konto — zum Erstellen brauchst du etwa ${solAmount} SOL in dieser Wallet (einmalige Kontomiete + Gebühr, von dir bezahlt) — sende zuerst etwas SOL hierher`,
    ownUsdcAccountRent: solAmount =>
      `Für dein USDC-Konto brauchst du etwa ${solAmount} in dieser Wallet (einmalige Kontomiete + Gebühr) — sende zuerst etwas SOL hierher`,
  },

  ethWallet: {
    receiptReverted: hash => `Transaktion ${hash} wurde on-chain zurückgewiesen`,
    receiptTimeout: hash => `Transaktion ${hash} wurde nicht innerhalb der Frist in einen Block aufgenommen`,
    pairingTimedOut: 'Zeitüberschreitung bei der Kopplung — innerhalb von 5 Min. hat keine Wallet gescannt',
    pairingFailed: detail => `WalletConnect-Kopplung fehlgeschlagen: ${detail}`,
  },

  tap: {
    couldntConfirmOffline: 'Nicht bestätigt — prüfe dein Guthaben, wenn du wieder online bist',
    couldntVerifyRequest: 'Diese Anfrage konnte nicht geprüft werden',
    couldntReturnResult:
      'Das Zahlungsergebnis konnte nicht zurückgegeben werden — halte die Handys zusammen und versuche es erneut',
    stillConfirming: 'Wird noch bestätigt — prüfe gleich das Guthaben',
    unsupportedAsset: currency => `Asset nicht unterstützt (Währung ${currency})`,
    cannotConfirmAsset: currency => `Asset kann nicht bestätigt werden (Währung ${currency})`,
    couldntReadRequest: 'Die Zahlungsanfrage konnte nicht gelesen werden',
    requestExpired: 'Diese Anfrage ist abgelaufen — bitte um eine neue Anfrage',
    couldntAuthorize: 'Zahlung konnte nicht freigegeben werden — versuche es erneut',
    noOpenRequest: 'Keine offene Anfrage',
    paymentRejected: 'Zahlung abgelehnt',
    couldntConfirm: 'Nicht bestätigt',
    couldntConfirmCheckBalance: 'Die Zahlung konnte nicht bestätigt werden — prüfe dein Guthaben',
    paymentRequestExpired: 'Diese Zahlungsanfrage ist abgelaufen',
  },
};
