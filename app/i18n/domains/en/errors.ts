/**
 * i18n/domains/en/errors.ts — copy that is THROWN (or mapped from a thrown value) and then rendered
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

  /** Solana rail — the device-key send path and the one-time token account (ATA) setup. Every
   *  key names the ASSET it is about (USDC, EURC, …) — no token is hard-coded in the copy. */
  solana: {
    offline: string;
    tokenUnavailable: (asset: string) => string;
    /** Fail-closed sender check: you cannot send a token you hold no account for. */
    senderNoTokenAccount: (asset: string) => string;
    /**
     * The two CAVEATS that ride a payment signed without a fact (`solSplSignGate`'s 'unverified'
     * and 'unverified-rail-down'). Neither may block: an offline payer must keep the ability to
     * sign a payment that WOULD settle, and the payer who does hold the account is the common
     * case. So the surface says what it could not check, what it costs if the guess is wrong, and
     * what to do — and the two differ in exactly that last part, because the user's move differs:
     *   • `senderTokenAccountUnverified` — no fact and no answer from the endpoint. Finding signal
     *     fixes it.
     *   • `senderTokenAccountUnverifiedRailDown` — the rail is why there is no fact: the endpoint
     *     ANSWERED and refused this wallet, served bytes that cannot be trusted, or nothing on the
     *     rail's path answered while the phone IS online (the IC-boundary probe answered — the
     *     service side is down). "Get online" would be a lie in all three; the account can only be
     *     checked once Solana answers again.
     */
    senderTokenAccountUnverified: (asset: string) => string;
    senderTokenAccountUnverifiedRailDown: (asset: string) => string;
    /** The recipient has no token account; the sender pays its one-time rent and is short of SOL. */
    recipientNoTokenAccount: (solAmount: string, asset: string) => string;
    /** Same rent, own account — the receive-side onboarding pre-check. */
    ownTokenAccountRent: (solAmount: string, asset: string) => string;
  };

  /**
   * A whole RAIL's read failure, stated ONCE for the SETTLEMENT NETWORK rather than once per
   * account (X9). When an endpoint refuses — the measured case is the baked Helius key's HTTP 429
   * — every account on that network reports 'error' in the same poll, and the accounts list used
   * to print the identical ~48-word paragraph on each of them (three copies, ~120 words of alarm
   * text, for one fact). One network's outage is one fact.
   *
   * Four keys, four CAUSES (R3, spec 2026-09-09-relay-ha-and-solana-proxy: "three states, never
   * collapsed into one") — classified at the transport seam, never guessed at the component:
   *   - `refused`: the endpoint answered and did not serve us. The rail is down, the phone is
   *     online, and dpay keeps retrying behind the endpoint's cooldown.
   *   - `offline`: nothing answered anywhere — the rail's endpoint AND the IC boundary probe.
   *     The phone has no connectivity; NO ONE is named as the cause, because the wallet cannot
   *     see that far. Must not imply an outage on dpay's side or the rail's.
   *   - `unreachable`: the rail's path is down while the phone IS online. The copy names dpay's
   *     side of the path, says the money is untouched, names what still works — every claim
   *     verified against the code: IC PAYMENTS go straight to icp-api.io (the oracle's probe
   *     literally is that check), and signSolPayment/signSplPayment are pure/offline, so payments
   *     can still be SIGNED offline (their later broadcast still needs a rail — the copy must not
   *     imply otherwise) — and gives the escape: Settings ▸ Advanced points the wallet at any
   *     Solana endpoint, which removes dpay's choice from the path.
   *   - `unreadable`: the endpoint answered with bytes that could not be trusted.
   *
   * It promises NO RETRY. `hooks/useSolanaBalances.ts` already re-polls every `POLL.balance`
   * (2.5s in a shipped build) with an in-flight guard, so by the time a user could read this line
   * and tap, several retries have already run — and against a rate limit an extra manual read is
   * what caused the failure, not what fixes it. (The unreachable note's Settings ▸ Advanced
   * Pressable is NAVIGATION to the escape that sentence names, not a retry.)
   */
  rail: {
    refused: (network: string) => string;
    offline: (network: string) => string;
    unreachable: (network: string) => string;
    unreadable: (network: string) => string;
    /** The TRANSACTIONS list's staleness line (Ledger's `sol-history-stale`): the last history read
     *  failed, so the rows shown are the last known truth. The cause-specific rail copy above is the
     *  BALANCE surface's (it says "balances"); this sentence only marks the list itself. */
    historyStale: (network: string) => string;
    /** accessibilityHint for the unreachable note's tappable Settings ▸ Advanced escape. */
    unreachableHint: (network: string) => string;
  };

  /** The user's OWN Ethereum wallet during the ckERC20 onramp (injected provider / WalletConnect). */
  ethWallet: {
    /** Mined but reverted — a hard fail that will never credit. */
    receiptReverted: (hash: string) => string;
    /** Not mined inside the window — soft, the transaction may still land. */
    receiptTimeout: (hash: string) => string;
    /**
     * The two ways an `eth_sendTransaction` ends with no transaction id, which is one situation for
     * the user (dpay cannot tell whether money moved, so a retry might pay twice) and two different
     * FACTS about what dpay knows. Both are the first half of a sentence the deposit sheet finishes
     * with the step-specific instruction; neither may claim the wallet accepted anything, because in
     * the timeout case dpay does not know the wallet ever saw the request.
     *
     * `received` is the diagnostic — the value that came back — kept in the copy so a user can
     * quote it. See `TransactionHashMissing` in app/wallet.ts.
     */
    hashMissing: (received: string) => string;
    /** …and the same outcome reached by silence: the wallet never answered at all. */
    sendTimedOut: string;
    /**
     * A wallet request that ran out of time on OUR side with nothing at stake yet — connecting, a
     * chain-id read, a receipt read. Nothing was signed, so unlike `sendTimedOut` this one can name
     * a next action and mean it. The message of `WalletRequestTimeout` (app/wallet.ts).
     */
    requestTimedOut: string;
    pairingTimedOut: string;
    pairingFailed: (detail: string) => string;
    /** `eth_chainId` answered in neither encoding dpay decodes — see `getChainId` in wallet.ts. */
    invalidChainId: (value: string) => string;
    /** The WalletConnect session approved other chains than the one the deposit settles on (or
     *  none at all, which each locale phrases separately). `approved` is a comma-joined list. */
    chainNotApproved: (requested: number, approved: string) => string;
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
    /** IC MERCHANT DEAD ENDS — the two ways a tap ends without a settlement, written for the person
     *  at the counter rather than for the payer. Both render under the "Not confirmed" title, so
     *  neither repeats it; both must name the next move, and neither may claim a decline (this
     *  phone cannot verify one — see `MerchantVerdict` in `components/NfcTap.tsx`).
     *
     *  `merchantRefusalUnverified`: the ledger's answer said the transfer did not execute (a payer
     *  short of the asset lands here) and no history row appeared — an unverifiable answer, so it
     *  is reported as doubt and never as a cause. */
    merchantRefusalUnverified: string;
    /** …and the plain absence: nothing observed inside the poll budget. */
    merchantNothingArrived: string;
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
    /** SOL tap: settle-verify mismatch — the confirmed tx isn't this request (receipt code 3,
     *  honest pending for the payer; shortened NFC form of receive.settlementNotVerified). */
    settlementNotVerified: string;
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
    tokenUnavailable: asset => `Solana ${asset} is not available (no RPC endpoint configured)`,
    senderNoTokenAccount: asset =>
      `You have no ${asset} account yet. Get online once and open Receive ▸ Create my ${asset} account — or pay with an asset you already hold`,
    senderTokenAccountUnverified: asset =>
      `dpay couldn’t check whether you have a ${asset} account. If not, this payment cannot settle. Get online once and open Receive ▸ My address to check it, or to create the account.`,
    senderTokenAccountUnverifiedRailDown: asset =>
      `dpay couldn’t check whether you have a ${asset} account — Solana is not answering this wallet, so more signal will not help. If the account doesn’t exist, this payment cannot settle. Open Receive ▸ My address to check or create it, once Solana answers again.`,
    recipientNoTokenAccount: (solAmount, asset) =>
      `They don't have a ${asset} account yet — creating it needs about ${solAmount} in this wallet (one-time rent + fee, paid by you) — send a little SOL here first`,
    ownTokenAccountRent: (solAmount, asset) =>
      `Creating your ${asset} account needs about ${solAmount} in this wallet (one-time account rent + fee) — send a little SOL here first`,
  },

  rail: {
    refused: network =>
      `${network}’s endpoint refused the request, so these balances are out of date. Nothing moved, your other accounts still work, and dpay keeps retrying.`,
    offline: network =>
      `You appear to be offline, so ${network} balances could not be refreshed — nothing moved. They update on their own when a connection returns, and paying by QR still works offline.`,
    unreachable: network =>
      `${network} is unreachable while you are online — dpay’s relay can’t reach ${network} right now, and your money is untouched. Nothing moved, your Internet Computer payments still work, and you can still sign payments offline. Settings ▸ Advanced can point this wallet at any ${network} endpoint.`,
    unreadable: network =>
      `${network} answered with data this wallet cannot read, so these balances are out of date. Nothing moved, your other accounts still work, and dpay keeps retrying.`,
    historyStale: network =>
      `${network} history is out of date — nothing moved, and it refreshes on its own.`,
    /** accessibilityHint for the unreachable note's Settings ▸ Advanced Pressable (the founder
     *  UX directive that made the escape tappable). Says where the tap lands — never a promise
     *  the tap fixes the outage. */
    unreachableHint: () => 'Opens Settings ▸ Advanced.',
  },

  ethWallet: {
    receiptReverted: hash => `transaction ${hash} reverted on chain`,
    receiptTimeout: hash => `transaction ${hash} was not mined within the timeout`,
    hashMissing: received =>
      `Your wallet answered without a transaction id (${received}), so dpay can't tell whether the transaction was sent.`,
    sendTimedOut: "Your wallet didn't answer, so dpay can't tell whether the transaction was sent.",
    requestTimedOut:
      "Your wallet didn't answer. Open it, deal with any pending request, then try again.",
    pairingTimedOut: 'pairing timed out — no wallet scanned within 5 min',
    pairingFailed: detail => `WalletConnect pairing failed: ${detail}`,
    invalidChainId: value =>
      `Your wallet reported a network dpay can’t read (${value}). Reconnect it, and if that keeps happening use another wallet app.`,
    chainNotApproved: (requested, approved) =>
      approved === ''
        ? `Your wallet connected but approved no Ethereum network. This deposit settles on network ${requested} — switch to it in your wallet, then connect again.`
        : `Your wallet approved network ${approved}; this deposit settles on network ${requested}. Switch in your wallet, then connect again.`,
  },

  tap: {
    couldntConfirmOffline: 'Couldn’t confirm — check your balance when back online',
    couldntVerifyRequest: 'Couldn’t verify this request',
    couldntReturnResult: 'Couldn’t return the payment result — keep the phones together and try again',
    merchantRefusalUnverified:
      'The ledger says this transfer did not go through, but that answer could not be verified on this phone. Do not hand over the goods. Check your balance and Transactions in a moment — if the money did arrive, it shows there.',
    merchantNothingArrived:
      'No payment arrived — do not hand over the goods. A transfer can still land and will show in your balance and Transactions; ask for another tap only if nothing appears.',
    unsupportedAsset: currency => `Unsupported asset (currency ${currency})`,
    cannotConfirmAsset: currency => `Cannot confirm the asset (currency ${currency})`,
    couldntReadRequest: 'Couldn’t read the payment request',
    requestExpired: 'This request expired — ask for a fresh one',
    couldntAuthorize: 'Couldn’t authorize payment — try again',
    noOpenRequest: 'No open request',
    paymentRejected: 'Payment rejected',
    couldntConfirm: 'Couldn’t confirm',
    couldntConfirmCheckBalance: 'Couldn’t confirm the payment — check your balance',
    settlementNotVerified: 'Confirmed — but it isn’t this request. Check the signature before handover',
    paymentRequestExpired: 'This payment request has expired',
  },
};
