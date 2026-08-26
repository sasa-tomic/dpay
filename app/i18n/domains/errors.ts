/**
 * i18n/domains/errors.ts — copy that is THROWN (or mapped from a thrown value) and then rendered
 * to the user verbatim.
 *
 * WHY THIS IS USER COPY AND NOT DIAGNOSTICS: the app surfaces failures by binding `setErr(e.message)`
 * straight into a `<Text>` (PayMode, the deposit/withdraw sheets), and the NFC status view renders a
 * terminal `reason` as its sub-line. So an English sentence thrown from deep in a rail — the Solana
 * seam, the IC certified-clock gate, the EIP-1193 transport — reaches the user exactly like a button
 * label does, and has to be translatable for the same reason.
 *
 * WHAT DELIBERATELY STAYS OUT: developer diagnostics that name a BUG rather than a user action
 * (`broadcastSolPayment: canonicalRequestUri does not match request (programming error)`,
 * `signSolPayment: expected SOL currency`, `hex string has odd length`). Translating those would
 * only make a stack trace harder to read. Equally out: any notion of a generic "something went
 * wrong" default — an unrecognized raw failure must keep falling through VERBATIM (see
 * `solana/errors.ts`), because hiding a novel failure is the one thing this catalog must never
 * enable. Each module keeps its own classification and control flow; only the TEXT moved here.
 */

export type ErrorMessages = {
  /** Recovery-seed input rule, shared by the Onboarding restore form and the Settings one. */
  seedFormat: string;

  /** IC rail — refusals raised locally, before anything is signed or submitted. */
  ic: {
    /** The certified-time gate: never sign a value envelope on an unverifiable or skewed clock. */
    clockUnreachable: string;
    clockSkew: string;
    /** The requested currency has no ledger in the catalog — nothing payable, so nothing is signed. */
    noLedgerForCurrency: string;
    /** `icrc1_fee` is unreadable, so an ICRC-2 approve cannot carry the fee the ledger demands. */
    feeUnavailable: string;
  };

  /** Solana rail — the device-key send path and the one-time USDC account (ATA) setup. */
  solana: {
    offline: string;
    usdcUnavailable: string;
    /** Fail-closed sender check: you cannot send USDC you hold no account for. */
    senderNoUsdcAccount: string;
    /** The recipient has no USDC account; the sender pays its one-time rent and is short of SOL. */
    recipientNoUsdcAccount: (solAmount: string) => string;
    /** Same rent, own account — the receive-side onboarding pre-check. */
    ownUsdcAccountRent: (solAmount: string) => string;
  };

  /** The user's OWN Ethereum wallet during the ckERC20 onramp (injected provider / WalletConnect). */
  ethWallet: {
    /** Mined but reverted — a hard fail that will never credit. */
    receiptReverted: (hash: string) => string;
    /** Not mined inside the window — soft, the transaction may still land. */
    receiptTimeout: (hash: string) => string;
    pairingTimedOut: string;
    pairingFailed: (detail: string) => string;
  };

  /**
   * NFC tap terminal reasons — the tap status view renders these verbatim as its sub-line, so an
   * unknown outcome must read as unknown ("Couldn't confirm"), never as a decline.
   */
  tap: {
    /** Shared by both rails: the payer's phone is offline and the merchant owns the verdict. */
    couldntConfirmOffline: string;
    /** IC merchant: the open request is missing its ledger/relay context, so nothing can be proven. */
    couldntVerifyRequest: string;
    /** IC merchant: settled or not, the result never made it back over the still-open channel. */
    couldntReturnResult: string;
    /** IC merchant: submitted, no exact history row inside the poll budget — honest pending. */
    stillConfirming: string;
    /** IC payer, fail-closed: the request names an asset this wallet cannot pay. */
    unsupportedAsset: (currency: number) => string;
    /** IC payer, fail-closed: the asset is known but its disclosure cannot be resolved. */
    cannotConfirmAsset: (currency: number) => string;
    couldntReadRequest: string;
    /** IC payer: the request's certified expiry passed before the sign fired. */
    requestExpired: string;
    couldntAuthorize: string;
    /** SOL merchant: a payment arrived with no request open on this phone. */
    noOpenRequest: string;
    paymentRejected: string;
    couldntConfirm: string;
    /** SOL merchant: unknown outcome — the broadcast may still land, so never "try again". */
    couldntConfirmCheckBalance: string;
    /** SOL payer: the request's recent blockhash window closed before the sign fired. */
    paymentRequestExpired: string;
  };
};

export const errorsEn: ErrorMessages = {
  seedFormat: 'Recovery seed must be 64 hex characters (0-9, a-f).',

  ic: {
    clockUnreachable: 'IC clock unreachable',
    clockSkew: 'IC clock skew too large',
    noLedgerForCurrency: 'Unsupported asset — no ledger for this currency',
    feeUnavailable: "Couldn't fetch the ledger fee — check your connection",
  },

  solana: {
    offline: 'Solana is offline (no RPC endpoint configured)',
    usdcUnavailable: 'Solana USDC is not available (no RPC endpoint configured)',
    senderNoUsdcAccount: "Your wallet doesn't have a USDC account yet",
    recipientNoUsdcAccount: solAmount =>
      `They don't have a USDC account yet — creating it needs about ${solAmount} of SOL in this wallet (one-time rent + fee, paid by you) — send a little SOL here first`,
    ownUsdcAccountRent: solAmount =>
      `Creating your USDC account needs about ${solAmount} in this wallet (one-time account rent + fee) — send a little SOL here first`,
  },

  ethWallet: {
    receiptReverted: hash => `transaction ${hash} reverted on chain`,
    receiptTimeout: hash => `transaction ${hash} was not mined within the timeout`,
    pairingTimedOut: 'pairing timed out — no wallet scanned within 5 min',
    pairingFailed: detail => `WalletConnect pairing failed: ${detail}`,
  },

  tap: {
    couldntConfirmOffline: 'Couldn’t confirm — check your balance when back online',
    couldntVerifyRequest: 'Couldn’t verify this request',
    couldntReturnResult: 'Couldn’t return the payment result — keep the phones together and try again',
    stillConfirming: 'Still confirming — check the balance shortly',
    unsupportedAsset: currency => `Unsupported asset (currency ${currency})`,
    cannotConfirmAsset: currency => `Cannot confirm the asset (currency ${currency})`,
    couldntReadRequest: 'Couldn’t read the payment request',
    requestExpired: 'This request expired — ask for a fresh request',
    couldntAuthorize: 'Couldn’t authorize payment — try again',
    noOpenRequest: 'No open request',
    paymentRejected: 'Payment rejected',
    couldntConfirm: 'Couldn’t confirm',
    couldntConfirmCheckBalance: 'Couldn’t confirm the payment — check your balance',
    paymentRequestExpired: 'This payment request has expired',
  },
};
